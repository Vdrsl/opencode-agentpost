/** Shared wire/record shapes. Everything here is serialized to disk as JSON. */

/** Where a registered agent's opencode session lives. */
export type AgentRouting = {
  sessionID: string
  directory: string
  worktree: string
  serverUrl: string
}

/** One agent's record: `<home>/agents/<id>.json`, written only by its owner. */
export type OwnerIdentity = {
  ownerInstance: string
  incarnation: string
}

export type ClaimMeta = {
  ownerInstance: string
  incarnation: string
  sessionID: string
  claimedAt: string
  leaseExpiresAt: string
  attempt: number
}

export type AgentRecord = {
  schemaVersion?: 1
  id: string
  description: string
  metadata: Record<string, string>
  routing: AgentRouting
  pid: number
  ownerInstance?: string
  incarnation?: string
  hostId?: string
  registeredAt: string
}

export type AgentStatus = "alive" | "stale"

/** What peers see through `agentmesh_peers` / `agentmesh_register`. */
export type PeerView = {
  id: string
  description: string
  metadata: Record<string, string>
  status: AgentStatus
  lastSeen: string
  directory: string
  self?: true
}

/** One queued message: `<home>/inbox/<to>/<id>.json`, written by the sender. */
export type MeshMessage = {
  schemaVersion?: 1
  id: string
  from: string
  to: string
  text: string
  context?: string
  in_reply_to?: string
  replyDepth?: number
  _retryCount?: number
  sentAt: string
}

/** Written by the recipient once the message is injected into its session. */
export type MeshAck = {
  id: string
  to: string
  sessionID: string
  status: "injected" | "failed"
  detail?: string
  at: string
}

export type SendStatus = "accepted" | "queued" | "failed"

export class MeshError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = "MeshError"
    this.code = code
  }
}

export const ErrorCode = {
  INVALID_ID: "E_INVALID_ID",
  CONFLICT: "E_CONFLICT",
  NOT_REGISTERED: "E_NOT_REGISTERED",
  NO_AGENT: "E_NO_AGENT",
  SELF_SEND: "E_SELF_SEND",
  TEXT_TOO_LONG: "E_TEXT_TOO_LONG",
  INVALID_REPLY: "E_INVALID_REPLY",
  FENCED: "E_FENCED",
  INBOX_FULL: "E_INBOX_FULL",
  MESSAGE_TOO_LARGE: "E_MESSAGE_TOO_LARGE",
  REPLY_DEPTH_EXCEEDED: "E_REPLY_DEPTH_EXCEEDED",
  DEAD_LETTERED: "E_DEAD_LETTERED",
  IO: "E_IO",
} as const
