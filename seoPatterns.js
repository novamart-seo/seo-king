require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const Groq = require('groq-sdk');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Groq Setup ────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Groq Free Tier Limits (llama-3.3-70b, resets midnight UTC) ───────────
const DAILY_LIMIT         = 980;   // Safe buffer under 1,000 RPD
const CALLS_PER_PRODUCT   = 5;     // H1 + meta title + meta desc + body + tags
const MAX_PRODUCTS_PER_DAY = Math.floor(DAILY_LIMIT / CALLS_PER_PRODUCT); // 196
const MAX_RUN_MINUTES = 300; // 5 hour safety limit
const RUN_START_TIME = Date.now();

const RPM_LIMIT           = 28;    // Safe buffer under 30 RPM
const MIN_DELAY_MS        = Math.ceil(60000 / RPM_LIMIT); // ~2142ms between calls

const PROGRESS_FILE   = './progress.json';
const DAILY_CALL_FILE = './daily-calls.json';

// ─── Mode ──────────────────────────────────────────────────────────────────
const TEST_MODE = process.argv.includes('--test');

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Progress Tracker ──────────────────────────────────────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      console.log(`📂 Resuming — ${data.completed.length} products already done`);
      return data;
    }
  } catch (e) {}
  return { completed: [], failed: [] };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Daily Call Counter ────────────────────────────────────────────────────
let totalCallsToday = 0;

function loadDailyCalls() {
  try {
    if (fs.existsSync(DAILY_CALL_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_CALL_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        totalCallsToday = data.calls;
        console.log(`📊 Groq calls today: ${totalCallsToday}/${DAILY_LIMIT}`);
        return;
      }
    }
  } catch (e) {}
  totalCallsToday = 0;
  console.log(`📊 Groq calls today: 0/${DAILY_LIMIT} (fresh day)`);
}

function saveDailyCalls() {
  fs.writeFileSync(DAILY_CALL_FILE, JSON.stringify({
    date: new Date().toDateString(),
    calls: totalCallsToday
  }, null, 2));
}

function callsRemaining()    { return DAILY_LIMIT - totalCallsToday; }
function productsRemaining() { return Math.floor(callsRemaining() / CALLS_PER_PRODUCT); }

// ─── Rate Limiter ──────────────────────────────────────────────────────────
let lastCallTime = 0;
let callsThisMinute = 0;
let minuteWindowStart = Date.now();

async function enforceRateLimit() {
  // Reset minute window
  if (Date.now() - minuteWindowStart > 60000) {
    callsThisMinute = 0;
    minuteWindowStart = Date.now();
  }

  // Enforce minimum delay between calls
  const timeSinceLast = Date.now() - lastCallTime;
  if (timeSinceLast < MIN_DELAY_MS) {
    await wait(MIN_DELAY_MS - timeSinceLast);
  }

  // If at RPM cap, wait for window reset
  if (callsThisMinute >= RPM_LIMIT) {
    const elapsed  = Date.now() - minuteWindowStart;
    const waitTime = 60000 - elapsed + 1000;
    console.log(`   ⏳ RPM cap reached — waiting ${Math.round(waitTime / 1000)}s...`);
    await wait(waitTime);
    callsThisMinute = 0;
    minuteWindowStart = Date.now();
  }
}

