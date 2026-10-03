/**
 * Resolved configuration + on-disk layout.
 *
 * Everything the mesh needs lives under one home directory. The layout is
 * ownership-partitioned: each agent writes exactly one record file (its own)
 * and reads everyone else's, so peer discovery needs no locking at all.
 *
 *   <home>/agents/<id>.json       record, written only by <id>
 *   <home>/activity/<id>          last session turn, touched only by <id>
 *   <home>/inbox/<id>/<msg>.json  messages for <id>, written by peers
 *   <home>/acks/<msg>.json        delivery ack, written by the recipient
 *   <home>/processed/<msg>.json   local recipient marker after successful injection
 */

import os from "node:os"
import path from "node:path"

import { ErrorCode, MeshError } from "./types.ts"

export const PACKAGE_NAME = "opencode-agentpost"
export const TOOL_PREFIX = "agentpost"

export const TOOL_REGISTER = `${TOOL_PREFIX}_register`
export const TOOL_PEERS = `${TOOL_PREFIX}_peers`
export const TOOL_SEND = `${TOOL_PREFIX}_send`
export const TOOL_DELIVERIES = `${TOOL_PREFIX}_deliveries`
export const TOOL_FETCH = `${TOOL_PREFIX}_fetch`

/** Options accepted via `"plugin": [["@vdrsl/opencode-agentpost", { ... }]]`. */
export type MeshOptions = {
  /** Fixed agent id for this project. Default: derived from the worktree name. */
  id?: string
  /** Host identity stored in new agent records. Default: `os.hostname()`. */
  hostId?: string
  /** Mesh home directory. Default: `$XDG_DATA_HOME/opencode-agentpost`. */
  home?: string
  /** Register automatically on the first user message. Default: true. */
  autoRegister?: boolean
  /**
   * Default description for auto-registration, so the role is a property of the
   * project rather than something every session invents. An explicit
   * `agentpost_register` still wins: this only fills in the case where the
   * agent says nothing, so there is no conflict to resolve between them.
   */
  description?: string
  /** Default metadata for auto-registration. Same precedence as `description`. */
  metadata?: Record<string, string>
  /** Append the mesh protocol to the system prompt. Default: true. */
  injectSystemPrompt?: boolean
  /** OpenCode 2 delivery mode. Default: `steer`. Ignored by v1. */
  v2Delivery?: "steer" | "queue"
  heartbeatIntervalMs?: number
  staleAfterMs?: number
  /** How long a presence record with no heartbeat is reaped. */
  presenceReapMs?: number
  /** How long an undelivered message is kept before it is dropped. */
  messageRetentionMs?: number
  /** How long `agentpost_send` waits for the peer to confirm injection. */
  ackWaitMs?: number
  ackRetentionMs?: number
  /** How long an empty inbox of a gone agent is kept before deletion. */
  queueRetentionMs?: number
  /** How long a processed marker suppresses replay before it is reaped. */
  processedRetentionMs?: number
  /** How long a busy session is deferred before another attempt. */
  busyDeferMs?: number
  /** Maximum busy defers before a message becomes ambiguous. */
  maxBusyDefers?: number
  /** How long a single OpenCode prompt request may run before becoming ambiguous. */
  promptTimeoutMs?: number
  /** Inbox poll interval; a fallback for missed fs.watch events. */
  pollIntervalMs?: number
  /** Maximum message body length, in characters. */
  maxTextLength?: number
  /** How long a claimed message lease remains valid. */
  leaseDurationMs?: number
  /** Maximum number of injection attempts before dead-lettering. */
  maxDeliveryAttempts?: number
  /** Maximum number of pending .json messages in one inbox. */
  maxInboxMessages?: number
  /** Maximum serialized bytes in one pending message. */
  maxMessageBytes?: number
  /** Maximum serialized bytes across pending messages in one inbox. */
  maxInboxBytes?: number
  /** Maximum reply-chain depth. */
  maxReplyDepth?: number
  /** How many messages one agentpost_fetch call takes before reporting hasMore. */
  fetchLimit?: number
  /** How long a notified batch waits for agentpost_fetch before body-injecting. */
  fetchFallbackMs?: number
}

