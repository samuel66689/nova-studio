// canvas-export.js — Canvas + MediaRecorder video export (no ffmpeg.wasm memory crash)
// Renders video with effects frame-by-frame, records in real-time.

const RATIOS = { "9:16": [9,16], "16:9": [16,9], "1:1": [1,1], "4:5": [4,5], "3:4": [3,4] };
export const BITRATE = { 480: 2e6, 720: 4e6, 1080: 8e6 };
const even = (n) => Math.round(n / 2) * 2;
export function getOutDims(ratio, res, vw, vh) {
  const [a, b] = ratio === "original" ? [vw, vh] : (RATIOS[ratio] || RATIOS["9:16"]);
  const W = a <= b ? res : res * a / b, H = a <= b ? res * b / a : res;
  return { W: even(W), H: even(H), k: even(W) / 720 };
}

/**
 * Export video with effects via canvas.
 * @param {Blob} videoBlob - input video
 * @param {Object} opts - {flip, watermarkText, subtitles: [{start,end,text}], width, height, onprog}
 * @returns {Promise<Blob>} - recorded video blob (webm or mp4)
 */

/** Patch MP4 duration by modifying header only (2MB, no full re-encode) */
/** Draw blurred background (for contain/fit mode) */
function drawBlurBg(ctx, video, W, H, tmp) {
  tmp.width = 32; tmp.height = Math.max(2, Math.round(32 * H / W));
  const t = tmp.getContext("2d");
  const s = Math.max(tmp.width / video.videoWidth, tmp.height / video.videoHeight);
  const w = video.videoWidth * s, h = video.videoHeight * s;
  t.drawImage(video, (tmp.width - w) / 2, (tmp.height - h) / 2, w, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, 0, 0, W, H);
}

export async function patchMp4Duration(blob, sec) {
  try {
    const HEAD = Math.min(blob.size, 2 << 20);
    const buf = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
    const dv = new DataView(buf.buffer);
    const u32 = (o) => dv.getUint32(o);
    const tp = (o) => String.fromCharCode(buf[o], buf[o+1], buf[o+2], buf[o+3]);
    const put = (o, v, big) => {
      if (big) { dv.setUint32(o, Math.floor(v / 2**32)); dv.setUint32(o+4, v >>> 0); }
      else dv.setUint32(o, v >>> 0);
    };
    const walk = (s, e, cb) => {
      for (let o = s; o + 8 <= e;) {
        let sz = u32(o), h = 8;
        if (sz === 1) { sz = u32(o+8) * 2**32 + u32(o+12); h = 16; }
        if (sz < h) break;
        cb(tp(o+4), o+h, Math.min(o+sz, e));
        o += sz;
      }
    };
    let mts = 1000, n = 0;
    walk(0, HEAD, (t, p, e) => {
      if (t !== "moov") return;
      walk(p, e, (t2, p2, e2) => {
        if (t2 === "mvhd") {
          const v = buf[p2], o = p2 + 4 + (v ? 16 : 8);
          mts = u32(o); put(o+4, Math.round(sec*mts), v===1); n++;
        }
        if (t2 === "trak") walk(p2, e2, (t3, p3, e3) => {
          if (t3 === "tkhd") { const v = buf[p3]; put(p3 + 4 + (v ? 24 : 16), Math.round(sec*mts), v===1); n++; }
          if (t3 === "mdia") walk(p3, e3, (t4, p4) => {
            if (t4 === "mdhd") { const v = buf[p4], o = p4 + 4 + (v ? 16 : 8); put(o+4, Math.round(sec*u32(o)), v===1); n++; }
          });
        });
      });
    });
    return n ? new Blob([buf, blob.slice(HEAD)], { type: blob.type }) : blob;
  } catch (_) { return blob; }
}

export async function canvasExport(videoBlob, opts = {}) {
  const {
    flip = false,
    watermarkText = "",
    subtitles = [],
    width = 720,
    height = 1280,
    onprog = null,
    audioBlob = null, // optional narration audio to mux
    blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4, subPos = "onBlur",
    logoImg = null, logoPos = null, logoShape = "square",
  } = opts;

  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => {
      const ec = video.error ? video.error.code : "?";
      try { console.warn(`[canvas-export] video load failed: type=${videoBlob.type || "?"} size=${videoBlob.size || "?"} error.code=${ec}`); } catch (_) {}
      rej(new Error(`video ဖတ်မရပါ (type=${videoBlob.type || "?"}, code=${ec}) — browser ဒီ format ကို decode မရပါ`));
    };
  });

  const dur = video.duration || 0;
  if (!dur) throw new Error("video duration မရပါ");

  // Canvas setup
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  // Calculate draw dimensions (cover or contain)
  const vw = video.videoWidth, vh = video.videoHeight;
  const fit = (opts && opts.fit) || "cover";
  const scale = fit === "contain" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (width - dw) / 2, dy = (height - dh) / 2;

  // Audio: use provided narration, or original video audio
  let audioStream = null;
  let audioEl = null;
  if (audioBlob) {
    const aurl = URL.createObjectURL(audioBlob);
    audioEl = new Audio(aurl);
  }

  // Capture stream
  const stream = canvas.captureStream(30);
  
  // Add audio track
  if (audioEl) {
    const actx = new AudioContext();
  try { if (actx.state === "suspended") actx.resume().catch(() => {}); } catch (_) {}
    const src = actx.createMediaElementSource(audioEl);
    const dest = actx.createMediaStreamDestination();
    src.connect(dest);
    src.connect(actx.destination); // also play aloud (muted? no, we want to hear)
    const atrack = dest.stream.getAudioTracks()[0];
    if (atrack) stream.addTrack(atrack);
  } else {
    // Use video's original audio via captureStream from video element
    // (video.muted must be false for this, but we muted for autoplay)
    // Instead, we'll just record video-only and mux audio separately
    // For now: video-only, audio handled separately
  }

  // MediaRecorder setup - prefer mp4, fallback to webm
  const mimeTypes = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  let mimeType = "";
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }
  if (!mimeType) throw new Error("MediaRecorder မရပါ");

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate || 4_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });

  // Render loop
  let startTime = null;
  const renderFrame = (now) => {
    if (!startTime) startTime = now;
    const t = video.currentTime;

    // Draw video frame
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    if (flip) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();

    // Watermark
    if (watermarkText) {
      ctx.font = "22px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(watermarkText, 12, height - 36);
    }
    try { drawBlurBoxes(ctx, video, dx, dy, dw, dh, width, height, flip, blurRegions, video.currentTime); } catch (_) {}

    // Subtitles
    const sub = subtitles.find((s) => t >= s.start && t < s.end);
    if (sub && subOn) {
      drawStyledSubtitle(ctx, sub.text, width, height, { color: subColor, size: subSize, font: subFont, shadeColor, thickness: shadeThick, anchor: subtitleAnchor(width, height, blurRegions, flip, subPos) });
    }
    if (logoImg && logoPos) drawLogo(ctx, logoImg, width, height, logoPos, logoShape);

    if (onprog) {
      try { onprog(t / dur); } catch (_) {}
    }

    if (!video.ended && !video.paused) {
      requestAnimationFrame(renderFrame);
    }
  };

  // Start (measure actual recording time for duration patch)
  const _recT0 = performance.now();
  rec.start(1000);
  if (audioEl) {
    try { await audioEl.play(); } catch (_) {}
  }
  await video.play();
  requestAnimationFrame(renderFrame);

  // Wait for video to end
  await new Promise((res) => {
    video.onended = res;
    // Safety timeout
    setTimeout(res, (dur + 10) * 1000);
  });

  rec.stop();
  await done;

  URL.revokeObjectURL(url);
  if (audioEl) URL.revokeObjectURL(audioEl.src);

  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: dur, recSec: (performance.now() - _recT0) / 1000 };
}

