// app.js — Nova Studio UI wiring (3 tabs). All compute runs in this browser.
import { ensureFFmpeg, fetchFile, setProgressHandler, ffmpegMode } from "./js/ffmpeg.js?v=20261021a";
import { edgeTTS, previewWithWebSpeech } from "./js/tts.js?v=20261021a";
import { canvasExport, canvasRecapSync, canvasDubSync, getOutDims, BITRATE, patchMp4Duration } from "./js/canvas-export.js?v=20261021a";

// Wake up TTS server (cold start mitigation)
try { fetch("https://nova-tts.onrender.com/").catch(() => {}); } catch (_) {}

// Preview layout: update on video load and ratio/res change
document.addEventListener("DOMContentLoaded", () => {
  const pv = $("rcBlurPrev");
  if (pv) pv.addEventListener("loadedmetadata", (e) => {
    rcSrc = { vw: e.target.videoWidth || 576, vh: e.target.videoHeight || 1024 };
    rcApplyLayout();
  });
  $("rcRatio")?.addEventListener("change", () => {
    rcApplyLayout();
    alert("Ratio ပြောင်းသွားပါပြီ — Blur box တွေ ပြန်ထားပေးပါ");
  });
  $("rcRes")?.addEventListener("change", rcApplyLayout);
  $("rcFit")?.addEventListener("change", rcApplyLayout);
  // Video pause warning (Chrome background tab)
  window.__novaOnVideoPause = () => {
    // No alert() here: this fires DURING canvas recording, and a blocking
    // alert freezes frame capture while the recorder keeps running (A/V skew).
    log("rc", "⚠️ Video ရပ် သွား တယ်! Chrome tab ပြန် ဝင် ပါ — မ ထွက် ပါ နဲ့", "err");
  };
  $("rcSeriesOn")?.addEventListener("change", (e) => {
    $("rcSeriesBox").style.display = e.target.checked ? "block" : "none";
    if (e.target.checked) refreshSeriesDropdown();
  });
  // Refresh series dropdown on load (in case memories exist)
  try { refreshSeriesDropdown(); } catch (_) {}
  $("rcSeriesTitleSel")?.addEventListener("change", (e) => {
    if (e.target.value) $("rcSeriesTitle").value = e.target.value;
  });
  $("rcMemView")?.addEventListener("click", () => {
    const t = ($("rcSeriesTitle").value || "").trim();
    if (!t) { alert("ခေါင်းစဉ် အရင် ရွေး/ရိုက် ပါ"); return; }
    $("rcMemText").value = getMemory(t) || "";
    $("rcMemBox").style.display = $("rcMemBox").style.display === "none" ? "block" : "none";
  });
  $("rcMemSave")?.addEventListener("click", () => {
    const t = ($("rcSeriesTitle").value || "").trim();
    if (!t) return;
    saveMemory(t, $("rcMemText").value);
    refreshSeriesDropdown();
    alert("Memory သိမ်းပြီးပါပြီ ✅");
  });
  $("rcMemDel")?.addEventListener("click", () => {
    const t = ($("rcSeriesTitle").value || "").trim();
    if (!t || !confirm(`"${t}" memory ဖျက် မလား?`)) return;
    delMemory(t);
    $("rcMemText").value = "";
    refreshSeriesDropdown();
  });
  $("rcMemExport")?.addEventListener("click", () => {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("nova_series_mem_")) data[k] = localStorage.getItem(k);
    }
    const count = Object.keys(data).length;
    if (!count) { alert("Export လုပ်စရာ Series Memory မရှိပါ"); return; }
    const payload = { app: "nova-studio", kind: "series-memory", version: 1, exportedAt: new Date().toISOString(), memories: data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nova-series-memory.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    log("rc", `📤 Series Memory ${count} ခု export လုပ်ပြီးပါပြီ`, "ok");
  });
  $("rcMemImport")?.addEventListener("click", () => $("rcMemImportFile")?.click());
  $("rcMemImportFile")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const mem = (j && typeof j === "object" && j.memories && typeof j.memories === "object") ? j.memories : j;
      const keys = Object.keys(mem || {}).filter((k) => k.startsWith("nova_series_mem_") && typeof mem[k] === "string");
      if (!keys.length) { alert("Import ဖိုင်ထဲမှာ Series Memory မတွေ့ပါ"); return; }
      if (!confirm(`Series Memory ${keys.length} ခု import လုပ်မယ် — တူညီတဲ့ ခေါင်းစဉ်ဆို အစားထိုးပါမယ်။ ဆက်လုပ်မလား?`)) return;
      for (const k of keys) localStorage.setItem(k, mem[k]);
      refreshSeriesDropdown();
      alert(`Series Memory ${keys.length} ခု import ပြီးပါပြီ ✅`);
    } catch (err) { alert("Import မရပါ: " + (err.message || err)); }
  });
  rcApplyLayout();
});
import {
  getKeys, saveKeys, clearKeys,
  groqTranscribe, aaiTranscribe, geminiTranscribe, geminiRecapScript, geminiRecapScriptVision,
  geminiUploadVideo, geminiRecapFromVideoFile,
  idbSet, idbGet, idbDel, idbKeys,
  extractSceneFrames,
  segmentsToSRT, buildOutputTimeline, mediaDuration, fmtClock, pad2,
  geminiText, extractStoryMemory, validateRecapSegments,
} from "./js/api.js?v=20261021a";

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const now = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

/** Copy log text to clipboard */
function copyLog(lid) {
  const box = document.getElementById(lid);
  if (!box) return;
  const text = box.innerText || "";
  if (!text.trim()) { alert("Log ဗလာ ပါ"); return; }
  const done = () => alert("📋 Copy ပြီးပြီ (" + text.split("\n").length + " ကြောင်း)");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); }
  catch (_) { alert("Copy မရပါ — စာကို ဖိပြီး ရွေးပါ"); }
  document.body.removeChild(ta);
}
window.copyLog = copyLog;

/**
 * Generate SRT from segments with audio blobs.
 * Measures actual audio durations and builds cumulative output timeline.
 * Throws with clear error if timestamps are invalid.
 */
async function srtFromSegsWithAudio(segsWithAudio, logTab) {
  const withDur = [];
  for (let i = 0; i < segsWithAudio.length; i++) {
    const s = segsWithAudio[i];
    let dur = 0;
    if (s.audioBlob) {
      try { dur = await mediaDuration(s.audioBlob); } catch (_) { dur = 0; }
    }
    // Fallback to existing audioDur/audioDuration if measurement fails
    if (!(dur > 0)) {
      dur = (typeof s.audioDur === "number" && s.audioDur > 0) ? s.audioDur
          : (typeof s.audioDuration === "number" && s.audioDuration > 0 ? s.audioDuration : 0);
    }
    withDur.push({ ...s, audioDur: dur });
  }
  const timed = buildOutputTimeline(withDur);
  return segmentsToSRT(timed);
}

/** Stage timing: track durations for diagnostics */
const _stageTimes = {};
function stageStart(name) {
  _stageTimes[name] = Date.now();
  try { console.log(`[stage] ${name} started`); } catch (_) {}
}
function stageEnd(name) {
  const t0 = _stageTimes[name];
  if (t0) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    try { console.log(`[stage] ${name} completed in ${secs}s`); } catch (_) {}
    return secs;
  }
  return null;
}

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

const tabBlobUrls = { cut: [], edit: [], recap: [] };
function revokeUrls(tab) {
  const arr = tabBlobUrls[tab] || [];
  while (arr.length) {
    try { URL.revokeObjectURL(arr.pop()); } catch (_) {}
  }
}
function trackUrl(tab, url) {
  (tabBlobUrls[tab] = tabBlobUrls[tab] || []).push(url);
}
function dlRow(name, blob, mime, tab) {
  const url = URL.createObjectURL(blob);
  trackUrl(tab || "recap", url);
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
  $("aaiKey").value = k.aai || "";
  $("geminiKey").value = k.gemini;
  updateKeyStatus();
})();
function updateKeyStatus() {
  const k = getKeys();
  const parts = [];
  if (k.groq) parts.push("Groq ✅"); else parts.push("Groq ❌");
  if (k.aai) parts.push("AAI ✅"); else parts.push("AAI ❌");
  if (k.gemini) parts.push("Gemini ✅"); else parts.push("Gemini ❌");
  $("keyStatus").textContent = parts.join(" · ") +
    (k.groq && k.gemini ? " — အဆင်သင့်ပါပြီ" : " — လိုအပ်တဲ့ key ထည့်ပါ");
}
$("saveKeys").addEventListener("click", () => {
  saveKeys($("groqKey").value, $("geminiKey").value, $("aaiKey").value);
  updateKeyStatus();
  alert("Keys တွေ သိမ်းပြီးပါပြီ ✅");
});
$("clearKeys").addEventListener("click", () => {
  if (!confirm("Keys တွေ ဖျက်မှာလား?")) return;
  clearKeys();
  $("groqKey").value = "";
  $("aaiKey").value = "";
  $("geminiKey").value = "";
  updateKeyStatus();
});

const TTS_SERVER = "https://nova-tts.onrender.com";

/** Server-side Edge TTS (VPN-proof, native Burmese voices). Resolves to audio/mpeg Blob. */
async function serverEdgeTTS(text, voice) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 60s: healthy TTS measures 8-12s; fail sooner to browser fallback
  try {
    const res = await fetch(TTS_SERVER + "/api/tts", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) throw new Error("TTS server error " + res.status);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error("TTS server: \u1021\u101E\u1036\u1016\u102D\u102F\u1004\u1039 \u1017\u101C\u102C");
    return new Blob([buf], { type: "audio/mpeg" });
  } finally { clearTimeout(timer); }
}

// Voice fallback: if saved/selected voice is no longer supported (e.g. removed Gemini),
// fall back to Thiha (default). Preserves valid Nilar selection.
(function initVoiceDefault() {
  try {
    const sel = document.getElementById("rcVoice");
    if (!sel) return;
    const v = sel.value || "";
    if (v.startsWith("gemini:") || (v !== "my-MM-NilarNeural" && v !== "my-MM-ThihaNeural")) {
      sel.value = "my-MM-ThihaNeural";
    }
  } catch (_) {}
})();

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
  revokeUrls("cut");
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
      const fname = cutFile.name.replace(/\.[^.]+$/, "") + "_p" + String(i + 1).padStart(Math.max(2, String(total).length), "0") + ".mp4";
      const { row, anchor } = dlRow(fname, blob, "video/mp4", "cut");
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
let edFile = null, edSrt = null, edFileName = "";
let edWH = null;              // {iw, ih} — preview video natural size
let previewURL = null;
const blurRegions = [];       // {x,y,w,h fractions 0-1, t0,t1 seconds, strength 1-30}

/** Load a file/Blob into the editor (file picker or recap handoff). */
function setEditorInput(file, name) {
  edFile = file || null;
  edFileName = name || (file && file.name) || "";
  $("edResults").innerHTML = "";
  clearBlurRegions();
  if (!edFile) {
    $("edFileInfo").textContent = "";
    setPreview(null);
    return;
  }
  $("edFileInfo").textContent = edFileName + " (" + fmtSize(edFile.size) + ")";
  setPreview(edFile);
}
$("edFile").addEventListener("change", (e) => {
  const f = e.target.files[0] || null;
  setEditorInput(f, f ? f.name : "");
});
$("srtFile").addEventListener("change", (e) => {
  edSrt = e.target.files[0] || null;
});

// ---------- blur boxes ----------
function setPreview(blob) {
  const v = $("blurPrev");
  if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
  edWH = null;
  updateWrapRatio();
  if (!blob) { v.removeAttribute("src"); v.load(); return; }
  previewURL = URL.createObjectURL(blob);
  v.src = previewURL;
}
$("blurPrev").addEventListener("loadedmetadata", () => {
  const v = $("blurPrev");
  if (v.videoWidth) edWH = { iw: v.videoWidth, ih: v.videoHeight };
  updateWrapRatio();
});

/** Output W,H in pixels — mirrors the editor's crop/scale filters. */
function outDims() {
  if (!edWH) return null;
  let W = edWH.iw, H = edWH.ih;
  const crop = $("cropSel").value;
  if (crop === "16:9") { W = Math.min(W, H * 16 / 9); H = W * 9 / 16; }
  else if (crop === "9:16") { W = Math.min(W, H * 9 / 16); H = W * 16 / 9; }
  else if (crop === "1:1") { W = Math.min(W, H); H = W; }
  if ($("compressChk").checked) { W = Math.round((W / H) * 480 / 2) * 2; H = 480; }
  W = Math.max(2, Math.round(W / 2) * 2);
  H = Math.max(2, Math.round(H / 2) * 2);
  return { W, H };
}
function updateWrapRatio() {
  const d = outDims();
  $("blurWrap").style.aspectRatio = d ? (d.W + " / " + d.H) : "16 / 9";
}
$("cropSel").addEventListener("change", updateWrapRatio);
$("compressChk").addEventListener("change", updateWrapRatio);

const clamp01 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function positionRegionEl(el, r) {
  el.style.left = (r.x * 100) + "%";
  el.style.top = (r.y * 100) + "%";
  el.style.width = (r.w * 100) + "%";
  el.style.height = (r.h * 100) + "%";
}

function makeDraggable(el, r, handle) {
  let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0, oh = 0;
  el.addEventListener("pointerdown", (e) => {
    mode = (e.target === handle) ? "resize" : "move";
    sx = e.clientX; sy = e.clientY;
    ox = r.x; oy = r.y; ow = r.w; oh = r.h;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!mode) return;
    const wrap = $("blurWrap");
    const dx = (e.clientX - sx) / wrap.clientWidth;
    const dy = (e.clientY - sy) / wrap.clientHeight;
    if (mode === "move") {
      r.x = clamp01(ox + dx, 0, 1 - r.w);
      r.y = clamp01(oy + dy, 0, 1 - r.h);
    } else {
      r.w = clamp01(ow + dx, 0.03, 1 - ox);
      r.h = clamp01(oh + dy, 0.03, 1 - oy);
    }
    positionRegionEl(el, r);
  });
  const stop = () => { mode = null; };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

