const { test, expect } = require('../support/fixtures');
const { ChangePasswordPage } = require('../pages/change-password-page');
const { LoginPage } = require('../pages/login-page');
const { BookingPage } = require('../pages/booking-page');
const { TOMORROW } = require('../support/clinic-time');

test.describe('Changing your password', () => {
  test('a patient changes their password and signs in with the new one', { tag: '@regression' }, async ({ patientPage, patient }) => {
    await new BookingPage(patientPage).goto();
    await patientPage.getByRole('link', { name: 'Change password' }).click();
    const changePassword = new ChangePasswordPage(patientPage);
    await expect(changePassword.heading).toBeFocused();
    await expect(patientPage).toHaveTitle('Change password | Clinic Booking, Bangalore');

    await changePassword.change(patient.user.password, 'Brand-new-pass-1');

    await expect(patientPage.getByRole('status')).toHaveText('Password changed. Any other devices have been signed out.');
    await expect(new BookingPage(patientPage).heading).toBeVisible();
    await patientPage.getByRole('button', { name: 'Log out' }).click();
    const login = new LoginPage(patientPage);
    await login.signIn(patient.user.email, 'Brand-new-pass-1');
    await expect(patientPage.getByTestId('current-user')).toHaveText(patient.user.name);
  });

  test('a wrong current password explains what went wrong', { tag: '@regression' }, async ({ patientPage }) => {
    const changePassword = new ChangePasswordPage(patientPage);
    await changePassword.goto();

    await changePassword.change('not-my-password', 'Brand-new-pass-1');

    await expect(changePassword.error).toHaveText('Your current password is incorrect.');
    await expect(changePassword.heading).toBeVisible();
  });

  test('an admin can change their password too', { tag: '@regression' }, async ({ adminPage }) => {
    await adminPage.goto('/#/appointments');

    await adminPage.getByRole('link', { name: 'Change password' }).click();

    await expect(new ChangePasswordPage(adminPage).heading).toBeVisible();
  });

  test('a signed-out visitor to the address sees sign-in', { tag: '@regression' }, async ({ page }) => {
    await page.goto('/#/password');

    await expect(new LoginPage(page).heading).toBeVisible();
  });
});

test.describe('Sign-in limit', () => {
  // The server is shared by every test, so the limit is shown by faking its answer
  // rather than by really failing five times from this address.
  test('the sign-in page shows how long to wait', { tag: '@regression' }, async ({ page }) => {
    await page.route('**/api/login', (route) => route.fulfill({
      status: 429,
      headers: { 'Retry-After': '900' },
      json: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed sign-in attempts. Try again in 15 minutes.' } },
    }));
    const login = new LoginPage(page);
    await login.goto();

    await login.signIn('patient@clinic.test', 'Patient@123');

    await expect(login.error).toHaveText('Too many failed sign-in attempts. Try again in 15 minutes.');
  });
});

test.describe('Content security policy', () => {
  test('the main journeys run without breaking the policy', { tag: '@regression' }, async ({ pageFor, patient, doctor }) => {
    const page = await pageFor(patient);
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });

    const booking = new BookingPage(page);
    await booking.goto();
    await booking.book(doctor, { date: TOMORROW, time: '10:00', reason: 'Check-up' });
    await expect(page.getByRole('heading', { level: 1, name: 'My appointments' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel appointment' }).click();
    await page.getByRole('button', { name: 'Keep appointment' }).click();
    await new ChangePasswordPage(page).goto();

    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  });
});
