/**
 * The three tools the model sees.
 *
 * Session identity is never asked of the model: `sessionID`, `directory` and
 * `worktree` come from the tool context, and `serverUrl` from the plugin
 * input. That is the whole reason this is a plugin and not an MCP server.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND } from "./config.ts"
import {
  DELIVERIES_DESCRIPTION,
  FETCH_DESCRIPTION,
  PEERS_DESCRIPTION,
  REGISTER_DESCRIPTION,
  SEND_DESCRIPTION,
} from "./descriptions.ts"
import type { Mesh, SessionContext } from "./mesh.ts"

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
