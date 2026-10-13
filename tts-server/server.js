// nova-tts — server-side Microsoft Edge TTS proxy.
// Why server-side: browser-side Edge TTS exposes the user's IP (VPN exit IPs
// get blocked); the maintained `edge-tts` Python library handles Microsoft's
// rotating TrustedClientToken + Sec-MS-GEC DRM automatically.
const { spawnSync } = require("child_process");
const http = require("http");

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || "https://nova-studio-qfco.onrender.com";
const ALLOWED_VOICES = new Set(["my-MM-NilarNeural", "my-MM-ThihaNeural"]);

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
    const p = spawnSync("python3", ["-c", PY], {
      input: JSON.stringify({ text, voice }),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 90000,
    });
    if (p.error) return reject(p.error);
    if (p.status !== 0) {
      const err = (p.stderr || Buffer.alloc(0)).toString().slice(0, 300);
      return reject(new Error("edge-tts failed: " + err));
    }
    resolve(p.stdout);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("nova-tts ok");
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
        console.error("tts error:", (e.message || e).toString().slice(0, 200));
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("tts failed");
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("nova-tts listening on " + PORT));
