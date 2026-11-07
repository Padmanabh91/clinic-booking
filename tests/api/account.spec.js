const { test, expect } = require('../support/fixtures');

const NEW_PASSWORD = 'Brand-new-pass-1';

async function expectError(response, status, code, message) {
  expect(response.status()).toBe(status);
  expect((await response.json()).error).toEqual({ code, message });
}

test.describe('Changing your password', () => {
  test('the new password works and the old one no longer does', { tag: '@regression' }, async ({ patient, newClient }) => {
    const response = await patient.changePassword(patient.user.password, NEW_PASSWORD);

    expect(response.status()).toBe(204);
    const other = await newClient();
    expect((await other.login(patient.user.email, patient.user.password)).status()).toBe(401);
    expect((await other.login(patient.user.email, NEW_PASSWORD)).status()).toBe(200);
  });

  test('signs out other sessions but keeps this one', { tag: '@regression' }, async ({ patient, newClient }) => {
    const otherDevice = await newClient();
    expect((await otherDevice.login(patient.user.email, patient.user.password)).status()).toBe(200);

    await patient.changePassword(patient.user.password, NEW_PASSWORD);

    expect((await otherDevice.me()).status()).toBe(401);
    expect((await patient.me()).status()).toBe(200);
  });

  test('a wrong current password changes nothing', { tag: '@regression' }, async ({ patient, newClient }) => {
    await expectError(await patient.changePassword('not-my-password', NEW_PASSWORD),
      400, 'WRONG_PASSWORD', 'Your current password is incorrect.');

    const other = await newClient();
    expect((await other.login(patient.user.email, patient.user.password)).status()).toBe(200);
  });

  const invalidPasswords = [
    ['7 characters', '1234567', 'Password must be at least 8 characters.'],
    ['129 characters', 'x'.repeat(129), 'Password must be at most 128 characters.'],
    ['the same as now', null, 'Choose a new password that is different from your current one.'],
  ];
  for (const [title, password, message] of invalidPasswords) {
    test(`refuses a new password of ${title}`, { tag: '@regression' }, async ({ patient }) => {
      const response = await patient.changePassword(patient.user.password, password ?? patient.user.password);

      await expectError(response, 400, 'INVALID_INPUT', message);
    });
  }

  test('accepts a new password of exactly 128 characters', { tag: '@regression' }, async ({ patient }) => {
    expect((await patient.changePassword(patient.user.password, 'x'.repeat(128))).status()).toBe(204);
  });

  test('requires sign-in', { tag: '@regression' }, async ({ newClient }) => {
    const client = await newClient();

    await expectError(await client.changePassword('anything', NEW_PASSWORD),
      401, 'UNAUTHENTICATED', 'Please sign in first.');
  });
});
