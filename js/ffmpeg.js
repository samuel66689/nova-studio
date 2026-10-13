// ffmpeg.js — ffmpeg.wasm singleton (multi-thread → single-thread fallback)
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

const CORE_MT = {
  js: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js",
  wasm: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm",
};
const CORE_ST = {
  js: "https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm/ffmpeg-core.js",
  wasm: "https://unpkg.com/@ffmpeg/core-st@0.12.6/dist/esm/ffmpeg-core.wasm",
};

let ffmpeg = null;
let mode = null; // 'mt' | 'st'
let progressCb = null;

export { fetchFile, toBlobURL };
export function ffmpegMode() { return mode; }
export function setProgressHandler(cb) { progressCb = cb; }

/** Load ffmpeg once; returns the singleton instance. */
export async function ensureFFmpeg(log) {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (progressCb) { try { progressCb(progress); } catch (_) {} }
  });
  const tries = [["mt", CORE_MT], ["st", CORE_ST]];
  let lastErr = null;
  for (const [m, urls] of tries) {
    try {
      if (log) log(m === "mt"
        ? "FFmpeg (multi-thread) load လုပ်နေပါတယ်…"
        : "Single-thread core ကို စမ်းနေပါတယ်…");
      await ffmpeg.load({
        coreURL: await toBlobURL(urls.js, "text/javascript"),
        wasmURL: await toBlobURL(urls.wasm, "application/wasm"),
      });
      mode = m;
      if (log) log("FFmpeg အဆင်သင့်ဖြစ်ပါပြီ ✅", "ok");
      return ffmpeg;
    } catch (e) {
      lastErr = e;
      if (log) log("FFmpeg (" + m + ") load မအောင်မြင်ပါ — နောက်တစ်ခုစမ်းပါမယ်…");
      ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (progressCb) { try { progressCb(progress); } catch (_) {} }
      });
    }
  }
  throw new Error("FFmpeg ကို load မလုပ်နိုင်ပါ။ Browser refresh လုပ်ပြီး ပြန်စမ်းပါ။ (" + String(lastErr && lastErr.message || lastErr) + ")");
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
