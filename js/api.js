// api.js — Groq + Gemini calls (direct from browser), key storage, helpers

export function getKeys() {
  return {
    groq: (localStorage.getItem("nova_groq_key") || "").trim(),
    aai: (localStorage.getItem("nova_aai_key") || "").trim(),
    gemini: (localStorage.getItem("nova_gemini_key") || "").trim(),
  };
}
export function saveKeys(groq, gemini, aai) {
  localStorage.setItem("nova_groq_key", (groq || "").trim());
  localStorage.setItem("nova_gemini_key", (gemini || "").trim());
  if (aai !== undefined) localStorage.setItem("nova_aai_key", (aai || "").trim());
}
export function clearKeys() {
  localStorage.removeItem("nova_groq_key");
  localStorage.removeItem("nova_gemini_key");
  localStorage.removeItem("nova_aai_key");
}

// ---------- time helpers ----------
export function pad2(n) { return String(n).padStart(2, "0"); }

export function fmtClock(sec) {
  // Guard: never return "NaN:NaN" — return "??:??" for invalid input
  if (typeof sec !== "number" || !isFinite(sec)) return "??:??";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h > 0 ? pad2(h) + ":" : "") + pad2(m) + ":" + pad2(s);
}

export function toSRTTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60), ms = Math.floor((sec % 1) * 1000);
  return pad2(h) + ":" + pad2(m) + ":" + pad2(s) + "," + String(ms).padStart(3, "0");
}

/**
 * Parse "MM:SS" or "HH:MM:SS" to seconds. Returns null for anything invalid.
 * - MM:SS → seconds must be 00-59 (rejects "00:75")
 * - HH:MM:SS → minutes and seconds must be 00-59 (rejects "01:70:00")
 * - Rejects negative ("-1:30"), non-numeric ("ab:cd"), empty parts ("1::30"),
 *   wrong part counts, decimals, and surrounding garbage.
 * - Hours/minutes (leading part) may be any non-negative integer ("75:00" ok).
 */
export function parseClock(str) {
  const s = String(str == null ? "" : str).trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (parts.length === 2) {
    const [m, sec] = nums;
    if (sec > 59) return null;
    return m * 60 + sec;
  }
  const [h, m, sec] = nums;
  if (m > 59 || sec > 59) return null;
  return h * 3600 + m * 60 + sec;
}

export function mediaDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(d); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("video duration ဖတ်မရပါ")); };
    v.src = url;
  });
}

/** IndexedDB: persist recap pipeline state across refreshes. */
const IDB_NAME = "nova-studio";
const IDB_STORE = "recap-runs";
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(IDB_STORE)) {
        r.result.createObjectStore(IDB_STORE);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
export async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const q = tx.objectStore(IDB_STORE).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
/** List all keys in the store (for project/preset enumeration). */
export async function idbKeys() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const q = tx.objectStore(IDB_STORE).getAllKeys();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("base64 convert မအောင်မြင်ပါ"));
    r.readAsDataURL(blob);
  });
}

// ---------- Groq Whisper ----------
/** Returns [{start,end,text}] (seconds). */
export async function groqTranscribe(mp3Blob, language) {
  const { groq } = getKeys();
  if (!groq) throw new Error("Groq API key မထည့်ရသေးပါ — ⚙️ Settings မှာ ထည့်ပါ");
  const fd = new FormData();
  fd.append("file", mp3Blob, "audio.mp3");
  fd.append("model", "whisper-large-v3");
  fd.append("response_format", "verbose_json");
  if (language && language !== "auto") fd.append("language", language);
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + groq },
      body: fd,
    });
  } catch (e) {
    throw new Error("Groq ကို ဆက်သွယ်မရပါ — internet စစ်ပါ");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Groq transcribe မအောင်မြင်ပါ (" + res.status + "): " + t.slice(0, 180));
  }
  const j = await res.json();
  const segs = (j.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || "").trim(),
  })).filter((s) => s.text);
  if (!segs.length && j.text) {
    // fallback: no segments, treat whole thing as one
    return [{ start: 0, end: 0, text: String(j.text).trim() }];
  }
  return segs;
}

// ---------- Gemini ----------
const GEMINI_PROXY = "https://nova-tts.onrender.com/api/gemini";

/**
 * Route Gemini generateContent through the server proxy (US IP).
 * Falls back to direct browser request only on network-level failures,
 * NOT on API errors (invalid key, quota, location) to avoid duplicate calls.
 */
