/**
 * seoPatterns.js
 * Runs nightly at 2am via GitHub Actions.
 *
 * BATCH MODE: all 8 fields in ONE API call per product.
 * KEY STRATEGY: Managed entirely by apiManager.js
 *   Gemini  — 4 keys × 1,500 req/day  = 6,000/day
 *   Groq    — 4 keys × 14,400 req/day = 57,600/day
 *   DeepSeek— 3 keys × ~5,000 req/day = 15,000/day
 *   TOTAL   ≈ 78,600 requests/day FREE
 *
 * FIXES:
 *  - Now uses apiManager.js for all key rotation (all 11 keys active).
 *  - 429 / 503 / RESOURCE_EXHAUSTED (per-minute) are TEMPORARY → retry, never kill key.
 *  - Only an explicit "per day / daily" quota message marks a key exhausted.
 *  - Counter increments only on SUCCESS (quota never wasted on failures).
 *  - Body HTML cleaned: stray intro paragraph removed, banned words stripped.
 */

require('dotenv').config();

const axios  = require('axios');
const fs     = require('fs');

// ─── API Manager — all key rotation handled here ───────────────────────────
const { callAIJson, verifyAllKeys, getStatus, hasCapacity } = require('./apiManager');

// ─── Store + Auth ──────────────────────────────────────────────────────────
const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Limits ────────────────────────────────────────────────────────────────
const MAX_RUN_MINUTES = 320;
const RUN_START_TIME  = Date.now();

// ─── Banned words ───────────────────────────────────────────────────────────
const BANNED_WORDS = /\b(Experience|Enjoy|Amazing|Best|Quality|Perfect|Discover)\b/gi;

// ─── Cooldown / Tier settings ──────────────────────────────────────────────
const COOLDOWN_DAYS        = 45;
const TIER1_LOCK_DAYS      = 60;
const TIER1_TAG            = 'seo-tier1';
const POLLANDFIX_LOCK_DAYS = 45;

// ─── Theme templates ──────────────────────────────────────────────────────
const THEME_TEMPLATES = {
  'tech-product':      'electronics, gadgets, appliances, vacuum cleaners, audio, earbuds, headphones, cameras, computers, smart devices, chargers, cables, power banks, speakers, keyboards, mice, monitors, printers, routers',
  'fashion-product':   'clothing, apparel, shirts, pants, dresses, shoes, footwear, handbags, jewellery, watches, sunglasses, belts, scarves, caps, hats, wallets, purses',
  'pet-products-page': 'pet food, cat litter, dog accessories, pet toys, pet grooming, aquarium, bird feeders, pet beds, leashes, collars',
  'baby-product-page': 'baby clothes, diapers, prams, strollers, baby toys, infant formula, nursery items, baby bottles, baby monitors',
  'toys':              'toys, games, puzzles, board games, action figures, kids play sets, remote control cars, lego, building blocks, dolls',
  'product':           'default fallback — luggage, travel bags, trolley cases, suitcases, backpacks, home decor, kitchen items, furniture, sports equipment, books',
};

// ─── File paths ────────────────────────────────────────────────────────────
const PROGRESS_FILE = './progress.json';

// ─── Shopify client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

// ══════════════════════════════════════════════════════════════════════════
// PROGRESS
// ══════════════════════════════════════════════════════════════════════════

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (!data.phase) data.phase = 'baseline';
      return data;
    }
  } catch (e) {}
  return {
    phase:              'baseline',
    cooldown_until:     null,
    baseline_complete:  false,
    completed:          [],
    tier_last_seo:      {},
    pollandfix_touched: {},
  };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════

function shortenTitle(title, maxChars) {
  if (title.length <= maxChars) return title;
  const fillers = [/\bwith\b/gi, /\bfor\b/gi, /\band\b/gi, /\bthe\b/gi, /\bof\b/gi, /\bin\b/gi, /\ba\b/gi, /\ban\b/gi];
  let shortened = title;
  for (const filler of fillers) {
    if (shortened.length <= maxChars) break;
    shortened = shortened.replace(filler, '').replace(/\s+/g, ' ').trim();
  }
  if (shortened.length > maxChars) shortened = shortened.slice(0, maxChars).replace(/\s+\S*$/, '').trim();
  return shortened;
}

function enforceMetaTitle(text) {
  const suffix = ' | Nova Mart';
  if (!text.includes('| Nova Mart')) text = text.replace(/\|.*$/, '').trim() + suffix;
  if (text.length > 60) {
    const withoutSuffix = text.replace(suffix, '').trim();
    const trimmed = withoutSuffix.slice(0, 60 - suffix.length).replace(/\s+\S*$/, '').trim();
    text = trimmed + suffix;
  }
  return text;
}

