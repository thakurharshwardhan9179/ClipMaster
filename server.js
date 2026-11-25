'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const EXPORTS = path.join(DATA, 'exports');
const PREVIEWS = path.join(EXPORTS, 'previews');
const DB_FILE = path.join(DATA, 'projects.json');
const BGM_DIR = path.join(ROOT, 'assets', 'bgm');
if (!fs.existsSync(BGM_DIR)) fs.mkdirSync(BGM_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const MAX_PARALLEL_RENDERS = 2;

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

// ── In-memory job store & render queue ─────────────────────
const jobs = new Map();
const renderQueue = [];
let activeRenders = 0;
let aiDiagnostic = '';

// ── Ensure data directories exist ──────────────────────────
for (const dir of [DATA, UPLOADS, EXPORTS, PREVIEWS]) fs.mkdirSync(dir, { recursive: true });

// ── DB helpers ──────────────────────────────────────────────
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveProjects(items) {
  fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2));
}
function getProject(id) { return loadProjects().find(p => p.id === id) || null; }
function withProject(id, update) {
  const all = loadProjects();
  const index = all.findIndex(p => p.id === id);
  if (index < 0) return null;
  all[index] = { ...all[index], ...update, updatedAt: new Date().toISOString() };
  saveProjects(all);
  return all[index];
}

// ── Social Accounts & Facebook/Instagram Helpers ─────────────
function loadAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return { facebook: null, instagram: null };
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : { facebook: null, instagram: null };
  } catch {
    return { facebook: null, instagram: null };
  }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function publicAccounts() {
  const acc = loadAccounts();
  const fbConnected = Boolean(acc.facebook && acc.facebook.connected);
  const igAccounts = (acc.instagram && Array.isArray(acc.instagram.accounts)) ? acc.instagram.accounts : [];
  const igConnected = Boolean(acc.instagram && acc.instagram.connected && igAccounts.length > 0);

  return {
    facebook: {
      connected: fbConnected,
      connectedAt: fbConnected ? acc.facebook.connectedAt : null,
      user: fbConnected ? (acc.facebook.user || null) : null,
      pages: fbConnected ? (acc.facebook.pages || []).map(p => ({
        id: p.id,
        name: p.name,
        category: p.category || 'Facebook Page',
        hasToken: Boolean(p.access_token),
        instagramAccount: p.instagram_business_account ? {
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username || p.name,
          name: p.instagram_business_account.name || p.instagram_business_account.username || p.name,
          profile_picture_url: p.instagram_business_account.profile_picture_url || null
        } : null
      })) : []
    },
    instagram: {
      connected: igConnected,
      connectedAt: igConnected ? acc.instagram.connectedAt : null,
      accounts: igAccounts.map(a => ({
        id: a.id,
        username: a.username,
        name: a.name || a.username,
        profile_picture_url: a.profile_picture_url || null,
        pageId: a.pageId || null,
        pageName: a.pageName || null
      }))
    }
  };
}

async function verifyFacebookToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) throw new Error('Facebook Access Token is required.');

  // 1. Verify entity identity via Graph API (only request fields common to User and Page: id, name)
  const meRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15000)
  });
  const meData = await meRes.json();
  if (meData.error) {
    throw new Error(meData.error.message || 'Invalid or expired Facebook Access Token.');
  }

  // 2. Check if token can access /me/accounts (User token with managed Pages & linked Instagram accounts)
  let pages = [];
  let accountsError = null;
  try {
    const pagesRes = await fetch(`https://graph.facebook.com/v20.0/me/accounts?fields=id,name,category,access_token,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000)
    });
    const pagesData = await pagesRes.json();
    if (pagesData.error) {
      accountsError = pagesData.error.message;
    } else if (pagesData.data && Array.isArray(pagesData.data) && pagesData.data.length > 0) {
      pages = pagesData.data.map(p => ({
        id: p.id,
        name: p.name,
        category: p.category || 'Facebook Page',
        access_token: p.access_token || token,
        instagram_business_account: p.instagram_business_account || null
      }));
    }
  } catch (err) {
    accountsError = err.message;
  }

  // 3. Fallback per page to query linked Instagram account if not returned by batch /me/accounts
  for (const p of pages) {
    if (!p.instagram_business_account) {
      try {
        const pageIgRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(p.id)}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(p.access_token || token)}`, {
          signal: AbortSignal.timeout(6000)
        });
        const pageIgData = await pageIgRes.json();
        if (pageIgData && pageIgData.instagram_business_account && pageIgData.instagram_business_account.id) {
          p.instagram_business_account = pageIgData.instagram_business_account;
        }
      } catch {}
    }
  }

  // 4. If no pages returned via /me/accounts, check if this token itself is a direct Page token
  if (pages.length === 0) {
    let isDirectPage = false;
    let pageCategory = 'Facebook Page';
    let directIgAccount = null;
    try {
      const pageCheckRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=category,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(8000)
      });
      const pageCheckData = await pageCheckRes.json();
      if (!pageCheckData.error && pageCheckData.category) {
        isDirectPage = true;
        pageCategory = pageCheckData.category;
        directIgAccount = pageCheckData.instagram_business_account || null;
      }
    } catch {}

    if (isDirectPage) {
      pages.push({
        id: meData.id,
        name: meData.name || 'Facebook Page',
        category: pageCategory,
        access_token: token,
        instagram_business_account: directIgAccount
      });
    } else {
      const hint = accountsError
        ? ` (${accountsError})`
        : `. Please ensure your token includes the 'pages_show_list' and 'pages_manage_posts' permissions, or select your Page from the Graph API Explorer dropdown.`;
      throw new Error(`Connected to Facebook user "${meData.name}", but no accessible Facebook Pages were found${hint}`);
    }
  }

  // 5. Gather all connected Instagram Professional Accounts
  const igAccounts = [];
  for (const p of pages) {
    if (p.instagram_business_account && p.instagram_business_account.id) {
      if (!igAccounts.some(a => a.id === p.instagram_business_account.id)) {
        igAccounts.push({
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username || p.name,
          name: p.instagram_business_account.name || p.instagram_business_account.username || p.name,
          profile_picture_url: p.instagram_business_account.profile_picture_url || null,
          pageId: p.id,
          pageName: p.name,
          access_token: p.access_token || token
        });
      }
    }
  }

  const accounts = loadAccounts();
  accounts.facebook = {
    connected: true,
    connectedAt: new Date().toISOString(),
    user: {
      id: meData.id,
      name: meData.name
    },
    userAccessToken: token,
    pages
  };
  accounts.instagram = {
    connected: igAccounts.length > 0,
    connectedAt: igAccounts.length > 0 ? new Date().toISOString() : null,
    accounts: igAccounts
  };
  saveAccounts(accounts);
  return publicAccounts();
}

async function refreshInstagramAccounts() {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('Please connect your Facebook account first.');
  }

  const pages = accounts.facebook.pages || [];
  const token = accounts.facebook.userAccessToken;
  const igAccounts = [];

  for (const page of pages) {
    const pToken = page.access_token || token;
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(pToken)}`, {
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      if (data && data.instagram_business_account && data.instagram_business_account.id) {
        page.instagram_business_account = data.instagram_business_account;
        if (!igAccounts.some(a => a.id === data.instagram_business_account.id)) {
          igAccounts.push({
            id: data.instagram_business_account.id,
            username: data.instagram_business_account.username || page.name,
            name: data.instagram_business_account.name || data.instagram_business_account.username || page.name,
            profile_picture_url: data.instagram_business_account.profile_picture_url || null,
            pageId: page.id,
            pageName: page.name,
            access_token: pToken
          });
        }
      }
    } catch (err) {
      console.warn(`[Refresh IG] Check failed for page ${page.id}:`, err.message);
    }
  }

  accounts.instagram = {
    connected: igAccounts.length > 0,
    connectedAt: igAccounts.length > 0 ? new Date().toISOString() : null,
    accounts: igAccounts
  };
  saveAccounts(accounts);
  return publicAccounts();
}

async function linkManualInstagramAccount({ igUserId, pageId }) {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('Please connect your Facebook account first.');
  }
  const pages = accounts.facebook.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (!page) throw new Error('Facebook Page not found.');

  const pToken = page.access_token || accounts.facebook.userAccessToken;
  const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(igUserId)}?fields=id,username,name,profile_picture_url&access_token=${encodeURIComponent(pToken)}`, {
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || 'Could not verify Instagram Account ID with current token.');
  }

  if (!accounts.instagram) accounts.instagram = { connected: true, accounts: [] };
  accounts.instagram.connected = true;
  accounts.instagram.connectedAt = new Date().toISOString();
  if (!accounts.instagram.accounts) accounts.instagram.accounts = [];

  const newAccount = {
    id: data.id,
    username: data.username || data.name || igUserId,
    name: data.name || data.username || igUserId,
    profile_picture_url: data.profile_picture_url || null,
    pageId: page.id,
    pageName: page.name,
    access_token: pToken
  };

  const existingIdx = accounts.instagram.accounts.findIndex(a => a.id === data.id);
  if (existingIdx >= 0) {
    accounts.instagram.accounts[existingIdx] = newAccount;
  } else {
    accounts.instagram.accounts.push(newAccount);
  }

  saveAccounts(accounts);
  return publicAccounts();
}

function disconnectFacebook() {
  const accounts = loadAccounts();
  accounts.facebook = null;
  accounts.instagram = null;
  saveAccounts(accounts);
  return { ok: true };
}

function disconnectInstagram() {
  const accounts = loadAccounts();
  accounts.instagram = { connected: false, accounts: [] };
  saveAccounts(accounts);
  return { ok: true };
}

async function publishVideoToFacebook({ jobId, pageId, title, description, hashtags }) {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('No Facebook account connected. Please connect your Facebook account first.');
  }

  const pages = accounts.facebook.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (!page) {
    throw new Error('Target Facebook Page not found.');
  }

  const pageToken = page.access_token || accounts.facebook.userAccessToken;
  if (!pageToken) {
    throw new Error('No access token available for this Facebook Page.');
  }

  const videoPath = path.join(EXPORTS, `${jobId}.mp4`);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file for clip ${jobId} not found on disk.`);
  }

  let fullDescription = (description || '').trim();
  if (hashtags && hashtags.trim()) {
    fullDescription += (fullDescription ? '\n\n' : '') + hashtags.trim();
  }

  const fileBuffer = fs.readFileSync(videoPath);
  const fileBlob = new Blob([fileBuffer], { type: 'video/mp4' });

  const form = new FormData();
  form.append('access_token', pageToken);
  if (title && title.trim()) form.append('title', title.trim().slice(0, 255));
  if (fullDescription) form.append('description', fullDescription);
  form.append('source', fileBlob, path.basename(videoPath));

  const uploadRes = await fetch(`https://graph-video.facebook.com/v20.0/${page.id}/videos`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180000)
  });

  const resData = await uploadRes.json();
  if (resData.error) {
    throw new Error(`Facebook API error: ${resData.error.message || JSON.stringify(resData.error)}`);
  }

  return {
    ok: true,
    videoId: resData.id,
    pageId: page.id,
    pageName: page.name,
    postUrl: `https://www.facebook.com/${resData.id}`,
    videoUrl: `https://www.facebook.com/watch/?v=${resData.id}`
  };
}

