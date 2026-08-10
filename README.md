# someproject-visual-test

Visual regression testing tool — screenshots stored in **Cloudflare R2**, comparison reports saved locally and uploaded to R2 for public sharing.

---

## Cloudflare R2 — First-time Setup

Follow these steps once before using this project for the first time.

### 1. Create a Cloudflare account

Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up if you don't have an account.

### 2. Enable R2

1. In the dashboard sidebar, click **R2 Object Storage**
2. Click **Purchase R2 Plan** and add a payment method (required even for the free tier)
3. Free tier includes: **10 GB storage**, **1M writes/month**, **10M reads/month**, no egress fees

### 3. Find your Account ID

Your Account ID is visible in the URL of any Cloudflare dashboard page:  
`https://dash.cloudflare.com/<account-id>/...`

Copy it — you'll need it for `.env`.

### 4. Create an API Token

1. Go to **https://dash.cloudflare.com/&lt;account-id&gt;/api-tokens**  
   (replace `<account-id>` with yours)
2. Click **Create Token**
3. Click **Create Custom Token** (at the bottom of the template list)
4. Give it a name, e.g. `someproject-visual-test`
5. Under **Permissions**, set the three dropdowns to:  
   **Account** → **Workers R2 Storage** → **Edit**
6. Click **Continue to Summary → Create Token**
7. **Copy the token immediately** — it is only shown once

### 5. Configure .env

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
CF_ACCOUNT_ID=your_account_id
CF_API_TOKEN=your_api_token
R2_BUCKET=someproject-visual-test
SITEMAP_INDEX=https://www.example.com/sitemap.xml
R2_PUBLIC_URL=https://pub-xxxx.r2.dev   # fill in after step 6 below
```

The bucket (`someproject-visual-test`) is created automatically on first run.

### 6. Enable Public Development URL (for shareable report links)

After running the project for the first time:

1. Go to **R2 → `someproject-visual-test` → Settings → Public Development URL**
2. Click **Enable** → type `allow` → click **Allow**
3. Copy the URL shown (e.g. `https://pub-xxxx.r2.dev`)
4. Paste it into `.env` as `R2_PUBLIC_URL`

All future comparison reports will print a public link automatically.

---

## Project Setup

```bash
cd someproject-visual-test
npm install
```

Google Chrome must be installed at the default macOS path (`/Applications/Google Chrome.app`).  
Override with `CHROME_PATH` in `.env` if needed.

---

## Workflow

### 1. Fetch the sitemap

```bash
node fetch-sitemap.js
```

Crawls the sitemap index, collects all page URLs, saves them to `sitemap.txt`.  
Re-run any time the site structure changes.

---

### 2. Take a baseline screenshot set

```bash
node take-screenshots.js
```

- Takes a full-page screenshot (1280 px wide) of every URL in `sitemap.txt`
- Uploads each PNG directly to R2 at `screenshots/<timestamp>/`
- No local copies are kept

To preview which URLs would be captured without actually running:

```bash
node take-screenshots.js --dry-run
```

---

### 3. Make your changes (deploy, update, etc.)

---

### 4. Take a second screenshot set

```bash
node take-screenshots.js
```

---

### 5. List available timestamps

```bash
node list-screenshots.js
```

Output example:
```
  2026-08-07_09-00-00  (806 pages)
  2026-08-07_16-30-00  (806 pages)
```

---

### 6. Compare two sets

```bash
node compare-screenshots.js 2026-08-07_09-00-00 2026-08-07_16-30-00
```

This will:
- Download both screenshot sets from R2
- Pixel-diff every page
- Save diff images to R2 at `diffs/<before>_vs_<after>/`
- Upload the full report (HTML + images) to R2 at `reports/<before>_vs_<after>/`
- Write a local copy to `reports/<before>_vs_<after>/index.html`
- Print a public shareable URL (if `R2_PUBLIC_URL` is set in `.env`)

Open the local report:
```bash
open reports/2026-08-07_09-00-00_vs_2026-08-07_16-30-00/index.html
```

---

## Storage Management

### Check storage usage

```bash
node storage.js
```

Shows total used space, breakdown by prefix (screenshots / diffs / reports), and remaining free tier capacity (10 GB free).

### Delete a screenshot set

Preview what would be deleted:
```bash
node delete-set.js 2026-08-07_09-00-00
```

Actually delete (screenshots + all associated diffs and reports for that timestamp):
```bash
node delete-set.js 2026-08-07_09-00-00 --confirm
```

---

## R2 Storage Layout

```
someproject-visual-test/              ← R2 bucket
  screenshots/
    2026-08-07_09-00-00/
      index.png
      about_.png
      ...
    2026-08-07_16-30-00/
      ...
  diffs/
    2026-08-07_09-00-00_vs_2026-08-07_16-30-00/
      about_.png                        ← diff images for changed pages only
      ...
  reports/
    2026-08-07_09-00-00_vs_2026-08-07_16-30-00/
      index.html                        ← shareable report (if public access enabled)
      before/
      after/
      diff/
```

## Local Output Layout

```
reports/
  2026-08-07_09-00-00_vs_2026-08-07_16-30-00/
    index.html          ← open in browser (no server needed)
    before/             ← before images for changed pages
    after/              ← after images for changed pages
    diff/               ← pixel-diff images
```

---

## Configuration (.env)

| Variable        | Description                                                  |
|-----------------|--------------------------------------------------------------|
| `CF_ACCOUNT_ID` | Cloudflare Account ID (from dashboard URL)                   |
| `CF_API_TOKEN`  | Cloudflare API token with Workers R2 Storage: Edit           |
| `R2_BUCKET`     | R2 bucket name (default: `someproject-visual-test`)        |
| `SITEMAP_INDEX` | Sitemap URL to crawl                                         |
| `R2_PUBLIC_URL` | Public dev URL from R2 bucket settings (e.g. `https://pub-xxxx.r2.dev`) |
| `CHROME_PATH`   | Path to Chrome (only needed if not at default macOS location)|

---

## All scripts

| Script                    | Description                                              |
|---------------------------|----------------------------------------------------------|
| `node fetch-sitemap.js`   | Fetch URLs from sitemap → `sitemap.txt`                  |
| `node take-screenshots.js`| Take screenshots → upload to R2                          |
| `node list-screenshots.js`| List available timestamps in R2                          |
| `node compare-screenshots.js <before> <after>` | Diff two sets → local + R2 report    |
| `node storage.js`         | Show R2 storage usage vs free tier                       |
| `node delete-set.js <ts>` | Preview deletion of a set (add `--confirm` to execute)   |
