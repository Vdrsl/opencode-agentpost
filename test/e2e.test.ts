import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { InboxWatcher } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import { readJson, writeJsonAtomic } from "../src/store.ts"
import { PromptTimeoutError, SessionBusyError, SessionNotFoundError } from "../src/types.ts"
import { startFakeOpenCode, type FakeOpenCode, type FakeOpenCodeMode } from "./fake-opencode.ts"
import { noopLogger } from "../src/logger.ts"
import { testConfig, waitFor } from "./helpers.ts"

function message() {
  return {
    schemaVersion: 1 as const,
    id: newMessageId(),
    from: "sender",
    to: "reviewer",
    text: "boundary test",
    sentAt: new Date().toISOString(),
  }
}

function errorTag(value: unknown): string | undefined {
  const error = (value as { error?: unknown } | undefined)?.error
  if (!error || typeof error !== "object") return undefined
  const tag = (error as { _tag?: unknown })._tag
  return typeof tag === "string" ? tag : undefined
}

async function inject(fake: FakeOpenCode, sessionID: string, text: string, timeoutMs: number): Promise<void> {
  const get = await fake.client.session.get({
    path: { id: sessionID },
    query: { directory: "I:\\fake" },
  })
  const getTag = errorTag(get)
  if (getTag === "SessionNotFoundError") throw new SessionNotFoundError(sessionID)
  if (get.error) throw new Error(String(get.error))

  const status = await fake.client.session.status({ query: { directory: "I:\\fake" } })
  const statusTag = errorTag(status)
  if (statusTag) throw new Error(`status: ${statusTag}`)
  const current = status.data?.[sessionID]?.type
  if (current === "busy" || current === "retry") throw new SessionBusyError(sessionID)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const promptAsync = fake.client.session.promptAsync as unknown as (
    options: Record<string, unknown>,
  ) => Promise<unknown>
  try {
    const result = await promptAsync.call(fake.client.session, {
      path: { id: sessionID },
      query: { directory: "I:\\fake" },
      body: { parts: [{ type: "text", text }] },
      signal: controller.signal,
    })
    if (controller.signal.aborted) throw new PromptTimeoutError(timeoutMs)
    const tag = errorTag(result)
    if (tag === "SessionNotFoundError") throw new SessionNotFoundError(sessionID)
    if (tag === "SessionBusyError") throw new SessionBusyError(sessionID)
    if ((result as { error?: unknown }).error) throw new Error(String((result as { error: unknown }).error))
  } catch (error) {
    if (controller.signal.aborted) throw new PromptTimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function fixture(mode: FakeOpenCodeMode, overrides: Record<string, unknown> = {}) {
  const fake = await startFakeOpenCode(mode)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-e2e-"))
  const config = testConfig(home, { pollIntervalMs: 10, ...overrides })
  const inbox = path.join(config.inboxDir, "reviewer")
  await fs.mkdir(inbox, { recursive: true })
  return { fake, home, config, inbox }
}

async function cleanup(home: string, fake: FakeOpenCode, watcher?: InboxWatcher): Promise<void> {
  await watcher?.stop()
  await fake.close()
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(home, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function watcherFor(config: ReturnType<typeof testConfig>, fake: FakeOpenCode, onEvent?: (event: string) => void) {
  return new InboxWatcher(
    config,
    "reviewer",
    "ses_fake",
    "owner-a",
    "incarnation-a",
    (input) => inject(fake, input.sessionID, input.text, config.promptTimeoutMs),
    (_error, event) => onEvent?.(event),
  )
}

async function waitForFile(file: string): Promise<void> {
  await waitFor(() => existsSync(file))
}

describe("OpenCode boundary E2E", () => {
  it("accepts a prompt after HTTP 204", async () => {
    const f = await fixture("accepted")
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const ack = path.join(f.config.acksDir, `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitForFile(ack)
      assert.equal((await readJson<Record<string, unknown>>(ack))?.["status"], "accepted")
      assert.equal(existsSync(path.join(f.config.processedDir, `${msg.id}.json`)), true)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("fails and dead-letters HTTP 404", async () => {
    const f = await fixture("not_found")
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const ack = path.join(f.config.acksDir, `${msg.id}.json`)
    const dead = path.join(f.config.deadDir, "reviewer", `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitForFile(dead)
      assert.equal((await readJson<Record<string, unknown>>(ack))?.["status"], "failed")
      assert.equal(existsSync(path.join(f.config.processedDir, `${msg.id}.json`)), false)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("defers HTTP 409 as a queued retry without an ack", async () => {
    const f = await fixture("busy", { busyDeferMs: 100, pollIntervalMs: 1000 })
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const ack = path.join(f.config.acksDir, `${msg.id}.json`)
    let busySeen!: () => void
    const busy = new Promise<void>((resolve) => { busySeen = resolve })
    const watcher = watcherFor(f.config, f.fake, (event) => {
      if (event === "session_busy") busySeen()
    })
    try {
      await writeJsonAtomic(pending, msg)
      const started = watcher.start()
      await busy
      await watcher.stop()
      await started
      assert.equal(existsSync(pending), true)
      assert.equal(existsSync(ack), false)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("retries HTTP 500 and dead-letters after the bound", async () => {
    const f = await fixture("server_error", { maxDeliveryAttempts: 2, pollIntervalMs: 10 })
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const dead = path.join(f.config.deadDir, "reviewer", `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitForFile(dead)
      assert.equal((await readJson<Record<string, unknown>>(path.join(f.config.acksDir, `${msg.id}.json`)))?.["status"], "failed")
      assert.equal(f.fake.promptCount() >= 2, true)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("returns ambiguous and no processed marker on timeout", async () => {
    const f = await fixture("timeout", { promptTimeoutMs: 15, pollIntervalMs: 10 })
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const ack = path.join(f.config.acksDir, `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitForFile(ack)
      assert.equal((await readJson<Record<string, unknown>>(ack))?.["status"], "ambiguous")
      assert.equal(existsSync(path.join(f.config.processedDir, `${msg.id}.json`)), false)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("accepts after a busy response when the session becomes idle", async () => {
    const f = await fixture("busy_once", { busyDeferMs: 1, maxBusyDefers: 3, pollIntervalMs: 10 })
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const ack = path.join(f.config.acksDir, `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitForFile(ack)
      assert.equal((await readJson<Record<string, unknown>>(ack))?.["status"], "accepted")
      assert.equal(f.fake.promptCount(), 2)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("suppresses a duplicate after the processed marker exists", async () => {
    const f = await fixture("accepted")
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      await watcher.start()
      await waitFor(() => f.fake.promptCount() === 1)
      await writeJsonAtomic(pending, msg)
      await waitFor(() => !existsSync(pending))
      await waitFor(() => existsSync(path.join(f.config.acksDir, `${msg.id}.json`)))
      assert.equal(f.fake.promptCount(), 1)
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })

  it("dead-letters a queued message when its session was deleted", async () => {
    const f = await fixture("not_found")
    const msg = message()
    const pending = path.join(f.inbox, `${msg.id}.json`)
    const dead = path.join(f.config.deadDir, "reviewer", `${msg.id}.json`)
    const watcher = watcherFor(f.config, f.fake)
    try {
      await writeJsonAtomic(pending, msg)
      assert.equal(existsSync(pending), true)
      await watcher.start()
      await waitForFile(dead)
      await waitFor(() => !existsSync(pending) && !existsSync(`${pending}.taken`))
      assert.equal((await readJson<Record<string, unknown>>(path.join(f.config.acksDir, `${msg.id}.json`)))?.["status"], "failed")
    } finally {
      await cleanup(f.home, f.fake, watcher)
    }
  })
})
