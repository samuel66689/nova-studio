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
