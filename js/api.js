// api.js — Groq + Gemini calls (direct from browser), key storage, helpers

export function getKeys() {
  return {
    groq: (localStorage.getItem("nova_groq_key") || "").trim(),
    gemini: (localStorage.getItem("nova_gemini_key") || "").trim(),
  };
}
export function saveKeys(groq, gemini) {
  localStorage.setItem("nova_groq_key", (groq || "").trim());
  localStorage.setItem("nova_gemini_key", (gemini || "").trim());
}
export function clearKeys() {
  localStorage.removeItem("nova_groq_key");
  localStorage.removeItem("nova_gemini_key");
}

// ---------- time helpers ----------
export function pad2(n) { return String(n).padStart(2, "0"); }

export function fmtClock(sec) {
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

export function parseClock(str) {
  const p = String(str).split(":").map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
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
async function geminiGenerateParts(model, systemText, parts, maxTokens) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ — ⚙️ Settings မှာ ထည့်ပါ");
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.8, maxOutputTokens: maxTokens || 8192 },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
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
  const j = await res.json();
  const text = ((j.candidates || [])[0] || {}).content?.parts
    ?.map((p) => p.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini က စာမပြန်ပါ — ပြန်ကြိုးစားပါ");
  return text;
}

/** Gemini Files API: upload video file, returns file URI. */
export async function geminiUploadVideo(file, onprog) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ");
  // Step 1: initiate resumable upload
  const meta = { file: { displayName: file.name || "video.mp4", mimeType: file.type || "video/mp4" } };
  let res;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/upload/v1beta/files",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": gemini,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(file.size),
          "X-Goog-Upload-Header-Content-Type": file.type || "video/mp4",
        },
        body: JSON.stringify(meta),
      }
    );
  } catch (e) {
    throw new Error("Gemini Files upload စမရပါ — internet စစ်ပါ");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Files upload init error " + res.status + ": " + t.slice(0, 180));
  }
  const uploadUrl = res.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Upload URL မရပါ");
  // Step 2: upload bytes
  const ures = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(file.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: file,
  });
  if (!ures.ok) {
    const t = await ures.text().catch(() => "");
    throw new Error("Files upload error " + ures.status + ": " + t.slice(0, 180));
  }
  const uj = await ures.json();
  const fileUri = uj.file && uj.file.uri;
  const fileName = uj.file && uj.file.name;
  if (!fileUri) throw new Error("File URI မရပါ");
  // Step 3: wait for ACTIVE
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (onprog) { try { onprog(i + 1); } catch (_) {} }
    const sres = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/" + fileName,
      { headers: { "x-goog-api-key": gemini } }
    );
    if (!sres.ok) continue;
    const sj = await sres.json();
    const state = sj.state || (sj.file && sj.file.state);
    if (state === "ACTIVE") return fileUri;
    if (state === "FAILED") throw new Error("Video process မအောင်မြင်ပါ");
  }
  throw new Error("Video process ကြာလွန်းနေပါတယ် — ပြန်ကြိုးစားပါ");
}

