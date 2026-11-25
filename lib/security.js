'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function validateUploadId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UPLOAD_ID_RE.test(trimmed) ? trimmed : null;
}

function safeResolveInside(baseDir, targetName) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, String(targetName || ''));
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid file path.');
  }
  return resolvedTarget;
}

function safeDecodeHeader(value, fallback = 'video.mp4') {
  if (!value) return fallback;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function safeName(input) {
  return path.basename(String(input || 'video.mp4'))
    .normalize('NFKC')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100) || 'video.mp4';
}

// ── Atomic JSON persistence with per-file serialization ────
const writeQueues = new Map();

function enqueueFileWrite(filePath, fn) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(filePath, next.catch(() => {}));
  return next;
}

function atomicWriteFileSync(filePath, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, mode); } catch {}
  }
}

function atomicWriteJsonSync(filePath, value, mode = 0o644) {
  atomicWriteFileSync(filePath, JSON.stringify(value, null, 2), mode);
}

// ── Access key, signed session cookies, and CSRF/Origin checks ──
function getOrCreateAccessKey(dataDir) {
  const envKey = String(process.env.CLIPMASTER_ACCESS_KEY || '').trim();
  if (envKey) return envKey;

  const keyFile = path.join(dataDir, '.access_key');
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, 'utf8').trim();
      if (existing.length >= 8) return existing;
    }
  } catch {}

  const generated = crypto.randomBytes(12).toString('base64url');
  atomicWriteFileSync(keyFile, generated + '\n', 0o600);
  return generated;
}

function getOrCreateSessionSecret(dataDir) {
  const envSecret = String(process.env.CLIPMASTER_SESSION_SECRET || '').trim();
  if (envSecret) return envSecret;

  const secretFile = path.join(dataDir, '.session_secret');
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
  } catch {}

  const generated = crypto.randomBytes(32).toString('hex');
  atomicWriteFileSync(secretFile, generated + '\n', 0o600);
  return generated;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSessionToken(secret, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${exp}.${nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  if (!nonce || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', secret).update(`${expStr}.${nonce}`).digest('base64url');
  return timingSafeEqualStr(sig, expectedSig);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try { cookies[k] = decodeURIComponent(v); } catch { cookies[k] = v; }
    }
  }
  return cookies;
}

function isDirectLoopback(req) {
  if (String(process.env.CLIPMASTER_REQUIRE_LOCAL_AUTH || '') === '1') {
    return false;
  }
  // Requests forwarded by Cloudflare Tunnel or any reverse proxy are NOT direct local loopback
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) {
    return false;
  }
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthenticated(req, accessKey, sessionSecret) {
  if (isDirectLoopback(req)) return true;

  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (timingSafeEqualStr(token, accessKey)) return true;
  }

  const keyHeader = req.headers['x-clipmaster-key'];
  if (keyHeader && timingSafeEqualStr(String(keyHeader).trim(), accessKey)) {
    return true;
  }

  const cookies = parseCookies(req);
  if (cookies.cm_session && verifySessionToken(cookies.cm_session, sessionSecret)) {
    return true;
  }

  return false;
}

function checkSameOrigin(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return true; // Non-browser clients / same-origin fetch without Origin
  if (!host) return false;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

class RateLimiter {
  constructor({ windowMs = 60_000, max = 30 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length >= this.max) {
      return { allowed: false, retryAfterSec: Math.ceil((list[0] + this.windowMs - now) / 1000) };
    }
    list.push(now);
    if (this.hits.size > 2000) {
      for (const [k, v] of this.hits.entries()) {
        if (!v.length || v[v.length - 1] <= cutoff) this.hits.delete(k);
      }
    }
    return { allowed: true, retryAfterSec: 0 };
  }
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = {
  isUuid,
  validateUploadId,
  safeResolveInside,
  safeDecodeHeader,
  safeName,
  enqueueFileWrite,
  atomicWriteFileSync,
  atomicWriteJsonSync,
  getOrCreateAccessKey,
  getOrCreateSessionSecret,
  timingSafeEqualStr,
  signSessionToken,
  verifySessionToken,
  isDirectLoopback,
  isAuthenticated,
  checkSameOrigin,
  RateLimiter,
  getClientIp
};
