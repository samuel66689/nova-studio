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
        # build per-input chain: atempo/atrim then adelay
        chain = f"[{i}:a]"
        rate = float(s.get("rate") or 1)
        if rate > 1.001:
            chain += f"atempo={rate:.3f},"
        win = float(s["end"]) - float(s["start"])
        # trim if still over (safety)
        # adelay to position
        dms = int(max(0, float(s["start"])) * 1000)
        chain += f"aformat=sample_rates=44100:channel_layouts=stereo,adelay={dms}|{dms}[a{i}];"
        fc_parts.append(chain)
    mix_labels = "".join(f"[a{i}]" for i in range(len(segs)))
    fc = "".join(fc_parts) + f"{mix_labels}amix=inputs={len(segs)}:duration=longest:normalize=0"
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
        const p = spawnSync("python3", ["-c", MIX_PY_MIX], {
          input: JSON.stringify({ segments: segs, videoDur: data.videoDur || 0 }),
          maxBuffer: 64 * 1024 * 1024,
          timeout: 150000,
        });
        if (p.error) throw p.error;
        if (p.status !== 0) {
          const err = (p.stderr || Buffer.alloc(0)).toString().slice(0, 500);
          throw new Error("mix failed: " + err);
        }
        const audio = p.stdout;
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

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("nova-tts listening on " + PORT));
