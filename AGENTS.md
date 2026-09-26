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
<home>/acks/<msgid>.json       delivery ack, written by the recipient
<home>/processed/<msgid>.json local recipient marker after successful injection
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
- **Claiming is `rename` to `*.json.taken`** (at-most-once injection). Orphaned claims from a
  crashed process are restored on watcher start (`InboxWatcher.recoverClaimed`).
- **Local processed markers suppress replay after a successful injection.** They are recipient-owned
  state under `<home>/processed/`; recovery checks them before reinjecting an orphaned claim.
- **Liveness = record mtime + pid check.** Heartbeat is `fs.utimes` only, never a rewrite
  (`store.touch`). `pidAlive` makes a killed opencode stale immediately instead of after 60s.
- **Activity is a separate `utimes` file, `<home>/activity/<id>`.** It is touched on every
  `chat.message` and `session.idle`, never a rewrite of `agents/<id>.json` — a rewrite would
  open a rename window where a peer's `list()` sees ENOENT and the peer vanishes. Peers read it
  as `PeerView.idleMs` (fallback: record mtime), because a live process says nothing about whether
  anyone is at the keyboard. `peers()` sorts alive → least idle → stale, id as tie-break: that
  ordering is the feature, so keep it when changing the query.
- **Message ids are ULIDs prefixed `agm_`, monotonic per process** (`src/ids.ts`). FIFO ordering
  comes solely from inbox filenames sorting lexicographically. Changing the id format silently
  breaks message ordering.
- **One plugin instance can host several sessions** (multiple opencode sessions in one directory).
  `Mesh` keeps a `sessionID -> {id, routing, watcher}` map, one watcher per session, one shared
  heartbeat/reap timer. Nothing may assume a single agent per process.
- `fs.watch` is best-effort; `pollIntervalMs` is the safety net for events macOS drops and for
  messages that landed while the process was down. Don't remove the poll.
- **Cleanup is conservative on purpose.** One sweep per minute (`Mesh.tick`, `REAP_INTERVAL_MS`)
  runs `registry.reap`, `reapAcks`, `cleanupOrphanedInboxes`, `cleanupProcessed`. Deletion rules:
  `activity/<id>` goes only in `Registry.unregister()` (which `reap` also goes through);
  `inbox/<id>` goes only from `cleanupOrphanedInboxes`, only when the agent has no record, the
  inbox is empty, and its mtime is older than `queueRetentionMs`. `unregisterSession()` must never
  delete an inbox — the id can be re-registered by the next session in that directory, and a
  non-empty inbox is undelivered work. `processed/<msgid>.json` is reaped by mtime after
  `processedRetentionMs`, which is exactly how long replay suppression lasts.

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

The shared home directory is trusted storage, not encrypted transport or an authorization boundary.
Local `processed/` markers suppress replay after a successful injection but do not make the
filesystem handoff transactional or exactly-once. `accepted` confirms asynchronous prompt
acceptance, not peer comprehension; `ambiguous` outcomes require operator judgment. Keep security
tests and the fake HTTP boundary tests in the same suite when changing storage or acknowledgements.
