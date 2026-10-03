/**
 * The integration test that matters: two independent Mesh instances sharing a
 * home directory, exactly as two opencode processes would.
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"

import { parseEnvelope, renderEnvelope } from "../src/envelope.ts"
import { enqueue, InboxWatcher, readAck, readProcessedDepth, readProcessedThreadId } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import { readOutboxEntry, sweepOutbox, writeOutboxEntry } from "../src/outbox.ts"
import { claimFile, readJson, removeFile, writeJsonAtomic } from "../src/store.ts"
import {
  resolveConfig,
  TOOL_DELIVERIES,
  TOOL_FETCH,
  TOOL_PEERS,
  TOOL_REGISTER,
  TOOL_SEND,
} from "../src/config.ts"
import { noopLogger } from "../src/logger.ts"
import { buildTools } from "../src/tools.ts"
import { type ClaimMeta, MeshError, PromptTimeoutError, SessionBusyError, SessionNotFoundError } from "../src/types.ts"
import {
  messageFiles,
  sessionContext,
  stageLiveClaim,
  tempHome,
  testConfig,
  testMesh,
  waitFor,
} from "./helpers.ts"

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

/**
 * A watcher that is never started, so nothing drains behind the test's back.
 * Its handler fails loudly: anything that reaches a body-inject here is a bug,
 * because these cases are about what `takeBatch` claims, not about injection.
 */
function idleWatcher(config: ReturnType<typeof testConfig>, id: string, onBatch?: (count: number) => Promise<void>) {
  return new InboxWatcher(
    config,
    id,
    "ses_b",
    "owner-a",
    "incarnation-a",
    async () => assert.fail("an unfetched message must not be injected"),
    () => {},
    {},
    onBatch,
  )
}