function enforceMetaDesc(text) {
  const cta = 'Free Delivery at Nova Mart!';
  if (!text.includes(cta)) text = text.replace(/[.!]$/, '') + '. ' + cta;
  if (text.length > 160) {
    const withoutCta = text.replace(cta, '').trim().replace(/[.,!]$/, '');
    text = withoutCta.slice(0, 160 - cta.length - 1).replace(/\s+\S*$/, '').trim() + ' ' + cta;
  }
  if (text.length < 140) {
    const pads = [
      ' Trusted by thousands of Nova Mart shoppers.',
      ' Top-rated and in stock now.',
      ' Ships fast across Pakistan.',
      ' Premium pick at an unbeatable value.',
    ];
    for (const p of pads) {
      const withoutCta = text.replace(' ' + cta, '').replace(cta, '').trim().replace(/[.,!]$/, '');
      const candidate  = withoutCta + p + ' ' + cta;
      if (candidate.length >= 140 && candidate.length <= 160) { text = candidate; break; }
    }
  }
  return text;
}

function cleanBodyHtml(html) {
  let body = html.trim();
  const hookIndex = body.search(/<p>\s*<em>/i);
  if (hookIndex > 0) {
    console.log('   ✂️  Removed stray intro paragraph before the <em> hook');
    body = body.slice(hookIndex);
  }
  if (BANNED_WORDS.test(body)) {
    console.log('   ✂️  Removed banned words from body');
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

// ══════════════════════════════════════════════════════════════════════════
// BATCH PROMPT
// ══════════════════════════════════════════════════════════════════════════

function buildBatchPrompt(product) {
  const desc      = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 500) || '';
  const shortName = shortenTitle(product.title, 40);
  const templates = Object.keys(THEME_TEMPLATES).join(' | ');

  return `You are an expert SEO copywriter for Nova Mart, a Pakistani e-commerce store.
Generate ALL 8 SEO fields for this product in ONE JSON response.

Product name : ${product.title}
Short name   : ${shortName}
Description  : ${desc}

IMPORTANT: Return ONLY valid JSON. No markdown, no backticks, no explanation.
Escape all special characters inside string values properly.
Use this exact structure:
{
  "h1": "...",
  "metaTitle": "...",
  "metaDesc": "...",
  "bodyHtml": "...",
  "tags": "tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8",
  "urlHandle": "...",
  "techSummary": "...",
  "template": "..."
}

━━━ FIELD RULES ━━━

H1 (h1):
- Pattern: [Short Product Name] – [Key Feature] [Size if fits]
- Under 70 characters hard limit
- No quotes, no punctuation at end
- Examples: Pet Shaver – Stainless Steel Blades 1-Piece | Iron Man ANC Earbuds – HiFi 13mm Drivers

META TITLE (metaTitle):
- Pattern: [Short Name] – [Specific Spec] | Nova Mart
- Under 60 characters hard limit including "| Nova Mart"
- Must always end with exactly: | Nova Mart
- Real numbers/units preferred: 100ml, 13mm, 500W, 30L
- Examples: Pet Shaver – Stainless Steel | Nova Mart | Cordless Vacuum – 55Kpa 500W | Nova Mart

META DESCRIPTION (metaDesc):
- Emotional hook + 2 specific specs + "Free Delivery at Nova Mart!"
- Between 140 and 160 characters exactly
- Must end with: Free Delivery at Nova Mart!
- No quotes anywhere in the text
- Never start with: Experience, Enjoy, Discover
- Never use: Amazing, Best, Quality, Perfect

BODY HTML (bodyHtml):
- Minimum 800 words, Nova Mart voice: sophisticated, minimalist, confident
- The VERY FIRST element MUST be <p><em>hook</em></p>. Do NOT write ANY intro
  paragraph, sentence, or text before this hook. The hook is always first.
- Escape all HTML properly for JSON (use \\n for newlines inside the JSON string)
- Structure (in this exact order):
  <p><em>[punchy 8-12 word hook]</em></p>
  <h2>Key Features</h2><ul><li><b>Feature:</b> detail</li>x5-7</ul>
  <h2>Why It Works For You</h2><p>3-4 sentences to customer</p>
  <h2>What Makes Nova Mart Different</h2><p>2-3 sentences, mention free delivery</p>
  <h2>Technical Specifications</h2><table><tr><th>Specification</th><th>Details</th></tr>x5-8 rows</table>
  <h2>Frequently Asked Questions</h2>
  <details><summary>question</summary><p>answer</p></details> x3
- FORBIDDEN WORDS anywhere in the body: Experience, Enjoy, Amazing, Best, Quality,
  Perfect, Discover. Never use any of them. Output is invalid if you do.

TAGS (tags):
- 8-10 comma-separated lowercase SEO tags, each under 25 chars
- Mix: product type, material, feature, use case, audience

URL HANDLE (urlHandle):
- lowercase-hyphens-only, no /products/ prefix, max 60 chars
- Pattern: product-name-key-feature-size
- Examples: pet-shaver-stainless-1-piece | cordless-vacuum-55kpa-500w

TECH SHORT SUMMARY (techSummary):
- Exactly: Spec1 • Spec2 • Spec3
- Real numbers and units, each spec under 20 chars, total under 80 chars
- Examples: 500W Motor • 55Kpa Suction • HEPA Filter | 13mm HiFi Drivers • ANC • 15H Battery

TEMPLATE (template):
- Pick ONE from: ${templates}
- Luggage, suitcases, trolley cases, travel bags → always: product
- Only pick specific template if very confident it matches
- Return exact template name only, nothing else`;
}

// ══════════════════════════════════════════════════════════════════════════
// SHOPIFY HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function saveMetafield(productId, namespace, mfKey, value) {
  try {
    const res      = await shopify.get(`/products/${productId}/metafields.json`);
    const existing = res.data.metafields.find(m => m.namespace === namespace && m.key === mfKey);
    if (existing) {
      await shopify.put(`/products/${productId}/metafields/${existing.id}.json`, {
        metafield: { id: existing.id, value, type: 'single_line_text_field' }
      });
    } else {
      await shopify.post(`/products/${productId}/metafields.json`, {
        metafield: { namespace, key: mfKey, value, type: 'single_line_text_field' }
      });
    }
  } catch (err) {
    console.error(`   ❌ Metafield (${namespace}.${mfKey}) error: ${err.message}`);
  }
}

