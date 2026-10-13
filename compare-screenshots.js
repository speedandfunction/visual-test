#!/usr/bin/env node
/**
 * compare-screenshots.js
 * Downloads two screenshot sets from R2, pixel-diffs them, uploads diff images
 * back to R2, and writes a self-contained HTML report to ./reports/.
 *
 * Usage:
 *   node compare-screenshots.js <ts-before> <ts-after>
 *
 * Example:
 *   node compare-screenshots.js 2026-08-07_09-00-00 2026-08-07_16-00-00
 *
 * Available timestamps:
 *   node list-screenshots.js
 *
 * Output:
 *   reports/<ts-before>_vs_<ts-after>/
 *     index.html          ← open in browser (self-contained, no server needed)
 *     before/             ← changed pages' before images (local cache)
 *     after/              ← changed pages' after images (local cache)
 *     diff/               ← pixel-diff images
 *
 *   R2: diffs/<ts-before>_vs_<ts-after>/<filename>.png
 */

'use strict';

const { PNG }    = require('pngjs');
const pixelmatch = require('pixelmatch');
const fs         = require('fs');
const path       = require('path');
const fetch      = require('node-fetch');
const r2         = require('./r2');

const SITE_NAME = process.env.SITE_NAME || 'site';

// ── Config ────────────────────────────────────────────────────────────────────
const DIFF_THRESHOLD   = 0.1;   // per-pixel colour tolerance (0–1)
const CHANGE_THRESHOLD = 0.05;  // min % of pixels changed to flag a page
const HIGHLIGHT_COLOR  = [255, 0, 128];

const REPORTS_DIR = path.join(__dirname, 'reports');
const SITEMAP     = path.join(__dirname, 'sitemap.txt');

// ── Args ──────────────────────────────────────────────────────────────────────
const [,, tsBefore, tsAfter] = process.argv;
if (!tsBefore || !tsAfter) {
  console.error('Usage: node compare-screenshots.js <ts-before> <ts-after>');
  console.error('Run "node list-screenshots.js" to see available timestamps.');
  process.exit(1);
}

// ── URL map: filename → original URL ─────────────────────────────────────────
function buildUrlMap() {
  if (!fs.existsSync(SITEMAP)) return {};
  const map = {};
  for (const url of fs.readFileSync(SITEMAP, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    try {
      const u = new URL(url);
      const p = (u.pathname + (u.search || '')).replace(/^\//, '') || 'index';
      const name = p.replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').substring(0, 200);
      map[name] = url;
    } catch { /* skip */ }
  }
  return map;
}

// ── Redirect detection ───────────────────────────────────────────────────────
const REDIRECT_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS   = 10;

const AUTH_HEADER = (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS)
  ? { Authorization: 'Basic ' + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString('base64') }
  : {};

// Same page = same host + path + query, ignoring protocol, "www." and trailing slash
function samePage(a, b) {
  const norm = u => {
    const x = new URL(u);
    const host = x.host.replace(/^www\./i, '').toLowerCase();
    const p = x.pathname.replace(/\/+$/, '') || '/';
    return `${host}${p}${x.search}`;
  };
  try { return norm(a) === norm(b); } catch { return false; }
}

/**
 * Follows redirects manually. Returns the final URL if the page ends up on a
 * different page than requested, otherwise null. Network errors → null
 * (page is compared as usual).
 */
async function detectRedirect(url) {
  let current = url;
  try {
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        timeout: REDIRECT_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (visual-test redirect check)', ...AUTH_HEADER },
      });
      if (res.body && typeof res.body.destroy === 'function') res.body.destroy();

      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) break;
      current = new URL(location, current).toString();
    }
  } catch {
    return null;
  }
  return samePage(url, current) ? null : current;
}

// ── Image helpers ─────────────────────────────────────────────────────────────
function readPng(buffer) { return PNG.sync.read(buffer); }

function padPng(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

function diffImages(bufA, bufB) {
  const pngA = readPng(bufA);
  const pngB = readPng(bufB);
  const width  = Math.max(pngA.width,  pngB.width);
  const height = Math.max(pngA.height, pngB.height);
  const a = padPng(pngA, width, height);
  const b = padPng(pngB, width, height);
  const diffPng    = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diffPng.data, width, height, {
    threshold: DIFF_THRESHOLD,
    includeAA: false,
    diffColor: HIGHLIGHT_COLOR,
  });
  return { diffPng, diffPixels, totalPixels: width * height, pct: (diffPixels / (width * height)) * 100 };
}