function renumberBlurCards() {
  const cards = $("blurList").children;
  for (let i = 0; i < cards.length; i++) {
    const t = cards[i].querySelector(".btitle");
    if (t) t.textContent = "Box " + (i + 1);
  }
}

function clearBlurRegions() {
  blurRegions.length = 0;
  document.querySelectorAll("#blurWrap .bregion").forEach((e) => e.remove());
  $("blurList").innerHTML = "";
}

function addBlurRegion(r) {
  blurRegions.push(r);
  const el = document.createElement("div");
  el.className = "bregion";
  const handle = document.createElement("div");
  handle.className = "bhandle";
  el.appendChild(handle);
  $("blurWrap").appendChild(el);
  positionRegionEl(el, r);
  makeDraggable(el, r, handle);

  const card = document.createElement("div");
  card.className = "part";
  const title = document.createElement("span");
  title.className = "btitle";
  title.textContent = "Box " + blurRegions.length;
  const ctl = document.createElement("div");
  ctl.className = "bctl";
  ctl.innerHTML =
    '<label>စ(s)<input type="number" class="bt0" value="' + r.t0 + '" min="0" step="0.5"></label>' +
    '<label>ဆုံး(s)<input type="number" class="bt1" value="' + r.t1 + '" min="0" step="0.5"></label>' +
    '<label>Blur<input type="number" class="bstr" value="' + r.strength + '" min="1" max="30" step="1"></label>';
  ctl.querySelector(".bt0").addEventListener("input", (e) => {
    r.t0 = Math.max(0, parseFloat(e.target.value) || 0);
  });
  ctl.querySelector(".bt1").addEventListener("input", (e) => {
    r.t1 = Math.max(0, parseFloat(e.target.value) || 0);
  });
  ctl.querySelector(".bstr").addEventListener("input", (e) => {
    r.strength = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 12));
  });
  const del = document.createElement("button");
  del.className = "ghost";
  del.style.cssText = "padding:8px 12px;min-height:0;font-size:14px;margin-top:0;";
  del.textContent = "❌";
  del.onclick = () => {
    blurRegions.splice(blurRegions.indexOf(r), 1);
    el.remove();
    card.remove();
    renumberBlurCards();
  };
  card.appendChild(title);
  card.appendChild(ctl);
  card.appendChild(del);
  $("blurList").appendChild(card);
}

$("addBlur").addEventListener("click", () => {
  if (!edFile) { alert("Video file အရင်ရွေးပါ"); return; }
  if (!edWH) { alert("Preview load ဖြစ်အောင် ခဏစောင့်ပါ"); return; }
  const dur = $("blurPrev").duration;
  const t1 = (dur && isFinite(dur)) ? Math.round(dur * 10) / 10 : 10;
  addBlurRegion({ x: 0.35, y: 0.30, w: 0.30, h: 0.25, t0: 0, t1: t1, strength: 12 });
});

function escDrawtext(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Pass 1: simple -vf base filters (crop/flip/watermark/compress/subtitles) -> out.
 *  Blur boxes are NOT in this pass — they run separately in pass 2 so each
 *  FFmpeg run holds less in WASM memory (the combined single-pass graph
 *  caused FS/memory errors on phones). */
function buildPass1Args(baseFilters, out) {
  if (!baseFilters.length)
    return ["-i", "input.mp4", "-c", "copy", "-movflags", "+faststart", out];
  return ["-i", "input.mp4", "-vf", baseFilters.join(","),
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
}

/** Pass 2: blur-box chain ONLY, applied to the pass-1 result -> output.mp4.
 *  dims must be the post-pass-1 frame size (outDims() already accounts for
 *  crop/compress, the only geometry-changing base filters). */
function buildPass2Args(regions, dims) {
  // Safety margin: real crop output can differ by ~2px from our mirror math.
  const W = dims.W - 2, H = dims.H - 2;
  let fc = "[0:v]copy[v0]", last = "[v0]", used = 0;
  regions.forEach((r, i) => {
    let cx = Math.max(0, Math.round(W * r.x / 2) * 2);
    let cy = Math.max(0, Math.round(H * r.y / 2) * 2);
    let cw = Math.max(2, Math.round(W * r.w / 2) * 2);
    let ch = Math.max(2, Math.round(H * r.h / 2) * 2);
    if (cx + cw > W) cw = W - cx;
    if (cy + ch > H) ch = H - cy;
    if (cw < 2 || ch < 2) return; // degenerate — skip
    const st = Math.max(1, Math.min(30, Math.round(r.strength)));
    const t0 = Math.max(0, +r.t0), t1 = Math.max(t0, +r.t1);
    fc += ";" + last + "crop=" + cw + ":" + ch + ":" + cx + ":" + cy +
          ",boxblur=" + st + "[bx" + i + "]";
    fc += ";" + last + "[bx" + i + "]overlay=" + cx + ":" + cy +
          ":enable='between(t," + t0 + "," + t1 + ")'[v" + (i + 1) + "]";
    last = "[v" + (i + 1) + "]";
    used++;
  });
  return ["-i", "temp.mp4", "-filter_complex", fc,
    "-map", last, "-map", "0:a?",
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "output.mp4"];
}

$("startEdit").addEventListener("click", async () => {
  if (!edFile) { alert("Video file အရင်ရွေးပါ"); return; }
  const dims = outDims();
  if (blurRegions.length && !dims) { alert("Preview load ဖြစ်အောင် ခဏစောင့်ပါ"); return; }
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
  const FONTFILE = "/fonts/NotoSansMyanmar.ttf";
  if (wantWm) vf.push("drawtext=fontfile=" + FONTFILE + ":text='" + escDrawtext(wm) + "':fontsize=22:fontcolor=white@0.75:x=12:y=h-36");
  if ($("compressChk").checked) vf.push("scale=-2:480");
  if (wantSub) vf.push("subtitles=subs.srt:fontsdir=/fonts:force_style=FontName='Noto Sans Myanmar'");

  const baseName = edFileName.replace(/\.[^.]+$/, "");
  try {
    log("ed", "FFmpeg ပြင်ဆင်နေပါတယ်…");
    const ff = await ensureFFmpeg((m, c) => log("ed", m, c));
    setProgressHandler((p) => setProgress("ed", p * 100, "လုပ်နေပါတယ်… " + Math.round(p * 100) + "%"));
    const files = { "input.mp4": await fetchFile(edFile) };
    if (wantSub) files["subs.srt"] = await fetchFile(edSrt);
    // Myanmar font for drawtext/subtitles burn-in
    try { await ff.createDir("/fonts"); } catch (_) {}
    try {
      const fr = await fetch("./fonts/NotoSansMyanmar.ttf");
      if (fr.ok) await ff.writeFile(FONTFILE, new Uint8Array(await fr.arrayBuffer()));
    } catch (_) {}
    for (const [n, d] of Object.entries(files)) await ff.writeFile(n, d);

    let args, dropped = [];
    const needBlur = blurRegions.length > 0;
    const pass1Out = needBlur ? "temp.mp4" : "output.mp4";

    // ---- Pass 1: base filters (crop/flip/watermark/compress/subtitles) ----
    // On failure, drop subtitle/watermark (font ပြဿနာ) and retry — blur is untouched here.
    let cur = vf.slice();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      args = buildPass1Args(cur, pass1Out);
      log("ed", "အဆင့် ၁/" + (needBlur ? "၂" : "၁") + " — Run #" + (attempt + 1) +
        (cur.length ? " filters: " + cur.join(" | ") : " (copy mode)"));
      try {
        await ff.exec(args);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const subIdx = cur.findIndex((f) => f.startsWith("subtitles="));
        const wmIdx = cur.findIndex((f) => f.startsWith("drawtext="));
        if (subIdx >= 0) {
          cur.splice(subIdx, 1); dropped.push("စာတန်းထိုး");
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

    // ---- Pass 2: blur boxes only, on the pass-1 result ----
    if (needBlur) {
      log("ed", "အဆင့် ၂/၂ — blur box " + blurRegions.length + " ခု ထည့်နေပါတယ်…");
      try {
        await ff.exec(buildPass2Args(blurRegions, dims));
      } catch (e) {
        // Blur still failed — deliver the pass-1 result without blur.
        const n = blurRegions.length;
        blurRegions.length = 0;
        dropped.push("blur box (" + n + ")");
        log("ed", "⚠️ blur filter မနိုင်လို့ ဖြုတ်ပြီး ဆက်လုပ်ပါမယ် (" + n + " box)", "err");
        const tdata = await ff.readFile("temp.mp4");
        await ff.writeFile("output.mp4", tdata);
      }
    }

    const data = await ff.readFile("output.mp4");
    const blob = new Blob([data], { type: "video/mp4" });
    for (const n of ["input.mp4", "subs.srt", "temp.mp4", "output.mp4"]) { try { await ff.deleteFile(n); } catch (_) {} }
    const { row } = dlRow(baseName + "_edited.mp4", blob, null, "edit");
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

$("canvasExportBtn").addEventListener("click", async () => {
  if (!edFile) { alert("Video file အရင်ရွေးပါ"); return; }
  setBusy(["startEdit", "canvasExportBtn", "extractAudio"], true);
  $("edResults").innerHTML = "";
  try {
    log("ed", "📹 Canvas နဲ့ export လုပ်နေပါတယ်… (real-time)");
    const flip = $("flipChk").checked;
    const wm = $("wmText").value.trim();
    // Subtitles if SRT loaded
    let subs = [];
    if (edSrt) {
      const txt = await edSrt.text();
      subs = parseSRT(txt);
    }
    setProgressHandler((p) => setProgress("ed", p * 100, "Recording… " + Math.round(p * 100) + "%"));
    const { blob, ext, recSec } = await canvasExport(edFile, {
      flip, watermarkText: wm, subtitles: subs,
      ...getRcDims(),
      onprog: (p) => setProgress("ed", p * 100, "Recording… " + Math.round(p * 100) + "%"),
    });
    const baseName = edFileName.replace(/\.[^.]+$/, "");
    const { row } = dlRow(baseName + "_canvas." + ext, blob, null, "edit");
    $("edResults").appendChild(row);
    setProgress("ed", 100, "ပြီးပါပြီ ✅");
    log("ed", "Canvas export ရပါပြီ ✅ (" + ext.toUpperCase() + ")", "ok");
  } catch (e) {
    log("ed", "အမှား: " + (e.message || e), "err");
    setProgress("ed", 0, "");
  } finally {
    setProgressHandler(null);
    setBusy(["startEdit", "canvasExportBtn", "extractAudio"], false);
  }
});

function parseSRT(txt) {
  const out = [];
  const blocks = String(txt).split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.trim().split("\n");
    if (lines.length < 2) continue;
    const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const t = (h, m2, s, ms) => (+h) * 3600 + (+m2) * 60 + (+s) + (+ms) / 1000;
    out.push({
      start: t(m[1], m[2], m[3], m[4]),
      end: t(m[5], m[6], m[7], m[8]),
      text: lines.slice(2).join(" "),
    });
  }
  return out;
}

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
    const { row } = dlRow(edFileName.replace(/\.[^.]+$/, "") + ".mp3", blob, null, "edit");
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

// ---- step 5 extracted: timestamp sync mux (retryable without re-doing TTS) ----
async function doRecapMux(ff, segments, segPieces, baseName) {
  // Memory-safe sync: NO adelay+amix (amix buffers all 17 full-timeline inputs
  // in WASM memory -> OOM on phones). Instead: per-segment atempo/atrim only,
  // then build the timeline with silence gaps + concat (sequential, low memory).
  let muxPhase = "init";
  try {
    setStep("mux", "run");
    setProgress("rc", 86, "အသံကို ရုပ်နဲ့ sync လုပ်နေပါတယ်…");
    muxPhase = "segments";
    log("rc", "5️⃣ အသံကို timestamp နေရာအတိအကျ ချနေပါတယ်…");
    const ssegs = segments.map((s, i) => ({ start: s.start, end: s.end, _i: i }))
      .sort((a, b) => a.start - b.start);
    const ACtx = new (window.AudioContext || window.webkitAudioContext)();
    async function mp3Duration(u8, byteLen, segNo) {
      const copy = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      try {
        const dec = await Promise.race([
          ACtx.decodeAudioData(copy),
          new Promise((_, rej) => setTimeout(() => rej(new Error("decode-timeout")), 15000))
        ]);
        return dec.duration;
      } catch (e) {
        // Fallback: estimate from file size (Edge TTS ~48kbps mono MP3).
        // decodeAudioData can hang on mobile browsers; don't stall the pipeline.
        const est = Math.max(0.5, (byteLen * 8) / 48000);
        log("rc", `⚠️ အပိုင်း ${segNo}: duration တိုင်းမရလို့ ခန့်မှန်းသုံးပါတယ်`, "err");
        return est;
      }
    }
    const encB = new TextEncoder();
    // ---- measure durations, then SERVER-SIDE mix (browser FFmpeg can't handle it reliably) ----
    muxPhase = "servermix";
    setProgress("rc", 91, "အသံတွေ ပေါင်းနေပါတယ်… (server)");
    log("rc", "🔗 အသံတွေ server ပေါ်မှာ ပေါင်းနေပါတယ်…");
    const mixSegs = new Array(ssegs.length);
    let mixDone = 0;
    // Bounded concurrency: 2 at a time. Order preserved via index.
    // Each segment's start/end/rate mapping is unchanged.
    async function prepareMixSeg(k) {
      const seg = ssegs[k];
      const pieces = segPieces[seg._i];
      // Combine pieces into one blob for duration measurement
      const blob = pieces.length === 1 ? pieces[0] : new Blob(pieces, { type: "audio/mpeg" });
      const buf = await blob.arrayBuffer();
      const u8 = new Uint8Array(buf);
      const dur = await mp3Duration(u8, u8.byteLength, k + 1);
      const win = Math.max(0.5, seg.end - seg.start);
      let rate = 1;
      if (dur > win + 0.05) {
        rate = Math.min(dur / win, 1.3);
        if (dur / rate > win + 0.05) {
          log("rc", `⚠️ အပိုင်း ${k + 1}: အသံရှည်လွန်းလို့ ${win.toFixed(1)}s မှာ ဖြတ်လိုက်ပါတယ်`, "err");
        } else if (rate > 1.001) {
          log("rc", `အပိုင်း ${k + 1}: ${rate.toFixed(2)}x မြန်လိုက်ပါတယ်`, "ok");
        }
      }
      // base64 for server
      const b64 = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.readAsDataURL(blob);
      });
      mixSegs[k] = { b64, start: seg.start, end: seg.end, rate };
      mixDone++;
      setProgress("rc", 91 + (mixDone / ssegs.length) * 2, `ပြင်ဆင်နေပါတယ်… (${mixDone}/${ssegs.length})`);
    }
    {
      let nextK = 0;
      const workers = [0, 1].map(async () => {
        while (true) {
          const k = nextK++;
          if (k >= ssegs.length) break;
          await prepareMixSeg(k);
        }
      });
      await Promise.all(workers);
    }
    try { await ACtx.close(); } catch (_) {}
    // video duration for final pad
    // video duration for final pad
    const vdur = await new Promise((res) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => { const d = v.duration || 0; URL.revokeObjectURL(v.src); res(d); };
      v.onerror = () => res(0);
      v.src = URL.createObjectURL(rcFile);
    });
    // Send to server for mixing
    const mixResp = await fetch(TTS_SERVER + "/api/mix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: mixSegs, videoDur: vdur })
    });
    if (!mixResp.ok) {
      const t = await mixResp.text();
      throw new Error("server mix failed: " + t.slice(0, 200));
    }
    const narrBlob = await mixResp.blob();
    await ff.writeFile("narr.mp3", await fetchFile(narrBlob));

    // ---- mux with video ----
    muxPhase = "remux-write";
    setProgressHandler((p) => setProgress("rc", 94 + p * 6, "video နဲ့ တွဲနေပါတယ်…"));
    // Diagnostic: verify file readable before FFmpeg write
    try {
      const fsz = rcFile ? rcFile.size : 0;
      console.log(`[remux-write] file: ${rcFile ? (rcFile.name || "?") : "null"} size=${fsz} type=${rcFile ? (rcFile.type || "?") : "?"}`);
      if (!rcFile || !fsz) throw new Error("video file မရှိတော့ပါ — ပြန်ရွေးပေးပါ");
      // Warn if file is very large for mobile memory
      if (fsz > 500 * 1024 * 1024) {
        log("rc", `⚠️ Video ကြီးလွန်းပါတယ် (${(fsz/1048576).toFixed(0)}MB) — memory မလောက်နိုင်ပါ`, "err");
      }
    } catch (de) { console.warn("[remux-write] pre-check:", de.message); }
    try {
      await ff.writeFile("input.mp4", await fetchFile(rcFile));
    } catch (we) {
      // Provide clear error instead of cryptic Code=-1
      const msg = `video file FFmpeg ထဲ ရေးမရပါ: ${(we.message || we).toString().slice(0, 150)} (size=${rcFile ? rcFile.size : "?"})`;
      log("rc", "❌ " + msg, "err");
      throw new Error(msg);
    }
    muxPhase = "remux-exec";
    await ff.exec(["-i", "input.mp4", "-i", "narr.mp3",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "recap.mp4"]);
    muxPhase = "readout";
    for (const n of ["input.mp4", "narr.mp3"]) {
      try { await ff.deleteFile(n); } catch (_) {}
    }
    const vdata = await ff.readFile("recap.mp4");
    const vblob = new Blob([vdata], { type: "video/mp4" });
    try { await ff.deleteFile("recap.mp4"); } catch (_) {}

    let srt = null;
    try { srt = segmentsToSRT(segments); }
    catch (e) { console.warn("SRT failed:", e.message); srt = null; }
    const srtBlob = srt ? new Blob([srt], { type: "text/plain" }) : null;
    const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });

    const r1 = dlRow(baseName + "_recap.mp4", vblob); $("rcResults").appendChild(r1.row);
    if (srtBlob) { const r2 = dlRow(baseName + "_recap.srt", srtBlob); $("rcResults").appendChild(r2.row); }
    const r3 = dlRow(baseName + "_script.txt", txtBlob); $("rcResults").appendChild(r3.row);

    // Auto-apply selected edits via canvas (unified flow — no separate editor tab)
    const wantFlip = $("rcFlip") && $("rcFlip").checked;
    const wantWm = ($("rcWatermark") && $("rcWatermark").value.trim()) || "";
    if (wantFlip || wantWm) {
      try {
        setProgress("rc", 97, "Edit တွေ လုပ်နေပါတယ် (canvas)…");
        log("rc", "🎨 flip/watermark canvas နဲ့ လုပ်နေပါတယ်…");
        // Parse SRT for subtitle burn-in
        const subs = [];
        const srtLines = srt.split("\n");
        // (subtitles already in srt string; parse quickly)
        const { blob: editedBlob, ext, recSec } = await canvasExport(vblob, {
          flip: wantFlip,
          watermarkText: wantWm,
          subtitles: segments,
          ...getStyleOpts(),
          ...getRcDims(),
          onprog: (p) => setProgress("rc", 97 + p * 2, "Edit… " + Math.round(p * 100) + "%"),
        });
        const r4 = dlRow(baseName + "_recap_edited." + ext, editedBlob);
        $("rcResults").appendChild(r4.row);
        log("rc", "Edit ပြီးပါပြီ ✅", "ok");
      } catch (e) {
        log("rc", "Edit မအောင်မြင်ပါ: " + (e.message || e) + " — မူရင်း video ကို သုံးပါ", "err");
      }
    }

    rcHandoff = { blob: vblob, name: baseName + "_recap.mp4" };

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
  } catch (e) {
    log("rc", "❌ sync phase [" + muxPhase + "] မှာ error: " + (e.message || e), "err");
    throw e;
  }
}

