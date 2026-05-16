require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SITE_URL = 'https://mynovamart.store';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Check store is online
async function checkStoreOnline() {
  try {
    const response = await axios.get(SITE_URL, { timeout: 10000 });
    return response.status === 200;
  } catch {
    return false;
  }
}

// Get product stats
async function getProductStats() {
  try {
    let products = [];
    let url = '/products.json?limit=250&fields=id,title,images,metafields_global_description_tag';

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

    const missingAlt = [];
    let totalImages = 0;
    let imagesWithAlt = 0;

    products.forEach(p => {
      if (p.images) {
        p.images.forEach(img => {
          totalImages++;
          if (img.alt && img.alt.trim() !== '') {
            imagesWithAlt++;
          } else {
            missingAlt.push(p.title);
          }
        });
      }
    });

    return {
      totalProducts: products.length,
      totalImages,
      imagesWithAlt,
      missingAltCount: missingAlt.length,
      missingAltProducts: [...new Set(missingAlt)].slice(0, 5)
    };
  } catch (error) {
    return null;
  }
}

// Get SEO score summary
async function getSEOSummary() {
  try {
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

    let totalScore = 0;
    let above80 = 0;
    let below50 = 0;

    for (const product of products.slice(0, 50)) {
      let score = 100;
      const metafields = await shopify.get(`/products/${product.id}/metafields.json`);
      const seo = {};
      metafields.data.metafields.forEach(m => {
        if (m.namespace === 'global' && m.key === 'description_tag') seo.description = m.value;
      });

      if (!seo.description || seo.description.length < 100) score -= 20;
      if (!product.body_html || product.body_html.length < 100) score -= 15;
      if (product.handle && product.handle.length > 50) score -= 5;

      totalScore += score;
      if (score >= 80) above80++;
      if (score < 50) below50++;
    }

    return {
      averageScore: Math.round(totalScore / 50),
      above80,
      below50,
      sampledProducts: 50
    };
  } catch (error) {
    return null;
  }
}

// Check redirects
async function getRedirectCount() {
  try {
    const response = await shopify.get('/redirects.json?limit=250');
    return response.data.redirects.length;
  } catch {
    return 0;
  }
}

// Send email report
async function sendReport(data) {
  const now = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const storeStatus = data.storeOnline ? '✅ Online' : '❌ Offline';
  const altCoverage = Math.round((data.productStats.imagesWithAlt / data.productStats.totalImages) * 100);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px;">
        📊 SEO King Daily Report
      </h1>
      <p style="color: #7f8c8d;">Nova Mart — ${now}</p>

      <h2 style="color: #2c3e50;">🏪 Store Status</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="background: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6;">Store Online</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${storeStatus}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6;">Total Products</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${data.productStats.totalProducts}</td>
        </tr>
        <tr style="background: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6;">Total Images</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${data.productStats.totalImages}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6;">Alt Text Coverage</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${altCoverage}% (${data.productStats.imagesWithAlt}/${data.productStats.totalImages})</td>
        </tr>
        <tr style="background: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6;">Active Redirects</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${data.redirectCount}</td>
        </tr>
      </table>

      <h2 style="color: #2c3e50; margin-top: 20px;">🎯 SEO Score (Sample of 50 products)</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr style="background: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6;">Average Score</td>
          <td style="padding: 10px; border: 1px solid #dee2e6; font-size: 20px; font-weight: bold; color: #27ae60;">${data.seoSummary.averageScore}/100</td>
        </tr>
        <tr>
          <td style="padding: 10px; border: 1px solid #dee2e6;">Products scoring 80+</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">✅ ${data.seoSummary.above80}</td>
        </tr>
        <tr style="background: #f8f9fa;">
          <td style="padding: 10px; border: 1px solid #dee2e6;">Products needing urgent fix</td>
          <td style="padding: 10px; border: 1px solid #dee2e6;">${data.seoSummary.below50 === 0 ? '✅ 0' : '❌ ' + data.seoSummary.below50}</td>
        </tr>
      </table>

      ${data.productStats.missingAltCount > 0 ? `
      <h2 style="color: #e74c3c; margin-top: 20px;">⚠️ Images Missing Alt Text</h2>
      <p>${data.productStats.missingAltCount} images need alt text. Top products:</p>
      <ul>
        ${data.productStats.missingAltProducts.map(p => `<li>${p}</li>`).join('')}
      </ul>
      ` : '<h2 style="color: #27ae60; margin-top: 20px;">✅ All images have alt text!</h2>'}

      <div style="margin-top: 30px; padding: 15px; background: #f8f9fa; border-radius: 5px;">
        <p style="margin: 0; color: #7f8c8d; font-size: 12px;">
          This report was automatically generated by SEO King — your 24/7 Shopify SEO automation tool.
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"SEO King" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO,
    subject: `📊 SEO King Daily Report — Nova Mart — ${now}`,
    html
  });

  console.log('✅ Report sent to:', process.env.EMAIL_TO);
}

// Run monitor
async function runMonitor() {
  console.log('\n🔍 Running SEO King Monitor...\n');

  try {
    console.log('Checking store status...');
    const storeOnline = await checkStoreOnline();
    console.log(`Store: ${storeOnline ? '✅ Online' : '❌ Offline'}`);

    console.log('Getting product stats...');
    const productStats = await getProductStats();

    console.log('Getting SEO summary...');
    const seoSummary = await getSEOSummary();

    console.log('Getting redirect count...');
    const redirectCount = await getRedirectCount();

    console.log('Sending email report...');
    await sendReport({
      storeOnline,
      productStats,
      seoSummary,
      redirectCount
    });

    console.log('\n✅ Monitor complete — report sent!');

  } catch (error) {
    console.error('Monitor failed:', error.message);
  }
}

runMonitor();