#!/usr/bin/env node
/**
 * take-screenshots.js
 * Takes full-page screenshots (1280 px wide) for every URL in ./sitemap.txt
 * and uploads each one directly to Cloudflare R2.
 *
 * R2 path: screenshots/<YYYY-MM-DD_HH-MM-SS>/<filename>.png
 *
 * Links to files (PDF, Office docs, archives, images…) are NOT screenshotted.
 * They are downloaded and fingerprinted (SHA-256) instead; the fingerprint is
 * stored as a text file next to the screenshots:
 *   screenshots/<YYYY-MM-DD_HH-MM-SS>/<filename>.txt
 *
 * Prerequisites:
 *   npm install
 *   Google Chrome installed at the default macOS path (or set CHROME_PATH)
 *
 * Usage:
 *   node take-screenshots.js           # all URLs from sitemap.txt
 *   node take-screenshots.js --dry-run # print URLs only, don't screenshot
 */

'use strict';

const puppeteer = require('puppeteer-core');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const r2        = require('./r2');
const files     = require('./files');

// ── Config ────────────────────────────────────────────────────────────────────
const VIEWPORT_WIDTH  = 1280;
const VIEWPORT_HEIGHT = 900;
const TIMEOUT_MS      = 30_000;
const CONCURRENCY     = 2;
const CHROME_PATH     =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SITEMAP_FILE = path.join(__dirname, 'sitemap.txt');

// Basic auth — reads from .env; null if not configured
const BASIC_AUTH = (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS)
  ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
  : null;

const AUTH_HEADER = BASIC_AUTH
  ? { Authorization: 'Basic ' + Buffer.from(`${BASIC_AUTH.username}:${BASIC_AUTH.password}`).toString('base64') }
  : {};

// ── CSS: kill banners, freeze animations ─────────────────────────────────────
const NORMALISE_CSS = `
  [class*="cookie" i], [class*="consent" i], [class*="gdpr" i],
  [id*="cookie" i],   [id*="consent" i],    [id*="gdpr" i],
  .cc-window, .cc-banner, .pum-overlay, .pum-container,
  #onetrust-banner-sdk, .optanon-alert-box-wrapper,
  .cookie-notice, .cookie-popup, .cookie-bar { display: none !important; }

  *, *::before, *::after {
    animation-play-state:  paused   !important;
    animation-duration:    0.001ms  !important;
    animation-delay:       0ms      !important;
    transition-duration:   0.001ms  !important;
    transition-delay:      0ms      !important;
  }
  video { display: none !important; }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-') + '_' + [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('-');
}

function urlToFilename(url) {
  const u = new URL(url);
  const p = (u.pathname + (u.search || '')).replace(/^\//, '') || 'index';
  return p.replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').substring(0, 200) + '.png';
}

async function triggerLazyLoad(page) {
  await page.evaluate(async () => {
    // Scroll down to trigger lazy-load, then return to top
    await new Promise(resolve => {
      const step = 600, delay = 120;
      let y = 0;
      const tick = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight) {
          clearInterval(tick);
          window.scrollTo(0, 0);
          resolve();
        }
      }, delay);
    });

    // Wait for all visible images to fully decode
    const imgs = Array.from(document.querySelectorAll('img'));
    await Promise.allSettled(
      imgs.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise(res => {
          img.addEventListener('load',  res, { once: true });
          img.addEventListener('error', res, { once: true });
          // Safety timeout per image
          setTimeout(res, 5000);
        });
      })
    );
  });
}

// ── Screenshot one URL, upload to R2 ─────────────────────────────────────────
async function screenshotAndUpload(page, url, r2Key) {
  const tmpFile = path.join(os.tmpdir(), `tc-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT_MS });
    await page.addStyleTag({ content: NORMALISE_CSS });
    await triggerLazyLoad(page);
    await page.mouse.move(0, 0);
    // Extra settle wait for fonts, background images, and CSS transitions
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: tmpFile, fullPage: true });

    const buffer = fs.readFileSync(tmpFile);
    await r2.upload(r2Key, buffer, 'image/png');

    console.log(`    ✓ ${r2Key}`);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

