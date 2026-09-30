# Phase 4 Layer 0 — identity inheritance contract

Written before any code, the way the Phase 3.5 race matrix was. The bug is not a
duplicate delivery but a silent loss: recreate a session in the same directory and
it gets a fresh address, and the mailbox of the old address stops being written
to while its contents stay on disk forever.

No code in this phase may be written until this contract is agreed.

## The problem, stated precisely

`Registry.allocateName` derives a name from `sessionID` via `agentName`. A new
session means a new `sessionID`, so it means a new
name. The old name's `inbox/<id>/` still holds mail that a peer will keep sending
to, because that peer only knows the address. Nothing warns anybody: the sender
gets `queued`, the message waits forever, `cleanupExpiredMessages` eventually
drops it, and the peer never learns why.

The comment on that method promises "the same chat keeps its address across
restarts". That is true of a process restart with the same session, and false of
the session being recreated — which is the case that loses mail.

## The rejected solution, and why

Derive the address from the directory (`slugify(basename(directory))`), so one
directory is one address. It reads like a direct fix and it is a rollback: it
reintroduces `workbench-2`, the exact problem `88d4917` removed, because two live
sessions in one directory would collide and fall back to suffixes. Worse, it
contradicts another rule the project already relies on: when a session loses its
address, mail is deliberately **not** carried to the new one, because the new
address may belong to someone else a moment later. Combined, those two rules
mean the left agent's mailbox ends up in the right agent's hands.

The difference that matters: an address must never be *derived* from a shared
scope, and must only ever be *inherited* from one specific dead predecessor.

## Layer 1, point 1: where the address comes from

Unchanged: `agentName(sessionID)`. Names stay session-derived, suffixes stay
reserved for genuine hash collisions. `src/names.ts` keeps its current role.

One extra step at auto-registration, before any name is generated:

1. List the registry records whose `routing.directory` equals this session's
   directory. The field already exists (`src/registry.ts:128`), so this is a
   filter, not new storage.
2. Keep the ones that are *effectively dead* (criterion below).
3. If any remain, take the address of the most recently touched one
   (`mtimeMs`, newest first). That is "whoever was last here".
4. If none remain, allocate a name exactly as today.

A live agent keeps its address and its mailbox. A second live session in the same
directory gets its own name, as today. Nobody takes anything from anybody.

## Layer 1, point 2: when an address may be taken

A new predicate, separate from `statusOf`, because the two answer different
questions. `statusOf` feeds `peers` and means "will this answer soon" — it is
driven by heartbeat age. Address release means "can I safely hold this mailbox".

```
takeable = !pidAlive(pid) || ageMs(recordMtime, now) >= presenceReapMs
```

- A live process that has gone quiet for under `presenceReapMs`: **not** takeable.
  This is the case `status !== "alive"` gets wrong today, and it is why
  `Registry.pickFree` is currently a hole — a hung opencode loses its mailbox to
  whoever registers next.
- A dead process: takeable immediately. No waiting, so restarting a window does
  not cost the mailbox (closes the "quick recreate" question).
- A reused pid: the foreign process sends no heartbeat, so `presenceReapMs`
  reclaims the address anyway. The window is bounded, not eternal.
- This aligns with `reap` (`src/registry.ts:269`), which drops records on the same
  `presenceReapMs`, so the record and the address go together.

**Every path that hands over somebody else's address uses `takeable`, not
`status`.** There are two, and both must change:

- the new predecessor search above;
- `Registry.pickFree`, which today accepts any record
  that is not `alive`. That is the same hole reached by a different route: a
  re-registration could take a hung process's address while the predecessor
  search correctly refuses. `pickFree` answers "may I safely hold this mailbox",
  not "will it answer soon", so it is given `takeable`.

**`statusOf` does not change.** If it became pid-based, `peers` would report a
hung process as `alive` for five minutes and "alive" would stop meaning "answers
promptly". Two predicates, two meanings, kept apart.

Residual risk, accepted and documented: pid reuse plus a new session in that
directory inside the same `presenceReapMs` window can take an address that is
technically still live. Closing it properly means comparing process start time
against `registeredAt`, which is platform-specific. Deferred.

## Layer 1, point 3: what moves with the address

| State | Moves? | Reason |
|---|---|---|
| `inbox/<id>/` | yes | It is the mail. Not moving it is the bug. |
| `activity/<id>` | rewritten | The new owner writes its own, or `idleMs` reports the predecessor's silence. |
| `description` / `metadata` | copied from the predecessor's record | Read at takeover time. No new profile storage. |
| `outbox/<msgid>.json` | no | Written by its owner; `agentmesh_deliveries` filters by `from` anyway. |
| `acks/`, `processed/` | no | Recipient-owned, reaped on their own timers. |

