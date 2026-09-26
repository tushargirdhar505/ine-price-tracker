/**
 * run-headed.js — Headed mode runner for the INE Price Tracker scraper.
 *
 * Designed specifically for recording the 2-4 minute demonstration video
 * required by the assignment brief.
 *
 * Usage:
 *   node run-headed.js [/item/product_id] [option_label]
 *
 * Example:
 *   node run-headed.js /item/2095 "128 GB"
 */

import { scrapeProductWithRetries } from './scraper.js';

// Force headed mode
process.env.HEADLESS = 'false';

const productPath = process.argv[2] || '/item/2095';
const optionLabel = process.argv[3] || '128 GB';

console.log('====================================================');
console.log('🚀 INE Price Tracker — Headed Observable Run');
console.log(`Target Product Path : ${productPath}`);
console.log(`Target Option Label : ${optionLabel}`);
console.log('Browser Mode        : Visible (Headed Chromium)');
console.log('====================================================\n');

async function main() {
  const startTime = Date.now();

  try {
    const attempts = await scrapeProductWithRetries(productPath, optionLabel);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n====================================================');
    console.log(`🏁 Scraping Run Complete in ${duration}s`);
    console.log(`Total Attempts Logged : ${attempts.length}`);
    console.log('====================================================');

    attempts.forEach((att, idx) => {
      console.log(`\n[Attempt ${idx + 1}/${attempts.length}]`);
      console.log(`  Timestamp : ${att.timestamp}`);
      console.log(`  Outcome   : ${att.outcome.toUpperCase()}`);
      console.log(`  Price     : ${att.price !== null ? '₹' + att.price.toLocaleString('en-IN') : 'null'}`);
      console.log(`  Stock     : ${att.stock !== null ? att.stock + ' units' : 'null'}`);
      if (att.detail) {
        console.log(`  Detail    : ${att.detail}`);
      }
    });

    console.log('\n====================================================');
    console.log('✅ Final Result:');
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.outcome === 'success') {
      console.log(`🎉 Success! Price: ₹${lastAttempt.price.toLocaleString('en-IN')}, Stock: ${lastAttempt.stock}`);
    } else {
      console.log(`⚠️ Completed with status: ${lastAttempt.outcome} (${lastAttempt.detail})`);
    }
    console.log('====================================================\n');
  } catch (err) {
    console.error('Fatal error during headed run:', err);
  }
}

main();