async function geminiViaServer(model, key, geminiBody) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 250000); // 250s: just above the proxy's 240s so its 504 message arrives
  try {
    const res = await fetch(GEMINI_PROXY, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, key, geminiBody }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      // Any 5xx: the proxy answered, but the upstream Gemini request timed
      // out, the proxy itself failed, or the proxy forwarded a Google 5xx
      // (the server forwards Google's status verbatim). This is NOT a client
      // network failure, and a direct fallback would only produce a
      // misleading geo-location error from a blocked IP. Mark it so callers
      // surface it instead of falling back.
      const isUpstream = res.status >= 500 && res.status <= 599;
      const err = new Error(isUpstream
        ? (res.status === 504
          ? "Gemini proxy (" + model + ") timeout (504) — Gemini က process လုပ်တာ ကြာနေပါတယ်. ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ"
          : "Gemini proxy (" + model + ") error " + res.status + " — server ပြဿနာ ဖြစ်နေပါတယ်. ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ")
        : "Gemini proxy (" + model + ") error " + res.status + ": " + t.slice(0, 180));
      err.isApiError = res.status >= 400 && res.status < 500;
      err.isUpstreamError = isUpstream;
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally { clearTimeout(timer); }
}

function isNetworkFailure(e) {
  return e.name === "AbortError" || e.name === "TypeError" ||
    /failed to fetch|network|timeout/i.test(e.message || "");
}

async function geminiGenerateParts(model, systemText, parts, maxTokens) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ — ⚙️ Settings မှာ ထည့်ပါ");
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.8, maxOutputTokens: maxTokens || 8192 },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  // Try server proxy first (US IP, bypasses geo-blocking)
  let j;
  try {
    j = await geminiViaServer(model, gemini, body);
  } catch (proxyErr) {
    // Upstream errors (502/504): proxy answered but Gemini timed out.
    // Never fall back to direct — it would fail with a misleading
    // unsupported-location error from a geo-blocked IP.
    if (proxyErr && proxyErr.isUpstreamError) throw proxyErr;
    // Fallback to direct only on network failures, not API errors
    if (!isNetworkFailure(proxyErr) && proxyErr.isApiError) throw proxyErr;
    let res;
    try {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": gemini }, body: JSON.stringify(body) }
      );
    } catch (e) {
      throw new Error("Gemini ကို ဆက်သွယ်မရပါ — internet စစ်ပါ");
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("Gemini (" + model + ") error " + res.status + ": " + t.slice(0, 180));
    }
    j = await res.json();
  }
  const text = ((j.candidates || [])[0] || {}).content?.parts
    ?.map((p) => p.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini က စာမပြန်ပါ — ပြန်ကြိုးစားပါ");
  return text;
}

/** Gemini Files API: upload video file, returns file URI. */
export async function geminiUploadVideo(file, onprog) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key \u1019\u101b\u1004\u1037\u1032\u101e\u1031\u1038\u1015\u102b — ⚙️ Settings \u1019\u103e\u102c \u1011\u100a\u1037\u1015\u102b");
  // Route through server proxy (US IP) to bypass geo-blocking.
  // Server handles resumable upload init, byte transfer, and ACTIVE polling.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 400000);
  try {
    const res = await fetch("https://nova-tts.onrender.com/api/gemini-upload", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-gemini-key": gemini,
        "x-file-name": encodeURIComponent(file.name || "video.mp4"),
        "x-mime-type": file.type || "video/mp4",
      },
      body: file,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (res.status === 413) throw new Error("Video \u1000\u103c\u102e\u1038\u1038\u1000\u103c\u102e\u1038\u1000\u103c\u102e\u1038 (100MB \u1021\u1011\u1000\u103a)");
      throw new Error("Video upload \u1019\u1031\u1021\u102f\u1004\u103a\u1019\u103c\u1004\u103a (" + res.status + "): " + t.slice(0, 120));
    }
    const j = await res.json();
    if (!j.uri) throw new Error("File URI \u1019\u101b\u1015\u102b");
    return j.uri;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Video upload \u1021\u1001\u102d\u1014\u103a\u1000\u102f\u1014\u103a\u101c\u103d\u1014\u103a");
    throw e;
  } finally { clearTimeout(timer); }
}



/** Style prompts for recap narration. */
export const RECAP_STYLES = {
  story: [
    "You are a professional Burmese recap narrator for short drama videos.",
    "STYLE: STORY — calm, clear storytelling like popular YouTube recap channels.",
    "RULES:",
    '1. NO intro — NEVER say "မင်္ဂလာပါ", "ဒီနေ့ တင်ဆက်ပေးမှာကတော့", or greet viewers. Start DIRECTLY with the story.',
    "2. Write NATURAL SPOKEN BURMESE (စကားပြောဟန်) — like telling a friend.",
    "3. Short sentences. One idea per sentence.",
    "4. Focus on: what happens, why characters do it, how they feel.",
    "5. Use character names consistently.",
    '6. NO "နောက်အပိုင်းကို စောင့်မျှော်" unless told it is a series.',
    "7. End naturally when story ends — no forced closing.",
    'BAD: "အားလုံးပဲ မင်္ဂလာပါရှင်။ ဒီနေ့ တင်ဆက်ပေးမှာကတော့..."',
    'GOOD: "လီဝေ ဟာ မနက် စော စော ထ ပြီး..."',
  ].join("\n"),
  viral: [
    "You are a professional Burmese recap narrator for short drama videos.",
    "STYLE: VIRAL — punchy, hook-driven, high energy. Start with a shocking hook. Short sentences. Cliffhangers.",
    "Write NATURAL SPOKEN BURMESE (စကားပြောဟန်) — exciting, like a viral TikTok narrator.",
  ].join("\n"),
  hybrid: [
    "You are a professional Burmese recap narrator for short drama videos.",
    "STYLE: HYBRID — engaging story with viral hooks at key moments. Balanced pacing.",
    "Write NATURAL SPOKEN BURMESE (စကားပြောဟန်).",
  ].join("\n"),
};

