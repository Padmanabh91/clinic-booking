const { test, expect } = require('../support/fixtures');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TODAY, TOMORROW, LAST_BOOKABLE_DAY } = require('../support/clinic-time');

// The shared server holds every test's appointments, so each test filters by its own doctor.

async function bookThree({ patient, newPatient, doctor }) {
  const other = await newPatient();
  await patient.book(doctor.id, { date: TODAY, time: '15:00', reason: 'Today' });
  const b = await (await other.book(doctor.id, { date: TOMORROW, time: '10:00', reason: 'Tomorrow' })).json();
  await patient.book(doctor.id, { date: LAST_BOOKABLE_DAY, time: '10:00', reason: 'Next month' });
  await other.cancel(b.id);
}

const reasons = (appointments) => appointments.page.getByTestId('appointment-list').locator('.reason');

test.describe('Filtering all appointments', () => {
  test('by doctor shows only theirs, with a summary', { tag: '@regression' }, async ({ adminPage, patient, newPatient, doctor }) => {
    await bookThree({ patient, newPatient, doctor });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();

    await appointments.filter({ doctor: String(doctor.id) });

    await expect(reasons(appointments)).toHaveText(['Today', 'Next month', 'Tomorrow']); // upcoming, then history
    await expect(appointments.count('booked')).toHaveText('2');
    await expect(appointments.count('cancelled')).toHaveText('1');
    await expect(appointments.count('completed')).toHaveText('0');
    await expect(appointments.count('no-show')).toHaveText('0');
    await expect(appointments.count('total')).toHaveText('3');
  });

  test('by date range and status; the summary still compares every status', { tag: '@regression' }, async ({ adminPage, patient, newPatient, doctor }) => {
    await bookThree({ patient, newPatient, doctor });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();

    await appointments.filter({ doctor: String(doctor.id), from: TODAY, to: TOMORROW, status: 'booked' });

    await expect(reasons(appointments)).toHaveText(['Today']);
    await expect(appointments.count('booked')).toHaveText('1');
    await expect(appointments.count('cancelled')).toHaveText('1');
    await expect(appointments.count('total')).toHaveText('2');
  });

  test('a From date after the To date explains the problem and keeps the last results', { tag: '@regression' }, async ({ adminPage, patient, newPatient, doctor }) => {
    await bookThree({ patient, newPatient, doctor });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();
    await appointments.filter({ doctor: String(doctor.id) });

    await appointments.filter({ from: TOMORROW, to: TODAY });

    await expect(appointments.filterError).toHaveText('From must be on or before To.');
    await expect(appointments.count('total')).toHaveText('3');
  });

  test('filters stay while moving around, and Clear filters shows everything again', { tag: '@regression' }, async ({ adminPage, patient, newPatient, doctor }) => {
    await bookThree({ patient, newPatient, doctor });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();
    await appointments.filter({ doctor: String(doctor.id), status: 'cancelled' });

    await adminPage.getByRole('link', { name: 'Doctors' }).click();
    await adminPage.getByRole('link', { name: 'All appointments' }).click();

    await expect(appointments.filters.getByLabel('Status', { exact: true })).toHaveValue('cancelled');
    await expect(reasons(appointments)).toHaveText(['Tomorrow']);
    await appointments.filters.getByRole('button', { name: 'Clear filters' }).click();
    await expect(appointments.filters.getByLabel('Doctor', { exact: true })).toHaveValue('');
    await expect(appointments.card(doctor.name).filter({ hasText: 'Next month' })).toBeVisible();
  });

  test('patients have no filters or summary', { tag: '@regression' }, async ({ patientPage }) => {
    await new AppointmentsPage(patientPage).goto();

    await expect(patientPage.getByRole('form', { name: 'Filter appointments' })).toHaveCount(0);
    await expect(patientPage.getByTestId('count-total')).toHaveCount(0);
  });
});
