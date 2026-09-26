/**
 * scraper.js — Core Playwright scraping logic, reused by the backend.
 *
 * This is the SAME logic proven out in the standalone scraper/scrape.js
 * script (selectors, mouse simulation, retry loop) — just repackaged as
 * one importable function, scrapeProductWithRetries(productPath), so
 * server.js can call it for any tracked product instead of one hardcoded
 * path.
 *
 * Kept in a single file, one exported function, so it's easy to explain:
 * "attemptScrape() does one try; scrapeProductWithRetries() calls it up
 * to 3 times."
 */

import { chromium } from 'playwright';

const STORE_BASE_URL = 'https://demo.inelabteamdev.com';

const SELECTORS = {
  cookieConsentModal: '.consent-scrim',
  cookieConsentDismissBtn: '.consent-scrim button',
  pricePanel: '.offer-panel',
  priceSuccessState: '.offer-panel.offer-ready',
  // The site randomizes which HTML tag holds the real price (<output>,
  // <b>, etc). What stays constant is this inline style, so we match on
  // that instead of a tag name.
  priceValue: '.offer-row [style*="2.4rem"]',
  stockValue: '.offer-panel .avail-pill',
  priceErrorState: '.offer-panel.offer-failed',
  checkPriceButton: '.offer-panel button',
};

const TIMEOUTS = {
  cookieModalAppear: 6000,
  priceResolve: 15000,
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

function parsePriceText(rawText) {
  if (!rawText) return null;
  const digitsOnly = rawText.replace(/[^0-9.]/g, '');
  return digitsOnly ? Number(digitsOnly) : null;
}

function parseStockFromPillText(rawText) {
  if (!rawText) return null;
  if (rawText.toLowerCase().includes('sold out')) return 0;
  const match = rawText.match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function dismissCookieConsentIfPresent(page, timeout = TIMEOUTS.cookieModalAppear) {
  try {
    const modal = page.locator(SELECTORS.cookieConsentModal).first();
    await modal.waitFor({ state: 'visible', timeout });
    for (let i = 0; i < 3; i++) {
      if (!(await modal.isVisible().catch(() => false))) break;
      await page.locator(SELECTORS.cookieConsentDismissBtn).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    return true;
  } catch {
    return false;
  }
}

async function simulateGenuineMouseMovement(page) {
  const panel = page.locator(SELECTORS.pricePanel).first();
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  const box = await panel.boundingBox();
  if (!box) throw new Error('Price panel had no bounding box.');

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  const steps = 10;
  const startX = Math.max(0, targetX - 250);
  const startY = Math.max(0, targetY - 150);

  await page.mouse.move(startX, startY);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      startX + ((targetX - startX) * i) / steps,
      startY + ((targetY - startY) * i) / steps,
      { steps: 3 }
    );
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(750); // hold over the panel past the 600ms threshold
}

async function wiggleOverPanel(page) {
  const panel = page.locator(SELECTORS.pricePanel).first();
  const box = await panel.boundingBox().catch(() => null);
  if (!box) {
    await page.waitForTimeout(300);
    return;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      cx + (Math.random() - 0.5) * Math.min(40, box.width / 3),
      cy + (Math.random() - 0.5) * Math.min(20, box.height / 3),
      { steps: 2 }
    );
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
}

async function clickCheckPrice(page) {
  const btn = page.locator(SELECTORS.checkPriceButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });

  const gateDeadline = Date.now() + 6000;
  while (await btn.isDisabled().catch(() => true)) {
    if (Date.now() > gateDeadline) break;
    await wiggleOverPanel(page);
  }

  await dismissCookieConsentIfPresent(page, 800);

  try {
    await btn.click({ timeout: 5000 });
  } catch (err) {
    if (String(err.message).includes('intercepts pointer events')) {
      await dismissCookieConsentIfPresent(page, 2000);
      await btn.click({ timeout: 5000 });
    } else {
      throw err;
    }
  }
}

async function waitForPriceResult(page) {
  const success = page.locator(SELECTORS.priceSuccessState).first();
  const error = page.locator(SELECTORS.priceErrorState).first();

  const outcome = await Promise.race([
    success.waitFor({ state: 'visible', timeout: TIMEOUTS.priceResolve }).then(() => 'success'),
    error.waitFor({ state: 'visible', timeout: TIMEOUTS.priceResolve }).then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome === 'success') {
    await page.waitForTimeout(300);
    let priceText = await page.locator(SELECTORS.priceValue).first().textContent().catch(() => null);
    if (!priceText) {
      await page.waitForTimeout(500);
      priceText = await page.locator(SELECTORS.priceValue).first().textContent().catch(() => null);
    }
    const stockPillText = await page.locator(SELECTORS.stockValue).first().textContent().catch(() => null);
    return {
      outcome: 'success',
      price: parsePriceText(priceText),
      stock: parseStockFromPillText(stockPillText),
    };
  }

  if (outcome === 'error') {
    const msg = await page.locator('.offer-panel .offer-msg').first().textContent().catch(() => null);
    const submsg = await page.locator('.offer-panel .offer-submsg').first().textContent().catch(() => null);
    const detail = [msg, submsg].filter(Boolean).map((s) => s.trim()).join(' — ');
    return { outcome: 'failed', price: null, stock: null, detail: detail || 'error state shown' };
  }

  return { outcome: 'failed', price: null, stock: null, detail: 'timed out waiting for success/error state' };
}

async function attemptScrape(page, url) {
  try {
    // page.goto() is now INSIDE the try/catch — a navigation failure
    // (DNS hiccup, timeout, store briefly down) is a legitimate failed
    // attempt to retry, not something that should crash the whole cycle.
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await dismissCookieConsentIfPresent(page);
    await simulateGenuineMouseMovement(page);
    await clickCheckPrice(page);
    const result = await waitForPriceResult(page);

    // Guard: the site can technically show the 'offer-ready' class while
    // our price/stock text extraction still comes back empty (a parsing
    // edge case we haven't hit yet, but could). Never report 'success'
    // with missing data — that would violate "never store wrong or
    // empty data". Treat it as a failed attempt instead, so it retries.
    if (result.outcome === 'success' && (result.price === null || result.stock === null)) {
      return {
        outcome: 'failed',
        price: null,
        stock: null,
        detail: `success state shown but price/stock text could not be parsed (price=${result.price}, stock=${result.stock})`,
      };
    }

    return result;
  } catch (err) {
    return { outcome: 'failed', price: null, stock: null, detail: `script error: ${err.message}` };
  }
}

/**
 * Scrapes one product, retrying up to MAX_ATTEMPTS times. Returns EVERY
 * attempt's result (not just the final one), so the caller can write one
 * scrape_history row per attempt — matching the data model's 'retried'
 * outcome for non-final failures.
 */
export async function scrapeProductWithRetries(productPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const url = `${STORE_BASE_URL}${productPath}`;

  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timestamp = new Date().toISOString();
    const result = await attemptScrape(page, url);
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    const rowOutcome = result.outcome === 'success' ? 'success' : isLastAttempt ? 'failed' : 'retried';

    attempts.push({ timestamp, outcome: rowOutcome, price: result.price, stock: result.stock, detail: result.detail || null });

    if (result.outcome === 'success') break;
    if (!isLastAttempt) await page.waitForTimeout(RETRY_DELAY_MS);
  }

  await browser.close();
  return attempts;
}