/** Recap from full video via Files API. style = story|viral|hybrid */
export async function geminiRecapFromVideoFile(fileUri, style, extraPrompt="", opts={}) {
  const targetMin = opts.targetMinutes;
  const durHint = targetMin
    ? `\nDURATION TARGET: ~${targetMin} minutes (~${Math.round(targetMin*60/8)} segments). Do NOT be overly concise.`
    : "";
  const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];
  const stylePrompt = (RECAP_STYLES[style] || RECAP_STYLES.story);
  const systemText = stylePrompt + "\n" + [
    "You are given the FULL VIDEO. Watch it completely.",
    "Write the recap narration to match what happens on screen — actions, dialogue, expressions, settings.",
    "STRICT RULES:",
    "1. NEVER use literary/formal particles: သည်, ၏, ၍, ထို့ကြောင့်, သို့သော်. Use natural spoken forms only.",
    "2. CHARACTER IDENTITY: never mix up who is who.",
    "3. Cover the story IN ORDER. Keep every key twist, stay concise but engaging.",
    "4. ONLY describe what is actually visible or spoken in the video — never invent.",
    "5. Do NOT add unnecessary dramatic/florid words.",
    "6. Output ONLY segment lines, one per line, in this EXACT format:",
    "[SRC 03:10-03:25] narration text here",
    "6b. The [SRC start-end] MUST be source-video timestamps — which scene this narration describes.",
    "7. Each segment must be 5 to 12 seconds of spoken narration.",
    "8. The LAST segment may end with a short teaser hook for the next episode.",
    "9. No Chinese, Thai or Latin characters — except brand/person names (transliterate rest).",
    "10. No intro, no markdown, no numbering — only segment lines.",
  ].join("\n") + extraPrompt + durHint;
  let lastErr = null;
  for (const m of models) {
    try {
      const { gemini } = getKeys();
      const body = {
        contents: [{ parts: [
          { fileData: { mimeType: "video/mp4", fileUri } },
          { text: "Watch this video completely and write the Burmese recap narration." },
        ]}],
        generationConfig: { temperature: 0.8, maxOutputTokens: 16384 },
        systemInstruction: { parts: [{ text: systemText }] },
      };
      let j;
      try {
        j = await geminiViaServer(m, gemini, body);
      } catch (proxyErr) {
        if (proxyErr && proxyErr.isUpstreamError) throw proxyErr;
        if (!isNetworkFailure(proxyErr) && proxyErr.isApiError) throw proxyErr;
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": gemini }, body: JSON.stringify(body) }
        );
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error("Gemini (" + m + ") error " + res.status + ": " + t.slice(0, 180));
        }
        j = await res.json();
      }
      const text = ((j.candidates || [])[0] || {}).content?.parts
        ?.map((p) => p.text || "").join("") || "";
      const { segments: segs, errors: segErrs } = parseRecapSegmentsStrict(text);
      if (segErrs.length) throw new Error("Timestamp အမှား:\n" + segErrs.slice(0, 5).join("\n"));
      if (!segs.length) throw new Error("script format မမှန်ပါ — segment မရှိပါ");
      // Diagnostic: log if segments have empty text (for debugging)
      try {
        const emptyCount = segs.filter(s => !hasRealText(s.text)).length;
        if (emptyCount > 0) console.warn(`[script-diag] ${emptyCount}/${segs.length} segments have no real text`);
      } catch (_) {}
      return segs;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Gemini fallback transcription. Returns [{start,end,text}]. */
