/**
 * opencode-agentmesh — peer-to-peer messaging between opencode agents.
 *
 * Install by adding the package to `plugin` in `~/.config/opencode/opencode.json`:
 *
 *     { "plugin": ["opencode-agentmesh"] }
 *
 * Every opencode session that loads it registers itself, watches its own inbox
 * and gains three tools. There is no daemon, no port and no per-agent config.
 */

import type { Plugin } from "@opencode-ai/plugin"

import { type MeshOptions, resolveConfig } from "./config.ts"
import { createLogger } from "./logger.ts"
import { Mesh } from "./mesh.ts"
import { systemPrompt } from "./prompt.ts"
import { PromptTimeoutError, SessionBusyError, SessionNotFoundError } from "./types.ts"
import { buildTools } from "./tools.ts"

export type { MeshOptions } from "./config.ts"
export type { AgentRecord, MeshMessage, PeerView } from "./types.ts"

export const AgentMesh: Plugin = async (input, options) => {
  const config = resolveConfig((options ?? {}) as MeshOptions)
  const serverUrl = input.serverUrl ? input.serverUrl.toString().replace(/\/$/, "") : ""

  const logger = createLogger()

  const errorTag = (result: unknown): string | undefined => {
    const error = (result as { error?: unknown } | undefined)?.error
    if (!error || typeof error !== "object") return undefined
    const tag = (error as { _tag?: unknown })._tag
    return typeof tag === "string" ? tag : undefined
  }

  const mesh = new Mesh(config, {
    logger,
    async inject({ sessionID, directory, text }) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.promptTimeoutMs)
      try {
        const sessionResult = await input.client.session.get({
          path: { id: sessionID },
          query: { directory },
        })
        const sessionErrorTag = errorTag(sessionResult)
        if (sessionErrorTag === "SessionNotFoundError") {
          throw new SessionNotFoundError(sessionID)
        }
        if (sessionErrorTag) {
          throw new Error(`OpenCode session lookup failed: ${sessionErrorTag}`)
        }

        const statusResult = await input.client.session.status({ query: { directory } })
        const statusErrorTag = errorTag(statusResult)
        if (statusErrorTag) {
          throw new Error(`OpenCode session status failed: ${statusErrorTag}`)
        }
        const statuses = statusResult.data as Record<string, { type?: unknown }> | undefined
        const currentStatus = statuses?.[sessionID]?.type
        if (currentStatus === "busy" || currentStatus === "retry") {
          throw new SessionBusyError(sessionID)
        }

        const promptAsync = input.client.session.promptAsync as unknown as (
          parameters: Record<string, unknown>,
        ) => Promise<unknown>
        const result = await promptAsync.call(input.client.session, {
          path: { id: sessionID },
          query: { directory },
          body: { parts: [{ type: "text", text }] },
          signal: controller.signal,
        })
        // The SDK reports transport/HTTP failures in `error` rather than throwing.
        const error = (result as { error?: unknown }).error
        const tag = errorTag(result)
        if (tag === "SessionBusyError") throw new SessionBusyError(sessionID)
        if (tag === "SessionNotFoundError") throw new SessionNotFoundError(sessionID)
        if (error) throw new Error(typeof error === "string" ? error : JSON.stringify(error))
      } catch (error) {
        if (controller.signal.aborted) throw new PromptTimeoutError(config.promptTimeoutMs)
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },
  })

  const sessionContext = (sessionID: string) => ({
    sessionID,
    directory: input.directory,
    worktree: input.worktree || input.directory,
    serverUrl,
  })

  return {
    tool: buildTools(mesh, serverUrl),

    /** First user turn in a session puts it on the mesh, with no model input. */
    "chat.message": async ({ sessionID }) => {
      if (config.autoRegister && !mesh.isRegistered(sessionID)) {
        try {
          await mesh.autoRegister(sessionContext(sessionID))
        } catch (error) {
          logger("error", "auto_register_failed")
        }
      }
      // Every turn, not just the first: this is what makes an abandoned chat
      // look abandoned to peers instead of permanently fresh.
      await mesh.noteActivity(sessionID).catch(() => {})
    },

    /** Teach the protocol in the system prompt instead of a per-repo AGENTS.md. */
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!config.injectSystemPrompt) return
      output.system.push(
        systemPrompt({
          ...(sessionID && mesh.selfId(sessionID) ? { selfId: mesh.selfId(sessionID)! } : {}),
          maxTextLength: config.maxTextLength,
          maxReplyDepth: config.maxReplyDepth,
          presenceReapMs: config.presenceReapMs,
        }),
      )
    },

    /**
     * A deleted session must not linger in the registry as a live peer, and a
     * session that just finished a turn is the freshest thing on the mesh.
     */
    event: async ({ event }) => {
      logger("debug", "opencode_event")
      if (event.type === "session.idle") {
        await mesh.noteActivity(event.properties.sessionID).catch(() => {})
        return
      }
      if (event.type !== "session.deleted") return
      await mesh.unregisterSession(event.properties.info.id).catch(() => {})
    },

    dispose: async () => {
      await mesh.dispose().catch(() => {})
    },
  }
}

export default AgentMesh
