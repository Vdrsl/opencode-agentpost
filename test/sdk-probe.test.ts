import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

import { AgentPost } from "../src/index.ts"

type FetchCall = {
  url: string
  method: string
  body: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("OpenCode SDK probe", () => {
  it("exposes session methods and preserves HTTP error results", async (t) => {
    const calls: FetchCall[] = []
    const client = createOpencodeClient({
      baseUrl: "http://sdk-probe.invalid",
      responseStyle: "fields",
      throwOnError: false,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = request.url
        const method = request.method
        const body = await request.clone().text()
        calls.push({ url, method, body })

        if (url.endsWith("/session/status")) return jsonResponse([])
        if (url.endsWith("/session/ses_probe")) {
          return jsonResponse({ id: "ses_probe", directory: "I:\\test" })
        }
        if (url.endsWith("/session/ses_missing")) {
          return jsonResponse({ _tag: "SessionNotFoundError", sessionID: "ses_missing" }, 404)
        }
        if (url.endsWith("/session") && method === "GET") return jsonResponse([])
        if (url.endsWith("/prompt_async")) {
          if (body.includes("conflict")) {
            return jsonResponse(
              { _tag: "SessionBusyError", sessionID: "ses_busy", message: "busy" },
              409,
            )
          }
          if (body.includes("missing")) {
            return jsonResponse(
              { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "not found" },
              404,
            )
          }
          return new Response(null, { status: 204 })
        }
        return jsonResponse({ message: "not found" }, 404)
      },
    })

    const sessionKeys = Object.keys(client.session)
    const sessionPrototype = Object.getPrototypeOf(client.session) as object
    const sessionMethods = Object.getOwnPropertyNames(sessionPrototype)
    t.diagnostic(`Object.keys(client.session): ${JSON.stringify(sessionKeys)}`)
    t.diagnostic(`session prototype methods: ${JSON.stringify(sessionMethods)}`)
    for (const method of ["list", "status", "get", "messages", "prompt", "promptAsync"]) {
      assert.equal(
        typeof (client.session as unknown as Record<string, unknown>)[method],
        "function",
        `missing session method: ${method}`,
      )
      assert.ok(sessionMethods.includes(method), `missing prototype method: ${method}`)
    }

    const status = await client.session.status({})
    const list = await client.session.list({})
    const session = await client.session.get({ sessionID: "ses_probe" })
    assert.equal(status.error, undefined)
    assert.equal(list.error, undefined)
    assert.equal(session.error, undefined)

    const accepted = await client.session.promptAsync({
      sessionID: "ses_probe",
      parts: [{ type: "text", text: "accepted probe" }],
    })
    t.diagnostic(`accepted: ${JSON.stringify(accepted)}`)
    assert.equal(accepted.error, undefined)
    assert.equal(accepted.response.status, 204)

    const busy = await client.session.promptAsync({
      sessionID: "ses_busy",
      parts: [{ type: "text", text: "conflict" }],
    })
    t.diagnostic(`busy: ${JSON.stringify(busy)}`)
    assert.ok(busy.error)
    assert.equal(busy.response.status, 409)

    const missing = await client.session.promptAsync({
      sessionID: "ses_missing",
      parts: [{ type: "text", text: "missing" }],
    })
    t.diagnostic(`missing: ${JSON.stringify(missing)}`)
    assert.ok(missing.error)
    assert.equal(missing.response.status, 404)

    assert.ok(calls.some((call) => call.url.endsWith("/session/status")))
    assert.ok(calls.some((call) => call.url.endsWith("/session/ses_probe")))
    assert.ok(calls.some((call) => call.url.endsWith("/prompt_async")))
  })

  it("uses PluginInput session preflight signatures", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-sdk-"))
    const calls: string[] = []
    const client = {
      session: {
        get: async (options: unknown) => {
          calls.push(`get ${JSON.stringify(options)}`)
          return { data: { id: "ses_recipient" } }
        },
        status: async (options: unknown) => {
          calls.push(`status ${JSON.stringify(options)}`)
          return { data: { ses_recipient: { type: "idle" } } }
        },
        promptAsync: async (options: unknown) => {
          calls.push(`promptAsync ${JSON.stringify(options)}`)
          return { data: null }
        },
      },
    }
    const recipientInput = {
      client,
      directory: "I:\\recipient",
      worktree: "I:\\recipient",
      serverUrl: "http://127.0.0.1:4096",
    }
    const senderInput = {
      ...recipientInput,
      directory: "I:\\sender",
      worktree: "I:\\sender",
    }
    const recipient = (await AgentPost(recipientInput as never, { home, id: "recipient" })) as {
      tool: Record<string, { execute: (args: unknown, context: unknown) => Promise<{ output: string }> }>
      dispose: () => Promise<void>
    }
    const sender = (await AgentPost(senderInput as never, { home, id: "sender" })) as typeof recipient
    try {
      await recipient.tool["agentpost_register"]!.execute(
        { id: "recipient", description: "recipient" },
        { sessionID: "ses_recipient", directory: "I:\\recipient", worktree: "I:\\recipient" },
      )
      await sender.tool["agentpost_register"]!.execute(
        { id: "sender", description: "sender" },
        { sessionID: "ses_sender", directory: "I:\\sender", worktree: "I:\\sender" },
      )
      const result = await sender.tool["agentpost_send"]!.execute(
        { to: "recipient", text: "preflight probe" },
        { sessionID: "ses_sender", directory: "I:\\sender", worktree: "I:\\sender" },
      )
      assert.equal(JSON.parse(result.output).status, "accepted")
      assert.deepEqual(JSON.parse(calls[0]!.slice("get ".length)), {
        path: { id: "ses_recipient" },
        query: { directory: "I:\\recipient" },
      })
      assert.deepEqual(JSON.parse(calls[1]!.slice("status ".length)), {
        query: { directory: "I:\\recipient" },
      })
      const prompt = JSON.parse(calls[2]!.slice("promptAsync ".length))
      assert.deepEqual(prompt.path, { id: "ses_recipient" })
      assert.deepEqual(prompt.query, { directory: "I:\\recipient" })
      assert.match(prompt.body.parts[0].text, /preflight probe/)
    } finally {
      await sender.dispose()
      await recipient.dispose()
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
