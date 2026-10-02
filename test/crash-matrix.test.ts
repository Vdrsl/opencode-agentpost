import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { InboxWatcher } from "../src/inbox.ts"
import { newMessageId } from "../src/ids.ts"
import { claimFile, readJson, writeJsonAtomic } from "../src/store.ts"
import type { ClaimMeta, MeshMessage } from "../src/types.ts"
import { testConfig, waitFor, stageLiveClaim, expireClaim } from "./helpers.ts"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(id = newMessageId()): MeshMessage {
  return {
    schemaVersion: 1,
    id,
    from: "owner-a",
    to: "reviewer",
    text: "crash matrix",
    sentAt: new Date().toISOString(),
  }
}

function claim(id: string, expired = false): ClaimMeta {
  const now = Date.now()
  const at = expired ? now - 1000 : now
  return {
    ownerInstance: "owner-a",
    incarnation: "incarnation-a",
    sessionID: "ses_b",
    claimedAt: new Date(at).toISOString(),
    leaseExpiresAt: new Date(expired ? at - 1 : at + 1).toISOString(),
    attempt: 0,
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function fixture(overrides: Record<string, unknown> = {}): Promise<{
  home: string
  config: ReturnType<typeof testConfig>
  inbox: string
  pending: (id: string) => string
  claimed: (id: string) => string
  processed: (id: string) => string
  ack: (id: string) => string
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentmesh-crash-"))
  const config = testConfig(home, { leaseDurationMs: 5, pollIntervalMs: 10, ...overrides })
  const inbox = path.join(config.inboxDir, "reviewer")
  await fs.mkdir(inbox, { recursive: true })
  return {
    home,
    config,
    inbox,
    pending: (id) => path.join(inbox, `${id}.json`),
    claimed: (id) => path.join(inbox, `${id}.json.taken`),
    processed: (id) => path.join(config.processedDir, `${id}.json`),
    ack: (id) => path.join(config.acksDir, `${id}.json`),
  }
}

async function stopAndRemove(home: string, watcher?: InboxWatcher): Promise<void> {
  await watcher?.stop()
  // The claim rename in inbox/ leaves a delayed directory entry on Windows, so
  // rmdir can land on ENOTEMPTY. Same retry options test/security.test.ts uses.
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

describe("crash matrix", () => {
  it("C1 leaves a claim when the process crashes after claim", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterClaim: () => { throw new Error("crash C1") } },
    )
    try {
      await watcher.start()
      await watcher.stop()
      assert.equal(injected, 0)
      assert.equal(await exists(f.claimed(msg.id)), true)
      assert.equal(await exists(f.processed(msg.id)), false)
      assert.equal(await exists(f.ack(msg.id)), false)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  it("C7 consolidates both names after a crash between link and drop", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const first = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterClaim: () => { throw new Error("crash C7") } },
    )
    try {
      await first.start()
      await first.stop()
      assert.equal(await exists(f.claimed(msg.id)), true)
      // The hard link is in place; the crash happened before the pending name
      // went away, so both names point at the same inode.
      await fs.link(f.claimed(msg.id), f.pending(msg.id))
      assert.equal(await exists(f.pending(msg.id)), true)
      assert.equal(await exists(f.claimed(msg.id)), true)

      const second = new InboxWatcher(
        f.config,
        "reviewer",
        "ses_b",
        "owner-a",
        "incarnation-a",
        async () => { injected++ },
        () => {},
      )
      await second.start()
      // The claim never got a lease stamped, so recovery deliberately leaves it
      // alone until the fallback window passes — the owner may still be
      // injecting. Delivery therefore waits for a poll, not for start().
      await waitFor(() => injected === 1)
      await second.stop()
      // Recovery dropped the pending name rather than leaving a file that every
      // future drain would lose a claim race against.
      assert.equal(await exists(f.pending(msg.id)), false)
      assert.equal(await exists(f.claimed(msg.id)), false)
      assert.equal(injected, 1)
      assert.equal(await exists(f.processed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, first)
    }
  })

  it("C8 recovers a stale claim while a live watcher is running", async () => {
    const f = await fixture({ leaseDurationMs: 30_000 })
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    const injected: string[] = []
    // The state a crashed process leaves behind: the claim exists and its lease
    // has long expired. It is the same `.taken` the hard link would leave.
    await writeJsonAtomic(f.claimed(msg.id), {
      ...msg,
      _claim: { ...claim(), leaseExpiresAt: new Date(0).toISOString() },
    })
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async (received) => void injected.push(received.id),
      () => {},
    )
    try {
      // Started with the stale claim already in place: recovery at start clears
      // it. The regression this covers is the watcher that was *already* running.
      await watcher.start()
      await waitFor(() => injected.length === 1)
      assert.equal(await exists(f.pending(msg.id)), false)
      assert.equal(await exists(f.claimed(msg.id)), false)
      assert.equal(await exists(f.processed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  it("C9 hands a live claim back only after its lease looks stale", async () => {
    // The lease is the only headroom this test has: it asserts that a young
    // ctime keeps the claim alive, so anything slower than the lease between
    // writing it and `start()` reading it flips the result. 100ms was not enough
    // under `node --test` running files in parallel on a busy machine — it failed
    // on the claim check while passing alone. The wait below costs the same.
    const f = await fixture({ leaseDurationMs: 1_000 })
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
// No `_claim` at all: the window between creating the claim and stamping its
    // lease. The content is deliberately much older than the lease, so only the
    // claim's own ctime can keep it alive — mtime here is just the queueing time.
    await writeJsonAtomic(f.claimed(msg.id), msg)
    const queued = new Date(Date.now() - 60_000)
    await fs.utimes(f.claimed(msg.id), queued, queued)
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => {},
      () => {},
    )
    try {
await watcher.start()
      await watcher.stop()
      // Untouched: the claim is young, even though the message is old. The
      // pending name has to stay as well — a lone `.taken` is not a `.json`
      // file, so dropping the pending name while declining the claim would
      // strand the message where no future drain can find it.
      assert.equal(await exists(f.claimed(msg.id)), true)
      assert.equal(await exists(f.pending(msg.id)), true)

      // Age it past the lease and it is recovered, because now nothing can hold it.
      const second = new InboxWatcher(
        f.config,
        "reviewer",
        "ses_b",
        "owner-a",
        "incarnation-a",
        async () => {},
        () => {},
      )
      await new Promise((resolve) => setTimeout(resolve, f.config.leaseDurationMs + 50))
      await second.start()
      // Wait for delivery rather than reading the instant `stop()` resolves:
      // recovery hands the claim back and the delivery then runs through the
      // claim, so on a loaded machine the names are still on disk at that point.
      await waitFor(async () => !(await exists(f.pending(msg.id))))
      await second.stop()
      // Recovery handed it back and the watcher delivered it, so both names are
      // gone and the processed marker proves it went out exactly once.
      assert.equal(await exists(f.claimed(msg.id)), false)
      assert.equal(await exists(f.pending(msg.id)), false)
      assert.equal(await exists(f.processed(msg.id)), true)
      await stopAndRemove(f.home, second)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  it("C2 retries an expired claim after a crash immediately after claim", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const first = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterClaim: () => { throw new Error("crash C2") } },
    )
    const second = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-b",
      async () => { injected++ },
      () => {},
    )
    try {
      await first.start()
      await first.stop()
      await sleep(10)
      await second.start()
      await waitFor(() => injected === 1)
      const ack = await readJson<Record<string, unknown>>(f.ack(msg.id))
      assert.equal(ack?.["status"], "accepted")
      assert.equal(await exists(f.processed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, first)
      await stopAndRemove(f.home, second)
    }
  })

  it("C3 leaves no marker or ack when the process crashes after handler", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterHandler: () => { throw new Error("crash C3") } },
    )
    try {
      await watcher.start()
      await watcher.stop()
      assert.equal(injected, 1)
      assert.equal(await exists(f.processed(msg.id)), false)
      assert.equal(await exists(f.ack(msg.id)), false)
      assert.equal(await exists(f.claimed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  it("C4 reinjects an expired handler crash because no processed marker exists", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const first = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterHandler: () => { throw new Error("crash C4") } },
    )
    const second = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-b",
      async () => { injected++ },
      () => {},
    )
    try {
      await first.start()
      await first.stop()
      await sleep(10)
      await second.start()
      await waitFor(() => injected === 2)
      const ack = await readJson<Record<string, unknown>>(f.ack(msg.id))
      assert.equal(ack?.["status"], "accepted")
      assert.equal(await exists(f.processed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, first)
      await stopAndRemove(f.home, second)
    }
  })

  it("C5 suppresses a crash after accepted ack and claim recovery", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    let injected = 0
    const first = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
      { afterAck: () => { throw new Error("crash C5") } },
    )
    const second = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-b",
      async () => { injected++ },
      () => {},
    )
    try {
      await first.start()
      await first.stop()
      await sleep(10)
      assert.equal(await exists(f.processed(msg.id)), true)
      const ack = await readJson<Record<string, unknown>>(f.ack(msg.id))
      assert.equal(ack?.["status"], "accepted")
      await second.start()
      await waitFor(() => injected === 1)
      assert.equal(await exists(f.claimed(msg.id)), false)
    } finally {
      await stopAndRemove(f.home, first)
      await stopAndRemove(f.home, second)
    }
  })

  it("C6 recovers a marker without an ack without reinjecting", async () => {
    const f = await fixture()
    const msg = message()
    await writeJsonAtomic(f.pending(msg.id), msg)
    const claimed = await claimFile(f.pending(msg.id), ".taken", claim(msg.id, true))
    assert.ok(claimed)
    await writeJsonAtomic(f.processed(msg.id), { id: msg.id, at: new Date().toISOString() })
    let injected = 0
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_b",
      "owner-a",
      "incarnation-b",
      async () => { injected++ },
      () => {},
    )
    try {
      await watcher.start()
      await waitFor(() => injected === 0)
      const ack = await readJson<Record<string, unknown>>(f.ack(msg.id))
      assert.equal(ack?.["status"], "accepted")
      assert.equal(await exists(f.claimed(msg.id)), false)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  // A declined claim must leave the message visible, and an expired one must be
  // delivered exactly once. Staged through the shared helper rather than by
  // enqueueing and then writing the claim: a running watcher claims the message
  // the moment enqueue returns, so the test would race the thing it sets up and
  // pass without ever entering the branch it was written for.
  it("C10 holds a message whose live claim it declines, then delivers it once", async () => {
    const f = await fixture({ leaseDurationMs: 60_000 })
    const msg = { ...message(), to: "reviewer" }
    const { taken } = await stageLiveClaim(f.inbox, msg, 60_000)

    let injected = 0
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_a",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
    )
    try {
      await watcher.start()
      // A lease nobody gave up: the owner may still be injecting, so recovery
      // declines and both names stay — a lone `.taken` is not a `.json` file and
      // would leave a directory that looks empty with the mail inside it.
      await sleep(120)
      assert.equal(injected, 0)
      assert.equal(await exists(f.pending(msg.id)), true)
      assert.equal(await exists(taken), true)

      await expireClaim(taken)
      // Wait for the terminal state, not for the handler. The injection runs
      // before the marker is written and before the claim is dropped, so
      // `injected === 1` is true while both names are still on disk — asserting
      // on them right after passes on a slow machine and fails on a fast one.
      await waitFor(async () => !(await exists(f.pending(msg.id))) && !(await exists(taken)))
      assert.equal(injected, 1)
      assert.equal(await exists(f.processed(msg.id)), true)
    } finally {
      await stopAndRemove(f.home, watcher)
    }
  })

  // The window between `fs.link` and `stampClaim`. `claimFile` links, drops the
  // pending name, and only then stamps the lease, so a crash inside it leaves a
  // claim whose owner is mid-claim and whose lease nobody can read. Recovery must
  // not read that as stale: it falls back to the claim's own ctime and declines
  // while the window is open, which is the only thing keeping the mail visible.
  // An unstamped claim is staged by rewriting the file in place — an in-place
  // write keeps the inode, so both names stay one file, which is the whole state
  // under test. A helper that rewrote the claim atomically would quietly leave
  // two inodes and test something else.
  it("C11 leaves an unstamped claim alone while it is young, then delivers it once", async () => {
    const f = await fixture({ leaseDurationMs: 60_000 })
    const msg = { ...message(), to: "reviewer" }
    const { taken } = await stageLiveClaim(f.inbox, msg, 60_000)
    const raw = JSON.parse(await fs.readFile(taken, "utf8")) as Record<string, unknown>
    delete raw["_claim"]
    await fs.writeFile(taken, JSON.stringify(raw))
    const staged = await fs.stat(taken)
    assert.equal((await fs.stat(f.pending(msg.id))).ino, staged.ino)

    let injected = 0
    const watcher = new InboxWatcher(
      f.config,
      "reviewer",
      "ses_a",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
    )
    try {
      await watcher.start()
      // No lease to respect, so ctime is the only evidence that the owner may
      // still be injecting. Too young to be stale: decline, and keep the pending
      // name — a lone `.taken` is not a `.json` file, so nothing else would ever
      // look at this mail again.
      await sleep(120)
      assert.equal(injected, 0)
      assert.equal(await exists(f.pending(msg.id)), true)
      assert.equal(await exists(taken), true)
      assert.equal(await exists(f.processed(msg.id)), false)
    } finally {
      await watcher.stop()
    }

    // The same unstamped claim, once the window has passed. `leaseDurationMs: 0`
    // is how a test says "the window is over": ctime cannot be backdated, and
    // rewriting the claim would stamp a lease that never existed.
    const later = new InboxWatcher(
      testConfig(f.home, { leaseDurationMs: 0, pollIntervalMs: 10 }),
      "reviewer",
      "ses_a",
      "owner-a",
      "incarnation-a",
      async () => { injected++ },
      () => {},
    )
    try {
      await later.start()
      // Wait for the terminal state, not for the handler — the injection runs
      // before the marker is written and before the claim is dropped.
      await waitFor(async () => !(await exists(f.pending(msg.id))) && !(await exists(taken)))
      assert.equal(injected, 1)
      assert.equal(await exists(f.processed(msg.id)), true)
      const ack = await readJson<Record<string, unknown>>(f.ack(msg.id))
      assert.equal(ack?.["status"], "accepted")
    } finally {
      await stopAndRemove(f.home, later)
    }
  })
})
