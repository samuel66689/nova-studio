// TTS canary — run after every deploy (npm run canary / node canary.js).
// Proves the server Edge TTS path works end-to-end against the live service:
// call 1 must synthesize via Microsoft (cache miss), call 2 with the same
// text must come from the server LRU cache (x-tts-cache: hit).
// Usage: TTS_URL=https://nova-tts.onrender.com node canary.js
// Exit 0 = OK, exit 1 = FAIL. Run only after /api/version shows the new build.
const TTS_URL = (process.env.TTS_URL || "https://nova-tts.onrender.com").replace(/\/$/, "");
const TEXT = "မင်္ဂလာပါ";
const VOICE = "my-MM-ThihaNeural";
async function post(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(TTS_URL + "/api/tts", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: VOICE }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, cache: res.headers.get("x-tts-cache"), bytes: buf.length };
  } finally { clearTimeout(timer); }
}
(async () => {
  try {
    const vres = await fetch(TTS_URL + "/api/version");
    console.log("version:", (await vres.text()).slice(0, 200));
  } catch (e) { console.log("version check skipped:", e.message); }
  const a = await post(TEXT);
  console.log("call 1:", a.status, "cache=" + a.cache, "bytes=" + a.bytes);
  if (a.status !== 200 || a.bytes < 1000) { console.error("CANARY FAIL: first synthesis did not return audio"); process.exit(1); }
  const b = await post(TEXT);
  console.log("call 2:", b.status, "cache=" + b.cache, "bytes=" + b.bytes);
  if (b.status !== 200 || b.bytes < 1000) { console.error("CANARY FAIL: second synthesis did not return audio"); process.exit(1); }
  if (b.cache !== "hit") { console.error("CANARY FAIL: second call was not a server cache hit"); process.exit(1); }
  console.log("CANARY OK");
})().catch((e) => { console.error("CANARY FAIL:", e.message); process.exit(1); });
