/**
 * INE Store — Price/Stock Scraper with Retry Loop (Step 2 + Step 3)
 * -------------------------------------------------------------------
 * Given one product page on demo.inelabteamdev.com, reliably get that
 * product's live price + stock by driving a real headless browser through
 * the site's anti-bot challenge:
 *   1. Dismiss the cookie-consent modal if/when it appears (random delay,
 *      random position, sometimes needs 2-3 clicks) — can appear at ANY
 *      point in the sequence, not just at page load.
 *   2. Simulate genuine mouse movement + a 600ms+ hover over the price
 *      panel (the "Check today's price" button stays disabled until the
 *      site sees 8+ mousemove events and the hover) — polling with extra
 *      "wiggle" movement if the gate doesn't unlock on the first pass.
 *   3. Click "Check today's price".
 *   4. Wait for the panel to resolve to EITHER its success state or its
 *      error state — never on a fixed timer. The click has a ~35% chance
 *      of silently doing nothing or adding ~900ms delay, so the wait must
 *      be generous and must not assume success.
 *
 * STEP 3 — retry/backoff: a single attempt failing (gate never unlocking,
 * flaky click, error state, timeout) does not mean the scrape cycle fails.
 * We retry up to MAX_ATTEMPTS times with a fixed delay between attempts,
 * doing a full fresh page navigation each time (never reusing a stale
 * price). Only after every attempt fails do we return a final 'failed'
 * result — and even then, price/stock are always null, never guessed or
 * left half-filled (never price without stock or vice versa).
 *
 * This script is still standalone — no DB writes yet (that's Step 4).
 */

import { chromium } from 'playwright';
import { insertScrapeHistory } from './db.js';

// ---------------------------------------------------------------------
// CONFIG — fill these in for the product you're testing against
// ---------------------------------------------------------------------
const STORE_BASE_URL = 'https://demo.inelabteamdev.com';

const PRODUCT_PATH = '/item/2569'; // confirmed from the live site

const HEADLESS = process.env.HEADLESS !== 'false'; // `HEADLESS=false npm run scrape` for headed/demo mode

const TRACKED_PRODUCT_ID = process.env.TRACKED_PRODUCT_ID; // UUID from the tracked_products table

// ---------------------------------------------------------------------
// SELECTORS — every one of these needs verifying against the live DOM
// ---------------------------------------------------------------------
const SELECTORS = {
  // CONFIRMED (from a click-intercept error in a real run): the popup's
  // overlay/scrim is <div class="consent-scrim">. We haven't seen its
  // inner dismiss button directly yet, so we fall back to clicking any
  // button inside it.
  cookieConsentModal: '.consent-scrim',
  cookieConsentDismissBtn: '.consent-scrim button',

  // CONFIRMED from live DOM: the whole price block is <div class="offer-panel ...">.
  // It gets an extra "offer-ready" class once a check resolves successfully
  // (e.g. class="offer-panel offer-ready tpv-j2"). The trailing class
  // (tpv-j2 here) looks randomized per page load — never rely on it.
  pricePanel: '.offer-panel',
  priceSuccessState: '.offer-panel.offer-ready',

  // CONFIRMED, and IMPORTANT: the site randomizes which HTML tag holds the
  // real price between page loads — we've seen it as both <output> and
  // <b>. What stays constant is its inline style: font-size: 2.4rem;
  // font-weight: 700; letter-spacing: -0.02em. We match on that style
  // fragment instead of a tag name, so it works no matter what tag wraps it.
  priceValue: '.offer-row [style*="2.4rem"]',

  // CONFIRMED: stock is a pill, not a number directly — text is either
  // "Available (172)" or "Sold out". We parse the number out of the text
  // in code below (see parseStockFromPillText).
  stockValue: '.offer-panel .avail-pill',

  // CONFIRMED: on a genuine failure, "offer-failed" is added instead of
  // "offer-ready". Message text seen: "Couldn't load the price after 6
  // attempts." / "upstream 429" — the site does its own internal retries
  // before surfacing this, and simulates a rate-limit error.
  priceErrorState: '.offer-panel.offer-failed',

  // CONFIRMED: the action button relabels itself depending on state
  // ("Check today's price" initially, "Check again" after success,
  // "Retry" after failure) so we match by position, not text.
  checkPriceButton: '.offer-panel button',
};

