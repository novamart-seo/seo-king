require('dotenv').config();
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

// Fetch real SEO metafields for a product
async function getProductSEO(productId) {
  try {
    const response = await shopify.get(`/products/${productId}/metafields.json`);
    const metafields = response.data.metafields;
    const seo = {};
    metafields.forEach(m => {
      if (m.namespace === 'global' && m.key === 'title_tag') seo.title = m.value;
      if (m.namespace === 'global' && m.key === 'description_tag') seo.description = m.value;
    });
    return seo;
  } catch {
    return {};
  }
}

// SEO scoring function
async function auditProduct(product) {
  const issues = [];
  let score = 100;

  // Fetch real SEO data from metafields
  const seo = await getProductSEO(product.id);

  // Check meta title
  const metaTitle = seo.title || product.title || '';
  if (!metaTitle) {
    issues.push('❌ Missing meta title');
    score -= 20;
  } else if (metaTitle.length < 30) {
    issues.push(`⚠️ Meta title too short (${metaTitle.length} chars, min 30)`);
    score -= 10;
  } else if (metaTitle.length > 60) {
    issues.push(`⚠️ Meta title too long (${metaTitle.length} chars, max 60)`);
    score -= 5;
  }

  // Check meta description
  const metaDesc = seo.description || '';
  if (!metaDesc) {
    issues.push('❌ Missing meta description');
    score -= 20;
  } else if (metaDesc.length < 100) {
    issues.push(`⚠️ Meta description too short (${metaDesc.length} chars, min 100)`);
    score -= 10;
  } else if (metaDesc.length > 160) {
    issues.push(`⚠️ Meta description too long (${metaDesc.length} chars, max 160)`);
    score -= 5;
  }

  // Check product description
  const body = product.body_html || '';
  if (!body || body.length < 100) {
    issues.push('❌ Product description too short or missing');
    score -= 15;
  }

  // Check images
  if (!product.images || product.images.length === 0) {
    issues.push('❌ No images found');
    score -= 20;
  } else {
    product.images.forEach((img, index) => {
      // Check alt text
      if (!img.alt || img.alt.trim() === '') {
        issues.push(`❌ Image ${index + 1} missing alt text`);
        score -= 10;
      }
      // Check filename
      const filename = img.src.split('/').pop().split('?')[0];
      if (/^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename)) {
        issues.push(`⚠️ Image ${index + 1} has unfriendly filename: ${filename}`);
        score -= 5;
      }
    });
  }

  // Check product handle (URL)
  if (product.handle && product.handle.length > 50) {
    issues.push(`⚠️ URL handle too long: ${product.handle}`);
    score -= 5;
  }

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    score: Math.max(0, score),
    issues
  };
}

// Get all products with pagination
async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle,body_html,images';

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

// Run the full audit
async function runAudit() {
  console.log('\n🔍 Starting SEO audit for your store...\n');

  try {
    const products = await getAllProducts();
    console.log(`Found ${products.length} products to audit\n`);
    console.log('='.repeat(50));

    const results = [];
    let totalScore = 0;

    for (const product of products) {
      const audit = await auditProduct(product);
      results.push(audit);
      totalScore += audit.score;

      // Show result for each product
      const emoji = audit.score >= 80 ? '🟢' : audit.score >= 50 ? '🟡' : '🔴';
      console.log(`\n${emoji} ${audit.title}`);
      console.log(`   Score: ${audit.score}/100`);
      if (audit.issues.length > 0) {
        audit.issues.forEach(issue => console.log(`   ${issue}`));
      } else {
        console.log('   ✅ No issues found');
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('\n📊 AUDIT SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total products audited: ${products.length}`);
    console.log(`Average SEO score: ${Math.round(totalScore / products.length)}/100`);
    console.log(`Products with score 80+: ${results.filter(r => r.score >= 80).length}`);
    console.log(`Products with score 50-79: ${results.filter(r => r.score >= 50 && r.score < 80).length}`);
    console.log(`Products needing urgent fix: ${results.filter(r => r.score < 50).length}`);

  } catch (error) {
    console.error('Audit failed:', error.response?.data || error.message);
  }
}

runAudit();