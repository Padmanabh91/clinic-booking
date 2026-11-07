const { performance } = require('node:perf_hooks');
const { test, expect } = require('../support/local-app');

const WRONG = 'wrong-password';

async function failTimes(client, email, times) {
  for (let i = 0; i < times; i += 1) {
    expect((await client.login(email, WRONG)).status()).toBe(401);
  }
}

async function expectLimited(response, minutes) {
  expect(response.status()).toBe(429);
  expect(response.headers()['retry-after']).toBe(String(minutes * 60));
  const unit = minutes === 1 ? 'minute' : 'minutes';
  expect((await response.json()).error).toEqual({
    code: 'TOO_MANY_ATTEMPTS',
    message: `Too many failed sign-in attempts. Try again in ${minutes} ${unit}.`,
  });
}

test.describe('Failed sign-ins per email (the clock moves in these tests)', () => {
  test('after 5 failures even the right password waits 15 minutes', { tag: '@regression' }, async ({ patient, clock }) => {
    const { email, password } = patient.user;
    await failTimes(patient, email, 5);

    await expectLimited(await patient.login(email, password), 15);

    clock.advance(14);
    await expectLimited(await patient.login(email, password), 1);

    clock.advance(1);
    expect((await patient.login(email, password)).status()).toBe(200);
  });

  test('the wait counts from the oldest failure still in the window', { tag: '@regression' }, async ({ patient, clock }) => {
    const { email, password } = patient.user;
    await failTimes(patient, email, 1);
    clock.advance(10);
    await failTimes(patient, email, 4);

    await expectLimited(await patient.login(email, password), 5);
  });

  test('a successful sign-in clears earlier failures', { tag: '@regression' }, async ({ patient }) => {
    const { email, password } = patient.user;
    await failTimes(patient, email, 4);
    expect((await patient.login(email, password)).status()).toBe(200);

    await failTimes(patient, email, 4);

    expect((await patient.login(email, password)).status()).toBe(200);
  });

  test('email case does not give extra attempts', { tag: '@regression' }, async ({ patient }) => {
    const { email, password } = patient.user;
    await failTimes(patient, email.toUpperCase(), 5);

    await expectLimited(await patient.login(email, password), 15);
  });
});

test.describe('Failed sign-ins per address', () => {
  const failFromAddress = async (newClient, count, forwardedFor) => {
    for (let i = 0; i < count; i += 1) {
      const headers = forwardedFor ? { 'X-Forwarded-For': forwardedFor(i) } : undefined;
      const client = await newClient({ headers });
      expect((await client.login(`nobody-${i}@clinic.test`, WRONG)).status()).toBe(401);
    }
  };

  test('one address gets 50 failures across all accounts', { tag: '@regression' }, async ({ patient, newClient }) => {
    await failFromAddress(newClient, 50);

    await expectLimited(await patient.login(patient.user.email, patient.user.password), 15);
  });

  test("a made-up forwarded address can't get round the limit", { tag: '@regression' }, async ({ patient, newClient }) => {
    await failFromAddress(newClient, 50, (i) => `203.0.113.${i}`);

    const spoofing = await newClient({ headers: { 'X-Forwarded-For': '198.51.100.7' } });
    await expectLimited(await spoofing.login(patient.user.email, patient.user.password), 15);
  });

  test.describe('behind a trusted proxy', () => {
    test.use({ appOptions: { trustProxy: true } });

    test('each visitor address has its own limit', { tag: '@regression' }, async ({ patient, newClient }) => {
      await failFromAddress(newClient, 50, () => '203.0.113.1');

      const sameVisitor = await newClient({ headers: { 'X-Forwarded-For': '203.0.113.1' } });
      const otherVisitor = await newClient({ headers: { 'X-Forwarded-For': '203.0.113.2' } });
      await expectLimited(await sameVisitor.login(patient.user.email, patient.user.password), 15);
      expect((await otherVisitor.login(patient.user.email, patient.user.password)).status()).toBe(200);
    });
  });
});

test.describe('Sign-in timing', () => {
  test("an unknown email takes about as long as a wrong password, so it can't reveal accounts", { tag: '@regression' }, async ({ patient, newClient }) => {
    const client = await newClient();
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const timeLogin = async (email) => {
      const start = performance.now();
      expect((await client.login(email, WRONG)).status()).toBe(401);
      return performance.now() - start;
    };
    await timeLogin('warm-up@clinic.test');

    const known = [];
    const unknown = [];
    for (let i = 0; i < 4; i += 1) { // stays under the 5-failure limit for the real email
      known.push(await timeLogin(patient.user.email));
      unknown.push(await timeLogin(`nobody-${i}@clinic.test`));
    }

    // Without the fix an unknown email skips password hashing and is about 20x faster.
    // The margin is wide so a busy machine doesn't cause false failures.
    expect(median(unknown)).toBeGreaterThan(median(known) * 0.4);
  });
});
