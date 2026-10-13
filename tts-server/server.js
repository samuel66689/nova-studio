// nova-tts — server-side Microsoft Edge TTS proxy.
// Why: browser-side Edge TTS exposes the user's IP (VPN exit IPs get blocked
// by Microsoft). Doing it server-side hides the IP, like Automation Nova does.
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || "https://nova-studio-qfco.onrender.com";

const EDGE_WS =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
  "?trustedclienttoken=6A5AA1D4EAFF4B2FB37E23D68491D6F4";

// Only these voices are served (abuse prevention).
const ALLOWED_VOICES = new Set(["my-MM-NilarNeural", "my-MM-ThihaNeural"]);

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}

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

function edgeTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    let ws = null;
    const finish = (ok, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (_) {}
      ok ? resolve(val) : reject(val);
    };
    const timer = setTimeout(() => finish(false, new Error("edge timeout")), 90000);
    try {
      ws = new WebSocket(EDGE_WS, {
        headers: {
          Origin: "https://www.bing.com",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
    } catch (e) { finish(false, e); return; }

    ws.on("open", () => {
      const ts = new Date().toString();
      ws.send(
        "X-Timestamp:" + ts + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
      );
      const rid = crypto.randomBytes(16).toString("hex");
      const ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='my-MM'>" +
        "<voice name='" + voice + "'><prosody rate='+0%' pitch='+0Hz'>" +
        xmlEscape(text) + "</prosody></voice></speak>";
      ws.send(
        "X-RequestId:" + rid + "\r\n" +
        "Content-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + ts + "\r\n" +
        "Path:ssml\r\n\r\n" + ssml
      );
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes("Path:turn.end")) finish(true, Buffer.concat(chunks));
        return;
      }
      try {
        const hlen = data.readUInt16BE(0); // big-endian header length
        const header = data.slice(2, 2 + hlen).toString();
        if (header.includes("Path:audio")) {
          chunks.push(data.slice(2 + hlen));
        } else if (header.includes("Path:turn.end")) {
          finish(true, Buffer.concat(chunks));
        }
      } catch (e) { finish(false, e); }
    });

    ws.on("error", (e) => finish(false, e));
    ws.on("close", () => { if (!done) finish(false, new Error("edge closed early")); });
  });
}

const server = http.createServer((req, res) => {
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
        const audio = await edgeTTS(String(text).slice(0, 5000), v);
        if (!audio.length) { res.writeHead(502); res.end("empty audio"); return; }
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length });
        res.end(audio);
      } catch (e) {
        console.error("tts error:", e.message);
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("tts failed");
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("nova-tts listening on " + PORT));
