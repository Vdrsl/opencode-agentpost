import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import { after, describe, it } from "node:test"

import { Registry } from "../src/registry.ts"
import { agentName } from "../src/names.ts"
import { type AgentRouting, MeshError } from "../src/types.ts"
import { tempHome, testConfig } from "./helpers.ts"

const homes: string[] = []
after(async () => {
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

async function newRegistry(overrides = {}) {
  const home = await tempHome()
  homes.push(home)
  return new Registry(testConfig(home, overrides))
}

function routing(sessionID: string, directory = "/tmp/project"): AgentRouting {
  return { sessionID, directory, worktree: directory, serverUrl: "http://127.0.0.1:4096" }
}

describe("registry", () => {
  it("registers and reads back an agent", async () => {
    const registry = await newRegistry()
    await registry.register({
      id: "planner",
      description: "plans work",
      metadata: { stack: "python" },
      routing: routing("ses_1"),
    })
    const entry = await registry.get("planner")
    assert.equal(entry?.record.description, "plans work")
    assert.equal(entry?.record.metadata["stack"], "python")
    assert.equal(typeof entry?.record.ownerInstance, "string")
    assert.equal(typeof entry?.record.incarnation, "string")
    assert.equal(entry?.record.hostId, os.hostname())
    assert.equal(entry?.status, "alive")
  })

  it("rejects ids that are not safe slugs", async () => {
    const registry = await newRegistry()
    for (const id of ["A", "has space", "../escape", "x", ""]) {
      await assert.rejects(
        registry.register({ id, description: "d", routing: routing("ses_1") }),
        (error: MeshError) => error.code === "E_INVALID_ID",
      )
    }
  })

  it("is idempotent for the same session and keeps registeredAt", async () => {
    const registry = await newRegistry()
    const first = await registry.register({ id: "planner", description: "v1", routing: routing("ses_1") })
    const second = await registry.register({ id: "planner", description: "v2", routing: routing("ses_1") })
    assert.equal(second.registeredAt, first.registeredAt)
    assert.equal(second.description, "v2")
  })

  it("refuses to steal an id from a live agent, unless forced", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "first", routing: routing("ses_1") })
    await assert.rejects(
      registry.register({ id: "planner", description: "second", routing: routing("ses_2") }),
      (error: MeshError) => error.code === "E_CONFLICT",
    )
    const forced = await registry.register({
      id: "planner",
      description: "second",
      routing: routing("ses_2"),
      force: true,
    })
    assert.equal(forced.routing.sessionID, "ses_2")
  })

  it("fences the previous owner after a takeover", async () => {
    const registry = await newRegistry()
    const first = await registry.register({
      id: "planner",
      description: "first",
      routing: routing("ses_1"),
      ownerInstance: "owner-a",
    })
    const second = await registry.register({
      id: "planner",
      description: "second",
      routing: routing("ses_2"),
      ownerInstance: "owner-b",
      force: true,
    })
    const oldOwner = {
      ownerInstance: first.ownerInstance!,
      incarnation: first.incarnation!,
    }
    const newOwner = {
      ownerInstance: second.ownerInstance!,
      incarnation: second.incarnation!,
    }

    assert.equal(await registry.heartbeat("planner", oldOwner), false)
    await assert.rejects(
      registry.unregister("planner", oldOwner),
      (error: MeshError) => error.code === "E_FENCED",
    )
    assert.equal((await registry.get("planner"))?.record.ownerInstance, "owner-b")
    assert.equal(await registry.heartbeat("planner", newOwner), true)
  })

  it("lets a new session take over an id whose owner went stale", async () => {
    const registry = await newRegistry({ staleAfterMs: 0 })
    await registry.register({ id: "planner", description: "first", routing: routing("ses_1") })
    const taken = await registry.register({
      id: "planner",
      description: "second",
      routing: routing("ses_2"),
    })
    assert.equal(taken.routing.sessionID, "ses_2")
  })

  it("drops the old record when a session re-registers under a new id", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await registry.register({ id: "architect", description: "d", routing: routing("ses_1") })
    assert.equal(await registry.get("planner"), undefined)
    assert.ok(await registry.get("architect"))
  })

  it("marks an agent stale once its heartbeat stops", async () => {
    const registry = await newRegistry({ staleAfterMs: 0 })
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    assert.equal((await registry.get("planner"))?.status, "stale")
  })

  it("marks an agent stale when its process is gone, even if fresh", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    const file = registry.recordPath("planner")
    const record = JSON.parse(await fs.readFile(file, "utf8"))
    // A pid that cannot exist: liveness must not depend on mtime alone.
    await fs.writeFile(file, JSON.stringify({ ...record, pid: 2 ** 30 }))
    assert.equal((await registry.get("planner"))?.status, "stale")
  })

  it("allocates a suffixed id when the plain one is taken by a live peer", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "web", description: "d", routing: routing("ses_1") })
    assert.equal(await registry.allocateId("web", "ses_2"), "web-2")
    // ...but the same session keeps its own id.
    assert.equal(await registry.allocateId("web", "ses_1"), "web")
  })

  it("hashes an auto name from the session so a restart reclaims it", async () => {
    const registry = await newRegistry()
    const name = await registry.allocateName("ses_1")
    assert.match(name, /^[a-z]+-[a-z]+$/)
    // Another process, same home, same session: the address must not drift,
    // or the peer's inbox would be orphaned under a name nobody will send to.
    const restarted = new Registry(testConfig(registry.config.home))
    assert.equal(await restarted.allocateName("ses_1"), name)
    // A different session in the same directory is a different agent.
    assert.notEqual(await registry.allocateName("ses_2"), name)
  })

  it("walks past a name a live peer already holds", async () => {
    const registry = await newRegistry()
    // Park the name ses_2 hashes to on its first try under another session.
    await registry.register({ id: agentName("ses_2", 1), description: "d", routing: routing("ses_1") })
    assert.equal(await registry.allocateName("ses_2"), agentName("ses_2", 2))
    // The session that owns a name gets it back rather than walking past it.
    await registry.register({ id: agentName("ses_3", 1), description: "d", routing: routing("ses_3") })
    assert.equal(await registry.allocateName("ses_3"), agentName("ses_3", 1))
  })

  it("reaps records that expired and leaves fresh ones alone", async () => {
    const registry = await newRegistry({ expireAfterMs: 0 })
    await registry.register({ id: "gone", description: "d", routing: routing("ses_1") })
    assert.deepEqual(await registry.reap(), ["gone"])
    assert.equal(await registry.get("gone"), undefined)

    const keeper = await newRegistry({ expireAfterMs: 60_000 })
    await keeper.register({ id: "here", description: "d", routing: routing("ses_1") })
    assert.deepEqual(await keeper.reap(), [])
  })

  it("ignores unparseable files instead of failing discovery", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "good", description: "d", routing: routing("ses_1") })
    await fs.writeFile(registry.recordPath("broken"), "{ not json")
    const listed = (await registry.list()).map((entry) => entry.record.id)
    assert.deepEqual(listed, ["good"])
  })

  it("measures idle from the activity marker, not the heartbeat", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await registry.touchActivity("planner")
    const activity = registry.activityPath("planner")
    const backdate = Date.now() - 5 * 60_000
    await fs.utimes(activity, new Date(backdate), new Date(backdate))

    const entry = await registry.get("planner")
    // The heartbeat never stops, so record mtime is fresh while the session is not.
    assert.equal(entry?.status, "alive")
    assert.ok((entry?.activityMtimeMs ?? 0) <= backdate + 1_000)
    const view = registry.toPeerView(entry!, "me")
    assert.ok(view.idleMs >= 5 * 60_000, `idleMs was ${view.idleMs}`)
    // The chat behind the record: several ids in one directory are several chats.
    assert.equal(view.sessionID, "ses_1")
  })

  it("falls back to the record mtime when no activity marker exists", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await fs.utimes(registry.recordPath("planner"), new Date(0), new Date(0))
    const entry = await registry.get("planner")
    assert.equal(entry?.activityMtimeMs, entry?.mtimeMs)
    assert.ok(registry.toPeerView(entry!).idleMs > 0)
  })

  it("never reports a negative idleMs", async () => {
    const registry = await newRegistry()
    await registry.register({ id: "planner", description: "d", routing: routing("ses_1") })
    await registry.touchActivity("planner")
    const ahead = Date.now() + 60_000
    await fs.utimes(registry.activityPath("planner"), new Date(ahead), new Date(ahead))
    assert.equal(registry.toPeerView((await registry.get("planner"))!).idleMs, 0)
  })
})
