export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      // 'credentialless' (not 'require-corp') on purpose — Pyodide is
      // loaded from a third-party CDN (jsdelivr), and 'require-corp'
      // would block any cross-origin resource that doesn't explicitly
      // send a matching CORP header back. 'credentialless' achieves
      // the same cross-origin isolation without that risk.
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
};