// ─── Groq Generator ───────────────────────────────────────────────────────
async function generate(prompt, retries = 4) {
  if (totalCallsToday >= DAILY_LIMIT) return null;

  await enforceRateLimit();

  let backoff = 15000;

  for (let i = 0; i < retries; i++) {
    try {
      callsThisMinute++;
      lastCallTime = Date.now();
      totalCallsToday++;
      saveDailyCalls();

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();

    } catch (error) {
      totalCallsToday--;
      callsThisMinute = Math.max(0, callsThisMinute - 1);
      saveDailyCalls();

      const msg = error.message || '';
      console.log(`   ⚠️  Groq error (attempt ${i + 1}/${retries}): ${msg.slice(0, 100)}`);

      // Invalid API key — exit immediately
      if (msg.includes('401') || msg.includes('invalid_api_key') || msg.includes('Authentication')) {
        console.log('\n   🛑 Invalid Groq API key — check your .env file. Exiting.');
        process.exit(1);
      }

      // Daily quota hit
      if (msg.includes('daily') && msg.includes('quota')) {
        console.log(`\n   🛑 Groq daily quota hit at ${totalCallsToday} calls.`);
        return null;
      }

      // Rate limit — wait and retry with exponential backoff
      if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests')) {
        if (i < retries - 1) {
          console.log(`   ⏳ Rate limit — waiting ${backoff / 1000}s...`);
          await wait(backoff);
          backoff = Math.min(backoff * 2, 60000);
          callsThisMinute = 0;
          minuteWindowStart = Date.now();
        } else {
          console.log('   ❌ Retries exhausted.');
          return null;
        }
      } else {
        return null;
      }
    }
  }
  return null;
}

// ─── Daily Limit Guard ─────────────────────────────────────────────────────
function dailyLimitReached() {
  if (callsRemaining() < CALLS_PER_PRODUCT) {
    console.log('\n' + '='.repeat(50));
    console.log(`🛑 Daily Groq limit reached — ${totalCallsToday}/${DAILY_LIMIT} calls used.`);
    console.log(`📅 Quota resets at midnight UTC — run again tomorrow.`);
    console.log(`📂 Progress saved — will resume exactly where it left off.`);
    console.log('='.repeat(50));
    return true;
  }
  return false;
}

// ─── SEO Pattern: H1 Title ─────────────────────────────────────────────────
// Pattern: [Full Product Name] – [Key Material or Feature] [Size/Qty]
// Length: 50-70 chars | No quotes | No trailing punctuation
async function generateH1Title(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 300) || '';
  return await generate(`Generate an H1 product title following this EXACT pattern:
[Full Product Name] – [Key Material or Feature] [Size/Quantity if applicable]

Product: ${product.title}
Existing description: ${desc}

Rules:
- Between 50-70 characters
- Must include the FULL product name — never shorten or abbreviate it
- Must add key material or standout feature after a dash
- Add size/quantity/set info at the end if available
- No quotes, no punctuation at end
- Return ONLY the H1 title, nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy Alcohol Scent 100ml
Marvel Iron Man ANC TWS Earbuds – HiFi 13mm Drivers 2-Piece
MOLLE Tactical Backpack – Waterproof Nylon 30L 45L 80L
Women's High Waist Wide-Leg Pants – Soft Cotton 3-Piece Set
Cordless Stick Vacuum Cleaner – 55Kpa HEPA 10-in-1 500W`);
}

// ─── SEO Pattern: Meta Title ───────────────────────────────────────────────
// Pattern: [Full Product Name] – [Specific Spec/Number] | Nova Mart
// Length: 50-60 chars | No generic words | Must end with | Nova Mart
async function generateMetaTitle(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 200) || '';
  return await generate(`Generate a meta title following this EXACT pattern:
[Full Product Name] – [Most Specific Feature with number or spec] | Nova Mart

Product: ${product.title}
Product info: ${desc}

Rules:
- Between 50-60 characters
- Must include the full product name
- Most specific unique feature — use real numbers or specs
- Must end with | Nova Mart
- No quotes
- Never use: quality, best, amazing, perfect
- Return ONLY the meta title, nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy 100ml | Nova Mart
Marvel Iron Man ANC Earbuds – 13mm HiFi 15H | Nova Mart
Cordless Vacuum 500W – 55Kpa HEPA 10-in-1 | Nova Mart
MOLLE Tactical Backpack – Waterproof 30L Nylon | Nova Mart`);
}

