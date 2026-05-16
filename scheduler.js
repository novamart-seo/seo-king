require('dotenv').config();
const { execSync } = require('child_process');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Keep alive endpoint
app.get('/', (req, res) => {
  res.json({
    status: '✅ SEO King is running',
    timestamp: new Date().toISOString(),
    schedule: {
      dailyFix: 'Every day at 2:00 AM',
      redirectCheck: 'Every day at 2:30 AM',
      brokenLinks: 'Every Monday at 3:00 AM',
      imageOptimization: 'Every Sunday at 4:00 AM'
    }
  });
});

// Webhook endpoint for new products
app.post('/webhook/product-created', async (req, res) => {
  console.log('\n🔔 New product webhook received!');
  const product = req.body;
  console.log(`Product: ${product.title}`);
  res.json({ received: true });

  // Run auto fix for new product
  try {
    console.log('Running SEO fix for new product...');
    execSync('node autoFix.js', { stdio: 'inherit' });
    console.log('✅ SEO fix complete for new product');
  } catch (error) {
    console.error('❌ SEO fix failed:', error.message);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🌐 SEO King Web Server running on port ${PORT}`);
  startScheduler();
});

// Schedule configuration
const SCHEDULE = {
  dailyFix: { hour: 2, minute: 0 },
  dailyRedirects: { hour: 2, minute: 30 },
  weeklyBrokenLinks: { dayOfWeek: 1, hour: 3, minute: 0 },
  weeklyTechnicalSEO: { dayOfWeek: 0, hour: 4, minute: 0 }
};

function runTask(taskName) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🚀 Running task: ${taskName}`);
  try {
    execSync(`node ${taskName}.js`, { stdio: 'inherit' });
    console.log(`[${timestamp}] ✅ Task completed: ${taskName}`);
  } catch (error) {
    console.error(`[${timestamp}] ❌ Task failed: ${taskName}`, error.message);
  }
}

function shouldRunDaily(schedule) {
  const now = new Date();
  return now.getHours() === schedule.hour && now.getMinutes() === schedule.minute;
}

function shouldRunWeekly(schedule) {
  const now = new Date();
  return now.getDay() === schedule.dayOfWeek &&
    now.getHours() === schedule.hour &&
    now.getMinutes() === schedule.minute;
}

function startScheduler() {
  console.log('\n🕐 SEO King Scheduler Started');
  console.log('================================');
  console.log('Schedule:');
  console.log('  📅 Daily SEO fix — every day at 2:00 AM');
  console.log('  📅 Redirect check — every day at 2:30 AM');
  console.log('  📅 Broken links — every Monday at 3:00 AM');
  console.log('  📅 Image optimization — every Sunday at 4:00 AM');
  console.log('================================\n');

  setInterval(() => {
    const now = new Date();
    console.log(`⏰ ${now.toLocaleTimeString()} — Scheduler running...`);

    if (shouldRunDaily(SCHEDULE.dailyFix)) runTask('autoFix');
    if (shouldRunDaily(SCHEDULE.dailyRedirects)) runTask('redirectManager');
    if (shouldRunWeekly(SCHEDULE.weeklyBrokenLinks)) runTask('brokenLinks');
    if (shouldRunWeekly(SCHEDULE.weeklyTechnicalSEO)) runTask('technicalSEO');

  }, 60000);
}