// ---- MP3 frame-aware splitting for transcription ----
// The Gemini proxy caps request bodies at 5MB, and base64 inflates audio by
// ~1.33x, so a blob over ~3.5MB always failed with HTTP 413. Split large MP3s
// at frame boundaries into <=3MB parts; each part is a valid standalone MP3.
const MP3_BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SR_TAB = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3FrameAt(u8, off) {
  if (off + 4 > u8.length) return null;
  if (u8[off] !== 0xFF || (u8[off + 1] & 0xE0) !== 0xE0) return null;
  const ver = (u8[off + 1] >> 3) & 3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  if (ver === 1) return null;
  if (((u8[off + 1] >> 1) & 3) !== 1) return null; // Layer III only
  const brIdx = (u8[off + 2] >> 4) & 0xF;
  const srIdx = (u8[off + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const kbps = (ver === 3 ? MP3_BR_V1_L3 : MP3_BR_V2_L3)[brIdx];
  const sr = MP3_SR_TAB[ver][srIdx];
  const pad = (u8[off + 2] >> 1) & 1;
  const len = Math.floor((ver === 3 ? 144000 : 72000) * kbps / sr) + pad;
  if (len < 24 || off + len > u8.length) return null;
  return { len, dur: (ver === 3 ? 1152 : 576) / sr };
}
function splitMp3ByFrames(u8, maxBytes) {
  let scanFrom = 0;
  if (u8.length > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) { // "ID3"
    scanFrom = 10 + (((u8[6] & 0x7F) << 21) | ((u8[7] & 0x7F) << 14) | ((u8[8] & 0x7F) << 7) | (u8[9] & 0x7F));
  }
  let off = -1;
  for (let i = scanFrom; i + 4 <= u8.length; i++) { if (mp3FrameAt(u8, i)) { off = i; break; } }
  if (off < 0) return null;
  const parts = [];
  let partFrom = 0; // first part keeps any ID3 prefix
  let partDur = 0, t = 0, frames = 0;
  let cur = off;
  while (cur < u8.length) {
    const fr = mp3FrameAt(u8, cur);
    if (!fr) break;
    if (frames > 0 && (cur + fr.len) - partFrom > maxBytes) {
      parts.push({ from: partFrom, to: cur, startSec: t - partDur, durSec: partDur });
      partFrom = cur; partDur = 0; frames = 0;
    }
    partDur += fr.dur; t += fr.dur; frames++;
    cur += fr.len;
  }
  if (frames > 0) parts.push({ from: partFrom, to: cur, startSec: t - partDur, durSec: partDur });
  // Sanity: frames must cover most of the file, else this was not a clean MP3.
  if (!parts.length || cur < u8.length * 0.9) return null;
  return parts;
}

async function geminiTranscribeOnce(mp3Blob) {
  const b64 = await blobToBase64(mp3Blob);
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ");
  const body = {
    contents: [{ parts: [
      { text: "Transcribe this audio completely. Output ONLY lines in this exact format, one per line:\n[MM:SS] transcribed text\nUse the timestamp of when each line starts. No other commentary." },
      { inlineData: { mimeType: "audio/mpeg", data: b64 } },
    ]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
  };
  let j = null, terr = null;
  for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]) {
    try {
      try {
        j = await geminiViaServer(m, gemini, body);
      } catch (proxyErr) {
        if (proxyErr && proxyErr.isUpstreamError) throw proxyErr;
        if (!isNetworkFailure(proxyErr) && proxyErr.isApiError) throw proxyErr;
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": gemini }, body: JSON.stringify(body) }
        );
        if (!res.ok) throw new Error("Gemini transcribe error " + res.status);
        j = await res.json();
      }
      break;
    } catch (e) { terr = e; j = null; }
  }
  if (!j) throw terr || new Error("Gemini transcribe မအောင်မြင်ပါ");
  const text = ((j.candidates || [])[0] || {}).content?.parts
    ?.map((p) => p.text || "").join("") || "";
  const segs = [];
  for (const ln of text.split("\n")) {
    const m = ln.match(/\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)/);
    if (m) {
      const start = parseClock(m[1]);
      if (start !== null && m[2].trim()) segs.push({ start, text: m[2].trim() });
    }
  }
  return segs;
}

/** Gemini fallback transcription. Returns [{start,end,text}].
 * Large inputs are split at MP3 frame boundaries so no single proxy
 * request exceeds the 5MB body limit (previously a guaranteed 413). */
export async function geminiTranscribe(mp3Blob) {
  const MAX_BLOB = 3 * 1024 * 1024; // base64 ~4MB, safely under the proxy cap
  let raw = null;
  if (mp3Blob.size <= MAX_BLOB) {
    raw = await geminiTranscribeOnce(mp3Blob);
  } else {
    const u8 = new Uint8Array(await mp3Blob.arrayBuffer());
    const parts = splitMp3ByFrames(u8, MAX_BLOB);
    if (!parts || parts.length < 2) {
      raw = await geminiTranscribeOnce(mp3Blob); // unparseable stream: previous behavior
    } else {
      raw = [];
      for (const part of parts) {
        const sub = new Blob([u8.subarray(part.from, part.to)], { type: "audio/mpeg" });
        const segs = await geminiTranscribeOnce(sub);
        for (const s of segs) raw.push({ start: s.start + part.startSec, text: s.text });
      }
      raw.sort((a, b) => a.start - b.start);
    }
  }
  if (!raw || !raw.length) throw new Error("Gemini transcribe က စာမထွက်ပါ");
  const segs = raw.map((s) => ({ start: s.start, end: 0, text: s.text }));
  for (let i = 0; i < segs.length; i++) {
    segs[i].end = (i + 1 < segs.length) ? segs[i + 1].start : segs[i].start + 5;
  }
  return segs;
}