const TIMEOUTS = {
  cookieModalAppear: 6000, // modal can appear up to 5s after load
  priceResolve: 15000, // generous: button click can add ~900ms delay, plus PoW solve time
};

// ---------------------------------------------------------------------
// Text parsing helpers
// ---------------------------------------------------------------------

/**
 * The real price <output> is made of separate <span> characters
 * (e.g. <span>₹</span><span>3</span><span>7</span>...) but Playwright's
 * textContent() already concatenates them into one string like "₹37,104".
 * This strips the currency symbol/commas down to a plain number.
 */
function parsePriceText(rawText) {
  if (!rawText) return null;
  const digitsOnly = rawText.replace(/[^0-9.]/g, '');
  if (!digitsOnly) return null;
  return Number(digitsOnly);
}

/**
 * Stock is shown as a pill: "Available (172)" or "Sold out".
 * "Sold out" is a legitimate result, not a failure — it means stock = 0.
 */
function parseStockFromPillText(rawText) {
  if (!rawText) return null;
  const text = rawText.trim().toLowerCase();
  if (text.includes('sold out')) return 0;
  // Handles "Available (172)", "Last few: 161", and any other wording that
  // contains a plain number — pulls the first number found, in any format.
  const match = rawText.match(/\d+/);
  return match ? Number(match[0]) : null;
}

// ---------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------

/**
 * Dismisses the cookie consent modal if it shows up. It appears after a
 * random 1.5-5s delay and sometimes needs 2-3 clicks to fully go away,
 * so this polls briefly and clicks repeatedly while it's visible.
 */
async function dismissCookieConsentIfPresent(page, timeout = TIMEOUTS.cookieModalAppear) {
  try {
    const modal = page.locator(SELECTORS.cookieConsentModal).first();
    await modal.waitFor({ state: 'visible', timeout });
    console.log('[cookie] Consent modal appeared — dismissing...');

    // Click up to 3 times, since the brief says it sometimes needs 2-3 clicks.
    for (let i = 0; i < 3; i++) {
      const stillVisible = await modal.isVisible().catch(() => false);
      if (!stillVisible) break;
      const dismissBtn = page.locator(SELECTORS.cookieConsentDismissBtn).first();
      await dismissBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    console.log('[cookie] Consent modal dismissed (or no longer blocking).');
    return true;
  } catch {
    // Modal never appeared within the window — that's fine, it's random.
    return false;
  }
}

/**
 * The "Check today's price" button stays disabled until the site has seen
 * 8+ mousemove events AND a 600ms+ hover over the price area. This moves
 * the mouse in several small steps toward the panel (never one instant
 * jump), then holds there past 600ms.
 */
async function simulateGenuineMouseMovement(page) {
  const panel = page.locator(SELECTORS.pricePanel).first();
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  const box = await panel.boundingBox();
  if (!box) throw new Error('Price panel had no bounding box — selector likely wrong, verify SELECTORS.pricePanel.');

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;

  // Start from a plausible current position and step toward the target
  // in several small moves (>=8) rather than one jump.
  const steps = 10;
  const startX = Math.max(0, targetX - 250);
  const startY = Math.max(0, targetY - 150);

  await page.mouse.move(startX, startY);
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((targetX - startX) * i) / steps;
    const y = startY + ((targetY - startY) * i) / steps;
    await page.mouse.move(x, y, { steps: 3 });
    await page.waitForTimeout(60); // small human-like pause between moves
  }

  console.log(`[mouse] Simulated ${steps} mouse-move steps toward the price panel.`);

  // Now hold over the panel for 600ms+.
  await page.waitForTimeout(750);
  console.log('[mouse] Held hover over price panel for 750ms (>600ms threshold).');
}

