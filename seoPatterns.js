require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Gemini Setup (Primary) ────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ─── Groq Setup (Fallback) ─────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Limits ────────────────────────────────────────────────────────────────
const GEMINI_DAILY_LIMIT     = 1490;  // Safe buffer under 1,500 RPD
const GEMINI_RPM_LIMIT       = 13;    // Safe buffer under 15 RPM
const GEMINI_DELAY_MS        = Math.ceil(60000 / GEMINI_RPM_LIMIT); // ~4615ms

const GROQ_DAILY_LIMIT       = 980;   // Safe buffer under 1,000 RPD
const GROQ_RPM_LIMIT         = 28;    // Safe buffer under 30 RPM
const GROQ_DELAY_MS          = Math.ceil(60000 / GROQ_RPM_LIMIT);   // ~2142ms

const CALLS_PER_PRODUCT      = 5;     // H1 + meta title + meta desc + body + tags
const MAX_RUN_MINUTES        = 320;   // 5hr 20min safety limit
const RUN_START_TIME         = Date.now();

const PROGRESS_FILE          = './progress.json';
const DAILY_CALL_FILE        = './daily-calls.json';

// ─── Mode ──────────────────────────────────────────────────────────────────
const TEST_MODE = process.argv.includes('--test');

// ─── Shopify Client ────────────────────────────────────────────────────────
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
let geminiCallsToday = 0;
let groqCallsToday   = 0;
let geminiExhausted  = false;
let groqExhausted    = false;

