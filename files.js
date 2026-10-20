/**
 * files.js
 * Fingerprinting for non-HTML links (PDFs, Office docs, archives, media…).
 *
 * Instead of screenshotting these in Chrome (slow, and Chrome's PDF viewer
 * renders asynchronously → blank/half-drawn shots → false positives), we
 * download the file, hash it (SHA-256) and store a small text file next to
 * the screenshots:
 *
 *   screenshots/<timestamp>/<filename>.txt
 *
 * compare-screenshots.js compares the hashes of two runs.
 */

'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

// Links with these extensions are fingerprinted instead of screenshotted.
const FILE_EXTENSIONS = new Set([
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pps', 'ppsx',
  'odt', 'ods', 'odp', 'rtf', 'csv', 'txt', 'xml', 'json',
  'zip', 'rar', '7z', 'gz', 'tar',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tif', 'tiff', 'bmp', 'ico',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi', 'webm', 'wmv',
  'eps', 'ai', 'psd',
]);

const FETCH_TIMEOUT_MS = 120_000;
const FETCH_RETRIES    = 3;

/** Extension of the URL path (lowercase, no dot) or '' */
function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** True if the URL points to a downloadable file rather than an HTML page. */
function isFileUrl(url) {
  return FILE_EXTENSIONS.has(extOf(url));
}

/**
 * True if a screenshot key/filename (e.g. "..._Newsletter.pdf.png") belongs
 * to a file link. Used to ignore legacy screenshots of PDFs etc. taken by
 * older versions of take-screenshots.js.
 */
function isFileScreenshotName(filename) {
  const m = filename.replace(/\.png$/i, '').match(/\.([a-z0-9]{1,5})$/i);
  return !!m && FILE_EXTENSIONS.has(m[1].toLowerCase());
}

/**
 * Download a file and compute its SHA-256 (streamed — large files are fine).
 * Never throws: on failure the fingerprint is "ERROR <reason>", so a broken
 * link still shows up as a change when compared to a good run.
 *
 * @param {string} url
 * @param {object} [headers]  extra request headers (e.g. Basic auth)
 * @returns {Promise<{url, sha256, size, status, contentType, lastModified, etag, fetchedAt}>}
 */
async function fingerprintUrl(url, headers = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (visual-test fingerprint)', ...headers },
      });

      const meta = {
        url,
        finalUrl:     res.url !== url ? res.url : '',
        status:       res.status,
        contentType:  res.headers.get('content-type') || '',
        lastModified: res.headers.get('last-modified') || '',
        etag:         res.headers.get('etag') || '',
        fetchedAt:    new Date().toISOString(),
      };

      if (!res.ok) {
        if (res.body && typeof res.body.destroy === 'function') res.body.destroy();
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < FETCH_RETRIES) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        return { ...meta, sha256: `ERROR HTTP ${res.status}`, size: 0 };
      }

      const hash = crypto.createHash('sha256');
      let size = 0;
      await new Promise((resolve, reject) => {
        res.body.on('data', chunk => { hash.update(chunk); size += chunk.length; });
        res.body.on('end', resolve);
        res.body.on('error', reject);
      });

      return { ...meta, sha256: hash.digest('hex'), size };
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }

  return {
    url, finalUrl: '', status: 0, contentType: '', lastModified: '', etag: '',
    fetchedAt: new Date().toISOString(),
    sha256: `ERROR ${lastErr ? (lastErr.code || lastErr.message) : 'unknown'}`, size: 0,
  };
}

/** Serialise a fingerprint as a simple "key: value" text file. */
function formatFingerprint(fp) {
  return [
    `url: ${fp.url}`,
    fp.finalUrl ? `final-url: ${fp.finalUrl}` : null,
    `sha256: ${fp.sha256}`,
    `size: ${fp.size}`,
    `status: ${fp.status}`,
    `content-type: ${fp.contentType}`,
    `last-modified: ${fp.lastModified}`,
    `etag: ${fp.etag}`,
    `fetched-at: ${fp.fetchedAt}`,
  ].filter(l => l !== null).join('\n') + '\n';
}

/** Parse a fingerprint text file back into an object (keys as written). */
function parseFingerprint(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Fingerprint filename for a URL, matching the screenshot naming scheme. */
function fingerprintFilename(screenshotFilename) {
  return screenshotFilename.replace(/\.png$/i, '') + '.txt';
}

module.exports = {
  FILE_EXTENSIONS,
  isFileUrl,
  isFileScreenshotName,
  fingerprintUrl,
  formatFingerprint,
  parseFingerprint,
  fingerprintFilename,
};
