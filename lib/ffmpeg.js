'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { escapeAssText, resolveCrossPlatformFont } = require('./captions');

const execFileAsync = promisify(execFile);

const binCache = new Map();

function ensureDirInPath(dir) {
  if (!dir) return;
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  const current = process.env[pathKey] || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  const norm = p => path.resolve(p).toLowerCase();
  if (!parts.some(p => norm(p) === norm(dir))) {
    process.env[pathKey] = [dir, ...parts].join(path.delimiter);
  }
}

function findInPathDirs(binName, pathString) {
  if (!pathString) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = pathString.split(path.delimiter).map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binName.endsWith(ext) ? binName : binName + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

function findWindowsFallbackBinary(binName) {
  if (process.platform !== 'win32') return null;
  const exeName = binName.toLowerCase().endsWith('.exe') ? binName : `${binName}.exe`;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userProfile = process.env.USERPROFILE || os.homedir();

  // 1. Direct common locations
  const directCandidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exeName),
    path.join('C:', 'ffmpeg', 'bin', exeName),
    path.join('C:', 'ProgramData', 'chocolatey', 'bin', exeName),
    path.join(userProfile, 'scoop', 'shims', exeName),
    path.join('C:', 'Program Files', 'ffmpeg', 'bin', exeName),
    path.join('C:', 'Program Files (x86)', 'ffmpeg', 'bin', exeName)
  ];
  for (const c of directCandidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {}
  }

  // 2. Scan WinGet Packages for FFmpeg (e.g., Gyan.FFmpeg_...\ffmpeg-x.y-full_build\bin\ffmpeg.exe)
  const wingetPkgs = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  try {
    if (fs.existsSync(wingetPkgs)) {
      const pkgDirs = fs.readdirSync(wingetPkgs).filter(d => /ffmpeg/i.test(d));
      for (const pkg of pkgDirs) {
        const pkgPath = path.join(wingetPkgs, pkg);
        const directBin = path.join(pkgPath, 'bin', exeName);
        if (fs.existsSync(directBin)) return directBin;
        const subDirs = fs.readdirSync(pkgPath, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const sub of subDirs) {
          const nestedBin = path.join(pkgPath, sub.name, 'bin', exeName);
          if (fs.existsSync(nestedBin)) return nestedBin;
          const flatBin = path.join(pkgPath, sub.name, exeName);
          if (fs.existsSync(flatBin)) return flatBin;
        }
      }
    }
  } catch {}

  // 3. Query Windows Registry User/Machine PATH in case current process inherited a stale PATH
  try {
    const { execFileSync } = require('node:child_process');
    for (const regKey of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      try {
        const out = execFileSync('reg', ['query', regKey, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 1500 });
        const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
        if (m && m[1]) {
          const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
          const found = findInPathDirs(binName, expanded);
          if (found) return found;
        }
      } catch {}
    }
  } catch {}

  return null;
}

function resolveMediaBin(name) {
  const key = name.toLowerCase();
  const envVar = key === 'ffmpeg' ? process.env.FFMPEG_PATH : key === 'ffprobe' ? process.env.FFPROBE_PATH : null;
  if (envVar && String(envVar).trim()) {
    const cleanEnv = String(envVar).trim().replace(/^"|"$/g, '');
    if (fs.existsSync(cleanEnv)) {
      ensureDirInPath(path.dirname(cleanEnv));
      return cleanEnv;
    }
  }

  if (binCache.has(key)) return binCache.get(key);

  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  let resolved = findInPathDirs(name, process.env[pathKey]);

  if (!resolved && process.platform === 'win32') {
    resolved = findWindowsFallbackBinary(name);
  }

  if (resolved) {
    ensureDirInPath(path.dirname(resolved));
    binCache.set(key, resolved);
    return resolved;
  }

  return name;
}

function getFfmpegBin() {
  return resolveMediaBin('ffmpeg');
}

function getFfprobeBin() {
  return resolveMediaBin('ffprobe');
}

function resetMediaBinCache() {
  binCache.clear();
}

async function checkMediaTools() {
  const checkBin = async name => {
    const bin = resolveMediaBin(name);
    try {
      await execFileAsync(bin, ['-version'], { windowsHide: true, timeout: 8000 });
      return { ok: true, path: bin };
    } catch {
      return { ok: false, path: bin };
    }
  };
  const [ff, fp] = await Promise.all([checkBin('ffmpeg'), checkBin('ffprobe')]);
  return {
    ffmpeg: ff.ok,
    ffprobe: fp.ok,
    ffmpegPath: ff.ok ? ff.path : null,
    ffprobePath: fp.ok ? fp.path : null
  };
}

