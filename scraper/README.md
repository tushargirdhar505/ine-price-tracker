# Step 2 — Standalone Scraper Setup

## 1. Install

```bash
npm install
npm run install-browsers   # downloads Chromium for Playwright
```

## 2. Find the real product URL + selectors (do this first, in your own browser)

1. Open https://demo.inelabteamdev.com in Chrome.
2. Search for a product, click into it, and note the **actual URL pattern**
   (e.g. `/product/abc123` or `/products/abc123?option=xyz`). Put that
   pattern into `PRODUCT_PATH` in `scrape.js`.
3. Open DevTools (F12) → Elements tab. Click each of these on the live
   page and copy their real selector (prefer `data-testid`/`id` if present):
   - The cookie-consent modal, and its dismiss/accept button.
   - The container around the price + "Check today's price" button
     (this is what we hover over).
   - The "Check today's price" button itself.
   - Whatever element appears on a **successful** price check (should
     contain the price and stock).
   - Whatever element appears on a **failed/error** price check.
4. Paste each real selector into the matching entry in the `SELECTORS`
   object at the top of `scrape.js`, replacing the placeholder.

Tip: in DevTools you can right-click any element → Copy → Copy selector
as a starting point, then simplify/clean it up.

## 3. Run it

```bash
npm run scrape          # headless
npm run scrape:headed   # visible browser — use this while debugging selectors
```

Watch the console output. It logs each stage (`[cookie]`, `[mouse]`,
`[click]`) so you can see exactly where it succeeds or fails, and prints
a final JSON result block.

## 4. Iterate

Because of the site's built-in ~35% flaky click and random cookie-modal
timing, run it several times (5-10) before trusting it. You're aiming for:
- Reliable price/stock extraction on a genuine success.
- A clean `"outcome": "failed"` (never a half-filled result) on the
  flaky/error cases — never partial data.

Once this reliably gets a price most runs, we move to **Step 3**
(retry/backoff loop) and **Step 4** (Supabase wiring).
