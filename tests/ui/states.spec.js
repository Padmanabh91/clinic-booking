const { test, expect } = require('../support/fixtures');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { DoctorsPage } = require('../pages/admin-pages');
const { TOMORROW } = require('../support/clinic-time');

// Holds matching requests until release() is called, so a loading state can be seen
// for as long as the test needs instead of depending on timing.
async function holdRequests(page, url, method = null) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const held = [];
  await page.route(url, async (route) => {
    if (method && route.request().method() !== method) return route.continue();
    held.push(route.request());
    await released;
    return route.continue();
  });
  return { release, held };
}

test.describe('Loading states', () => {
  test('a slow page says it is loading, then shows the screen', { tag: '@regression' }, async ({ patientPage }) => {
    const { release } = await holdRequests(patientPage, '**/api/doctors');

    await patientPage.goto('/#/book');

    await expect(patientPage.getByTestId('loading')).toHaveText('Loading…');
    await expect(patientPage.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(new BookingPage(patientPage).heading).toBeVisible();
    await expect(patientPage.getByRole('main')).not.toHaveAttribute('aria-busy');
    await expect(patientPage.getByTestId('loading')).toHaveCount(0);
  });

  test('a slow appointments list says it is loading under the heading', { tag: '@regression' }, async ({ patientPage }) => {
    const { release } = await holdRequests(patientPage, '**/api/appointments');

    await patientPage.goto('/#/appointments');

    await expect(patientPage.getByRole('heading', { level: 1, name: 'My appointments' })).toBeVisible();
    await expect(patientPage.getByTestId('list-loading')).toHaveText('Loading appointments…');
    await expect(patientPage.getByTestId('appointment-list')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(patientPage.getByText('No upcoming appointments.')).toBeVisible();
    await expect(patientPage.getByTestId('appointment-list')).not.toHaveAttribute('aria-busy');
  });

  test('times say they are loading', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    const { release } = await holdRequests(patientPage, /\/api\/doctors\/\d+\/slots/);

    await booking.choose(doctor, TOMORROW);

    await expect(patientPage.getByTestId('slots-loading')).toHaveText('Loading times…');
    await expect(booking.slots).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(booking.slot('10:00')).toBeEnabled();
    await expect(booking.slots).not.toHaveAttribute('aria-busy');
  });

  test("a slow booking can't be sent twice", { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await booking.slot('10:00').click();
    await booking.reason.fill('Check-up');
    const { release, held } = await holdRequests(patientPage, '**/api/appointments', 'POST');

    await booking.confirm.click();
    await expect(booking.confirm).toHaveAttribute('aria-disabled', 'true');
    await booking.confirm.click({ force: true }); // an impatient second click
    await booking.reason.press('Control+Enter'); // and a keyboard submit attempt
    release();

    await expect(new AppointmentsPage(patientPage).toast).toHaveText('Appointment booked successfully');
    expect(held).toHaveLength(1);
    expect((await (await patient.appointments()).json())).toHaveLength(1);
  });

  test('a slow cancellation keeps the dialog busy until it finishes', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    await appointments.openCancelDialog(appointments.card(doctor.name));
    const { release, held } = await holdRequests(patientPage, /\/api\/appointments\/\d+\/cancel/);

    await appointments.confirmCancel.click();
    await expect(appointments.confirmCancel).toHaveAttribute('aria-disabled', 'true');
    await appointments.confirmCancel.click({ force: true });
    release();

    await expect(appointments.toast).toHaveText('Appointment cancelled successfully');
    expect(held).toHaveLength(1);
  });
});

test.describe('Error states', () => {
  test('a page that failed to load offers Try again', { tag: '@regression' }, async ({ patientPage }) => {
    let failures = 1;
    await patientPage.route('**/api/appointments', (route) => (failures-- > 0 ? route.abort('internetdisconnected') : route.continue()));
    await patientPage.goto('/#/appointments');
    await expect(patientPage.getByRole('alert')).toHaveText("We couldn't reach the clinic. Check your connection and try again.");

    await patientPage.getByRole('button', { name: 'Try again' }).click();

    await expect(patientPage.getByRole('heading', { level: 1, name: 'My appointments' })).toBeVisible();
  });

  test('a failed action shows its message styled as an error, not a success', { tag: '@regression' }, async ({ adminPage, admin, doctor }) => {
    await admin.updateDoctor(doctor.id, { active: false });
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await adminPage.route(`**/api/doctors/${doctor.id}`, (route) => route.fulfill({
      status: 500, json: { error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } },
    }));

    await adminPage.getByRole('button', { name: `Reactivate ${doctor.name}` }).click();

    await expect(doctors.toast).toHaveText('Something went wrong.');
    await expect(doctors.toast).toHaveClass(/error/);
    await expect(doctors.status(doctor.name)).toHaveText('Inactive');
  });

  test('a success after an error is styled as a success again', { tag: '@regression' }, async ({ adminPage, admin, doctor }) => {
    await admin.updateDoctor(doctor.id, { active: false });
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    let failures = 1;
    await adminPage.route(`**/api/doctors/${doctor.id}`, (route) => (failures-- > 0
      ? route.fulfill({ status: 500, json: { error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } } })
      : route.continue()));
    await adminPage.getByRole('button', { name: `Reactivate ${doctor.name}` }).click();
    await expect(doctors.toast).toHaveClass(/error/);

    await adminPage.getByRole('button', { name: `Reactivate ${doctor.name}` }).click();

    await expect(doctors.toast).toHaveText(`${doctor.name} reactivated.`);
    await expect(doctors.toast).not.toHaveClass(/error/);
  });
});

test.describe('Empty states', () => {
  test('filters that match nothing say so', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();

    await appointments.filter({ doctor: String(doctor.id) });

    await expect(adminPage.getByTestId('no-matches'))
      .toHaveText('No appointments match these filters. Try a wider date range, or clear the filters.');
    await expect(appointments.count('total')).toHaveText('0');
  });
});
