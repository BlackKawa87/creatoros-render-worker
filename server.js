// server.js — GrowCreator Render Worker (Railway)
// Node 20+. Sem Realtime, sem WebSocket, sem supabase.channel().

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- Supabase (sem realtime) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false },
  }
);

const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'rendered-clips';
const RENDER_WORKER_SECRET = process.env.RENDER_WORKER_SECRET || '';

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Auth helper ----------
function isAuthorized(req) {
  if (!RENDER_WORKER_SECRET) return false;
  const auth = (req.headers['authorization'] || '').toString();
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : '';
  const headerSecret = (req.headers['x-render-secret'] || '').toString();
  const bodySecret =
    req.body && typeof req.body.secret === 'string' ? req.body.secret : '';
  const provided = bearer || headerSecret || bodySecret;
  return provided && provided === RENDER_WORKER_SECRET;
}

// ---------- Health ----------
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'growcreator-render-worker' })
);

// ---------- Subprocess helper ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

// ---------- Callback ----------
async function postCallback(callbackUrl, payload) {
  if (!callbackUrl) return;
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RENDER_WORKER_SECRET}`,
        'x-render-secret': RENDER_WORKER_SECRET,
      },
      body: JSON.stringify({ ...payload, secret: RENDER_WORKER_SECRET }),
    });
  } catch (e) {
    console.error('[callback] failed:', e.message);
  }
}

// ---------- Render pipeline ----------
async function processJob(job) {
  const {
    job_id,
    clip_id,
    video_id,
    source_video_url,
    start_time = 0,
    end_time = 0,
    aspect_ratio = '9:16',
    output_format = 'mp4',
    callback_url,
  } = job;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${job_id}-`));
  const sourcePath = path.join(workDir, 'source.mp4');
  const outPath = path.join(workDir, `out.${output_format}`);
  const thumbPath = path.join(workDir, 'thumb.jpg');

  try {
    await postCallback(callback_url, { job_id, status: 'processing', progress: 5 });

    // 1) Download via yt-dlp
    await run('yt-dlp', [
      '-f',
      'bv*[height<=1080]+ba/b[height<=1080]',
      '--merge-output-format',
      'mp4',
      '-o',
      sourcePath,
      source_video_url || `https://www.youtube.com/watch?v=${video_id}`,
    ]);
    await postCallback(callback_url, { job_id, status: 'processing', progress: 35 });

    // 2) FFmpeg cut + 9:16
    const duration = Math.max(1, Number(end_time) - Number(start_time));
    const vf =
      aspect_ratio === '9:16'
        ? "crop='ih*9/16':ih,scale=1080:1920:flags=lanczos"
        : 'scale=1920:1080:flags=lanczos';

    await run('ffmpeg', [
      '-y',
      '-ss', String(start_time),
      '-i', sourcePath,
      '-t', String(duration),
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ]);
    await postCallback(callback_url, { job_id, status: 'processing', progress: 75 });

    // 3) Thumbnail
    await run('ffmpeg', [
      '-y',
      '-ss', '1',
      '-i', outPath,
      '-frames:v', '1',
      '-q:v', '3',
      thumbPath,
    ]);

    // 4) Upload (Supabase Storage)
    const stamp = Date.now();
    const videoKey = `${clip_id || job_id}/${stamp}.${output_format}`;
    const thumbKey = `${clip_id || job_id}/${stamp}.jpg`;

    const videoBuf = fs.readFileSync(outPath);
    const thumbBuf = fs.readFileSync(thumbPath);

    const up1 = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(videoKey, videoBuf, {
        contentType: `video/${output_format}`,
        upsert: true,
      });
    if (up1.error) throw new Error(`upload video: ${up1.error.message}`);

    const up2 = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(thumbKey, thumbBuf, { contentType: 'image/jpeg', upsert: true });
    if (up2.error) throw new Error(`upload thumb: ${up2.error.message}`);

    const { data: vUrl } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(videoKey);
    const { data: tUrl } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(thumbKey);

    await postCallback(callback_url, {
      job_id,
      status: 'completed',
      progress: 100,
      output_url: vUrl.publicUrl,
      thumbnail_url: tUrl.publicUrl,
    });
  } catch (err) {
    console.error(`[job ${job_id}] failed:`, err);
    await postCallback(callback_url, {
      job_id,
      status: 'failed',
      error_message: err.message || String(err),
    });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------- /render ----------
app.post('/render', (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const job = req.body || {};
  if (!job.job_id) {
    return res.status(400).json({ ok: false, error: 'job_id required' });
  }

  // Dry-run probe usado pelo diagnóstico
  if (job.dry_run) {
    return res.status(200).json({ ok: true, dry_run: true, received: job.job_id });
  }

  // Fire-and-forget — responde imediatamente, processa em background
  res.status(202).json({ ok: true, accepted: job.job_id });
  setImmediate(() => processJob(job).catch((e) => console.error(e)));
});

// ---------- Listen ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Render Worker running on port ${PORT}`);
});
