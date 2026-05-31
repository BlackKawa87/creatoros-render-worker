const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

const RENDER_WORKER_SECRET = process.env.RENDER_WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "clips";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function run(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function callback(callbackUrl, payload) {
  await axios.post(callbackUrl, payload, {
    headers: {
      Authorization: `Bearer ${RENDER_WORKER_SECRET}`,
      "x-render-secret": RENDER_WORKER_SECRET,
      "Content-Type": "application/json"
    },
    timeout: 30000
  });
}

function seconds(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;

  const parts = String(value).split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

app.get("/", (req, res) => {
  res.send("CreatorOS Render Worker Online");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "CreatorOS Render Worker"
  });
});

app.post("/render", async (req, res) => {
  const incomingSecret =
    req.headers.authorization?.replace("Bearer ", "") ||
    req.headers["x-render-secret"] ||
    req.body.secret;

  if (!RENDER_WORKER_SECRET || incomingSecret !== RENDER_WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized render request" });
  }

  const job = req.body;

  res.json({
    received: true,
    job_id: job.job_id
  });

  processRenderJob(job).catch((error) => {
    console.error("Render job failed:", error);
  });
});

async function processRenderJob(job) {
  const {
    job_id,
    clip_id,
    source_video_url,
    start_time,
    end_time,
    callback_url
  } = job;

  const workdir = `/tmp/${job_id || uuidv4()}`;
  fs.mkdirSync(workdir, { recursive: true });

  const inputPath = path.join(workdir, "input.mp4");
  const outputPath = path.join(workdir, "output.mp4");
  const thumbnailPath = path.join(workdir, "thumbnail.jpg");

  try {
    await callback(callback_url, {
      job_id,
      status: "processing",
      progress: 10
    });

    if (!source_video_url) {
      throw new Error("Missing source_video_url");
    }

    await run(`yt-dlp -f "mp4/best" -o "${inputPath}" "${source_video_url}"`);

    await callback(callback_url, {
      job_id,
      status: "processing",
      progress: 35
    });

    const start = seconds(start_time);
    const end = seconds(end_time);
    const duration = Math.max(end - start, 3);

    const ffmpegCommand = [
      `ffmpeg -y`,
      `-ss ${start}`,
      `-i "${inputPath}"`,
      `-t ${duration}`,
      `-vf "scale=1080:-2,crop=1080:1920"`,
      `-c:v libx264`,
      `-preset veryfast`,
      `-crf 23`,
      `-c:a aac`,
      `-b:a 128k`,
      `"${outputPath}"`
    ].join(" ");

    await run(ffmpegCommand);

    await callback(callback_url, {
      job_id,
      status: "processing",
      progress: 70
    });

    await run(`ffmpeg -y -i "${outputPath}" -ss 1 -vframes 1 "${thumbnailPath}"`);

    const outputFileName = `${clip_id || job_id}-${Date.now()}.mp4`;
    const thumbnailFileName = `${clip_id || job_id}-${Date.now()}.jpg`;

    const outputBuffer = fs.readFileSync(outputPath);
    const thumbnailBuffer = fs.readFileSync(thumbnailPath);

    const outputUpload = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(`renders/${outputFileName}`, outputBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    if (outputUpload.error) throw outputUpload.error;

    const thumbnailUpload = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(`thumbnails/${thumbnailFileName}`, thumbnailBuffer, {
        contentType: "image/jpeg",
        upsert: true
      });

    if (thumbnailUpload.error) throw thumbnailUpload.error;

    const outputPublic = supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(`renders/${outputFileName}`);

    const thumbnailPublic = supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(`thumbnails/${thumbnailFileName}`);

    await callback(callback_url, {
      job_id,
      status: "completed",
      progress: 100,
      output_url: outputPublic.data.publicUrl,
      thumbnail_url: thumbnailPublic.data.publicUrl
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  } catch (error) {
    await callback(callback_url, {
      job_id,
      status: "failed",
      progress: 100,
      error_message: error.message
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

app.listen(PORT, () => {
  console.log(`CreatorOS Render Worker running on port ${PORT}`);
});
