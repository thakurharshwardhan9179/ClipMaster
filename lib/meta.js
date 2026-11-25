'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { atomicWriteJsonSync, enqueueFileWrite, isUuid, safeResolveInside } = require('./security');
const { generateQuoteImage, getFfmpegBin } = require('./ffmpeg');

const execFileAsync = promisify(execFile);

async function fileAsBlob(filePath, mimeType) {
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath, { type: mimeType });
  }
  const buf = await fs.promises.readFile(filePath);
  return new Blob([buf], { type: mimeType });
}

function computeUploadTimeoutMs(byteSize, minMs = 300000) {
  const bytes = Math.max(0, Number(byteSize) || 0);
  // Allow conservative ~100 KB/s upload bandwidth plus server processing headroom, bounded [minMs, 20 min]
  const estimatedMs = Math.ceil(bytes / (100 * 1024)) * 1000 + 60000;
  return Math.min(20 * 60 * 1000, Math.max(minMs, estimatedMs));
}

function isTimeoutError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || '');
  return name === 'TimeoutError' || name === 'AbortError' || /timed out|aborted due to timeout/i.test(msg);
}

async function fetchWithPhase(url, options, timeoutMs, phaseLabel) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      const secs = Math.round(timeoutMs / 1000);
      const timeoutErr = new Error(`${phaseLabel} timed out after ${secs}s. Check your internet upload speed or try again.`);
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }
}

