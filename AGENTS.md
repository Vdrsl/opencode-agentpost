# AGENTS.md

`@vdrsl/opencode-agentmesh` — an opencode **plugin** (not an MCP server, not an app) that gives
opencode sessions in different directories/servers peer-to-peer messaging. Published to npm
from `src/` → `dist/`. Entrypoint: `src/index.ts` (default export `AgentMesh: Plugin`).

## Commands

```bash
npm run typecheck                                        # tsc --noEmit
npm test                                                 # node --test on test/*.test.ts
npm run build                                            # emits dist/ (also runs on prepublish)
node --test --experimental-strip-types test/mesh.test.ts  # single file
node --test --experimental-strip-types --test-name-pattern="burst" test/mesh.test.ts
npm pack --dry-run                                      # verifies the published file set
```

- Node >= 22 required: tests run TypeScript directly via `--experimental-strip-types`.
- **`npm run typecheck` does not cover `test/`** — `tsconfig.json` has `include: ["src/**/*.ts"]`.
  Type errors in tests only surface at runtime (type stripping erases types without checking).
  Run both `npm run typecheck` and `npm test` before calling work done.
- No linter or formatter is configured, and there is no CI. Verification is typecheck + tests only.

## Code conventions that will bite you

- **Internal imports use explicit `.ts` extensions** (`import { Mesh } from "./mesh.ts"`).
  This is deliberate: `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` make `tsc`
  emit `./mesh.js` in `dist/`, while tests import the same `.ts` paths under type stripping.
  Never "fix" these to `.js`.
- `verbatimModuleSyntax: true` — type-only imports must use `import type` / `type` specifiers.
- `noUncheckedIndexedAccess: true` — array/record indexing yields `T | undefined`. Env reads use
  bracket syntax (`process.env["AGENTMESH_DEBUG"]`) throughout; keep that style.
- Style (unenforced, so match it by hand): no semicolons, double quotes, 2-space indent, ~100 cols.
- Every file in `src/` opens with a block comment explaining **why** the module exists and what
  invariant it holds. Keep that when adding files; these headers are the real design docs.

## Architecture: the invariants worth protecting

There is **no daemon, no port, no lock**. All coordination happens through one home directory
(`$AGENTMESH_HOME`, else `$XDG_DATA_HOME/opencode-agentmesh`, else `~/.local/share/opencode-agentmesh`):

```
<home>/agents/<id>.json        one record, written ONLY by its owner
<home>/activity/<id>          last session turn of <id>, touched ONLY by its owner
<home>/inbox/<id>/<msgid>.json messages for <id>, written by senders
<home>/dead/<id>/<msgid>.json  undeliverable messages, written by the recipient
<home>/quarantine/<id>/        malformed messages, written by the recipient
<home>/acks/<msgid>.json       delivery ack, written by the recipient
<home>/processed/<msgid>.json local recipient marker after successful injection or fetch
<home>/outbox/<msgid>.json      the sender's own copy: state of one sent message
```

Correctness rests on facts that are easy to break accidentally:

- **Ownership partitioning replaces locking.** An agent writes only its own record; a sender writes
  only into the recipient's inbox; only the recipient writes acks. Any new feature that writes
  another agent's file breaks the concurrency model.
- **Delivery is pull-side.** A sender never touches the peer's session. The recipient's own plugin
  watches its inbox and injects via its own authenticated client (`client.session.promptAsync`),
  which is why messages cross opencode servers, auth and restarts. See `src/inbox.ts`.
- **All writes are atomic** (temp file + `rename`, `src/store.ts`). Reads treat missing/corrupt
  files as normal and return `undefined` — peers come and go; discovery must never throw.
- **Claiming is `fs.link` to `*.json.taken`, then dropping the pending name** (at-most-once
  injection). It must stay `fs.link` and never go back to `rename`: on Windows two concurrent renames
  of one source both succeed, measured, so two delivery paths could each believe they owned the same
  message. A hard link is exclusive by definition, `EEXIST` is the normal losing outcome, and a crash
  between link and drop leaves two names on one inode — same file, not two copies, which
  `recoverClaimed` consolidates. Orphaned claims from a crashed process are restored on watcher start
  (`InboxWatcher.recoverClaimed`).
