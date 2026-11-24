'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const currentHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Extract current script block
const scriptMatch = currentHtml.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('Could not find <script> block in index.html');
const scriptContent = scriptMatch[1];

// Full Figma Design CSS + Essential Component Styling
const figmaCss = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=Manrope:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0c0d;
      --s: #111416;
      --s2: #171b1d;
      --s3: #1d2224;
      --line: #292f31;
      --line2: #3b4345;
      --text: #f5f7f2;
      --muted: #818a87;
      --muted2: #a5b0ad;
      --lime: #c8ff63;
      --green: #72e39d;
      --purple: #9b8cff;
      --red: #ff6b6b;
      --amber: #f59e0b;
      --font: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-heading: 'Manrope', sans-serif;
      --mono: 'JetBrains Mono', monospace;
      --radius: 10px;
      --radius-sm: 7px;
      --radius-lg: 13px;
      --transition: 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      --shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 25px 80px rgba(0, 0, 0, 0.7);
    }

    html { scroll-behavior: smooth; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      padding-bottom: 44px;
      overflow-x: hidden;
    }

    button, input, select, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; border: none; background: none; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--lime);
      outline-offset: 2px;
    }
    a { color: inherit; text-decoration: none; }
    img, video { display: block; max-width: 100%; }

    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

    .app {
      min-height: 100vh;
      background: radial-gradient(circle at 50% -20%, rgba(155, 140, 255, 0.08), transparent 30%), var(--bg);
    }

    /* ── Topbar ─────────────────────────────────────────────── */
    .topbar {
      height: 64px;
      padding: 0 20px;
      border-bottom: 1px solid var(--line);
      background: rgba(10, 12, 13, 0.92);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .brandBtn {
      border: 0;
      background: none;
      color: inherit;
      padding: 0;
      cursor: pointer;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
      font: 800 16px 'Manrope', sans-serif;
      letter-spacing: -0.04em;
      color: var(--text);
    }
    .brand > b {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: var(--lime);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2.5px;
      flex-shrink: 0;
    }
    .brand > b i {
      width: 3px;
      border-radius: 3px;
      background: #111;
      display: inline-block;
    }
    .brand > b i:nth-child(1) { height: 9px; }
    .brand > b i:nth-child(2) { height: 16px; }
    .brand > b i:nth-child(3) { height: 12px; }
    .brand small, .tag, .purple {
      font: 700 8px 'DM Sans', sans-serif;
      color: var(--muted);
      border: 1px solid var(--line);
      background: var(--s2);
      border-radius: 20px;
      padding: 2px 7px;
      letter-spacing: 0.05em;
    }
    .purple {
      color: var(--purple);
      border-color: rgba(155, 140, 255, 0.25);
      background: rgba(155, 140, 255, 0.08);
    }
    .topbar > nav {
      display: flex;
      gap: 3px;
    }
    .topbar > nav button, .drawer nav button {
      border: 0;
      background: none;
      color: var(--muted);
      border-radius: 8px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition);
    }
    .topbar > nav button.on, .topbar > nav button:hover,
    .drawer nav button.on, .drawer nav button:hover {
      background: var(--s2);
      color: var(--text);
    }
    .actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .online {
      height: 29px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 18px;
      color: #bcc3c0;
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10px;
      font-weight: 500;
    }
    .online i, footer > div > i {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      display: inline-block;
    }
    .quiet {
      border: 0;
      background: none;
      color: var(--muted);
      padding: 7px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border-radius: 7px;
      transition: var(--transition);
    }
    .quiet:hover {
      color: var(--text);
      background: var(--s2);
    }
    .social-indicator {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
      transition: var(--transition);
      display: inline-block;
      flex-shrink: 0;
    }
    .social-indicator.connected {
      background: var(--green);
      box-shadow: 0 0 8px rgba(114, 227, 157, 0.8);
    }
    .btn {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--s2);
      color: #c7cdca;
      padding: 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
      transition: var(--transition);
    }
    .btn:hover:not(:disabled) {
      border-color: var(--line2);
      color: white;
      transform: translateY(-1px);
    }
    .btn.primary {
      background: var(--lime);
      border-color: var(--lime);
      color: #111;
      font-weight: 700;
    }
    .btn.primary:hover:not(:disabled) {
      background: #d4ff7d;
      border-color: #d4ff7d;
      box-shadow: 0 2px 14px rgba(200, 255, 99, 0.35);
      color: #111;
    }
    .btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
      transform: none !important;
    }
    .full { width: 100%; }
    .icon {
      width: 33px;
      height: 33px;
      border: 0;
      border-radius: 8px;
      background: none;
      color: var(--muted);
      display: grid;
      place-items: center;
      cursor: pointer;
      transition: var(--transition);
    }
    .icon:hover {
      background: var(--s2);
      color: white;
    }
    .icon.bordered {
      border: 1px solid var(--line);
    }
    .mob { display: none; }
    .more { position: relative; }
    .dropdown {
      position: absolute;
      right: 0;
      top: 42px;
      width: 200px;
      padding: 6px;
      background: var(--s2);
      border: 1px solid var(--line2);
      border-radius: 10px;
      box-shadow: var(--shadow-lg);
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .dropdown button {
      width: 100%;
      border: 0;
      background: none;
      color: #bec5c2;
      padding: 9px 10px;
      border-radius: 7px;
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      font-weight: 500;
      text-align: left;
    }
    .dropdown button:hover { background: var(--s3); color: var(--text); }
    .dropdown hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
    .dropdown .red { color: var(--red); }
    .dropdown .red:hover { background: rgba(255, 107, 107, 0.12); color: var(--red); }

    /* ── Main Layout ────────────────────────────────────────── */
    main {
      max-width: 1440px;
      margin: auto;
      padding: 24px 20px 60px;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid var(--line);
      border-radius: 11px;
      background: var(--s);
      overflow: hidden;
      margin-bottom: 20px;
    }
    .steps > div {
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: #66706d;
      font-size: 11px;
      font-weight: 600;
      position: relative;
    }
    .steps > div:not(:last-child)::after {
      content: '';
      height: 20px;
      width: 1px;
      background: var(--line);
      position: absolute;
      right: 0;
    }
    .steps span {
      width: 22px;
      height: 22px;
      border: 1px solid var(--line2);
      border-radius: 50%;
      display: grid;
      place-items: center;
      font: 600 10px 'Manrope', sans-serif;
    }
    .steps .active {
      color: white;
      background: linear-gradient(90deg, transparent, rgba(200, 255, 99, 0.08), transparent);
    }
    .steps .active span {
      background: var(--lime);
      border-color: var(--lime);
      color: #111;
      font-weight: 700;
    }
    .steps .done {
      color: #c4cbc8;
    }
    .steps .done span {
      background: var(--green);
      border-color: var(--green);
      color: #111;
      font-weight: 700;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 345px;
      gap: 18px;
      align-items: start;
    }
    .maincol, .side { min-width: 0; }
    .side {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--s);
      border-radius: 13px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .panel > header {
      min-height: 49px;
      border-bottom: 1px solid var(--line);
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .panel > header > div {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--lime);
    }
    .panel h2 {
      margin: 0;
      color: var(--text);
      font: 700 12px 'Manrope', sans-serif;
      letter-spacing: -0.01em;
    }

    /* ── Hero Upload Card ───────────────────────────────────── */
    .hero {
      padding: 48px 40px 30px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 35%), var(--s);
      text-align: center;
    }
    .herocopy > span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #c0c6c3;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    .herocopy > span i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--lime);
    }
    .herocopy > span svg { color: var(--lime); }
    .herocopy h1 {
      margin: 16px 0 12px;
      font: 800 clamp(32px, 4vw, 52px) / 1.05 'Manrope', sans-serif;
      letter-spacing: -0.055em;
      color: var(--text);
    }
    .herocopy h1 em {
      color: var(--lime);
      font-style: normal;
    }
    .herocopy p {
      max-width: 610px;
      margin: 0 auto 30px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.65;
    }
    .drop {
      width: min(710px, 100%);
      min-height: 220px;
      margin: auto;
      border: 1px dashed var(--line2);
      border-radius: 13px;
      background: var(--s2);
      color: inherit;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      cursor: pointer;
      transition: var(--transition);
      padding: 24px;
    }
    .drop:hover {
      border-color: var(--lime);
      background: rgba(200, 255, 99, 0.05);
      transform: translateY(-2px);
    }
    .drop > b {
      width: 49px;
      height: 49px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--s3);
      color: var(--lime);
      display: grid;
      place-items: center;
    }
    .drop h2 {
      font: 700 15px 'Manrope', sans-serif;
      margin: 14px 0 5px;
    }
    .drop p {
      color: var(--muted);
      font-size: 12px;
      margin: 0;
    }
    .drop p strong { color: var(--lime); }
    .drop small {
      color: #626a68;
      font-size: 9px;
      margin-top: 12px;
    }
    .or {
      width: min(710px, 100%);
      margin: 20px auto 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #616966;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    .or::before, .or::after {
      content: '';
      height: 1px;
      background: var(--line);
      flex: 1;
    }
    .import {
      width: min(710px, 100%);
      margin: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--s2);
      padding: 10px;
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 10px;
      align-items: center;
    }
    .import > b {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255, 107, 107, 0.12);
      color: var(--red);
      display: grid;
      place-items: center;
    }
    .import label {
      display: flex;
      flex-direction: column;
      min-width: 110px;
      text-align: left;
    }
    .import label strong { font-size: 10px; font-weight: 700; color: var(--text); }
    .import label small { color: var(--muted); font-size: 9px; }
    .import input, .project input, .fb input, .publish input {
      min-width: 0;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--bg);
      color: white;
      padding: 0 10px;
      font-size: 11px;
      outline: 0;
    }
    .features {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--line);
      display: grid;
      grid-template-columns: repeat(4, 1fr);
    }
    .features span {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
    }
    .features svg { color: var(--lime); width: 14px; }

    /* ── Video Stage & Timeline ─────────────────────────────── */
    .headact { display: flex !important; gap: 8px !important; align-items: center; }
    .headact > span {
      color: var(--green);
      border: 1px solid rgba(114, 227, 157, 0.25);
      background: rgba(114, 227, 157, 0.08);
      border-radius: 14px;
      padding: 3px 8px;
      font-size: 9px;
      font-weight: 700;
    }
    .stage { padding: 16px; }
    .frame {
      height: 390px;
      border-radius: 10px;
      background: #040505;
      overflow: hidden;
      position: relative;
      display: grid;
      place-items: center;
    }
    .frame video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
    .play-overlay-btn {
      position: absolute;
      z-index: 5;
      width: 54px;
      height: 54px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.65);
      color: white;
      border-radius: 50%;
      display: grid;
      place-items: center;
      cursor: pointer;
      transition: var(--transition);
    }
    .play-overlay-btn:hover {
      background: rgba(0, 0, 0, 0.85);
      transform: scale(1.08);
    }
    .vidmeta {
      display: flex;
      justify-content: space-between;
      padding: 10px 2px 0;
      color: var(--muted);
      font-size: 11px;
    }
    .vidmeta strong { color: #c9cfcc; }

    .timeline { padding: 16px; border-top: 1px solid var(--line); }
    .tlhead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 11px;
    }
    .tlhead > span {
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }
    .tlhead > div {
      display: flex;
      gap: 5px;
      align-items: center;
    }
    .tlhead button, .tlhead select {
      height: 28px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--s2);
      color: var(--muted);
      padding: 0 8px;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition);
    }
    .tlhead button:hover, .tlhead select:hover {
      color: var(--text);
      border-color: var(--line2);
    }
    .tlhead time {
      font: 600 11px 'Manrope', sans-serif;
      color: #c7cdca;
      padding: 0 6px;
    }

    .wave {
      height: 64px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--s2);
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }
    .wave canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    #selectionOverlay {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0%;
      width: 30%;
      border-left: 2px solid var(--lime);
      border-right: 2px solid var(--lime);
      background: rgba(200, 255, 99, 0.08);
      pointer-events: none;
    }
    #playheadLine {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0%;
      width: 2px;
      background: white;
      box-shadow: 0 0 8px white;
      pointer-events: none;
    }
    .ticks {
      display: flex;
      justify-content: space-between;
      color: #606866;
      font-size: 9px;
      font-family: var(--mono);
      margin: 6px 0 10px;
    }
    .ranges {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .ranges label {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--s2);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
    }
    .ranges input {
      flex: 1;
      min-width: 20px;
      accent-color: var(--lime);
      cursor: pointer;
    }
    .ranges time {
      font: 600 11px 'Manrope', sans-serif;
      color: #c7cdca;
      min-width: 40px;
      text-align: right;
    }
    .times {
      display: grid;
      grid-template-columns: 1fr auto 1fr 115px;
      gap: 10px;
      align-items: center;
      margin-top: 10px;
    }
    .times label {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--s2);
      padding: 6px 10px;
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .times label input {
      display: block;
      width: 100%;
      border: 0;
      background: none;
      color: white;
      padding-top: 3px;
      font: 600 11px 'Manrope', sans-serif;
      outline: none;
    }
    .times > div {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
    }
    .times > div strong {
      color: var(--lime);
      font: 700 13px 'Manrope', sans-serif;
      margin-top: 2px;
    }

    /* ── Lower Grid (Captions & Style) ──────────────────────── */
    .lower {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 14px;
      margin-top: 16px;
    }
    .captionlist {
      padding: 6px 16px 0;
      max-height: 280px;
      overflow-y: auto;
    }
    .caption-row {
      display: grid;
      grid-template-columns: 55px 1fr 26px;
      gap: 10px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }
    .caption-ts {
      font: 600 10px 'Manrope', sans-serif;
      color: #c6cdca;
      display: block;
    }
    .caption-text {
      resize: none;
      height: 48px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--s2);
      color: #c7cdca;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1.4;
      outline: none;
    }
    .caption-text:focus {
      border-color: var(--lime);
    }
    .caption-del {
      border: 0;
      background: none;
      color: var(--muted);
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .caption-del:hover { color: var(--red); }
    .addcap {
      width: calc(100% - 32px);
      margin: 10px 16px 14px;
      height: 32px;
      border: 1px dashed var(--line2);
      border-radius: 7px;
      background: var(--s2);
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: var(--transition);
    }
    .addcap:hover {
      border-color: var(--lime);
      color: var(--lime);
    }
    .style { padding: 16px; }
    .fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .style label, .fields label {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .style select, .setting select {
      width: 100%;
      height: 32px;
      margin-top: 5px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--s2);
      color: #c7cdca;
      padding: 0 8px;
      font-size: 11px;
      outline: none;
    }
    .swatches { display: flex; gap: 8px; margin-top: 7px; }
    .swatches button {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid var(--s);
      cursor: pointer;
    }
    .swatches button.active, .swatches button.on {
      outline: 2px solid var(--lime);
      outline-offset: 1px;
    }
    .segments {
      display: flex;
      border: 1px solid var(--line);
      border-radius: 7px;
      overflow: hidden;
      margin-top: 6px;
    }
    .segments button {
      flex: 1;
      height: 30px;
      border: 0;
      border-right: 1px solid var(--line);
      background: var(--s2);
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
    }
    .segments button:last-child { border-right: none; }
    .segments button.active, .segments button.on {
      color: var(--lime);
      background: rgba(200, 255, 99, 0.1);
      font-weight: 700;
    }
    .toggle {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      color: #c7cdca;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .toggle input { accent-color: var(--lime); width: 16px; height: 16px; cursor: pointer; }

    /* ── Sidebar (Project & Shorts Studio) ──────────────────── */
    .project, .studio { padding: 16px; }
    .project > label { color: var(--muted); font-size: 10px; font-weight: 600; }
    .project > label > div { position: relative; margin: 6px 0 10px; }
    .project input { width: 100%; padding-right: 28px; font-weight: 600; }
    .project label svg { position: absolute; right: 8px; top: 10px; color: var(--muted); pointer-events: none; }
    .project p {
      min-height: 32px;
      margin: 0;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
    }
    .project p:last-child { border: 0; }
    .project p span { color: var(--muted); }
    .project p strong {
      color: #c7cdca;
      font: 500 11px 'Manrope', sans-serif;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .modes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
    }
    .modes button {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--s2);
      color: var(--muted);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      text-align: left;
      cursor: pointer;
      transition: var(--transition);
    }
    .modes button.active, .modes button.on {
      border-color: rgba(200, 255, 99, 0.5);
      background: rgba(200, 255, 99, 0.08);
      color: var(--lime);
    }
    .modes button span { min-width: 0; display: flex; flex-direction: column; }
    .modes strong { color: #c7cdca; font-size: 11px; }
    .modes small { font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
    .estimate {
      height: 32px;
      margin: 10px 0;
      border: 1px solid rgba(200, 255, 99, 0.2);
      border-radius: 7px;
      background: rgba(200, 255, 99, 0.05);
      color: var(--lime);
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      font-size: 10px;
      font-weight: 600;
    }
    .setting {
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
      margin-bottom: 4px;
    }
    .setting input {
      width: 60px;
      height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--s2);
      color: white;
      text-align: center;
      font-weight: 600;
    }
    .setting select {
      width: auto;
      max-width: 190px;
      margin: 0;
    }
    .hint, .ready {
      display: block;
      color: #66706d;
      font-size: 10px;
      line-height: 1.5;
      margin: 5px 0 10px;
    }
    .studio hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 12px 0 6px;
    }
    .ratios { display: flex; gap: 5px; }
    .ratios button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--s2);
      color: var(--muted);
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .ratios button.active, .ratios button.on {
      border-color: var(--lime);
      color: var(--lime);
      background: rgba(200, 255, 99, 0.1);
      font-weight: 700;
    }
    .generate {
      height: 40px;
      margin-top: 12px;
      font-size: 12px;
      font-weight: 700;
    }
    .ready { text-align: center; }

    /* ── Results / Clip Cards ───────────────────────────────── */
    .results {
      border-top: 1px solid var(--line);
      margin-top: 12px;
      padding-top: 12px;
    }
    .results > header {
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .results header button {
      border: 0;
      background: none;
      color: var(--lime);
      display: flex;
      gap: 4px;
      align-items: center;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
    }
    .clip-card {
      display: grid;
      grid-template-columns: 56px 1fr;
      gap: 10px;
      border: 1px solid var(--line);
      background: var(--s2);
      border-radius: 9px;
      padding: 8px;
      margin-top: 8px;
      transition: var(--transition);
    }
    .clip-card:hover {
      border-color: var(--line2);
      transform: translateY(-1px);
    }
    .clip-thumb-box {
      height: 72px;
      border-radius: 6px;
      background: linear-gradient(145deg, #17132d, #271c42);
      position: relative;
      overflow: hidden;
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .clip-thumb-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .clip-thumb-video.ready { opacity: 1; }
    .clip-thumb-overlay {
      position: absolute;
      z-index: 2;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      color: white;
      display: grid;
      place-items: center;
    }
    .clip-thumb-overlay svg { width: 12px; height: 12px; fill: currentColor; }
    .clip-thumb-spinner {
      position: absolute;
      z-index: 3;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: var(--lime);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .clip-card-details {
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .clip-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 4px;
    }
    .clip-title-wrap {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .clip-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .clip-status {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 10px;
      white-space: nowrap;
      font-family: var(--mono);
    }
    .clip-status.queued { color: var(--muted); background: var(--s3); }
    .clip-status.rendering { color: var(--amber); background: rgba(245, 158, 11, 0.12); }
    .clip-status.complete { color: var(--green); background: rgba(114, 227, 157, 0.12); }
    .clip-status.failed { color: var(--red); background: rgba(255, 107, 107, 0.12); }
    .clip-meta {
      color: var(--muted);
      font-size: 9px;
      margin-top: 2px;
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .clip-score {
      color: var(--lime);
      font-weight: 600;
    }
    .clip-progress progress {
      width: 100%;
      height: 3px;
      margin-top: 4px;
      border-radius: 2px;
      border: none;
      background: var(--s3);
    }
    .clip-progress progress::-webkit-progress-bar { background: var(--s3); }
    .clip-progress progress::-webkit-progress-value { background: var(--lime); }
    .clip-actions {
      display: flex;
      gap: 4px;
      margin-top: 6px;
      align-items: center;
    }
    .clip-actions button, .clip-actions a {
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--s);
      color: var(--muted);
      padding: 0 6px;
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: var(--transition);
    }
    .clip-actions button:hover, .clip-actions a:hover {
      border-color: var(--line2);
      color: var(--text);
    }
    .btn-clip-publish {
      background: var(--lime) !important;
      border-color: var(--lime) !important;
      color: #111 !important;
      font-weight: 700 !important;
    }
    .btn-clip-publish:hover {
      background: #d4ff7d !important;
      color: #111 !important;
    }
    .clip-actions a[aria-disabled="true"], .clip-actions button:disabled {
      opacity: 0.35;
      pointer-events: none;
    }

    .panel details { border-top: 1px solid var(--line); }
    .panel summary {
      height: 42px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    .panel details > div { padding: 0 16px 16px; }

    /* ── Projects Page (Library) ────────────────────────────── */
    .projects { padding: 32px 10px; }
    .projects > header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .projects > header > div > span {
      color: var(--lime);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 700;
    }
    .projects h1 {
      font: 800 28px 'Manrope', sans-serif;
      letter-spacing: -0.04em;
      margin: 6px 0 4px;
      color: var(--text);
    }
    .projects header p {
      color: var(--muted);
      font-size: 12px;
      margin: 0;
    }
    .projectgrid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .projectgrid article, .project-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--s);
      overflow: hidden;
      cursor: pointer;
      transition: var(--transition);
    }
    .projectgrid article:hover, .project-card:hover {
      transform: translateY(-3px);
      border-color: var(--line2);
      box-shadow: var(--shadow-lg);
    }
    .visual, .project-thumb-box {
      aspect-ratio: 16/9;
      position: relative;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: #17132d;
    }
    .visual.lime { background: #1a2619; }
    .visual.blue { background: #102630; }
    .visual > span {
      position: absolute;
      left: 16px;
      top: 10px;
      color: rgba(255, 255, 255, 0.12);
      font: 800 48px 'Manrope', sans-serif;
    }
    .visual > b {
      width: 42%;
      aspect-ratio: 1;
      border-radius: 50%;
      background: var(--purple);
      box-shadow: 70px 30px 60px rgba(200, 255, 99, 0.3);
    }
    .visual > button, .project-card-delete {
      position: absolute;
      right: 10px;
      top: 10px;
      width: 28px;
      height: 28px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 7px;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      display: grid;
      place-items: center;
      cursor: pointer;
      opacity: 0;
      transition: var(--transition);
    }
    .projectgrid article:hover .visual > button, .project-card:hover .project-card-delete {
      opacity: 1;
    }
    .projectgrid article > section, .project-info {
      padding: 14px;
    }
    .projectgrid section em {
      float: right;
      color: var(--green);
      font-size: 10px;
      font-style: normal;
      font-weight: 700;
    }
    .projectgrid h2, .project-name {
      font: 700 13px 'Manrope', sans-serif;
      margin: 0 50px 6px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
    }
    .projectgrid section p, .project-meta {
      color: var(--muted);
      font-size: 10px;
      margin: 0;
    }
    .newproject {
      min-height: 240px;
      border: 1px dashed var(--line2);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.01);
      color: var(--muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: var(--transition);
    }
    .newproject:hover {
      border-color: var(--lime);
      background: rgba(200, 255, 99, 0.04);
      transform: translateY(-3px);
    }
    .newproject i {
      width: 44px;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 11px;
      background: var(--s2);
      color: var(--lime);
      display: grid;
      place-items: center;
    }
    .newproject strong { color: #c7cdca; font-size: 12px; margin-top: 10px; }
    .newproject small { font-size: 10px; margin-top: 4px; }

    /* ── Footer Status Bar ──────────────────────────────────── */
    footer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 35;
      height: 36px;
      border-top: 1px solid var(--line);
      background: rgba(17, 20, 22, 0.96);
      backdrop-filter: blur(12px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      color: var(--muted);
      font-size: 10px;
    }
    footer > div {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    footer strong {
      color: #c7cdca;
      font-weight: 500;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    footer em {
      font-style: normal;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 2px 7px;
      background: var(--s2);
    }
    footer kbd {
      border: 1px solid var(--line2);
      background: var(--s3);
      border-radius: 4px;
      color: #c7cdca;
      padding: 2px 6px;
      font-family: var(--mono);
      font-size: 9px;
    }
    .green { color: var(--green) !important; }

    /* ── Modals & Drawers ───────────────────────────────────── */
    .modal-backdrop, .modalback {
      position: fixed;
      inset: 0;
      z-index: 80;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: grid;
      place-items: center;
      padding: 16px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .modal-backdrop.open, .modalback.open {
      opacity: 1;
      pointer-events: auto;
    }
    .modal {
      width: min(480px, 100%);
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      border: 1px solid var(--line2);
      border-radius: 14px;
      background: var(--s);
      box-shadow: var(--shadow-lg);
      transform: translateY(10px);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .modal-backdrop.open .modal { transform: translateY(0); }
    .modal > header, .modal-header {
      height: 56px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal > header > div, .modal-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--lime);
    }
    .modal h2, .modal h3, .modal-title {
      font: 700 14px 'Manrope', sans-serif;
      color: white;
      margin: 0;
    }
    .modal-close-btn {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      color: var(--muted);
      cursor: pointer;
    }
    .modal-close-btn:hover { color: white; background: var(--s2); }

    .modal-desc {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
      padding: 16px 18px 0;
    }
    .modal-footer {
      padding: 14px 18px;
      border-top: 1px solid var(--line);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .shortcuts-grid { padding: 16px 18px; }
    .shortcut-row {
      height: 42px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #c7cdca;
      font-size: 11px;
    }
    .shortcut-row:last-child { border: none; }
    .shortcut-row kbd {
      border: 1px solid var(--line2);
      border-radius: 6px;
      background: var(--s2);
      padding: 4px 8px;
      font-size: 10px;
      font-family: var(--mono);
      color: var(--text);
    }

    /* Accounts & Facebook Modal */
    .step-guide-box {
      border: 1px solid var(--line);
      background: var(--s2);
      border-radius: 8px;
      padding: 12px 14px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.6;
      margin: 14px 18px;
    }
    .step-guide-box strong { color: #c7cdca; }
    .step-guide-box ol { margin: 6px 0 0; padding-left: 18px; }
    .step-guide-link { color: var(--lime); text-decoration: underline; }
    .account-card {
      background: var(--s2);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px;
      margin: 14px 18px;
    }
    .account-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .account-user-info { display: flex; align-items: center; gap: 10px; }
    .account-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: #1877F2;
      display: grid;
      place-items: center;
      color: white;
      font-weight: 700;
      font-size: 15px;
    }
    .account-pages-list { display: flex; flex-direction: column; gap: 7px; }
    .fb-page-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      background: var(--s);
      border: 1px solid var(--line);
      border-radius: 7px;
    }
    .fb-page-name { font-size: 11px; font-weight: 700; color: var(--text); }
    .fb-page-sub { font-size: 10px; color: var(--muted); }

    /* AI Copy & Publish Box */
    .ai-copy-box {
      background: rgba(200, 255, 99, 0.04);
      border: 1px solid rgba(200, 255, 99, 0.2);
      border-radius: 9px;
      padding: 14px;
      margin: 14px 0;
    }
    .ai-copy-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .tag-pills-wrap { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .tag-pill {
      font-size: 10px;
      font-family: var(--mono);
      background: var(--s2);
      border: 1px solid var(--line);
      color: var(--muted);
      padding: 3px 8px;
      border-radius: 12px;
      cursor: pointer;
      transition: var(--transition);
    }
    .tag-pill:hover { border-color: var(--lime); color: var(--text); }
    .tag-pill.selected {
      background: rgba(200, 255, 99, 0.12);
      border-color: var(--lime);
      color: var(--lime);
      font-weight: 700;
    }

    /* QR / Mobile Modal */
    .modal-qr-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      margin: 14px 18px;
      padding: 16px;
      background: var(--s2);
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    .qr-image-wrapper {
      width: 160px;
      height: 160px;
      background: white;
      padding: 8px;
      border-radius: 8px;
      display: grid;
      place-items: center;
    }
    .qr-image-wrapper img { width: 100%; height: 100%; object-fit: contain; }
    .mobile-url-pill {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      color: var(--lime);
      background: rgba(200, 255, 99, 0.08);
      border: 1px solid rgba(200, 255, 99, 0.25);
      padding: 8px 12px;
      border-radius: 7px;
      word-break: break-all;
      text-align: center;
      width: 100%;
    }

    /* Mobile Drawer */
    .mobile-drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 90;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(6px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .mobile-drawer-backdrop.open { opacity: 1; pointer-events: auto; }
    .mobile-drawer {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 95;
      width: min(290px, 85vw);
      background: var(--s);
      border-right: 1px solid var(--line);
      padding: 18px;
      display: flex;
      flex-direction: column;
      transform: translateX(-100%);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .mobile-drawer.open { transform: translateX(0); }
    .mobile-drawer-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .mobile-drawer-nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 14px;
    }
    .mobile-nav-link {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      transition: var(--transition);
    }
    .mobile-nav-link.active, .mobile-nav-link:hover {
      background: var(--s2);
      color: white;
    }
    .mobile-drawer-footer {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 48px;
      z-index: 100;
      transform: translate(-50%, 12px);
      opacity: 0;
      pointer-events: none;
      border: 1px solid var(--line2);
      border-radius: 9px;
      background: var(--s2);
      box-shadow: var(--shadow-lg);
      color: #c7cdca;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      font-weight: 600;
      transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .toast.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }

    [hidden], .hidden { display: none !important; }

    /* ── Responsive Rules ───────────────────────────────────── */
    @media (max-width: 1050px) {
      .workspace { grid-template-columns: minmax(0, 1fr) 300px; }
      .quiet span { display: none; }
      .frame { height: 330px; }
      .hero { padding-inline: 27px; }
    }
    @media (max-width: 840px) {
      .topbar > nav, .quiet.keys { display: none; }
      .mob { display: grid; }
      .online { display: none; }
      .workspace { grid-template-columns: 1fr; }
      .features { grid-template-columns: 1fr 1fr; gap: 12px; }
      .projectgrid { grid-template-columns: repeat(2, 1fr); }
      .lower { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      main { padding: 12px 10px 52px; }
      .topbar { height: 57px; padding: 0 12px; gap: 8px; }
      .quiet { display: none; }
      .actions > .btn span { display: none; }
      .actions > .btn { width: 34px; padding: 0; }
      .brand small { display: none; }
      .steps { overflow-x: auto; grid-template-columns: repeat(4, minmax(110px, 1fr)); }
      .steps > div { justify-content: flex-start; padding-left: 12px; }
      .hero { padding: 28px 14px 20px; }
      .herocopy h1 { font-size: 32px; }
      .import { grid-template-columns: auto 1fr; }
      .import input, .import > .btn { grid-column: 1 / -1; width: 100%; }
      .features { grid-template-columns: 1fr; }
      .features span { justify-content: flex-start; }
      .frame { height: 230px; }
      .ranges { grid-template-columns: 1fr; }
      .times { grid-template-columns: 1fr 1fr; }
      .times > svg { display: none; }
      .projectgrid { grid-template-columns: 1fr; }
      .footkeys, footer > div:last-child { display: none; }
    }
`;

// Assemble the complete HTML
const newHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0a0c0d">
  <meta name="description" content="ClipMaster 2.0 — Local AI Video Repurposing Studio. Find the moments worth sharing.">
  <title>ClipMaster 2.0 — Local AI Video Studio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..700&family=Manrope:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${figmaCss}</style>
</head>
<body>

<div class="app">
  <!-- ── Topbar ────────────────────────────────────────────── -->
  <header class="topbar">
    <button class="icon mob" id="mobileMenuBtn" aria-label="Open menu">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <button class="brandBtn" id="navHome">
      <div class="brand">
        <b><i></i><i></i><i></i></b>
        <strong>ClipMaster</strong>
        <small class="brand-version">2.0</small>
      </div>
    </button>
    <nav>
      <button class="on" id="navWorkspace">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16m8-16v16M3 9h5m8 0h5M3 15h5m8 0h5"/></svg>
        Workspace
      </button>
      <button id="navProjects">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7h7l2 2h9v10H3V7Z"/></svg>
        Projects
      </button>
    </nav>
    <div class="actions">
      <span class="online" id="serverStatus"><i class="status-dot"></i><span id="sbServer">Local engine ready</span></span>
      <button class="quiet" id="topAccountsBtn" title="Facebook Page Publishing & Accounts">
        <span class="social-indicator" id="socialIndicator"></span>
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;color:#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
        <span class="btn-text" id="topAccountsBtnText">Facebook</span>
      </button>
      <button class="quiet" id="topMobileConnectBtn" title="Open ClipMaster on Phone / Wi-Fi">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg>
        <span class="btn-text">Mobile</span>
      </button>
      <button class="quiet keys" id="topShortcutsBtn" title="View keyboard shortcuts">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M11 13h.01M15 13h.01M9 16h6"/></svg>
        Shortcuts
      </button>
      <button class="btn primary" id="uploadTopBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M5 14v5h14v-5"/></svg>
        <span class="btn-text">Upload</span>
      </button>
      <div class="more">
        <button class="icon bordered" id="moreMenuBtn" aria-label="More actions">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
        </button>
        <div class="dropdown" id="moreDropdown" style="display:none">
          <button id="menuAccountsBtn">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width:13px;height:13px;color:#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            Facebook Accounts
          </button>
          <button id="menuShortcutsBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M11 13h.01M15 13h.01M9 16h6"/></svg>
            Keyboard Shortcuts
          </button>
          <button id="menuReloadBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 8a7 7 0 0 1 12-1l2 5M4 12l2 5a7 7 0 0 0 12-1"/></svg>
            Refresh Connection
          </button>
          <hr>
          <button class="red" id="resetBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7"/><path d="M10 11v6m4-6v6"/></svg>
            Reset Workspace
          </button>
        </div>
      </div>
    </div>
    <input id="fileInput" type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-m4v" hidden>
  </header>

  <!-- ── Main Workspace / Shell ────────────────────────────── -->
  <main>
    <div id="workspacePage">
      <!-- 4-step workflow indicator -->
      <div class="steps" id="stepsBar">
        <div class="active" id="step1"><span class="step-num">01</span><b>Add video</b></div>
        <div id="step2"><span class="step-num">02</span><b>Trim clip</b></div>
        <div id="step3"><span class="step-num">03</span><b>Style captions</b></div>
        <div id="step4"><span class="step-num">04</span><b>Export</b></div>
      </div>

      <div class="workspace">
        <!-- Main Column -->
        <div class="maincol">
          <!-- Hero Upload Card (Landing state) -->
          <section class="hero" id="uploadCard">
            <div class="herocopy">
              <span><i></i><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>Private, local AI video studio</span>
              <h1>Find the moments<br><em>worth sharing.</em></h1>
              <p>Turn long videos, podcasts, and interviews into sharp, captioned vertical clips — without sending your footage to the cloud.</p>
            </div>

            <!-- Drop Zone -->
            <div class="drop" id="dropZone">
              <b>
                <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 19h10a4 4 0 0 0 1-7.9A6 6 0 0 0 6 10a4.5 4.5 0 0 0 1 9Z"/><path d="M12 16V9m0 0-3 3m3-3 3 3"/></svg>
              </b>
              <h2>Drop a video to begin</h2>
              <p>or <strong>choose a file</strong> from your computer</p>
              <small>MP4, MOV, MKV, WEBM, M4V · up to 8 GB</small>

              <div class="upload-progress-wrap" id="uploadProgressWrap" style="display:none;width:80%;margin-top:14px">
                <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:5px">
                  <span id="uploadProgressTitle">Uploading video…</span>
                  <span id="uploadPct">0%</span>
                </div>
                <progress id="uploadProgressBar" max="100" value="0" style="width:100%;height:6px"></progress>
              </div>
            </div>

            <div class="or"><span>or import from a URL</span></div>

            <!-- YouTube Import Row -->
            <div class="import">
              <b>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m9 7 8 5-8 5V7Z"/></svg>
              </b>
              <label>
                <strong>YouTube link</strong>
                <small>Captions extracted automatically</small>
              </label>
              <input id="ytUrlInput" placeholder="Paste youtube.com/watch?v=…" type="url">
              <button class="btn" id="ytImportBtn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-5.5-5.8"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 5.5 5.8"/></svg>
                Import video
              </button>
            </div>
            <div id="ytError" style="font-size:11px;color:var(--red);margin-top:8px;text-align:center"></div>

            <!-- 4 Features Bar -->
            <div class="features">
              <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s7-3.5 7-9V5l-7-2-7 2v7c0 5.5 7 9 7 9Z"/><path d="m9 12 2 2 4-4"/></svg>100% local &amp; private</span>
              <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>AI hook detection</span>
              <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 3v14h14M3 7h14v14"/></svg>Vertical auto-crop</span>
              <span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 11h4m3 0h3M7 15h3m3 0h4"/></svg>Dynamic captions</span>
            </div>
          </section>

          <!-- Video Editor Panel -->
          <section class="panel" id="videoCard" hidden>
            <header>
              <div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16m8-16v16M3 9h5m8 0h5M3 15h5m8 0h5"/></svg>
                <h2 id="videoTitle">Source video</h2>
              </div>
              <div class="headact">
                <span id="videoQualityBadge">1080P</span>
                <button class="btn" id="changeVideoBtn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M5 14v5h14v-5"/></svg>
                  Change video
                </button>
              </div>
            </header>
            <div class="stage">
              <div class="frame">
                <video id="sourceVideo" preload="metadata" playsinline></video>
                <button id="btnPlayPause" class="play-overlay-btn" aria-label="Play or pause">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" id="playIcon"><path d="m9 7 8 5-8 5V7Z"/></svg>
                </button>
              </div>
              <div class="vidmeta">
                <strong id="videoMeta">Video Title</strong>
                <span><span id="videoCurrentTime">0:00</span> / <span id="videoTotalTime">0:00</span></span>
              </div>
            </div>
            <div class="timeline">
              <div class="tlhead">
                <span>Clip range &amp; timeline</span>
                <div>
                  <button id="btnSeekBack" title="Seek back 5s">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 8-4 4 4 4m-4-4h9"/></svg>
                    -5s
                  </button>
                  <button id="btnSpeed" title="Playback speed">1×</button>
                  <button id="btnSeekFwd" title="Seek forward 5s">
                    +5s
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 8 4 4-4 4m4-4H7"/></svg>
                  </button>
                  <button id="btnSetIn" title="Set IN (Shortcut: I)">Set in</button>
                  <button id="btnSetOut" title="Set OUT (Shortcut: O)">Set out</button>
                  <span id="playText" style="display:none">Play</span>
                </div>
              </div>
              <div class="wave" id="waveform">
                <div id="waveformBars" style="width:100%;height:100%;position:absolute;top:0;left:0"></div>
                <div id="clipSelection"></div>
                <div id="waveformPlayhead"></div>
              </div>
              <div class="ticks" id="waveformTicks">
                <span>0:00</span>
                <span id="totalDurationTick">0:00</span>
              </div>
              <div class="ranges">
                <label>
                  IN
                  <input type="range" id="rangeIn" min="0" max="100" value="0" step="1">
                  <time id="rangeInLabel">0:00</time>
                </label>
                <label>
                  OUT
                  <input type="range" id="rangeOut" min="0" max="100" value="30" step="1">
                  <time id="rangeOutLabel">0:30</time>
                </label>
              </div>
              <div class="times">
                <label>
                  Start time
                  <input id="startInput" value="0:00:00">
                </label>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 8 4 4-4 4m4-4H7"/></svg>
                <label>
                  End time
                  <input id="endInput" value="0:00:30">
                </label>
                <div>
                  <span>Clip duration</span>
                  <strong id="durationLabel">0:30</strong>
                </div>
              </div>
            </div>
          </section>

          <!-- Lower Grid (Captions & Caption Style) -->
          <div class="lower" id="lowerGrid" hidden>
            <section class="panel">
              <header>
                <div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 11h4m3 0h3M7 15h3m3 0h4"/></svg>
                  <h2>Captions</h2>
                </div>
                <span class="tag" id="captionCount">0 lines</span>
              </header>
              <div class="captionlist" id="captionsList">
                <div class="captions-empty" id="captionsEmpty" style="padding:20px 10px;text-align:center;color:var(--muted);font-size:11px">
                  No captions yet. Imported captions appear here automatically, or add manually below.
                </div>
              </div>
              <button class="addcap" id="addCaptionBtn">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg>
                Add caption line
              </button>
            </section>

            <section class="panel">
              <header>
                <div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>
                  <h2>Caption style</h2>
                </div>
              </header>
              <div class="style">
                <div class="fields">
                  <label>
                    Font
                    <select id="fontSelect">
                      <option value="Arial">Arial</option>
                      <option value="Manrope">Manrope</option>
                      <option value="DM Sans" selected>DM Sans</option>
                      <option value="Inter">Inter</option>
                    </select>
                  </label>
                  <label>
                    Size
                    <select id="sizeSelect">
                      <option value="small">Small</option>
                      <option value="medium" selected>Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                </div>
                <label>
                  Highlight color
                  <div class="swatches">
                    <button class="swatch on" style="background:#ffffff" data-color="#ffffff" title="White"></button>
                    <button class="swatch" style="background:#c8ff63" data-color="#c8ff63" title="Neon Lime"></button>
                    <button class="swatch" style="background:#9b8cff" data-color="#9b8cff" title="Lilac"></button>
                    <button class="swatch" style="background:#51d7ff" data-color="#51d7ff" title="Cyan"></button>
                    <button class="swatch" style="background:#ff8a65" data-color="#ff8a65" title="Coral"></button>
                  </div>
                </label>
                <label>
                  Background
                  <div class="segments" id="bgStyle">
                    <button class="segmented-btn" data-val="None">None</button>
                    <button class="segmented-btn on" data-val="Pill">Pill</button>
                    <button class="segmented-btn" data-val="Shadow">Shadow</button>
                    <button class="segmented-btn" data-val="Outline">Outline</button>
                  </div>
                </label>
                <label>
                  Position
                  <div class="segments" id="posStyle">
                    <button class="segmented-btn" data-val="Top">Top</button>
                    <button class="segmented-btn" data-val="Middle">Mid</button>
                    <button class="segmented-btn on" data-val="Bottom">Bottom</button>
                  </div>
                </label>
                <div class="toggle">
                  <span>Karaoke word highlight</span>
                  <input type="checkbox" id="karaokeToggle">
                </div>
              </div>
            </section>
          </div>
        </div>

        <!-- Sidebar Column -->
        <aside class="side">
          <!-- Project Info Panel -->
          <section class="panel">
            <header>
              <div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7h7l2 2h9v10H3V7Z"/></svg>
                <h2>Project</h2>
              </div>
              <span class="purple" id="projectBadge">LOCAL</span>
            </header>
            <div class="project">
              <label>
                Project name
                <div>
                  <input id="projectName" value="No project loaded">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/></svg>
                </div>
              </label>
              <p><span>Source</span><strong id="sourceUrlLabel">—</strong></p>
              <p><span>Duration</span><strong id="sourceDuration">—</strong></p>
              <p><span>Resolution</span><strong id="sourceResolution">—</strong></p>
              <p><span>File size</span><strong id="sourceSize">—</strong></p>
              <p><span>Codec / format</span><strong id="sourceCodec">—</strong></p>
            </div>
          </section>

          <!-- Shorts Studio Panel -->
          <section class="panel">
            <header>
              <div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>
                <h2>Shorts studio</h2>
              </div>
              <span class="tag" id="studioClipBadge">AUTO</span>
            </header>
            <div class="studio">
              <div class="modes">
                <button class="mode-tab on" data-mode="highlights">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>
                  <span><strong>AI highlights</strong><small>Smart hook detection</small></span>
                </button>
                <button class="mode-tab" data-mode="full">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m8.5 8.5 10 6m-10 1 10-6"/></svg>
                  <span><strong>Entire video</strong><small>Split into segments</small></span>
                </button>
              </div>

              <div class="estimate" id="durationLimitText">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                <span>Clips will be about 30–60 seconds</span>
              </div>

              <div id="highlightSettings">
                <label class="setting">
                  <span>Number of clips</span>
                  <input type="number" id="clipCount" min="1" max="50" value="3">
                </label>
                <label class="setting">
                  <span>Clip length</span>
                  <select id="clipDurationPref">
                    <option value="40" selected>30s – 60s (Standard)</option>
                    <option value="25">Under 30s (Short)</option>
                    <option value="75">60s – 90s (Long)</option>
                  </select>
                </label>
                <label class="setting">
                  <span>Caption language</span>
                  <select id="captionLang">
                    <option value="auto" selected>Auto detect</option>
                    <option value="en">English</option>
                    <option value="hi">Hindi</option>
                  </select>
                </label>
                <small class="hint">Local transcript analysis finds high-retention hooks and punchlines.</small>
              </div>

              <div id="fullSettings" hidden>
                <label class="setting">
                  <span>Split every</span>
                  <select id="segmentLen">
                    <option value="30">30 seconds</option>
                    <option value="60" selected>60 seconds</option>
                    <option value="90">90 seconds</option>
                    <option value="180">3 minutes</option>
                  </select>
                </label>
                <small class="hint" id="fullHint">Split the entire video into equal segments.</small>
              </div>

              <hr>

              <label class="setting">
                <span>Aspect ratio</span>
                <div class="ratios">
                  <button class="ratio-btn" data-ratio="16:9">16:9</button>
                  <button class="ratio-btn on" data-ratio="9:16">9:16</button>
                  <button class="ratio-btn" data-ratio="1:1">1:1</button>
                </div>
              </label>

              <label class="setting">
                <span>Resolution</span>
                <select id="autoResolution">
                  <option value="1080p" selected>1080p · Full HD</option>
                  <option value="720p">720p · Fast</option>
                </select>
              </label>

              <button class="btn primary full generate" id="autoShortsBtn" disabled>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>
                <span>Create highlight clips</span>
              </button>

              <small class="ready" id="studioNote">Upload a video to get started.</small>

              <!-- Batch progress bar -->
              <div id="batchProgress" hidden style="margin-top:10px">
                <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:4px">
                  <span id="batchLabel">Preparing…</span>
                  <span id="batchPct">0%</span>
                </div>
                <progress id="batchBar" max="100" value="0" style="width:100%;height:6px"></progress>
              </div>

              <!-- Generated Clips List -->
              <div class="results" id="clipsBatchHeader" style="display:none">
                <header>
                  <span>Generated clips</span>
                  <button id="btnDownloadAll">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 20h16"/></svg>
                    Download all
                  </button>
                </header>
                <div id="clipsList" style="margin-top:8px"></div>
              </div>
            </div>

            <!-- Manual Export Details -->
            <details>
              <summary>Export selected range manually</summary>
              <div>
                <label class="setting" style="margin-bottom:8px">
                  <span>Captions</span>
                  <select id="captionMode">
                    <option value="Burned in">Burned in</option>
                    <option value="Separate .srt">Separate .srt</option>
                    <option value="Both">Both</option>
                  </select>
                </label>
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:10px">
                  <span>Est. file size</span>
                  <strong id="estSize" style="color:var(--text)">— MB</strong>
                </div>
                <button class="btn full" id="manualExportBtn" disabled>Export selected clip</button>
                <p id="manualNote" style="font-size:10px;color:var(--muted);margin-top:6px"></p>
              </div>
            </details>
          </section>
        </aside>
      </div>
    </div>

    <!-- ── Projects Page (Library) ───────────────────────────── -->
    <section class="projects hidden" id="projectsPage">
      <header>
        <div>
          <span>Library</span>
          <h1>Your projects</h1>
          <p>Pick up where you left off or start with a new source video.</p>
        </div>
        <button class="btn primary" id="newProjectBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg>
          New project
        </button>
      </header>
      <div class="projectgrid" id="projectsGrid"></div>
    </section>
  </main>

  <!-- ── Footer Status Bar ─────────────────────────────────── -->
  <footer>
    <div>
      <i></i>
      <strong id="sbProject">No project loaded</strong>
      <span>Duration: <time id="sbDuration">—</time></span>
      <em id="sbClips">0 clips</em>
    </div>
    <div class="footkeys">
      <kbd>Space</kbd> Play/Pause · <kbd>I</kbd> Set in · <kbd>O</kbd> Set out
    </div>
    <div>
      Engine <strong class="green">Connected v2.0</strong>
    </div>
  </footer>
</div>

<!-- ── Social Accounts & Facebook Integration Modal ────────── -->
<div class="modal-backdrop" id="accountsModal">
  <div class="modal" style="width:min(520px, calc(100vw - 24px))">
    <header class="modal-header">
      <div class="modal-title-wrap">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:20px;height:20px;color:#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
        <h2 class="modal-title">Facebook Integration</h2>
      </div>
      <button class="modal-close-btn" id="accountsModalCloseX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>
    <p class="modal-desc">Connect your Facebook Pages to publish vertical reels and short clips directly from ClipMaster without hardcoded keys.</p>

    <!-- State A: Connected -->
    <div id="accountsConnectedBox" style="display:none">
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-user-info">
            <div class="account-avatar">f</div>
            <div>
              <div style="font-weight:700;font-size:14px" id="fbUserName">User Name</div>
              <div style="font-size:11px;color:var(--green);display:flex;align-items:center;gap:5px">
                <span class="social-indicator connected"></span> Connected via Meta Graph API
              </div>
            </div>
          </div>
          <button class="btn btn-xs" id="btnDisconnectFb" style="color:var(--red);border-color:rgba(255,107,107,0.3)" title="Disconnect Facebook account">Disconnect</button>
        </div>

        <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin:12px 0 6px">
          Available Pages for Publishing (<span id="fbPagesCount">0</span>)
        </div>
        <div class="account-pages-list" id="fbPagesList"></div>
      </div>
    </div>

    <!-- State B: Not Connected -->
    <div id="accountsConnectBox">
      <div class="step-guide-box">
        <strong>How to get your Facebook Access Token (No coding required):</strong>
        <ol>
          <li>Open Meta's <a href="https://developers.facebook.com/tools/explorer/" target="_blank" class="step-guide-link">Graph API Explorer ↗</a></li>
          <li>In <strong>User or Page</strong> dropdown, choose your <strong>Page Access Token</strong> (or User Token with <code>pages_show_list</code> &amp; <code>pages_manage_posts</code>)</li>
          <li>Click <strong>Generate Access Token</strong>, copy it and paste below:</li>
        </ol>
      </div>

      <div style="margin:0 18px 14px">
        <label style="display:block;margin-bottom:6px;font-size:10px;font-weight:600;color:var(--muted)" for="fbTokenInput">Facebook Access Token</label>
        <div style="position:relative">
          <input type="password" id="fbTokenInput" placeholder="EAABw..." style="width:100%;height:36px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:white;padding:0 36px 0 10px;font-family:var(--mono);font-size:11px">
          <button type="button" id="btnToggleTokenVisibility" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--muted);display:grid;place-items:center" title="Show/Hide Token">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <div id="fbTokenError" style="font-size:11px;color:var(--red);margin-top:6px;min-height:16px"></div>
      </div>

      <div style="padding:0 18px">
        <button class="btn primary full" id="btnConnectFb" style="height:38px">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          Connect Facebook Account
        </button>
      </div>
    </div>

    <footer class="modal-footer" style="position:static;height:auto;background:transparent;margin-top:16px">
      <button class="btn" id="accountsModalCloseBtn">Close</button>
    </footer>
  </div>
</div>

<!-- ── Video Publish Modal with AI Generator ────────────────── -->
<div class="modal-backdrop" id="publishModal">
  <div class="modal" style="width:min(580px, calc(100vw - 20px))">
    <header class="modal-header">
      <div class="modal-title-wrap">
        <span class="purple" style="font-size:9px">PUBLISH</span>
        <h2 class="modal-title">Publish to Facebook Page</h2>
      </div>
      <button class="modal-close-btn" id="publishModalCloseX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>

    <div style="padding:16px 18px" id="publishFormContainer">
      <!-- Target Page Selection -->
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <label style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase" for="publishPageSelect">Destination Facebook Page</label>
          <a href="#" id="linkManageAccounts" style="font-size:11px;color:var(--lime);text-decoration:underline">Manage Accounts</a>
        </div>
        <select id="publishPageSelect" style="width:100%;height:34px;border:1px solid var(--line);border-radius:7px;background:var(--s2);color:white;padding:0 8px"></select>
        <div id="publishNoAccountsNotice" style="display:none;margin-top:8px;padding:10px;border-radius:7px;background:var(--s2);border:1px solid var(--line);align-items:center;justify-content:space-between">
          <span style="font-size:11px;color:var(--muted)">No Facebook accounts connected.</span>
          <button class="btn primary btn-xs" id="btnConnectFromPublish">Connect Facebook Now</button>
        </div>
      </div>

      <!-- AI Copy Generator Card -->
      <div class="ai-copy-box">
        <div class="ai-copy-header">
          <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:12px;color:var(--lime)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3-1.5 4.5a5 5 0 0 1-3 3L3 12l4.5 1.5a5 5 0 0 1 3 3L12 21l1.5-4.5a5 5 0 0 1 3-3L21 12l-4.5-1.5a5 5 0 0 1-3-3L12 3Z"/></svg>
            AI Copy &amp; Viral Hashtags
          </div>
          <button class="btn primary" id="btnGenAiCopy" type="button" style="height:28px;font-size:10px;padding:0 8px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            Auto-Generate Copy
          </button>
        </div>

        <div style="margin-bottom:10px">
          <label style="display:block;margin-bottom:4px;font-size:10px;color:var(--muted);font-weight:600" for="publishTitleInput">Post / Reel Title</label>
          <input type="text" id="publishTitleInput" style="width:100%;height:34px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:white;padding:0 8px;font-size:11px" placeholder="Catchy hook title with emojis…">
        </div>

        <div style="margin-bottom:10px">
          <label style="display:block;margin-bottom:4px;font-size:10px;color:var(--muted);font-weight:600" for="publishCaptionInput">Description / Caption</label>
          <textarea id="publishCaptionInput" rows="3" style="width:100%;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:white;padding:8px;font-size:11px;resize:vertical" placeholder="Engaging caption that keeps viewers watching…"></textarea>
        </div>

        <div>
          <label style="display:block;margin-bottom:4px;font-size:10px;color:var(--muted);font-weight:600" for="publishTagsInput">Viral Hashtags</label>
          <input type="text" id="publishTagsInput" style="width:100%;height:34px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:white;padding:0 8px;font-family:var(--mono);font-size:11px" placeholder="#Reels #Viral #Trending…">
          <div class="tag-pills-wrap" id="tagPillsWrap">
            <span class="tag-pill" data-tag="#Reels">#Reels</span>
            <span class="tag-pill" data-tag="#FacebookReels">#FacebookReels</span>
            <span class="tag-pill" data-tag="#Viral">#Viral</span>
            <span class="tag-pill" data-tag="#Trending">#Trending</span>
            <span class="tag-pill" data-tag="#Shorts">#Shorts</span>
            <span class="tag-pill" data-tag="#ExplorePage">#ExplorePage</span>
            <span class="tag-pill" data-tag="#DailyClips">#DailyClips</span>
            <span class="tag-pill" data-tag="#MustWatch">#MustWatch</span>
          </div>
        </div>
      </div>

      <!-- Live Post Preview -->
      <div style="background:var(--s2);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;font-weight:700">Post Preview</div>
        <div style="font-size:12px;color:var(--text);font-weight:700" id="previewPostTitle">Video Title</div>
        <div style="font-size:11px;color:var(--muted2);white-space:pre-line;margin-top:4px" id="previewPostDesc">Video description and hashtags will appear here…</div>
      </div>

      <div id="publishError" style="font-size:11px;color:var(--red);margin-bottom:10px;min-height:16px"></div>

      <!-- Action Buttons -->
      <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end">
        <button class="btn" id="publishModalCancelBtn">Cancel</button>
        <button class="btn primary" id="btnSubmitPublish" style="padding:0 16px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Publish Video to Facebook
        </button>
      </div>
    </div>

    <!-- Publishing Progress State -->
    <div id="publishLoadingState" style="display:none;padding:36px 16px;text-align:center">
      <div class="clip-thumb-spinner" style="display:block;margin:0 auto 16px;width:32px;height:32px;border-width:3px"></div>
      <h3 style="font-size:15px;font-weight:700;margin-bottom:6px">Uploading Video to Facebook…</h3>
      <p style="font-size:11px;color:var(--muted)">Transferring clip to Meta Graph API. Please wait a moment.</p>
    </div>

    <!-- Success State -->
    <div id="publishSuccessState" style="display:none;padding:32px 16px;text-align:center">
      <div style="width:48px;height:48px;border-radius:50%;background:rgba(114, 227, 157, 0.15);color:var(--green);display:grid;place-items:center;margin:0 auto 14px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:24px;height:24px"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h3 style="font-size:16px;font-weight:800;margin-bottom:6px">Video Published to Facebook! 🎉</h3>
      <p style="font-size:12px;color:var(--muted);margin-bottom:18px" id="publishSuccessMsg">Your video has been uploaded to your Facebook Page.</p>
      <div style="display:flex;gap:10px;justify-content:center">
        <a href="#" target="_blank" class="btn primary" id="btnViewOnFb">
          View on Facebook ↗
        </a>
        <button class="btn" id="btnPublishDone">Done</button>
      </div>
    </div>
  </div>
</div>

<!-- ── Clip Preview Modal ──────────────────────────────────── -->
<div class="modal-backdrop" id="clipPreviewModal">
  <div class="modal" style="width:min(540px, calc(100vw - 20px))">
    <header class="modal-header">
      <div class="modal-title-wrap">
        <span class="purple" style="font-size:9px">PREVIEW</span>
        <h2 class="modal-title" id="previewModalTitle" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px">Clip Preview</h2>
      </div>
      <button class="modal-close-btn" id="previewModalClose" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>
    <div style="padding:16px">
      <div style="border-radius:8px;background:#000;overflow:hidden;display:grid;place-items:center;max-height:460px">
        <video id="previewVideoPlayer" controls playsinline style="max-height:440px;width:auto"></video>
      </div>
    </div>
    <footer class="modal-footer" style="position:static;height:auto;background:transparent">
      <button class="btn" id="previewCopyBtn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-5.5-5.8"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 5.5 5.8"/></svg>
        Copy link
      </button>
      <a class="btn primary" id="previewDlBtn" download>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 20h16"/></svg>
        Download
      </a>
    </footer>
  </div>
</div>

<!-- ── Keyboard Shortcuts Modal ────────────────────────────── -->
<div class="modal-backdrop" id="shortcutsModal">
  <div class="modal" style="width:min(440px, calc(100vw - 24px))">
    <header class="modal-header">
      <div class="modal-title-wrap">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M11 13h.01M15 13h.01M9 16h6"/></svg>
        <h2 class="modal-title">Keyboard Shortcuts</h2>
      </div>
      <button class="modal-close-btn" id="shortcutsModalClose" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>
    <div class="shortcuts-grid">
      <div class="shortcut-row">
        <span>Play / Pause video</span>
        <kbd>Space / K</kbd>
      </div>
      <div class="shortcut-row">
        <span>Seek backward / forward 5s</span>
        <kbd>J / L</kbd>
      </div>
      <div class="shortcut-row">
        <span>Set clip IN point to current time</span>
        <kbd>I</kbd>
      </div>
      <div class="shortcut-row">
        <span>Set clip OUT point to current time</span>
        <kbd>O</kbd>
      </div>
      <div class="shortcut-row">
        <span>Close active dialog or menu</span>
        <kbd>Esc</kbd>
      </div>
    </div>
    <footer class="modal-footer" style="position:static;height:auto;background:transparent">
      <button class="btn primary" id="shortcutsGotItBtn">Got it</button>
    </footer>
  </div>
</div>

<!-- ── YouTube Import Modal ────────────────────────────────── -->
<div class="modal-backdrop" id="ytModal">
  <div class="modal" style="width:min(480px, calc(100vw - 24px))">
    <header class="modal-header">
      <div class="modal-title-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="color:var(--red)"><path d="m9 7 8 5-8 5V7Z"/></svg>
        <h2 class="modal-title">Import from YouTube</h2>
      </div>
      <button class="modal-close-btn" id="ytModalCloseX" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>
    <p class="modal-desc">Paste a YouTube link. ClipMaster downloads the video and auto-generates captions, then finds highlight clips automatically.</p>
    <div style="padding:14px 18px">
      <input class="project-input" id="ytModalInput" placeholder="https://youtube.com/watch?v=…" type="url" style="width:100%;height:36px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:white;padding:0 10px;font-size:11px">
      <div id="ytModalError" style="font-size:11px;color:var(--red);margin-top:6px;min-height:16px"></div>
    </div>
    <footer class="modal-footer" style="position:static;height:auto;background:transparent">
      <button class="btn" id="ytModalClose">Cancel</button>
      <button class="btn primary" id="ytModalBtn">Import</button>
    </footer>
  </div>
</div>

<!-- ── Mobile / Network Connect Modal ────────────────────── -->
<div class="modal-backdrop" id="mobileConnectModal">
  <div class="modal" style="width:min(440px, calc(100vw - 24px)); text-align:center">
    <header class="modal-header" style="justify-content:center;position:relative">
      <h2 class="modal-title">📱 Open on Mobile Phone</h2>
      <button class="modal-close-btn" id="mobileModalCloseX" aria-label="Close" style="position:absolute;right:14px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </header>
    <p class="modal-desc" style="padding-top:12px;margin-bottom:6px">Apne phone ya tablet ke camera se scan karein ya browser me yeh URL kholein:</p>
    <div class="modal-qr-box">
      <div class="qr-image-wrapper">
        <img id="mobileQrImg" src="" alt="Mobile QR Code">
      </div>
      <div class="mobile-url-pill" id="mobileConnectUrlText">Loading network address…</div>
      <button class="btn primary full" id="btnCopyMobileUrl">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-5.5-5.8"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 5.5 5.8"/></svg>
        Copy Mobile URL
      </button>
    </div>
    <div style="font-size:11px;color:var(--muted);padding:0 18px 14px;text-align:left">
      <strong>Note:</strong> Phone aur PC dono ka <strong>same Wi-Fi network</strong> se connect hona zaroori hai.
    </div>
    <footer class="modal-footer" style="position:static;height:auto;background:transparent;justify-content:center">
      <button class="btn" id="mobileModalCloseBtn">Done</button>
    </footer>
  </div>
</div>

<!-- ── Mobile Drawer ───────────────────────────────────────── -->
<div class="mobile-drawer-backdrop" id="mobileDrawerBackdrop"></div>
<div class="mobile-drawer" id="mobileDrawer">
  <div class="mobile-drawer-header">
    <div class="brand">
      <b><i></i><i></i><i></i></b>
      <strong>ClipMaster</strong>
    </div>
    <button class="modal-close-btn" id="mobileDrawerClose">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <nav class="mobile-drawer-nav">
    <a href="#" class="mobile-nav-link active" id="mNavWorkspace">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16m8-16v16M3 9h5m8 0h5M3 15h5m8 0h5"/></svg>
      Workspace
    </a>
    <a href="#" class="mobile-nav-link" id="mNavProjects">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7h7l2 2h9v10H3V7Z"/></svg>
      Projects
    </a>
    <a href="#" class="mobile-nav-link" id="mNavAccounts">
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;color:#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      Facebook Publishing
      <span class="tag" id="mNavAccountsBadge" style="margin-left:auto">Connect</span>
    </a>
    <a href="#" class="mobile-nav-link" id="mNavMobileConnect">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg>
      Open on Phone / QR Code
    </a>
    <a href="#" class="mobile-nav-link" id="mNavShortcuts">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h.01M11 13h.01M15 13h.01M9 16h6"/></svg>
      Keyboard Shortcuts
    </a>
  </nav>
  <div class="mobile-drawer-footer">
    <button class="btn primary full" id="mUploadBtn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M5 14v5h14v-5"/></svg>
      Upload Video
    </button>
    <button class="btn full" id="mResetBtn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7"/><path d="M10 11v6m4-6v6"/></svg>
      Reset Workspace
    </button>
  </div>
</div>

<!-- ── Toast Notification ──────────────────────────────────── -->
<div class="toast" id="toast" role="alert" aria-live="polite"></div>

<!-- ── Application Logic ───────────────────────────────────── -->
<script>
${scriptContent}
</script>
</body>
</html>`;

fs.writeFileSync(path.join(ROOT, 'index.html'), newHtml, 'utf8');
console.log('✓ Successfully generated index.html with Figma UI!');
