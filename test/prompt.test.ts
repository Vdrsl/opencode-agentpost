import { test } from "node:test"
import assert from "node:assert/strict"
import { systemPrompt } from "../src/prompt.ts"

test("systemPrompt includes key sections with selfId", () => {
  const p = systemPrompt({ selfId: "test-agent", maxTextLength: 8000, maxReplyDepth: 8 })
  assert.ok(p.includes("test-agent"))
  assert.ok(p.includes("8000"))
  assert.ok(p.includes("8 levels"))
  assert.ok(p.includes("ambiguous"))
  assert.ok(p.includes("in_reply_to"))
  assert.ok(p.includes("API keys"))
  assert.ok(p.includes("in-reply-to:"))
})

test("systemPrompt without selfId says not registered", () => {
  const p = systemPrompt({ maxTextLength: 8000, maxReplyDepth: 8 })
  assert.ok(p.includes("not on the mesh yet"))
})

test("systemPrompt does not contain undefined placeholders", () => {
  const p = systemPrompt({ selfId: "x", maxTextLength: 500, maxReplyDepth: 4 })
  assert.ok(!p.includes("undefined"))
})
