// @ts-check
const { execFileSync } = require('node:child_process');
const { defineConfig, devices } = require('@playwright/test');
const { FIXED_NOW } = require('./tests/support/clinic-time');

// The test server gets a free port chosen when the run starts, so two runs at once can't
// collide. This file is loaded again in every worker, so the port is kept in TEST_PORT,
// which the workers inherit, and only chosen once. Setting TEST_PORT yourself fixes it.
function freePort() {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
}
process.env.TEST_PORT ||= freePort();
const PORT = Number(process.env.TEST_PORT);
const baseURL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry in CI only, so a local failure is never hidden by a lucky second run.
  retries: process.env.CI ? 1 : 0,
  // The HTML report is always written to playwright-report/ and kept; CI uploads it.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    // A trace is recorded on the retry of a failed test, which in practice means in CI.
    // Locally, rerun a failure with --trace=on to get one.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'api', testDir: './tests/api' },
    { name: 'db', testDir: './tests/db' },
    { name: 'server', testDir: './tests/server' },
    { name: 'chromium', testDir: './tests/ui', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testDir: './tests/ui', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testDir: './tests/ui', use: { ...devices['Desktop Safari'] } },
  ],
  // Every run gets a fresh in-memory database and a clock fixed at a known moment.
  webServer: {
    command: 'node src/server.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DB_PATH: ':memory:',
      FIXED_NOW,
      BUGS: process.env.BUGS || '',
    },
  },
});
