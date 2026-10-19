// app.js — Nova Studio UI wiring (3 tabs). All compute runs in this browser.
import { ensureFFmpeg, fetchFile, setProgressHandler, ffmpegMode } from "./js/ffmpeg.js?v=20261015f";
import { edgeTTS, previewWithWebSpeech } from "./js/tts.js?v=20261017t";
import { canvasExport, canvasRecapSync, canvasDubSync, getOutDims, BITRATE, patchMp4Duration } from "./js/canvas-export.js?v=20261017u";

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
  // Video pause warning (Chrome background tab)
  window.__novaOnVideoPause = () => {
    log("rc", "⚠️ Video ရပ် သွား တယ်! Chrome tab ပြန် ဝင် ပါ — မ ထွက် ပါ နဲ့", "err");
    alert("⚠️ Video ရပ် သွား တယ်!\nChrome tab ထဲ ပြန် ဝင် ပါ။\nSync ပြီးသည် အထိ မ ထွက် ပါ နဲ့။");
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
} from "./js/api.js?v=20261018f";

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
  const timer = setTimeout(() => ctrl.abort(), 120000);
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
      const fname = cutFile.name.replace(/\.[^.]+$/, "") + "_p" + (i + 1) + ".mp4";
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

/** Get recap duration target from percentage selector.
 * Returns { pct, targetMin, srcMin }.
 * pct: selected percentage (10-80, default 50)
 * srcMin: source video duration in minutes
 * targetMin: Math.max(1, round(srcMin * pct / 100))
 * Note: This is a TARGET for script generation, not a guaranteed export duration.
 * Actual duration depends on Gemini output length, TTS audio durations, and freeze/zoom.
 */
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

/** Update duration hint in UI */
function updateDurationHint() {
  try {
    const hint = $("rcDurationHint");
    if (!hint) return;
    const { pct, targetMin, srcMin } = getDurationTarget();
    hint.textContent = `≈ ${targetMin} မိနစ် (မူရင်း ${Math.round(srcMin)} မိနစ်၏ ${pct}%) — ခန့်မှန်းခြေသာ`;
  } catch (_) {}
}

// Update hint when percentage changes or video loads
document.addEventListener("DOMContentLoaded", () => {
  const pctSel = $("rcDurationPct");
  if (pctSel) pctSel.addEventListener("change", updateDurationHint);
  updateDurationHint();
});