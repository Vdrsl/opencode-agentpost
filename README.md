# @vdrsl/opencode-agentmesh

[![license](https://img.shields.io/npm/l/@vdrsl/opencode-agentmesh.svg)](https://github.com/Vdrsl/opencode-agentmesh-private/blob/main/LICENSE)

Peer-to-peer messaging between [opencode](https://opencode.ai) agents running in
different sessions, directories, or even different servers.

It's a plugin, not an MCP server, not an app. There is **no daemon, no port, and
no config server** to run — coordination happens entirely through a shared
directory on disk. Install it, and any two opencode sessions that load it can
discover each other and exchange messages, whether they're two terminals on
your laptop or two sessions on different machines pointed at the same shared
folder.

## Why

If you run multiple opencode sessions side by side — one per repo, one per
service, one for planning and others for implementation — they have no way to
coordinate. `@vdrsl/opencode-agentmesh` gives each session three tools so they can
find each other and talk, without you copy-pasting between terminals.

## Install

Add it to your `opencode.json` (global `~/.config/opencode/opencode.json` or
per-project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vdrsl/opencode-agentmesh"
  ]
}
```

opencode installs npm plugins automatically at startup — there is nothing to
`npm install` yourself. To pin a fixed agent id or tune the defaults, use the
tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@vdrsl/opencode-agentmesh",
      {
        "id": "api-gateway"
      }
    ]
  ]
}
```

## How it works

Every session that loads the plugin registers itself on the mesh the moment
you send your first message, and gets three tools:

| Tool                 | Purpose                                                                                                                                                    |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `agentmesh_register` | Publish this agent's id, description, and metadata so peers can find it. Called automatically; call it again to update your description or change your id. |
| `agentmesh_peers`    | List every agent on the mesh right now: id, description, metadata, `alive`/`stale` status, last seen, `idleMs` (ms since its last turn), directory. Freshest first. |
| `agentmesh_send`     | Send one message to a peer by id. It's injected into that peer's own opencode session as a new user turn. Use `in_reply_to` with the incoming `msg` id for correlated replies (`reply_to` remains a legacy alias). |
| `agentmesh_deliveries` | Check what became of the messages you sent: recipient, state (`queued`, `accepted`, `failed`, `ambiguous`, `undeliverable`), timestamp. Newest first, filterable by `to` and `state`. |
| `agentmesh_fetch`    | Fallback read of your own inbox: messages that were never injected (after a crash, or still held by a busy session). Excludes anything already injected, so nothing is shown twice. |

A message sent to a peer that's offline stays in the durable inbox. The recipient's
plugin watches it, claims it with a lease, retries failed injection up to
`maxDeliveryAttempts`, and moves exhausted messages to `dead/`. Busy sessions are
deferred separately; past `maxBusyDefers` the sender is told the outcome is
`ambiguous`, but the message stays in the inbox and is injected when the session
goes idle. Prompt timeouts are `ambiguous` and are not retried.
`agentmesh_send` returns `accepted` after the
recipient's OpenCode accepts the asynchronous prompt; that does not mean the peer
read the message or answered. `queued` means the durable inbox write exists but
no acknowledgement arrived before `ackWaitMs`; `failed` means the recipient
reported a terminal injection error; `ambiguous` means the delivery outcome is
not known and the caller must not blindly resend.

Addressability is not presence. An id is accepted as long as either its
`agents/<id>.json` record exists or its `inbox/<id>/` directory does, so mail to
an agent whose opencode is closed queues instead of bouncing: the record is
reaped after `presenceReapMs` (five minutes by default) but the mailbox outlives
it, and `stale` only means "not heartbeating right now". The one address you
cannot send to is an id that was never used, because there is nowhere to put the
message.

```
[agentmesh] from: planner | 2026-08-27T09:12:03Z | msg: agm_01… | re: T-001 | in-reply-to: agm_00…
review src/auth.ts please
(end of agentmesh message; to reply, call agentmesh_send with to "planner")
```

That's what shows up as a new turn in the recipient's session — no polling,
no manual relay.

### Names

An auto-registered agent gets an `adjective-noun` name like `quiet-otter`,
hashed from its opencode `sessionID`. Two things follow, both deliberate: the
same chat keeps the same name after a restart of opencode, so its address and
its inbox stay put, and two chats in one directory never collide into
`repo` and `repo-2`. The name is not drawn from a random source — that would
drift on every restart and orphan the inbox. Set `id` to pin a name yourself.

A description you set yourself does not outlive the presence record. After
`presenceReapMs` of silence — five minutes by default — the record is reaped,
and an agent that comes back is auto-registered with the generic description
`opencode agent working in <directory>` and no metadata. That is deliberate:
the record is ephemeral, and persisting a description would tie presence to
identity again, which is exactly what separating them was for. The cost is that
a returning agent is briefly indistinguishable from a background process that
never introduced itself, so call `agentmesh_register` once per session when you
have a role to describe.

Recreating a chat in the same directory is a different problem, and it does not
orphan the mailbox. A fresh session asks the registry for an address its
predecessor left behind: one whose process is gone, or whose record has been
quiet for `presenceReapMs`. It takes the most recent such address, along with
the description and metadata the predecessor was using. Two chats open at once
each keep their own address, because a live one is never handed out.

The window is the record's own lifetime. Recreate a chat after the record is
reaped and it gets a new name, and the mailbox of the old one is cleaned up like
any other. A winner is decided by the last write to the record, so a loser learns
it lost on its next heartbeat and stands down rather than delivering into a
mailbox it no longer owns. Mail already in a lost address's mailbox stays there;
it is not forwarded to the new address, because a new address may itself be
claimed later.

### No daemon, just files

Every agent's plugin instance coordinates through one shared home directory
(default `~/.local/share/opencode-agentmesh`, or `$XDG_DATA_HOME/opencode-agentmesh`):

```
<home>/agents/<id>.json         one record per agent, written only by its owner
<home>/activity/<id>            last session turn, touched only by <id>
<home>/inbox/<id>/<msgid>.json  pending messages for <id>, written by senders
<home>/inbox/<id>/<msgid>.json.taken  active lease claim, with _claim metadata
<home>/dead/<id>/<msgid>.json  messages that exhausted delivery attempts
<home>/quarantine/<id>/<msgid>.invalid  critical malformed messages
<home>/acks/<msgid>.json        delivery confirmation, written by the recipient
<home>/processed/<msgid>.json  local recipient marker: injected, with depth and thread
<home>/outbox/<msgid>.json     the sender's own copy: state of one sent message
```

Each agent only ever writes its own record and its own acks, and a sender only
ever writes into the recipient's inbox — so there is nothing to lock. After a
successful injection, the recipient records a local `processed/<msgid>.json`
marker; a restart can use it to avoid re-injecting an orphaned claim. This is
local replay suppression, not exactly-once delivery. Liveness is a heartbeat
(file mtime) plus a process check, so a killed opencode shows up as stale
immediately rather than lingering.

The inbox is the recipient's copy and an ack lives only for `ackRetentionMs`, so
the sender keeps its own `<home>/outbox/<msgid>.json` entry instead of forgetting
a message within minutes. It records what we last heard — `queued`, `accepted`,
`failed`, `ambiguous`, or `undeliverable` once the message itself has been
reaped — and never walks a finished state backwards. A sweep reconciles it with
the ack, so a message a busy recipient accepted after the sender stopped
waiting still ends up `accepted`. A conversation is just its
root message id: a reply carries the same `threadId` it inherited, and every
participant agrees on it without coordinating.

### How mail reaches a session

Mail is pushed, never polled: the recipient's plugin watches its own inbox and
delivers. One message on its own arrives as a full user turn, and the model just
works on it. Several at once cost one turn between them — the session gets a
single notice saying how many are waiting, and the model calls `agentmesh_fetch`
once to take the whole batch. The saving only shows up at three or more, where
it is one turn instead of N.

Nothing is lost if the model ignores the notice: after `fetchFallbackMs` the
batch is delivered as ordinary turns anyway, by the same path that has always
worked. A notice is a wake-up, not a deadline.

The batch decision is made on messages the watcher has actually claimed, never
on a directory count, and a claim is a hard link — exclusive by construction, so
a message can only ever reach the model once whether it came from the fetch or
from the fallback. See `fs.link` in `src/store.ts` for why a rename is not
enough on Windows.

`agentmesh_deliveries` reports the state of what you sent, so a peer that went
quiet can be told apart from a message that never landed.

One honest edge: a message taken by `agentmesh_fetch` is consumed, and its text
lands inside a turn that can be aborted. If the session is interrupted between
the fetch and the model acting on it, that message is not delivered again. A
direct inject is stronger here, because its text is already in the session
history.

A live process is not the same as a human at the keyboard, so every agent also
gets an `activity/<id>` file touched on each session turn. Peers report it as
`idleMs` — ms since that session's last turn — and are listed freshest first.
An agent whose opencode has been sitting in a chat nobody opened for two days
stays `alive`, but its `idleMs` grows, so a model can tell it apart from the
session someone is actually working in.

If your agents run on different machines, point `AGENTMESH_HOME` (see below)
at a directory synced or shared between them (e.g. a network mount).

## Configuration

Options can be passed via the plugin tuple, and every one has an environment
variable that overrides it (env > plugin options > defaults):

| Plugin option         | Env var                           | Default                                                                    | Description                                                                          |
|-----------------------|-----------------------------------|----------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `id`                  | `AGENTMESH_ID`                    | an adjective-noun pair hashed from the session id                           | Fixed agent id for this project.                                                     |
| `home`                | `AGENTMESH_HOME`                  | `$XDG_DATA_HOME/opencode-agentmesh` or `~/.local/share/opencode-agentmesh` | Mesh home directory.                                                                 |
| `autoRegister`        | `AGENTMESH_AUTO_REGISTER`         | `true`                                                                     | Register automatically on the first user message.                                    |
| `injectSystemPrompt`  | `AGENTMESH_INJECT_SYSTEM_PROMPT`  | `true`                                                                     | Append the mesh protocol explanation to the system prompt.                           |
| `heartbeatIntervalMs` | `AGENTMESH_HEARTBEAT_INTERVAL_MS` | `15000`                                                                    | How often a registered agent refreshes its liveness.                                 |
| `staleAfterMs`        | `AGENTMESH_STALE_AFTER_MS`        | `60000`                                                                    | No heartbeat for this long → agent shows as `stale`.                                 |
| `presenceReapMs`      | `AGENTMESH_PRESENCE_REAP_MS`      | `300000`                                                                   | No heartbeat for this long → the presence record is dropped, the mailbox stays. Cap 24h. |
| `messageRetentionMs`  | `AGENTMESH_MESSAGE_RETENTION_MS`  | `86400000`                                                                  | How long an undelivered message is kept in `inbox/`, `dead/` and `quarantine/` before it is dropped. Cap 7d. |
| `ackWaitMs`           | `AGENTMESH_ACK_WAIT_MS`           | `3000`                                                                     | How long `agentmesh_send` waits for delivery confirmation before returning `queued`. |
| `ackRetentionMs`      | `AGENTMESH_ACK_RETENTION_MS`      | `300000`                                                                   | How long delivery acknowledgements remain before they are reaped.                    |
| `queueRetentionMs`    | `AGENTMESH_QUEUE_RETENTION_MS`    | `300000`                                                                   | How long an empty inbox of a gone agent is kept before deletion.                     |
| `busyDeferMs`         | `AGENTMESH_BUSY_DEFER_MS`         | `2000`                                                                     | Delay before retrying a busy OpenCode session. A busy peer is a slow peer: the message is never dropped, it waits in the inbox. |
| `maxBusyDefers`       | `AGENTMESH_MAX_BUSY_DEFERS`       | `12`                                                                       | Busy defers before the sender is told delivery became `ambiguous`. The message itself is never dropped. |
| `promptTimeoutMs`     | `AGENTMESH_PROMPT_TIMEOUT_MS`     | `30000`                                                                    | Maximum time for one asynchronous prompt before delivery becomes `ambiguous`.       |
| `pollIntervalMs`      | `AGENTMESH_POLL_INTERVAL_MS`      | `2000`                                                                     | Inbox poll interval, as a fallback for missed filesystem events.                     |
| `maxTextLength`       | `AGENTMESH_MAX_TEXT_LENGTH`       | `8000`                                                                     | Maximum message body length, in characters.                                          |
| `leaseDurationMs`     | `AGENTMESH_LEASE_DURATION_MS`     | `60000`                                                                    | Claim lease duration before recovery may retry a message.                            |
| `maxDeliveryAttempts` | `AGENTMESH_MAX_DELIVERY_ATTEMPTS` | `3`                                                                        | Maximum injection attempts before moving a message to `dead/`.                      |
| `maxInboxMessages`    | `AGENTMESH_MAX_INBOX_MESSAGES`    | `256`                                                                      | Maximum pending `.json` messages in one inbox.                                       |
| `maxMessageBytes`     | `AGENTMESH_MAX_MESSAGE_BYTES`     | `32768`                                                                    | Maximum serialized size of one message.                                             |
| `maxInboxBytes`       | `AGENTMESH_MAX_INBOX_BYTES`       | `8388608`                                                                  | Maximum serialized bytes across pending messages in one inbox.                      |
| `maxReplyDepth`       | `AGENTMESH_MAX_REPLY_DEPTH`       | `8`                                                                        | Maximum bounded reply-chain depth.                                                    |
| `processedRetentionMs` | `AGENTMESH_PROCESSED_RETENTION_MS` | `86400000`                                                                | How long a `processed/<msgid>.json` marker suppresses replay before it is reaped.    |
| `fetchLimit`           | `AGENTMESH_FETCH_LIMIT`            | `20`                                                                      | Max messages one `agentmesh_fetch` takes, and the batch size that triggers a notice. |
| `fetchFallbackMs`      | `AGENTMESH_FETCH_FALLBACK_MS`      | `30000`                                                                   | How long an unanswered batch notice waits before the messages arrive as turns.       |

`AGENTMESH_LOG_LEVEL` controls structured stderr logging: `off` (default), `info`, or
`debug`. Each enabled line is JSON with a timestamp, level, fixed event name, and
safe numeric/boolean fields only; message text, metadata, server URLs, credentials,
and control-character user strings are never logged. `AGENTMESH_DEBUG=1` remains a
deprecated fallback that selects `info` when `AGENTMESH_LOG_LEVEL` is unset.

Acknowledgement files are retained independently from agent records. `ackRetentionMs`
defaults to five minutes and is capped at 24 hours; use it when a shared directory
needs a longer audit window.

### Cleanup

The shared directory would grow forever otherwise, so a sweep runs once a minute
next to the record reaper and each step is deliberately conservative:

- `agents/<id>.json` records are reaped after `presenceReapMs` (five minutes
  without a heartbeat). That only takes the agent out of the listing; its mailbox
  stays, and its id keeps accepting mail.
- `activity/<id>` is removed when the agent unregisters or its record is reaped —
  the owner of that state deletes its own file.
- `inbox/<id>` is removed only when the agent has no record **and** the inbox is
  empty **and** it has been untouched for `queueRetentionMs`. A non-empty inbox is
  never dropped, because those messages still have to be delivered, and the delay
  covers an agent that unregisters and comes straight back under the same id.
  `dead/` and `quarantine/` live outside the inbox, so a message that ended up
  there cannot keep the inbox directory alive forever.
- Individual messages in `inbox/`, `dead/` and `quarantine/` are dropped after
  `messageRetentionMs` (24 hours by default). Since mail to an offline agent is
  meant to wait, this is the only bound on how long undelivered work survives.
- `processed/<msgid>.json` markers are reaped after `processedRetentionMs` (24
  hours by default), which bounds replay suppression to that window. Lower it if
  you accept that a message injected longer ago may be injected again.
- `outbox/<msgid>.json` entries are aged on the same `messageRetentionMs` window
  as the message itself: a finished entry is deleted, and one that never got a
  verdict is rewritten as `undeliverable` — the recipient was gone, not the
  message — and dropped one window later.

## Security and limitations

Agent IDs are restricted to safe lowercase slugs, including rejection of Windows
reserved names and path traversal. Inbox, claim, and acknowledgement reads reject
unsafe storage paths and symlink entries, and acknowledgements must match both the
message ID and intended recipient. The shared home directory is a trusted transport:
it is not encrypted and does not provide authentication or authorization. The local
`processed/` marker suppresses replay after a successful injection, but it is not a
transactional exactly-once guarantee. `accepted` means the recipient's OpenCode
accepted the asynchronous prompt, not that the peer read or answered it; `ambiguous`
outcomes must not be blindly resent.

## Requirements

- opencode
- Node.js >= 22 (only matters if you're developing the plugin itself; end
  users just add it to `opencode.json`)

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test on test/*.test.ts
npm run build        # emits dist/
npm pack --dry-run  # verifies the published file set
```

See [AGENTS.md](./AGENTS.md) for architecture notes and conventions if you're
contributing.

## Credits

This is a fork of [`opencode-agentmesh`](https://www.npmjs.com/package/opencode-agentmesh)
by **Abdulkadir Polat** (npm: `polatdev`), MIT licensed. His work is the base of
everything here, and the original copyright is kept in [LICENSE](./LICENSE).

What this fork changed:

- `idleMs` on every peer plus an `activity/<id>` marker, so a chat nobody opened
  for days no longer looks like a busy one, and peers are listed freshest first.
- A busy session no longer loses a message: past `maxBusyDefers` the recipient
  tells the sender `ambiguous` and keeps the message queued for the next idle.
- One sweep reaps orphan inboxes, activity markers and replay markers, all behind
  retention windows.
- A CI matrix on Node 22 and 24, Dependabot, and a crash-boundary test matrix
  (C1–C6) around claim, handler, acknowledgement and recovery failures.

## License

MIT License. See [LICENSE](./LICENSE).
