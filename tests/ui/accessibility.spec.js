const { AxeBuilder } = require('@axe-core/playwright');
const { test, expect } = require('../support/fixtures');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage, ReschedulePage } = require('../pages/appointments-page');
const { LoginPage, RegisterPage } = require('../pages/login-page');
const { ChangePasswordPage } = require('../pages/change-password-page');
const { DoctorsPage, DoctorFormPage, ScheduleDatesPage } = require('../pages/admin-pages');
const { TOMORROW } = require('../support/clinic-time');

async function expectNoViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe('Accessibility (WCAG 2.1 AA, automated checks)', () => {
  test('error screen with Try again, and the focused skip link', { tag: '@regression' }, async ({ patientPage }) => {
    await patientPage.route('**/api/appointments', (route) => route.abort('internetdisconnected'));
    await patientPage.goto('/#/appointments');
    await expect(patientPage.getByRole('button', { name: 'Try again' })).toBeVisible();
    await patientPage.getByRole('link', { name: 'Skip to main content' }).focus();
    await expectNoViolations(patientPage);
  });

  test('reschedule page with a new slot chosen', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    await patientPage.goto(`/#/appointments/${booked.id}/reschedule`);
    const reschedule = new ReschedulePage(patientPage);
    await reschedule.slot('11:00').click();
    await expectNoViolations(patientPage);
  });

  test('all appointments with filters applied and the summary', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();
    await appointments.filter({ doctor: String(doctor.id), status: 'booked' });
    await expect(appointments.count('total')).toHaveText('1');
    await expectNoViolations(adminPage);
  });

  test('my appointments with upcoming and history, including a cancellation reason', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const cancelled = await (await patient.book(doctor.id, { date: TOMORROW, time: '11:00' })).json();
    await patient.cancel(cancelled.id, 'Feeling better');
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    await expect(appointments.section('History')).toHaveCount(1);
    await expectNoViolations(patientPage);
  });

  test('admin doctors page', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await expect(doctors.card(doctor)).toBeVisible();
    await expectNoViolations(adminPage);
  });

  test('doctor form with an error shown', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    await adminPage.goto(`/#/doctors/${doctor.id}`);
    const form = new DoctorFormPage(adminPage);
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await form.day(day).uncheck();
    await form.save.click();
    await expect(form.error).toBeVisible();
    await expectNoViolations(adminPage);
  });

  test('leave days page with a day listed', { tag: '@regression' }, async ({ adminPage, admin, doctor }) => {
    await admin.addLeave(doctor.id, { date: TOMORROW, reason: 'Conference' });
    const leave = new ScheduleDatesPage(adminPage);
    await leave.gotoLeave(doctor);
    await expect(leave.entries).toHaveCount(1);
    await expectNoViolations(adminPage);
  });

  test('holidays page', { tag: '@regression' }, async ({ adminPage }) => {
    await new ScheduleDatesPage(adminPage).gotoHolidays();
    await expectNoViolations(adminPage);
  });

  test('dialog listing the appointments a change would cancel', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await doctors.startDeactivating(doctor);
    await expect(doctors.affected.list).toBeVisible();
    await expectNoViolations(adminPage);
  });

  test('sign-in page', { tag: '@regression' }, async ({ page }) => {
    await new LoginPage(page).goto();
    await expectNoViolations(page);
  });

  test('registration page', { tag: '@regression' }, async ({ page }) => {
    await new RegisterPage(page).goto();
    await expectNoViolations(page);
  });

  test('booking page with a slot selected', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await booking.slot('10:00').click();
    await expectNoViolations(patientPage);
  });

  test('change password page with an error shown', { tag: '@regression' }, async ({ patientPage }) => {
    const changePassword = new ChangePasswordPage(patientPage);
    await changePassword.goto();
    await changePassword.change('not-my-password', 'Brand-new-pass-1');
    await expect(changePassword.error).toBeVisible();
    await expectNoViolations(patientPage);
  });

  test('appointments page with the cancel dialog open', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    await expectNoViolations(patientPage);

    await appointments.openCancelDialog(appointments.card(doctor.name));
    await expectNoViolations(patientPage);
  });
});
