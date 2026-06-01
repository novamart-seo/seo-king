/**
 * apiManager.js
 * Centralized AI API key rotation manager for Nova Mart SEO King.
 *
 * PROVIDERS & KEYS:
 *   Gemini     — 4 keys × 1,500 req/day   =   6,000/day
 *   Groq       — 4 keys × 14,400 req/day  =  57,600/day
 *   OpenRouter — 4 keys × 200 req/day     =     800/day  (DeepSeek V4 Flash free)
 *   TOTAL      ≈ 64,400 requests/day FREE
 *
 * ROTATION STRATEGY:
 *   1. Gemini keys used sequentially (Key1 → Key2 → Key3 → Key4)
 *   2. Switch to next Gemini key at 90% of daily safe limit (before hitting wall)
 *   3. When ALL Gemini keys exhausted → rotate through Groq keys
 *   4. When ALL Groq keys exhausted   → rotate through OpenRouter keys
 *   5. Per-minute rate limits enforced per key with automatic cooldown
 *
 * USAGE:
 *   const { callAI, callAIJson, getStatus } = require('./apiManager');
 *
 *   // Simple text call
 *   const result = await callAI('Your prompt here');
 *   if (result) console.log(result.text, result.provider, result.keyLabel);
 *
 *   // JSON call (auto-parses response)
 *   const json = await callAIJson('Return JSON: { "title": "..." }');
 *   if (json) console.log(json.data); // parsed object
 *
 *   // Check status of all keys
 *   console.log(getStatus());
 */

require('dotenv').config();
const axios = require('axios');
const Groq  = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════

const CONFIG = {
  gemini: {
    model:           'gemini-2.5-flash',
    safeLimit:       1350,   // 90% of 1,500 — switch before hitting wall
    rpmLimit:        13,     // 90% of 15 RPM
    delayMs:         5000,   // min ms between calls per key
    maxOutputTokens: 8192,
    temperature:     0.7,
    keys: [
      process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
    ],
  },
  groq: {
    model:       'llama-3.3-70b-versatile',
    safeLimit:   12960,  // 90% of 14,400
    rpmLimit:    27,     // 90% of 30 RPM
    delayMs:     2500,
    maxTokens:   4096,
    temperature: 0.7,
    keys: [
      process.env.GROQ_API_KEY,
      process.env.GROQ_API_KEY_2,
      process.env.GROQ_API_KEY_3,
      process.env.GROQ_API_KEY_4,
    ],
  },
  openrouter: {
    model:       'deepseek/deepseek-v4-flash:free',  // best free model on OpenRouter
    safeLimit:   180,    // 90% of 200 req/day per key
    rpmLimit:    18,     // 90% of 20 RPM
    delayMs:     3500,   // min ms between calls per key
    maxTokens:   4096,
    temperature: 0.7,
    baseUrl:     'https://openrouter.ai/api/v1/chat/completions',
    keys: [
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_API_KEY_2,
      process.env.OPENROUTER_API_KEY_3,
      process.env.OPENROUTER_API_KEY_4,
    ],
  },
};

const CALL_LOG_FILE = './api-manager-calls.json';
const wait = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// KEY STATE — tracks each key independently
// ════════════════════════════════════════════════════════════

function makeKeyState(keyValue, label) {
  return {
    value:      keyValue,
    label,
    callsToday: 0,
    lastCall:   0,
    rpmCount:   0,
    rpmWindow:  Date.now(),
    exhausted:  !keyValue,   // mark exhausted immediately if key not set
  };
}

const state = {
  gemini:     CONFIG.gemini.keys.map((k, i)     => makeKeyState(k, `Gemini-Key${i + 1}`)),
  groq:       CONFIG.groq.keys.map((k, i)       => makeKeyState(k, `Groq-Key${i + 1}`)),
  openrouter: CONFIG.openrouter.keys.map((k, i) => makeKeyState(k, `OpenRouter-Key${i + 1}`)),
};

// ════════════════════════════════════════════════════════════
// CALL LOG — persist daily counts across restarts
// ════════════════════════════════════════════════════════════

