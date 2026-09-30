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
  fileExists,
  listClaims,
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
  type ProcessedVia,
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

/**
 * Did we already inject this message? The marker is the only durable proof,
 * because the inbox copy is deleted the moment delivery succeeds.
 */
export async function hasProcessedMarker(config: MeshConfig, messageId: string): Promise<boolean> {
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
  threadId?: string,
  via?: ProcessedVia,
): Promise<void> {
  await writeJsonAtomic(processedPath(config, messageId), {
    id: messageId,
    at: new Date().toISOString(),
    depth,
    threadId,
    via,
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

/**
 * Which thread a message we injected belonged to, or undefined when the marker
 * predates threads. Read from our own marker for the same ownership reason as
 * the depth: the sender's copy is not ours, and the inbox copy is gone.
 */
export async function readProcessedThreadId(
  config: MeshConfig,
  messageId: string,
): Promise<string | undefined> {
  if (!isMessageId(messageId)) return undefined
  const marker = await readJson<{ threadId?: unknown }>(processedPath(config, messageId))
  return typeof marker?.threadId === "string" && isMessageId(marker.threadId)
    ? marker.threadId
    : undefined
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

function threadIdOf(message: MeshMessage | undefined): string | undefined {
  const threadId = message?.threadId
  return typeof threadId === "string" && isMessageId(threadId) ? threadId : undefined
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

/**
 * The batch wake-up, told how many messages are waiting. It is a turn of its
 * own and carries no body: the model answers it with `agentmesh_fetch`, so a
 * pile of letters costs one turn instead of one turn each.
 */
export type BatchNotifier = (count: number) => Promise<void>

/** A message we hold a claim on and have already decided to deliver. */
type ClaimedMessage = {
  /** Path of the `.json.taken` file; the claim is ours until it is gone. */
  path: string
  message: MeshMessage
  attempt: number
}

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
  /**
   * The delivery slot (M2 in the race matrix). While a delivery is running, a
   * second one does not start: it only re-arms `pending` so the next loop picks
   * up whatever arrived meanwhile. An external `session.idle` is not a
   * substitute — it can land while this flag is set, and that is exactly how a
   * message would get injected twice.
   */
  private deliveryInFlight = false
  private pending = false
  /**
   * M6, the one piece of state Phase 3.5 adds. Set when a batch notification
   * was actually injected, it both suppresses a second notification while the
   * batch is unresolved and anchors the fallback timer. Per watcher, never per
   * process: one process hosts several sessions, and a shared marker would let
   * one session's backlog silence another's notification. Deliberately not
   * persisted — a restart just re-notifies, which is faster, not lossy.
   */
  private notifiedAt?: number
  private stopped = false

  private readonly config: MeshConfig
  private readonly id: string
  private readonly sessionID: string
  private readonly ownerInstance: string
  private readonly incarnation: string
  private readonly handler: InboxHandler
  private readonly notifier: BatchNotifier
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
    notifier: BatchNotifier = async (count) => {
      this.onError(
        new Error("no batch notifier wired into this watcher"),
        "batch_notify_unwired",
        { count },
      )
    },
  ) {
    this.config = config
    this.id = id
    this.sessionID = sessionID
    this.ownerInstance = ownerInstance
    this.incarnation = incarnation
    this.handler = handler
    this.onError = onError
    this.crashHooks = crashHooks
    this.notifier = notifier
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
      const original = path.join(this.dir, base)
      // A crash between creating the hard link and dropping the pending name
      // leaves both names pointing at the same inode. The claim is the fact and
      // the pending name is the lie, so the pending name goes below — but only
      // in the branches that actually take the claim over. Dropping it up front
      // would strand the message: a claim we decline to take (the lease is still
      // live) then sits there alone, and a lone `.taken` is not a `.json` file,
      // so no drain ever sees a message to lose a claim race against and
      // recovery is never entered again.
      const messageId = base.replace(/\.json$/, "")
      if (isMessageId(messageId)) {
        const ack = await readAck(this.config, messageId, this.id)
        if (ack?.status === "accepted") {
          await removeFile(original)
          await removeFile(taken)
          continue
        }
        if (await hasProcessedMarker(this.config, messageId)) {
          await writeAcceptedAck(this.config, messageId, this.id, this.sessionID)
          await removeFile(original)
          await removeFile(taken)
          continue
        }
      }
      const raw = await readJson<Record<string, unknown> & { _claim?: ClaimMeta }>(taken)
      const leaseExpiresAt = raw?._claim?.leaseExpiresAt
      const leaseMs = typeof leaseExpiresAt === "string" ? Date.parse(leaseExpiresAt) : Number.NaN
      if (Number.isFinite(leaseMs) && leaseMs > now) continue
      // A claim with no readable lease is not automatically stale: the window
      // between creating the claim and stamping the lease is real, and a peer
      // starting inside it would hand a message back while its owner is still
      // injecting it. Fall back to the file's own age, which is the conservative
      // reading of the same window.
      if (!Number.isFinite(leaseMs)) {
        // ctime, not mtime: creating the hard link updates ctime and leaves
        // mtime alone, so mtime measures how long the message has been sitting
        // in the inbox rather than how long ago it was claimed. Using it would
        // hand back a message the instant its owner claimed it, just because the
        // message itself had been queued for a while.
        let age = Number.NaN
        try {
          age = ageMs((await fs.stat(taken)).ctimeMs, now)
        } catch {
          continue
        }
        if (age < this.config.leaseDurationMs) continue
      }
      if (raw) {
        delete raw["_claim"]
        await writeJsonAtomic(original, raw)
        await removeFile(taken)
      } else {
        await fs.rename(taken, original).catch(() => {})
      }
    }
  }

  /**
   * Process everything currently queued, oldest first (ULID file names sort).
   *
   * The batch decision is made on what we actually claimed, never on a readdir
   * count: a count is a stale read, and acting on it would either notify for a
   * batch that a concurrent fetch already took or inject a body for a batch it
   * never announced. Claim first, then look at the claims.
   *
   * One claim means the fast path: the body is injected, exactly as before
   * Phase 3.5, and `agentmesh_fetch` never sees it. Two or more means one
   * notification instead of N body-injects, and the claims go straight back so
   * the fetch can take them.
   */
  async drain(): Promise<void> {
    if (this.stopped) return
    if (this.deliveryInFlight) {
      this.pending = true
      return
    }
    this.deliveryInFlight = true
    try {
      do {
        this.pending = false
        const files = await listJsonFiles(this.dir)
        if (files.length === 0) {
          // Nothing outstanding, so any earlier batch is resolved by definition.
          this.notifiedAt = undefined
          continue
        }
        const claimed = await this.claimBatch(files)
        if (claimed.length === 0) {
          // Files are pending yet nothing could be claimed: a stale `.taken`
          // from a crashed process is sitting next to them, and a claim on it
          // loses forever. Recovery only runs at startup, so a watcher that was
          // already live when that state appeared would never recover on its
          // own. It is lease-respecting, so live claims are left untouched.
          await this.recoverClaimed()
          continue
        }
        if (claimed.length === 1) {
          await this.deliverClaimed(claimed[0]!)
          continue
        }
        await this.deliverBatch(claimed)
      } while (this.pending)
    } catch (error) {
      this.onError(error, "inbox_drain_failed")
    } finally {
      this.deliveryInFlight = false
    }
  }

  /**
   * Take as many messages as one batch may hold, oldest first, and hand back
   * only the ones that survived claiming and validation. A file that lost the
   * race, was already injected or is malformed is disposed of here, so the
   * caller decides on a clean set of live claims.
   */
  private async claimBatch(files: string[]): Promise<ClaimedMessage[]> {
    const claimed: ClaimedMessage[] = []
    for (const name of files.slice(0, this.config.fetchLimit)) {
      const held = await this.claimOne(path.join(this.dir, name))
      if (held) claimed.push(held)
    }
    return claimed
  }

  /**
   * One message, many waiting. Before announcing anything we check whether the
   * batch we announced earlier went unread for longer than it is worth waiting:
   * then the plain, old body-inject takes over and the message is delivered the
   * way it always was.
   *
   * The check sits before the notification on purpose. The other order would
   * announce a batch we are about to inject ourselves, and the model would read
   * the wake-up as "come get this" while the turns are already arriving.
   *
   * Only what is claimed here is eligible: `claimBatch` took these files from
   * `pending`, so anything a fetch already consumed or another delivery is
   * holding right now is invisible to the fallback by construction, not by a
   * check that could be skipped.
   */
  private async deliverBatch(claimed: ClaimedMessage[]): Promise<void> {
    const count = claimed.length
    const notifiedAt = this.notifiedAt
    if (notifiedAt !== undefined) {
      if (Date.now() - notifiedAt < this.config.fetchFallbackMs) {
        // The batch is announced and still within its window. Say nothing else:
        // a second wake-up would only repeat a batch the model has not read yet,
        // and the fallback is the only thing that may resolve it.
        for (const held of claimed) await this.release(held)
        return
      }
      this.notifiedAt = undefined
      this.onError(new Error("fetch window expired"), "batch_fallback", { count })
      for (const held of claimed) await this.deliverClaimed(held)
      return
    }
    // Release before announcing, not after. A fetch that lands in the window
    // between the notice and the release would see fewer messages than the
    // notice promised, and the batch would appear to lose one.
    for (const held of claimed) await this.release(held)
    try {
      await this.notifier(count)
      this.notifiedAt = Date.now()
    } catch (error) {
      if (error instanceof InboxCrashHookError) throw error
      if (!(error instanceof SessionBusyError)) {
        this.onError(error, "batch_notify_failed", { count })
      }
      this.notifiedAt = undefined
    }
  }

  /**
   * Pretend the notification was sent long enough ago that the fetch window has
   * passed. Test-only seam for the fallback deadline: the alternative is
   * sleeping through `fetchFallbackMs`, and nothing here depends on wall time.
   */
  expireNotification(now: number = Date.now()): void {
    if (this.notifiedAt !== undefined) {
      this.notifiedAt = now - this.config.fetchFallbackMs - 1
    }
  }

  /**
   * Take up to `limit` queued messages for the model, oldest first, and consume
   * them: each one is claimed with the same atomic rename the injector uses, so
   * a message can have exactly one winner — the fetch or the fallback, never
   * both. The processed marker is written before the file is removed, which is
   * what makes a crash in between a no-op instead of a redelivery.
   *
   * This is the only reader of the mailbox, and it is the reason the batch
   * notification exists: one call answers for a whole pile of turns.
   */
  async takeBatch(limit: number): Promise<{ messages: MeshMessage[]; hasMore: boolean }> {
    if (this.stopped) return { messages: [], hasMore: false }
    const taken: ClaimedMessage[] = []
    for (const name of (await listJsonFiles(this.dir)).slice(0, Math.max(1, limit))) {
      const held = await this.claimOne(path.join(this.dir, name))
      if (held) taken.push(held)
    }
    const messages: MeshMessage[] = []
    for (const held of taken) {
      await writeProcessedMarker(
        this.config,
        held.message.id,
        replyDepthOf(held.message),
        threadIdOf(held.message),
        "fetch",
      )
      // The same marker claimOne and recoverClaimed treat as accepted. Skipping
      // this left the sender at `queued` until it aged into `undeliverable`,
      // which reads as "never arrived" for a message the model just read.
      await writeAcceptedAck(this.config, held.message.id, this.id, this.sessionID)
      await removeFile(held.path)
      messages.push(held.message)
    }
    // A claim in flight is unread mail too. Counting only `*.json` reported
    // `hasMore: false` while a `*.json.taken` was still on disk, and a model
    // that trusts it stops paginating — the message then waits for the next
    // notification instead of being fetched.
    //
    // Our own claims count: we hold them, we are mid-inject or deferring, and
    // they will be delivered by us. A claim held by *another* watcher does not,
    // because that message is already being injected into that session and is
    // not ours to fetch — counting it would page forever against a message we can
    // never take (the mid-inject takeover race).
    const [pending, claims] = await Promise.all([
      listJsonFiles(this.dir),
      listClaims(this.dir),
    ])
    let ours = 0
    for (const name of claims) {
      const held = await readJson<{ _claim?: ClaimMeta }>(path.join(this.dir, name))
      if (held?._claim?.ownerInstance === this.ownerInstance) ours += 1
    }
    const hasMore = pending.length > 0 || ours > 0
    // M6, extended: a fetch is activity, so it moves the fallback deadline and
    // keeps the notification suppressed while pagination is going on. A fetch
    // that took the last of the pile resolves the batch outright, and a fetch
    // that took nothing is not a signal at all.
    if (messages.length > 0) this.notifiedAt = hasMore ? Date.now() : undefined
    return { messages, hasMore }
  }

  /** Put a claim back on the queue, keeping the internal counters intact. */
  private async release(held: ClaimedMessage): Promise<void> {
    const message = withoutInternalFields(held.message)
    if (held.attempt > 1) message["_retryCount"] = held.attempt - 1
    const original = held.path.slice(0, -CLAIM_SUFFIX.length)
    try {
      await writeJsonAtomic(original, message)
      await removeFile(held.path)
    } catch (error) {
      this.onError(error, "claim_release_failed", { attempt: held.attempt })
    }
  }

  private async deliverOne(file: string): Promise<void> {
    const held = await this.claimOne(file)
    if (held) await this.deliverClaimed(held)
  }

  /**
   * Claim one message and get it ready to inject: the file is taken with an
   * atomic rename, validated, and dropped early if it was already acked or
   * already injected. Returns undefined when there is nothing left to deliver.
   */
  private async claimOne(file: string): Promise<ClaimedMessage | undefined> {
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
    if (!claimed) return undefined // someone else got there first
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
      return undefined
    }
    return { path: claimed, message, attempt }
  }

  /**
   * Deliver a message we hold a claim on: inject the body, stamp the marker,
   * ack, then drop the file. Every failure path either drops the message on
   * purpose or puts it back on the queue — none of them loses it.
   */
  private async deliverClaimed(held: ClaimedMessage): Promise<void> {
    const { path: claimed, message, attempt } = held
    try {
      await this.handler(withoutInternalFields(message) as MeshMessage)
      await runCrashHook(this.crashHooks.afterHandler)
      await writeProcessedMarker(this.config, message.id, replyDepthOf(message), threadIdOf(message), "inject")
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
