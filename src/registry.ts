/**
 * The registry: one JSON file per agent under `<home>/agents/`, plus one
 * touch-only marker per agent under `<home>/activity/`.
 *
 * Only an agent's own plugin instance ever writes its record, so there is no
 * shared mutable state and no locking. Liveness is the record file's mtime
 * (bumped by a heartbeat) plus a pid check, which turns a killed opencode into
 * an immediately-stale peer instead of one that lingers for a minute.
 *
 * The activity marker answers a different question — "was anyone actually
 * driving this session?" — because a long-lived opencode process keeps
 * heartbeating for chats the human abandoned days ago. Like the heartbeat it
 * is `utimes` only, so no reader ever sees the agent's record disappear.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { assertValidId, type MeshConfig } from "./config.ts"
import { noopLogger, type Logger } from "./logger.ts"
import {
  ageMs,
  ensureDir,
  listJsonFiles,
  pidAlive,
  readJsonWithMtime,
  removeFile,
  touch,
  writeJsonAtomic,
} from "./store.ts"
import {
  type AgentRecord,
  type AgentRouting,
  type OwnerIdentity,
  ErrorCode,
  MeshError,
  type PeerView,
} from "./types.ts"

export type RegistryEntry = {
  record: AgentRecord
  mtimeMs: number
  /** Last session turn. Falls back to the record mtime for older records. */
  activityMtimeMs: number
  status: "alive" | "stale"
}

export type RegisterInput = {
  id: string
  description: string
  metadata?: Record<string, string>
  routing: AgentRouting
  ownerInstance?: string
  force?: boolean
}

function ownerIdentity(record: AgentRecord): OwnerIdentity | undefined {
  if (record.schemaVersion !== 1) return undefined
  if (typeof record.ownerInstance !== "string" || typeof record.incarnation !== "string") return undefined
  return { ownerInstance: record.ownerInstance, incarnation: record.incarnation }
}

function sameOwner(record: AgentRecord, expected: OwnerIdentity | undefined): boolean {
  const owner = ownerIdentity(record)
  return owner !== undefined && expected !== undefined &&
    owner.ownerInstance === expected.ownerInstance && owner.incarnation === expected.incarnation
}

export class Registry {
  private readonly config: MeshConfig
  private readonly logger: Logger

  constructor(config: MeshConfig, logger: Logger = noopLogger) {
    this.config = config
    this.logger = logger
  }

  recordPath(id: string): string {
    assertValidId(id)
    return path.join(this.config.agentsDir, `${id}.json`)
  }

  activityPath(id: string): string {
    assertValidId(id)
    return path.join(this.config.activityDir, id)
  }

  /**
   * Mark "a turn just happened in this agent's session". Touch-only, exactly
   * like the heartbeat: the record itself is never rewritten, so a concurrent
   * `list()` can never observe it missing.
   */
  async touchActivity(id: string): Promise<void> {
    const file = this.activityPath(id)
    await ensureDir(this.config.activityDir)
    if (await touch(file)) return
    await writeJsonAtomic(file, { id, at: new Date().toISOString() })
  }

  /** Activity mtime, or `undefined` for an agent that never reported a turn. */
  private async readActivityMtime(id: string): Promise<number | undefined> {
    try {
      return (await fs.stat(this.activityPath(id))).mtimeMs
    } catch {
      return undefined
    }
  }

  inboxPath(id: string): string {
    assertValidId(id)
    return path.join(this.config.inboxDir, id)
  }

  private statusOf(record: AgentRecord, mtimeMs: number, now: number): "alive" | "stale" {
    if (ageMs(mtimeMs, now) >= this.config.staleAfterMs) return "stale"
    return pidAlive(record.pid) ? "alive" : "stale"
  }

  async list(now: number = Date.now()): Promise<RegistryEntry[]> {
    const files = await listJsonFiles(this.config.agentsDir)
    const entries: RegistryEntry[] = []
    for (const file of files) {
      const read = await readJsonWithMtime<AgentRecord>(path.join(this.config.agentsDir, file))
      if (!read?.value?.id || !read.value.routing) continue
      if (read.value.schemaVersion !== undefined && read.value.schemaVersion !== 1) continue
      if (read.value.schemaVersion === 1 && !ownerIdentity(read.value)) continue
      entries.push({
        record: read.value,
        mtimeMs: read.mtimeMs,
        activityMtimeMs: (await this.readActivityMtime(read.value.id)) ?? read.mtimeMs,
        status: this.statusOf(read.value, read.mtimeMs, now),
      })
    }
    return entries
  }