// ─── SEO Pattern: Meta Description ────────────────────────────────────────
// Pattern: [Hook] + [2 specs] + Free Delivery at Nova Mart!
// Length: 140-160 chars | Emotional hook | No quotes
async function generateMetaDescription(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 400) || '';
  return await generate(`Generate an appealing and specific meta description.

Product: ${product.title}
Product details: ${desc}

Rules:
- Between 140-160 characters exactly
- NO quotes anywhere
- Emotional hook that makes customer want to click
- Include 2 specific features with real numbers/specs
- Must end with exactly: Free Delivery at Nova Mart!
- Never use: Experience, Enjoy, Discover, Amazing, Best, Quality, Perfect
- Return ONLY the meta description, nothing else

Examples:
Turn heads with 1 Million EDT — fresh spicy scent that lasts all day. 100ml unisex formula. Free Delivery at Nova Mart!
Block the noise. Own the sound. 13mm HiFi drivers and 15H battery in Marvel Iron Man ANC earbuds. Free Delivery at Nova Mart!
55Kpa suction. HEPA filtration. 10 tools in one cordless vacuum. Clean every corner fast. Free Delivery at Nova Mart!`);
}

// ─── SEO Pattern: Product Description (Body HTML) ─────────────────────────
// Structure: Hook → Key Features → Why It Works → Nova Mart Diff → Specs Table → FAQ
// Min 800 words | Nova Mart brand voice | No generic language
async function generateProductDescription(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 500) || '';
  return await generate(`Write a complete product description for Nova Mart Shopify store.

Product: ${product.title}
Existing info: ${desc}

BRAND VOICE: Nova Mart — sophisticated, minimalist, confident.
Short punchy sentences. Never generic. Rewrite uniquely in Nova Mart voice.

Follow this EXACT HTML structure:

<p><em>[ONE punchy 8-12 word sentence. Core benefit. No fluff.]</em></p>

<h2>Key Features</h2>
<ul>
<li><b>[Feature Name]:</b> [Why it matters. Real specs.]</li>
[5-7 bullets total]
</ul>

<h2>Why It Works For You</h2>
<p>[3-4 sentences. Speak to customer directly. Practical daily benefit.]</p>

<h2>What Makes Nova Mart Different</h2>
<p>[2-3 sentences. Free delivery, curated products, trust.]</p>

<h2>Technical Specifications</h2>
<table>
<tr><th>Specification</th><th>Details</th></tr>
[5-8 rows with real specs]
</table>

<h2>Frequently Asked Questions</h2>
<details><summary>[Common question]</summary><p>[Answer 2-3 sentences.]</p></details>
<details><summary>[Usage or compatibility question]</summary><p>[Answer.]</p></details>
<details><summary>[Delivery or returns question]</summary><p>[Mention Nova Mart free delivery.]</p></details>

Rules:
- Minimum 800 words
- Never use: Experience, Enjoy, Amazing, Best, Quality, Perfect
- Return ONLY the HTML, nothing else`);
}

// ─── SEO Pattern: Tags ─────────────────────────────────────────────────────
// Pattern: 8-10 comma-separated tags | Mix broad + specific | Under 25 chars each
async function generateTags(product) {
  const result = await generate(`Generate SEO tags for this Shopify product.

Product: ${product.title}

Rules:
- 8-10 tags
- Mix broad and specific keywords
- Cover: product type, material, feature, use case, audience, style
- Each tag under 25 characters
- Comma separated, no quotes
- Return ONLY the comma-separated tags, nothing else`);

  return result ? result.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
}

// ─── Metafield Saver ───────────────────────────────────────────────────────
async function saveMetafield(productId, key, value) {
  try {
    const res = await shopify.get(`/products/${productId}/metafields.json`);
    const existing = res.data.metafields.find(m => m.namespace === 'global' && m.key === key);
    if (existing) {
      await shopify.put(`/products/${productId}/metafields/${existing.id}.json`, {
        metafield: { id: existing.id, value, type: 'string' }
      });
    } else {
      await shopify.post(`/products/${productId}/metafields.json`, {
        metafield: { namespace: 'global', key, value, type: 'string' }
      });
    }
  } catch (error) {
    console.error(`   ❌ Metafield error: ${error.message}`);
  }
}

