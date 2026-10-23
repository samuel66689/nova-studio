// dub-recap-render.js — Dubbing "Recap render" engine (ffmpeg.wasm, offline).
//
// Port of Audio Dub Studio's render_recap_video + speedup_video:
// the narration is NEVER fitted into the source slot and NEVER cut —
// instead each piece of the source video is re-timed (setpts) to match
// its narration length (+ the natural gap after it), the pieces are
// concatenated back to constant frame rate, styled subtitles / blur /
// logo / watermark are burned in, and the finished video is sped up by
// a fixed SPEEDUP (1.3x) baked into the SAME ffmpeg pass
// (video setpts=PTS/1.3 + audio atempo=1.3, so sync is preserved).
//
// Returns the NEW subtitle timeline (post-retime, post-speedup) so the
// SRT download matches the exported video — the source timeline would
// be wrong for this render mode.

import { ensureFFmpeg, fetchFile, setProgressHandler } from "./ffmpeg.js?v=20261021a";
import { mediaDuration } from "./api.js?v=20261021a";

export const DUB_RECAP_SPEEDUP = 1.3;

const _clampF = (f) => Math.min(Math.max(f, 0.05), 20.0);

/** Boundary of segment i: next segment's start (or video end), never
 *  before the segment's own end. Mirrors Audio Dub Studio exactly. */
export function dubRecapBoundary(segs, i, totalDuration) {
  const b = i + 1 < segs.length ? segs[i + 1].start : totalDuration;
  return Math.max(b, segs[i].end);
}

/**
 * Pure recap-retime math (no browser/ffmpeg deps — unit-testable).
 * segs: [{start, end, audioDur, text}] sorted by start.
 * Returns {
 *   pieces: [{a, b, target, factor, segIndex}],   // segIndex -1 = leading silence piece
 *   timelinePre: [{start, end, text}],            // pre-speedup output timeline
 *   totalPre, report: [{i, factor, note}]
 * }
 */
export function buildDubRecapPieces(segs, totalDuration) {
  const pieces = [], timelinePre = [], report = [];
  if (!segs.length) return { pieces, timelinePre, totalPre: 0, report };
  if (segs[0].start > 0.05) {
    pieces.push({ a: 0, b: segs[0].start, target: segs[0].start, factor: 1, segIndex: -1 });
  }
  let cum = segs[0].start > 0.05 ? segs[0].start : 0;
  segs.forEach((sg, i) => {
    const b = dubRecapBoundary(segs, i, totalDuration);
    const pDur = b - sg.start;
    const gap = Math.max(0, b - sg.end);
    const target = sg.audioDur + gap;
    const factor = pDur > 0.05 ? _clampF(target / pDur) : 1;
    pieces.push({ a: sg.start, b, target, factor, segIndex: i });
    let note = "";
    if (factor >= 2) note = "video အရမ်းနှေး (slow-mo ×" + factor.toFixed(1) + ")";
    else if (factor <= 0.5) note = "video အရမ်းမြန် (×" + (1 / factor).toFixed(1) + ")";
    report.push({ i, factor, note });
    timelinePre.push({ start: cum, end: cum + sg.audioDur, text: sg.text });
    cum += target;
  });
  return { pieces, timelinePre, totalPre: cum, report };
}

/** Map a SOURCE-timeline time to the pre-speedup OUTPUT time (piecewise
 *  linear through the retimed pieces). Used for blur-box time windows. */
export function dubRecapTimeMapper(pieces) {
  const spans = [];
  let cum = 0;
  for (const p of pieces) { spans.push({ a: p.a, b: p.b, out: cum, target: p.target }); cum += p.target; }
  return (t) => {
    for (const s of spans) {
      if (t <= s.b) {
        const span = s.b - s.a;
        const f = span > 0.001 ? (t - s.a) / span : 0;
        return s.out + Math.min(Math.max(f, 0), 1) * s.target;
      }
    }
    return cum;
  };
}

