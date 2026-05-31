/**
 * GrowCreator Render Worker
 * - Express HTTP server
 * - POST /render: download with yt-dlp, cut/resize with ffmpeg to 9:16 1080x1920,
 *   generate thumbnail, upload to Supabase Storage, callback progress.
 * - Supports YT_COOKIES_BASE64 to bypass YouTube bot detection.
 */

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const PORT = parseInt(process.env.PORT || "8080", 10);
const RENDER_WORKER_SECRET = process.env.RENDER_WORKER_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "rendered-clips";
const YT_COOKIES_BASE64 = process.env.YT_COOKIES_BASE64 || "";
const COOKIES_PATH = "/tmp/youtube_cookies.txt";

// ---- Cookies bootstrap -------------------------------------------------------
function bootstrapCookies() {
  if (!YT_COOKIES_BASE64) {
    console.log("[cookies] YT_COOKIES_BASE64 not set — proceeding without cookies");
    return null;
  }
  try {
    const decoded = Buffer.from(YT_COOKIES_BASE64, "base64").toString("utf8");
    fs.writeFileSync(COOKIES_PATH, decoded, { mode: 0o600 });
    console.log(`[cookies] wrote ${decoded.length} bytes to ${COOKIES_PATH}`);
    return COOKIES_PATH;
  } catch (e) {
    console.error("[cookies] failed to decode YT_COOKIES_BASE64:", e.message);
    return null;
  }
}
const COOKIES_FILE = bootstrapCookies();

// ---- Supabase ---------------------------------------------------------------
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// ---- Helpers ----------------------------------------------------------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
    });
  });
}

async function postCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RENDER_WORKER_SECRET}`,
        "x-render-secret": RENDER_WORKER_SECRET,
      },
      body: JSON.stringify({ ...payload, secret: RENDER_WORKER_SECRET }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[callback] ${res.status}: ${txt.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn("[callback] error:", e.message);
  }
}

function ytDlpBaseArgs() {
  const args = [
    "--no-playlist",
    "--no-check-certificate",
    "--force-ipv4",
    "--retries", "5",
    "--fragment-retries", "5",
    "--extractor-args", "youtube:player_client=android,web",
  ];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    args.push("--cookies", COOKIES_FILE);
  }
  return args;
}

async function downloadVideo(sourceUrl, outPath) {
  const args = [
    ...ytDlpBaseArgs(),
    "-f", "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", outPath,
    sourceUrl,
  ];
  console.log("[yt-dlp]", args.join(" "));
  await run("yt-dlp", args);
}

async function cutAndResize(inputPath, outPath, startTime, endTime) {
  const duration = Math.max(0.1, Number(endTime) - Number(startTime));
  // Scale to fill 1080x1920, center-crop. Re-encode for accuracy.
  const vf =
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";
  const args = [
    "-y",
    "-ss", String(startTime),
    "-i", inputPath,
    "-t", String(duration),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ];
  await run("ffmpeg", args);
}

async function generateThumbnail(videoPath, thumbPath) {
  const args = [
    "-y",
    "-ss", "0.5",
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "3",
    thumbPath,
  ];
  await run("ffmpeg", args);
}

async function uploadToStorage(localPath, storageKey, contentType) {
  if (!supabase) throw new Error("Supabase not configured");
  const file = await fsp.readFile(localPath);
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storageKey, file, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storageKey);
  return data.publicUrl;
}

// ---- Render pipeline --------------------------------------------------------
async function processJob(job) {
  const { job_id, clip_id, video_id, source_video_url, start_time, end_time, callback_url } = job;
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `render-${job_id}-`));
  const rawPath = path.join(workDir, "source.mp4");
  const outPath = path.join(workDir, "clip.mp4");
  const thumbPath = path.join(workDir, "thumb.jpg");

  try {
    await postCallback(callback_url, { job_id, status: "processing", progress: 5 });

    console.log(`[job ${job_id}] downloading ${source_video_url}`);
    await downloadVideo(source_video_url, rawPath);
    await postCallback(callback_url, { job_id, status: "processing", progress: 40 });

    console.log(`[job ${job_id}] cutting ${start_time}..${end_time}`);
    await cutAndResize(rawPath, outPath, start_time, end_time);
    await postCallback(callback_url, { job_id, status: "processing", progress: 70 });

    console.log(`[job ${job_id}] thumbnail`);
    await generateThumbnail(outPath, thumbPath);
    await postCallback(callback_url, { job_id, status: "processing", progress: 85 });

    const stamp = Date.now();
    const videoKey = `clips/${clip_id || job_id}/${stamp}.mp4`;
    const thumbKey = `clips/${clip_id || job_id}/${stamp}.jpg`;
    const [outputUrl, thumbUrl] = await Promise.all([
      uploadToStorage(outPath, videoKey, "video/mp4"),
      uploadToStorage(thumbPath, thumbKey, "image/jpeg"),
    ]);

    await postCallback(callback_url, {
      job_id,
      status: "completed",
      progress: 100,
      output_url: outputUrl,
      thumbnail_url: thumbUrl,
    });
    console.log(`[job ${job_id}] completed`);
  } catch (e) {
    console.error(`[job ${job_id}] failed:`, e.message);
    await postCallback(callback_url, {
      job_id,
      status: "failed",
      error_message: e.message.slice(0, 1000),
    });
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- HTTP -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.json({ status: "ok" }));
app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "growcreator-render-worker" }),
);

function checkAuth(req) {
  if (!RENDER_WORKER_SECRET) return false;
  const auth = req.headers["authorization"] || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const headerSecret = req.headers["x-render-secret"] || "";
  const bodySecret = (req.body && typeof req.body.secret === "string") ? req.body.secret : "";
  const provided = bearer || headerSecret || bodySecret;
  if (!provided) return false;
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(RENDER_WORKER_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

app.post("/render", async (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const job = req.body || {};
  const required = ["job_id", "video_id", "source_video_url", "start_time", "end_time", "callback_url"];
  for (const k of required) {
    if (job[k] === undefined || job[k] === null || job[k] === "") {
      return res.status(400).json({ ok: false, error: `missing field: ${k}` });
    }
  }
  // Accept and queue asynchronously
  res.status(202).json({ ok: true, accepted: true, job_id: job.job_id });
  setImmediate(() => {
    processJob(job).catch((e) => console.error("[processJob fatal]", e));
  });
});

app.listen(PORT, () => {
  console.log(`growcreator-render-worker listening on :${PORT}`);
  console.log(`  supabase: ${supabase ? "configured" : "MISSING"}`);
  console.log(`  bucket:   ${STORAGE_BUCKET}`);
  console.log(`  cookies:  ${COOKIES_FILE ? "loaded" : "none"}`);
});
