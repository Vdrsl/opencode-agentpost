/**
 * The mesh as one plugin instance sees it.
 *
 * A plugin instance can host more than one session (several opencode sessions
 * in the same directory), so every registered session gets its own record,
 * its own inbox watcher and its own place in the registry. One shared timer
 * heartbeats them all and sweeps the dead ones.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { assertValidId, type MeshConfig, slugify } from "./config.ts"
import type { Logger } from "./logger.ts"
import { renderEnvelope } from "./envelope.ts"
import {
  enqueue,
  inboxDirFor,
  InboxWatcher,
  readProcessedDepth,
  readProcessedThreadId,
  reapAcks,
  waitForAck,
} from "./inbox.ts"
import { isMessageId, newMessageId } from "./ids.ts"
import { sweepOutbox, writeOutboxEntry } from "./outbox.ts"
import { Registry } from "./registry.ts"
import {
  type AgentRouting,
  ErrorCode,
  type MeshMessage,
  MeshError,
  type PeerView,
  type SendStatus,
} from "./types.ts"

/** Injects text into one of *our own* sessions as a new user turn. */
export type InjectFn = (target: {
  sessionID: string
  directory: string
  text: string
}) => Promise<void>

export type MeshDeps = {
  inject: InjectFn
  logger: Logger
}

/** Identity of the session a tool call came from. */
export type SessionContext = {
  sessionID: string
  directory: string
  worktree: string
  serverUrl: string
}

type SessionAgent = {
  id: string
  routing: AgentRouting
  watcher: InboxWatcher
  ownerInstance?: string
  incarnation?: string
}

const REAP_INTERVAL_MS = 60_000

export class Mesh {
  readonly config: MeshConfig
  readonly registry: Registry
  private readonly deps: MeshDeps
  private readonly ownerInstance = randomUUID()
  private readonly agents = new Map<string, SessionAgent>()
  private timer?: NodeJS.Timeout
  private lastReap = 0

  constructor(config: MeshConfig, deps: MeshDeps) {
    this.config = config
    this.deps = deps
    this.registry = new Registry(config, this.deps.logger)
  }

