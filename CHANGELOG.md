# Changelog

## Unreleased — OpenCode boundary

- Add root PluginInput `session.get`/`session.status` preflight handling for busy, retry, and missing sessions.
- Add prompt timeouts, busy defers, explicit `accepted`/`failed`/`ambiguous` delivery states, and legacy acknowledgement normalization.
- Add a recipient-local processed registry for crash recovery without querying `session.messages`.
- Keep asynchronous prompt delivery diagnostic-only after a real event probe found no completion or failure event.
- Document the verified OpenCode SDK 1.18.32 client and event-stream behavior.

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
