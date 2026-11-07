const { test, expect } = require('../support/fixtures');
const { LoginPage } = require('../pages/login-page');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TOMORROW } = require('../support/clinic-time');

const SESSION_ENDED = 'Your session has ended. Please sign in again.';

test.describe('When the session ends', () => {
  // Signing out through the API ends the same session the browser is using.
  test('opening a page sends the patient to sign-in with an explanation', { tag: '@regression' }, async ({ patientPage, patient }) => {
    await new BookingPage(patientPage).goto();
    await patient.logout();

    await patientPage.getByRole('link', { name: 'My appointments' }).click();

    const login = new LoginPage(patientPage);
    await expect(login.heading).toBeVisible();
    await expect(login.error).toHaveText(SESSION_ENDED);
    await expect(patientPage.getByTestId('current-user')).toHaveCount(0);
  });

  test('confirming a cancellation closes the dialog and goes to sign-in', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    await appointments.openCancelDialog(appointments.card(doctor.name));
    await patient.logout();

    await appointments.confirmCancel.click();

    await expect(appointments.dialog).toBeHidden();
    await expect(new LoginPage(patientPage).error).toHaveText(SESSION_ENDED);
  });

  test('logging out still reaches sign-in', { tag: '@regression' }, async ({ patientPage, patient }) => {
    await new BookingPage(patientPage).goto();
    await patient.logout();

    await patientPage.getByRole('button', { name: 'Log out' }).click();

    await expect(new LoginPage(patientPage).heading).toBeVisible();
  });

  test('the explanation is shown only once', { tag: '@regression' }, async ({ patientPage, patient }) => {
    await new BookingPage(patientPage).goto();
    await patient.logout();
    await patientPage.getByRole('link', { name: 'My appointments' }).click();
    const login = new LoginPage(patientPage);
    await expect(login.error).toHaveText(SESSION_ENDED);

    await patientPage.getByRole('link', { name: 'Create an account' }).click();
    await patientPage.getByRole('link', { name: 'Sign in' }).click();

    await expect(login.heading).toBeVisible();
    await expect(login.error).toBeHidden();
  });
});

test.describe('When the server or network fails', () => {
  test('a response that is not JSON shows a friendly message', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.route('**/api/appointments', (route) => route.fulfill({
      status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>',
    }));

    await patientPage.goto('/#/appointments');

    await expect(patientPage.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible();
    await expect(patientPage.getByRole('alert')).toHaveText('Something went wrong on our side. Please try again.');
  });

  test('a lost connection says the clinic could not be reached', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.route('**/api/appointments', (route) => route.abort('internetdisconnected'));

    await patientPage.goto('/#/appointments');

    await expect(patientPage.getByRole('alert')).toHaveText("We couldn't reach the clinic. Check your connection and try again.");
  });

  test('slots that fail to load show an error and keep the booking form', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await patientPage.route(/\/api\/doctors\/\d+\/slots/, (route) => route.fulfill({
      status: 500, json: { error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } },
    }));

    await booking.choose(doctor, TOMORROW);

    await expect(booking.error).toHaveText('Something went wrong.');
    await expect(booking.confirm).toBeVisible();
  });
});