async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle,body_html,tags,images,variants,product_type';
  while (url) {
    const res  = await shopify.get(url);
    products   = [...products, ...res.data.products];
    const link = res.headers['link'];
    if (link?.includes('rel="next"')) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
    } else { url = null; }
  }
  return products;
}

// ══════════════════════════════════════════════════════════════════════════
// TIER HELPERS
// ══════════════════════════════════════════════════════════════════════════

function isTier1(product) {
  return (product.tags || '').split(',').map(t => t.trim().toLowerCase()).includes(TIER1_TAG);
}

function daysSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

function shouldSkip(product, progress) {
  if (isTier1(product)) {
    const lastSeo = progress.tier_last_seo[product.id];
    if (!lastSeo || daysSince(lastSeo) < TIER1_LOCK_DAYS) return `Tier 1 lock (${TIER1_LOCK_DAYS}d)`;
  }
  const pfDate = progress.pollandfix_touched?.[product.id];
  if (pfDate && daysSince(pfDate) < POLLANDFIX_LOCK_DAYS)
    return `pollAndFix lock (${Math.round(POLLANDFIX_LOCK_DAYS - daysSince(pfDate))}d left)`;
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// APPLY BATCH TO SHOPIFY — shared by all modes
// ══════════════════════════════════════════════════════════════════════════

async function processBatch(batch, product, keyLabel) {
  console.log(`   ✅ Batch received from ${keyLabel}`);

  const updates = {};

  if (batch.h1) {
    let h1 = batch.h1.trim();
    if (h1.length > 70) h1 = h1.slice(0, 70).replace(/\s+\S*$/, '').trim();
    console.log(`   ✅ H1: ${h1}  (${h1.length} chars)`);
    updates.title = h1;
  } else console.log('   ⚠️  H1 missing');

  if (batch.metaTitle) {
    const mt = enforceMetaTitle(batch.metaTitle.trim());
    console.log(`   ✅ Meta Title: ${mt}  (${mt.length} chars)`);
    await saveMetafield(product.id, 'global', 'title_tag', mt);
  } else console.log('   ⚠️  Meta Title missing');

  if (batch.metaDesc) {
    const md = enforceMetaDesc(batch.metaDesc.trim());
    console.log(`   ✅ Meta Desc: ${md.length} chars`);
    await saveMetafield(product.id, 'global', 'description_tag', md);
  } else console.log('   ⚠️  Meta Desc missing');

  if (batch.bodyHtml) {
    const body = cleanBodyHtml(batch.bodyHtml);
    console.log(`   ✅ Body HTML: ${body.length} chars`);
    updates.body_html = body;
  } else console.log('   ⚠️  Body HTML missing');

  if (batch.tags) {
    const tagArr = batch.tags.split(',').map(t => t.trim()).filter(Boolean);
    console.log(`   ✅ Tags: ${tagArr.join(', ')}`);
    updates.tags = tagArr.join(', ');
  } else console.log('   ⚠️  Tags missing');

  if (batch.urlHandle) {
    const cleanUrl = batch.urlHandle.trim()
      .replace(/^\/products\//, '').toLowerCase()
      .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 60);
    console.log(`   ✅ URL: /products/${cleanUrl}`);
    updates.handle = cleanUrl;
  } else console.log('   ⚠️  URL missing');

  if (batch.techSummary) {
    console.log(`   ✅ Tech Summary: ${batch.techSummary}`);
    await saveMetafield(product.id, 'custom', 'tech_short_summary', batch.techSummary.trim());
  } else console.log('   ⚠️  Tech Summary missing');

  if (batch.template) {
    const valid   = Object.keys(THEME_TEMPLATES);
    const matched = valid.find(t => t === batch.template.trim().toLowerCase()) || 'product';
    console.log(`   ✅ Template: ${matched}`);
    updates.template_suffix = matched === 'product' ? '' : matched;
  } else console.log('   ⚠️  Template missing');

  if (Object.keys(updates).length > 0) {
    await shopify.put(`/products/${product.id}.json`, { product: { id: product.id, ...updates } });
    console.log('   ✅ Saved to Shopify');
  }

  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS ONE PRODUCT
// ══════════════════════════════════════════════════════════════════════════

async function applyPatterns(product) {
  console.log(`\n🔧 ${product.title}`);
  console.log(getStatus());

  const prompt = buildBatchPrompt(product);
  console.log('   [BATCH] Generating all 8 fields in one call...');

  // callAIJson routes: Gemini (4 keys) → Groq (4 keys) → DeepSeek (3 keys)
  const aiResult = await callAIJson(prompt);

  if (!aiResult) {
    console.log('   ❌ AI generation failed for this product — will retry next run');
    return false;
  }

  return processBatch(aiResult.data, product, aiResult.keyLabel);
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE RUNNERS
// ══════════════════════════════════════════════════════════════════════════

async function runBaseline(progress, products) {
  console.log('\n⚡ PHASE 1 — BASELINE RUN');
  console.log(`   Goal : optimize all ${products.length} products once`);
  console.log(`   Mode : BATCH — 1 API call per product`);
  console.log(`   Budget: ~78,600 requests/day across all 11 keys`);
  console.log('='.repeat(55));

  const remaining = products.filter(p => !progress.completed.includes(p.id));
  if (remaining.length === 0) {
    console.log('\n🎉 Baseline complete! Triggering 45-day cooldown...');
    progress.phase            = 'cooldown';
    progress.baseline_complete = true;
    progress.cooldown_until   = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    saveProgress(progress);
    console.log(`🔒 Cooldown until: ${progress.cooldown_until}`);
    return;
  }

  console.log(`\n📦 Total   : ${products.length}`);
  console.log(`✅ Done    : ${progress.completed.length}`);
  console.log(`📋 Tonight : up to ${remaining.length} remaining\n`);

  let doneThisSession = 0;
  for (const product of remaining) {
    if (!hasCapacity()) { console.log('\n🛑 All API limits reached — saving progress.'); break; }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) { console.log('\n⏱️  Time limit reached.'); break; }

    const success = await applyPatterns(product);
    if (success) { progress.completed.push(product.id); doneThisSession++; }
    saveProgress(progress);
    console.log(`   📊 Tonight: ${doneThisSession} | Baseline: ${progress.completed.length}/${products.length}`);
  }

  if (products.every(p => progress.completed.includes(p.id))) {
    console.log('\n🎉 Baseline complete! Triggering 45-day cooldown...');
    progress.phase            = 'cooldown';
    progress.baseline_complete = true;
    progress.cooldown_until   = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    saveProgress(progress);
    console.log(`🔒 Cooldown until: ${progress.cooldown_until}`);
  } else {
    const left = products.filter(p => !progress.completed.includes(p.id)).length;
    console.log(`\n▶️  ${left} products left — resuming tomorrow.`);
  }
  console.log(`\n📦 Done tonight: ${doneThisSession}`);
}

async function runCooldown(progress) {
  const until    = new Date(progress.cooldown_until);
  const daysLeft = Math.ceil((until - Date.now()) / (1000 * 60 * 60 * 24));
  if (Date.now() < until) {
    console.log('\n🔒 PHASE 2 — COOLDOWN ACTIVE');
    console.log(`   Ends: ${until.toDateString()} | Days left: ${daysLeft}`);
    console.log('   ✅ No changes. New products handled by pollAndFix.js.');
    return;
  }
  console.log('\n✅ Cooldown complete! Moving to Tier Mode...');
  progress.phase          = 'tier';
  progress.cooldown_until = null;
  progress.completed      = [];
  saveProgress(progress);
}

async function runTierMode(progress, products) {
  console.log('\n🏷️  PHASE 3 — TIER MODE');
  console.log('='.repeat(55));
  const eligible = products.filter(p => {
    const reason = shouldSkip(p, progress);
    if (reason) { console.log(`   ⏭️  "${p.title}" — ${reason}`); return false; }
    return true;
  });
  console.log(`\n📦 Total: ${products.length} | ⏭️ Skipped: ${products.length - eligible.length} | 📋 Eligible: ${eligible.length}\n`);
  if (eligible.length === 0) { console.log('✅ All products locked. Nothing to do.'); return; }

  let doneThisSession = 0;
  for (const product of eligible) {
    if (!hasCapacity()) { console.log('\n🛑 All API limits reached.'); break; }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) { console.log('\n⏱️  Time limit reached.'); break; }

    const success = await applyPatterns(product);
    if (success) { progress.tier_last_seo[product.id] = new Date().toISOString(); doneThisSession++; }
    saveProgress(progress);
    console.log(`   📊 Tonight: ${doneThisSession}`);
  }
  console.log(`\n📦 Done tonight: ${doneThisSession}`);
}

// ══════════════════════════════════════════════════════════════════════════
// SINGLE PRODUCT MODE
// ══════════════════════════════════════════════════════════════════════════

async function runSingleProduct(productId) {
  console.log('\n🎯 Nova Mart SEO Patterns — Single Product Mode');
  console.log('   Keys  : managed by apiManager (4 Gemini + 4 Groq + 3 DeepSeek)');
  console.log('   Mode  : BATCH (1 API call = all 8 fields) → saves to Shopify');
  console.log('='.repeat(55));

  await verifyAllKeys();

  console.log(`\n🔍 Fetching product ID: ${productId}...`);
  let product;
  try {
    const res = await shopify.get(`/products/${productId}.json?fields=id,title,handle,body_html,tags,images,variants,product_type`);
    product = res.data.product;
  } catch (err) {
    console.error(`❌ Could not fetch product ${productId}: ${err.message}`);
    process.exit(1);
  }

  console.log(`✅ Found: "${product.title}"\n`);
  const success = await applyPatterns(product);

  console.log('\n' + '='.repeat(55));
  console.log(success ? '✅ Done — all fields saved to Shopify.' : '❌ Failed — check errors above.');
  console.log(getStatus());
  console.log('='.repeat(55));
}

// ══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  const productArg = process.argv.find(a => a.startsWith('--product='));
  if (productArg) {
    const productId = productArg.split('=')[1];
    if (!productId) { console.error('❌ Usage: node seoPatterns.js --product=<id>'); process.exit(1); }
    return runSingleProduct(productId);
  }

  console.log('\n🚀 Nova Mart SEO Patterns — Nightly Run');
  console.log('   Keys  : 4 Gemini + 4 Groq + 3 DeepSeek = 11 keys (~78,600 req/day)');
  console.log('   Mode  : BATCH (1 API call per product = all 8 fields)');
  console.log('   Strategy: Gemini → Groq → DeepSeek (auto-rotated by apiManager)');
  console.log('='.repeat(55));

  await verifyAllKeys();

  const progress = loadProgress();
  const products = await getAllProducts();

  console.log(`\n📦 Products in store : ${products.length}`);
  console.log(`📂 Current phase     : ${(progress.phase || 'baseline').toUpperCase()}`);

  if (progress.phase === 'baseline') {
    await runBaseline(progress, products);
  } else if (progress.phase === 'cooldown') {
    await runCooldown(progress);
    if (progress.phase === 'tier') await runTierMode(progress, products);
  } else if (progress.phase === 'tier') {
    await runTierMode(progress, products);
  }

  console.log('\n' + '='.repeat(55));
  console.log(getStatus());
  console.log('='.repeat(55));
}

// ─── Export for pollAndFix.js ──────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => {
    console.error('❌ seoPatterns crashed:', err.message);
    process.exit(1);
  });
}

module.exports = { applyPatterns };