// ── Multi-Format Publishing Engine (Reels, Quote Image, Story) ─
function extractBestQuote(jobId, fallbackTitle = 'Highlight Moment') {
  const srtPath = path.join(EXPORTS, `${jobId}.srt`);
  if (!fs.existsSync(srtPath)) {
    return { quoteText: fallbackTitle, timestamp: 2.5 };
  }

  try {
    const raw = fs.readFileSync(srtPath, 'utf8');
    const blocks = raw.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
    const cues = [];

    for (const b of blocks) {
      const lines = b.split(/\r?\n/);
      if (lines.length < 3) continue;
      const timeMatch = lines[1].match(/(\d+):(\d+):(\d+)[,\.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,\.](\d+)/);
      if (!timeMatch) continue;
      const startSec = parseInt(timeMatch[1], 10) * 3600 +
                       parseInt(timeMatch[2], 10) * 60 +
                       parseInt(timeMatch[3], 10) +
                       parseInt(timeMatch[4], 10) / 1000;
      const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
      if (text) cues.push({ start: startSec, text });
    }

    if (!cues.length) return { quoteText: fallbackTitle, timestamp: 2.5 };

    const impactWords = /वायरल|थंबनेल|सीखने|सफलता|मेहनत|secret|viral|success|power|focus|key|rule|mindset|money|life|never|always|important|learn|remember/i;
    let best = cues[0];
    let bestScore = -1;

    cues.forEach(c => {
      let score = 0;
      const wordCount = c.text.split(/\s+/).length;
      if (wordCount >= 5 && wordCount <= 24) score += 6;
      if (impactWords.test(c.text)) score += 8;
      if (c.text.includes('?') || c.text.includes('!') || c.text.includes('।')) score += 3;
      if (c.start >= 1.5 && c.start <= 25) score += 4;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    });

    let cleaned = best.text.replace(/^[,\.\-!?:;\s]+/, '').replace(/^(और|तो|अब|फिर|and|so|then|but)\s+/i, '');
    if (!cleaned) cleaned = fallbackTitle;
    return { quoteText: cleaned, timestamp: Math.max(1.5, best.start) };
  } catch {
    return { quoteText: fallbackTitle, timestamp: 2.5 };
  }
}

async function generateQuoteImage({ videoPath, quoteText, ratio = '1:1', watermark = null, outputPath = null, timestamp = 2.5 }) {
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

  // Format quote cleanly with ~30-34 chars per line
  const cleanQuote = String(quoteText || 'Inspiring highlight moment from this clip')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleanQuote.split(' ');
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

  // Creator watermark / brand handle
  let wmText = '@ClipMaster';
  if (watermark && watermark.enabled && watermark.text) {
    wmText = String(watermark.text).trim();
  }

  const assId = crypto.randomUUID();
  const assFile = path.join(DATA, `quote_${assId}.ass`);

  const assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: QuoteMark, Segoe UI, 75, &H0063FFC8, &H000000FF, &H00000000, &H00000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 5, 120, 120, ${quoteY - 65}, 1
Style: QuoteText, Segoe UI, 40, &H00FFFFFF, &H000000FF, &H00000000, &H88000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 2, 3, 5, 120, 120, ${quoteY + 30}, 1
Style: AuthorWatermark, Segoe UI, 24, &H0063FFC8, &H000000FF, &H00000000, &HAA000000, 1, 0, 0, 0, 100, 100, 0, 0, 1, 1, 2, 2, 80, 80, ${isPortrait ? 80 : 60}, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,QuoteMark,,0,0,0,,“
Dialogue: 0,0:00:00.00,0:00:05.00,QuoteText,,0,0,0,,${formattedQuote}
Dialogue: 0,0:00:00.00,0:00:05.00,AuthorWatermark,,0,0,0,,${wmText}
`;

  fs.writeFileSync(assFile, assContent, 'utf8');
  const escapedAss = assFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");

  const finalOutput = outputPath || path.join(PREVIEWS, `quote_${crypto.randomUUID()}.jpg`);
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
    await execFileAsync('ffmpeg', args);
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

async function publishReelToFacebook({ jobId, pageId, title, description, hashtags }) {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('No Facebook account connected. Please connect your Facebook account first.');
  }

  const pages = accounts.facebook.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (!page) throw new Error('Target Facebook Page not found.');

  const pageToken = page.access_token || accounts.facebook.userAccessToken;
  if (!pageToken) throw new Error('No access token available for this Facebook Page.');

  const videoPath = path.join(EXPORTS, `${jobId}.mp4`);
  if (!fs.existsSync(videoPath)) throw new Error(`Video file for clip ${jobId} not found.`);

  let fullDescription = (description || '').trim();
  if (hashtags && hashtags.trim()) {
    fullDescription += (fullDescription ? '\n\n' : '') + hashtags.trim();
  }

  const fileBuffer = fs.readFileSync(videoPath);

  // 1. Try Facebook Page Reels Publishing API
  try {
    const initRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/video_reels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'start',
        access_token: pageToken
      }),
      signal: AbortSignal.timeout(30000)
    });
    const initData = await initRes.json();

    if (initData.video_id && initData.upload_url) {
      // 2. Upload binary
      const uploadRes = await fetch(initData.upload_url, {
        method: 'POST',
        headers: {
          'Authorization': `OAuth ${pageToken}`,
          'offset': '0',
          'file_size': String(fileBuffer.length)
        },
        body: fileBuffer,
        signal: AbortSignal.timeout(180000)
      });
      const uploadData = await uploadRes.json();
      if (uploadData.error) throw new Error(uploadData.error.message || 'Binary upload failed');

      // 3. Finish Reel publishing
      const finishRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/video_reels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upload_phase: 'finish',
          video_id: initData.video_id,
          video_state: 'PUBLISHED',
          description: fullDescription,
          title: (title || '').slice(0, 255),
          access_token: pageToken
        }),
        signal: AbortSignal.timeout(30000)
      });
      const finishData = await finishRes.json();
      if (finishData.error) throw new Error(finishData.error.message || 'Reels finish failed');

      return {
        ok: true,
        format: 'reel',
        videoId: initData.video_id,
        pageId: page.id,
        pageName: page.name,
        postUrl: `https://www.facebook.com/reel/${initData.video_id}`,
        videoUrl: `https://www.facebook.com/watch/?v=${initData.video_id}`
      };
    }
  } catch (reelErr) {
    console.warn('[Reels API] Falling back to standard video upload:', reelErr.message);
  }

  // Fallback to /videos (Facebook automatically recognizes 9:16 videos <= 90s as Reels)
  const fallback = await publishVideoToFacebook({ jobId, pageId, title, description, hashtags });
  return { ...fallback, format: 'reel' };
}

async function publishPhotoToFacebook({ imagePath, pageId, caption }) {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('No Facebook account connected. Please connect your Facebook account first.');
  }

  const pages = accounts.facebook.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (!page) throw new Error('Target Facebook Page not found.');

  const pageToken = page.access_token || accounts.facebook.userAccessToken;
  if (!pageToken) throw new Error('No access token available for this Facebook Page.');

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found at ${imagePath}`);
  }

  const imgBuffer = fs.readFileSync(imagePath);
  const imgBlob = new Blob([imgBuffer], { type: 'image/jpeg' });

  const form = new FormData();
  form.append('access_token', pageToken);
  if (caption && caption.trim()) form.append('caption', caption.trim());
  form.append('source', imgBlob, path.basename(imagePath));

  const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/photos`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60000)
  });

  const resData = await uploadRes.json();
  if (resData.error) {
    throw new Error(`Facebook Photos API error: ${resData.error.message || JSON.stringify(resData.error)}`);
  }

  const postId = resData.post_id || resData.id;
  return {
    ok: true,
    format: 'imagePost',
    photoId: resData.id,
    postId,
    pageId: page.id,
    pageName: page.name,
    postUrl: `https://www.facebook.com/${postId}`
  };
}

async function publishStoryToFacebook({ videoPath, imagePath, pageId }) {
  const accounts = loadAccounts();
  if (!accounts.facebook || !accounts.facebook.connected) {
    throw new Error('No Facebook account connected. Please connect your Facebook account first.');
  }

  const pages = accounts.facebook.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (!page) throw new Error('Target Facebook Page not found.');

  const pageToken = page.access_token || accounts.facebook.userAccessToken;
  if (!pageToken) throw new Error('No access token available for this Facebook Page.');

  let teaserPath = null;
  try {
    // 1. If video is provided, generate a 15-second teaser for Story
    if (videoPath && fs.existsSync(videoPath)) {
      teaserPath = path.join(EXPORTS, `story_teaser_${crypto.randomUUID().slice(0, 8)}.mp4`);
      await execFileAsync('ffmpeg', [
        '-y', '-ss', '0', '-i', videoPath,
        '-t', '15',
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
        '-movflags', '+faststart',
        teaserPath
      ]);

      const teaserBuffer = fs.readFileSync(teaserPath);

      const startRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/video_stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upload_phase: 'start',
          access_token: pageToken
        }),
        signal: AbortSignal.timeout(30000)
      });
      const startData = await startRes.json();

      if (startData.video_id && startData.upload_url) {
        await fetch(startData.upload_url, {
          method: 'POST',
          headers: {
            'Authorization': `OAuth ${pageToken}`,
            'offset': '0',
            'file_size': String(teaserBuffer.length)
          },
          body: teaserBuffer,
          signal: AbortSignal.timeout(90000)
        });

        const finishRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/video_stories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upload_phase: 'finish',
            video_id: startData.video_id,
            access_token: pageToken
          }),
          signal: AbortSignal.timeout(30000)
        });
        const finishData = await finishRes.json();
        if (finishData.error) throw new Error(finishData.error.message || 'Story finish failed');

        return {
          ok: true,
          format: 'story',
          storyId: startData.video_id,
          pageId: page.id,
          pageName: page.name,
          postUrl: `https://www.facebook.com/${page.id}`
        };
      }
      if (startData.error) throw new Error(startData.error.message);
    }

    // 2. Try photo_stories if image graphic is available
    if (imagePath && fs.existsSync(imagePath)) {
      const imgBuffer = fs.readFileSync(imagePath);
      const form = new FormData();
      form.append('access_token', pageToken);
      form.append('published', 'false');
      form.append('temporary', 'true');
      form.append('source', new Blob([imgBuffer], { type: 'image/jpeg' }), 'story.jpg');

      const pRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/photos`, { method: 'POST', body: form });
      const pData = await pRes.json();
      if (pData.id) {
        const sRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/photo_stories?photo_id=${pData.id}&access_token=${encodeURIComponent(pageToken)}`, { method: 'POST' });
        const sData = await sRes.json();
        if (sData.success || sData.id) {
          return {
            ok: true,
            format: 'story',
            storyId: sData.id || pData.id,
            pageId: page.id,
            pageName: page.name,
            postUrl: `https://www.facebook.com/${page.id}`
          };
        }
        if (sData.error) throw new Error(sData.error.message);
      }
      if (pData.error) throw new Error(pData.error.message);
    }

    throw new Error('Facebook Story publishing requires Page Story permissions (pages_manage_metadata).');
  } catch (storyErr) {
    console.warn('[Story API Notice]:', storyErr.message);
    return {
      ok: false,
      format: 'story',
      error: storyErr.message || 'Facebook Story requires Page Story permissions (pages_manage_metadata).'
    };
  } finally {
    if (teaserPath && fs.existsSync(teaserPath)) {
      try { fs.unlinkSync(teaserPath); } catch {}
    }
  }
}

