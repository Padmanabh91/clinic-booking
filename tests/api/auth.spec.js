const { test, expect, newPatientData } = require('../support/fixtures');
const { FIXED_NOW, TODAY } = require('../support/clinic-time');

test.describe('Registration', () => {
  test('creates a patient account and signs them in', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();
    const data = newPatientData();

    const response = await client.register(data);

    expect(response.status()).toBe(201);
    const user = await response.json();
    expect(user).toMatchObject({ name: data.name, email: data.email, role: 'patient' });
    expect(user).not.toHaveProperty('password_hash');
    expect((await client.me()).status()).toBe(200);
  });

  test('cannot register as an admin by sending a role', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.register({ ...newPatientData(), role: 'admin' });

    expect(response.status()).toBe(201);
    expect((await response.json()).role).toBe('patient');
  });

  test('rejects an email that is already registered, ignoring case', { tag: '@regression' }, async ({ newClient, patient }) => {
    const client = await newClient();

    const response = await client.register({ ...newPatientData(), email: patient.user.email.toUpperCase() });

    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('EMAIL_TAKEN');
  });

  const invalidInputs = [
    { title: 'a one-letter name', change: { name: 'A' } },
    { title: 'a blank name', change: { name: '   ' } },
    { title: 'a malformed email', change: { email: 'not-an-email' } },
    { title: 'a 7-character password', change: { password: '1234567' } },
    { title: 'a missing password', change: { password: undefined } },
    { title: 'a 129-character password', change: { password: 'x'.repeat(129) } },
  ];
  for (const { title, change } of invalidInputs) {
    test(`rejects ${title}`, { tag: '@regression' }, async ({ newClient }) => {
      const client = await newClient();

      const response = await client.register({ ...newPatientData(), ...change });

      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    });
  }

  test('accepts a password of exactly 8 characters', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.register({ ...newPatientData(), password: '12345678' });

    expect(response.status()).toBe(201);
  });

  test('accepts a password of exactly 128 characters', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.register({ ...newPatientData(), password: 'x'.repeat(128) });

    expect(response.status()).toBe(201);
  });
});

test.describe('Sign in and sign out', () => {
  test('signs in with the correct password', { tag: '@smoke' }, async ({ newClient, patient }) => {
    const client = await newClient();

    const response = await client.login(patient.user.email, patient.user.password);

    expect(response.status()).toBe(200);
    expect((await client.me()).status()).toBe(200);
  });

  test('gives the same error for a wrong password and an unknown email', { tag: '@regression' }, async ({ newClient, patient }) => {
    const client = await newClient();

    const wrongPassword = await client.login(patient.user.email, 'wrong-password');
    const unknownEmail = await client.login('nobody@clinic.test', 'wrong-password');

    expect(wrongPassword.status()).toBe(401);
    expect(unknownEmail.status()).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
  });

  test('requires sign-in for protected endpoints', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    expect((await client.me()).status()).toBe(401);
    expect((await client.appointments()).status()).toBe(401);
  });

  test('ends the session on sign-out', { tag: '@regression' }, async ({ patient }) => {
    expect((await patient.logout()).status()).toBe(204);

    expect((await patient.me()).status()).toBe(401);
  });
});

test.describe('Clinic details', () => {
  test('the health check reports the app and its database are up', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.health();

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  test('reports the clinic as being in Bangalore on IST', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const config = await (await client.config()).json();

    expect(config).toMatchObject({ city: 'Bangalore', timeZone: 'Asia/Kolkata', timeZoneLabel: 'IST' });
  });

  test('reports the current Bangalore date and time', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const config = await (await client.config()).json();

    expect(config).toMatchObject({ today: TODAY, now: FIXED_NOW });
  });
});
