const { test, expect } = require('../support/local-app');
const { DoctorsPage, ScheduleDatesPage } = require('../pages/admin-pages');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TOMORROW } = require('../support/clinic-time');
const { GENERAL_MEDICINE, DERMATOLOGY, PEDIATRICS, doctorLabel } = require('../support/doctors');

// These tests change things for every doctor or patient, so each runs on its own copy
// of the app instead of the shared test server.


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
    await booking.choose(GENERAL_MEDICINE, TOMORROW);
    await expect(booking.slots).toHaveText('The clinic is closed on this day for Founders Day.');

    await adminPage.getByRole('button', { name: 'Remove Founders Day on Tue, 8 Jan 2030' }).click();

    await expect(holidays.toast).toHaveText('Holiday removed.');
    await expect(adminPage.getByText('No holidays coming up.')).toBeVisible();
    await patientPage.reload();
    await expect(booking.heading).toBeVisible();
    await booking.choose(GENERAL_MEDICINE, TOMORROW);
    await expect(booking.slot('10:00')).toBeEnabled();
  });

  test('a holiday with bookings lists them, and patients see why theirs was cancelled', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    await patient.book(GENERAL_MEDICINE.id, { date: TOMORROW, time: '09:30' });
    const holidays = new ScheduleDatesPage(await localPageFor(admin));
    await holidays.gotoHolidays();

    await holidays.addDate(TOMORROW, 'Founders Day');
    await expect(holidays.affected.list).toHaveText(`Tue, 8 Jan 2030 at 09:30: ${patient.user.name} with ${doctorLabel(GENERAL_MEDICINE)}`);
    await holidays.affected.confirm.click();

    await expect(holidays.toast).toHaveText('Holiday added. 1 appointment cancelled.');
    const appointments = new AppointmentsPage(await localPageFor(patient));
    await appointments.goto();
    await expect(appointments.card(doctorLabel(GENERAL_MEDICINE)).getByTestId('cancel-reason'))
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

test.describe('Doctors who share a name', () => {
  const NEXT_WEDNESDAY = '2030-01-09';
  const LABELS = [DERMATOLOGY, GENERAL_MEDICINE, PEDIATRICS].map(doctorLabel); // sorted by specialty

  test('patients can tell them apart when booking and on their appointments', { tag: '@regression' }, async ({ patient, localPageFor }) => {
    await patient.book(PEDIATRICS.id, { date: TOMORROW, time: '10:00' });
    const moved = await (await patient.book(DERMATOLOGY.id, { date: NEXT_WEDNESDAY, time: '10:00' })).json();
    const page = await localPageFor(patient);
    const booking = new BookingPage(page);

    await booking.goto();
    await expect(booking.doctor.locator('option')).toHaveText(LABELS);

    const appointments = new AppointmentsPage(page);
    await appointments.goto();
    await expect(appointments.section('Upcoming').getByRole('heading', { level: 3 }))
      .toHaveText([doctorLabel(PEDIATRICS), doctorLabel(DERMATOLOGY)]);

    await page.goto(`/#/appointments/${moved.id}/reschedule`);
    await expect(page.getByTestId('current-appointment')).toContainText(`with ${doctorLabel(DERMATOLOGY)}.`);
  });

  test('admins can tell them apart in the doctors list and the filters', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    await patient.book(PEDIATRICS.id, { date: TOMORROW, time: '10:00', reason: 'For pediatrics' });
    await patient.book(GENERAL_MEDICINE.id, { date: TOMORROW, time: '11:00', reason: 'For general medicine' });
    const page = await localPageFor(admin);

    const doctors = new DoctorsPage(page);
    await doctors.goto();
    await expect(page.getByTestId('doctor-card').getByRole('heading', { level: 2 })).toHaveText(LABELS);
    for (const label of LABELS) {
      await expect(page.getByRole('link', { name: `Edit ${label}`, exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: `Leave days for ${label}`, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `Deactivate ${label}`, exact: true })).toBeVisible();
    }

    const appointments = new AppointmentsPage(page);
    await appointments.goto();
    await expect(appointments.filters.getByLabel('Doctor', { exact: true }).locator('option')).toHaveText(['All doctors', ...LABELS]);
    await appointments.filter({ doctor: String(PEDIATRICS.id) });
    await expect(page.getByTestId('appointment-list').locator('.reason')).toHaveText(['For pediatrics']);
  });

  test('deactivating one names its specialty and leaves the others active', { tag: '@regression' }, async ({ admin, localPageFor }) => {
    const page = await localPageFor(admin);
    const doctors = new DoctorsPage(page);
    await doctors.goto();

    await page.getByRole('button', { name: `Deactivate ${doctorLabel(DERMATOLOGY)}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: `Deactivate ${doctorLabel(DERMATOLOGY)}?`, exact: true })).toBeVisible();
    await doctors.dialog.getByRole('button', { name: 'Deactivate', exact: true }).click();

    await expect(doctors.toast).toHaveText(`${doctorLabel(DERMATOLOGY)} deactivated.`);
    await expect(doctors.status(DERMATOLOGY)).toHaveText('Inactive');
    await expect(doctors.status(GENERAL_MEDICINE)).toHaveText('Active');
    await expect(doctors.status(PEDIATRICS)).toHaveText('Active');
  });
});
