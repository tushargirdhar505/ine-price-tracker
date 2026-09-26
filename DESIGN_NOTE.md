# Engineering Design Note: INE Price Tracker

**Assignment**: Product Price Tracker (Web Scraping)  
**Author**: Tushar Girdhar  
**Target Mock Store**: [https://demo.inelabteamdev.com](https://demo.inelabteamdev.com)  

---

## 1. How Scraping Was Made Reliable

The INE mock storefront is deliberately engineered to frustrate conventional scraping through asynchronous content shifts, randomized DOM markup, synthetic anti-bot behavioral gates, and intentional error injection. Here is how each failure mode was countered:

### A. Behavioral Verification & The Unlock Gate
* **Challenge**: The "Check today's price" button remains disabled until the browser registers at least 8 `mousemove` events directed toward the price panel and maintains a continuous hover of >600ms.
* **Solution**: Rather than issuing an instantaneous cursor jump (`page.mouse.move(x, y)`), the scraper simulates human micro-trajectories over 10 intermediate interpolated steps with slight pacing pauses (60ms), ending with a deliberate 750ms dwell over `.offer-panel`. If the button remains disabled, an active "wiggle" algorithm produces subtle randomized jitter over the panel bounding box until the gate unlocks.

### B. Dynamic Cookie Consent Scrim (`.consent-scrim`)
* **Challenge**: An unannounced cookie consent overlay appears asynchronously after an arbitrary 1.5s–5s delay and intercepts click events, throwing `Target element intercepts pointer events`.
* **Solution**: Cookie dismissal is not treated as a one-time pageload check. A dedicated helper polls for `.consent-scrim` visibility, clicks the dismiss button up to 3 times, and is re-invoked immediately prior to clicking the price button. Additionally, if the price button click fails with a pointer intercept error, the scraper catches the error, re-dismisses the scrim, and retries the click automatically.

### C. DOM Tag Randomization & Value Assembly
* **Challenge**: The store alternates the HTML container wrapping the resolved price (`<output>`, `<b>`, etc.) across page loads, and assembles price digits character-by-character inside distinct `<span>` elements.
* **Solution**: Rather than selecting by tag name, the scraper matches on stable inline CSS styles: `.offer-row [style*="2.4rem"]`. Playwright's `textContent()` is utilized to extract and concatenate the span values, followed by regex sanitization (`/[^0-9.]/g`).

### D. Zero Stale or Partial Data Policy
* **Challenge**: The brief specifies: *"never silently stop or store incorrect data"* and *"never store wrong or empty data on failure"*.
* **Solution**: If the panel transitions to `.offer-ready` but price or stock extraction yields `null`, the run is marked as a failure rather than storing a half-empty success row. Stock parsing accurately distinguishes between `"Available (172)"` (numerical 172) and `"Sold out"` (explicit 0).

### E. Retry & State Recovery Loop
* Each product scrape executes up to 3 attempts.
* Every attempt performs a **fresh, isolated page navigation** (`page.goto`) rather than clicking "Retry" in a polluted DOM, ensuring no cached prices or stale closures leak between runs.
* Attempts 1 and 2 write rows with outcome `retried` and error detail. A failure on attempt 3 writes `failed`. Only an authenticated price/stock extraction writes `success`.

---

## 2. Architectural Trade-Offs

### A. Headless Browser (Playwright) vs. Lightweight HTTP Fetching
* **Trade-Off**: The assignment notes: *"Prefer lightweight HTTP fetching and HTML parsing where possible. Reach for a headless browser only where the page genuinely requires it."*
* **Decision**: We analyzed the mock store's network requests during price checking. The store requires client-side JavaScript execution to solve a proof-of-work (PoW) computation and monitors native DOM mouse events before dispatching the internal check. A plain HTTP fetch (e.g., `axios` + `cheerio`) cannot satisfy the client-side event gate or run the PoW script. Hence, **Playwright was strictly required and justified**.

### B. Free-Tier Scheduling Constraint & Webhook Timeout
* **Trade-Off**: Free-tier web hosts (Render) shut down after 15 minutes of inactivity and take ~50 seconds to wake up. External cron services like `cron-job.org` enforce a 30s timeout on free accounts.
* **Decision**:
  1. We configured a lightweight **Keep-Warm ping** hitting `GET /` every 10 minutes, eliminating cold starts completely.
  2. For the 2-hour scraper (`POST /api/scrape-all`), waiting synchronously for multiple Playwright launches across several products easily exceeds 30–60s. We engineered the endpoint to validate the secret and respond **immediately with `200 OK`**, dispatching the scraping cycle asynchronously in the background. Supabase reflects attempts in real-time as each product finishes.

---

## 3. AI Tools Disclosure: Errors on First Attempt & Corrections

In compliance with the assignment instructions (*"disclose how you used AI in the design note"*, *"explain what your AI tools got wrong on the first attempt and how you corrected it"*):

AI coding assistants were used to scaffold boilerplate, draft CSS, and generate initial selectors. Several critical assumptions made by AI tools were flawed on the first attempt and required manual diagnosis and correction:

1. **Catalog Search API Parameters**:
   * *AI Tool Mistake*: The AI initially generated `/api/search` by proxying directly to `https://demo.inelabteamdev.com/api/v2/listings?search=${query}`.
   * *Correction*: When tested against the live API, the store's endpoint ignored the `search` query parameter completely (it only supports `page` and `limit`). The AI's code returned identical results regardless of query. We corrected this by implementing server-side paginated retrieval (`page=1..10`), scanning through catalog items, and applying substring filtering in Node.js.
2. **Missing Docker Container Flags for Chromium**:
   * *AI Tool Mistake*: The initial Playwright launcher produced by AI was `chromium.launch({ headless: true })`.
   * *Correction*: Inside a Docker container on Linux (Render), Chromium crashed immediately with `Running as root without --no-sandbox is not supported` and ran out of shared memory. We diagnosed the container environment and added `--no-sandbox`, `--disable-setuid-sandbox`, and `--disable-dev-shm-usage`.
3. **Supabase WebSocket / Node Version Incompatibility**:
   * *AI Tool Mistake*: The AI used the standard Microsoft Playwright Jammy image with default Node 20.
   * *Correction*: `@supabase/supabase-js` v2.45+ crashed on boot with `Node.js detected but native WebSocket not found`. The AI did not account for the fact that Node 20 did not have native WebSocket enabled by default. We modified the Dockerfile to install Node 22 LTS from NodeSource and introduced the `ws` polyfill fallback.
4. **Synchronous Cron Request Timeouts**:
   * *AI Tool Mistake*: The AI initially wrote `app.post('/api/scrape-all')` to `await` every product sequentially before sending `res.json(...)`.
   * *Correction*: In real runs with 3 products, the endpoint took ~45 seconds, causing `cron-job.org` to flag the cron job as `Failed (timeout)`. We restructured the route to return an instant `200 OK` acknowledgment while executing the scrape batch in the background.
