# Changelog

## Unreleased
- **OpenCode 2 delivery now steers by default.** `v2Delivery` picks `steer` or `queue`, defaulting to
  `steer`, and `AGENTPOST_V2_DELIVERY=queue` switches back without a rebuild. Measured on a live v2:
  `queue` holds a message until the turn ends, so a model thinking for minutes sees it only
  afterwards, when the facts in it may be stale; `steer` reaches the running turn. Two live deliveries
  arrived mid-turn (at steps 5 and 17 of a 40-file task) and one message survived cancelling the turn.
  A third delivery was accepted and never answered because it arrived on the recipient's last tool call
  and the turn ended before the recipient read it — a delivery racing the end of a turn, not a lost
  message, so `steer` is not claimed to be lossless.
- **An earlier idea, removed in the same change:** announcing unread mail from the `context` hook before
  each model dispatch. It cannot work — delivery already hands the message to `session.prompt` and
  deletes it from the inbox, so by the next dispatch there is nothing left to see. The unit test drove
  a fake context and could not show that; a live v2 did.

## v0.14.1
- **A registration failure now says why.** `send` re-attempts `autoRegister` and, when that fails,
  answers `E_NOT_REGISTERED` with the reason and what to do about it, instead of letting a raw
  filesystem error escape. It matters because the hooks that register a session log the failure at a
  level that is off by default, and `agentpost_peers`, `agentpost_fetch` and `agentpost_deliveries`
  do not require registration: a session that could not register could browse the mesh indefinitely
  without learning it was not on it. `send` is the model's first move, so it is the one place the
  reason can still reach the model.
- Publish to npm from the release through **trusted publishing**
  (`.github/workflows/publish.yml`): no `NPM_TOKEN` in the repository, `--provenance` on the tarball,
  and the tag and `package.json` must agree before anything is published. Triggered by publishing a
  release, not by a push to `main`.
- Keep the rejected-by-design reasoning in `AGENTS.md` and drop the stale Phase 4 backlog file. The
  file-lease and metrics rejections are worth keeping precisely because they were expensive to reach:
  the lease keying trap is the same one that already cost us the address.
- Correct two claims in `AGENTS.md` that had drifted from the code: it said no CI existed, and that
  inheritance carried `description`/`metadata` along with the address — which 0.14.0 removed, because a
  copied description is a lie that peers read as fact.

## v0.14.0 — One package, OpenCode 1 and 2
- **Rename to `@vdrsl/opencode-agentpost`.** The unscoped `opencode-agentmesh` belongs to the original author, and a fork carrying his name one-for-one is not a fork anyone would publish. The package name, the tool prefix (`agentpost_*`), the `AGENTPOST_*` env vars, the home directory, the exported symbol and the skill folder all moved together; historical entries in this file keep the names they had at the time, and `README.md` keeps the credit to the original author.
- **The same package now runs on OpenCode 2.** The default export carries both entrypoints: V1 reads `server()` and V2 reads `setup()`, which is the dual form OpenCode documents. That needs 1.18.29 or newer on the V1 side — the first release accepting an object entrypoint, and older than any release this package was published to. Install under `plugin` on V1 and `plugins` on V2; nothing else differs.
- **V2 delivery uses the runtime's queue.** V1 discovered a busy recipient through `session.status` and deferred the message itself, up to `maxBusyDefers`. V2 removed that API and made the choice part of the request, so delivery is one call with `delivery: "queue"`. This plugin never asks whether a session is busy under V2: a second queue built on the first is how messages get lost twice.
- **`accepted` under V2 means "admitted to that session's durable queue"** — the promise resolving with the admitted inbox item. It never meant the model read the message, and under V2 it does not even mean the session went idle. The other four states are unchanged.
- Tool descriptions moved to `src/descriptions.ts`, shared by both runtimes. The model reads them as instructions, so a V1 build and a V2 build describing the same tool differently would be two projects wearing one name with nothing failing.
- Under V2 a session's own activity marker is no longer refreshed by mail another agent injects into it: V2 does not run the prompt hook for synthetic messages. `idleMs` still tracks the human's own turns, which is what it claims to measure.
- **Fix, found on a real v2.0.22: every V2 tool call failed** with "Tool result declared output without an output schema". The plugin registered cleanly and then each call failed, so nothing behind a fake context ever saw it. `Tool.Info` carries `output?: JsonSchema` and the result must match it; all five tools return pretty-printed JSON text, so one schema now covers them and the test asserts it.