// ─── Already Optimized Check ──────────────────────────────────────────────
async function isAlreadyOptimized(product) {
  try {
    const res = await shopify.get(`/products/${product.id}/metafields.json`);
    const fields = res.data.metafields;
    const hasMetaTitle = fields.some(m => m.namespace === 'global' && m.key === 'title_tag' && m.value?.length > 30);
    const hasMetaDesc  = fields.some(m => m.namespace === 'global' && m.key === 'description_tag' && m.value?.length > 100);
    const hasBody      = product.body_html?.includes('<h2>Key Features</h2>');
    return hasMetaTitle && hasMetaDesc && hasBody;
  } catch {
    return false;
  }
}

// ─── Process One Product ───────────────────────────────────────────────────
async function applyPatterns(product, testMode = false) {
  console.log(`\n🔧 ${product.title}`);

  if (!testMode) {
    console.log(`   📊 Groq: ${totalCallsToday}/${DAILY_LIMIT} used | ${callsRemaining()} left | ~${productsRemaining()} products left today`);
  }

  const updates    = {};
  const testOutput = {};

  // ── 1. H1 Title ──────────────────────────────────────────────────────────
  // SEO Pattern: Full name + dash + key feature + size/qty (50-70 chars)
  console.log('   [Pattern 1/5] H1 Title — Full name + feature + spec...');
  const h1Title = await generateH1Title(product);
  if (h1Title) {
    console.log(`   ✅ H1: ${h1Title}  (${h1Title.length} chars)`);
    testMode ? testOutput.h1Title = h1Title : (updates.title = h1Title);
  } else console.log('   ⚠️  H1 title failed');

  // ── 2. Meta Title ─────────────────────────────────────────────────────────
  // SEO Pattern: Full name + most specific spec + | Nova Mart (50-60 chars)
  console.log('   [Pattern 2/5] Meta Title — Name + spec + | Nova Mart...');
  const metaTitle = await generateMetaTitle(product);
  if (metaTitle) {
    console.log(`   ✅ Meta Title: ${metaTitle}  (${metaTitle.length} chars)`);
    if (testMode) testOutput.metaTitle = metaTitle;
    else await saveMetafield(product.id, 'title_tag', metaTitle);
  } else console.log('   ⚠️  Meta title failed');

  // ── 3. Meta Description ───────────────────────────────────────────────────
  // SEO Pattern: Emotional hook + 2 specs + "Free Delivery at Nova Mart!" (140-160 chars)
  console.log('   [Pattern 3/5] Meta Description — Hook + 2 specs + CTA...');
  const metaDesc = await generateMetaDescription(product);
  if (metaDesc) {
    console.log(`   ✅ Meta Desc: ${metaDesc}  (${metaDesc.length} chars)`);
    if (testMode) testOutput.metaDesc = metaDesc;
    else await saveMetafield(product.id, 'description_tag', metaDesc);
  } else console.log('   ⚠️  Meta desc failed');

  // ── 4. Product Body HTML ──────────────────────────────────────────────────
  // SEO Pattern: Hook → Features → Why → Nova Mart diff → Specs table → FAQ
  console.log('   [Pattern 4/5] Body HTML — Hook + Features + Specs + FAQ...');
  const productDesc = await generateProductDescription(product);
  if (productDesc) {
    console.log(`   ✅ Body HTML: ${productDesc.length} chars generated`);
    testMode ? testOutput.bodyHtml = productDesc : (updates.body_html = productDesc);
  } else console.log('   ⚠️  Body HTML failed');

  // ── 5. Tags ───────────────────────────────────────────────────────────────
  // SEO Pattern: 8-10 tags mixing broad + specific (type, material, use case, audience)
  console.log('   [Pattern 5/5] Tags — 8-10 keyword mix...');
  const tags = await generateTags(product);
  if (tags.length > 0) {
    console.log(`   ✅ Tags: ${tags.join(', ')}`);
    testMode ? testOutput.tags = tags : (updates.tags = tags.join(', '));
  } else console.log('   ⚠️  Tags failed');

  // ── Test Mode Preview ─────────────────────────────────────────────────────
  if (testMode) {
    console.log('\n' + '─'.repeat(50));
    console.log('📋 TEST PREVIEW — Nothing saved to Shopify');
    console.log('─'.repeat(50));
    console.log('\n📐 SEO PATTERNS APPLIED:');
    console.log('   Pattern 1 — H1 Title    : [Full Name] – [Feature] [Spec]');
    console.log('   Pattern 2 — Meta Title  : [Full Name] – [Spec] | Nova Mart');
    console.log('   Pattern 3 — Meta Desc   : [Hook] + [2 specs] + Free Delivery at Nova Mart!');
    console.log('   Pattern 4 — Body HTML   : Hook → Features → Why → Diff → Specs → FAQ');
    console.log('   Pattern 5 — Tags        : 8-10 mixed broad+specific keywords');
    console.log('\n📝 GENERATED OUTPUT:');
    if (testOutput.h1Title)   console.log(`\n🏷️  H1 Title (${testOutput.h1Title.length} chars):\n   ${testOutput.h1Title}`);
    if (testOutput.metaTitle) console.log(`\n🔍 Meta Title (${testOutput.metaTitle.length} chars):\n   ${testOutput.metaTitle}`);
    if (testOutput.metaDesc)  console.log(`\n📝 Meta Description (${testOutput.metaDesc.length} chars):\n   ${testOutput.metaDesc}`);
    if (testOutput.tags)      console.log(`\n🏷️  Tags (${testOutput.tags.length}):\n   ${testOutput.tags.join(', ')}`);
    if (testOutput.bodyHtml) {
      console.log(`\n📄 Body HTML (${testOutput.bodyHtml.length} chars) — first 600 chars:\n`);
      console.log(testOutput.bodyHtml.slice(0, 600) + '\n...');
    }
    console.log('\n' + '─'.repeat(50));
    console.log('✅ Test passed! Run without --test to apply to all products.');
    console.log('─'.repeat(50));
    return true;
  }

  // ── Save to Shopify ───────────────────────────────────────────────────────
  if (Object.keys(updates).length > 0) {
    await shopify.put(`/products/${product.id}.json`, {
      product: { id: product.id, ...updates }
    });
    console.log(`   ✅ Saved to Shopify`);
  }

  return true;
}

