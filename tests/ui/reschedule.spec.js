const { test, expect } = require('../support/fixtures');
const { AppointmentsPage, ReschedulePage } = require('../pages/appointments-page');
const { TODAY, TOMORROW } = require('../support/clinic-time');
const { doctorLabel } = require('../support/doctors');

const NEXT_WEDNESDAY = '2030-01-09';

test.describe('Rescheduling', () => {
  test('a patient moves an appointment and sees both the new one and the original', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00', reason: 'Back pain' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();

    await appointments.card(doctor.name).getByRole('link', { name: 'Reschedule' }).click();
    const reschedule = new ReschedulePage(patientPage);
    await expect(reschedule.heading).toBeFocused();
    await expect(patientPage).toHaveTitle('Move appointment | Clinic Booking, Bangalore');
    await expect(reschedule.current).toHaveText(`Currently Tue, 8 Jan 2030 at 10:00 IST with ${doctorLabel(doctor)}.`);
    await expect(reschedule.slot('10:00')).toBeDisabled(); // its own current slot
    await reschedule.moveTo(NEXT_WEDNESDAY, '14:30');

    await expect(appointments.toast).toHaveText('Appointment moved to Wed, 9 Jan 2030 at 14:30.');
    const moved = appointments.section('Upcoming');
    await expect(moved).toHaveCount(1); // waits for the list; .all() would not
    await expect(moved).toContainText('Wed, 9 Jan 2030 at 14:30 IST');
    await expect(moved).toContainText('Back pain');
    await expect(moved.getByTestId('moved')).toHaveText('Moved from Tue, 8 Jan 2030 at 10:00.');
    const original = appointments.section('History');
    await expect(original).toHaveCount(1);
    await expect(appointments.status(original)).toHaveText('Rescheduled');
    await expect(original.getByTestId('moved')).toHaveText('Moved to Wed, 9 Jan 2030 at 14:30.');
    await expect(original.getByRole('link', { name: 'Reschedule' })).toHaveCount(0);
  });

  test('inside the 2-hour window the reason is shown and nothing changes', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TODAY, time: '11:30' })).json();
    await patientPage.goto(`/#/appointments/${booked.id}/reschedule`);
    const reschedule = new ReschedulePage(patientPage);

    await reschedule.moveTo(TOMORROW, '11:30');

    await expect(reschedule.error).toHaveText('Appointments can be moved up to 2 hours before they start.');
    expect((await (await patient.appointments()).json()).map((a) => a.status)).toEqual(['booked']);
  });

  test('choosing no slot asks for one', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    await patientPage.goto(`/#/appointments/${booked.id}/reschedule`);
    const reschedule = new ReschedulePage(patientPage);
    await expect(reschedule.slot('11:00')).toBeEnabled();

    await reschedule.confirm.click();

    await expect(reschedule.error).toHaveText('Choose a time slot.');
  });

  test('a cancelled appointment cannot be opened for moving', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    await patient.cancel(booked.id);

    await patientPage.goto(`/#/appointments/${booked.id}/reschedule`);

    await expect(patientPage.getByRole('alert')).toHaveText('That appointment can no longer be moved.');
  });

  test('admins have no reschedule button or address', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();
    await expect(appointments.card(doctor.name).getByRole('link', { name: 'Reschedule' })).toHaveCount(0);

    await adminPage.goto(`/#/appointments/${booked.id}/reschedule`);

    await expect(adminPage).toHaveURL(/#\/appointments$/);
  });
});

test.describe('Cancelling with a reason', () => {
  test("the patient's reason is shown on their cancelled appointment", { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    await appointments.openCancelDialog(appointments.card(doctor.name));

    await appointments.cancelReason.fill('Feeling better');
    await appointments.confirmCancel.click();

    const card = appointments.section('History');
    await expect(appointments.status(card)).toHaveText('Cancelled');
    await expect(card.getByTestId('cancel-reason')).toHaveText('Cancelled by the patient: Feeling better');
  });

  test("an admin's reason is shown to the patient as the clinic's", { tag: '@regression' }, async ({ adminPage, patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW });
    const admin = new AppointmentsPage(adminPage);
    await admin.goto();
    await admin.openCancelDialog(admin.card(doctor.name));

    await admin.confirmCancel.click();

    await expect(admin.toast).toHaveText('Appointment cancelled successfully');
    const mine = new AppointmentsPage(patientPage);
    await mine.goto();
    await expect(mine.card(doctor.name).getByTestId('cancel-reason')).toHaveText('Cancelled by the clinic: No reason given.');
  });
});

test.describe('Upcoming and history', () => {
  test('upcoming is soonest first; history holds cancelled ones; empty sections say so', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: NEXT_WEDNESDAY, time: '09:00', reason: 'Later' });
    await patient.book(doctor.id, { date: TOMORROW, time: '09:00', reason: 'Sooner' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();

    await expect(appointments.section('Upcoming').locator('.reason')).toHaveText(['Sooner', 'Later']);
    await expect(patientPage.getByRole('region', { name: 'History' })).toContainText('No past or cancelled appointments.');
  });

  test('a new patient sees both sections empty', { tag: '@regression' }, async ({ patientPage }) => {
    await new AppointmentsPage(patientPage).goto();

    await expect(patientPage.getByRole('region', { name: 'Upcoming' })).toContainText('No upcoming appointments.');
    await expect(patientPage.getByRole('region', { name: 'History' })).toContainText('No past or cancelled appointments.');
  });
});
