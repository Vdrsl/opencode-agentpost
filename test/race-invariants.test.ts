/**
 * Adversarial delivery races. Nothing here is about business logic: every case
 * is about the one property the claim primitive exists to guarantee — a message
 * has exactly one winner, whoever gets there first, and a loser never injects it.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, describe, it } from "node:test"

import { type MeshConfig } from "../src/config.ts"
import { enqueue, InboxWatcher } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import type { MeshMessage } from "../src/types.ts"
import { messageFiles, tempHome, testConfig, waitFor } from "./helpers.ts"

const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const cleanup of cleanups.slice().reverse()) await cleanup()
})

/**
 * A throwaway home. `fetchFallbackMs: 1` keeps a pile of messages on the
 * inject path instead of the batch path, so these cases measure the claim and
 * nothing else — no sleeping through a 30s window to find out who won.
 */
async function raceHome(overrides: Partial<MeshConfig> = {}): Promise<MeshConfig> {
  const dir = await tempHome()
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return testConfig(dir, { fetchFallbackMs: 1, ...overrides })
}

function raceWatcher(config: MeshConfig, instance: string, injected: string[]): InboxWatcher {
  const watcher = new InboxWatcher(
    config,
    "reviewer",
    `ses_${instance}`,
    `owner_${instance}`,
    `incarnation_${instance}`,
    async (message) => void injected.push(message.id),
    () => {},
    {},
    async () => {},
  )
  cleanups.push(() => watcher.stop())
  return watcher
}

/** Never started, so nothing drains behind the test's back. */
function idleWatcher(config: MeshConfig): InboxWatcher {
  return new InboxWatcher(
    config,
    "reviewer",
    "ses_idle",
    "owner_idle",
    "incarnation_idle",
    async () => assert.fail("an unfetched message must not be injected"),
    () => {},
  )
}

function raceMessage(id: string): MeshMessage {
  return {
    schemaVersion: 1,
    id,
    from: "planner",
    to: "reviewer",
    text: `race ${id}`,
    sentAt: new Date().toISOString(),
  }
}

/** A promise plus its resolver, so a test can hold delivery open on demand. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** Let every already-resolved microtask and promise callback run. No timer. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe("delivery races", () => {
  // The multi-process takeover case: two opencode processes, one shared home,
  // one agent id. Whoever gets there first delivers; the other must find nothing.
  it("delivers every message exactly once across two watchers on one agent id", async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const config = await raceHome()
      const first: string[] = []
      const second: string[] = []
      const a = raceWatcher(config, "a", first)
      const b = raceWatcher(config, "b", second)
      await Promise.all([a.start(), b.start()])

      const ids = Array.from({ length: 6 }, () => newMessageId())
      for (const id of ids) await enqueue(config, raceMessage(id))

      const total = (): number => first.length + second.length
      await waitFor(() => total() === ids.length)

      // Two more full rounds: a late duplicate is claimed here, not after the
      // test has already asserted the count.
      await Promise.all([a.drain(), b.drain()])
      await Promise.all([a.drain(), b.drain()])

      assert.equal(total(), ids.length, `iteration ${iteration}: a duplicate or a lost message`)
      assert.equal(new Set([...first, ...second]).size, ids.length)
      assert.deepEqual(await messageFiles(path.join(config.inboxDir, "reviewer")), [])

      await Promise.all([a.stop(), b.stop()])
    }
  })

  it("never hands one message to two of five concurrent fetches", async () => {
    const config = await raceHome()
    const watcher = idleWatcher(config)
    const ids = Array.from({ length: 10 }, () => newMessageId())
    for (const id of ids) await enqueue(config, raceMessage(id))

    const results = await Promise.all(
      Array.from({ length: 5 }, () => watcher.takeBatch(10)),
    )
    const delivered = results.flatMap((result) => result.messages.map((message) => message.id))

    for (const result of results) {
      assert.equal(new Set(result.messages.map((message) => message.id)).size, result.messages.length)
    }
    assert.equal(new Set(delivered).size, delivered.length, "a message was fetched twice")
    assert.equal(delivered.length, ids.length, "a claimed message was never handed back")
    assert.deepEqual([...delivered].sort(), [...ids].sort())
  })

  it("does not let a second watcher deliver a message the first is injecting", async () => {
    const config = await raceHome()
    const held = deferred()
    const started: string[] = []
    const injecting: string[] = []
    const rival: string[] = []

    const first = new InboxWatcher(
      config,
      "reviewer",
      "ses_a",
      "owner_a",
      "incarnation_a",
      async (message) => {
        started.push(message.id)
        await held.promise
        injecting.push(message.id)
      },
      () => {},
      {},
      async () => {},
    )
    cleanups.push(() => first.stop())
    const second = raceWatcher(config, "b", rival)
    await first.start()

    const id = newMessageId()
    await enqueue(config, raceMessage(id))
    // The handler is running, so the claim is ours and the pending name is gone.
    // Only now does the rival appear: it is the takeover that has to fail, not a
    // race for who claims first.
    await waitFor(() => started.length === 1)
    await second.start()

    // Let the rival drain, poll and fetch. It must find nothing at all: the
    // message is neither pending nor injectable, it is mid-inject.
    await second.drain()
    await second.drain()
    assert.deepEqual(await second.takeBatch(10), { messages: [], hasMore: false })
    assert.deepEqual(rival, [])
    assert.deepEqual(injecting, [], "the first watcher finished without being released")

    held.release()
    await waitFor(() => injecting.length === 1)
    await Promise.all([first.drain(), second.drain()])

    assert.deepEqual(injecting, [id])
    assert.deepEqual(rival, [], "the second watcher injected the message already in flight")
    assert.deepEqual(await messageFiles(path.join(config.inboxDir, "reviewer")), [])
    await settled()
    assert.deepEqual(rival, [])
  })
})