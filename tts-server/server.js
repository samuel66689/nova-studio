// nova-tts — server-side Microsoft Edge TTS proxy.
// Why server-side: browser-side Edge TTS exposes the user's IP (VPN exit IPs
// get blocked); the maintained `edge-tts` Python library handles Microsoft's
// rotating TrustedClientToken + Sec-MS-GEC DRM automatically.
const { spawn } = require("child_process");
const http = require("http");

const PORT = process.env.PORT || 3000;
const BACKEND_VERSION = "20261018-diag2"; // bump on each deploy for verification
const ORIGIN = process.env.ALLOWED_ORIGIN || "https://nova-studio-qfco.onrender.com";
const ALLOWED_VOICES = new Set(["my-MM-NilarNeural", "my-MM-ThihaNeural"]);
// Gemini proxy: only these models, only generateContent on the official host
const GEMINI_HOST = "generativelanguage.googleapis.com";
const ALLOWED_GEMINI_MODELS = new Set([
  "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash",
  "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-2.0-flash", "gemini-2.0-flash-lite",
  "gemini-1.5-flash", "gemini-1.5-pro",
]);

// --- concurrency semaphore for /api/gemini-upload (max 1 active) ---
let geminiUploadActive = false;

// --- simple per-IP rate limit: 60 TTS requests / minute ---
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 60;
}

const MIX_PY_MIX = `
import json, sys, os, subprocess, tempfile, base64
import imageio_ffmpeg

def main():
    d = json.load(sys.stdin)
    segs = d["segments"]  # [{b64, start, end, rate}]
    video_dur = float(d.get("videoDur", 0))
    tmpd = tempfile.mkdtemp(prefix="mix")
    inputs = []
    fc_parts = []
    for i, s in enumerate(segs):
        fp = os.path.join(tmpd, f"s{i}.mp3")
        with open(fp, "wb") as f:
            f.write(base64.b64decode(s["b64"]))
        inputs += ["-i", fp]
        # Simple: atempo (if needed), then sequential concat.
        # No per-segment timestamp placement — the narration plays as one
        # continuous voiceover (Automation Nova approach: single voice file).
        # This avoids the WASM memory wall entirely.
        chain = f"[{i}:a]"
        rate = float(s.get("rate") or 1)
        if rate > 1.001:
            chain += f"atempo={rate:.3f},"
        chain += f"aformat=sample_rates=44100:channel_layouts=stereo[a{i}];"
        fc_parts.append(chain)
    mix_labels = "".join(f"[a{i}]" for i in range(len(segs)))
    fc = "".join(fc_parts) + f"{mix_labels}concat=n={len(segs)}:v=0:a=1"
    if video_dur > 0:
        fc += f",apad=whole_dur={video_dur:.2f}"
    out = os.path.join(tmpd, "narr.mp3")
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [exe, "-y"] + inputs + ["-filter_complex", fc, "-c:a", "libmp3lame", "-b:a", "128k", out]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(out):
        sys.stderr.write(r.stderr.decode(errors="ignore")[-500:])
        sys.exit(1)
    sys.stdout.buffer.write(open(out, "rb").read())

main()
`;

const PY = `
import asyncio, json, sys
import edge_tts
async def main():
    d = json.load(sys.stdin)
    text = str(d.get("text", ""))[:5000]
    voice = d.get("voice") or "my-MM-ThihaNeural"
    comm = edge_tts.Communicate(text, voice)
    out = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            out += chunk["data"]
    sys.stdout.buffer.write(bytes(out))
asyncio.run(main())
`;

