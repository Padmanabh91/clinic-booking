const { once } = require('node:events');
const base = require('@playwright/test');
const { createDb } = require('../../src/db');
const { createApp } = require('../../src/app');
const { parseBugs } = require('../../src/bugs');
const { shiftTime } = require('../../src/rules');
const { ApiClient } = require('./api-client');
const { FIXED_NOW } = require('./clinic-time');
const { newPatientData } = require('./fixtures');

// Starts the real app on a free port with its own in-memory database. It reads BUGS the
// same way the test server does, so bug mode applies to these tests too.
async function startLocalApp(options = {}) {
  const bugs = parseBugs(process.env.BUGS);
  const db = createDb(':memory:', bugs);
  const server = createApp(db, bugs, options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    db,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      try { db.close(); } catch { /* a test may have closed it already */ }
    },
  };
}

// Tests here each run their own copy of the app, so they can move its clock without
// affecting other tests. The app reads the clock from FIXED_NOW, which is per worker process.
const test = base.test.extend({
  appOptions: [{}, { option: true }],

  clock: async ({}, use) => {
    process.env.FIXED_NOW = FIXED_NOW;
    await use({
      now: () => process.env.FIXED_NOW,
      advance(minutes) { process.env.FIXED_NOW = shiftTime(process.env.FIXED_NOW, minutes); },
    });
    process.env.FIXED_NOW = FIXED_NOW;
  },

  // Depends on clock so the clock is reset before the app starts.
  localApp: async ({ clock, appOptions }, use) => {
    const app = await startLocalApp(appOptions);
    await use(app);
    await app.close();
  },

  // newClient({ headers }) gives a client with its own cookies, for example to act as
  // another device or to send X-Forwarded-For.
  newClient: async ({ playwright, localApp }, use) => {
    const contexts = [];
    await use(async ({ headers } = {}) => {
      const context = await playwright.request.newContext({ baseURL: localApp.url, extraHTTPHeaders: headers });
      contexts.push(context);
      return new ApiClient(context);
    });
    await Promise.all(contexts.map((context) => context.dispose()));
  },

  patient: async ({ newClient }, use) => {
    const client = await newClient();
    const data = newPatientData();
    const response = await client.register(data);
    base.expect(response.status()).toBe(201);
    client.user = { ...data, ...(await response.json()) };
    await use(client);
  },

  admin: async ({ newClient }, use) => {
    const client = await newClient();
    base.expect((await client.login('admin@clinic.test', 'Admin@12345')).status()).toBe(200);
    await use(client);
  },

  newDoctor: async ({ admin }, use) => {
    let count = 0;
    await use(async (overrides = {}) => {
      count += 1;
      const response = await admin.createDoctor({ name: `Dr. Local ${count}`, specialty: 'General Medicine', ...overrides });
      base.expect(response.status()).toBe(201);
      return response.json();
    });
  },

  // Opens a browser page on this copy of the app, signed in as the given client.
  localPageFor: async ({ browser, localApp }, use) => {
    const contexts = [];
    await use(async (client) => {
      const storageState = await client.request.storageState();
      const context = await browser.newContext({ baseURL: localApp.url, storageState });
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});

module.exports = { test, expect: base.expect, startLocalApp };
