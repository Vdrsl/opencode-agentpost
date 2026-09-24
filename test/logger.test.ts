import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { reapAcks } from "../src/inbox.ts"
import { resolveConfig } from "../src/config.ts"
import { createLogger, noopLogger, resolveLogLevel, type LogFields } from "../src/logger.ts"
import { writeJsonAtomic } from "../src/store.ts"

describe("logger and ack retention", () => {
  it("resolves explicit levels and the deprecated debug fallback", () => {
    assert.equal(resolveLogLevel({ AGENTMESH_LOG_LEVEL: "debug", AGENTMESH_DEBUG: "1" }), "debug")
    assert.equal(resolveLogLevel({ AGENTMESH_LOG_LEVEL: "off", AGENTMESH_DEBUG: "1" }), "off")
    assert.equal(resolveLogLevel({ AGENTMESH_LOG_LEVEL: "invalid" }), "off")
    assert.equal(resolveLogLevel({ AGENTMESH_DEBUG: "yes" }), "info")
    assert.equal(resolveLogLevel({}), "off")
  })

  it("emits JSON lines with fixed events and safe fields only", () => {
    const lines: string[] = []
    const logger = createLogger({
      env: { AGENTMESH_LOG_LEVEL: "debug" },
      write: (line) => lines.push(line),
    })
    logger("debug", "safe.event", {
      count: 2,
      alive: true,
      text: "secret",
      serverUrl: "http://secret",
    } as unknown as LogFields)
    logger("info", "bad\nsecret", { attempt: 1 })
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!) as Record<string, unknown>
    const second = JSON.parse(lines[1]!) as Record<string, unknown>
    assert.equal(first["event"], "safe.event")
    assert.equal(first["count"], 2)
    assert.equal(first["alive"], true)
    assert.equal(first["text"], undefined)
    assert.equal(first["serverUrl"], undefined)
    assert.equal(second["event"], "invalid_event")
    assert.equal(second["attempt"], 1)
  })

  it("honors off and noop logger", () => {
    const lines: string[] = []
    const logger = createLogger({ env: { AGENTMESH_LOG_LEVEL: "off" }, write: (line) => lines.push(line) })
    logger("error", "ignored")
    noopLogger("error", "ignored")
    assert.equal(lines.length, 0)
  })

  it("validates ack retention independently from agent expiry", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-ack-retention-"))
    try {
      assert.equal(resolveConfig({ home }).ackRetentionMs, 300_000)
      assert.throws(
        () => resolveConfig({ home, ackRetentionMs: 0 }),
        /ackRetentionMs must be a finite number greater than zero/,
      )
      assert.throws(
        () => resolveConfig({ home, ackRetentionMs: 86_400_001 }),
        /ackRetentionMs must be at most 86400000ms/,
      )
      const config = resolveConfig({ home, ackRetentionMs: 10, expireAfterMs: 120_000 })
      const ackFile = path.join(config.acksDir, "agm_01aaaaaaaaaaaaaaaaaaaaaaaa.json")
      await writeJsonAtomic(ackFile, { id: "agm_01aaaaaaaaaaaaaaaaaaaaaaaa", to: "peer", sessionID: "ses_a", status: "accepted", at: new Date().toISOString() })
      const old = new Date(Date.now() - 20)
      await fs.utimes(ackFile, old, old)
      assert.equal(await reapAcks(config), 1)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
