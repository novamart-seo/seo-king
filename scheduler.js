require('dotenv').config();
const { exec } = require('child_process');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Run task without blocking server ─────────────────────────────────────
function runTask(taskName) {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🚀 Running: ${taskName}`);

  exec(`node ${taskName}.js`, (error, stdout, stderr) => {
    if (error) {
      console.error(`[${timestamp}] ❌ Failed: ${taskName} — ${error.message}`);
    } else {
      console.log(`[${timestamp}] ✅ Done: ${taskName}`);
    }
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
}
// ──────────────────────────────────────────────────────────────────────────

// ─── Schedule ──────────────────────────────────────────────────────────────
const SCHEDULE = {
  dailyFix:          { hour: 21, minute: 0 },  // 9PM UTC = 2AM Pakistan
  dailyRedirects:    { hour: 21, minute: 30 }, // 9:30PM UTC = 2:30AM Pakistan
  dailySEOPatterns:  { hour: 22, minute: 0 },  // 10PM UTC = 3AM Pakistan
  weeklyBrokenLinks: { dayOfWeek: 1, hour: 22, minute: 30 },
  weeklyTechnicalSEO:{ dayOfWeek: 0, hour: 23, minute: 0 }
};

function shouldRunDaily(schedule) {
  const now = new Date();
  return now.getUTCHours() === schedule.hour &&
         now.getUTCMinutes() === schedule.minute;
}

function shouldRunWeekly(schedule) {
  const now = new Date();
  return now.getUTCDay() === schedule.dayOfWeek &&
         now.getUTCHours() === schedule.hour &&
         now.getUTCMinutes() === schedule.minute;
}
// ──────────────────────────────────────────────────────────────────────────

function startScheduler() {
  console.log('\n🕐 SEO King Scheduler Started');
  console.log('================================');
  console.log('  📅 Daily SEO fix       — 2:00 AM Pakistan');
  console.log('  📅 Redirect check      — 2:30 AM Pakistan');
  console.log('  📅 SEO Patterns        — 3:00 AM Pakistan');
  console.log('  📅 Broken links        — Monday 3:30 AM Pakistan');
  console.log('  📅 Technical SEO       — Sunday 4:00 AM Pakistan');
  console.log('================================\n');

  setInterval(() => {
    if (shouldRunDaily(SCHEDULE.dailyFix))          runTask('autoFix');
    if (shouldRunDaily(SCHEDULE.dailyRedirects))     runTask('redirectManager');
    if (shouldRunDaily(SCHEDULE.dailySEOPatterns))   runTask('seoPatterns');
    if (shouldRunWeekly(SCHEDULE.weeklyBrokenLinks)) runTask('brokenLinks');
    if (shouldRunWeekly(SCHEDULE.weeklyTechnicalSEO))runTask('technicalSEO');
  }, 60000);
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ SEO King is running',
    timestamp: new Date().toISOString(),
    schedule: {
      dailyFix:       'Every day at 2:00 AM Pakistan',
      redirectCheck:  'Every day at 2:30 AM Pakistan',
      seoPatterns:    'Every day at 3:00 AM Pakistan',
      brokenLinks:    'Every Monday at 3:30 AM Pakistan',
      technicalSEO:   'Every Sunday at 4:00 AM Pakistan'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

app.post('/webhook/product-created', async (req, res) => {
  try {
    console.log('\n🔔 New product webhook received!');
    const product = req.body;
    console.log(`Product: ${product.title || 'Unknown'}`);
    res.status(200).json({ received: true });
    setTimeout(() => runTask('autoFix'), 1000);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).json({ received: true });
  }
});
// ──────────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 SEO King running on port ${PORT}`);
  startScheduler();
});

server.on('error', (err) => console.error('Server error:', err));