/**
 * A few extra small mouse movements within the price panel, used when
 * polling for the behavioral gate to unlock (some runs need more than
 * one pass of movement before the button enables).
 */
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
    const jitterX = cx + (Math.random() - 0.5) * Math.min(40, box.width / 3);
    const jitterY = cy + (Math.random() - 0.5) * Math.min(20, box.height / 3);
    await page.mouse.move(jitterX, jitterY, { steps: 2 });
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
}

/**
 * Clicks "Check today's price" once it's enabled.
 */
async function clickCheckPrice(page) {
  const btn = page.locator(SELECTORS.checkPriceButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });

  // The behavioral gate (8+ mousemoves + 600ms+ hover) doesn't always
  // unlock on the first pass — poll for up to ~6s, doing extra small
  // mouse wiggles over the panel in between checks, before giving up.
  const gateDeadline = Date.now() + 6000;
  while (await btn.isDisabled().catch(() => true)) {
    if (Date.now() > gateDeadline) {
      console.log('[click] Button still disabled after extended mouse activity — giving up on this attempt.');
      break;
    }
    await wiggleOverPanel(page);
  }

  // Last-second check: the popup can appear mid-sequence (during the mouse
  // movement above), not just at page load, so check again right before
  // clicking.
  await dismissCookieConsentIfPresent(page, 800);

  try {
    await btn.click({ timeout: 5000 });
  } catch (err) {
    // If a click failed because the consent popup intercepted it (visible
    // in the error as "intercepts pointer events"), dismiss it and retry
    // the click once rather than treating this as a full failure.
    if (String(err.message).includes('intercepts pointer events')) {
      console.log('[cookie] Popup intercepted the click — dismissing and retrying click...');
      await dismissCookieConsentIfPresent(page, 2000);
      await btn.click({ timeout: 5000 });
    } else {
      throw err;
    }
  }
  console.log('[click] Clicked "Check today\'s price".');
}

/**
 * Waits for EITHER the success state or the error state to render —
 * never a fixed timer. Returns a structured result; never guesses or
 * fabricates price/stock.
 */