- **Recovery consolidates two names only in the branch that takes the claim over.** A crash between
  link and drop leaves the pending name as the lie, and dropping it is what stops every later drain
  from losing a claim race against it forever. But it may only be dropped once recovery is actually
  taking over: a claim it declines (the lease is still live, or the ctime is too young) must keep the
  pending name. A lone `*.json.taken` is not a `*.json` file, so `drain` sees no message to lose a
  claim against, and `recoverClaimed` — which only runs from `start()` or from that "nothing could be
  claimed" branch — is never entered again. Dropping it early strands the message in a directory that
  looks empty. Caught by C7, and C9 used to assert the stranding as correct.
- **Local processed markers suppress replay after a successful injection.** They are recipient-owned
  state under `<home>/processed/`; recovery checks them before reinjecting an orphaned claim.
- **Liveness = record mtime + pid check.** Heartbeat is `fs.utimes` only, never a rewrite
  (`store.touch`). `pidAlive` makes a killed opencode stale immediately instead of after 60s.
- **Addressability is not presence.** `send()` accepts an id while either its record exists or its
  `inbox/<id>/` directory does (`Mesh.inboxDirExists`), so mail to an agent that closed its window
  queues instead of failing with `E_NO_AGENT`. `presenceReapMs` drops the record; the mailbox
  outlives it on purpose. `stale` means "not heartbeating right now", never "undeliverable".
- **`dead/` and `quarantine/` live outside `inbox/<id>/`.** Inside, a single dead letter would keep
  the inbox non-empty forever, and an inbox is only reaped when it is empty. That's the whole reason
  for `<home>/dead/<id>/` and `<home>/quarantine/<id>/`.
- **Reply depth is read from `<home>/processed/`, never from the sender's inbox.** The inbox copy is
  deleted the moment delivery succeeds, so reading depth from it always returned 0 and let a reply
  chain grow without bound. `deliverOne` stamps the depth into the processed marker and
  `readProcessedDepth` reads it back; a marker without `depth` is 0.
- **A thread is its root message id, carried in the same processed marker.** `threadId` on a reply
  comes from the recipient's own marker (`readProcessedThreadId`), falling back to the parent id when
  the parent predates threads — which forks a thread mid-conversation rather than losing the link.
  No coordination exists by design: everyone derives the same root from the id chain.
- **The sender keeps `<home>/outbox/<msgid>.json`, and only the sender writes it.** The inbox is the
  recipient's copy and an ack lives only for `ackRetentionMs`, so without an outbox a sender forgets
  its own message within minutes. The state is *what we last heard*, never an assumption, and
  `writeOutboxEntry` refuses to walk a finished state backwards. `sweepOutbox` takes the ack as the
  word on the outcome — a busy recipient acks long after `ackWaitMs` gave up, and only the sweep
  can move a delivered message off `queued` — and turns an entry that never got a verdict into
  `undeliverable` before deleting it a window later: the recipient was gone, not the message. Any
  new per-message state follows this split, not a shared file.
- **Reading the mailbox is never the delivery path.** Injection is: the recipient's own watcher
  claims a message, injects it, stamps `processed/<msgid>.json` and only then deletes the inbox
  copy. `agentmesh_fetch` is the consuming escape hatch for a batch the watcher could not inject
  (a busy session, or a crashed one), and it **excludes anything with a processed marker**, so a
  model can never be shown a turn it already saw. `agentmesh_deliveries`
  reads `outbox/` filtered by the entry's `from` — that field is the only reason a shared outbox
  directory can stay owner-private, so write it on every entry.
- **One winner per `msgid`, and the batch decision is made on claims, never on a readdir count.** A
  count is a stale read, so `drain` claims up to `fetchLimit` files first and then looks at what it
  holds. The claim primitive is what makes this hold across `fetch` and the fallback racing for the
  same files; a lost claim is `EEXIST`, never an error.
