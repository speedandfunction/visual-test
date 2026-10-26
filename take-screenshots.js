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
 * Resume / checkpoint:
 *   Progress is saved to ./.screenshot-progress.json after every finished URL
 *   (the R2 folder timestamp + the list of URLs already done). If the run is
 *   stopped (Ctrl+C, crash, closed laptop), running the script again continues
 *   in the SAME R2 folder and skips the URLs that are already done.
 *   The checkpoint is ignored (a new run starts) if sitemap.txt or the R2
 *   bucket changed since it was written. It is deleted when the run completes.
 *
 * Usage:
 *   node take-screenshots.js           # all URLs from sitemap.txt (resumes if a checkpoint exists)
 *   node take-screenshots.js --fresh   # ignore the checkpoint, start a new run
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

const SITEMAP_FILE  = path.join(__dirname, 'sitemap.txt');
const PROGRESS_FILE = path.join(__dirname, '.screenshot-progress.json');

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

// ── Checkpoint (resume support) ──────────────────────────────────────────────
function hashUrls(urls) {
  return require('crypto').createHash('sha256').update(urls.join('\n')).digest('hex');
}

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Atomic write: write to a temp file, then rename, so a kill mid-write
// never leaves a corrupt checkpoint behind.
function saveProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  const tmp = PROGRESS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2));
  fs.renameSync(tmp, PROGRESS_FILE);
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

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

async function runWithConcurrency(browser, items, ts, concurrency, progress, stats) {
  const queue = [...items];
  const doneSet = new Set(progress.done);

  const markDone = url => {
    if (doneSet.has(url)) return;
    doneSet.add(url);
    progress.done.push(url);
    saveProgress(progress);
    stats.ok++;
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    let page = await newPage(browser);

    while (queue.length > 0 && !stats.stopping) {
      const { url, filename } = queue.shift();
      const prefix = `[${progress.done.length + 1}/${progress.total}]`;

      // File links (PDF etc.) → fingerprint instead of screenshot
      if (files.isFileUrl(url)) {
        const key = `screenshots/${ts}/${files.fingerprintFilename(filename)}`;
        try {
          await fingerprintAndUpload(url, key);
          markDone(url);
        } catch (e) {
          stats.failed++;
          console.error(`    ✗ ${prefix} ${url} — ${e.message}`);
        }
        continue;
      }

      const key = `screenshots/${ts}/${filename}`;

      try {
        await screenshotAndUpload(page, url, key);
        markDone(url);
      } catch (e) {
        if (stats.stopping) break; // browser is closing because of Ctrl+C
        // Page/session crashed — open a fresh one and continue
        stats.failed++;
        console.error(`    ✗ ${prefix} ${url} — ${e.message}`);
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

  // ── Resume from checkpoint, or start a new run ──
  const fresh       = process.argv.includes('--fresh');
  const sitemapHash = hashUrls(urls);
  const saved       = fresh ? null : loadProgress();
  let progress;

  if (saved && saved.sitemapHash === sitemapHash && saved.bucket === r2.BUCKET_NAME && saved.ts) {
    progress = { ...saved, total: urls.length, done: saved.done || [] };
  } else {
    if (saved) {
      const why = saved.bucket !== r2.BUCKET_NAME
        ? `bucket changed (${saved.bucket} → ${r2.BUCKET_NAME})`
        : 'sitemap.txt changed';
      console.log(`\n⚠  Ignoring old checkpoint (${why}); starting a new run.`);
    }
    progress = {
      ts:          timestamp(),
      bucket:      r2.BUCKET_NAME,
      sitemapHash,
      total:       urls.length,
      startedAt:   new Date().toISOString(),
      done:        [],
    };
  }

  const ts       = progress.ts;
  const doneSet  = new Set(progress.done);
  const resuming = doneSet.size > 0;
  const todo     = urls.filter(u => !doneSet.has(u));

  console.log(`\n📸 Screenshot run [${ts}]${resuming ? '  ↻ RESUMING' : ''}`);
  const fileCount = urls.filter(files.isFileUrl).length;
  console.log(`   URLs: ${urls.length} (${urls.length - fileCount} pages, ${fileCount} files fingerprinted)  |  Viewport: ${VIEWPORT_WIDTH}px  |  Concurrency: ${CONCURRENCY}`);
  if (resuming) {
    console.log(`   Already done: ${doneSet.size}  |  Remaining: ${todo.length}  (checkpoint: ${path.basename(PROGRESS_FILE)}, use --fresh to start over)`);
  }
  console.log(`   R2 bucket: ${r2.BUCKET_NAME}`);
  console.log(`   Basic auth: ${BASIC_AUTH ? `✓ (${BASIC_AUTH.username})` : 'none'}\n`);

  if (dryRun) {
    console.log('-- DRY RUN: URLs that would be screenshotted --');
    todo.forEach(u => console.log(` • ${u}${files.isFileUrl(u) ? '  [file → fingerprint]' : ''}`));
    console.log(`\nTotal: ${todo.length} URLs${resuming ? ` (${doneSet.size} skipped, already done)` : ''}`);
    return;
  }

  if (todo.length === 0) {
    console.log(`✅ Nothing left to do — all ${urls.length} URLs are already in screenshots/${ts}/`);
    clearProgress();
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

  // Write the checkpoint up-front so the run folder is remembered even if
  // the very first URL never finishes.
  saveProgress(progress);

  const items = todo.map(url => ({ url, filename: urlToFilename(url) }));
  const stats = { ok: 0, failed: 0, stopping: false };

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

  // Ctrl+C / kill: progress is already on disk after every URL, so just stop
  // cleanly. A second Ctrl+C exits immediately.
  const onSignal = async signal => {
    if (stats.stopping) process.exit(130);
    stats.stopping = true;
    console.log(`\n\n⏸  ${signal} received — stopping. ${progress.done.length}/${urls.length} done.`);
    console.log(`   Run "node take-screenshots.js" again to continue in screenshots/${ts}/`);
    try { await browser.close(); } catch {}
    process.exit(130);
  };
  process.on('SIGINT',  onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await runWithConcurrency(browser, items, ts, CONCURRENCY, progress, stats);
  } finally {
    if (!stats.stopping) await browser.close();
  }

  if (stats.stopping) return;

  const remaining = urls.length - progress.done.length;
  if (remaining > 0) {
    // Some URLs failed — keep the checkpoint so a re-run retries only those.
    console.log(`\n⚠  Finished with ${remaining} failed URL(s). ${progress.done.length}/${urls.length} done at: screenshots/${ts}/`);
    console.log(`   Run "node take-screenshots.js" again to retry just the failed ones (or --fresh to start over).`);
  } else {
    clearProgress();
    console.log(`\n✅ Done. ${urls.length - fileCount} screenshots + ${fileCount} fingerprints at: screenshots/${ts}/`);
  }
  console.log(`   Run "node list-screenshots.js" to see all available timestamps.`);
})();
