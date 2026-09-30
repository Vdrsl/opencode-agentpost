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
import { agentName } from "./names.ts"
import {
  ageMs,
  ensureDir,
  listDirs,
  listJsonFiles,
  pidAlive,
  readJsonWithMtime,
  removeDir,
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

  /**
   * May this address be handed to a session that is not its owner?
   *
   * Deliberately not `status`: a hung process still heartbeats its record, so it
   * looks alive for as long as the sweep tolerates, and `stale` would report it
   * as alive for another `staleAfterMs` on top. An address is takeable once the
   * owner cannot be trusted to still want it — its process is gone, or it has
   * been quiet long enough that the record is about to be reaped anyway.
   *
   * A reused pid is the case this exists for: the old process died, the new one
   * inherited the number, and `pidAlive` answers true. Nothing is lost by
   * waiting out `presenceReapMs`, because reap would drop the record anyway.
   */
  takeable(entry: RegistryEntry, now: number = Date.now()): boolean {
    return !pidAlive(entry.record.pid) || ageMs(entry.mtimeMs, now) >= this.config.presenceReapMs
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

  /**
   * Bump our mtime.
   *
   * `ok` refreshed it. `missing` means the record is gone — reaped by another
   * mesh's sweep while this session was blocked past `presenceReapMs`. `fenced`
   * means another session owns the address now.
   *
   * The caller must not read those two the same. A missing record is not a
   * takeover: the mailbox is still ours and still addressable, so tearing the
   * watcher down here would leave peers queueing mail that nobody ever reads.
   */
  async heartbeat(id: string, expected?: OwnerIdentity): Promise<"ok" | "missing" | "fenced"> {
    const entry = await this.get(id)
    if (!entry) return "missing"
    if (entry.record.schemaVersion === 1 && !sameOwner(entry.record, expected)) return "fenced"
    return (await touch(this.recordPath(id))) ? "ok" : "missing"
  }

  async unregister(id: string, expected?: OwnerIdentity): Promise<void> {
    const entry = await this.get(id)
    if (!entry) return
    if (entry.record.schemaVersion === 1 && !sameOwner(entry.record, expected)) {
      throw new MeshError(ErrorCode.FENCED, `id ${JSON.stringify(id)} is owned by another instance`)
    }
    await removeFile(this.recordPath(id))
    await removeFile(this.activityPath(id))
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
   * Walk candidate names until one is free. A name we already hold ourselves is
   * returned as-is, so a restart reclaims the same address instead of drifting.
   */
  private async pickFree(
    name: (attempt: number) => string,
    fallback: string,
    sessionID: string,
  ): Promise<string> {
    const now = Date.now()
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = name(attempt)
      const existing = await this.get(candidate, now)
      if (!existing) return candidate
      if (existing.record.routing.sessionID === sessionID) return candidate
      if (this.takeable(existing, now)) return candidate
    }
    return fallback
  }

  /**
   * The address a new session should inherit, or undefined when it has none to
   * inherit.
   *
   * Recreating a chat gives it a new session id, and a name hashed from the
   * session id would therefore change — stranding the mailbox the address used
   * to own, along with any mail queued in it. So a session starting in a
   * directory that already had a takeable address claims that address instead of
   * minting a new one, and the mailbox simply stays where it is.
   *
   * Only one address is inherited, the most recently seen takeable one, and only
   * within `presenceReapMs` of the predecessor going quiet: past that the sweep
   * reaps the record, the mailbox is reaped with it, and a tombstone would be
   * preserving an address nobody is going to use.
   *
   * Returns the whole entry rather than its id. The caller needs the description
   * and metadata the record carries, and re-reading them by id would be a second
   * lookup whose answer can already be a different record than the one that
   * justified the takeover.
   */
  async inheritableAddress(
    directory: string,
    sessionID: string,
    now: number = Date.now(),
  ): Promise<RegistryEntry | undefined> {
    let best: RegistryEntry | undefined
    for (const entry of await this.list(now)) {
      if (entry.record.routing.directory !== directory) continue
      if (entry.record.routing.sessionID === sessionID) continue
      if (!this.takeable(entry, now)) continue
      if (!best || entry.mtimeMs > best.mtimeMs) best = entry
    }
    return best
  }

  /**
   * Pick a free id for auto-registration: `preferred`, else `preferred-2`, …
   * An id already held by our own session is reused as-is. Only used when the
   * operator pinned an id in the config.
   */
  async allocateId(preferred: string, sessionID: string): Promise<string> {
    return this.pickFree(
      (attempt) => (attempt === 1 ? preferred : `${preferred}-${attempt}`),
      `${preferred}-${sessionID.slice(-6).toLowerCase()}`,
      sessionID,
    )
  }

  /**
   * Pick a free name for auto-registration: an adjective-noun pair hashed from
   * the session id, so the same chat keeps its address across restarts while two
   * chats in one directory get different, sayable names.
   */
  async allocateName(sessionID: string): Promise<string> {
    return this.pickFree(
      (attempt) => agentName(sessionID, attempt),
      `${agentName(sessionID, 1)}-${sessionID.slice(-6).toLowerCase()}`,
      sessionID,
    )
  }

  /** Drop records that have been dead long enough that nobody should see them. */
  async reap(now: number = Date.now()): Promise<string[]> {
    const removed: string[] = []
    for (const entry of await this.list(now)) {
      if (ageMs(entry.mtimeMs, now) < this.config.presenceReapMs) continue
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

  /**
   * Drop the inbox of an agent that is gone for good. Only an inbox that is
   * empty is a candidate: a non-empty one still holds messages someone must
   * deliver, and a registered agent owns its inbox even while idle. Ageing
   * matters too, because a peer can be between unregistering and coming back.
   */
  async cleanupOrphanedInboxes(now: number = Date.now()): Promise<string[]> {
    const removed: string[] = []
    let dirs: string[]
    try {
      dirs = await fs.readdir(this.config.inboxDir)
    } catch {
      return removed
    }
    for (const name of dirs) {
      if (await this.get(name, now)) continue
      try {
        const inbox = this.inboxPath(name)
        if ((await fs.readdir(inbox)).length > 0) continue
        if (ageMs((await fs.stat(inbox)).mtimeMs, now) < this.config.queueRetentionMs) continue
        await removeDir(inbox)
      } catch {
        continue
      }
      removed.push(name)
    }
    return removed
  }

  /**
   * Age out the local processed markers. They exist to suppress a replay of a
   * message we already injected, and one file is written per delivery, so
   * without this they grow forever. Age comes from mtime, which is the moment
   * the injection happened.
   */
  async cleanupProcessed(now: number = Date.now()): Promise<number> {
    let removed = 0
    for (const name of await listJsonFiles(this.config.processedDir)) {
      const file = path.join(this.config.processedDir, name)
      try {
        if (ageMs((await fs.stat(file)).mtimeMs, now) < this.config.processedRetentionMs) {
          continue
        }
        await removeFile(file)
      } catch {
        continue
      }
      removed += 1
    }
    return removed
  }

  /**
   * Age out messages nobody ever picked up. Queueing must outlive presence —
   * that is the whole point of the mailbox model — so an undelivered message
   * cannot be reaped with the record. Without a TTL here, a peer that never
   * comes back leaves its inbox forever and blocks cleanup of the directory.
   */
  async cleanupExpiredMessages(now: number = Date.now()): Promise<number> {
    let removed = 0
    for (const root of [this.config.inboxDir, this.config.deadDir, this.config.quarantineDir]) {
      for (const agentId of await listDirs(root)) {
        const dir = path.join(root, agentId)
        for (const name of await listJsonFiles(dir)) {
          const file = path.join(dir, name)
          try {
            if (ageMs((await fs.stat(file)).mtimeMs, now) < this.config.messageRetentionMs) {
              continue
            }
            await removeFile(file)
          } catch {
            continue
          }
          removed += 1
        }
      }
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
      sessionID: entry.record.routing.sessionID,
    }
    if (entry.record.id === selfId) view.self = true
    return view
  }
}