  async get(id: string, now: number = Date.now()): Promise<RegistryEntry | undefined> {
    assertValidId(id)
    const read = await readJsonWithMtime<AgentRecord>(this.recordPath(id))
    if (!read?.value?.id || !read.value.routing) return undefined
    if (read.value.schemaVersion !== undefined && read.value.schemaVersion !== 1) return undefined
    if (read.value.schemaVersion === 1 && !ownerIdentity(read.value)) return undefined
    return {
      record: read.value,
      mtimeMs: read.mtimeMs,
      activityMtimeMs: (await this.readActivityMtime(read.value.id)) ?? read.mtimeMs,
      status: this.statusOf(read.value, read.mtimeMs, now),
    }
  }

  /**
   * Write this agent's record, taking over the id when it is free, held by our
   * own session, or held by a peer that is no longer alive.
   */
  async register(input: RegisterInput): Promise<AgentRecord> {
    assertValidId(input.id)
    const now = Date.now()
    const existing = await this.get(input.id, now)
    const heldByOther = existing && existing.record.routing.sessionID !== input.routing.sessionID
    if (heldByOther && existing.status === "alive" && !input.force) {
      throw new MeshError(
        ErrorCode.CONFLICT,
        `id ${JSON.stringify(input.id)} is already held by a live agent in ` +
          `${existing.record.routing.directory}. Pick another id, or pass force: true to take it over.`,
      )
    }

    // Re-registering under a new id: drop the record the old id left behind.
    await this.releaseOtherIdsOf(input.routing.sessionID, input.id)

    const record: AgentRecord = {
      schemaVersion: 1,
      id: input.id,
      description: input.description,
      metadata: input.metadata ?? {},
      routing: input.routing,
      pid: process.pid,
      ownerInstance: input.ownerInstance ?? randomUUID(),
      incarnation: randomUUID(),
      hostId: this.config.hostId,
      registeredAt:
        existing && !heldByOther ? existing.record.registeredAt : new Date(now).toISOString(),
    }
    await writeJsonAtomic(this.recordPath(input.id), record)
    return record
  }

  /** Bump our mtime. Returns false when the record vanished or is fenced. */
  async heartbeat(id: string, expected?: OwnerIdentity): Promise<boolean> {
    const entry = await this.get(id)
    if (!entry) return false
    if (entry.record.schemaVersion === 1 && !sameOwner(entry.record, expected)) return false
    return touch(this.recordPath(id))
  }

  async unregister(id: string, expected?: OwnerIdentity): Promise<void> {
    const entry = await this.get(id)
    if (!entry) return
    if (entry.record.schemaVersion === 1 && !sameOwner(entry.record, expected)) {
      throw new MeshError(ErrorCode.FENCED, `id ${JSON.stringify(id)} is owned by another instance`)
    }
    await removeFile(this.recordPath(id))
  }

  private async releaseOtherIdsOf(sessionID: string, keepId: string): Promise<void> {
    for (const entry of await this.list()) {
      if (entry.record.id === keepId) continue
      if (entry.record.routing.sessionID === sessionID) {
        await this.unregister(entry.record.id, ownerIdentity(entry.record))
      }
    }
  }

  /**
   * Pick a free id for auto-registration: `preferred`, else `preferred-2`, …
   * An id already held by our own session is reused as-is.
   */
  async allocateId(preferred: string, sessionID: string): Promise<string> {
    const now = Date.now()
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = attempt === 1 ? preferred : `${preferred}-${attempt}`
      const existing = await this.get(candidate, now)
      if (!existing) return candidate
      if (existing.record.routing.sessionID === sessionID) return candidate
      if (existing.status !== "alive") return candidate
    }
    return `${preferred}-${sessionID.slice(-6).toLowerCase()}`
  }

  /** Drop records that have been dead long enough that nobody should see them. */
  async reap(now: number = Date.now()): Promise<string[]> {
    const removed: string[] = []
    for (const entry of await this.list(now)) {
      if (ageMs(entry.mtimeMs, now) < this.config.expireAfterMs) continue
      try {
        await this.unregister(entry.record.id, ownerIdentity(entry.record))
      } catch (error) {
        if (error instanceof MeshError && error.code === ErrorCode.FENCED) continue
        throw error
      }
      removed.push(entry.record.id)
    }
    return removed
  }

  toPeerView(entry: RegistryEntry, selfId?: string, now: number = Date.now()): PeerView {
    const view: PeerView = {
      id: entry.record.id,
      description: entry.record.description,
      metadata: entry.record.metadata,
      status: entry.status,
      lastSeen: new Date(entry.mtimeMs).toISOString(),
      idleMs: ageMs(entry.activityMtimeMs, now),
      directory: entry.record.routing.directory,
    }
    if (entry.record.id === selfId) view.self = true
    return view
  }
}