// ============================================================
// TAB 3 — RECAP NOVA
// ============================================================
let rcFile = null;
let rcLastRun = null; // {segments, segPieces, baseName} — retry sync without re-TTS
let rcHandoff = null; // {blob, name} — recap output for the editor handoff
// ---- Recap Nova blur boxes (unified flow) ----
const rcBlurRegions = [];
let rcBlurUrl = null;
function rcShowBlurPreview() {
  const sec = $("rcBlurSection");
  if (!rcFile) { sec.style.display = "none"; return; }
  sec.style.display = "";
  const v = $("rcBlurPrev");
  if (rcBlurUrl) URL.revokeObjectURL(rcBlurUrl);
  rcBlurUrl = URL.createObjectURL(rcFile);
  v.src = rcBlurUrl;
}
function rcAddBlurBox() {
  const r = { x: 0.1, y: 0.05, w: 0.8, h: 0.15, t0: 0, t1: 9999, strength: 15 };
  rcBlurRegions.push(r);
  const wrap = $("rcBlurWrap");
  const el = document.createElement("div");
  el.className = "rcbox";
  el.style.cssText = "position:absolute;border:2px solid #4da6ff;background:rgba(77,166,255,0.2);cursor:move;touch-action:none;";
  // Resize handle (bottom-right)
  const rh = document.createElement("div");
  rh.style.cssText = "position:absolute;right:-8px;bottom:-8px;width:20px;height:20px;background:#4da6ff;border-radius:50%;cursor:nwse-resize;touch-action:none;";
  el.appendChild(rh);
  const update = () => {
    el.style.left = (r.x * 100) + "%";
    el.style.top = (r.y * 100) + "%";
    el.style.width = (r.w * 100) + "%";
    el.style.height = (r.h * 100) + "%";
  };
  update();
  // Simple drag
  let sx, sy, ox, oy;
  el.addEventListener("pointerdown", (e) => {
    sx = e.clientX; sy = e.clientY; ox = r.x; oy = r.y;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (sx === undefined) return;
    const rect = wrap.getBoundingClientRect();
    r.x = Math.max(0, Math.min(1 - r.w, ox + (e.clientX - sx) / rect.width));
    r.y = Math.max(0, Math.min(1 - r.h, oy + (e.clientY - sy) / rect.height));
    update();
  });
  el.addEventListener("pointerup", () => { sx = undefined; });
  // Resize via handle
  let rsx, rsy, rw, rh0;
  rh.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    rsx = e.clientX; rsy = e.clientY; rw = r.w; rh0 = r.h;
    rh.setPointerCapture(e.pointerId);
  });
  rh.addEventListener("pointermove", (e) => {
    if (rsx === undefined) return;
    const rect = wrap.getBoundingClientRect();
    r.w = Math.max(0.05, Math.min(1 - r.x, rw + (e.clientX - rsx) / rect.width));
    r.h = Math.max(0.05, Math.min(1 - r.y, rh0 + (e.clientY - rsy) / rect.height));
    update();
  });
  rh.addEventListener("pointerup", () => { rsx = undefined; });
  wrap.appendChild(el);
  r._el = el; r._update = update;
  rcRenderBlurList();
}
function rcRenderBlurList() {
  const list = $("rcBlurList");
  list.innerHTML = "";
  rcBlurRegions.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "part";
    d.innerHTML = `<span>Box ${i + 1}</span>
      <label>Blur<input type="number" value="${r.strength}" min="1" max="30" style="width:60px;"></label>
      <button class="ghost" style="padding:4px 10px;">❌</button>`;
    d.querySelector("input").addEventListener("input", (e) => {
      r.strength = Math.max(1, Math.min(30, parseInt(e.target.value) || 15));
    });
    d.querySelector("button").onclick = () => {
      rcBlurRegions.splice(i, 1);
      if (r._el) r._el.remove();
      rcRenderBlurList();
    };
    list.appendChild(d);
  });
}
// ---- SRT upload ----
let rcSrtSegments = null;
$("rcSrtFile")?.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) { rcSrtSegments = null; $("rcSrtInfo").textContent = ""; return; }
  try {
    const txt = await f.text();
    rcSrtSegments = parseSRT(txt);
    $("rcSrtInfo").textContent = `${f.name} — ${rcSrtSegments.length} ကြောင်း`;
    log("rc", `SRT ရပါပြီ (${rcSrtSegments.length} ကြောင်း) ✅`, "ok");
  } catch (err) {
    $("rcSrtInfo").textContent = "SRT ဖတ်မရပါ";
    rcSrtSegments = null;
  }
});

// ---- Logo upload + drag ----
let rcLogoImg = null;
let rcLogoPos = { x: 0.05, y: 0.05, size: 0.15 }; // fractions
$("rcLogoFile")?.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  rcLogoBlob = f; // preserve original blob for preset saving
  rcLogoImageId = null; // new upload, not yet saved
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    rcLogoImg = img;
    $("rcLogoPrev").src = url;
    $("rcLogoWrap").style.display = "";
    // Make draggable on the main preview
    rcInitLogoDrag();
  };
  img.src = url;
});
function rcInitLogoDrag() {
  // Logo drag on blur preview video
  const wrap = $("rcBlurWrap");
  let lel = document.getElementById("rcLogoDrag");
  if (lel) lel.remove();
  if (!rcLogoImg) return;
  lel = document.createElement("div");
  lel.id = "rcLogoDrag";
  lel.style.cssText = "position:absolute;cursor:move;touch-action:none;border:1px dashed #fff;";
  const update = () => {
    lel.style.left = (rcLogoPos.x * 100) + "%";
    lel.style.top = (rcLogoPos.y * 100) + "%";
    lel.style.width = (rcLogoPos.size * 100) + "%";
    lel.style.aspectRatio = "1";
    lel.style.backgroundImage = `url(${$("rcLogoPrev").src})`;
    lel.style.backgroundSize = "contain";
    lel.style.backgroundRepeat = "no-repeat";
    const shape = ($("rcLogoShape") || {}).value || "square";
    lel.style.borderRadius = shape === "circle" ? "50%" : "0";
    lel.style.overflow = "hidden";
  };
  update();
  let sx, sy, ox, oy;
  lel.addEventListener("pointerdown", (e) => {
    sx = e.clientX; sy = e.clientY; ox = rcLogoPos.x; oy = rcLogoPos.y;
    lel.setPointerCapture(e.pointerId);
  });
  lel.addEventListener("pointermove", (e) => {
    if (sx === undefined) return;
    const rect = wrap.getBoundingClientRect();
    rcLogoPos.x = Math.max(0, Math.min(1 - rcLogoPos.size, ox + (e.clientX - sx) / rect.width));
    rcLogoPos.y = Math.max(0, Math.min(1 - rcLogoPos.size, oy + (e.clientY - sy) / rect.height));
    update();
  });
  lel.addEventListener("pointerup", () => { sx = undefined; });
  // Resize handle for logo
  const lrh = document.createElement("div");
  lrh.style.cssText = "position:absolute;right:-8px;bottom:-8px;width:20px;height:20px;background:#fff;border-radius:50%;cursor:nwse-resize;touch-action:none;border:2px solid #4da6ff;";
  lel.appendChild(lrh);
  let lrsx, lrsy, lrsz;
  lrh.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    lrsx = e.clientX; lrsy = e.clientY; lrsz = rcLogoPos.size;
    lrh.setPointerCapture(e.pointerId);
  });
  lrh.addEventListener("pointermove", (e) => {
    if (lrsx === undefined) return;
    const rect = wrap.getBoundingClientRect();
    const dx = (e.clientX - lrsx) / rect.width;
    rcLogoPos.size = Math.max(0.05, Math.min(0.5, lrsz + dx));
    update();
  });
  lrh.addEventListener("pointerup", () => { lrsx = undefined; });
  wrap.appendChild(lel);
  // Update on shape change
  $("rcLogoShape")?.addEventListener("change", update);
}
$("rcLogoShape")?.addEventListener("change", () => {
  const lel = document.getElementById("rcLogoDrag");
  if (lel) {
    const shape = ($("rcLogoShape") || {}).value || "square";
    lel.style.borderRadius = shape === "circle" ? "50%" : "0";
  }
});