export type MeshConfig = {
  home: string
  agentsDir: string
  activityDir: string
  inboxDir: string
  acksDir: string
  processedDir: string
  deadDir: string
  quarantineDir: string
  outboxDir: string
  id?: string
  hostId: string
  autoRegister: boolean
  /** Undefined means "generate one per session". */
  description?: string
  /** Undefined means no defaults, so peers see an empty map. */
  metadata?: Record<string, string>
  injectSystemPrompt: boolean
  /**
   * How OpenCode 2 is asked to deliver a message. `steer` reaches a session that is
   * mid-turn; `queue` holds the message until the session goes idle — and on v2 that
   * hold needs a human to release it from the TUI, so `queue` is a message parked
   * in a menu, not a delivery. V1 has no equivalent choice and ignores this.
   */
  v2Delivery: "steer" | "queue"
  heartbeatIntervalMs: number
  staleAfterMs: number
  presenceReapMs: number
  messageRetentionMs: number
  ackWaitMs: number
  ackRetentionMs: number
  queueRetentionMs: number
  processedRetentionMs: number
  busyDeferMs: number
  maxBusyDefers: number
  promptTimeoutMs: number
  pollIntervalMs: number
  maxTextLength: number
  leaseDurationMs: number
  maxDeliveryAttempts: number
  maxInboxMessages: number
  maxMessageBytes: number
  maxInboxBytes: number
  maxReplyDepth: number
  fetchLimit: number
  fetchFallbackMs: number
}

