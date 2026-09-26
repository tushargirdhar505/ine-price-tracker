# INE Product Price & Stock Tracker

A full-stack, automated web application that tracks product prices and stock levels over time by scraping INE's hosted mock store on a scheduled, unattended basis. Built for the **INE Software Engineer Intern Assignment**.

- **Live Dashboard**: [https://ine-price-tracker-three.vercel.app](https://ine-price-tracker-three.vercel.app) *(Replace with your live Vercel URL)*
- **Hosted Backend**: [https://ine-price-tracker-to8e.onrender.com](https://ine-price-tracker-to8e.onrender.com)
- **Target Mock Store**: [https://demo.inelabteamdev.com](https://demo.inelabteamdev.com)
- **Design Note**: See [DESIGN_NOTE.md](./DESIGN_NOTE.md) for scraping reliability analysis, architecture trade-offs, and AI tool disclosure.

---

## Architecture Overview

```
 ┌──────────────────────┐        ┌────────────────────────┐
 │   React (Vite) UI    │ <────> │ Express Backend (Node) │
 │  Deployed on Vercel  │        │   Deployed on Render   │
 └──────────────────────┘        └───────────┬────────────┘
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       │                     │                     │
                       ▼                     ▼                     ▼
             ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
             │    Playwright    │  │     Supabase     │  │   cron-job.org   │
             │ Headless Browser │  │    PostgreSQL    │  │  External Cron   │
             └─────────┬────────┘  └──────────────────┘  └──────────────────┘
                       │
                       ▼
             ┌──────────────────┐
             │  INE Mock Store  │
             └──────────────────┘
```

- **Frontend**: React 19 + Vite deployed on **Vercel**. Responsive dashboard with live search, option selection chips, interactive SVG price trend chart, honest scrape audit logs, and CSV export.
- **Backend**: Node.js + Express + Playwright Dockerized on **Render** (`mcr.microsoft.com/playwright:v1.48.0-jammy` with Node 22 LTS).
- **Database**: **Supabase (PostgreSQL)** tracking products and historical scrape attempts.
- **Scheduler**: **cron-job.org** triggering unattended scraping every 2 hours and keeping the free-tier backend warm.

---

## Core Features

1. **Product Search & Option Selection**:
   * Search INE's hosted mock store catalog by partial or full product name.
   * View and pick selectable product options (storage sizes, pack sizes, kits).
   * Persists tracked products directly to Supabase (`tracked_products`).
2. **Scheduled Unattended Scraping**:
   * Fixed 2-hour schedule triggered via external cron (`cron-job.org`).
   * Handles the mock store's anti-bot mechanisms: behavioral mouse-movement tracking, hover thresholds, random cookie-consent scrims, and randomized DOM tags.
   * Automatic 3-attempt retry loop with backoff and fresh navigations.
3. **Honest History & Audit Scrape Log**:
   * Displays every single scrape attempt in reverse-chronological order.
   * Failures and retries are recorded honestly (never hidden), capturing upstream 429s, gate timeouts, and script errors.
   * Price trend visualizer plotted across scrape timestamps.
4. **Full CSV Export**:
   * "Export CSV" button downloads `scrape_history.csv` matching the required schema:
     `store_product_id,product_name,selected_option,timestamp_utc,price,stock,outcome`
   * Failed attempts leave price and stock empty as specified.

---

## Running the Observable (Headed) Scraper

Per the assignment brief, the scraper can be run locally in headed mode with visible browser automation to observe mouse simulations, button gate unlocking, and failure handling:

```bash
# From the project root:
npm run scrape:headed

# Or run directly inside the backend directory:
cd backend
npm run scrape:headed

# Optional: customize target product and option:
node run-headed.js /item/2095 "128 GB"
```

---

## Setup & Local Development

### Prerequisites
- Node.js 20+ (Node 22 LTS recommended)
- Git

### 1. Clone Repository
```bash
git clone https://github.com/tushargirdhar505/ine-price-tracker.git
cd ine-price-tracker
```

### 2. Backend Setup
```bash
cd backend
npm install
npx playwright install chromium
```

Create `backend/.env`:
```env
PORT=3000
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key>
SCRAPE_SECRET=<your-scrape-secret>
```

Start the backend:
```bash
npm run dev
# Server listens on http://localhost:3000
```

### 3. Frontend Setup
```bash
cd ../frontend
npm install
```

Create `frontend/.env`:
```env
VITE_API_URL=http://localhost:3000
```

Start Vite dev server:
```bash
npm run dev
# Dashboard opens on http://localhost:5173
```

---

## Environment Variables

### Backend (`backend/.env` & Render Service Settings)
| Variable | Description | Example |
| :--- | :--- | :--- |
| `PORT` | Port for Express server | `3000` |
| `SUPABASE_URL` | Supabase Project URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for database operations | `eyJhbGciOi...` |
| `SCRAPE_SECRET` | Secret bearer header for `/api/scrape-all` | `super-secret-key-123` |

### Frontend (`frontend/.env` & Vercel Project Settings)
| Variable | Description | Example |
| :--- | :--- | :--- |
| `VITE_API_URL` | Backend URL (Render in prod, localhost in dev) | `https://ine-price-tracker-to8e.onrender.com` |

---

## Scraping Schedule Configuration (cron-job.org)

Render free instances idle after 15 minutes of inactivity. To satisfy the 2-hour schedule without cold-start timeouts:

1. **Keep-Warm Ping Job**:
   - **URL**: `GET https://ine-price-tracker-to8e.onrender.com/`
   - **Schedule**: Every 10 minutes (`*/10 * * * *`)
   - **Purpose**: Keeps the container warm 24/7.
2. **2-Hour Scraper Job**:
   - **URL**: `POST https://ine-price-tracker-to8e.onrender.com/api/scrape-all`
   - **Schedule**: Every 2 hours (`0 */2 * * *`)
   - **Headers**: `x-scrape-secret: <your_secret>`
   - **Behavior**: Acknowledges immediately (`200 OK`) and runs the scrape asynchronously in the background, logging every attempt to Supabase.
