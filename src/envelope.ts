/**
 * Rendering of the text that gets injected into the recipient's session.
 *
 *   [agentpost] from: planner | 2026-08-27T09:12:03Z | msg: agm_01J… | re: T-001
 *   <text>
 *   (end of agentpost message; to reply, call agentpost_send with to "planner")
 *
 * The `re:` segment appears only when the sender passed a context tag. The
 * `msg:` id is the correlation key and keeps logs greppable.
 */

import { TOOL_SEND } from "./config.ts"
import type { MeshMessage } from "./types.ts"

export const MAX_CONTEXT_LENGTH = 200

export function sanitizeHeaderField(value: string, maxLen: number): string {
  return value
    .replace(/[\r\n\0]/g, "")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .slice(0, maxLen)
}

export function renderEnvelope(message: MeshMessage): string {
  const from = sanitizeHeaderField(message.from, 64)
  const timestamp = message.sentAt.replace(/\.\d+Z$/, "Z")
  let header = `[agentpost] from: ${from} | ${timestamp} | msg: ${message.id}`
  if (message.context) {
    header += ` | re: ${sanitizeHeaderField(message.context, MAX_CONTEXT_LENGTH)}`
  }
  // The root of a thread carries threadId === id, which says nothing the msg id
  // does not, so it is only shown on replies.
  if (message.threadId && message.threadId !== message.id) header += ` | thread: ${message.threadId}`
  if (message.in_reply_to) header += ` | in-reply-to: ${message.in_reply_to}`
  const footer = `to reply, call ${TOOL_SEND} with to "${from}"`
  return `${header}\n${message.text}\n(end of agentpost message; ${footer})`
}

/** Best-effort inverse of {@link renderEnvelope}, for tests and tooling. */
export function parseEnvelope(envelope: string): Record<string, string> {
  const lines = envelope.split("\n")
  const first = lines[0]
  if (!first || !first.startsWith("[agentpost] ")) return {}
  const out: Record<string, string> = {}
  for (const segment of first.slice("[agentpost]".length).trim().split(" | ")) {
    const index = segment.indexOf(":")
    if (index === -1) continue
    out[segment.slice(0, index).trim()] = segment.slice(index + 1).trim()
  }
  const endIndex = lines.findIndex(
    (line, i) => i > 0 && line.startsWith("(end of agentpost message"),
  )
  out["text"] = lines.slice(1, endIndex === -1 ? undefined : endIndex).join("\n")
  return out
}