function loadDailyCalls() {
  try {
    if (fs.existsSync(DAILY_CALL_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_CALL_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        geminiCallsToday = data.gemini || 0;
        groqCallsToday   = data.groq   || 0;
        if (geminiCallsToday >= GEMINI_DAILY_LIMIT) geminiExhausted = true;
        if (groqCallsToday   >= GROQ_DAILY_LIMIT)   groqExhausted   = true;
        console.log(`📊 Gemini calls today : ${geminiCallsToday}/${GEMINI_DAILY_LIMIT}`);
        console.log(`📊 Groq calls today   : ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);
        return;
      }
    }
  } catch (e) {}
  geminiCallsToday = 0;
  groqCallsToday   = 0;
  console.log(`📊 Gemini: 0/${GEMINI_DAILY_LIMIT} | Groq: 0/${GROQ_DAILY_LIMIT} (fresh day)`);
}

function saveDailyCalls() {
  fs.writeFileSync(DAILY_CALL_FILE, JSON.stringify({
    date: new Date().toDateString(),
    gemini: geminiCallsToday,
    groq: groqCallsToday
  }, null, 2));
}

function bothExhausted() {
  return geminiExhausted && groqExhausted;
}

function activeEngine() {
  if (!geminiExhausted) return 'Gemini';
  if (!groqExhausted)   return 'Groq';
  return 'None';
}

// ─── Gemini Rate Limiter ───────────────────────────────────────────────────
let geminiLastCall      = 0;
let geminiCallsMinute   = 0;
let geminiWindowStart   = Date.now();

async function enforceGeminiRateLimit() {
  if (Date.now() - geminiWindowStart > 60000) {
    geminiCallsMinute = 0;
    geminiWindowStart = Date.now();
  }
  const timeSinceLast = Date.now() - geminiLastCall;
  if (timeSinceLast < GEMINI_DELAY_MS) {
    await wait(GEMINI_DELAY_MS - timeSinceLast);
  }
  if (geminiCallsMinute >= GEMINI_RPM_LIMIT) {
    const elapsed  = Date.now() - geminiWindowStart;
    const waitTime = 60000 - elapsed + 1000;
    console.log(`   ⏳ Gemini RPM cap — waiting ${Math.round(waitTime / 1000)}s...`);
    await wait(waitTime);
    geminiCallsMinute = 0;
    geminiWindowStart = Date.now();
  }
}

// ─── Groq Rate Limiter ─────────────────────────────────────────────────────
let groqLastCall      = 0;
let groqCallsMinute   = 0;
let groqWindowStart   = Date.now();

async function enforceGroqRateLimit() {
  if (Date.now() - groqWindowStart > 60000) {
    groqCallsMinute = 0;
    groqWindowStart = Date.now();
  }
  const timeSinceLast = Date.now() - groqLastCall;
  if (timeSinceLast < GROQ_DELAY_MS) {
    await wait(GROQ_DELAY_MS - timeSinceLast);
  }
  if (groqCallsMinute >= GROQ_RPM_LIMIT) {
    const elapsed  = Date.now() - groqWindowStart;
    const waitTime = 60000 - elapsed + 1000;
    console.log(`   ⏳ Groq RPM cap — waiting ${Math.round(waitTime / 1000)}s...`);
    await wait(waitTime);
    groqCallsMinute = 0;
    groqWindowStart = Date.now();
  }
}

// ─── Gemini Generator ─────────────────────────────────────────────────────
async function generateWithGemini(prompt, retries = 3) {
  if (geminiExhausted) return null;
  if (geminiCallsToday >= GEMINI_DAILY_LIMIT) {
    console.log('   🔄 Gemini daily limit reached — switching to Groq...');
    geminiExhausted = true;
    return null;
  }

  await enforceGeminiRateLimit();
  let backoff = 60000;

  for (let i = 0; i < retries; i++) {
    try {
      geminiCallsMinute++;
      geminiLastCall = Date.now();
      geminiCallsToday++;
      saveDailyCalls();

      const result = await geminiModel.generateContent(prompt);
      return result.response.text().trim();

    } catch (error) {
      geminiCallsToday--;
      geminiCallsMinute = Math.max(0, geminiCallsMinute - 1);
      saveDailyCalls();

      const msg = error.message || '';
      console.log(`   ⚠️  Gemini error (attempt ${i + 1}/${retries}): ${msg.slice(0, 80)}`);

      if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
        console.log('   🔄 Gemini quota exhausted — switching to Groq...');
        geminiExhausted = true;
        return null;
      }

      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        if (i < retries - 1) {
          console.log(`   ⏳ Gemini rate limit — waiting ${backoff / 1000}s...`);
          await wait(backoff);
          backoff = Math.min(backoff * 2, 120000);
          geminiCallsMinute = 0;
          geminiWindowStart = Date.now();
        } else {
          geminiExhausted = true;
          return null;
        }
      } else {
        return null;
      }
    }
  }
  return null;
}

// ─── Groq Generator ───────────────────────────────────────────────────────
async function generateWithGroq(prompt, retries = 4) {
  if (groqExhausted) return null;
  if (groqCallsToday >= GROQ_DAILY_LIMIT) {
    console.log('   🛑 Groq daily limit reached.');
    groqExhausted = true;
    return null;
  }

  await enforceGroqRateLimit();
  let backoff = 15000;

  for (let i = 0; i < retries; i++) {
    try {
      groqCallsMinute++;
      groqLastCall = Date.now();
      groqCallsToday++;
      saveDailyCalls();

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();

    } catch (error) {
      groqCallsToday--;
      groqCallsMinute = Math.max(0, groqCallsMinute - 1);
      saveDailyCalls();

      const msg = error.message || '';
      console.log(`   ⚠️  Groq error (attempt ${i + 1}/${retries}): ${msg.slice(0, 80)}`);

      if (msg.includes('401') || msg.includes('invalid_api_key')) {
        console.log('   🛑 Invalid Groq API key. Exiting.');
        process.exit(1);
      }
      if (msg.includes('daily') && msg.includes('quota')) {
        groqExhausted = true;
        return null;
      }
      if (msg.includes('429') || msg.includes('rate_limit')) {
        if (i < retries - 1) {
          console.log(`   ⏳ Groq rate limit — waiting ${backoff / 1000}s...`);
          await wait(backoff);
          backoff = Math.min(backoff * 2, 60000);
          groqCallsMinute = 0;
          groqWindowStart = Date.now();
        } else {
          groqExhausted = true;
          return null;
        }
      } else {
        return null;
      }
    }
  }
  return null;
}

// ─── Smart Generator (Gemini first, Groq fallback) ────────────────────────
async function generate(prompt) {
  // Try Gemini first
  if (!geminiExhausted) {
    const result = await generateWithGemini(prompt);
    if (result) return { text: result, engine: 'Gemini' };
  }
  // Fallback to Groq
  if (!groqExhausted) {
    console.log('   🔄 Using Groq fallback...');
    const result = await generateWithGroq(prompt);
    if (result) return { text: result, engine: 'Groq' };
  }
  return null;
}

// ─── SEO Pattern 1: H1 Title ───────────────────────────────────────────────
async function generateH1Title(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 300) || '';
  const res = await generate(`Generate an H1 product title following this EXACT pattern:
[Full Product Name] – [Key Material or Feature] [Size/Quantity if applicable]

Product: ${product.title}
Existing description: ${desc}

Rules:
- Between 50-70 characters
- Must include the FULL product name — never shorten or abbreviate
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
  return res;
}

// ─── SEO Pattern 2: Meta Title ─────────────────────────────────────────────
async function generateMetaTitle(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 200) || '';
  const res = await generate(`Generate a meta title following this EXACT pattern:
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
  return res;
}

// ─── SEO Pattern 3: Meta Description ──────────────────────────────────────
async function generateMetaDescription(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 400) || '';
  const res = await generate(`Generate an appealing and specific meta description.

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
  return res;
}

// ─── SEO Pattern 4: Body HTML ──────────────────────────────────────────────
async function generateBodyHTML(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 500) || '';
  const res = await generate(`Write a complete product description for Nova Mart Shopify store.

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
  return res;
}

// ─── SEO Pattern 5: Tags ───────────────────────────────────────────────────
async function generateTags(product) {
  const res = await generate(`Generate SEO tags for this Shopify product.

Product: ${product.title}

Rules:
- 8-10 tags
- Mix broad and specific keywords
- Cover: product type, material, feature, use case, audience, style
- Each tag under 25 characters
- Comma separated, no quotes
- Return ONLY the comma-separated tags, nothing else`);
  if (!res) return null;
  const tags = res.text.split(',').map(t => t.trim()).filter(t => t.length > 0);
  return { text: tags, engine: res.engine };
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

// ─── Process One Product ───────────────────────────────────────────────────
async function applyPatterns(product, testMode = false) {
  console.log(`\n🔧 ${product.title}`);
  console.log(`   🤖 Active engine: ${activeEngine()} | Gemini: ${geminiCallsToday}/${GEMINI_DAILY_LIMIT} | Groq: ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);

  const updates    = {};
  const testOutput = {};

  // ── 1. H1 Title ──────────────────────────────────────────────────────────
  console.log('   [1/5] H1 Title...');
  const h1 = await generateH1Title(product);
  if (h1) {
    console.log(`   ✅ H1 [${h1.engine}]: ${h1.text}  (${h1.text.length} chars)`);
    testMode ? (testOutput.h1Title = h1.text) : (updates.title = h1.text);
  } else console.log('   ⚠️  H1 failed');

  // ── 2. Meta Title ─────────────────────────────────────────────────────────
  console.log('   [2/5] Meta Title...');
  const metaTitle = await generateMetaTitle(product);
  if (metaTitle) {
    console.log(`   ✅ Meta Title [${metaTitle.engine}]: ${metaTitle.text}  (${metaTitle.text.length} chars)`);
    if (testMode) testOutput.metaTitle = metaTitle.text;
    else await saveMetafield(product.id, 'title_tag', metaTitle.text);
  } else console.log('   ⚠️  Meta title failed');

  // ── 3. Meta Description ───────────────────────────────────────────────────
  console.log('   [3/5] Meta Description...');
  const metaDesc = await generateMetaDescription(product);
  if (metaDesc) {
    console.log(`   ✅ Meta Desc [${metaDesc.engine}]: ${metaDesc.text.length} chars`);
    if (testMode) testOutput.metaDesc = metaDesc.text;
    else await saveMetafield(product.id, 'description_tag', metaDesc.text);
  } else console.log('   ⚠️  Meta desc failed');

  // ── 4. Body HTML ──────────────────────────────────────────────────────────
  console.log('   [4/5] Body HTML...');
  const body = await generateBodyHTML(product);
  if (body) {
    console.log(`   ✅ Body HTML [${body.engine}]: ${body.text.length} chars`);
    testMode ? (testOutput.bodyHtml = body.text) : (updates.body_html = body.text);
  } else console.log('   ⚠️  Body HTML failed');

  // ── 5. Tags ───────────────────────────────────────────────────────────────
  console.log('   [5/5] Tags...');
  const tags = await generateTags(product);
  if (tags && tags.text.length > 0) {
    console.log(`   ✅ Tags [${tags.engine}]: ${tags.text.join(', ')}`);
    testMode ? (testOutput.tags = tags.text) : (updates.tags = tags.text.join(', '));
  } else console.log('   ⚠️  Tags failed');

  // ── Test Mode Preview ─────────────────────────────────────────────────────
  if (testMode) {
    console.log('\n' + '─'.repeat(50));
    console.log('📋 TEST PREVIEW — Nothing saved to Shopify');
    console.log('─'.repeat(50));
    if (testOutput.h1Title)   console.log(`\n🏷️  H1 Title:\n   ${testOutput.h1Title}`);
    if (testOutput.metaTitle) console.log(`\n🔍 Meta Title:\n   ${testOutput.metaTitle}`);
    if (testOutput.metaDesc)  console.log(`\n📝 Meta Desc:\n   ${testOutput.metaDesc}`);
    if (testOutput.tags)      console.log(`\n🏷️  Tags:\n   ${testOutput.tags.join(', ')}`);
    if (testOutput.bodyHtml)  console.log(`\n📄 Body HTML (first 500 chars):\n${testOutput.bodyHtml.slice(0, 500)}...`);
    console.log('\n' + '─'.repeat(50));
    console.log('✅ Test complete! Remove --test flag to apply to all products.');
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

// ─── Verify API Keys ───────────────────────────────────────────────────────
async function verifyKeys() {
  console.log('\n🔍 Verifying API keys...');

  // Verify Gemini
  try {
    const result = await geminiModel.generateContent('Reply with exactly one word: OK');
    const reply = result.response.text().trim();
    console.log(`   ✅ Gemini key valid — response: "${reply}"`);
    geminiCallsToday++;
    saveDailyCalls();
  } catch (error) {
    console.log(`   ⚠️  Gemini key failed: ${error.message.slice(0, 80)}`);
    console.log('   🔄 Will use Groq only tonight.');
    geminiExhausted = true;
  }

  // Verify Groq
  try {
    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      max_tokens: 5
    });
    const reply = response.choices[0].message.content.trim();
    console.log(`   ✅ Groq key valid — response: "${reply}"`);
    groqCallsToday++;
    saveDailyCalls();
  } catch (error) {
    console.log(`   ⚠️  Groq key failed: ${error.message.slice(0, 80)}`);
    groqExhausted = true;
  }

  if (geminiExhausted && groqExhausted) {
    console.log('\n   🛑 Both API keys failed. Check your secrets. Exiting.');
    process.exit(1);
  }
}

// ─── Test Mode ─────────────────────────────────────────────────────────────
async function runTestMode() {
  console.log('\n🧪 TEST MODE — 1 random product, nothing saved to Shopify');
  console.log('='.repeat(55));

  loadDailyCalls();
  await verifyKeys();

  const products = await getAllProducts();
  console.log(`\n📦 Found ${products.length} products`);

  const randomProduct = products[Math.floor(Math.random() * products.length)];
  console.log(`\n🎲 Testing: "${randomProduct.title}"`);

  await applyPatterns(randomProduct, true);

  console.log(`\n📊 Gemini calls used: ${geminiCallsToday} | Groq calls used: ${groqCallsToday}`);
}

// ─── Full Run ──────────────────────────────────────────────────────────────
async function runSEOPatterns() {
  console.log('\n🚀 Nova Mart SEO Optimizer — Unified Engine');
  console.log('='.repeat(55));
  console.log(`   Primary AI   : Gemini 2.0 Flash (${GEMINI_DAILY_LIMIT} calls/day)`);
  console.log(`   Fallback AI  : Groq llama-3.3-70b (${GROQ_DAILY_LIMIT} calls/day)`);
  console.log(`   Combined     : ~${Math.floor((GEMINI_DAILY_LIMIT + GROQ_DAILY_LIMIT) / CALLS_PER_PRODUCT)} products/night`);
  console.log(`   Per product  : ${CALLS_PER_PRODUCT} AI calls`);
  console.log('='.repeat(55));

  loadDailyCalls();
  await verifyKeys();

  const progress = loadProgress();
  const products = await getAllProducts();

  console.log(`\n📦 Total products : ${products.length}`);

  // Daily rotation — reset progress when all done
  let remaining = products.filter(p => !progress.completed.includes(p.id));
  if (remaining.length === 0) {
    console.log('\n🔄 Full cycle complete — resetting for fresh rotation...');
    progress.completed = [];
    progress.failed    = [];
    saveProgress(progress);
    remaining = [...products];
  }

  console.log(`✅ Done this cycle : ${progress.completed.length}`);
  console.log(`📋 Remaining       : ${remaining.length}`);
  console.log('='.repeat(55));

  let doneThisSession = 0;

  for (const product of remaining) {

    // Both quotas exhausted
    if (bothExhausted()) {
      console.log('\n🛑 Both Gemini and Groq quotas exhausted for today.');
      console.log(`📊 Done tonight: ${doneThisSession} products`);
      saveProgress(progress);
      break;
    }

    // Time limit check
    const minutesElapsed = (Date.now() - RUN_START_TIME) / 60000;
    if (minutesElapsed >= MAX_RUN_MINUTES) {
      console.log(`\n⏱️ Time limit reached (${Math.round(minutesElapsed)}min) — saving progress`);
      saveProgress(progress);
      break;
    }

    const success = await applyPatterns(product, false);

    if (success) {
      progress.completed.push(product.id);
      doneThisSession++;
    } else {
      progress.failed.push(product.id);
    }

    saveProgress(progress);
    console.log(`   📊 Tonight: ${doneThisSession} | Cycle: ${progress.completed.length}/${products.length}`);
  }

  // Summary
  console.log('\n' + '='.repeat(55));
  if (progress.completed.length >= products.length) {
    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
    console.log('🎉 FULL CYCLE COMPLETE — All products refreshed!');
    console.log('🔄 Tomorrow starts a fresh cycle automatically.');
  } else {
    const cycleNight = Math.ceil(progress.completed.length / Math.floor((GEMINI_DAILY_LIMIT + GROQ_DAILY_LIMIT) / CALLS_PER_PRODUCT));
    console.log(`📊 Cycle progress  : ${progress.completed.length}/${products.length} products`);
    console.log(`🌙 Cycle night     : ${cycleNight}`);
    console.log('▶️  Continuing tomorrow night automatically...');
  }

  console.log(`\n📊 Gemini used tonight : ${geminiCallsToday}/${GEMINI_DAILY_LIMIT}`);
  console.log(`📊 Groq used tonight   : ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);
  console.log(`📦 Products tonight    : ${doneThisSession}`);
  console.log('='.repeat(55));
}

// ─── Entry Point ───────────────────────────────────────────────────────────
if (TEST_MODE) {
  runTestMode();
} else {
  runSEOPatterns();
}