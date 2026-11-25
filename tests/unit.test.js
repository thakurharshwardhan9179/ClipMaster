'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const security = require('../lib/security');
const captions = require('../lib/captions');
const highlights = require('../lib/highlights');
const ffmpegLib = require('../lib/ffmpeg');
const { generateQrSvg } = require('../lib/qrcode');

describe('lib/security', () => {
  it('validates UUIDs and uploadIds strictly', () => {
    const id = crypto.randomUUID();
    assert.equal(security.isUuid(id), true);
    assert.equal(security.isUuid('../etc/passwd'), false);
    assert.equal(security.isUuid(''), false);

    assert.equal(security.validateUploadId('up_123456_abc'), 'up_123456_abc');
    assert.equal(security.validateUploadId(''), null);
    assert.equal(security.validateUploadId(undefined), null);
    assert.equal(security.validateUploadId('../evil'), null);
  });

  it('prevents path traversal in safeResolveInside', () => {
    const base = path.join(os.tmpdir(), 'cm-test-base');
    assert.throws(() => security.safeResolveInside(base, '../secret.json'));
    assert.throws(() => security.safeResolveInside(base, '../../etc/passwd'));
    const ok = security.safeResolveInside(base, 'clip.mp4');
    assert.ok(ok.startsWith(path.resolve(base) + path.sep));
  });

  it('safely decodes malformed URI headers without throwing', () => {
    assert.equal(security.safeDecodeHeader('hello%20world.mp4'), 'hello world.mp4');
    assert.equal(security.safeDecodeHeader('100%real_video.mp4'), '100%real_video.mp4');
  });

  it('signs and verifies HMAC session tokens', () => {
    const secret = 'test-secret-0123456789abcdef';
    const token = security.signSessionToken(secret, 10_000);
    assert.equal(security.verifySessionToken(token, secret), true);
    assert.equal(security.verifySessionToken(token + 'x', secret), false);
    assert.equal(security.verifySessionToken(token, 'wrong-secret-0123456789'), false);

    const expired = security.signSessionToken(secret, -1000);
    assert.equal(security.verifySessionToken(expired, secret), false);
  });

  it('detects proxy headers as non-loopback and enforces auth', () => {
    const secret = 'test-secret-0123456789abcdef';
    const accessKey = 'key-abc-1234';
    const localReq = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const proxiedReq = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } };
    const authedProxiedReq = {
      headers: { 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${accessKey}` },
      socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal(security.isDirectLoopback(localReq), true);
    assert.equal(security.isDirectLoopback(proxiedReq), false);
    assert.equal(security.isAuthenticated(localReq, accessKey, secret), true);
    assert.equal(security.isAuthenticated(proxiedReq, accessKey, secret), false);
    assert.equal(security.isAuthenticated(authedProxiedReq, accessKey, secret), true);
  });

  it('enforces same-origin on state-changing requests', () => {
    assert.equal(security.checkSameOrigin({ method: 'GET', headers: { origin: 'https://evil.com', host: 'localhost:4173' } }), true);
    assert.equal(security.checkSameOrigin({ method: 'POST', headers: { origin: 'https://evil.com', host: 'localhost:4173' } }), false);
    assert.equal(security.checkSameOrigin({ method: 'POST', headers: { origin: 'http://localhost:4173', host: 'localhost:4173' } }), true);
  });
});

describe('lib/captions', () => {
  it('discovers en-US, en-GB, and hi-IN VTT subtitle tracks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-vtt-'));
    try {
      const pid = crypto.randomUUID();
      fs.writeFileSync(path.join(tmp, `${pid}.en-US.vtt`), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n');
      fs.writeFileSync(path.join(tmp, `${pid}.hi-IN.vtt`), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nनमस्ते दुनिया\n');

      const enTrack = captions.chooseCaptionTrack(tmp, { id: pid }, 'en');
      assert.ok(enTrack && enTrack.langCode === 'en-US');

      const hiTrack = captions.chooseCaptionTrack(tmp, { id: pid }, 'hi');
      assert.ok(hiTrack && hiTrack.langCode === 'hi-IN');

      const allFiles = captions.listProjectVttFiles(tmp, pid);
      assert.equal(allFiles.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scales .srt timestamps when speedFactor is 1.02', () => {
    const srt = captions.toSrt([{ start: 10.2, end: 20.4, text: 'Test line' }], 0, 30, 1.02);
    assert.ok(srt.includes('00:00:10,000 --> 00:00:20,000'));
  });

  it('generates karaoke ASS tags, white hook style, and escapes braces', () => {
    const assKaraoke = captions.toAss(
      [{ start: 0, end: 2, text: 'Hello {world} today' }],
      0,
      5,
      { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom', karaoke: true },
      1080,
      1920,
      { enabled: true, text: '@brand{1}' },
      { headerHook: 'Hook {test}', headerStyle: 'white', headerColor: '#FFE500', bottomText: 'Bottom', partBadge: 'Part-1', framingMode: 'fit-bars' }
    );
    assert.ok(assKaraoke.includes('{\\kf'));
    assert.ok(assKaraoke.includes('\\{world\\}'));
    assert.ok(assKaraoke.includes('Style: HeaderHook,') && assKaraoke.includes('&H00FFFFFF'));
    assert.ok(assKaraoke.includes('@brand\\{1\\}'));
    assert.ok(assKaraoke.includes('Hook \\{test\\}'));

    const assPlain = captions.toAss(
      [{ start: 0, end: 2, text: 'Hello {world} today' }],
      0,
      5,
      { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom', karaoke: false },
      1080,
      1920
    );
    assert.ok(assPlain.includes('Hello \\{world\\} today'));
  });

  it('positions 9:16 fit-bars overlays strictly inside top/bottom letterbox margins without colliding with centered 16:9 video', () => {
    for (const [w, h] of [[1080, 1920], [720, 1280]]) {
      const layout = captions.computeCanvasLayout(w, h, 'fit-bars', 'Bottom', {
        hasHeaderHook: true,
        hasBottomText: true,
        hasPartBadge: true
      });
      // Top watermark -> Top hook -> Centered 16:9 video -> Subtitle -> BottomText -> Bottom watermark -> PartBadge
      assert.ok(layout.wmTopY < layout.hook.y);
      assert.ok(layout.hook.y < layout.videoTopY);
      assert.ok(layout.videoTopY < layout.videoBottomY);
      assert.equal(layout.subtitle.an, 8); // top-anchored below video edge
      assert.ok(layout.subtitle.y > layout.videoBottomY);
      assert.ok(layout.bottomText.y > layout.subtitle.y);
      assert.ok(layout.wmBotY > layout.bottomText.y);
      assert.ok(layout.partBadge.y > layout.wmBotY);
      assert.ok(layout.partBadge.y < h);
    }

    const longHook = 'Tarak Mehta Ka Ulta Chashma Comedy Episode With Jethalal And Babita Ji';
    const ass = captions.toAss(
      [{ start: 0, end: 2, text: 'Ye dekho ek lamba Hindi aur English dialogue line hai' }],
      0,
      5,
      { font: 'Nirmala UI', size: 72, color: '#ffffff', background: 'Pill', position: 'Bottom' },
      1080,
      1920,
      { enabled: true, text: '@creator', position: 'bottom-center', size: 'medium', background: 'pill' },
      { headerHook: longHook, headerStyle: 'card', headerColor: '#FFE500', bottomText: 'नीचे का कैप्शन यहाँ रहेगा', partBadge: 'Part-2', framingMode: 'fit-bars' }
    );
    // Explicit \pos coordinates anchored to full 1080x1920 canvas
    assert.ok(ass.includes('{\\an8\\pos(540,259)}'));
    assert.ok(ass.includes('{\\an8\\pos(540,1306)}'));
    assert.ok(ass.includes('{\\an8\\pos(540,1482)}'));
    assert.ok(ass.includes('{\\an5\\pos(540,1609)}'));
    assert.ok(ass.includes('{\\an5\\pos(540,1699)}'));
    // Long hook wraps onto multiple lines instead of truncating at 2 lines
    assert.ok(ass.includes('Babita'));
  });
});

describe('lib/highlights', () => {
  it('selects non-overlapping highlights with selectionReason and skips intros/outros', () => {
    const cues = [
      { start: 0.5, end: 3.5, text: 'Hello welcome everyone to my channel.' },
      { start: 10.0, end: 15.0, text: 'Why do most people fail to save money in their twenties?' },
      { start: 15.2, end: 22.0, text: 'Because nobody teaches the simple rule of automated investing.' },
      { start: 22.2, end: 29.0, text: 'Here is the 3-step strategy that changes everything!' },
      { start: 29.5, end: 36.0, text: 'Once you start early, compounding does the heavy lifting.' },
      { start: 60.0, end: 66.0, text: 'What if you could learn any skill in half the time?' },
      { start: 66.3, end: 74.0, text: 'The secret truth is focused deliberate practice every morning.' },
      { start: 74.2, end: 82.0, text: 'My mentor told me this story and it shocked me completely.' },
      { start: 82.5, end: 89.0, text: 'Finally I realized consistent effort beats talent.' },
      { start: 110.0, end: 116.0, text: 'Thank you for watching, like and subscribe to our channel!' }
    ];
    const picked = highlights.findHighlights(cues, 120, 2, 25);
    assert.equal(picked.length, 2);
    assert.ok(picked[0].selectionReason);
    assert.ok(picked[0].end + 4 <= picked[1].start);
    assert.ok(!picked.some(c => c.captions.some(x => x.text.includes('subscribe'))));
  });
});

describe('lib/ffmpeg', () => {
  it('builds valid FFmpeg args for audio-less videos with and without BGM', () => {
    const tmpBgm = path.join(os.tmpdir(), 'cm-dummy-bgm.mp3');
    fs.writeFileSync(tmpBgm, 'ID3');
    try {
      const noAudioNoBgm = ffmpegLib.buildRenderArgs({
        inputPath: 'in.mp4',
        outputPath: 'out.mp4',
        start: 5,
        rawDuration: 20,
        width: 1080,
        height: 1920,
        framingMode: 'fit-bars',
        zoom: 1,
        assEscaped: null,
        shield: { enabled: true, visualMod: true, speedShift: true, progressBar: true },
        hasAudio: false,
        bgmPath: null
      });
      assert.ok(noAudioNoBgm.args.includes('-an'));
      assert.ok(!noAudioNoBgm.args.includes('atempo=1.02'));

      const noAudioWithBgm = ffmpegLib.buildRenderArgs({
        inputPath: 'in.mp4',
        outputPath: 'out.mp4',
        start: 5,
        rawDuration: 20,
        width: 1080,
        height: 1920,
        framingMode: 'blur-bg',
        zoom: 1,
        assEscaped: null,
        shield: { enabled: true, visualMod: true, speedShift: true, progressBar: true, bgmVolume: 0.15 },
        hasAudio: false,
        bgmPath: tmpBgm
      });
      const fcIdx = noAudioWithBgm.args.indexOf('-filter_complex');
      assert.ok(fcIdx >= 0);
      const fc = noAudioWithBgm.args[fcIdx + 1];
      assert.ok(!fc.includes('[0:a]'));
      assert.ok(fc.includes('[1:a]volume=0.15'));
      assert.ok(fc.includes('crop=trunc(in_w*0.96/2)*2'));
      // Input -t before -i inputPath
      assert.equal(noAudioWithBgm.args[noAudioWithBgm.args.indexOf('-i') - 2], '-t');
    } finally {
      fs.rmSync(tmpBgm, { force: true });
    }
  });

  it('places pad filter before ass filter in buildRenderArgs so overlays target full 9:16 canvas', () => {
    const rendered = ffmpegLib.buildRenderArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      start: 0,
      rawDuration: 5,
      width: 1080,
      height: 1920,
      framingMode: 'fit-bars',
      zoom: 1,
      assEscaped: 'C\\:/tmp/test.ass',
      shield: null,
      hasAudio: false
    });
    const vfIdx = rendered.args.indexOf('-vf');
    assert.ok(vfIdx >= 0);
    const vf = rendered.args[vfIdx + 1];
    const padIdx = vf.indexOf('pad=1080:1920');
    const assIdx = vf.indexOf("ass='C\\:/tmp/test.ass'");
    assert.ok(padIdx >= 0 && assIdx > padIdx);
  });

  it('auto-detects ffmpeg and ffprobe via checkMediaTools even when FFMPEG_PATH is unset', async () => {
    const prevFf = process.env.FFMPEG_PATH;
    const prevFp = process.env.FFPROBE_PATH;
    try {
      delete process.env.FFMPEG_PATH;
      delete process.env.FFPROBE_PATH;
      ffmpegLib.resetMediaBinCache();
      const tools = await ffmpegLib.checkMediaTools();
      if (process.platform === 'win32') {
        assert.equal(tools.ffmpeg, true);
        assert.equal(tools.ffprobe, true);
        assert.ok(tools.ffmpegPath && fs.existsSync(tools.ffmpegPath));
        assert.ok(tools.ffprobePath && fs.existsSync(tools.ffprobePath));
      }
    } finally {
      if (prevFf !== undefined) process.env.FFMPEG_PATH = prevFf;
      if (prevFp !== undefined) process.env.FFPROBE_PATH = prevFp;
      ffmpegLib.resetMediaBinCache();
    }
  });
});

describe('lib/qrcode', () => {
  it('generates valid SVG QR codes locally', () => {
    const svg = generateQrSvg('http://192.168.1.42:4173');
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('<path d="M'));
    assert.ok(svg.endsWith('</svg>'));
    assert.throws(() => generateQrSvg('x'.repeat(200)));
  });
});
