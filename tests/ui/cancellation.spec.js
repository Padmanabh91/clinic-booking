const { test, expect } = require('../support/fixtures');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TODAY, TOMORROW } = require('../support/clinic-time');

test.describe('Cancelling from My appointments', () => {
  test('confirming the dialog cancels the appointment', { tag: '@smoke' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    const card = appointments.card(doctor.name);

    await appointments.openCancelDialog(card);
    await appointments.confirmCancel.click();

    await expect(appointments.toast).toHaveText('Appointment cancelled successfully');
    await expect(appointments.dialog).toBeHidden();
    await expect(appointments.status(card)).toHaveText('Cancelled');
    await expect(card.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
  });

  test('keeping the appointment changes nothing', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    const card = appointments.card(doctor.name);

    await appointments.openCancelDialog(card);
    await appointments.keep.click();

    await expect(appointments.dialog).toBeHidden();
    await expect(appointments.status(card)).toHaveText('Booked');
  });

  test('inside the 2-hour window the dialog explains the rule', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TODAY, time: '11:30' });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    const card = appointments.card(doctor.name);

    await appointments.openCancelDialog(card);
    await appointments.confirmCancel.click();

    await expect(appointments.dialogError).toHaveText('Appointments can be cancelled up to 2 hours before they start.');
    await appointments.keep.click();
    await expect(appointments.status(card)).toHaveText('Booked');
  });
});

// The server clock is fixed at 10:00, so the page is shown a later clinic time to make
// a booked appointment look started without changing what the server allows.
async function setClinicTime(page, now) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), now } });
  });
}

test.describe('Appointments that have already started', () => {
  test('have no cancel button once the start time arrives', { tag: '@regression' }, async ({ patientPage, patient, doctor, newDoctor }) => {
    const laterDoctor = await newDoctor();
    await patient.book(doctor.id, { date: TODAY, time: '11:30' });
    await patient.book(laterDoctor.id, { date: TOMORROW, time: '10:00' });
    await setClinicTime(patientPage, `${TODAY}T11:30`);
    const appointments = new AppointmentsPage(patientPage);

    await appointments.goto();

    const started = appointments.card(doctor.name);
    await expect(appointments.status(started)).toHaveText('Booked');
    await expect(started.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
    await expect(appointments.card(laterDoctor.name).getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
  });

  test('still show the cancel button one minute before the start', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TODAY, time: '11:30' });
    await setClinicTime(patientPage, `${TODAY}T11:29`);
    const appointments = new AppointmentsPage(patientPage);

    await appointments.goto();

    await expect(appointments.card(doctor.name).getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
  });

  test('have no cancel button in the admin view either', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TODAY, time: '11:30' });
    await setClinicTime(adminPage, `${TODAY}T12:00`);
    const appointments = new AppointmentsPage(adminPage);

    await appointments.goto();

    const card = appointments.card(doctor.name);
    await expect(card).toContainText(`Patient: ${patient.user.name}`);
    await expect(card.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
  });
});

test.describe('Admin view', () => {
  test('an admin sees the patient and can cancel their appointment', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    const appointments = new AppointmentsPage(adminPage);
    await appointments.goto();
    const card = appointments.card(doctor.name);
    await expect(card).toContainText(`Patient: ${patient.user.name}`);

    await appointments.openCancelDialog(card);
    await appointments.confirmCancel.click();

    await expect(appointments.status(card)).toHaveText('Cancelled');
  });

  test('an admin has no booking link', { tag: '@regression' }, async ({ adminPage }) => {
    await new AppointmentsPage(adminPage).goto();

    await expect(adminPage.getByRole('link', { name: 'Book appointment' })).toHaveCount(0);
  });
});