function createMetaService({ dataDir, exportsDir, previewsDir }) {
  const ACCOUNTS_FILE = path.join(dataDir, 'accounts.json');

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
    atomicWriteJsonSync(ACCOUNTS_FILE, data, 0o600);
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

    const meRes = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000)
    });
    const meData = await meRes.json();
    if (meData.error) {
      throw new Error(meData.error.message || 'Invalid or expired Facebook Access Token.');
    }

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

    await enqueueFileWrite(ACCOUNTS_FILE, () => {
      const accounts = loadAccounts();
      accounts.facebook = {
        connected: true,
        connectedAt: new Date().toISOString(),
        user: { id: meData.id, name: meData.name },
        userAccessToken: token,
        pages
      };
      accounts.instagram = {
        connected: igAccounts.length > 0,
        connectedAt: igAccounts.length > 0 ? new Date().toISOString() : null,
        accounts: igAccounts
      };
      saveAccounts(accounts);
    });

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

    await enqueueFileWrite(ACCOUNTS_FILE, () => {
      accounts.instagram = {
        connected: igAccounts.length > 0,
        connectedAt: igAccounts.length > 0 ? new Date().toISOString() : null,
        accounts: igAccounts
      };
      saveAccounts(accounts);
    });
    return publicAccounts();
  }

  async function linkManualInstagramAccount({ igUserId, pageId }) {
    const cleanIgId = String(igUserId || '').trim();
    if (!/^[0-9]+$/.test(cleanIgId)) {
      throw new Error('Please enter a valid numeric Instagram Account ID.');
    }
    const accounts = loadAccounts();
    if (!accounts.facebook || !accounts.facebook.connected) {
      throw new Error('Please connect your Facebook account first.');
    }
    const pages = accounts.facebook.pages || [];
    const page = pages.find(p => p.id === pageId) || pages[0];
    if (!page) throw new Error('Facebook Page not found.');

    const pToken = page.access_token || accounts.facebook.userAccessToken;
    const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(cleanIgId)}?fields=id,username,name,profile_picture_url&access_token=${encodeURIComponent(pToken)}`, {
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message || 'Could not verify Instagram Account ID with current token.');
    }

    await enqueueFileWrite(ACCOUNTS_FILE, () => {
      const fresh = loadAccounts();
      if (!fresh.instagram) fresh.instagram = { connected: true, accounts: [] };
      fresh.instagram.connected = true;
      fresh.instagram.connectedAt = new Date().toISOString();
      if (!fresh.instagram.accounts) fresh.instagram.accounts = [];

      const newAccount = {
        id: data.id,
        username: data.username || data.name || cleanIgId,
        name: data.name || data.username || cleanIgId,
        profile_picture_url: data.profile_picture_url || null,
        pageId: page.id,
        pageName: page.name,
        access_token: pToken
      };

      const existingIdx = fresh.instagram.accounts.findIndex(a => a.id === data.id);
      if (existingIdx >= 0) fresh.instagram.accounts[existingIdx] = newAccount;
      else fresh.instagram.accounts.push(newAccount);
      saveAccounts(fresh);
    });

    return publicAccounts();
  }

  function disconnectFacebook() {
    saveAccounts({ facebook: null, instagram: null });
    return { ok: true };
  }

  function disconnectInstagram() {
    const accounts = loadAccounts();
    accounts.instagram = { connected: false, accounts: [] };
    saveAccounts(accounts);
    return { ok: true };
  }

  function resolveClipVideoPath(jobId) {
    if (!isUuid(jobId)) throw new Error('Invalid clip jobId.');
    const videoPath = safeResolveInside(exportsDir, `${jobId}.mp4`);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file for clip ${jobId} not found on disk.`);
    }
    return videoPath;
  }

  async function publishVideoChunkedToFacebook({ videoPath, stat, page, pageToken, title, description, onProgress }) {
    const startParams = new URLSearchParams({
      upload_phase: 'start',
      file_size: String(stat.size),
      access_token: pageToken
    });
    const startRes = await fetchWithPhase(
      `https://graph-video.facebook.com/v20.0/${encodeURIComponent(page.id)}/videos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: startParams.toString()
      },
      60000,
      'Facebook chunked video init'
    );
    const startData = await startRes.json();
    if (!startRes.ok || startData.error || !startData.upload_session_id) {
      throw new Error(startData.error?.message || `Chunked init HTTP ${startRes.status}`);
    }

    const sessionId = startData.upload_session_id;
    let startOffset = Number(startData.start_offset || 0);
    let endOffset = Number(startData.end_offset || Math.min(stat.size, 8 * 1024 * 1024));
    const maxChunkBytes = 8 * 1024 * 1024;
    const fullBlob = await fileAsBlob(videoPath, 'application/octet-stream');

    while (startOffset < stat.size) {
      const clampedEnd = Math.min(stat.size, Math.max(startOffset + 1, Math.min(endOffset, startOffset + maxChunkBytes)));
      const chunkBlob = fullBlob.slice(startOffset, clampedEnd, 'application/octet-stream');
      const pct = Math.round((startOffset / stat.size) * 100);
      if (typeof onProgress === 'function') {
        onProgress(`Uploading video chunk (${pct}%)...`);
      }

      let chunkData = null;
      let lastChunkErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const chunkForm = new FormData();
          chunkForm.append('access_token', pageToken);
          chunkForm.append('upload_phase', 'transfer');
          chunkForm.append('upload_session_id', sessionId);
          chunkForm.append('start_offset', String(startOffset));
          chunkForm.append('video_file_chunk', chunkBlob, path.basename(videoPath));

          const transferRes = await fetchWithPhase(
            `https://graph-video.facebook.com/v20.0/${encodeURIComponent(page.id)}/videos`,
            { method: 'POST', body: chunkForm },
            180000,
            `Facebook video chunk upload (${pct}%)`
          );
          chunkData = await transferRes.json();
          if (!transferRes.ok || chunkData.error) {
            throw new Error(chunkData.error?.message || `Chunk transfer HTTP ${transferRes.status}`);
          }
          lastChunkErr = null;
          break;
        } catch (err) {
          lastChunkErr = err;
          if (attempt === 0 && (err.isTimeout || isTimeoutError(err))) continue;
          throw err;
        }
      }
      if (lastChunkErr) throw lastChunkErr;

      const nextStart = Number(chunkData.start_offset);
      const nextEnd = Number(chunkData.end_offset);
      startOffset = Number.isFinite(nextStart) && nextStart > startOffset ? nextStart : clampedEnd;
      endOffset = Number.isFinite(nextEnd) && nextEnd > startOffset ? nextEnd : Math.min(stat.size, startOffset + maxChunkBytes);
    }

    if (typeof onProgress === 'function') onProgress('Finalizing Facebook video...');
    const finishParams = new URLSearchParams({
      upload_phase: 'finish',
      upload_session_id: sessionId,
      access_token: pageToken
    });
    if (title && title.trim()) finishParams.append('title', title.trim().slice(0, 255));
    if (description) finishParams.append('description', description);

    const finishRes = await fetchWithPhase(
      `https://graph-video.facebook.com/v20.0/${encodeURIComponent(page.id)}/videos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: finishParams.toString()
      },
      120000,
      'Facebook chunked video finish'
    );
    const finishData = await finishRes.json();
    if (!finishRes.ok || finishData.error) {
      throw new Error(`Facebook API error: ${finishData.error?.message || `HTTP ${finishRes.status}`}`);
    }

    const vid = startData.video_id || finishData.id;
    return {
      ok: true,
      videoId: vid,
      pageId: page.id,
      pageName: page.name,
      postUrl: `https://www.facebook.com/${vid}`,
      videoUrl: `https://www.facebook.com/watch/?v=${vid}`
    };
  }

  async function publishVideoToFacebook({ jobId, pageId, title, description, hashtags, onProgress }) {
    const accounts = loadAccounts();
    if (!accounts.facebook || !accounts.facebook.connected) {
      throw new Error('No Facebook account connected. Please connect your Facebook account first.');
    }

    const pages = accounts.facebook.pages || [];
    const page = pages.find(p => p.id === pageId) || pages[0];
    if (!page) throw new Error('Target Facebook Page not found.');

    const pageToken = page.access_token || accounts.facebook.userAccessToken;
    if (!pageToken) throw new Error('No access token available for this Facebook Page.');

    const videoPath = resolveClipVideoPath(jobId);
    const stat = fs.statSync(videoPath);

    let fullDescription = (description || '').trim();
    if (hashtags && hashtags.trim()) {
      fullDescription += (fullDescription ? '\n\n' : '') + hashtags.trim();
    }

    if (stat.size > 8 * 1024 * 1024) {
      try {
        return await publishVideoChunkedToFacebook({
          videoPath,
          stat,
          page,
          pageToken,
          title,
          description: fullDescription,
          onProgress
        });
      } catch (chunkErr) {
        console.warn('[FB Video Chunked] Falling back to direct upload:', chunkErr.message);
      }
    }

    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    const fileBlob = await fileAsBlob(videoPath, 'video/mp4');
    const form = new FormData();
    form.append('access_token', pageToken);
    if (title && title.trim()) form.append('title', title.trim().slice(0, 255));
    if (fullDescription) form.append('description', fullDescription);
    form.append('source', fileBlob, path.basename(videoPath));

    const uploadRes = await fetchWithPhase(
      `https://graph-video.facebook.com/v20.0/${encodeURIComponent(page.id)}/videos`,
      { method: 'POST', body: form },
      computeUploadTimeoutMs(stat.size, 300000),
      `Facebook Video upload (${sizeMb} MB)`
    );

    const resData = await uploadRes.json();
    if (!uploadRes.ok || resData.error) {
      throw new Error(`Facebook API error: ${resData.error?.message || `HTTP ${uploadRes.status}`}`);
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

  async function publishReelToFacebook({ jobId, pageId, title, description, hashtags, onProgress }) {
    const accounts = loadAccounts();
    if (!accounts.facebook || !accounts.facebook.connected) {
      throw new Error('No Facebook account connected. Please connect your Facebook account first.');
    }

    const pages = accounts.facebook.pages || [];
    const page = pages.find(p => p.id === pageId) || pages[0];
    if (!page) throw new Error('Target Facebook Page not found.');

    const pageToken = page.access_token || accounts.facebook.userAccessToken;
    if (!pageToken) throw new Error('No access token available for this Facebook Page.');

    const videoPath = resolveClipVideoPath(jobId);
    const stat = fs.statSync(videoPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    const uploadTimeoutMs = computeUploadTimeoutMs(stat.size, 300000);

    let fullDescription = (description || '').trim();
    if (hashtags && hashtags.trim()) {
      fullDescription += (fullDescription ? '\n\n' : '') + hashtags.trim();
    }

    let reelErr = null;
    try {
      if (typeof onProgress === 'function') onProgress('Initializing Facebook Reel upload...');
      const initRes = await fetchWithPhase(
        `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_reels`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upload_phase: 'start',
            access_token: pageToken
          })
        },
        60000,
        'Facebook Reel init'
      );
      const initData = await initRes.json();
      if (!initRes.ok || initData.error) {
        throw new Error(initData.error?.message || `Reels init HTTP ${initRes.status}`);
      }

      if (initData.video_id && initData.upload_url) {
        if (typeof onProgress === 'function') onProgress(`Uploading Reel (${sizeMb} MB) to Facebook...`);
        const videoBlob = await fileAsBlob(videoPath, 'application/octet-stream');
        const uploadRes = await fetchWithPhase(
          initData.upload_url,
          {
            method: 'POST',
            headers: {
              Authorization: `OAuth ${pageToken}`,
              'Content-Type': 'application/octet-stream',
              offset: '0',
              file_size: String(stat.size)
            },
            body: videoBlob
          },
          uploadTimeoutMs,
          `Facebook Reel upload (${sizeMb} MB)`
        );
        const uploadData = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok || uploadData.error) {
          throw new Error(uploadData.error?.message || `Binary upload HTTP ${uploadRes.status}`);
        }

        if (typeof onProgress === 'function') onProgress('Publishing & finalizing Reel on Facebook...');
        let finishData = null;
        try {
          const finishRes = await fetchWithPhase(
            `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_reels`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                upload_phase: 'finish',
                video_id: initData.video_id,
                video_state: 'PUBLISHED',
                description: fullDescription,
                title: (title || '').slice(0, 255),
                access_token: pageToken
              })
            },
            120000,
            'Facebook Reel finish'
          );
          finishData = await finishRes.json();
          if (!finishRes.ok || finishData.error) {
            throw new Error(finishData.error?.message || `Reels finish HTTP ${finishRes.status}`);
          }
        } catch (finErr) {
          // If finish timed out after binary upload already completed, check if Meta already accepted the Reel
          if (finErr.isTimeout || isTimeoutError(finErr)) {
            const checkRes = await fetch(
              `https://graph.facebook.com/v20.0/${encodeURIComponent(initData.video_id)}?fields=status&access_token=${encodeURIComponent(pageToken)}`,
              { signal: AbortSignal.timeout(20000) }
            ).catch(() => null);
            const checkData = checkRes ? await checkRes.json().catch(() => ({})) : {};
            const upStatus = String(checkData?.status?.uploading_phase?.status || '').toLowerCase();
            const pubStatus = String(checkData?.status?.publishing_phase?.status || '').toLowerCase();
            if (upStatus === 'complete' && (pubStatus === 'complete' || pubStatus === 'in_progress')) {
              finishData = { success: true };
            } else {
              throw finErr;
            }
          } else {
            throw finErr;
          }
        }

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
    } catch (err) {
      reelErr = err;
      console.warn('[Reels API] Falling back to standard video upload:', err.message);
    }

    if (typeof onProgress === 'function') {
      onProgress('Reels upload timed out or unavailable; retrying via Video upload...');
    }
    try {
      const fallback = await publishVideoToFacebook({ jobId, pageId, title, description, hashtags, onProgress });
      return { ...fallback, format: 'reel' };
    } catch (fbErr) {
      if (reelErr && reelErr.message && reelErr.message !== fbErr.message) {
        throw new Error(`${reelErr.message} (Fallback: ${fbErr.message})`);
      }
      throw fbErr;
    }
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

    if (!fs.existsSync(imagePath)) throw new Error(`Image file not found at ${imagePath}`);

    const imgBlob = await fileAsBlob(imagePath, 'image/jpeg');
    const form = new FormData();
    form.append('access_token', pageToken);
    if (caption && caption.trim()) form.append('caption', caption.trim());
    form.append('source', imgBlob, path.basename(imagePath));

    const uploadRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/photos`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000)
    });

    const resData = await uploadRes.json();
    if (!uploadRes.ok || resData.error) {
      throw new Error(`Facebook Photos API error: ${resData.error?.message || `HTTP ${uploadRes.status}`}`);
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
      if (videoPath && fs.existsSync(videoPath)) {
        teaserPath = path.join(exportsDir, `story_teaser_${crypto.randomUUID().slice(0, 8)}.mp4`);
        await execFileAsync(getFfmpegBin(), [
          '-y', '-ss', '0', '-i', videoPath,
          '-t', '15',
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
          '-movflags', '+faststart',
          teaserPath
        ], { windowsHide: true, timeout: 60000 });

        const teaserStat = fs.statSync(teaserPath);
        const startRes = await fetchWithPhase(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_stories`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upload_phase: 'start', access_token: pageToken })
          },
          60000,
          'Facebook Story init'
        );
        const startData = await startRes.json();
        if (!startRes.ok || startData.error) {
          throw new Error(startData.error?.message || `Story start HTTP ${startRes.status}`);
        }

        if (startData.video_id && startData.upload_url) {
          const teaserBlob = await fileAsBlob(teaserPath, 'application/octet-stream');
          const uploadRes = await fetchWithPhase(
            startData.upload_url,
            {
              method: 'POST',
              headers: {
                Authorization: `OAuth ${pageToken}`,
                'Content-Type': 'application/octet-stream',
                offset: '0',
                file_size: String(teaserStat.size)
              },
              body: teaserBlob
            },
            computeUploadTimeoutMs(teaserStat.size, 180000),
            'Facebook Story upload'
          );
          const uploadData = await uploadRes.json().catch(() => ({}));
          if (!uploadRes.ok || uploadData.error) {
            throw new Error(uploadData.error?.message || `Story binary upload HTTP ${uploadRes.status}`);
          }

          const finishRes = await fetchWithPhase(
            `https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/video_stories`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                upload_phase: 'finish',
                video_id: startData.video_id,
                access_token: pageToken
              })
            },
            90000,
            'Facebook Story finish'
          );
          const finishData = await finishRes.json();
          if (!finishRes.ok || finishData.error) {
            throw new Error(finishData.error?.message || 'Story finish failed');
          }

          return {
            ok: true,
            format: 'story',
            storyId: startData.video_id,
            pageId: page.id,
            pageName: page.name,
            postUrl: `https://www.facebook.com/${page.id}`
          };
        }
      }

      if (imagePath && fs.existsSync(imagePath)) {
        const imgBlob = await fileAsBlob(imagePath, 'image/jpeg');
        const form = new FormData();
        form.append('access_token', pageToken);
        form.append('published', 'false');
        form.append('temporary', 'true');
        form.append('source', imgBlob, 'story.jpg');

        const pRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/photos`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(45000)
        });
        const pData = await pRes.json();
        if (!pRes.ok || pData.error) throw new Error(pData.error?.message || `Photo story upload HTTP ${pRes.status}`);

        if (pData.id) {
          const sRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(page.id)}/photo_stories?photo_id=${encodeURIComponent(pData.id)}&access_token=${encodeURIComponent(pageToken)}`, {
            method: 'POST',
            signal: AbortSignal.timeout(30000)
          });
          const sData = await sRes.json();
          if (!sRes.ok || sData.error) throw new Error(sData.error?.message || `Photo story HTTP ${sRes.status}`);
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
        }
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

    let targetIg = igUserId
      ? igAccounts.find(a => String(a.id) === String(igUserId) || a.username === igUserId)
      : null;
    if (!targetIg) targetIg = igAccounts[0];

    const igToken = targetIg.access_token || accounts.facebook?.userAccessToken;
    if (!igToken) {
      throw new Error(`No access token found for Instagram account @${targetIg.username || targetIg.id}`);
    }

    const videoPath = resolveClipVideoPath(jobId);
    const stat = fs.statSync(videoPath);
    if (stat.size <= 0) throw new Error(`Video file is empty: ${videoPath}`);

    let fullCaption = (caption || '').trim();
    if (hashtags && hashtags.trim()) {
      fullCaption += (fullCaption ? '\n\n' : '') + hashtags.trim();
    }

    const initParams = new URLSearchParams({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: fullCaption,
      share_to_feed: 'true',
      access_token: igToken
    });
    if (coverUrl) {
      try {
        const parsedCover = new URL(coverUrl);
        if (['http:', 'https:'].includes(parsedCover.protocol)) {
          initParams.append('cover_url', parsedCover.href);
        }
      } catch {}
    }

    const initUrl = `https://graph.facebook.com/v20.0/${encodeURIComponent(targetIg.id)}/media`;
    const initRes = await fetchWithPhase(
      initUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: initParams.toString()
      },
      60000,
      'Instagram Reel init'
    );

    const initData = await initRes.json();
    if (!initRes.ok || initData.error) {
      const errMsg = initData.error?.message || `HTTP ${initRes.status}`;
      if (errMsg.includes('permission') || errMsg.includes('Scope') || errMsg.includes('access')) {
        throw new Error(`Instagram API Permission error: ${errMsg}. Make sure your token has 'instagram_content_publish' and 'instagram_basic'.`);
      }
      throw new Error(`Instagram Reel init failed: ${errMsg}`);
    }

    const containerId = initData.id;
    const uploadUri = initData.uri;
    if (!containerId || !uploadUri) {
      throw new Error('Invalid response from Instagram Reel initialization.');
    }

    const igSizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    const videoBlob = await fileAsBlob(videoPath, 'application/octet-stream');
    const uploadRes = await fetchWithPhase(
      uploadUri,
      {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${igToken}`,
          offset: '0',
          file_size: String(stat.size),
          'Content-Type': 'application/octet-stream'
        },
        body: videoBlob
      },
      computeUploadTimeoutMs(stat.size, 300000),
      `Instagram Reel upload (${igSizeMb} MB)`
    );

    const uploadText = await uploadRes.text();
    let uploadData = {};
    try { uploadData = JSON.parse(uploadText); } catch {}

    if (!uploadRes.ok || uploadData.error) {
      const errMsg = uploadData?.error?.message || uploadText || `HTTP ${uploadRes.status}`;
      throw new Error(`Instagram Reel binary upload failed: ${errMsg}`);
    }

    const pollStart = Date.now();
    const maxPollMs = 180000;
    let isReady = false;

    while (Date.now() - pollStart < maxPollMs) {
      await new Promise(r => setTimeout(r, 4000));
      const statusRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(igToken)}`, {
        signal: AbortSignal.timeout(15000)
      });
      const statusData = await statusRes.json();
      if (statusData.error) continue;

      const code = (statusData.status_code || '').toUpperCase();
      if (code === 'FINISHED') {
        isReady = true;
        break;
      } else if (code === 'ERROR') {
        throw new Error(`Instagram video processing failed: ${statusData.status || 'Encoding error'}`);
      } else if (code === 'EXPIRED') {
        throw new Error('Instagram Reel upload session expired.');
      }
    }

    if (!isReady) {
      throw new Error('Instagram Reel processing timed out after 3 minutes. Check your Instagram account before retrying.');
    }

    const publishParams = new URLSearchParams({
      creation_id: containerId,
      access_token: igToken
    });
    const publishRes = await fetchWithPhase(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(targetIg.id)}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: publishParams.toString()
      },
      90000,
      'Instagram Reel media_publish'
    );

    const publishData = await publishRes.json();
    if (!publishRes.ok || publishData.error) {
      throw new Error(`Instagram Reel publish failed: ${publishData.error?.message || `HTTP ${publishRes.status}`}`);
    }

    const mediaId = publishData.id;
    let permalink = 'https://www.instagram.com/reel/';
    try {
      const linkRes = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}?fields=permalink,shortcode&access_token=${encodeURIComponent(igToken)}`, {
        signal: AbortSignal.timeout(10000)
      });
      const linkData = await linkRes.json();
      if (linkData?.permalink) permalink = linkData.permalink;
      else if (linkData?.shortcode) permalink = `https://www.instagram.com/reel/${linkData.shortcode}/`;
    } catch {}

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

  function extractBestQuote(jobId, fallbackTitle = 'Highlight Moment') {
    if (!isUuid(jobId)) return { quoteText: fallbackTitle, timestamp: 2.5 };
    const srtPath = safeResolveInside(exportsDir, `${jobId}.srt`);
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
    watermark = null,
    onProgress = null
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
    if (requiresFb && !page) throw new Error('Target Facebook Page not found.');

    const videoPath = resolveClipVideoPath(jobId);
    const results = {};
    const tempFiles = [];
    const notify = (step, status, detail) => {
      if (typeof onProgress === 'function') onProgress(step, status, detail);
    };

    try {
      if (formats.reel) {
        notify('reel', 'running', 'Uploading Reel to Facebook...');
        try {
          const reelRes = await publishReelToFacebook({
            jobId,
            pageId: page?.id,
            title,
            description,
            hashtags,
            onProgress: msg => notify('reel', 'running', msg)
          });
          results.reel = { ok: true, ...reelRes };
          notify('reel', 'done', 'Published to Facebook Reel');
        } catch (err) {
          results.reel = { ok: false, error: err.message };
          notify('reel', 'error', err.message);
        }
      }

      if (requiresIg) {
        notify('instagramReel', 'running', 'Uploading & processing Instagram Reel...');
        try {
          const igRes = await publishReelToInstagram({
            jobId,
            igUserId,
            caption: title ? `${title}\n\n${description}` : description,
            hashtags
          });
          results.instagramReel = { ok: true, ...igRes };
          notify('instagramReel', 'done', 'Published to Instagram Reel');
        } catch (err) {
          results.instagramReel = { ok: false, error: err.message };
          notify('instagramReel', 'error', err.message);
        }
      }

      let generatedImage = null;
      if (formats.imagePost) {
        notify('imagePost', 'running', 'Rendering quote card & uploading...');
        try {
          const quoteInfo = extractBestQuote(jobId, title);
          const textToUse = quoteText && quoteText.trim() ? quoteText.trim() : quoteInfo.quoteText;
          const tempImg = path.join(previewsDir, `post_${jobId}_${Date.now()}.jpg`);
          tempFiles.push(tempImg);

          await generateQuoteImage({
            videoPath,
            quoteText: textToUse,
            ratio,
            watermark,
            outputPath: tempImg,
            timestamp: quoteInfo.timestamp,
            dataDir,
            previewsDir
          });
          generatedImage = tempImg;

          if (page) {
            let photoCaption = textToUse ? `“${textToUse}”` : (title || 'Highlight Moment');
            if (description && description.trim()) photoCaption += `\n\n${description.trim()}`;
            if (hashtags && hashtags.trim()) photoCaption += `\n\n${hashtags.trim()}`;

            const photoRes = await publishPhotoToFacebook({
              imagePath: tempImg,
              pageId: page.id,
              caption: photoCaption
            });
            results.imagePost = { ok: true, ...photoRes };
            notify('imagePost', 'done', 'Published Quote Post');
          }
        } catch (err) {
          results.imagePost = { ok: false, error: err.message };
          notify('imagePost', 'error', err.message);
        }
      }

      if (formats.story && page) {
        notify('story', 'running', 'Publishing 15s Story teaser...');
        try {
          const storyRes = await publishStoryToFacebook({
            videoPath,
            imagePath: generatedImage,
            pageId: page.id
          });
          results.story = storyRes;
          notify('story', storyRes.ok ? 'done' : 'error', storyRes.ok ? 'Published Story' : storyRes.error);
        } catch (err) {
          results.story = { ok: false, error: err.message };
          notify('story', 'error', err.message);
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

  return {
    loadAccounts,
    saveAccounts,
    publicAccounts,
    verifyFacebookToken,
    refreshInstagramAccounts,
    linkManualInstagramAccount,
    disconnectFacebook,
    disconnectInstagram,
    publishVideoToFacebook,
    publishReelToFacebook,
    publishPhotoToFacebook,
    publishStoryToFacebook,
    publishReelToInstagram,
    publishMultiFormat,
    extractBestQuote
  };
}

module.exports = { createMetaService };