- **`hasMore` counts our own claims, not every claim.** A `.json.taken` is unread mail that
  `listJsonFiles` cannot see, so counting only `*.json` told a fetching model `hasMore: false`
  while our own claim sat on disk — it stopped paging and the message waited for the next
  notification. Counting every `.taken` is not the fix: a claim another watcher holds is being
  injected into that session and is not ours to fetch (mid-inject takeover), so counting it pages
  forever. Ownership is the discriminator — `ownerInstance` on the claim.
- **Adaptive delivery: idle + 1 pending → inject the body; ≥2 → one notification, no bodies.** The
  notification is a wake-up, not a message: no `msgid`, no `processed` marker, no ack. `notifiedAt`
  (M6) is per-watcher in-memory state doing two jobs — suppressing a repeat notification while the
  batch is unresolved, and anchoring the `fetchFallbackMs` fallback deadline. It is deliberately not
  persisted: a restart re-notifies, which is faster, never lossy. Anything still `pending` when the
  deadline passes is body-injected, which is the old reliable path.
  **A batch needs a busy recipient by construction, not by configuration.** One message is claimed and
  injected before a second can arrive, so an idle recipient never batches: a soak that fires two sends
  seconds apart sees `via: inject` twice and exercises nothing. To see the batch path, the recipient has
  to be mid-turn so the first claim defers, and the second message lands inside `busyDeferMs`.
- **A message consumed by `fetch` is consumed for good.** The marker is written before the file is
  removed, so a crash in between is a no-op rather than a redelivery. The cost is honest: unlike an
  inject, whose text lands in the session history as a user turn, a fetch result lives inside a
  turn that can be aborted — so a message taken by `fetch` and not acted on before an abort is not
  recovered. That is the one place fetch delivery is weaker than injection, and it is a deliberate
  trade, not an oversight.
- **Activity is a separate `utimes` file, `<home>/activity/<id>`.** It is touched on every
  `chat.message` and `session.idle`, never a rewrite of `agents/<id>.json` — a rewrite would
  open a rename window where a peer's `list()` sees ENOENT and the peer vanishes. Peers read it
  as `PeerView.idleMs` (fallback: record mtime), because a live process says nothing about whether
  anyone is at the keyboard. `peers()` sorts alive → least idle → stale, id as tie-break: that
  ordering is the feature, so keep it when changing the query.
- **Message ids are ULIDs prefixed `agm_`, monotonic per process** (`src/ids.ts`). FIFO ordering
  comes solely from inbox filenames sorting lexicographically. Changing the id format silently
  breaks message ordering.
- **Agent ids are `adjective-noun`, hashed from the `sessionID`** (`src/names.ts`,
  `Registry.allocateName`), not from the directory and not from a random source. Deterministic on
  purpose: a name that changed on every restart would orphan the peer's inbox and drift the address
  other agents send to. `Registry.pickFree` walks `attempt` past a name a live peer holds; an
  explicit `config.id` bypasses naming entirely (`Mesh.autoRegister` → `allocateId`).
- **Inheritance covers a session that died *without giving up its address*, and nothing else.**
  (`Registry.inheritableAddress`, `Registry.takeable`.) The name is hashed from the `sessionID`, so a
  new `sessionID` would otherwise orphan the mailbox. A fresh session in the same
  `routing.directory` takes the most recent address whose owner is gone — `takeable` is
  `!pidAlive(pid) || ageMs(recordMtime) >= presenceReapMs`, deliberately *not* `status`: a hung process
  keeps heartbeating and looks alive for the whole `presenceReapMs`, and `stale` would add `staleAfterMs`
  on top. `pickFree` uses `takeable` too, for the same reason; both paths that hand out an address must
  agree, or a hung peer holds a name forever. Description and metadata come across with the address,
  which is why no separate identity profile exists.
  **A clean session close is not that case.** `session.deleted` runs `unregisterSession` →
  `Registry.unregister`, which removes the record, and inheritance enumerates records — so with no
  record there is no candidate, and it *cannot* fire on Ctrl+C or a closed window. Worse, the mailbox
  survives that unregister (nothing touches `inbox/<id>/`), so `send` keeps accepting the address
  (`Mesh.inboxDirExists`) and queues mail into a box no future session will ever read, because
  `cleanupOrphanedInboxes` only reaps an *empty* one. Verified live on 0.13.0, not reasoned about: the
  record was gone after close, so the address was never offered. Testing inheritance needs a death
  that leaves no `session.deleted` — a crash, not a close.
