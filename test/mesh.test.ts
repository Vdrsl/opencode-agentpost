/**
 * The integration test that matters: two independent Mesh instances sharing a
 * home directory, exactly as two opencode processes would.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { after, describe, it } from "node:test"

import { parseEnvelope } from "../src/envelope.ts"
import { enqueue, InboxWatcher, readAck, readProcessedDepth } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import { claimFile, readJson, writeJsonAtomic } from "../src/store.ts"
import { resolveConfig, TOOL_REGISTER } from "../src/config.ts"
import { noopLogger } from "../src/logger.ts"
import { buildTools } from "../src/tools.ts"
import { type ClaimMeta, MeshError, PromptTimeoutError, SessionBusyError, SessionNotFoundError } from "../src/types.ts"
import { messageFiles, sessionContext, tempHome, testConfig, testMesh, waitFor } from "./helpers.ts"

const cleanups: (() => Promise<void>)[] = []
after(async () => {
  for (const cleanup of cleanups.slice().reverse()) await cleanup()
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

function leaseMessage() {
  return {
    schemaVersion: 1 as const,
    id: "agm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    from: "planner",
    to: "reviewer",
    text: "leased message",
    sentAt: new Date().toISOString(),
  }
}

function leaseMessageWithId(id: string) {
  return { ...leaseMessage(), id }
}

function leaseClaim(leaseExpiresAt: string): ClaimMeta {
  return {
    ownerInstance: "owner-a",
    incarnation: "incarnation-a",
    sessionID: "ses_b",
    claimedAt: new Date().toISOString(),
    leaseExpiresAt,
    attempt: 1,
  }
}

describe("mesh", () => {
  it("rejects invalid timing configuration", () => {
    assert.throws(
      () => resolveConfig({ heartbeatIntervalMs: 100, staleAfterMs: 100 }),
      /heartbeatIntervalMs < staleAfterMs < presenceReapMs/,
    )
    assert.throws(
      () => resolveConfig({ presenceReapMs: 86_400_001 }),
      /presenceReapMs must be at most 86400000ms/,
    )
    assert.throws(
      () => resolveConfig({ messageRetentionMs: 604_800_001 }),
      /messageRetentionMs must be at most 604800000ms/,
    )
  })

  it("reaps presence on minutes but keeps messages for a day", () => {
    const config = resolveConfig({})
    assert.equal(config.presenceReapMs, 300_000)
    assert.equal(config.messageRetentionMs, 86_400_000)
    assert.equal(config.staleAfterMs, 60_000)
  })

  it("rejects an excessive prompt timeout", () => {
    assert.throws(
      () => resolveConfig({ promptTimeoutMs: 120_001 }),
      /promptTimeoutMs must be at most 120000ms/,
    )
  })

  it("rejects invalid busy defer configuration", () => {
    assert.throws(
      () => resolveConfig({ busyDeferMs: 60_001 }),
      /busyDeferMs must be at most 60000ms/,
    )
    assert.throws(
      () => resolveConfig({ maxBusyDefers: 0 }),
      /maxBusyDefers must be an integer from 1 to 100/,
    )
  })

  it("does not expose force in the register tool schema", async () => {
    const { a } = await twoAgents()
    const tools = buildTools(a.mesh, "http://127.0.0.1:4096")
    const register = tools[TOOL_REGISTER] as unknown as { args?: Record<string, unknown> }
    assert.equal(register.args && "force" in register.args, false)
  })

  it("writes lease metadata into a claimed message", async () => {
    const home = await tempHome()
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const file = path.join(home, "message.json")
    const claim = leaseClaim(new Date(Date.now() + 60_000).toISOString())
    await writeJsonAtomic(file, leaseMessage())
    const claimed = await claimFile(file, ".taken", claim)
    assert.ok(claimed)
    const raw = await readJson<Record<string, unknown>>(claimed)
    assert.deepEqual(raw?.["_claim"], claim)
  })

  it("does not recover a claim with an active lease", async () => {
    const home = await tempHome()
    const config = testConfig(home, { leaseDurationMs: 60_000, pollIntervalMs: 50 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    const taken = path.join(inbox, `${message.id}.json.taken`)
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(taken, {
      ...message,
      _claim: leaseClaim(new Date(Date.now() + 60_000).toISOString()),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.equal(injected.length, 0)
    assert.equal((await fs.readdir(inbox)).includes(path.basename(taken)), true)
  })

  it("recovers an expired claim and delivers it", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 50 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    const taken = path.join(inbox, `${message.id}.json.taken`)
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(taken, {
      ...message,
      _claim: leaseClaim(new Date(Date.now() - 1_000).toISOString()),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.deepEqual(injected, ["leased message"])
    assert.equal((await fs.readdir(inbox)).includes(path.basename(taken)), false)
    const marker = await readJson<Record<string, unknown>>(path.join(config.processedDir, `${message.id}.json`))
    assert.equal(marker?.["id"], message.id)
  })

  it("does not reinject a pending message with a processed marker", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    await writeJsonAtomic(path.join(config.processedDir, `${message.id}.json`), {
      id: message.id,
      at: new Date().toISOString(),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.deepEqual(injected, [])
    assert.equal((await readAck(config, message.id))?.status, "accepted")
    assert.deepEqual(await messageFiles(inbox), [])
  })

  it("recovers a processed claim without reinjecting", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    const taken = path.join(inbox, `${message.id}.json.taken`)
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(taken, {
      ...message,
      _claim: leaseClaim(new Date(Date.now() - 1_000).toISOString()),
    })
    await writeJsonAtomic(path.join(config.processedDir, `${message.id}.json`), {
      id: message.id,
      at: new Date().toISOString(),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.deepEqual(injected, [])
    assert.equal((await readAck(config, message.id))?.status, "accepted")
    assert.equal((await fs.readdir(inbox)).includes(path.basename(taken)), false)
  })

  it("removes a claimed message when its ack already exists", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 50 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    const taken = path.join(inbox, `${message.id}.json.taken`)
    await fs.mkdir(inbox, { recursive: true })
    await fs.mkdir(config.acksDir, { recursive: true })
    await writeJsonAtomic(taken, {
      ...message,
      _claim: leaseClaim(new Date(Date.now() + 60_000).toISOString()),
    })
    await writeJsonAtomic(path.join(config.acksDir, `${message.id}.json`), {
      id: message.id,
      to: "reviewer",
      sessionID: "ses_b",
      status: "injected",
      at: new Date().toISOString(),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.deepEqual(injected, [])
    assert.equal((await readAck(config, message.id))?.status, "accepted")
    assert.equal((await fs.readdir(inbox)).includes(path.basename(taken)), false)
  })

  it("does not inject a pending message when its ack already exists", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 50 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    const pending = path.join(inbox, `${message.id}.json`)
    await fs.mkdir(inbox, { recursive: true })
    await fs.mkdir(config.acksDir, { recursive: true })
    await writeJsonAtomic(pending, message)
    await writeJsonAtomic(path.join(config.acksDir, `${message.id}.json`), {
      id: message.id,
      to: "reviewer",
      sessionID: "ses_b",
      status: "accepted",
      at: new Date().toISOString(),
    })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (value) => injected.push(value.text),
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.deepEqual(injected, [])
    assert.deepEqual(await messageFiles(inbox), [])
  })

  it("retries a failed injection and succeeds on the next attempt", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 50, maxDeliveryAttempts: 3 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    let attempts = 0
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("temporary failure")
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    assert.equal(attempts, 2)
    assert.deepEqual(await messageFiles(inbox), [])
    const ack = await readJson<Record<string, unknown>>(path.join(config.acksDir, `${message.id}.json`))
    assert.equal(ack?.["status"], "accepted")
  })

  it("dead-letters a message after max delivery attempts", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 50, maxDeliveryAttempts: 2 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    let attempts = 0
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {
        attempts += 1
        throw new Error("permanent failure")
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    await watcher.drain()
    assert.equal(attempts, 2)
    const deadFile = path.join(config.deadDir, "reviewer", `${message.id}.json`)
    const dead = await readJson<Record<string, unknown>>(deadFile)
    assert.equal((dead?.["_deadLetter"] as Record<string, unknown>)?.["attempts"], 2)
    assert.equal(dead?.["_claim"], undefined)
    assert.equal(dead?.["_retryCount"], undefined)
    const entries = await fs.readdir(inbox)
    // Dead letters live outside the inbox: a subdirectory here would keep the
    // inbox non-empty forever and block the orphan sweep.
    assert.equal(entries.includes("dead"), false)
    assert.equal(entries.includes(`${message.id}.json`), false)
    assert.equal(entries.includes(`${message.id}.json.taken`), false)
  })

  it("rejects a message larger than maxMessageBytes", async () => {
    const home = await tempHome()
    const config = testConfig(home, { maxMessageBytes: 32 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    await assert.rejects(
      enqueue(config, { ...leaseMessage(), text: "x".repeat(100) }),
      (error: MeshError) => error.code === "E_MESSAGE_TOO_LARGE",
    )
  })

  it("rejects an inbox at maxInboxMessages", async () => {
    const home = await tempHome()
    const config = testConfig(home, { maxInboxMessages: 1 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    await enqueue(config, leaseMessage())
    await assert.rejects(
      enqueue(config, leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAW")),
      (error: MeshError) => error.code === "E_INBOX_FULL",
    )
  })

  it("rejects an inbox at maxInboxBytes", async () => {
    const home = await tempHome()
    const config = testConfig(home, {
      maxInboxMessages: 3,
      maxInboxBytes: 300,
      maxMessageBytes: 200,
    })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const first = leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAW")
    const second = leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAX")
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${first.id}.json`), { ...first, text: "x".repeat(150) })
    await writeJsonAtomic(path.join(inbox, `${second.id}.json`), { ...second, text: "x".repeat(150) })
    await assert.rejects(
      enqueue(config, leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAY")),
      (error: MeshError) => error.code === "E_INBOX_FULL",
    )
  })

  it("propagates inbox backpressure errors from send", async () => {
    const { config, a, b } = await twoAgents({ maxInboxMessages: 1 })
    await a.mesh.register({ context: sessionContext("ses_a", "/tmp/planner"), id: "planner", description: "plans" })
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
    const existing = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${existing.id}.json`), existing)
    await assert.rejects(
      a.mesh.send({
        context: sessionContext("ses_a", "/tmp/planner"),
        to: "reviewer",
        text: "new message",
      }),
      (error: MeshError) => error.code === "E_INBOX_FULL",
    )
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
    assert.equal(parseEnvelope(a.injected[0]!.text)["in-reply-to"], request.messageId)
  })

  it("records reply depth on a reply message", async () => {
    const { config, a, b } = await twoAgents({ ackWaitMs: 250 })
    await a.mesh.registry.register({
      id: "planner",
      description: "plans",
      routing: {
        sessionID: "ses_a",
        directory: "/tmp/planner",
        worktree: "/tmp/planner",
        serverUrl: "http://127.0.0.1:4096",
      },
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })
    const result = await b.mesh.send({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      to: "planner",
      text: "reply",
      in_reply_to: "agm_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    })
    const message = await readJson<{ replyDepth?: number }>(
      path.join(config.inboxDir, "planner", `${result.messageId}.json`),
    )
    assert.equal(message?.replyDepth, 1)
  })

  it("rejects replies beyond maxReplyDepth", async () => {
    const { config, a, b } = await twoAgents({ maxReplyDepth: 1 })
    await a.mesh.registry.register({
      id: "planner",
      description: "plans",
      routing: {
        sessionID: "ses_a",
        directory: "/tmp/planner",
        worktree: "/tmp/planner",
        serverUrl: "http://127.0.0.1:4096",
      },
    })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })
    const internal = b.mesh as unknown as {
      agents: Map<string, { watcher: InboxWatcher }>
    }
    await internal.agents.get("ses_b")!.watcher.stop()
    const parentId = "agm_01ARZ3NDEKTSV4RRFFQ69G5FAW"
    // The depth of a message we were sent lives in our own processed marker,
    // not in an inbox copy: the inbox copy is gone after delivery.
    await writeJsonAtomic(path.join(config.processedDir, `${parentId}.json`), {
      id: parentId,
      at: new Date().toISOString(),
      depth: 1,
    })
    await assert.rejects(
      b.mesh.send({
        context: sessionContext("ses_b", "/tmp/reviewer"),
        to: "planner",
        text: "too deep",
        in_reply_to: parentId,
      }),
      (error: MeshError) => error.code === "E_REPLY_DEPTH_EXCEEDED",
    )
  })

  it("sends to a peer whose presence record went stale", async () => {
    const { config, a, b } = await twoAgents({ staleAfterMs: 1 })
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({
      context: sessionContext("ses_b", "/tmp/reviewer"),
      id: "reviewer",
      description: "reviews",
    })
    // Presence lapses, the mailbox does not: the message still lands.
    const when = new Date(Date.now() - 600_000)
    await fs.utimes(path.join(config.agentsDir, "reviewer.json"), when, when)

    const result = await a.mesh.send({ context: aContext, to: "reviewer", text: "still deliverable" })
    assert.equal(result.status, "accepted")
    assert.equal(b.injected.length, 1)
  })

  it("sends to an address with a mailbox but no presence record", async () => {
    const { config, a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    // A session that closed its window: the record is reaped, the inbox stays.
    const inbox = path.join(config.inboxDir, "away")
    await fs.mkdir(inbox, { recursive: true })
    assert.equal(await a.mesh.registry.get("away"), undefined)

    const result = await a.mesh.send({ context: aContext, to: "away", text: "mail for later" })
    assert.equal(result.status, "queued")
    assert.equal((await messageFiles(inbox)).length, 1)
  })

  it("rejects an address that was never used", async () => {
    const { a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })

    await assert.rejects(
      a.mesh.send({ context: aContext, to: "never-existed", text: "hello?" }),
      (error: MeshError) => error.code === "E_NO_AGENT",
    )
  })

  it("keeps the reply depth of a delivered message for the answer", async () => {
    const { config, a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })

    const request = await a.mesh.send({ context: aContext, to: "reviewer", text: "please review" })
    assert.equal(request.status, "accepted")
    // Injected by the reviewer, so its inbox copy is already gone: the only
    // surviving record of how deep this chain is sits in the local marker.
    assert.equal(await readProcessedDepth(config, request.messageId), 0)

    const response = await b.mesh.send({
      context: bContext,
      to: "planner",
      text: "on it",
      in_reply_to: request.messageId,
    })
    // Depth 1, not a reset 0: reading it from the sender's inbox used to
    // always return 0 and let a chain grow without bound.
    await waitFor(async () => (await readProcessedDepth(config, response.messageId)) === 1)
  })

  it("stamps the depth of an injected message into its processed marker", async () => {
    const { config, a } = await twoAgents()
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    const message = { ...leaseMessage(), to: "planner", from: "reviewer", replyDepth: 3 }
    await enqueue(config, message)

    await waitFor(async () => (await readProcessedDepth(config, message.id)) === 3)
    const marker = await readJson<{ depth?: number }>(
      path.join(config.processedDir, `${message.id}.json`),
    )
    assert.equal(marker?.depth, 3)
  })

  it("reads an older processed marker without a depth as zero", async () => {
    const { config } = await twoAgents()
    const messageId = newMessageId()
    await fs.mkdir(config.processedDir, { recursive: true })
    await writeJsonAtomic(path.join(config.processedDir, `${messageId}.json`), {
      id: messageId,
      at: new Date().toISOString(),
    })
    assert.equal(await readProcessedDepth(config, messageId), 0)
  })

  it("reads a depth of zero for a message it never injected", async () => {
    const { config } = await twoAgents()
    assert.equal(await readProcessedDepth(config, "agm_01ARZ3NDEKTSV4RRFFQ69G5FAW"), 0)
    assert.equal(await readProcessedDepth(config, "not-a-message-id"), 0)
  })

  it("sees the peer through agentmesh_peers", async () => {
    const { config, a, b } = await twoAgents()
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
    // planner had no turn for five minutes; reviewer just registered.
    const longAgo = new Date(Date.now() - 300_000)
    await fs.utimes(path.join(config.activityDir, "planner"), longAgo, longAgo)

    const peers = await a.mesh.peers({ sessionID: "ses_a" })
    assert.deepEqual(
      peers.map((peer) => peer.id),
      ["reviewer", "planner"],
    )
    assert.equal(peers.find((peer) => peer.id === "planner")?.self, true)
    assert.equal(peers.find((peer) => peer.id === "reviewer")?.status, "alive")
    assert.equal(peers.find((peer) => peer.id === "reviewer")?.self, undefined)
  })

  it("lists peers freshest first, alive before stale, id as the tie-break", async () => {
    const { config, a } = await twoAgents()
    for (const id of ["planner", "fresh", "mid", "ancient", "twin-a", "twin-b", "gone"]) {
      await a.mesh.register({
        context: sessionContext(`ses_${id}`, "/tmp/planner"),
        id,
        description: "d",
      })
    }
    const backdate = async (id: string, when: Date) => {
      await fs.utimes(path.join(config.activityDir, id), when, when)
    }
    for (const id of ["fresh", "gone", "mid", "ancient", "twin-a", "twin-b"]) {
      await a.mesh.noteActivity(`ses_${id}`)
    }
    const now = Date.now()
    await backdate("mid", new Date(now - 60_000))
    // Same timestamp for both twins, so only the id can order them.
    const twin = new Date(now - 600_000)
    for (const id of ["twin-a", "twin-b"]) await backdate(id, twin)
    await backdate("ancient", new Date(now - 7_200_000))

    // A dead pid makes "gone" stale no matter how fresh it looks.
    const goneRecord = await readJson<Record<string, unknown>>(
      path.join(config.agentsDir, "gone.json"),
    )
    await writeJsonAtomic(path.join(config.agentsDir, "gone.json"), {
      ...goneRecord,
      pid: 2 ** 30,
    })

    const peers = await a.mesh.peers({ sessionID: "ses_planner" })
    assert.deepEqual(
      peers.map((peer) => peer.id).filter((id) => id !== "planner"),
      ["fresh", "mid", "twin-a", "twin-b", "ancient", "gone"],
    )
    assert.equal(peers.at(-1)?.status, "stale")
    const ancient = peers.find((peer) => peer.id === "ancient")
    assert.ok((ancient?.idleMs ?? 0) >= 3_600_000)
    // Every peer names the chat it lives in, so two ids in one directory are
    // distinguishable even when their records look identical.
    assert.equal(peers.find((peer) => peer.id === "twin-a")?.sessionID, "ses_twin-a")
    assert.equal(peers.find((peer) => peer.id === "twin-b")?.sessionID, "ses_twin-b")
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
      const quarantined = await fs.readdir(path.join(config.quarantineDir, "reviewer"))
      return quarantined.includes(`${messageId}.json`)
    })
    assert.equal(b.injected.length, 0)
    assert.deepEqual(await messageFiles(inbox), [])
    assert.equal((await fs.readdir(inbox)).includes("quarantine"), false)
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
    await waitFor(async () => (await fs.readdir(path.join(config.quarantineDir, "reviewer"))).includes(`${messageId}.invalid`))
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
    await waitFor(async () => (await fs.readdir(path.join(config.quarantineDir, "reviewer"))).includes(`${messageId}.invalid`))
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
    await waitFor(async () => (await fs.readdir(path.join(config.quarantineDir, "reviewer"))).includes(`${messageId}.invalid`))
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
    assert.deepEqual(await messageFiles(path.join(config.inboxDir, "reviewer")), [])
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
        logger: noopLogger,
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

  it("reports a prompt timeout as ambiguous without retrying", async () => {
    const { config, a } = await twoAgents()
    const broken = {
      mesh: new (await import("../src/mesh.ts")).Mesh(config, {
        logger: noopLogger,
        async inject() {
          throw new PromptTimeoutError(25)
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
      text: "timeout probe",
    })
    assert.equal(result.status, "ambiguous")
    assert.match(result.detail, /timed out after 25ms/)
    assert.deepEqual(await fs.readdir(config.processedDir).catch(() => []), [])
  })

  it("defers a busy session without consuming a retry attempt", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10, busyDeferMs: 1, maxBusyDefers: 3 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    let attempts = 0
    let deferred: Record<string, unknown> | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markDeferredRead!: () => void
    const deferredRead = new Promise<void>((resolve) => { markDeferredRead = resolve })
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {
        attempts += 1
        if (attempts === 1) throw new SessionBusyError("ses_b")
        deferred = await readJson<Record<string, unknown>>(
          path.join(inbox, `${message.id}.json.taken`),
        )
        markDeferredRead()
        await gate
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    const starting = watcher.start()
    await waitFor(() => attempts === 2)
    await deferredRead
    assert.equal(deferred?.["_busyDeferCount"], 1)
    assert.equal(deferred?.["_retryCount"], undefined)
    release()
    await starting
    const ack = await readJson<Record<string, unknown>>(path.join(config.acksDir, `${message.id}.json`))
    assert.equal(ack?.["status"], "accepted")
  })

  it("dead-letters a session that no longer exists", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { throw new SessionNotFoundError("ses_b") },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    await watcher.start()
    const deadFile = path.join(config.deadDir, "reviewer", `${message.id}.json`)
    await waitFor(async () => (await fs.readdir(path.join(config.deadDir, "reviewer"))).includes(`${message.id}.json`))
    const dead = await readJson<Record<string, unknown>>(deadFile)
    assert.equal((dead?.["_deadLetter"] as Record<string, unknown>)["attempts"], 1)
    const ack = await readJson<Record<string, unknown>>(path.join(config.acksDir, `${message.id}.json`))
    assert.equal(ack?.["status"], "failed")
  })

  it("keeps a message queued when a session stays busy past the defer limit", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10, busyDeferMs: 1, maxBusyDefers: 2 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    let attempts = 0
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {
        attempts += 1
        throw new SessionBusyError("ses_b")
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    const starting = watcher.start()
    const ackFile = path.join(config.acksDir, `${message.id}.json`)
    await waitFor(async () =>
      (await fs.readdir(config.acksDir).catch(() => [])).includes(`${message.id}.json`),
    )
    const ack = await readJson<Record<string, unknown>>(ackFile)
    assert.equal(ack?.["status"], "ambiguous")

    // The sender knows the outcome is unknown, but the message is still there,
    // with its defer count carried over, and it is claimed again every pass.
    await waitFor(() => attempts > 2)
    await watcher.stop()
    await starting
    const queued = await readJson<Record<string, unknown>>(
      path.join(inbox, `${message.id}.json`),
    )
    assert.ok((queued?.["_busyDeferCount"] as number) >= 2)
    assert.deepEqual(await messageFiles(inbox), [`${message.id}.json`])
  })

  it("delivers a queued message once the busy session goes idle", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10, busyDeferMs: 1, maxBusyDefers: 2 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const message = leaseMessage()
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    const injected: string[] = []
    let busy = true
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (received) => {
        if (busy) throw new SessionBusyError("ses_b")
        injected.push(received.id)
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    const starting = watcher.start()
    await waitFor(async () =>
      Boolean(await readJson(path.join(config.acksDir, `${message.id}.json`)).catch(() => null)),
    )
    busy = false
    // Wait for the accepted ack, not for the handler: the handler runs before
    // the ack is written, so reading it straight after the injection is a race.
    await waitFor(async () =>
      (await readJson<Record<string, unknown>>(
        path.join(config.acksDir, `${message.id}.json`),
      ).catch(() => null))?.["status"] === "accepted",
    )
    assert.deepEqual(injected, [message.id])
    assert.deepEqual(await messageFiles(inbox), [])
    await watcher.stop()
    await starting
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

  it("auto-registers a sayable name instead of a directory name", async () => {
    const { a, b } = await twoAgents()
    const first = await a.mesh.autoRegister(sessionContext("ses_a", "/tmp/My Project"))
    assert.ok(first)
    assert.match(first, /^[a-z]+-[a-z]+$/)
    // A second session in the same directory gets its own name, not `name-2`.
    const second = await b.mesh.autoRegister(sessionContext("ses_b", "/tmp/My Project"))
    assert.ok(second)
    assert.match(second, /^[a-z]+-[a-z]+$/)
    assert.notEqual(second, first)
  })

  it("keeps a pinned config id instead of a generated name", async () => {
    const { a } = await twoAgents({ id: "pinned-name" })
    assert.equal(await a.mesh.autoRegister(sessionContext("ses_a", "/tmp/My Project")), "pinned-name")
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