**No profile layer is required.** This is the difference from my earlier draft:
because the address is inherited from a specific record rather than derived from a
directory, the description is available on that record while it still exists. The
documented limitation from `6513925` — a description does not outlive
`presenceReapMs` — still holds afterwards, and stays handled by the prompt telling
the model to re-register. Layer 2 remains deferred.

## Layer 1, point 4: split-brain, and what is currently broken about it

`ownerInstance` + `incarnation` already fence writes: `heartbeat` and
`unregister` check `sameOwner` and raise `E_FENCED`. What is missing is the
consequence.

Today `Mesh.tick` logs `heartbeat_fenced` and keeps going.
The fenced watcher keeps its inbox watcher running and keeps delivering mail into
the session that lost the address. No message is duplicated — one winner per
`msgid` still holds — but the message goes to the wrong session, and the model in
the new session never learns it is not the owner.

Rule: a fenced heartbeat **stops the watcher** for that agent. Fencing becomes a
real primitive instead of a warning. This changes takeover behaviour, so the
fencing tests are updated deliberately, not incidentally.

## Layer 1, point 5: two live sessions in one directory

Unchanged behaviour. Both derive their own names from their own session ids, both
are `alive`, neither touches the other. If one exits and returns, `pickFree`
sees a live foreign record and allocates its own name again.

The consequence must be stated, not engineered away: **a session that loses its
address does not carry its mail to the new one.** Moving mail onto an address that
any other session may claim a second later is worse than leaving it on the
address that is about to be freed. The mail returns when the address does.

## Layer 1, point 6: quick recreate

**This point does not hold, and the reason is worth keeping.** It was written as
"closed by the `takeable` predicate: a closed window leaves a dead pid, so the
address is inherited immediately". Both halves are wrong in the shipped code.

A closed window does not leave a dead pid: the record stores `process.pid`
(`registry.ts:198`), which is the opencode *process*, shared by every session it
hosts. And a close does not even reach `takeable` — `session.deleted`
(`index.ts:137`) runs `unregisterSession` → `Registry.unregister`, which removes
the record outright (`registry.ts:233`). `inheritableAddress` enumerates records,
so with no record there is no candidate, and the predicate is never consulted.

What survives a close is the `pid`; what does not is the record. So quick
recreate only works when the predecessor dies *without* giving up its address —
a crash, not a close. Verified live on 0.13.0, not reasoned about: after killing
the process, `agents/<id>.json` was gone and reappeared only once the next
session auto-registered. The invariant in `AGENTS.md` states the whole case,
including the mailbox that outlives the record with nothing left to address it.

## Concurrent takeover is fenced, not atomic

Two sessions may start at the same instant as the predecessor dies, both find the
same record, and both decide they may have it. Writing `agents/<id>.json` is not
atomic in the way `claimFile` is after the `fs.link` fix: there is no exclusive
create on the record itself. Last write wins, and the loser discovers it on its
next heartbeat.

So the guarantee is **bounded, not immediate**: the loser gets `E_FENCED` and its
watcher stops (point 4), which from that moment means no mail reaches a session
that does not own the address. Between the overwrite and the next heartbeat it
may still deliver a few messages, and that window is a known cost, not an
oversight. Nothing is duplicated either way — one winner per `msgid` still holds.

Closing the window tightly would mean an exclusive claim on the record itself,
the same `fs.link` primitive with a lease, taken before writing. That is a
different level of guarantee and belongs to a later layer unless the tests show
the window bites.

## Bounds of the fix

Inheritance works while the predecessor's record still exists, which is until
`reap` removes it at `presenceReapMs`. Recreate a session after that and there is
no record to inherit from — a new address, and the old mailbox ages out. That is
the same window the address already has today; Layer 4 fixes the common case
(restarted a window, came back in a couple of minutes) and does not invent
persistent addresses. If the soak shows five minutes is short, the fix is a
tombstone record or a larger `presenceReapMs`, decided later with evidence.

## Out of scope for Layer 1

- Changing `statusOf`.
- Touching the busy, retry, dead-letter or quarantine paths.
- Any new storage entity: no profile, no tombstone, no index.
- Names: `src/names.ts`, `agentName`, and the suffix rules are untouched.
- Reply depth, threads, delivery states — Phase 3.5 behaviour is frozen.

## Verification for Layer 1

- New session in a directory whose predecessor is dead inherits its address and
  sees the predecessor's unread mail.
- A hung but live predecessor under `presenceReapMs` keeps its address; a new
  session does not take it.
- A fenced watcher stops delivering, and the fencing tests assert the stop.
- Two live sessions in one directory both keep their own addresses.
- Recreate after `reap` allocates a fresh name, as today.
- Two sessions racing the same dead predecessor: exactly one address and mailbox
  is won, the loser is fenced and its watcher stops, and no mail is delivered to
  the loser after that stop. The window before the next heartbeat is not asserted
  on exact timing.
