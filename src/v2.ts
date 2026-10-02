/**
 * The OpenCode V2 surface of this plugin.
 *
 * One package serves both runtimes: `src/index.ts` exports the v1 function and
 * this module exports the v2 `{ id, setup }` object, and the package's default
 * export carries both so each opencode calls the one it understands. Nothing in
 * the mesh is duplicated here — `Mesh`, the registry, the watcher and the store
 * know nothing about opencode, so only the wiring lives in this file.
 *
 * Three v2 differences decide the shape of this adapter, and all three come
 * from the same fact: v2 owns the queue.
 *
 * 1. Delivery is one call with `delivery: "queue"`. v1 needed `session.status`
 *    to discover a busy recipient and deferred the message itself with
 *    `maxBusyDefers`; v2 removed that API and made the choice part of the
 *    request. Re-implementing busy detection here would be a second queue built
 *    on top of the first, so this module never looks at busy at all.
 * 2. `session.prompt` throws typed errors instead of returning `{ error }`, so
 *    the v1 `errorTag()` dance has no meaning here.
 * 3. `accepted` therefore means "OpenCode admitted it into that session's
 *    durable queue" — the promise resolved with the admitted inbox item. It
 *    never meant the model read it, and in v2 it does not even mean the session
 *    went idle.
 *
 * The v2 types are declared locally rather than imported. `@opencode/plugin`
 * pulls in Effect and the whole v2 client, which a v1-only user must not have to
 * install for types we erase at runtime; and the surface used here is small
 * enough to state exactly, which is the point — if v2 moves it, the tests in
 * `test/v2.test.ts` fail on the real shape instead of us trusting a stub.
 */

import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND, resolveConfig, type MeshOptions } from "./config.ts"
import {
  DELIVERIES_DESCRIPTION,
  FETCH_DESCRIPTION,
  PEERS_DESCRIPTION,
  REGISTER_DESCRIPTION,
  SEND_DESCRIPTION,
} from "./descriptions.ts"
import { createLogger } from "./logger.ts"
import { Mesh, type SessionContext } from "./mesh.ts"
import type { OutboxState } from "./outbox.ts"
import { systemPrompt } from "./prompt.ts"
import { SessionNotFoundError } from "./types.ts"

export const V2_PLUGIN_ID = "vdrsl.opencode-agentpost"

/** Exactly the v2 surface this adapter uses. Anything added is a decision, not a convenience. */
type V2ToolContext = {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  readonly progress: (update: unknown) => Promise<void>
}

type V2ToolResult = {
  readonly output?: string
  readonly metadata?: Record<string, unknown>
}

type V2JsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

type V2ToolDefinition = {
  name: string
  description: string
  input: V2JsonSchema
  // `any` in exactly one place, on purpose: each tool narrows its own input to
  // the shape it declares, and the alternative is a cast on every one of them.
  execute: (input: any, context: V2ToolContext) => Promise<V2ToolResult>
}

type V2ToolEditor = {
  add(tool: V2ToolDefinition): void
}

type V2PromptEvent = {
  readonly sessionID: string
  readonly messageID: string
}

type V2ContextEvent = {
  readonly sessionID: string
  system: Array<{ type: "text"; text: string }>
}

type V2ServerEvent = {
  readonly type: string
  readonly properties?: Record<string, unknown>
}

type V2Context = {
  readonly location: { readonly directory: string }
  readonly options: Record<string, unknown>
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<unknown>
  }
  readonly session: {
    prompt(input: {
      sessionID: string
      text: string
      delivery: "steer" | "queue"
    }): Promise<unknown>
    hook(name: "prompt", callback: (event: V2PromptEvent) => Promise<void> | void): Promise<unknown>
    hook(name: "context", callback: (event: V2ContextEvent) => void): Promise<unknown>
  }
  readonly event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<V2ServerEvent>
  }
}

const ID_PATTERN = "^[a-z0-9][a-z0-9_-]*$"

const idSchema = {
  type: "string",
  minLength: 2,
  maxLength: 64,
  pattern: ID_PATTERN,
} as const

/**
 * The five tools, calling the same mesh methods as `src/tools.ts` and returning
 * the same payload. `{ output, metadata }` is valid in both runtimes; v2 has no
 * `title`, so the v1 titles are dropped rather than faked.
 */
