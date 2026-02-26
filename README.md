# blble — Broken Links. Broken Links Everywhere.

blble is a local, browser-driven link-auditing tool designed for library/reserve workflows (e.g., Leganto “Citation Source” links) where access depends on **OpenAthens** authentication and links may require multiple resolver “jumps”.

It runs on your machine, launches a visible Chromium browser, lets you **log in once**, then iterates through URLs and uses **Gemini** to evaluate whether the resolved page appears to match the expected citation metadata.

> **AI / “vibe coded” disclosure**
>
> This project was substantially developed with the help of generative AI tools (a “vibe coded” workflow): an AI assistant produced large portions of the scaffolding, implementation, and iterative updates, with human direction and testing.
> Please review the code before deploying in production environments, and treat outputs as **decision support** rather than ground truth.

## What it does

- **CSV input**: accepts a Leganto export CSV; extracts URLs from *Citation Source* columns and metadata from other columns.
- **Login first**: opens an interactive browser window for manual authentication. Works with OpenAthens. Probably works with EZProxy.
- **Resolver clicker**: attempts to follow “Full text / PDF / View online” links when a resolver page is encountered.
- **Page evaluation** (Gemini): classifies each item as:
  - `correct_and_accessible`
  - `correct_but_paywalled_or_partial`
  - `incorrect_article`
  - `uncertain_needs_review`
- **Outputs**
  - `results.csv` (primary)
  - `report.html`
  - `results.json` / `results.jsonl` (debug)
  - screenshots per row

## Quick start (Windows)

### Prereqs
- Node.js **18+** recommended (Node 20 LTS is a safe choice)
- npm (bundled with Node)
- A Gemini API key (Google AI Studio / Google Cloud)

### Install
```powershell
npm install
copy .env.example .env
notepad .env
```

### Configure `.env`
```env
GEMINI_API_KEY=YOUR_KEY_HERE
GEMINI_MODEL=gemini-2.5-flash

# Optional throttles (help avoid 429s)
THROTTLE_MS=1250
GEMINI_MIN_DELAY_MS=1500
GEMINI_MAX_RETRIES=3
```

### Run
```powershell
npm start
```

Open: http://localhost:3877

Workflow:
1. Click **Open Login Browser**
2. Complete OpenAthens authentication (leave that window open)
3. Upload your CSV
4. Click **Test Gemini**
5. Click **Run Audit**

## Security / privacy

- This repo includes **`.env.example` only**.
- Outputs (screenshots / excerpts) may contain licensed content; store/share appropriately.

— Version 0.3.5