// ---- Subtitle live preview ----
function rcUpdateSubPreview() {
  const wrap = $("rcBlurWrap");
  let sel = document.getElementById("rcSubPreview");
  const text = ($("rcSubPreviewText") || {}).value || "";
  const show = ($("rcSubOn") || {}).checked;
  if (!text || !show) { if (sel) sel.remove(); return; }
  if (!sel) {
    sel = document.createElement("div");
    sel.id = "rcSubPreview";
    sel.style.cssText = "position:absolute;left:0;right:0;bottom:8%;text-align:center;pointer-events:none;padding:0 10px;";
    wrap.appendChild(sel);
  }
  const color = ($("rcSubColor") || {}).value || "#ffffff";
  const size = parseInt((($("rcSubSize") || {}).value || "28"), 10);
  const font = ($("rcSubFont") || {}).value || "Aka07";
  const shadeColor = ($("rcShadeColor") || {}).value || "#000000";
  const thick = parseInt((($("rcShadeThick") || {}).value || "4"), 10);
  // Scale to preview width (preview is ~340px, export is 720px)
  const k = (wrap.clientWidth || 340) / 720;
  sel.style.color = color;
  sel.style.fontSize = (size * k) + "px";
  sel.style.fontFamily = `"${font}", sans-serif`;
  sel.style.fontWeight = "bold";
  const tk = thick * k;
  sel.style.textShadow = `-${tk}px 0 0 ${shadeColor}, ${tk}px 0 0 ${shadeColor}, 0 -${tk}px 0 ${shadeColor}, 0 ${tk}px 0 ${shadeColor}`;
  sel.textContent = text;
}
["rcSubPreviewText", "rcSubOn", "rcSubColor", "rcSubSize", "rcSubFont", "rcShadeColor", "rcShadeThick"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", rcUpdateSubPreview);
  document.getElementById(id)?.addEventListener("change", rcUpdateSubPreview);
});

$("rcAddBlur")?.addEventListener("click", rcAddBlurBox);
$("rcClearBlur")?.addEventListener("click", () => {
  rcBlurRegions.length = 0;
  document.querySelectorAll("#rcBlurWrap .rcbox").forEach((e) => e.remove());
  rcRenderBlurList();
});


/** Get subtitle/logo options from UI. */
function getStyleOpts() {
  return {
    subOn: ($("rcSubOn") || {}).checked !== false,
    subColor: ($("rcSubColor") || {}).value || "#ffffff",
    subSize: parseInt((($("rcSubSize") || {}).value || "28"), 10),
    subFont: ($("rcSubFont") || {}).value || "Aka07",
    shadeColor: ($("rcShadeColor") || {}).value || "#000000",
    shadeThick: parseInt((($("rcShadeThick") || {}).value || "4"), 10),
    subPos: ($("rcSubPos") || {}).value || "bottom",
    logoImg: rcLogoImg,
    logoPos: rcLogoImg ? rcLogoPos : null,
    logoShape: ($("rcLogoShape") || {}).value || "square",
  };
}

/** Video source dimensions (updated on metadata load) */
let rcSrc = { vw: 576, vh: 1024 };
/** Get output dimensions from UI selections */
function getRcDims() {
  const ratio = ($("rcRatio") || {}).value || "9:16";
  const res = parseInt((($("rcRes") || {}).value || "720"), 10);
  const fit = ($("rcFit") || {}).value || "cover";
  const { W, H } = getOutDims(ratio, res, rcSrc.vw, rcSrc.vh);
  return { width: W, height: H, bitrate: BITRATE[res] || 4e6, fit };
}

/** Get recap duration target from percentage selector. */
function getDurationTarget() {
  const pctEl = $("rcDurationPct");
  let pct = 50;
  if (pctEl) {
    const v = parseInt(pctEl.value, 10);
    if ([10, 20, 30, 50, 80].includes(v)) pct = v;
  }
  const srcMin = (typeof rcFile !== "undefined" && rcFile && rcFile._dur ? rcFile._dur : 480) / 60;
  const targetMin = Math.max(1, Math.round(srcMin * pct / 100));
  return { pct, targetMin, srcMin };
}

function updateDurationHint() {
  try {
    const hint = $("rcDurationHint");
    if (!hint) return;
    const { pct, targetMin, srcMin } = getDurationTarget();
    hint.textContent = `≈ ${targetMin} မိနစ် (မူရင်း ${Math.round(srcMin)} မိနစ်၏ ${pct}%) — ခန့်မှန်းခြေသာ`;
  } catch (_) {}
}
/** Update preview wrapper to match output aspect */
function rcApplyLayout() {
  const { width, height } = getRcDims();
  const w = $("rcBlurWrap");
  if (w) {
    w.style.aspectRatio = width + " / " + height;
    w.style.maxWidth = width >= height ? "560px" : "340px";
  }
  // Preview must render the video exactly like export does (cover = crop,
  // contain = letterbox) so blur/logo/subtitle positions line up 1:1.
  const pv = $("rcBlurPrev");
  if (pv) pv.style.objectFit = ((($("rcFit") || {}).value || "cover") === "contain") ? "contain" : "cover";
}

/** Story Memory: localStorage per series title */
function memKey(title) { return "nova_series_mem_" + title; }
function getAllSeries() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("nova_series_mem_")) out.push(k.slice(16));
  }
  return out.sort();
}
function getMemory(title) {
  if (!title) return null;
  try { return localStorage.getItem(memKey(title)) || null; } catch (_) { return null; }
}
function saveMemory(title, text) {
  if (!title) return;
  try { localStorage.setItem(memKey(title), text); } catch (_) {}
}
function delMemory(title) {
  if (!title) return;
  try { localStorage.removeItem(memKey(title)); } catch (_) {}
}
/**
 * Parse memory text into part blocks.
 * Returns [{part: "1", num: 1, text: "..."}, ...] preserving legacy format.
 * Non-part text (before first header) is kept as {part: null}.
 */
function parseMemoryParts(text) {
  const parts = [];
  if (!text) return parts;
  const re = /\[Part\s+([^\]]+)\]/gi;
  let m, lastIdx = 0, lastPart = null;
  while ((m = re.exec(text)) !== null) {
    // Text before this header belongs to previous part (or preamble)
    if (lastPart !== null || lastIdx < m.index) {
      const t = text.slice(lastIdx, m.index).trim();
      if (t || lastPart !== null) {
        parts.push({ part: lastPart, num: partNum(lastPart), text: t });
      }
    }
    lastPart = m[1].trim();
    lastIdx = m.index + m[0].length;
  }
  // Trailing text
  const tail = text.slice(lastIdx).trim();
  if (tail || lastPart !== null) {
    parts.push({ part: lastPart, num: partNum(lastPart), text: tail });
  }
  return parts;
}
/** Normalize part identifier to number for sorting (End = Infinity) */
function partNum(p) {
  if (p === null || p === undefined) return -1;
  const s = String(p).trim().toLowerCase();
  if (s === "end") return Infinity;
  const n = parseInt(s, 10);
  return isNaN(n) ? -1 : n;
}
/** Normalize part identifier for comparison (e.g. "1" == "01") */
function normPart(p) {
  const n = partNum(p);
  if (n === Infinity) return "end";
  if (n >= 0) return String(n);
  return String(p).trim().toLowerCase();
}
/** Rebuild memory text from parts, sorted ascending */
function buildMemoryText(parts) {
  const sorted = [...parts].sort((a, b) => a.num - b.num);
  return sorted.map(p => {
    if (p.part === null) return p.text;
    return `[Part ${p.part}]\n` + p.text;
  }).join("\n\n").trim();
}
/**
 * Set memory for a specific part (replace if exists, else add).
 * Preserves other parts unchanged, keeps ascending order.
 */
function setMemoryPart(title, part, memText) {
  if (!title || memText === null || memText === undefined) return;
  const np = normPart(part);
  const parts = parseMemoryParts(getMemory(title));
  let found = false;
  for (const p of parts) {
    if (p.part !== null && normPart(p.part) === np) {
      p.text = memText.trim();
      p.part = String(partNum(part) === Infinity ? "End" : partNum(part));
      p.num = partNum(p.part);
      found = true;
      break;
    }
  }
  if (!found) {
    parts.push({ part: String(part), num: partNum(part), text: memText.trim() });
  }
  saveMemory(title, buildMemoryText(parts));
}
/**
 * Get memory for parts strictly earlier than the given part.
 * Part 1 gets no prior context. End gets all numbered parts.
 */
function getMemoryBefore(title, part) {
  const n = partNum(part);
  const parts = parseMemoryParts(getMemory(title));
  const earlier = parts.filter(p => p.part !== null && p.num >= 0 && p.num < n);
  if (!earlier.length) return null;
  return buildMemoryText(earlier);
}
function refreshSeriesDropdown() {
  const sel = $("rcSeriesTitleSel");
  if (!sel) return;
  const cur = $("rcSeriesTitle").value;
  sel.innerHTML = '<option value="">— အသစ် —</option>';
  for (const t of getAllSeries()) {
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    if (t === cur) o.selected = true;
    sel.appendChild(o);
  }
}

/* ============================================================
   PHASE 1: Series Presets (local browser storage)
   ============================================================ */
const PRESET_PREFIX = "preset_";
const LOGO_PREFIX = "logo_";

/** Collect current UI settings into a preset object */
function collectPresetSettings() {
  const style = getStyleOpts();
  const dims = getRcDims();
  return {
    subOn: style.subOn,
    subColor: style.subColor,
    subSize: style.subSize,
    subFont: style.subFont,
    shadeColor: style.shadeColor,
    shadeThick: style.shadeThick,
    subPos: style.subPos,
    logoShape: style.logoShape,
    logoPos: style.logoPos ? { ...style.logoPos } : null,
    logoImageId: style.logoPos ? rcLogoImageId : null,
    ratio: ($("rcRatio") || {}).value || "9:16",
    res: ($("rcRes") || {}).value || "720",
    fit: ($("rcFit") || {}).value || "cover",
    voice: ($("rcVoice") || {}).value || "my-MM-ThihaNeural",
    style_: ($("rcStyle") || {}).value || "",
    lang: ($("rcLang") || {}).value || "",
    flip: ($("rcFlip") || {}).checked || false,
  };
}

/** Apply preset settings to UI. Does NOT modify the saved preset. */
async function applyPresetSettings(settings) {
  if (!settings) return;
  const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = v; };
  const setChk = (id, v) => { const el = $(id); if (el && v !== undefined) el.checked = !!v; };
  setChk("rcSubOn", settings.subOn);
  set("rcSubColor", settings.subColor);
  set("rcSubSize", String(settings.subSize || "28"));
  set("rcSubFont", settings.subFont);
  set("rcShadeColor", settings.shadeColor);
  set("rcShadeThick", String(settings.shadeThick || "4"));
  set("rcSubPos", settings.subPos);
  set("rcRatio", settings.ratio);
  set("rcRes", String(settings.res || "720"));
  set("rcFit", settings.fit);
  set("rcLogoShape", settings.logoShape);
  set("rcVoice", settings.voice);
  set("rcStyle", settings.style_);
  set("rcLang", settings.lang);
  setChk("rcFlip", settings.flip);
  // Logo position
  if (settings.logoPos) {
    rcLogoPos = { ...settings.logoPos };
  }
  // Logo image: load blob from IDB
  if (settings.logoImageId) {
    try {
      const blob = await idbGet(LOGO_PREFIX + settings.logoImageId);
      if (!blob) {
        throw new Error("Logo image မတွေ့ပါ — preset မှာ သိမ်းထားတဲ့ logo ပျောက်နေပါတယ်. Logo ပြန်တင်ပေးပါ");
      }
      await setLogoFromBlob(blob);
      rcLogoImageId = settings.logoImageId;
    } catch (e) {
      // Clear logo but don't fail the whole preset
      rcLogoImg = null; rcLogoImageId = null;
      const w = $("rcLogoWrap"); if (w) w.style.display = "none";
      throw e;
    }
  } else {
    rcLogoImg = null; rcLogoImageId = null;
    const w = $("rcLogoWrap"); if (w) w.style.display = "none";
  }
  // Refresh layout
  try { if (typeof rcApplyLayout === "function") rcApplyLayout(); } catch (_) {}
}

/** Set logo from a Blob (preserves original format/transparency) */
function setLogoFromBlob(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      rcLogoImg = img;
      rcLogoBlob = blob; // keep original blob for saving
      const pv = $("rcLogoPrev");
      if (pv) pv.src = url;
      const w = $("rcLogoWrap");
      if (w) w.style.display = "";
      try { rcInitLogoDrag(); } catch (_) {}
      res();
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Logo image ဖတ်မရပါ")); };
    img.src = url;
  });
}
// Track current logo blob for preset saving (original format preserved)
let rcLogoBlob = null;
let rcLogoImageId = null;

/** Save logo blob to IDB, returns image ID (dedupe by size+type+name) */
async function saveLogoBlob(blob) {
  if (!blob) return null;
  // Simple ID: timestamp + size (dedupe not critical for Phase 1)
  const id = "img_" + Date.now().toString(36) + "_" + (blob.size || 0).toString(36);
  await idbSet(LOGO_PREFIX + id, blob);
  return id;
}

/** Create a new preset from current settings */
async function createPreset(name, seriesTitle) {
  if (!name || !name.trim()) throw new Error("Preset နာမည် ထည့်ပါ");
  // Save logo blob first (if any)
  let logoImageId = null;
  if (rcLogoImg && rcLogoBlob) {
    logoImageId = await saveLogoBlob(rcLogoBlob);
  }
  const settings = collectPresetSettings();
  settings.logoImageId = logoImageId;
  const id = PRESET_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const preset = {
    id, name: name.trim(),
    seriesTitle: (seriesTitle || "").trim() || null,
    settings,
    updatedAt: Date.now(),
  };
  await idbSet(id, preset);
  await refreshPresetList();
  return preset;
}

