require('dotenv').config();
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Per-minute throttle ───────────────────────────────────────────────────
let callCount = 0;
let windowStart = Date.now();
const MAX_CALLS_PER_MINUTE = 12; // stay safely under Gemini's 15 RPM free limit

async function generateWithGemini(prompt, retries = 3) {
  // Reset window every 60 seconds
  if (Date.now() - windowStart > 60000) {
    callCount = 0;
    windowStart = Date.now();
  }

  // If approaching the limit, wait out the remainder of the window
  if (callCount >= MAX_CALLS_PER_MINUTE) {
    const elapsed = Date.now() - windowStart;
    const waitTime = 60000 - elapsed + 1000; // +1s buffer
    console.log(`   ⏳ Throttling — waiting ${Math.round(waitTime / 1000)}s to respect rate limit...`);
    await wait(waitTime);
    callCount = 0;
    windowStart = Date.now();
  }

  for (let i = 0; i < retries; i++) {
    try {
      callCount++;
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      if (error.message.includes('429') || error.message.includes('quota')) {
        console.log('   ⏳ 429 received — waiting 60 seconds...');
        await wait(60000); // wait full minute on hard rate limit
        callCount = 0;
        windowStart = Date.now();
      } else {
        throw error;
      }
    }
  }
  return null;
}
// ──────────────────────────────────────────────────────────────────────────

async function generateH1Title(product) {
  const existingDesc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 300) || '';
  const prompt = `Generate an H1 product title following this EXACT pattern:
[Full Product Name] – [Key Material or Feature] [Size/Quantity if applicable]

Product: ${product.title}
Existing description: ${existingDesc}

Rules:
- Between 50-70 characters
- Must include the FULL product name — never shorten or abbreviate it
- Must add key material or standout feature after a dash
- Must add size quantity or set info at the end if available in description
- No quotes no punctuation at end
- Return ONLY the H1 title nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy Alcohol Scent 100ml
Marvel Iron Man ANC TWS Earbuds – HiFi 13mm Drivers 2-Piece
MOLLE Tactical Backpack – Waterproof Nylon 30L 45L 80L
Women's High Waist Wide-Leg Pants – Soft Cotton 3-Piece Set
Cordless Stick Vacuum Cleaner – 55Kpa HEPA 10-in-1 500W`;

  return await generateWithGemini(prompt);
}

async function generateMetaTitle(product) {
  const existingDesc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 200) || '';
  const prompt = `Generate a meta title following this EXACT pattern:
[Full Product Name] – [Most Specific Feature with number or spec] | Nova Mart

Product: ${product.title}
Product info: ${existingDesc}

Rules:
- Between 50-60 characters
- Must include the full product name
- Must add the MOST specific unique feature — use real numbers or specs from product info
- Must end with | Nova Mart
- No quotes
- Never use generic words like quality best amazing perfect
- Return ONLY the meta title nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy 100ml | Nova Mart
Marvel Iron Man ANC Earbuds – 13mm HiFi 15H | Nova Mart
Cordless Vacuum 500W – 55Kpa HEPA 10-in-1 | Nova Mart
MOLLE Tactical Backpack – Waterproof 30L Nylon | Nova Mart`;

  return await generateWithGemini(prompt);
}

async function generateMetaDescription(product) {
  const existingDesc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 400) || '';
  const prompt = `Generate an appealing and specific meta description.

Product: ${product.title}
Product details: ${existingDesc}

Rules:
- Between 140-160 characters exactly
- NO quotes anywhere
- Must be emotionally appealing and specific — not generic
- Start with an action word or emotional hook that makes customer want to click
- Include 2 real specific features with numbers or specs from product info
- Must end with exactly: Free Delivery at Nova Mart!
- Never use: Experience Enjoy Discover Amazing Best Quality Perfect
- Think like a copywriter not a robot
- Return ONLY the meta description nothing else

Great examples:
Turn heads with 1 Million EDT — fresh spicy scent that lasts all day. 100ml unisex formula. Free Delivery at Nova Mart!
Block the noise. Own the sound. 13mm HiFi drivers and 15H battery in Marvel Iron Man ANC earbuds. Free Delivery at Nova Mart!
55Kpa suction. HEPA filtration. 10 tools in one cordless vacuum. Clean every corner fast. Free Delivery at Nova Mart!

Bad examples never write like this:
Enjoy our amazing quality product with best features available online...
Experience the freedom of cleaning your home with our vacuum...`;

  return await generateWithGemini(prompt);
}