// ─── Fetch All Products ────────────────────────────────────────────────────
async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle,body_html,tags,images,variants';
  while (url) {
    const response = await shopify.get(url);
    products = [...products, ...response.data.products];
    const linkHeader = response.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
    } else { url = null; }
  }
  return products;
}

// ─── Verify Groq Key ───────────────────────────────────────────────────────
async function verifyGroqKey() {
  console.log('\n🔍 Verifying Groq API key...');
  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      max_tokens: 5
    });
    const reply = response.choices[0].message.content.trim();
    console.log(`   ✅ Groq key valid — model: ${GROQ_MODEL} — response: "${reply}"`);
    totalCallsToday++;
    saveDailyCalls();
  } catch (error) {
    console.log(`\n   ❌ Groq API key failed: ${error.message}`);
    console.log('   👉 Check GROQ_API_KEY in your .env file');
    console.log('   👉 Get a key at: https://console.groq.com');
    process.exit(1);
  }
}

// ─── Test Mode Entry ───────────────────────────────────────────────────────
async function runTestMode() {
  console.log('\n🧪 TEST MODE — 1 random product, nothing saved to Shopify');
  console.log('='.repeat(50));

  loadDailyCalls();
  await verifyGroqKey();

  console.log('\n📦 Fetching products...');
  const products = await getAllProducts();
  console.log(`   Found ${products.length} products`);

  const randomProduct = products[Math.floor(Math.random() * products.length)];
  console.log(`\n🎲 Randomly selected: "${randomProduct.title}"`);
  console.log(`   Shopify URL  : https://${STORE}/admin/products/${randomProduct.id}`);
  console.log(`   Existing tags: ${randomProduct.tags || '(none)'}`);
  console.log(`   Has body     : ${randomProduct.body_html ? 'Yes (' + randomProduct.body_html.length + ' chars)' : 'No'}`);

  await applyPatterns(randomProduct, true);

  console.log(`\n📊 Groq calls used this test: ${totalCallsToday}/${DAILY_LIMIT}`);
}

