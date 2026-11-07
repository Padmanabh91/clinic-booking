const { test, expect, newPatientData } = require('../support/fixtures');
const { LoginPage, RegisterPage } = require('../pages/login-page');

test.describe('Signing in', () => {
  test('a patient signs in and reaches the booking page', { tag: '@smoke' }, async ({ page, patient }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.signIn(patient.user.email, patient.user.password);

    await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible();
    await expect(page.getByTestId('current-user')).toHaveText(patient.user.name);
  });

  test('a wrong password shows an error and stays on sign-in', { tag: '@regression' }, async ({ page, patient }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.signIn(patient.user.email, 'wrong-password');

    await expect(login.error).toHaveText('Email or password is incorrect.');
    await expect(login.heading).toBeVisible();
  });

  test('a signed-out visitor to My appointments sees sign-in', { tag: '@regression' }, async ({ page }) => {
    await page.goto('/#/appointments');

    await expect(new LoginPage(page).heading).toBeVisible();
  });

  test('logging out stays logged out after a reload', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.goto('/#/book');

    await patientPage.getByRole('button', { name: 'Log out' }).click();
    const login = new LoginPage(patientPage);
    await expect(login.heading).toBeVisible();

    await patientPage.reload();
    await expect(login.heading).toBeVisible();
  });
});

test.describe('Creating an account', () => {
  test('a new patient registers and is signed in', { tag: '@regression' }, async ({ page }) => {
    const register = new RegisterPage(page);
    const data = newPatientData();
    await register.goto();

    await register.createAccount(data);

    await expect(page.getByTestId('current-user')).toHaveText(data.name);
  });

  test('a short password shows the rule that was broken', { tag: '@regression' }, async ({ page }) => {
    const register = new RegisterPage(page);
    await register.goto();

    await register.createAccount({ ...newPatientData(), password: 'short' });

    await expect(register.error).toHaveText('Password must be at least 8 characters.');
  });
});
