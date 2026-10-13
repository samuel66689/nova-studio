// app.js — Nova Studio UI wiring (3 tabs). All compute runs in this browser.
import { ensureFFmpeg, fetchFile, setProgressHandler, ffmpegMode } from "./js/ffmpeg.js";
import { edgeTTS, previewWithWebSpeech } from "./js/tts.js";
import {
  getKeys, saveKeys, clearKeys,
  groqTranscribe, geminiTranscribe, geminiRecapScript,
  segmentsToSRT, mediaDuration, fmtClock, pad2,
} from "./js/api.js";

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const now = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

function log(tab, msg, cls) {
  const box = $(tab + "Log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = "[" + now() + "] ";
  line.appendChild(t);
  line.appendChild(document.createTextNode(msg));
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setProgress(tab, pct, label) {
  $(tab + "Progress").style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (label !== undefined) $(tab + "ProgressLabel").textContent = label;
}

function setBusy(ids, busy) {
  for (const id of ids) $(id).disabled = busy;
}

function fmtSize(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
}

function dlRow(name, blob, mime) {
  const url = URL.createObjectURL(blob);
  const row = document.createElement("div");
  row.className = "part";
  const s = document.createElement("span");
  s.textContent = name + " (" + fmtSize(blob.size) + ")";
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = "⬇️ Download";
  row.appendChild(s);
  row.appendChild(a);
  return { row, anchor: a };
}

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tabpage").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------- settings ----------
(function initKeys() {
  const k = getKeys();
  $("groqKey").value = k.groq;
  $("geminiKey").value = k.gemini;
  updateKeyStatus();
})();
function updateKeyStatus() {
  const k = getKeys();
  const parts = [];
  if (k.groq) parts.push("Groq ✅"); else parts.push("Groq ❌");
  if (k.gemini) parts.push("Gemini ✅"); else parts.push("Gemini ❌");
  $("keyStatus").textContent = parts.join(" · ") +
    (k.groq && k.gemini ? " — အဆင်သင့်ပါပြီ" : " — လိုအပ်တဲ့ key ထည့်ပါ");
}
$("saveKeys").addEventListener("click", () => {
  saveKeys($("groqKey").value, $("geminiKey").value);
  updateKeyStatus();
  alert("Keys တွေ သိမ်းပြီးပါပြီ ✅");
});
$("clearKeys").addEventListener("click", () => {
  if (!confirm("Keys တွေ ဖျက်မှာလား?")) return;
  clearKeys();
  $("groqKey").value = "";
  $("geminiKey").value = "";
  updateKeyStatus();
});

// ============================================================
// TAB 1 — NOVA CUT
// ============================================================
let cutFile = null;
$("cutFile").addEventListener("change", async (e) => {
  cutFile = e.target.files[0] || null;
  $("cutResults").innerHTML = "";
  $("downloadAll").style.display = "none";
  if (!cutFile) { $("cutFileInfo").textContent = ""; return; }
  $("cutFileInfo").textContent = cutFile.name + " (" + fmtSize(cutFile.size) + ") — duration ဖတ်နေပါတယ်…";
  try {
    const d = await mediaDuration(cutFile);
    $("cutFileInfo").textContent = cutFile.name + " (" + fmtSize(cutFile.size) + ", " + fmtClock(d) + " ကြာတယ်)";
    cutFile._dur = d;
  } catch (err) {
    $("cutFileInfo").textContent = cutFile.name + " (" + fmtSize(cutFile.size) + ")";
  }
});

$("startCut").addEventListener("click", async () => {
  if (!cutFile) { alert("Video file အရင်ရွေးပါ"); return; }
  const minutes = Math.max(1, parseFloat($("cutMinutes").value) || 8);
  const partSec = minutes * 60;
  setBusy(["startCut", "downloadAll"], true);
  $("cutResults").innerHTML = "";
  $("downloadAll").style.display = "none";
  const anchors = [];
  try {
    log("cut", "FFmpeg ပြင်ဆင်နေပါတယ်…");
    const ff = await ensureFFmpeg((m, c) => log("cut", m, c));
    let duration = cutFile._dur;
    if (!duration) duration = await mediaDuration(cutFile);
    const total = Math.ceil(duration / partSec);
    log("cut", `စုစုပေါင်း ${total} ပိုင်း ဖြတ်ပါမယ် (${minutes} မိနစ်စီ)`, "ok");

    setProgressHandler((p) => setProgress("cut", (p * 100) / total + (0), `အပိုင်း ${1}/${total}…`));
    await ff.writeFile("input.mp4", await fetchFile(cutFile));

    for (let i = 0; i < total; i++) {
      const start = i * partSec;
      const dur = Math.min(partSec, duration - start);
      const outName = "part" + String(i + 1).padStart(2, "0") + ".mp4";
      setProgressHandler((p) => setProgress("cut",
        ((i + p) / total) * 100, `အပိုင်း ${i + 1}/${total} ဖြတ်နေပါတယ်…`));
      log("cut", `အပိုင်း ${i + 1}/${total} (${fmtClock(start)} → ${fmtClock(start + dur)})…`);
      await ff.exec(["-ss", start.toFixed(2), "-t", dur.toFixed(2),
        "-i", "input.mp4", "-c", "copy", outName]);
      const data = await ff.readFile(outName);
      await ff.deleteFile(outName);
      const blob = new Blob([data], { type: "video/mp4" });
      const fname = cutFile.name.replace(/\.[^.]+$/, "") + "_p" + (i + 1) + ".mp4";
      const { row, anchor } = dlRow(fname, blob, "video/mp4");
      $("cutResults").appendChild(row);
      anchors.push(anchor);
      log("cut", `အပိုင်း ${i + 1} ပြီးပါပြီ ✅`, "ok");
    }
    await ff.deleteFile("input.mp4");
    setProgress("cut", 100, "ပြီးပါပြီ ✅ — download ခလုတ်နှိပ်ရင် ချက်ချင်း save ချမှာပါ");
    log("cut", `အားလုံးပြီးပါပြီ (${total} ပိုင်း) 🎉`, "ok");
    if (anchors.length > 1) $("downloadAll").style.display = "";
    $("downloadAll").onclick = async () => {
      for (const a of anchors) { a.click(); await new Promise((r) => setTimeout(r, 600)); }
    };
  } catch (e) {
    log("cut", "အမှား: " + (e.message || e), "err");
    setProgress("cut", 0, "");
  } finally {
    setProgressHandler(null);
    setBusy(["startCut", "downloadAll"], false);
  }
});

// ============================================================
// TAB 2 — VIDEO EDITOR
// ============================================================
let edFile = null, edSrt = null;
$("edFile").addEventListener("change", async (e) => {
  edFile = e.target.files[0] || null;
  $("edResults").innerHTML = "";
  if (!edFile) { $("edFileInfo").textContent = ""; return; }
  $("edFileInfo").textContent = edFile.name + " (" + fmtSize(edFile.size) + ")";
});
$("srtFile").addEventListener("change", (e) => {
  edSrt = e.target.files[0] || null;
});

function escDrawtext(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

$("startEdit").addEventListener("click", async () => {
  if (!edFile) { alert("Video file အရင်ရွေးပါ"); return; }
  setBusy(["startEdit", "extractAudio"], true);
  $("edResults").innerHTML = "";
  const vf = [];
  const crop = $("cropSel").value;
  if (crop === "16:9") vf.push("crop='min(iw,ih*16/9)':'min(ih,iw*9/16)'");
  else if (crop === "9:16") vf.push("crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'");
  else if (crop === "1:1") vf.push("crop='min(iw,ih)':'min(iw,ih)'");
  if ($("flipChk").checked) vf.push("hflip");
  const wm = $("wmText").value.trim();
  const wantSub = !!edSrt;
  const wantWm = wm.length > 0;
  if (wantWm) vf.push("drawtext=text='" + escDrawtext(wm) + "':fontsize=22:fontcolor=white@0.75:x=12:y=h-36");
  if ($("compressChk").checked) vf.push("scale=-2:480");
  if (wantSub) vf.push("subtitles=subs.srt");

  const baseName = edFile.name.replace(/\.[^.]+$/, "");
  try {
    log("ed", "FFmpeg ပြင်ဆင်နေပါတယ်…");
    const ff = await ensureFFmpeg((m, c) => log("ed", m, c));
    setProgressHandler((p) => setProgress("ed", p * 100, "လုပ်နေပါတယ်… " + Math.round(p * 100) + "%"));
    const files = { "input.mp4": await fetchFile(edFile) };
    if (wantSub) files["subs.srt"] = await fetchFile(edSrt);
    for (const [n, d] of Object.entries(files)) await ff.writeFile(n, d);

    let args, dropped = [];
    const buildArgs = (filters) => filters.length === 0
      ? ["-i", "input.mp4", "-c", "copy", "-movflags", "+faststart", "output.mp4"]
      : ["-i", "input.mp4", "-vf", filters.join(","),
         "-c:v", "libx264", "-preset", "fast", "-crf", "23",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "output.mp4"];

    // Try full filter chain; if it fails, drop subtitle/watermark (font ပြဿနာ) and retry.
    let cur = vf.slice();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      args = buildArgs(cur);
      log("ed", "Run #" + (attempt + 1) + (cur.length ? " filters: " + cur.join(" | ") : " (copy mode)"));
      try {
        await ff.exec(args);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const subIdx = cur.findIndex((f) => f.startsWith("subtitles="));
        const wmIdx = cur.findIndex((f) => f.startsWith("drawtext="));
        if (subIdx >= 0) {
          cur.splice(subIdx, 1); dropped.push("စာတန်းထိုး (subtitle font မရှိလို့)");
          log("ed", "⚠️ subtitle burn-in မရလို့ ကျော်ပြီး ဆက်လုပ်ပါမယ်", "err");
        } else if (wmIdx >= 0) {
          cur.splice(wmIdx, 1); dropped.push("watermark");
          log("ed", "⚠️ watermark မရလို့ ကျော်ပြီး ဆက်လုပ်ပါမယ်", "err");
        } else {
          break;
        }
      }
    }
    if (lastErr) throw lastErr;

    const data = await ff.readFile("output.mp4");
    const blob = new Blob([data], { type: "video/mp4" });
    for (const n of ["input.mp4", "subs.srt", "output.mp4"]) { try { await ff.deleteFile(n); } catch (_) {} }
    const { row } = dlRow(baseName + "_edited.mp4", blob);
    $("edResults").appendChild(row);
    setProgress("ed", 100, "ပြီးပါပြီ ✅");
    log("ed", "ပြီးပါပြီ ✅" + (dropped.length ? " (ကျော်သွားတာ: " + dropped.join(", ") + ")" : ""), "ok");
  } catch (e) {
    log("ed", "အမှား: " + (e.message || e), "err");
    setProgress("ed", 0, "");
  } finally {
    setProgressHandler(null);
    setBusy(["startEdit", "extractAudio"], false);
  }
});

$("extractAudio").addEventListener("click", async () => {
  if (!edFile) { alert("Video file အရင်ရွေးပါ"); return; }
  setBusy(["startEdit", "extractAudio"], true);
  $("edResults").innerHTML = "";
  try {
    log("ed", "အသံခွဲထုတ်နေပါတယ်…");
    const ff = await ensureFFmpeg((m, c) => log("ed", m, c));
    setProgressHandler((p) => setProgress("ed", p * 100, "အသံထုတ်နေပါတယ်…"));
    await ff.writeFile("input.mp4", await fetchFile(edFile));
    await ff.exec(["-i", "input.mp4", "-vn", "-acodec", "libmp3lame", "-q:a", "2", "audio.mp3"]);
    const data = await ff.readFile("audio.mp3");
    const blob = new Blob([data], { type: "audio/mpeg" });
    for (const n of ["input.mp4", "audio.mp3"]) { try { await ff.deleteFile(n); } catch (_) {} }
    const { row } = dlRow(edFile.name.replace(/\.[^.]+$/, "") + ".mp3", blob);
    $("edResults").appendChild(row);
    setProgress("ed", 100, "ပြီးပါပြီ ✅");
    log("ed", "MP3 ရပါပြီ ✅", "ok");
  } catch (e) {
    log("ed", "အမှား: " + (e.message || e), "err");
    setProgress("ed", 0, "");
  } finally {
    setProgressHandler(null);
    setBusy(["startEdit", "extractAudio"], false);
  }
});

// ============================================================
// TAB 3 — RECAP NOVA
// ============================================================
let rcFile = null;
$("rcFile").addEventListener("change", async (e) => {
  rcFile = e.target.files[0] || null;
  $("rcResults").innerHTML = "";
  if (!rcFile) { $("rcFileInfo").textContent = ""; return; }
  $("rcFileInfo").textContent = rcFile.name + " (" + fmtSize(rcFile.size) + ") — duration ဖတ်နေပါတယ်…";
  try {
    const d = await mediaDuration(rcFile);
    $("rcFileInfo").textContent = rcFile.name + " (" + fmtSize(rcFile.size) + ", " + fmtClock(d) + " ကြာတယ်)";
    rcFile._dur = d;
  } catch (err) {
    $("rcFileInfo").textContent = rcFile.name + " (" + fmtSize(rcFile.size) + ")";
  }
});

function setStep(name, cls) {
  const li = document.querySelector('#rcSteps li[data-step="' + name + '"]');
  if (li) li.className = cls || "";
}
function resetSteps() {
  document.querySelectorAll("#rcSteps li").forEach((li) => { li.className = ""; });
}

function splitLongText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = text.split(/(?<=[။.!?！？…])/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > maxLen && cur) { out.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

$("startRecap").addEventListener("click", async () => {
  if (!rcFile) { alert("Video file အရင်ရွေးပါ"); return; }
  const lang = $("rcLang").value;
  const voice = $("rcVoice").value;
  setBusy(["startRecap"], true);
  $("rcResults").innerHTML = "";
  $("rcTranscript").value = "";
  $("rcScript").value = "";
  resetSteps();
  const baseName = rcFile.name.replace(/\.[^.]+$/, "");

  try {
    log("rc", "FFmpeg ပြင်ဆင်နေပါတယ်…");
    const ff = await ensureFFmpeg((m, c) => log("rc", m, c));

    // ---- step 1: extract audio ----
    setStep("audio", "run");
    setProgressHandler((p) => setProgress("rc", p * 30, "အသံခွဲထုတ်နေပါတယ်…"));
    log("rc", "1️⃣ အသံခွဲထုတ်နေပါတယ်…");
    await ff.writeFile("input.mp4", await fetchFile(rcFile));
    await ff.exec(["-i", "input.mp4", "-vn", "-acodec", "libmp3lame", "-q:a", "2", "audio.mp3"]);
    const audioData = await ff.readFile("audio.mp3");
    const audioBlob = new Blob([audioData], { type: "audio/mpeg" });
    await ff.deleteFile("audio.mp3");
    await ff.deleteFile("input.mp4"); // free memory; re-write before mux
    log("rc", "အသံရပါပြီ (" + fmtSize(audioBlob.size) + ") ✅", "ok");
    setStep("audio", "done");

    // ---- step 2: transcribe (chunked if big) ----
    setStep("transcribe", "run");
    log("rc", "2️⃣ စာသားပြောင်းနေပါတယ် (Groq Whisper)…");
    const CHUNK_MB = 15;
    const sizeMB = audioBlob.size / 1048576;
    const audioDur = await mediaDuration(audioBlob).catch(() => 0);
    const nChunks = Math.max(1, Math.ceil(sizeMB / CHUNK_MB));
    const chunkDur = audioDur > 0 ? audioDur / nChunks : 0;
    log("rc", `အသံ ${nChunks} ပိုင်း ခွဲပြီး transcribe လုပ်ပါမယ်`);
    await ff.writeFile("taudio.mp3", await fetchFile(audioBlob));
    const allSegs = [];
    for (let i = 0; i < nChunks; i++) {
      const start = chunkDur * i;
      const dur = chunkDur > 0 ? Math.min(chunkDur, audioDur - start) : 0;
      const cname = "tchunk" + i + ".mp3";
      if (nChunks > 1 && chunkDur > 0) {
        await ff.exec(["-ss", start.toFixed(2), "-t", dur.toFixed(2),
          "-i", "taudio.mp3", "-c", "copy", cname]);
      } else {
        await ff.exec(["-i", "taudio.mp3", "-c", "copy", cname]);
      }
      const cdata = await ff.readFile(cname);
      await ff.deleteFile(cname);
      const cblob = new Blob([cdata], { type: "audio/mpeg" });
      setProgress("rc", 30 + ((i + 0.5) / nChunks) * 25,
        `transcribe လုပ်နေပါတယ်… (${i + 1}/${nChunks})`);
      let segs = null, err1 = null;
      try {
        segs = await groqTranscribe(cblob, lang);
        log("rc", `အပိုင်း ${i + 1}: Groq ရပါပြီ (${segs.length} ကြောင်း)`, "ok");
      } catch (e) {
        err1 = e;
        log("rc", `အပိုင်း ${i + 1}: Groq မရပါ (${e.message}) — Gemini နဲ့ စမ်းပါမယ်…`, "err");
      }
      if (!segs) {
        try {
          segs = await geminiTranscribe(cblob);
          log("rc", `အပိုင်း ${i + 1}: Gemini ရပါပြီ`, "ok");
        } catch (e2) {
          throw new Error(`transcribe မအောင်မြင်ပါ (အပိုင်း ${i + 1}): ` + (err1 ? err1.message : e2.message));
        }
      }
      for (const s of segs) allSegs.push({ start: s.start + start, end: s.end + start, text: s.text });
    }
    await ff.deleteFile("taudio.mp3");
    allSegs.sort((a, b) => a.start - b.start);
    const transcriptText = allSegs.map((s) => "[" + fmtClock(s.start) + "] " + s.text).join("\n");
    $("rcTranscript").value = transcriptText.slice(0, 6000);
    log("rc", `transcript ရပါပြီ (${allSegs.length} ကြောင်း) ✅`, "ok");
    setStep("transcribe", "done");

    // ---- step 3: recap script ----
    setStep("script", "run");
    setProgress("rc", 58, "Recap script ရေးနေပါတယ် (Gemini)…");
    log("rc", "3️⃣ Gemini က recap script ရေးနေပါတယ်…");
    const segments = await geminiRecapScript(transcriptText);
    $("rcScript").value = segments.map((s) =>
      `[${fmtClock(s.start)}-${fmtClock(s.end)}] ${s.text}`).join("\n");
    log("rc", `script ရပါပြီ (${segments.length} segments) ✅`, "ok");
    setStep("script", "done");

    // ---- step 4: TTS per segment ----
    setStep("tts", "run");
    log("rc", `4️⃣ အသံထွက်နေပါတယ် (Edge TTS — ${voice})…`);
    const ttsBlobs = [];
    let ttsFailed = null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      setProgress("rc", 60 + ((i + 1) / segments.length) * 25,
        `အသံထွက်နေပါတယ်… (${i + 1}/${segments.length})`);
      const pieces = splitLongText(seg.text, 700);
      try {
        for (const pc of pieces) {
          const b = await edgeTTS(pc, voice);
          if (b.size === 0) throw new Error("အသံဖိုင် ဗလာ ဖြစ်နေပါတယ်");
          ttsBlobs.push(b);
        }
        if ((i + 1) % 5 === 0 || i === segments.length - 1) {
          log("rc", `အသံ ${i + 1}/${segments.length} ပြီးပါပြီ`, "ok");
        }
      } catch (e) {
        ttsFailed = { index: i, text: seg.text, error: e };
        log("rc", `❌ အပိုင်း ${i + 1} TTS မအောင်မြင်ပါ: ${e.message}`, "err");
        break;
      }
    }
    if (ttsFailed) {
      setStep("tts", "fail");
      const { row } = dlRow("failed_segment.txt",
        new Blob([ttsFailed.text], { type: "text/plain" }));
      $("rcResults").appendChild(row);
      const prev = document.createElement("button");
      prev.className = "ghost";
      prev.textContent = "🔊 Web Speech နဲ့ အစမ်းနားထောင်မယ် (အသံမသိမ်းဘူး)";
      prev.onclick = () => {
        if (!previewWithWebSpeech(ttsFailed.text)) alert("ဒီ browser Web Speech မရပါ");
      };
      $("rcResults").appendChild(prev);
      throw new Error("TTS ရပ်သွားပါတယ် — internet စစ်ပြီး ပြန်ကြိုးစားပါ။ " +
        "အထက်က segments တွေတော့ script ထဲမှာ ကျန်ပါတယ်။");
    }
    log("rc", `အသံအားလုံး ရပါပြီ (${ttsBlobs.length} ပိုင်း) ✅`, "ok");
    setStep("tts", "done");

    // ---- step 5: concat + mux + srt ----
    setStep("mux", "run");
    setProgress("rc", 88, "Video နဲ့ တွဲနေပါတယ်…");
    log("rc", "5️⃣ အသံတွေ ဆက်ပြီး video နဲ့ တွဲနေပါတယ်…");
    const listTxt = ttsBlobs.map((_, i) => "file 'seg" + i + ".mp3'").join("\n");
    const enc = new TextEncoder();
    await ff.writeFile("list.txt", enc.encode(listTxt));
    for (let i = 0; i < ttsBlobs.length; i++) {
      await ff.writeFile("seg" + i + ".mp3", await fetchFile(ttsBlobs[i]));
    }
    setProgressHandler((p) => setProgress("rc", 88 + p * 6, "အသံတွေ ဆက်နေပါတယ်…"));
    await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "narration.mp3"]);
    for (let i = 0; i < ttsBlobs.length; i++) { try { await ff.deleteFile("seg" + i + ".mp3"); } catch (_) {} }
    await ff.deleteFile("list.txt");

    setProgressHandler((p) => setProgress("rc", 94 + p * 6, "video နဲ့ တွဲနေပါတယ်…"));
    await ff.writeFile("input.mp4", await fetchFile(rcFile));
    await ff.exec(["-i", "input.mp4", "-i", "narration.mp3",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
      "-shortest", "-movflags", "+faststart", "recap.mp4"]);
    const vdata = await ff.readFile("recap.mp4");
    const vblob = new Blob([vdata], { type: "video/mp4" });
    for (const n of ["input.mp4", "narration.mp3", "recap.mp4"]) {
      try { await ff.deleteFile(n); } catch (_) {}
    }

    const srt = segmentsToSRT(segments);
    const srtBlob = new Blob([srt], { type: "text/plain" });
    const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });

    const r1 = dlRow(baseName + "_recap.mp4", vblob); $("rcResults").appendChild(r1.row);
    const r2 = dlRow(baseName + "_recap.srt", srtBlob); $("rcResults").appendChild(r2.row);
    const r3 = dlRow(baseName + "_script.txt", txtBlob); $("rcResults").appendChild(r3.row);

    // per-segment Web Speech preview buttons (QC)
    const prevWrap = document.createElement("div");
    prevWrap.className = "hint";
    prevWrap.textContent = "အသံအစမ်းနားထောင်ရန် (Web Speech): ";
    segments.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "ghost";
      b.style.cssText = "padding:6px 10px;min-height:0;font-size:13px;margin:4px 4px 0 0;";
      b.textContent = "🔊 " + (i + 1);
      b.onclick = () => previewWithWebSpeech(s.text);
      prevWrap.appendChild(b);
    });
    $("rcResults").appendChild(prevWrap);

    setProgress("rc", 100, "ပြီးပါပြီ ✅");
    log("rc", "🎉 Recap video ပြီးပါပြီ!", "ok");
    setStep("mux", "done");
  } catch (e) {
    log("rc", "အမှား: " + (e.message || e), "err");
    setProgress("rc", 0, "");
    document.querySelectorAll("#rcSteps li.run").forEach((li) => { li.className = "fail"; });
  } finally {
    setProgressHandler(null);
    setBusy(["startRecap"], false);
  }
});