/** Draw blur boxes: copies region, blurs it. */
function drawBlurBoxes(ctx, video, dx, dy, dw, dh, width, height, flip, regions, t) {
  const k = width / 720;
  for (const r of regions) {
    if (t < (r.t0 || 0) || t > (r.t1 || 9999)) continue;
    const fx = flip ? 1 - r.x - r.w : r.x;
    const bx = fx * width, by = r.y * height;
    const bw = r.w * width, bh = r.h * height;
    ctx.save();
    ctx.filter = `blur(${Math.max(2, Math.min(30, r.strength || 40))}px)`;
    // Clip to box and draw video portion blurred
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    if (flip) { ctx.translate(width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
  }
}

/** Subtitle position: on first blur box, or bottom */
function subtitleAnchor(W, H, blur, flip, mode) {
  const b = (blur || []).slice().sort((a, c) => c.y - a.y)[0];
  if (mode === "onBlur" && b) {
    const x = flip ? 1 - b.x - b.w : b.x;
    return { cx: (x + b.w / 2) * W, cy: (b.y + b.h / 2) * H,
             maxW: Math.max(b.w * W, W * 0.6) };
  }
  const k = W / 720;
  return { cx: W / 2, cy: H - 100*k, maxW: W - 40*k };
}

/** Unified scene renderer: video -> blur -> subtitle -> logo */
// Temp canvas for blur background
const _blurTmp = document.createElement("canvas");
function drawScene(ctx, W, H, S, zoom = 1) {
  const zw = S.dw * zoom, zh = S.dh * zoom;
  const rx = (W - zw) / 2, ry = (H - zh) / 2;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  // Fit mode: draw blurred background first
  if (S.fit === "contain") {
    drawBlurBg(ctx, S.video, W, H, _blurTmp);
  }
  ctx.save();
  if (S.flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(S.video, rx, ry, zw, zh);
  ctx.restore();
  try { drawBlurBoxes(ctx, S.video, rx, ry, zw, zh, W, H, S.flip, S.blur, S.t); } catch (_) {}
  if (S.sub.on && S.text)
    drawStyledSubtitle(ctx, S.text, W, H, { ...S.sub,
      anchor: subtitleAnchor(W, H, S.blur, S.flip, S.sub.pos) });
  if (S.logo.img && S.logo.pos)
    drawLogo(ctx, S.logo.img, W, H, S.logo.pos, S.logo.shape);
  if (S.wm) { const k = W / 720; ctx.font = `${22*k}px sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillText(S.wm, 12*k, H - 36*k); }
}

export async function canvasDubSync(videoBlob, segments, opts = {}) {
  const { flip = false, watermarkText = "", width = 720, height = 1280, onprog = null, blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4, subPos = "onBlur",
    logoImg = null, logoPos = null, logoShape = "square" } = opts;
  // Preload font for canvas
  try {
    await document.fonts.load(`bold ${subSize}px "${subFont}"`);
    await document.fonts.ready;
  } catch (_) {}

  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.src = url;
  try { video.load(); } catch (_) {}
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("video metadata timeout")), 15000);
    video.onloadedmetadata = () => { clearTimeout(to); res(); };
    video.onerror = () => {
      clearTimeout(to);
      const ec = video.error ? video.error.code : "?";
      try { console.warn(`[canvas-export] video load failed: code=${ec}`); } catch (_) {}
      rej(new Error(`video ဖတ်မရပါ (code=${ec}) — browser ဒီ format ကို decode မရပါ`));
    };
  });

  const dur = video.duration || 0;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const vw = video.videoWidth, vh = video.videoHeight;
  const _fit = (typeof opts !== "undefined" && opts.fit) || "cover";
  const scale = _fit === "contain" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (width - dw) / 2, dy = (height - dh) / 2;

  // Prepare audio with durations
  const segData = [];
  for (const s of segments) {
    const aurl = URL.createObjectURL(s.audioBlob);
    const a = new Audio(aurl);
    const d = await new Promise((res) => {
      a.onloadedmetadata = () => res(a.duration || 0);
      a.onerror = () => res(0);
    });
    segData.push({ ...s, audioEl: a, audioDur: d, audioUrl: aurl });
  }
  segData.sort((a, b) => a.start - b.start);

  // Audio mixing
  const stream = canvas.captureStream(30);
  const actx = new AudioContext();
  try { if (actx.state === "suspended") actx.resume().catch(() => {}); } catch (_) {}
  const dest = actx.createMediaStreamDestination();
  for (const s of segData) {
    const src = actx.createMediaElementSource(s.audioEl);
    src.connect(dest);
  }
  const atrack = dest.stream.getAudioTracks()[0];
  if (atrack) stream.addTrack(atrack);

  const mimeTypes = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  let mimeType = "";
  for (const mt of mimeTypes) { if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; } }
  if (!mimeType) throw new Error("MediaRecorder မရပါ");

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate || 4_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const recDone = new Promise((res) => { rec.onstop = res; });

  const drawFrame = (t) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    // Contain mode: blurred background like drawScene (else literal black bars)
    if (_fit === "contain") { try { drawBlurBg(ctx, video, width, height, _blurTmp); } catch (_) {} }
    ctx.save();
    if (flip) { ctx.translate(width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
    if (watermarkText) {
      ctx.font = "22px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(watermarkText, 12, height - 36);
    }
    try { drawBlurBoxes(ctx, video, dx, dy, dw, dh, width, height, flip, blurRegions, t); } catch (_) {}
    const sub = segData.find((s) => t >= s.start && t < s.end);
    if (sub && sub.text && subOn) {
      drawStyledSubtitle(ctx, sub.text, width, height, { color: subColor, size: subSize, font: subFont, shadeColor, thickness: shadeThick, anchor: subtitleAnchor(width, height, blurRegions, flip, subPos) });
    }
    if (logoImg && logoPos) drawLogo(ctx, logoImg, width, height, logoPos, logoShape);
    if (onprog) { try { onprog(t / dur); } catch (_) {} }
  };

  const _recT0 = performance.now();
  rec.start(1000);
  await video.play();

  // Play video continuously, trigger audio at timestamps
  let segIdx = 0;
  await new Promise((res) => {
    const check = () => {
      const t = video.currentTime;
      drawFrame(t);
      // Trigger audio for segments starting now
      // Audio Dub Studio method: borrow gap_after, never overlap next
      while (segIdx < segData.length && segData[segIdx].start <= t + 0.1) {
        const s = segData[segIdx];
        const segDur = Math.max(0.5, s.end - s.start);
        const nextStart = (segIdx + 1 < segData.length) ? segData[segIdx + 1].start : dur;
        const gapAfter = Math.max(0, nextStart - s.end);
        const maxPlay = segDur + gapAfter; // never exceed next segment start
        // Speed up audio if too long (max 1.3x)
        if (s.audioDur > segDur) {
          const rate = Math.min(1.3, s.audioDur / segDur);
          try { s.audioEl.playbackRate = rate; } catch (_) {}
        }
        const playedDur = s.audioDur / (s.audioEl.playbackRate || 1);
        try { s.audioEl.play(); } catch (_) {}
        // If still too long, stop before next segment (prevent overlap)
        if (playedDur > maxPlay + 0.05) {
          const stopMs = Math.max(100, (maxPlay - 0.05) * 1000);
          const el = s.audioEl;
          setTimeout(() => { try { el.pause(); } catch (_) {} }, stopMs);
        }
        segIdx++;
      }
      if (!video.ended && t < dur) {
        requestAnimationFrame(check);
      } else {
        res();
      }
    };
    check();
    // Safety timeout
    setTimeout(res, (dur + 10) * 1000);
  });

  video.pause();
  rec.stop();
  await recDone;
  URL.revokeObjectURL(url);
  for (const s of segData) URL.revokeObjectURL(s.audioUrl);
  try { video.remove(); } catch (_) {}
  try { await actx.close(); } catch (_) {}

  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: dur, recSec: (performance.now() - _recT0) / 1000 };
}

/** Draw styled subtitle with user options. */
function drawStyledSubtitle(ctx, text, W, H, o) {
  const { color="#ffffff", size=28, font="Aka07",
          shadeColor="#000000", thickness=4, anchor } = o;
  const k = W / 720;
  const a = anchor || { cx: W/2, cy: H-100*k, maxW: W-40*k };
  ctx.font = `bold ${size*k}px "${font}", "NotoSansMyanmar", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineJoin = "round"; ctx.miterLimit = 2;
  ctx.lineWidth = thickness * k;
  ctx.strokeStyle = shadeColor; ctx.fillStyle = color;
  const lines = wrapText(ctx, text, a.maxW), lh = size * k * 1.4;
  const y0 = a.cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => {
    ctx.strokeText(ln, a.cx, y0 + i * lh);
    ctx.fillText(ln, a.cx, y0 + i * lh);
  });
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

/** Draw logo at position with shape. */
function drawLogo(ctx, img, W, H, pos, shape) {
  if (!img) return;
  const s = pos.size * W, x = pos.x * W, y = pos.y * H;
  ctx.save();
  if (shape === "circle") {
    const m = Math.min(img.naturalWidth || s, img.naturalHeight || s);
    ctx.beginPath(); ctx.arc(x + s/2, y + s/2, s/2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, (img.naturalWidth - m)/2, (img.naturalHeight - m)/2, m, m, x, y, s, s);
  } else {
    const h = s * (img.naturalHeight || 1) / (img.naturalWidth || 1);
    ctx.drawImage(img, x, y, s, h);
  }
  ctx.restore();
}

function wrapText(ctx, text, maxW) {
  const words = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? [...new Intl.Segmenter("my", { granularity: "word" }).segment(String(text))].map((s) => s.segment)
    : String(text).split(/(?<=\s)/);
  const lines = []; let cur = "";
  for (const w of words) {
    if (cur && ctx.measureText(cur + w).width > maxW) { lines.push(cur.trim()); cur = w; }
    else cur += w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [String(text)];
}

/** Split long narration into chunks for timed display */
function chunkText(text, max = 45) {
  const parts = String(text).split(/(?<=[။၊!?])\s*/).filter(Boolean);
  const out = []; let cur = "";
  for (const part of parts) {
    if (cur && (cur + " " + part).length > max) { out.push(cur); cur = part; }
    else cur = cur ? cur + " " + part : part;
  }
  if (cur) out.push(cur);
  return out.length ? out : [String(text)];
}
function pickChunk(text, t, total) {
  const ch = chunkText(text);
  if (ch.length <= 1) return ch[0];
  const sum = ch.reduce((a, c) => a + c.length, 0);
  let acc = 0;
  for (const c of ch) { acc += c.length; if (t / Math.max(total, 0.1) <= acc / sum) return c; }
  return ch[ch.length - 1];
}

/**
 * Audio-first recap export: video adjusts to match narration audio per segment.
 * For each segment: play video clip; if shorter than audio, freeze last frame.
 * @param {Blob} videoBlob - source video
 * @param {Array} segments - [{start, end, audioBlob, text}]
 * @param {Object} opts - {flip, watermarkText, width, height, onprog}
 */
export async function canvasRecapSync(videoBlob, segments, opts = {}) {
  const { flip = false, watermarkText = "", width = 720, height = 1280, onprog = null, blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4, subPos = "onBlur",
    logoImg = null, logoPos = null, logoShape = "square" } = opts;
  // Timeline note (verified 2026-10-25): outputStart/outputEnd are rebuilt
  // below from ACTUAL audio durations, so each segment plays exactly its
  // narration length. sourceStart/sourceEnd ARE set by SRC scripts and are
  // used for seeking/loop bounds when present; without them the video
  // simply plays straight through (no per-segment seek, no freeze — the
  // freeze branch below only fires when the video itself ends early).
  // Timestamp validation happens in app-v3.js before calling this function.
  // Preload font for canvas
  try {
    await document.fonts.load(`bold ${subSize}px "${subFont}"`);
    await document.fonts.ready;
  } catch (_) {}

  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.src = url;
  try { video.load(); } catch (_) {}
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("video metadata timeout")), 15000);
    video.onloadedmetadata = () => { clearTimeout(to); res(); };
    video.onerror = () => {
      clearTimeout(to);
      const ec = video.error ? video.error.code : "?";
      try { console.warn(`[canvas-export] video load failed: code=${ec}`); } catch (_) {}
      rej(new Error(`video ဖတ်မရပါ (code=${ec}) — browser ဒီ format ကို decode မရပါ`));
    };
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const vw = video.videoWidth, vh = video.videoHeight;
  const _fit = (typeof opts !== "undefined" && opts.fit) || "cover";
  const scale = _fit === "contain" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (width - dw) / 2, dy = (height - dh) / 2;

  // Unified scene state
  const S = { video, dw, dh, fit: _fit || "cover", flip, blur: blurRegions, wm: watermarkText,
    t: 0, text: "",
    sub: { on: subOn, color: subColor, size: subSize, font: subFont,
           shadeColor, thickness: shadeThick, pos: subPos },
    logo: { img: logoImg, pos: logoPos, shape: logoShape } };

  // Prepare audio elements with durations
  const segData = [];
  for (const s of segments) {
    const aurl = URL.createObjectURL(s.audioBlob);
    const a = new Audio(aurl);
    const d = await new Promise((res) => {
      a.onloadedmetadata = () => res(a.duration || 0);
      a.onerror = () => res(0);
    });
    segData.push({ ...s, audioEl: a, audioDur: d, audioUrl: aurl });
  }

  const totalDur = segData.reduce((sum, s) => sum + s.audioDur, 0);

  // Phase 3: Build output timeline from ACTUAL audio durations.
  // outputStart/outputEnd = position in final video, calculated cumulatively.
  // This is separate from sourceStart/sourceEnd (original video positions).
  let _outT = 0;
  for (const s of segData) {
    s.outputStart = _outT;
    s.outputEnd = _outT + (s.audioDur || 0);
    _outT = s.outputEnd;
  }
  try {
    console.log(`[phase3] Output timeline: ${segData.length} segs, total ${_outT.toFixed(1)}s`);
  } catch (_) {}

  // Setup recording
  const stream = canvas.captureStream(30);
  // Mix all audio via Web Audio
  const actx = new AudioContext();
  try { if (actx.state === "suspended") actx.resume().catch(() => {}); } catch (_) {}
  const dest = actx.createMediaStreamDestination();
  const sources = [];
  for (const s of segData) {
    const src = actx.createMediaElementSource(s.audioEl);
    src.connect(dest);
    sources.push(src);
  }
  const atrack = dest.stream.getAudioTracks()[0];
  if (atrack) stream.addTrack(atrack);

  const mimeTypes = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  let mimeType = "";
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }
  if (!mimeType) throw new Error("MediaRecorder မရပါ");

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate || 4_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const recDone = new Promise((res) => { rec.onstop = res; });

  // drawFrame replaced by drawScene (unified)

  const _recT0 = performance.now();
  rec.start(1000);
  let elapsed = 0;

  // Diagnostic: log timeline summary
  try {
    const totalAudio = segData.reduce((a, s) => a + (s.audioDur || 0), 0);
    console.log(`[recap-sync] ${segData.length} segments, total audio ${totalAudio.toFixed(1)}s`);
  } catch (_) {}

  for (let i = 0; i < segData.length; i++) {
    const s = segData[i];
    const c = Math.max(0.5, (s.outputEnd ?? s.end) - (s.outputStart ?? s.start)); // narration target duration
    const d = s.audioDur; // actual audio duration
    try {
      console.log(`[recap-sync] seg ${i}: out=${(s.outputStart ?? s.start).toFixed(1)}-${(s.outputEnd ?? s.end).toFixed(1)}s, audio=${(d||0).toFixed(1)}s, src=${s.sourceStart !== undefined ? s.sourceStart.toFixed(1) + "-" + s.sourceEnd.toFixed(1) : "n/a"}, video@${video.currentTime.toFixed(1)}s`);
    } catch (_) {}

    if (onprog) { try { onprog(elapsed / totalDur, i, segData.length); } catch (_) {} }

    // PHASE 1 Gap-1 fix: Do NOT silently treat output timeline as source timeline.
    // Only seek when a genuine sourceStart exists. Otherwise continue from
    // current position — the output timestamp is narration timing, not a
    // source-video position. (Phase 3 will add proper scene matching.)
    // Seek: register listener BEFORE setting currentTime (avoid race).
    const hasSrc = typeof s.sourceStart === "number" && isFinite(s.sourceStart) && s.sourceStart >= 0;
    if (hasSrc) {
      const target = s.sourceStart;
      // Already at target? No seek needed — continue immediately.
      if (Math.abs(video.currentTime - target) < 0.3) {
        try { console.log(`[seek] seg ${i}: already at ${target.toFixed(1)}s`); } catch (_) {}
      } else {
        await new Promise((res) => {
          let done = false;
          let to = null;
          const cleanup = () => {
            video.removeEventListener("seeked", onSeeked);
            if (to) clearTimeout(to);
          };
          const finish = () => { if (!done) { done = true; cleanup(); res(); } };
          const onSeeked = () => finish();
          // 1. Register listener FIRST
          video.addEventListener("seeked", onSeeked);
          // 2. Register timeout
          to = setTimeout(() => {
            try { console.warn(`[seek] seg ${i}: timeout after 3s (target ${target.toFixed(1)}s)`); } catch (_) {}
            finish();
          }, 3000);
          // 3. THEN initiate seek
          try { video.currentTime = target; }
          catch (e) {
            try { console.warn(`[seek] seg ${i}: seek error: ${e.message}`); } catch (_) {}
            finish();
          }
        });
      }
    } else {
      // Legacy: no source timestamp — continue immediately, no wait.
      try {
        console.warn(`[seek] seg ${i}: no sourceStart — continuing from ${video.currentTime.toFixed(1)}s`);
      } catch (_) {}
    }

    // Play audio
    const audioDone = new Promise((res) => {
      s.audioEl.onended = res;
      setTimeout(res, (d + 2) * 1000);
    });
    try { await s.audioEl.play(); } catch (_) {}

    // Play video for min(c, d), then freeze if needed
    const playTime = Math.min(c, d);
    try { await video.play(); } catch (e) {
      console.warn("[recap] video.play() blocked:", e.message);
    }
    const t0 = performance.now();
    let pauseWarned = false;
    const srcEnd = (typeof s.sourceEnd === "number" && isFinite(s.sourceEnd)) ? s.sourceEnd : null;
    const srcStart = (typeof s.sourceStart === "number" && isFinite(s.sourceStart)) ? s.sourceStart : null;
    let loopCount = 0;
    await new Promise((res) => {
      const check = () => {
        const el = (performance.now() - t0) / 1000;
        // Enforce sourceEnd — do not drift into unrelated scenes.
        // If video reaches sourceEnd but audio continues, loop back to sourceStart.
        // Safety: max 20 loops to avoid infinite loop on bad timestamps.
        if (srcEnd !== null && srcStart !== null && loopCount < 20 &&
            video.currentTime >= srcEnd - 0.1 && !video.paused) {
          loopCount++;
          try { video.currentTime = srcStart; } catch (_) {}
          try { console.log(`[src-bound] seg ${i}: loop ${loopCount} to ${srcStart.toFixed(1)}s`); } catch (_) {}
        }
        // Detect unexpected pause (Chrome background tab)
        if (video.paused && !video.ended && el < playTime) {
          if (!pauseWarned) {
            pauseWarned = true;
            console.warn("[recap] ⚠️ Video paused unexpectedly! (tab switched?)");
            try {
              if (typeof window !== "undefined" && window.__novaOnVideoPause)
                window.__novaOnVideoPause();
            } catch (_) {}
          }
          // Try to resume
          video.play().catch(() => {});
        }
        S.t = video.currentTime; S.text = pickChunk(s.text, el, d);
        drawScene(ctx, width, height, S);
        if (el < playTime && !video.ended) {
          requestAnimationFrame(check);
        } else {
          res();
        }
      };
      check();
    });
    video.pause();

    // Freeze remaining time (if audio longer than video clip).
    // Use the ACTUAL elapsed play time, not the planned playTime: if the
    // play loop exited early (video.ended) or late (slow decode), using
    // playTime would make this segment longer/shorter than the audio (d),
    // drifting every following segment out of sync. Actual elapsed keeps
    // play + freeze == d exactly.
    const playElapsed = (performance.now() - t0) / 1000;
    const freezeTime = d - playElapsed;
    if (freezeTime > 0.1) {
      // Keep last frame, draw with slight zoom
      const fz0 = performance.now();
      await new Promise((res) => {
        const check = () => {
          const el = (performance.now() - fz0) / 1000;
          const zp = Math.min(el / Math.max(freezeTime, 0.1), 1);
          const zs = 1 + 0.12 * zp;
          S.t = video.currentTime; S.text = pickChunk(s.text, playElapsed + el, d);
          drawScene(ctx, width, height, S, zs);
          if (el < freezeTime) {
            requestAnimationFrame(check);
          } else {
            res();
          }
        };
        check();
      });
    }

    await audioDone;
    elapsed += d;
    URL.revokeObjectURL(s.audioUrl);
  }

  rec.stop();
  await recDone;
  URL.revokeObjectURL(url);
  try { video.pause(); video.removeAttribute("src"); video.load(); video.remove(); } catch (_) {}
  try { await actx.close(); } catch (_) {}

  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: totalDur, recSec: (performance.now() - _recT0) / 1000 };
}

// =====================================================================
// METHOD B — Audio Master Timeline (EXPERIMENTAL)
// ---------------------------------------------------------------------
// Method A (canvasRecapSync above) is a sequential chain: each segment
// starts only after the previous segment's seek + play + freeze finish,
// so seek waits and loop overshoots accumulate into the recording and
// the file drifts away from the output/SRT timeline.
//
// Method B instead anchors EVERYTHING to one master clock that starts
// when the recorder starts:
//   - The output timeline is built once from ACTUAL measured audio
//     durations (buildMasterTimeline) — the same values the SRT uses.
//   - Each segment's audio starts when master time reaches its
//     outputStart (scheduled, not chained). Errors do not accumulate.
//   - The first seek is paid BEFORE recording starts.
//   - Later seeks are issued at segment boundaries without blocking the
//     scheduler; a drift check re-locks the picture to the master clock.
//   - Freeze tails, subtitles, blur and logo reuse drawScene/pickChunk,
//     exactly like Method A.
// Method A is untouched and remains the default.
// =====================================================================

/** Build the output timeline from measured audio durations (exact floats,
 * no per-segment rounding, so boundaries cannot drift apart). */
export function buildMasterTimeline(segData) {
  let t = 0;
  const items = [];
  for (const s of segData) {
    const d = (typeof s.audioDur === "number" && isFinite(s.audioDur) && s.audioDur > 0) ? s.audioDur : 0;
    s.outputStart = t;
    s.outputEnd = t + d;
    t = s.outputEnd;
    items.push(s);
  }
  return { items, total: t };
}

/** Which segment owns master time t? Boundaries belong to the NEXT segment.
 * Zero-duration segments own no time and are skipped. -1 when t is outside. */
export function masterSegmentAt(items, t) {
  if (typeof t !== "number" || !isFinite(t) || t < 0) return -1;
  for (let i = 0; i < items.length; i++) {
    if (t >= items[i].outputStart && t < items[i].outputEnd) return i;
  }
  return -1;
}

/** Validate/clamp a segment's source window against the real video duration.
 * Returns {start, end} or null when there is no usable source window
 * (missing/NaN timestamps, empty or out-of-range window). */
export function clampSourceWindow(seg, videoDur) {
  if (!seg || typeof seg.sourceStart !== "number" || !isFinite(seg.sourceStart)) return null;
  const vd = (typeof videoDur === "number" && isFinite(videoDur) && videoDur > 0) ? videoDur : 0;
  let start = Math.max(0, seg.sourceStart);
  if (vd > 0) {
    if (start >= vd) return null; // scene starts at/after the end of the footage
    start = Math.min(start, Math.max(vd - 0.05, 0));
  }
  let end = (typeof seg.sourceEnd === "number" && isFinite(seg.sourceEnd)) ? seg.sourceEnd : vd;
  if (vd > 0) end = Math.min(end, vd);
  if (!(end > start)) return null;
  return { start, end };
}

// ---- Method B safety guards: fail safe, never silently corrupt ----
// Detection does NOT rely on timers running in a background tab (they may
// not): the visibility event rejects the export the moment the tab hides,
// and a per-tick wall-clock gap check catches stalls that fire no event.
export const SYNC_B_STALL_LIMIT_MS = 1500;
export const SYNC_B_LATE_AUDIO_SEC = 0.35;
export const SYNC_B_MAX_RESYNC = 4;

/** True when the scheduler was stalled (hidden tab / app switch / freeze).
 * Normal rAF gaps are ~16-100ms even on a busy phone; beyond the limit,
 * boundaries were missed and the recording cannot be trusted. */
export function stallDetected(lastTickAt, nowMs, limitMs = SYNC_B_STALL_LIMIT_MS) {
  if (!lastTickAt || typeof nowMs !== "number" || !isFinite(nowMs)) return false;
  return (nowMs - lastTickAt) > limitMs;
}

/** Where a segment's audio starts when its boundary is processed late.
 * <= threshold is rAF jitter -> start at 0. Real lateness starts at the
 * matching timeline position so narration/subtitles stay aligned with
 * the window; the tail is cut at the next boundary, never spilled over. */
export function audioStartOffset(local) {
  if (typeof local !== "number" || !isFinite(local) || local <= SYNC_B_LATE_AUDIO_SEC) return 0;
  return local;
}

/** Per-segment forced-resync budget. The 0.35s drift threshold is kept:
 * lower would seek constantly (a phone seek costs ~100-300ms and can
 * create the drift it tries to fix); higher would leave the picture
 * visibly off the narration position. The budget catches seek storms —
 * more resyncs than this in one segment means the decoder cannot keep
 * up, and Method B aborts with a clear error instead of degrading. */
export function resyncAllowed(alreadyUsed, max = SYNC_B_MAX_RESYNC) {
  return (alreadyUsed || 0) < max;
}

export const SYNC_B_SETTLE_MS = 300;
export const SYNC_B_AIM_CAP_SEC = 1.0;
export const SYNC_B_SEEK_WATCHDOG_MS = 3000;

/** Signed sync error: expected - currentTime.
 * > 0: video BEHIND (older scene than the narration position).
 * < 0: video AHEAD (later scene). Verdicts use Math.abs — a video that
 * is ahead is NOT treated as synchronized. */
export function syncLag(expected, currentTime) {
  if (typeof expected !== "number" || typeof currentTime !== "number" || !isFinite(expected) || !isFinite(currentTime)) return 0;
  return expected - currentTime;
}

/** Aim-ahead seek target: the source position the video should occupy
 * when the seek COMPLETES. expected advances at 1.0x during the seek,
 * so targeting expected + (estimated seek latency) lands on the
 * expected position at completion instead of behind it by the latency.
 * The aim is capped at 1.0s and clamped to the window end. */
export function aimAheadTarget(expected, latencySec, winEnd) {
  const lat = (typeof latencySec === "number" && isFinite(latencySec)) ? latencySec : 0;
  const aim = Math.min(Math.max(lat, 0), SYNC_B_AIM_CAP_SEC);
  let t = expected + aim;
  if (typeof winEnd === "number" && isFinite(winEnd)) t = Math.min(t, winEnd);
  return t;
}

/** Correction verdict for a SETTLED tick.
 * "correct": settled |lag| beyond 0.35s with budget left.
 * "abort": settled |lag| beyond 0.35s with the budget exhausted — the
 * export fails rather than shipping visibly wrong scene timing.
 * "none": unsettled, or |lag| within tolerance. */
export function correctionVerdict(absLag, settled, correctionsUsed, max = SYNC_B_MAX_RESYNC) {
  if (!settled || !(absLag > 0.35)) return "none";
  return (correctionsUsed || 0) < max ? "correct" : "abort";
}

/** Seeking watchdog: true when the element has been continuously
 * seeking longer than the limit (decoder hang). Caller owns the timer:
 * it starts on the first tick that observes seeking, resets on any
 * tick that observes not-seeking; new seek requests do NOT reset it. */
export function seekingWatchdogTripped(seekingSince, nowMs, limitMs = SYNC_B_SEEK_WATCHDOG_MS) {
  if (seekingSince == null || typeof nowMs !== "number" || !isFinite(nowMs)) return false;
  return (nowMs - seekingSince) > limitMs;
}

function seekWithTimeoutB(video, target, ms) {
  return new Promise((res) => {
    let done = false;
    let to = null;
    const cleanup = () => { video.removeEventListener("seeked", onSeeked); if (to) clearTimeout(to); };
    const finish = () => { if (!done) { done = true; cleanup(); res(); } };
    const onSeeked = () => finish();
    video.addEventListener("seeked", onSeeked);
    to = setTimeout(finish, ms);
    try { video.currentTime = target; } catch (_) { finish(); }
  });
}

export async function canvasRecapSyncB(videoBlob, segments, opts = {}) {
  const { flip = false, watermarkText = "", width = 720, height = 1280, onprog = null, blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4, subPos = "onBlur",
    logoImg = null, logoPos = null, logoShape = "square" } = opts;
  try {
    await document.fonts.load(`bold ${subSize}px "${subFont}"`);
    await document.fonts.ready;
  } catch (_) {}

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);

  // Load the source video — ONE automatic retry with a fresh object URL.
  // A transient load failure (e.g. memory pressure right after TTS) must
  // not kill the whole run the way it could in the sequential pipeline.
  let url = URL.createObjectURL(videoBlob);
  const loadOnce = () => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("video metadata timeout")), 15000);
    video.onloadedmetadata = () => { clearTimeout(to); res(); };
    video.onerror = () => {
      clearTimeout(to);
      const ec = video.error ? video.error.code : "?";
      rej(new Error(`video ဖတ်မရပါ (code=${ec}) — browser ဒီ format ကို decode မရပါ`));
    };
    video.src = url;
    try { video.load(); } catch (_) {}
  });
  try {
    await loadOnce();
  } catch (e1) {
    try { console.warn("[sync-b] video load failed once, retrying:", e1.message); } catch (_) {}
    await new Promise((r) => setTimeout(r, 600));
    URL.revokeObjectURL(url);
    url = URL.createObjectURL(videoBlob);
    await loadOnce(); // second failure -> throw to caller (no silent fallback)
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const vw = video.videoWidth, vh = video.videoHeight;
  const _fit = (typeof opts !== "undefined" && opts.fit) || "cover";
  const scale = _fit === "contain" ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const dw = vw * scale, dh = vh * scale;

  const S = { video, dw, dh, fit: _fit || "cover", flip, blur: blurRegions, wm: watermarkText,
    t: 0, text: "",
    sub: { on: subOn, color: subColor, size: subSize, font: subFont,
           shadeColor, thickness: shadeThick, pos: subPos },
    logo: { img: logoImg, pos: logoPos, shape: logoShape } };

  // Prepare audio elements with measured durations (same as Method A)
  const segData = [];
  for (const s of segments) {
    const aurl = URL.createObjectURL(s.audioBlob);
    const a = new Audio(aurl);
    const d = await new Promise((res) => {
      a.onloadedmetadata = () => res(a.duration || 0);
      a.onerror = () => res(0);
    });
    segData.push({ ...s, audioEl: a, audioDur: d, audioUrl: aurl });
  }

  // Authoritative timeline from ACTUAL audio durations
  const tl = buildMasterTimeline(segData);
  const total = tl.total;
  if (!(total > 0)) {
    for (const s of segData) URL.revokeObjectURL(s.audioUrl);
    try { video.remove(); } catch (_) {}
    URL.revokeObjectURL(url);
    throw new Error("Method B: audio timeline is empty (အသံ duration မရပါ)");
  }
  try { console.log(`[sync-b] ${segData.length} segments, master timeline ${total.toFixed(1)}s`); } catch (_) {}

  // Pay the FIRST seek before the recorder starts, so its cost is not recorded
  const firstWin = clampSourceWindow(segData[0], video.duration || 0);
  let latencyEst = 0;
  if (firstWin && Math.abs(video.currentTime - firstWin.start) >= 0.3) {
    const _ps = performance.now();
    await seekWithTimeoutB(video, firstWin.start, 3000);
    latencyEst = Math.min(Math.max((performance.now() - _ps) / 1000, 0), 1.5);
  }

  // Recording setup (same shape as Method A)
  const stream = canvas.captureStream(30);
  const actx = new AudioContext();
  try { if (actx.state === "suspended") actx.resume().catch(() => {}); } catch (_) {}
  const dest = actx.createMediaStreamDestination();
  for (const s of segData) {
    const src = actx.createMediaElementSource(s.audioEl);
    src.connect(dest);
  }
  const atrack = dest.stream.getAudioTracks()[0];
  if (atrack) stream.addTrack(atrack);

  const mimeTypes = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  let mimeType = "";
  for (const mt of mimeTypes) { if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; } }
  if (!mimeType) throw new Error("MediaRecorder မရပါ");

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: opts.bitrate || 4_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const recDone = new Promise((res) => { rec.onstop = res; });
  let recErr = null;
  rec.onerror = (e) => { recErr = (e && e.error) || new Error("recorder error"); };

  const _recT0 = performance.now();
  rec.start(1000);
  const T0 = performance.now();

  let cur = -1;
  let frozen = false;
  let lastTickAt = 0;
  // Aim-ahead seek bookkeeping: completion is detected by the seeking
  // true->false transition sampled in the tick, or inferred when the
  // target is already showing without a transition (no-op/instant seek).
  let prevSeeking = false;
  let pendingSeek = false;
  let sawSeeking = false;
  let seekIssuedAt = 0;
  let seekTargetPos = 0;
  let lastSeekDoneAt = T0;
  let seekingSince = null;
  let baseLag = null;
  let lastSampleAt = 0;
  const issueSeek = (pos) => {
    pendingSeek = true; sawSeeking = false;
    seekIssuedAt = performance.now(); seekTargetPos = pos;
    try { video.currentTime = pos; } catch (_) {}
  };

  // Fail-safe suspension handling (see guards above): hidden tab rejects
  // immediately via the visibility event; a stall without an event is
  // caught by the per-tick gap check. Either way the export FAILS with a
  // clear error — Method B never returns a silently corrupted recording.
  let rejectScheduler = null;
  const stallError = () => new Error("Sync Method B: browser ရပ်သွားလို့ export ရပ်လိုက်ပါတယ် (tab ဖျောက် / app ပြောင်း / screen ပိတ်) — အသံ ကျော်သွားနိုင်လို့ file မထုတ်ပေးပါဘူး။ Tab ကို ဖွင့်ထားပြီး ပြန်စမ်းပါ၊ ဒါမှမဟုတ် Method A သုံးပါ");
  const onVisChange = () => {
    if (document.hidden && rejectScheduler) rejectScheduler(stallError());
  };
  document.addEventListener("visibilitychange", onVisChange);

  try {
  await new Promise((resolve, reject) => {
    rejectScheduler = reject;
    const tick = () => {
      if (recErr) { reject(recErr); return; }
      const nowMs = performance.now();
      if (stallDetected(lastTickAt, nowMs)) { reject(stallError()); return; }
      lastTickAt = nowMs;
      // Seeking watchdog: continuous seeking beyond the limit is a
      // decoder hang — abort instead of waiting forever.
      if (video.seeking) { if (seekingSince == null) seekingSince = nowMs; }
      else seekingSince = null;
      if (seekingWatchdogTripped(seekingSince, nowMs)) {
        reject(new Error("Sync Method B: video seek က ရပ်တန့်နေလို့ (decoder hang) ရပ်လိုက်ပါတယ် — Method A နဲ့ ပြန်စမ်းပါ"));
        return;
      }
      // Seek completion bookkeeping (updates the latency estimate).
      if (pendingSeek) {
        if (video.seeking) sawSeeking = true;
        const doneByTransition = prevSeeking && !video.seeking;
        const doneByArrival = !video.seeking && Math.abs(video.currentTime - seekTargetPos) <= 0.05;
        if (doneByTransition || doneByArrival) {
          const measured = (nowMs - seekIssuedAt) / 1000;
          if (sawSeeking && measured > 0 && measured < 10) {
            latencyEst = Math.min(Math.max(measured, 0), 1.5);
          }
          pendingSeek = false;
          lastSeekDoneAt = nowMs;
          baseLag = null;
          try { console.log(`[sync-b-land] latency=${Math.round(measured * 1000)}ms est=${latencyEst.toFixed(2)}s`); } catch (_) {}
        }
      }
      prevSeeking = video.seeking;
      const master = (nowMs - T0) / 1000;
      if (master >= total) {
        // Grace: let the final segment's audio finish (max +2s), like Method A
        const last = segData[segData.length - 1];
        const lastPlaying = last && last.audioEl && !last.audioEl.ended && !last.audioEl.paused;
        if (lastPlaying && master < total + 2) { requestAnimationFrame(tick); return; }
        resolve(); return;
      }
      const idx = masterSegmentAt(tl.items, master);
      if (idx < 0) { resolve(); return; }
      const s = segData[idx];
      const local = master - s.outputStart;
      const segDur = s.outputEnd - s.outputStart;

      if (idx !== cur) {
        // Segment boundary — reached by the MASTER CLOCK, not by the
        // previous segment finishing. Stop any overrun audio (no overlap).
        if (cur >= 0) {
          const prev = segData[cur];
          if (prev && prev.audioEl && !prev.audioEl.ended && !prev.audioEl.paused) {
            try { prev.audioEl.pause(); } catch (_) {}
          }
        }
        cur = idx; frozen = false;
        s._corr = 0;
        baseLag = null;
        s._win = clampSourceWindow(s, video.duration || 0);
        // Late boundary: start the audio at the matching timeline
        // position instead of restarting it from zero.
        try { s.audioEl.currentTime = audioStartOffset(local); } catch (_) {}
        s.audioEl.play().catch(() => {});
        if (s._win) {
          if (Math.abs(video.currentTime - s._win.start) >= 0.3) issueSeek(s._win.start);
          video.play().catch(() => {});
        } else if (video.paused && !video.ended) {
          video.play().catch(() => {});
        }
        if (onprog) { try { onprog(master / total, idx, segData.length); } catch (_) {} }
      }

      const win = s._win;
      if (win) {
        const clipLen = win.end - win.start;
        if (local <= clipLen) {
          if (frozen) { frozen = false; video.play().catch(() => {}); }
          // Aim-ahead drift correction. Verdicts are made only on
          // SETTLED ticks (seek completed + 300ms), always against the
          // expected position at THIS tick — never at request time.
          // |lag| is used: an ahead video is not synchronized either.
          if (!video.seeking && !video.paused) {
            const expected = win.start + local;
            const lag = syncLag(expected, video.currentTime);
            const settled = !pendingSeek && (nowMs - lastSeekDoneAt) >= SYNC_B_SETTLE_MS;
            if (settled) {
              if (baseLag == null) {
                baseLag = lag;
                try { console.log(`[sync-b-land] idx=${idx} landingLag=${lag.toFixed(2)}s`); } catch (_) {}
              }
              const growth = lag - baseLag;
              if (Math.abs(lag) > 0.2 && nowMs - lastSampleAt >= 500) {
                lastSampleAt = nowMs;
                try { console.log(`[sync-b-sample] idx=${idx} master=${master.toFixed(2)} lag=${lag.toFixed(2)} growth=${growth.toFixed(2)}`); } catch (_) {}
              }
              const verdict = correctionVerdict(Math.abs(lag), settled, s._corr);
              if (verdict === "abort") {
                reject(new Error(growth > 0.15
                  ? "Sync Method B: video decode က အချိန်ကို မလိုက်နိုင်လို့ ရပ်လိုက်ပါတယ် (seek အကြိမ်များလွန်း) — Method A နဲ့ ပြန်စမ်းပါ"
                  : "Sync Method B: seek latency မြင့်/မတည်ငြိမ်လွန်းလို့ scene timing မမှန်နိုင်ပါ — Method A နဲ့ ပြန်စမ်းပါ"));
                return;
              }
              // Boundary guard: correct only when the seek can land
              // AND settle inside this segment; otherwise the next
              // boundary re-anchors anyway.
              if (verdict === "correct" && (segDur - local) > latencyEst + SYNC_B_SETTLE_MS / 1000) {
                s._corr = (s._corr || 0) + 1;
                const target = aimAheadTarget(expected, latencyEst, win.end);
                try { console.log(`[sync-b-resync] idx=${idx} lag=${lag.toFixed(2)} growth=${growth.toFixed(2)} count=${s._corr} target=${target.toFixed(2)}`); } catch (_) {}
                issueSeek(target);
              }
            }
          }
          S.t = video.currentTime; S.text = pickChunk(s.text, local, segDur);
          drawScene(ctx, width, height, S);
        } else {
          // Freeze tail: hold last frame with the same slow zoom as Method A
          if (!frozen) { frozen = true; try { video.pause(); } catch (_) {} }
          const zp = Math.min((local - clipLen) / Math.max(segDur - clipLen, 0.1), 1);
          S.t = video.currentTime; S.text = pickChunk(s.text, local, segDur);
          drawScene(ctx, width, height, S, 1 + 0.12 * zp);
        }
      } else {
        // No source window (frames/text modes): continuous playback
        if (video.paused && !video.ended) video.play().catch(() => {});
        S.t = video.currentTime; S.text = pickChunk(s.text, local, segDur);
        drawScene(ctx, width, height, S);
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  } catch (e) {
    // Abort path: discard the partial recording, clean up, report failure.
    try { video.pause(); } catch (_) {}
    for (const s of segData) { if (s.audioEl && !s.audioEl.paused) { try { s.audioEl.pause(); } catch (_) {} } }
    try { rec.stop(); } catch (_) {}
    URL.revokeObjectURL(url);
    for (const s of segData) URL.revokeObjectURL(s.audioUrl);
    try { video.remove(); } catch (_) {}
    try { await actx.close(); } catch (_) {}
    document.removeEventListener("visibilitychange", onVisChange);
    throw e;
  }
  document.removeEventListener("visibilitychange", onVisChange);

  try { video.pause(); } catch (_) {}
  for (const s of segData) { if (s.audioEl && !s.audioEl.paused) { try { s.audioEl.pause(); } catch (_) {} } }
  rec.stop();
  await recDone;
  URL.revokeObjectURL(url);
  for (const s of segData) URL.revokeObjectURL(s.audioUrl);
  try { video.remove(); } catch (_) {}
  try { await actx.close(); } catch (_) {}

  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: total, recSec: (performance.now() - _recT0) / 1000 };
}