/** List all presets */
async function listPresets() {
  const keys = await idbKeys();
  const out = [];
  for (const k of keys) {
    if (typeof k === "string" && k.startsWith(PRESET_PREFIX)) {
      try { const p = await idbGet(k); if (p && p.id) out.push(p); } catch (_) {}
    }
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

/** Get a preset by ID */
async function getPreset(id) {
  if (!id) return null;
  try { return await idbGet(id); } catch (_) { return null; }
}

/**
 * Update an existing preset with current UI settings.
 * Preserves preset ID. Reuses logo blob if unchanged.
 */
async function updatePresetWithCurrentSettings(id) {
  const p = await getPreset(id);
  if (!p) throw new Error("Preset မတွေ့ပါ");
  const settings = collectPresetSettings();
  // Logo: preserve existing blob ID unless user uploaded a new logo
  // Case 1: new upload (rcLogoBlob set, rcLogoImageId null) → save new blob
  // Case 2: logo currently displayed with ID → reuse it
  // Case 3: no logo but preset had one → keep preset's ID (don't lose it)
  // Case 4: no logo anywhere → null
  if (rcLogoBlob && !rcLogoImageId) {
    settings.logoImageId = await saveLogoBlob(rcLogoBlob);
    rcLogoImageId = settings.logoImageId;
  } else if (!settings.logoImageId && p.settings && p.settings.logoImageId && rcLogoImg) {
    // User didn't change logo, preset had one, logo still displayed → keep preset's
    settings.logoImageId = p.settings.logoImageId;
  }
  // Also allow updating name/series from editor fields if filled
  const newName = ($("rcPresetName") || {}).value || "";
  const newSeries = ($("rcPresetSeries") || {}).value || "";
  const updates = { settings };
  if (newName.trim()) updates.name = newName.trim();
  // series: allow clearing too (empty = null)
  if ($("rcPresetSeries")) updates.seriesTitle = newSeries.trim() || null;
  return await updatePreset(id, updates);
}

/** Update preset (rename / edit settings / re-link series) */
async function updatePreset(id, updates) {
  const p = await getPreset(id);
  if (!p) throw new Error("Preset မတွေ့ပါ");
  if (updates.name !== undefined) p.name = updates.name.trim() || p.name;
  if (updates.seriesTitle !== undefined) p.seriesTitle = updates.seriesTitle.trim() || null;
  if (updates.settings !== undefined) p.settings = updates.settings;
  p.updatedAt = Date.now();
  await idbSet(id, p);
  await refreshPresetList();
  return p;
}

/** Duplicate a preset */
async function duplicatePreset(id) {
  const p = await getPreset(id);
  if (!p) throw new Error("Preset မတွေ့ပါ");
  const nid = PRESET_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const copy = JSON.parse(JSON.stringify(p));
  copy.id = nid;
  copy.name = p.name + " (copy)";
  copy.updatedAt = Date.now();
  await idbSet(nid, copy);
  await refreshPresetList();
  return copy;
}

/** Delete a preset (does not touch projects or Series Memory) */
async function deletePreset(id) {
  await idbDel(id);
  await refreshPresetList();
}

/** Refresh preset dropdown UI */
async function refreshPresetList() {
  const sel = $("rcPresetSel");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Preset မရွေး —</option>';
  try {
    const presets = await listPresets();
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + (p.seriesTitle ? ` (${p.seriesTitle})` : "");
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  } catch (e) { console.warn("refreshPresetList failed", e); }
}

/** Preview tool tabs: control which overlay is interactive */
function initPreviewTools() {
  try {
    const tools = document.getElementById("rcTools");
    const wrap = document.getElementById("rcBlurWrap");
    if (!tools || !wrap) return;
    // Avoid double-binding
    if (tools.dataset.bound) return;
    tools.dataset.bound = "1";
    const label = document.getElementById("rcModeLabel");
    const dock = document.getElementById("rcSettingsDock");
    const labels = {
      all: "👆 All overlays active",
      sub: "📝 Subtitle mode — logo/blur won't intercept touches",
      logo: "🖼️ Logo mode — drag/resize logo",
      blur: "🟫 Blur mode — add/move/resize blur boxes",
    };
    // Track original positions for restore
    const origPos = new Map();
    function findSect(keyword) {
      const sects = document.querySelectorAll("#tab-recap .sect");
      for (const s of sects) {
        const t = s.querySelector(".sect-title");
        if (t && t.textContent.includes(keyword)) return s;
      }
      return null;
    }
    function moveToDock(sect) {
      if (!sect || !dock) return;
      if (!origPos.has(sect)) {
        origPos.set(sect, { parent: sect.parentNode, next: sect.nextSibling });
      }
      dock.appendChild(sect);
    }
    function restoreAll() {
      for (const [sect, pos] of origPos) {
        if (pos.next && pos.next.parentNode === pos.parent) {
          pos.parent.insertBefore(sect, pos.next);
        } else {
          pos.parent.appendChild(sect);
        }
      }
      origPos.clear();
      if (dock) dock.innerHTML = "";
    }
    tools.addEventListener("click", (e) => {
      const btn = e.target.closest(".rc-tool");
      if (!btn) return;
      tools.querySelectorAll(".rc-tool").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tool = btn.dataset.tool;
      wrap.classList.remove("tool-sub", "tool-logo", "tool-blur");
      if (tool !== "all") wrap.classList.add("tool-" + tool);
      if (label) label.textContent = labels[tool] || labels.all;
      // Move relevant settings to dock
      restoreAll();
      const blurControls = document.getElementById("rcBlurControls");
      if (blurControls) {
        // Show blur controls only in All and Blu modes
        blurControls.style.display = (tool === "all" || tool === "blur") ? "" : "none";
      }
      if (tool === "sub") {
        const s = findSect("Subtitle");
        if (s) moveToDock(s);
      } else if (tool === "logo") {
        const s = findSect("Logo");
        if (s) moveToDock(s);
      }
    });
  } catch (e) { console.warn("tool tabs failed", e); }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPreviewTools);
} else {
  initPreviewTools();
}

/** Init preset UI handlers */
function initPresetUI() {
  const sel = $("rcPresetSel");
  if (!sel) return;
  // Apply button
  $("rcPresetApply")?.addEventListener("click", async () => {
    const id = sel.value;
    if (!id) { alert("Preset အရင်ရွေးပါ"); return; }
    try {
      const p = await getPreset(id);
      if (!p) throw new Error("Preset မတွေ့ပါ");
      await applyPresetSettings(p.settings);
      $("rcPresetInfo").textContent = `✅ "${p.name}" သုံးနေပါတယ်`;
      try { localStorage.setItem("nova_last_preset", id); } catch (_) {}
    } catch (e) {
      alert("Preset apply မရပါ: " + (e.message || e));
    }
  });
  // Save button - show editor
  $("rcPresetSave")?.addEventListener("click", () => {
    const ed = $("rcPresetEditor");
    if (ed) ed.style.display = ed.style.display === "none" ? "" : "none";
  });
  $("rcPresetManage")?.addEventListener("click", () => {
    const ed = $("rcPresetEditor");
    if (ed) ed.style.display = ed.style.display === "none" ? "" : "none";
  });
  $("rcPresetClose")?.addEventListener("click", () => {
    $("rcPresetEditor").style.display = "none";
  });
  // Do save (as new) - check for duplicates first
  $("rcPresetDoSave")?.addEventListener("click", async () => {
    const name = ($("rcPresetName") || {}).value || "";
    const series = ($("rcPresetSeries") || {}).value || "";
    if (!name.trim()) { alert("Preset နာမည် ထည့်ပါ"); return; }
    try {
      // Check for existing preset with same name + series
      const presets = await listPresets();
      const dup = presets.find(p =>
        p.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        (p.seriesTitle || "").trim().toLowerCase() === series.trim().toLowerCase()
      );
      if (dup) {
        const choice = confirm(
          `"${dup.name}" နာမည်တူ preset ရှိနေပါတယ်.\n\n` +
          `OK = ရွေးထားတဲ့ preset ကို Update လုပ်\n` +
          `Cancel = အသစ် အနေနဲ့ သိမ်း (duplicate)`
        );
        if (choice) {
          // Update existing instead
          await updatePresetWithCurrentSettings(dup.id);
          $("rcPresetInfo").textContent = `🔄 "${dup.name}" update ပြီးပြီ`;
          $("rcPresetEditor").style.display = "none";
          sel.value = dup.id;
          return;
        }
        // else fall through to create new
      }
      // Check storage quota
      const warn = await checkStorageQuota();
      if (warn) { if (!confirm(warn + "\n\nဆက်လုပ်မလား?")) return; }
      const p = await createPreset(name, series);
      $("rcPresetInfo").textContent = `💾 "${p.name}" သိမ်းပြီးပြီ`;
      $("rcPresetName").value = ""; $("rcPresetSeries").value = "";
      $("rcPresetEditor").style.display = "none";
      sel.value = p.id;
    } catch (e) {
      alert("Preset သိမ်းမရပါ: " + (e.message || e));
    }
  });
  // Update selected preset with current settings
  $("rcPresetUpdate")?.addEventListener("click", async () => {
    const id = sel.value;
    if (!id) { alert("Update လုပ်ဖို့ preset အရင်ရွေးပါ"); return; }
    const p = await getPreset(id);
    if (!p) { alert("Preset မတွေ့ပါ"); return; }
    if (!confirm(`"${p.name}" ရဲ့ settings ကို လက်ရှိ settings နဲ့ အစားထိုးမလား?`)) return;
    try {
      await updatePresetWithCurrentSettings(id);
      $("rcPresetInfo").textContent = `🔄 "${p.name}" update ပြီးပြီ`;
      $("rcPresetEditor").style.display = "none";
    } catch (e) {
      alert("Update မရပါ: " + (e.message || e));
    }
  });
  // Duplicate
  $("rcPresetDup")?.addEventListener("click", async () => {
    const id = sel.value;
    if (!id) { alert("Preset အရင်ရွေးပါ"); return; }
    try {
      const p = await duplicatePreset(id);
      sel.value = p.id;
      $("rcPresetInfo").textContent = `📋 "${p.name}" ပွားပြီးပြီ`;
    } catch (e) { alert("ပွားမရပါ: " + (e.message || e)); }
  });
  // Delete
  $("rcPresetDel")?.addEventListener("click", async () => {
    const id = sel.value;
    if (!id) { alert("Preset အရင်ရွေးပါ"); return; }
    const p = await getPreset(id);
    if (!confirm(`"${p ? p.name : id}" ကို ဖျက်မလား?`)) return;
    try {
      await deletePreset(id);
      sel.value = "";
      $("rcPresetInfo").textContent = "";
    } catch (e) { alert("ဖျက်မရပါ: " + (e.message || e)); }
  });
  // Track manual changes - show "modified" if settings differ from applied preset
  // (Phase 1: simple indicator, no auto-compare)
  // Init: refresh list and restore last preset selection
  refreshPresetList().then(() => {
    try {
      const last = localStorage.getItem("nova_last_preset");
      if (last) sel.value = last;
    } catch (_) {}
  });
}
// Init on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPresetUI);
} else {
  initPresetUI();
}

/** Check storage quota and warn if >80% used */
async function checkStorageQuota() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const est = await navigator.storage.estimate();
    if (!est.quota) return null;
    const pct = (est.usage || 0) / est.quota;
    if (pct > 0.8) {
      return `⚠️ Browser storage ${(pct * 100).toFixed(0)}% ပြည့်နေပါပြီ — မလိုတဲ့ projects/presets ဖျက်ပါ`;
    }
    return null;
  } catch (_) { return null; }
}

/** Get series info from UI */
function getSeriesInfo() {
  if (!($("rcSeriesOn") || {}).checked) return null;
  const title = (($("rcSeriesTitle") || {}).value || "").trim();
  const part = (($("rcSeriesPart") || {}).value || "").trim();
  if (!title) return null;
  const isEnd = part.toLowerCase() === "end";
  return { title, part: isEnd ? "End" : part, isEnd };
}
/** Validate Series inputs when Series mode is ON.
 * A run with Series ON but no valid part number would save story memory
 * under an empty/invalid part label and corrupt the memory structure,
 * so require: title + (positive integer part | "end"). */
