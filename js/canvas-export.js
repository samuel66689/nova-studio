// canvas-export.js — Canvas + MediaRecorder video export (no ffmpeg.wasm memory crash)
// Renders video with effects frame-by-frame, records in real-time.

/**
 * Export video with effects via canvas.
 * @param {Blob} videoBlob - input video
 * @param {Object} opts - {flip, watermarkText, subtitles: [{start,end,text}], width, height, onprog}
 * @returns {Promise<Blob>} - recorded video blob (webm or mp4)
 */
export async function canvasExport(videoBlob, opts = {}) {
  const {
    flip = false,
    watermarkText = "",
    subtitles = [],
    width = 720,
    height = 1280,
    onprog = null,
    audioBlob = null, // optional narration audio to mux
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

  // Calculate draw dimensions (cover fit)
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(width / vw, height / vh);
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
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
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
      drawStyledSubtitle(ctx, sub.text, width, height, { color: subColor, size: subSize, font: subFont, shadeColor, thickness: shadeThick });
    }
    if (logoImg && logoPos) drawLogo(ctx, logoImg, width, height, logoPos, logoShape);

    if (onprog) {
      try { onprog(t / dur); } catch (_) {}
    }

    if (!video.ended && !video.paused) {
      requestAnimationFrame(renderFrame);
    }
  };

  // Start
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
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: totalDur };
}

/** Draw blur boxes: copies region, blurs it. */
function drawBlurBoxes(ctx, video, dx, dy, dw, dh, width, height, flip, regions, t) {
  for (const r of regions) {
    if (t < (r.t0 || 0) || t > (r.t1 || 9999)) continue;
    const bx = r.x * width, by = r.y * height;
    const bw = r.w * width, bh = r.h * height;
    ctx.save();
    ctx.filter = `blur(${Math.max(2, Math.min(30, r.strength || 15))}px)`;
    // Clip to box and draw video portion blurred
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    if (flip) { ctx.translate(width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, dx, dy, dw, dh);
    ctx.restore();
  }
}

/**
 * Fix WebM duration metadata (MediaRecorder writes wrong duration).
 * Patches the Duration element in the Segment Info.
 */
export async function fixWebMDuration(blob, durationSec) {
  const buf = await blob.arrayBuffer();
  const arr = new Uint8Array(buf);
  const view = new DataView(buf);

  // EBML varint parser
  function readVint(pos) {
    const b = arr[pos];
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(b & mask)) { mask >>= 1; len++; }
    if (len > 8) return null;
    let val = b & (mask - 1);
    for (let i = 1; i < len; i++) val = (val << 8) | arr[pos + i];
    return { len, val };
  }

  // Find Segment (ID: 0x18538067)
  // Skip EBML header (ID: 0x1A45DFA3)
  let pos = 0;
  while (pos < arr.length - 4) {
    const id = readVint(pos);
    if (!id) break;
    if (id.val === 0x1A45DFA3) { // EBML header
      const sz = readVint(pos + id.len);
      pos += id.len + sz.len + sz.val;
    } else if (id.val === 0x18538067) { // Segment
      const sz = readVint(pos + id.len);
      const segStart = pos + id.len + sz.len;
      // Find Info (ID: 0x1549A966) within Segment
      let p2 = segStart;
      const segEnd = sz.val === 0xFFFFFFFFFFFFFF ? arr.length : segStart + sz.val;
      while (p2 < segEnd - 4) {
        const id2 = readVint(p2);
        if (!id2) break;
        if (id2.val === 0x1549A966) { // Info
          const sz2 = readVint(p2 + id2.len);
          const infoStart = p2 + id2.len + sz2.len;
          const infoEnd = infoStart + sz2.val;
          // Find Duration (ID: 0x4489) within Info
          let p3 = infoStart;
          while (p3 < infoEnd - 4) {
            const id3 = readVint(p3);
            if (!id3) break;
            if (id3.val === 0x4489) { // Duration
              const sz3 = readVint(p3 + id3.len);
              const durPos = p3 + id3.len + sz3.len;
              if (sz3.val === 8) {
                view.setFloat64(durPos, durationSec, false); // big-endian
                return new Blob([buf], { type: "video/webm" });
              } else if (sz3.val === 4) {
                view.setFloat32(durPos, durationSec, false);
                return new Blob([buf], { type: "video/webm" });
              }
              break;
            }
            const s3 = readVint(p3 + id3.len);
            if (!s3) break;
            p3 += id3.len + s3.len + s3.val;
          }
          break;
        }
        const s2 = readVint(p2 + id2.len);
        if (!s2) break;
        p2 += id2.len + s2.len + s2.val;
      }
      break;
    } else {
      const sz = readVint(pos + id.len);
      if (!sz) break;
      pos += id.len + sz.len + sz.val;
    }
  }
  // If not found, return original
  return blob;
}

/**
 * Video-first dubbing: video plays continuously, audio fits to original timing.
 * Output duration = video duration. Audio sped up (max 1.3x) if too long.
 */
