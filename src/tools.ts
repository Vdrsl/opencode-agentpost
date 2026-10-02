/**
 * The three tools the model sees.
 *
 * Session identity is never asked of the model: `sessionID`, `directory` and
 * `worktree` come from the tool context, and `serverUrl` from the plugin
 * input. That is the whole reason this is a plugin and not an MCP server.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND } from "./config.ts"
import type { Mesh, SessionContext } from "./mesh.ts"

const REGISTER_DESCRIPTION = `Publish this agent on the mesh so other opencode agents can discover and message it. Call it once near the start of a session, and again whenever your role or scope changes.

Arguments:
- id: stable short slug peers address you by. Example: "api-gateway".
- description: one line covering what you do and which repo/area you own. Example: "Owns the REST API in /repo/api; handles auth and rate limiting."
- metadata: free-form string map shown to peers. Example: {"repo": "/repo/api", "stack": "node+express", "role": "backend", "focus": "auth module"}.

Returns your own entry plus everyone else currently on the mesh.`

const PEERS_DESCRIPTION = `List the agents on the mesh with live state: id, description, metadata, status (alive/stale), lastSeen, idleMs, directory, sessionID.
Use it to (1) get a valid "to" before ${TOOL_SEND}, (2) check whether a peer is still alive before or after sending, and (3) read peer metadata — project path, stack, role — to decide who a piece of work belongs to.
A stale peer is not gone: messages queue and are accepted when it returns.
idleMs is ms since that peer's last session turn: prefer the smallest value that fits the task, and treat an hours-old one as an unattended chat. Peers are returned least-idle first, alive before stale. lastSeen is a heartbeat and reads the same for every live peer, so it does not order the list.
sessionID is the opencode chat behind the record: several ids in one directory are several chats, and a closed chat stays alive until its record is reaped but never answers. If a peer accepts a message and stays silent, move on to another peer instead of resending.
A peer nobody introduced — description exactly "opencode agent working in <directory>" and empty metadata — is a background process that registered itself, not a colleague. Do not delegate to it; choose a peer that described itself.`

const SEND_DESCRIPTION = `Send one message to another registered agent. It is injected into that agent's opencode session as a new user turn.
This returns a delivery status, NOT the peer's answer: "accepted" (OpenCode returned 204 and accepted the message into the peer's session), "queued" (waiting for them to come back), "failed" (it could not be injected), "ambiguous" (the delivery outcome is unknown). Accepted does not mean the peer read the message or that the model answered.
The peer sees NO context from your session — write self-contained: what you need, why, and every referenced fact (absolute paths, agreed contract). To get an answer, ask for one explicitly; it arrives later as a new turn, so keep working instead of waiting.
A peer whose session is busy reports "queued": the message stays in its inbox and is injected as soon as that session goes idle. That is normal — do not resend it.
"queued" means the agent is registered and the message has a reader: it arrives when that session goes idle, or when the agent comes back. A peer whose window was closed reports no address at all, because there is nobody to deliver to — ${TOOL_SEND} fails with E_NO_AGENT. Read the registered ids from ${TOOL_PEERS} and send to one of those instead. Do not retry the same id: a closed chat gets a new one when it is reopened.
"stale" means not heartbeating right now, not gone, and a stale peer still receives.
Use context as a short topic tag (e.g. "T-001 contract"). If no reply comes within a few minutes, check ${TOOL_PEERS} before re-sending.`

const DELIVERIES_DESCRIPTION = `Check what became of the messages you sent: id, recipient, delivery state, timestamp. Newest first.
States: "queued" (in the recipient's inbox, no confirmation yet), "accepted" (it became a user turn in their session), "failed" (they got it but could not inject it), "ambiguous" (outcome unknown), "undeliverable" (nobody confirmed before it aged out).
Use it when a peer went quiet and you need to know whether the message landed, before resending anything. Do not poll it in a loop.`

const FETCH_DESCRIPTION = `Read the messages waiting in your inbox and take them out of it. Call this when you get a notice saying "N new messages in your inbox" — that notice is a wake-up, not the mail itself.
A single message never arrives as a notice; it arrives as a full turn, so there is nothing to fetch in that case.
Returns the oldest messages first, and "hasMore": true when more are still queued — call again if so.
This is not a polling tool: the transport tells you when there is mail, and polling does not make anything arrive sooner. Taking a message out of the inbox means you own it; if you fetch and then do not act on what you read, it is not delivered again. Returns an empty list when there is nothing waiting.`

export function buildTools(
  mesh: Mesh,
  serverUrl: string,
): Record<string, ToolDefinition> {
  const contextOf = (ctx: {
    sessionID: string
    directory: string
    worktree: string
  }): SessionContext => ({
    sessionID: ctx.sessionID,
    directory: ctx.directory,
    worktree: ctx.worktree || ctx.directory,
    serverUrl,
  })

  return {
    [TOOL_REGISTER]: tool({
      description: REGISTER_DESCRIPTION,
      args: {
        id: tool.schema
          .string()
          .min(2)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/)
          .describe(
            "Stable lowercase slug peers address you by, e.g. 'api-gateway'. " +
              "2-64 chars of [a-z0-9_-], must start with [a-z0-9].",
          ),
        description: tool.schema
          .string()
          .describe("One line: what you do and which repo/area you own."),
        metadata: tool.schema
          .record(tool.schema.string(), tool.schema.string())
          .optional()
          .describe("Durable facts peers should know: project path, stack, role, focus."),

      },
      async execute(args, ctx) {
        const result = await mesh.register({
          context: contextOf(ctx),
          id: args.id,
          description: args.description,
          metadata: args.metadata ?? {},
          force: false,
        })
        return {
          title: `registered as ${result.self.id}`,
          output: JSON.stringify({ self: result.self, peers: result.peers }, null, 2),
          metadata: { id: result.self.id, peers: result.peers.length },
        }
      },
    }),

    [TOOL_PEERS]: tool({
      description: PEERS_DESCRIPTION,
      args: {
        include_stale: tool.schema
          .boolean()
          .optional()
          .describe("Include agents that stopped heartbeating. Default true."),
      },
      async execute(args, ctx) {
        const peers = await mesh.peers({
          sessionID: ctx.sessionID,
          includeStale: args.include_stale ?? true,
        })
        const alive = peers.filter((peer) => peer.status === "alive").length
        return {
          title: `${peers.length} agent${peers.length === 1 ? "" : "s"} (${alive} alive)`,
          output: JSON.stringify({ agents: peers }, null, 2),
          metadata: { count: peers.length, alive },
        }
      },
    }),

    [TOOL_SEND]: tool({
      description: SEND_DESCRIPTION,
      args: {
        to: tool.schema
          .string()
          .min(2)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/)
          .describe(`Agent id from ${TOOL_PEERS}. 2-64 chars of [a-z0-9_-].`),
        text: tool.schema
          .string()
          .describe("Self-contained message. Include every fact the peer needs."),
        context: tool.schema
          .string()
          .optional()
          .describe("Short topic tag shown in the envelope header, e.g. 'T-001 contract'."),
        reply_to: tool.schema
          .string()
          .optional()
          .describe("Legacy alias for in_reply_to."),
        in_reply_to: tool.schema
          .string()
          .optional()
          .describe("Message id from the incoming envelope when this is a reply."),
      },
      async execute(args, ctx) {
        const inReplyTo = args.in_reply_to ?? args.reply_to
        const result = await mesh.send({
          context: contextOf(ctx),
          to: args.to,
          text: args.text,
          ...(args.context ? { context_tag: args.context } : {}),
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        })
        return {
          title: `${result.status} -> ${result.to}`,
          output: JSON.stringify(result, null, 2),
          metadata: { status: result.status, to: result.to, messageId: result.messageId },
        }
      },
    }),

    [TOOL_DELIVERIES]: tool({
      description: DELIVERIES_DESCRIPTION,
      args: {
        to: tool.schema
          .string()
          .optional()
          .describe("Filter by recipient agent id."),
        state: tool.schema
          .enum(["queued", "accepted", "failed", "ambiguous", "undeliverable"])
          .optional()
          .describe("Filter by delivery state."),
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many records to return, newest first. Default 20, max 100."),
      },
      async execute(args, ctx) {
        if (!mesh.selfId(ctx.sessionID)) {
          return {
            title: "not registered",
            output: `This session is not on the mesh yet, so it has no deliveries: call ${TOOL_REGISTER} first.`,
            metadata: { count: 0 },
          }
        }
        const deliveries = await mesh.deliveries({
          sessionID: ctx.sessionID,
          ...(args.to ? { to: args.to } : {}),
          ...(args.state ? { state: args.state } : {}),
          limit: Math.min(args.limit ?? 20, 100),
        })
        return {
          title: `${deliveries.length} delivery record${deliveries.length === 1 ? "" : "s"}`,
          output: JSON.stringify({ deliveries }, null, 2),
          metadata: { count: deliveries.length },
        }
      },
    }),

    [TOOL_FETCH]: tool({
      description: FETCH_DESCRIPTION,
      args: {
        limit: tool.schema
          .number()
          .int()
          .min(1)
          .optional()
          .describe("How many messages to take, oldest first. Default and ceiling: fetchLimit."),
      },
      async execute(args, ctx) {
        if (!mesh.selfId(ctx.sessionID)) {
          return {
            title: "not registered",
            output: `This session is not on the mesh yet: call ${TOOL_REGISTER} first.`,
            metadata: { count: 0 },
          }
        }
        const { messages, hasMore } = await mesh.fetch({
          sessionID: ctx.sessionID,
          ...(args.limit ? { limit: Math.min(args.limit, mesh.fetchLimit) } : {}),
        })
        return {
          title: `${messages.length} message${messages.length === 1 ? "" : "s"}` +
            (hasMore ? ", more pending" : ""),
          output: JSON.stringify({ messages, hasMore }, null, 2),
          metadata: { count: messages.length, hasMore },
        }
      },
    }),
  }
}
