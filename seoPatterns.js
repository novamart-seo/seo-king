/**
 * seoPatterns.js
 * Runs nightly at 2am via GitHub Actions.
 *
 * BATCH MODE: all 8 fields in ONE API call per product.
 * KEY STRATEGY: Use Gemini Key1 fully → then Key2 → then Groq backup.
 * Real free tier: 250 RPD / 10 RPM per key. Safe limit: 240.
 *
 * FIXES:
 *  - 429 / 503 / RESOURCE_EXHAUSTED (per-minute) are TEMPORARY → retry, never kill key.
 *  - Only an explicit "per day / daily" quota message marks a key exhausted.
 *  - Counter increments only on SUCCESS (quota never wasted on failures).
 *  - Body HTML cleaned: stray intro paragraph removed, banned words stripped.
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');
const Groq  = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Store + Auth ──────────────────────────────────────────────────────────
const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Gemini Keys ───────────────────────────────────────────────────────────
const GEMINI_KEY_1 = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1;
const GEMINI_KEY_2 = process.env.GEMINI_API_KEY_2;

if (!GEMINI_KEY_1) {
  console.error('❌ No Gemini Key 1 found. Set GEMINI_API_KEY (or GEMINI_API_KEY_1) in .env');
  process.exit(1);
}

const geminiClient1 = new GoogleGenerativeAI(GEMINI_KEY_1);
const geminiClient2 = GEMINI_KEY_2 ? new GoogleGenerativeAI(GEMINI_KEY_2) : null;

// ─── Groq (fallback) ───────────────────────────────────────────────────────
const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Limits ────────────────────────────────────────────────────────────────
const GEMINI_SAFE_LIMIT = 240;
const GEMINI_RPM_LIMIT  = 9;
const GEMINI_DELAY_MS   = 7000;
const GROQ_DAILY_LIMIT  = 1000;
const GROQ_RPM_LIMIT    = 2;
const GROQ_DELAY_MS     = 22000;
const MAX_RUN_MINUTES   = 320;
const RUN_START_TIME    = Date.now();

// ─── Generation config ─────────────────────────────────────────────────────
const GEMINI_GEN_CONFIG = {
  responseMimeType: 'application/json',
  maxOutputTokens: 8192,
  temperature: 0.7,
};

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
const CALL_LOG_FILE = './pattern-calls.json';

// ─── Shopify client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════════

function isDailyQuotaError(msg) {
  return (
    msg.includes('per day') ||
    msg.includes('perday') ||
    msg.includes('daily limit') ||
    msg.includes('requests per day') ||
    (msg.includes('quota') && msg.includes('day'))
  );
}

function isTemporaryError(msg) {
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('500') ||
    msg.includes('internal')
  );
}

function isInvalidKeyError(msg) {
  return msg.includes('api_key_invalid') || msg.includes('api key not valid');
}

// ══════════════════════════════════════════════════════════════════════════
// PROGRESS & CALL TRACKING
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

const key = {
  1: { callsToday: 0, lastCall: 0, rpmCount: 0, rpmWindow: Date.now(), exhausted: false },
  2: { callsToday: 0, lastCall: 0, rpmCount: 0, rpmWindow: Date.now(), exhausted: !GEMINI_KEY_2 },
};
let groqCallsToday = 0, groqLastCall = 0, groqRpmCount = 0;
let groqRpmWindow  = Date.now(), groqExhausted = false;

function loadCallLog() {
  try {
    if (fs.existsSync(CALL_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CALL_LOG_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        key[1].callsToday = data.key1 || 0;
        key[2].callsToday = data.key2 || 0;
        groqCallsToday    = data.groq  || 0;
        if (data.key1_exhausted) key[1].exhausted = true;
        if (data.key2_exhausted) key[2].exhausted = true;
        if (data.groq_exhausted) groqExhausted    = true;
        if (key[1].callsToday >= GEMINI_SAFE_LIMIT) key[1].exhausted = true;
        if (key[2].callsToday >= GEMINI_SAFE_LIMIT || !GEMINI_KEY_2) key[2].exhausted = true;
        if (groqCallsToday >= GROQ_DAILY_LIMIT) groqExhausted = true;
        const k2str = GEMINI_KEY_2 ? `${key[2].callsToday}/${GEMINI_SAFE_LIMIT}${key[2].exhausted ? ' 🚫' : ''}` : 'not set';
        console.log(`📊 pattern-calls — Key1: ${key[1].callsToday}/${GEMINI_SAFE_LIMIT}${key[1].exhausted ? ' 🚫' : ''} | Key2: ${k2str} | Groq: ${groqCallsToday}/${GROQ_DAILY_LIMIT}${groqExhausted ? ' 🚫' : ''}`);
        return;
      }
    }
  } catch (e) {}
  console.log('📊 pattern-calls — fresh day');
}

function saveCallLog() {
  fs.writeFileSync(CALL_LOG_FILE, JSON.stringify({
    date:           new Date().toDateString(),
    key1:           key[1].callsToday,
    key2:           key[2].callsToday,
    groq:           groqCallsToday,
    key1_exhausted: key[1].exhausted,
    key2_exhausted: key[2].exhausted,
    groq_exhausted: groqExhausted,
  }, null, 2));
}

function allExhausted() {
  return key[1].exhausted && key[2].exhausted && groqExhausted;
}

// ══════════════════════════════════════════════════════════════════════════
// RATE LIMITERS
// ══════════════════════════════════════════════════════════════════════════

async function enforceGeminiRate(keyNum) {
  const s = key[keyNum];
  if (Date.now() - s.rpmWindow > 60000) { s.rpmCount = 0; s.rpmWindow = Date.now(); }
  const gap = Date.now() - s.lastCall;
  if (gap < GEMINI_DELAY_MS) await wait(GEMINI_DELAY_MS - gap);
  if (s.rpmCount >= GEMINI_RPM_LIMIT) {
    const pause = 60000 - (Date.now() - s.rpmWindow) + 2000;
    console.log(`   ⏳ Gemini Key${keyNum} at ${GEMINI_RPM_LIMIT} RPM — cooling down ${Math.round(pause / 1000)}s...`);
    await wait(pause);
    s.rpmCount = 0; s.rpmWindow = Date.now();
  }
}

async function enforceGroqRate() {
  if (Date.now() - groqRpmWindow > 60000) { groqRpmCount = 0; groqRpmWindow = Date.now(); }
  const gap = Date.now() - groqLastCall;
  if (gap < GROQ_DELAY_MS) await wait(GROQ_DELAY_MS - gap);
  if (groqRpmCount >= GROQ_RPM_LIMIT) {
    const pause = 60000 - (Date.now() - groqRpmWindow) + 1000;
    console.log(`   ⏳ Groq RPM — waiting ${Math.round(pause / 1000)}s...`);
    await wait(pause);
    groqRpmCount = 0; groqRpmWindow = Date.now();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// AI GENERATORS
// ══════════════════════════════════════════════════════════════════════════

async function callGeminiKey(keyNum, prompt, retries = 4) {
  const s      = key[keyNum];
  const client = keyNum === 1 ? geminiClient1 : geminiClient2;
  if (!client || s.exhausted) return null;
  if (s.callsToday >= GEMINI_SAFE_LIMIT) {
    if (!s.exhausted) { console.log(`   ⚠️  Gemini Key${keyNum} hit daily safe limit (${s.callsToday}/${GEMINI_SAFE_LIMIT})`); s.exhausted = true; saveCallLog(); }
    return null;
  }
  let backoff = 20000;
  for (let i = 0; i < retries; i++) {
    if (s.callsToday >= GEMINI_SAFE_LIMIT) { s.exhausted = true; saveCallLog(); return null; }
    await enforceGeminiRate(keyNum);
    try {
      s.rpmCount++; s.lastCall = Date.now();
      const model  = client.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: GEMINI_GEN_CONFIG });
      const result = await model.generateContent(prompt);
      const text   = result.response.text().trim();
      s.callsToday++; saveCallLog();
      return text;
    } catch (err) {
      s.rpmCount = Math.max(0, s.rpmCount - 1);
      const msg = (err.message || '').toLowerCase();
      if (isDailyQuotaError(msg)) {
        console.log(`   🛑 Gemini Key${keyNum} DAILY quota exhausted — switching key`);
        s.exhausted = true; s.callsToday = GEMINI_SAFE_LIMIT; saveCallLog(); return null;
      }
      if (isInvalidKeyError(msg)) {
        console.log(`   🛑 Gemini Key${keyNum} invalid — check your .env`);
        s.exhausted = true; saveCallLog(); return null;
      }
      if (isTemporaryError(msg) && i < retries - 1) {
        s.rpmCount = 0; s.rpmWindow = Date.now();
        console.log(`   ⏳ Gemini Key${keyNum} temporary error (${msg.slice(0, 40)}) — backoff ${Math.round(backoff / 1000)}s (attempt ${i + 1}/${retries})...`);
        await wait(backoff); backoff = Math.min(backoff * 2, 120000);
      } else {
        console.log(`   ⚠️  Gemini Key${keyNum} error: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }
  return null;
}

async function generateWithGemini(prompt) {
  for (const keyNum of [1, 2]) {
    if (key[keyNum].exhausted) continue;
    const result = await callGeminiKey(keyNum, prompt);
    if (result) return { text: result, engine: `Gemini-Key${keyNum}` };
    if (!key[keyNum].exhausted) return null;
  }
  return null;
}

async function generateWithGroq(prompt, retries = 4) {
  if (groqExhausted || groqCallsToday >= GROQ_DAILY_LIMIT) { groqExhausted = true; return null; }
  let backoff = 15000;
  for (let i = 0; i < retries; i++) {
    if (groqCallsToday >= GROQ_DAILY_LIMIT) { groqExhausted = true; return null; }
    await enforceGroqRate();
    try {
      groqRpmCount++; groqLastCall = Date.now();
      const res = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1800,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });
      const text = res.choices[0].message.content.trim();
      groqCallsToday++; saveCallLog();
      return text;
    } catch (err) {
      groqRpmCount = Math.max(0, groqRpmCount - 1);
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('401')) { console.log('   🛑 Invalid Groq key.'); process.exit(1); }
      if (msg.includes('daily') || msg.includes('per day')) { groqExhausted = true; return null; }
      if (msg.includes('429') && i < retries - 1) {
        console.log(`   ⏳ Groq rate limit — waiting ${backoff / 1000}s...`);
        await wait(backoff); backoff = Math.min(backoff * 2, 60000);
        groqRpmCount = 0; groqRpmWindow = Date.now();
      } else {
        console.log(`   ⚠️  Groq error: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }
  return null;
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
// PARSE BATCH RESPONSE
// ══════════════════════════════════════════════════════════════════════════

function parseBatchResponse(raw) {
  try {
    let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    clean = clean.slice(start, end + 1);
    return JSON.parse(clean);
  } catch (e) {
    try {
      const get = (field) => {
        const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"[a-zA-Z]|\\s*\\})`));
        return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : null;
      };
      const result = {
        h1:          get('h1'),
        metaTitle:   get('metaTitle'),
        metaDesc:    get('metaDesc'),
        bodyHtml:    get('bodyHtml'),
        tags:        get('tags'),
        urlHandle:   get('urlHandle'),
        techSummary: get('techSummary'),
        template:    get('template'),
      };
      if (result.h1) return result;
      return null;
    } catch (e2) { return null; }
  }
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
// PROCESS ONE PRODUCT
// ══════════════════════════════════════════════════════════════════════════

async function applyPatterns(product) {
  console.log(`\n🔧 ${product.title}`);
  console.log(`   Key1: ${key[1].callsToday}/${GEMINI_SAFE_LIMIT} | Key2: ${GEMINI_KEY_2 ? key[2].callsToday + '/' + GEMINI_SAFE_LIMIT : 'not set'} | Groq: ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);

  const prompt = buildBatchPrompt(product);

  console.log('   [BATCH] Generating all 8 fields in one call...');
  let rawResponse = null;
  let engine      = '';

  const geminiResult = await generateWithGemini(prompt);
  if (geminiResult) { rawResponse = geminiResult.text; engine = geminiResult.engine; }

  if (!rawResponse && key[1].exhausted && key[2].exhausted) {
    console.log('   🔄 Both Gemini keys exhausted — Groq backup...');
    rawResponse = await generateWithGroq(prompt);
    engine      = 'Groq';
  }

  if (!rawResponse) { console.log('   ❌ AI generation failed for this product — will retry next run'); return false; }

  const batch = parseBatchResponse(rawResponse);
  if (!batch) {
    console.log(`   ⚠️  Could not parse JSON from ${engine} — skipping`);
    console.log(`   Raw (first 300): ${rawResponse.slice(0, 300)}`);
    return false;
  }

  console.log(`   ✅ Batch received from ${engine}`);

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
// KEY VERIFICATION
// ══════════════════════════════════════════════════════════════════════════

async function verifyKeys() {
  console.log('\n🔑 Verifying API keys...');
  console.log(`   Key1 source: ${process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GEMINI_API_KEY_1 (fallback)'}`);
  for (const keyNum of [1, 2]) {
    const client = keyNum === 1 ? geminiClient1 : geminiClient2;
    if (!client) { console.log(`   ⚠️  Gemini Key${keyNum} — not configured`); key[keyNum].exhausted = true; saveCallLog(); continue; }
    if (key[keyNum].exhausted) { console.log(`   ⚠️  Gemini Key${keyNum} already exhausted — skipping`); continue; }
    if (key[keyNum].callsToday >= GEMINI_SAFE_LIMIT) { console.log(`   ⚠️  Gemini Key${keyNum} already at safe limit — skipping`); key[keyNum].exhausted = true; saveCallLog(); continue; }
    try {
      const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
      await model.generateContent('Reply with one word: OK');
      console.log(`   ✅ Gemini Key${keyNum} verified`);
      key[keyNum].callsToday++; saveCallLog();
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const isNetworkError = msg.includes('fetch') || msg.includes('network') ||
                             msg.includes('econnrefused') || msg.includes('timeout') ||
                             msg.includes('socket') || msg.includes('dns');
      if (!isNetworkError && (isDailyQuotaError(msg) || isInvalidKeyError(msg))) {
        console.log(`   🛑 Gemini Key${keyNum} unusable: ${msg.slice(0, 80)}`);
        key[keyNum].exhausted = true; saveCallLog();
      } else {
        console.log(`   ⚠️  Gemini Key${keyNum} temporary verify error (${msg.slice(0, 60)}) — keeping key active`);
      }
    }
  }
  try {
    await groq.chat.completions.create({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 5 });
    console.log('   ✅ Groq verified');
    groqCallsToday++; saveCallLog();
  } catch (err) {
    console.log(`   ⚠️  Groq failed: ${err.message.slice(0, 80)}`);
    if ((err.message || '').toLowerCase().includes('401')) groqExhausted = true;
  }
  if (key[1].exhausted && key[2].exhausted && groqExhausted) {
    console.log('\n   🛑 All API keys failed or exhausted. Exiting.'); process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE RUNNERS
// ══════════════════════════════════════════════════════════════════════════

async function runBaseline(progress, products) {
  console.log('\n⚡ PHASE 1 — BASELINE RUN');
  console.log(`   Goal : optimize all ${products.length} products once`);
  console.log(`   Mode : BATCH — 1 API call per product`);
  console.log(`   Budget: ~${GEMINI_SAFE_LIMIT * (GEMINI_KEY_2 ? 2 : 1)} products/night (Gemini) + Groq backup`);
  console.log('='.repeat(55));

  const remaining = products.filter(p => !progress.completed.includes(p.id));
  if (remaining.length === 0) {
    console.log('\n🎉 Baseline complete! Triggering 45-day cooldown...');
    progress.phase = 'cooldown'; progress.baseline_complete = true;
    progress.cooldown_until = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    saveProgress(progress); console.log(`🔒 Cooldown until: ${progress.cooldown_until}`); return;
  }

  console.log(`\n📦 Total   : ${products.length}`);
  console.log(`✅ Done    : ${progress.completed.length}`);
  console.log(`📋 Tonight : up to ${remaining.length} remaining\n`);

  let doneThisSession = 0;
  for (const product of remaining) {
    if (allExhausted()) { console.log('\n🛑 All API limits reached — saving progress.'); break; }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) { console.log('\n⏱️  Time limit reached.'); break; }
    const success = await applyPatterns(product);
    if (success) { progress.completed.push(product.id); doneThisSession++; }
    saveProgress(progress);
    console.log(`   📊 Tonight: ${doneThisSession} | Baseline: ${progress.completed.length}/${products.length}`);
  }

  if (products.every(p => progress.completed.includes(p.id))) {
    console.log('\n🎉 Baseline complete! Triggering 45-day cooldown...');
    progress.phase = 'cooldown'; progress.baseline_complete = true;
    progress.cooldown_until = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    saveProgress(progress); console.log(`🔒 Cooldown until: ${progress.cooldown_until}`);
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
    console.log('   ✅ No changes. New products handled by pollAndFix.js.'); return;
  }
  console.log('\n✅ Cooldown complete! Moving to Tier Mode...');
  progress.phase = 'tier'; progress.cooldown_until = null; progress.completed = [];
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
    if (allExhausted()) { console.log('\n🛑 All API limits reached.'); break; }
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
  console.log(`   Key 1 : ${process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GEMINI_API_KEY_1 (fallback)'}`);
  console.log(`   Key 2 : ${GEMINI_KEY_2 ? 'GEMINI_API_KEY_2' : 'not configured'}`);
  console.log('   Groq  : backup');
  console.log('   Mode  : BATCH (1 API call = all 8 fields) → saves to Shopify');
  console.log('='.repeat(55));

  loadCallLog();
  await verifyKeys();

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
  console.log(`📊 Gemini Key1 : ${key[1].callsToday}/${GEMINI_SAFE_LIMIT}`);
  console.log(`📊 Gemini Key2 : ${GEMINI_KEY_2 ? key[2].callsToday + '/' + GEMINI_SAFE_LIMIT : 'not configured'}`);
  console.log(`📊 Groq        : ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);
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
  console.log(`   Key 1 : ${process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GEMINI_API_KEY_1 (fallback)'}`);
  console.log(`   Key 2 : ${GEMINI_KEY_2 ? 'GEMINI_API_KEY_2' : 'not configured'}`);
  console.log('   Groq  : backup');
  console.log('   Mode  : BATCH (1 API call per product = all 8 fields)');
  console.log('   Strategy: Key1 → Key2 → Groq (sequential)');
  console.log('='.repeat(55));

  loadCallLog();
  await verifyKeys();

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
  console.log(`📊 Gemini Key1 : ${key[1].callsToday}/${GEMINI_SAFE_LIMIT}`);
  console.log(`📊 Gemini Key2 : ${GEMINI_KEY_2 ? key[2].callsToday + '/' + GEMINI_SAFE_LIMIT : 'not configured'}`);
  console.log(`📊 Groq        : ${groqCallsToday}/${GROQ_DAILY_LIMIT}`);
  console.log('='.repeat(55));
}

// ─── Export for pollAndFix.js ──────────────────────────────────────────────
// When required as a module, applyPatterns is available directly.
// When run directly (node seoPatterns.js), main() runs as normal.
if (require.main === module) {
  main().catch(err => {
    console.error('❌ seoPatterns crashed:', err.message);
    process.exit(1);
  });
}

module.exports = { applyPatterns };