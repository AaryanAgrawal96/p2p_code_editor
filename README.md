# P2P Code Editor

A collaborative Python execution environment that runs entirely in the browser — no backend, no container, no server in the execution path. Multiple peers connect directly to each other over WebRTC, edit code together in real time, and execute it via a coordination protocol that elects a single peer to run the code and broadcasts the result to everyone.

## Why this exists

Most "online coding lab" platforms — Replit, CodeSandbox, university coding-lab tools — run your code on a remote container. That's expensive to scale and puts a server in the critical path for every single run.

This project asks: **what if execution never left the browser at all?**

- **WebAssembly (Pyodide)** runs a full Python interpreter client-side.
- **WebRTC** lets browsers talk directly to each other, peer-to-peer.
- **CRDTs (via Yjs)** keep everyone's copy of the code in sync without a central authority resolving conflicts.

Put together: a group of people can open this page, write Python together, and run it — with zero cloud compute involved in either the editing or the execution.

## What's actually novel here (and what isn't)

It's important to be precise about this, because the individual pieces below are well-documented:

- Collaborative text editing via Yjs + WebRTC + Monaco — **documented, multiple existing examples**
- Running Python in-browser via Pyodide — **documented**
- P2P sync over WebRTC using Yjs — **documented**

What doesn't have prior art is the **execution coordination layer**: once code is shared, *who* actually runs it, how does the result reach everyone identically, and what happens if the peer running it disappears mid-execution? That protocol — leader election, result propagation, and failure recovery — is the original contribution of this project, built from scratch with no reference implementation to follow.

## Architecture

```
Layer 1 — Client-side execution
  Pyodide (CPython compiled to WebAssembly) runs Python directly
  in the browser tab. No server touches the code.

Layer 2 — Execution coordination  (the novel part)
  A shared Y.Map holds three fields: runRequest, runResult, executor.
  Any peer can request a run. All peers independently compute the
  same leader (lowest Yjs clientID among connected peers) and agree
  on who executes — with no message exchange needed to decide.

Layer 3 — P2P sync
  Yjs (CRDT) + y-webrtc keep the code editor and the execution
  state in sync across all connected peers, with no central server
  in the data path after the initial WebRTC handshake.
```

### How a "Run" actually works

1. Any peer clicks **Run**. This writes a `runRequest` to the shared document.
2. Every peer runs the same deterministic election: lowest `clientID` wins. No coordination message is needed — everyone arrives at the same answer independently.
3. The elected peer executes the code in its own Pyodide instance and writes the result to the shared document as `runResult`.
4. All peers — including the ones who didn't execute anything — receive that result via CRDT sync and display the identical output.
5. If no result arrives within the timeout window, peers assume the executor died, evict it, and re-elect.

## Tech stack

| Piece | Role |
|---|---|
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | The code editor UI (same engine as VS Code) |
| [Yjs](https://github.com/yjs/yjs) | CRDT for shared text + shared execution-coordination state |
| [y-webrtc](https://github.com/yjs/y-webrtc) | P2P transport layer; also provides peer presence ("awareness") |
| [Pyodide](https://pyodide.org/) | CPython compiled to WebAssembly — runs Python client-side |
| [Vite](https://vitejs.dev/) | Dev server and bundler |

## Engineering challenges actually solved

These were not tutorial-solvable problems — each one required designing a fix from first principles. They're documented here because the reasoning behind them is the actual substance of this project.

### 1. The leader's own click overwrote its own correct result

The Run button set a "waiting..." message *after* triggering the request. Since the leader executes synchronously and Pyodide calls block the main thread, the leader would compute and display the correct result *before* that "waiting..." line executed — which then immediately overwrote the correct output with a stale message.

**Fix:** set the "waiting" message *before* triggering the request, so any synchronous completion happens after it, not before.

### 2. Blocking execution silently prevented the network broadcast

Yjs fires local `.observe()` callbacks *before* it broadcasts a change over the network. When the leader ran a long, synchronous computation inside that callback, it blocked Yjs's own transaction pipeline from ever reaching the step that sends the update to other peers. If the leader then closed mid-computation, other peers never even found out a run had been requested — the message never left the leader's own browser.

**Fix:** defer the actual execution to the next event-loop tick (`setTimeout(fn, 0)`), so Yjs finishes broadcasting the request *before* the thread gets blocked by execution.

### 3. Two independent timeout clocks could disagree

Failure detection used its own timeout to decide when to re-elect a leader. But Yjs's `y-webrtc` awareness module has its *own* internal ~30 second cleanup window before it forgets a disconnected peer. If our timeout fired before Yjs's did, peers would keep re-electing the same disconnected (but not-yet-purged) peer in a loop.

**Fix:** when our own timeout fires, explicitly evict the suspected-dead peer from Yjs's awareness state ourselves (`removeAwarenessStates`), rather than waiting for the library's internal clock to catch up.

## Known limitations

Documented honestly rather than hidden — these are real open problems, not yet fully solved:

- **Zombie request resurrection (partially mitigated, not fully solved).** Because CRDTs preserve state indefinitely, an unresolved `runRequest` left behind by a peer that disconnected mid-execution can be inherited by a *brand-new* peer joining much later, who syncs the full document history and may act on a request nobody is waiting for anymore. Guards were added (skip already-answered requests; skip requests whose original requester has disconnected), which reduced the issue, but a stale request can still surface under some join timings. The principled fix is to explicitly clear or expire `runRequest`/`runResult` once consumed, rather than letting them persist as permanent CRDT state — left as future work.
- **Leader election is non-sticky.** Leadership is recalculated from scratch on every event based on the lowest connected `clientID`. A newly-joined peer with a lower ID can become leader instantly, with no incumbency or handoff.
- **Pyodide runs on the main thread.** Long-running Python code freezes the UI of whichever peer executes it, since there's no Web Worker isolating execution.
- **Single hardcoded room.** All peers currently join the same fixed room name — there's no room creation or joining UI yet.

## Future work

- Move Pyodide execution into a dedicated Web Worker so heavy computation never blocks the UI (this would also eliminate failure mode #2 above structurally, not just work around it)
- Explicit request lifecycle (expiry/clearing) to close the zombie-request gap
- Room creation and sharing UI for multiple independent sessions
- Sharding execution across multiple peers instead of a single elected leader, for a genuinely distributed (not just delegated) execution model

## Getting started

### Prerequisites
- Node.js installed

### Setup

```bash
npm install
```

### Running locally

You need **two terminals**, both from the project root.

**Terminal 1 — dev server:**
```bash
npm run dev
```

**Terminal 2 — local signaling server** (lets peers discover each other before connecting P2P):
```bash
node node_modules/y-webrtc/bin/server.js
```

Then open the dev server URL in two or more browser tabs. Each tab is an independent peer.

### Testing it

**Basic sync check** — type in one tab, confirm it appears in the others.

**Determinism check** — confirms only one peer actually executes:
```python
import random
print("Random number:", random.random())
```
Run it multiple times from different tabs. The number changes between runs, but is identical across all tabs *for the same run* — proof that only the elected leader executes, not every peer independently.

**Failure handling check** — use a deliberately slow computation:
```python
total = 0
for i in range(300000000):
    total += i
print("Done:", total)
```
Run it, then close whichever tab is currently the leader while it's executing. The remaining tab(s) should detect the timeout, evict the dead peer, and re-elect.