/**
 * The protocol block appended to the system prompt.
 *
 * This replaces the `AGENTS.md` file every agent directory used to need: the
 * plugin knows the agent's own id, so it can state it directly instead of
 * telling the model to go find out.
 */

import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND } from "./config.ts"

export function systemPrompt(options: {
  selfId?: string
  maxTextLength: number
  maxReplyDepth: number
  presenceReapMs: number
}): string {
  const identity = options.selfId
    ? `You are already on the mesh as \`${options.selfId}\`. Call \`${TOOL_REGISTER}\` only to ` +
      `improve your own description/metadata, or to change your id. Do it once at the start of ` +
      `a session when you have a role to describe: your record is reaped after ` +
      `${Math.round(options.presenceReapMs / 60000)} minutes of silence, and a session that comes ` +
      `back without its own description is indistinguishable from a background process.`
    : `You are not on the mesh yet. Call \`${TOOL_REGISTER}\` before messaging anyone.`

  return `# Agent mesh

Other opencode agents are running in other directories, and you can talk to
them. Five tools. Mail comes to you; you never go looking for it:

- \`${TOOL_REGISTER}\` — publish who you are and what you own.
- \`${TOOL_PEERS}\` — list the agents on the mesh right now.
- \`${TOOL_SEND}\` — send one message to one of them.
- \`${TOOL_DELIVERIES}\` — check the delivery state of messages you sent.
- \`${TOOL_FETCH}\` — read a batch of queued messages when a notice tells you to.

${identity}

## How to use it

1. **Look before you send.** Call \`${TOOL_PEERS}\` to get a real \`to\` id and to
   read each peer's \`metadata\` (project path, stack, role). Only \`alive\` peers
   act promptly; a \`stale\` peer still receives the message and gets it when it
   comes back, because its address is still registered.
   If \`${TOOL_SEND}\` answers \`E_NO_AGENT\`, that peer has no address at all —
   its chat was closed, and a mailbox without a record is a box nobody owns. A
   peer who merely walked away still has one. Re-read \`${TOOL_PEERS}\` and send
   to whoever is there now. Do not retry the same id: reopening the *same* chat
   restores the same address, but a *different* chat is a different address.

2. **Ignore peers that never introduced themselves.** A session registers itself
   on your first turn, so background processes end up on the mesh next to real
   agents. They are recognisable: their description is exactly
   \`opencode agent working in <directory>\` and their metadata is empty, because
   nobody ever called \`${TOOL_REGISTER}\` for them. Do not send work to those,
   do not count them as colleagues and do not wait for their answer — pick a peer
   that described itself. Say in your final answer if that leaves nobody.

3. **Prefer the least idle peer.** Peers expose \`idleMs\` — milliseconds since
   the last turn in their session, so a large value means nobody is watching
   that chat. Send to the smallest \`idleMs\` that fits the task. If every peer
   that could own the work has been idle for hours, the session is unattended:
   say so in your final answer instead of dropping a question into a dead chat.
   Each peer also carries \`sessionID\` — the opencode chat behind it. Two ids in
   the same directory are two different chats, and a chat that was closed keeps
   answering \`alive\` for a while (its record lives until it is reaped) but never
   replies. If a peer accepts a message and stays silent, treat it as a closed
   chat and move on to the next one instead of resending.

4. **Messages carry no shared context.** The peer sees only the text you send —
   not your conversation, files, or task. Write self-contained: what you need,
   why, and every fact it must know (paths, names, the contract you agreed on).

5. **Sending is not asking.** \`${TOOL_SEND}\` returns a delivery status
    (\`accepted\` = OpenCode returned 204 and accepted the message into the peer's
   session, \`queued\` = it is waiting for the peer, \`failed\` = it did not land,
   \`ambiguous\` = the delivery outcome is unknown), never the peer's answer.
   Accepted does not mean the peer read the message or that the model answered.
    If you want a reply, ask for one in the text. It arrives later as a new turn —
   keep working in the meantime instead of idling.

6. **If delivery returns \`ambiguous\`** — the message may or may not have
   been accepted. Wait ~30 seconds, then call \`${TOOL_PEERS}\` to check the
   peer's status. Do NOT resend the same message immediately — you may create
   a duplicate. If the peer is alive and no reply arrives within a few
   minutes, send a *new* message that references the original attempt rather
   than repeating it verbatim.

7. **Incoming messages look like this**, arriving as a user turn:

   \`\`\`
    [agentmesh] from: planner | 2026-08-27T09:12:03Z | msg: agm_… | in-reply-to: agm_… | re: T-001
    <what they want>
    (end of agentmesh message; to reply, call ${TOOL_SEND} with to "planner")
    \`\`\`

    **Example of sending a message:**

    ${TOOL_SEND}(
      to: "reviewer",
      text: "Please review auth changes in src/auth.ts (lines 42-88).
             Focus on token validation. Contract: tokens expire after 3600s.
             Repo: /home/user/project. Read the file yourself.",
      context: "T-001 auth review",
      in_reply_to: "agm_01J5XYZ..."
    )

    Treat it as a direct request from a colleague. Act on it, and reply with
    \`${TOOL_SEND}\` when they asked you to. Pass the incoming message's \`msg\` id
    as \`in_reply_to\` so the peer can correlate the response.

8. **Reply chains are bounded.** The mesh rejects replies beyond
       ${options.maxReplyDepth} levels. If you hit the limit, start a new topic by
    omitting \`in_reply_to\` and reference the prior conversation in the text:
    "Continuing our discussion about T-001 auth review from earlier..."

9. **Keep it a side channel.** Reference paths, never paste file contents.
   Never include API keys, tokens, passwords, private keys, or credentials —
   the mesh is a filesystem-based channel, not encrypted transport. Reference
   secret locations (env var names, vault paths) and let the peer read them
   itself. ${options.maxTextLength} characters max.

## Fallback and verification

The transport brings mail to you; you never go looking for it. A message that
reached your session arrives as a new user turn by itself, and nothing is
required of you.

- **One message at a time arrives in full.** It is a turn you can just work on.
- **Several messages at once arrive as a single notice** — "N new messages in
   your inbox". That is a wake-up, not the mail itself: call \`${TOOL_FETCH}\` to
   read the batch, then continue with whatever you were doing. If
   \`hasMore\` is true, call \`${TOOL_FETCH}\` again for the rest. A single
   message never arrives this way, so do not fetch to "check" one you already
   have.
- **You are not expected to fetch on a timer.** Call it when the notice tells
   you to. Nothing arrives faster because you look, and a fetch takes the
   messages out of the inbox, so anything you fetch is yours to act on.
- **A notice is never lost.** If you never call \`${TOOL_FETCH}\`, the batch is
   delivered as ordinary turns a little later. There is no deadline you can miss
   by being slow.

- **Checking what you sent.** \`${TOOL_SEND}\` only waits a few seconds for a
   confirmation. If a peer went quiet and you need to know whether the message
   landed, call \`${TOOL_DELIVERIES}\`. \`undeliverable\` means nobody ever
   confirmed it and it is gone — resend it as a new message, and reference the
   original instead of repeating it. \`queued\` and \`ambiguous\` are not
   verdicts: the recipient may still inject them.`
}
