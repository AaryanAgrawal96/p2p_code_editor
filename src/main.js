import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import * as monaco from "monaco-editor";
import { removeAwarenessStates } from "y-protocols/awareness";

// --- Monaco web worker setup ---
// Without this, Vite doesn't know how to bundle Monaco's worker files,
// so Monaco silently falls back to running on the main thread instead
// (this was the source of the "Could not create web worker(s)" warning).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

// --- Yjs setup ---
const ydoc = new Y.Doc();
const provider = new WebrtcProvider("p2p-code-editor-room", ydoc, {
  signaling: ["ws://localhost:4444"],
});
const ytext = ydoc.getText("code");
const ymap = ydoc.getMap("execution");

// My unique peer ID
const myId = ydoc.clientID;

// Tracks the timeout for failure detection
let executionTimeout = null;

// --- Monaco Editor setup ---
const editor = monaco.editor.create(
  document.getElementById("editor-container"),
  {
    value: "",
    language: "python",
    theme: "vs-dark",
    fontSize: 14,
    automaticLayout: true,
  }
);

// --- Sync Yjs → Monaco ---
ytext.observe(() => {
  const currentValue = editor.getValue();
  const newValue = ytext.toString();
  if (currentValue !== newValue) {
    const position = editor.getPosition();
    editor.setValue(newValue);
    editor.setPosition(position);
  }
});

// --- Sync Monaco → Yjs ---
editor.onDidChangeModelContent(() => {
  const editorValue = editor.getValue();
  const ytextValue = ytext.toString();
  if (editorValue !== ytextValue) {
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, editorValue);
    });
  }
});

// --- Peer count ---
provider.awareness.on("change", () => {
  const peerCount = provider.awareness.getStates().size - 1;
  document.getElementById("peers").textContent = `Peers: ${peerCount}`;
});

// --- Leader election ---
function electLeader() {
  const states = provider.awareness.getStates();
  const allIds = Array.from(states.keys());
  return Math.min(...allIds);
}

function isLeader() {
  return electLeader() === myId;
}

// --- Execution function (called by leader only) ---
// Kept separate so we can use async/await without breaking the observer
async function executeCode(requestId) {
  const code = ytext.toString();

  try {
    window.pyodide.runPython(`
      import sys, io
      sys.stdout = io.StringIO()
    `);
    window.pyodide.runPython(code);
    const output = window.pyodide.runPython("sys.stdout.getvalue()");
    const result = output || "(no output)";

    ymap.set("executor", myId);
    ymap.set("runResult", { requestId, output: result });

    // Leader updates its own display directly
    // (observer won't reliably re-fire for your own writes)
    document.getElementById(
      "output"
    ).textContent = `[Executed by peer: ${myId}]\n\n${result}`;
  } catch (err) {
    const result = "Error:\n" + err.message;

    ymap.set("executor", myId);
    ymap.set("runResult", { requestId, output: result });

    document.getElementById(
      "output"
    ).textContent = `[Executed by peer: ${myId}]\n\n${result}`;
  }
}

// --- Unified ymap observer (NOT async) ---
ymap.observe((event) => {
  // Someone hit Run — leader picks it up and executes
  if (event.keysChanged.has("runRequest")) {
    const runRequest = ymap.get("runRequest");
    if (!runRequest) return;

    if (isLeader()) {
      const lastHandled = window._lastHandledRequest;
      if (lastHandled === runRequest.requestId) return;

      // Guard 1: don't re-execute a request that's already been
      // answered. This happens when a brand-new peer syncs the full
      // document history and sees an old runRequest that already
      // has a matching runResult sitting next to it.
      const existingResult = ymap.get("runResult");
      if (existingResult && existingResult.requestId === runRequest.requestId) {
        window._lastHandledRequest = runRequest.requestId;
        return;
      }

      // Guard 2: don't execute a request whose original requester
      // has since disconnected. CRDTs preserve state forever, so an
      // abandoned, never-fulfilled runRequest can sit in the doc and
      // get inherited by a peer that joins much later — even though
      // nobody is actually waiting for that output anymore.
      const stillConnected = provider.awareness
        .getStates()
        .has(runRequest.requestedBy);
      if (!stillConnected) {
        window._lastHandledRequest = runRequest.requestId;
        return;
      }

      window._lastHandledRequest = runRequest.requestId;

      // Defer to next tick so Yjs finishes broadcasting this
      // transaction over the network before we block the thread.
      setTimeout(() => executeCode(runRequest.requestId), 0);
    }
  }

  // Result arrived — non-leaders update their display
  if (event.keysChanged.has("runResult")) {
    const runResult = ymap.get("runResult");
    if (!runResult) return;

    // Cancel failure timeout — result arrived in time
    if (executionTimeout) {
      clearTimeout(executionTimeout);
      executionTimeout = null;
    }

    // Leader already updated its own display inside executeCode
    // Only non-leaders need to update here
    if (!isLeader()) {
      const executor = ymap.get("executor");
      document.getElementById(
        "output"
      ).textContent = `[Executed by peer: ${executor}]\n\n${runResult.output}`;
    }
  }
});

// --- Run button ---
document.getElementById("runBtn").addEventListener("click", () => {
  if (!window.pyodide) {
    document.getElementById("output").textContent =
      "Still loading Python runtime, please wait...";
    return;
  }

  const requestId = `${myId}-${Date.now()}`;

  // Clear any existing timeout
  if (executionTimeout) clearTimeout(executionTimeout);

  // IMPORTANT: set this BEFORE ymap.set below.
  // If we are the leader, ymap.set triggers the observer synchronously,
  // which runs executeCode() to completion (no internal await) and writes
  // the real result to the screen immediately. If "waiting..." were set
  // after ymap.set, it would overwrite that real result.
  document.getElementById("output").textContent =
    "Run requested, waiting for executor...";

  // Start failure detection — if no result in 30s, evict the dead
  // leader's awareness entry ourselves (don't wait for Yjs's own
  // ~30s cleanup), then re-elect and retry
  executionTimeout = setTimeout(() => {
    const currentResult = ymap.get("runResult");
    const currentRequest = ymap.get("runRequest");

    if (
      !currentResult ||
      currentResult.requestId !== currentRequest?.requestId
    ) {
      const suspectedDeadLeader = electLeader();

      // Never evict ourselves — if we're the only one left,
      // electLeader() will correctly return our own id
      if (suspectedDeadLeader !== myId) {
        removeAwarenessStates(
          provider.awareness,
          [suspectedDeadLeader],
          "execution-timeout"
        );
      }

      document.getElementById("output").textContent =
        "Executor timed out. Re-electing and retrying...";

      ymap.set("runRequest", {
        requestId: `${myId}-${Date.now()}-retry`,
        timestamp: Date.now(),
        requestedBy: myId,
      });
    }
  }, 30000);

  ymap.set("runRequest", {
    requestId,
    timestamp: Date.now(),
    requestedBy: myId,
  });
});

// --- Preload Pyodide on startup ---
window.pyodide = null;
document.getElementById("output").textContent = "Loading Python runtime...";
loadPyodide().then((pyodide) => {
  window.pyodide = pyodide;
  document.getElementById("output").textContent = "Ready.";
});

// --- Debug helpers ---
window.ydoc = ydoc;
window.provider = provider;