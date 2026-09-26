/**
 * The inbox: how a message actually reaches another agent.
 *
 * The sender only writes a file into `<home>/inbox/<to>/`. The recipient's own
 * plugin watches that directory and injects the envelope into its own session
 * with its own authenticated client — so a message crosses opencode servers,
 * passwords and restarts without the sender needing any of that. A message
 * sent to an agent that is currently down simply waits until it comes back. The
 * same is true of a session that is busy: it defers, and if it stays busy past
 * `maxBusyDefers` it only tells the sender "ambiguous" — never drops the message.
 */

import { watch, type FSWatcher } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { assertValidId, type MeshConfig } from "./config.ts"
import { isMessageId } from "./ids.ts"
import type { LogFields } from "./logger.ts"
import {
  ageMs,
  claimFile,
  ensureDir,
  listJsonFiles,
  readJson,
  readJsonWithMtime,
  removeFile,
  writeJsonAtomic,
} from "./store.ts"
import {
  ErrorCode,
  MeshError,
  PromptTimeoutError,
  SessionBusyError,
  SessionNotFoundError,
  type ClaimMeta,
  type MeshAck,
  type MeshMessage,
} from "./types.ts"

const CLAIM_SUFFIX = ".taken"

export function inboxDirFor(config: MeshConfig, id: string): string {
  assertValidId(id)
  return path.join(config.inboxDir, id)
}

function ackPath(config: MeshConfig, messageId: string): string {
  if (!isMessageId(messageId)) throw new TypeError(`invalid message id ${JSON.stringify(messageId)}`)
  return path.join(config.acksDir, `${messageId}.json`)
}

function processedPath(config: MeshConfig, messageId: string): string {
  if (!isMessageId(messageId)) throw new TypeError(`invalid message id ${JSON.stringify(messageId)}`)
  return path.join(config.processedDir, `${messageId}.json`)
}

async function hasProcessedMarker(config: MeshConfig, messageId: string): Promise<boolean> {
  const marker = await readJson<{ id?: unknown }>(processedPath(config, messageId))
  return marker?.id === messageId
}

async function writeAcceptedAck(
  config: MeshConfig,
  messageId: string,
  to: string,
  sessionID: string,
): Promise<void> {
  await writeAck(config, {
    id: messageId,
    to,
    sessionID,
    status: "accepted",
    at: new Date().toISOString(),
  })
}

async function writeProcessedMarker(
  config: MeshConfig,
  messageId: string,
  depth: number,
): Promise<void> {
  await writeJsonAtomic(processedPath(config, messageId), {
    id: messageId,
    at: new Date().toISOString(),
    depth,
  })
}

/**
 * How deep in a reply chain the message we injected was. The marker is
 * recipient-owned state written at injection time, so it is the only place the
 * depth survives: the inbox copy is gone the moment delivery succeeds, and the
 * sender's copy is not ours to read.
 */
export async function readProcessedDepth(config: MeshConfig, messageId: string): Promise<number> {
  if (!isMessageId(messageId)) return 0
  const marker = await readJson<{ depth?: unknown }>(processedPath(config, messageId))
  const depth = marker?.depth
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0
}

async function quarantineFile(file: string, directory: string, name: string): Promise<void> {
  const fs = await import("node:fs/promises")
  await ensureDir(directory)
  await fs.rename(file, path.join(directory, name))
}

type MessageValidation = { ok: true } | { ok: false; reason: string; name: string }

function retryCount(message: MeshMessage | undefined): number {
  const value = (message as unknown as Record<string, unknown> | undefined)?.["_retryCount"]
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function busyDeferCount(message: MeshMessage | undefined): number {
  const value = (message as unknown as Record<string, unknown> | undefined)?.["_busyDeferCount"]
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function replyDepthOf(message: MeshMessage | undefined): number {
  const depth = message?.replyDepth
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0
}

function withoutInternalFields(message: MeshMessage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message as unknown as Record<string, unknown>).filter(
      ([key]) => !key.startsWith("_"),
    ),
  )
}

function validateMessage(
  message: MeshMessage | undefined,
  file: string,
  recipient: string,
  maxTextLength: number,
): MessageValidation {
  const raw = message as unknown as Record<string, unknown> | undefined
  const id = raw?.id
  const name = typeof id === "string" && isMessageId(id)
    ? `${id}.invalid`
    : `${path.basename(file)}.invalid`
  const invalid = (reason: string): MessageValidation => ({ ok: false, reason, name })
  if (!raw) return invalid("message JSON is unreadable or corrupt")
  if (typeof id !== "string" || !isMessageId(id)) return invalid("message id is invalid")
  if (path.basename(file, CLAIM_SUFFIX) !== `${id}.json`) {
    return invalid("message filename does not match message id")
  }
  if (typeof raw.from !== "string" || typeof raw.to !== "string") {
    return invalid("message sender or recipient is missing")
  }
  try {
    assertValidId(raw.from)
    assertValidId(raw.to)
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error))
  }
  if (raw.to !== recipient) return invalid("message recipient does not match inbox")
  if (typeof raw.text !== "string" || raw.text.length === 0) {
    return invalid("message text is missing")
  }
  if (raw.text.length > maxTextLength) return invalid("message text exceeds maxTextLength")
  if (typeof raw.sentAt !== "string" || Number.isNaN(Date.parse(raw.sentAt))) {
    return invalid("message sentAt is invalid")
  }
  return { ok: true }
}

