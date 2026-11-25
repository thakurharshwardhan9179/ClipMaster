'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let cachedLinuxFonts = null;

function getAvailableLinuxFonts() {
  if (cachedLinuxFonts !== null) return cachedLinuxFonts;
  if (process.platform === 'win32') {
    cachedLinuxFonts = new Set();
    return cachedLinuxFonts;
  }
  try {
    const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 3000 });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      for (const fam of line.split(',')) {
        const clean = fam.trim().toLowerCase();
        if (clean) set.add(clean);
      }
    }
    cachedLinuxFonts = set;
  } catch {
    cachedLinuxFonts = new Set();
  }
  return cachedLinuxFonts;
}

function resolveCrossPlatformFont(requestedFont, hasDevanagari = false) {
  const allowed = ['Nirmala UI', 'Segoe UI', 'Impact', 'Arial', 'Montserrat', 'Roboto', 'Manrope', 'DM Sans', 'Inter', 'Noto Sans', 'Noto Sans Devanagari', 'DejaVu Sans', 'Liberation Sans'];
  const cleanReq = allowed.includes(requestedFont) ? requestedFont : 'Nirmala UI';

  if (process.platform === 'win32') {
    if (hasDevanagari && ['Arial', 'Impact', 'DM Sans', 'Montserrat'].includes(cleanReq)) {
      return 'Nirmala UI';
    }
    return cleanReq;
  }

  const available = getAvailableLinuxFonts();
  if (available.has(cleanReq.toLowerCase()) && !hasDevanagari) {
    return cleanReq;
  }

  if (hasDevanagari) {
    const indicCandidates = ['Noto Sans Devanagari', 'Lohit Devanagari', 'Gargi', 'FreeSans', 'Noto Sans', 'DejaVu Sans'];
    for (const c of indicCandidates) {
      if (available.has(c.toLowerCase())) return c;
    }
    return 'Noto Sans Devanagari';
  }

  const latinMap = {
    'Nirmala UI': ['Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'FreeSans'],
    'Segoe UI': ['Noto Sans', 'Liberation Sans', 'DejaVu Sans'],
    'Impact': ['Liberation Sans', 'DejaVu Sans', 'Noto Sans'],
    'Arial': ['Liberation Sans', 'DejaVu Sans', 'Noto Sans'],
    'Montserrat': ['Noto Sans', 'Liberation Sans', 'DejaVu Sans'],
    'Roboto': ['Roboto', 'Noto Sans', 'Liberation Sans', 'DejaVu Sans'],
    'Manrope': ['Noto Sans', 'DejaVu Sans', 'Liberation Sans'],
    'DM Sans': ['Noto Sans', 'Liberation Sans', 'DejaVu Sans'],
    'Inter': ['Noto Sans', 'Liberation Sans', 'DejaVu Sans']
  };
  const candidates = latinMap[cleanReq] || ['Noto Sans', 'DejaVu Sans', 'Liberation Sans'];
  for (const c of candidates) {
    if (available.has(c.toLowerCase())) return c;
  }
  return 'DejaVu Sans';
}

function srtTime(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) * 1000));
  const ms = n % 1000;
  const all = Math.floor(n / 1000);
  return `${String(Math.floor(all / 3600)).padStart(2, '0')}:${String(Math.floor((all % 3600) / 60)).padStart(2, '0')}:${String(all % 60).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function assTime(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .trim();
}

function parseVtt(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const blocks = source.split(/\r?\n\s*\r?\n/);
  const cues = [];
  const toSec = s => {
    const p = s.trim().split(':');
    return (p.length === 3 ? Number(p[0]) * 3600 + Number(p[1]) * 60 : p.length === 2 ? Number(p[0]) * 60 : 0) + Number(p.at(-1).replace(',', '.'));
  };

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const ti = lines.findIndex(l => /\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(/([\d:.,]+)\s+-->\s+([\d:.,]+)/);
    if (!m) continue;
    const start = toSec(m[1]);
    const end = toSec(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    let text = lines.slice(ti + 1).join(' ')
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (end - start < 0.12 || !text) continue;
    // Skip non-speech sound markers alone if empty after stripping
    const prev = cues.at(-1);
    if (prev && text.toLowerCase() === prev.text.toLowerCase()) continue;
    if (prev && text.toLowerCase().startsWith(prev.text.toLowerCase())) {
      text = text.slice(prev.text.length).trim();
    }
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function listProjectVttFiles(uploadsDir, projectId) {
  if (!fs.existsSync(uploadsDir)) return [];
  const prefix = `${projectId}.`;
  return fs.readdirSync(uploadsDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.vtt'))
    .map(f => ({
      filename: f,
      file: path.join(uploadsDir, f),
      langCode: f.slice(prefix.length, -4) // e.g. 'en-orig', 'en-US', 'hi-IN'
    }));
}

function chooseCaptionTrack(uploadsDir, project, language = 'auto') {
  const available = listProjectVttFiles(uploadsDir, project.id);
  if (!available.length) return null;

  const langPriority = language === 'hi'
    ? ['hi-orig', 'hi', 'hi-IN']
    : language === 'en'
    ? ['en-orig', 'en', 'en-US', 'en-GB', 'en-IN']
    : ['en-orig', 'hi-orig', 'en', 'hi', 'en-US', 'en-GB', 'hi-IN', 'en-IN'];

  for (const lang of langPriority) {
    const match = available.find(a => a.langCode.toLowerCase() === lang.toLowerCase());
    if (match) {
      return {
        file: match.file,
        language: match.langCode.toLowerCase().startsWith('hi') ? 'hi' : 'en',
        langCode: match.langCode
      };
    }
  }

  if (language === 'auto') {
    const first = available[0];
    return {
      file: first.file,
      language: first.langCode.toLowerCase().startsWith('hi') ? 'hi' : 'en',
      langCode: first.langCode
    };
  }

  // Fallback prefix match (e.g. 'en-CA' when 'en' requested)
  const prefixMatch = available.find(a => a.langCode.toLowerCase().startsWith(language.toLowerCase()));
  if (prefixMatch) {
    return {
      file: prefixMatch.file,
      language: prefixMatch.langCode.toLowerCase().startsWith('hi') ? 'hi' : 'en',
      langCode: prefixMatch.langCode
    };
  }
  return null;
}

function groupCaptions(cues, start, end) {
  const source = cues
    .filter(c => Number(c.end) > start && Number(c.start) < end)
    .sort((a, b) => Number(a.start) - Number(b.start));
  const items = [];
  let prior = [];

  for (const cue of source) {
    let words = String(cue.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    let overlap = 0;
    for (let n = Math.min(5, prior.length, words.length); n > 0; n--) {
      if (prior.slice(-n).join(' ').toLowerCase() === words.slice(0, n).join(' ').toLowerCase()) {
        overlap = n;
        break;
      }
    }
    words = words.slice(overlap);
    if (!words.length) continue;
    prior = prior.concat(words).slice(-8);

    const text = words.join(' ');
    const last = items.at(-1);
    const endsSentence = last && /[.!?।॥]$/.test(last.text.trim());
    const gap = last ? Math.max(0, Number(cue.start) - last.end) : 0;

    if (
      last &&
      !endsSentence &&
      gap <= 0.6 &&
      (last.text.split(/\s+/).length + words.length <= 7) &&
      (Number(cue.end) - last.start <= 2.8) &&
      (last.text.length + 1 + text.length < 50)
    ) {
      last.text += ` ${text}`;
      last.end = Math.min(end, Number(cue.end));
    } else {
      items.push({
        start: Math.max(start, Number(cue.start)),
        end: Math.min(end, Number(cue.end)),
        text
      });
    }
  }
  return items;
}

function visualCharLength(str) {
  return String(str || '').replace(/[\u0300-\u036f\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962\u0963]/g, '').length;
}

function assWrap(text, maxChars = 24, maxLines = 3) {
  const words = escapeAssText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && visualCharLength(line) + 1 + visualCharLength(word) > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line += (line ? ' ' : '') + word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).join('\\N');
}

function toSrt(lines, offset, clipEnd, speedFactor = 1.0) {
  const factor = Number(speedFactor) > 0 ? Number(speedFactor) : 1.0;
  return lines
    .filter(c => Number(c.end) > offset && Number(c.start) < clipEnd)
    .map((line, i) => {
      const relStart = Math.max(0, Number(line.start) - offset) / factor;
      const relEnd = Math.min(clipEnd - offset, Number(line.end) - offset) / factor;
      return `${i + 1}\n${srtTime(relStart)} --> ${srtTime(relEnd)}\n${String(line.text || '').replace(/[<>]/g, '').trim()}\n`;
    })
    .join('\n');
}

function hexToAssColor(hex, opacity = 1) {
  const clean = String(hex || '#FFFFFF').replace('#', '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6).padEnd(6, 'F');
  const alphaInt = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)));
  const aa = alphaInt.toString(16).padStart(2, '0').toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const r = clean.slice(0, 2).toUpperCase();
  return `&H${aa}${b}${g}${r}`;
}

function computeCanvasLayout(width = 1080, height = 1920, framingMode = 'fit-bars', stylePos = 'Bottom', flags = {}) {
  const isTall916 = height >= width * 1.5;
  const isPortrait45 = !isTall916 && height > width;
  const mode = framingMode || 'fit-bars';
  const isBarFramed = (isTall916 || isPortrait45) && (mode === 'fit-bars' || mode === 'blur-bg');
  const cx = Math.round(width / 2);
  const marginH = Math.round(0.055 * width);
  const hasLowerOverlays = Boolean(flags.hasBottomText || flags.hasPartBadge);

  if (isTall916) {
    const wmTopY = Math.round(0.042 * height);
    const wmBotY = Math.round(0.838 * height);
    const hook = isBarFramed
      ? { an: 8, x: cx, y: Math.round(0.135 * height), maxChars: 22, maxLines: 4 }
      : { an: 8, x: cx, y: Math.round(0.115 * height), maxChars: 22, maxLines: 3 };

    let subtitle;
    if (stylePos === 'Top') {
      subtitle = {
        an: 8,
        x: cx,
        y: flags.hasHeaderHook ? Math.round(0.255 * height) : Math.round(0.155 * height),
        maxChars: 26,
        maxLines: 2
      };
    } else if (stylePos === 'Middle') {
      subtitle = { an: 5, x: cx, y: Math.round(0.50 * height), maxChars: 24, maxLines: 3 };
    } else if (isBarFramed) {
      // Top-anchored cleanly below 16:9 bottom edge (0.6583 * H) so wrapped lines never enter the video frame
      subtitle = { an: 8, x: cx, y: Math.round(0.680 * height), maxChars: 26, maxLines: 3 };
    } else {
      subtitle = {
        an: 2,
        x: cx,
        y: hasLowerOverlays ? Math.round(0.755 * height) : Math.round(0.820 * height),
        maxChars: 24,
        maxLines: 3
      };
    }

    return {
      isTall916,
      isPortrait45,
      isBarFramed,
      cx,
      marginH,
      wmTopY,
      wmBotY,
      videoTopY: isBarFramed ? Math.round(0.3417 * height) : 0,
      videoBottomY: isBarFramed ? Math.round(0.6583 * height) : height,
      hook,
      subtitle,
      bottomText: { an: 8, x: cx, y: Math.round(0.772 * height), maxChars: 28, maxLines: 2 },
      partBadge: { an: 5, x: cx, y: Math.round(0.885 * height) }
    };
  }

  if (isPortrait45) {
    const wmTopY = Math.round(0.035 * height);
    const wmBotY = Math.round(0.895 * height);
    let subtitle;
    if (stylePos === 'Top') {
      subtitle = { an: 8, x: cx, y: flags.hasHeaderHook ? Math.round(0.21 * height) : Math.round(0.12 * height), maxChars: 28, maxLines: 2 };
    } else if (stylePos === 'Middle') {
      subtitle = { an: 5, x: cx, y: Math.round(0.50 * height), maxChars: 28, maxLines: 3 };
    } else if (isBarFramed) {
      subtitle = { an: 8, x: cx, y: Math.round(0.742 * height), maxChars: 28, maxLines: 2 };
    } else {
      subtitle = { an: 2, x: cx, y: hasLowerOverlays ? Math.round(0.80 * height) : Math.round(0.88 * height), maxChars: 28, maxLines: 2 };
    }
    return {
      isTall916,
      isPortrait45,
      isBarFramed,
      cx,
      marginH,
      wmTopY,
      wmBotY,
      videoTopY: isBarFramed ? Math.round(0.275 * height) : 0,
      videoBottomY: isBarFramed ? Math.round(0.725 * height) : height,
      hook: { an: 8, x: cx, y: Math.round(0.085 * height), maxChars: 26, maxLines: 3 },
      subtitle,
      bottomText: { an: 8, x: cx, y: Math.round(0.838 * height), maxChars: 30, maxLines: 2 },
      partBadge: { an: 5, x: cx, y: Math.round(0.942 * height) }
    };
  }

  // 1:1 Square or 16:9 Landscape
  const wmTopY = Math.round(0.045 * height);
  const wmBotY = Math.round(0.945 * height);
  const maxC = width > height * 1.2 ? 44 : 30;
  let subtitle;
  if (stylePos === 'Top') {
    subtitle = { an: 8, x: cx, y: flags.hasHeaderHook ? Math.round(0.18 * height) : Math.round(0.07 * height), maxChars: maxC, maxLines: 2 };
  } else if (stylePos === 'Middle') {
    subtitle = { an: 5, x: cx, y: Math.round(0.50 * height), maxChars: maxC, maxLines: 2 };
  } else {
    subtitle = { an: 2, x: cx, y: hasLowerOverlays ? Math.round(0.79 * height) : Math.round(0.90 * height), maxChars: maxC, maxLines: 2 };
  }
  return {
    isTall916,
    isPortrait45,
    isBarFramed: false,
    cx,
    marginH,
    wmTopY,
    wmBotY,
    videoTopY: 0,
    videoBottomY: height,
    hook: { an: 8, x: cx, y: Math.round(0.055 * height), maxChars: maxC, maxLines: 2 },
    subtitle,
    bottomText: { an: 8, x: cx, y: Math.round(0.825 * height), maxChars: maxC + 4, maxLines: 2 },
    partBadge: { an: 5, x: cx, y: Math.round(0.925 * height) }
  };
}

function buildWatermarkStyle(wm, width, height, hasDevanagari = false, layout = null) {
  if (!wm || !wm.enabled || !String(wm.text || '').trim()) return { styleStr: '', safeText: '', posTag: '' };

  const posKey = String(wm.position || 'top-right').toLowerCase();
  const posMap = {
    'top-left': 7, 'top-center': 8, 'top-right': 9,
    'bottom-left': 4, 'bottom-center': 5, 'bottom-right': 6
  };
  const align = posMap[posKey] || 9;

  const scale = height / 1920;
  const sizeMap = { small: Math.round(32 * scale), medium: Math.round(40 * scale), large: Math.round(50 * scale) };
  const fontSize = Math.max(16, sizeMap[wm.size] || Math.round(40 * scale));
  const primaryCol = hexToAssColor(wm.color || '#FFFFFF', wm.opacity ?? 0.85);
  const font = resolveCrossPlatformFont('Nirmala UI', hasDevanagari || /[\u0900-\u097F]/.test(String(wm.text)));

  let borderStyle = 1;
  let outline = Math.max(1, Math.round(2 * scale));
  let shadow = Math.max(1, Math.round(2 * scale));
  let outlineCol = '&H60000000';
  let backCol = '&H80000000';

  if (wm.background === 'pill' || wm.background === 'box') {
    borderStyle = 3;
    outline = Math.max(4, Math.round(8 * scale));
    shadow = 0;
    backCol = '&H90000000';
    outlineCol = '&H90000000';
  } else if (wm.shadow === 'outline') {
    borderStyle = 1;
    outline = Math.max(2, Math.round(3 * scale));
    shadow = 0;
    outlineCol = '&H00000000';
  } else if (wm.shadow === 'none') {
    borderStyle = 1;
    outline = 0;
    shadow = 0;
  }

  const resolvedLayout = layout || computeCanvasLayout(width, height, 'fit-bars', 'Bottom', {});
  const marginH = resolvedLayout.marginH;
  const isBottom = posKey.startsWith('bottom-');
  const wmY = isBottom ? resolvedLayout.wmBotY : resolvedLayout.wmTopY;
  const wmX = posKey.endsWith('-left') ? marginH : posKey.endsWith('-center') ? resolvedLayout.cx : (width - marginH);
  const marginV = isBottom ? Math.max(12, height - wmY) : wmY;
  const styleStr = `Style: Watermark,${font},${fontSize},${primaryCol},${primaryCol},${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${align},${marginH},${marginH},${marginV},1`;
  const safeText = escapeAssText(wm.text);
  const posTag = `{\\an${align}\\pos(${wmX},${wmY})}`;
  return { styleStr, safeText, posTag };
}

function buildKaraokeLine(text, durationSec, maxChars = 24, maxLines = 3) {
  const words = escapeAssText(text).split(/\s+/).filter(Boolean);
  if (!words.length) return '';

  const totalCs = Math.max(10, Math.round(durationSec * 100));
  const totalWeight = words.reduce((s, w) => s + Math.max(2, visualCharLength(w)), 0);

  let remainingCs = totalCs;
  const wrappedLines = [];
  let currentLine = '';
  let currentLen = 0;

  words.forEach((word, idx) => {
    const isLast = idx === words.length - 1;
    const wLen = visualCharLength(word);
    const cs = isLast
      ? Math.max(5, remainingCs)
      : Math.max(5, Math.round((Math.max(2, wLen) / totalWeight) * totalCs));
    remainingCs = Math.max(0, remainingCs - cs);

    const token = `{\\kf${cs}}${word}`;
    if (currentLine && currentLen + 1 + wLen > maxChars) {
      wrappedLines.push(currentLine);
      currentLine = token;
      currentLen = wLen;
    } else {
      currentLine += (currentLine ? ' ' : '') + token;
      currentLen += (currentLen ? 1 : 0) + wLen;
    }
  });

  if (currentLine) wrappedLines.push(currentLine);
  return wrappedLines.slice(0, maxLines).join('\\N');
}

function toAss(lines, offset, clipEnd, style = {}, width = 1080, height = 1920, watermark = null, overlay = {}) {
  const hasHeaderHook = Boolean(overlay.headerHook && String(overlay.headerHook).trim());
  const hasBottomText = Boolean(overlay.bottomText && String(overlay.bottomText).trim());
  const hasPartBadge = Boolean(overlay.partBadge && String(overlay.partBadge).trim());

  const allTexts = [
    ...lines.map(c => String(c.text || '')),
    overlay.headerHook || '',
    overlay.bottomText || '',
    overlay.partBadge || ''
  ];
  const hasHindi = allTexts.some(txt => /[\u0900-\u097F]/.test(txt));
  const font = resolveCrossPlatformFont(style.font || 'Nirmala UI', hasHindi);

  const scale = Math.min(width / 1080, height / 1920);
  const scaleY = height / 1920;
  const posType = style.position || 'Bottom';
  const layout = computeCanvasLayout(width, height, overlay.framingMode || 'fit-bars', posType, {
    hasHeaderHook,
    hasBottomText,
    hasPartBadge
  });

  const userSize = Number(style.size) || 72;
  // On 9:16 letterboxed/blur-bar mode, keep subtitles crisp inside the lower black bar without overflowing into video or BottomText
  const sizeRatio = layout.isBarFramed ? 0.65 : 0.90;
  const minPx = layout.isBarFramed ? 36 : 42;
  const maxPx = layout.isBarFramed ? 58 : 92;
  const size = Math.round(Math.max(minPx, Math.min(maxPx, userSize * sizeRatio)) * Math.max(0.5, scaleY));

  const useKaraoke = Boolean(style.karaoke);
  const activeHex = style.color || '#FFFFFF';
  // In karaoke mode, SecondaryColour is unspoken (white) and PrimaryColour sweeps to highlight color (lime if white was selected)
  const primaryHex = useKaraoke && activeHex.toLowerCase() === '#ffffff' ? '#C8FF63' : activeHex;
  const primaryAssColor = hexToAssColor(primaryHex, 1);
  const secondaryAssColor = useKaraoke ? '&H00FFFFFF' : primaryAssColor;

  const bgType = style.background || 'Pill';
  let borderStyle = 1;
  let outline = Math.max(1, Math.round(3 * scaleY));
  let shadow = Math.max(1, Math.round(2 * scaleY));
  let outlineCol = '&H00000000';
  let backCol = '&H80000000';

  if (bgType === 'Pill') {
    borderStyle = 3;
    outline = Math.max(4, Math.round(8 * scaleY));
    shadow = 0;
    outlineCol = '&HA0000000';
    backCol = '&HA0000000';
  } else if (bgType === 'Outline') {
    borderStyle = 1;
    outline = Math.max(2, Math.round(4 * scaleY));
    shadow = 0;
    outlineCol = '&H00000000';
    backCol = '&H00000000';
  } else if (bgType === 'Shadow') {
    borderStyle = 1;
    outline = Math.max(1, Math.round(2 * scaleY));
    shadow = Math.max(2, Math.round(4 * scaleY));
    outlineCol = '&H00000000';
    backCol = '&HB0000000';
  } else if (bgType === 'None') {
    borderStyle = 1;
    outline = Math.max(1, Math.round(1.5 * scaleY));
    shadow = Math.max(1, Math.round(1.5 * scaleY));
    outlineCol = '&H00000000';
    backCol = '&H80000000';
  }

  const subPos = layout.subtitle;
  const alignment = subPos.an;
  const marginV = alignment === 2 ? Math.max(12, height - subPos.y) : alignment === 8 ? subPos.y : 0;
  const marginH = layout.marginH;
  const maxWrapChars = subPos.maxChars;
  const maxWrapLines = subPos.maxLines;

  const { styleStr: wmStyle, safeText: wmText, posTag: wmPosTag } = buildWatermarkStyle(watermark, width, height, hasHindi, layout);

  let head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${size},${primaryAssColor},${secondaryAssColor},${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1\n`;

  if (wmStyle) head += wmStyle + '\n';

  let safeHook = '';
  if (hasHeaderHook) {
    const hookStyleMode = overlay.headerStyle || 'card';
    const hookHex = hookStyleMode === 'white' ? '#FFFFFF' : (overlay.headerColor || '#FFE500');
    const hookCol = hexToAssColor(hookHex, 1);
    safeHook = assWrap(overlay.headerHook, layout.hook.maxChars, layout.hook.maxLines);
    const hookLineCount = safeHook.split('\\N').length;
    const baseHookPx = Math.min(62, (Number(overlay.headerSize) || 74) * 0.80);
    const compactFactor = hookLineCount >= 3 ? 0.84 : 1.0;
    const hookFontSize = Math.max(22, Math.round(baseHookPx * compactFactor * Math.max(0.5, scaleY)));
    const hookFont = resolveCrossPlatformFont(hasHindi ? 'Nirmala UI' : 'Montserrat', hasHindi);
    const hookMarginV = layout.hook.y;

    if (hookStyleMode === 'card') {
      const boxOutline = Math.max(5, Math.round(11 * scaleY));
      head += `Style: HeaderHook,${hookFont},${hookFontSize},&H00000000,&H00000000,${hookCol},${hookCol},-1,0,0,0,100,100,0,0,3,${boxOutline},0,${layout.hook.an},${marginH},${marginH},${hookMarginV},1\n`;
    } else {
      const hookOutline = Math.max(2, Math.round(5 * scaleY));
      const hookShadow = Math.max(1, Math.round(2 * scaleY));
      head += `Style: HeaderHook,${hookFont},${hookFontSize},${hookCol},${hookCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${hookOutline},${hookShadow},${layout.hook.an},${marginH},${marginH},${hookMarginV},1\n`;
    }
  }

  if (hasBottomText) {
    const btmCol = hexToAssColor(overlay.bottomColor || '#FFFFFF', 1);
    const btmFontSize = Math.max(18, Math.round(Math.min(48, (Number(overlay.bottomSize) || 64) * 0.72) * Math.max(0.5, scaleY)));
    const btmFont = resolveCrossPlatformFont(hasHindi ? 'Nirmala UI' : 'Montserrat', hasHindi);
    const btmMarginV = layout.bottomText.an === 8 ? layout.bottomText.y : Math.max(12, height - layout.bottomText.y);
    const btmOutline = Math.max(2, Math.round(4 * scaleY));
    const btmShadow = Math.max(1, Math.round(2 * scaleY));
    head += `Style: BottomText,${btmFont},${btmFontSize},${btmCol},${btmCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${btmOutline},${btmShadow},${layout.bottomText.an},${marginH},${marginH},${btmMarginV},1\n`;
  }

  if (hasPartBadge) {
    const partCol = hexToAssColor(overlay.partColor || '#FFFFFF', 1);
    const partFontSize = Math.max(20, Math.round(Math.min(48, (Number(overlay.partSize) || 62) * 0.75) * Math.max(0.5, scaleY)));
    const partFont = resolveCrossPlatformFont(hasHindi ? 'Nirmala UI' : 'Impact', hasHindi);
    const partMarginV = Math.max(12, height - layout.partBadge.y);
    const partOutline = Math.max(2, Math.round(4 * scaleY));
    const partShadow = Math.max(1, Math.round(2 * scaleY));
    head += `Style: PartBadge,${partFont},${partFontSize},${partCol},${partCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${partOutline},${partShadow},${layout.partBadge.an},${marginH},${marginH},${partMarginV},1\n`;
  }

  head += `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const totalDuration = Math.max(0.1, clipEnd - offset);

  if (wmStyle && wmText) {
    head += `Dialogue: 1,0:00:00.00,${assTime(totalDuration)},Watermark,,0,0,0,,${wmPosTag}${wmText}\n`;
  }

  if (hasHeaderHook && safeHook) {
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},HeaderHook,,0,0,0,,{\\an${layout.hook.an}\\pos(${layout.hook.x},${layout.hook.y})}${safeHook}\n`;
  }

  if (hasBottomText) {
    const safeBtm = assWrap(overlay.bottomText, layout.bottomText.maxChars, layout.bottomText.maxLines);
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},BottomText,,0,0,0,,{\\an${layout.bottomText.an}\\pos(${layout.bottomText.x},${layout.bottomText.y})}${safeBtm}\n`;
  }

  if (hasPartBadge) {
    const safePart = escapeAssText(overlay.partBadge);
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},PartBadge,,0,0,0,,{\\an${layout.partBadge.an}\\pos(${layout.partBadge.x},${layout.partBadge.y})}${safePart}\n`;
  }

  const subPosTag = `{\\an${subPos.an}\\pos(${subPos.x},${subPos.y})}`;
  const events = lines
    .filter(c => Number(c.end) > offset && Number(c.start) < clipEnd && String(c.text || '').trim())
    .map(c => {
      const relStart = Math.max(0, Number(c.start) - offset);
      const relEnd = Math.min(clipEnd - offset, Number(c.end) - offset);
      const lineBody = useKaraoke
        ? buildKaraokeLine(c.text, Math.max(0.1, relEnd - relStart), maxWrapChars, maxWrapLines)
        : assWrap(c.text, maxWrapChars, maxWrapLines);
      return `Dialogue: 0,${assTime(relStart)},${assTime(relEnd)},Default,,0,0,0,,${subPosTag}${lineBody}`;
    })
    .join('\n');

  return head + events + '\n';
}

module.exports = {
  resolveCrossPlatformFont,
  srtTime,
  assTime,
  escapeAssText,
  parseVtt,
  listProjectVttFiles,
  chooseCaptionTrack,
  groupCaptions,
  assWrap,
  toSrt,
  hexToAssColor,
  computeCanvasLayout,
  buildWatermarkStyle,
  buildKaraokeLine,
  toAss
};
