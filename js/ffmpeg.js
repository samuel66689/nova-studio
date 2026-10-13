// ffmpeg.js — ffmpeg.wasm loader.
// Cores are self-hosted in ./ffmpeg-core/ (same origin) so a flaky CDN/VPN
// can't break loading. CDN copies (jsdelivr → unpkg) are fallbacks.
// Multi-thread core is tried first when the browser allows SharedArrayBuffer,
// otherwise the single-thread core is used directly.
// Core downloads show progress and have a stall timeout so a dead connection
// can't hang the app forever.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

export { fetchFile };

let ffmpeg = null;
let mode = null; // 'mt' | 'st'
let progressCb = null;

export function ffmpegMode() { return mode; }
export function setProgressHandler(cb) { progressCb = cb; }

function coreSources(kind) {
  if (kind === "mt") {
    return [
      { label: "site", js: "./ffmpeg-core/mt-ffmpeg-core.js", wasm: "./ffmpeg-core/mt-ffmpeg-core.wasm", worker: "./ffmpeg-core/mt-ffmpeg-core.worker.js" },
      { label: "jsdelivr", js: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.js", wasm: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.wasm", worker: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.worker.js" },
      { label: "unpkg", js: "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.js", wasm: "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.wasm", worker: "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.worker.js" },
    ];
  }
  return [
    { label: "site", js: "./ffmpeg-core/ffmpeg-core.js", wasm: "./ffmpeg-core/ffmpeg-core.wasm" },
    { label: "jsdelivr", js: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js", wasm: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm" },
    { label: "unpkg", js: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js", wasm: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm" },
  ];
}

/**
 * Fetch a URL to a blob URL with download progress, stall timeout and retry.
 * log(pct) is called with 0..100 as the download progresses.
 */
async function fetchBlobURL(url, mime, fileLabel, log, onPct) {
  const TIMEOUT_MS = 4 * 60 * 1000;
  let err = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const total = parseInt(res.headers.get("content-length") || "0", 10) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            if (onPct) { try { onPct(pct); } catch (_) {} }
          }
        }
      }
      clearTimeout(timer);
      return URL.createObjectURL(new Blob(chunks, { type: mime }));
    } catch (e) {
      clearTimeout(timer);
      err = e;
      if (log) log(`${fileLabel} (${attempt}/2) မရပါ — ပြန်စမ်းနေပါတယ်…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw err;
}

/** Load ffmpeg once; returns the singleton instance. */
export async function ensureFFmpeg(log) {
  if (ffmpeg) return ffmpeg;
  const kinds = window.crossOriginIsolated ? ["mt", "st"] : ["st"];
  if (!window.crossOriginIsolated && log) {
    log("SharedArrayBuffer မရပါ — single-thread core ကို သုံးပါမယ်…");
  }
  let lastErr = null;
  for (const kind of kinds) {
    for (const s of coreSources(kind)) {
      const inst = new FFmpeg();
      inst.on("progress", ({ progress }) => {
        if (progressCb) { try { progressCb(progress); } catch (_) {} }
      });
      try {
        const tag = kind === "mt" ? "multi-thread" : "single-thread";
        if (log) log(`FFmpeg (${tag}) — ${s.label} ကနေ download လုပ်နေပါတယ်… (32MB, ခဏစောင့်)`);
        const cfg = {
          coreURL: await fetchBlobURL(s.js, "text/javascript", "core js", log, null),
          wasmURL: await fetchBlobURL(s.wasm, "application/wasm", "core wasm", log,
            (p) => { if (log) log(`⬇️ FFmpeg download… ${p}% (${s.label})`); }),
        };
        if (s.worker) cfg.classWorkerURL = await fetchBlobURL(s.worker, "text/javascript", "worker", log, null);
        if (log) log("Download ပြီးပါပြီ — FFmpeg စတင်နေပါတယ်… (ဖုန်းပေါ်မှာ 1 မိနစ်လောက်ကြာနိုင်)");
        await inst.load(cfg);
        ffmpeg = inst;
        mode = kind;
        if (log) log(`FFmpeg အဆင်သင့်ဖြစ်ပါပြီ ✅ (${tag} · ${s.label})`, "ok");
        return ffmpeg;
      } catch (e) {
        lastErr = e;
        if (log) log(`FFmpeg (${kind} · ${s.label}) မရပါ — နောက်တစ်ခုစမ်းပါမယ်…`);
      }
    }
  }
  throw new Error(
    "FFmpeg ကို load မလုပ်နိုင်ပါ။ VPN ပိတ်ကြည့်ပါ၊ internet စစ်ပါ၊ ပြီးရင် browser refresh လုပ်ပြီး ပြန်စမ်းပါ။ (" +
    String((lastErr && lastErr.message) || lastErr) + ")"
  );
}

/** Run one ffmpeg command. files = {name: File|Blob|Uint8Array}. Returns ff instance. */
export async function runFFmpeg(args, files, log) {
  const ff = await ensureFFmpeg(log);
  for (const [name, data] of Object.entries(files || {})) {
    await ff.writeFile(name, data instanceof Blob ? await fetchFile(data) : data);
  }
  await ff.exec(args);
  return ff;
}

/** Read output file as Blob and delete given wasm-fs files to free memory. */
export async function readOutput(ff, outName, mime, cleanupNames) {
  const data = await ff.readFile(outName);
  const blob = new Blob([data], { type: mime });
  for (const n of cleanupNames || []) {
    try { await ff.deleteFile(n); } catch (_) {}
  }
  return blob;
}
