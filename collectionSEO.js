/**
 * collectionSEO.js
 * Optimizes all Shopify collections for Nova Mart.
 * Runs nightly via GitHub Actions (or manually).
 *
 * WHAT IT DOES (per collection):
 *  - Meta Title    : keyword-rich, ends with "| Nova Mart", max 60 chars
 *  - Meta Desc     : 140-160 chars, ends with "Free Delivery at Nova Mart!"
 *  - Body HTML     : 400+ word collection description, Nova Mart voice
 *  - URL Handle    : clean lowercase-hyphen slug, max 60 chars
 *
 * KEY STRATEGY: apiManager.js handles all rotation automatically.
 *   Gemini Key1→2→3→4 → Groq Key1→2→3→4 → DeepSeek Key1→2→3
 *   TOTAL ≈ 78,600 requests/day FREE
 *
 * PROGRESS: saved to collection-progress.json — safe to stop/resume.
 * USAGE:
 *   node collectionSEO.js                          ← all collections
 *   node collectionSEO.js --id=123456789           ← single collection
 *   node collectionSEO.js --reset                  ← clear progress & restart
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');

// ─── API Manager (handles all key rotation) ────────────────────────────────
const { callAIJson, verifyAllKeys, hasCapacity, getStatus } = require('./apiManager');

// ─── Store + Auth ──────────────────────────────────────────────────────────
const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Run Settings ──────────────────────────────────────────────────────────
const MAX_RUN_MINUTES = 300;
const RUN_START_TIME  = Date.now();
const REOPTIMIZE_DAYS = 60;   // re-optimize a collection after this many days

// ─── Banned words ───────────────────────────────────────────────────────────
const BANNED_WORDS = /\b(Experience|Enjoy|Amazing|Best|Quality|Perfect|Discover)\b/gi;

// ─── File paths ────────────────────────────────────────────────────────────
const PROGRESS_FILE = './collection-progress.json';

// ─── Shopify client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// PROGRESS
// ══════════════════════════════════════════════════════════════════════════

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { completed: {}, lastRun: null };
  // completed: { [collectionId]: isoDateString }
}

function saveProgress(p) {
  p.lastRun = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function daysSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function enforceMetaTitle(text) {
  const suffix = ' | Nova Mart';
  // Strip any existing suffix variant then reapply cleanly
  text = text.replace(/\s*\|.*$/, '').trim();
  if ((text + suffix).length > 60) {
    text = text.slice(0, 60 - suffix.length).replace(/\s+\S*$/, '').trim();
  }
  return text + suffix;
}

function enforceMetaDesc(text) {
  const cta = 'Free Delivery at Nova Mart!';
  // Remove existing CTA if present, then re-append cleanly
  text = text.replace(cta, '').replace(/[.!\s]+$/, '').trim();
  const candidate = text + '. ' + cta;
  if (candidate.length > 160) {
    text = text.slice(0, 160 - cta.length - 2).replace(/\s+\S*$/, '').trim();
  }
  let result = text + '. ' + cta;
  // Pad if too short
  if (result.length < 140) {
    const pads = [
      ' Trusted by thousands of Nova Mart shoppers.',
      ' Top-rated and in stock now.',
      ' Ships fast across Pakistan.',
      ' Premium picks at unbeatable value.',
    ];
    for (const p of pads) {
      const candidate2 = text + p + ' ' + cta;
      if (candidate2.length >= 140 && candidate2.length <= 160) { result = candidate2; break; }
    }
  }
  return result;
}

function cleanBodyHtml(html) {
  let body = html.trim();
  if (BANNED_WORDS.test(body)) {
    body = body
      .replace(BANNED_WORDS, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .replace(/<(\w+)>\s+/g, '<$1>')
      .trim();
  }
  BANNED_WORDS.lastIndex = 0;
  return body;
}

function cleanHandle(raw) {
  return raw.trim()
    .replace(/^\/collections\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDER
// ══════════════════════════════════════════════════════════════════════════

function buildCollectionPrompt(collection) {
  const existingDesc = (collection.body_html || '')
    .replace(/<[^>]*>/g, '')
    .slice(0, 300)
    .trim();

  return `You are an expert SEO copywriter for Nova Mart, a Pakistani e-commerce store.
Generate ALL 4 SEO fields for this Shopify COLLECTION in ONE JSON response.

Collection name : ${collection.title}
Collection type : ${collection.collection_type || 'custom'}
Existing description (if any): ${existingDesc || 'none'}

IMPORTANT: Return ONLY valid JSON. No markdown, no backticks, no explanation.
Use this exact structure:
{
  "metaTitle": "...",
  "metaDesc": "...",
  "bodyHtml": "...",
  "urlHandle": "..."
}

━━━ FIELD RULES ━━━

META TITLE (metaTitle):
- Pattern: [Collection Name] – [Category Keyword] | Nova Mart
- Under 60 characters HARD LIMIT including "| Nova Mart"
- Must always end with exactly: | Nova Mart
- Examples:
    Men's Shoes – Sneakers & Formal | Nova Mart
    Baby Products – Diapers & Toys | Nova Mart
    Tech Gadgets – Smart Devices | Nova Mart

META DESCRIPTION (metaDesc):
- 140–160 characters exactly
- Pattern: What the collection contains + who it's for + "Free Delivery at Nova Mart!"
- Must end with: Free Delivery at Nova Mart!
- Never start with: Experience, Enjoy, Discover
- Never use: Amazing, Best, Quality, Perfect
- No quotes anywhere
- Examples:
    Shop Nova Mart's full range of baby essentials — diapers, prams, toys and more. Free Delivery at Nova Mart!
    Browse our curated tech gadgets collection — earbuds, chargers, smart devices and more. Free Delivery at Nova Mart!

BODY HTML (bodyHtml):
- Minimum 400 words, Nova Mart voice: confident, minimalist, helpful
- NO banned words: Experience, Enjoy, Amazing, Best, Quality, Perfect, Discover
- Structure (in this exact order):
  <h2>[Collection Name] at Nova Mart</h2>
  <p>[2-3 sentence intro about what this collection contains and who it serves]</p>
  <h2>What You'll Find Here</h2>
  <ul>
    <li><b>[Sub-category 1]:</b> [1 sentence about it]</li>
    <li><b>[Sub-category 2]:</b> [1 sentence about it]</li>
    <li><b>[Sub-category 3]:</b> [1 sentence about it]</li>
    <li><b>[Sub-category 4]:</b> [1 sentence about it]</li>
    <li><b>[Sub-category 5]:</b> [1 sentence about it]</li>
  </ul>
  <h2>Why Shop This Collection at Nova Mart</h2>
  <p>[2-3 sentences about Nova Mart's value — free delivery, range, reliability]</p>
  <h2>Frequently Asked Questions</h2>
  <details><summary>[relevant question about this category]</summary><p>[answer]</p></details>
  <details><summary>Do you offer free delivery on these products?</summary><p>Yes — Nova Mart offers free delivery across Pakistan on all orders.</p></details>
  <details><summary>[another relevant question]</summary><p>[answer]</p></details>
- Escape all HTML properly for JSON (use \\n for newlines inside the string)

URL HANDLE (urlHandle):
- lowercase-hyphens-only, no /collections/ prefix, max 60 chars
- Pattern: collection-name-category-keyword
- Examples: baby-products-diapers-toys | tech-gadgets-smart-devices | mens-shoes-sneakers`;
}

// ══════════════════════════════════════════════════════════════════════════
// SHOPIFY HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function getAllCollections() {
  const all = [];

  for (const type of ['custom', 'smart']) {
    let url = `/${type}_collections.json?limit=250&fields=id,title,handle,body_html,collection_type,published_at`;
    while (url) {
      const res = await shopify.get(url);
      const key = type === 'custom' ? 'custom_collections' : 'smart_collections';
      const items = res.data[key] || [];
      items.forEach(c => { c.collection_type = type; });
      all.push(...items);

      const link = res.headers['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      if (next) {
        const parsed = new URL(next[1]);
        url = parsed.pathname.replace('/admin/api/2024-01', '') + parsed.search;
      } else { url = null; }
    }
  }

  return all;
}

async function saveCollectionSEO(collection, fields) {
  const type      = collection.collection_type;
  const endpoint  = `/${type}_collections/${collection.id}.json`;
  const bodyKey   = type === 'custom' ? 'custom_collection' : 'smart_collection';

  const updates = {};
  if (fields.metaTitle)  updates.metafields_global_title_tag       = fields.metaTitle;
  if (fields.metaDesc)   updates.metafields_global_description_tag = fields.metaDesc;
  if (fields.bodyHtml)   updates.body_html                         = fields.bodyHtml;
  if (fields.urlHandle)  updates.handle                            = fields.urlHandle;

  await shopify.put(endpoint, {
    [bodyKey]: { id: collection.id, ...updates }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS ONE COLLECTION
// ══════════════════════════════════════════════════════════════════════════

async function applyCollectionSEO(collection) {
  console.log(`\n🗂️  ${collection.title}  [${collection.collection_type}]`);

  const prompt = buildCollectionPrompt(collection);
  console.log('   [BATCH] Generating all 4 fields in one call...');

  const result = await callAIJson(prompt);

  if (!result) {
    console.log('   ❌ AI generation failed — will retry next run');
    return false;
  }

  const batch  = result.data;
  const engine = result.keyLabel;

  if (!batch) {
    console.log(`   ⚠️  Could not parse JSON from ${engine} — skipping`);
    return false;
  }

  console.log(`   ✅ Batch received from ${engine}`);

  const fields = {};

  if (batch.metaTitle) {
    fields.metaTitle = enforceMetaTitle(batch.metaTitle.trim());
    console.log(`   ✅ Meta Title : ${fields.metaTitle}  (${fields.metaTitle.length} chars)`);
  } else {
    console.log('   ⚠️  Meta Title missing');
  }

  if (batch.metaDesc) {
    fields.metaDesc = enforceMetaDesc(batch.metaDesc.trim());
    console.log(`   ✅ Meta Desc  : ${fields.metaDesc.length} chars`);
  } else {
    console.log('   ⚠️  Meta Desc missing');
  }

  if (batch.bodyHtml) {
    fields.bodyHtml = cleanBodyHtml(batch.bodyHtml);
    console.log(`   ✅ Body HTML  : ${fields.bodyHtml.length} chars`);
  } else {
    console.log('   ⚠️  Body HTML missing');
  }

  if (batch.urlHandle) {
    fields.urlHandle = cleanHandle(batch.urlHandle);
    console.log(`   ✅ URL Handle : /collections/${fields.urlHandle}`);
  } else {
    console.log('   ⚠️  URL Handle missing');
  }

  if (Object.keys(fields).length === 0) {
    console.log('   ❌ No valid fields — skipping Shopify save');
    return false;
  }

  try {
    await saveCollectionSEO(collection, fields);
    console.log('   ✅ Saved to Shopify');
  } catch (err) {
    console.error(`   ❌ Shopify save error: ${err.message}`);
    return false;
  }

  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// SINGLE COLLECTION MODE
// ══════════════════════════════════════════════════════════════════════════

async function runSingleCollection(collectionId) {
  console.log('\n🎯 Nova Mart Collection SEO — Single Mode');
  console.log('   Strategy: Gemini Key1→2→3→4 → Groq Key1→2→3→4 → DeepSeek Key1→2→3');
  console.log('='.repeat(55));

  await verifyAllKeys();

  // Try custom first, then smart
  let collection = null;
  for (const type of ['custom', 'smart']) {
    try {
      const key = type === 'custom' ? 'custom_collection' : 'smart_collection';
      const res = await shopify.get(`/${type}_collections/${collectionId}.json`);
      collection = res.data[key];
      collection.collection_type = type;
      break;
    } catch (err) {
      if (err.response?.status !== 404) throw err;
    }
  }

  if (!collection) {
    console.error(`❌ Collection ${collectionId} not found`);
    process.exit(1);
  }

  console.log(`✅ Found: "${collection.title}" [${collection.collection_type}]\n`);
  const success = await applyCollectionSEO(collection);

  console.log('\n' + '='.repeat(55));
  console.log(success ? '✅ Done — all fields saved to Shopify.' : '❌ Failed — check errors above.');
  console.log(getStatus());
  console.log('='.repeat(55));
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── Reset flag ──────────────────────────────────────────────────────────
  if (process.argv.includes('--reset')) {
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
    console.log('🔄 Progress reset. Starting fresh.');
  }

  // ── Single collection mode ──────────────────────────────────────────────
  const idArg = process.argv.find(a => a.startsWith('--id='));
  if (idArg) {
    const collectionId = idArg.split('=')[1];
    if (!collectionId) { console.error('❌ Usage: node collectionSEO.js --id=<collectionId>'); process.exit(1); }
    return runSingleCollection(collectionId);
  }

  // ── Full run ────────────────────────────────────────────────────────────
  console.log('\n🚀 Nova Mart Collection SEO — Nightly Run');
  console.log('   Strategy: Gemini Key1→2→3→4 → Groq Key1→2→3→4 → DeepSeek Key1→2→3');
  console.log('   Fields  : Meta Title + Meta Desc + Body HTML + URL Handle');
  console.log('   Re-optimize after: ' + REOPTIMIZE_DAYS + ' days');
  console.log('='.repeat(55));

  await verifyAllKeys();

  const progress    = loadProgress();
  const collections = await getAllCollections();

  console.log(`\n🗂️  Total collections : ${collections.length}`);
  console.log(`✅ Already done      : ${Object.keys(progress.completed).length}`);

  // Determine which need processing
  const toProcess = collections.filter(c => {
    const lastDone = progress.completed[c.id];
    if (!lastDone) return true; // never done
    if (daysSince(lastDone) >= REOPTIMIZE_DAYS) return true; // stale
    return false;
  });

  const skipped = collections.length - toProcess.length;
  console.log(`⏭️  Skipped (fresh)   : ${skipped}`);
  console.log(`📋 To process        : ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log('✅ All collections are up to date. Nothing to do.');
    console.log(getStatus());
    return;
  }

  let doneThisSession = 0;
  let failedThisSession = 0;

  for (const collection of toProcess) {
    if (!hasCapacity()) {
      console.log('\n🛑 All API limits reached — saving progress.');
      break;
    }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) {
      console.log('\n⏱️  Time limit reached.');
      break;
    }

    const success = await applyCollectionSEO(collection);

    if (success) {
      progress.completed[collection.id] = new Date().toISOString();
      doneThisSession++;
    } else {
      failedThisSession++;
    }

    saveProgress(progress);
    console.log(`   📊 Tonight: ${doneThisSession} done | ${failedThisSession} failed | ${toProcess.length - doneThisSession - failedThisSession} remaining`);

    await wait(500); // small gap between collections
  }

  const remaining = toProcess.length - doneThisSession - failedThisSession;
  console.log('\n' + '='.repeat(55));
  console.log(`✅ Done tonight      : ${doneThisSession}`);
  console.log(`❌ Failed            : ${failedThisSession}`);
  if (remaining > 0) console.log(`▶️  Remaining        : ${remaining} — resuming tomorrow`);
  console.log(getStatus());
  console.log('='.repeat(55));
}

main().catch(err => {
  console.error('❌ collectionSEO crashed:', err.message);
  process.exit(1);
});