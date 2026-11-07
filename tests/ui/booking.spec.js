const { test, expect } = require('../support/fixtures');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TODAY, TOMORROW, MONDAY } = require('../support/clinic-time');

test.describe('Booking page', () => {
  test('shows the clinic location and time zone', { tag: '@regression' }, async ({ patientPage }) => {
    const booking = new BookingPage(patientPage);

    await booking.goto();

    await expect(booking.clinicNote).toHaveText('Clinic location: Bangalore. All times are in Bangalore time (IST).');
  });

  test('a patient books an appointment and sees it listed', { tag: '@smoke' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();

    await booking.book(doctor, { date: TOMORROW, time: '10:30', reason: 'Persistent cough' });

    const appointments = new AppointmentsPage(patientPage);
    await expect(appointments.toast).toHaveText('Appointment booked successfully');
    const card = appointments.card(doctor.name);
    await expect(appointments.status(card)).toHaveText('Booked');
    await expect(card).toContainText('Tue, 8 Jan 2030 at 10:30 IST');
    await expect(card).toContainText('Bangalore');
    await expect(card).toContainText('Persistent cough');
  });

  test('a chosen slot stays selected after leaving the date field', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await booking.date.focus();

    await booking.slot('10:30').click();
    await booking.reason.click();

    await expect(booking.slot('10:30')).toHaveAttribute('aria-pressed', 'true');
  });

  test("today's earlier slots are disabled", { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();

    await booking.choose(doctor, TODAY);

    await expect(booking.slot('09:30')).toBeDisabled();
    await expect(booking.slot('10:00')).toBeDisabled();
    await expect(booking.slot('10:30')).toBeEnabled();
  });

  test('a slot another patient booked is disabled', { tag: '@regression' }, async ({ patientPage, newPatient, doctor }) => {
    const other = await newPatient();
    await other.book(doctor.id, { date: TOMORROW, time: '11:00' });
    const booking = new BookingPage(patientPage);
    await booking.goto();

    await booking.choose(doctor, TOMORROW);

    await expect(booking.slot('11:00')).toBeDisabled();
    await expect(booking.slot('11:30')).toBeEnabled();
  });

  test('losing a slot to someone else explains why and refreshes the times', { tag: '@regression' }, async ({ patientPage, newPatient, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await booking.slot('14:00').click();
    await booking.reason.fill('Follow-up');

    const other = await newPatient();
    await other.book(doctor.id, { date: TOMORROW, time: '14:00' });
    await booking.confirm.click();

    await expect(booking.error).toHaveText('That slot has just been taken.');
    await expect(booking.slot('14:00')).toBeDisabled();
  });

  test("a doctor's non-working day shows a message instead of slots", { tag: '@regression' }, async ({ patientPage, newDoctor }) => {
    const mondayOnly = await newDoctor({ workingDays: [MONDAY] });
    const booking = new BookingPage(patientPage);
    await booking.goto();

    await booking.choose(mondayOnly, TOMORROW);

    await expect(booking.slots).toHaveText('The doctor does not work on this day.');
  });

  test('confirming without choosing a slot asks for one', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await booking.reason.fill('Check-up');

    await booking.confirm.click();

    await expect(booking.error).toHaveText('Choose a time slot.');
  });

  test('HTML in the reason is shown as plain text, not run', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const reason = '<img src=x onerror="window.__xss=true">';
    await patient.book(doctor.id, { date: TOMORROW, time: '15:00', reason });
    const appointments = new AppointmentsPage(patientPage);

    await appointments.goto();

    const card = appointments.card(doctor.name);
    await expect(card).toContainText(reason);
    await expect(card.locator('img')).toHaveCount(0);
    expect(await patientPage.evaluate(() => window.__xss)).toBeUndefined();
  });
});
