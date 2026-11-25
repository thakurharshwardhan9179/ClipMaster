'use strict';
const http = require('node:http');
const dns = require('node:dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  isUuid,
  validateUploadId,
  safeResolveInside,
  safeDecodeHeader,
  safeName,
  enqueueFileWrite,
  atomicWriteJsonSync,
  getOrCreateAccessKey,
  getOrCreateSessionSecret,
  timingSafeEqualStr,
  signSessionToken,
  isDirectLoopback,
  isAuthenticated,
  checkSameOrigin,
  RateLimiter,
  getClientIp
} = require('./lib/security');
const {
  parseVtt,
  listProjectVttFiles,
  chooseCaptionTrack,
  groupCaptions,
  toSrt,
  toAss
} = require('./lib/captions');
const {
  findHighlights,
  rankWithLocalAi,
  generateAiPostCopy
} = require('./lib/highlights');
const {
  checkMediaTools,
  getFfmpegBin,
  probe,
  parseRatio,
  renderDimensions,
  buildRenderArgs,
  generateQuoteImage
} = require('./lib/ffmpeg');
const { createMetaService } = require('./lib/meta');
const { generateQrSvg } = require('./lib/qrcode');

function loadDotEnv(rootDir) {
  const envPath = path.join(rootDir || __dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {}
}

const execFileAsync = promisify(execFile);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const MAX_PARALLEL_RENDERS = 2;
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

function getNetworkIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function createApp(config = {}) {
  const ROOT = config.rootDir || __dirname;
  if (config.loadEnv !== false) loadDotEnv(ROOT);
  const DATA = config.dataDir || path.join(ROOT, 'data');
  const UPLOADS = path.join(DATA, 'uploads');
  const EXPORTS = path.join(DATA, 'exports');
  const PREVIEWS = path.join(EXPORTS, 'previews');
  const DB_FILE = path.join(DATA, 'projects.json');
  const BGM_DIR = config.bgmDir || path.join(ROOT, 'assets', 'bgm');
  const PORT = Number(config.port ?? process.env.PORT ?? 4173);

  for (const dir of [DATA, UPLOADS, EXPORTS, PREVIEWS, BGM_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const accessKey = config.accessKey || getOrCreateAccessKey(DATA);
  const sessionSecret = config.sessionSecret || getOrCreateSessionSecret(DATA);

  const authLimiter = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 12 });
  const publishLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 20 });
  const importLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 15 });

  const jobs = new Map();
  const ytDownloads = new Map();
  const publishJobs = new Map();
  const uploadSessions = new Map();
  const renderQueue = [];
  let activeRenders = 0;
  let aiDiagnostic = '';
  let mediaToolsStatus = { ffmpeg: true, ffprobe: true };

  const meta = createMetaService({ dataDir: DATA, exportsDir: EXPORTS, previewsDir: PREVIEWS });

  // ── DB helpers ─────────────────────────────────────────────
  function loadProjects() {
    try {
      if (!fs.existsSync(DB_FILE)) return [];
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function saveProjectsSync(items) {
    atomicWriteJsonSync(DB_FILE, items, 0o644);
  }

  function getProject(id) {
    if (!isUuid(id)) return null;
    return loadProjects().find(p => p.id === id) || null;
  }

  function sanitizeProject(p) {
    if (!p) return null;
    const { filename, ...pub } = p;
    return {
      ...pub,
      ext: p.ext || (filename ? path.extname(filename).replace('.', '').toUpperCase() : 'MP4'),
      videoCodec: p.videoCodec || 'H.264',
      hasAudio: p.hasAudio !== false
    };
  }

  async function mutateProjects(mutator) {
    return enqueueFileWrite(DB_FILE, () => {
      const all = loadProjects();
      const result = mutator(all);
      saveProjectsSync(all);
      return result;
    });
  }

  async function withProject(id, update) {
    if (!isUuid(id)) return null;
    return mutateProjects(all => {
      const index = all.findIndex(p => p.id === id);
      if (index < 0) return null;
      all[index] = { ...all[index], ...update, updatedAt: new Date().toISOString() };
      return all[index];
    });
  }

  // ── Cleanup & TTL Pruning ──────────────────────────────────
  function removeClipArtifacts(clipId) {
    if (!isUuid(clipId)) return;
    const files = [
      safeResolveInside(EXPORTS, `${clipId}.mp4`),
      safeResolveInside(EXPORTS, `${clipId}.srt`),
      safeResolveInside(DATA, `${clipId}.ass`)
    ];
    for (const f of files) {
      try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch {}
    }
    try {
      if (fs.existsSync(PREVIEWS)) {
        for (const f of fs.readdirSync(PREVIEWS)) {
          if (f.includes(clipId)) {
            fs.rmSync(safeResolveInside(PREVIEWS, f), { force: true });
          }
        }
      }
    } catch {}
    jobs.delete(clipId);
  }

  function pruneExpiredState() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if ((job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') &&
          now - (job.completedAt || job.startedAt || now) > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
    for (const [id, dl] of ytDownloads.entries()) {
      if ((dl.status === 'complete' || dl.status === 'failed') &&
          now - (dl.completedAt || dl.startedAt || now) > JOB_TTL_MS) {
        ytDownloads.delete(id);
      }
    }
    for (const [id, pj] of publishJobs.entries()) {
      if ((pj.status === 'complete' || pj.status === 'failed') &&
          now - (pj.completedAt || pj.startedAt || now) > JOB_TTL_MS) {
        publishJobs.delete(id);
      }
    }
    for (const [uid, sess] of uploadSessions.entries()) {
      if (now - sess.lastActivity > JOB_TTL_MS) {
        try { if (sess.tmpFile && fs.existsSync(sess.tmpFile)) fs.unlinkSync(sess.tmpFile); } catch {}
        uploadSessions.delete(uid);
      }
    }
    try {
      if (fs.existsSync(UPLOADS)) {
        for (const f of fs.readdirSync(UPLOADS)) {
          if (f.startsWith('tmp_') && f.endsWith('.part')) {
            const fp = path.join(UPLOADS, f);
            const st = fs.statSync(fp);
            if (now - st.mtimeMs > JOB_TTL_MS) {
              fs.unlinkSync(fp);
            }
          }
        }
      }
    } catch {}
  }

  const cleanupTimer = setInterval(pruneExpiredState, 15 * 60 * 1000);
  cleanupTimer.unref?.();

  // ── HTTP helpers ───────────────────────────────────────────
  function json(res, status, value, extraHeaders = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    });
    res.end(body);
  }

  function contentType(file) {
    return ({
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.m4v': 'video/mp4',
      '.mkv': 'video/webm'
    })[path.extname(file).toLowerCase()] || 'application/octet-stream';
  }

  function parseBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) return;
        body += chunk;
        if (Buffer.byteLength(body) > limit) {
          aborted = true;
          reject(new Error('Request body too large.'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON in request body.'));
        }
      });
      req.on('error', err => {
        if (!aborted) reject(err);
      });
    });
  }

  function streamFile(req, res, file, type, downloadName) {
    if (!fs.existsSync(file)) return json(res, 404, { error: 'File not found.' });
    const stat = fs.statSync(file);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (downloadName) {
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(downloadName)}"`);
    }
    if (range) {
      const [a, b] = range.replace(/bytes=/, '').split('-');
      const start = Number(a);
      const end = b ? Math.min(Number(b), stat.size - 1) : stat.size - 1;
      if (!Number.isInteger(start) || start < 0 || start >= stat.size || !Number.isInteger(end) || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size });
      fs.createReadStream(file).pipe(res);
    }
  }

  // ── YouTube Download ───────────────────────────────────────
  async function importYoutube(input) {
    let parsed;
    try { parsed = new URL(input); } catch { throw new Error('Enter a valid URL.'); }

    const host = parsed.hostname.toLowerCase();
    if (!['youtu.be', 'youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com'].some(h => host === h || host.endsWith('.' + h))) {
      throw new Error('Only YouTube video links are supported at this time.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('URL must use http or https.');
    }

    const id = crypto.randomUUID();
    const template = path.join(UPLOADS, `${id}.%(ext)s`);
    const subLangs = 'en-orig,hi-orig,en,hi,en-US,en-GB,hi-IN';
    const ffmpegBin = getFfmpegBin();
    const ffmpegLocArgs = path.isAbsolute(ffmpegBin) ? ['--ffmpeg-location', path.dirname(ffmpegBin)] : [];
    const nodeRuntime = process.execPath ? `node:${process.execPath}` : 'node';
    const formatSelector = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/best';

    const commonArgs = [
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout', '30',
      '--retries', '5',
      '--extractor-retries', '5',
      '--fragment-retries', '5',
      '--max-filesize', '8G',
      '--geo-bypass',
      '--js-runtimes', nodeRuntime,
      ...ffmpegLocArgs
    ];

    const videoArgs = [
      ...commonArgs,
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '-o', template,
      '--print', 'title',
      '--print', 'after_move:filepath',
      parsed.href
    ];

    let result;
    const pyEnv = {
      ...process.env,
      PYTHONPATH: [path.join(ROOT, 'vendor'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUTF8: '1'
    };

    try {
      result = await execFileAsync('python', ['-m', 'yt_dlp', ...videoArgs], {
        windowsHide: true,
        timeout: 25 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        env: pyEnv
      });
    } catch (e) {
      const possibleFile = fs.readdirSync(UPLOADS).find(f =>
        f.startsWith(id + '.') &&
        !f.endsWith('.vtt') &&
        !f.endsWith('.part') &&
        !f.endsWith('.ytdl')
      );
      if (!possibleFile) {
        try {
          const fallbackArgs = [
            ...commonArgs,
            '--compat-options', 'no-youtube-unavailable-videos',
            '--extractor-args', 'youtube:player_client=android_vr,tv,web',
            '-f', 'bv*[height<=1080]+ba/b[ext=mp4][height<=1080]/b[height<=1080]/bv*+ba/best',
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            '-o', template,
            '--print', 'title',
            '--print', 'after_move:filepath',
            parsed.href
          ];
          result = await execFileAsync('python', ['-m', 'yt_dlp', ...fallbackArgs], {
            windowsHide: true,
            timeout: 25 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            env: pyEnv
          });
        } catch (err2) {
          const detail = (err2.stderr || err2.message || e.stderr || e.message || '')
            .trim().split('\n').slice(-5).join(' ').slice(0, 700);
          throw new Error(`YouTube download failed: ${detail}`);
        }
      } else {
        result = { stdout: `${possibleFile}\n${path.join(UPLOADS, possibleFile)}` };
      }
    }

    // Best-effort subtitle download (separated so a 429 rate-limit on secondary auto-sub tracks never aborts the video import)
    try {
      const subArgs = [
        ...commonArgs,
        '--ignore-errors',
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', subLangs,
        '--sub-format', 'vtt',
        '-o', template,
        parsed.href
      ];
      await execFileAsync('python', ['-m', 'yt_dlp', ...subArgs], {
        windowsHide: true,
        timeout: 2 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: pyEnv
      });
    } catch {
      // yt-dlp returns exit code 1 if any optional subtitle track hits HTTP 429; downloaded .vtt tracks on disk are kept
    }

    const lines = (result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    let filename = lines.find(s => fs.existsSync(s) && path.resolve(s).startsWith(path.resolve(UPLOADS) + path.sep));
    if (!filename) {
      const found = fs.readdirSync(UPLOADS).find(f =>
        f.startsWith(id + '.') &&
        !f.endsWith('.vtt') &&
        !f.endsWith('.part') &&
        !f.endsWith('.ytdl')
      );
      if (found) filename = path.join(UPLOADS, found);
    }
    if (!filename) throw new Error('yt-dlp completed but the downloaded file was not found.');

    try {
      const metaInfo = await probe(filename);
      const title = lines.find(s => s !== filename) || metaInfo.title;
      const ext = path.extname(filename);
      const finalName = `${id}${ext}`;
      const target = path.join(UPLOADS, finalName);
      if (path.resolve(filename) !== path.resolve(target)) fs.renameSync(filename, target);

      const project = {
        id,
        filename: finalName,
        name: title,
        originalName: `${title}${ext}`,
        sourceUrl: parsed.href,
        duration: metaInfo.duration,
        width: metaInfo.width,
        height: metaInfo.height,
        hasAudio: metaInfo.hasAudio,
        videoCodec: metaInfo.videoCodec,
        ext: metaInfo.ext,
        size: metaInfo.size,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await mutateProjects(all => { all.unshift(project); });
      return sanitizeProject(project);
    } catch (e) {
      fs.rmSync(filename, { force: true });
      throw e;
    }
  }

  async function runAsyncYoutubeImport(downloadId, url) {
    try {
      const project = await importYoutube(url);
      ytDownloads.set(downloadId, { status: 'complete', project, error: null, completedAt: Date.now() });
    } catch (err) {
      ytDownloads.set(downloadId, { status: 'failed', project: null, error: err.message, completedAt: Date.now() });
    }
  }

  // ── Render Queue Management ────────────────────────────────
  function extractCaptionsFromSrt(srtPath, offsetSec = 0, speedFactor = 1.0) {
    if (!fs.existsSync(srtPath)) return [];
    try {
      const raw = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '');
      const blocks = raw.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
      const out = [];
      const toSec = (h, m, s, ms) => (Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000) * speedFactor + offsetSec;
      for (const b of blocks) {
        const lines = b.split(/\r?\n/);
        if (lines.length < 3) continue;
        const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) continue;
        const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
        if (text) {
          out.push({
            start: toSec(m[1], m[2], m[3], m[4]),
            end: toSec(m[5], m[6], m[7], m[8]),
            text
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  function renderJob(project, options) {
    const id = crypto.randomUUID();
    const output = safeResolveInside(EXPORTS, `${id}.mp4`);
    const maxDur = Number(project.duration) > 0 ? Number(project.duration) : 36000;
    const start = Math.max(0, Number(options.start) || 0);
    const end = Math.min(maxDur, Number(options.end) || 0);
    if (end <= start) throw new Error('Clip end time must be after start time.');

    const rawDuration = end - start;
    const ratio = parseRatio(options.ratio);
    const { w: width, h: height } = renderDimensions(ratio, options.resolution || '1080p');

    let rawCaptions = Array.isArray(options.captions) ? options.captions : [];
    // If re-rendering an existing clip and caller sent no captions (unless explicitly cleared), recover persisted cues
    if (!rawCaptions.length && !options.clearCaptions && isUuid(options.clipJobId)) {
      const existingClip = (project.autoClips || []).find(c => c.jobId === options.clipJobId);
      if (existingClip && Array.isArray(existingClip.captions) && existingClip.captions.length) {
        rawCaptions = existingClip.captions;
      } else {
        const oldSrt = safeResolveInside(EXPORTS, `${options.clipJobId}.srt`);
        const oldSpeed = existingClip?.speedShift ? 1.02 : 1.0;
        const recovered = extractCaptionsFromSrt(oldSrt, existingClip?.start ?? start, oldSpeed);
        if (recovered.length) {
          rawCaptions = recovered;
        } else {
          const track = chooseCaptionTrack(UPLOADS, project, options.language || project.captionLanguage || 'auto');
          if (track) {
            rawCaptions = parseVtt(track.file).filter(c => c.end > start && c.start < end);
          }
        }
      }
    }

    const captions = rawCaptions.length
      ? groupCaptions(rawCaptions.filter(c => String(c.text || '').trim() && Number(c.end) > Number(c.start)), start, end)
      : [];

    const captionMode = ['Burned in', 'Separate .srt', 'Both'].includes(options.captionMode) ? options.captionMode : 'Burned in';
    const framingMode = ['fit-bars', 'blur-bg', 'crop-fill'].includes(options.framingMode) ? options.framingMode : 'fit-bars';
    const zoom = Math.max(0.5, Math.min(2.0, Number(options.zoom) || 1.0));

    // Evaluate Copyright Shield BEFORE writing .srt so external .srt timing matches speedShift!
    const shieldOpt = options.copyrightShield;
    const isShield = Boolean(shieldOpt === true || (shieldOpt && shieldOpt.enabled !== false));
    const shield = isShield ? {
      enabled: true,
      visualMod: shieldOpt.visualMod !== false,
      speedShift: shieldOpt.speedShift !== false,
      progressBar: shieldOpt.progressBar !== false,
      bgmTrack: String(shieldOpt.bgmTrack || 'none').toLowerCase().trim(),
      bgmVolume: Number.isFinite(Number(shieldOpt.bgmVolume)) ? Math.min(1, Math.max(0, Number(shieldOpt.bgmVolume))) : 0.12
    } : null;

    const speedFactor = (shield && shield.speedShift) ? 1.02 : 1.0;

    let captionFile = null;
    let tempAssFile = null;
    const hasWatermark = Boolean(options.watermark && options.watermark.enabled && String(options.watermark.text || '').trim());
    const hasOverlay = Boolean(
      (options.headerHook && String(options.headerHook).trim()) ||
      (options.bottomText && String(options.bottomText).trim()) ||
      (options.partBadge && String(options.partBadge).trim())
    );

    if (captions.length) {
      captionFile = safeResolveInside(EXPORTS, `${id}.srt`);
      fs.writeFileSync(captionFile, '\ufeff' + toSrt(captions, start, end, speedFactor), 'utf8');
    }

    let assEscaped = null;
    if ((captions.length && captionMode !== 'Separate .srt') || hasWatermark || hasOverlay) {
      const style = options.style || {};
      const overlay = {
        headerHook: options.headerHook,
        headerStyle: options.headerStyle || 'card',
        headerColor: options.headerColor || '#FFE500',
        headerSize: options.headerSize || 74,
        bottomText: options.bottomText,
        bottomColor: options.bottomColor || '#FFFFFF',
        bottomSize: options.bottomSize || 64,
        partBadge: options.partBadge,
        partColor: options.partColor || '#FFFFFF',
        partSize: options.partSize || 62,
        framingMode,
        ratio
      };
      tempAssFile = safeResolveInside(DATA, `${id}.ass`);
      fs.writeFileSync(tempAssFile, '\ufeff' + toAss(
        captionMode !== 'Separate .srt' ? captions : [],
        start,
        end,
        style,
        width,
        height,
        options.watermark,
        overlay
      ), 'utf8');
      assEscaped = tempAssFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");
    }

    let bgmPath = null;
    if (shield && shield.bgmTrack && shield.bgmTrack !== 'none') {
      const safeTrack = safeName(`${shield.bgmTrack}.mp3`);
      const candidate = safeResolveInside(BGM_DIR, safeTrack);
      if (fs.existsSync(candidate)) bgmPath = candidate;
    }

    const inputPath = safeResolveInside(UPLOADS, project.filename);
    const { targetDuration, args } = buildRenderArgs({
      inputPath,
      outputPath: output,
      start,
      rawDuration,
      width,
      height,
      framingMode,
      zoom,
      assEscaped,
      shield,
      hasAudio: project.hasAudio !== false,
      bgmPath
    });

    const jobTitle = options.clipTitle || (options.partBadge || `Clip ${id.slice(0, 4)}`);
    const downloadName = options.downloadName || `ClipMaster-${id.slice(0, 6)}.mp4`;
    const job = {
      id,
      status: 'queued',
      progress: 0,
      output,
      captionFile,
      projectId: project.id,
      start,
      end,
      targetDuration,
      shieldEnabled: isShield,
      speedShift: Boolean(shield && shield.speedShift),
      title: jobTitle,
      downloadName,
      framingMode,
      zoom,
      headerHook: options.headerHook || null,
      headerStyle: options.headerStyle || 'card',
      headerColor: options.headerColor || '#FFE500',
      bottomText: options.bottomText || null,
      partBadge: options.partBadge || null,
      captions,
      ratio,
      resolution: options.resolution || '1080p',
      startedAt: Date.now()
    };

    jobs.set(id, job);
    renderQueue.push({ job, args, start, end, targetDuration, tempAssFile });
    startNextRender();
    return job;
  }

  function startNextRender() {
    while (activeRenders < MAX_PARALLEL_RENDERS && renderQueue.length) {
      const item = renderQueue.shift();
      const { job, args, start, end, targetDuration, tempAssFile } = item;
      if (job.status === 'cancelled') {
        if (tempAssFile && fs.existsSync(tempAssFile)) { try { fs.unlinkSync(tempAssFile); } catch {} }
        continue;
      }

      activeRenders++;
      job.status = 'rendering';
      job.renderStartedAt = Date.now();

      const child = spawn(getFfmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      job._child = child;
      let err = '';

      child.stderr.on('data', b => {
        err += b.toString();
        if (err.length > 15000) err = err.slice(-10000);
      });
      child.stdout.on('data', b => {
        const m = b.toString().match(/out_time_ms=(\d+)/);
        if (m) {
          const totalDur = targetDuration || (end - start);
          job.progress = Math.min(98, Math.round((Number(m[1]) / 1_000_000) / totalDur * 100));
        }
      });

      let closed = false;
      const finalize = (status, code, spawnErr) => {
        if (closed) return;
        closed = true;
        delete job._child;
        if (job.status === 'cancelled') {
          job.completedAt = Date.now();
        } else if (status === 'complete') {
          job.status = 'complete';
          job.progress = 100;
          job.completedAt = Date.now();
        } else {
          job.status = 'failed';
          job.completedAt = Date.now();
          job.error = spawnErr
            ? `Could not start FFmpeg: ${spawnErr.message}`
            : (err.trim().split('\n').slice(-5).join(' ').slice(0, 600) || `FFmpeg exited with code ${code}`);
        }
        if (tempAssFile && fs.existsSync(tempAssFile)) {
          try { fs.unlinkSync(tempAssFile); } catch {}
        }
        activeRenders = Math.max(0, activeRenders - 1);
        startNextRender();
      };

      child.on('error', e => finalize('failed', null, e));
      child.on('close', code => finalize(code === 0 ? 'complete' : 'failed', code, null));
    }
  }

  function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      return true;
    }
    if (job.status === 'rendering' && job._child) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      try { job._child.kill('SIGTERM'); } catch {}
      return true;
    }
    return false;
  }

  // ── Main Request Handler ───────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const clientIp = getClientIp(req);

    // ── Serve index.html & favicon ───────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN'
      });
      return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    // ── Origin / CSRF Check for state-changing requests ──────
    if (!checkSameOrigin(req)) {
      return json(res, 403, { error: 'Cross-origin request denied.' });
    }

    // ── Auth Routes ──────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const authed = isAuthenticated(req, accessKey, sessionSecret);
      return json(res, 200, {
        ok: true,
        authenticated: authed,
        localLoopback: isDirectLoopback(req)
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const rl = authLimiter.check(clientIp);
      if (!rl.allowed) {
        return json(res, 429, { error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
      }
      let body;
      try { body = await parseBody(req, 16 * 1024); } catch (e) { return json(res, 400, { error: e.message }); }

      const candidate = String(body.key || '').trim();
      if (!timingSafeEqualStr(candidate, accessKey)) {
        return json(res, 401, { error: 'Invalid access key.' });
      }

      const token = signSessionToken(sessionSecret);
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
      const cookieParts = [
        `cm_session=${encodeURIComponent(token)}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${7 * 24 * 60 * 60}`
      ];
      if (isHttps) cookieParts.push('Secure');

      return json(res, 200, { ok: true, authenticated: true }, { 'Set-Cookie': cookieParts.join('; ') });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      return json(res, 200, { ok: true }, {
        'Set-Cookie': 'cm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    // ── Health ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const authed = isAuthenticated(req, accessKey, sessionSecret);
      if (!authed) {
        return json(res, 200, {
          ok: true,
          version: '2.0',
          authRequired: true,
          authenticated: false
        });
      }
      const networkIps = getNetworkIps();
      return json(res, 200, {
        ok: true,
        ffmpeg: mediaToolsStatus.ffmpeg,
        ffprobe: mediaToolsStatus.ffprobe,
        mode: 'network',
        version: '2.0',
        port: PORT,
        localUrl: `http://localhost:${PORT}`,
        networkUrls: networkIps.map(ip => `http://${ip}:${PORT}`),
        primaryNetworkUrl: networkIps.length ? `http://${networkIps[0]}:${PORT}` : `http://localhost:${PORT}`,
        authRequired: !isDirectLoopback(req),
        authenticated: true
      });
    }

    // ── Authentication Gate for all remaining /api/* routes ──
    if (url.pathname.startsWith('/api/')) {
      if (!isAuthenticated(req, accessKey, sessionSecret)) {
        return json(res, 401, {
          error: 'Authentication required. Please enter your ClipMaster Access Key.',
          authRequired: true
        });
      }
    }

    // ── Authenticated Auth Key Inspection (for Mobile Connect modal) ──
    if (req.method === 'GET' && url.pathname === '/api/auth/access-key') {
      return json(res, 200, { accessKey });
    }

    // ── Local QR SVG Generator ───────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      const text = url.searchParams.get('text') || '';
      if (!text || Buffer.byteLength(text) > 134) {
        return json(res, 400, { error: 'Invalid or overly long QR text.' });
      }
      const svg = generateQrSvg(text, 3);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(svg);
    }

    // ── BGM Tracks list ──────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/bgm-tracks') {
      return json(res, 200, [
        { id: 'none', label: 'None (Dialogue Only)', desc: 'No background music' },
        { id: 'chill-lofi', label: 'Chill Lo-Fi Beat', desc: 'Smooth low-tempo lofi chords' },
        { id: 'motivational', label: 'Motivational Ambient', desc: 'Warm uplifting atmospheric pad' },
        { id: 'upbeat', label: 'Upbeat Rhythm', desc: 'Energetic acoustic groove' }
      ]);
    }

    // ── Projects list ────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(res, 200, loadProjects().map(sanitizeProject));
    }

    // ── Abort / Cleanup Chunked Upload ───────────────────────
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'upload' && parts[2] === 'chunk' && parts[3]) {
      const uploadId = validateUploadId(parts[3]);
      if (!uploadId) return json(res, 400, { error: 'Invalid uploadId.' });
      const sess = uploadSessions.get(uploadId);
      uploadSessions.delete(uploadId);
      const tmpFile = safeResolveInside(UPLOADS, `tmp_${uploadId}.part`);
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
      if (sess?.tmpFile && fs.existsSync(sess.tmpFile)) {
        try { fs.unlinkSync(sess.tmpFile); } catch {}
      }
      return json(res, 200, { ok: true, cleaned: uploadId });
    }

    // ── Chunked Upload ───────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/upload/chunk') {
      const uploadId = validateUploadId(req.headers['x-upload-id']);
      if (!uploadId) {
        return json(res, 400, { error: 'Invalid or missing X-Upload-Id header.' });
      }

      const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
      const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
      const original = safeName(safeDecodeHeader(req.headers['x-file-name'], 'video.mp4'));
      const totalSize = parseInt(req.headers['x-file-size'], 10) || 0;
      const ext = path.extname(original).toLowerCase();

      if (!ALLOWED_VIDEO_EXTS.has(ext)) {
        return json(res, 415, { error: 'Unsupported format. Use MP4, MOV, MKV, WEBM, or M4V.' });
      }
      if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 5000 || chunkIndex < 0 || chunkIndex >= totalChunks) {
        return json(res, 400, { error: 'Invalid chunk index parameters.' });
      }
      if (totalSize > MAX_UPLOAD_BYTES) {
        return json(res, 413, { error: 'File exceeds the 8 GB limit.' });
      }

      const tmpFile = safeResolveInside(UPLOADS, `tmp_${uploadId}.part`);
      let session = uploadSessions.get(uploadId);

      if (chunkIndex === 0) {
        if (fs.existsSync(tmpFile)) {
          try { fs.unlinkSync(tmpFile); } catch {}
        }
        session = {
          uploadId,
          tmpFile,
          totalChunks,
          totalSize,
          ext,
          original,
          expectedIndex: 0,
          bytesWritten: 0,
          lastActivity: Date.now()
        };
        uploadSessions.set(uploadId, session);
      } else {
        if (!session) {
          return json(res, 409, { error: 'Upload session not found or expired. Please restart upload.' });
        }
        if (chunkIndex !== session.expectedIndex) {
          return json(res, 409, { error: `Out-of-order chunk ${chunkIndex}; expected ${session.expectedIndex}.` });
        }
        // Truncate back to last committed byte boundary in case a previous attempt on this chunk failed mid-stream
        if (fs.existsSync(tmpFile)) {
          const st = fs.statSync(tmpFile);
          if (st.size !== session.bytesWritten) {
            fs.truncateSync(tmpFile, session.bytesWritten);
          }
        }
      }

      session.lastActivity = Date.now();
      let chunkBytes = 0;
      let aborted = false;

      const out = fs.createWriteStream(tmpFile, { flags: chunkIndex === 0 ? 'w' : 'a' });

      req.on('data', chunk => {
        if (aborted) return;
        chunkBytes += chunk.length;
        if (session.bytesWritten + chunkBytes > MAX_UPLOAD_BYTES) {
          aborted = true;
          out.destroy();
          req.destroy();
          uploadSessions.delete(uploadId);
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
          if (!res.headersSent) json(res, 413, { error: 'Upload exceeds the 8 GB limit.' });
        }
      });

      req.on('aborted', () => {
        aborted = true;
        out.destroy();
      });

      req.pipe(out);

      out.on('error', e => {
        if (!aborted && !res.headersSent) {
          json(res, 500, { error: `Chunk write error: ${e.message}` });
        }
      });

      out.on('finish', async () => {
        if (aborted) return;
        session.bytesWritten += chunkBytes;
        session.expectedIndex += 1;
        session.lastActivity = Date.now();

        if (chunkIndex < totalChunks - 1) {
          return json(res, 200, { ok: true, chunk: chunkIndex, bytesReceived: session.bytesWritten });
        }

        uploadSessions.delete(uploadId);
        const id = crypto.randomUUID();
        const filename = `${id}${ext}`;
        const dest = safeResolveInside(UPLOADS, filename);

        try {
          fs.renameSync(tmpFile, dest);
          const metaInfo = await probe(dest);
          const project = {
            id,
            filename,
            name: metaInfo.title || original,
            originalName: original,
            sourceUrl: null,
            duration: metaInfo.duration,
            width: metaInfo.width,
            height: metaInfo.height,
            hasAudio: metaInfo.hasAudio,
            videoCodec: metaInfo.videoCodec,
            ext: metaInfo.ext,
            size: metaInfo.size || session.bytesWritten || totalSize,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await mutateProjects(all => { all.unshift(project); });
          return json(res, 201, { project: sanitizeProject(project) });
        } catch (e) {
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
          try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
          return json(res, 422, { error: `Could not process video: ${e.message}` });
        }
      });
      return;
    }

    // ── Direct Single-Stream Upload ──────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const original = safeName(safeDecodeHeader(req.headers['x-file-name'], 'video.mp4'));
      const ext = path.extname(original).toLowerCase();
      if (!ALLOWED_VIDEO_EXTS.has(ext)) {
        return json(res, 415, { error: 'Unsupported format. Use MP4, MOV, MKV, WEBM, or M4V.' });
      }
      const length = Number(req.headers['content-length'] || 0);
      if (length > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'File exceeds the 8 GB limit.' });

      const id = crypto.randomUUID();
      const filename = `${id}${ext}`;
      const dest = safeResolveInside(UPLOADS, filename);
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      let received = 0;
      let failed = false;

      req.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) {
          failed = true;
          out.destroy();
          req.destroy();
          try { if (fs.existsSync(dest)) fs.rmSync(dest, { force: true }); } catch {}
          if (!res.headersSent) json(res, 413, { error: 'File exceeds the 8 GB limit.' });
        }
      });
      req.pipe(out);
      out.on('error', e => {
        try { if (fs.existsSync(dest)) fs.rmSync(dest, { force: true }); } catch {}
        if (!failed && !res.headersSent) json(res, 500, { error: e.message });
      });
      out.on('finish', async () => {
        if (failed) return;
        try {
          const metaInfo = await probe(dest);
          const project = {
            id,
            filename,
            name: metaInfo.title,
            originalName: original,
            sourceUrl: null,
            duration: metaInfo.duration,
            width: metaInfo.width,
            height: metaInfo.height,
            hasAudio: metaInfo.hasAudio,
            videoCodec: metaInfo.videoCodec,
            ext: metaInfo.ext,
            size: metaInfo.size,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await mutateProjects(all => { all.unshift(project); });
          json(res, 201, { project: sanitizeProject(project) });
        } catch (e) {
          fs.rmSync(dest, { force: true });
          json(res, 422, { error: `Could not read video: ${e.message}` });
        }
      });
      return;
    }

    // ── YouTube Import ───────────────────────────────────────
    if (req.method === 'POST' && (url.pathname === '/api/youtube' || url.pathname === '/api/youtube/')) {
      const rl = importLimiter.check(clientIp);
      if (!rl.allowed) return json(res, 429, { error: `Too many requests. Retry in ${rl.retryAfterSec}s.` });

      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

      const ytUrl = String(body.url || '').trim();
      if (!ytUrl) return json(res, 400, { error: 'Please enter a valid YouTube URL.' });

      if (body.sync) {
        try {
          const project = await importYoutube(ytUrl);
          return json(res, 201, { project });
        } catch (e) { return json(res, 422, { error: e.message }); }
      }

      const downloadId = crypto.randomUUID();
      ytDownloads.set(downloadId, { status: 'downloading', project: null, error: null, startedAt: Date.now() });
      runAsyncYoutubeImport(downloadId, ytUrl);
      return json(res, 202, { downloadId, status: 'downloading' });
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'youtube' && parts[2] === 'status' && parts[3]) {
      const downloadId = parts[3];
      if (!isUuid(downloadId)) return json(res, 400, { error: 'Invalid downloadId.' });
      const item = ytDownloads.get(downloadId);
      if (!item) return json(res, 404, { error: 'Download job not found or expired.' });
      return json(res, 200, item);
    }

    // ── Social Accounts API ──────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      return json(res, 200, meta.publicAccounts());
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/facebook/token') {
      const rl = authLimiter.check(clientIp);
      if (!rl.allowed) return json(res, 429, { error: `Too many requests. Retry in ${rl.retryAfterSec}s.` });
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const accounts = await meta.verifyFacebookToken(body.token);
        return json(res, 200, { ok: true, accounts });
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/instagram/refresh') {
      try {
        const accounts = await meta.refreshInstagramAccounts();
        return json(res, 200, { ok: true, accounts });
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/instagram/link') {
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const accounts = await meta.linkManualInstagramAccount(body);
        return json(res, 200, { ok: true, accounts });
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'DELETE' && url.pathname === '/api/accounts/facebook') {
      meta.disconnectFacebook();
      return json(res, 200, { ok: true, disconnected: true });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/accounts/instagram') {
      meta.disconnectInstagram();
      return json(res, 200, { ok: true, disconnected: true });
    }

    // ── AI Copy & Viral Hashtags ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/ai/copy') {
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        if (body.jobId && !isUuid(body.jobId)) {
          return json(res, 400, { error: 'Invalid jobId.' });
        }
        const copy = await generateAiPostCopy(body, EXPORTS);
        return json(res, 200, copy);
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    // ── Quote Image Preview ──────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/publish/image-preview') {
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const jobId = String(body.jobId || '').trim();
        if (!isUuid(jobId)) return json(res, 400, { error: 'Valid jobId is required.' });
        const videoPath = safeResolveInside(EXPORTS, `${jobId}.mp4`);
        if (!fs.existsSync(videoPath)) throw new Error(`Clip ${jobId} video file not found.`);

        const quoteInfo = meta.extractBestQuote(jobId, body.fallbackTitle || 'Highlight Moment');
        const quoteText = body.quoteText && body.quoteText.trim() ? body.quoteText.trim() : quoteInfo.quoteText;
        const ratio = body.ratio === '4:5' ? '4:5' : '1:1';

        const previewFilename = `preview_${jobId}_${ratio.replace(':', '_')}.jpg`;
        const previewPath = safeResolveInside(PREVIEWS, previewFilename);

        await generateQuoteImage({
          videoPath,
          quoteText,
          ratio,
          watermark: body.watermark || null,
          outputPath: previewPath,
          timestamp: quoteInfo.timestamp,
          dataDir: DATA,
          previewsDir: PREVIEWS
        });

        return json(res, 200, {
          ok: true,
          imageUrl: `/api/preview/images/${previewFilename}?t=${Date.now()}`,
          quoteText,
          ratio
        });
      } catch (e) {
        return json(res, 422, { error: e.message });
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/preview/images/')) {
      const filename = path.basename(url.pathname);
      if (!/^[a-zA-Z0-9_.-]+\.jpg$/.test(filename)) {
        return json(res, 400, { error: 'Invalid preview filename.' });
      }
      const filepath = safeResolveInside(PREVIEWS, filename);
      if (!fs.existsSync(filepath)) return json(res, 404, { error: 'Preview image not found.' });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(filepath).pipe(res);
    }

    // ── Legacy Direct Publish Endpoints ──────────────────────
    if (req.method === 'POST' && url.pathname === '/api/publish/facebook') {
      const rl = publishLimiter.check(clientIp);
      if (!rl.allowed) return json(res, 429, { error: `Too many requests. Retry in ${rl.retryAfterSec}s.` });
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        if (!isUuid(body.jobId)) return json(res, 400, { error: 'Invalid jobId.' });
        const result = await meta.publishVideoToFacebook(body);
        return json(res, 200, result);
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/publish/instagram') {
      const rl = publishLimiter.check(clientIp);
      if (!rl.allowed) return json(res, 429, { error: `Too many requests. Retry in ${rl.retryAfterSec}s.` });
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        if (!isUuid(body.jobId)) return json(res, 400, { error: 'Invalid jobId.' });
        const result = await meta.publishReelToInstagram(body);
        return json(res, 200, result);
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    // ── Async Multi-Format Publish (prevents tunnel timeout + duplicate posts) ──
    if (req.method === 'POST' && url.pathname === '/api/publish/multi') {
      const rl = publishLimiter.check(clientIp);
      if (!rl.allowed) return json(res, 429, { error: `Too many requests. Retry in ${rl.retryAfterSec}s.` });
      let body;
      try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

      if (!isUuid(body.jobId)) {
        return json(res, 400, { error: 'Valid clip jobId is required.' });
      }

      const formats = body.formats || {};
      const selectedKeys = [
        formats.reel ? 'reel' : null,
        (formats.instagramReel || formats.igReel) ? 'instagramReel' : null,
        formats.imagePost ? 'imagePost' : null,
        formats.story ? 'story' : null
      ].filter(Boolean);

      if (!selectedKeys.length) {
        return json(res, 400, { error: 'Select at least one publish format.' });
      }

      // Deduplicate identical active publish jobs to prevent double posts from double-clicks
      const dedupeKey = `${body.jobId}:${body.pageId || ''}:${body.igUserId || ''}:${selectedKeys.join(',')}`;
      for (const existing of publishJobs.values()) {
        if (existing.dedupeKey === dedupeKey && existing.status === 'publishing') {
          return json(res, 202, {
            publishJobId: existing.id,
            status: existing.status,
            steps: existing.steps,
            deduplicated: true
          });
        }
      }

      // Pre-validate accounts & file existence before spawning background job
      try {
        const accounts = meta.loadAccounts();
        const requiresFb = Boolean(formats.reel || formats.imagePost || formats.story);
        const requiresIg = Boolean(formats.instagramReel || formats.igReel);
        if (requiresFb && (!accounts.facebook || !accounts.facebook.connected || !(accounts.facebook.pages || []).length)) {
          throw new Error('No Facebook Page connected. Please connect your Facebook account first.');
        }
        if (requiresIg && (!accounts.instagram || !accounts.instagram.connected || !(accounts.instagram.accounts || []).length)) {
          throw new Error('No Instagram account connected. Please connect an Instagram account first.');
        }
        const videoPath = safeResolveInside(EXPORTS, `${body.jobId}.mp4`);
        if (!fs.existsSync(videoPath)) throw new Error(`Video file for clip ${body.jobId} not found.`);
      } catch (e) {
        return json(res, 422, { error: e.message });
      }

      const publishJobId = crypto.randomUUID();
      const steps = {};
      for (const k of selectedKeys) {
        steps[k] = { status: 'pending', detail: 'Queued...' };
      }

      const pj = {
        id: publishJobId,
        dedupeKey,
        status: 'publishing',
        steps,
        result: null,
        error: null,
        startedAt: Date.now(),
        completedAt: null
      };
      publishJobs.set(publishJobId, pj);

      if (body.sync) {
        try {
          const result = await meta.publishMultiFormat({
            ...body,
            onProgress: (step, st, detail) => {
              if (pj.steps[step]) pj.steps[step] = { status: st, detail };
            }
          });
          pj.status = 'complete';
          pj.result = result;
          pj.completedAt = Date.now();
          return json(res, 200, result);
        } catch (e) {
          pj.status = 'failed';
          pj.error = e.message;
          pj.completedAt = Date.now();
          return json(res, 422, { error: e.message });
        }
      }

      // Run asynchronously and report live per-step status
      (async () => {
        try {
          const result = await meta.publishMultiFormat({
            ...body,
            onProgress: (step, st, detail) => {
              if (pj.steps[step]) pj.steps[step] = { status: st, detail };
            }
          });
          pj.status = 'complete';
          pj.result = result;
          pj.completedAt = Date.now();
        } catch (e) {
          pj.status = 'failed';
          pj.error = e.message;
          pj.completedAt = Date.now();
        }
      })();

      return json(res, 202, {
        publishJobId,
        status: pj.status,
        steps: pj.steps
      });
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'publish' && parts[2] === 'status' && parts[3]) {
      const publishJobId = parts[3];
      if (!isUuid(publishJobId)) return json(res, 400, { error: 'Invalid publishJobId.' });
      const pj = publishJobs.get(publishJobId);
      if (!pj) return json(res, 404, { error: 'Publish job not found or expired.' });
      return json(res, 200, {
        publishJobId: pj.id,
        status: pj.status,
        steps: pj.steps,
        result: pj.result,
        error: pj.error
      });
    }

    // ── Project Routes ───────────────────────────────────────
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
      if (!isUuid(parts[2])) return json(res, 400, { error: 'Invalid project ID.' });
      const project = getProject(parts[2]);
      if (!project) return json(res, 404, { error: 'Project not found.' });

      if (req.method === 'GET' && !parts[3]) {
        return json(res, 200, { project: sanitizeProject(project) });
      }

      if (req.method === 'PATCH' && !parts[3]) {
        let body;
        try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        const updated = await withProject(project.id, {
          name: body.name !== undefined ? safeName(body.name).replace(/_/g, ' ') : project.name
        });
        return json(res, 200, { ok: true, project: sanitizeProject(updated) });
      }

      if (req.method === 'DELETE' && !parts[3]) {
        await mutateProjects(all => {
          const idx = all.findIndex(p => p.id === project.id);
          if (idx >= 0) all.splice(idx, 1);
        });

        try {
          if (project.filename) {
            const videoFile = safeResolveInside(UPLOADS, project.filename);
            if (fs.existsSync(videoFile)) fs.rmSync(videoFile, { force: true });
          }
          for (const vtt of listProjectVttFiles(UPLOADS, project.id)) {
            if (fs.existsSync(vtt.file)) fs.rmSync(vtt.file, { force: true });
          }
          (project.autoClips || []).forEach(c => {
            cancelJob(c.jobId);
            removeClipArtifacts(c.jobId);
          });
        } catch (err) {
          console.warn('Cleanup error during project deletion:', err.message);
        }
        return json(res, 200, { ok: true, deleted: project.id });
      }

      if (req.method === 'DELETE' && parts[3] === 'clips' && parts[4]) {
        const clipId = parts[4];
        if (!isUuid(clipId)) return json(res, 400, { error: 'Invalid clip ID.' });
        await withProject(project.id, {
          autoClips: (project.autoClips || []).filter(c => c.jobId !== clipId)
        });
        cancelJob(clipId);
        removeClipArtifacts(clipId);
        return json(res, 200, { ok: true, deleted: clipId });
      }

      if (req.method === 'GET' && parts[3] === 'video') {
        const videoFile = safeResolveInside(UPLOADS, project.filename);
        return streamFile(req, res, videoFile, contentType(project.filename));
      }

      if (req.method === 'GET' && parts[3] === 'auto-jobs') {
        const clips = project.autoClips || [];
        const items = clips.map(clip => {
          const job = jobs.get(clip.jobId);
          const file = safeResolveInside(EXPORTS, `${clip.jobId}.mp4`);
          if (job) {
            return {
              jobId: clip.jobId,
              status: job.status,
              progress: job.progress || 0,
              error: job.error || null,
              downloadUrl: job.status === 'complete' ? `/api/jobs/${clip.jobId}/download` : null
            };
          }
          return fs.existsSync(file)
            ? { jobId: clip.jobId, status: 'complete', progress: 100, downloadUrl: `/api/jobs/${clip.jobId}/download` }
            : { jobId: clip.jobId, status: 'failed', progress: 0, error: 'Render did not persist across server restart.' };
        });
        const complete = items.filter(x => x.status === 'complete').length;
        const failed = items.filter(x => x.status === 'failed' || x.status === 'cancelled').length;
        const progress = items.length ? Math.round(items.reduce((s, x) => s + (x.status === 'complete' ? 100 : x.progress), 0) / items.length) : 0;
        return json(res, 200, { jobs: items, total: items.length, complete, failed, progress });
      }

      if (req.method === 'POST' && parts[3] === 'auto-shorts') {
        let body;
        try { body = await parseBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

        try {
          if (!Number(project.duration) || Number(project.duration) <= 0) {
            throw new Error('Source video duration is invalid or missing.');
          }
          const mode = body.mode === 'full' ? 'full' : 'highlights';
          const track = chooseCaptionTrack(UPLOADS, project, body.language || 'auto');
          const cues = track ? parseVtt(track.file) : [];
          let highlights = [];
          let aiUsed = false;
          let segmentSeconds = null;

          const partPattern = String(body.partPattern || 'Part-{n}').trim();
          const headerHook = String(body.headerHook || '').trim();
          const headerStyle = String(body.headerStyle || 'card').trim();
          const headerColor = String(body.headerColor || '#FFE500').trim();
          const bottomText = String(body.bottomText || '').trim();
          const framingMode = ['fit-bars', 'blur-bg', 'crop-fill'].includes(body.framingMode) ? body.framingMode : 'fit-bars';
          const zoom = Math.max(0.5, Math.min(2.0, Number(body.zoom) || 1.0));

          if (mode === 'full') {
            segmentSeconds = Math.max(10, Math.min(600, Number(body.segmentSeconds) || 60));
            const total = Math.ceil(project.duration / segmentSeconds);
            if (total > 500) {
              return json(res, 422, { error: `Would create ${total} clips. Increase segment length to at least ${Math.ceil(project.duration / 500)}s (max 500 clips).` });
            }
            for (let start = 0, index = 0; start < project.duration; start += segmentSeconds, index++) {
              const end = Math.min(project.duration, start + segmentSeconds);
              const partNum = index + 1;
              const partBadge = partPattern
                ? partPattern.replace(/\{n\}/gi, String(partNum)).replace(/\{pad\}/gi, String(partNum).padStart(3, '0'))
                : `Part-${partNum}`;
              highlights.push({
                start,
                end,
                score: null,
                selectionReason: 'Full-video sequential segment',
                title: partBadge || `Part ${String(partNum).padStart(3, '0')}`,
                partBadge,
                headerHook,
                headerStyle,
                headerColor,
                bottomText,
                captions: cues.filter(c => c.end > start && c.start < end)
              });
            }
          } else {
            if (!track) {
              return json(res, 422, { error: 'No captions found for this video. Use "Entire Video" mode instead, or choose a YouTube video with English/Hindi captions.' });
            }
            const wanted = Math.max(1, Math.min(50, Math.floor(Number(body.clipCount) || 3)));
            const targetDuration = Number(body.targetDuration) || 40;
            const pool = findHighlights(cues, project.duration, Math.min(100, wanted * 3), targetDuration);
            const aiRes = await rankWithLocalAi(pool, wanted);
            aiDiagnostic = aiRes.diagnostic || '';
            aiUsed = Boolean(aiRes.selected);
            highlights = aiRes.selected || pool.sort((a, b) => (b.score - a.score) || (a.start - b.start)).slice(0, wanted).sort((a, b) => a.start - b.start);

            for (let i = 0; i < highlights.length; i++) {
              const partNum = i + 1;
              highlights[i].partBadge = partPattern
                ? partPattern.replace(/\{n\}/gi, String(partNum)).replace(/\{pad\}/gi, String(partNum).padStart(3, '0'))
                : `Part ${partNum}`;
              highlights[i].headerHook = headerHook;
              highlights[i].headerStyle = headerStyle;
              highlights[i].headerColor = headerColor;
              highlights[i].bottomText = bottomText;
            }
          }

          // Clean up any previous auto-clips on this project before creating a new batch
          (project.autoClips || []).forEach(old => {
            cancelJob(old.jobId);
            removeClipArtifacts(old.jobId);
          });

          const style = body.style || { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom' };
          const ratio = parseRatio(body.ratio || '9:16');
          const resolution = body.resolution || '1080p';
          const watermark = body.watermark || null;
          const copyrightShield = body.copyrightShield || null;
          const captionMode = body.captionMode || 'Burned in';

          const created = highlights.map((h, i) => renderJob(project, {
            start: h.start,
            end: h.end,
            captions: h.captions,
            ratio,
            resolution,
            captionMode,
            framingMode,
            zoom,
            headerHook: h.headerHook || headerHook || null,
            headerStyle: h.headerStyle || headerStyle || 'card',
            headerColor: h.headerColor || headerColor || '#FFE500',
            bottomText: h.bottomText || bottomText || null,
            partBadge: h.partBadge || null,
            clipTitle: h.title,
            downloadName: `ClipMaster-${mode === 'full' ? 'Part' : 'Short'}-${String(i + 1).padStart(3, '0')}-${safeName(h.title).slice(0, 32)}.mp4`,
            style,
            watermark,
            copyrightShield
          }));

          const clips = created.map((j, i) => ({
            jobId: j.id,
            title: j.title,
            start: j.start,
            end: j.end,
            score: highlights[i].score,
            selectionReason: highlights[i].selectionReason || null,
            aiPicked: Boolean(highlights[i].aiPicked),
            downloadName: j.downloadName,
            headerHook: j.headerHook,
            headerStyle: j.headerStyle,
            headerColor: j.headerColor,
            bottomText: j.bottomText,
            partBadge: j.partBadge,
            framingMode: j.framingMode,
            zoom: j.zoom,
            ratio: j.ratio,
            speedShift: j.speedShift,
            captions: j.captions,
            downloadUrl: `/api/jobs/${j.id}/download`
          }));

          await withProject(project.id, {
            autoClips: clips,
            autoMode: mode,
            segmentSeconds,
            captionLanguage: track?.language || null,
            aiPicked: aiUsed
          });

          return json(res, 202, {
            projectId: project.id,
            mode,
            language: track?.language || null,
            aiUsed,
            aiDiagnostic,
            model: aiUsed ? (process.env.CLIPMASTER_AI_MODEL || 'qwen2.5:3b') : null,
            segmentSeconds,
            total: clips.length,
            clips
          });
        } catch (e) {
          return json(res, 422, { error: e.message });
        }
      }

      if (req.method === 'POST' && parts[3] === 'render') {
        let options;
        try { options = await parseBody(req, 4 * 1024 * 1024); } catch (e) { return json(res, 400, { error: e.message }); }

        try {
          if (options.clipJobId && !isUuid(options.clipJobId)) {
            return json(res, 400, { error: 'Invalid clipJobId.' });
          }

          const updatedName = String(options.projectName || '').trim();
          const renderProject = updatedName ? await withProject(project.id, { name: updatedName }) : project;
          const job = renderJob(renderProject, options);

          if (options.clipJobId && renderProject.autoClips && renderProject.autoClips.length) {
            const oldJobId = options.clipJobId;
            const updatedClips = renderProject.autoClips.map(c => {
              if (c.jobId !== oldJobId) return c;
              return {
                ...c,
                jobId: job.id,
                title: options.clipTitle || options.partBadge || c.title,
                partBadge: options.partBadge !== undefined ? options.partBadge : c.partBadge,
                headerHook: options.headerHook !== undefined ? options.headerHook : c.headerHook,
                headerStyle: options.headerStyle !== undefined ? options.headerStyle : c.headerStyle,
                headerColor: options.headerColor !== undefined ? options.headerColor : c.headerColor,
                bottomText: options.bottomText !== undefined ? options.bottomText : c.bottomText,
                framingMode: options.framingMode || c.framingMode,
                zoom: options.zoom !== undefined ? options.zoom : c.zoom,
                ratio: options.ratio || c.ratio,
                speedShift: job.speedShift,
                captions: job.captions,
                downloadUrl: `/api/jobs/${job.id}/download`
              };
            });
            await withProject(project.id, { autoClips: updatedClips });
            cancelJob(oldJobId);
            removeClipArtifacts(oldJobId);
          }

          return json(res, 202, {
            jobId: job.id,
            status: job.status,
            captionsCount: job.captions.length
          });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
    }

    // ── Job Routes ───────────────────────────────────────────
    if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
      const jobId = parts[2];
      if (!isUuid(jobId)) return json(res, 400, { error: 'Invalid job ID.' });

      if (req.method === 'POST' && parts[3] === 'cancel') {
        const cancelled = cancelJob(jobId);
        return json(res, cancelled ? 200 : 404, { ok: cancelled, jobId, status: cancelled ? 'cancelled' : 'not_cancellable' });
      }

      const job = jobs.get(jobId);
      if (!job) {
        const file = safeResolveInside(EXPORTS, `${jobId}.mp4`);
        const srtFile = safeResolveInside(EXPORTS, `${jobId}.srt`);
        const saved = loadProjects().flatMap(p => p.autoClips || []).find(c => c.jobId === jobId);
        if (saved && req.method === 'GET' && parts[3] === 'download' && fs.existsSync(file)) {
          return streamFile(req, res, file, 'video/mp4', saved.downloadName || `Short-${jobId.slice(0, 6)}.mp4`);
        }
        if (saved && req.method === 'GET' && parts[3] === 'captions' && fs.existsSync(srtFile)) {
          return streamFile(req, res, srtFile, 'application/x-subrip', `clipmaster-${jobId.slice(0, 6)}.srt`);
        }
        if (saved && req.method === 'GET' && !parts[3] && fs.existsSync(file)) {
          return json(res, 200, {
            id: jobId,
            title: saved.title,
            start: saved.start,
            end: saved.end,
            status: 'complete',
            progress: 100,
            downloadUrl: `/api/jobs/${jobId}/download`,
            subtitleUrl: fs.existsSync(srtFile) ? `/api/jobs/${jobId}/captions` : null
          });
        }
        return json(res, 404, { error: 'Render job not found.' });
      }

      if (req.method === 'GET' && parts[3] === 'download' && job.status === 'complete') {
        return streamFile(req, res, job.output, 'video/mp4', job.downloadName || `ClipMaster-${jobId.slice(0, 6)}.mp4`);
      }
      if (req.method === 'GET' && parts[3] === 'captions' && job.status === 'complete' && job.captionFile && fs.existsSync(job.captionFile)) {
        return streamFile(req, res, job.captionFile, 'application/x-subrip', `clipmaster-${job.projectId}.srt`);
      }
      if (req.method === 'GET' && !parts[3]) {
        return json(res, 200, {
          id: job.id,
          title: job.title,
          start: job.start,
          end: job.end,
          status: job.status,
          progress: job.progress,
          error: job.error || null,
          downloadUrl: job.status === 'complete' ? `/api/jobs/${job.id}/download` : null,
          subtitleUrl: job.status === 'complete' && job.captionFile ? `/api/jobs/${job.id}/captions` : null
        });
      }
    }

    return json(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(e => {
      if (!res.headersSent) json(res, 500, { error: e.message || 'Unexpected server error.' });
      else res.destroy(e);
    });
  });

  return {
    server,
    accessKey,
    cleanup: () => clearInterval(cleanupTimer),
    async init() {
      mediaToolsStatus = await checkMediaTools();
      return mediaToolsStatus;
    },
    meta,
    jobs,
    publishJobs,
    ytDownloads
  };
}

if (require.main === module) {
  loadDotEnv(__dirname);
  const PORT = Number(process.env.PORT || 4173);
  const app = createApp({ port: PORT });

  app.server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.log(`\nClipMaster is already running on port ${PORT}.\nOpen http://localhost:${PORT} in your browser.\n`);
      process.exit(0);
    }
    console.error(`ClipMaster failed to start: ${error.message}`);
    process.exit(1);
  });

  app.init().then(tools => {
    app.server.listen(PORT, '0.0.0.0', () => {
      const networkIps = getNetworkIps();
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  ✓ ClipMaster v2.0 is LIVE & READY');
      console.log(`  🖥️  PC / Local:       http://localhost:${PORT}`);
      if (networkIps.length) {
        networkIps.forEach(ip => {
          console.log(`  📱  Mobile / Network:  http://${ip}:${PORT}`);
        });
      }
      console.log(`  🔐  Remote Access Key: ${app.accessKey}`);
      if (tools.ffmpeg && tools.ffprobe) {
        console.log(`  🎬  Media tools ready: ffmpeg=true, ffprobe=true`);
      } else {
        console.warn(`  ⚠  Media tools check: ffmpeg=${tools.ffmpeg}, ffprobe=${tools.ffprobe}`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      if (process.env.FB_ACCESS_TOKEN && process.env.FB_ACCESS_TOKEN.trim()) {
        app.meta.verifyFacebookToken(process.env.FB_ACCESS_TOKEN.trim())
          .then(() => {
            console.log('  ✓ Meta / Facebook Accounts auto-connected via FB_ACCESS_TOKEN');
          })
          .catch(err => {
            console.log(`  ⚠ Auto-connect failed: ${err.message}`);
          });
      }
    });
  });
}

module.exports = { createApp };