- **Ownership of a mailbox is decided by the record, and a loser stands down.** The record is a plain
  atomic rewrite, not a `fs.link` claim: last write wins, and the loser learns it lost on its next
  heartbeat, at which point `tick` stops the watcher (`heartbeat_fenced` →
  `unregisterSession`). Until that heartbeat the fenced watcher can still deliver — a documented window,
  not a defect. Mail in a lost address's mailbox is **not** forwarded to the new address: a new address
  may itself be claimed later, and moving mail across addresses is how mail ends up read by a stranger.
- **A heartbeat that comes back `missing` is not a fence, and must not stop the watcher.** `heartbeat`
  returns `"ok" | "missing" | "fenced"` because the two failures mean opposite things: `fenced` is
  another session's address now, while `missing` is a record some other mesh's sweep reaped while this
  session was blocked past `presenceReapMs` — nobody claimed the address. The mailbox outlives the record
  and is still addressable, so stopping on `missing` would leave peers queueing mail that nobody ever
  reads: the same orphan-mailbox bug the record/mailbox split exists to prevent. `Mesh.reRegister`
  writes the record back, keeping the description and metadata the session had introduced itself with,
  and deliberately without `force` — `register` refuses when a live session holds the address, and that
  refusal *is* the fence, which then goes down the fenced path. Collapsing `missing` into `fenced` is
  how a session silently goes dark while its inbox keeps filling.
- **Address inheritance is only as good as the home it was pointed at, and it fails quietly.** It
  looks the predecessor up by `routing.directory`, so a probe given its own temp home sees an empty
  registry, mints a new name, and reports the recreation as fine while the real mailbox sits orphaned.
  Same trap when a probe builds state under an invented id: the name is hashed from the `sessionID`,
  so `inbox/soak-claim/` is not where a watcher registered as `concurrent-folder` will look. Take the id
  from `selfId()` *after* auto-registration, and run the probe against one shared home. And set up claim
  state before the watcher exists — a running watcher claims the message and delivers it before you can
  stage the lease, and the test passes without touching the branch you meant to exercise. A refused
  claim gives that deterministically: fail the first handler call through the `afterClaim` crash hook.
- **A custom `description`/`metadata` does not outlive the presence record.** After
  `presenceReapMs` of silence (five minutes by default) the record is reaped, and auto-registration
  falls back to the generated description, so an agent that comes back is indistinguishable from a
  background process that never introduced itself. This is deliberate: the record is ephemeral by
  design, and persisting the description would glue back together what Phase 1 separated. The fix
  is one `agentmesh_register` call, so `prompt.ts` tells the model to make it when it has a role and
  sees the default description. If it proves to bite in practice, it belongs with identity in
  Phase 4, not as a one-off here.
- **One plugin instance can host several sessions** (multiple opencode sessions in one directory).
  `Mesh` keeps a `sessionID -> {id, routing, watcher}` map, one watcher per session, one shared
  heartbeat/reap timer. Nothing may assume a single agent per process.
- `fs.watch` is best-effort; `pollIntervalMs` is the safety net for events macOS drops and for
  messages that landed while the process was down. Don't remove the poll.
