# Changelog

## v0.13.0 — Phase 4: Address inheritance
- **Breaking: an id is addressable only while its record exists.** Phase 1 also accepted a bare `inbox/<id>/` directory, on the reasoning that the mailbox outlives the presence record so mail for an away agent can queue. That reasoning only holds while something comes back to read it, and with no record nothing does — inheritance enumerates records, so there is no candidate to inherit the box. The result was `queued` for mail nothing would ever read, and the model believes that status. `send` now answers `E_NO_AGENT` and points at `agentmesh_peers`. A `stale` peer is unaffected and still receives: the record is what decides, not the liveness. Reopening the *same* chat mints the same id again, since the name is hashed from the `sessionID`, so a peer returning to the chat it left is reachable under the familiar address.
- Fix, found on live data: `agentmesh_fetch` reported `hasMore: false` while the recipient's own
  claim was still on disk, so a model that trusted it stopped paging and the message waited for the
  next notification. A `.json.taken` is unread mail that `listJsonFiles` cannot see. Counting every
  claim is not the fix either — a claim another watcher holds is being injected into that session and
  is not ours to fetch, so counting it pages forever. Ownership is the discriminator.
- A fresh session in the same directory claims the address a predecessor left behind, so its mailbox
  survives, along with the description and metadata it was using. The name is still hashed from the
  `sessionID`. The predecessor must have died *without giving up its address* — a crash, not a close:
  `session.deleted` runs `Registry.unregister`, which removes the record, and inheritance enumerates
  records, so a clean close offers no candidate and the mailbox is left with nothing that can address
  it. A record also holds `process.pid` — the opencode process, shared by every session it hosts — so
  two live chats in one process can never take each other's address. Verified live on 0.13.0: after
  killing the process `agents/<id>.json` was gone and came back only when the next session
  auto-registered. Reopening the *same* chat keeps its address regardless, but for a different reason:
  the name is a hash of the `sessionID`, so it is deterministic and no inheritance is involved.
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
- Adaptive delivery: idle with one pending message injects the body as before; two or more produce a single notice and the model calls `agentmesh_fetch` once for the batch. After `fetchFallbackMs` the fallback body-injects whatever is still pending, so a model that ignores the notice still gets its mail.
- `agentmesh_fetch` is now consuming: it claims with the same atomic primitive the injector uses, stamps `processed/<msgid>.json` with `via`, and takes the messages out of the inbox. Returns `hasMore` so a batch larger than `fetchLimit` can be paged through.
- One winner per message id, enforced by the claim itself, so the fetch and the fallback racing for the same file cannot both deliver it.
- Per-sender ordering is preserved by the monotonic ULID the sender already writes. Ordering between different senders is not a protocol guarantee.

Known edge, documented rather than hidden: a message consumed by `agentmesh_fetch` is not delivered again if the session is aborted between the fetch returning and the model acting on it. A direct inject is stronger, because its text is already in the session history.

## v0.11.0 — Phase 3: Fetch & deliveries tools
- Add `agentmesh_deliveries`: read your own outbox entries — recipient, state, timestamp — with optional `to`/`state` filters and a limit.
- Add `agentmesh_fetch`: read-only fallback that returns the inbox messages which were never injected, excluding anything with a `processed/` marker so an already-seen turn is never shown twice.
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
- Tell the model what to do when a peer vanishes mid-send: re-read `agentmesh_peers` and try once more, because a restarted session comes back under a new name.

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
