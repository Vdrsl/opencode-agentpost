/**
 * The sender's half of a delivery: one file per message under `<home>/outbox/`.
 *
 * The inbox is the recipient's copy and the ack only lives for `ackRetentionMs`,
 * so without this the sender forgets its own message within minutes. Ownership
 * follows the acks: the sender writes its own entry, and ageing it is a sweep
 * like any other, because a crashed sender must not pin its state forever.
 *
 * The state is *what we last heard*, never what we assume. `queued` and
 * `ambiguous` mean the recipient may still confirm; the rest are final, and a
 * final state is never downgraded.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { MeshConfig } from "./config.ts"
import { isMessageId } from "./ids.ts"
import { readAck } from "./inbox.ts"
import { ageMs, listJsonFiles, readJson, removeFile, writeJsonAtomic } from "./store.ts"

/** `undeliverable` is ours, not the recipient's: nobody acked in time. */
export type OutboxState = "queued" | "accepted" | "failed" | "ambiguous" | "undeliverable"

export type OutboxEntry = {
  id: string
  from: string
  to: string
  threadId?: string
  state: OutboxState
  at: string
}

const FINAL: readonly OutboxState[] = ["accepted", "failed", "undeliverable"]

function isFinal(state: OutboxState): boolean {
  return FINAL.includes(state)
}

export function outboxPath(config: MeshConfig, messageId: string): string {
  return path.join(config.outboxDir, `${messageId}.json`)
}

/** Create or move our own entry. Ignores any attempt to walk a state backwards. */
export async function writeOutboxEntry(
  config: MeshConfig,
  entry: OutboxEntry,
): Promise<void> {
  const existing = await readOutboxEntry(config, entry.id)
  if (existing && isFinal(existing.state) && !isFinal(entry.state)) return
  await writeJsonAtomic(outboxPath(config, entry.id), entry)
}

export async function readOutboxEntry(
  config: MeshConfig,
  messageId: string,
): Promise<OutboxEntry | undefined> {
  if (!isMessageId(messageId)) return undefined
  const raw = await readJson<OutboxEntry>(outboxPath(config, messageId))
  return raw && raw.id === messageId ? raw : undefined
}

/**
 * Every entry we sent, newest last. Filenames are ULIDs, so sorting by name is
 * sorting by time — no second clock to keep in sync. Entries written before
 * `from` existed have none, and a message nobody can attribute is not ours to
 * report, so they are skipped.
 */
export async function listOutboxEntries(config: MeshConfig): Promise<OutboxEntry[]> {
  const entries: OutboxEntry[] = []
  for (const name of await listJsonFiles(config.outboxDir)) {
    const entry = await readJson<OutboxEntry>(path.join(config.outboxDir, name)).catch(
      () => undefined,
    )
    if (entry && entry.id === name.slice(0, -".json".length) && entry.from) entries.push(entry)
  }
  return entries
}

/** Our own outbox, newest first, for `agentmesh_deliveries`. */
export async function getDeliveries(
  config: MeshConfig,
  from: string,
  filter: { to?: string; state?: OutboxState } = {},
  limit = 20,
): Promise<OutboxEntry[]> {
  const entries = (await listOutboxEntries(config)).filter((entry) => entry.from === from)
  const filtered = entries.filter(
    (entry) => (!filter.to || entry.to === filter.to) && (!filter.state || entry.state === filter.state),
  )
  return filtered.slice(-limit).reverse()
}

/**
 * Bring the outbox in line with what the recipient actually said, then retire
 * what nobody ever confirmed.
 *
 * The ack is what we last heard, so it wins over our own state: a busy
 * recipient acks long after `ackWaitMs` gave up, and without this a delivered
 * message would sit at `queued` until it aged into `undeliverable`. An
 * acknowledged entry is therefore left alone, and once the ack itself is
 * reaped the entry ages out on the next sweep like any other.
 *
 * Ageing is measured on the file's mtime, which every write bumps. A record
 * reconciled just now is therefore young again, and the rewrite that marks it
 * `undeliverable` buys the verdict one more window before it is deleted.
 */
export async function sweepOutbox(
  config: MeshConfig,
  now: number = Date.now(),
): Promise<{ reconciled: number; marked: number; removed: number }> {
  let reconciled = 0
  let marked = 0
  let removed = 0
  for (const name of await listJsonFiles(config.outboxDir)) {
    const file = path.join(config.outboxDir, name)
    const entry = await readJson<OutboxEntry>(file).catch(() => undefined)
    const id = name.slice(0, -".json".length)
    if (!entry || entry.id !== id || !isMessageId(id)) continue
    const ack = await readAck(config, id).catch(() => undefined)
    if (ack) {
      if (entry.state !== ack.status) {
        await writeJsonAtomic(file, { ...entry, state: ack.status })
        reconciled += 1
      }
      continue
    }
    let old: boolean
    try {
      old = ageMs((await fs.stat(file)).mtimeMs, now) >= config.messageRetentionMs
    } catch {
      continue
    }
    if (!old) continue
    if (isFinal(entry.state)) {
      await removeFile(file)
      removed += 1
      continue
    }
    await writeJsonAtomic(file, { ...entry, state: "undeliverable" satisfies OutboxState })
    marked += 1
  }
  return { reconciled, marked, removed }
}
