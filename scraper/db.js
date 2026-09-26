/**
 * db.js — Supabase connection + one simple function to log a scrape attempt.
 *
 * Kept deliberately small: one client, one function. Everything else
 * (scrape.js) just calls insertScrapeHistory() and doesn't need to know
 * anything about Supabase itself.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Inserts one row into scrape_history. Called once per scrape ATTEMPT
 * (not just once per cycle) — so a cycle that retries twice before
 * succeeding writes 3 rows: two 'retried', one 'success'.
 */
export async function insertScrapeHistory({ productId, timestamp, price, stock, outcome, detail }) {
  const { error } = await supabase.from('scrape_history').insert({
    product_id: productId,
    timestamp,
    price,
    stock,
    outcome,
    detail,
  });

  if (error) {
    // THROW instead of just logging — a caller that only prints this and
    // moves on could end up reporting the scrape as fully successful even
    // though the row never made it into scrape_history. The caller must
    // decide what to do about a failed write, not have it hidden here.
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
  console.log(`[db] Logged scrape_history row (outcome: ${outcome})`);
}