function synth(text, voice) {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-c", PY], { timeout: 90000 });
    const out = [], err = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { p.kill("SIGKILL"); } catch (_) {}
      reject(new Error("edge-tts timeout"));
    }, 90000);
    p.stdout.on("data", (d) => {
      out.push(d);
      if (Buffer.concat(out).length > 64 * 1024 * 1024) {
        clearTimeout(timer);
        try { p.kill("SIGKILL"); } catch (_) {}
        reject(new Error("edge-tts output too large"));
      }
    });
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const msg = Buffer.concat(err).toString().slice(0, 300);
        return reject(new Error("edge-tts failed: " + msg));
      }
      resolve(Buffer.concat(out));
    });
    try {
      p.stdin.write(JSON.stringify({ text, voice }));
      p.stdin.end();
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-gemini-key, x-file-name, x-mime-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("nova-tts ok");
    return;
  }

  if (req.method === "GET" && req.url === "/api/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: BACKEND_VERSION, endpoints: ["/api/gemini", "/api/gemini-upload", "/api/tts", "/api/mix"] }));
    return;
  }


  if (req.method === "POST" && req.url === "/api/mix") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "text/plain" }); res.end("rate limited"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const segs = data.segments || [];
        if (!segs.length) { res.writeHead(400); res.end("no segments"); return; }
        const audio = await new Promise((resolve, reject) => {
          const p = spawn("python3", ["-c", MIX_PY_MIX], { timeout: 150000 });
          const out = [], err = [];
          const timer = setTimeout(() => {
            try { p.kill("SIGKILL"); } catch (_) {}
            reject(new Error("mix timeout"));
          }, 150000);
          p.stdout.on("data", (d) => out.push(d));
          p.stderr.on("data", (d) => err.push(d));
          p.on("error", (e) => { clearTimeout(timer); reject(e); });
          p.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
              const msg = Buffer.concat(err).toString().slice(0, 500);
              return reject(new Error("mix failed: " + msg));
            }
            resolve(Buffer.concat(out));
          });
          p.stdin.write(JSON.stringify({ segments: segs, videoDur: data.videoDur || 0 }));
          p.stdin.end();
        });
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length });
        res.end(audio);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("mix error: " + (e.message || e).slice(0, 300));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/tts") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "text/plain" }); res.end("rate limited"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 30000) req.destroy(); });
    req.on("end", async () => {
      try {
        const { text, voice } = JSON.parse(body || "{}");
        if (!text || !String(text).trim()) { res.writeHead(400); res.end("empty text"); return; }
        const v = ALLOWED_VOICES.has(voice) ? voice : "my-MM-ThihaNeural";
        const audio = await synth(String(text), v);
        if (!audio.length) { res.writeHead(502); res.end("empty audio"); return; }
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length });
        res.end(audio);
      } catch (e) {
        const msg = (e.message || e).toString().slice(0, 300);
        console.error("tts error:", msg);
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("tts failed: " + msg);
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/gemini") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "text/plain" }); res.end("rate limited"); return; }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5 * 1024 * 1024) {
        if (!res.writableEnded) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("request too large (max 5MB)");
        }
        req.destroy();
      }
    });
    req.on("end", async () => {
      // DIAG vars defined before try so catch block can always access them,
      // even if JSON.parse fails (prevents secondary ReferenceError).
      const diagId = Math.random().toString(36).slice(2, 10);
      const diagStart = Date.now();
      let diagModel = "?";
      try {
        const data = JSON.parse(body || "{}");
        const { model, key, geminiBody } = data;
        diagModel = model || "?";
        // Validate model (prevent arbitrary model/endpoint abuse)
        if (!model || !ALLOWED_GEMINI_MODELS.has(model)) {
          res.writeHead(400); res.end("invalid model"); return;
        }
        if (!key || typeof key !== "string" || key.length < 10) {
          res.writeHead(400); res.end("missing api key"); return;
        }
        if (!geminiBody || typeof geminiBody !== "object") {
          res.writeHead(400); res.end("missing request body"); return;
        }
        // Forward to official Gemini API only.
        // Key sent via x-goog-api-key header (never in URL, never logged).
        const diagOrigin = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "direct";
        // DIAG-START: log immediately on request receipt (before Google call)
        // Sanitized: only correlation ID and model name. No keys, prompts, or bodies.
        console.log(`[gemini-diag-start] id=${diagId} model=${model}`);
        // Log only: model, origin IP prefix, status. NEVER key, headers, or prompt.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 240000); // 240s: long video/scene analysis can exceed 90s
        try {
          const url = `https://${GEMINI_HOST}/v1beta/models/${model}:generateContent`;
          const gres = await fetch(url, {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify(geminiBody),
          });
          const text = await gres.text();
          // DIAG: extract Google error code/status/message (sanitized, no prompt content)
          let gCode = "", gStatus = "", gMsg = "";
          try {
            const gj = JSON.parse(text);
            const ge = gj.error || {};
            gCode = String(ge.code || "");
            gStatus = String(ge.status || "");
            gMsg = String(ge.message || "").slice(0, 120);
          } catch (_) { /* non-JSON response */ }
          const diagDur = Date.now() - diagStart;
          console.log(`[gemini-diag] id=${diagId} model=${model} origin=${diagOrigin.slice(0,15)} http=${gres.status} dur=${diagDur}ms gcode=${gCode} gstatus=${gStatus} gmsg=${gMsg}`);
          // Never log key or full body; forward status + body as-is
          res.writeHead(gres.status, { "Content-Type": "application/json" });
          res.end(text);
        } finally { clearTimeout(timer); }
      } catch (e) {
        // Do not expose internals or key material
        const isAbort = e.name === "AbortError";
        const diagDur2 = Date.now() - diagStart;
        // DIAG-ERROR: log timeouts and failures explicitly (no secrets)
        console.log(`[gemini-diag-error] id=${diagId} model=${diagModel} dur=${diagDur2}ms err=${isAbort ? "timeout" : "error"}`);
        if (!res.writableEnded) {
          res.writeHead(isAbort ? 504 : 502, { "Content-Type": "text/plain" });
          res.end(isAbort ? "gemini upstream timeout" : "gemini proxy error");
        }
      }
    });
    return;
  }

  // Gemini Files API upload proxy (resumable upload handled server-side)
  // Client sends raw video bytes; metadata via headers. Never logs key or upload URL.
  if (req.method === "POST" && req.url === "/api/gemini-upload") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "text/plain" }); res.end("rate limited"); return; }
    const key = req.headers["x-gemini-key"];
    const fileName = String(req.headers["x-file-name"] || "video.mp4").slice(0, 100);
    const mimeType = String(req.headers["x-mime-type"] || "video/mp4").slice(0, 50);
    if (!key || typeof key !== "string" || key.length < 10) {
      res.writeHead(400); res.end("missing api key"); return;
    }
    if (!/^video\//.test(mimeType) && mimeType !== "video/mp4") {
      res.writeHead(400); res.end("invalid mime type"); return;
    }
    // Semaphore: reject if another upload is active (don't buffer the body)
    if (geminiUploadActive) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("upload busy — try again in a moment");
      req.resume(); // drain incoming body, don't destroy (response must flush)
      return;
    }
    geminiUploadActive = true;
    let semaphoreReleased = false;
    const releaseSemaphore = () => {
      if (!semaphoreReleased) { semaphoreReleased = true; geminiUploadActive = false; }
    };

    const chunks = [];
    let totalLen = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      totalLen += c.length;
      if (totalLen > 100 * 1024 * 1024) {
        rejected = true;
        chunks.length = 0; // free buffered data immediately
        if (!res.writableEnded) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("video too large (max 100MB)");
        }
        releaseSemaphore();
        req.resume(); // drain remaining body, don't destroy (response must flush)
        return;
      }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (rejected) return; // already handled 413
      try {
        const videoBuf = Buffer.concat(chunks);
        chunks.length = 0; // free originals
        if (!videoBuf.length) { res.writeHead(400); res.end("empty video"); return; }
        const H = { "x-goog-api-key": key };
        // Step 1: init resumable upload
        const initCtrl = new AbortController();
        const initTimer = setTimeout(() => initCtrl.abort(), 30000);
        let uploadUrl;
        try {
          const ires = await fetch(`https://${GEMINI_HOST}/upload/v1beta/files`, {
            method: "POST", signal: initCtrl.signal,
            headers: {
              ...H, "Content-Type": "application/json",
              "X-Goog-Upload-Protocol": "resumable",
              "X-Goog-Upload-Command": "start",
              "X-Goog-Upload-Header-Content-Length": String(videoBuf.length),
              "X-Goog-Upload-Header-Content-Type": mimeType,
            },
            body: JSON.stringify({ file: { displayName: fileName, mimeType } }),
          });
          if (!ires.ok) {
            res.writeHead(ires.status); res.end("upload init failed"); return;
          }
          uploadUrl = ires.headers.get("x-goog-upload-url");
          if (!uploadUrl) { res.writeHead(502); res.end("no upload url"); return; }
        } finally { clearTimeout(initTimer); }
        // Step 2: upload bytes (upload URL is Google-internal, never sent to client)
        const upCtrl = new AbortController();
        const upTimer = setTimeout(() => upCtrl.abort(), 300000);
        let fileUri, fName;
        try {
          const ures = await fetch(uploadUrl, {
            method: "PUT", signal: upCtrl.signal,
            headers: {
              "Content-Length": String(videoBuf.length),
              "X-Goog-Upload-Offset": "0",
              "X-Goog-Upload-Command": "upload, finalize",
            },
            body: videoBuf,
          });
          if (!ures.ok) { res.writeHead(ures.status); res.end("upload failed"); return; }
          const uj = await ures.json();
          fileUri = uj.file && uj.file.uri;
          fName = uj.file && uj.file.name;
          if (!fileUri) { res.writeHead(502); res.end("no file uri"); return; }
        } finally { clearTimeout(upTimer); }
        // Step 3: poll until ACTIVE (max ~5 min)
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const sres = await fetch(`https://${GEMINI_HOST}/v1beta/${fName}`, { headers: H });
            if (!sres.ok) continue;
            const sj = await sres.json();
            const state = sj.state || (sj.file && sj.file.state);
            if (state === "ACTIVE") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ uri: fileUri, name: fName }));
              return;
            }
            if (state === "FAILED") { res.writeHead(502); res.end("processing failed"); return; }
          } catch (_) { /* retry */ }
        }
        res.writeHead(504); res.end("processing timeout");
      } catch (e) {
        const isAbort = e.name === "AbortError";
        if (!res.writableEnded) {
          res.writeHead(isAbort ? 504 : 502, { "Content-Type": "text/plain" });
          res.end(isAbort ? "upload timeout" : "upload proxy error");
        }
      } finally {
        releaseSemaphore();
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("nova-tts listening on " + PORT));
