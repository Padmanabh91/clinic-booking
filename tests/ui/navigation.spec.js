const { test, expect } = require('../support/fixtures');
const { LoginPage, RegisterPage } = require('../pages/login-page');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');

const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true });

test.describe('Where each address leads', () => {
  test('an admin who opens the booking address lands on All appointments', { tag: '@regression' }, async ({ adminPage }) => {
    await adminPage.goto('/#/book');

    await expect(heading(adminPage, 'All appointments')).toBeVisible();
    await expect(adminPage).toHaveURL(/#\/appointments$/);
  });

  test("an admin's home address is All appointments", { tag: '@regression' }, async ({ adminPage }) => {
    await adminPage.goto('/');

    await expect(heading(adminPage, 'All appointments')).toBeVisible();
    await expect(adminPage).toHaveURL(/#\/appointments$/);
  });

  test("a patient's home address is the booking page", { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.goto('/');

    await expect(heading(patientPage, 'Book an appointment')).toBeVisible();
    await expect(patientPage).toHaveURL(/#\/book$/);
  });

  test('an unknown address takes a patient to the booking page', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.goto('/#/no-such-page');

    await expect(heading(patientPage, 'Book an appointment')).toBeVisible();
    await expect(patientPage).toHaveURL(/#\/book$/);
  });

  test('a signed-in patient who opens sign-in goes to the booking page', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.goto('/#/login');

    await expect(heading(patientPage, 'Book an appointment')).toBeVisible();
    await expect(patientPage).toHaveURL(/#\/book$/);
  });

  test('an admin who signs in lands on All appointments', { tag: '@regression' }, async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.signIn('admin@clinic.test', 'Admin@12345');

    await expect(heading(page, 'All appointments')).toBeVisible();
    await expect(page).toHaveURL(/#\/appointments$/);
  });
});

test.describe('Page titles', () => {
  test('sign-in and registration pages', { tag: '@regression' }, async ({ page }) => {
    await new LoginPage(page).goto();
    await expect(page).toHaveTitle('Sign in | Clinic Booking, Bangalore');

    await new RegisterPage(page).goto();
    await expect(page).toHaveTitle('Create an account | Clinic Booking, Bangalore');
  });

  test("a patient's pages", { tag: '@regression' }, async ({ patientPage }) => {
    await new BookingPage(patientPage).goto();
    await expect(patientPage).toHaveTitle('Book an appointment | Clinic Booking, Bangalore');

    await new AppointmentsPage(patientPage).goto();
    await expect(patientPage).toHaveTitle('My appointments | Clinic Booking, Bangalore');
  });

  test("an admin's page", { tag: '@regression' }, async ({ adminPage }) => {
    await new AppointmentsPage(adminPage).goto();
    await expect(adminPage).toHaveTitle('All appointments | Clinic Booking, Bangalore');
  });
});

test.describe('Focus after moving between pages', () => {
  test('following a menu link moves focus to the new heading', { tag: '@regression' }, async ({ patientPage }) => {
    await new BookingPage(patientPage).goto();

    await patientPage.getByRole('link', { name: 'My appointments' }).click();

    await expect(heading(patientPage, 'My appointments')).toBeFocused();
  });

  test('signing in moves focus to the booking heading', { tag: '@regression' }, async ({ page, patient }) => {
    const login = new LoginPage(page);
    await login.goto();

    await login.signIn(patient.user.email, patient.user.password);

    await expect(heading(page, 'Book an appointment')).toBeFocused();
  });

  test('opening the app does not move focus away from the page start', { tag: '@regression' }, async ({ patientPage }) => {
    await new BookingPage(patientPage).goto();

    await expect(heading(patientPage, 'Book an appointment')).not.toBeFocused();
  });
});