function validateSeriesInputs() {
  if (!(($("rcSeriesOn") || {}).checked)) return { ok: true };
  const title = (($("rcSeriesTitle") || {}).value || "").trim();
  const part = (($("rcSeriesPart") || {}).value || "").trim();
  if (!title) return { ok: false, error: "Series mode ဖွင့်ထားရင် ဇာတ်လမ်းခေါင်းစဉ် ထည့်ပါ" };
  if (part.toLowerCase() === "end") return { ok: true };
  if (!/^\d+$/.test(part) || parseInt(part, 10) < 1) {
    return { ok: false, error: "Series mode ဖွင့်ထားရင် အပိုင်းနံပါတ် ထည့်ပါ (ဥပမာ 1, 2, 3) — နောက်ဆုံးပိုင်းဆို \"end\"" };
  }
  return { ok: true };
}
/** Build series prompt addition */
function seriesPromptExtra() {
  const s = getSeriesInfo();
  if (!s) return "";
  let extra = "";
  // Only use memories from parts STRICTLY EARLIER than current part
  // Part 1 gets no prior context; reruns don't see own/later memories
  // End gets all numbered parts (excludes obsolete End block); others get strictly earlier parts
  const mem = getMemoryBefore(s.title, s.isEnd ? "End" : s.part);
  if (mem) {
    extra += `\n\nSTORY MEMORY (previous parts of "${s.title}"): \n${mem}\n` +
      `Use the SAME character names and continue the story consistently.`;
  }
  if (s.isEnd) {
    return extra + `\n\nSERIES INFO: This is "${s.title}" — FINAL PART (End). ` +
      `At the end of your recap, add a closing line. ` +
      `If the story is complete, write something like "ဒီဇာတ်လမ်း ဒီမှာ ပြီးစီးပါပြီ". ` +
      `If the story continues (next season), predict what might happen next and add an exciting hook like "နောက် Season မှာ ဘာ ဖြစ် မလဲ? စောင့်ကြည့်ပါ".`;
  }
  return extra + `\n\nSERIES INFO: This is "${s.title}" — Part ${s.part} (continuation, NOT the end). ` +
    `STRICT RULES for continuation:` +
    `\n1. NEVER start with ANY meta-intro about episode numbers, previous episodes, or recaps.` +
    ` Examples of FORBIDDEN openings: "ဒုတိယပိုင်းမှာ", "အပိုင်း ${s.part} မှာ", "အရင်အပိုင်းမှာ",` +
    ` "ပြီးခဲ့တဲ့အပိုင်းမှာ", "In Part ${s.part}", "previously", or any equivalent.` +
    `\n2. NEVER greet viewers, summarize previous parts, or announce episode numbers.` +
    `\n3. Start DIRECTLY with the next story event, action, or dialogue — as if the story never paused.` +
    ` The first sentence must be about what a character DOES, SAYS, or what HAPPENS — not about the episode itself.` +
    `\n4. Do NOT repeat previous part content unless one brief detail is essential for understanding.` +
    `\n5. Do NOT add "wait for next part" hook at the end. End naturally when this part's events conclude.`;
}

/** Wake Lock: keep screen on during recording */
let _wakeLock = null;
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      _wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (_) {}
}
function releaseWakeLock() {
  try { _wakeLock?.release(); _wakeLock = null; } catch (_) {}
}

/** Fix duration metadata via FFmpeg stream-copy remux (for MP4/WebM) */
async function fixDuration(blob, ext, sec) {
  try {
    if (blob.size > 350 * 1048576) {
      // Use header patch for large files (no ffmpeg memory)
      if (ext === "mp4" && sec > 0) return await patchMp4Duration(blob, sec);
      return blob;
    }
    const ff = await ensureFFmpeg((m, c) => log("rc", m, c));
    const i = "rec_in." + ext, o = "rec_out." + ext;
    await ff.writeFile(i, await fetchFile(blob));
    await ff.exec(["-i", i, "-c", "copy",
      ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), o]);
    const d = await ff.readFile(o);
    for (const n of [i, o]) { try { await ff.deleteFile(n); } catch (_) {} }
    log("rc", "⏱️ Duration metadata ပြင်ပြီးပါပြီ ✅", "ok");
    return new Blob([d], { type: blob.type });
  } catch (e) {
    log("rc", "Duration fix မအောင်မြင်ပါ: " + e.message, "err");
    return blob;
  }
}

// Sync-only: uses saved rcLastRun, skips transcribe/script/TTS
$("rcSyncOnly")?.addEventListener("click", async () => {
  if (!rcLastRun || !rcLastRun.segPieces) { alert("Sync လုပ်စရာ data မရှိပါ — Recap အရင်လုပ်ပါ"); return; }
  if (!rcFile) { alert("Video file အရင်ရွေးပါ"); return; }
  setBusy(["rcSyncOnly", "startRecap"], true);
  const { segments, segPieces, baseName } = rcLastRun;
  setStep("mux", "run");
  try {
    log("rc", "🔄 Sync ပြန်လုပ်နေပါတယ်… (TTS skip)");
    const useAudioFirst = $("rcAudioFirst") && $("rcAudioFirst").checked;
    const isDubbing = (($("rcStyle") || {}).value || "") === "wordbyword";
    // Dubbing: video-first (output = video duration). Recap: audio-first.
    if (isDubbing) {
      setProgress("rc", 90, "🎙️ Dubbing sync (video-first)…");
      log("rc", "🎙️ Video timing အတိုင်း dubbing လုပ်နေပါတယ်…");
      const wantFlip = $("rcFlip") && $("rcFlip").checked;
      const wantWm = ($("rcWatermark") && $("rcWatermark").value.trim()) || "";
      const segsWithAudio = segments.map((s, i) => {
        const pieces = segPieces[s._i] || segPieces[i] || [];
        const audioBlob = pieces.length === 1 ? pieces[0] : new Blob(pieces, { type: "audio/mpeg" });
        const out = {
          outputStart: s.outputStart ?? s.start, outputEnd: s.outputEnd ?? s.end,
          start: s.start, end: s.end,  // deprecated alias
          text: s.text, audioBlob,
          audioDuration: s.audioDuration,
        };
        // Preserve genuine source timestamps only — never invent them
        if (typeof s.sourceStart === "number" && isFinite(s.sourceStart)) out.sourceStart = s.sourceStart;
        if (typeof s.sourceEnd === "number" && isFinite(s.sourceEnd)) out.sourceEnd = s.sourceEnd;
        return out;
      });
      // PHASE 1 Gap-3: Validate before export. sourceDuration is passed
      // but ONLY applies to genuine sourceStart/sourceEnd fields — output
      // timestamps are never compared against source duration.
      {
        const srcDur = (typeof rcFile !== "undefined" && rcFile && rcFile._dur) || 0;
        const v = validateRecapSegments(segsWithAudio, { sourceDuration: srcDur });
        if (!v.ok) {
          const msg = "Timestamp အမှား:\n" + v.errors.slice(0, 5).join("\n");
          log("rc", msg, "err");
          throw new Error(msg);
        }
      }
      let { blob: finalBlob, ext, duration: recDur, recSec } = await canvasDubSync(rcFile, segsWithAudio, {
        flip: wantFlip, watermarkText: wantWm, blurRegions: rcBlurRegions,
        ...getStyleOpts(),
        ...getRcDims(),
        onprog: (p) => setProgress("rc", 90 + p * 9, `Dubbing… ${Math.round(p * 100)}%`),
      });
      try { finalBlob = await fixDuration(finalBlob, ext, recSec); } catch (e) { console.warn("duration fix failed", e); }
      let srt = null;
      try { srt = segmentsToSRT(segments); }
      catch (e) {
        log("rc", `⚠️ SRT ထုတ်မရပါ: ${e.message}`, "err");
        srt = null; // Do NOT create file with error message
      }
      const srtBlob = srt ? new Blob([srt], { type: "text/plain" }) : null;
      const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });
      $("rcResults").innerHTML = "";
      const r1 = dlRow(baseName + "_dubbed." + ext, finalBlob);
      $("rcResults").appendChild(r1.row);
      const r2 = srtBlob ? dlRow(baseName + "_dubbed.srt", srtBlob) : null;
      if (r2) $("rcResults").appendChild(r2.row);
      const r3 = dlRow(baseName + "_script.txt", txtBlob);
      $("rcResults").appendChild(r3.row);
      setProgress("rc", 100, "ပြီးပါပြီ ✅");
      log("rc", "Dubbing ပြီးပါပြီ ✅", "ok");
      setStep("mux", "done");
    } else if (useAudioFirst) {
      setProgress("rc", 90, "🎯 Audio-first sync လုပ်နေပါတယ် (canvas)…");
      const wantFlip = $("rcFlip") && $("rcFlip").checked;
      const wantWm = ($("rcWatermark") && $("rcWatermark").value.trim()) || "";
      const segsWithAudio = segments.map((s, i) => {
        const pieces = segPieces[s._i] || segPieces[i] || [];
        const audioBlob = pieces.length === 1 ? pieces[0] : new Blob(pieces, { type: "audio/mpeg" });
        const out = {
          outputStart: s.outputStart ?? s.start, outputEnd: s.outputEnd ?? s.end,
          start: s.start, end: s.end,  // deprecated alias
          text: s.text, audioBlob,
          audioDuration: s.audioDuration,
        };
        // Preserve genuine source timestamps only — never invent them
        if (typeof s.sourceStart === "number" && isFinite(s.sourceStart)) out.sourceStart = s.sourceStart;
        if (typeof s.sourceEnd === "number" && isFinite(s.sourceEnd)) out.sourceEnd = s.sourceEnd;
        return out;
      });
      // PHASE 1 Gap-3: Validate before export. sourceDuration is passed
      // but ONLY applies to genuine sourceStart/sourceEnd fields — output
      // timestamps are never compared against source duration.
      {
        const srcDur = (typeof rcFile !== "undefined" && rcFile && rcFile._dur) || 0;
        const v = validateRecapSegments(segsWithAudio, { sourceDuration: srcDur });
        if (!v.ok) {
          const msg = "Timestamp အမှား:\n" + v.errors.slice(0, 5).join("\n");
          log("rc", msg, "err");
          throw new Error(msg);
        }
      }
      let { blob: finalBlob, ext, duration: recDur, recSec } = await canvasRecapSync(rcFile, segsWithAudio, {
        flip: wantFlip, watermarkText: wantWm, blurRegions: rcBlurRegions,
        ...getStyleOpts(),
        ...getRcDims(),
        onprog: (p, si, n) => setProgress("rc", 90 + p * 9, `Sync… segment ${si + 1}/${n}`),
      });
      // Fix WebM duration metadata (for CapCut/editors)
      try { finalBlob = await fixDuration(finalBlob, ext, recSec); } catch (e) { console.warn("duration fix failed", e); }
      let srt = null;
      try { srt = await srtFromSegsWithAudio(segsWithAudio, "rc"); }
      catch (e) {
        log("rc", `⚠️ SRT ထုတ်မရပါ: ${e.message}`, "err");
        srt = null; // Do NOT create file with error message
      }
      const srtBlob = srt ? new Blob([srt], { type: "text/plain" }) : null;
      const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });
      $("rcResults").innerHTML = "";
      // Final validation: ensure output blob is valid before offering download
      if (!finalBlob || finalBlob.size < 1024) {
        const msg = `Export failed: output file too small (${finalBlob ? finalBlob.size : 0} bytes)`;
        log("rc", "❌ " + msg, "err");
        throw new Error(msg);
      }
      const r1 = dlRow(baseName + "_recap_sync." + ext, finalBlob);
      $("rcResults").appendChild(r1.row);
      const r2 = srtBlob ? dlRow(baseName + "_recap.srt", srtBlob) : null;
      if (r2) $("rcResults").appendChild(r2.row);
      const r3 = dlRow(baseName + "_script.txt", txtBlob);
      $("rcResults").appendChild(r3.row);
      setProgress("rc", 100, "ပြီးပါပြီ ✅");
      // Log actual vs target (do NOT claim target achieved)
      try {
        const actualMin = (recSec || recDur || 0) / 60;
        log("rc", `📊 Export: ${actualMin.toFixed(1)} မိနစ် (actual)`, actualMin > 0 ? "ok" : "err");
      } catch (_) {}
      log("rc", "Sync ပြီးပါပြီ ✅", "ok");
      setStep("mux", "done");
    } else {
      const ff2 = await ensureFFmpeg((m, c) => log("rc", m, c));
      await doRecapMux(ff2, segments, segPieces, baseName);
    }
  } catch (e) {
    log("rc", "အမှား: " + (e.message || e), "err");
    setStep("mux", "fail");
  } finally {
    setBusy(["rcSyncOnly", "startRecap"], false);
  }
});

