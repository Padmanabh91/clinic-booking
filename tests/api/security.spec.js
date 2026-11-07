const { test, expect } = require('../support/fixtures');

const EXPECTED_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

test.describe('Security headers', () => {
  test('API answers carry the security headers and are never cached', { tag: '@regression' }, async ({ patient }) => {
    const headers = (await patient.me()).headers();

    expect(headers).toMatchObject({ ...EXPECTED_HEADERS, 'cache-control': 'no-store' });
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('the web page carries the same headers', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const headers = (await client.request.get('/')).headers();

    expect(headers).toMatchObject(EXPECTED_HEADERS);
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('error answers carry them too', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const headers = (await client.request.get('/api/no-such-endpoint')).headers();

    expect(headers).toMatchObject({ ...EXPECTED_HEADERS, 'cache-control': 'no-store' });
  });
});

test.describe('Sign-in cookie', () => {
  test('cannot be read by page scripts or sent from other sites', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    const response = await client.login('patient@clinic.test', 'Patient@123');

    expect(response.headers()['set-cookie']).toMatch(/^sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  });
});

test.describe('Sign-in limit (the clock is fixed, so the 15 minutes never pass here)', () => {
  test('after 5 failures the right password is refused too', { tag: '@regression' }, async ({ newClient, patient }) => {
    const client = await newClient();
    for (let i = 0; i < 5; i += 1) {
      expect((await client.login(patient.user.email, 'wrong-password')).status()).toBe(401);
    }

    const response = await client.login(patient.user.email, patient.user.password);

    expect(response.status()).toBe(429);
    expect(response.headers()['retry-after']).toBe('900');
    expect((await response.json()).error).toEqual({
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many failed sign-in attempts. Try again in 15 minutes.',
    });
  });

  test("an unknown email is limited the same way, so the limit doesn't reveal accounts", { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();
    const email = `nobody-${Date.now()}@clinic.test`;
    for (let i = 0; i < 5; i += 1) {
      expect((await client.login(email, 'wrong-password')).status()).toBe(401);
    }

    expect((await client.login(email, 'wrong-password')).status()).toBe(429);
  });
});
