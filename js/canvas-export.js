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
    video.onerror = () => rej(new Error("video ဖတ်မရပါ"));
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
    video.onerror = () => { clearTimeout(to); rej(new Error("video ဖတ်မရပါ")); };
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
  // PHASE 1 NOTE: segments use outputStart/outputEnd (narration timeline).
  // sourceStart/sourceEnd are NOT set by current recap modes.
  // The seek below (video.currentTime = s.start) uses OUTPUT time as source seek
  // — this is a known Phase 1 limitation, fixed in Phase 3. Do not silently change it here.
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
    video.onerror = () => { clearTimeout(to); rej(new Error("video ဖတ်မရပါ")); };
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
    // Issue 1 fix: Only wait for seek when actually seeking.
    const hasSrc = typeof s.sourceStart === "number" && isFinite(s.sourceStart) && s.sourceStart >= 0;
    if (hasSrc) {
      video.currentTime = s.sourceStart;
      // Wait for seeked with timeout, cleanup on all paths
      await new Promise((res) => {
        let done = false;
        const finish = () => { if (!done) { done = true; video.removeEventListener("seeked", h); clearTimeout(to); res(); } };
        const h = () => finish();
        const to = setTimeout(() => {
          try { console.warn(`[seek] seg ${i}: seek timeout after 3s`); } catch (_) {}
          finish();
        }, 3000);
        video.addEventListener("seeked", h);
        // If already at target (no seek needed), resolve immediately
        setTimeout(() => {
          if (Math.abs(video.currentTime - s.sourceStart) < 0.3) finish();
        }, 100);
      });
    } else {
      // No source timestamp: continue from current position, NO wait.
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
    await new Promise((res) => {
      const check = () => {
        const el = (performance.now() - t0) / 1000;
        // Issue 2: Enforce sourceEnd — do not drift into unrelated scenes.
        // If video reaches sourceEnd but audio continues, loop back to sourceStart.
        if (srcEnd !== null && srcStart !== null && video.currentTime >= srcEnd - 0.1) {
          try { video.currentTime = srcStart; } catch (_) {}
          try { console.log(`[src-bound] seg ${i}: looped to ${srcStart.toFixed(1)}s`); } catch (_) {}
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

    // Freeze remaining time (if audio longer than video clip)
    const freezeTime = d - playTime;
    if (freezeTime > 0.1) {
      // Keep last frame, draw with slight zoom
      const fz0 = performance.now();
      await new Promise((res) => {
        const check = () => {
          const el = (performance.now() - fz0) / 1000;
          const zp = Math.min(el / Math.max(freezeTime, 0.1), 1);
          const zs = 1 + 0.12 * zp;
          S.t = video.currentTime; S.text = pickChunk(s.text, playTime + el, d);
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
