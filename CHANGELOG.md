# Changelog

## Unreleased — Phase 3.5: Adaptive delivery
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