const DEFAULTS = {
  autoRegister: true,
  injectSystemPrompt: true,
  v2Delivery: "steer",
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 60_000,
  presenceReapMs: 300_000,
  messageRetentionMs: 86_400_000,
  ackWaitMs: 3_000,
  ackRetentionMs: 300_000,
  queueRetentionMs: 300_000,
  processedRetentionMs: 86_400_000,
  busyDeferMs: 2_000,
  maxBusyDefers: 12,
  promptTimeoutMs: 30_000,
  pollIntervalMs: 2_000,
  maxTextLength: 8_000,
  leaseDurationMs: 60_000,
  maxDeliveryAttempts: 3,
  maxInboxMessages: 256,
  maxMessageBytes: 32_768,
  maxInboxBytes: 8_388_608,
  maxReplyDepth: 8,
  fetchLimit: 20,
  fetchFallbackMs: 30_000,
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

/** Env (`AGENTPOST_*`) wins over plugin options, which win over defaults. */
export function resolveConfig(options: MeshOptions = {}): MeshConfig {
  const home = path.resolve(
    pick(envString("AGENTPOST_HOME"), options.home, defaultHome()) as string,
  )
  const config: MeshConfig = {
    home,
    agentsDir: path.join(home, "agents"),
    activityDir: path.join(home, "activity"),
    inboxDir: path.join(home, "inbox"),
    acksDir: path.join(home, "acks"),
    processedDir: path.join(home, "processed"),
    deadDir: path.join(home, "dead"),
    quarantineDir: path.join(home, "quarantine"),
    outboxDir: path.join(home, "outbox"),
    id: pick(envString("AGENTPOST_ID"), options.id),
    hostId: pick(envString("AGENTPOST_HOST_ID"), options.hostId, os.hostname()) as string,
    autoRegister: pick(
      envBool("AGENTPOST_AUTO_REGISTER"),
      options.autoRegister,
      DEFAULTS.autoRegister,
    ) as boolean,
    // No env form: a description is prose, and a whole role sentence in an env
    // var is worse to maintain than in the project's plugin config.
    description: options.description,
    metadata: options.metadata,
    injectSystemPrompt: pick(
      envBool("AGENTPOST_INJECT_SYSTEM_PROMPT"),
      options.injectSystemPrompt,
      DEFAULTS.injectSystemPrompt,
    ) as boolean,
    v2Delivery: (envString("AGENTPOST_V2_DELIVERY") ?? options.v2Delivery ?? DEFAULTS.v2Delivery) as
      | "steer"
      | "queue",
    heartbeatIntervalMs: pick(
      envNumber("AGENTPOST_HEARTBEAT_INTERVAL_MS"),
      options.heartbeatIntervalMs,
      DEFAULTS.heartbeatIntervalMs,
    ) as number,
    staleAfterMs: pick(
      envNumber("AGENTPOST_STALE_AFTER_MS"),
      options.staleAfterMs,
      DEFAULTS.staleAfterMs,
    ) as number,
    presenceReapMs: pick(
      envNumber("AGENTPOST_PRESENCE_REAP_MS"),
      options.presenceReapMs,
      DEFAULTS.presenceReapMs,
    ) as number,
    messageRetentionMs: pick(
      envNumber("AGENTPOST_MESSAGE_RETENTION_MS"),
      options.messageRetentionMs,
      DEFAULTS.messageRetentionMs,
    ) as number,
    ackWaitMs: pick(
      envNumber("AGENTPOST_ACK_WAIT_MS"),
      options.ackWaitMs,
      DEFAULTS.ackWaitMs,
    ) as number,
    ackRetentionMs: pick(
      envNumber("AGENTPOST_ACK_RETENTION_MS"),
      options.ackRetentionMs,
      DEFAULTS.ackRetentionMs,
    ) as number,
    queueRetentionMs: pick(
      envNumber("AGENTPOST_QUEUE_RETENTION_MS"),
      options.queueRetentionMs,
      DEFAULTS.queueRetentionMs,
    ) as number,
    processedRetentionMs: pick(
      envNumber("AGENTPOST_PROCESSED_RETENTION_MS"),
      options.processedRetentionMs,
      DEFAULTS.processedRetentionMs,
    ) as number,
    busyDeferMs: pick(
      envNumber("AGENTPOST_BUSY_DEFER_MS"),
      options.busyDeferMs,
      DEFAULTS.busyDeferMs,
    ) as number,
    maxBusyDefers: pick(
      envNumber("AGENTPOST_MAX_BUSY_DEFERS"),
      options.maxBusyDefers,
      DEFAULTS.maxBusyDefers,
    ) as number,
    promptTimeoutMs: pick(
      envNumber("AGENTPOST_PROMPT_TIMEOUT_MS"),
      options.promptTimeoutMs,
      DEFAULTS.promptTimeoutMs,
    ) as number,
    pollIntervalMs: pick(
      envNumber("AGENTPOST_POLL_INTERVAL_MS"),
      options.pollIntervalMs,
      DEFAULTS.pollIntervalMs,
    ) as number,
    maxTextLength: pick(
      envNumber("AGENTPOST_MAX_TEXT_LENGTH"),
      options.maxTextLength,
      DEFAULTS.maxTextLength,
    ) as number,
    leaseDurationMs: pick(
      envNumber("AGENTPOST_LEASE_DURATION_MS"),
      options.leaseDurationMs,
      DEFAULTS.leaseDurationMs,
    ) as number,
    maxDeliveryAttempts: pick(
      envNumber("AGENTPOST_MAX_DELIVERY_ATTEMPTS"),
      options.maxDeliveryAttempts,
      DEFAULTS.maxDeliveryAttempts,
    ) as number,
    maxInboxMessages: pick(
      envNumber("AGENTPOST_MAX_INBOX_MESSAGES"),
      options.maxInboxMessages,
      DEFAULTS.maxInboxMessages,
    ) as number,
    maxMessageBytes: pick(
      envNumber("AGENTPOST_MAX_MESSAGE_BYTES"),
      options.maxMessageBytes,
      DEFAULTS.maxMessageBytes,
    ) as number,
    maxInboxBytes: pick(
      envNumber("AGENTPOST_MAX_INBOX_BYTES"),
      options.maxInboxBytes,
      DEFAULTS.maxInboxBytes,
    ) as number,
    maxReplyDepth: pick(
      envNumber("AGENTPOST_MAX_REPLY_DEPTH"),
      options.maxReplyDepth,
      DEFAULTS.maxReplyDepth,
    ) as number,
    fetchLimit: pick(
      envNumber("AGENTPOST_FETCH_LIMIT"),
      options.fetchLimit,
      DEFAULTS.fetchLimit,
    ) as number,
    fetchFallbackMs: pick(
      envNumber("AGENTPOST_FETCH_FALLBACK_MS"),
      options.fetchFallbackMs,
      DEFAULTS.fetchFallbackMs,
    ) as number,
  }
  if (!Number.isFinite(config.heartbeatIntervalMs) || config.heartbeatIntervalMs <= 0) {
    throw new Error("AgentPost config: heartbeatIntervalMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.staleAfterMs) || config.staleAfterMs <= 0) {
    throw new Error("AgentPost config: staleAfterMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.presenceReapMs) || config.presenceReapMs <= 0) {
    throw new Error("AgentPost config: presenceReapMs must be a finite number greater than zero")
  }
  if (config.presenceReapMs > 86_400_000) {
    throw new Error("AgentPost config: presenceReapMs must be at most 86400000ms")
  }
  if (!Number.isFinite(config.messageRetentionMs) || config.messageRetentionMs <= 0) {
    throw new Error(
      "AgentPost config: messageRetentionMs must be a finite number greater than zero",
    )
  }
  if (config.messageRetentionMs > 604_800_000) {
    throw new Error("AgentPost config: messageRetentionMs must be at most 604800000ms")
  }
  if (
    config.heartbeatIntervalMs >= config.staleAfterMs ||
    config.staleAfterMs >= config.presenceReapMs
  ) {
    throw new Error("AgentPost config: heartbeatIntervalMs < staleAfterMs < presenceReapMs is required")
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new Error("AgentPost config: pollIntervalMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.ackWaitMs) || config.ackWaitMs <= 0) {
    throw new Error("AgentPost config: ackWaitMs must be a finite number greater than zero")
  }
  if (!Number.isFinite(config.ackRetentionMs) || config.ackRetentionMs <= 0) {
    throw new Error("AgentPost config: ackRetentionMs must be a finite number greater than zero")
  }
  if (config.ackRetentionMs > 86_400_000) {
    throw new Error("AgentPost config: ackRetentionMs must be at most 86400000ms")
  }
  if (!Number.isFinite(config.queueRetentionMs) || config.queueRetentionMs <= 0) {
    throw new Error(
      "AgentPost config: queueRetentionMs must be a finite number greater than zero",
    )
  }
  if (config.queueRetentionMs > 86_400_000) {
    throw new Error("AgentPost config: queueRetentionMs must be at most 86400000ms")
  }
  if (!Number.isFinite(config.processedRetentionMs) || config.processedRetentionMs <= 0) {
    throw new Error(
      "AgentPost config: processedRetentionMs must be a finite number greater than zero",
    )
  }
  if (config.processedRetentionMs > 604_800_000) {
    throw new Error("AgentPost config: processedRetentionMs must be at most 604800000ms")
  }
  if (!Number.isFinite(config.busyDeferMs) || config.busyDeferMs <= 0) {
    throw new Error("AgentPost config: busyDeferMs must be a finite number greater than zero")
  }
  if (config.busyDeferMs > 60_000) {
    throw new Error("AgentPost config: busyDeferMs must be at most 60000ms")
  }
  if (
    !Number.isFinite(config.maxBusyDefers) ||
    !Number.isInteger(config.maxBusyDefers) ||
    config.maxBusyDefers < 1 ||
    config.maxBusyDefers > 100
  ) {
    throw new Error("AgentPost config: maxBusyDefers must be an integer from 1 to 100")
  }
  if (!Number.isFinite(config.promptTimeoutMs) || config.promptTimeoutMs <= 0) {
    throw new Error("AgentPost config: promptTimeoutMs must be a finite number greater than zero")
  }
  if (config.promptTimeoutMs > 120_000) {
    throw new Error("AgentPost config: promptTimeoutMs must be at most 120000ms")
  }
  if (!Number.isFinite(config.maxTextLength) || config.maxTextLength <= 0) {
    throw new Error("AgentPost config: maxTextLength must be a finite number greater than zero")
  }
  if (config.heartbeatIntervalMs > 60_000) {
    throw new Error("AgentPost config: heartbeatIntervalMs must be at most 60000ms")
  }
  if (config.staleAfterMs > 600_000) {
    throw new Error("AgentPost config: staleAfterMs must be at most 600000ms")
  }
  if (config.maxTextLength > 100_000) {
    throw new Error("AgentPost config: maxTextLength must be at most 100000")
  }
  if (!Number.isFinite(config.leaseDurationMs) || config.leaseDurationMs <= 0) {
    throw new Error("AgentPost config: leaseDurationMs must be a finite number greater than zero")
  }
  if (config.leaseDurationMs > 600_000) {
    throw new Error("AgentPost config: leaseDurationMs must be at most 600000ms")
  }
  if (
    !Number.isFinite(config.maxDeliveryAttempts) ||
    !Number.isInteger(config.maxDeliveryAttempts) ||
    config.maxDeliveryAttempts < 1 ||
    config.maxDeliveryAttempts > 10
  ) {
    throw new Error("AgentPost config: maxDeliveryAttempts must be an integer from 1 to 10")
  }
  if (
    !Number.isFinite(config.maxInboxMessages) ||
    !Number.isInteger(config.maxInboxMessages) ||
    config.maxInboxMessages < 1 ||
    config.maxInboxMessages > 10_000
  ) {
    throw new Error("AgentPost config: maxInboxMessages must be an integer from 1 to 10000")
  }
  if (!Number.isFinite(config.maxMessageBytes) || config.maxMessageBytes <= 0 || config.maxMessageBytes > 1_048_576) {
    throw new Error("AgentPost config: maxMessageBytes must be from 1 to 1048576")
  }
  if (!Number.isFinite(config.maxInboxBytes) || config.maxInboxBytes <= 0 || config.maxInboxBytes > 104_857_600) {
    throw new Error("AgentPost config: maxInboxBytes must be from 1 to 104857600")
  }
  if (config.maxMessageBytes > config.maxInboxBytes) {
    throw new Error("AgentPost config: maxMessageBytes must not exceed maxInboxBytes")
  }
  if (
    !Number.isFinite(config.maxReplyDepth) ||
    !Number.isInteger(config.maxReplyDepth) ||
    config.maxReplyDepth < 1 ||
    config.maxReplyDepth > 32
  ) {
    throw new Error("AgentPost config: maxReplyDepth must be an integer from 1 to 32")
  }
  if (!Number.isInteger(config.fetchLimit) || config.fetchLimit < 1 || config.fetchLimit > 200) {
    throw new Error("AgentPost config: fetchLimit must be an integer from 1 to 200")
  }
  if (
    !Number.isFinite(config.fetchFallbackMs) ||
    config.fetchFallbackMs <= 0 ||
    config.fetchFallbackMs > 600_000
  ) {
    throw new Error(
      "AgentPost config: fetchFallbackMs must be a finite number greater than zero and at most 600000ms",
    )
  }
  return config
}

/** Agent ids are lowercase slugs so they are safe as file names. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/
const WINDOWS_RESERVED_IDS = new Set([
  "con",
  "nul",
  "prn",
  "aux",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

export function assertValidId(id: string): void {
  if (!ID_PATTERN.test(id) || WINDOWS_RESERVED_IDS.has(id.toLowerCase())) {
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
