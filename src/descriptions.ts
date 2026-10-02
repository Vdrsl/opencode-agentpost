/**
 * The model-facing text of the tools, in one place, because there are two
 * runtimes to serve and the tool descriptions are behaviour, not documentation:
 * the model reads them as instructions. A v1 build and a v2 build that described
 * the same tool differently would be two projects wearing one name, and nothing
 * would fail — the difference would simply show up as two agents behaving
 * differently depending on which opencode loaded them.
 *
 * Nothing here imports an opencode package. The tool schemas differ per runtime
 * (zod-ish in v1, JSON Schema in v2) but the words must not, so this module is
 * the one place the two runtimes are required to agree.
 */

import { TOOL_DELIVERIES, TOOL_FETCH, TOOL_PEERS, TOOL_REGISTER, TOOL_SEND } from "./config.ts"

export const REGISTER_DESCRIPTION = `Publish this agent on the mesh so other opencode agents can discover and message it. Call it once near the start of a session, and again whenever your role or scope changes.

Arguments:
- id: stable short slug peers address you by. Example: "api-gateway".
- description: one line covering what you do and which repo/area you own. Example: "Owns the REST API in /repo/api; handles auth and rate limiting."
- metadata: free-form string map shown to peers. Example: {"repo": "/repo/api", "stack": "node+express", "role": "backend", "focus": "auth module"}.

Returns your own entry plus everyone else currently on the mesh.`

export const PEERS_DESCRIPTION = `List the agents on the mesh with live state: id, description, metadata, status (alive/stale), lastSeen, idleMs, directory, sessionID.
Use it to (1) get a valid "to" before ${TOOL_SEND}, (2) check whether a peer is still alive before or after sending, and (3) read peer metadata — project path, stack, role — to decide who a piece of work belongs to.
A stale peer is not gone: messages queue and are accepted when it returns.
idleMs is ms since that peer's last session turn: prefer the smallest value that fits the task, and treat an hours-old one as an unattended chat. Peers are returned least-idle first, alive before stale. lastSeen is a heartbeat and reads the same for every live peer, so it does not order the list.
sessionID is the opencode chat behind the record: several ids in one directory are several chats, and a closed chat stays alive until its record is reaped but never answers. If a peer accepts a message and stays silent, move on to another peer instead of resending.
A peer nobody introduced — description exactly "opencode agent working in <directory>" and empty metadata — is a background process that registered itself, not a colleague. Do not delegate to it; choose a peer that described itself.`

export const SEND_DESCRIPTION = `Send one message to another registered agent. It is injected into that agent's opencode session as a new user turn.
This returns a delivery status, NOT the peer's answer: "accepted" (OpenCode admitted the message into the peer's session queue), "queued" (waiting for them to come back), "failed" (it could not be injected), "ambiguous" (the delivery outcome is unknown). Accepted does not mean the peer read the message or that the model answered.
The peer sees NO context from your session — write self-contained: what you need, why, and every referenced fact (absolute paths, agreed contract). To get an answer, ask for one explicitly; it arrives later as a new turn, so keep working instead of waiting.
A peer whose session is busy reports "queued": the message stays in its inbox and is injected as soon as that session goes idle. That is normal — do not resend it.
"queued" means the agent is registered and the message has a reader: it arrives when that session goes idle, or when the agent comes back. A peer whose window was closed reports no address at all, because there is nobody to deliver to — ${TOOL_SEND} fails with E_NO_AGENT. Read the registered ids from ${TOOL_PEERS} and send to one of those instead. Do not retry the same id: a closed chat gets a new one when it is reopened.
"stale" means not heartbeating right now, not gone, and a stale peer still receives.
Use context as a short topic tag (e.g. "T-001 contract"). If no reply comes within a few minutes, check ${TOOL_PEERS} before re-sending.`

export const DELIVERIES_DESCRIPTION = `Check what became of the messages you sent: id, recipient, delivery state, timestamp. Newest first.
States: "queued" (in the recipient's inbox, no confirmation yet), "accepted" (OpenCode admitted it as a user turn in their session), "failed" (they got it but could not inject it), "ambiguous" (outcome unknown), "undeliverable" (nobody confirmed before it aged out).
Use it when a peer went quiet and you need to know whether the message landed, before resending anything. Do not poll it in a loop.`

export const FETCH_DESCRIPTION = `Read the messages waiting in your inbox and take them out of it. Call this when you get a notice saying "N new messages in your inbox" — that notice is a wake-up, not the mail itself.
A single message never arrives as a notice; it arrives as a full turn, so there is nothing to fetch in that case.
Returns the oldest messages first, and "hasMore": true when more are still queued — call again if so.
This is not a polling tool: the transport tells you when there is mail, and polling does not make anything arrive sooner. Taking a message out of the inbox means you own it; if you fetch and then do not act on what you read, it is not delivered again. Returns an empty list when there is nothing waiting.`
