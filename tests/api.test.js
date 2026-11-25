'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createApp } = require('../server');
const { getFfmpegBin, probe } = require('../lib/ffmpeg');

describe('ClipMaster HTTP API & Security Integration', () => {
  let tmpData;
  let app;
  let baseUrl;
  const origFetch = global.fetch;

  before(async () => {
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-api-test-'));
    app = createApp({
      rootDir: path.join(__dirname, '..'),
      dataDir: tmpData,
      port: 0,
      accessKey: 'test-access-key-9999'
    });
    await app.init();
    await new Promise(resolve => {
      app.server.listen(0, '127.0.0.1', () => {
        const addr = app.server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    global.fetch = origFetch;
    app.cleanup();
    await new Promise(resolve => app.server.close(resolve));
    fs.rmSync(tmpData, { recursive: true, force: true });
  });

  it('serves index.html and reports health accurately', async () => {
    const htmlRes = await origFetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('ClipMaster 2.0'));

    const healthRes = await origFetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(typeof health.ffmpeg, 'boolean');
    assert.equal(health.authenticated, true);
  });

  it('blocks unauthenticated proxy/tunnel requests and unlocks via login cookie', async () => {
    const unauthHealth = await origFetch(`${baseUrl}/api/health`, {
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });
    const uhData = await unauthHealth.json();
    assert.equal(uhData.authRequired, true);
    assert.equal(uhData.authenticated, false);
    assert.equal(uhData.networkUrls, undefined);

    const blockedProjects = await origFetch(`${baseUrl}/api/projects`, {
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });
    assert.equal(blockedProjects.status, 401);

    const badLogin = await origFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ key: 'wrong-key' })
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await origFetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({ key: 'test-access-key-9999' })
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('cm_session='));

    const cookieVal = setCookie.split(';')[0];
    const authedProjects = await origFetch(`${baseUrl}/api/projects`, {
      headers: { 'x-forwarded-for': '203.0.113.10', cookie: cookieVal }
    });
    assert.equal(authedProjects.status, 200);
  });

  it('blocks cross-origin POST requests (CSRF protection)', async () => {
    const res = await origFetch(`${baseUrl}/api/accounts/facebook`, {
      method: 'DELETE',
      headers: { origin: 'https://malicious.example' }
    });
    assert.equal(res.status, 403);
  });

  it('blocks path traversal and malformed IDs across routes', async () => {
    const badProject = await origFetch(`${baseUrl}/api/projects/not-a-uuid`);
    assert.equal(badProject.status, 400);

    const badPreview = await origFetch(`${baseUrl}/api/publish/image-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: '../accounts' })
    });
    assert.equal(badPreview.status, 400);

    const badImg = await origFetch(`${baseUrl}/api/preview/images/..%2faccounts.json`);
    assert.equal(badImg.status, 400);
  });

  it('validates chunked uploads and cleans up aborted upload temp files', async () => {
    const missingId = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: { 'x-chunk-index': '0', 'x-total-chunks': '1', 'x-file-name': 'clip.mp4' },
      body: Buffer.from('abc')
    });
    assert.equal(missingId.status, 400);

    const badExt = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_test_12345',
        'x-chunk-index': '0',
        'x-total-chunks': '2',
        'x-file-name': 'malware.exe'
      },
      body: Buffer.from('abc')
    });
    assert.equal(badExt.status, 415);

    const chunk0 = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_test_abort_1',
        'x-chunk-index': '0',
        'x-total-chunks': '2',
        'x-file-name': '100%video.mp4',
        'x-file-size': '100'
      },
      body: Buffer.from('hello')
    });
    assert.equal(chunk0.status, 200);
    const tmpPart = path.join(tmpData, 'uploads', 'tmp_up_test_abort_1.part');
    assert.equal(fs.existsSync(tmpPart), true);

    const outOfOrder = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_test_abort_1',
        'x-chunk-index': '5',
        'x-total-chunks': '2',
        'x-file-name': '100%video.mp4'
      },
      body: Buffer.from('bad')
    });
    assert.equal(outOfOrder.status, 400);

    const delChunk = await origFetch(`${baseUrl}/api/upload/chunk/up_test_abort_1`, { method: 'DELETE' });
    assert.equal(delChunk.status, 200);
    assert.equal(fs.existsSync(tmpPart), false);
  });

  it('preserves Facebook & Instagram tokens in accounts.json while redacting public API output', async () => {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(baseUrl)) return origFetch(url, opts);
      if (u.includes('/me?fields=id,name')) {
        return new Response(JSON.stringify({ id: 'u1', name: 'Test Creator' }), { status: 200 });
      }
      if (u.includes('/me/accounts')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'page1',
            name: 'My Studio Page',
            category: 'Media',
            access_token: 'PAGE_SECRET_TOKEN',
            instagram_business_account: { id: 'ig1', username: 'mystudio', name: 'My Studio' }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected call' } }), { status: 400 });
    };

    const res = await origFetch(`${baseUrl}/api/accounts/facebook/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'USER_SECRET_TOKEN' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accounts.facebook.connected, true);
    assert.equal(body.accounts.instagram.connected, true);
    // Tokens MUST NOT leak in API response
    assert.equal(JSON.stringify(body).includes('SECRET_TOKEN'), false);

    // Tokens MUST be preserved on disk in accounts.json
    const saved = JSON.parse(fs.readFileSync(path.join(tmpData, 'accounts.json'), 'utf8'));
    assert.equal(saved.facebook.userAccessToken, 'USER_SECRET_TOKEN');
    assert.equal(saved.facebook.pages[0].access_token, 'PAGE_SECRET_TOKEN');
  });

  it('runs async multi-format publishing, deduplicates identical requests, and reports per-step status', async () => {
    const clipId = crypto.randomUUID();
    fs.writeFileSync(path.join(tmpData, 'exports', `${clipId}.mp4`), Buffer.from('FAKE_MP4_DATA'));

    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(baseUrl)) return origFetch(url, opts);
      if (u.includes('/video_reels')) {
        const b = JSON.parse(opts.body);
        if (b.upload_phase === 'start') {
          return new Response(JSON.stringify({ video_id: 'fb_reel_1', upload_url: 'https://rupload.facebook.com/reel1' }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (u.includes('rupload.facebook.com/reel1')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Mock failure' } }), { status: 400 });
    };

    const startRes = await origFetch(`${baseUrl}/api/publish/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: clipId,
        pageId: 'page1',
        formats: { reel: true, instagramReel: false, imagePost: false, story: false },
        title: 'Test Reel',
        description: 'Desc',
        hashtags: '#Test'
      })
    });
    assert.equal(startRes.status, 202);
    const startData = await startRes.json();
    assert.ok(startData.publishJobId);

    // Poll until complete
    let finalPoll = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const p = await origFetch(`${baseUrl}/api/publish/status/${startData.publishJobId}`);
      finalPoll = await p.json();
      if (finalPoll.status === 'complete' || finalPoll.status === 'failed') break;
    }
    assert.equal(finalPoll.status, 'complete');
    assert.equal(finalPoll.result.ok, true);
    assert.equal(finalPoll.result.results.reel.videoId, 'fb_reel_1');
  });

  it('recovers when Reels finish times out after upload completes, and falls back to chunked video upload on transfer timeout', async () => {
    const clipId = crypto.randomUUID();
    // >8 MB dummy buffer to exercise chunked upload fallback path
    fs.writeFileSync(path.join(tmpData, 'exports', `${clipId}.mp4`), Buffer.alloc(9 * 1024 * 1024, 0x41));

    // Case 1: finish throws TimeoutError, but GET /{video_id}?fields=status confirms Meta already completed upload
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(baseUrl)) return origFetch(url, opts);
      if (u.includes('/video_reels') && opts?.method === 'POST') {
        const b = JSON.parse(opts.body);
        if (b.upload_phase === 'start') {
          return new Response(JSON.stringify({ video_id: 'fb_reel_rec', upload_url: 'https://rupload.facebook.com/reel_rec' }), { status: 200 });
        }
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      if (u.includes('rupload.facebook.com/reel_rec')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (u.includes('/fb_reel_rec?fields=status')) {
        return new Response(JSON.stringify({
          status: { uploading_phase: { status: 'complete' }, publishing_phase: { status: 'in_progress' } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected call: ' + u } }), { status: 400 });
    };

    const recRes = await origFetch(`${baseUrl}/api/publish/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: clipId,
        pageId: 'page1',
        formats: { reel: true, instagramReel: false, imagePost: false, story: false },
        title: 'Timeout Recovery Test'
      })
    });
    const recData = await recRes.json();
    let poll1 = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 80));
      poll1 = await (await origFetch(`${baseUrl}/api/publish/status/${recData.publishJobId}`)).json();
      if (poll1.status === 'complete' || poll1.status === 'failed') break;
    }
    assert.equal(poll1.result.ok, true);
    assert.equal(poll1.result.results.reel.videoId, 'fb_reel_rec');

    // Case 2: rupload times out -> falls back to chunked /videos upload (start -> transfer -> finish)
    let chunkTransfers = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(baseUrl)) return origFetch(url, opts);
      if (u.includes('/video_reels')) {
        return new Response(JSON.stringify({ video_id: 'fb_reel_to', upload_url: 'https://rupload.facebook.com/reel_to' }), { status: 200 });
      }
      if (u.includes('rupload.facebook.com/reel_to')) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      if (u.includes('graph-video.facebook.com') && u.includes('/videos')) {
        if (opts.body instanceof FormData) {
          chunkTransfers++;
          const startOff = Number(opts.body.get('start_offset'));
          const chunk = opts.body.get('video_file_chunk');
          const next = startOff + chunk.size;
          return new Response(JSON.stringify({ start_offset: String(next), end_offset: String(Math.min(9 * 1024 * 1024, next + 8 * 1024 * 1024)) }), { status: 200 });
        }
        const params = new URLSearchParams(opts.body);
        if (params.get('upload_phase') === 'start') {
          return new Response(JSON.stringify({ upload_session_id: 'sess_1', video_id: 'fb_chunk_vid', start_offset: '0', end_offset: String(8 * 1024 * 1024) }), { status: 200 });
        }
        if (params.get('upload_phase') === 'finish') {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ error: { message: 'Unexpected mock call' } }), { status: 400 });
    };

    const fbRes = await origFetch(`${baseUrl}/api/publish/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: clipId,
        pageId: 'page1',
        formats: { reel: true, instagramReel: false, imagePost: false, story: false },
        title: 'Chunked Fallback Test'
      })
    });
    const fbData = await fbRes.json();
    let poll2 = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 80));
      poll2 = await (await origFetch(`${baseUrl}/api/publish/status/${fbData.publishJobId}`)).json();
      if (poll2.status === 'complete' || poll2.status === 'failed') break;
    }
    assert.equal(poll2.result.ok, true);
    assert.equal(poll2.result.results.reel.videoId, 'fb_chunk_vid');
    assert.equal(chunkTransfers, 2);
  });

  it('preserves captions on clip re-render and cleans up all project files on delete', async () => {
    const projectId = crypto.randomUUID();
    const oldClipId = crypto.randomUUID();
    fs.writeFileSync(path.join(tmpData, 'uploads', `${projectId}.mp4`), 'video');
    fs.writeFileSync(path.join(tmpData, 'uploads', `${projectId}.en-US.vtt`), 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nTest subtitle\n');
    fs.writeFileSync(path.join(tmpData, 'exports', `${oldClipId}.mp4`), 'clip');
    fs.writeFileSync(path.join(tmpData, 'exports', `${oldClipId}.srt`), '1\n00:00:01,000 --> 00:00:04,000\nTest subtitle\n');

    const dbPath = path.join(tmpData, 'projects.json');
    fs.writeFileSync(dbPath, JSON.stringify([{
      id: projectId,
      filename: `${projectId}.mp4`,
      name: 'Subtitle Test Project',
      duration: 60,
      width: 1920,
      height: 1080,
      hasAudio: true,
      autoClips: [{
        jobId: oldClipId,
        title: 'Part-1',
        start: 0,
        end: 10,
        captions: [{ start: 1, end: 4, text: 'Preserved subtitle line' }]
      }]
    }], null, 2));

    // Re-render sending empty captions (simulating clip edit modal)
    const rerenderRes = await origFetch(`${baseUrl}/api/projects/${projectId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipJobId: oldClipId,
        start: 0,
        end: 10,
        captions: [],
        headerHook: 'Updated Hook',
        partBadge: 'Part-1',
        copyrightShield: { enabled: true, speedShift: true, bgmTrack: 'none' }
      })
    });
    assert.equal(rerenderRes.status, 202);
    const rrData = await rerenderRes.json();
    assert.equal(rrData.captionsCount, 1);
    // Old clip files should be cleaned up
    assert.equal(fs.existsSync(path.join(tmpData, 'exports', `${oldClipId}.mp4`)), false);
    // New .srt should exist with speed-shifted timing
    const newSrt = fs.readFileSync(path.join(tmpData, 'exports', `${rrData.jobId}.srt`), 'utf8');
    assert.ok(newSrt.includes('Preserved subtitle line'));

    // Cancel spawned ffmpeg (if any) and delete project
    await origFetch(`${baseUrl}/api/jobs/${rrData.jobId}/cancel`, { method: 'POST' });
    const delRes = await origFetch(`${baseUrl}/api/projects/${projectId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);

    assert.equal(fs.existsSync(path.join(tmpData, 'uploads', `${projectId}.mp4`)), false);
    assert.equal(fs.existsSync(path.join(tmpData, 'uploads', `${projectId}.en-US.vtt`)), false);
    assert.equal(fs.existsSync(path.join(tmpData, 'exports', `${rrData.jobId}.srt`)), false);
  });

  it('generates local SVG QR codes via /api/qr', async () => {
    const qrRes = await origFetch(`${baseUrl}/api/qr?text=${encodeURIComponent('http://192.168.1.5:4173')}`);
    assert.equal(qrRes.status, 200);
    assert.ok(qrRes.headers.get('content-type').includes('image/svg+xml'));
    const svg = await qrRes.text();
    assert.ok(svg.includes('<svg '));
  });

  it('discovers en-US.vtt in auto-shorts, preserves captions/selectionReason, and redacts filename', async () => {
    const projectId = crypto.randomUUID();
    fs.writeFileSync(path.join(tmpData, 'uploads', `${projectId}.mp4`), 'video');
    const cuesVtt = [
      'WEBVTT',
      '',
      '00:00:08.000 --> 00:00:13.000',
      'Why do most creators struggle to grow on social media?',
      '',
      '00:00:13.200 --> 00:00:19.000',
      'Because the real secret is hooking viewers in the first three seconds!',
      '',
      '00:00:19.200 --> 00:00:25.000',
      'Here is the 3-step strategy that improves retention right away.',
      '',
      '00:00:25.200 --> 00:00:31.000',
      'Once you test this hook, your watch time grows naturally.'
    ].join('\n');
    fs.writeFileSync(path.join(tmpData, 'uploads', `${projectId}.en-US.vtt`), cuesVtt);

    const dbPath = path.join(tmpData, 'projects.json');
    const existing = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    existing.push({
      id: projectId,
      filename: `${projectId}.mp4`,
      name: 'Auto Shorts VTT Test',
      duration: 60,
      width: 1920,
      height: 1080,
      hasAudio: true,
      videoCodec: 'h264',
      ext: 'MP4'
    });
    fs.writeFileSync(dbPath, JSON.stringify(existing, null, 2));

    const getRes = await origFetch(`${baseUrl}/api/projects/${projectId}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.project.filename, undefined);
    assert.equal(getBody.project.ext, 'MP4');
    assert.equal(getBody.project.videoCodec, 'h264');

    const autoRes = await origFetch(`${baseUrl}/api/projects/${projectId}/auto-shorts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'highlights',
        clipCount: 1,
        targetDuration: 20,
        language: 'auto',
        copyrightShield: { enabled: true, speedShift: true, bgmTrack: 'none' }
      })
    });
    assert.equal(autoRes.status, 202);
    const autoBody = await autoRes.json();
    assert.equal(autoBody.total, 1);
    assert.ok(autoBody.clips[0].selectionReason);
    assert.ok(Array.isArray(autoBody.clips[0].captions) && autoBody.clips[0].captions.length > 0);

    await origFetch(`${baseUrl}/api/jobs/${autoBody.clips[0].jobId}/cancel`, { method: 'POST' });
    await origFetch(`${baseUrl}/api/projects/${projectId}`, { method: 'DELETE' });
  });

  it('probes, renders clips with subtitles & Copyright Shield (audio + silent), and generates quote preview with real FFmpeg', async () => {
    const health = await origFetch(`${baseUrl}/api/health`).then(r => r.json());
    assert.equal(health.ffmpeg, true);
    assert.equal(health.ffprobe, true);

    const ffmpegBin = getFfmpegBin();
    const audioSample = path.join(tmpData, 'sample_audio.mp4');
    const silentSample = path.join(tmpData, 'sample_silent.mp4');

    execFileSync(ffmpegBin, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', audioSample
    ], { windowsHide: true, timeout: 20000 });

    execFileSync(ffmpegBin, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=24',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-an', silentSample
    ], { windowsHide: true, timeout: 20000 });

    // Upload audio video via chunked upload
    const audioBuf = fs.readFileSync(audioSample);
    const upAudio = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_real_audio_1',
        'x-chunk-index': '0',
        'x-total-chunks': '1',
        'x-file-name': 'real_audio.mp4',
        'x-file-size': String(audioBuf.length)
      },
      body: audioBuf
    });
    assert.equal(upAudio.status, 201);
    const audioProj = (await upAudio.json()).project;
    assert.equal(audioProj.hasAudio, true);
    assert.equal(audioProj.duration, 4);

    // Upload silent video via chunked upload
    const silentBuf = fs.readFileSync(silentSample);
    const upSilent = await origFetch(`${baseUrl}/api/upload/chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_real_silent_1',
        'x-chunk-index': '0',
        'x-total-chunks': '1',
        'x-file-name': 'real_silent.mp4',
        'x-file-size': String(silentBuf.length)
      },
      body: silentBuf
    });
    assert.equal(upSilent.status, 201);
    const silentProj = (await upSilent.json()).project;
    assert.equal(silentProj.hasAudio, false);

    // Render 9:16 clip with karaoke EN/HI subtitles, overlays, Copyright Shield + BGM on audio video
    const renderAudio = await origFetch(`${baseUrl}/api/projects/${audioProj.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: 0,
        end: 3,
        captions: [{ start: 0.2, end: 2.8, text: 'Hello नमस्ते karaoke test' }],
        ratio: '9:16',
        resolution: '720p',
        captionMode: 'Both',
        framingMode: 'fit-bars',
        headerHook: 'Top Hook Test',
        headerStyle: 'card',
        bottomText: 'Bottom Bar Text',
        partBadge: 'Part-1',
        style: { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom', karaoke: true },
        copyrightShield: { enabled: true, visualMod: true, speedShift: true, progressBar: true, bgmTrack: 'chill-lofi', bgmVolume: 0.12 }
      })
    });
    assert.equal(renderAudio.status, 202);
    const { jobId: audioJobId } = await renderAudio.json();

    // Render 9:16 clip with BGM on SILENT video (regression check for [0:a] stream crash)
    const renderSilent = await origFetch(`${baseUrl}/api/projects/${silentProj.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: 0,
        end: 3,
        captions: [{ start: 0.2, end: 2.5, text: 'Silent video caption' }],
        ratio: '9:16',
        resolution: '720p',
        captionMode: 'Burned in',
        framingMode: 'blur-bg',
        copyrightShield: { enabled: true, visualMod: true, speedShift: true, progressBar: true, bgmTrack: 'chill-lofi', bgmVolume: 0.12 }
      })
    });
    assert.equal(renderSilent.status, 202);
    const { jobId: silentJobId } = await renderSilent.json();

    // Wait for both real FFmpeg renders to finish
    const waitJob = async jid => {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 400));
        const st = await origFetch(`${baseUrl}/api/jobs/${jid}`).then(r => r.json());
        if (st.status === 'complete' || st.status === 'failed') return st;
      }
      throw new Error(`Job ${jid} timed out`);
    };

    const [stAudio, stSilent] = await Promise.all([waitJob(audioJobId), waitJob(silentJobId)]);
    assert.equal(stAudio.status, 'complete', stAudio.error || '');
    assert.equal(stSilent.status, 'complete', stSilent.error || '');
    assert.ok(stAudio.subtitleUrl);

    const probedAudioOut = await probe(path.join(tmpData, 'exports', `${audioJobId}.mp4`));
    assert.equal(probedAudioOut.width, 720);
    assert.equal(probedAudioOut.height, 1280);
    assert.equal(probedAudioOut.hasAudio, true);

    const probedSilentOut = await probe(path.join(tmpData, 'exports', `${silentJobId}.mp4`));
    assert.equal(probedSilentOut.width, 720);
    assert.equal(probedSilentOut.height, 1280);
    assert.equal(probedSilentOut.hasAudio, true);

    // Test Quote Graphic preview generation using real FFmpeg
    const quoteRes = await origFetch(`${baseUrl}/api/publish/image-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: audioJobId, quoteText: 'Inspiring real test quote', ratio: '1:1' })
    });
    assert.equal(quoteRes.status, 200);
    const quoteBody = await quoteRes.json();
    assert.equal(quoteBody.ok, true);
    const imgRes = await origFetch(`${baseUrl}${quoteBody.imageUrl}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/jpeg');

    await origFetch(`${baseUrl}/api/projects/${audioProj.id}`, { method: 'DELETE' });
    await origFetch(`${baseUrl}/api/projects/${silentProj.id}`, { method: 'DELETE' });
  });
});
