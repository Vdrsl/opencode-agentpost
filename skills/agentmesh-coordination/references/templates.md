# Agent Mesh Message Templates

Ready-made templates for common coordination patterns. Copy, fill placeholders,
and send via `agentmesh_send`.

Task slug: a short lowercase descriptor you create yourself, e.g.
`auth-rate-limit`, `review-token-validation`, `fix-ci-timeout`.
Use it in the `context` field. Do NOT use numeric IDs like T-001.

## Task Delegation

```
agentmesh_send(
  to: "<peer-id>",
  text: "Task: <one-line deliverable>\n\nFiles:\n- <absolute/path/to/file1.ts>\n- <absolute/path/to/dir/>\n\nWhy: <one sentence>\n\nContract:\n- <constraint 1>\n- <constraint 2>\n\nDone means: <acceptance criteria>\n\nReply with the result when done.",
  context: "<task-slug>"
)
```

## Review Request

```
agentmesh_send(
  to: "<reviewer-id>",
  text: "Review request.\n\nChanged files:\n- <path> (lines <start>-<end>): <what changed>\n- <path> (lines <start>-<end>): <what changed>\n\nWhy: <reason for change>\n\nContract to check against:\n- <requirement 1>\n- <requirement 2>\n\nPlease review and reply with APPROVE, REQUEST_CHANGES, or NEED_CONTEXT.",
  context: "review-<task-slug>"
)
```

## Review Response — Approve

```
agentmesh_send(
  to: "<requester-id>",
  text: "APPROVE\n\nReviewed: <file list>\nNo blocking issues against the stated contract.",
  context: "review-<task-slug>",
  in_reply_to: "<original msg id>"
)
```

## Review Response — Request Changes

```
agentmesh_send(
  to: "<requester-id>",
  text: "REQUEST_CHANGES\n\n1. <file>, lines <range>: <issue>. Suggested fix: <fix>.\n2. <file>, lines <range>: <issue>. Suggested fix: <fix>.\n\nRe-request review after addressing.",
  context: "review-<task-slug>",
  in_reply_to: "<original msg id>"
)
```

## Blocker Notification

```
agentmesh_send(
  to: "<peer-id>",
  text: "BLOCKED on <task-slug>.\n\nI cannot proceed because: <reason>.\nI need from you: <specific ask>.\nMy task is paused until your reply.",
  context: "<task-slug>",
  in_reply_to: "<related msg id if any>"
)
```

## Status Update (no reply expected)

```
agentmesh_send(
  to: "<peer-id>",
  text: "Status: <what was done>.\nCommit: <hash or branch>.\nNo reply needed.",
  context: "<task-slug>"
)
```

## Declining a Request

```
agentmesh_send(
  to: "<peer-id>",
  text: "Cannot take that on: <brief reason>.\nSuggested alternative: <who or what>.",
  context: "<task-slug>",
  in_reply_to: "<original msg id>"
)
```

## Escalation to Human

This is NOT sent via agentmesh. Write directly in your session:

```
ESCALATION
Agents involved: <id1>, <id2>
Issue: <one sentence>
Attempted: <what was tried>
Need: <what decision/access is required>
```