const RECAP_SYSTEM = [
  "You are a professional Burmese recap narrator for short drama videos.",
  "Write NATURAL SPOKEN BURMESE (စကားပြောဟန်) — like a friend excitedly retelling a drama episode.",
  "STRICT RULES:",
  "1. NEVER use literary/formal particles: သည်, ၏, ၍, ထို့ကြောင့်, သို့သော်. Use natural spoken forms only.",
  "2. Cover the story IN ORDER from the transcript. Keep every key twist, stay concise but engaging.",
  "3. ONLY describe what is in the transcript — never invent events or details.",
  "4. Do NOT add unnecessary dramatic/florid words — keep the language natural and direct.",
  "5. Output ONLY segment lines, one per line, in this EXACT format:",
  "[SRC 03:10-03:25] narration text here",
  "[SRC 03:25-03:40] narration text here",
  "6. The [SRC start-end] timestamps MUST be from the transcript timestamps — they tell which source-video scene this narration describes.",
  "7. Each segment must be 5 to 12 seconds of spoken narration.",
  "8. The LAST segment may end with a short teaser hook for the next episode (one sentence).",
  "9. No Chinese, Thai or Latin characters in the output — except well-known brand names and real person names (transliterate everything else into Burmese).",
  "9. No intro, no markdown, no numbering — only the segment lines.",
].join("\n");

async function geminiGenerate(model, systemText, userText, maxTokens) {
  return geminiGenerateParts(model, systemText, [{ text: userText }], maxTokens);
}

/** Simple text prompt via Gemini (for translations). */
export async function geminiText(prompt, maxTokens = 8000) {
  const keys = getKeys();
  if (!keys.gemini) throw new Error("Gemini API key မရှိပါ");
  const models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
  let lastErr = null;
  for (const m of models) {
    try {
      return await geminiGenerate(m, "", prompt, maxTokens);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Gemini မအောင်မြင်ပါ");
}

const RECAP_VISION_SYSTEM = [
  "You are a professional Burmese recap narrator for short drama videos.",
  "You are given SCENE FRAMES from the video (in story order, each labeled with its timestamp) PLUS the full audio transcript with timestamps.",
  "WATCH the scenes and write the narration to match what is actually visible on screen — actions, gestures, expressions, settings.",
  "Write NATURAL SPOKEN BURMESE (စကားပြောဟန်) — like a friend excitedly retelling a drama episode.",
  "STRICT RULES:",
  "1. NEVER use literary/formal particles: သည်, ၏, ၍, ထို့ကြောင့်, သို့သော်. Use natural spoken forms only.",
  "2. CHARACTER IDENTITY: never mix up who is who. If a name is spoken or shown, use it only for that person; unknown people get role labels.",
  "3. Cover the story IN ORDER. Keep every key twist, stay concise but engaging.",
  "4. ONLY describe what is actually visible or spoken in the video — never invent events, actions or details not shown.",
  "5. Do NOT add unnecessary dramatic/florid words — keep the language natural and direct.",
  "6. You MAY quote a short real spoken line from the transcript when it is impactful — never invent dialogue that is not in the transcript.",
  "7. Output ONLY segment lines, one per line, in this EXACT format:",
  "[SRC 03:10-03:25] narration text here",
  "[SRC 03:25-03:40] narration text here",
  "7b. The [SRC start-end] MUST be source-video timestamps from the transcript/frames.",
  "8. Each segment must be 5 to 12 seconds of spoken narration.",
  "9. The LAST segment may end with a short teaser hook for the next episode (one sentence).",
  "10. No Chinese, Thai or Latin characters in the output — except well-known brand names and real person names (transliterate everything else into Burmese).",
  "11. No intro, no markdown, no numbering — only the segment lines.",
].join("\n");

/** Multimodal recap: scene frames + transcript. frames = [{at, b64}]. */
export async function geminiRecapScriptVision(frames, transcriptText, extraPrompt="", opts={}) {
  const targetMin = opts.targetMinutes;
  const durHint = targetMin
    ? `\nDURATION TARGET: Write enough segments for ~${targetMin} minutes (~${Math.round(targetMin*60/8)} segments). Do NOT be overly concise.`
    : "";
  const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
  let lastErr = null;
  for (const m of models) {
    try {
      const parts = [];
      for (const f of frames) {
        parts.push({ text: "Scene at " + fmtClock(f.at) + ":" });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: f.b64 } });
      }
      parts.push({ text: "AUDIO TRANSCRIPT (with timestamps):\n" + transcriptText +
        "\n\nNow watch the scenes above in story order and write the recap narration." + extraPrompt + durHint });
      const text = await geminiGenerateParts(m, RECAP_VISION_SYSTEM, parts, 8192);
      const { segments: segs, errors: segErrs } = parseRecapSegmentsStrict(text);
      if (segErrs.length) throw new Error("Timestamp အမှား:\n" + segErrs.slice(0, 5).join("\n"));
      if (!segs.length) throw new Error("script format မမှန်ပါ — segment မရှိပါ");
      return segs;
    } catch (e) {
      lastErr = e;
      try { console.warn("[gemini] model", m, "failed:", String(e.message || e).slice(0, 200)); } catch (_) {}
    }
  }
  throw lastErr;
}

