/**
 * The mesh as one plugin instance sees it.
 *
 * A plugin instance can host more than one session (several opencode sessions
 * in the same directory), so every registered session gets its own record,
 * its own inbox watcher and its own place in the registry. One shared timer
 * heartbeats them all and sweeps the dead ones.
 */

import path from "node:path"
import { randomUUID } from "node:crypto"

import { assertValidId, type MeshConfig, slugify } from "./config.ts"
import type { Logger } from "./logger.ts"
import { renderEnvelope } from "./envelope.ts"
import { enqueue, inboxDirFor, InboxWatcher, reapAcks, waitForAck } from "./inbox.ts"
import { isMessageId, newMessageId } from "./ids.ts"
import { readJson } from "./store.ts"
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

  /** Default id for a session: the worktree directory name, slugified. */
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

    const entries = await this.registry.list()
    const self = entries.find((entry) => entry.record.id === record.id)
    return {
      self: self
        ? this.registry.toPeerView(self, record.id)
        : {
            id: record.id,
            description: record.description,
            metadata: record.metadata,
            status: "alive",
            lastSeen: new Date().toISOString(),
            directory: record.routing.directory,
            self: true,
          },
      peers: entries
        .filter((entry) => entry.record.id !== record.id)
        .map((entry) => this.registry.toPeerView(entry, record.id)),
    }
  }

  /** Register with a derived id, without asking the model for anything. */
  async autoRegister(context: SessionContext): Promise<string | undefined> {
    if (!this.config.autoRegister) return undefined
    if (this.agents.has(context.sessionID)) return this.agents.get(context.sessionID)!.id
    const id = await this.registry.allocateId(this.preferredId(context), context.sessionID)
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

  async peers(options: { sessionID?: string; includeStale?: boolean } = {}): Promise<PeerView[]> {
    const selfId = options.sessionID ? this.selfId(options.sessionID) : undefined
    const entries = await this.registry.list()
    return entries
      .filter((entry) => options.includeStale !== false || entry.status === "alive")
      .map((entry) => this.registry.toPeerView(entry, selfId))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  // -------------------------------------------------------------- messaging

  private async resolveReplyDepth(agentId: string, parentId: string): Promise<number> {
    const file = path.join(inboxDirFor(this.config, agentId), `${parentId}.json`)
    const parent = await readJson<MeshMessage>(file)
    const depth = parent?.replyDepth
    return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : 0
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
      const parentDepth = await this.resolveReplyDepth(from, input.in_reply_to)
      if (parentDepth >= this.config.maxReplyDepth) {
        throw new MeshError(
          ErrorCode.REPLY_DEPTH_EXCEEDED,
          `reply chain depth ${parentDepth + 1} exceeds the limit of ${this.config.maxReplyDepth}`,
        )
      }
      replyDepth = parentDepth + 1
    }

    const target = await this.registry.get(input.to)
    if (!target) {
      const known = (await this.peers({ sessionID: input.context.sessionID }))
        .map((peer) => peer.id)
        .join(", ")
      throw new MeshError(
        ErrorCode.NO_AGENT,
        `no agent ${JSON.stringify(input.to)} is registered. ` +
          (known ? `Registered right now: ${known}.` : "Nobody is registered right now."),
      )
    }

    const message: MeshMessage = {
      schemaVersion: 1,
      id: newMessageId(),
      from,
      to: input.to,
      text: input.text,
      replyDepth,
      sentAt: new Date().toISOString(),
    }
    if (input.context_tag) message.context = input.context_tag
    if (input.in_reply_to) message.in_reply_to = input.in_reply_to
    await enqueue(this.config, message)

    const ack = await waitForAck(this.config, message.id, this.config.ackWaitMs, input.to)
    if (ack?.status === "accepted") {
      return {
        to: input.to,
        messageId: message.id,
        status: "accepted",
        detail: `accepted into ${input.to}'s session as a new user turn`,
      }
    }
    if (ack?.status === "ambiguous") {
      return {
        to: input.to,
        messageId: message.id,
        status: "ambiguous",
        detail: ack.detail ?? `${input.to}'s delivery outcome is unknown`,
      }
    }
    if (ack?.status === "failed") {
      return {
        to: input.to,
        messageId: message.id,
        status: "failed",
        detail: `${input.to} received the message but could not inject it: ${ack.detail ?? "unknown error"}`,
      }
    }
    return {
      to: input.to,
      messageId: message.id,
      status: "queued",
      detail:
        target.status === "alive"
          ? `queued in ${input.to}'s inbox; no confirmation within ${this.config.ackWaitMs}ms`
          : `${input.to} is ${target.status}; the message waits in its inbox until it comes back`,
    }
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