/** Queue a message for `message.to`. Returns once it is durably on disk. */
export async function enqueue(config: MeshConfig, message: MeshMessage): Promise<void> {
  assertValidId(message.to)
  if (!isMessageId(message.id)) throw new TypeError(`invalid message id ${JSON.stringify(message.id)}`)
  const serialized = JSON.stringify(message, null, 2)
  const byteLength = Buffer.byteLength(serialized, "utf8")
  if (byteLength > config.maxMessageBytes) {
    throw new MeshError(
      ErrorCode.MESSAGE_TOO_LARGE,
      `message is ${byteLength} bytes; the limit is ${config.maxMessageBytes}`,
    )
  }
  const dir = inboxDirFor(config, message.to)
  await ensureDir(dir)
  const files = await listJsonFiles(dir)
  if (files.length >= config.maxInboxMessages) {
    throw new MeshError(
      ErrorCode.INBOX_FULL,
      `inbox for ${message.to} has ${files.length} messages; the limit is ${config.maxInboxMessages}`,
    )
  }
  if (files.length > config.maxInboxMessages / 2) {
    let totalBytes = 0
    for (const file of files) {
      try {
        totalBytes += (await fs.stat(path.join(dir, file))).size
      } catch {
        continue
      }
    }
    if (totalBytes + byteLength > config.maxInboxBytes) {
      throw new MeshError(
        ErrorCode.INBOX_FULL,
        `inbox for ${message.to} exceeds ${config.maxInboxBytes} bytes`,
      )
    }
  }
  await writeJsonAtomic(path.join(dir, `${message.id}.json`), message)
}

function normalizeAck(value: MeshAck | undefined): MeshAck | undefined {
  if (!value) return undefined
  const status = (value as unknown as { status?: unknown }).status
  if (status === "injected") return { ...value, status: "accepted" }
  if (status === "accepted" || status === "failed" || status === "ambiguous") return value
  return undefined
}

export async function readAck(
  config: MeshConfig,
  messageId: string,
  expectedTo?: string,
): Promise<MeshAck | undefined> {
  if (!isMessageId(messageId)) throw new TypeError(`invalid message id ${JSON.stringify(messageId)}`)
  const ack = normalizeAck(await readJson<MeshAck>(ackPath(config, messageId)))
  if (!ack || ack.id !== messageId || (expectedTo !== undefined && ack.to !== expectedTo)) {
    return undefined
  }
  return ack
}

async function writeAck(config: MeshConfig, ack: MeshAck): Promise<void> {
  await writeJsonAtomic(ackPath(config, ack.id), ack)
}

/** Poll for the recipient's ack until it lands or the window closes. */
export async function waitForAck(
  config: MeshConfig,
  messageId: string,
  timeoutMs: number,
  expectedTo?: string,
): Promise<MeshAck | undefined> {
  const deadline = Date.now() + timeoutMs
  const step = 100
  for (;;) {
    const ack = await readAck(config, messageId, expectedTo)
    if (ack) return ack
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, deadline - Date.now())))
  }
}

/** Drop acks nobody is waiting for any more. */
export async function reapAcks(config: MeshConfig, now: number = Date.now()): Promise<number> {
  let removed = 0
  for (const file of await listJsonFiles(config.acksDir)) {
    const full = path.join(config.acksDir, file)
    const read = await readJsonWithMtime<MeshAck>(full)
    if (read && ageMs(read.mtimeMs, now) < config.ackRetentionMs) continue
    await removeFile(full)
    removed++
  }
  return removed
}

export type InboxHandler = (message: MeshMessage) => Promise<void>

export type InboxCrashHooks = {
  afterClaim?: () => void | Promise<void>
  afterHandler?: () => void | Promise<void>
  afterAck?: () => void | Promise<void>
}

class InboxCrashHookError extends Error {
  constructor() {
    super("Inbox crash hook triggered")
    this.name = "InboxCrashHookError"
  }
}

async function runCrashHook(hook: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!hook) return
  try {
    await hook()
  } catch {
    throw new InboxCrashHookError()
  }
}