/** Extract up to maxFrames JPEG scene frames from a video blob. Returns [{at, b64}]. */
export async function extractSceneFrames(file, maxFrames, onprog) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => {
        // Diagnostic: log file details and video error code (never API keys)
        const ec = v.error ? v.error.code : "?";
        const em = v.error ? (v.error.message || "") : "";
        try {
          console.warn(`[extractSceneFrames] video load failed: name=${file.name || "?"} type=${file.type || "?"} size=${file.size || "?"} error.code=${ec} ${em}`);
        } catch (_) {}
        rej(new Error(`video ဖတ်မရပါ (${file.name || "file"}, type=${file.type || "?"}, code=${ec}) — browser ဒီ format ကို decode မရပါ`));
      };
    });
    const dur = v.duration || 0;
    const n = Math.max(6, Math.min(maxFrames || 40, Math.floor(dur / 10)));
    if (!dur || dur < 5 || n < 4) return [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min((dur * (i + 0.5)) / n, Math.max(0, dur - 0.2));
      await new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; v.removeEventListener("seeked", on); res(); } };
        const on = fin;
        v.addEventListener("seeked", on);
        setTimeout(fin, 4000);
        try { v.currentTime = t; } catch (_) { fin(); }
      });
      const scale = Math.min(1, 480 / (v.videoWidth || 480));
      canvas.width = Math.max(2, Math.round(v.videoWidth * scale));
      canvas.height = Math.max(2, Math.round(v.videoHeight * scale));
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.7));
      if (blob) frames.push({ at: t, b64: await blobToBase64(blob) });
      if (onprog) { try { onprog(i + 1, n); } catch (_) {} }
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Returns [{start,end,text}] recap segments. Tries 2.0-flash then 2.5-flash. */
export async function geminiRecapScript(transcriptText, extraPrompt="", opts={}) {
  // Issue 1: Duration target — aim for ~50% of source, ±10% tolerance
  const targetMin = opts.targetMinutes;
  const durHint = targetMin
    ? `\nDURATION TARGET: Write enough segments for ~${targetMin} minutes of narration (~${Math.round(targetMin*60/8)} segments of 8-10 sec each). Do NOT be overly concise — cover key events.`
    : "";
  const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
  let lastErr = null;
  for (const m of models) {
    try {
      const text = await geminiGenerate(
        m, RECAP_SYSTEM,
        "Write the recap narration for this transcript:\n\n" + transcriptText + extraPrompt + durHint
      );
      const { segments: segs, errors: segErrs } = parseRecapSegmentsStrict(text);
      if (segErrs.length) throw new Error("Timestamp အမှား:\n" + segErrs.slice(0, 5).join("\n"));
      if (!segs.length) throw new Error("script format မမှန်ပါ — segment မရှိပါ");
      return segs;
    } catch (e) {
      lastErr = e;
      try { console.warn("[gemini] model", m, "failed:", String(e.message || e).slice(0, 200)); } catch (_) {}
    }
  }
  throw lastErr;
}


/** Assembly AI transcribe (browser direct) */
export async function aaiTranscribe(audioBlob, apiKey) {
  if (!apiKey) throw new Error("Assembly AI key မရှိပါ");
  const H = { authorization: apiKey };
  // 1. Upload
  const up = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST", headers: H, body: audioBlob,
  });
  if (!up.ok) throw new Error("AssemblyAI upload failed: " + up.status);
  const { upload_url } = await up.json();
  // 2. Request transcript
  const tr = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
  });
  if (!tr.ok) throw new Error("AssemblyAI transcript failed: " + tr.status);
  const { id } = await tr.json();
  // 3. Poll
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: H });
    const j = await st.json();
    if (j.status === "completed") {
      const words = j.words || [];
      // Group words into segments (max 8s or 25 words)
      const segs = [];
      let cur = null;
      for (const w of words) {
        const s = w.start / 1000, e = w.end / 1000;
        if (!cur || s - cur.end > 0.7 || cur.words.length >= 25 || e - cur.start > 8) {
          if (cur) segs.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
          cur = { start: s, end: e, words: [w.text] };
        } else {
          cur.end = e; cur.words.push(w.text);
        }
      }
      if (cur) segs.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
      return segs;
    }
    if (j.status === "error") throw new Error("AssemblyAI: " + (j.error || "failed"));
  }
  throw new Error("AssemblyAI timeout");
}

/** Extract story memory from recap segments (characters, places, plot) */
export async function extractStoryMemory(segments) {
  const text = segments.map((s) => s.text).join("\n").slice(0, 4000);
  if (!text.trim()) return "";
  const prompt = "From this recap narration, extract:\n" +
    "1. Characters (name = role, e.g. လီဝေ = မင်းသား)\n" +
    "2. Places\n" +
    "3. Key plot points (2-3 lines)\n\n" +
    "Write in Burmese, concise. Format:\n" +
    "ဇာတ်ကောင်: ...\nနေရာ: ...\nအဖြစ်: ...\n\nNarration:\n" + text;
  try {
    const result = await geminiText(prompt, 1000);
    return (result || "").trim();
  } catch (_) { return ""; }
}

