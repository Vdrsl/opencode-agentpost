/**
 * The integration test that matters: two independent Mesh instances sharing a
 * home directory, exactly as two opencode processes would.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, describe, it } from "node:test"

import { parseEnvelope } from "../src/envelope.ts"
import { resolveConfig, TOOL_REGISTER } from "../src/config.ts"
import { buildTools } from "../src/tools.ts"
import { MeshError } from "../src/types.ts"
import { sessionContext, tempHome, testConfig, testMesh, waitFor } from "./helpers.ts"

const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const cleanup of cleanups) await cleanup()
})

async function twoAgents(overrides = {}) {
  const home = await tempHome()
  const config = testConfig(home, overrides)
  const a = testMesh(config)
  const b = testMesh(config)
  cleanups.push(async () => {
    await a.mesh.dispose()
    await b.mesh.dispose()
    await fs.rm(home, { recursive: true, force: true })
  })
  return { home, config, a, b }
}

describe("mesh", () => {
  it("rejects invalid timing configuration", () => {
    assert.throws(
      () => resolveConfig({ heartbeatIntervalMs: 100, staleAfterMs: 100 }),
      /heartbeatIntervalMs < staleAfterMs < expireAfterMs/,
    )
  })

  it("does not expose force in the register tool schema", async () => {
    const { a } = await twoAgents()
    const tools = buildTools(a.mesh, "http://127.0.0.1:4096")
    const register = tools[TOOL_REGISTER] as unknown as { args?: Record<string, unknown> }
    assert.equal(register.args && "force" in register.args, false)
  })

  it("delivers a message into the peer's session", async () => {
    const { a, b } = await twoAgents()
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })

    const result = await a.mesh.send({
      context: sessionContext("ses_a", "/tmp/planner"),
      to: "reviewer",
      text: "review src/auth.ts please",
      context_tag: "T-001",
    })

    assert.equal(result.status, "accepted")
    assert.equal(result.to, "reviewer")
    assert.equal(b.injected.length, 1)
    assert.equal(b.injected[0]!.sessionID, "ses_b")

    const parsed = parseEnvelope(b.injected[0]!.text)
    assert.equal(parsed["from"], "planner")
    assert.equal(parsed["re"], "T-001")
    assert.equal(parsed["text"], "review src/auth.ts please")
    // The sender's own session is never touched.
    assert.equal(a.injected.length, 0)
  })

  it("carries reply correlation into the recipient envelope", async () => {
    const { a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })

    const request = await a.mesh.send({
      context: aContext,
      to: "reviewer",
      text: "please review",
    })
    assert.equal(request.status, "accepted")

    const response = await b.mesh.send({
      context: bContext,
      to: "planner",
      text: "review complete",
      in_reply_to: request.messageId,
    })
    assert.equal(response.status, "accepted")
    assert.equal(parseEnvelope(a.injected[0]!.text)["reply-to"], request.messageId)
  })

  it("sees the peer through agentmesh_peers", async () => {
    const { a, b } = await twoAgents()
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
      metadata: { repo: "/tmp/planner" },
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })

    const peers = await a.mesh.peers({ sessionID: "ses_a" })
    assert.deepEqual(
      peers.map((peer) => peer.id),
      ["planner", "reviewer"],
    )
    assert.equal(peers.find((peer) => peer.id === "planner")?.self, true)
    assert.equal(peers.find((peer) => peer.id === "reviewer")?.status, "alive")
    assert.equal(peers.find((peer) => peer.id === "reviewer")?.self, undefined)
  })

  it("queues for an agent that is registered but not listening", async () => {
    const { home, config, a, b } = await twoAgents({ ackWaitMs: 250 })
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })
    // reviewer's opencode goes away; its record stays until it expires.
    await b.mesh.dispose()
    await b.mesh.registry.register({
      id: "reviewer",
      description: "reviews",
      routing: {
        sessionID: "ses_b",
        directory: "/tmp/reviewer",
        worktree: "/tmp/reviewer",
        serverUrl: "http://127.0.0.1:4096",
      },
      force: true,
    })

    const result = await a.mesh.send({
      context: sessionContext("ses_a", "/tmp/planner"),
      to: "reviewer",
      text: "still there?",
    })
    assert.equal(result.status, "queued")

    // The message is durable: it is sitting in the inbox, waiting.
    const queued = await fs.readdir(path.join(config.inboxDir, "reviewer"))
    assert.deepEqual(queued, [`${result.messageId}.json`])
    assert.ok(home)
  })

  it("keeps queued messages when an agent is unregistered", async () => {
    const { config, a, b } = await twoAgents({ ackWaitMs: 250 })
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    const reviewer = await b.mesh.registry.register({
      id: "reviewer",
      description: "reviews",
      routing: {
        sessionID: "ses_b",
        directory: "/tmp/reviewer",
        worktree: "/tmp/reviewer",
        serverUrl: "http://127.0.0.1:4096",
      },
    })

    const result = await a.mesh.send({
      context: sessionContext("ses_a", "/tmp/planner"),
      to: "reviewer",
      text: "survives unregister",
    })
    assert.equal(result.status, "queued")

    await b.mesh.registry.unregister("reviewer", {
      ownerInstance: reviewer.ownerInstance!,
      incarnation: reviewer.incarnation!,
    })
    assert.deepEqual(await fs.readdir(path.join(config.inboxDir, "reviewer")), [
      `${result.messageId}.json`,
    ])
  })

  it("quarantines messages with an unsupported schema version", async () => {
    const { config, a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })

    const messageId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(
      path.join(inbox, `${messageId}.json`),
      JSON.stringify({
        schemaVersion: 2,
        id: messageId,
        from: "planner",
        to: "reviewer",
        text: "unsupported version",
        sentAt: new Date().toISOString(),
      }),
    )

    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })
    await waitFor(async () => {
      const quarantined = await fs.readdir(path.join(inbox, "quarantine"))
      return quarantined.includes(`${messageId}.json`)
    })
    assert.equal(b.injected.length, 0)
    assert.deepEqual(await fs.readdir(inbox), ["quarantine"])
  })

  it("accepts legacy messages without schemaVersion", async () => {
    const { config, b } = await twoAgents()
    const messageId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FBA"
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(
      path.join(inbox, `${messageId}.json`),
      JSON.stringify({
        id: messageId,
        from: "planner",
        to: "reviewer",
        text: "legacy message",
        sentAt: new Date().toISOString(),
      }),
    )

    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })
    await waitFor(() => b.injected.length === 1)
    assert.equal(parseEnvelope(b.injected[0]!.text)["text"], "legacy message")
  })

  it("quarantines messages without a sender", async () => {
    const { config, b } = await twoAgents()
    const messageId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FCA"
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(
      path.join(inbox, `${messageId}.json`),
      JSON.stringify({ id: messageId, to: "reviewer", text: "missing sender", sentAt: new Date().toISOString() }),
    )
    await b.mesh.register({ context: sessionContext("ses_b", "/tmp/reviewer"), id: "reviewer", description: "reviews" })
    await waitFor(async () => (await fs.readdir(path.join(inbox, "quarantine"))).includes(`${messageId}.invalid`))
    assert.equal(b.injected.length, 0)
  })

  it("quarantines messages addressed to another recipient", async () => {
    const { config, b } = await twoAgents()
    const messageId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FDA"
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(
      path.join(inbox, `${messageId}.json`),
      JSON.stringify({
        id: messageId,
        from: "planner",
        to: "other",
        text: "wrong recipient",
        sentAt: new Date().toISOString(),
      }),
    )
    await b.mesh.register({ context: sessionContext("ses_b", "/tmp/reviewer"), id: "reviewer", description: "reviews" })
    await waitFor(async () => (await fs.readdir(path.join(inbox, "quarantine"))).includes(`${messageId}.invalid`))
    assert.equal(b.injected.length, 0)
  })

  it("quarantines messages that exceed maxTextLength", async () => {
    const { config, b } = await twoAgents({ maxTextLength: 5 })
    const messageId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FEA"
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await fs.writeFile(
      path.join(inbox, `${messageId}.json`),
      JSON.stringify({
        id: messageId,
        from: "planner",
        to: "reviewer",
        text: "too long",
        sentAt: new Date().toISOString(),
      }),
    )
    await b.mesh.register({ context: sessionContext("ses_b", "/tmp/reviewer"), id: "reviewer", description: "reviews" })
    await waitFor(async () => (await fs.readdir(path.join(inbox, "quarantine"))).includes(`${messageId}.invalid`))
    assert.equal(b.injected.length, 0)
  })

  it("delivers a queued message once the peer comes back", async () => {
    const { config, a, b } = await twoAgents({ ackWaitMs: 250 })
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    await b.mesh.registry.register({
      id: "reviewer",
      description: "reviews",
      routing: {
        sessionID: "ses_b",
        directory: "/tmp/reviewer",
        worktree: "/tmp/reviewer",
        serverUrl: "http://127.0.0.1:4096",
      },
    })

    const result = await a.mesh.send({
      context: sessionContext("ses_a", "/tmp/planner"),
      to: "reviewer",
      text: "waiting for you",
    })
    assert.equal(result.status, "queued")

    // reviewer's opencode starts and registers: the watcher drains the inbox.
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
      force: true,
    })
    await waitFor(() => b.injected.length === 1)
    assert.equal(parseEnvelope(b.injected[0]!.text)["text"], "waiting for you")
    assert.deepEqual(await fs.readdir(path.join(config.inboxDir, "reviewer")), [])
  })

  it("preserves order across a burst of messages", async () => {
    const { a, b } = await twoAgents()
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })

    for (let i = 0; i < 10; i++) {
      await a.mesh.send({
        context: sessionContext("ses_a", "/tmp/planner"),
        to: "reviewer",
        text: `message ${i}`,
      })
    }
    await waitFor(() => b.injected.length === 10)
    assert.deepEqual(
      b.injected.map((entry) => parseEnvelope(entry.text)["text"]),
      Array.from({ length: 10 }, (_, i) => `message ${i}`),
    )
  })

  it("reports a failed injection instead of silently dropping it", async () => {
    const { config, a } = await twoAgents()
    const broken = {
      mesh: new (await import("../src/mesh.ts")).Mesh(config, {
        log: () => {},
        async inject() {
          throw new Error("session is gone")
        },
      }),
    }
    cleanups.push(() => broken.mesh.dispose())

    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    await broken.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })

    const result = await a.mesh.send({
      context: sessionContext("ses_a", "/tmp/planner"),
      to: "reviewer",
      text: "this will not land",
    })
    assert.equal(result.status, "failed")
    assert.match(result.detail, /session is gone/)
  })

  it("rejects unknown recipients, self-sends and oversized text", async () => {
    const { a, b } = await twoAgents({ maxTextLength: 20 })
    const context = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context, id: "planner", description: "plans" })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })

    await assert.rejects(
      a.mesh.send({ context, to: "../etc", text: "hi" }),
      (error: MeshError) => error.code === "E_INVALID_ID",
    )
    await assert.rejects(
      a.mesh.send({ context, to: "nobody", text: "hi" }),
      (error: MeshError) => error.code === "E_NO_AGENT",
    )
    await assert.rejects(
      a.mesh.send({ context, to: "planner", text: "hi" }),
      (error: MeshError) => error.code === "E_SELF_SEND",
    )
    await assert.rejects(
      a.mesh.send({ context, to: "reviewer", text: "x".repeat(21) }),
      (error: MeshError) => error.code === "E_TEXT_TOO_LONG",
    )
    await assert.rejects(
      a.mesh.send({ context, to: "reviewer", text: "reply", in_reply_to: "not-an-id" }),
      (error: MeshError) => error.code === "E_INVALID_REPLY",
    )
    assert.equal(b.injected.length, 0)
  })

  it("auto-registers with an id derived from the worktree name", async () => {
    const { a, b } = await twoAgents()
    assert.equal(await a.mesh.autoRegister(sessionContext("ses_a", "/tmp/My Project")), "my-project")
    // A second session in the same directory gets a distinct id, not a clash.
    assert.equal(await b.mesh.autoRegister(sessionContext("ses_b", "/tmp/My Project")), "my-project-2")
  })

  it("removes an agent from the registry when its session is deleted", async () => {
    const { a } = await twoAgents()
    const context = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context, id: "planner", description: "plans" })
    assert.ok(await a.mesh.registry.get("planner"))

    await a.mesh.unregisterSession("ses_a")
    assert.equal(await a.mesh.registry.get("planner"), undefined)
    assert.deepEqual(await a.mesh.peers({}), [])
  })
})
