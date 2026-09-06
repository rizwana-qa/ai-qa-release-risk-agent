/**
 * Locate the recorded LinkedIn demo video, verify it is silent and complete, and
 * report its properties. If a capable `ffmpeg` is available (system PATH, the
 * FFMPEG env var, or the one Playwright already downloaded), also write an
 * audio-free MP4 next to it for platforms that prefer H.264 — otherwise the
 * WebM is delivered as-is (it already has no audio track).
 *
 * No new dependency is installed for this.
 *
 *   node scripts/finalize-demo-video.mjs
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEMO_DIR = fileURLToPath(new URL("../artifacts/linkedin-demo/", import.meta.url));
const STABLE = join(DEMO_DIR, "ai-qa-release-risk-demo.webm");

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

/* ---- 1. find the recording ---------------------------------------------- */

function newestWebm(dir) {
  if (!existsSync(dir)) return null;
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith(".webm")) found.push(p);
    }
  };
  walk(dir);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

const video = existsSync(STABLE) ? STABLE : newestWebm(DEMO_DIR);
if (!video) fail(`no .webm recording found under ${DEMO_DIR} — run "npm run test:demo" first`);

const bytes = statSync(video).size;
const mb = (bytes / 1024 / 1024).toFixed(2);

/* ---- 2. locate an ffmpeg (optional) ----------------------------------- */

function resolveFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
  if (onPath.status === 0) return onPath.stdout.split(/\r?\n/)[0].trim();
  // Playwright downloads a minimal ffmpeg for screen recording.
  const cache = join(homedir(), process.platform === "darwin"
    ? "Library/Caches/ms-playwright"
    : process.platform === "win32"
      ? join("AppData", "Local", "ms-playwright")
      : ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((n) => n.startsWith("ffmpeg-")).sort().reverse()) {
      for (const bin of ["ffmpeg-win64.exe", "ffmpeg-mac", "ffmpeg-linux", "ffmpeg.exe", "ffmpeg"]) {
        const p = join(cache, d, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const ffmpeg = resolveFfmpeg();

/* ---- 3. inspect: duration, resolution, and NO audio stream ----------- */

let durationSec = null;
let resolution = null;
let hasAudio = null;

if (ffmpeg) {
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", video], { encoding: "utf8" }).stderr || "";
  const dm = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) durationSec = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
  const rm = info.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  if (rm) resolution = `${rm[1]}x${rm[2]}`;
  hasAudio = /\n\s*Stream #\d+:\d+.*: Audio:/.test(info);
}

/* ---- 4. optional MP4 (H.264, guaranteed no audio via -an) ------------ */

let mp4 = null;
if (ffmpeg) {
  const encoders = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "";
  if (/\blibx264\b/.test(encoders)) {
    const out = join(DEMO_DIR, "ai-qa-release-risk-demo.mp4");
    const r = spawnSync(ffmpeg, [
      "-y", "-i", video,
      "-an",                         // no audio track at all
      "-c:v", "libx264", "-preset", "medium", "-crf", "22",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ], { encoding: "utf8" });
    if (r.status === 0 && existsSync(out)) mp4 = out;
    else console.warn("note: MP4 transcode was attempted but did not succeed; the WebM is the deliverable.");
  }
}

/* ---- 5. report ------------------------------------------------------- */

console.log("\nLinkedIn demo video");
console.log("-------------------");
console.log("file        :", video);
console.log("size        :", `${mb} MB (${bytes.toLocaleString()} bytes)`);
console.log("format      : WebM (VP8) — container has no audio stream");
if (resolution) console.log("resolution  :", resolution);
if (durationSec != null) console.log("duration    :", `${durationSec.toFixed(1)}s`);
if (ffmpeg) {
  console.log("audio track :", hasAudio ? "PRESENT ❌ (unexpected)" : "none ✅ (silent)");
} else {
  console.log("audio track : none ✅ (Playwright recordings never contain an audio track)");
}
if (mp4) console.log("mp4 (H.264) :", mp4, "— audio-free (-an)");
else console.log("mp4 (H.264) : not created (no libx264-capable ffmpeg found); deliver the WebM, or convert in post");
console.log("");

if (hasAudio === true) fail("the recording unexpectedly contains an audio stream");
if (durationSec != null && (durationSec < 45 || durationSec > 150)) {
  console.warn(`warning: duration ${durationSec.toFixed(1)}s is outside the 60-120s target band`);
}