$("rcFile").addEventListener("change", async (e) => {
  rcFile = e.target.files[0] || null;
  $("rcResults").innerHTML = "";
  rcShowBlurPreview();
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

// Check for saved recap run on load
(async () => {
  try {
    const saved = await idbGet("rc-last");
    if (saved && saved.segments && saved.segPieces && (Date.now() - saved.savedAt) < 24 * 3600 * 1000) {
      // Auto-restore rcLastRun so Sync button works immediately
      rcLastRun = { segments: saved.segments, segPieces: saved.segPieces, baseName: saved.baseName };
      const sbAuto = $("rcSyncOnly");
      if (sbAuto) sbAuto.style.display = "";
      if (saved.transcript) { try { $("rcTranscript").value = saved.transcript; } catch (_) {} }
      if (saved.script) { try { $("rcScript").value = saved.script; } catch (_) {} }
      const bar = document.createElement("div");
      bar.style.cssText = "background:#1a3a2a;border:1px solid #4caf50;border-radius:8px;padding:12px;margin:8px 0;";
      bar.innerHTML = `<div>💾 <b>သိမ်းထားတာ ရှိတယ်</b> (${saved.segments.length} segments, ${new Date(saved.savedAt).toLocaleString()})</div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button id="rcResumeBtn" style="flex:1;">▶️ ဆက်လုပ် (API ပြန်မကုန်)</button>
          <button id="rcDiscardBtn" class="ghost">🗑️ ဖျက်</button>
        </div>`;
      const rcSec = document.querySelector("#rcSteps")?.parentElement;
      if (rcSec) rcSec.insertBefore(bar, document.querySelector("#rcSteps"));
      $("rcResumeBtn").onclick = async () => {
        // Restore state
        if (saved.transcript) $("rcTranscript").value = saved.transcript;
        if (saved.script) $("rcScript").value = saved.script;
        rcLastRun = { segments: saved.segments, segPieces: saved.segPieces, baseName: saved.baseName };
        // Need the video file — user must re-select it
        alert("Video file ကို ပြန်ရွေးပေးပါ (အသံက သိမ်းထားပြီးသား)");
        bar.remove();
        // Jump to step 5
        setStep("tts", "done");
        const sb2 = $("rcSyncOnly");
        if (sb2) sb2.style.display = "";
        log("rc", "📂 ပြန်လည်ရယူပြီးပြီ — video ရွေးပြီး '🔄 Sync ပြန်လုပ်' နှိပ်ပါ", "ok");
      };
      $("rcDiscardBtn").onclick = async () => {
        await idbDel("rc-last");
        bar.remove();
      };
    }
  } catch (e) { console.warn("resume check failed", e); }
})();

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

// ---- voice preview: play a short sample in the selected voice ----
$("previewVoice").addEventListener("click", async () => {
  const voice = $("rcVoice").value;
  const sample = "မင်္ဂလာပါ။ ဒါက အသံ စမ်းသပ်ခြင်း ဖြစ်ပါတယ်။";
  const btn = $("previewVoice");
  btn.disabled = true;
  const oldT = btn.textContent;
  btn.textContent = "⏳…";
  try {
    let blob = null;
    try { blob = await serverEdgeTTS(sample, voice); }
    catch (_) { blob = await edgeTTS(sample, voice); }
    if (blob && blob.size > 0) {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } else {
      alert("အသံထုတ်မရပါ");
    }
  } catch (e) {
    alert("အမှား: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = oldT;
  }
});

$("startRecap").addEventListener("click", async () => {
  revokeUrls("recap");
  rcLastRun = null; // Fix #9: clear previous run to avoid mixing old audio with new video
  if (!rcFile) { alert("Video file အရင်ရွေးပါ"); return; }
  const sv = validateSeriesInputs();
  if (!sv.ok) { alert(sv.error); log("rc", "❌ " + sv.error, "err"); return; }
  acquireWakeLock();
  const lang = $("rcLang").value;
  const voice = $("rcVoice").value;
  setBusy(["startRecap"], true);
  $("rcResults").innerHTML = "";
  rcHandoff = null;
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

    // If SRT uploaded + dubbing: use SRT directly, skip transcribe/translate
    const rcStyleVal0 = ($("rcStyle") || {}).value || "story";
    let useSrtDirect = false;
    if (rcSrtSegments && rcSrtSegments.length && rcStyleVal0 === "wordbyword") {
      log("rc", `📄 SRT သုံးမယ် (${rcSrtSegments.length} ကြောင်း) — transcribe/translate skip`, "ok");
      setStep("transcribe", "done");
      setStep("script", "done");
      useSrtDirect = true;
    }

    // ---- step 2: transcribe (chunked if big) ----
    setStep("transcribe", "run");
    const allSegs = [];
    if (!useSrtDirect) {
    log("rc", "2️⃣ စာသားပြောင်းနေပါတယ် (Groq Whisper)…");
    const CHUNK_MB = 15;
    const sizeMB = audioBlob.size / 1048576;
    const audioDur = await mediaDuration(audioBlob).catch(() => 0);
    let nChunks = Math.max(1, Math.ceil(sizeMB / CHUNK_MB));
    if (audioDur <= 0 && nChunks > 1) {
      // duration unreadable: time-based split impossible — send once instead of
      // duplicating the full audio in every chunk
      nChunks = 1;
      log("rc", "⚠️ အသံကြာချိန် ဖတ်မရလို့ တစ်ပိုင်းတည်း ပို့ပါမယ်", "err");
    }
    const chunkDur = audioDur > 0 ? audioDur / nChunks : 0;
    log("rc", `အသံ ${nChunks} ပိုင်း ခွဲပြီး transcribe လုပ်ပါမယ်`);
    await ff.writeFile("taudio.mp3", await fetchFile(audioBlob));
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
      let segs = null, errs = [];
      try {
        segs = await groqTranscribe(cblob, lang);
        log("rc", `အပိုင်း ${i + 1}: Groq ရပါပြီ (${segs.length} ကြောင်း)`, "ok");
      } catch (e) {
        errs.push("Groq: " + e.message);
        log("rc", `အပိုင်း ${i + 1}: Groq မရပါ — AssemblyAI စမ်းပါမယ်…`, "err");
      }
      if (!segs) {
        try {
          const aaiKey = (getKeys().aai || "").trim();
          if (!aaiKey) throw new Error("Assembly AI key မရှိပါ");
          segs = await aaiTranscribe(cblob, aaiKey);
          log("rc", `အပိုင်း ${i + 1}: AssemblyAI ရပါပြီ (${segs.length} ကြောင်း)`, "ok");
        } catch (e) {
          errs.push("AAI: " + e.message);
          log("rc", `အပိုင်း ${i + 1}: AssemblyAI မရပါ — Gemini စမ်းပါမယ်…`, "err");
        }
      }
      if (!segs) {
        try {
          segs = await geminiTranscribe(cblob);
          log("rc", `အပိုင်း ${i + 1}: Gemini ရပါပြီ`, "ok");
        } catch (e2) {
          errs.push("Gemini: " + e2.message);
          throw new Error(`transcribe မအောင်မြင်ပါ (အပိုင်း ${i + 1}): ` + errs.join(" | "));
        }
      }
      for (const s of segs) allSegs.push({ start: s.start + start, end: s.end + start, text: s.text });
    }
    await ff.deleteFile("taudio.mp3");
    } // end if (!useSrtDirect)
    if (useSrtDirect) {
      allSegs.length = 0;
      for (const s of rcSrtSegments) allSegs.push({ start: s.start, end: s.end, text: s.text });
      $("rcTranscript").value = allSegs.map((s) => "[" + fmtClock(s.start) + "] " + s.text).join("\n").slice(0, 6000);
      log("rc", `SRT transcript ရပါပြီ (${allSegs.length} ကြောင်း) ✅`, "ok");
    }
    allSegs.sort((a, b) => a.start - b.start);
    const transcriptText = allSegs.map((s) => "[" + fmtClock(s.start) + "] " + s.text).join("\n");
    $("rcTranscript").value = transcriptText.slice(0, 6000);
    log("rc", `transcript ရပါပြီ (${allSegs.length} ကြောင်း) ✅`, "ok");
    setStep("transcribe", "done");

    // ---- step 3: recap script ----
    setStep("script", "run");
    const rcStyle = ($("rcStyle") || {}).value || "story";
    const watchMode = ($("rcWatchMode") || {}).value || "frames";
    let segments = null;
    if (useSrtDirect) {
      // SRT direct: use allSegs as segments (already translated)
      segments = allSegs.map((s) => ({ start: s.start, end: s.end, text: s.text }));
      $("rcScript").value = segments.map((s) => `[${fmtClock(s.start)}-${fmtClock(s.end)}] ${s.text}`).join("\n");
      log("rc", `SRT script ရပါပြီ (${segments.length} ကြောင်း) ✅`, "ok");
      setStep("script", "done");
    }
    if (!segments && rcStyle === "wordbyword") {
      // Word-by-word dubbing: translate transcript directly, keep original timing
      setProgress("rc", 55, "စာသားတွေ မြန်မာလို ပြန်နေပါတယ်…");
      log("rc", "🎙️ Word-by-word dubbing — transcript ကို တိုက်ရိုက် ဘာသာပြန်နေပါတယ်…");
      segments = [];
      const BATCH = 10;
      for (let i = 0; i < allSegs.length; i += BATCH) {
        const batch = allSegs.slice(i, i + BATCH);
        const prompt = "Translate each line to natural spoken Burmese (စကားပြော). " +
          "Return ONLY the translations, one per line, in the same order. " +
          "No numbering, no explanations.\n\n" +
          batch.map((s, j) => `${j + 1}. ${s.text}`).join("\n");
        try {
          const out = await geminiText(prompt, 8000);
          const lines = out.trim().split("\n").map((l) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);
          batch.forEach((s, j) => {
            segments.push({ start: s.start, end: s.end, text: lines[j] || s.text });
          });
        } catch (e) {
          // Fallback: use original text
          batch.forEach((s) => segments.push({ start: s.start, end: s.end, text: s.text }));
        }
        setProgress("rc", 55 + (i / allSegs.length) * 10, `ဘာသာပြန်နေပါတယ်… (${Math.min(i + BATCH, allSegs.length)}/${allSegs.length})`);
      }
      log("rc", `dubbing script ရပါပြီ (${segments.length} ကြောင်း) ✅`, "ok");
      setStep("script", "done");
    }
    if (!segments && watchMode === "fullvideo") {
      // Full video via Gemini Files API — AI watches the entire video
      try {
        setProgress("rc", 52, "Video တင်နေပါတယ် (Gemini)…");
        log("rc", "3️⃣ Video အပြည့်တင်ပြီး AI ကြည့်နေပါတယ်… 🎬");
        const fileUri = await geminiUploadVideo(rcFile, (i) =>
          setProgress("rc", 52 + Math.min(i, 10), `video process စောင့်နေပါတယ်…`));
        setProgress("rc", 62, "AI က video ကြည့်ပြီး script ရေးနေပါတယ်…");
        log("rc", `🎬 video အပြည့် + style (${rcStyle}) နဲ့ script ရေးနေပါတယ်…`);
        {
        const srcMin = (rcFile && rcFile._dur ? rcFile._dur : 480) / 60;
        const tgtMin = getDurationTarget().targetMin;
        log("rc", `🎯 Target: ~${tgtMin} မိနစ် (မူရင်း ${Math.round(srcMin)} မိနစ်၏ ${getDurationTarget().pct}%) [full-video] — ခန့်မှန်းခြေသာ`);
        segments = await geminiRecapFromVideoFile(fileUri, rcStyle, seriesPromptExtra(), { targetMinutes: tgtMin });
      }
        log("rc", `video-ကြည့်ပြီး script ရပါပြီ (${segments.length} segments) ✅`, "ok");
      } catch (e) {
        log("rc", `full video မအောင်မြင်ပါ (${e.message}) — frames နဲ့ ဆက်လုပ်ပါမယ်…`, "err");
      }
    }
    if (!segments || !segments.length) {
      // Frames mode (or fullvideo fallback)
      try {
        setProgress("rc", 52, "Scene frames ထုတ်နေပါတယ်…");
        log("rc", "3️⃣ AI က scene တွေကြည့်နေပါတယ်… 🎬");
        const frames = await extractSceneFrames(rcFile, 40, (i, n) =>
          setProgress("rc", 52 + (i / Math.max(1, n)) * 4, `scene ထုတ်နေပါတယ်… (${i}/${n})`));
        if (frames.length >= 4) {
          setProgress("rc", 57, "AI က scene တွေကြည့်ပြီး script ရေးနေပါတယ်…");
          log("rc", `🎬 scene ${frames.length} ကွက် + transcript နဲ့ script ရေးနေပါတယ်…`);
          {
          const srcMin = (rcFile && rcFile._dur ? rcFile._dur : 480) / 60;
          const tgtMin = getDurationTarget().targetMin;
          log("rc", `🎯 Target: ~${tgtMin} မိနစ် (မူရင်း ${Math.round(srcMin)} မိနစ်၏ ${getDurationTarget().pct}%) [vision] — ခန့်မှန်းခြေသာ`);
          segments = await geminiRecapScriptVision(frames, transcriptText, seriesPromptExtra(), { targetMinutes: tgtMin });
        }
          log("rc", `scene-ကြည့်ပြီး script ရပါပြီ (${segments.length} segments) ✅`, "ok");
        } else {
          log("rc", "scene ထုတ်မရပါ — စာသားနဲ့ပဲ ဆက်လုပ်ပါမယ်…", "err");
        }
      } catch (e) {
        log("rc", `scene script မအောင်မြင်ပါ (${e.message}) — စာသားနဲ့ပဲ ဆက်လုပ်ပါမယ်…`, "err");
      }
    }
    if (!segments || !segments.length) {
      setProgress("rc", 58, "Recap script ရေးနေပါတယ် (Gemini)…");
      log("rc", "3️⃣ Gemini က recap script ရေးနေပါတယ်…");
      {
        const srcMin = (rcFile && rcFile._dur ? rcFile._dur : 480) / 60;
        const tgtMin = getDurationTarget().targetMin;
        log("rc", `🎯 Target: ~${tgtMin} မိနစ် (မူရင်း ${Math.round(srcMin)} မိနစ်၏ ${getDurationTarget().pct}%) — ခန့်မှန်းခြေသာ`);
        segments = await geminiRecapScript(transcriptText, seriesPromptExtra(), { targetMinutes: tgtMin });
      }
    }
    $("rcScript").value = segments.map((s) => {
      // SRC format: show source timestamps; output calculated later from audio
      // Guard: both must be finite numbers, else show validation error
      if (s.sourceStart !== undefined) {
        const a = s.sourceStart, b = s.sourceEnd;
        if (typeof a !== "number" || !isFinite(a) || typeof b !== "number" || !isFinite(b)) {
          return `[SRC INVALID] ${s.text} (timestamp error - see log)`;
        }
        return `[SRC ${fmtClock(a)}-${fmtClock(b)}] ${s.text}`;
      }
      const a = s.outputStart ?? s.start, b = s.outputEnd ?? s.end;
      // Guard against NaN display
      const fa = (typeof a === "number" && isFinite(a)) ? fmtClock(a) : "??:??";
      const fb = (typeof b === "number" && isFinite(b)) ? fmtClock(b) : "??:??";
      return `[${fa}-${fb}] ${s.text}`;
    }).join("\n");
    log("rc", `script ရပါပြီ (${segments.length} segments) ✅`, "ok");
    // PRIORITY 1: Validate BEFORE TTS to avoid wasting API credits
    {
      const srcDur = (typeof rcFile !== "undefined" && rcFile && rcFile._dur) || 0;
      const v = validateRecapSegments(segments, { sourceDuration: srcDur });
      if (!v.ok) {
        const msg = "Script အမှား (TTS မလုပ်ခင်):\n" + v.errors.slice(0, 5).join("\n");
        log("rc", msg, "err");
        throw new Error(msg);
      }
      log("rc", "✅ Script validation အောင်မြင်ပါပြီ", "ok");
    }
    setStep("script", "done");
    // Auto-save story memory if series ON (Phase 1)
    try {
      const si = getSeriesInfo();
      if (si && !si.isEnd && segments && segments.length) {
        log("rc", "📓 Memory ထုတ် နေ ပါ တယ်…");
        extractStoryMemory(segments).then((mem) => {
          if (mem && mem.trim()) {
            // Replace Part N block (no duplicates), preserve other parts
            setMemoryPart(si.title, si.part, mem);
            log("rc", "📓 Memory သိမ်း ပြီးပါ ပြီ ✅", "ok");
            refreshSeriesDropdown();
          } else {
            // Do NOT replace valid memory with empty content
            log("rc", "📓 Memory ထုတ် မ ရ ပါ (အဟောင်း မပျက်)", "err");
          }
        }).catch((e) => log("rc", "📓 Memory error: " + (e.message || e), "err"));
      }
    } catch (e) { log("rc", "📓 Memory error: " + (e.message || e), "err"); }

    // ---- step 4: TTS per segment ----
    setStep("tts", "run");
    // Circuit breaker: if the TTS server fails 3 times in a row, stop paying
    // its timeout on every remaining piece and use the browser path only.
    let srvTtsFailStreak = 0;
    let srvTtsDisabled = false;
    async function ttsPiece(text) {
      if (!srvTtsDisabled) {
        try {
          const b = await serverEdgeTTS(text, voice);
          srvTtsFailStreak = 0;
          return b;
        } catch (e1) {
          srvTtsFailStreak++;
          if (srvTtsFailStreak >= 3) {
            srvTtsDisabled = true;
            log("rc", "⚠️ server TTS ၃ ခါ ဆက်တိုက် မရပါ — ကျန် အပိုင်းတွေကို browser Edge နဲ့ပဲ လုပ်ပါမယ်", "err");
          } else {
            log("rc", "⚠️ server TTS မရပါ — browser Edge နဲ့ ပြန်စမ်းမယ်…", "err");
          }
        }
      }
      return await edgeTTS(text, voice);
    }
    stageStart("tts");
    log("rc", `4\uFE0F\u20E3 \u1021\u101E\u1036\u1011\u103d\u1000\u1039\u1014\u1031\u1015\u102B\u1010\u101A\u103a (server TTS \u2014 ${voice})\u2026`);
    const segPieces = segments.map(() => []);
    let ttsFailed = null;
    let ttsDone = 0;
    // Bounded concurrency: 2 segments at a time. Each segment's pieces
    // are still processed sequentially with retries. Order preserved via index.
    async function processTtsSegment(i) {
      const seg = segments[i];
      const pieces = splitLongText(seg.text, 700);
      for (const pc of pieces) {
        let b = null, terr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            b = await ttsPiece(pc);
            if (b.size === 0) throw new Error("အသံဖိုင် ဗလာ ဖြစ်နေပါတယ်");
            terr = null;
            break;
          } catch (e) {
            terr = e;
            log("rc", `အပိုင်း ${i + 1} TTS (${attempt}/3) မရပါ — ပြန်စမ်းနေပါတယ်…`, "err");
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
        if (!b || b.size === 0) throw terr || new Error("TTS မအောင်မြင်ပါ");
        segPieces[i].push(b);
      }
      ttsDone++;
      setProgress("rc", 60 + (ttsDone / segments.length) * 25,
        `အသံထွက်နေပါတယ်… (${ttsDone}/${segments.length})`);
      if (ttsDone % 5 === 0 || ttsDone === segments.length) {
        log("rc", `အသံ ${ttsDone}/${segments.length} ပြီးပါပြီ`, "ok");
      }
    }
    {
      let nextIdx = 0;
      const workers = [0, 1].map(async () => {
        while (true) {
          if (ttsFailed) break;
          const i = nextIdx++;
          if (i >= segments.length) break;
          try {
            await processTtsSegment(i);
          } catch (e) {
            if (!ttsFailed) {
              ttsFailed = { index: i, text: segments[i].text, error: e };
              log("rc", `❌ အပိုင်း ${i + 1} TTS မအောင်မြင်ပါ: ${e.message}`, "err");
            }
            break;
          }
        }
      });
      await Promise.all(workers);
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
    const totalPieces = segPieces.reduce((a, p) => a + p.length, 0);
    const ttsSecs = stageEnd("tts");
    log("rc", `အသံအားလုံး ရပါပြီ (${segments.length} segments, ${totalPieces} ပိုင်း${ttsSecs ? ", " + ttsSecs + "s" : ""}) ✅`, "ok");
    setStep("tts", "done");
    // Show sync-only button
    // Validate: ensure all segments have audio before proceeding
    const missingAudio = [];
    for (let i = 0; i < segments.length; i++) {
      const pieces = segPieces[i] || [];
      const totalSize = pieces.reduce((a, b) => a + (b.size || 0), 0);
      if (!pieces.length || totalSize === 0) missingAudio.push(i + 1);
    }
    if (missingAudio.length) {
      const msg = `အသံမရှိတဲ့ segments: ${missingAudio.slice(0, 5).join(", ")}${missingAudio.length > 5 ? "..." : ""}`;
      log("rc", "❌ " + msg, "err");
      throw new Error(msg);
    }
    const syncBtn = $("rcSyncOnly");
    if (syncBtn) syncBtn.style.display = "";
    // Persist to IndexedDB (survives refresh — no more wasted API calls)
    try {
      await idbSet("rc-last", {
        segments, segPieces, baseName,
        savedAt: Date.now(),
        transcript: $("rcTranscript").value,
        script: $("rcScript").value,
      });
      log("rc", "💾 သိမ်းပြီးပြီ — refresh လုပ်လည်း ပြန်စရာ မလို", "ok");
    } catch (e) {
      console.warn("idb save failed", e);
    }

    // ---- step 5: sync + mux ----
    rcLastRun = { segments, segPieces, baseName };
    const useAudioFirst = $("rcAudioFirst") && $("rcAudioFirst").checked;
    const isDubbing = (($("rcStyle") || {}).value || "") === "wordbyword";
    // Dubbing: video-first (output = video duration). Recap: audio-first.
    if (isDubbing) {
      setProgress("rc", 90, "🎙️ Dubbing sync (video-first)…");
      log("rc", "🎙️ Video timing အတိုင်း dubbing လုပ်နေပါတယ်…");
      const wantFlip = $("rcFlip") && $("rcFlip").checked;
      const wantWm = ($("rcWatermark") && $("rcWatermark").value.trim()) || "";
      const segsWithAudio = segments.map((s, i) => {
        const pieces = segPieces[s._i] || segPieces[i] || [];
        const audioBlob = pieces.length === 1 ? pieces[0] : new Blob(pieces, { type: "audio/mpeg" });
        const out = {
          outputStart: s.outputStart ?? s.start, outputEnd: s.outputEnd ?? s.end,
          start: s.start, end: s.end,  // deprecated alias
          text: s.text, audioBlob,
          audioDuration: s.audioDuration,
        };
        // Preserve genuine source timestamps only — never invent them
        if (typeof s.sourceStart === "number" && isFinite(s.sourceStart)) out.sourceStart = s.sourceStart;
        if (typeof s.sourceEnd === "number" && isFinite(s.sourceEnd)) out.sourceEnd = s.sourceEnd;
        return out;
      });
      // PHASE 1 Gap-3: Validate before export. sourceDuration is passed
      // but ONLY applies to genuine sourceStart/sourceEnd fields — output
      // timestamps are never compared against source duration.
      {
        const srcDur = (typeof rcFile !== "undefined" && rcFile && rcFile._dur) || 0;
        const v = validateRecapSegments(segsWithAudio, { sourceDuration: srcDur });
        if (!v.ok) {
          const msg = "Timestamp အမှား:\n" + v.errors.slice(0, 5).join("\n");
          log("rc", msg, "err");
          throw new Error(msg);
        }
      }
      let { blob: finalBlob, ext, duration: recDur, recSec } = await canvasDubSync(rcFile, segsWithAudio, {
        flip: wantFlip, watermarkText: wantWm, blurRegions: rcBlurRegions,
        ...getStyleOpts(),
        ...getRcDims(),
        onprog: (p) => setProgress("rc", 90 + p * 9, `Dubbing… ${Math.round(p * 100)}%`),
      });
      try { finalBlob = await fixDuration(finalBlob, ext, recSec); } catch (e) { console.warn("duration fix failed", e); }
      let srt = null;
      try { srt = segmentsToSRT(segments); }
      catch (e) {
        log("rc", `⚠️ SRT ထုတ်မရပါ: ${e.message}`, "err");
        srt = null; // Do NOT create file with error message
      }
      const srtBlob = srt ? new Blob([srt], { type: "text/plain" }) : null;
      const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });
      $("rcResults").innerHTML = "";
      const r1 = dlRow(baseName + "_dubbed." + ext, finalBlob);
      $("rcResults").appendChild(r1.row);
      const r2 = srtBlob ? dlRow(baseName + "_dubbed.srt", srtBlob) : null;
      if (r2) $("rcResults").appendChild(r2.row);
      const r3 = dlRow(baseName + "_script.txt", txtBlob);
      $("rcResults").appendChild(r3.row);
      setProgress("rc", 100, "ပြီးပါပြီ ✅");
      log("rc", "Dubbing ပြီးပါပြီ ✅", "ok");
      setStep("mux", "done");
    } else if (useAudioFirst) {
      // Canvas audio-first: video adjusts to narration per segment
      setStep("mux", "run");
      setProgress("rc", 90, "🎯 Audio-first sync လုပ်နေပါတယ် (canvas)…");
      log("rc", "5️⃣ Video ကို အသံနဲ့ကိုက်အောင် ညှိနေပါတယ်… 🎯");
      const wantFlip = $("rcFlip") && $("rcFlip").checked;
      const wantWm = ($("rcWatermark") && $("rcWatermark").value.trim()) || "";
      // Build segments with audio blobs
      const segsWithAudio = segments.map((s, i) => {
        const pieces = segPieces[s._i] || segPieces[i] || [];
        const audioBlob = pieces.length === 1 ? pieces[0] : new Blob(pieces, { type: "audio/mpeg" });
        const out = {
          outputStart: s.outputStart ?? s.start, outputEnd: s.outputEnd ?? s.end,
          start: s.start, end: s.end,  // deprecated alias
          text: s.text, audioBlob,
          audioDuration: s.audioDuration,
        };
        // Preserve genuine source timestamps only — never invent them
        if (typeof s.sourceStart === "number" && isFinite(s.sourceStart)) out.sourceStart = s.sourceStart;
        if (typeof s.sourceEnd === "number" && isFinite(s.sourceEnd)) out.sourceEnd = s.sourceEnd;
        return out;
      });
      // PHASE 1 Gap-3: Validate before export. sourceDuration is passed
      // but ONLY applies to genuine sourceStart/sourceEnd fields — output
      // timestamps are never compared against source duration.
      {
        const srcDur = (typeof rcFile !== "undefined" && rcFile && rcFile._dur) || 0;
        const v = validateRecapSegments(segsWithAudio, { sourceDuration: srcDur });
        if (!v.ok) {
          const msg = "Timestamp အမှား:\n" + v.errors.slice(0, 5).join("\n");
          log("rc", msg, "err");
          throw new Error(msg);
        }
      }
      let { blob: finalBlob, ext, duration: recDur, recSec } = await canvasRecapSync(rcFile, segsWithAudio, {
        flip: wantFlip,
        watermarkText: wantWm,
        blurRegions: rcBlurRegions,
        ...getStyleOpts(),
        ...getRcDims(),
        onprog: (p, si, n) => setProgress("rc", 90 + p * 9, `Sync… segment ${si + 1}/${n}`),
      });
      try { finalBlob = await fixDuration(finalBlob, ext, recSec); } catch (e) { console.warn("duration fix failed", e); }
      // SRT + script files
      let srt = null;
      try { srt = await srtFromSegsWithAudio(segsWithAudio, "rc"); }
      catch (e) {
        log("rc", `⚠️ SRT ထုတ်မရပါ: ${e.message}`, "err");
        srt = null; // Do NOT create file with error message
      }
      const srtBlob = srt ? new Blob([srt], { type: "text/plain" }) : null;
      const txtBlob = new Blob([$("rcScript").value], { type: "text/plain" });
      // Final validation: ensure output blob is valid before offering download
      if (!finalBlob || finalBlob.size < 1024) {
        const msg = `Export failed: output file too small (${finalBlob ? finalBlob.size : 0} bytes)`;
        log("rc", "❌ " + msg, "err");
        throw new Error(msg);
      }
      const r1 = dlRow(baseName + "_recap_sync." + ext, finalBlob);
      $("rcResults").appendChild(r1.row);
      const r2 = srtBlob ? dlRow(baseName + "_recap.srt", srtBlob) : null;
      if (r2) $("rcResults").appendChild(r2.row);
      const r3 = dlRow(baseName + "_script.txt", txtBlob);
      $("rcResults").appendChild(r3.row);
      setProgress("rc", 100, "ပြီးပါပြီ ✅");
      log("rc", "Audio-first sync ပြီးပါပြီ ✅", "ok");
      setStep("mux", "done");
    } else {
      await doRecapMux(ff, segments, segPieces, baseName);
    }
  } catch (e) {
    log("rc", "အမှား: " + (e.message || e), "err");
    setProgress("rc", 0, "");
    document.querySelectorAll("#rcSteps li.run").forEach((li) => { li.className = "fail"; });
    if (rcLastRun && rcLastRun.segPieces) {
      const rb = document.createElement("button");
      rb.className = "ghost";
      rb.textContent = "🔄 Sync ပြန်လုပ် (TTS ပြန်မလုပ်ဘူး)";
      rb.onclick = async () => {
        rb.disabled = true;
        try {
          log("rc", "🔄 sync ပြန်လုပ်နေပါတယ်…");
          const ff2 = await ensureFFmpeg((m, c) => log("rc", m, c));
          await doRecapMux(ff2, rcLastRun.segments, rcLastRun.segPieces, rcLastRun.baseName);
        } catch (e2) {
          log("rc", "အမှား: " + (e2.message || e2), "err");
        } finally { rb.disabled = false; }
      };
      $("rcResults").appendChild(rb);
    }
  } finally {
    setProgressHandler(null);
    setBusy(["startRecap"], false);
    releaseWakeLock();
  }
});
