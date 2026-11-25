'use strict';
const fs = require('node:fs');
const assert = require('node:assert');

const html = fs.readFileSync('index.html', 'utf8');
console.log('HTML size:', html.length, 'bytes');

// Check script syntax
const scriptMatches = html.match(/<script(?![^>]*src=)[\s\S]*?<\/script>/gi);
console.log('Inline scripts found:', scriptMatches ? scriptMatches.length : 0);

if (scriptMatches) {
  scriptMatches.forEach((s, idx) => {
    const code = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    new Function(code);
    console.log('Script ' + idx + ' syntax OK! Length: ' + code.length);
  });
}

// Check IDs referenced via $('#...')
const hashMatches = Array.from(html.matchAll(/\$\(['"]#([a-zA-Z0-9_\-]+)['"]\)/g)).map(m => m[1]);
const uniqueHashIds = Array.from(new Set(hashMatches));
console.log('Total $("#id") selectors checked:', uniqueHashIds.length);

const missingHash = [];
for (const id of uniqueHashIds) {
  const pattern = new RegExp(`id=["']${id}["']`);
  if (!pattern.test(html)) {
    missingHash.push(id);
  }
}

assert.strictEqual(missingHash.length, 0, `Missing element IDs referenced by $("#..."): ${missingHash.join(', ')}`);
console.log('ALL', uniqueHashIds.length, 'IDs referenced by $("#...") are present in index.html!');

// Regression checks for previously identified frontend bugs
const downloadAllListeners = html.match(/\$\(['"]#btnDownloadAll['"]\)\?\.addEventListener\(['"]click['"]/g) || [];
assert.strictEqual(downloadAllListeners.length, 1, `Expected 1 #btnDownloadAll listener, found ${downloadAllListeners.length}`);
assert.ok(!html.includes('api.qrserver.com'), 'External QR dependency api.qrserver.com should not be present');
assert.ok(html.includes('#clipSelection'), '#clipSelection CSS rule must exist');
assert.ok(html.includes('#waveformPlayhead'), '#waveformPlayhead CSS rule must exist');
assert.ok(!html.includes('id="moreDropdown" style="display:none"'), '#moreDropdown should not have inline display:none');
assert.ok(!html.includes('id="batchProgress" style="display:none"'), '#batchProgress should use hidden attribute instead of inline display:none');
console.log('ALL frontend regression checks passed!');