export async function canvasDubSync(videoBlob, segments, opts = {}) {
  const { flip = false, watermarkText = "", width = 720, height = 1280, onprog = null, blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4,
    logoImg = null, logoPos = null, logoShape = "square" } = opts;

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
  const scale = Math.max(width / vw, height / vh);
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
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
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
      drawStyledSubtitle(ctx, sub.text, width, height, { color: subColor, size: subSize, font: subFont, shadeColor, thickness: shadeThick });
    }
    if (logoImg && logoPos) drawLogo(ctx, logoImg, width, height, logoPos, logoShape);
    if (onprog) { try { onprog(t / dur); } catch (_) {} }
  };

  rec.start(1000);
  await video.play();

  // Play video continuously, trigger audio at timestamps
  let segIdx = 0;
  await new Promise((res) => {
    const check = () => {
      const t = video.currentTime;
      drawFrame(t);
      // Trigger audio for segments starting now
      while (segIdx < segData.length && segData[segIdx].start <= t + 0.1) {
        const s = segData[segIdx];
        const segDur = Math.max(0.5, s.end - s.start);
        // Speed up audio if too long (max 1.3x)
        if (s.audioDur > segDur) {
          const rate = Math.min(1.3, s.audioDur / segDur);
          try { s.audioEl.playbackRate = rate; } catch (_) {}
        }
        try { s.audioEl.play(); } catch (_) {}
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
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: dur };
}

/** Draw styled subtitle with user options. */
function drawStyledSubtitle(ctx, text, width, height, opts) {
  const {
    color = "#ffffff", size = 28, font = "Aka07",
    shadeColor = "#000000", thickness = 4,
  } = opts;
  ctx.font = `bold ${size}px "${font}", sans-serif`;
  ctx.textAlign = "center";
  ctx.strokeStyle = shadeColor;
  ctx.lineWidth = parseInt(thickness) || 4;
  ctx.fillStyle = color;
  const lines = wrapText(ctx, text, width - 40);
  const lh = size * 1.2;
  const y0 = height - 100 - (lines.length - 1) * lh;
  lines.forEach((ln, i) => {
    const y = y0 + i * lh;
    ctx.strokeText(ln, width / 2, y);
    ctx.fillText(ln, width / 2, y);
  });
  ctx.textAlign = "left";
}

/** Draw logo at position with shape. */
function drawLogo(ctx, logoImg, width, height, pos, shape) {
  if (!logoImg) return;
  const size = pos.size * width;
  const x = pos.x * width, y = pos.y * height;
  ctx.save();
  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.drawImage(logoImg, x, y, size, size);
  ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
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
    shadeColor = "#000000", shadeThick = 4,
    logoImg = null, logoPos = null, logoShape = "square" } = opts;

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
  const scale = Math.max(width / vw, height / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = (width - dw) / 2, dy = (height - dh) / 2;

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
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const recDone = new Promise((res) => { rec.onstop = res; });

  const drawFrame = (subtitleText) => {
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
    try { drawBlurBoxes(ctx, video, dx, dy, dw, dh, width, height, flip, blurRegions, video.currentTime); } catch (_) {}
    if (subtitleText) {
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = 4;
      const lines = wrapText(ctx, subtitleText, width - 40);
      const y0 = height - 100 - (lines.length - 1) * 34;
      lines.forEach((ln, i) => {
        ctx.strokeText(ln, width / 2, y0 + i * 34);
        ctx.fillStyle = "#fff";
        ctx.fillText(ln, width / 2, y0 + i * 34);
      });
      ctx.textAlign = "left";
    }
  };

  rec.start(1000);
  let elapsed = 0;

  for (let i = 0; i < segData.length; i++) {
    const s = segData[i];
    const c = Math.max(0.5, s.end - s.start); // video clip duration
    const d = s.audioDur; // audio duration

    if (onprog) { try { onprog(elapsed / totalDur, i, segData.length); } catch (_) {} }

    // Seek video to segment start
    video.currentTime = s.start;
    await new Promise((res) => {
      const h = () => { video.removeEventListener("seeked", h); res(); };
      video.addEventListener("seeked", h);
      setTimeout(res, 3000);
    });

    // Play audio
    const audioDone = new Promise((res) => {
      s.audioEl.onended = res;
      setTimeout(res, (d + 2) * 1000);
    });
    try { await s.audioEl.play(); } catch (_) {}

    // Play video for min(c, d), then freeze if needed
    const playTime = Math.min(c, d);
    video.play();
    const t0 = performance.now();
    await new Promise((res) => {
      const check = () => {
        const el = (performance.now() - t0) / 1000;
        drawFrame(s.text);
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
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, width, height);
          ctx.save();
          if (flip) { ctx.translate(width, 0); ctx.scale(-1, 1); }
          const zdw = dw * zs, zdh = dh * zs;
          const zdx = (width - zdw) / 2, zdy = (height - zdh) / 2;
          ctx.drawImage(video, zdx, zdy, zdw, zdh);
          ctx.restore();
          if (watermarkText) {
            ctx.font = "22px sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.fillText(watermarkText, 12, height - 36);
          }
          if (s.text && subOn) {
            drawStyledSubtitle(ctx, s.text, width, height, { color: subColor, size: subSize, font: subFont, shadeColor, thickness: shadeThick });
          }
          if (logoImg && logoPos) drawLogo(ctx, logoImg, width, height, logoPos, logoShape);
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
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), ext, duration: totalDur };
}