function buildV2Tools(mesh: Mesh, directory: string): V2ToolDefinition[] {
  const contextOf = (sessionID: string): SessionContext => ({
    sessionID,
    directory,
    worktree: directory,
    // v2 has no server URL: the plugin talks through `ctx`, not through a URL
    // it constructs. The field is informational in the peer record — delivery
    // is the recipient's own watcher reading the shared directory, never a
    // remote call — so an empty value is honest rather than a missing feature.
    serverUrl: "",
  })

  return [
    {
      name: TOOL_REGISTER,
      description: REGISTER_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          id: idSchema,
          description: { type: "string", description: "One line: what you do and which repo/area you own." },
          metadata: {
            type: "object",
            description: "Durable facts peers should know: project path, stack, role, focus.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["id", "description"],
        additionalProperties: false,
      },
      execute: async (
        input: { id: string; description: string; metadata?: Record<string, string> },
        me: V2ToolContext,
      ) => {
        const result = await mesh.register({
          context: contextOf(me.sessionID),
          id: input.id,
          description: input.description,
          metadata: input.metadata ?? {},
          force: false,
        })
        return {
          output: JSON.stringify({ self: result.self, peers: result.peers }, null, 2),
          metadata: { id: result.self.id, peers: result.peers.length },
        }
      },
    },
    {
      name: TOOL_PEERS,
      description: PEERS_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          include_stale: {
            type: "boolean",
            description: "Include agents that stopped heartbeating. Default true.",
          },
        },
        additionalProperties: false,
      },
      execute: (async (
        input: { include_stale?: boolean },
        me: V2ToolContext,
      ) => {
        const peers = await mesh.peers({
          sessionID: me.sessionID,
          includeStale: input.include_stale ?? true,
        })
        const alive = peers.filter((peer) => peer.status === "alive").length
        return {
          output: JSON.stringify({ agents: peers }, null, 2),
          metadata: { count: peers.length, alive },
        }
      }),
    },
    {
      name: TOOL_SEND,
      description: SEND_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          to: idSchema,
          text: { type: "string", description: "Self-contained message. Include every fact the peer needs." },
          context: {
            type: "string",
            description: "Short topic tag shown in the envelope header, e.g. 'T-001 contract'.",
          },
          reply_to: { type: "string", description: "Legacy alias for in_reply_to." },
          in_reply_to: { type: "string", description: "Message id from the incoming envelope when this is a reply." },
        },
        required: ["to", "text"],
        additionalProperties: false,
      },
      execute: (async (
        input: {
          to: string
          text: string
          context?: string
          reply_to?: string
          in_reply_to?: string
        },
        me: V2ToolContext,
      ) => {
        const inReplyTo = input.in_reply_to ?? input.reply_to
        const result = await mesh.send({
          context: contextOf(me.sessionID),
          to: input.to,
          text: input.text,
          ...(input.context ? { context_tag: input.context } : {}),
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        })
        return {
          output: JSON.stringify(result, null, 2),
          metadata: { status: result.status, to: result.to, messageId: result.messageId },
        }
      }),
    },
    {
      name: TOOL_DELIVERIES,
      description: DELIVERIES_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: "Filter by recipient agent id." },
          state: {
            type: "string",
            enum: ["queued", "accepted", "failed", "ambiguous", "undeliverable"],
            description: "Filter by delivery state.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "How many records to return, newest first. Default 20, max 100.",
          },
        },
        additionalProperties: false,
      },
      execute: (async (
        input: { to?: string; state?: string; limit?: number },
        me: V2ToolContext,
      ) => {
        if (!mesh.selfId(me.sessionID)) {
          return {
            output: `This session is not on the mesh yet, so it has no deliveries: call ${TOOL_REGISTER} first.`,
            metadata: { count: 0 },
          }
        }
        const deliveries = await mesh.deliveries({
          sessionID: me.sessionID,
          ...(input.to ? { to: input.to } : {}),
          ...(input.state ? { state: input.state as OutboxState } : {}),
          limit: Math.min(input.limit ?? 20, 100),
        })
        return {
          output: JSON.stringify({ deliveries }, null, 2),
          metadata: { count: deliveries.length },
        }
      }),
    },
    {
      name: TOOL_FETCH,
      description: FETCH_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "How many messages to take, oldest first. Default and ceiling: fetchLimit.",
          },
        },
        additionalProperties: false,
      },
      execute: (async (input: { limit?: number }, me: V2ToolContext) => {
        if (!mesh.selfId(me.sessionID)) {
          return {
            output: `This session is not on the mesh yet: call ${TOOL_REGISTER} first.`,
            metadata: { count: 0 },
          }
        }
        const { messages, hasMore } = await mesh.fetch({
          sessionID: me.sessionID,
          ...(input.limit ? { limit: Math.min(input.limit, mesh.fetchLimit) } : {}),
        })
        return {
          output: JSON.stringify({ messages, hasMore }, null, 2),
          metadata: { count: messages.length, hasMore },
        }
      }),
    },
  ]
}