/**
 * PHASE 1 TIMING CONTRACT
 * -----------------------
 * Recap segments use EXPLICIT timeline fields:
 * - outputStart/outputEnd: position in the OUTPUT narration timeline (seconds).
 *   The AI generates these as sequential narration timestamps (e.g. 00:00, 00:12).
 *   These are NOT source-video timestamps.
 * - sourceStart/sourceEnd: position in the SOURCE/ORIGINAL video (seconds).
 *   Only set when the generation mode genuinely provides source timestamps.
 *   Currently most recap modes do NOT provide these — do not guess them.
 * - audioDuration: measured TTS audio length for this segment (seconds).
 *
 * DEPRECATED aliases `start`/`end` are kept for backward compatibility.
 * They ALWAYS mean output timeline. Do NOT use them to seek source video.
 */
export function parseRecapSegments(text) {
  const segs = [];
  // Accept -, –, —, and "00:00 - 00:12" format
  const re = /\[?(\d{1,3}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{1,3}:\d{2}(?::\d{2})?)\]?\s*(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const a = parseClock(m[1]), b = parseClock(m[2]);
    if (a !== null && b !== null && b > a && m[3].trim()) {
      segs.push({
        outputStart: a, outputEnd: b,
        start: a, end: b,  // DEPRECATED alias = output timeline
        text: m[3].trim(),
        // sourceStart/sourceEnd intentionally NOT set — unknown
      });
    }
  }
  return segs;
}

/**
 * Validate recap segment timestamps. Returns {ok, errors[]}.
 * - Checks finite, non-negative, end > start
 * - If sourceDuration given AND seg has sourceStart/sourceEnd, validates against it
 * - Does NOT silently clamp, swap, or guess
 */