  // ------------------------------------------------------------- lifecycle

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.config.heartbeatIntervalMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    for (const [sessionID, agent] of this.agents) {
      try {
        const alive = await this.registry.heartbeat(agent.id, {
          ownerInstance: agent.ownerInstance ?? this.ownerInstance,
          incarnation: agent.incarnation ?? "",
        })
        if (!alive) {
          this.deps.logger("warn", "heartbeat_fenced")
        }
      } catch (error) {
        this.deps.logger("error", "heartbeat_failed")
      }
    }
    const now = Date.now()
    if (now - this.lastReap < REAP_INTERVAL_MS) return
    this.lastReap = now
    try {
      const removed = await this.registry.reap(now)
      if (removed.length) this.deps.logger("info", "agents_reaped", { count: removed.length })
      await reapAcks(this.config, now)
      const cleaned = await this.registry.cleanupOrphanedInboxes(now)
      if (cleaned.length) {
        this.deps.logger("info", "orphans_cleaned", { count: cleaned.length })
      }
      const expired = await this.registry.cleanupExpiredMessages(now)
      if (expired) this.deps.logger("info", "expired_messages_cleaned", { count: expired })
      const reaped = await this.registry.cleanupProcessed(now)
      if (reaped) this.deps.logger("info", "processed_cleaned", { count: reaped })
      const outbox = await sweepOutbox(this.config, now)
      if (outbox.reconciled) this.deps.logger("info", "outbox_reconciled", { count: outbox.reconciled })
      if (outbox.marked) this.deps.logger("info", "outbox_aged", { count: outbox.marked })
      if (outbox.removed) this.deps.logger("info", "outbox_cleaned", { count: outbox.removed })
    } catch {
      this.deps.logger("error", "sweep_failed")
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const [sessionID] of this.agents) await this.unregisterSession(sessionID)
  }

  // -------------------------------------------------------------- registry

  isRegistered(sessionID: string): boolean {
    return this.agents.has(sessionID)
  }

  selfId(sessionID: string): string | undefined {
    return this.agents.get(sessionID)?.id
  }

  /** Id for a session that pinned one in the config, else the directory name. */
  preferredId(context: SessionContext): string {
    if (this.config.id) return slugify(this.config.id)
    return slugify(path.basename(context.worktree || context.directory) || "agent")
  }

  async register(input: {
    context: SessionContext
    id: string
    description: string
    metadata?: Record<string, string>
    force?: boolean
  }): Promise<{ self: PeerView; peers: PeerView[] }> {
    const routing: AgentRouting = {
      sessionID: input.context.sessionID,
      directory: input.context.directory,
      worktree: input.context.worktree,
      serverUrl: input.context.serverUrl,
    }
    const record = await this.registry.register({
      id: input.id,
      description: input.description,
      metadata: input.metadata ?? {},
      routing,
      ownerInstance: this.ownerInstance,
      force: input.force ?? false,
    })

    const previous = this.agents.get(routing.sessionID)
    if (previous && previous.id !== record.id) await previous.watcher.stop()

    if (!previous || previous.id !== record.id) {
      const watcher = new InboxWatcher(
        this.config,
        record.id,
        routing.sessionID,
        record.ownerInstance ?? this.ownerInstance,
        record.incarnation ?? "",
        (message) => this.receive(routing, message),
        (_error, event, fields) => this.deps.logger("error", event, fields),
      )
      this.agents.set(routing.sessionID, {
        id: record.id,
        routing,
        watcher,
        ownerInstance: record.ownerInstance,
        incarnation: record.incarnation,
      })
      await watcher.start()
    } else {
       this.agents.set(routing.sessionID, {
         id: record.id,
         routing,
         watcher: previous.watcher,
         ownerInstance: record.ownerInstance,
         incarnation: record.incarnation,
       })
    }
    this.startTimer()
    // Registering is itself a turn in that session, so the agent is not idle.
    await this.registry.touchActivity(record.id).catch(() => {})

    const now = Date.now()
    const entries = await this.registry.list(now)
    const self = entries.find((entry) => entry.record.id === record.id)
    return {
      self: self
        ? this.registry.toPeerView(self, record.id, now)
        : {
            id: record.id,
            description: record.description,
            metadata: record.metadata,
            status: "alive",
            lastSeen: new Date().toISOString(),
            idleMs: 0,
            directory: record.routing.directory,
            sessionID: record.routing.sessionID,
            self: true,
          },
      peers: entries
        .filter((entry) => entry.record.id !== record.id)
        .map((entry) => this.registry.toPeerView(entry, record.id, now)),
    }
  }

  /** Register with a derived id, without asking the model for anything. */
  async autoRegister(context: SessionContext): Promise<string | undefined> {
    if (!this.config.autoRegister) return undefined
    if (this.agents.has(context.sessionID)) return this.agents.get(context.sessionID)!.id
    // A pinned id is the operator's choice and keeps its directory-free form;
    // otherwise the name is hashed from the session, not the directory, so two
    // chats in one directory never end up as `repo` and `repo-2`.
    const id = this.config.id
      ? await this.registry.allocateId(this.preferredId(context), context.sessionID)
      : await this.registry.allocateName(context.sessionID)
    const existing = await this.registry.get(id)
    const reuse =
      existing && existing.record.routing.sessionID === context.sessionID
        ? existing.record
        : undefined
    await this.register({
      context,
      id,
      description: reuse?.description ?? `opencode agent working in ${context.directory}`,
      metadata: reuse?.metadata ?? {},
      force: true,
    })
    this.deps.logger("info", "auto_registered")
    return id
  }

  async unregisterSession(sessionID: string): Promise<void> {
    const agent = this.agents.get(sessionID)
    if (!agent) return
    this.agents.delete(sessionID)
    await agent.watcher.stop()
    try {
      await this.registry.unregister(agent.id, {
        ownerInstance: agent.ownerInstance ?? this.ownerInstance,
        incarnation: agent.incarnation ?? "",
      })
    } catch (error) {
      if (error instanceof MeshError && error.code === ErrorCode.FENCED) {
        this.deps.logger("warn", "unregister_fenced")
        return
      }
      throw error
    }
  }

  /**
   * Peers, freshest first: alive before stale, then least idle, id as the
   * tie-break. Ordering is the fix for "every peer looks equally plausible" —
   * the model reads the top of the list first.
   */
  async peers(options: { sessionID?: string; includeStale?: boolean } = {}): Promise<PeerView[]> {
    const selfId = options.sessionID ? this.selfId(options.sessionID) : undefined
    const now = Date.now()
    const entries = await this.registry.list(now)
    return entries
      .filter((entry) => options.includeStale !== false || entry.status === "alive")
      .map((entry) => this.registry.toPeerView(entry, selfId, now))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "alive" ? -1 : 1
        if (a.idleMs !== b.idleMs) return a.idleMs - b.idleMs
        return a.id.localeCompare(b.id)
      })
  }

  /**
   * "A turn just happened in this session." Touch-only marker, so an idle chat
   * stays visibly idle instead of being kept fresh by its own heartbeat.
   */
  async noteActivity(sessionID: string): Promise<void> {
    const id = this.agents.get(sessionID)?.id
    if (!id) return
    await this.registry.touchActivity(id)
  }

  // -------------------------------------------------------------- messaging

  /**
   * Does this address have a mailbox? The directory survives the presence
   * record, which is what makes mail to an agent that is away queue instead of
   * bounce. A sender creates it on the first successful enqueue.
   */
  private async inboxDirExists(id: string): Promise<boolean> {
    try {
      await fs.stat(inboxDirFor(this.config, id))
      return true
    } catch {
      return false
    }
  }

  /**
   * The depth we injected a message at. It comes from our own processed marker,
   * not from the sender's inbox: that copy is deleted the moment delivery
   * succeeds, which used to make every reply look like depth 0 and let a chain
   * run forever.
   */
  private async resolveReplyDepth(parentId: string): Promise<number> {
    return readProcessedDepth(this.config, parentId)
  }

  /**
   * The thread a reply belongs to: the root our own marker remembers, or the
   * parent itself when it predates threads. A missing marker is not an error —
   * the parent is a safe root, it just forks a thread from the middle.
   */
  private async resolveThreadId(parentId: string): Promise<string> {
    return (await readProcessedThreadId(this.config, parentId)) ?? parentId
  }

  async send(input: {
    context: SessionContext
    to: string
    text: string
    context_tag?: string
    in_reply_to?: string
  }): Promise<{ to: string; messageId: string; status: SendStatus; detail: string }> {
    assertValidId(input.to)
    const from = this.agents.get(input.context.sessionID)?.id ?? (await this.autoRegister(input.context))
    if (!from) {
      throw new MeshError(
        ErrorCode.NOT_REGISTERED,
        "this session is not on the mesh yet; call agentmesh_register first",
      )
    }
    if (input.to === from) {
      throw new MeshError(ErrorCode.SELF_SEND, "cannot send a message to yourself")
    }
    if (input.text.length > this.config.maxTextLength) {
      throw new MeshError(
        ErrorCode.TEXT_TOO_LONG,
        `text is ${input.text.length} characters; the limit is ${this.config.maxTextLength}. ` +
          "Send a summary plus file paths instead of pasting content.",
      )
    }

    if (input.in_reply_to && !isMessageId(input.in_reply_to)) {
      throw new MeshError(
        ErrorCode.INVALID_REPLY,
        `reply_to must be a valid message id, got ${JSON.stringify(input.in_reply_to)}`,
      )
    }

    let replyDepth = 0
    if (input.in_reply_to) {
      const parentDepth = await this.resolveReplyDepth(input.in_reply_to)
      if (parentDepth >= this.config.maxReplyDepth) {
        throw new MeshError(
          ErrorCode.REPLY_DEPTH_EXCEEDED,
          `reply chain depth ${parentDepth + 1} exceeds the limit of ${this.config.maxReplyDepth}`,
        )
      }
      replyDepth = parentDepth + 1
    }

    // Addressability is not presence. A record proves the address was used
    // recently; the inbox directory proves it was used at all, and it outlives
    // the record on purpose — mail for an agent that is away has to queue.
    const target = await this.registry.get(input.to)
    if (!target && !(await this.inboxDirExists(input.to))) {
      const known = (await this.peers({ sessionID: input.context.sessionID }))
        .map((peer) => peer.id)
        .join(", ")
      throw new MeshError(
        ErrorCode.NO_AGENT,
        `no agent ${JSON.stringify(input.to)} is registered. ` +
          (known ? `Registered right now: ${known}.` : "Nobody is registered right now."),
      )
    }

    const id = newMessageId()
    const message: MeshMessage = {
      schemaVersion: 1,
      id,
      from,
      to: input.to,
      text: input.text,
      replyDepth,
      // A thread is just its root message id, so no coordination is needed: a
      // reply inherits it and every participant agrees without asking anyone.
      threadId: input.in_reply_to ? await this.resolveThreadId(input.in_reply_to) : id,
      sentAt: new Date().toISOString(),
    }
    if (input.context_tag) message.context = input.context_tag
    if (input.in_reply_to) message.in_reply_to = input.in_reply_to
    await enqueue(this.config, message)
    const record = { id, to: input.to, threadId: message.threadId }
    await writeOutboxEntry(this.config, {
      ...record,
      state: "queued",
      at: message.sentAt,
    })

    const ack = await waitForAck(this.config, message.id, this.config.ackWaitMs, input.to)
    let status: SendStatus
    let detail: string
    if (ack?.status === "accepted") {
      status = "accepted"
      detail = `accepted into ${input.to}'s session as a new user turn`
    } else if (ack?.status === "ambiguous") {
      status = "ambiguous"
      detail = ack.detail ?? `${input.to}'s delivery outcome is unknown`
    } else if (ack?.status === "failed") {
      status = "failed"
      detail =
        `${input.to} received the message but could not inject it: ` +
        (ack.detail ?? "unknown error")
    } else {
      status = "queued"
      detail =
        target?.status === "alive"
          ? `queued in ${input.to}'s inbox; no confirmation within ${this.config.ackWaitMs}ms`
          : `${input.to} is ${target?.status ?? "offline"}; the message waits in its inbox until it comes back`
    }
    // The inbox copy is the recipient's to delete, but what it did to us is
    // ours to keep: the ack outlives neither the answer nor our own memory.
    await writeOutboxEntry(this.config, { ...record, state: status, at: new Date().toISOString() })
    return { to: input.to, messageId: id, status, detail }
  }

  /** Called by our own inbox watcher: put the envelope into our session. */
  private async receive(routing: AgentRouting, message: MeshMessage): Promise<void> {
    await this.deps.inject({
      sessionID: routing.sessionID,
      directory: routing.directory,
      text: renderEnvelope(message),
    })
    this.deps.logger("info", "message_accepted")
  }
}