/**
 * The v2 delivery path, exported so a test can drive the real thing.
 *
 * It never inspects the session's state. V1 asked `session.status` and deferred
 * a busy recipient itself; V2 removed that API and put the decision in the
 * request as `delivery: "queue"`, so this is one call. A test that reaches this
 * function is testing what actually ships, which a test calling the fake ctx
 * directly is not.
 */
export function v2Inject(ctx: V2Context) {
  return async ({ sessionID, text }: { sessionID: string; text: string }): Promise<void> => {
    try {
      await ctx.session.prompt({ sessionID, text, delivery: "queue" })
    } catch (error) {
      const tag = (error as { _tag?: unknown } | undefined)?._tag
      if (tag === "SessionNotFoundError") throw new SessionNotFoundError(sessionID)
      throw error
    }
  }
}

export const v2Plugin = {
  id: V2_PLUGIN_ID,
  async setup(rawCtx: V2Context): Promise<() => Promise<void>> {
    const ctx = rawCtx
    const config = resolveConfig((ctx.options ?? {}) as MeshOptions)
    const logger = createLogger()
    const directory = ctx.location.directory

    const mesh = new Mesh(config, { logger, inject: v2Inject(ctx) })

    await ctx.tool.transform((editor) => {
      for (const tool of buildV2Tools(mesh, directory)) editor.add(tool)
    })

    // First user turn in a session puts it on the mesh, and every turn refreshes
    // its activity marker — that is what makes an abandoned chat look abandoned
    // instead of permanently fresh. v2 does not run this hook for synthetic
    // messages, so mail another agent injects into this session no longer counts
    // as activity here. Idle-ness still tracks the human's own turns, which is
    // what `idleMs` claims to measure.
    await ctx.session.hook("prompt", async (event) => {
      if (config.autoRegister && !mesh.isRegistered(event.sessionID)) {
        try {
          await mesh.autoRegister({
            sessionID: event.sessionID,
            directory,
            worktree: directory,
            serverUrl: "",
          })
        } catch (error) {
          logger("error", "auto_register_failed")
        }
      }
      await mesh.noteActivity(event.sessionID).catch(() => {})
    })

    // Teach the protocol in the system prompt instead of a per-repo AGENTS.md.
    await ctx.session.hook("context", (event) => {
      if (!config.injectSystemPrompt) return
      const selfId = mesh.selfId(event.sessionID)
      event.system.push({
        type: "text",
        text: systemPrompt({
          ...(selfId ? { selfId } : {}),
          maxTextLength: config.maxTextLength,
          maxReplyDepth: config.maxReplyDepth,
          presenceReapMs: config.presenceReapMs,
        }),
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          logger("debug", "opencode_event")
          if (event.type === "session.idle") {
            const id = (event.properties as { sessionID?: unknown } | undefined)?.sessionID
            if (typeof id === "string") await mesh.noteActivity(id).catch(() => {})
            continue
          }
          if (event.type !== "session.deleted") continue
          const info = (event.properties as { info?: { id?: unknown } } | undefined)?.info
          if (info && typeof info.id === "string") await mesh.unregisterSession(info.id).catch(() => {})
        }
      } catch {
        // A stream that ends on abort is the normal exit; anything else has
        // nowhere to report to, and the sweep still reaps a stale record.
      }
    })()

    return async () => {
      controller.abort()
      await mesh.dispose().catch(() => {})
    }
  },
}