export function validateRecapSegments(segs, opts = {}) {
  const errors = [];
  const srcDur = opts.sourceDuration;
  if (!Array.isArray(segs) || !segs.length) {
    return { ok: false, errors: ["Segment မရှိပါ"] };
  }
  // Fail fast: reject segments with no real text (e.g. only "]" or punctuation)
  const emptySegs = [];
  for (let i = 0; i < segs.length; i++) {
    if (!hasRealText(segs[i] && segs[i].text)) emptySegs.push(i + 1);
  }
  if (emptySegs.length) {
    return { ok: false, errors: [`စာသားမပါတဲ့ segments: ${emptySegs.slice(0,5).join(", ")}${emptySegs.length > 5 ? "..." : ""} (${emptySegs.length}/${segs.length}) — Script ပြန်ထုတ်ပါ`] };
  }
  segs.forEach((s, i) => {
    const n = i + 1;
    const os = s.outputStart ?? s.start;
    const oe = s.outputEnd ?? s.end;
    const hasOutput = os !== undefined && os !== null && os !== "";
    const hasSource = s.sourceStart !== undefined || s.sourceEnd !== undefined;
    const chk = (v, name) => {
      if (v === undefined || v === null || v === "")
        errors.push(`Segment ${n}: ${name} မရှိပါ`);
      else if (typeof v !== "number" || !isFinite(v))
        errors.push(`Segment ${n}: ${name} ဂဏန်း မဟုတ်ပါ (${v})`);
      else if (v < 0)
        errors.push(`Segment ${n}: ${name} အနုတ် မရ (${v})`);
    };
    // Phase 2/3: output timeline optional if source timeline present
    // (output calculated later from audio durations)
    if (hasOutput) { chk(os, "outputStart"); chk(oe, "outputEnd"); }
    else if (!hasSource) errors.push(`Segment ${n}: outputStart/outputEnd သို့မဟုတ် sourceStart/sourceEnd တခု လို`);
    if (typeof os === "number" && typeof oe === "number" && isFinite(os) && isFinite(oe)) {
      if (oe <= os)
        errors.push(`Segment ${n}: outputEnd (${fmtClock(oe)}) သည် outputStart (${fmtClock(os)}) ထက် ကြီး ရ မယ်`);
    }
    // Source timeline validation — ONLY if source fields are present
    if (s.sourceStart !== undefined || s.sourceEnd !== undefined) {
      chk(s.sourceStart, "sourceStart"); chk(s.sourceEnd, "sourceEnd");
      if (typeof s.sourceStart === "number" && typeof s.sourceEnd === "number" &&
          isFinite(s.sourceStart) && isFinite(s.sourceEnd) && s.sourceEnd <= s.sourceStart)
        errors.push(`Segment ${n}: sourceEnd သည် sourceStart ထက် ကြီး ရ မယ်`);
      if (srcDur && isFinite(srcDur)) {
        // Allow 5s tolerance for AI imprecision (e.g. 08:04 vs 08:02) — clamp with warning, not silent
        const TOL = 5;
        if (typeof s.sourceEnd === "number" && s.sourceEnd > srcDur + TOL)
          errors.push(`Segment ${n}: sourceEnd (${fmtClock(s.sourceEnd)}) သည် video အရှည် (${fmtClock(srcDur)}) ထက် အများ ကြီး ကျော် နေ`);
        else if (typeof s.sourceEnd === "number" && s.sourceEnd > srcDur) {
          try { console.warn(`[validate] Segment ${n}: sourceEnd clamped ${fmtClock(s.sourceEnd)} → ${fmtClock(srcDur)}`); } catch (_) {}
          s.sourceEnd = srcDur;
        }
        if (typeof s.sourceStart === "number" && s.sourceStart >= srcDur + TOL)
          errors.push(`Segment ${n}: sourceStart သည် video အရှည် ထက် အများ ကြီး ကျော် နေ`);
        else if (typeof s.sourceStart === "number" && s.sourceStart >= srcDur) {
          try { console.warn(`[validate] Segment ${n}: sourceStart clamped to ${fmtClock(srcDur - 1)}`); } catch (_) {}
          s.sourceStart = Math.max(0, srcDur - 1);
        }
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Gap-2: Strict recap parser — reports malformed timestamp lines explicitly
 * instead of silently skipping them. Returns {segments, errors}.
 * - Empty lines are ignored (not errors).
 * - Lines that look like segment attempts (contain [ ] or timestamp-like text)
 *   but fail to parse are reported as errors with line numbers.
 */
export // Check if text contains real content (not just punctuation/brackets/whitespace)
// Returns true if there's at least one letter/number character
function hasRealText(s) {
  if (!s) return false;
  // Must contain at least one letter (any language) or digit
  return /[\p{L}\p{N}]/u.test(s);
}

function parseRecapSegmentsStrict(text) {
  const segments = [];
  const errors = [];
  const lines = (text || "").split("\n");
  // Phase 2: [SRC 03:10-03:25] = source-video timestamps (preferred)
  const reSrc = /\[SRC\s+(\d{1,3}:\d{2}(?::\d{2})?)\s*[-\u2013\u2014]\s*(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)/i;
  // Legacy: [00:00-00:12] = output timeline (no source info)
  const reLegacy = /\[?(\d{1,3}:\d{2}(?::\d{2})?)\s*[-\u2013\u2014]\s*(\d{1,3}:\d{2}(?::\d{2})?)\]?\s*(.+)/;
  const looksLikeSeg = /\[|\d{1,4}:\d{2}/;
  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const t = ln.trim();
    if (!t) return;
    let m = t.match(reSrc);
    if (m) {
      const a = parseClock(m[1]), b = parseClock(m[2]);
      if (a === null) errors.push(`Line ${lineNo}: source start "${m[1]}" မမှန်ပါ`);
      else if (b === null) errors.push(`Line ${lineNo}: source end "${m[2]}" မမှန်ပါ`);
      else if (b <= a) errors.push(`Line ${lineNo}: source end \u101e\u100a\u103a start \u1011\u1000\u103a \u1000\u103c\u102e\u1038\u101b\u1019\u101a\u103a`);
      else if (!hasRealText(m[3])) errors.push(`Line ${lineNo}: စာသား မရှိပါ`);
      else segments.push({ sourceStart: a, sourceEnd: b, text: m[3].trim() });
      return;
    }
    m = t.match(reLegacy);
    if (m) {
      const a = parseClock(m[1]), b = parseClock(m[2]);
      if (a === null) errors.push(`Line ${lineNo}: start "${m[1]}" မမှန်ပါ`);
      else if (b === null) errors.push(`Line ${lineNo}: end "${m[2]}" မမှန်ပါ`);
      else if (b <= a) errors.push(`Line ${lineNo}: end သည် start ထက် ကြီးရမယ်`);
      else if (!hasRealText(m[3])) errors.push(`Line ${lineNo}: စာသား မရှိပါ`);
      else segments.push({ outputStart: a, outputEnd: b, start: a, end: b, text: m[3].trim() });
    } else if (looksLikeSeg.test(t)) {
      errors.push(`Line ${lineNo}: format မမှန်ပါ`);
    }
  });
  return { segments, errors };
}

/**
 * Build output timeline from actual audio durations.
 * Returns new array with outputStart/outputEnd set cumulatively.
 */
export function buildOutputTimeline(segs) {
  let t = 0;
  return segs.map((s) => {
    const dur = (typeof s.audioDur === "number" && isFinite(s.audioDur) && s.audioDur > 0)
      ? s.audioDur
      : (typeof s.audioDuration === "number" && isFinite(s.audioDuration) && s.audioDuration > 0
        ? s.audioDuration : 0);
    const out = { ...s, outputStart: t, outputEnd: t + dur };
    t = out.outputEnd;
    return out;
  });
}

export function segmentsToSRT(segs) {
  return segs.map((s, i) => {
    const a = s.outputStart ?? s.start;
    const b = s.outputEnd ?? s.end;
    // Validate: must be finite, non-negative, end > start
    if (typeof a !== "number" || !isFinite(a) || a < 0 ||
        typeof b !== "number" || !isFinite(b) || b <= a) {
      throw new Error(`SRT segment ${i + 1}: invalid timestamps (start=${a}, end=${b})`);
    }
    return (i + 1) + "\n" + toSRTTime(a) + " --> " + toSRTTime(b) + "\n" + s.text + "\n";
  }).join("\n");
}
