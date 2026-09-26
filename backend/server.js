/**
 * server.js — Express backend for the INE Price Tracker.
 *
 * Six routes, matching the brief exactly:
 *   GET  /api/search              — search the store's catalog
 *   POST /api/track               — start tracking a product
 *   GET  /api/products            — list tracked products
 *   GET  /api/products/:id/history — one product's scrape history
 *   POST /api/scrape-all          — secret-protected, scrapes every tracked product (cron calls this)
 *   GET  /api/export.csv          — full scrape history as CSV
 *
 * Each route is a short function that calls into db.js (for data) or
 * scraper.js (for the actual scraping) — server.js itself has no business
 * logic beyond "read the request, call the right helper, send the response".
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  insertTrackedProduct,
  getTrackedProducts,
  insertScrapeHistory,
  getProductHistory,
  getFullHistoryForExport,
} from './db.js';
import { scrapeProductWithRetries } from './scraper.js';

const app = express();
app.use(cors());
app.use(express.json());

const STORE_BASE_URL = 'https://demo.inelabteamdev.com';
const PORT = process.env.PORT || 3000;

async function getStoreProduct(storeProductId) {
  const response = await fetch(`${STORE_BASE_URL}/api/v2/items/${encodeURIComponent(storeProductId)}`);
  if (!response.ok) throw new Error(`Store product lookup failed with HTTP ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------
// GET /api/search?query=xyz — proxies the store's own catalog endpoint,
// then filters by name server-side (the store's endpoint only documents
// page/limit, no dedicated search param).
// ---------------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const query = (req.query.query || '').toLowerCase();
  const MAX_RESULTS = 20;
  const MAX_PAGES_TO_SCAN = 10; // 10 * 100 = up to 1000 products scanned per search

  try {
    // The store's /api/v2/listings has no search param (confirmed against
    // the live API) — only page/limit, wrapped as { results: [...] }. With
    // 960 products across 192 pages, we page through until we've found
    // enough matches (or run out of pages to scan), rather than only
    // checking page 1 and missing almost everything.
    const matches = [];
    for (let page = 1; page <= MAX_PAGES_TO_SCAN; page++) {
      const response = await fetch(`${STORE_BASE_URL}/api/v2/listings?page=${page}&limit=100`);
      const data = await response.json();
      const results = data.results || [];
      if (results.length === 0) break; // ran out of pages

      const pageMatches = query ? results.filter((item) => item.name?.toLowerCase().includes(query)) : results;
      matches.push(...pageMatches);

      if (matches.length >= MAX_RESULTS || page >= data.totalPages) break;
    }

    res.json(matches.slice(0, MAX_RESULTS));
  } catch (err) {
    res.status(502).json({ error: `Failed to reach the store's catalog: ${err.message}` });
  }
});

// ---------------------------------------------------------------------
// GET /api/catalog/:storeProductId — details and real selectable options for
// the frontend after the user chooses a result from /api/search.
app.get('/api/catalog/:storeProductId', async (req, res) => {
  try {
    res.json(await getStoreProduct(req.params.storeProductId));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/track — body: { storeProductId, productName, optionId, optionLabel }
// ---------------------------------------------------------------------
app.post('/api/track', async (req, res) => {
  const { storeProductId, productName, optionId, optionLabel } = req.body;
  if (!storeProductId || !productName || !optionId || !optionLabel) {
    return res.status(400).json({ error: 'storeProductId, productName, optionId, and optionLabel are required' });
  }
  try {
    // Never trust a browser-submitted option blindly. Check it against the
    // store's product data and persist the canonical name and option label.
    const storeProduct = await getStoreProduct(storeProductId);
    const storeOption = storeProduct.options?.find((option) => option.id === optionId);
    if (!storeOption || storeOption.label !== optionLabel) {
      return res.status(400).json({ error: 'The selected option does not belong to this store product' });
    }

    const row = await insertTrackedProduct({
      storeProductId: storeProduct.id,
      productName: storeProduct.name,
      optionId: storeOption.id,
      optionLabel: storeOption.label,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/products — everything currently tracked
// ---------------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  try {
    res.json(await getTrackedProducts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/products/:id/history — one product's full scrape log
// ---------------------------------------------------------------------
app.get('/api/products/:id/history', async (req, res) => {
  try {
    res.json(await getProductHistory(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/scrape-all — secret-protected. Scrapes every tracked product,
// writing one scrape_history row per attempt. This is what cron-job.org
// calls every 2 hours.
// ---------------------------------------------------------------------
app.post('/api/scrape-all', async (req, res) => {
  const providedSecret = req.headers['x-scrape-secret'];
  if (providedSecret !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing scrape secret' });
  }

  try {
    const products = await getTrackedProducts();
    const summary = [];

    for (const product of products) {
      const attempts = await scrapeProductWithRetries(
        `/item/${product.store_product_id}`,
        product.option_label
      );
      let rowsStored = 0;
      let dbWriteFailed = false;

      for (const attempt of attempts) {
        try {
          await insertScrapeHistory({
            productId: product.id,
            timestamp: attempt.timestamp,
            price: attempt.price,
            stock: attempt.stock,
            outcome: attempt.outcome,
            detail: attempt.detail,
          });
          rowsStored++;
        } catch (dbErr) {
          console.error(`[scrape-all] Failed to store scrape_history row for product ${product.id}:`, dbErr.message);
          dbWriteFailed = true;
        }
      }

      summary.push({
        productId: product.id,
        productName: product.product_name,
        finalOutcome: attempts[attempts.length - 1].outcome,
        attemptsLogged: attempts.length,
        rowsStored,
        dbWriteFailed,
      });
    }

    res.json({ scraped: summary.length, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/export.csv — full history, exact columns from the brief:
// store_product_id, product_name, selected_option, timestamp_utc,
// price, stock, outcome
// ---------------------------------------------------------------------
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.get('/api/export.csv', async (req, res) => {
  try {
    const rows = await getFullHistoryForExport();
    const header = 'store_product_id,product_name,selected_option,timestamp_utc,price,stock,outcome';
    const lines = rows.map((row) => {
      const product = row.tracked_products || {};
      return [
        csvEscape(product.store_product_id),
        csvEscape(product.product_name),
        csvEscape(product.option_label),
        csvEscape(row.timestamp),
        csvEscape(row.price),
        csvEscape(row.stock),
        csvEscape(row.outcome),
      ].join(',');
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="scrape_history.csv"');
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'INE Price Tracker backend is running' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
