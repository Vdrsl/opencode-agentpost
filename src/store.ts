/**
 * Filesystem primitives shared by the registry and the inbox.
 *
 * Every write is atomic (temp file in the same directory + `rename`), so a
 * reader never observes a half-written record. Missing files are a normal
 * state here — peers come and go — so reads answer `undefined` rather than
 * throwing.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { ClaimMeta } from "./types.ts"

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST"
}

/** Filesystems that cannot hard link at all: FAT32, some network mounts. */
function unsupportedLink(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP"
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function ensureDir(dir: string): Promise<void> {
  try {
    const existing = await fs.lstat(dir)
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`unsafe directory: ${dir}`)
    }
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const created = await fs.lstat(dir)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`unsafe directory: ${dir}`)
  }
}

async function replaceFile(temp: string, file: string): Promise<void> {
  try {
    await fs.rename(temp, file)
    return
  } catch (error) {
    if (process.platform !== "win32") throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST" && code !== "EPERM") throw error
  }

  const backup = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.bak`
  try {
    await fs.rename(file, backup)
  } catch {
    await fs.rename(temp, file)
    return
  }
  try {
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rename(backup, file).catch(() => {})
    throw error
  }
  await fs.rm(backup, { force: true }).catch(() => {})
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await replaceFile(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch (error) {
    if (isMissing(error)) return undefined
    // A truncated or hand-edited file must not take the mesh down.
    return undefined
  }
}

/** Read a record together with its mtime, which is what liveness is based on. */
export async function readJsonWithMtime<T>(
  file: string,
): Promise<{ value: T; mtimeMs: number } | undefined> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const value = await readJson<T>(file)
  if (value === undefined) return undefined
  return { value, mtimeMs: stat.mtimeMs }
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/** Subdirectory names, sorted. Missing directory reads as empty. */
export async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch(() => {})
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Bump mtime without rewriting the file — this is the heartbeat. */
export async function touch(file: string): Promise<boolean> {
  const now = new Date()
  try {
    await fs.utimes(file, now, now)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Claim a file by hard-linking it to `<file>.taken` and dropping the original
 * name. Exactly one caller can win; everyone else sees EEXIST.
 *
 * This started out as a `rename`, and that was wrong on Windows: two concurrent
 * renames of the same source both resolved successfully there, measured, so two
 * delivery paths could both believe they owned the same message. Hard link
 * creation is exclusive by definition on every platform we support, which is
 * the property the whole at-most-once delivery model rests on.
 *
 * Hard links are unavailable on some filesystems (FAT32, some network mounts),
 * so those failures fall back to `rename`: still correct where rename is atomic,
 * and no worse than what we shipped before.
 */
export async function claimFile(
  file: string,
  suffix: string,
  claim: ClaimMeta,
): Promise<string | undefined> {
  const claimed = `${file}${suffix}`
  try {
    // Only the link error decides whether hard links work here. A later failure
    // in this function must not be mistaken for "no link support", or a
    // transient Windows lock on the rm below would drop us into the rename
    // fallback — the primitive measured non-atomic on this platform.
    await fs.link(file, claimed)
  } catch (error) {
    // EEXIST means someone else holds the claim. That is the normal losing
    // outcome, not a failure: there is exactly one winner by construction.
    if (isMissing(error) || isExists(error)) return undefined
    if (!unsupportedLink(error)) throw error
    try {
      await fs.rename(file, claimed)
    } catch (renameError) {
      if (isMissing(renameError) || isExists(renameError)) return undefined
      throw renameError
    }
    return stampClaim(claimed, claim)
  }
  // The claim is the fact now; the pending name is what everyone else watches.
  // If this rm fails the message is still safe — the winner is us either way —
  // and a crash here leaves two names on one inode, which recovery consolidates.
  await fs.rm(file, { force: true }).catch(() => {})
  await stampClaim(claimed, claim)
  return claimed
}

/** Record the lease on a claimed file. Losing it is recoverable, not fatal. */
async function stampClaim(claimed: string, claim: ClaimMeta): Promise<string> {
  try {
    const raw = await readJson<Record<string, unknown>>(claimed)
    if (raw) {
      raw["_claim"] = claim
      await writeJsonAtomic(claimed, raw)
    }
  } catch {
    // A claimed file without metadata is recovered as an expired lease.
  }
  return claimed
}

/**
 * Age of a record in ms, clamped at zero: filesystem mtimes carry sub-ms
 * precision while `Date.now()` is truncated, so a file written right now can
 * otherwise look a fraction of a millisecond into the future.
 */
export function ageMs(mtimeMs: number, now: number): number {
  return Math.max(0, now - mtimeMs)
}

/** True when a process with this pid exists and we are allowed to signal it. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true // unknown: don't claim it's dead
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
