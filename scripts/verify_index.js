const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
console.log('HTML size:', html.length, 'bytes');

// Check script syntax
const scriptMatches = html.match(/<script(?![^>]*src=)[\s\S]*?<\/script>/gi);
console.log('Inline scripts found:', scriptMatches ? scriptMatches.length : 0);

if (scriptMatches) {
  scriptMatches.forEach((s, idx) => {
    const code = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try {
      new Function(code);
      console.log('Script ' + idx + ' syntax OK! Length: ' + code.length);
    } catch (e) {
      console.error('Script ' + idx + ' syntax error:', e.message);
    }
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

if (missingHash.length > 0) {
  console.warn('Missing element IDs referenced by $("#..."):', missingHash);
} else {
  console.log('ALL', uniqueHashIds.length, 'IDs referenced by $("#...") are present in index.html!');
}
