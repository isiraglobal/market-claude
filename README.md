# MarketAI — NSE Stock Market Intelligence Platform

A complete, production-ready single-page application for real-time NSE (National Stock Exchange of India) stock market analysis and trading intelligence, fully optimized for Vercel.

## Overview

**MarketAI** is a serverless web application that:
- Fetches live stock prices via Google Sheets (multi-market support: NSE, NASDAQ, SGX, Singapore, LSE,SGX,SGX,SGX,SGD,SGD,JPY,etc.)
- Stores price history (rolling 200 snapshot window) in Vercel KV (production) or local files (development)
- Detects technical patterns (Hammer, Doji, Engulfing, Morning Star)
- Provides portfolio tracking, watchlists, and price alerts
- Delivers momentum-based stock recommendations via AI Briefing
- Requires zero authentication — fully public, zero setup

## Architecture

```
Google Sheet (GOOGLEFINANCE)
    ↓
Google Apps Script (logs prices every 10 min)
    ↓
Vercel Serverless Functions (/api/sync, /api/data)
    ↓
Vercel KV Store (production persistence) / data.json (local fallback)
    ↓
Browser (single-file SPA with all features + localStorage caching)
```

**Tech Stack:**
- Frontend: Vanilla JavaScript, Canvas charts, SVG sparklines
- Backend: Node.js Vercel Serverless Functions (zero dependencies)
- Data: Vercel KV (production persistence) or local JSON files (development)
- Hosting: Vercel (automatic deployment)
- Fonts: Inter (UI) + JetBrains Mono (data)

## Quick Start (5 minutes)

### 1. Make Google Sheet Public
```
Share → Anyone with the link → Viewer
Copy Sheet ID from URL: /spreadsheets/d/{SHEET_ID}/...
```

### 2. Deploy to Vercel
```bash
# Install Vercel CLI
npm install -g vercel

# Run vercel deploy
vercel
```

### 3. Setup Vercel KV Storage (Optional but Recommended)
* Go to your project dashboard on Vercel.
* Click **Storage** -> **Create Database** -> **KV**.
* Connect the KV database to your project. This automatically creates the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables.

### 4. Set Up Google Apps Script
```
Google Sheet → Extensions → Apps Script
Paste GoogleAppsScript.js content
Run setupTriggers() once manually to authorize
```

### 5. Done!
Open your app, click "Sync" in the header, or let it auto-sync on load.

## Features

### Dashboard
- Workspace tabs (Morning Scan, Intraday, Swing)
- KPI boxes: Symbol count, snapshots, advancing/declining ratio
- Top gainers and losers
- Hammer reversal signals
- AI-powered momentum recommendations
- Optional AI market briefing (requires `GROQ_API_KEY`)

### Stocks
- Searchable, sortable table of all symbols
- Live prices, changes, high/low, snapshot count
- Click any stock for detailed analysis

### Stock Detail
- Interactive canvas chart (responsive, retina-ready)
- Period filters: All / 3M / 1M / 1W / 3D
- Hover tooltip with price and change %
- RSI(14), Volatility, Average price, Return %
- Full price history table with individual snapshots
- Add to portfolio or watchlist

### Patterns
- Detects: Hammer, Doji, Engulfing, Morning Star
- Filterable by type and minimum score
- Table with pattern signals across all stocks

### Screener
- Filter by price, returns, volatility, trend
- Save/load custom screeners
- View matching stocks with sparklines

### Portfolio
- Track positions: qty, avg buy price, current price
- Live P&L calculation
- Summary: invested, current value, total P&L, return %

### Watchlists
- Multiple named watchlists
- Add/remove stocks
- Live prices and changes

### Alerts
- Price alerts: above/below target price
- Check every 60 seconds in browser
- Triggered alerts shown prominently
- Pause/resume/delete alerts

### Settings
- Data source info and manual sync
- Export all data as JSON
- Clear market or user data

## File Structure

```
├── index.html                    Single-file SPA (all HTML/CSS/JS)
├── vercel.json                   Vercel configurations (CORS, headers)
├── GoogleAppsScript.js           Paste into Google Sheets
├── README.md                     This file
├── api/                          Vercel Serverless Functions
│   ├── data.js                   GET/POST market + user data
│   ├── sync.js                   Fetch Google Sheet → update Vercel KV / local files
│   └── groq.js                   Optional AI proxy to Groq API
```

## Google Sheet Setup

Your spreadsheet needs a worksheet named **SYMBOLS** containing symbols and formulas, and separate sheets named after the markets (e.g. **NSE**, **NASDAQ**) to log price columns.

Refer to [GoogleAppsScript.js](file:///Users/lakshitsinghvi/Documents/Stock%20Market/GoogleAppsScript.js) for details. The Google Apps Script automatically:
- Synchronizes symbols from the main sheet
- Appends new price columns with timestamps every 10 minutes
- Automatically cleans up historical snapshots older than 7 days

## API Endpoints

### GET /api/data
Returns combined JSON:
```json
{
  "snapshots": [{
    "id": "snap_1712000000000_1",
    "ts": 1712000000000,
    "label": "01/04/2026 15:00",
    "prices": { "TCS": 3890.00, "RELIANCE": 2450.50 }
  }],
  "symbols": ["RELIANCE", "TCS"],
  "lastSync": 1712000000000,
  "portfolio": [],
  "watchlists": [],
  "alerts": []
}
```

### POST /api/data
Saves user data.

### POST /api/sync
Fetches Google Sheet, updates Vercel KV or local files.

### POST /api/groq (Optional)
AI analysis proxy (requires `GROQ_API_KEY` env variable).

## Settings

### Optional: Enable AI Features
Get a free Groq API key for market briefings:
1. Create account at console.groq.com
2. Generate API key
3. Go to Vercel Project settings → Environment variables
4. Key: `GROQ_API_KEY`
5. Value: [your API key]
6. Redeploy or restart dev server.

## Development

### Local Development with Vercel CLI
```bash
npm install -g vercel
vercel dev
# Open http://localhost:3000
```

### Deploy Changes
```bash
git add .
git commit -m "Deploy Vercel migration"
git push origin main
```

## Security & Privacy
- **No authentication**: Fully public, no login
- **User data**: Stored in Vercel KV / local files (server-side) and `localStorage` (client-side)
- **GROQ_API_KEY**: Environment variable (hidden from client)

## License
MIT — Use freely for personal or commercial projects.
