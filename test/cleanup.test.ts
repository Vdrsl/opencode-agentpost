import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, describe, it } from "node:test"

import { Registry } from "../src/registry.ts"
import { InboxWatcher } from "../src/inbox.ts"
import { noopLogger } from "../src/logger.ts"
import { type AgentRouting } from "../src/types.ts"
import { newMessageId } from "../src/ids.ts"
import { tempHome, testConfig } from "./helpers.ts"

const homes: string[] = []
after(async () => {
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

async function newRegistry(overrides = {}) {
  const home = await tempHome()
  homes.push(home)
  return { home, config: testConfig(home, overrides), registry: new Registry(testConfig(home, overrides)) }
}

function routing(sessionID: string, directory = "/tmp/project"): AgentRouting {
  return { sessionID, directory, worktree: directory, serverUrl: "http://127.0.0.1:4096" }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

/** Backdate a path so an age-based sweep considers it stale. */
async function backdate(target: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await fs.utimes(target, when, when)
}

async function writeProcessed(config: ReturnType<typeof testConfig>, id: string): Promise<string> {
  const file = path.join(config.processedDir, `${id}.json`)
  await fs.mkdir(config.processedDir, { recursive: true })
  await fs.writeFile(file, JSON.stringify({ id, at: new Date().toISOString() }))
  return file
}

describe("cleanup", () => {
  it("removes the activity marker when an agent unregisters", async () => {
    const { config, registry } = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await registry.touchActivity("planner")
    const record = (await registry.get("planner"))?.record
    const marker = path.join(config.activityDir, "planner")
    assert.equal(await exists(marker), true)

    await registry.unregister("planner", {
      ownerInstance: record?.ownerInstance ?? "",
      incarnation: record?.incarnation ?? "",
    })
    assert.equal(await exists(marker), false)
    assert.equal(await exists(path.join(config.agentsDir, "planner.json")), false)
  })

  it("removes the activity marker when the record is reaped", async () => {
    const { config, registry } = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await registry.touchActivity("planner")
    const marker = path.join(config.activityDir, "planner")
    assert.equal(await exists(marker), true)

    const removed = await registry.reap(Date.now() + config.presenceReapMs + 1)
    assert.deepEqual(removed, ["planner"])
    assert.equal(await exists(marker), false)
  })

  it("removes an empty inbox of a gone agent once it ages out", async () => {
    const { config, registry } = await newRegistry({ queueRetentionMs: 1_000 })
    const inbox = path.join(config.inboxDir, "gone")
    await fs.mkdir(inbox, { recursive: true })
    await backdate(inbox, 60_000)

    assert.deepEqual(await registry.cleanupOrphanedInboxes(), ["gone"])
    assert.equal(await exists(inbox), false)
  })

  it("keeps the inbox of a registered agent even when it is empty and old", async () => {
    const { config, registry } = await newRegistry({ queueRetentionMs: 1_000 })
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    const inbox = path.join(config.inboxDir, "planner")
    await fs.mkdir(inbox, { recursive: true })
    await backdate(inbox, 60_000)

    assert.deepEqual(await registry.cleanupOrphanedInboxes(), [])
    assert.equal(await exists(inbox), true)
  })

  // The gate here is emptiness, not age: the directory is backdated past
  // queueRetentionMs on purpose, so a survivor proves the emptiness check ran.
  // What this does not prove is the other half of the promise AGENTS.md and the
  // README make — letters die by their own mtime ("drops expired messages from
  // inbox, dead and quarantine", below), and since `cleanupOrphanedInboxes`
  // runs before `cleanupExpiredMessages` in `Mesh.tick`, an orphan holding
  // nothing but expired letters is emptied by one and reaped by the next. Two
  // sweeps, by ordering, not by accident.
  it("keeps a non-empty inbox of a gone agent, queued work is not garbage", async () => {
    const { config, registry } = await newRegistry({ queueRetentionMs: 1_000 })
    const inbox = path.join(config.inboxDir, "gone")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(path.join(inbox, `${newMessageId()}.json`), "{}")
    await backdate(inbox, 60_000)

    assert.deepEqual(await registry.cleanupOrphanedInboxes(), [])
    assert.equal(await exists(inbox), true)
  })

  it("keeps an empty inbox that is younger than queueRetentionMs", async () => {
    const { config, registry } = await newRegistry({ queueRetentionMs: 3_600_000 })
    const inbox = path.join(config.inboxDir, "gone")
    await fs.mkdir(inbox, { recursive: true })
    await backdate(inbox, 60_000)

    assert.deepEqual(await registry.cleanupOrphanedInboxes(), [])
    assert.equal(await exists(inbox), true)
  })

  it("reaps processed markers older than processedRetentionMs", async () => {
    const { config, registry } = await newRegistry({ processedRetentionMs: 1_000 })
    const old = await writeProcessed(config, newMessageId())
    await backdate(old, 60_000)

    assert.equal(await registry.cleanupProcessed(), 1)
    assert.equal(await exists(old), false)
  })

  it("keeps a processed marker younger than processedRetentionMs", async () => {
    const { config, registry } = await newRegistry({ processedRetentionMs: 3_600_000 })
    const fresh = await writeProcessed(config, newMessageId())

    assert.equal(await registry.cleanupProcessed(), 0)
    assert.equal(await exists(fresh), true)
  })

  it("reaps only the expired markers in a mixed directory", async () => {
    const { config, registry } = await newRegistry({ processedRetentionMs: 1_000 })
    const old = await writeProcessed(config, newMessageId())
    const fresh = await writeProcessed(config, newMessageId())
    await backdate(old, 60_000)

    assert.equal(await registry.cleanupProcessed(), 1)
    assert.equal(await exists(old), false)
    assert.equal(await exists(fresh), true)
  })

  it("does not throw when the processed directory does not exist", async () => {
    const { registry } = await newRegistry()
    assert.equal(await registry.cleanupProcessed(), 0)
  })

  it("reaps a record past presenceReapMs but keeps the mailbox", async () => {
    const { config, registry } = await newRegistry({ presenceReapMs: 1_000 })
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    const inbox = path.join(config.inboxDir, "planner")
    await fs.mkdir(inbox, { recursive: true })

    const removed = await registry.reap(Date.now() + 1_001)
    assert.deepEqual(removed, ["planner"])
    // The record is presence state, the inbox is mail: the address survives.
    assert.equal(await exists(inbox), true)
  })

  it("drops expired messages from inbox, dead and quarantine", async () => {
    const { config, registry } = await newRegistry({ messageRetentionMs: 1_000 })
    const written: string[] = []
    for (const root of [config.inboxDir, config.deadDir, config.quarantineDir]) {
      const dir = path.join(root, "planner")
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${newMessageId()}.json`)
      await fs.writeFile(file, "{}")
      await backdate(file, 60_000)
      written.push(file)
    }
    // A claim in flight is not a message file and must survive the sweep.
    const claimed = path.join(config.inboxDir, "planner", "agm_pending.json.taken")
    await fs.writeFile(claimed, "{}")

    assert.equal(await registry.cleanupExpiredMessages(), 3)
    for (const file of written) assert.equal(await exists(file), false)
    assert.equal(await exists(claimed), true)
  })

  it("keeps a queued message younger than messageRetentionMs", async () => {
    const { config, registry } = await newRegistry({ messageRetentionMs: 3_600_000 })
    const dir = path.join(config.inboxDir, "planner")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${newMessageId()}.json`)
    await fs.writeFile(file, "{}")

    assert.equal(await registry.cleanupExpiredMessages(), 0)
    assert.equal(await exists(file), true)
  })

  it("does not throw when the message directories do not exist", async () => {
    const { registry } = await newRegistry()
    assert.equal(await registry.cleanupExpiredMessages(), 0)
  })

  it("reaps an empty inbox even when the agent still has dead letters", async () => {
    const { config, registry } = await newRegistry({ queueRetentionMs: 1_000 })
    const inbox = path.join(config.inboxDir, "gone")
    await fs.mkdir(inbox, { recursive: true })
    await backdate(inbox, 60_000)
    const dead = path.join(config.deadDir, "gone")
    await fs.mkdir(dead, { recursive: true })
    await fs.writeFile(path.join(dead, `${newMessageId()}.json`), "{}")

    assert.deepEqual(await registry.cleanupOrphanedInboxes(), ["gone"])
    assert.equal(await exists(inbox), false)
    assert.equal((await fs.readdir(dead)).length, 1)
  })

  it("keeps dead letters and quarantined files outside the inbox", async () => {
    const { config } = await newRegistry()
    const watcher = new InboxWatcher(config, "planner", async () => {}, noopLogger)
    const deadFile = path.join(watcher.deadDir, "agm_x.json")
    await fs.mkdir(watcher.deadDir, { recursive: true })
    await fs.writeFile(deadFile, "{}")
    await fs.mkdir(watcher.quarantineDir, { recursive: true })
    const badFile = path.join(watcher.quarantineDir, "agm_y.invalid")
    await fs.writeFile(badFile, "broken")

    assert.equal(await exists(deadFile), true)
    assert.equal(await exists(badFile), true)
    // Nothing landed inside inbox/<id>/, so the orphan sweep can still reap it.
    assert.equal(await exists(path.join(config.inboxDir, "planner")), false)
  })
})
