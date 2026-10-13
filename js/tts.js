// tts.js — Microsoft Edge TTS via WebSocket (browser only, no server)
const EDGE_WS =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
  "?trustedclienttoken=6A5AA1D4EAFF4B2FB37E23D68491D6F4";

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}

function randHex(n) {
  const a = new Uint8Array(n / 2);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Synthesize text with Edge TTS. Resolves to an audio/mpeg Blob.
 * Throws a Burmese error if the WebSocket path fails.
 */
export function edgeTTS(text, voice) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) { resolve(new Blob([], { type: "audio/mpeg" })); return; }
    let ws;
    try {
      ws = new WebSocket(EDGE_WS);
    } catch (e) {
      reject(new Error("Edge TTS ချိတ်ဆက်မှု မအောင်မြင်ပါ — internet စစ်ပါ"));
      return;
    }
    ws.binaryType = "arraybuffer";
    const chunks = [];
    let done = false;
    const finish = (ok, val) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) {}
      if (ok) resolve(val); else reject(val);
    };
    const ts = new Date().toString();
    const timer = setTimeout(() => {
      finish(false, new Error("Edge TTS အချိန်လွန်သွားပါတယ် (timeout) — ပြန်ကြိုးစားပါ"));
    }, 90000);

    ws.onopen = () => {
      ws.send(
        "X-Timestamp:" + ts + "\r\n" +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
      );
      const rid = randHex(32);
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
    };

    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        if (d.includes("Path:turn.end")) {
          clearTimeout(timer);
          finish(true, new Blob(chunks, { type: "audio/mpeg" }));
        }
        return;
      }
      try {
        const view = new DataView(d);
        const hlen = view.getUint16(0, false); // big-endian header length
        const header = new TextDecoder().decode(d.slice(2, 2 + hlen));
        if (header.includes("Path:audio")) {
          chunks.push(d.slice(2 + hlen));
        } else if (header.includes("Path:turn.end")) {
          clearTimeout(timer);
          finish(true, new Blob(chunks, { type: "audio/mpeg" }));
        }
      } catch (e) {
        clearTimeout(timer);
        finish(false, e);
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      finish(false, new Error("Edge TTS ချိတ်ဆက်မှု မအောင်မြင်ပါ — internet / VPN စစ်ပါ"));
    };
    ws.onclose = () => {
      if (!done) {
        clearTimeout(timer);
        finish(false, new Error("Edge TTS ဆက်သွယ်မှု ပြတ်တောက်သွားပါတယ်"));
      }
    };
  });
}


/** PCM s16le mono -> WAV blob (Gemini TTS returns raw PCM). */
function pcmToWav(pcmBytes, sampleRate) {
  const n = pcmBytes.length;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).set(pcmBytes);
  return new Blob([buf], { type: "audio/wav" });
}

const GEMINI_TTS_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"];

/**
 * Gemini native TTS (works through the same API key — VPN-safe).
 * Returns a WAV blob (24kHz mono). Throws Burmese error on failure.
 */
export async function geminiTTS(text, voiceName, apiKey) {
  if (!text || !text.trim()) return new Blob([], { type: "audio/wav" });
  if (!apiKey) throw new Error("Gemini API key မထည့်ရသေးပါ — \u2699\ufe0f Settings မှာ ထည့်ပါ");
  let lastErr = null;
  for (const m of GEMINI_TTS_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent",
        {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Read aloud in a natural, warm narrator voice: " + text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || "Kore" } } },
            },
          }),
        }
      );
      clearTimeout(timer);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("Gemini TTS (" + m + ") error " + res.status + ": " + t.slice(0, 150));
      }
      const j = await res.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      let b64 = null;
      for (const pt of parts) {
        if (pt.inlineData && pt.inlineData.data) { b64 = pt.inlineData.data; break; }
      }
      if (!b64) throw new Error("Gemini TTS: အသံမရပါ — ပြန်ကြိုးစားပါ");
      const pcm = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (!pcm.length) throw new Error("Gemini TTS: အသံဗလာ ဖြစ်နေပါတယ်");
      return pcmToWav(pcm, 24000);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? new Error("Gemini TTS အချိန်လွန်သွားပါတယ်") : e;
    }
  }
  throw lastErr || new Error("Gemini TTS မအောင်မြင်ပါ");
}

/** Live playback preview only (no recording) — honest fallback. */
export function previewWithWebSpeech(text, lang) {
  try {
    if (!("speechSynthesis" in window)) return false;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "my-MM";
    speechSynthesis.speak(u);
    return true;
  } catch (_) {
    return false;
  }
}