/** "#rrggbb" -> "0xrrggbb" for drawtext colors. */
export function hexToFfmpegColor(c, fallback = "0xffffff") {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || "").trim());
  return m ? "0x" + m[1].toLowerCase() : fallback;
}

/** Video part of the filter graph: retime pieces -> concat -> CFR ->
 *  scale/crop|pad to output size -> optional hflip. Ends at [vbase]. */
export function buildDubRecapVideoGraph(pieces, fps, width, height, fit, flip) {
  const parts = [], labels = [];
  pieces.forEach((p, j) => {
    parts.push(
      `[0:v]trim=start=${p.a.toFixed(3)}:end=${p.b.toFixed(3)},` +
      `settb=AVTB,setpts=(PTS-STARTPTS)*${p.factor.toFixed(4)}[v${j}]`);
    labels.push(`[v${j}]`);
  });
  let g = parts.join(";") + ";" + labels.join("") +
    `concat=n=${pieces.length}:v=1:a=0,fps=${fps.toFixed(2)}`;
  if (fit === "contain") {
    g += `,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
         `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  } else {
    g += `,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  if (flip) g += ",hflip";
  return g + "[vbase]";
}

// ------------------------------------------------------------ helpers

const FONT_FILES = {
  Aka07: "Aka07-Bold.ttf",
  Aka011: "Aka011-Regular.ttf",
  AJKunheing: "AJKunheingETM06-Regular.ttf",
  MyanmarFont: "MyanmarFont-Regular.ttf",
  MyanmarFont2: "MyanmarFont2.ttf",
  NotoSansMyanmar: "NotoSansMyanmar.ttf",
};

async function fetchFontBytes(fontName) {
  const tries = [];
  if (FONT_FILES[fontName]) tries.push(FONT_FILES[fontName]);
  tries.push(fontName + ".ttf", fontName + "-Regular.ttf", "Aka07-Bold.ttf");
  for (const f of [...new Set(tries)]) {
    try {
      const r = await fetch("./fonts/" + f);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (_) {}
  }
  throw new Error("Subtitle font file မတွေ့ပါ (fonts/" + (FONT_FILES[fontName] || fontName) + ")");
}

const _measureCtx = document.createElement("canvas").getContext("2d");

/** Same word-wrap as canvas drawStyledSubtitle (Intl.Segmenter "my"). */
export function wrapDubText(text, fontPx, fontName, maxW) {
  _measureCtx.font = `bold ${fontPx}px "${fontName}", "NotoSansMyanmar", sans-serif`;
  const words = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? [...new Intl.Segmenter("my", { granularity: "word" }).segment(String(text))].map((s) => s.segment)
    : String(text).split(/(?<=\s)/);
  const lines = []; let cur = "";
  for (const w of words) {
    if (cur && _measureCtx.measureText(cur + w).width > maxW) { lines.push(cur.trim()); cur = w; }
    else cur += w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [String(text)];
}

/** Subtitle anchor — mirrors canvas subtitleAnchor (onBlur / top / bottom). */
export function dubSubtitleAnchor(W, H, blur, flip, mode) {
  const k = W / 720;
  const b = (blur || []).slice().sort((a, c) => c.y - a.y)[0];
  if (mode === "onBlur" && b) {
    const x = flip ? 1 - b.x - b.w : b.x;
    return { cx: (x + b.w / 2) * W, cy: (b.y + b.h / 2) * H, maxW: Math.max(b.w * W, W * 0.6) };
  }
  if (mode === "top") return { cx: W / 2, cy: 100 * k, maxW: W - 40 * k };
  return { cx: W / 2, cy: H - 100 * k, maxW: W - 40 * k };
}

/** Render the logo to a PNG blob at its on-screen size (circle-cropped
 *  when shape is "circle") so ffmpeg can overlay it 1:1. */
export function logoPngBlob(img, pos, W, shape) {
  return new Promise((resolve, reject) => {
    try {
      const s = Math.max(2, Math.round(pos.size * W));
      const natW = img.naturalWidth || s, natH = img.naturalHeight || s;
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d");
      if (shape === "circle") {
        c.width = s; c.height = s;
        const m = Math.min(natW, natH);
        ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, (natW - m) / 2, (natH - m) / 2, m, m, 0, 0, s, s);
      } else {
        c.width = s; c.height = Math.max(2, Math.round(s * natH / natW));
        ctx.drawImage(img, 0, 0, c.width, c.height);
      }
      c.toBlob((b) => b ? resolve(b) : reject(new Error("logo PNG ထုတ်မရပါ")), "image/png");
    } catch (e) { reject(e); }
  });
}

function videoDurationOf(blob) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(v.src); resolve(isFinite(d) ? d : 0); };
    v.onerror = () => resolve(0);
    v.src = URL.createObjectURL(blob);
  });
}

async function probeFps(ff) {
  let buf = "";
  const onLog = ({ message }) => { buf += message + "\n"; };
  try { ff.on("log", onLog); } catch (_) {}
  try { await ff.exec(["-i", "dub_in.mp4"]); } catch (_) {}
  try { ff.off("log", onLog); } catch (_) {}
  const m = /(\d+(?:\.\d+)?)\s*fps/.exec(buf);
  if (m) { const f = parseFloat(m[1]); if (f > 1 && f < 120) return f; }
  return 30;
}

// ------------------------------------------------------------ main

/**
 * ffmpegDubRecap(videoFile, segments, opts) -> {blob, ext, duration, recSec, timeline, report}
 * segments: [{start, end, text, audioBlob, audioDuration?}] (source timeline).
 * opts mirrors canvasDubSync's options (flip, watermarkText, blurRegions,
 * style opts, logo, width/height/fit) + onprog(0..1) + onlog(msg).
 * timeline is in FINAL (post-speedup) seconds, for segmentsToSRT.
 */
export async function ffmpegDubRecap(videoFile, segments, opts = {}) {
  const {
    flip = false, watermarkText = "", blurRegions = [],
    subOn = true, subColor = "#ffffff", subSize = 28, subFont = "Aka07",
    shadeColor = "#000000", shadeThick = 4, subPos = "bottom",
    logoImg = null, logoPos = null, logoShape = "square",
    width = 720, height = 1280, fit = "cover",
    onprog = null, onlog = null,
  } = opts;
  const say = (m) => { console.log("[dub-recap]", m); if (onlog) { try { onlog(m); } catch (_) {} } };
  const segsIn = (segments || []).filter((s) => s && s.audioBlob);
  if (!segsIn.length) throw new Error("Dub recap render: အသံပါတဲ့ segment မရှိပါ");

  const srcDur = await videoDurationOf(videoFile);
  const segs = [];
  for (const s of segsIn) {
    let d = (typeof s.audioDuration === "number" && s.audioDuration > 0) ? s.audioDuration : 0;
    if (!d) { try { d = await mediaDuration(s.audioBlob); } catch (_) { d = 0; } }
    if (!(d > 0)) throw new Error("Dub recap render: segment အသံအရှည် တိုင်းမရပါ");
    segs.push({ start: s.start, end: s.end, text: s.text || "", audioDur: d, audioBlob: s.audioBlob });
  }
  segs.sort((a, b) => a.start - b.start);
  const lastEnd = segs.reduce((m, s) => Math.max(m, s.end), 0);
  const total = Math.max(srcDur, lastEnd);
  if (!(total > 0)) throw new Error("Dub recap render: video အရှည် မသိရပါ");
  for (const s of segs) { // clamp into the video so a stray timestamp can't crash trim
    s.start = Math.min(Math.max(0, s.start), Math.max(0, total - 0.05));
    s.end = Math.min(Math.max(s.end, s.start + 0.01), total);
  }

  const { pieces, timelinePre, totalPre, report } = buildDubRecapPieces(segs, total);
  const extreme = report.filter((r) => r.note);
  if (extreme.length) {
    say(`⚠️ recap render: အရမ်းဆွဲဆန့်/ချုံ့ထားတဲ့ အပိုင်း ${extreme.length} ခု — ` +
        extreme.slice(0, 6).map((r) => `#${r.i + 1} ${r.note}`).join(", "));
  }
  const mapT = dubRecapTimeMapper(pieces);

  let ff = null;
  const cleanup = [];
  const reg = (n) => { cleanup.push(n); return n; };
  try {
    ff = await ensureFFmpeg((m) => say(m));
    if (onprog) onprog(0.03);
    await ff.writeFile(reg("dub_in.mp4"), await fetchFile(videoFile));
    const fps = await probeFps(ff);
    for (let i = 0; i < segs.length; i++) {
      await ff.writeFile(reg(`dub_seg${i}.mp3`), await fetchFile(segs[i].audioBlob));
    }
    // gap silence files (unique durations, rounded to 0.01s)
    const gaps = new Map();
    const gapName = (g) => {
      const key = Math.round(g * 100) / 100;
      if (!gaps.has(key)) gaps.set(key, `dub_gap${gaps.size}.mp3`);
      return gaps.get(key);
    };
    const segGap = (i) => Math.max(0, dubRecapBoundary(segs, i, total) - segs[i].end);
    if (segs[0].start > 0.05) gapName(segs[0].start);
    segs.forEach((sg, i) => { const g = segGap(i); if (g > 0.02) gapName(g); });
    for (const [durS, name] of gaps) {
      await ff.exec(["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
        "-t", durS.toFixed(2), "-c:a", "libmp3lame", "-b:a", "96k",
        "-ar", "24000", "-ac", "1", reg(name)]);
    }
    const lines = [];
    if (segs[0].start > 0.05) lines.push(`file '${gapName(segs[0].start)}'`);
    segs.forEach((sg, i) => {
      lines.push(`file 'dub_seg${i}.mp3'`);
      const g = segGap(i);
      if (g > 0.02) lines.push(`file '${gapName(g)}'`);
    });
    await ff.writeFile(reg("dub_list.txt"), new TextEncoder().encode(lines.join("\n")));

    // ---- filter graph ----
    let graph = buildDubRecapVideoGraph(pieces, fps, width, height, fit, flip);
    let cur = "vbase", stage = 0;
    const next = () => "x" + (stage++);
    for (const r of (blurRegions || []).slice(0, 6)) {
      const fx = flip ? 1 - r.x - r.w : r.x;
      const bx = Math.round(fx * width), by = Math.round(r.y * height);
      const bw = Math.max(2, Math.round(r.w * width)), bh = Math.max(2, Math.round(r.h * height));
      const rad = Math.min(20, Math.max(2, Math.round((r.strength || 40) / 2)));
      const t0 = mapT(r.t0 || 0), t1 = mapT(typeof r.t1 === "number" ? r.t1 : total);
      const sp = next(), bl = next(), out = next();
      graph += `;[${cur}]split[${sp}][${bl}b];[${bl}b]crop=${bw}:${bh}:${bx}:${by},` +
        `boxblur=luma_radius=${rad}:luma_power=2[${bl}];` +
        `[${sp}][${bl}]overlay=${bx}:${by}:enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'[${out}]`;
      cur = out;
    }
    let fontReady = false;
    if (subOn || watermarkText) {
      await ff.writeFile(reg("dub_font.ttf"), await fetchFontBytes(subFont));
      fontReady = true;
    }
    if (subOn && fontReady) {
      const k = width / 720;
      const fontPx = Math.max(8, Math.round(subSize * k));
      const anchor = dubSubtitleAnchor(width, height, blurRegions, flip, subPos);
      const lh = Math.round(fontPx * 1.4);
      const border = Math.max(1, Math.round(shadeThick * k));
      const fc = hexToFfmpegColor(subColor), bc = hexToFfmpegColor(shadeColor, "0x000000");
      for (let i = 0; i < timelinePre.length; i++) {
        const tl = timelinePre[i];
        const wrapped = wrapDubText(tl.text, fontPx, subFont, anchor.maxW);
        const name = `dub_sub${i}.txt`;
        await ff.writeFile(reg(name), new TextEncoder().encode(wrapped.join("\n")));
        const blockH = fontPx + (wrapped.length - 1) * lh;
        const out = next();
        graph += `;[${cur}]drawtext=fontfile=dub_font.ttf:textfile=${name}:fontsize=${fontPx}` +
          `:fontcolor=${fc}:borderw=${border}:bordercolor=${bc}:line_spacing=${lh - fontPx}` +
          `:x=${Math.round(anchor.cx)}-text_w/2:y=${Math.round(anchor.cy - blockH / 2)}` +
          `:enable='between(t,${tl.start.toFixed(3)},${tl.end.toFixed(3)})'[${out}]`;
        cur = out;
      }
    }
    let hasLogo = false;
    if (logoImg && logoPos) {
      const png = await logoPngBlob(logoImg, logoPos, width, logoShape);
      await ff.writeFile(reg("dub_logo.png"), await fetchFile(png));
      const out = next();
      graph += `;[${cur}][2:v]overlay=${Math.round(logoPos.x * width)}:${Math.round(logoPos.y * height)}[${out}]`;
      cur = out; hasLogo = true;
    }
    if (watermarkText && fontReady) {
      await ff.writeFile(reg("dub_wm.txt"), new TextEncoder().encode(watermarkText));
      const k = width / 720, out = next();
      graph += `;[${cur}]drawtext=fontfile=dub_font.ttf:textfile=dub_wm.txt` +
        `:fontsize=${Math.round(20 * k)}:fontcolor=white@0.7` +
        `:x=w-text_w-${Math.round(16 * k)}:y=${Math.round(14 * k)}[${out}]`;
      cur = out;
    }
    graph += `;[${cur}]setpts=PTS/${DUB_RECAP_SPEEDUP.toFixed(4)}[vout]` +
      `;[1:a]aresample=24000,atempo=${DUB_RECAP_SPEEDUP.toFixed(4)}[aout]`;

    const args = ["-i", "dub_in.mp4", "-f", "concat", "-safe", "0", "-i", "dub_list.txt"];
    if (hasLogo) args.push("-i", "dub_logo.png");
    args.push("-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      "-shortest", "dub_out.mp4");
    reg("dub_out.mp4");
    say(`🎬 Dub recap render စပါပြီ — ${segs.length} ပိုင်း, မူရင်း ${total.toFixed(1)}s → ` +
        `${totalPre.toFixed(1)}s → 1.3× ပြီး ${(totalPre / DUB_RECAP_SPEEDUP).toFixed(1)}s`);
    if (onprog) onprog(0.1);
    setProgressHandler((p) => { if (onprog) { try { onprog(0.1 + p * 0.85); } catch (_) {} } });
    const code = await ff.exec(args);
    setProgressHandler(null);
    if (code !== 0) throw new Error("Dub recap render: FFmpeg render မအောင်မြင်ပါ (code " + code + ")");
    try { await ff.deleteFile("dub_in.mp4"); } catch (_) {}
    const data = await ff.readFile("dub_out.mp4");
    const blob = new Blob([data], { type: "video/mp4" });
    if (blob.size < 1024) throw new Error("Dub recap render: output file အရမ်းသေးနေပါတယ်");
    if (onprog) onprog(1);
    const sp = DUB_RECAP_SPEEDUP;
    const timeline = timelinePre.map((t) => ({ start: t.start / sp, end: t.end / sp, text: t.text }));
    say(`🎬 Dub recap render ပြီးပါပြီ ✅ (${(blob.size / 1048576).toFixed(1)}MB, ${timeline.length} ကြောင်း)`);
    return { blob, ext: "mp4", duration: totalPre / sp, recSec: totalPre / sp, timeline, report };
  } finally {
    setProgressHandler(null);
    if (ff) for (const n of cleanup) { try { await ff.deleteFile(n); } catch (_) {} }
  }
}
