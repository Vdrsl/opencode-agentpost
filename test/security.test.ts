import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, it } from "node:test"

import { assertValidId, type MeshConfig, slugify } from "../src/config.ts"
import { renderEnvelope } from "../src/envelope.ts"
import { InboxWatcher, readAck, waitForAck } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import { claimFile, ensureDir, listJsonFiles, writeJsonAtomic } from "../src/store.ts"
import type { MeshMessage } from "../src/types.ts"
import { noopLogger } from "../src/logger.ts"
import { tempHome, testConfig, waitFor } from "./helpers.ts"

async function withHome(run: (config: MeshConfig, home: string) => Promise<void>): Promise<void> {
  const home = await tempHome()
  try {
    await run(testConfig(home), home)
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
}

function message(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    schemaVersion: 1,
    id: newMessageId(),
    from: "sender",
    to: "reviewer",
    text: "security test",
    sentAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("claim primitive", () => {
  // The whole at-most-once delivery model rests on this: a rename was used
  // before, and on Windows two concurrent renames of one source both succeed,
  // so two delivery paths could each believe they owned the same message.
  for (const consumers of [2, 4]) {
    it(`gives a contested message to exactly one of ${consumers} consumers`, async () => {
      const home = await tempHome()
      const file = path.join(home, "contested.json")
      await writeJsonAtomic(file, { schemaVersion: 1, id: "contested" })
      const claim = {
        ownerInstance: "owner-a",
        incarnation: "incarnation-a",
        sessionID: "ses_a",
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        attempt: 1,
      }

      const results = await Promise.all(
        Array.from({ length: consumers }, () => claimFile(file, ".taken", claim)),
      )
      assert.equal(results.filter(Boolean).length, 1)
    })
  }
})

describe("security boundaries", () => {
  it("accepts ordinary IDs", () => {
    assert.doesNotThrow(() => assertValidId("reviewer_1"))
  })

  it("rejects traversal IDs", () => {
    for (const id of ["../escape", "..\\escape", "a/b", "a\\b", "/absolute"]) {
      assert.throws(() => assertValidId(id))
    }
  })

  it("rejects empty and overlong IDs", () => {
    assert.throws(() => assertValidId(""))
    assert.throws(() => assertValidId("a".repeat(65)))
  })

  it("rejects control characters and special characters in IDs", () => {
    for (const id of ["sender\nx", "sender\0x", "sender x", "sender?", "sender/"]) {
      assert.throws(() => assertValidId(id))
    }
  })

  it("rejects every Windows reserved ID case-insensitively", () => {
    const reserved = [
      "con",
      "nul",
      "prn",
      "aux",
      ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
    ]
    for (const id of reserved) {
      assert.throws(() => assertValidId(id))
      assert.throws(() => assertValidId(id.toUpperCase()))
    }
    assert.doesNotThrow(() => assertValidId("con-agent"))
  })

  it("keeps Unicode input safe through slugify", () => {
    const id = slugify("日本語")
    assert.doesNotThrow(() => assertValidId(id))
  })

  it("rejects a traversal recipient before enqueue", async () => {
    await withHome(async (config) => {
      const { enqueue } = await import("../src/inbox.ts")
      await assert.rejects(() => enqueue(config, message({ to: "../escape" })))
    })
  })

  it("quarantines a message addressed to another recipient", async () => {
    await withHome(async (config) => {
      const msg = message({ to: "other" })
      const inbox = path.join(config.inboxDir, "reviewer")
      await writeJsonAtomic(path.join(inbox, `${msg.id}.json`), msg)
      const watcher = new InboxWatcher(
        config,
        "reviewer",
        "ses_reviewer",
        "owner",
        "incarnation",
        async () => assert.fail("mismatched recipient must not inject"),
        noopLogger,
      )
      await watcher.start()
      await watcher.stop()
      assert.equal(
        await fs.stat(path.join(config.quarantineDir, "reviewer", `${msg.id}.invalid`)).then(() => true),
        true,
      )
    })
  })

  it("quarantines a message with an invalid sender", async () => {
    await withHome(async (config) => {
      const msg = message({ from: "../sender" })
      const inbox = path.join(config.inboxDir, "reviewer")
      await writeJsonAtomic(path.join(inbox, `${msg.id}.json`), msg)
      const watcher = new InboxWatcher(
        config,
        "reviewer",
        "ses_reviewer",
        "owner",
        "incarnation",
        async () => assert.fail("invalid sender must not inject"),
        noopLogger,
      )
      await watcher.start()
      await watcher.stop()
      assert.equal(await fs.stat(path.join(config.quarantineDir, "reviewer", `${msg.id}.invalid`)).then(() => true), true)
    })
  })

  it("quarantines oversized message text", async () => {
    await withHome(async (config) => {
      const msg = message({ text: "123456" })
      const inbox = path.join(config.inboxDir, "reviewer")
      await writeJsonAtomic(path.join(inbox, `${msg.id}.json`), msg)
      const watcher = new InboxWatcher(
        { ...config, maxTextLength: 5 },
        "reviewer",
        "ses_reviewer",
        "owner",
        "incarnation",
        async () => assert.fail("oversized message must not inject"),
        noopLogger,
      )
      await watcher.start()
      await watcher.stop()
      assert.equal(await fs.stat(path.join(config.quarantineDir, "reviewer", `${msg.id}.invalid`)).then(() => true), true)
    })
  })

  it("sanitizes control characters in envelope headers", () => {
    const rendered = renderEnvelope(message({ from: "sender\nX", context: "ctx\0tag" }))
    const header = rendered.split("\n")[0] ?? ""
    assert.equal(header.includes("\n"), false)
    assert.equal(header.includes("\0"), false)
    assert.match(header, /from: senderX/)
  })

  it("rejects forged ack IDs", async () => {
    await withHome(async (config) => {
      const id = newMessageId()
      await writeJsonAtomic(path.join(config.acksDir, `${id}.json`), {
        id: newMessageId(),
        to: "reviewer",
        status: "accepted",
        at: new Date().toISOString(),
      })
      assert.equal(await readAck(config, id, "reviewer"), undefined)
    })
  })

  it("rejects forged ack recipients", async () => {
    await withHome(async (config) => {
      const id = newMessageId()
      await writeJsonAtomic(path.join(config.acksDir, `${id}.json`), {
        id,
        to: "attacker",
        status: "accepted",
        at: new Date().toISOString(),
      })
      assert.equal(await readAck(config, id, "reviewer"), undefined)
      assert.equal(await waitForAck(config, id, 0, "reviewer"), undefined)
    })
  })

  it("accepts an ack only for the requested message and recipient", async () => {
    await withHome(async (config) => {
      const id = newMessageId()
      await writeJsonAtomic(path.join(config.acksDir, `${id}.json`), {
        id,
        to: "reviewer",
        status: "accepted",
        at: new Date().toISOString(),
      })
      assert.equal((await readAck(config, id, "reviewer"))?.status, "accepted")
    })
  })

  it("ignores symlink JSON files when listing", async () => {
    await withHome(async (config, home) => {
      const dir = path.join(home, "list")
      await fs.mkdir(dir)
      await writeJsonAtomic(path.join(dir, "real.json"), { ok: true })
      const link = path.join(dir, "link.json")
      try {
        await fs.symlink(path.join(dir, "real.json"), link, "file")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return
        throw error
      }
      assert.deepEqual(await listJsonFiles(dir), ["real.json"])
    })
  })

  it("rejects symlinked directories", async () => {
    await withHome(async (_config, home) => {
      const target = path.join(home, "target")
      const link = path.join(home, "link")
      await fs.mkdir(target)
      try {
        await fs.symlink(target, link, "junction")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return
        throw error
      }
      await assert.rejects(() => ensureDir(link), /unsafe directory/)
    })
  })

  it("rejects a non-directory at a storage path", async () => {
    await withHome(async (_config, home) => {
      const file = path.join(home, "not-a-dir")
      await fs.writeFile(file, "x")
      await assert.rejects(() => ensureDir(file), /unsafe directory/)
    })
  })

  it("does not inject a message with a forged recipient", async () => {
    await withHome(async (config) => {
      const msg = message({ to: "other" })
      const inbox = path.join(config.inboxDir, "reviewer")
      await writeJsonAtomic(path.join(inbox, `${msg.id}.json`), msg)
      let injected = 0
      const watcher = new InboxWatcher(
        config,
        "reviewer",
        "ses_reviewer",
        "owner",
        "incarnation",
        async () => { injected++ },
        noopLogger,
      )
      await watcher.start()
      await waitFor(() => fs.stat(path.join(config.quarantineDir, "reviewer", `${msg.id}.invalid`)).then(() => true))
      await watcher.stop()
      assert.equal(injected, 0)
    })
  })
})