## v0.13.0 — Phase 4: Address inheritance
- **Breaking: an id is addressable only while its record exists.** Phase 1 also accepted a bare `inbox/<id>/` directory, on the reasoning that the mailbox outlives the presence record so mail for an away agent can queue. That reasoning only holds while something comes back to read it, and with no record nothing does — inheritance enumerates records, so there is no candidate to inherit the box. The result was `queued` for mail nothing would ever read, and the model believes that status. `send` now answers `E_NO_AGENT` and points at `agentpost_peers`. A `stale` peer is unaffected and still receives: the record is what decides, not the liveness. Reopening the *same* chat mints the same id again, since the name is hashed from the `sessionID`, so a peer returning to the chat it left is reachable under the familiar address.
- Fix, found on live data: `agentpost_fetch` reported `hasMore: false` while the recipient's own
  claim was still on disk, so a model that trusted it stopped paging and the message waited for the
  next notification. A `.json.taken` is unread mail that `listJsonFiles` cannot see. Counting every
  claim is not the fix either — a claim another watcher holds is being injected into that session and
  is not ours to fetch, so counting it pages forever. Ownership is the discriminator.
- A fresh session in the same directory claims the address a predecessor left behind, so its mailbox
  survives. The name is still hashed from the
  `sessionID`. The predecessor must have died *without giving up its address* — a crash, not a close:
  `session.deleted` runs `Registry.unregister`, which removes the record, and inheritance enumerates
  records, so a clean close offers no candidate and the mailbox is left with nothing that can address
  it. A record also holds `process.pid` — the opencode process, shared by every session it hosts — so
  two live chats in one process can never take each other's address. Verified live on 0.13.0: after
  killing the process `agents/<id>.json` was gone and came back only when the next session
  auto-registered. Reopening the *same* chat keeps its address regardless, but for a different reason:
  the name is a hash of the `sessionID`, so it is deterministic and no inheritance is involved.
- **The address carries the mailbox, not the identity.** Inheriting the description and metadata along
  with it assumed "one directory, one logical agent", which the soak disproved: a different agent moved
  into the directory, inherited the address, and published the predecessor's description as its own —
  a lie in the record that peers read as fact. A new owner now describes itself, from
  `config.description` when the project declares one and from the generated default otherwise, with
  metadata empty unless `config.metadata` says otherwise. The address and the mailbox still move, which
  is what mail needs.
- A record is handed out only when its owner is genuinely gone: `takeable` is `!pidAlive(pid) || ageMs(recordMtime) >= presenceReapMs`, deliberately not `status`. A hung process keeps heartbeating and looks alive for the whole reap window, and reusing `status` would have added `staleAfterMs` on top. `pickFree` uses the same criterion, so both paths that hand out an address agree.
- A fenced heartbeat now stops the watcher instead of only logging. A session that lost its address stands down rather than delivering into a mailbox another session now owns. The window between the record changing hands and the loser's next heartbeat is a documented limit, not a silent one: the record is a plain atomic rewrite, last write wins, and an `fs.link` claim is the possible later hardening.
- A heartbeat that comes back **missing** is no longer treated as a fence. The two mean opposite things, and reading them alike made a session go dark while its inbox kept filling: a sweep that reaps a record under a session blocked past `presenceReapMs` is not a takeover, and the mailbox it addresses outlives the record on purpose. `heartbeat` now distinguishes `ok`/`missing`/`fenced`, and a missing record is written back with the session's own description and metadata — without `force`, so a live session holding the address still wins and the loser stands down as before.
- Mail in a lost address's mailbox stays there. It is not forwarded to the new address, because that address may itself be claimed later, and moving mail between addresses is how mail ends up read by a stranger.
- Fix: a claim recovery that declined to take over left the message stranded. Recovery dropped the pending name *before* deciding whether it could take the claim, so declining — a lease still live, or a claim too young to be stale — left a lone `*.json.taken`. That is not a `*.json` file, so no later drain saw a message to lose a claim race against and recovery was never entered again: the message sat in an inbox that looked empty, forever. The pending name is now dropped only in the branches that actually take the claim over. This is the one failure CI caught that the Windows machine could not, and `fail-fast: false` on the test matrix is what made it visible instead of cancelling the other platforms.
- Inheritance holds for the lifetime of the predecessor's record, which is `presenceReapMs` by default. A crash later than that and the next session gets a new name; the old mailbox is reaped like any other.
- Scope correction, found by testing on a live chat rather than by reasoning: inheritance covers a session that dies **without giving up its address**, which is a crash. Closing a window normally is not that case — `session.deleted` unregisters the record and inheritance enumerates records, so it cannot fire on `Ctrl+C` at all. The window above was documented as if closing a chat recovered the address, and it does not.
- Known gap, deliberately left visible rather than fixed here: because the mailbox outlives that unregister, `send` keeps accepting a closed chat's address and queues mail that no later session will read — `cleanupOrphanedInboxes` only reaps an *empty* inbox. Closing this means choosing between dropping queued mail and promising a reader that does not exist, which is a decision about what `send` means, not a bug fix.