async function publishReelToInstagram({ jobId, igUserId, caption = '', hashtags = '', coverUrl = null }) {
  const accounts = loadAccounts();
  const igConfig = accounts.instagram;
  const igAccounts = (igConfig && Array.isArray(igConfig.accounts)) ? igConfig.accounts : [];

  if (!igAccounts.length) {
    throw new Error('No connected Instagram account found. Please connect your Instagram Business/Creator account via Social Accounts.');
  }

  // Find targeted Instagram account
  let targetIg = null;
  if (igUserId) {
    targetIg = igAccounts.find(a => String(a.id) === String(igUserId) || a.username === igUserId);
  }
  if (!targetIg) {
    targetIg = igAccounts[0];
  }

  const igToken = targetIg.access_token || accounts.facebook?.userAccessToken;
  if (!igToken) {
    throw new Error(`No access token found for Instagram account @${targetIg.username || targetIg.id}`);
  }

  const videoPath = path.join(EXPORTS, `${jobId}.mp4`);
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file for clip ${jobId} not found at ${videoPath}`);
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  if (fileSize <= 0) {
    throw new Error(`Video file is empty: ${videoPath}`);
  }

  let fullCaption = (caption || '').trim();
  if (hashtags && hashtags.trim()) {
    fullCaption += (fullCaption ? '\n\n' : '') + hashtags.trim();
  }

  console.log(`[Instagram Reels] Publishing clip ${jobId} to @${targetIg.username} (${targetIg.id}), size: ${fileSize} bytes...`);

  // Step 1: Initialize Resumable Media Container
  const initParams = new URLSearchParams({
    media_type: 'REELS',
    upload_type: 'resumable',
    caption: fullCaption,
    share_to_feed: 'true',
    access_token: igToken
  });
  if (coverUrl) {
    initParams.append('cover_url', coverUrl);
  }

  const initUrl = `https://graph.facebook.com/v20.0/${encodeURIComponent(targetIg.id)}/media`;
  const initRes = await fetch(initUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: initParams.toString(),
    signal: AbortSignal.timeout(30000)
  });

  const initData = await initRes.json();
  if (initData.error) {
    const errMsg = initData.error.message || 'Failed to initialize Instagram Reel container';
    console.error('[Instagram Reels Init Error]', initData.error);
    if (errMsg.includes('permission') || errMsg.includes('Scope') || errMsg.includes('access')) {
      throw new Error(`Instagram API Permission error: ${errMsg}. Make sure your token has 'instagram_content_publish' and 'instagram_basic'.`);
    }
    throw new Error(`Instagram Reel init failed: ${errMsg}`);
  }

  const containerId = initData.id;
  const uploadUri = initData.uri;
  if (!containerId || !uploadUri) {
    throw new Error(`Invalid response from Instagram Reel init: ${JSON.stringify(initData)}`);
  }

  console.log(`[Instagram Reels] Container created: ${containerId}, upload URI: ${uploadUri}`);

  // Step 2: Upload Video Binary directly to Meta rupload endpoint
  const fileBuffer = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUri, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${igToken}`,
      'offset': '0',
      'file_size': String(fileSize),
      'Content-Type': 'application/octet-stream'
    },
    body: fileBuffer,
    signal: AbortSignal.timeout(180000)
  });

  const uploadText = await uploadRes.text();
  let uploadData = {};
  try { uploadData = JSON.parse(uploadText); } catch {}

  if (!uploadRes.ok || uploadData.error) {
    const errMsg = uploadData?.error?.message || uploadText || `HTTP ${uploadRes.status}`;
    console.error('[Instagram Reels Upload Error]', errMsg);
    throw new Error(`Instagram Reel binary upload failed: ${errMsg}`);
  }

  console.log(`[Instagram Reels] Binary upload completed. Polling container status for container ${containerId}...`);

  // Step 3: Poll status until FINISHED (transcoding & validation complete)
  const pollStart = Date.now();
  const maxPollMs = 120000; // 2 minutes
  let isReady = false;

  while (Date.now() - pollStart < maxPollMs) {
    await new Promise(r => setTimeout(r, 4000)); // wait 4 seconds between polls

    const statusRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(igToken)}`, {
      signal: AbortSignal.timeout(15000)
    });
    const statusData = await statusRes.json();

    if (statusData.error) {
      console.warn('[Instagram Reels Status Warn]', statusData.error);
      continue;
    }

    const code = (statusData.status_code || '').toUpperCase();
    console.log(`[Instagram Reels Status] Container ${containerId}: ${code}`);

    if (code === 'FINISHED') {
      isReady = true;
      break;
    } else if (code === 'ERROR') {
      throw new Error(`Instagram video processing failed: ${statusData.status || 'Encoding error'}`);
    } else if (code === 'EXPIRED') {
      throw new Error('Instagram Reel upload session expired.');
    }
    // If IN_PROGRESS, continue polling
  }

  if (!isReady) {
    throw new Error('Instagram Reel processing timed out after 2 minutes. The video may still be processing on Meta servers.');
  }

  // Step 4: Publish the container
  console.log(`[Instagram Reels] Publishing container ${containerId}...`);
  const publishParams = new URLSearchParams({
    creation_id: containerId,
    access_token: igToken
  });

  const publishRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(targetIg.id)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishParams.toString(),
    signal: AbortSignal.timeout(30000)
  });

  const publishData = await publishRes.json();
  if (publishData.error) {
    console.error('[Instagram Reels Publish Error]', publishData.error);
    throw new Error(`Instagram Reel publish failed: ${publishData.error.message || 'Unknown error'}`);
  }

  const mediaId = publishData.id;
  console.log(`[Instagram Reels] Successfully published! Media ID: ${mediaId}`);

  // Step 5: Fetch permalink
  let permalink = `https://www.instagram.com/reel/`;
  try {
    const linkRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}?fields=permalink,shortcode&access_token=${encodeURIComponent(igToken)}`, {
      signal: AbortSignal.timeout(10000)
    });
    const linkData = await linkRes.json();
    if (linkData && linkData.permalink) {
      permalink = linkData.permalink;
    } else if (linkData && linkData.shortcode) {
      permalink = `https://www.instagram.com/reel/${linkData.shortcode}/`;
    }
  } catch (linkErr) {
    console.warn('[Instagram Reels Permalink Warn]', linkErr.message);
  }

  return {
    ok: true,
    format: 'instagramReel',
    mediaId,
    permalink,
    postUrl: permalink,
    igUsername: targetIg.username,
    igUserId: targetIg.id
  };
}

async function publishMultiFormat({
  jobId,
  pageId,
  igUserId = null,
  formats = { reel: true, instagramReel: false, imagePost: true, story: false },
  title = '',
  description = '',
  hashtags = '',
  quoteText = '',
  ratio = '1:1',
  watermark = null
}) {
  const accounts = loadAccounts();
  const requiresFb = Boolean(formats.reel || formats.imagePost || formats.story);
  const requiresIg = Boolean(formats.instagramReel || formats.igReel);

  if (requiresFb && (!accounts.facebook || !accounts.facebook.connected)) {
    throw new Error('No Facebook account connected. Please connect your Facebook account first.');
  }
  if (requiresIg && (!accounts.instagram || !accounts.instagram.connected || !(accounts.instagram.accounts || []).length)) {
    throw new Error('No Instagram account connected. Please connect an Instagram account in Social Accounts.');
  }

  const pages = accounts.facebook?.pages || [];
  const page = pages.find(p => p.id === pageId) || pages[0];
  if (requiresFb && !page) {
    throw new Error('Target Facebook Page not found.');
  }

  const videoPath = path.join(EXPORTS, `${jobId}.mp4`);
  if (!fs.existsSync(videoPath)) throw new Error(`Video file for clip ${jobId} not found.`);

  const results = {};
  const tempFiles = [];

  try {
    // 1. Publish Facebook Reel if selected
    if (formats.reel) {
      try {
        const reelRes = await publishReelToFacebook({ jobId, pageId: page?.id, title, description, hashtags });
        results.reel = { ok: true, ...reelRes };
      } catch (err) {
        results.reel = { ok: false, error: err.message };
      }
    }

    // 2. Publish Instagram Reel if selected
    if (requiresIg) {
      try {
        const igRes = await publishReelToInstagram({
          jobId,
          igUserId,
          caption: (title ? `${title}\n\n${description}` : description),
          hashtags
        });
        results.instagramReel = { ok: true, ...igRes };
      } catch (err) {
        results.instagramReel = { ok: false, error: err.message };
      }
    }

    // 3. Generate and Publish Quote Image Post if selected
    let generatedImage = null;
    if (formats.imagePost || (formats.story && !formats.reel)) {
      try {
        const quoteInfo = extractBestQuote(jobId, title);
        const textToUse = quoteText && quoteText.trim() ? quoteText.trim() : quoteInfo.quoteText;
        const tempImg = path.join(PREVIEWS, `post_${jobId}_${Date.now()}.jpg`);
        tempFiles.push(tempImg);

        await generateQuoteImage({
          videoPath,
          quoteText: textToUse,
          ratio,
          watermark,
          outputPath: tempImg,
          timestamp: quoteInfo.timestamp
        });
        generatedImage = tempImg;

        if (formats.imagePost && page) {
          let photoCaption = textToUse ? `“${textToUse}”` : (title || 'Highlight Moment');
          if (description && description.trim()) photoCaption += `\n\n${description.trim()}`;
          if (hashtags && hashtags.trim()) photoCaption += `\n\n${hashtags.trim()}`;

          const photoRes = await publishPhotoToFacebook({
            imagePath: tempImg,
            pageId: page.id,
            caption: photoCaption
          });
          results.imagePost = { ok: true, ...photoRes };
        }
      } catch (err) {
        if (formats.imagePost) {
          results.imagePost = { ok: false, error: err.message };
        }
      }
    }

    // 4. Publish Story if selected
    if (formats.story && page) {
      try {
        const storyRes = await publishStoryToFacebook({
          videoPath,
          imagePath: generatedImage,
          pageId: page.id
        });
        results.story = storyRes;
      } catch (err) {
        results.story = { ok: false, error: err.message };
      }
    }

    const successfulCount = Object.values(results).filter(r => r && r.ok).length;
    const totalCount = Object.keys(results).length;

    return {
      ok: successfulCount > 0,
      pageId: page ? page.id : null,
      pageName: page ? page.name : null,
      successfulCount,
      totalCount,
      results
    };
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

// ── AI Viral Copy & Hashtags Generator ────────────────────
const STOP_WORDS = new Set([
  'the','and','a','to','of','in','is','it','you','that','he','was','for','on','are','as','with','his','they',
  'at','be','this','have','from','or','one','had','by','word','but','not','what','all','were','we','when','your',
  'can','said','there','use','an','each','which','she','do','how','their','if','will','up','other','about','out',
  'hai','ye','ki','ko','se','aur','kya','me','hum','bhi','par','kar','ho','to','ka','ke','kuch','hota','hoti',
  'raha','rahi','ek','kare','karein','toh','yeh','woh','kuch','karta','karti','wali','wale','karo','gaya','gayi',
  'में','से','पर','को','का','के','की','है','हैं','था','थी','थे','और','या','तो','एक','यह','वह','इस','उस','अपने',
  'अपनी','अपनों','भी','ही','तक','कर','किया','गया','गई','हो','होता','होती','होते','रहा','रही','रहे','क्या','क्यों',
  'कैसे','कब','कहाँ','कहा','बोला','बोली','सा','सी','से'
]);

function extractKeywords(text, limit = 8) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\w\s\u0900-\u097F]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, limit);
}