async function generateProductDescription(product) {
  const existingDesc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 500) || '';
  const prompt = `Write a complete product description for Nova Mart Shopify store.

Product: ${product.title}
Existing info: ${existingDesc}

BRAND VOICE: Nova Mart — sophisticated, minimalist, confident.
Short punchy sentences. Never generic. Never copy supplier text.
Rewrite everything uniquely in Nova Mart voice.

Follow this EXACT HTML structure:

<p><em>[ONE punchy 8-12 word sentence only. Core emotional or practical benefit. No fluff. Examples: Clean smarter not harder. / Sound without compromise. / Built for those who move fast. / Your signature scent starts here.]</em></p>

<h2>Key Features</h2>
<ul>
<li><b>[Specific Feature Name]:</b> [One sentence explaining WHY it matters to customer. Use real specs from product info.]</li>
[5-7 bullets total]
</ul>

<h2>Why It Works For You</h2>
<p>[2-3 sentences. Speak directly to customer using you. Practical daily benefit. No generic claims.]</p>

<h2>Technical Specifications</h2>
<table>
<tr><th>Specification</th><th>Details</th></tr>
<tr><td>[Spec name]</td><td>[Spec value]</td></tr>
[5-8 rows with real specs extracted from product info]
</table>

Rules:
- Minimum 300 words
- Never use Experience Enjoy Amazing Best Quality Perfect
- Every bullet must have bold benefit name followed by colon
- Extract real numbers and specs from existing info
- Hook must be SHORT — maximum 12 words
- Return ONLY the HTML nothing else`;

  return await generateWithGemini(prompt);
}

async function generateTags(product) {
  const prompt = `Generate SEO tags for this Shopify product.

Product: ${product.title}

Rules:
- Generate 8-10 tags
- Mix of broad and specific keywords
- Include product type material feature use case audience style
- Each tag under 25 characters
- Comma separated
- No quotes
- Return ONLY the comma-separated tags nothing else

Example:
wireless earbuds, anc earbuds, marvel earbuds, hifi sound, 15h battery, gaming earbuds, touch control, bluetooth earbuds`;

  const result = await generateWithGemini(prompt);
  return result ? result.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];
}

async function saveMetafield(productId, key, value) {
  try {
    const existingMetafields = await shopify.get(`/products/${productId}/metafields.json`);
    const existing = existingMetafields.data.metafields.find(
      m => m.namespace === 'global' && m.key === key
    );

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

async function applyPatterns(product) {
  console.log(`\n🔧 Applying SEO patterns: ${product.title}`);
  const updates = {};

  try {
    // H1 title
    console.log('   Generating H1 title...');
    const h1Title = await generateH1Title(product);
    if (h1Title) {
      updates.title = h1Title;
      console.log(`   ✅ H1: ${h1Title}`);
    }

    // Meta title
    console.log('   Generating meta title...');
    const metaTitle = await generateMetaTitle(product);
    if (metaTitle) {
      await saveMetafield(product.id, 'title_tag', metaTitle);
      console.log(`   ✅ Meta title: ${metaTitle}`);
    }

    // Meta description
    console.log('   Generating meta description...');
    const metaDesc = await generateMetaDescription(product);
    if (metaDesc) {
      await saveMetafield(product.id, 'description_tag', metaDesc);
      console.log(`   ✅ Meta desc: ${metaDesc.slice(0, 60)}...`);
    }

    // Product description
    console.log('   Generating product description...');
    const productDesc = await generateProductDescription(product);
    if (productDesc) {
      updates.body_html = productDesc;
      console.log(`   ✅ Product description generated`);
    }

    // Tags
    console.log('   Generating tags...');
    const tags = await generateTags(product);
    if (tags.length > 0) {
      updates.tags = tags.join(', ');
      console.log(`   ✅ Tags: ${tags.slice(0, 3).join(', ')}...`);
    }

    // Save all product updates
    if (Object.keys(updates).length > 0) {
      await shopify.put(`/products/${product.id}.json`, {
        product: { id: product.id, ...updates }
      });
      console.log(`   ✅ All updates saved to Shopify`);
    }

  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
  }
}

async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle,body_html,tags,images';

  while (url) {
    const response = await shopify.get(url);
    products = [...products, ...response.data.products];
    const linkHeader = response.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
    } else {
      url = null;
    }
  }
  return products;
}

async function runSEOPatterns() {
  console.log('\n🚀 Starting SEO Pattern Application for Nova Mart...\n');
  console.log('Applying Google-approved patterns for:');
  console.log('  ✅ H1 product titles');
  console.log('  ✅ Meta titles with Nova Mart brand');
  console.log('  ✅ Meta descriptions with Free Delivery CTA');
  console.log('  ✅ Product descriptions benefit-first unique');
  console.log('  ✅ SEO tags');
  console.log('\n' + '='.repeat(50));

  try {
    const products = await getAllProducts();
    console.log(`Found ${products.length} total products`);

    // TEST MODE — same 2 specific products every time
    const testProducts = products.filter(p =>
      p.title.includes('1 Million') ||
      p.title.includes('Cordless Stick Vacuum')
    );

    console.log(`Processing ${testProducts.length} test products\n`);

    let done = 0;
    for (const product of testProducts) {
      await applyPatterns(product);
      done++;
      console.log(`\n   Progress: ${done}/${testProducts.length}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ SEO PATTERNS COMPLETE');
    console.log('='.repeat(50));
    console.log(`Products updated: ${done}`);

  } catch (error) {
    console.error('SEO Patterns failed:', error.message);
  }
}

runSEOPatterns();