/**
 * Watches one agent's inbox. `fs.watch` handles the common case; the interval
 * is the safety net for the events macOS drops and for files that landed while
 * the process was down.
 */
export class InboxWatcher {
  private watcher?: FSWatcher
  private timer?: NodeJS.Timeout
  private draining = false
  private pending = false
  private stopped = false

  private readonly config: MeshConfig
  private readonly id: string
  private readonly sessionID: string
  private readonly ownerInstance: string
  private readonly incarnation: string
  private readonly handler: InboxHandler
  private readonly onError: (error: unknown, event: string, fields?: LogFields) => void
  private readonly crashHooks: InboxCrashHooks

  constructor(
    config: MeshConfig,
    id: string,
    sessionID: string,
    ownerInstance: string,
    incarnation: string,
    handler: InboxHandler,
    onError: (error: unknown, event: string, fields?: LogFields) => void,
    crashHooks: InboxCrashHooks = {},
  ) {
    this.config = config
    this.id = id
    this.sessionID = sessionID
    this.ownerInstance = ownerInstance
    this.incarnation = incarnation
    this.handler = handler
    this.onError = onError
    this.crashHooks = crashHooks
  }

  get dir(): string {
    return inboxDirFor(this.config, this.id)
  }

  /**
   * Dead letters and quarantined files live outside `inbox/<id>/` on purpose: a
   * non-empty subdirectory there would keep the inbox non-empty forever, and an
   * inbox is only reaped when it is empty.
   */
  get deadDir(): string {
    return path.join(this.config.deadDir, this.id)
  }

  get quarantineDir(): string {
    return path.join(this.config.quarantineDir, this.id)
  }