function generateHeuristicCopy({ title, transcript, duration }) {
  const baseTitle = String(title || 'Must Watch Moment').replace(/^[_\s\-]+|[_\s\-]+$/g, '').slice(0, 80);
  const keywords = extractKeywords(`${baseTitle} ${transcript}`);
  const cleanTranscript = String(transcript || '').replace(/\s+/g, ' ').trim();

  const hooks = [
    `Wait for this moment! 🤯 ${baseTitle}`,
    `This changed my perspective 🔥 ${baseTitle}`,
    `Watch till the end! 💡 ${baseTitle}`,
    `The harsh truth about ${keywords[0] ? keywords[0].toUpperCase() : baseTitle} 👀`,
    `Nobody talks about this! ⚡ ${baseTitle}`
  ];
  const hookTitle = hooks[Math.floor(Math.random() * hooks.length)];

  let captionBody = '';
  if (cleanTranscript.length > 30) {
    const firstSentence = cleanTranscript.split(/[.?!।\n]/)[0]?.trim();
    if (firstSentence && firstSentence.length > 15) {
      captionBody = `"${firstSentence.slice(0, 160)}..."\n\nDrop your thoughts in the comments! Do you agree? 👇`;
    }
  }
  if (!captionBody) {
    captionBody = `Every creator and viewer needs to hear this. Share your opinion in the comments below! 👇`;
  }

  const defaultViralTags = ['#Reels', '#FacebookReels', '#Viral', '#Trending', '#Shorts', '#ExplorePage', '#DailyClips'];
  const keywordTags = keywords
    .filter(k => /^[a-zA-Z0-9]+$/.test(k))
    .slice(0, 5)
    .map(k => `#${k.charAt(0).toUpperCase() + k.slice(1)}`);
  
  const allTags = [...new Set([...defaultViralTags, ...keywordTags])];

  return {
    ok: true,
    source: 'smart-nlp',
    title: hookTitle,
    caption: captionBody,
    hashtags: allTags,
    hashtagsString: allTags.join(' ')
  };
}

async function generateAiPostCopy({ jobId, title, transcript, duration, useOllama = false }) {
  let text = transcript || '';
  if (!text && jobId) {
    const srtPath = path.join(EXPORTS, `${jobId}.srt`);
    if (fs.existsSync(srtPath)) {
      try {
        text = fs.readFileSync(srtPath, 'utf8')
          .replace(/\d+\r?\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\r?\n/g, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      } catch {}
    }
  }

  if (useOllama) {
    const ollamaUrl = process.env.CLIPMASTER_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
    const model = process.env.CLIPMASTER_AI_MODEL || 'qwen2.5:3b';
    try {
      const prompt = `You are a viral social media manager. Generate high-converting Facebook Reel / Shorts post copy for this clip.
Title: ${title || 'Highlight Clip'}
Duration: ${duration || 30} seconds
Transcript: ${text.slice(0, 800) || title || 'Engaging video moment'}

Return a valid JSON object ONLY with these exact keys:
{
  "hookTitle": "Catchy title with 1 emoji (under 50 chars)",
  "caption": "2-sentence engaging caption with a call to action",
  "hashtags": ["#Reels", "#Viral", "#FacebookReels", "#Trending", "#ForYou"]
}`;

      const res = await fetch(ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0.7, num_predict: 180 },
          messages: [
            { role: 'system', content: 'Output ONLY valid JSON.' },
            { role: 'user', content: prompt }
          ]
        }),
        signal: AbortSignal.timeout(28000)
      });

      if (res.ok) {
        const data = await res.json();
        const parsed = JSON.parse(data.message?.content || '{}');
        if (parsed.hookTitle && parsed.caption) {
          const tags = Array.isArray(parsed.hashtags)
            ? parsed.hashtags.map(t => t.startsWith('#') ? t : `#${t}`)
            : ['#Reels', '#Viral', '#Trending'];
          return {
            ok: true,
            source: 'ollama',
            model,
            title: parsed.hookTitle,
            caption: parsed.caption,
            hashtags: tags,
            hashtagsString: tags.join(' ')
          };
        }
      }
    } catch (err) {
      console.warn('Ollama copy generation timed out or failed, falling back to smart-nlp:', err.message);
    }
  }

  return generateHeuristicCopy({ title, transcript: text, duration });
}

// ── HTTP helpers ────────────────────────────────────────────
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function safeName(input) {
  return path.basename(String(input || 'video.mp4'))
    .normalize('NFKC')
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 100) || 'video.mp4';
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
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Request body too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON in request body.')); }
    });
    req.on('error', reject);
  });
}

