const crypto = require('node:crypto');
const base = require('@playwright/test');
const { ApiClient } = require('./api-client');

const ADMIN = { email: 'admin@clinic.test', password: 'Admin@12345' };
const uniqueId = () => crypto.randomUUID().slice(0, 8);

function newPatientData() {
  const id = uniqueId();
  return { name: `Patient ${id}`, email: `patient-${id}@clinic.test`, password: `Pass-${id}!` };
}

// Tests run in parallel without clashing because each one gets its own patient
// and its own doctor, created through the API rather than the slower UI.
const test = base.test.extend({
  newClient: async ({ playwright, baseURL }, use) => {
    const contexts = [];
    await use(async () => {
      const context = await playwright.request.newContext({ baseURL });
      contexts.push(context);
      return new ApiClient(context);
    });
    await Promise.all(contexts.map((context) => context.dispose()));
  },

  newPatient: async ({ newClient }, use) => {
    await use(async () => {
      const client = await newClient();
      const data = newPatientData();
      const response = await client.register(data);
      base.expect(response.status()).toBe(201);
      client.user = { ...data, ...(await response.json()) };
      return client;
    });
  },

  patient: async ({ newPatient }, use) => {
    await use(await newPatient());
  },

  admin: async ({ newClient }, use) => {
    const client = await newClient();
    const response = await client.login(ADMIN.email, ADMIN.password);
    base.expect(response.status()).toBe(200);
    client.user = { ...ADMIN, ...(await response.json()) };
    await use(client);
  },

  newDoctor: async ({ admin }, use) => {
    await use(async (overrides = {}) => {
      const response = await admin.createDoctor({
        name: `Dr. Test ${uniqueId()}`,
        specialty: 'General Medicine',
        ...overrides,
      });
      base.expect(response.status()).toBe(201);
      return response.json();
    });
  },

  doctor: async ({ newDoctor }, use) => {
    await use(await newDoctor());
  },

  // Opens a browser page that is already signed in as the given API client.
  pageFor: async ({ browser, baseURL }, use) => {
    const contexts = [];
    await use(async (client) => {
      const storageState = await client.request.storageState();
      const context = await browser.newContext({ baseURL, storageState });
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },

  patientPage: async ({ pageFor, patient }, use) => {
    await use(await pageFor(patient));
  },

  adminPage: async ({ pageFor, admin }, use) => {
    await use(await pageFor(admin));
  },
});

module.exports = { test, expect: base.expect, newPatientData };