  async start(): Promise<void> {
    await ensureDir(this.dir)
    await this.recoverClaimed()
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => void this.drain())
      this.watcher.on("error", (error) => this.onError(error, "inbox_watch_failed"))
    } catch (error) {
      // Not fatal: the poll interval still delivers, just less promptly.
      this.onError(error, "inbox_watch_setup_failed")
    }
    this.timer = setInterval(() => void this.drain(), this.config.pollIntervalMs)
    this.timer.unref?.()
    await this.drain()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * A message claimed by a previous process that died mid-injection is still
   * sitting there as `*.json.taken`. We own this inbox, so it is safe to put
   * every claim back and try again.
   */
  private async recoverClaimed(): Promise<void> {
    const fs = await import("node:fs/promises")
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of entries) {
      if (!name.endsWith(CLAIM_SUFFIX)) continue
      const taken = path.join(this.dir, name)
      const base = name.slice(0, -CLAIM_SUFFIX.length)
      const messageId = base.replace(/\.json$/, "")
      if (isMessageId(messageId)) {
        const ack = await readAck(this.config, messageId, this.id)
        if (ack?.status === "accepted") {
          await removeFile(taken)
          continue
        }
        if (await hasProcessedMarker(this.config, messageId)) {
          await writeAcceptedAck(this.config, messageId, this.id, this.sessionID)
          await removeFile(taken)
          continue
        }
      }
      const raw = await readJson<Record<string, unknown> & { _claim?: ClaimMeta }>(taken)
      const leaseExpiresAt = raw?._claim?.leaseExpiresAt
      const leaseMs = typeof leaseExpiresAt === "string" ? Date.parse(leaseExpiresAt) : Number.NaN
      if (Number.isFinite(leaseMs) && leaseMs > now) continue
      const original = path.join(this.dir, base)
      if (raw) {
        delete raw["_claim"]
        await writeJsonAtomic(original, raw)
        await removeFile(taken)
      } else {
        await fs.rename(taken, original).catch(() => {})
      }
    }
  }

  /** Process everything currently queued, oldest first (ULID file names sort). */
  async drain(): Promise<void> {
    if (this.stopped) return
    if (this.draining) {
      this.pending = true
      return
    }
    this.draining = true
    try {
      do {
        this.pending = false
        for (const file of await listJsonFiles(this.dir)) {
          if (this.stopped) return
          await this.deliverOne(path.join(this.dir, file))
        }
      } while (this.pending)
    } catch (error) {
      this.onError(error, "inbox_drain_failed")
    } finally {
      this.draining = false
    }
  }

  private async deliverOne(file: string): Promise<void> {
    const pending = await readJson<MeshMessage>(file)
    const attempt = retryCount(pending) + 1
    const claim: ClaimMeta = {
      ownerInstance: this.ownerInstance,
      incarnation: this.incarnation,
      sessionID: this.sessionID,
      claimedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + this.config.leaseDurationMs).toISOString(),
      attempt,
    }
    const claimed = await claimFile(file, CLAIM_SUFFIX, claim)
    if (!claimed) return // someone else got there first
    await runCrashHook(this.crashHooks.afterClaim)
    const message = await readJson<MeshMessage>(claimed)
    const validation = validateMessage(message, claimed, this.id, this.config.maxTextLength)
    if (!validation.ok) {
      try {
        await quarantineFile(claimed, this.quarantineDir, validation.name)
        this.onError(new Error(validation.reason), "message_quarantined")
      } catch (error) {
        this.onError(error, "message_quarantine_failed")
      }
      return
    }
    if (!message) return
    const schemaVersion = (message as { schemaVersion?: unknown }).schemaVersion
    if (schemaVersion !== undefined && schemaVersion !== 1) {
      const name = `${message.id}.json`
      try {
        await quarantineFile(claimed, this.quarantineDir, name)
        this.onError(
          new Error(`unsupported message schemaVersion ${JSON.stringify(schemaVersion)}`),
          "message_schema_unsupported",
        )
      } catch (error) {
        this.onError(error, "message_schema_quarantine_failed")
      }
      return
    }
    const existingAck = await readAck(this.config, message.id, this.id)
    if (existingAck?.status === "accepted") {
      await removeFile(claimed)
      return
    }
    if (await hasProcessedMarker(this.config, message.id)) {
      await writeAcceptedAck(this.config, message.id, this.id, this.sessionID)
      await removeFile(claimed)
      return
    }
    try {
      await this.handler(withoutInternalFields(message) as MeshMessage)
      await runCrashHook(this.crashHooks.afterHandler)
      await writeProcessedMarker(this.config, message.id, replyDepthOf(message))
      await writeAcceptedAck(this.config, message.id, this.id, this.sessionID)
      await runCrashHook(this.crashHooks.afterAck)
      await removeFile(claimed)
    } catch (error) {
      if (error instanceof InboxCrashHookError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof PromptTimeoutError) {
        this.onError(error, "prompt_ambiguous", { attempt })
        await writeAck(this.config, {
          id: message.id,
          to: this.id,
          sessionID: this.sessionID,
          status: "ambiguous",
          detail,
          at: new Date().toISOString(),
        })
        await removeFile(claimed)
        return
      }
      if (error instanceof SessionNotFoundError) {
        this.onError(error, "session_not_found", { attempt })
        await writeAck(this.config, {
          id: message.id,
          to: this.id,
          sessionID: this.sessionID,
          status: "failed",
          detail,
          at: new Date().toISOString(),
        })
        await this.moveToDeadLetter(claimed, message, detail, attempt)
        return
      }
      if (error instanceof SessionBusyError) {
        const defers = busyDeferCount(message) + 1
        this.onError(error, "session_busy", { attempt, defers })
        await new Promise((resolve) => setTimeout(resolve, this.config.busyDeferMs))
        if (defers >= this.config.maxBusyDefers) {
          // Past the threshold the sender is told the outcome is unknown, but
          // the message is not dropped: it goes back on the queue and lands as
          // soon as the session frees up. A busy session is a slow session.
          this.onError(error, "message_deferred_busy", { defers })
          await writeAck(this.config, {
            id: message.id,
            to: this.id,
            sessionID: this.sessionID,
            status: "ambiguous",
            detail: `session remained busy after ${defers} defers`,
            at: new Date().toISOString(),
          })
        }
        const deferred = withoutInternalFields(message)
        deferred["_busyDeferCount"] = defers
        const original = claimed.slice(0, -CLAIM_SUFFIX.length)
        await writeJsonAtomic(original, deferred)
        await removeFile(claimed)
        return
      }
      this.onError(error, "inject_failed", { attempt })
      await writeAck(this.config, {
        id: message.id,
        to: this.id,
        sessionID: this.sessionID,
        status: "failed",
        detail,
        at: new Date().toISOString(),
      })
      if (attempt >= this.config.maxDeliveryAttempts) {
        await this.moveToDeadLetter(claimed, message, detail, attempt)
        return
      }
      const retryMessage = withoutInternalFields(message)
      retryMessage["_retryCount"] = attempt
      const original = claimed.slice(0, -CLAIM_SUFFIX.length)
      await writeJsonAtomic(original, retryMessage)
      await removeFile(claimed)
    }
  }

  private async moveToDeadLetter(
    claimed: string,
    message: MeshMessage,
    detail: string,
    attempt: number,
  ): Promise<void> {
    const deadFile = path.join(this.deadDir, `${message.id}.json`)
    const record = withoutInternalFields(message)
    record["_deadLetter"] = {
      reason: detail,
      attempts: attempt,
      at: new Date().toISOString(),
    }
    await writeJsonAtomic(deadFile, record)
    await removeFile(claimed)
    this.onError(new Error(`dead-lettered after ${attempt} attempts`), "message_dead_lettered", { attempt })
  }
}
