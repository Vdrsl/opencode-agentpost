# OpenCode SDK 1.18.32 probe notes

Probe date: 2026-09-24. Source of truth: the installed `@opencode-ai/sdk` and `@opencode-ai/plugin` packages under `node_modules`, not assumptions from the generated API names.

## Client construction

`@opencode-ai/sdk/v2/client` exports:

```ts
createOpencodeClient(config?: Config & {
  directory?: string
  experimental_workspaceID?: string
}): OpencodeClient
```

The client configuration supports `baseUrl`, custom `fetch`, `responseStyle`, `throwOnError`, and headers. `createOpencodeClient` adds directory/workspace headers and wraps the generated client.

## Runtime session shape

`Object.keys(client.session)` is:

```json
["client"]
```

The callable session methods are inherited from the generated `Session2` prototype, not own enumerable properties. The observed prototype methods were:

```text
constructor, list, create, status, delete, get, update, children, todo, diff,
messages, prompt, deleteMessage, message, fork, abort, init, unshare, share,
summarize, promptAsync, command, shell, revert, unrevert
```

The probe verifies methods through both runtime property access and the prototype list.

## Session API

The standalone probe uses the generated v2 client API:

- `status({ directory?, workspace? })`
- `get({ sessionID, directory?, workspace? })`
- `promptAsync({ sessionID, directory?, workspace?, messageID?, model?, agent?, noReply?, tools?, format?, system?, variant?, parts? })`

The PluginInput client is the root SDK client, whose generated signatures are:

- `session.status({ query?: { directory? } })`
- `session.get({ path: { id: string }, query?: { directory? } })`
- `session.promptAsync({ path: { id: string }, query?: { directory? }, body: { parts: [...] } })`

`promptAsync` is documented as asynchronous: it creates/sends a message, starts the session if needed, and returns immediately. The root plugin type exposes only one parameter, while the runtime v2-style client accepts a second `Options` argument with `signal`; the plugin uses a narrow local cast while preserving the verified runtime signal path.

## Observed status and event types

`SessionStatus` is:

```text
idle | retry | busy
```

The generated event union includes:

- `session.status` with `data.sessionID` and `data.status`
- `session.error` with optional `data.sessionID` and `data.error`
- `session.idle` with `data.sessionID`
- `session.compacted` with `data.sessionID`
- many message, tool, permission, and session lifecycle events

Generated error types include `SessionBusyError` and `SessionNotFoundError`.

The plugin's `AGENTPOST_DEBUG` path now logs the received event type from the existing event hook. This is diagnostic only and does not change delivery behavior.

## Fake HTTP probe

The probe used `createOpencodeClient` with a custom `fetch`. The custom fetch must read the body from the `Request` object; reading `init.body` is incorrect because the generated client passes a `Request`.

Observed results with `responseStyle: "fields"` and `throwOnError: false`:

| HTTP response | Result |
|---|---|
| `204` | no `error`; response accepted |
| `409` | `result.error._tag === "SessionBusyError"` |
| `404` | `result.error._tag === "SessionNotFoundError"` |

The `response` object is not JSON-serializable through `JSON.stringify`, so diagnostics should inspect `response.status` directly rather than stringify the result.

## Two real OpenCode servers

Two isolated `opencode serve --pure` processes were started on localhost ports `4101` and `4102`. One session was created through each server.

A real `promptAsync` request to the first session returned HTTP `204`. Immediately afterward, the first session status was `busy`; after approximately eight seconds, status was `idle`. The session messages endpoint then reported two messages.

The second server was used to verify real session creation and status discovery. The temporary servers and their temp workspaces were stopped and removed after the probe.

## Iteration 3.1 status vocabulary

AgentPost now names the recipient acknowledgement states explicitly:

- `accepted`: OpenCode accepted the asynchronous prompt.
- `failed`: the recipient reported a synchronous injection error.
- `ambiguous`: the delivery outcome is unknown and the caller must not blindly resend.

Legacy on-disk acknowledgements with `status: "injected"` are normalized to
`accepted` when read. New acknowledgements are written as `accepted`; no timeout,
busy, or retry behavior is changed by 3.1.

## Iteration 3.3 busy and session lifecycle handling

Before sending, AgentPost checks the root client's `session.get` and `session.status` APIs. A missing session becomes a failed delivery and is dead-lettered. A `busy` or `retry` status defers the message without consuming the normal delivery retry count. After `maxBusyDefers`, the result becomes `ambiguous`; a prompt timeout follows the same ambiguous result path.

The preflight reduces the common busy/not-found races, but it cannot provide a completion guarantee after an asynchronous prompt has been accepted. The caller must not blindly resend an `ambiguous` result.

## Event stream probe

A second real probe used two `opencode serve --pure` processes on localhost ports `4211` and `4212`.
Each client subscribed to `/event` before creating a session and issuing `promptAsync` with `noReply`.
Both requests returned HTTP `204`. The streams emitted `server.connected`, `session.created`,
`session.updated`, `message.updated`, and `message.part.updated`; neither stream emitted
`session.error`, `session.idle`, or a completion/failure event during the bounded five-second window.
Therefore the plugin keeps its existing `AGENTPOST_DEBUG` event-type logging and does not add a
completion acknowledgement or new delivery state.

## Iteration 3.4 local processed registry

After the recipient handler accepts a prompt, it atomically writes a local `processed/<msgid>.json`
marker before writing the accepted acknowledgement. Startup recovery checks that marker before
restoring an orphaned claim, then writes the accepted acknowledgement without injecting again.
The registry is recipient-local, uses no `session.messages` query, and does not add wire fields.

The marker suppresses local replay after a crash. It cannot provide exactly-once delivery because a
crash between asynchronous prompt acceptance and marker creation remains inherently ambiguous.

## Boundary conclusion for Iteration 3

`promptAsync` HTTP success proves that the asynchronous request was accepted by the OpenCode endpoint. It does not prove that the model completed, that a reply exists, or that the user turn remains available after a crash. Busy and not-found responses are observable through `result.error` and session status APIs. The next iteration can use these verified contracts; Iteration 3.0 does not change delivery semantics.

## Tool schema validation

The installed `@opencode-ai/plugin` 1.18.32 exposes Zod through `tool.schema`. Runtime probing confirmed that string schemas provide `.min()`, `.max()`, and `.regex()`, so tool arguments can enforce the documented identifier format before `execute()` runs.
