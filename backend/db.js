/**
 * db.js — All Supabase queries the backend needs, one small function each.
 *
 * Same pattern as the scraper's db.js: a single client, plain functions,
 * no ORM magic — easy to point at and explain in an interview.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- tracked_products ----

export async function insertTrackedProduct({ storeProductId, productName, optionId, optionLabel }) {
  const { data, error } = await supabase
    .from('tracked_products')
    .insert({ store_product_id: storeProductId, product_name: productName, option_id: optionId, option_label: optionLabel })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getTrackedProducts() {
  const { data, error } = await supabase
    .from('tracked_products')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ---- scrape_history ----

export async function insertScrapeHistory({ productId, timestamp, price, stock, outcome, detail }) {
  const { error } = await supabase
    .from('scrape_history')
    .insert({ product_id: productId, timestamp, price, stock, outcome, detail });
  if (error) throw error;
}

export async function getProductHistory(productId) {
  const { data, error } = await supabase
    .from('scrape_history')
    .select('*')
    .eq('product_id', productId)
    .order('timestamp', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Every scrape_history row joined with its product's identifying info —
 * exactly what the CSV export needs, in one query.
 */
export async function getFullHistoryForExport() {
  const { data, error } = await supabase
    .from('scrape_history')
    .select('timestamp, price, stock, outcome, detail, tracked_products(store_product_id, product_name, option_label)')
    .order('timestamp', { ascending: false });
  if (error) throw error;
  return data;
}
