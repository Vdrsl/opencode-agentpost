import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { createOpencodeClient } from "@opencode-ai/sdk/client"

export type FakeOpenCodeMode =
  | "accepted"
  | "not_found"
  | "busy"
  | "busy_once"
  | "server_error"
  | "timeout"

export type FakeOpenCode = {
  baseUrl: string
  client: ReturnType<typeof createOpencodeClient>
  promptCount: () => number
  requests: string[]
  close: () => Promise<void>
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function sessionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/session\/([^/]+)/)
  return match?.[1]
}

export async function startFakeOpenCode(mode: FakeOpenCodeMode = "accepted"): Promise<FakeOpenCode> {
  let prompts = 0
  const requests: string[] = []
  const server = createServer((request, response) => {
    const rawUrl = request.url ?? "/"
    const url = new URL(rawUrl, "http://127.0.0.1")
    const pathname = url.pathname
    requests.push(`${request.method ?? "GET"} ${rawUrl}`)
    if (request.method === "GET" && pathname === "/session/status") {
      json(response, 200, { ses_fake: { type: "idle" } })
      return
    }
    const id = sessionId(pathname)
    if (request.method === "GET" && id) {
      if (mode === "not_found") {
        json(response, 404, { _tag: "SessionNotFoundError", sessionID: id, message: "missing" })
      } else {
        json(response, 200, { id, directory: "I:\\fake" })
      }
      return
    }
    if (request.method === "POST" && id && pathname.endsWith("/prompt_async")) {
      prompts++
      if (mode === "timeout") return
      if (mode === "not_found") {
        json(response, 404, { _tag: "SessionNotFoundError", sessionID: id, message: "missing" })
      } else if (mode === "busy" || (mode === "busy_once" && prompts === 1)) {
        json(response, 409, { _tag: "SessionBusyError", sessionID: id, message: "busy" })
      } else if (mode === "server_error") {
        json(response, 500, { message: "server error" })
      } else {
        response.writeHead(204)
        response.end()
      }
      return
    }
    json(response, 404, { message: "not found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    client: createOpencodeClient({ baseUrl, responseStyle: "fields", throwOnError: false }),
    promptCount: () => prompts,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  }
}