// ── Fingerprint one file link, upload the .txt to R2 ─────────────────────────
async function fingerprintAndUpload(url, r2Key) {
  const fp = await files.fingerprintUrl(url, AUTH_HEADER);
  await r2.upload(r2Key, Buffer.from(files.formatFingerprint(fp), 'utf8'), 'text/plain; charset=utf-8');
  const warn = fp.sha256.startsWith('ERROR') ? `  ⚠ ${fp.sha256}` : '';
  console.log(`    ✓ ${r2Key}  (sha256 ${fp.sha256.slice(0, 12)}…, ${fp.size} bytes)${warn}`);
}

// ── Worker pool ───────────────────────────────────────────────────────────────
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (BASIC_AUTH) await page.authenticate(BASIC_AUTH);
  return page;
}

async function runWithConcurrency(browser, items, ts, concurrency) {
  const queue = [...items];

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    let page = await newPage(browser);

    while (queue.length > 0) {
      const { url, filename } = queue.shift();

      // File links (PDF etc.) → fingerprint instead of screenshot
      if (files.isFileUrl(url)) {
        const key = `screenshots/${ts}/${files.fingerprintFilename(filename)}`;
        try {
          await fingerprintAndUpload(url, key);
        } catch (e) {
          console.error(`    ✗ ${url} — ${e.message}`);
        }
        continue;
      }

      const key = `screenshots/${ts}/${filename}`;

      try {
        await screenshotAndUpload(page, url, key);
      } catch (e) {
        // Page/session crashed — open a fresh one and continue
        console.error(`    ✗ ${url} — ${e.message}`);
        try { await page.close(); } catch {}
        page = await newPage(browser);
      }
    }

    try { await page.close(); } catch {}
  });

  await Promise.all(workers);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(SITEMAP_FILE)) {
    console.error('Error: sitemap.txt not found. Run fetch-sitemap.js first.');
    process.exit(1);
  }

  const urls = fs.readFileSync(SITEMAP_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error('Error: sitemap.txt is empty.');
    process.exit(1);
  }

  const ts = timestamp();
  console.log(`\n📸 Screenshot run [${ts}]`);
  const fileCount = urls.filter(files.isFileUrl).length;
  console.log(`   URLs: ${urls.length} (${urls.length - fileCount} pages, ${fileCount} files fingerprinted)  |  Viewport: ${VIEWPORT_WIDTH}px  |  Concurrency: ${CONCURRENCY}`);
  console.log(`   R2 bucket: ${r2.BUCKET_NAME}`);
  console.log(`   Basic auth: ${BASIC_AUTH ? `✓ (${BASIC_AUTH.username})` : 'none'}\n`);

  if (dryRun) {
    console.log('-- DRY RUN: URLs that would be screenshotted --');
    urls.forEach(u => console.log(` • ${u}${files.isFileUrl(u) ? '  [file → fingerprint]' : ''}`));
    console.log(`\nTotal: ${urls.length} URLs`);
    return;
  }

  if (!fs.existsSync(CHROME_PATH)) {
    console.error(`Error: Chrome not found at "${CHROME_PATH}".`);
    console.error('Set CHROME_PATH env var to the correct path.');
    process.exit(1);
  }

  // Ensure R2 bucket exists
  process.stdout.write('Checking R2 bucket… ');
  await r2.ensureBucket();
  console.log('ok\n');

  const items = urls.map(url => ({ url, filename: urlToFilename(url) }));

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    ],
  });

  try {
    await runWithConcurrency(browser, items, ts, CONCURRENCY);
  } finally {
    await browser.close();
  }

  console.log(`\n✅ Done. ${urls.length - fileCount} screenshots + ${fileCount} fingerprints at: screenshots/${ts}/`);
  console.log(`   Run "node list-screenshots.js" to see all available timestamps.`);
})();
