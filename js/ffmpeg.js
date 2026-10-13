// ffmpeg.js — ffmpeg.wasm loader.
// Cores are self-hosted in ./ffmpeg-core/ (same origin) so a flaky CDN/VPN
// can't break loading. CDN copies (jsdelivr → unpkg) are fallbacks.
// Multi-thread core is tried first when the browser allows SharedArrayBuffer,
// otherwise the single-thread core is used directly.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

export { fetchFile, toBlobURL };

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

/** fetch -> blob URL, with one retry */
async function fetchBlobURL(url, mime) {
  let err = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await toBlobURL(url, mime);
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1200));
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
        if (log) log(`FFmpeg (${kind === "mt" ? "multi-thread" : "single-thread"}) — ${s.label} ကနေ load လုပ်နေပါတယ်…`);
        const cfg = {
          coreURL: await fetchBlobURL(s.js, "text/javascript"),
          wasmURL: await fetchBlobURL(s.wasm, "application/wasm"),
        };
        if (s.worker) cfg.classWorkerURL = await fetchBlobURL(s.worker, "text/javascript");
        await inst.load(cfg);
        ffmpeg = inst;
        mode = kind;
        if (log) log(`FFmpeg အဆင်သင့်ဖြစ်ပါပြီ ✅ (${kind === "mt" ? "multi-thread" : "single-thread"} · ${s.label})`, "ok");
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