- **Cleanup is conservative on purpose.** One sweep per minute (`Mesh.tick`, `REAP_INTERVAL_MS`)
  runs `registry.reap`, `reapAcks`, `cleanupOrphanedInboxes`, `cleanupExpiredMessages`,
  `cleanupProcessed`, `sweepOutbox`. Deletion rules: `agents/<id>.json` goes after
  `presenceReapMs` of silence;
  `activity/<id>` goes only in `Registry.unregister()` (which `reap` also goes through);
  `inbox/<id>` goes only from `cleanupOrphanedInboxes`, only when the agent has no record, the
  inbox is empty, and its mtime is older than `queueRetentionMs`. `unregisterSession()` must never
  delete an inbox — the id can be re-registered by the next session in that directory, and a
  non-empty inbox is undelivered work. Individual messages in `inbox/`, `dead/` and `quarantine/`
  are dropped by mtime after `messageRetentionMs`, which is the only bound on queued mail.
  `processed/<msgid>.json` is reaped by mtime after `processedRetentionMs`, which is exactly how
  long replay suppression lasts. `outbox/<msgid>.json` is aged on the `messageRetentionMs` window:
  finished entries go, unfinished ones become `undeliverable` first.

## Plugin-specific gotchas

- Session identity (`sessionID`, `directory`, `worktree`, `serverUrl`) always comes from the tool
  context / plugin input — never ask the model for it (`src/tools.ts` header explains why).
- The opencode SDK reports transport failures in `result.error` rather than throwing
  (`ThrowOnError = false` by default). `src/index.ts:39-41` checks it manually; do the same for any
  new SDK call.
- `src/prompt.ts` and the tool descriptions in `src/tools.ts` are injected into other models'
  prompts. They are behavioural spec, not comments — edit them with the same care as code.
- Config precedence: `AGENTMESH_*` env > plugin options > defaults (`resolveConfig`, `src/config.ts`).
- Structured logging is opt-in with `AGENTMESH_LOG_LEVEL=off|info|debug`; output is JSON lines with fixed events and allowlisted numeric/boolean fields. `AGENTMESH_DEBUG=1` is a deprecated info fallback.
- Installed by users as `{ "plugin": ["@vdrsl/opencode-agentmesh"] }`, or with options as
  `{ "plugin": [["@vdrsl/opencode-agentmesh", { "id": "…" }]] }`.

## Testing notes

- `test/helpers.ts` builds a `Mesh` whose `inject` just appends to an array; everything else
  (temp home via `fs.mkdtemp`, real `fs.watch`, real atomic writes) is real.
- `test/mesh.test.ts` runs **two `Mesh` instances over one home directory** — that is the
  simulation of two separate opencode processes, and it is the test that matters.
- `test/e2e.test.ts` uses the real `InboxWatcher` against a local fake OpenCode HTTP server; keep
  its status mapping and abort signal path aligned with the root SDK boundary.
- `test/crash-matrix.test.ts` owns crash-hook state assertions; `test/security.test.ts` owns ID,
  acknowledgement, storage, envelope, and recipient-boundary regressions.
- Tests are wall-clock sensitive: helpers force `pollIntervalMs: 50`, and cases override
  `ackWaitMs`/`maxTextLength` via `twoAgents({ … })`. The burst-ordering test takes ~1s by design;
  the suite is ~2s total. Don't add sleeps; use `waitFor` from `test/helpers.ts`.

## Security and limitations

**The home directory is trusted. The mesh is not an authorization boundary.** Any process that can
write there can forge a registration, a message, an acknowledgement or a processed marker, because
every one of those is a plain file written directly — validation inside the mesh never sees them.
That is why an inbound policy (`accept`/`auto`/`hold`/`refuse`) was rejected rather than deferred: it
filters only callers who already follow the rules, which is to say our own peers. A rule as narrow as
"only from registered senders" fails the same way — a stranger simply writes itself an
`agents/<id>.json` and is registered. The boundary is the filesystem permissions on the home
directory and the operator's judgment, not anything in `src/`. If the mesh ever spans machines or
untrusted users, this model is rebuilt from scratch: sender signatures, real authorization,
authenticated transport. Not a mail filter. `maxInboxMessages`/`maxInboxBytes` are robustness against
flooding, not security.

Local `processed/` markers suppress replay after a successful injection but do not make the
filesystem handoff transactional or exactly-once. `accepted` confirms asynchronous prompt
acceptance, not peer comprehension; `ambiguous` outcomes require operator judgment. Keep security
tests and the fake HTTP boundary tests in the same suite when changing storage or acknowledgements.