## v0.12.0 — Phase 3.5: Adaptive delivery
- Fix a delivery-correctness bug present since the first release: claiming a message used `fs.rename`, and on Windows two concurrent renames of the same source both succeed, so two delivery paths could each believe they owned one message. Claiming is now `fs.link`, which is exclusive by definition; `EEXIST` is the normal losing outcome, and a crash between link and drop leaves two names on one inode that recovery consolidates. This undercuts the at-most-once guarantee, so it is a correctness fix rather than part of the feature below.
- Adaptive delivery: idle with one pending message injects the body as before; two or more produce a single notice and the model calls `agentpost_fetch` once for the batch. After `fetchFallbackMs` the fallback body-injects whatever is still pending, so a model that ignores the notice still gets its mail.
- `agentpost_fetch` is now consuming: it claims with the same atomic primitive the injector uses, stamps `processed/<msgid>.json` with `via`, and takes the messages out of the inbox. Returns `hasMore` so a batch larger than `fetchLimit` can be paged through.
- One winner per message id, enforced by the claim itself, so the fetch and the fallback racing for the same file cannot both deliver it.
- Per-sender ordering is preserved by the monotonic ULID the sender already writes. Ordering between different senders is not a protocol guarantee.

Known edge, documented rather than hidden: a message consumed by `agentpost_fetch` is not delivered again if the session is aborted between the fetch returning and the model acting on it. A direct inject is stronger, because its text is already in the session history.

## v0.11.0 — Phase 3: Fetch & deliveries tools
- Add `agentpost_deliveries`: read your own outbox entries — recipient, state, timestamp — with optional `to`/`state` filters and a limit.
- Add `agentpost_fetch`: read-only fallback that returns the inbox messages which were never injected, excluding anything with a `processed/` marker so an already-seen turn is never shown twice.
- Stamp `from` on every outbox entry: the directory is shared, and that field is what keeps one agent's deliveries out of another's.
- Update the system prompt with explicit rules: delivery stays inject-primary, `fetch` is crash recovery rather than a polling loop, and `undeliverable` means resend rather than wait.

## v0.10.0 — Phase 2: Delivery state

- Add `threadId` to every message: a thread is its root message id, and a reply inherits the root its own `processed/<msgid>.json` marker remembers, so the same id chain is on both sides without coordination. Replies show `| thread: agm_…` in the envelope header.
- The sender now keeps `<home>/outbox/<msgid>.json` — one file per sent message, written only by its owner, recording what we last heard: `queued`, `accepted`, `failed`, `ambiguous`, or `undeliverable`. Without it a sender forgets its own message as soon as the ack is reaped, and there is no way to tell a delivered message from one that bounced.
- `writeOutboxEntry` refuses to walk a finished state backwards, so a late `queued` cannot undo a verdict the recipient already gave.
- `sweepOutbox` runs in the same sweep as everything else: it reconciles each entry with the ack the recipient eventually wrote, deletes a finished entry once it is old enough, and turns one that never got a verdict into `undeliverable` before dropping it a window later — the recipient was gone, not the message.

## v0.9.0 — Phase 1: Addressability ≠ Presence

