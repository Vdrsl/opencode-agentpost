/**
 * Resolved configuration + on-disk layout.
 *
 * Everything the mesh needs lives under one home directory. The layout is
 * ownership-partitioned: each agent writes exactly one record file (its own)
 * and reads everyone else's, so peer discovery needs no locking at all.
 *
 *   <home>/agents/<id>.json       record, written only by <id>
 *   <home>/inbox/<id>/<msg>.json  messages for <id>, written by peers
 *   <home>/acks/<msg>.json        delivery ack, written by the recipient
 */

import os from "node:os"
import path from "node:path"

import { ErrorCode, MeshError } from "./types.ts"

export const PACKAGE_NAME = "opencode-agentmesh"
export const TOOL_PREFIX = "agentmesh"

export const TOOL_REGISTER = `${TOOL_PREFIX}_register`
export const TOOL_PEERS = `${TOOL_PREFIX}_peers`
export const TOOL_SEND = `${TOOL_PREFIX}_send`

/** Options accepted via `"plugin": [["opencode-agentmesh", { ... }]]`. */
export type MeshOptions = {
  /** Fixed agent id for this project. Default: derived from the worktree name. */
  id?: string
  /** Host identity stored in new agent records. Default: `os.hostname()`. */
  hostId?: string
  /** Mesh home directory. Default: `$XDG_DATA_HOME/opencode-agentmesh`. */
  home?: string
  /** Register automatically on the first user message. Default: true. */
  autoRegister?: boolean
  /** Append the mesh protocol to the system prompt. Default: true. */
  injectSystemPrompt?: boolean
  heartbeatIntervalMs?: number
  staleAfterMs?: number
  expireAfterMs?: number
  /** How long `agentmesh_send` waits for the peer to confirm injection. */
  ackWaitMs?: number
  /** Inbox poll interval; a fallback for missed fs.watch events. */
  pollIntervalMs?: number
  /** Maximum message body length, in characters. */
  maxTextLength?: number
}

export type MeshConfig = {
  home: string
  agentsDir: string
  inboxDir: string
  acksDir: string
  id?: string
  hostId: string
  autoRegister: boolean
  injectSystemPrompt: boolean
  heartbeatIntervalMs: number
  staleAfterMs: number
  expireAfterMs: number
  ackWaitMs: number
  pollIntervalMs: number
  maxTextLength: number
}

const DEFAULTS = {
  autoRegister: true,
  injectSystemPrompt: true,
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 60_000,
  expireAfterMs: 300_000,
  ackWaitMs: 3_000,
  pollIntervalMs: 2_000,
  maxTextLength: 8_000,
} as const

function defaultHome(): string {
  const xdg = process.env["XDG_DATA_HOME"]
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, PACKAGE_NAME)
}

function envString(name: string): string | undefined {
  const raw = process.env[name]
  return raw && raw.trim() ? raw.trim() : undefined
}

function envBool(name: string): boolean | undefined {
  const raw = envString(name)?.toLowerCase()
  if (raw === undefined) return undefined
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

function envNumber(name: string): number | undefined {
  const raw = envString(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function pick<T>(...candidates: (T | undefined)[]): T | undefined {
  for (const candidate of candidates) if (candidate !== undefined) return candidate
  return undefined
}

/** Env (`AGENTMESH_*`) wins over plugin options, which win over defaults. */
export function resolveConfig(options: MeshOptions = {}): MeshConfig {
  const home = path.resolve(
    pick(envString("AGENTMESH_HOME"), options.home, defaultHome()) as string,
  )
  const config: MeshConfig = {
    home,
    agentsDir: path.join(home, "agents"),
    inboxDir: path.join(home, "inbox"),
    acksDir: path.join(home, "acks"),
    id: pick(envString("AGENTMESH_ID"), options.id),
    hostId: pick(envString("AGENTMESH_HOST_ID"), options.hostId, os.hostname()) as string,
    autoRegister: pick(
      envBool("AGENTMESH_AUTO_REGISTER"),
      options.autoRegister,
      DEFAULTS.autoRegister,
    ) as boolean,
    injectSystemPrompt: pick(
      envBool("AGENTMESH_INJECT_SYSTEM_PROMPT"),
      options.injectSystemPrompt,
      DEFAULTS.injectSystemPrompt,
    ) as boolean,
    heartbeatIntervalMs: pick(
      envNumber("AGENTMESH_HEARTBEAT_INTERVAL_MS"),
      options.heartbeatIntervalMs,
      DEFAULTS.heartbeatIntervalMs,
    ) as number,
    staleAfterMs: pick(
      envNumber("AGENTMESH_STALE_AFTER_MS"),
      options.staleAfterMs,
      DEFAULTS.staleAfterMs,
    ) as number,
    expireAfterMs: pick(
      envNumber("AGENTMESH_EXPIRE_AFTER_MS"),
      options.expireAfterMs,
      DEFAULTS.expireAfterMs,
    ) as number,
    ackWaitMs: pick(
      envNumber("AGENTMESH_ACK_WAIT_MS"),
      options.ackWaitMs,
      DEFAULTS.ackWaitMs,
    ) as number,
    pollIntervalMs: pick(
      envNumber("AGENTMESH_POLL_INTERVAL_MS"),
      options.pollIntervalMs,
      DEFAULTS.pollIntervalMs,
    ) as number,
    maxTextLength: pick(
      envNumber("AGENTMESH_MAX_TEXT_LENGTH"),
      options.maxTextLength,
      DEFAULTS.maxTextLength,
    ) as number,
  }
  if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) {
    throw new Error("AgentMesh config: heartbeatIntervalMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.staleAfterMs) || config.staleAfterMs <= 0) {
    throw new Error("AgentMesh config: staleAfterMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.expireAfterMs) || config.expireAfterMs <= 0) {
    throw new Error("AgentMesh config: expireAfterMs must be a finite number greater than zero")
  }
  if (
    config.heartbeatIntervalMs >= config.staleAfterMs ||
    config.staleAfterMs >= config.expireAfterMs
  ) {
    throw new Error("AgentMesh config: heartbeatIntervalMs < staleAfterMs < expireAfterMs is required")
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new Error("AgentMesh config: pollIntervalMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.ackWaitMs) || config.ackWaitMs <= 0) {
    throw new Error("AgentMesh config: ackWaitMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.maxTextLength) || config.maxTextLength <= 0) {
    throw new Error("AgentMesh config: maxTextLength must be a finite number greater than zero")
  }
  if (config.heartbeatIntervalMs > 60_000) {
    throw new Error("AgentMesh config: heartbeatIntervalMs must be at most 60000ms")
  }
  if (config.staleAfterMs > 600_000) {
    throw new Error("AgentMesh config: staleAfterMs must be at most 600000ms")
  }
  if (config.expireAfterMs > 3_600_000) {
    throw new Error("AgentMesh config: expireAfterMs must be at most 3600000ms")
  }
  if (config.maxTextLength > 100_000) {
    throw new Error("AgentMesh config: maxTextLength must be at most 100000")
  }
  return config
}

/** Agent ids are lowercase slugs so they are safe as file names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/

export function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new MeshError(
      ErrorCode.INVALID_ID,
      `id ${JSON.stringify(id)} must be 2-64 chars of [a-z0-9_-] and start with [a-z0-9]`,
    )
  }
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
  return slug.length >= 2 ? slug : "agent"
}