// ── HTML report ───────────────────────────────────────────────────────────────
const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f1117; color: #e2e8f0; line-height: 1.5; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .topbar { background: #1e2433; border-bottom: 1px solid #2d3748; padding: 18px 32px; }
  .topbar h1 { font-size: 1.25rem; font-weight: 700; color: #f0f4ff; }
  .topbar h1 span { color: #818cf8; }
  .topbar .breadcrumb { font-size: .8rem; color: #64748b; margin-bottom: 6px; }
  .meta-row { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 10px; font-size: .85rem; color: #94a3b8; }
  .meta-row strong { color: #cbd5e1; }
  .chip { padding: 6px 14px; border-radius: 99px; font-size: .8rem; font-weight: 600; }
  .chip-total   { background: #1e2433; color: #94a3b8; border: 1px solid #2d3748; }
  .chip-changed { background: #3b1f2b; color: #f87171; border: 1px solid #7f1d1d; }
  .chip-ok      { background: #1a2e22; color: #4ade80; border: 1px solid #14532d; }
  .chip-new     { background: #1c2c42; color: #60a5fa; border: 1px solid #1e40af; }
  .chip-missing { background: #2a1f10; color: #fb923c; border: 1px solid #7c2d12; }
  .chip-redirect { background: #261f3a; color: #a78bfa; border: 1px solid #5b21b6; }
  .summary { display: flex; gap: 12px; flex-wrap: wrap; padding: 20px 32px; }
  @media (max-width: 900px) { .topbar, main, .summary { padding-left: 16px; padding-right: 16px; } }
`;

function buildHtml({ tsBefore, tsAfter, results, totalCompared }) {
  const changed  = results.filter(r => r.changed);
  const newPages = results.filter(r => r.status === 'new');
  const missing  = results.filter(r => r.status === 'missing');
  const redirects = results.filter(r => r.status === 'redirect');

  const pageRows = changed.map(r => {
    const label = r.url
      ? `<a href="${r.url}" target="_blank" rel="noopener">${r.url}</a>`
      : `<span style="color:#64748b;font-style:italic">${r.name}</span>`;
    const bar      = Math.min(100, r.pct * 10);
    const barClass = r.pct > 5 ? 'bar-high' : r.pct > 1 ? 'bar-mid' : 'bar-low';
    // paths are relative to the report's own folder
    return `
<article class="diff-block">
  <header class="diff-header">
    <div class="diff-title">${label}</div>
    <div class="diff-meta">
      <span class="badge ${barClass}">${r.pct.toFixed(2)}% changed</span>
      <span class="px-count">${r.diffPixels.toLocaleString()} px / ${r.totalPixels.toLocaleString()} total</span>
    </div>
    <div class="diff-bar-track"><div class="diff-bar ${barClass}" style="width:${bar}%"></div></div>
  </header>
  <div class="img-row">
    <figure>
      <figcaption>Before <small>(${tsBefore})</small></figcaption>
      <img src="before/${r.file}" loading="lazy" alt="before">
    </figure>
    <figure>
      <figcaption>Diff <small>(changed pixels highlighted)</small></figcaption>
      <img src="diff/${r.file}" loading="lazy" alt="diff">
    </figure>
    <figure>
      <figcaption>After <small>(${tsAfter})</small></figcaption>
      <img src="after/${r.file}" loading="lazy" alt="after">
    </figure>
  </div>
</article>`;
  }).join('\n');

  const listItems = (items, cls, note) => items.map(r => {
    const lbl = r.url ? `<a href="${r.url}" target="_blank" rel="noopener">${r.url}</a>` : r.name;
    return `<li class="${cls}">${lbl} <em>${note}</em></li>`;
  }).join('\n');

  const redirectItems = redirects.map(r =>
    `<li class="status-redirect"><strong>${r.file}</strong> … ↪️ redirect detected → <a href="${r.redirectTo}" target="_blank" rel="noopener">${r.redirectTo}</a></li>`
  ).join('\n');

  const extras = (newPages.length || missing.length || redirects.length) ? `
<section class="extras">
  ${redirects.length ? `<h2>Redirected pages — not compared (${redirects.length})</h2><ul>${redirectItems}</ul>` : ''}
  ${newPages.length ? `<h2>New pages (${newPages.length})</h2><ul>${listItems(newPages, 'status-new', '(not in before set)')}</ul>` : ''}
  ${missing.length  ? `<h2>Missing pages (${missing.length})</h2><ul>${listItems(missing, 'status-missing', '(missing in after set)')}</ul>` : ''}
</section>` : '';

  const noChanges = changed.length === 0
    ? `<div class="no-changes">✅ No visual differences detected above the ${CHANGE_THRESHOLD}% threshold.</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual Diff — ${SITE_NAME} — ${tsBefore} vs ${tsAfter}</title>
<style>
${BASE_CSS}
  .no-changes { margin: 24px 32px; padding: 20px 24px; background: #1a2e22;
                border: 1px solid #14532d; border-radius: 8px; color: #4ade80; font-size: 1rem; font-weight: 500; }
  main { padding: 0 32px 48px; }
  .diff-block { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px; margin-bottom: 28px; overflow: hidden; }
  .diff-header { padding: 14px 18px; border-bottom: 1px solid #2d3748; }
  .diff-title  { font-size: .95rem; font-weight: 600; word-break: break-all; margin-bottom: 8px; }
  .diff-meta   { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: .8rem; }
  .badge { padding: 3px 10px; border-radius: 99px; font-weight: 700; font-size: .75rem; }
  .bar-high { background: #7f1d1d; color: #fca5a5; }
  .bar-mid  { background: #78350f; color: #fcd34d; }
  .bar-low  { background: #1e3a5f; color: #93c5fd; }
  .px-count { color: #64748b; }
  .diff-bar-track { height: 4px; background: #2d3748; border-radius: 2px; margin-top: 10px; }
  .diff-bar { height: 100%; border-radius: 2px; }
  .diff-bar.bar-high { background: #ef4444; }
  .diff-bar.bar-mid  { background: #f59e0b; }
  .diff-bar.bar-low  { background: #3b82f6; }
  .img-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #2d3748; }
  figure { background: #0f1117; padding: 10px; }
  figcaption { font-size: .75rem; color: #64748b; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  figcaption small { font-size: .7rem; color: #475569; text-transform: none; letter-spacing: 0; }
  figure img { width: 100%; height: auto; display: block; border-radius: 4px; border: 1px solid #2d3748; }
  .extras { padding: 0 32px 32px; }
  .extras h2 { font-size: .9rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .07em; margin: 24px 0 10px; }
  .extras ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .extras li { font-size: .85rem; padding: 7px 12px; border-radius: 6px; }
  .status-new     { background: #1c2c42; border-left: 3px solid #3b82f6; }
  .status-missing { background: #2a1f10; border-left: 3px solid #f97316; }
  .status-redirect { background: #261f3a; border-left: 3px solid #a78bfa; word-break: break-all; }
  @media (max-width: 900px) { .img-row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="topbar">
  <div class="breadcrumb">${SITE_NAME}</div>
  <h1>Visual Diff — <span>${SITE_NAME}</span></h1>
  <div class="meta-row">
    <div><strong>Before:</strong> ${tsBefore}</div>
    <div><strong>After:</strong> ${tsAfter}</div>
    <div><strong>Threshold:</strong> &gt;${CHANGE_THRESHOLD}% pixel change</div>
    <div><strong>Generated:</strong> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </div>
</div>
<div class="summary">
  <div class="chip chip-total">📄 ${totalCompared} compared</div>
  <div class="chip chip-changed">🔴 ${changed.length} changed</div>
  <div class="chip chip-ok">✅ ${totalCompared - changed.length} unchanged</div>
  ${newPages.length ? `<div class="chip chip-new">🆕 ${newPages.length} new</div>` : ''}
  ${missing.length  ? `<div class="chip chip-missing">⚠️ ${missing.length} missing</div>` : ''}
  ${redirects.length ? `<div class="chip chip-redirect">↪️ ${redirects.length} redirected</div>` : ''}
</div>
${noChanges}
<main>${pageRows}</main>
${extras}
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const label   = `${tsBefore}_vs_${tsAfter}`;
  const reportDir = path.join(REPORTS_DIR, label);
  const beforeDir = path.join(reportDir, 'before');
  const afterDir  = path.join(reportDir, 'after');
  const diffDir   = path.join(reportDir, 'diff');

  fs.mkdirSync(beforeDir, { recursive: true });
  fs.mkdirSync(afterDir,  { recursive: true });
  fs.mkdirSync(diffDir,   { recursive: true });

  console.log(`\nComparing: ${tsBefore} → ${tsAfter}`);
  console.log(`Bucket: ${r2.BUCKET_NAME}\n`);

  // List both sets in R2
  process.stdout.write('Listing R2 objects… ');
  const beforePrefix = `screenshots/${tsBefore}/`;
  const afterPrefix  = `screenshots/${tsAfter}/`;

  const beforeKeys = await r2.listKeys(beforePrefix);
  const afterKeys  = await r2.listKeys(afterPrefix);
  console.log(`before: ${beforeKeys.length} files, after: ${afterKeys.length} files\n`);

  if (beforeKeys.length === 0) { console.error(`No screenshots found for ${tsBefore}`); process.exit(1); }
  if (afterKeys.length === 0)  { console.error(`No screenshots found for ${tsAfter}`);  process.exit(1); }

  // Build file sets
  const beforeFiles = new Map(beforeKeys.map(k => [path.basename(k), k]));
  const afterFiles  = new Map(afterKeys.map(k => [path.basename(k), k]));
  const allFiles    = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);

  const urlMap  = buildUrlMap();
  const results = [];
  let   idx     = 0;

  for (const file of allFiles) {
    idx++;
    const name     = file.replace(/\.png$/, '');
    const url      = urlMap[name] || null;
    const inBefore = beforeFiles.has(file);
    const inAfter  = afterFiles.has(file);

    process.stdout.write(`  [${idx}/${allFiles.size}] ${file} … `);

    if (!inBefore) {
      console.log('NEW');
      results.push({ name, file, url, status: 'new', changed: false });
      continue;
    }
    if (!inAfter) {
      console.log('MISSING');
      results.push({ name, file, url, status: 'missing', changed: false });
      continue;
    }

    // Skip pages that redirect to another URL
    if (url) {
      const redirectTo = await detectRedirect(url);
      if (redirectTo) {
        console.log(`↪  redirect detected → ${redirectTo}`);
        results.push({ name, file, url, status: 'redirect', redirectTo, changed: false });
        continue;
      }
    }

    // Download both
    const [bufBefore, bufAfter] = await Promise.all([
      r2.download(beforeFiles.get(file)),
      r2.download(afterFiles.get(file)),
    ]);

    const { diffPng, diffPixels, totalPixels, pct } = diffImages(bufBefore, bufAfter);
    const changed = pct >= CHANGE_THRESHOLD;

    process.stdout.write(changed ? `⚠  ${pct.toFixed(2)}%\n` : `✓  ${pct.toFixed(2)}%\n`);

    if (changed) {
      // Save before, after, diff locally (only changed pages — saves disk space)
      fs.writeFileSync(path.join(beforeDir, file), bufBefore);
      fs.writeFileSync(path.join(afterDir,  file), bufAfter);
      const diffBuffer = PNG.sync.write(diffPng);
      fs.writeFileSync(path.join(diffDir, file), diffBuffer);

      // Upload diff to R2
      const diffKey = `diffs/${label}/${file}`;
      await r2.upload(diffKey, diffBuffer, 'image/png');

      results.push({ name, file, url, status: 'changed', changed: true, pct, diffPixels, totalPixels });
    } else {
      results.push({ name, file, url, status: 'ok', changed: false, pct });
    }
  }

  // Sort by diff % descending
  results.sort((a, b) => (b.pct || 0) - (a.pct || 0));

  const redirectCount = results.filter(r => r.status === 'redirect').length;
  const compared      = [...beforeFiles.keys()].filter(f => afterFiles.has(f)).length - redirectCount;
  const changedCount = results.filter(r => r.changed).length;

  // Write HTML report
  const html       = buildHtml({ tsBefore, tsAfter, results, totalCompared: compared });
  const reportFile = path.join(reportDir, 'index.html');
  fs.writeFileSync(reportFile, html, 'utf8');

  // Upload full report to R2 (so it can be served publicly from the bucket)
  process.stdout.write('\nUploading report to R2… ');
  const reportPrefix = `reports/${label}`;

  // Upload HTML
  await r2.upload(`${reportPrefix}/index.html`, fs.readFileSync(reportFile), 'text/html');

  // Upload before/after/diff images for changed pages
  for (const r of results.filter(x => x.changed)) {
    await r2.upload(`${reportPrefix}/before/${r.file}`, fs.readFileSync(path.join(beforeDir, r.file)), 'image/png');
    await r2.upload(`${reportPrefix}/after/${r.file}`,  fs.readFileSync(path.join(afterDir,  r.file)), 'image/png');
    await r2.upload(`${reportPrefix}/diff/${r.file}`,   fs.readFileSync(path.join(diffDir,   r.file)), 'image/png');
  }
  console.log('done');

  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  const publicUrl  = publicBase
    ? `${publicBase}/${reportPrefix}/index.html`
    : null;

  console.log(`\n✅ Done.`);
  console.log(`   ${changedCount} pages changed / ${compared} compared`);
  if (redirectCount) console.log(`   ${redirectCount} pages skipped (redirect detected)`);
  console.log(`   Local report: ${reportFile}`);
  if (publicUrl) {
    console.log(`   Public URL:   ${publicUrl}`);
  } else {
    console.log(`   Set R2_PUBLIC_URL in .env to get a shareable link`);
  }
})();
