require('dotenv').config();
const { execSync } = require('child_process');

// Schedule configuration
const SCHEDULE = {
  // Run full SEO audit and fix every day at 2:00 AM
  dailyFix: {
    hour: 2,
    minute: 0,
    task: 'autoFix'
  },
  // Run broken link checker every Monday at 3:00 AM
  weeklyBrokenLinks: {
    dayOfWeek: 1, // Monday
    hour: 3,
    minute: 0,
    task: 'brokenLinks'
  },
  // Run redirect manager every day at 2:30 AM
  dailyRedirects: {
    hour: 2,
    minute: 30,
    task: 'redirectManager'
  },
  // Run technical SEO (images) every Sunday at 4:00 AM
  weeklyTechnicalSEO: {
    dayOfWeek: 0, // Sunday
    hour: 4,
    minute: 0,
    task: 'technicalSEO'
  }
};

// Run a task
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

// Check if a daily task should run
function shouldRunDaily(schedule) {
  const now = new Date();
  return now.getHours() === schedule.hour &&
    now.getMinutes() === schedule.minute;
}

// Check if a weekly task should run
function shouldRunWeekly(schedule) {
  const now = new Date();
  return now.getDay() === schedule.dayOfWeek &&
    now.getHours() === schedule.hour &&
    now.getMinutes() === schedule.minute;
}

// Main scheduler loop
function startScheduler() {
  console.log('\n🕐 SEO King Scheduler Started');
  console.log('================================');
  console.log('Schedule:');
  console.log('  📅 Daily SEO fix — every day at 2:00 AM');
  console.log('  📅 Redirect check — every day at 2:30 AM');
  console.log('  📅 Broken links — every Monday at 3:00 AM');
  console.log('  📅 Image optimization — every Sunday at 4:00 AM');
  console.log('================================\n');

  // Check every minute
  setInterval(() => {
    const now = new Date();
    console.log(`⏰ ${now.toLocaleTimeString()} — Scheduler running...`);

    // Daily fix
    if (shouldRunDaily(SCHEDULE.dailyFix)) {
      runTask('autoFix');
    }

    // Daily redirect check
    if (shouldRunDaily(SCHEDULE.dailyRedirects)) {
      runTask('redirectManager');
    }

    // Weekly broken links
    if (shouldRunWeekly(SCHEDULE.weeklyBrokenLinks)) {
      runTask('brokenLinks');
    }

    // Weekly technical SEO
    if (shouldRunWeekly(SCHEDULE.weeklyTechnicalSEO)) {
      runTask('technicalSEO');
    }

  }, 60000); // Check every 60 seconds
}

startScheduler();