/** Style prompts for recap narration. */
export const RECAP_STYLES = {
  story: [
    "You are a professional Burmese recap narrator for short drama videos.",
    "STYLE: STORY — calm, clear storytelling. Focus on plot, character motivations, and emotional beats.",
    "Write NATURAL SPOKEN BURMESE (စကားပြောဟန်).",
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
export async function geminiRecapFromVideoFile(fileUri, style) {
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
    "[00:00-00:12] narration text here",
    "7. Each segment must be 5 to 12 seconds of spoken narration.",
    "8. The LAST segment may end with a short teaser hook for the next episode.",
    "9. No Chinese, Thai or Latin characters — except brand/person names (transliterate rest).",
    "10. No intro, no markdown, no numbering — only segment lines.",
  ].join("\n");
  let lastErr = null;
  for (const m of models) {
    try {
      const { gemini } = getKeys();
      const body = {
        contents: [{ parts: [
          { fileData: { mimeType: "video/mp4", fileUri } },
          { text: "Watch this video completely and write the Burmese recap narration." },
        ]}],
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
        systemInstruction: { parts: [{ text: systemText }] },
      };
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": gemini }, body: JSON.stringify(body) }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("Gemini (" + m + ") error " + res.status + ": " + t.slice(0, 180));
      }
      const j = await res.json();
      const text = ((j.candidates || [])[0] || {}).content?.parts
        ?.map((p) => p.text || "").join("") || "";
      const segs = parseRecapSegments(text);
      if (!segs.length) throw new Error("script format မမှန်ပါ");
      return segs;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Gemini fallback transcription. Returns [{start,end,text}]. */
export async function geminiTranscribe(mp3Blob) {
  const b64 = await blobToBase64(mp3Blob);
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ");
  const body = {
    contents: [{ parts: [
      { text: "Transcribe this audio completely. Output ONLY lines in this exact format, one per line:\n[MM:SS] transcribed text\nUse the timestamp of when each line starts. No other commentary." },
      { inlineData: { mimeType: "audio/mpeg", data: b64 } },
    ]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };
  let res = null, terr = null;
  for (const m of ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"]) {
    try {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": gemini }, body: JSON.stringify(body) }
      );
      if (!res.ok) throw new Error("Gemini transcribe error " + res.status);
      break;
    } catch (e) { terr = e; res = null; }
  }
  if (!res) throw terr || new Error("Gemini transcribe မအောင်မြင်ပါ");
  const j = await res.json();
  const text = ((j.candidates || [])[0] || {}).content?.parts
    ?.map((p) => p.text || "").join("") || "";
  const lines = text.split("\n");
  const segs = [];
  for (const ln of lines) {
    const m = ln.match(/\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)/);
    if (m) {
      const start = parseClock(m[1]);
      if (start !== null && m[2].trim()) segs.push({ start, end: 0, text: m[2].trim() });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    segs[i].end = (i + 1 < segs.length) ? segs[i + 1].start : segs[i].start + 5;
  }
  if (!segs.length) throw new Error("Gemini transcribe က စာမထွက်ပါ");
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
  "[00:00-00:12] narration text here",
  "[00:12-00:25] narration text here",
  "6. Each segment must be 5 to 12 seconds of spoken narration.",
  "7. The LAST segment may end with a short teaser hook for the next episode (one sentence).",
  "8. No Chinese, Thai or Latin characters in the output — except well-known brand names and real person names (transliterate everything else into Burmese).",
  "9. No intro, no markdown, no numbering — only the segment lines.",
].join("\n");

async function geminiGenerate(model, systemText, userText, maxTokens) {
  return geminiGenerateParts(model, systemText, [{ text: userText }], maxTokens);
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
  "[00:00-00:12] narration text here",
  "[00:12-00:25] narration text here",
  "8. Each segment must be 5 to 12 seconds of spoken narration.",
  "9. The LAST segment may end with a short teaser hook for the next episode (one sentence).",
  "10. No Chinese, Thai or Latin characters in the output — except well-known brand names and real person names (transliterate everything else into Burmese).",
  "11. No intro, no markdown, no numbering — only the segment lines.",
].join("\n");

/** Multimodal recap: scene frames + transcript. frames = [{at, b64}]. */
export async function geminiRecapScriptVision(frames, transcriptText) {
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
        "\n\nNow watch the scenes above in story order and write the recap narration." });
      const text = await geminiGenerateParts(m, RECAP_VISION_SYSTEM, parts, 8192);
      const segs = parseRecapSegments(text);
      if (!segs.length) throw new Error("script format မမှန်ပါ");
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
      v.onerror = () => rej(new Error("video ဖတ်မရပါ"));
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
export async function geminiRecapScript(transcriptText) {
  const models = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
  let lastErr = null;
  for (const m of models) {
    try {
      const text = await geminiGenerate(
        m, RECAP_SYSTEM,
        "Write the recap narration for this transcript:\n\n" + transcriptText
      );
      const segs = parseRecapSegments(text);
      if (!segs.length) throw new Error("script format မမှန်ပါ");
      return segs;
    } catch (e) {
      lastErr = e;
      try { console.warn("[gemini] model", m, "failed:", String(e.message || e).slice(0, 200)); } catch (_) {}
    }
  }
  throw lastErr;
}

export function parseRecapSegments(text) {
  const segs = [];
  const re = /\[(\d{1,3}:\d{2}(?::\d{2})?)-(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const a = parseClock(m[1]), b = parseClock(m[2]);
    if (a !== null && b !== null && b > a && m[3].trim()) {
      segs.push({ start: a, end: b, text: m[3].trim() });
    }
  }
  return segs;
}

export function segmentsToSRT(segs) {
  return segs.map((s, i) =>
    (i + 1) + "\n" + toSRTTime(s.start) + " --> " + toSRTTime(s.end) + "\n" + s.text + "\n"
  ).join("\n");
}