async function probe(file) {
  const { stdout } = await execFileAsync(getFfprobeBin(), [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name:format_tags=title:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json',
    file
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');

  if (!video) {
    throw new Error('No video stream found in file. The file may be corrupted or unsupported.');
  }

  return {
    duration: Math.max(0, Math.floor(Number(data.format?.duration || 0))),
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name || 'h264',
    audioCodec: audio ? (audio.codec_name || 'aac') : null,
    ext: path.extname(file).replace('.', '').toUpperCase() || 'MP4',
    size: Number(data.format?.size || 0),
    title: data.format?.tags?.title || path.parse(file).name
  };
}

function parseRatio(ratio) {
  return ['9:16', '1:1', '4:5', '16:9'].includes(ratio) ? ratio : '9:16';
}

function renderDimensions(ratio, resolution) {
  const res = resolution === '720p' ? 720 : 1080;
  if (ratio === '9:16') return { w: res === 1080 ? 1080 : 720, h: res === 1080 ? 1920 : 1280 };
  if (ratio === '4:5') return { w: res === 1080 ? 1080 : 720, h: res === 1080 ? 1350 : 900 };
  if (ratio === '1:1') return { w: res, h: res };
  return { w: res === 1080 ? 1920 : 1280, h: res };
}

function buildFramingFilter(framingMode, width, height, zoom, visualMod) {
  const preFilters = [];
  if (visualMod) {
    // 104% subtle micro-crop + micro color/contrast grading applied uniformly before framing
    preFilters.push('crop=trunc(in_w*0.96/2)*2:trunc(in_h*0.96/2)*2:(in_w-out_w)/2:(in_h-out_h)/2');
    preFilters.push('eq=contrast=1.03:brightness=0.01:saturation=1.04');
  }
  const pre = preFilters.length ? preFilters.join(',') + ',' : '';

  if (framingMode === 'blur-bg') {
    return `${pre}split=2[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},boxblur=25:5,drawbox=t=fill:c=black@0.45[bg2];` +
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg2];` +
      `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }

  if (framingMode === 'crop-fill') {
    if (zoom !== 1.0) {
      return `${pre}crop=trunc(in_w/${zoom}/2)*2:trunc(in_h/${zoom}/2)*2:(in_w-out_w)/2:(in_h-out_h)/2,` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`;
    }
    return `${pre}scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1`;
  }

  // fit-bars (Default clean letterbox: pad full WxH canvas FIRST, overlays render on full canvas SECOND)
  return `${pre}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

function buildRenderArgs({
  inputPath,
  outputPath,
  start,
  rawDuration,
  width,
  height,
  framingMode,
  zoom,
  assEscaped,
  shield,
  hasAudio = true,
  bgmPath = null
}) {
  const isShield = Boolean(shield && shield.enabled);
  const visualMod = Boolean(isShield && shield.visualMod);
  const speedShift = Boolean(isShield && shield.speedShift);
  const progressBar = Boolean(isShield && shield.progressBar);
  const speedFactor = speedShift ? 1.02 : 1.0;
  const targetDuration = rawDuration / speedFactor;

  const vPre = [buildFramingFilter(framingMode, width, height, zoom, visualMod)];
  // Burn subtitles/overlays BEFORE speedShift so dialogue stays synced to spoken audio
  if (assEscaped) {
    vPre.push(`ass='${assEscaped}'`);
  }

  const vPost = [];
  if (speedShift) {
    vPost.push('setpts=(1/1.02)*PTS');
  }
  vPost.push('format=yuv420p');

  const hasBgm = Boolean(isShield && bgmPath && fs.existsSync(bgmPath));

  // Build video graph cleanly (using color+overlay for animated progress bar so FFmpeg 9.x doesn't reject drawbox w=t)
  const buildVideoComplex = (inPad, outPad) => {
    if (!progressBar) {
      return `${inPad}${[...vPre, ...vPost].join(',')}${outPad}`;
    }
    return `${inPad}${vPre.join(',')}[vpre];` +
      `color=c=0xC8FF63@0.85:s=${width}x6,format=rgba[pbar];` +
      `[vpre][pbar]overlay=x='min(0,-w+w*(t/${rawDuration.toFixed(2)}))':y=H-8:shortest=1,${vPost.join(',')}${outPad}`;
  };

  if (hasBgm) {
    const fadeDuration = Math.max(0.5, Math.min(1.5, targetDuration / 4));
    const fadeOutStart = Math.max(0, targetDuration - fadeDuration);
    const bgmVol = Number(shield.bgmVolume || 0.12).toFixed(2);

    const filterComplexParts = [buildVideoComplex('[0:v]', '[vfinal]')];
    if (hasAudio) {
      filterComplexParts.push(`[0:a]${speedShift ? 'atempo=1.02' : 'anull'}[voice]`);
      filterComplexParts.push(`[1:a]volume=${bgmVol},afade=t=in:st=0:d=${fadeDuration.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration.toFixed(2)}[bgm]`);
      filterComplexParts.push('[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]');
    } else {
      filterComplexParts.push(`[1:a]volume=${bgmVol},afade=t=in:st=0:d=${fadeDuration.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration.toFixed(2)}[aout]`);
    }

    return {
      targetDuration,
      speedFactor,
      args: [
        '-y',
        '-ss', String(start),
        '-t', String(rawDuration),
        '-i', inputPath,
        '-stream_loop', '-1',
        '-i', bgmPath,
        '-filter_complex', filterComplexParts.join(';'),
        '-map', '[vfinal]',
        '-map', '[aout]',
        '-t', targetDuration.toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        outputPath
      ]
    };
  }

  const args = [
    '-y',
    '-ss', String(start),
    '-t', String(rawDuration),
    '-i', inputPath
  ];

  if (progressBar) {
    args.push('-filter_complex', buildVideoComplex('[0:v]', '[vfinal]'), '-map', '[vfinal]');
    if (hasAudio) args.push('-map', '0:a');
  } else {
    args.push('-vf', [...vPre, ...vPost].join(','));
  }

  if (hasAudio) {
    if (speedShift) args.push('-af', 'atempo=1.02');
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath
  );

  return { targetDuration, speedFactor, args };
}

async function generateQuoteImage({
  videoPath,
  quoteText,
  ratio = '1:1',
  watermark = null,
  outputPath = null,
  timestamp = 2.5,
  dataDir,
  previewsDir
}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found at ${videoPath}`);
  }

  const isPortrait = ratio === '4:5';
  const width = 1080;
  const height = isPortrait ? 1350 : 1080;
  const fgW = isPortrait ? 900 : 840;
  const fgH = isPortrait ? 540 : 480;
  const fgY = isPortrait ? 100 : 80;
  const quoteY = isPortrait ? 740 : 620;

  const cleanQuote = String(quoteText || 'Highlight moment from this clip')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const escapedQuote = escapeAssText(cleanQuote);
  const words = escapedQuote.split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length > 32)) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  const formattedQuote = lines.slice(0, 4).join('\\N');

  let wmRaw = '@ClipMaster';
  if (watermark && watermark.enabled && watermark.text) {
    wmRaw = String(watermark.text).trim();
  }
  const wmText = escapeAssText(wmRaw);
  const hasDevanagari = /[\u0900-\u097F]/.test(cleanQuote + wmRaw);
  const fontName = resolveCrossPlatformFont('Segoe UI', hasDevanagari);

  const assId = crypto.randomUUID();
  const assFile = path.join(dataDir, `quote_${assId}.ass`);

  const assContent = `\ufeff[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: QuoteMark, ${fontName}, 75, &H0063FFC8, &H000000FF, &H00000000, &H00000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 5, 120, 120, ${quoteY - 65}, 1
Style: QuoteText, ${fontName}, 40, &H00FFFFFF, &H000000FF, &H00000000, &H88000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 2, 3, 5, 120, 120, ${quoteY + 30}, 1
Style: AuthorWatermark, ${fontName}, 24, &H0063FFC8, &H000000FF, &H00000000, &HAA000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 1, 2, 2, 80, 80, ${isPortrait ? 80 : 60}, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,QuoteMark,,0,0,0,,“
Dialogue: 0,0:00:00.00,0:00:05.00,QuoteText,,0,0,0,,${formattedQuote}
Dialogue: 0,0:00:00.00,0:00:05.00,AuthorWatermark,,0,0,0,,${wmText}
`;

  fs.writeFileSync(assFile, assContent, 'utf8');
  const escapedAss = assFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");

  const finalOutput = outputPath || path.join(previewsDir, `quote_${crypto.randomUUID()}.jpg`);
  fs.mkdirSync(path.dirname(finalOutput), { recursive: true });

  const filter = `[0:v]split=2[bg][fg];` +
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=30:5,drawbox=t=fill:c=black@0.68[bg_dim];` +
    `[fg]scale=${fgW}:${fgH}:force_original_aspect_ratio=increase,crop=${fgW}:${fgH},pad=${fgW + 8}:${fgH + 8}:4:4:color=0x2b3442[fg_card];` +
    `[bg_dim][fg_card]overlay=(W-w)/2:${fgY}[comp];` +
    `[comp]ass='${escapedAss}'`;

  const ssTime = Math.max(0.5, Number(timestamp) || 2.5);
  const args = [
    '-y',
    '-ss', String(ssTime),
    '-i', videoPath,
    '-vf', filter,
    '-frames:v', '1',
    '-q:v', '2',
    finalOutput
  ];

  try {
    await execFileAsync(getFfmpegBin(), args, { windowsHide: true, timeout: 45000 });
  } finally {
    try { if (fs.existsSync(assFile)) fs.unlinkSync(assFile); } catch {}
  }

  return {
    outputPath: finalOutput,
    quoteText: cleanQuote,
    ratio,
    width,
    height
  };
}

module.exports = {
  resolveMediaBin,
  getFfmpegBin,
  getFfprobeBin,
  resetMediaBinCache,
  checkMediaTools,
  probe,
  parseRatio,
  renderDimensions,
  buildFramingFilter,
  buildRenderArgs,
  generateQuoteImage
};
