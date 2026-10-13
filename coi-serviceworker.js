/* coi-serviceworker — compact known-good version.
 * Injects Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers
 * so that SharedArrayBuffer (needed by ffmpeg.wasm multi-thread core) works
 * on static hosts that don't let you set response headers (e.g. Render Static).
 * Self-registers when loaded via <script src="coi-serviceworker.js"></script>.
 */
let coepCredentialless = false;

if (typeof window === "undefined") {
  // ---- Service worker context ----
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (event) => {
    if (event.data === "deregister") {
      self.registration.unregister().then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((c) => c.navigate(c.url)));
    } else if (event.data && typeof event.data.coepCredentialless === "boolean") {
      coepCredentialless = event.data.coepCredentialless;
    }
  });

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
    const request = (coepCredentialless && req.mode === "no-cors")
      ? new Request(req, { credentials: "omit" }) : req;
    event.respondWith(
      fetch(request).then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy",
          coepCredentialless ? "credentialless" : "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }).catch((err) => console.error("[coi-serviceworker] fetch failed:", err))
    );
  });
} else {
  // ---- Main thread: auto-register ----
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    if (window.crossOriginIsolated && reloadedBySelf !== "coi") {
      console.log("[coi-serviceworker] already crossOriginIsolated, skipping registration");
      return;
    }
    if (!("serviceWorker" in navigator)) {
      console.warn("[coi-serviceworker] serviceWorker not supported");
      return;
    }
    const src = window.document.currentScript && window.document.currentScript.src;
    if (!src) return;
    navigator.serviceWorker.register(src).then(
      (registration) => {
        console.log("[coi-serviceworker] registered:", registration.scope);
        registration.addEventListener("updatefound", () => {
          window.sessionStorage.setItem("coiReloadedBySelf", "coi");
          window.location.reload();
        });
        if (registration.active && !navigator.serviceWorker.controller) {
          window.sessionStorage.setItem("coiReloadedBySelf", "coi");
          window.location.reload();
        }
      },
      (err) => console.error("[coi-serviceworker] registration failed:", err)
    );
  })();
}
