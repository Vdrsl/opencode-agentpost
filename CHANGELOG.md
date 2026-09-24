# Changelog

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