async function waitForPriceResult(page) {
  const success = page.locator(SELECTORS.priceSuccessState).first();
  const error = page.locator(SELECTORS.priceErrorState).first();

  const outcome = await Promise.race([
    success.waitFor({ state: 'visible', timeout: TIMEOUTS.priceResolve }).then(() => 'success'),
    error.waitFor({ state: 'visible', timeout: TIMEOUTS.priceResolve }).then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome === 'success') {
    // The "offer-ready" class can appear a beat before the price digits
    // (built span-by-span) finish rendering. Give it a moment, and retry
    // once if the price text is still empty.
    await page.waitForTimeout(300);
    let priceText = await page.locator(SELECTORS.priceValue).first().textContent().catch(() => null);
    if (!priceText) {
      await page.waitForTimeout(500);
      priceText = await page.locator(SELECTORS.priceValue).first().textContent().catch(() => null);
    }
    const stockPillText = await page.locator(SELECTORS.stockValue).first().textContent().catch(() => null);
    console.log(`[debug] raw priceText="${priceText}" raw stockPillText="${stockPillText}"`);
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

  // Neither state rendered in time — this is the ~35% "does nothing" case,
  // or a genuinely slow response beyond our wait window.
  return { outcome: 'failed', price: null, stock: null, detail: 'timed out waiting for success/error state' };
}

// ---------------------------------------------------------------------
// Retry configuration (Step 3)
// ---------------------------------------------------------------------
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000; // fixed delay between attempts

// ---------------------------------------------------------------------
// A single attempt: fresh navigation through the full sequence.
// Returns a result object, never throws (errors are caught and turned
// into a 'failed' outcome so the retry loop can decide what to do next).
// ---------------------------------------------------------------------
async function attemptScrape(page, url, attemptNumber) {
  console.log(`\n--- Attempt ${attemptNumber}/${MAX_ATTEMPTS} ---`);
  try {
    // page.goto() is INSIDE the try/catch — a navigation failure is a
    // legitimate failed attempt to retry, not a crash.
    console.log(`[nav] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const modalSeen = await dismissCookieConsentIfPresent(page);
    if (!modalSeen) console.log('[cookie] No consent modal appeared within the initial wait window — continuing.');
    await simulateGenuineMouseMovement(page);
    await clickCheckPrice(page);
    const result = await waitForPriceResult(page);

    // Never report 'success' with missing price/stock — that would
    // violate "never store wrong or empty data". If the ready state
    // showed but we couldn't actually read the numbers, treat it as a
    // failed attempt so the retry loop tries again.
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

// ---------------------------------------------------------------------
// Retry wrapper: tries attemptScrape up to MAX_ATTEMPTS times, stopping
// as soon as one succeeds. A fresh page navigation each attempt means we
// never risk reusing a stale price from an earlier failed attempt.
// ---------------------------------------------------------------------
async function scrapeWithRetries() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  const url = `${STORE_BASE_URL}${PRODUCT_PATH}`;
  const startedAt = new Date().toISOString();

    let finalResult = null;
  let attemptsUsed = 0;
  let dbWriteFailed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    const attemptTimestamp = new Date().toISOString();
    const result = await attemptScrape(page, url, attempt);
    const isLastAttempt = attempt === MAX_ATTEMPTS;

    if (result.outcome === 'success') {
      finalResult = result;
      console.log(`[retry] Succeeded on attempt ${attempt}/${MAX_ATTEMPTS}.`);
      try {
        await insertScrapeHistory({
          productId: TRACKED_PRODUCT_ID,
          timestamp: attemptTimestamp,
          price: result.price,
          stock: result.stock,
          outcome: 'success',
          detail: null,
        });
      } catch (dbErr) {
        console.error(`[db] WARNING: scrape succeeded but row was NOT stored: ${dbErr.message}`);
        dbWriteFailed = true;
      }
      break;
    }

    const rowOutcome = isLastAttempt ? 'failed' : 'retried';
    console.log(`[retry] Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${result.detail}`);
    finalResult = result;

    try {
      await insertScrapeHistory({
        productId: TRACKED_PRODUCT_ID,
        timestamp: attemptTimestamp,
        price: null,
        stock: null,
        outcome: rowOutcome,
        detail: result.detail,
      });
    } catch (dbErr) {
      console.error(`[db] WARNING: failed to store '${rowOutcome}' row: ${dbErr.message}`);
      dbWriteFailed = true;
    }

    if (!isLastAttempt) {
      console.log(`[retry] Waiting ${RETRY_DELAY_MS / 1000}s before retrying...`);
      await page.waitForTimeout(RETRY_DELAY_MS);
    }
  }

    const output = {
    url,
    timestamp: startedAt,
    attempts: attemptsUsed,
    outcome: finalResult.outcome,
    price: finalResult.price,
    stock: finalResult.stock,
    dbWriteFailed,
  };
  if (finalResult.outcome === 'failed') {
    output.detail = `${finalResult.detail} (failed after ${attemptsUsed} attempt${attemptsUsed > 1 ? 's' : ''})`;
  }

  console.log('\n=== FINAL SCRAPE RESULT ===');
  console.log(JSON.stringify(output, null, 2));

  if (!HEADLESS) {
    console.log('\n[pause] Leaving the browser open for 15s so you can inspect the DOM (F12) if needed...');
    await page.waitForTimeout(15000);
  }

  await browser.close();
  return output;
}

scrapeWithRetries().catch((err) => {
  console.error('Fatal error running scraper:', err);
  process.exit(1);
});
