import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { type MeshConfig, resolveConfig } from "../src/config.ts"
import { Mesh, type SessionContext } from "../src/mesh.ts"
import { noopLogger } from "../src/logger.ts"
import { writeJsonAtomic } from "../src/store.ts"
import type { MeshMessage } from "../src/types.ts"

export async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpost-test-"))
}

export function testConfig(home: string, overrides: Partial<MeshConfig> = {}): MeshConfig {
  return {
    ...resolveConfig({ home }),
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 50,
    ackWaitMs: 2_000,
    ...overrides,
  }
}

export type Injected = { sessionID: string; text: string }

/** A mesh whose "session" is just an array we can assert on. */
export function testMesh(config: MeshConfig): { mesh: Mesh; injected: Injected[] } {
  const injected: Injected[] = []
  const mesh = new Mesh(config, {
    logger: noopLogger,
    async inject({ sessionID, text }) {
      injected.push({ sessionID, text })
    },
  })
  return { mesh, injected }
}

export function sessionContext(sessionID: string, directory: string): SessionContext {
  return { sessionID, directory, worktree: directory, serverUrl: "http://127.0.0.1:4096" }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error("condition not met within timeout")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Message files in an inbox, ignoring directories. An atomic write can leave a
 * `.tmp` scratch file behind on Windows, so assertions about "nothing left"
 * must look at messages, not at the raw directory listing.
 */
export async function messageFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"))
}

/**
 * A live claim on a message: both names present, holding a lease nobody has
 * given up. Staged as one inode behind two names, the state a crash between
 * `fs.link` and the drop leaves behind. Stage it before the watcher exists,
 * because a running one claims the message the moment `enqueue` returns — a test
 * that writes the claim afterwards races the very thing it means to set up, and
 * then passes without touching the branch it was written for.
 *
 * `expireClaim` rewrites the claim atomically and so breaks that link; after it
 * the two names are two files. Recovery reads names, not inodes, so tests are
 * unaffected — but "one inode" is only true before the first `expireClaim`.
 */
export async function stageLiveClaim(
  inboxDir: string,
  message: MeshMessage,
  leaseMs = 60_000,
): Promise<{ pending: string; taken: string }> {
  const pending = path.join(inboxDir, `${message.id}.json`)
  const taken = `${pending}.taken`
  await fs.mkdir(inboxDir, { recursive: true })
  await writeJsonAtomic(taken, {
    ...message,
    _claim: {
      ownerInstance: "other-instance",
      incarnation: "other-incarnation",
      sessionID: "other-session",
      claimedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
      attempt: 1,
    },
  })
  await fs.link(taken, pending)
  return { pending, taken }
}

/** Rewrite a staged claim with a lease that expired `expiredMs` ago. */
export async function expireClaim(taken: string, expiredMs = 1_000): Promise<void> {
  const raw = JSON.parse(await fs.readFile(taken, "utf8"))
  raw._claim.leaseExpiresAt = new Date(Date.now() - expiredMs).toISOString()
  await writeJsonAtomic(taken, raw)
}
