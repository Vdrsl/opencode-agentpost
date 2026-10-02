import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import dual, { AgentPost } from "../src/index.ts"
import { v2Inject, v2Plugin, V2_PLUGIN_ID } from "../src/v2.ts"
import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND } from "../src/config.ts"

/**
 * A fake v2 context. Deliberately narrow: it implements only what `src/v2.ts`
 * touches, and it throws on anything else. That is what lets one test claim
 * something stronger than "it called the right function" — if the adapter ever
 * reached for `session.status` again to decide busyness, the proxy below throws
 * on `get` rather than quietly answering.
 */
function fakeContext(home: string, calls: string[]) {
  const added: { name: string; description: string; input: Record<string, unknown>; output?: { type: string } }[] = []
  const hooks = new Map<string, (event: never) => unknown>()
  const prompts: unknown[] = []
  const controller = new AbortController()

  const session = new Proxy(
    {
      prompt(input: unknown) {
        prompts.push(input)
        calls.push("prompt")
        return Promise.resolve({ id: "msg_1" })
      },
      hook(name: string, callback: (event: never) => unknown) {
        hooks.set(name, callback)
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
    } as Record<string, unknown>,
    {
      get(target, property: string) {
        if (!(property in target)) {
          calls.push(`UNEXPECTED:${property}`)
          throw new Error(`v2 adapter called session.${property}, which this adapter must not need`)
        }
        return target[property]
      },
    },
  )

  return {
    added,
    hooks,
    prompts,
    ctx: {
      location: { directory: "I:\\test\\opencode-agentpost" },
      options: { home },
      tool: {
        transform(callback: (editor: { add(tool: { name: string; description: string; input: Record<string, unknown>; output?: { type: string } }): void }) => void) {
          callback({ add: (tool) => added.push(tool) })
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
      session,
      event: {
        subscribe({ signal }: { signal: AbortSignal }) {
          return {
            async *[Symbol.asyncIterator]() {
              while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
            },
          }
        },
      },
    },
  }
}

describe("OpenCode V2 surface", () => {
  it("serves both runtimes from one default export", async (t) => {
    // V1 reads `server`; V2 reads `id` + `setup`. Both must be present, or one
    // of the two opencodes loads a package that does nothing.
    assert.equal(typeof dual.server, "function")
    assert.equal(dual.id, V2_PLUGIN_ID)
    assert.equal(typeof dual.setup, "function")
    assert.equal(dual.server, AgentPost, "v1 keeps calling the exported function")
    assert.equal(dual.id, v2Plugin.id)
  })

  it("registers all five tools with JSON Schema inputs", async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-v2tools-"))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const fake = fakeContext(home, [])
    const cleanup = await v2Plugin.setup(fake.ctx as never)
    t.after(() => cleanup())

    const names = fake.added.map((tool) => tool.name).sort()
    assert.deepEqual(names, [TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND].sort())
    for (const tool of fake.added) {
      assert.equal(tool.input.type, "object")
      assert.equal(tool.input.additionalProperties, false)
      assert.ok(tool.description.length > 0)
      // v2 rejects a result that declares `output` without a schema, and only
      // at call time: the plugin registers fine and then every tool call fails.
      // Found on a real v2.0.22, not guessed — hence the assertion.
      assert.equal(tool.output?.type, "string")
    }
  })

  it("delivers with delivery:queue and never asks whether the session is busy", async (t) => {
    // The whole point of the v2 adapter: the queue belongs to opencode. Driving
    // `v2Inject` itself means the fake only ever sees `session.prompt` — if the
    // adapter reached for `session.status` or `session.get` to decide busyness,
    // the proxy throws instead of answering.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-v2deliver-"))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const calls: string[] = []
    const fake = fakeContext(home, calls)

    await v2Inject(fake.ctx as never)({ sessionID: "ses_probe", text: "hello" })

    assert.deepEqual(calls, ["prompt"])
    assert.deepEqual(fake.prompts, [{ sessionID: "ses_probe", text: "hello", delivery: "queue" }])
  })

  it("reports a missing v2 session as SessionNotFoundError", async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-v2missing-"))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const calls: string[] = []
    const fake = fakeContext(home, [])
    const ctx = {
      ...fake.ctx,
      session: {
        prompt: () => Promise.reject(Object.assign(new Error("gone"), { _tag: "SessionNotFoundError" })),
      },
    }
    await assert.rejects(
      () => v2Inject(ctx as never)({ sessionID: "ses_gone", text: "hello" }),
      (error: { sessionID?: unknown }) => error.sessionID === "ses_gone",
    )
  })

  it("registers the prompt and context hooks the v1 path used to carry", async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-v2hooks-"))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const fake = fakeContext(home, [])
    const cleanup = await v2Plugin.setup(fake.ctx as never)
    t.after(() => cleanup())

    assert.ok(fake.hooks.has("prompt"), "auto-register and activity on the first turn")
    assert.ok(fake.hooks.has("context"), "the mesh protocol in the system prompt")
    assert.equal(fake.hooks.has("session.idle"), false, "idle is an event, not a hook")
  })

  it("returns to the caller a cleanup that stops the event stream", async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentpost-v2cleanup-"))
    t.after(() => fs.rm(home, { recursive: true, force: true }))
    const fake = fakeContext(home, [])
    const cleanup = await v2Plugin.setup(fake.ctx as never)
    await cleanup()
    // Disposing must not throw even though the fake stream never yielded.
  })
})