function leaseClaim(leaseExpiresAt: string): ClaimMeta {  return {
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

  it("tells the model that queued means a reader exists", async () => {
    // `queued` used to be documented as "delivered when it comes back, for as
    // long as the inbox exists", which was a promise nothing kept: a chat closed
    // normally leaves a mailbox no later session reads. The model treats this
    // text as an instruction, so the meaning of the status must be in it.
    const { a } = await twoAgents()
    const tools = buildTools(a.mesh, "http://127.0.0.1:4096")
    const send = tools[TOOL_SEND] as unknown as { description?: string }
    assert.match(send.description ?? "", /"queued" means the agent is registered/)
    // A closed chat has no address, and the model needs the way out, not just
    // the refusal.
    assert.match(send.description ?? "", /E_NO_AGENT/)
    assert.match(send.description ?? "", new RegExp(TOOL_PEERS))
    // And the old lie must not survive anywhere in the description.
    assert.equal(/for as long as that inbox exists/.test(send.description ?? ""), false)
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
    await waitFor(() => attempts === 2)
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

  it("refuses an address whose mailbox outlived its record", async () => {
    const { config, a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    // A session that closed its window: the record is reaped, the inbox stays.
    const inbox = path.join(config.inboxDir, "away")
    await fs.mkdir(inbox, { recursive: true })
    assert.equal(await a.mesh.registry.get("away"), undefined)

    // Queueing here answered `queued` for mail nothing would ever read, and the
    // model believes that status. A mailbox alone is not an address: nothing
    // inherits it (inheritance enumerates records) and nothing comes back to it.
    await assert.rejects(
      a.mesh.send({ context: aContext, to: "away", text: "mail for later" }),
      (error: MeshError) => error.code === "E_NO_AGENT",
    )
    // And nothing was written into the box nobody owns.
    assert.deepEqual(await messageFiles(inbox), [])
  })

  it("makes the same address valid again when the same chat returns", async () => {
    // The asymmetry that decides whether this rule is affordable: a closed chat
    // has no address, but reopening *that* chat mints the same one, because the
    // name is hashed from the session id. So refusing to queue is not permanent
    // loss — the peer becomes reachable under the familiar address again.
    const { a, b } = await twoAgents()
    const sender = sessionContext("ses_sender", "/tmp/planner")
    await b.mesh.autoRegister(sender)
    const closed = sessionContext("ses_closed", "/tmp/planner")
    const id = await a.mesh.autoRegister(closed)
    await a.mesh.unregisterSession("ses_closed")
    await assert.rejects(
      b.mesh.send({ context: sender, to: id, text: "while closed" }),
      (error: MeshError) => error.code === "E_NO_AGENT",
    )

    cleanups.push(() => a.mesh.unregisterSession("ses_closed"))
    const again = await a.mesh.autoRegister(closed)
    assert.equal(again, id)
    // The point is that the address works again, not how fast it drains: `a` now
    // has a live watcher, so the message may be delivered outright rather than
    // queued. Both are the promise being kept.
    const sent = await b.mesh.send({ context: sender, to: id, text: "after reopening" })
    assert.ok(sent.status === "accepted" || sent.status === "queued", sent.status)
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

  it("carries the thread root from the injected message into its marker", async () => {
    const { config, a } = await twoAgents()
    await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "plans",
    })
    const root = newMessageId()
    const message = {
      ...leaseMessageWithId(root),
      to: "planner",
      from: "reviewer",
      replyDepth: 1,
      threadId: root,
    }
    await enqueue(config, message)

    await waitFor(async () => (await readProcessedThreadId(config, root)) === root)
  })

  it("gives a thread reply the root its own marker remembers", async () => {
    const { config, a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })

    const request = await a.mesh.send({ context: aContext, to: "reviewer", text: "please review" })
    assert.equal(request.status, "accepted")
    const response = await b.mesh.send({
      context: bContext,
      to: "planner",
      text: "on it",
      in_reply_to: request.messageId,
    })

    // The reply joins the thread of the message it answers, not a new one: the
    // root is whatever the reviewer's own marker recorded for the request.
    await waitFor(async () => (await readProcessedThreadId(config, response.messageId)) ===
      request.messageId)
  })

  it("falls back to the parent id when the marker predates threads", async () => {
    const { config, a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })
    const parentId = newMessageId()
    await enqueue(config, { ...leaseMessageWithId(parentId), to: "reviewer", from: "planner" })

    const response = await b.mesh.send({
      context: bContext,
      to: "planner",
      text: "old parent",
      in_reply_to: parentId,
    })

    // No marker for it yet, so the parent itself becomes the root — a fork
    // mid-conversation, not a lost link.
    await waitFor(async () => (await readProcessedThreadId(config, response.messageId)) === parentId)
  })

  it("shows the thread on a reply envelope but not on the root", () => {
    const root = renderEnvelope({
      ...leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      threadId: "agm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    })
    assert.equal(root.includes("thread:"), false)
    const reply = renderEnvelope({
      ...leaseMessageWithId("agm_01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      threadId: "agm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    })
    assert.equal(reply.includes("thread: agm_01ARZ3NDEKTSV4RRFFQ69G5FAV"), true)
  })

  it("keeps the sender's own outbox entry for a sent message", async () => {
    const { config, a, b } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    const bContext = sessionContext("ses_b", "/tmp/reviewer")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    await b.mesh.register({ context: bContext, id: "reviewer", description: "reviews" })

    const sent = await a.mesh.send({ context: aContext, to: "reviewer", text: "ping" })
    assert.equal(sent.status, "accepted")

    // The inbox copy is already deleted by the recipient and the ack is reaped
    // within minutes, so the sender's own entry is the only place the state
    // of this message survives.
    assert.deepEqual(await readOutboxEntry(config, sent.messageId), {
      id: sent.messageId,
      from: "planner",
      to: "reviewer",
      threadId: sent.messageId,
      state: "accepted",
      at: (await readOutboxEntry(config, sent.messageId))?.at,
    })
  })

  it("refuses to walk a finished outbox state backwards", async () => {
    const { config } = await twoAgents()
    const entry = { id: newMessageId(), to: "reviewer", at: new Date().toISOString() }
    await writeOutboxEntry(config, { ...entry, state: "accepted" })
    await writeOutboxEntry(config, { ...entry, state: "queued" })
    assert.equal((await readOutboxEntry(config, entry.id))?.state, "accepted")
  })

  it("marks a verdictless outbox entry undeliverable, then retires it", async () => {
    const home = await tempHome()
    const config = testConfig(home, { messageRetentionMs: 1_000 })
    const entry = { id: newMessageId(), to: "gone", at: new Date().toISOString() }
    await writeOutboxEntry(config, { ...entry, state: "queued" })
    const file = path.join(config.outboxDir, `${entry.id}.json`)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(file, old, old)

    // The recipient was gone, not the message, so the entry says so before it
    // goes away one window later. The rewrite bumps mtime, so the verdict
    // itself survives a full window.
    assert.deepEqual(await sweepOutbox(config), { reconciled: 0, marked: 1, removed: 0 })
    assert.equal((await readOutboxEntry(config, entry.id))?.state, "undeliverable")
    assert.deepEqual(await sweepOutbox(config), { reconciled: 0, marked: 0, removed: 0 })
    await fs.utimes(file, old, old)
    assert.deepEqual(await sweepOutbox(config), { reconciled: 0, marked: 0, removed: 1 })
    assert.equal(await readOutboxEntry(config, entry.id), undefined)
  })

  it("reconciles a queued entry once the ack lands after ackWaitMs", async () => {
    // The regular busy case: the recipient accepts long after send() gave up
    // waiting, so only the sweep can move the sender's state forward.
    const home = await tempHome()
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const config = testConfig(home, {
      messageRetentionMs: 1_000,
      busyDeferMs: 1,
      maxBusyDefers: 2,
    })
    const message = { ...leaseMessage(), to: "reviewer" }
    await writeOutboxEntry(config, {
      id: message.id,
      to: "reviewer",
      state: "queued",
      at: message.sentAt,
    })
    await enqueue(config, message)
    let attempts = 0
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {
        attempts += 1
        if (attempts === 1) throw new SessionBusyError("ses_b")
      },
      () => {},
    )
    cleanups.push(() => watcher.stop())
    const starting = watcher.start()
    await waitFor(async () => (await readAck(config, message.id))?.status === "accepted")
    assert.equal((await readOutboxEntry(config, message.id))?.state, "queued")

    assert.deepEqual(await sweepOutbox(config), { reconciled: 1, marked: 0, removed: 0 })
    assert.equal((await readOutboxEntry(config, message.id))?.state, "accepted")
    // A second sweep finds the ack already reflected, so nothing moves twice.
    assert.deepEqual(await sweepOutbox(config), { reconciled: 0, marked: 0, removed: 0 })
    await watcher.stop()
    await starting
  })

  it("deletes a finished outbox entry once it is old enough", async () => {
    const home = await tempHome()
    const config = testConfig(home, { messageRetentionMs: 1_000 })
    const entry = { id: newMessageId(), to: "reviewer", at: new Date().toISOString() }
    await writeOutboxEntry(config, { ...entry, state: "failed" })
    const file = path.join(config.outboxDir, `${entry.id}.json`)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(file, old, old)

    assert.deepEqual(await sweepOutbox(config), { reconciled: 0, marked: 0, removed: 1 })
    assert.equal(await readOutboxEntry(config, entry.id), undefined)
  })

  it("lists our own deliveries newest first", async () => {
    const { config, a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    const first = newMessageId()
    const second = newMessageId()
    const now = new Date().toISOString()
    await writeOutboxEntry(config, { id: first, from: "planner", to: "reviewer", state: "accepted", at: now })
    await writeOutboxEntry(config, { id: second, from: "planner", to: "reviewer", state: "queued", at: now })

    // Filenames are ULIDs, so ordering by name is ordering by time.
    const mine = await a.mesh.deliveries({ sessionID: "ses_a" })
    assert.deepEqual(mine.map((entry) => entry.id), [second, first])
  })

  it("filters deliveries by recipient, by state and by limit", async () => {
    const { config, a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    const now = new Date().toISOString()
    const toReviewer = newMessageId()
    const toAuditor = newMessageId()
    const queued = newMessageId()
    await writeOutboxEntry(config, { id: toReviewer, from: "planner", to: "reviewer", state: "accepted", at: now })
    await writeOutboxEntry(config, { id: toAuditor, from: "planner", to: "auditor", state: "accepted", at: now })
    await writeOutboxEntry(config, { id: queued, from: "planner", to: "reviewer", state: "queued", at: now })

    assert.deepEqual(
      (await a.mesh.deliveries({ sessionID: "ses_a", to: "auditor" })).map((entry) => entry.id),
      [toAuditor],
    )
    assert.deepEqual(
      (await a.mesh.deliveries({ sessionID: "ses_a", state: "queued" })).map((entry) => entry.id),
      [queued],
    )
    const limited = await a.mesh.deliveries({ sessionID: "ses_a", limit: 2 })
    assert.deepEqual(limited.map((entry) => entry.id), [queued, toAuditor])
  })

  it("keeps one agent's outbox out of another agent's deliveries", async () => {
    const { config, a } = await twoAgents()
    const aContext = sessionContext("ses_a", "/tmp/planner")
    await a.mesh.register({ context: aContext, id: "planner", description: "plans" })
    const notMine = newMessageId()
    await writeOutboxEntry(config, {
      id: notMine,
      from: "auditor",
      to: "reviewer",
      state: "accepted",
      at: new Date().toISOString(),
    })

    assert.deepEqual(await a.mesh.deliveries({ sessionID: "ses_a" }), [])
  })

  it("takes inbox messages that were never injected", async () => {
    const { config } = await twoAgents()
    // Not a live mesh: two separate enqueues let the watcher deliver the first
    // message as a lone batch before the second one lands.
    const watcher = idleWatcher(config, "reviewer")
    const injected = newMessageId()
    const missed = newMessageId()
    await enqueue(config, { ...leaseMessageWithId(injected), to: "reviewer", from: "planner" })
    await enqueue(config, { ...leaseMessageWithId(missed), to: "reviewer", from: "planner" })
    await fs.mkdir(config.processedDir, { recursive: true })
    await writeJsonAtomic(path.join(config.processedDir, `${injected}.json`), {
      id: injected,
      at: new Date().toISOString(),
      depth: 0,
    })

    const fetched = await watcher.takeBatch(10)
    // The already-injected one is acked and dropped, not handed over twice.
    assert.deepEqual(fetched.messages.map((message) => message.id), [missed])
    const ack = await readAck(config, injected, "reviewer")
    assert.equal(ack?.status, "accepted")
  })

  it("announces a batch once and leaves the messages pending for the fetch", async () => {
    const { config } = await twoAgents()
    const notified: number[] = []
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (message) => void injected.push(message.id),
      () => {},
      {},
      async (count) => void notified.push(count),
    )
    const ids = [newMessageId(), newMessageId(), newMessageId()]
    for (const id of ids) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })
    }

    await watcher.drain()
    // One wake-up, no bodies: three turns would have been the old behaviour.
    assert.deepEqual(notified, [3])
    assert.deepEqual(injected, [])
    assert.deepEqual(
      (await messageFiles(path.join(config.inboxDir, "reviewer"))).sort(),
      ids.map((id) => `${id}.json`).sort(),
    )

    // Draining again must not re-announce: the batch is unresolved.
    await watcher.drain()
    assert.deepEqual(notified, [3])

    const taken = await watcher.takeBatch(10)
    assert.deepEqual(taken.messages.map((message) => message.id), ids)
    assert.equal(taken.hasMore, false)
    assert.deepEqual(injected, [])
  })

  it("injects bodies once the fetch window expires, and only what is pending", async () => {
    const { config } = await twoAgents({ fetchFallbackMs: 60_000 })
    const notified: number[] = []
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (message) => void injected.push(message.id),
      () => {},
      {},
      async (count) => void notified.push(count),
    )
    const ids = [newMessageId(), newMessageId(), newMessageId()]
    for (const id of ids) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })
    }
    await watcher.drain()
    assert.deepEqual(notified, [3])

    // The model read one and walked away: that read moved the deadline, so the
    // fallback is not due yet and must not take the two that remain.
    await watcher.takeBatch(1)
    await watcher.drain()
    assert.deepEqual(injected, [])

    // Push the deadline into the past rather than sleeping through it.
    watcher.expireNotification()
    await watcher.drain()
    assert.deepEqual(injected, ids.slice(1))
    assert.deepEqual(await messageFiles(path.join(config.inboxDir, "reviewer")), [])

    // Resolved: nothing left, so no further notification and nothing to inject.
    await watcher.drain()
    assert.deepEqual(notified, [3])
    assert.deepEqual(injected, ids.slice(1))
  })

  it("gives a contested message to exactly one winner", async () => {
    const { config } = await twoAgents({ fetchFallbackMs: 60_000 })
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (message) => void injected.push(message.id),
      () => {},
      {},
      async () => {},
    )
    const ids = [newMessageId(), newMessageId(), newMessageId()]
    for (const id of ids) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })
    }
    await watcher.drain()
    await waitFor(async () =>
      (await messageFiles(path.join(config.inboxDir, "reviewer"))).length === ids.length,
    )

    // Both consumers race for the same files. The claim decides, so no message
    // may reach the model twice. It is *not* asserted that every message lands
    // in this instant: a fetch that took something resolves the batch, which
    // hands the rest back to the queue for the fallback. That is by design, and
    // the fallback cases above cover delivery.
    const [taken, after] = await Promise.all([
      watcher.takeBatch(10),
      watcher.drain().then(() => injected.length),
    ])
    const fetched = taken.messages.map((message) => message.id)
    const delivered = [...injected]
    assert.equal(fetched.filter((id) => delivered.includes(id)).length, 0)
    assert.equal(new Set([...fetched, ...delivered]).size, fetched.length + delivered.length)
    assert.equal(await readJson(path.join(config.processedDir, `${fetched[0] ?? ids[0]}.json`)).then(
      (marker) => (marker as { via?: string } | undefined)?.via,
    ), fetched.length ? "fetch" : "inject")
  })

  it("injects a single message straight to the session, bypassing fetch", async () => {
    const { config } = await twoAgents()
    const notified: number[] = []
    const injected: string[] = []
    const watcher = new InboxWatcher(
      config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (message) => void injected.push(message.id),
      () => {},
      {},
      async (count) => void notified.push(count),
    )
    const id = newMessageId()
    await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })

    await watcher.drain()
    assert.deepEqual(injected, [id])
    assert.deepEqual(notified, [])
    assert.deepEqual(await watcher.takeBatch(10), { messages: [], hasMore: false })
    const marker = await readJson<Record<string, unknown>>(
      path.join(config.processedDir, `${id}.json`),
    )
    assert.equal(marker?.["via"], "inject")
  })

  it("consumes what it takes: marker with via fetch, and gone from the inbox", async () => {
    const { config } = await twoAgents()
    const watcher = idleWatcher(config, "reviewer")
    const id = newMessageId()
    const threadId = newMessageId()
    await enqueue(config, {
      ...leaseMessageWithId(id),
      to: "reviewer",
      from: "planner",
      replyDepth: 2,
      threadId,
    })

    const first = await watcher.takeBatch(10)
    assert.deepEqual(first.messages.map((message) => message.id), [id])
    const marker = await readJson<Record<string, unknown>>(
      path.join(config.processedDir, `${id}.json`),
    )
    assert.equal(marker?.["via"], "fetch")
    assert.equal(marker?.["depth"], 2)
    assert.equal(marker?.["threadId"], threadId)
    assert.deepEqual(await messageFiles(path.join(config.inboxDir, "reviewer")), [])

    // The sender must learn the outcome. Without the ack a fetched message sat
    // at `queued` until it aged into `undeliverable`, which reads as "never
    // arrived" for a message the model had just read.
    assert.equal((await readAck(config, id, "reviewer"))?.status, "accepted")

    // A second fetch must not hand the same message back.
    assert.deepEqual(await watcher.takeBatch(10), { messages: [], hasMore: false })
  })

  it("reports hasMore for a live claim of its own, not for a foreign one", async () => {
    // Found live: a fetch that took everything said `hasMore: false` while our
    // own claim sat on disk, so the model stopped paging and the message waited
    // for the next notification instead of being delivered. Counting `*.taken`
    // naively is not the fix either — a claim another watcher holds is being
    // injected into that session and is not ours to fetch (see the mid-inject
    // takeover race), so counting it would page forever.
    const { config } = await twoAgents()
    const mine = idleWatcher(config, "reviewer")
    const held = newMessageId()
    const foreign = newMessageId()
    await stageLiveClaim(path.join(config.inboxDir, "reviewer"), {
      ...leaseMessageWithId(held),
      to: "reviewer",
      from: "planner",
    })
    // The same staged claim, but stamped with another watcher's identity.
    await writeJsonAtomic(path.join(config.inboxDir, "reviewer", `${foreign}.json`), {
      ...leaseMessageWithId(foreign),
      to: "reviewer",
      from: "planner",
    })
    await claimFile(
      path.join(config.inboxDir, "reviewer", `${foreign}.json`),
      ".taken",
      { ...leaseClaim("soon"), ownerInstance: "someone-else", incarnation: "other" },
    )
    await removeFile(path.join(config.inboxDir, "reviewer", `${foreign}.json`))

    const result = await mine.takeBatch(10)
    assert.deepEqual(result.messages, [])
    // One of the two claims is ours: still more mail.
    assert.equal(result.hasMore, true)
  })

  it("reports hasMore and stops at the limit", async () => {
    const { config } = await twoAgents({ fetchLimit: 2 })
    const watcher = idleWatcher(config, "reviewer")
    const ids = [newMessageId(), newMessageId(), newMessageId()]
    for (const id of ids) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })
    }

    // Oldest first: a queue that answered newest-first would reorder the mail.
    const first = await watcher.takeBatch(config.fetchLimit)
    assert.deepEqual(first.messages.map((message) => message.id), ids.slice(0, 2))
    assert.equal(first.hasMore, true)

    const rest = await watcher.takeBatch(config.fetchLimit)
    assert.deepEqual(rest.messages.map((message) => message.id), ids.slice(2))
    assert.equal(rest.hasMore, false)
  })

  it("takes only what the limit allows, oldest first", async () => {
    const { config } = await twoAgents()
    const watcher = idleWatcher(config, "reviewer")
    const first = newMessageId()
    const second = newMessageId()
    await enqueue(config, { ...leaseMessageWithId(first), to: "reviewer", from: "planner" })
    await enqueue(config, { ...leaseMessageWithId(second), to: "reviewer", from: "planner" })

    const taken = await watcher.takeBatch(1)
    assert.deepEqual(taken.messages.map((message) => message.id), [first])
    assert.equal(taken.hasMore, true)
  })

  it("tells an unregistered session to register before fetching", async () => {
    const { a } = await twoAgents()
    const tools = buildTools(a.mesh, "http://127.0.0.1:4096")
    const fetch = tools[TOOL_FETCH] as unknown as {
      execute: (args: unknown, ctx: { sessionID: string }) => Promise<{ output: string }>
    }

    const result = await fetch.execute(
      {},
      { sessionID: "ses_never_registered", directory: "/tmp/x", worktree: "" },
    )
    assert.match(result.output, /not on the mesh yet/)
  })

  it("names the reason when registration itself fails, instead of leaking a raw fs error", async () => {
    const { config } = await twoAgents()
    // A home that cannot exist: its parent is a regular file, so the mkdir behind
    // registration fails for a reason the model can be told. The config has to go
    // through `resolveConfig`, since the derived paths are computed from the home.
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-blocked-")), "not-a-dir")
    await fs.writeFile(file, "in the way")
    const blocked = testMesh(testConfig(path.join(file, "mesh"), { pollIntervalMs: config.pollIntervalMs }))
    cleanups.push(async () => {
      await blocked.mesh.dispose()
    })
    const tools = buildTools(blocked.mesh, "http://127.0.0.1:4096")
    const send = tools[TOOL_SEND] as unknown as {
      execute: (args: unknown, ctx: { sessionID: string }) => Promise<{ output: string }>
    }

    await assert.rejects(
      () =>
        send.execute(
          { to: "reviewer", text: "hello" },
          { sessionID: "ses_newcomer", directory: "/tmp/x", worktree: "" },
        ),
      (error: MeshError) => {
        assert.equal(error.code, "E_NOT_REGISTERED")
        assert.match(error.message, /could not be registered/)
        assert.match(error.message, /agentpost_register/)
        // The reason, not just the fact: the underlying text is what tells an
        // operator whether this is permissions, a missing parent, or a bad path.
        assert.match(error.message, /ENOTDIR|not-a-dir/)
        return true
      },
    )
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

  it("sees the peer through agentpost_peers", async () => {
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

  it("lists peers least-idle first, alive before stale, id as the tie-break", async () => {
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
    // The retry ran on a poll tick, not inside start()'s own drain, so the ack
    // is written after start() has already resolved.
    await waitFor(async () =>
      (await readJson<Record<string, unknown>>(path.join(config.acksDir, `${message.id}.json`)))
        ?.["status"] === "accepted",
    )
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
    // Wait for the claim to come back rather than reading the instant `stop()`
    // resolves: `stop` only clears the timer, so a drain already in flight still
    // holds the message as `*.json.taken`, and `messageFiles` cannot see that
    // name. The message is never lost — the busy path returns it to the queue —
    // but it is momentarily under the other name.
    await waitFor(async () => (await messageFiles(inbox)).includes(`${message.id}.json`))
    const queued = await readJson<Record<string, unknown>>(
      path.join(inbox, `${message.id}.json`),
    )
    assert.ok((queued?.["_busyDeferCount"] as number) >= 2)
    assert.deepEqual(await messageFiles(inbox), [`${message.id}.json`])
  })

  it("accumulates a busy sender's messages and hands them over as a batch", async () => {
    const home = await tempHome()
    const config = testConfig(home, { pollIntervalMs: 10, busyDeferMs: 1, fetchFallbackMs: 60_000 })
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const messages = [newMessageId(), newMessageId(), newMessageId()].map((id) =>
      leaseMessageWithId(id),
    )
    const inbox = path.join(config.inboxDir, "reviewer")
    await fs.mkdir(inbox, { recursive: true })
    for (const message of messages) {
      await writeJsonAtomic(path.join(inbox, `${message.id}.json`), message)
    }
    const injected: string[] = []
    const notified: number[] = []
    let attempts = 0
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
      {},
      async (count) => {
        // The real notifier injects a turn, so it fails exactly like the body
        // path does while the session is busy.
        attempts += 1
        if (busy) throw new SessionBusyError("ses_b")
        void notified.push(count)
      },
    )
    cleanups.push(() => watcher.stop())
    const starting = watcher.start()
    // While the session is busy the pile only grows: no body, no notice, and
    // nothing left claimed — every attempt gives the claims straight back.
    await waitFor(() => attempts >= 2)
    assert.deepEqual(notified, [])
    assert.deepEqual(injected, [])

    busy = false
    // Once it frees up, one notice covers the whole pile and fetch takes it.
    await waitFor(() => notified.length === 1)
    assert.equal(notified[0], 3)
    assert.deepEqual(injected, [])

// Which route each message takes is not fixed: the pile is announced as a batch,
//    and whatever is still alone when a later drain finds it is injected as a
    // body. Both are correct. What must hold is that every message arrives once
    // and only once, whichever route carried it.
    const collected: string[] = []
    await waitFor(async () => {
      const taken = await watcher.takeBatch(10)
      collected.push(...taken.messages.map((message) => message.id))
      return collected.length + injected.length === messages.length
    })
    const delivered = [...collected, ...injected]
    assert.deepEqual(new Set(delivered), new Set(messages.map((message) => message.id)))
    assert.equal(delivered.length, messages.length)
    await starting
  })

  it("keeps one sender's messages in order and never promises an order between senders", async () => {
    const { config } = await twoAgents({ fetchLimit: 10 })
    const watcher = idleWatcher(config, "reviewer")
    const fromPlanner = [newMessageId(), newMessageId(), newMessageId()]
    const fromAuditor = [newMessageId(), newMessageId()]
    for (const id of fromPlanner) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "planner" })
    }
    for (const id of fromAuditor) {
      await enqueue(config, { ...leaseMessageWithId(id), to: "reviewer", from: "auditor" })
    }

    const taken = await watcher.takeBatch(10)
    const order = taken.messages.map((message) => message.id)
    // Within one sender the ULIDs are monotonic and the queue is drained in name
    // order, so the sequence is guaranteed. Between senders it is not: ULIDs from
    // different processes are not comparable, so we assert nothing about that
    // beyond every message arriving exactly once.
    for (const ids of [fromPlanner, fromAuditor]) {
      const positions = ids.map((id) => order.indexOf(id))
      assert.equal(positions.every((position) => position >= 0), true)
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
    }
    assert.equal(new Set(order).size, fromPlanner.length + fromAuditor.length)
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

  it("hands a recreated session the address and mailbox of its predecessor", async () => {
    const { a, b, config } = await twoAgents()
    const first = await a.mesh.autoRegister(sessionContext("ses_old", "/tmp/My Project"))
    assert.ok(first)
    // Mail sitting in the old address's inbox: the whole point of inheriting.
    const queued = newMessageId()
    await enqueue(config, { ...leaseMessageWithId(queued), to: first, from: "planner" })
    // The old process is gone.
    const record = (await a.mesh.registry.get(first))!.record
    record.pid = 2 ** 30
    await writeJsonAtomic(a.mesh.registry.recordPath(first), record)

    const second = await b.mesh.autoRegister(sessionContext("ses_new", "/tmp/My Project"))
    assert.equal(second, first)
    // The mailbox did not move: the address did, so it stayed put, and the new
    // owner's watcher picks the queued mail up from it.
    await waitFor(async () =>
      Boolean(await readAck(config, queued, first).catch(() => undefined)),
    )
    // The mailbox did not move: the address did, so it stayed put.
    assert.equal((await a.mesh.registry.get(first))!.record.routing.sessionID, "ses_new")
  })

  it("inherits the address and the mailbox but not the predecessor's identity", async () => {
    const { a, b } = await twoAgents()
    const first = await a.mesh.autoRegister(sessionContext("ses_old", "/tmp/My Project"))
    const record = (await a.mesh.registry.get(first))!.record
    record.pid = 2 ** 30
    record.description = "owns the migration"
    record.metadata = { role: "lead" }
    await writeJsonAtomic(a.mesh.registry.recordPath(first), record)
    // Mail already addressed to the predecessor, to prove the box is what moves.
    await fs.mkdir(path.join(b.mesh.config.inboxDir, first), { recursive: true })

    assert.equal(
      await b.mesh.autoRegister(sessionContext("ses_new", "/tmp/My Project")),
      first,
    )
    const inherited = (await b.mesh.registry.get(first))!.record
    assert.equal(inherited.routing.sessionID, "ses_new")
    assert.equal(
      inherited.description,
      "opencode agent working in /tmp/My Project",
    )
    assert.deepEqual(inherited.metadata, {})
  })

  it("takes its own config description when it inherits an address, not the predecessor's", async () => {
    const { a } = await twoAgents({ description: "owns the migration", metadata: { role: "lead" } })
    const first = await a.mesh.autoRegister(sessionContext("ses_old", "/tmp/My Project"))
    const record = (await a.mesh.registry.get(first))!.record
    record.pid = 2 ** 30
    // The predecessor introduced itself differently. Same config on purpose, so
    // what the newcomer gets is provably not read off the old record.
    record.description = "something else entirely"
    record.metadata = { role: "stale" }
    await writeJsonAtomic(a.mesh.registry.recordPath(first), record)

    const second = await a.mesh.autoRegister(sessionContext("ses_new", "/tmp/My Project"))
    assert.equal(second, first)
    const inherited = (await a.mesh.registry.get(first))!.record
    assert.equal(inherited.description, "owns the migration")
    assert.deepEqual(inherited.metadata, { role: "lead" })
  })

  it("leaves two live sessions in one directory on their own addresses", async () => {
    const { a, b, config } = await twoAgents()
    const first = await a.mesh.autoRegister(sessionContext("ses_a", "/tmp/My Project"))
    const second = await b.mesh.autoRegister(sessionContext("ses_b", "/tmp/My Project"))
    assert.notEqual(first, second)
    assert.equal((await a.mesh.registry.get(first))!.record.routing.sessionID, "ses_a")
    assert.equal((await b.mesh.registry.get(second))!.record.routing.sessionID, "ses_b")
    // And a third session in that directory takes neither while both are alive.
    const c = testMesh(config)
    cleanups.push(async () => {
      await c.mesh.dispose()
    })
    const third = await c.mesh.autoRegister(sessionContext("ses_c", "/tmp/My Project"))
    assert.ok(third)
    assert.notEqual(third, first)
    assert.notEqual(third, second)
  })

  it("mints a new name once the predecessor's record has been reaped", async () => {
    const { a, b, config } = await twoAgents({ presenceReapMs: 1_000 })
    const first = await a.mesh.autoRegister(sessionContext("ses_old", "/tmp/My Project"))
    const gone = (await a.mesh.registry.get(first))!.record
    gone.pid = 2 ** 30
    await writeJsonAtomic(a.mesh.registry.recordPath(first), gone)
    await a.mesh.registry.reap(Date.now() + 2_000)
    assert.equal(await a.mesh.registry.get(first), undefined)

    const second = await b.mesh.autoRegister(sessionContext("ses_new", "/tmp/My Project"))
    assert.notEqual(second, first)
  })

  it("leaves one winner when two recreated sessions race for the same address", async () => {
    const { a, b, config } = await twoAgents({ heartbeatIntervalMs: 20 })
    // The predecessor is a dead process, not a closed one: its record survives
    // until the reap, and nobody is watching its inbox any more. Registering it
    // straight through the registry models exactly that — no Mesh, no watcher.
    const first = "planner"
    await a.mesh.registry.register({
      id: first,
      description: "was here first",
      routing: {
        sessionID: "ses_old",
        directory: "/tmp/My Project",
        worktree: "/tmp/My Project",
        serverUrl: "http://127.0.0.1:4096",
      },
      force: true,
    })
    const gone = (await a.mesh.registry.get(first))!.record
    gone.pid = 2 ** 30
    await writeJsonAtomic(a.mesh.registry.recordPath(first), gone)

    // Both newcomers see the same dead predecessor and both try to take it.
    const [left, right] = await Promise.all([
      b.mesh.autoRegister(sessionContext("ses_new_a", "/tmp/My Project")),
      a.mesh.autoRegister(sessionContext("ses_new_b", "/tmp/My Project")),
    ])

// The address file is a plain atomic rewrite, not a claim: last write wins.
// That is the honest limit of this layer, so the test asserts the outcome that
// follows rather than a mutual exclusion that is not implemented. Both newcomers
// read the same takeable predecessor, so both are handed the same address — the
// race decides which session keeps it, not who gets it.
const holder = (await a.mesh.registry.get(first))?.record.routing.sessionID
assert.ok(holder === "ses_new_a" || holder === "ses_new_b")
assert.equal(left, right)
    assert.ok(left && right)

    // ses_new_a belongs to mesh b and ses_new_b to mesh a, so the holder of the
    // record decides which mesh keeps its watcher. The loser's own mesh is the
    // only one that can drop that session: the winner's mesh still holds it, and
    // waiting for both would never come true.
    const winner = holder === "ses_new_a" ? b : a
    const loser = winner === a ? b : a
    const loserSession = loser === a ? "ses_new_b" : "ses_new_a"
    await waitFor(() => loser.mesh.selfId(loserSession) === undefined)
    await enqueue(config, { ...leaseMessage(), id: newMessageId(), to: first, from: "planner" })

    // Exactly one of them delivers, and the loser delivers nothing at all.
    await waitFor(() => winner.injected.length === 1, 3_000)
    assert.deepEqual(loser.injected, [])
  })

  it("stops delivering into a session that lost its address to another", async () => {
    const { config, a, b } = await twoAgents({ heartbeatIntervalMs: 20 })
    const context = sessionContext("ses_b", "/tmp/reviewer")
    const id = await b.mesh.autoRegister(context)
    // The original owner looks gone, which is what lets a rival claim the
    // address at all. Its session, however, is still running and still heartbeating.
    const record = (await b.mesh.registry.get(id))!.record
    record.pid = 2 ** 30
    await writeJsonAtomic(b.mesh.registry.recordPath(id), record)

    const rival = await a.mesh.autoRegister({ ...context, sessionID: "ses_rival" })
    assert.equal(rival, id)

    // The first owner is fenced and stands down rather than delivering into a
    // session that no longer owns the mailbox.
    await waitFor(() => b.mesh.selfId("ses_b") === undefined)
    const messageId = newMessageId()
    await enqueue(config, { ...leaseMessage(), id: messageId, to: id, from: "planner" })

    // The rival owns the mailbox now, so it is the one that delivers.
    await waitFor(() => a.injected.length === 1, 3_000)
    // And the fenced session never injects, not once, not later.
    assert.deepEqual(b.injected, [])
  })

  it("keeps a session delivering when its record is reaped but nobody took the address", async () => {
    const { config, a } = await twoAgents({ heartbeatIntervalMs: 20 })
    const id = await a.mesh.register({
      context: sessionContext("ses_a", "/tmp/planner"),
      id: "planner",
      description: "owns the migration",
      metadata: { role: "lead" },
    }).then((r) => r.self.id)
    // Some other mesh's sweep reaped the record while this session was blocked.
    // Nobody claimed the address — that is what distinguishes this from a fence.
    await fs.rm(a.mesh.registry.recordPath(id), { force: true })
    await waitFor(async () => (await a.mesh.registry.get(id)) !== undefined)

    const messageId = newMessageId()
    await enqueue(config, { ...leaseMessage(), id: messageId, to: id, from: "reviewer" })
    await waitFor(() => a.injected.length === 1, 3_000)

    // Written back as the same colleague, not as a fresh anonymous process.
    const restored = (await a.mesh.registry.get(id))?.record
    assert.equal(restored?.routing.sessionID, "ses_a")
    assert.equal(restored?.description, "owns the migration")
    assert.deepEqual(restored?.metadata, { role: "lead" })
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