function loadCallLog() {
  try {
    if (fs.existsSync(CALL_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CALL_LOG_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        // Restore gemini counts
        (data.gemini || []).forEach((entry, i) => {
          if (state.gemini[i]) {
            state.gemini[i].callsToday = entry.calls || 0;
            if (entry.exhausted || entry.calls >= CONFIG.gemini.safeLimit)
              state.gemini[i].exhausted = true;
          }
        });
        // Restore groq counts
        (data.groq || []).forEach((entry, i) => {
          if (state.groq[i]) {
            state.groq[i].callsToday = entry.calls || 0;
            if (entry.exhausted || entry.calls >= CONFIG.groq.safeLimit)
              state.groq[i].exhausted = true;
          }
        });
        // Restore openrouter counts
        (data.openrouter || []).forEach((entry, i) => {
          if (state.openrouter[i]) {
            state.openrouter[i].callsToday = entry.calls || 0;
            if (entry.exhausted || entry.calls >= CONFIG.openrouter.safeLimit)
              state.openrouter[i].exhausted = true;
          }
        });
        console.log('📊 apiManager — call log restored for today');
        return;
      }
    }
  } catch (e) {}
  console.log('📊 apiManager — fresh day, all counters reset');
}

function saveCallLog() {
  try {
    fs.writeFileSync(CALL_LOG_FILE, JSON.stringify({
      date:       new Date().toDateString(),
      gemini:     state.gemini.map(s     => ({ label: s.label, calls: s.callsToday, exhausted: s.exhausted })),
      groq:       state.groq.map(s       => ({ label: s.label, calls: s.callsToday, exhausted: s.exhausted })),
      openrouter: state.openrouter.map(s => ({ label: s.label, calls: s.callsToday, exhausted: s.exhausted })),
    }, null, 2));
  } catch (e) {}
}

// ════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ════════════════════════════════════════════════════════════

function isDailyQuota(msg) {
  return (
    msg.includes('per day') || msg.includes('daily') ||
    msg.includes('requests per day') ||
    (msg.includes('quota') && msg.includes('day'))
  );
}

function isTemporary(msg) {
  return (
    msg.includes('429') || msg.includes('too many requests') ||
    msg.includes('resource_exhausted') || msg.includes('rate limit') ||
    msg.includes('503') || msg.includes('overloaded') ||
    msg.includes('500') || msg.includes('internal')
  );
}

function isInvalidKey(msg) {
  return (
    msg.includes('api_key_invalid') || msg.includes('api key not valid') ||
    msg.includes('invalid api key') || msg.includes('401')
  );
}

// ════════════════════════════════════════════════════════════
// RATE LIMITER — per key
// ════════════════════════════════════════════════════════════

async function enforceRate(keyState, config) {
  const now = Date.now();

  // Reset RPM window if > 60s
  if (now - keyState.rpmWindow > 60000) {
    keyState.rpmCount = 0;
    keyState.rpmWindow = now;
  }

  // Enforce minimum delay between calls
  const gap = now - keyState.lastCall;
  if (gap < config.delayMs) await wait(config.delayMs - gap);

  // Enforce RPM cap — wait out the window if needed
  if (keyState.rpmCount >= config.rpmLimit) {
    const pause = 60000 - (Date.now() - keyState.rpmWindow) + 2000;
    console.log(`   ⏳ ${keyState.label} RPM cap (${config.rpmLimit}/min) — cooling ${Math.round(pause / 1000)}s...`);
    await wait(pause);
    keyState.rpmCount = 0;
    keyState.rpmWindow = Date.now();
  }
}

// ════════════════════════════════════════════════════════════
// GEMINI CALLER
// ════════════════════════════════════════════════════════════

