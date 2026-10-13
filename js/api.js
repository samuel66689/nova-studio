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

function blobToBase64(blob) {
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
async function geminiGenerate(model, systemText, userText, maxTokens) {
  const { gemini } = getKeys();
  if (!gemini) throw new Error("Gemini API key မထည့်ရသေးပါ — ⚙️ Settings မှာ ထည့်ပါ");
  const body = {
    contents: [{ parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: maxTokens || 8192 },
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  let res;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model +
      ":generateContent?key=" + encodeURIComponent(gemini),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
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
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
    encodeURIComponent(gemini),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error("Gemini transcribe error " + res.status);
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
  "3. Output ONLY segment lines, one per line, in this EXACT format:",
  "[00:00-00:12] narration text here",
  "[00:12-00:25] narration text here",
  "4. Each segment must be 5 to 12 seconds of spoken narration.",
  "5. No Chinese, Thai or Latin characters in the output — except well-known brand names and real person names (transliterate everything else into Burmese).",
  "6. No intro, no outro, no markdown, no numbering — only the segment lines.",
].join("\n");

/** Returns [{start,end,text}] recap segments. Tries 2.0-flash then 2.5-flash. */
export async function geminiRecapScript(transcriptText) {
  const models = ["gemini-2.0-flash", "gemini-2.5-flash"];
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
