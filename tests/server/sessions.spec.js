const crypto = require('node:crypto');
const { test, expect } = require('../support/local-app');

const HOUR = 60;
const DAY = 24 * HOUR;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sessionCount = (db, userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;

test.describe('Sessions end after 8 hours without use (the clock moves in these tests)', () => {
  test('still signed in 7 hours 59 minutes after the last use', { tag: '@regression' }, async ({ patient, clock }) => {
    clock.advance(8 * HOUR - 1);

    expect((await patient.me()).status()).toBe(200);
  });

  test('signed out exactly 8 hours after the last use, and the session is deleted', { tag: '@regression' }, async ({ patient, clock, localApp }) => {
    clock.advance(8 * HOUR);

    const response = await patient.me();

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
    expect(sessionCount(localApp.db, patient.user.id)).toBe(0);
  });

  test('each use restarts the 8 hours', { tag: '@regression' }, async ({ patient, clock }) => {
    clock.advance(5 * HOUR);
    expect((await patient.me()).status()).toBe(200);

    clock.advance(5 * HOUR); // 10 hours after sign-in, 5 after the last use

    expect((await patient.me()).status()).toBe(200);
  });
});

test.describe('Sessions end 7 days after sign-in', () => {
  test('even when used every few hours', { tag: '@regression' }, async ({ patient, clock }) => {
    let elapsed = 0;
    while (elapsed + 7 * HOUR < 7 * DAY) {
      clock.advance(7 * HOUR);
      elapsed += 7 * HOUR;
      expect((await patient.me()).status(), `${elapsed / HOUR} hours after sign-in`).toBe(200);
    }

    clock.advance(7 * DAY - elapsed); // exactly 7 days after sign-in

    expect((await patient.me()).status()).toBe(401);
  });

  test('signing in again starts a new 7 days', { tag: '@regression' }, async ({ patient, clock }) => {
    clock.advance(7 * DAY);
    expect((await patient.me()).status()).toBe(401);

    expect((await patient.login(patient.user.email, patient.user.password)).status()).toBe(200);

    expect((await patient.me()).status()).toBe(200);
  });
});

test.describe('Stored sessions', () => {
  test('the database holds only a hash of the session token', { tag: '@regression' }, async ({ patient, localApp }) => {
    const { cookies } = await patient.request.storageState();
    const token = cookies.find((c) => c.name === 'sid').value;

    const rows = localApp.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(patient.user.id);

    expect(rows.map((r) => r.token_hash)).toEqual([sha256(token)]);
    expect(localApp.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token).n).toBe(0);
  });

  test('records when the session started and was last used', { tag: '@regression' }, async ({ patient, clock, localApp }) => {
    const started = clock.now();
    clock.advance(30);

    await patient.me();

    expect({ ...localApp.db.prepare('SELECT created_at, last_seen_at FROM sessions WHERE user_id = ?').get(patient.user.id) })
      .toEqual({ created_at: started, last_seen_at: clock.now() });
  });

  test('expired sessions are cleared out when anyone signs in', { tag: '@regression' }, async ({ patient, newClient, clock, localApp }) => {
    clock.advance(8 * HOUR);
    expect(sessionCount(localApp.db, patient.user.id)).toBe(1);

    const admin = await newClient();
    expect((await admin.login('admin@clinic.test', 'Admin@12345')).status()).toBe(200);

    expect(sessionCount(localApp.db, patient.user.id)).toBe(0);
  });
});

test.describe('Cookie settings', () => {
  test('by default the cookie is not limited to HTTPS and there is no HSTS', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.login('patient@clinic.test', 'Patient@123');

    expect(response.headers()['set-cookie']).not.toMatch(/;\s*Secure/i);
    expect(response.headers()['strict-transport-security']).toBeUndefined();
  });

  test.describe('with secure cookies on', () => {
    test.use({ appOptions: { secureCookies: true } });

    test('the cookie is HTTPS-only and HSTS is sent', { tag: '@regression' }, async ({ newClient }) => {
      const client = await newClient();

      const response = await client.login('patient@clinic.test', 'Patient@123');

      expect(response.headers()['set-cookie']).toMatch(/;\s*Secure/i);
      expect(response.headers()['strict-transport-security']).toBe('max-age=31536000');
    });
  });
});