async function callGeminiKey(keyState, prompt, jsonMode = false, retries = 4) {
  if (!keyState.value || keyState.exhausted) return null;
  if (keyState.callsToday >= CONFIG.gemini.safeLimit) {
    if (!keyState.exhausted) {
      console.log(`   ⚠️  ${keyState.label} at safe limit (${keyState.callsToday}/${CONFIG.gemini.safeLimit}) — switching`);
      keyState.exhausted = true;
      saveCallLog();
    }
    return null;
  }

  const client = new GoogleGenerativeAI(keyState.value);
  let backoff = 20000;

  for (let i = 0; i < retries; i++) {
    if (keyState.callsToday >= CONFIG.gemini.safeLimit) {
      keyState.exhausted = true;
      saveCallLog();
      return null;
    }

    await enforceRate(keyState, CONFIG.gemini);

    try {
      keyState.rpmCount++;
      keyState.lastCall = Date.now();

      const genConfig = {
        maxOutputTokens: CONFIG.gemini.maxOutputTokens,
        temperature:     CONFIG.gemini.temperature,
      };
      if (jsonMode) genConfig.responseMimeType = 'application/json';

      const model  = client.getGenerativeModel({ model: CONFIG.gemini.model, generationConfig: genConfig });
      const result = await model.generateContent(prompt);
      const text   = result.response.text().trim();

      keyState.callsToday++;
      saveCallLog();
      return text;

    } catch (err) {
      keyState.rpmCount = Math.max(0, keyState.rpmCount - 1);
      const msg = (err.message || '').toLowerCase();

      if (isDailyQuota(msg)) {
        console.log(`   🛑 ${keyState.label} DAILY quota hit — switching key`);
        keyState.exhausted = true;
        keyState.callsToday = CONFIG.gemini.safeLimit;
        saveCallLog();
        return null;
      }
      if (isInvalidKey(msg)) {
        console.log(`   🛑 ${keyState.label} invalid key`);
        keyState.exhausted = true;
        saveCallLog();
        return null;
      }
      if (isTemporary(msg) && i < retries - 1) {
        keyState.rpmCount = 0;
        keyState.rpmWindow = Date.now();
        console.log(`   ⏳ ${keyState.label} temporary error — backoff ${Math.round(backoff / 1000)}s (attempt ${i + 1}/${retries})`);
        await wait(backoff);
        backoff = Math.min(backoff * 2, 120000);
      } else {
        console.log(`   ⚠️  ${keyState.label} error: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// GROQ CALLER
// ════════════════════════════════════════════════════════════

async function callGroqKey(keyState, prompt, jsonMode = false, retries = 4) {
  if (!keyState.value || keyState.exhausted) return null;
  if (keyState.callsToday >= CONFIG.groq.safeLimit) {
    if (!keyState.exhausted) {
      console.log(`   ⚠️  ${keyState.label} at safe limit (${keyState.callsToday}/${CONFIG.groq.safeLimit}) — switching`);
      keyState.exhausted = true;
      saveCallLog();
    }
    return null;
  }

  const client = new Groq({ apiKey: keyState.value });
  let backoff = 15000;

  for (let i = 0; i < retries; i++) {
    if (keyState.callsToday >= CONFIG.groq.safeLimit) {
      keyState.exhausted = true;
      saveCallLog();
      return null;
    }

    await enforceRate(keyState, CONFIG.groq);

    try {
      keyState.rpmCount++;
      keyState.lastCall = Date.now();

      const options = {
        model:       CONFIG.groq.model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  CONFIG.groq.maxTokens,
        temperature: CONFIG.groq.temperature,
      };
      if (jsonMode) options.response_format = { type: 'json_object' };

      const res  = await client.chat.completions.create(options);
      const text = res.choices[0].message.content.trim();

      keyState.callsToday++;
      saveCallLog();
      return text;

    } catch (err) {
      keyState.rpmCount = Math.max(0, keyState.rpmCount - 1);
      const msg = (err.message || '').toLowerCase();

      if (isDailyQuota(msg)) {
        console.log(`   🛑 ${keyState.label} DAILY quota hit — switching key`);
        keyState.exhausted = true;
        keyState.callsToday = CONFIG.groq.safeLimit;
        saveCallLog();
        return null;
      }
      if (isInvalidKey(msg)) {
        console.log(`   🛑 ${keyState.label} invalid key`);
        keyState.exhausted = true;
        saveCallLog();
        return null;
      }
      if ((isTemporary(msg) || msg.includes('429')) && i < retries - 1) {
        keyState.rpmCount = 0;
        keyState.rpmWindow = Date.now();
        console.log(`   ⏳ ${keyState.label} rate limit — backoff ${Math.round(backoff / 1000)}s`);
        await wait(backoff);
        backoff = Math.min(backoff * 2, 60000);
      } else {
        console.log(`   ⚠️  ${keyState.label} error: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// OPENROUTER CALLER (DeepSeek V4 Flash free)
// ════════════════════════════════════════════════════════════

async function callOpenRouterKey(keyState, prompt, jsonMode = false, retries = 4) {
  if (!keyState.value || keyState.exhausted) return null;
  if (keyState.callsToday >= CONFIG.openrouter.safeLimit) {
    if (!keyState.exhausted) {
      console.log(`   ⚠️  ${keyState.label} at safe limit (${keyState.callsToday}/${CONFIG.openrouter.safeLimit}) — switching`);
      keyState.exhausted = true;
      saveCallLog();
    }
    return null;
  }

  let backoff = 12000;

  for (let i = 0; i < retries; i++) {
    if (keyState.callsToday >= CONFIG.openrouter.safeLimit) {
      keyState.exhausted = true;
      saveCallLog();
      return null;
    }

    await enforceRate(keyState, CONFIG.openrouter);

    try {
      keyState.rpmCount++;
      keyState.lastCall = Date.now();

      const body = {
        model:       CONFIG.openrouter.model,
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  CONFIG.openrouter.maxTokens,
        temperature: CONFIG.openrouter.temperature,
      };
      if (jsonMode) body.response_format = { type: 'json_object' };

      const res = await axios.post(CONFIG.openrouter.baseUrl, body, {
        headers: {
          'Authorization': `Bearer ${keyState.value}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/novamart-seo/seo-king',
          'X-Title':       'Nova Mart SEO King',
        },
        timeout: 60000,
      });
      const text = res.data.choices[0].message.content.trim();

      keyState.callsToday++;
      saveCallLog();
      return text;

    } catch (err) {
      keyState.rpmCount = Math.max(0, keyState.rpmCount - 1);
      const status = err.response?.status || 0;
      const msg    = (err.message || '').toLowerCase();

      if (status === 401 || isInvalidKey(msg)) {
        console.log(`   🛑 ${keyState.label} invalid key`);
        keyState.exhausted = true;
        saveCallLog();
        return null;
      }
      if (isDailyQuota(msg) || status === 402) {
        console.log(`   🛑 ${keyState.label} daily quota hit — switching key`);
        keyState.exhausted = true;
        keyState.callsToday = CONFIG.openrouter.safeLimit;
        saveCallLog();
        return null;
      }
      if ((isTemporary(msg) || status === 429) && i < retries - 1) {
        keyState.rpmCount = 0;
        keyState.rpmWindow = Date.now();
        console.log(`   ⏳ ${keyState.label} rate limit — backoff ${Math.round(backoff / 1000)}s`);
        await wait(backoff);
        backoff = Math.min(backoff * 2, 60000);
      } else {
        console.log(`   ⚠️  ${keyState.label} error: ${msg.slice(0, 80)}`);
        return null;
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// MAIN ROUTER — Gemini → Groq → OpenRouter with per-key rotation
// ════════════════════════════════════════════════════════════

/**
 * callAI(prompt, jsonMode?)
 * Routes through all providers and keys automatically.
 * Returns: { text, provider, keyLabel } or null if everything exhausted.
 */
async function callAI(prompt, jsonMode = false) {
  // ── Try each Gemini key in order ──────────────────────────────────────────
  for (const keyState of state.gemini) {
    if (keyState.exhausted) continue;
    console.log(`   🤖 Trying ${keyState.label} (${keyState.callsToday}/${CONFIG.gemini.safeLimit})...`);
    const text = await callGeminiKey(keyState, prompt, jsonMode);
    if (text !== null) return { text, provider: 'gemini', keyLabel: keyState.label };
    if (!keyState.exhausted) return null; // temporary failure, not exhausted
  }

  // ── All Gemini exhausted → try each Groq key ──────────────────────────────
  const geminiAllExhausted = state.gemini.every(k => k.exhausted);
  if (geminiAllExhausted) {
    for (const keyState of state.groq) {
      if (keyState.exhausted) continue;
      console.log(`   🔄 Gemini exhausted — trying ${keyState.label} (${keyState.callsToday}/${CONFIG.groq.safeLimit})...`);
      const text = await callGroqKey(keyState, prompt, jsonMode);
      if (text !== null) return { text, provider: 'groq', keyLabel: keyState.label };
      if (!keyState.exhausted) return null;
    }
  }

  // ── All Groq exhausted → try each OpenRouter key ──────────────────────────
  const groqAllExhausted = state.groq.every(k => k.exhausted);
  if (geminiAllExhausted && groqAllExhausted) {
    for (const keyState of state.openrouter) {
      if (keyState.exhausted) continue;
      console.log(`   🔄 Groq exhausted — trying ${keyState.label} (${keyState.callsToday}/${CONFIG.openrouter.safeLimit})...`);
      const text = await callOpenRouterKey(keyState, prompt, jsonMode);
      if (text !== null) return { text, provider: 'openrouter', keyLabel: keyState.label };
      if (!keyState.exhausted) return null;
    }
  }

  console.log('   🛑 ALL API keys exhausted for today — no more calls possible');
  return null;
}

// ════════════════════════════════════════════════════════════
// JSON HELPER — auto-parses JSON from any provider
// ════════════════════════════════════════════════════════════

/**
 * callAIJson(prompt)
 * Same as callAI but returns { data (parsed object), provider, keyLabel }
 * Strips markdown fences and recovers partial JSON automatically.
 */
async function callAIJson(prompt) {
  const result = await callAI(prompt, true);
  if (!result) return null;

  try {
    let clean = result.text
      .replace(/^```json\s*/gi, '')
      .replace(/^```\s*/gi, '')
      .replace(/```\s*$/gi, '')
      .trim();

    // Find the outermost JSON object
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);

    // Attempt recovery if truncated
    if (!clean.endsWith('}')) {
      clean = clean.replace(/,?\s*"[^"]*"?\s*:\s*"[^"]*$/, '')
                   .replace(/,\s*$/, '') + '\n}';
    }

    const data = JSON.parse(clean);
    return { data, provider: result.provider, keyLabel: result.keyLabel };
  } catch (e) {
    console.log(`   ⚠️  JSON parse failed from ${result.keyLabel}: ${e.message}`);
    console.log(`   Raw snippet: ${result.text.slice(0, 200)}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// STATUS REPORTER
// ════════════════════════════════════════════════════════════

function getStatus() {
  const lines = ['\n📊 API Manager Status:'];

  for (const ks of state.gemini) {
    const pct  = Math.round((ks.callsToday / CONFIG.gemini.safeLimit) * 100);
    const flag = ks.exhausted ? '🛑' : pct >= 80 ? '⚠️ ' : '✅';
    lines.push(`   ${flag} ${ks.label.padEnd(18)} ${String(ks.callsToday).padStart(4)}/${CONFIG.gemini.safeLimit}   (${pct}%)${!ks.value ? '  [not set]' : ''}`);
  }
  for (const ks of state.groq) {
    const pct  = Math.round((ks.callsToday / CONFIG.groq.safeLimit) * 100);
    const flag = ks.exhausted ? '🛑' : pct >= 80 ? '⚠️ ' : '✅';
    lines.push(`   ${flag} ${ks.label.padEnd(18)} ${String(ks.callsToday).padStart(5)}/${CONFIG.groq.safeLimit}  (${pct}%)${!ks.value ? '  [not set]' : ''}`);
  }
  for (const ks of state.openrouter) {
    const pct  = Math.round((ks.callsToday / CONFIG.openrouter.safeLimit) * 100);
    const flag = ks.exhausted ? '🛑' : pct >= 80 ? '⚠️ ' : '✅';
    lines.push(`   ${flag} ${ks.label.padEnd(18)} ${String(ks.callsToday).padStart(3)}/${CONFIG.openrouter.safeLimit}    (${pct}%)${!ks.value ? '  [not set]' : ''}`);
  }

  const allExhausted = [
    ...state.gemini, ...state.groq, ...state.openrouter
  ].every(k => k.exhausted);
  lines.push(allExhausted ? '\n   🛑 ALL KEYS EXHAUSTED' : '\n   ✅ Keys available');

  return lines.join('\n');
}

/**
 * Returns true if at least one key across any provider is still usable.
 */
function hasCapacity() {
  return [...state.gemini, ...state.groq, ...state.openrouter].some(k => !k.exhausted && k.value);
}

// ════════════════════════════════════════════════════════════
// VERIFY ALL KEYS ON STARTUP
// ════════════════════════════════════════════════════════════

async function verifyAllKeys() {
  console.log('\n🔑 Verifying all API keys...');

  // ── Gemini ────────────────────────────────────────────────────────────────
  for (const ks of state.gemini) {
    if (!ks.value) { console.log(`   ⚠️  ${ks.label} — not configured`); continue; }
    if (ks.exhausted) { console.log(`   ⚠️  ${ks.label} — already exhausted`); continue; }
    // Skip verify call if already proven working today
    if (ks.callsToday > 0) { console.log(`   ✅ ${ks.label} — active (${ks.callsToday} calls today)`); continue; }
    try {
      const client = new GoogleGenerativeAI(ks.value);
      const model  = client.getGenerativeModel({ model: CONFIG.gemini.model });
      await model.generateContent('Reply with one word: OK');
      ks.callsToday++;
      saveCallLog();
      console.log(`   ✅ ${ks.label} verified`);
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      if (isDailyQuota(msg)) {
        console.log(`   🛑 ${ks.label} — daily quota already hit`);
        ks.exhausted = true;
        saveCallLog();
      } else if (isInvalidKey(msg)) {
        console.log(`   🛑 ${ks.label} — invalid key`);
        ks.exhausted = true;
        saveCallLog();
      } else {
        console.log(`   ⚠️  ${ks.label} — temp error (${msg.slice(0, 50)}) — keeping active`);
      }
    }
    await wait(500);
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  for (const ks of state.groq) {
    if (!ks.value) { console.log(`   ⚠️  ${ks.label} — not configured`); continue; }
    if (ks.exhausted) { console.log(`   ⚠️  ${ks.label} — already exhausted`); continue; }
    if (ks.callsToday > 0) { console.log(`   ✅ ${ks.label} — active (${ks.callsToday} calls today)`); continue; }
    try {
      const client = new Groq({ apiKey: ks.value });
      await client.chat.completions.create({
        model:    CONFIG.groq.model,
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 5,
      });
      ks.callsToday++;
      saveCallLog();
      console.log(`   ✅ ${ks.label} verified`);
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      if (isDailyQuota(msg)) {
        console.log(`   🛑 ${ks.label} — daily quota already hit`);
        ks.exhausted = true;
        saveCallLog();
      } else if (isInvalidKey(msg)) {
        console.log(`   🛑 ${ks.label} — invalid key`);
        ks.exhausted = true;
        saveCallLog();
      } else {
        console.log(`   ⚠️  ${ks.label} — temp error — keeping active`);
      }
    }
    await wait(300);
  }

  // ── OpenRouter ────────────────────────────────────────────────────────────
  for (const ks of state.openrouter) {
    if (!ks.value) { console.log(`   ⚠️  ${ks.label} — not configured`); continue; }
    if (ks.exhausted) { console.log(`   ⚠️  ${ks.label} — already exhausted`); continue; }
    if (ks.callsToday > 0) { console.log(`   ✅ ${ks.label} — active (${ks.callsToday} calls today)`); continue; }
    try {
      await axios.post(CONFIG.openrouter.baseUrl, {
        model:      CONFIG.openrouter.model,
        messages:   [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 5,
      }, {
        headers: {
          'Authorization': `Bearer ${ks.value}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/novamart-seo/seo-king',
          'X-Title':       'Nova Mart SEO King',
        },
        timeout: 15000,
      });
      ks.callsToday++;
      saveCallLog();
      console.log(`   ✅ ${ks.label} verified`);
    } catch (err) {
      const status = err.response?.status || 0;
      const msg    = (err.message || '').toLowerCase();
      if (status === 401 || isInvalidKey(msg)) {
        console.log(`   🛑 ${ks.label} — invalid key`);
        ks.exhausted = true;
        saveCallLog();
      } else {
        console.log(`   ⚠️  ${ks.label} — temp error — keeping active`);
      }
    }
    await wait(300);
  }

  if (!hasCapacity()) {
    console.log('\n   🛑 No valid API keys found. Check your .env / GitHub Secrets.');
    process.exit(1);
  }

  console.log(getStatus());
}

// ════════════════════════════════════════════════════════════
// INIT — load call log on require
// ════════════════════════════════════════════════════════════

loadCallLog();

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

module.exports = {
  callAI,          // callAI(prompt, jsonMode?) → { text, provider, keyLabel } | null
  callAIJson,      // callAIJson(prompt)        → { data, provider, keyLabel } | null
  getStatus,       // getStatus()               → formatted string
  hasCapacity,     // hasCapacity()             → boolean
  verifyAllKeys,   // verifyAllKeys()           → Promise<void>
};