// ─── Full Run Entry ────────────────────────────────────────────────────────
async function runSEOPatterns() {
  console.log('\n🚀 Nova Mart SEO Optimizer');
  console.log('='.repeat(50));
  console.log(`   AI Engine    : Groq — ${GROQ_MODEL}`);
  console.log(`   Daily limit  : ${DAILY_LIMIT} calls/day (resets midnight UTC)`);
  console.log(`   Per product  : ${CALLS_PER_PRODUCT} calls`);
  console.log(`   Max today    : ~${MAX_PRODUCTS_PER_DAY} products`);
  console.log('\n   SEO Patterns Applied Per Product:');
  console.log(`   1. H1 Title      — [Full Name] – [Feature] [Spec]  (50-70 chars)`);
  console.log(`   2. Meta Title    — [Full Name] – [Spec] | Nova Mart  (50-60 chars)`);
  console.log(`   3. Meta Desc     — [Hook] + [2 specs] + CTA  (140-160 chars)`);
  console.log(`   4. Body HTML     — Hook → Features → Why → Diff → Specs → FAQ`);
  console.log(`   5. Tags          — 8-10 mixed broad + specific keywords`);
  console.log('='.repeat(50));

  loadDailyCalls();
  await verifyGroqKey();

  if (callsRemaining() < CALLS_PER_PRODUCT) {
    console.log(`\n🛑 Not enough calls remaining (${callsRemaining()} left, need ${CALLS_PER_PRODUCT}).`);
    console.log('📅 Quota resets at midnight UTC.');
    process.exit(0);
  }

  const progress = loadProgress();
  const products = await getAllProducts();

  console.log(`\n📦 Total products : ${products.length}`);
  const remaining = products.filter(p => !progress.completed.includes(p.id));
  console.log(`✅ Already done   : ${progress.completed.length}`);
  console.log(`📋 Remaining      : ${remaining.length}`);

  console.log('\n🔍 Checking already-optimized products...');
  const toProcess = [];
  for (const product of remaining) {
    const optimized = await isAlreadyOptimized(product);
    if (optimized) {
      console.log(`   ⏭️  Already good: ${product.title}`);
      progress.completed.push(product.id);
      saveProgress(progress);
    } else {
      toProcess.push(product);
    }
  }

  console.log(`\n📋 Need SEO     : ${toProcess.length} products`);
  console.log(`📊 Can do today : ~${productsRemaining()} products`);
  console.log('='.repeat(50));

  let doneThisSession = 0;

  for (const product of toProcess) {
    if (dailyLimitReached()) {
      saveProgress(progress);
      process.exit(0);
    }

    // Stop if approaching 5 hour limit
    const minutesElapsed = (Date.now() - RUN_START_TIME) / 60000;
    if (minutesElapsed >= MAX_RUN_MINUTES) {
      console.log(`⏱️ Time limit reached (${Math.round(minutesElapsed)}min) — saving progress`);
      saveProgress(progress);
      process.exit(0);
    }

    const success = await applyPatterns(product, false);

    if (success) {
      progress.completed.push(product.id);
      doneThisSession++;
    } else {
      progress.failed.push(product.id);
    }
    saveProgress(progress);
    console.log(`   📊 Session: ${doneThisSession} done | Total: ${progress.completed.length}/${products.length}`);
  }

  if (progress.completed.length >= products.length) {
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
    console.log('\n' + '='.repeat(50));
    console.log('🎉 ALL PRODUCTS COMPLETE!');
  } else {
    console.log('\n' + '='.repeat(50));
    console.log(`📊 Session done — ${progress.completed.length}/${products.length} total`);
    console.log('▶️  Run again tomorrow to continue (resets midnight UTC)');
  }

  console.log(`\n📊 Groq calls used today : ${totalCallsToday}/${DAILY_LIMIT}`);
  console.log(`📦 Products this session : ${doneThisSession}`);
  console.log('='.repeat(50));
}

// ─── Entry Point ───────────────────────────────────────────────────────────
if (TEST_MODE) {
  runTestMode();
} else {
  runSEOPatterns();
}
