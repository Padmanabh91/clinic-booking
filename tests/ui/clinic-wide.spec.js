const { test, expect } = require('../support/local-app');
const { ScheduleDatesPage } = require('../pages/admin-pages');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TOMORROW } = require('../support/clinic-time');

// These tests change things for every doctor or patient, so each runs on its own copy
// of the app instead of the shared test server.

const ASHA_RAO = { id: 1, name: 'Dr. Asha Rao' }; // a seeded doctor, Monday to Friday

test.describe('No doctors available', () => {
  test('when every doctor is deactivated, patients see a message instead of the form', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    for (const doctor of await (await admin.allDoctors()).json()) {
      expect((await admin.updateDoctor(doctor.id, { active: false })).status()).toBe(200);
    }
    const page = await localPageFor(patient);
    const booking = new BookingPage(page);

    await booking.goto();

    await expect(page.getByTestId('no-doctors'))
      .toHaveText('No doctors are available for booking right now. Please check back later.');
    await expect(booking.clinicNote).toBeVisible();
    await expect(booking.confirm).toHaveCount(0);
    await expect(booking.doctor).toHaveCount(0);
  });
});

test.describe('Clinic holidays', () => {
  test('an admin adds a holiday, patients see the clinic closed, and removing it reopens the day', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    const adminPage = await localPageFor(admin);
    const holidays = new ScheduleDatesPage(adminPage);
    await holidays.gotoHolidays();

    await holidays.addDate(TOMORROW, 'Founders Day');

    await expect(holidays.toast).toHaveText('Holiday added.');
    await expect(holidays.entries).toHaveText(['Tue, 8 Jan 2030: Founders Day']);
    const patientPage = await localPageFor(patient);
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(ASHA_RAO, TOMORROW);
    await expect(booking.slots).toHaveText('The clinic is closed on this day for Founders Day.');

    await adminPage.getByRole('button', { name: 'Remove Founders Day on Tue, 8 Jan 2030' }).click();

    await expect(holidays.toast).toHaveText('Holiday removed.');
    await expect(adminPage.getByText('No holidays coming up.')).toBeVisible();
    await patientPage.reload();
    await expect(booking.heading).toBeVisible();
    await booking.choose(ASHA_RAO, TOMORROW);
    await expect(booking.slot('10:00')).toBeEnabled();
  });

  test('a holiday with bookings lists them, and patients see why theirs was cancelled', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    await patient.book(ASHA_RAO.id, { date: TOMORROW, time: '09:30' });
    const holidays = new ScheduleDatesPage(await localPageFor(admin));
    await holidays.gotoHolidays();

    await holidays.addDate(TOMORROW, 'Founders Day');
    await expect(holidays.affected.list).toHaveText(`Tue, 8 Jan 2030 at 09:30: ${patient.user.name} with ${ASHA_RAO.name}`);
    await holidays.affected.confirm.click();

    await expect(holidays.toast).toHaveText('Holiday added. 1 appointment cancelled.');
    const appointments = new AppointmentsPage(await localPageFor(patient));
    await appointments.goto();
    await expect(appointments.card(ASHA_RAO.name).getByTestId('cancel-reason'))
      .toHaveText('Cancelled by the clinic: The clinic is closed on this day for Founders Day.');
  });

  test('a holiday name is required', { tag: '@regression' }, async ({ admin, localPageFor }) => {
    const page = await localPageFor(admin);
    const holidays = new ScheduleDatesPage(page);
    await holidays.gotoHolidays();

    await holidays.addDate(TOMORROW, '');

    // The browser's own required-field check stops the form, so nothing is added.
    expect(await holidays.note.evaluate((input) => input.validity.valueMissing)).toBe(true);
    await expect(holidays.entries).toHaveCount(0);
  });
});