- Decouple `send()` addressability from presence: an id is accepted while its record exists **or** its `inbox/<id>/` directory does, so mail to a peer that closed its window queues instead of failing with `E_NO_AGENT`. `stale` now only means "not heartbeating right now".
- Split `expireAfterMs` into `presenceReapMs` (record cleanup, 5 min) and `messageRetentionMs` (undelivered message TTL, 24 h). Presence is allowed to vanish; mail is not.
- Move `dead/` and `quarantine/` out of `inbox/<id>/` to `<home>/dead/<id>/` and `<home>/quarantine/<id>/`, so one dead letter no longer keeps an inbox non-empty and blocks the orphan sweep forever.
- Fix `replyDepth`: the depth of an injected message is stamped into the recipient-owned `processed/<msgid>.json` marker and read back from there. It used to be read from the sender's inbox, whose copy is deleted the moment delivery succeeds, so every reply looked like depth 0 and chains grew without bound.
- Add `Registry.cleanupExpiredMessages()`: drop messages older than `messageRetentionMs` from `inbox/`, `dead/` and `quarantine/`.

## v0.8.0 — Rename and attribution

- Rename the package to `@vdrsl/opencode-agentmesh`, because the unscoped name belongs to the original author. Installs must switch to the scoped name; nothing else changed.
- Credit the original author in `README.md` and keep the original copyright in `LICENSE`, as MIT requires.
- Add `sessionID` to every peer, so an agent can tell two chats in one directory apart and stop waiting for a closed one.
- Auto-registered agents are now named `adjective-noun` (`quiet-otter`) hashed from their `sessionID`, instead of the directory name plus `-2`, `-3` suffixes. Deterministic, so a name survives a restart of opencode; set `id` to pin one yourself.
- Tell the model what to do when a peer vanishes mid-send: re-read `agentpost_peers` and try once more, because a restarted session comes back under a new name.

## v0.7.0 — Cleanup

- Remove `activity/<id>` in `Registry.unregister()`, so the owner deletes its own activity marker and the record reaper takes it with it.
- Add `queueRetentionMs` and `Registry.cleanupOrphanedInboxes()`: drop the inbox of a gone agent only when its record is gone, the inbox is empty, and it has been untouched for that long.
- Add `processedRetentionMs` and `Registry.cleanupProcessed()`: age out `processed/<msgid>.json` replay markers by mtime instead of keeping them forever.
- Run all three from the existing one-per-minute sweep, with `orphans_cleaned` and `processed_cleaned` log events.
- Leave `unregisterSession()` deleting nothing: an id can be re-registered, and a non-empty inbox is undelivered work.

## v0.6.0 — Improved tool descriptions and system prompt

- Clarify ambiguous delivery handling, secret-safe messaging, reply-depth limits, and message examples.
- Validate `id` and `to` tool arguments and add `systemPrompt()` regression coverage.

## v0.5.0 — Observability and test hardening

- Add structured JSON-line logging with `off`, `info`, and `debug` levels, safe allowlisted fields, and a deprecated `AGENTMESH_DEBUG=1` fallback.
- Add independent acknowledgement retention with `ackRetentionMs` and environment configuration.
- Add crash-boundary hooks and C1–C6 coverage for claim, handler, acknowledgement, and recovery failures.
- Add a real fake OpenCode HTTP server and eight boundary E2E cases for 204, 404, 409, 500, timeout, busy recovery, duplicate suppression, and deleted sessions.
- Add security coverage for path traversal, Windows reserved IDs, Unicode slug handling, symlinks, forged acknowledgements, recipient/from mismatches, control characters, and oversized messages.
- Harden storage and acknowledgement boundaries without changing delivery, wire, ownership, or tool semantics.
- Document the shared-directory trust model, local replay suppression limitation, and honest asynchronous delivery outcomes.

## v0.3.0 — Crash-safe delivery

- Add lease metadata to claims and recover only expired claims.
- Avoid duplicate injection when an injected acknowledgement already exists.
- Retry failed injections with bounded attempts and dead-letter exhausted messages.
- Add explicit inbox and serialized-message backpressure errors.
- Bound reply-chain depth and expose `in_reply_to` correlation.
- Keep internal claim, retry, and dead-letter fields out of rendered envelopes.

## v0.2.0 — Honest foundation

- Preserve queued inbox messages across unregister, dispose, and expiry.
- Report `accepted` instead of implying completed delivery after OpenCode accepts an async prompt.
- Add schema versioning with permissive legacy v0 reads and quarantine for critical malformed messages.
- Add durable owner identity, incarnation fencing, and host identity metadata.
- Validate path IDs, configuration timing, message recipients, filenames, and message fields.
- Remove `force` from the model-facing registration tool.
- Sanitize control characters in envelope headers.
