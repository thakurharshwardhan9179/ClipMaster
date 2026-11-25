'use strict';
const fs = require('node:fs');
const path = require('node:path');

const STOP_WORDS = new Set([
  'the','and','a','to','of','in','is','it','you','that','he','was','for','on','are','as','with','his','they',
  'at','be','this','have','from','or','one','had','by','word','but','not','what','all','were','we','when','your',
  'can','said','there','use','an','each','which','she','do','how','their','if','will','up','other','about','out',
  'hai','ye','ki','ko','se','aur','kya','me','hum','bhi','par','kar','ho','to','ka','ke','kuch','hota','hoti',
  'raha','rahi','ek','kare','karein','toh','yeh','woh','karta','karti','wali','wale','karo','gaya','gayi',
  'में','से','पर','को','का','के','की','है','हैं','था','थी','थे','और','या','तो','एक','यह','वह','इस','उस','अपने',
  'अपनी','अपनों','भी','ही','तक','कर','किया','गया','गई','हो','होता','होती','होते','रहा','रही','रहे','क्या','क्यों',
  'कैसे','कब','कहाँ','कहा','बोला','बोली','सा','सी','से'
]);

const HOOK_RE = /\b(how|why|what if|if you|you need|listen|look|here is|the secret|mistake|never|stop|most people|best|worst|truth|real reason|ways|tips|imagine|nobody|always remember|कैसे|क्यों|क्या|अगर|सुनो|देखो|यह|सीखें|सच|तरीका|गलती|जरूरी|सबसे|राज)\b/gi;
const INSIGHT_RE = /\b(salary|earn|money|mistake|secret|truth|important|simple|proof|result|learn|avoid|warning|problem|solution|step|benefit|skill|lesson|strategy|reason|पैसा|कमाई|नौकरी|काम|तरीका|सीख|फायदा|सही|गलत|समाधान|अनुभव)\b/gi;
const EMOTION_RE = /\b(love|hate|cry|laugh|funny|crazy|insane|shocked|shocking|heart|fear|dream|story|remember|finally|honestly|promise|believe|proud|pain|happy|प्यार|दिल|हंसी|मजाक|रोना|डर|सपना|कहानी|ईमानदारी|यकीन|दर्द|खुशी)\b/gi;
const STORY_PAYOFF_RE = /\b(then|suddenly|turns out|because|that's why|finally|realized|ended up|after that|तभी|अचानक|पता चला|इसलिए|आखिरकार|समझ आया|उसके बाद)\b/gi;
const INTRO_RE = /^(hello|hi|hey|welcome everyone|good morning|namaste|नमस्कार|हेलो|स्वागत|दोस्तों स्वागत)/i;
const OUTRO_RE = /\b(thank you for watching|thanks for watching|see you (in|next)|until then|like and subscribe|subscribe to|hit the bell|in the description|link in bio|sponsored by|धन्यवाद|मिलते हैं|सब्सक्राइब)\b/i;

function computeTokenJaccard(textA, textB) {
  const tok = s => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []));
  const a = tok(textA);
  const b = tok(textB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function findHighlights(cues, duration, count = 3, targetLengthPref = 35) {
  const ordered = cues
    .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && String(c.text || '').trim())
    .sort((a, b) => a.start - b.start);

  if (ordered.length < 3) {
    throw new Error('This video has too few readable captions to detect highlights. Try another video or a different caption language.');
  }

  let targetLength = Number(targetLengthPref) || 35;
  const minLength = Math.min(Math.max(8, Math.round(targetLength * 0.55)), duration - 1);
  const maxLength = Math.min(Math.max(25, Math.round(targetLength * 1.45)), duration - 0.1);
  targetLength = Math.min(targetLength, maxLength);
  if (maxLength < 5) throw new Error('Video is too short to create a Short clip.');

  const terminal = /[.!?।॥…]["')\\]]?$/;
  const starts = [];
  const seen = new Set();

  const addStart = (t, priority = 0) => {
    const key = Math.round(t / 3);
    if (t >= Math.min(8, duration * 0.08) && t <= duration - minLength && !seen.has(key)) {
      seen.add(key);
      starts.push({ t, priority });
    }
  };

  // Prefer natural sentence boundaries and pause gaps (>= 0.45s) so clips don't start mid-sentence
  for (let i = 0; i < ordered.length - 1; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    const endsClean = terminal.test(cur.text.trim());
    const pauseGap = next.start - cur.end;
    if (endsClean) addStart(next.start, 2);
    else if (pauseGap >= 0.45) addStart(next.start, 1);
  }

  let nextSample = Math.min(8, duration * 0.08);
  for (const cue of ordered) {
    if (cue.start >= nextSample) {
      addStart(cue.start, 0);
      nextSample = cue.start + 6;
    }
  }
  if (!starts.length) addStart(ordered[0].start, 0);

  const ranked = [];
  for (const { t: start, priority } of starts) {
    const endChoices = ordered.filter(c => c.end >= start + minLength && c.end <= Math.min(start + maxLength, duration));
    if (!endChoices.length) continue;

    // Pick an end cue that stays close to targetLength and lands on a complete thought/pause
    const endCue = endChoices.reduce((best, c) => {
      const idx = ordered.indexOf(c);
      const nextCue = ordered[idx + 1];
      const pauseAfter = nextCue ? Math.max(0, nextCue.start - c.end) : 1.0;
      const cost = x => {
        const xIdx = ordered.indexOf(x);
        const xNext = ordered[xIdx + 1];
        const xPause = xNext ? Math.max(0, xNext.start - x.end) : 1.0;
        return Math.abs((x.end - start) - targetLength)
          - (terminal.test(x.text.trim()) ? 2.8 : 0)
          - (xPause >= 0.4 ? 1.2 : 0);
      };
      return cost(c) < cost(best) ? c : best;
    });

    const end = endCue.end;
    const segment = ordered.filter(c => c.end > start && c.start < end);
    if (segment.length < 3) continue;

    // Silence / pacing check: avoid segments dominated by dead air
    const speechTime = segment.reduce((s, c) => s + Math.min(end, c.end) - Math.max(start, c.start), 0);
    const segDuration = Math.max(1, end - start);
    const speechRatio = speechTime / segDuration;
    if (speechRatio < 0.35) continue;

    const text = segment.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const words = lower.match(/[\p{L}\p{N}']+/gu) || [];
    if (words.length < 10) continue;

    const hookHits = (lower.slice(0, 160).match(HOOK_RE) || []).length;
    const insightHits = (lower.match(INSIGHT_RE) || []).length;
    const emotionHits = (lower.match(EMOTION_RE) || []).length;
    const storyHits = (lower.match(STORY_PAYOFF_RE) || []).length;
    const questions = (text.match(/[?]/g) || []).length;
    const exclaims = (text.match(/[!।]/g) || []).length;
    const digits = (text.match(/\b\d+\b/g) || []).length;
    const completeEnd = terminal.test(endCue.text.trim());
    const cleanStart = priority > 0;
    const uniqueRatio = new Set(words).size / words.length;
    const isIntro = INTRO_RE.test(text);
    const isOutro = OUTRO_RE.test(text);

    // Penalize repetitive filler / low-diversity segments
    if (uniqueRatio < 0.32) continue;

    const lengthBonus = Math.max(0, 7 - Math.abs(segDuration - targetLength) / 2.5);
    const density = Math.min(4.5, (words.length / segDuration) * 0.9);
    const pacingBonus = Math.min(2.5, speechRatio * 3.0);

    const hookScore = Math.min(7, hookHits * 1.5) + (questions > 0 ? 1.5 : 0);
    const insightScore = Math.min(6, insightHits * 0.85) + Math.min(2, digits * 0.6);
    const emotionScore = Math.min(5.5, emotionHits * 1.1) + Math.min(1.5, exclaims * 0.4);
    const storyScore = Math.min(4, storyHits * 0.9) + (completeEnd ? 2.2 : 0) + (cleanStart ? 1.5 : 0);

    const rawScore = lengthBonus + hookScore + insightScore + emotionScore + storyScore + uniqueRatio * 4 + density + pacingBonus
      - (isIntro ? 6 : 0)
      - (isOutro ? 10 : 0);

    const qualityScore = Math.min(98, Math.max(60, Math.round(56 + (rawScore / 26) * 40)));

    // Derive human-readable selection reason
    let selectionReason = 'High engagement potential';
    const categories = [
      { score: hookScore, label: 'Strong opening hook' },
      { score: insightScore, label: 'Useful insight' },
      { score: emotionScore, label: 'Emotional moment' },
      { score: storyScore, label: 'Story payoff' }
    ].sort((a, b) => b.score - a.score);
    if (categories[0].score >= 2.2) {
      selectionReason = categories[0].label;
    } else if (questions > 0) {
      selectionReason = 'Important statement & question';
    } else if (completeEnd && cleanStart) {
      selectionReason = 'Complete self-contained moment';
    }

    const sentences = text.split(/(?<=[.!?।॥])\s+/);
    const titleText = sentences.find(s => (s.match(/\S+/g) || []).length >= 4 && s.length >= 16) || text.split(/\s+/).slice(0, 8).join(' ');
    const title = titleText.replace(/\s+/g, ' ').replace(/\s+([,.!?।])/g, '$1').trim().slice(0, 68);

    ranked.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      score: qualityScore,
      selectionReason,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      captions: segment,
      _text: text
    });
  }

  // Deterministic sort: highest score, then earlier timestamp
  ranked.sort((a, b) => (b.score - a.score) || (a.start - b.start));

  const chosen = [];
  for (const item of ranked) {
    const nonOverlapping = chosen.every(x => item.start >= x.end + 4 || item.end <= x.start - 4);
    const nonDuplicateContent = chosen.every(x => computeTokenJaccard(item._text, x._text) < 0.65);
    if (nonOverlapping && nonDuplicateContent) {
      const { _text, ...cleanItem } = item;
      chosen.push(cleanItem);
    }
    if (chosen.length === count) break;
  }

  if (!chosen.length) {
    throw new Error('Could not find enough distinct captioned moments. Try a different caption language or a different video.');
  }
  return chosen.sort((a, b) => a.start - b.start);
}

async function rankWithLocalAi(candidates, wanted = 3) {
  if (wanted > 12) return { selected: null, diagnostic: 'Skipped local AI for >12 clips' };
  const endpoint = process.env.CLIPMASTER_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = process.env.CLIPMASTER_AI_MODEL || 'qwen2.5:3b';
  let diagnostic = '';

  try {
    const tags = await fetch(endpoint.replace(/\/api\/chat\/?$/, '/api/tags'), { signal: AbortSignal.timeout(3500) });
    if (!tags.ok) return { selected: null, diagnostic: `Ollama /api/tags returned ${tags.status}` };
    const available = (await tags.json()).models || [];
    if (!available.some(x => x.name === model || x.name?.startsWith(model + ':'))) {
      return { selected: null, diagnostic: `Model ${model} not found in Ollama. Install with: ollama pull ${model}` };
    }
  } catch (e) {
    return { selected: null, diagnostic: `Ollama unavailable: ${e.message}` };
  }

  const options = candidates.map((c, i) => ({
    id: `C${String(i + 1).padStart(2, '0')}`,
    start: c.start,
    end: c.end,
    score: c.score,
    reason: c.selectionReason,
    transcript: c.captions.map(x => x.text).join(' ').slice(0, 160)
  }));

  const prompt = `Pick ${wanted} distinct, self-contained short clips. Favor strong opening hooks, emotional moments, funny reactions, useful insights, or clear story payoffs. Avoid intros/outros or repeated segments. Reply with JSON ONLY: {"picks":[{"id":"C01","reason":"Strong hook"}]}. Candidates: ${JSON.stringify(options)}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: '15m',
        options: { temperature: 0, num_predict: Math.min(256, wanted * 28 + 32) },
        messages: [
          { role: 'system', content: `Select ${wanted} candidate IDs and return valid JSON or candidate IDs.` },
          { role: 'user', content: prompt }
        ]
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) return { selected: null, diagnostic: `Ollama chat returned ${response.status}` };

    const body = await response.json();
    const content = body.message?.content || '';
    const pickedItems = [];

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.picks)) {
          for (const p of parsed.picks) {
            const idx = Number(String(p.id || '').replace(/^C/i, '')) - 1;
            if (candidates[idx] && !pickedItems.some(x => x.start === candidates[idx].start)) {
              pickedItems.push({
                ...candidates[idx],
                aiPicked: true,
                selectionReason: String(p.reason || candidates[idx].selectionReason).slice(0, 60)
              });
            }
          }
        }
      }
    } catch {}

    if (!pickedItems.length) {
      const ids = [...new Set(content.match(/\bC0?\d{1,2}\b/gi) || [])].slice(0, wanted);
      for (const id of ids) {
        const idx = Number(id.replace(/^C/i, '')) - 1;
        if (candidates[idx] && !pickedItems.some(x => x.start === candidates[idx].start)) {
          pickedItems.push({ ...candidates[idx], aiPicked: true });
        }
      }
    }

    if (!pickedItems.length) {
      return { selected: null, diagnostic: `Ollama returned no valid IDs: ${content.slice(0, 120)}` };
    }

    for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
      if (pickedItems.length >= wanted) break;
      if (pickedItems.every(x => c.start >= x.end + 4 || c.end <= x.start - 4)) {
        pickedItems.push(c);
      }
    }

    return {
      selected: pickedItems.slice(0, wanted).sort((a, b) => a.start - b.start),
      diagnostic
    };
  } catch (e) {
    return { selected: null, diagnostic: `Ollama selection error: ${e.message}` };
  }
}

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

function generateHeuristicCopy({ title, transcript }) {
  const baseTitle = String(title || 'Must Watch Moment').replace(/^[_\s\-]+|[_\s\-]+$/g, '').slice(0, 80);
  const keywords = extractKeywords(`${baseTitle} ${transcript}`);
  const cleanTranscript = String(transcript || '').replace(/\s+/g, ' ').trim();

  const hooks = [
    `Wait for this moment! 🤯 ${baseTitle}`,
    `This changed my perspective 🔥 ${baseTitle}`,
    `Watch till the end! 💡 ${baseTitle}`,
    `The key takeaway about ${keywords[0] ? keywords[0].toUpperCase() : baseTitle} 👀`,
    `Worth hearing this! ⚡ ${baseTitle}`
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

  const defaultTags = ['#Reels', '#FacebookReels', '#Trending', '#Shorts', '#ExplorePage', '#DailyClips'];
  const keywordTags = keywords
    .filter(k => /^[a-zA-Z0-9]+$/.test(k))
    .slice(0, 5)
    .map(k => `#${k.charAt(0).toUpperCase() + k.slice(1)}`);

  const allTags = [...new Set([...defaultTags, ...keywordTags])];
  return {
    ok: true,
    source: 'smart-nlp',
    title: hookTitle,
    caption: captionBody,
    hashtags: allTags,
    hashtagsString: allTags.join(' ')
  };
}

async function generateAiPostCopy({ jobId, title, transcript, duration, useOllama = false }, exportsDir) {
  let text = transcript || '';
  if (!text && jobId && exportsDir) {
    const srtPath = path.join(exportsDir, `${jobId}.srt`);
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
      const prompt = `You are a social media editor. Generate engaging Facebook Reel / Shorts post copy for this clip.
Title: ${title || 'Highlight Clip'}
Duration: ${duration || 30} seconds
Transcript: ${text.slice(0, 800) || title || 'Engaging video moment'}

Return a valid JSON object ONLY with these exact keys:
{
  "hookTitle": "Catchy title with 1 emoji (under 50 chars)",
  "caption": "2-sentence engaging caption with a call to action",
  "hashtags": ["#Reels", "#FacebookReels", "#Shorts", "#Trending", "#ForYou"]
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
            ? parsed.hashtags.map(t => (String(t).startsWith('#') ? String(t) : `#${t}`))
            : ['#Reels', '#Shorts', '#Trending'];
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

module.exports = {
  findHighlights,
  rankWithLocalAi,
  extractKeywords,
  generateHeuristicCopy,
  generateAiPostCopy
};