// ── File streaming with range support ──────────────────────
function streamFile(req, res, file, type, downloadName) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'File not found.' });
  const stat = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${safeName(downloadName)}"`);
  if (range) {
    const [a, b] = range.replace(/bytes=/, '').split('-');
    const start = Number(a);
    const end = b ? Math.min(Number(b), stat.size - 1) : stat.size - 1;
    if (!Number.isInteger(start) || start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

// ── Video probe ─────────────────────────────────────────────
async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:format_tags=title:stream=codec_type,width,height,r_frame_rate',
    '-of', 'json', file
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find(s => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found in file. The file may be corrupted or unsupported.');
  return {
    duration: Math.floor(Number(data.format?.duration || 0)),
    width: video.width,
    height: video.height,
    size: Number(data.format?.size || 0),
    title: data.format?.tags?.title || path.parse(file).name
  };
}

// ── YouTube async download jobs map ────────────────────────
const ytDownloads = new Map();

async function runAsyncYoutubeImport(downloadId, url) {
  try {
    const project = await importYoutube(url);
    ytDownloads.set(downloadId, { status: 'complete', project, error: null });
  } catch (err) {
    ytDownloads.set(downloadId, { status: 'failed', project: null, error: err.message });
  }
}

// ── YouTube download ────────────────────────────────────────
async function importYoutube(input) {
  let parsed;
  try { parsed = new URL(input); }
  catch { throw new Error('Enter a valid URL.'); }

  const host = parsed.hostname.toLowerCase();
  if (!['youtu.be', 'youtube.com', 'www.youtube.com', 'music.youtube.com'].some(h => host === h || host.endsWith('.' + h))) {
    throw new Error('Only YouTube video links are supported at this time.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use http or https.');
  }

  const id = crypto.randomUUID();
  const template = path.join(UPLOADS, `${id}.%(ext)s`);
  const subLangs = 'en-orig,hi-orig,en-US,en-GB,hi-IN';
  const nodeRuntime = process.execPath ? `node:${process.execPath}` : 'node';
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '30',
    '--retries', '5',
    '--extractor-retries', '5',
    '--fragment-retries', '5',
    '--max-filesize', '8G',
    '--geo-bypass',
    '--js-runtimes', nodeRuntime,
    '-f', 'b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', subLangs,
    '--sub-format', 'vtt',
    '-o', template,
    '--print', 'title',
    '--print', 'after_move:filepath',
    parsed.href
  ];

  let result;
  try {
    result = await execFileAsync('python', ['-m', 'yt_dlp', ...args], {
      windowsHide: true,
      timeout: 25 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(ROOT, 'vendor'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1'
      }
    });
  } catch (e) {
    // If subtitle fetching fails or gets rate-limited, fallback to downloading video without subtitles
    let possibleFile = fs.readdirSync(UPLOADS).find(f =>
      f.startsWith(id + '.') &&
      !f.endsWith('.vtt') &&
      !f.endsWith('.part') &&
      !f.endsWith('.ytdl')
    );
    if (!possibleFile) {
      try {
        const fallbackArgs = [
          '--no-playlist',
          '--no-warnings',
          '--socket-timeout', '30',
          '--retries', '5',
          '--extractor-retries', '5',
          '--fragment-retries', '5',
          '--max-filesize', '8G',
          '--geo-bypass',
          '--compat-options', 'no-youtube-unavailable-videos',
          '--js-runtimes', nodeRuntime,
          '-f', 'best[ext=mp4][height<=1080]/best[height<=1080]/best',
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
          env: {
            ...process.env,
            PYTHONPATH: [path.join(ROOT, 'vendor'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
            PYTHONUTF8: '1'
          }
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
    const meta = await probe(filename);
    const title = lines.find(s => s !== filename) || meta.title;
    const ext = path.extname(filename);
    const finalName = `${id}${ext}`;
    const target = path.join(UPLOADS, finalName);
    if (path.resolve(filename) !== path.resolve(target)) fs.renameSync(filename, target);
    const project = {
      id, filename: finalName,
      name: title, originalName: `${title}${ext}`,
      sourceUrl: parsed.href,
      duration: meta.duration, width: meta.width, height: meta.height, size: meta.size,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const all = loadProjects();
    all.unshift(project);
    saveProjects(all);
    const { filename: _omit, ...pub } = project;
    return pub;
  } catch (e) {
    fs.rmSync(filename, { force: true });
    throw e;
  }
}

// ── Caption utilities ────────────────────────────────────────
function srtTime(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) * 1000));
  const ms = n % 1000, all = Math.floor(n / 1000);
  return `${String(Math.floor(all / 3600)).padStart(2,'0')}:${String(Math.floor(all % 3600 / 60)).padStart(2,'0')}:${String(all % 60).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}
function assTime(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return `${h}:${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;
}

function parseVtt(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const blocks = source.split(/\r?\n\s*\r?\n/);
  const cues = [];
  const toSec = s => {
    const p = s.trim().split(':');
    return (p.length === 3 ? Number(p[0])*3600 + Number(p[1])*60 : p.length === 2 ? Number(p[0])*60 : 0) + Number(p.at(-1).replace(',', '.'));
  };
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const ti = lines.findIndex(l => /\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->/.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(/([\d:.,]+)\s+-->\s+([\d:.,]+)/);
    if (!m) continue;
    const start = toSec(m[1]), end = toSec(m[2]);
    let text = lines.slice(ti + 1).join(' ')
      .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    if (end - start < 0.12 || !text) continue;
    const prev = cues.at(-1);
    if (prev && text.toLowerCase() === prev.text.toLowerCase()) continue;
    if (prev && text.toLowerCase().startsWith(prev.text.toLowerCase())) text = text.slice(prev.text.length).trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function chooseCaptionTrack(project, language = 'auto') {
  const base = path.join(UPLOADS, project.id + '.');
  const langs = language === 'hi' ? ['hi-orig', 'hi']
    : language === 'en' ? ['en-orig', 'en']
    : ['en-orig', 'hi-orig', 'en', 'hi'];
  for (const lang of langs) {
    const file = base + lang + '.vtt';
    if (fs.existsSync(file)) return { file, language: lang.startsWith('hi') ? 'hi' : 'en' };
  }
  return null;
}

function findHighlights(cues, duration, count = 3, targetLengthPref = 35) {
  const ordered = cues
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && String(c.text || '').trim())
    .sort((a, b) => a.start - b.start);
  if (ordered.length < 3) throw new Error('This video has too few readable captions to detect highlights. Try another video or a different caption language.');

  let targetLength = Number(targetLengthPref) || 35;
  const minLength = Math.min(Math.max(8, Math.round(targetLength * 0.55)), duration - 1);
  const maxLength = Math.min(Math.max(25, Math.round(targetLength * 1.45)), duration - 0.1);
  targetLength = Math.min(targetLength, maxLength);
  if (maxLength < 5) throw new Error('Video is too short to create a Short clip.');

  const terminal = /[.!?।॥…]["')\\]]?$/;
  const starts = [], seen = new Set();
  const addStart = t => {
    const key = Math.round(t / 3);
    if (t >= Math.min(8, duration * 0.08) && t <= duration - minLength && !seen.has(key)) {
      seen.add(key); starts.push(t);
    }
  };

  for (let i = 0; i < ordered.length - 1; i++) {
    if (terminal.test(ordered[i].text.trim())) addStart(ordered[i + 1].start);
  }
  let nextSample = Math.min(8, duration * 0.08);
  for (const cue of ordered) {
    if (cue.start >= nextSample) { addStart(cue.start); nextSample = cue.start + 6; }
  }
  if (!starts.length) addStart(ordered[0].start);

  const ranked = [];
  for (const start of starts) {
    const endChoices = ordered.filter(c => c.end >= start + minLength && c.end <= Math.min(start + maxLength, duration));
    if (!endChoices.length) continue;
    const endCue = endChoices.reduce((best, c) => {
      const cost = x => Math.abs((x.end - start) - targetLength) - (terminal.test(x.text.trim()) ? 1.8 : 0);
      return cost(c) < cost(best) ? c : best;
    });
    const end = endCue.end;
    const segment = ordered.filter(c => c.end > start && c.start < end);
    if (segment.length < 3) continue;
    const text = segment.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const words = lower.match(/[\p{L}\p{N}']+/gu) || [];
    if (words.length < 8) continue;

    const hook = (lower.slice(0, 150).match(/\b(how|why|what|if you|you can|you need|here|this|secret|mistake|never|stop|most|best|worst|important|watch|learn|truth|real|ways|tips|number|imagine|because|कैसे|क्यों|क्या|अगर|आप|तुम|यह|सीखें|सच|तरीका|गलती|जरूरी|सबसे)\b/gu) || []).length;
    const value = (lower.match(/\b(salary|earn|money|free|mistake|secret|truth|never|best|worst|important|easy|simple|fast|guaranteed|proof|result|learn|avoid|warning|problem|solution|step|benefit|apply|skill|job|start|stop|save|income|profit|पैसा|कमाई|नौकरी|काम|वीडियो|वायरल|तरीका|सीख|फायदा|सही|गलत|क्यों|कैसे)\b/gu) || []).length;
    const questions = (text.match(/[?!?]/g) || []).length;
    const digits = (text.match(/\b\d+\b/g) || []).length;
    const complete = terminal.test(endCue.text.trim());
    const unique = new Set(words).size / words.length;
    const intro = /^(hello|hi|hey|welcome everyone|good morning|नमस्कार|हेलो|स्वागत)/i.test(text);
    const outro = /\b(thank you|see you (in|next)|until then|like and subscribe|subscribe to|in the description|video description|comment below|धन्यवाद|मिलते हैं)\b/i.test(text);
    const lengthBonus = Math.max(0, 7 - Math.abs((end - start) - targetLength) / 2.4);
    const density = Math.min(4, words.length / Math.max(1, (end - start) * 1.5));
    const rawScore = lengthBonus + Math.min(7, hook * 1.35) + Math.min(6, value * 0.65) + Math.min(2, questions * 0.6) + Math.min(2, digits * 0.5) + (complete ? 2 : 0) + unique * 4 + density - (intro ? 4 : 0) - (outro ? 8 : 0);
    // Normalized Opus Clip style virality score (65 - 99)
    const viralityScore = Math.min(99, Math.max(65, Math.round(58 + (rawScore / 22) * 40)));

    const sentences = text.split(/(?<=[.!?।॥])\s+/);
    const titleText = sentences.find(s => (s.match(/\S+/g) || []).length >= 4 && s.length >= 18) || text.split(/\s+/).slice(0, 8).join(' ');
    const title = titleText.replace(/\s+/g, ' ').replace(/\s+([,.!?।])/g, '$1').trim().slice(0, 68);
    ranked.push({
      start: Number(start.toFixed(2)), end: Number(end.toFixed(2)),
      score: viralityScore,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      captions: segment
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const item of ranked) {
    if (chosen.every(x => item.start >= x.end + 4 || item.end <= x.start - 4)) chosen.push(item);
    if (chosen.length === count) break;
  }
  if (!chosen.length) throw new Error('Could not find enough distinct captioned moments. Try a different caption language or a different video.');
  return chosen.sort((a, b) => a.start - b.start);
}

async function rankWithLocalAi(candidates, wanted = 3) {
  if (wanted > 12) return null;
  const endpoint = process.env.CLIPMASTER_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = process.env.CLIPMASTER_AI_MODEL || 'qwen2.5:3b';
  aiDiagnostic = '';
  try {
    const tags = await fetch(endpoint.replace(/\/api\/chat\/?$/, '/api/tags'), { signal: AbortSignal.timeout(3500) });
    if (!tags.ok) { aiDiagnostic = `Ollama /api/tags returned ${tags.status}`; return null; }
    const available = (await tags.json()).models || [];
    if (!available.some(x => x.name === model || x.name?.startsWith(model + ':'))) {
      aiDiagnostic = `Model ${model} not found in Ollama. Install it with: ollama pull ${model}`;
      return null;
    }
  } catch (e) { aiDiagnostic = `Ollama unavailable: ${e.message}`; return null; }

  const options = candidates.map((c, i) => ({
    id: `C${String(i + 1).padStart(2, '0')}`,
    start: c.start, end: c.end, score: c.score,
    transcript: c.captions.map(x => x.text).join(' ').slice(0, 130)
  }));
  const prompt = `Pick ${wanted} different, self-contained Shorts. Favor a strong hook, useful payoff, natural flow. Avoid intros/outros. Reply with only candidate IDs like C01 C02 C03. Candidates: ${JSON.stringify(options)}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, keep_alive: '15m',
        options: { temperature: 0, num_predict: Math.min(128, wanted * 5 + 20) },
        messages: [
          { role: 'system', content: `Return exactly ${wanted} candidate IDs and no other text.` },
          { role: 'user', content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) { aiDiagnostic = `Ollama chat returned ${response.status}`; return null; }
    const body = await response.json();
    const content = body.message?.content || '';
    const ids = [...new Set(content.match(/\bC0?\d{1,2}\b/gi) || [])].slice(0, wanted);
    const selected = ids.map(id => candidates[Number(id.replace(/^C/i, '')) - 1]).filter(Boolean).map(c => ({ ...c, aiPicked: true }));
    if (!selected.length) { aiDiagnostic = `Ollama returned no valid IDs: ${content.slice(0, 120)}`; return null; }
    for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
      if (selected.length >= wanted) break;
      if (selected.every(x => c.start >= x.end + 4 || c.end <= x.start - 4)) selected.push(c);
    }
    return selected.slice(0, wanted).sort((a, b) => a.start - b.start);
  } catch (e) { aiDiagnostic = `Ollama selection error: ${e.message}`; return null; }
}

function groupCaptions(cues, start, end) {
  const source = cues.filter(c => c.end > start && c.start < end);
  const items = [];
  let prior = [];
  for (const cue of source) {
    let words = String(cue.text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    let overlap = 0;
    for (let n = Math.min(5, prior.length, words.length); n > 0; n--) {
      if (prior.slice(-n).join(' ').toLowerCase() === words.slice(0, n).join(' ').toLowerCase()) { overlap = n; break; }
    }
    words = words.slice(overlap);
    if (!words.length) continue;
    prior = prior.concat(words).slice(-8);
    const text = words.join(' ');
    const last = items.at(-1);
    if (last && (last.text.split(/\s+/).length + words.length <= 7) && (cue.end - last.start <= 2.8) && (last.text.length + text.length < 54)) {
      last.text += ` ${text}`; last.end = Math.min(end, cue.end);
    } else {
      items.push({ start: Math.max(start, cue.start), end: Math.min(end, cue.end), text });
    }
  }
  return items;
}

function assWrap(text, maxChars = 24) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > maxChars) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\\N');
}

function toSrt(lines, offset, clipEnd) {
  return lines
    .filter(c => Number(c.end) > offset && Number(c.start) < clipEnd)
    .map((line, i) => `${i + 1}\n${srtTime(Math.max(0, Number(line.start) - offset))} --> ${srtTime(Math.min(clipEnd - offset, Number(line.end) - offset))}\n${String(line.text || '').replace(/[<>]/g, '').trim()}\n`)
    .join('\n');
}

function hexToAssColor(hex, opacity = 1) {
  const clean = String(hex || '#FFFFFF').replace('#', '').slice(0, 6).padEnd(6, 'F');
  const alphaInt = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)));
  const aa = alphaInt.toString(16).padStart(2, '0').toUpperCase();
  const b = clean.slice(4, 6);
  const g = clean.slice(2, 4);
  const r = clean.slice(0, 2);
  return `&H${aa}${b}${g}${r}`;
}

function buildWatermarkStyle(wm, width, height) {
  if (!wm || !wm.enabled || !String(wm.text || '').trim()) return { styleStr: '', safeText: '' };

  const posMap = {
    'top-left': 7, 'top-center': 8, 'top-right': 9,
    'bottom-left': 1, 'bottom-center': 2, 'bottom-right': 3
  };
  const align = posMap[String(wm.position || '').toLowerCase()] || 9; // default top-right

  const scale = height / 1920;
  const sizeMap = { small: Math.round(36 * scale), medium: Math.round(48 * scale), large: Math.round(64 * scale) };
  const fontSize = sizeMap[wm.size] || Math.round(48 * scale);

  const primaryCol = hexToAssColor(wm.color || '#FFFFFF', wm.opacity ?? 0.85);

  let borderStyle = 1;
  let outline = 2;
  let shadow = 2;
  let outlineCol = '&H60000000';
  let backCol = '&H80000000';

  if (wm.background === 'pill' || wm.background === 'box') {
    borderStyle = 3;
    outline = Math.round(8 * scale);
    shadow = 0;
    backCol = '&H90000000'; // dark semi-transparent pill
    outlineCol = '&H90000000';
  } else if (wm.shadow === 'outline') {
    borderStyle = 1;
    outline = 3;
    shadow = 0;
    outlineCol = '&H00000000';
  } else if (wm.shadow === 'none') {
    borderStyle = 1;
    outline = 0;
    shadow = 0;
  }

  const marginH = Math.round(48 * scale);
  const marginV = Math.round(60 * scale);

  const styleStr = `Style: Watermark,Nirmala UI,${fontSize},${primaryCol},${primaryCol},${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${align},${marginH},${marginH},${marginV},1`;

  const safeText = String(wm.text || '').replace(/[\r\n\t]/g, ' ').replace(/{/g, '\\{').replace(/}/g, '\\}');
  return { styleStr, safeText };
}

function toAss(lines, offset, clipEnd, style = {}, width = 1080, height = 1920, watermark = null, overlay = {}) {
  const fonts = ['Nirmala UI', 'Segoe UI', 'Impact', 'Arial', 'Montserrat', 'Roboto', 'Manrope', 'DM Sans', 'Inter'];
  let font = fonts.includes(style.font) ? style.font : 'Nirmala UI';

  // Auto-detect Hindi / Devanagari characters
  const allTexts = [
    ...lines.map(c => String(c.text || '')),
    overlay.headerHook || '',
    overlay.bottomText || '',
    overlay.partBadge || ''
  ];
  const hasHindi = allTexts.some(txt => /[\u0900-\u097F]/.test(txt));
  if (hasHindi && (font === 'Arial' || font === 'Impact' || font === 'DM Sans')) {
    font = 'Nirmala UI';
  }

  const scale = height / 1920;
  const userSize = Number(style.size) || 72;
  const size = Math.round(Math.max(48, Math.min(100, userSize)) * scale);

  const hex = String(style.color || '#FFFFFF').replace('#', '').slice(0, 6).padEnd(6, 'F');
  const assColor = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;

  const bgType = style.background || 'Pill';
  let borderStyle = 1;
  let outline = Math.round(3 * scale);
  let shadow = Math.round(2 * scale);
  let outlineCol = '&H00000000';
  let backCol = '&H80000000';

  if (bgType === 'Pill') {
    borderStyle = 3;
    outline = Math.round(10 * scale);
    shadow = 0;
    outlineCol = '&HA0000000'; // dark semi-transparent pill box
    backCol = '&HA0000000';
  } else if (bgType === 'Outline') {
    borderStyle = 1;
    outline = Math.round(5 * scale);
    shadow = 0;
    outlineCol = '&H00000000';
    backCol = '&H00000000';
  } else if (bgType === 'Shadow') {
    borderStyle = 1;
    outline = Math.round(2 * scale);
    shadow = Math.round(5 * scale);
    outlineCol = '&H00000000';
    backCol = '&HB0000000';
  } else if (bgType === 'None') {
    borderStyle = 1;
    outline = Math.round(1.5 * scale);
    shadow = Math.round(1.5 * scale);
    outlineCol = '&H00000000';
    backCol = '&H80000000';
  }

  const isVertical = height > width * 1.3; // 9:16 vertical reel layout
  const isFitBars = overlay.framingMode === 'fit-bars' || !overlay.framingMode;

  const posType = style.position || 'Bottom';
  const alignment = posType === 'Top' ? 8 : posType === 'Middle' ? 5 : 2;
  // If vertical 9:16 with fit-bars, keep dialogue subtitles off video in bottom black bar!
  const marginV = (isVertical && isFitBars && alignment === 2)
    ? Math.round(350 * scale)
    : alignment === 2 ? Math.round(260 * scale) : alignment === 8 ? Math.round(200 * scale) : 0;
  const marginH = Math.round(70 * scale);

  const { styleStr: wmStyle, safeText: wmText } = buildWatermarkStyle(watermark, width, height);

  let head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${size},${assColor},${assColor},${outlineCol},${backCol},1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1\n`;

  if (wmStyle) {
    head += wmStyle + '\n';
  }

  // Header Hook style (Upar wala Viral Title/Hook)
  if (overlay.headerHook && String(overlay.headerHook).trim()) {
    const hookCol = hexToAssColor(overlay.headerColor || '#FFE500', 1);
    const hookFontSize = Math.round((Number(overlay.headerSize) || 76) * scale);
    const hookFont = hasHindi ? 'Nirmala UI' : 'Montserrat';
    // Center in top black bar when vertical 9:16 (top bar is 0 to 656px)
    const hookMarginV = isVertical ? Math.round(270 * scale) : Math.round(40 * scale);

    const hookStyleMode = overlay.headerStyle || 'card';
    if (hookStyleMode === 'card') {
      // Yellow Card Box with Bold Black Text (Like Reference 4 "जय श्री कृष्णा")
      const boxOutline = Math.round(14 * scale);
      head += `Style: HeaderHook,${hookFont},${hookFontSize},&H00000000,&H00000000,${hookCol},${hookCol},-1,0,0,0,100,100,0,0,3,${boxOutline},0,8,${marginH},${marginH},${hookMarginV},1\n`;
    } else {
      // Bold Yellow Text with Black Outline & Drop Shadow
      const hookOutline = Math.round(6 * scale);
      const hookShadow = Math.round(3 * scale);
      head += `Style: HeaderHook,${hookFont},${hookFontSize},${hookCol},${hookCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${hookOutline},${hookShadow},8,${marginH},${marginH},${hookMarginV},1\n`;
    }
  }

  // Bottom Content Text style (e.g. "खाने कमाने का ठिकाना नहीं डिब्बे में आटा")
  const hasBottomText = overlay.bottomText && String(overlay.bottomText).trim();
  const hasPartBadge = overlay.partBadge && String(overlay.partBadge).trim();

  if (hasBottomText) {
    const btmCol = hexToAssColor(overlay.bottomColor || '#FFFFFF', 1);
    const btmFontSize = Math.round((Number(overlay.bottomSize) || 68) * scale);
    const btmFont = hasHindi ? 'Nirmala UI' : 'Montserrat';
    // If part badge is also present, place bottom text above part badge in bottom bar
    const btmMarginV = isVertical ? Math.round((hasPartBadge ? 360 : 300) * scale) : Math.round(50 * scale);
    const btmOutline = Math.round(5 * scale);
    const btmShadow = Math.round(2 * scale);
    head += `Style: BottomText,${btmFont},${btmFontSize},${btmCol},${btmCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${btmOutline},${btmShadow},2,${marginH},${marginH},${btmMarginV},1\n`;
  }

  // Part Badge style (e.g. "Part-1" or "Part-7")
  if (hasPartBadge) {
    const partCol = hexToAssColor(overlay.partColor || '#FFFFFF', 1);
    const partFontSize = Math.round((Number(overlay.partSize) || 66) * scale);
    const partFont = hasHindi ? 'Nirmala UI' : 'Impact';
    // Place in bottom bar, below bottom text or dead center of bottom bar
    const partMarginV = isVertical ? Math.round((hasBottomText ? 210 : 300) * scale) : Math.round(45 * scale);
    const partOutline = Math.round(5 * scale);
    const partShadow = Math.round(2 * scale);
    head += `Style: PartBadge,${partFont},${partFontSize},${partCol},${partCol},&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,${partOutline},${partShadow},2,${marginH},${marginH},${partMarginV},1\n`;
  }

  head += `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const totalDuration = Math.max(0.1, clipEnd - offset);

  // Permanent watermark event spanning the entire clip
  if (wmStyle && wmText) {
    head += `Dialogue: 1,0:00:00.00,${assTime(totalDuration)},Watermark,,0,0,0,,${wmText}\n`;
  }

  // Permanent Header Hook event spanning the entire clip
  if (overlay.headerHook && String(overlay.headerHook).trim()) {
    const safeHook = String(overlay.headerHook).trim().replace(/[\r\n]+/g, '\\N').replace(/[{}]/g, '');
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},HeaderHook,,0,0,0,,${safeHook}\n`;
  }

  // Permanent Bottom Content Text event spanning the entire clip
  if (hasBottomText) {
    const safeBtm = String(overlay.bottomText).trim().replace(/[\r\n]+/g, '\\N').replace(/[{}]/g, '');
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},BottomText,,0,0,0,,${safeBtm}\n`;
  }

  // Permanent Part Badge event spanning the entire clip
  if (hasPartBadge) {
    const safePart = String(overlay.partBadge).trim().replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '');
    head += `Dialogue: 2,0:00:00.00,${assTime(totalDuration)},PartBadge,,0,0,0,,${safePart}\n`;
  }

  const events = lines
    .filter(c => Number(c.end) > offset && Number(c.start) < clipEnd && String(c.text || '').trim())
    .map(c => `Dialogue: 0,${assTime(Math.max(0, Number(c.start) - offset))},${assTime(Math.min(clipEnd - offset, Number(c.end) - offset))},Default,,0,0,0,,${assWrap(String(c.text).replace(/[{}]/g, ''))}`)
    .join('\n');
  return head + events + '\n';
}

// ── Render job management ────────────────────────────────────
function parseRatio(ratio) {
  const r = ['9:16', '1:1', '4:5', '16:9'].includes(ratio) ? ratio : '9:16';
  return r;
}
function renderDimensions(ratio, resolution) {
  const res = resolution === '720p' ? 720 : 1080;
  if (ratio === '9:16') return { w: res === 1080 ? 1080 : 720, h: res === 1080 ? 1920 : 1280 };
  if (ratio === '4:5') return { w: res === 1080 ? 1080 : 720, h: res === 1080 ? 1350 : 900 };
  if (ratio === '1:1') return { w: res, h: res };
  // 16:9
  return { w: res === 1080 ? 1920 : 1280, h: res };
}

function renderJob(project, options) {
  const id = crypto.randomUUID();
  const output = path.join(EXPORTS, `${id}.mp4`);
  const start = Math.max(0, Number(options.start) || 0);
  const end = Math.min(project.duration, Number(options.end) || 0);
  if (end <= start) throw new Error('Clip end time must be after start time.');

  const rawDuration = end - start;
  const ratio = parseRatio(options.ratio);
  const { w: width, h: height } = renderDimensions(ratio, options.resolution || '1080p');

  const captions = Array.isArray(options.captions)
    ? groupCaptions(options.captions.filter(c => String(c.text || '').trim() && Number(c.end) > Number(c.start)), start, end)
    : [];
  const captionMode = ['Burned in', 'Separate .srt', 'Both'].includes(options.captionMode) ? options.captionMode : 'Burned in';

  // ── Framing Mode & Aspect Ratio Calculation ──
  const framingMode = ['fit-bars', 'blur-bg', 'crop-fill'].includes(options.framingMode) ? options.framingMode : 'fit-bars';
  const zoom = Math.max(0.5, Math.min(2.0, Number(options.zoom) || 1.0));

  let captionFile = null;
  let tempAssFile = null;
  const hasWatermark = options.watermark && options.watermark.enabled && String(options.watermark.text || '').trim();
  const hasOverlay = Boolean(
    (options.headerHook && String(options.headerHook).trim()) ||
    (options.bottomText && String(options.bottomText).trim()) ||
    (options.partBadge && String(options.partBadge).trim())
  );

  if (captions.length) {
    captionFile = path.join(EXPORTS, `${id}.srt`);
    fs.writeFileSync(captionFile, '\ufeff' + toSrt(captions, start, end), 'utf8');
  }

  let assEscaped = null;
  if (((captions.length && captionMode !== 'Separate .srt') || hasWatermark || hasOverlay) && ratio !== '16:9') {
    const style = options.style || {};
    const overlay = {
      headerHook: options.headerHook,
      headerStyle: options.headerStyle || 'card',
      headerColor: options.headerColor || '#FFE500',
      headerSize: options.headerSize || 76,
      bottomText: options.bottomText,
      partBadge: options.partBadge,
      partColor: options.partColor || '#FFFFFF',
      partSize: options.partSize || 66,
      framingMode,
      ratio
    };
    tempAssFile = path.join(DATA, `${id}.ass`);
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

  let baseVideoFilter;
  if (framingMode === 'blur-bg') {
    baseVideoFilter = `split=2[bg][fg];[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=25:5,drawbox=t=fill:c=black@0.45[bg2];[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  } else if (framingMode === 'crop-fill') {
    if (zoom !== 1.0) {
      baseVideoFilter = `crop=in_w/${zoom}:in_h/${zoom}:(in_w-out_w)/2:(in_h-out_h)/2,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    } else {
      baseVideoFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
    }
  } else {
    // fit-bars (Classic Viral Movie / Meme Style - Default)
    baseVideoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }

  // ── Copyright Shield (Smart Transform) Evaluation ──
  const shieldOpt = options.copyrightShield;
  const isShield = !!(shieldOpt === true || (shieldOpt && shieldOpt.enabled !== false));
  const shield = isShield ? {
    enabled: true,
    visualMod: shieldOpt.visualMod !== false,
    speedShift: shieldOpt.speedShift !== false,
    progressBar: shieldOpt.progressBar !== false,
    bgmTrack: String(shieldOpt.bgmTrack || 'none').toLowerCase().trim(),
    bgmVolume: Number.isFinite(Number(shieldOpt.bgmVolume)) ? Math.min(1, Math.max(0, Number(shieldOpt.bgmVolume))) : 0.12
  } : null;

  let args = [];
  let targetDuration = rawDuration;

  if (!shield) {
    // ── Standard Pipeline (Shield Disabled / Backward Compatible) ──
    const filters = [baseVideoFilter];
    if (assEscaped) {
      filters.push(`ass='${assEscaped}'`);
    }
    args = [
      '-y',
      '-ss', String(start),
      '-i', path.join(UPLOADS, project.filename),
      '-t', String(rawDuration),
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      output
    ];
  } else {
    // ── Shield Enabled Pipeline ──
    const vFilters = [baseVideoFilter];

    if (shield.visualMod) {
      if (framingMode === 'crop-fill') {
        // 104.16% subtle zoom & crop to disrupt visual frame fingerprint
        vFilters.push(`crop=in_w*0.96:in_h*0.96:(in_w-out_w)/2:(in_h-out_h)/2`);
        vFilters.push(`scale=${width}:${height}`);
      }
      // Micro color & contrast grading
      vFilters.push(`eq=contrast=1.03:brightness=0.01:saturation=1.04`);
    }

    // Subtitles and watermark are burned in BEFORE speedup so audio/dialogue timing stays perfectly aligned
    if (assEscaped) {
      vFilters.push(`ass='${assEscaped}'`);
    }

    if (shield.progressBar && ratio !== '16:9') {
      // Sleek neon lime bottom progress bar (drawbox over clip duration)
      vFilters.push(`drawbox=x=0:y=ih-8:w='iw*(t/${rawDuration.toFixed(2)})':h=6:color=0xC8FF63@0.85:t=fill`);
    }

    if (shield.speedShift) {
      // Accelerate video PTS by 1.02x
      vFilters.push(`setpts=(1/1.02)*PTS`);
    }

    const speedFactor = shield.speedShift ? 1.02 : 1.0;
    targetDuration = rawDuration / speedFactor;

    // Check optional BGM loop
    let bgmPath = null;
    if (shield.bgmTrack && shield.bgmTrack !== 'none') {
      const candidate = path.join(BGM_DIR, `${shield.bgmTrack}.mp3`);
      if (fs.existsSync(candidate)) {
        bgmPath = candidate;
      }
    }

    if (bgmPath) {
      const fadeDuration = Math.max(0.5, Math.min(1.5, targetDuration / 4));
      const fadeOutStart = Math.max(0, targetDuration - fadeDuration);
      const bgmVol = shield.bgmVolume.toFixed(2);

      const filterComplex = [
        `[0:v]${vFilters.join(',')}[vfinal]`,
        `[0:a]${shield.speedShift ? 'atempo=1.02' : 'anull'}[voice]`,
        `[1:a]volume=${bgmVol},afade=t=in:st=0:d=${fadeDuration.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeDuration.toFixed(2)}[bgm]`,
        `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      ].join(';');

      args = [
        '-y',
        '-ss', String(start),
        '-i', path.join(UPLOADS, project.filename),
        '-stream_loop', '-1',
        '-i', bgmPath,
        '-t', String(rawDuration),
        '-filter_complex', filterComplex,
        '-map', '[vfinal]',
        '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        output
      ];
    } else {
      args = [
        '-y',
        '-ss', String(start),
        '-i', path.join(UPLOADS, project.filename),
        '-t', String(rawDuration),
        '-vf', vFilters.join(','),
        ...(shield.speedShift ? ['-af', 'atempo=1.02'] : []),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        output
      ];
    }
  }

  const jobTitle = options.clipTitle || (options.partBadge || `Clip ${id.slice(0, 4)}`);
  const downloadName = options.downloadName || `ClipMaster-${id.slice(0, 6)}.mp4`;
  const job = {
    id, status: 'queued', progress: 0,
    output, captionFile,
    projectId: project.id,
    start, end,
    targetDuration,
    shieldEnabled: isShield,
    title: jobTitle,
    downloadName,
    framingMode,
    zoom,
    headerHook: options.headerHook || null,
    headerStyle: options.headerStyle || 'card',
    headerColor: options.headerColor || '#FFE500',
    bottomText: options.bottomText || null,
    partBadge: options.partBadge || null,
    ratio, resolution: options.resolution || '1080p',
    startedAt: Date.now()
  };
  jobs.set(id, job);
  renderQueue.push({ job, args, start, end, targetDuration, tempAssFile });
  startNextRender();
  return job;
}

function startNextRender() {
  while (activeRenders < MAX_PARALLEL_RENDERS && renderQueue.length) {
    const { job, args, start, end, targetDuration, tempAssFile } = renderQueue.shift();
    activeRenders++;
    job.status = 'rendering';
    job.renderStartedAt = Date.now();

    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', b => { err += b.toString(); if (err.length > 15000) err = err.slice(-10000); });
    child.stdout.on('data', b => {
      const m = b.toString().match(/out_time_ms=(\d+)/);
      if (m) {
        const totalDur = targetDuration || (end - start);
        job.progress = Math.min(98, Math.round((Number(m[1]) / 1_000_000) / totalDur * 100));
      }
    });
    child.on('error', e => {
      job.status = 'failed';
      job.error = `Could not start FFmpeg: ${e.message}`;
      if (tempAssFile && fs.existsSync(tempAssFile)) { try { fs.unlinkSync(tempAssFile); } catch {} }
    });
    child.on('close', code => {
      if (code === 0) {
        job.status = 'complete'; job.progress = 100; job.completedAt = Date.now();
      } else {
        job.status = 'failed';
        job.error = err.trim().split('\n').slice(-5).join(' ').slice(0, 600) || `FFmpeg exited with code ${code}`;
      }
      if (tempAssFile && fs.existsSync(tempAssFile)) { try { fs.unlinkSync(tempAssFile); } catch {} }
      activeRenders--;
      startNextRender();
    });
  }
}

// ── Main request handler ────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // ── Health ──────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const networkIps = getNetworkIps();
    return json(res, 200, {
      ok: true,
      ffmpeg: true,
      mode: 'network',
      version: '2.0',
      port: PORT,
      localUrl: `http://localhost:${PORT}`,
      networkUrls: networkIps.map(ip => `http://${ip}:${PORT}`),
      primaryNetworkUrl: networkIps.length ? `http://${networkIps[0]}:${PORT}` : `http://localhost:${PORT}`
    });
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

  // ── Projects list ───────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return json(res, 200, loadProjects().map(({ filename, ...p }) => p));
  }

  // ── Chunked Upload (Safe for Cloudflare 100MB limit, Render, Proxies, up to 8GB) ──
  if (req.method === 'POST' && url.pathname === '/api/upload/chunk') {
    const uploadId = safeName(req.headers['x-upload-id'] || '');
    if (!uploadId) return json(res, 400, { error: 'Missing X-Upload-Id header.' });

    const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
    const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
    const original = safeName(decodeURIComponent(req.headers['x-file-name'] || 'video.mp4'));
    const totalSize = parseInt(req.headers['x-file-size'], 10) || 0;
    const ext = path.extname(original).toLowerCase();

    if (!['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext)) {
      return json(res, 415, { error: 'Unsupported format. Use MP4, MOV, MKV, WEBM, or M4V.' });
    }
    if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      return json(res, 400, { error: 'Invalid chunk index parameters.' });
    }

    const tmpFile = path.join(UPLOADS, `tmp_${uploadId}.part`);
    if (chunkIndex === 0 && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    const out = fs.createWriteStream(tmpFile, { flags: chunkIndex === 0 ? 'w' : 'a' });
    req.pipe(out);

    out.on('error', e => {
      if (!res.headersSent) json(res, 500, { error: `Chunk write error: ${e.message}` });
    });

    out.on('finish', async () => {
      if (chunkIndex < totalChunks - 1) {
        return json(res, 200, { ok: true, chunk: chunkIndex });
      }

      // Final chunk arrived!
      const id = crypto.randomUUID();
      const filename = `${id}${ext}`;
      const dest = path.join(UPLOADS, filename);

      try {
        fs.renameSync(tmpFile, dest);
        const meta = await probe(dest);
        const project = {
          id, filename, name: meta.title || original, originalName: original,
          sourceUrl: null,
          duration: meta.duration, width: meta.width, height: meta.height, size: meta.size || totalSize,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        const all = loadProjects();
        all.unshift(project);
        saveProjects(all);
        const { filename: _omit, ...pub } = project;
        return json(res, 201, { project: pub });
      } catch (e) {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
        return json(res, 422, { error: `Could not process video: ${e.message}` });
      }
    });
    return;
  }

  // ── Upload ──────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const original = safeName(decodeURIComponent(req.headers['x-file-name'] || 'video.mp4'));
    const ext = path.extname(original).toLowerCase();
    if (!['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext)) {
      return json(res, 415, { error: 'Unsupported format. Use MP4, MOV, MKV, WEBM, or M4V.' });
    }
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'File exceeds the 8 GB limit.' });

    const id = crypto.randomUUID();
    const filename = `${id}${ext}`;
    const dest = path.join(UPLOADS, filename);
    const out = fs.createWriteStream(dest, { flags: 'wx' });
    let received = 0, failed = false;

    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) { failed = true; req.destroy(new Error('Upload exceeds 8 GB limit.')); }
    });
    req.pipe(out);
    out.on('error', e => { if (!res.headersSent) json(res, 500, { error: e.message }); });
    out.on('finish', async () => {
      if (failed) return;
      try {
        const meta = await probe(dest);
        const project = {
          id, filename, name: meta.title, originalName: original,
          sourceUrl: null,
          duration: meta.duration, width: meta.width, height: meta.height, size: meta.size,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        const all = loadProjects(); all.unshift(project); saveProjects(all);
        const { filename: _omit, ...pub } = project;
        json(res, 201, { project: pub });
      } catch (e) {
        fs.rmSync(dest, { force: true });
        json(res, 422, { error: `Could not read video: ${e.message}` });
      }
    });
    return;
  }

  // ── YouTube import (Async capable with status polling to prevent Cloudflare 100s timeout) ──
  if (req.method === 'POST' && (url.pathname === '/api/youtube' || url.pathname === '/api/youtube/')) {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }

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

  // ── YouTube download status polling ──────────────────────
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'youtube' && parts[2] === 'status' && parts[3]) {
    const downloadId = parts[3];
    const item = ytDownloads.get(downloadId);
    if (!item) return json(res, 404, { error: 'Download job not found or expired.' });
    return json(res, 200, item);
  }

  // ── Social Accounts & Facebook/Instagram API ─────────────
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    return json(res, 200, publicAccounts());
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/facebook/token') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const accounts = await verifyFacebookToken(body.token);
      return json(res, 200, { ok: true, accounts });
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/instagram/refresh') {
    try {
      const accounts = await refreshInstagramAccounts();
      return json(res, 200, { ok: true, accounts });
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/instagram/link') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const accounts = await linkManualInstagramAccount(body);
      return json(res, 200, { ok: true, accounts });
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/accounts/facebook') {
    disconnectFacebook();
    return json(res, 200, { ok: true, disconnected: true });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/accounts/instagram') {
    disconnectInstagram();
    return json(res, 200, { ok: true, disconnected: true });
  }

  // ── AI Copy & Viral Hashtags ─────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/ai/copy') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const copy = await generateAiPostCopy(body);
      return json(res, 200, copy);
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  // ── Facebook Direct Video Publish (Legacy / Backward-compatible) ───
  if (req.method === 'POST' && url.pathname === '/api/publish/facebook') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const result = await publishVideoToFacebook(body);
      return json(res, 200, result);
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  // ── Multi-Format Quote Image Preview ─────────────────────
  if (req.method === 'POST' && url.pathname === '/api/publish/image-preview') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const jobId = String(body.jobId || '').trim();
      if (!jobId) throw new Error('jobId is required.');
      const videoPath = path.join(EXPORTS, `${jobId}.mp4`);
      if (!fs.existsSync(videoPath)) throw new Error(`Clip ${jobId} video file not found.`);

      const quoteInfo = extractBestQuote(jobId, body.fallbackTitle || 'Viral Moment');
      const quoteText = body.quoteText && body.quoteText.trim() ? body.quoteText.trim() : quoteInfo.quoteText;
      const ratio = body.ratio === '4:5' ? '4:5' : '1:1';

      const previewFilename = `preview_${jobId}_${ratio.replace(':', '_')}.jpg`;
      const previewPath = path.join(PREVIEWS, previewFilename);

      await generateQuoteImage({
        videoPath,
        quoteText,
        ratio,
        watermark: body.watermark || null,
        outputPath: previewPath,
        timestamp: quoteInfo.timestamp
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

  // ── Serve Preview Images ─────────────────────────────────
  if (req.method === 'GET' && url.pathname.startsWith('/api/preview/images/')) {
    const filename = path.basename(url.pathname);
    const filepath = path.join(PREVIEWS, filename);
    if (!fs.existsSync(filepath)) return json(res, 404, { error: 'Preview image not found.' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-cache, must-revalidate'
    });
    return fs.createReadStream(filepath).pipe(res);
  }

  // ── Instagram Direct Reel Publish ─────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/publish/instagram') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const result = await publishReelToInstagram(body);
      return json(res, 200, result);
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  // ── Multi-Format Direct Publish ──────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/publish/multi') {
    let body;
    try { body = await parseBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    try {
      const result = await publishMultiFormat(body);
      return json(res, 200, result);
    } catch (e) { return json(res, 422, { error: e.message }); }
  }

  // ── Project routes ──────────────────────────────────────
  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
    const project = getProject(parts[2]);
    if (!project) return json(res, 404, { error: 'Project not found.' });

    if (req.method === 'GET' && !parts[3]) {
      const { filename, ...pub } = project;
      return json(res, 200, { project: pub });
    }

    if (req.method === 'PATCH' && !parts[3]) {
      let body;
      try { body = await parseBody(req); }
      catch (e) { return json(res, 400, { error: e.message }); }
      const updated = withProject(project.id, {
        name: body.name !== undefined ? safeName(body.name).replace(/_/g, ' ') : project.name
      });
      const { filename: _omit, ...pub } = updated;
      return json(res, 200, { ok: true, project: pub });
    }

    if (req.method === 'DELETE' && !parts[3]) {
      const all = loadProjects();
      const filtered = all.filter(p => p.id !== project.id);
      saveProjects(filtered);

      try {
        const videoFile = path.join(UPLOADS, project.filename);
        if (fs.existsSync(videoFile)) fs.rmSync(videoFile, { force: true });
        const base = path.join(UPLOADS, project.id);
        for (const ext of ['.en-orig.vtt', '.hi-orig.vtt', '.en.vtt', '.hi.vtt']) {
          const vtt = base + ext;
          if (fs.existsSync(vtt)) fs.rmSync(vtt, { force: true });
        }
        (project.autoClips || []).forEach(c => {
          const expMp4 = path.join(EXPORTS, `${c.jobId}.mp4`);
          const expSrt = path.join(EXPORTS, `${c.jobId}.srt`);
          const ass = path.join(DATA, `${c.jobId}.ass`);
          if (fs.existsSync(expMp4)) fs.rmSync(expMp4, { force: true });
          if (fs.existsSync(expSrt)) fs.rmSync(expSrt, { force: true });
          if (fs.existsSync(ass)) fs.rmSync(ass, { force: true });
          jobs.delete(c.jobId);
        });
      } catch (err) {
        console.warn('Cleanup error during project deletion:', err.message);
      }
      return json(res, 200, { ok: true, deleted: project.id });
    }

    if (req.method === 'DELETE' && parts[3] === 'clips' && parts[4]) {
      const clipId = parts[4];
      const clips = (project.autoClips || []).filter(c => c.jobId !== clipId);
      withProject(project.id, { autoClips: clips });
      try {
        const expMp4 = path.join(EXPORTS, `${clipId}.mp4`);
        const expSrt = path.join(EXPORTS, `${clipId}.srt`);
        const ass = path.join(DATA, `${clipId}.ass`);
        if (fs.existsSync(expMp4)) fs.rmSync(expMp4, { force: true });
        if (fs.existsSync(expSrt)) fs.rmSync(expSrt, { force: true });
        if (fs.existsSync(ass)) fs.rmSync(ass, { force: true });
        jobs.delete(clipId);
      } catch (err) {}
      return json(res, 200, { ok: true, deleted: clipId });
    }

    if (req.method === 'GET' && parts[3] === 'video') {
      const videoFile = path.join(UPLOADS, project.filename);
      return streamFile(req, res, videoFile, contentType(project.filename));
    }

    if (req.method === 'GET' && parts[3] === 'auto-jobs') {
      const clips = project.autoClips || [];
      const items = clips.map(clip => {
        const job = jobs.get(clip.jobId);
        const file = path.join(EXPORTS, `${clip.jobId}.mp4`);
        if (job) return { jobId: clip.jobId, status: job.status, progress: job.progress || 0, error: job.error || null, downloadUrl: job.status === 'complete' ? `/api/jobs/${clip.jobId}/download` : null };
        return fs.existsSync(file)
          ? { jobId: clip.jobId, status: 'complete', progress: 100, downloadUrl: `/api/jobs/${clip.jobId}/download` }
          : { jobId: clip.jobId, status: 'failed', progress: 0, error: 'Render did not persist across server restart.' };
      });
      const complete = items.filter(x => x.status === 'complete').length;
      const failed = items.filter(x => x.status === 'failed').length;
      const progress = items.length ? Math.round(items.reduce((s, x) => s + (x.status === 'complete' ? 100 : x.progress), 0) / items.length) : 0;
      return json(res, 200, { jobs: items, total: items.length, complete, failed, progress });
    }

    if (req.method === 'POST' && parts[3] === 'auto-shorts') {
      let body;
      try { body = await parseBody(req); }
      catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const mode = body.mode === 'full' ? 'full' : 'highlights';
        const track = chooseCaptionTrack(project, body.language || 'auto');
        const cues = track ? parseVtt(track.file) : [];
        let highlights = [], aiUsed = false, segmentSeconds = null;

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
          if (total > 500) return json(res, 422, { error: `Would create ${total} clips. Increase segment length to at least ${Math.ceil(project.duration / 500)}s (max 500 clips).` });
          for (let start = 0, index = 0; start < project.duration; start += segmentSeconds, index++) {
            const end = Math.min(project.duration, start + segmentSeconds);
            const partNum = index + 1;
            const partBadge = partPattern
              ? partPattern.replace(/\{n\}/gi, String(partNum)).replace(/\{pad\}/gi, String(partNum).padStart(3, '0'))
              : `Part-${partNum}`;
            highlights.push({
              start, end, score: null,
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
          if (!track) return json(res, 422, { error: 'No captions found for this video. Use "Entire Video" mode instead, or choose a YouTube video with English/Hindi captions.' });
          const wanted = Math.max(1, Math.min(50, Math.floor(Number(body.clipCount) || 3)));
          const targetDuration = Number(body.targetDuration) || 35;
          const pool = findHighlights(cues, project.duration, Math.min(100, wanted * 3), targetDuration);
          highlights = await rankWithLocalAi(pool, wanted);
          aiUsed = !!highlights;
          if (!highlights) highlights = pool.sort((a, b) => b.score - a.score).slice(0, wanted).sort((a, b) => a.start - b.start);
          for (let i = 0; i < highlights.length; i++) {
            const partNum = i + 1;
            highlights[i].partBadge = partPattern ? partPattern.replace(/\{n\}/gi, String(partNum)).replace(/\{pad\}/gi, String(partNum).padStart(3, '0')) : `Part ${partNum}`;
            highlights[i].headerHook = headerHook;
            highlights[i].headerStyle = headerStyle;
            highlights[i].headerColor = headerColor;
            highlights[i].bottomText = bottomText;
          }
        }

        const style = body.style || { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom' };
        const ratio = parseRatio(body.ratio || '9:16');
        const resolution = body.resolution || '1080p';
        const watermark = body.watermark || null;
        const copyrightShield = body.copyrightShield || null;
        const captionMode = body.captionMode || 'Burned in';
        const created = highlights.map((h, i) => renderJob(project, {
          start: h.start, end: h.end,
          captions: h.captions, ratio, resolution,
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
          jobId: j.id, title: j.title, start: j.start, end: j.end,
          score: highlights[i].score, downloadName: j.downloadName,
          headerHook: j.headerHook,
          headerStyle: j.headerStyle,
          bottomText: j.bottomText,
          partBadge: j.partBadge,
          framingMode: j.framingMode,
          ratio: j.ratio,
          downloadUrl: `/api/jobs/${j.id}/download`
        }));

        withProject(project.id, {
          autoClips: clips, autoMode: mode, segmentSeconds,
          captionLanguage: track?.language || null, aiPicked: aiUsed
        });

        return json(res, 202, {
          projectId: project.id, mode,
          language: track?.language || null,
          aiUsed, aiDiagnostic,
          model: aiUsed ? (process.env.CLIPMASTER_AI_MODEL || 'qwen2.5:3b') : null,
          segmentSeconds, total: clips.length, clips
        });
      } catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'POST' && parts[3] === 'render') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) return json(res, 413, { error: 'Render payload too large.' });
      }
      try {
        const options = JSON.parse(body || '{}');
        const updated = String(options.projectName || '').trim();
        const renderProject = updated ? withProject(project.id, { name: updated }) : project;
        const job = renderJob(renderProject, options);

        if (options.clipJobId && project.autoClips && project.autoClips.length) {
          const updatedClips = project.autoClips.map(c => {
            if (c.jobId === options.clipJobId) {
              return {
                ...c,
                jobId: job.id,
                title: options.clipTitle || options.partBadge || c.title,
                partBadge: options.partBadge !== undefined ? options.partBadge : c.partBadge,
                headerHook: options.headerHook !== undefined ? options.headerHook : c.headerHook,
                headerStyle: options.headerStyle !== undefined ? options.headerStyle : c.headerStyle,
                bottomText: options.bottomText !== undefined ? options.bottomText : c.bottomText,
                framingMode: options.framingMode || c.framingMode,
                ratio: options.ratio || c.ratio,
                downloadUrl: `/api/jobs/${job.id}/download`
              };
            }
            return c;
          });
          withProject(project.id, { autoClips: updatedClips });
        }

        return json(res, 202, { jobId: job.id, status: job.status });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
  }

  // ── Job routes ──────────────────────────────────────────
  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const jobId = parts[2];
    const job = jobs.get(jobId);

    // Check persisted clips if job not in memory
    if (!job) {
      const file = path.join(EXPORTS, `${jobId}.mp4`);
      const saved = loadProjects().flatMap(p => p.autoClips || []).find(c => c.jobId === jobId);
      if (saved && req.method === 'GET' && parts[3] === 'download' && fs.existsSync(file)) {
        return streamFile(req, res, file, 'video/mp4', saved.downloadName || `Short-${jobId.slice(0,6)}.mp4`);
      }
      if (saved && req.method === 'GET' && !parts[3] && fs.existsSync(file)) {
        return json(res, 200, { id: jobId, title: saved.title, start: saved.start, end: saved.end, status: 'complete', progress: 100, downloadUrl: `/api/jobs/${jobId}/download` });
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
        id: job.id, title: job.title, start: job.start, end: job.end,
        status: job.status, progress: job.progress,
        error: job.error || null,
        downloadUrl: job.status === 'complete' ? `/api/jobs/${job.id}/download` : null,
        subtitleUrl: job.status === 'complete' && job.captionFile ? `/api/jobs/${job.id}/captions` : null
      });
    }
  }

  // ── Serve index.html ────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  return json(res, 404, { error: 'Not found.' });
}

// ── Server ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch(e => {
    if (!res.headersSent) json(res, 500, { error: e.message || 'Unexpected server error.' });
    else res.destroy(e);
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.log(`\nClipMaster is already running on port ${PORT}.\nOpen http://localhost:${PORT} in your browser.\n`);
    process.exit(0);
  }
  console.error(`ClipMaster failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const networkIps = getNetworkIps();
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ✓ ClipMaster v2.0 is LIVE & READY`);
  console.log(`  🖥️  PC / Local:       http://localhost:${PORT}`);
  if (networkIps.length) {
    networkIps.forEach(ip => {
      console.log(`  📱  Mobile / Network:  http://${ip}:${PORT}`);
    });
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (process.env.FB_ACCESS_TOKEN && process.env.FB_ACCESS_TOKEN.trim()) {
    verifyFacebookToken(process.env.FB_ACCESS_TOKEN.trim())
      .then(accounts => {
        saveAccounts(accounts);
        console.log(`  ✓ Meta / Facebook Accounts auto-connected via FB_ACCESS_TOKEN`);
      })
      .catch(err => {
        console.log(`  ⚠ Auto-connect failed: ${err.message}`);
      });
  }
});
