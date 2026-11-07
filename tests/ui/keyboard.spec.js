const { test, expect } = require('../support/fixtures');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { DoctorsPage } = require('../pages/admin-pages');
const { TOMORROW } = require('../support/clinic-time');

// Keyboard checks run on the shared server; the phone layout checks are in phone-layout.spec.js.

test.describe('Keyboard use', () => {
  test('the first Tab reaches a skip link that moves focus to the page heading', { tag: '@regression' }, async ({ patientPage, browserName }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    const skip = patientPage.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).not.toBeInViewport();

    // WebKit, like Safari with its default settings, never moves focus to links by keyboard
    // (plain Tab skips them), so there the link is focused directly and the rest is checked.
    if (browserName === 'webkit') await skip.focus();
    else await patientPage.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await patientPage.keyboard.press('Enter');

    await expect(booking.heading).toBeFocused();
    await expect(patientPage).toHaveURL(/#\/book$/); // the route is unchanged
  });

  test('an appointment can be booked without a mouse', { tag: '@regression' }, async ({ patientPage, doctor }) => {
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);

    await booking.slot('10:30').focus();
    await patientPage.keyboard.press('Space');
    await expect(booking.slot('10:30')).toHaveAttribute('aria-pressed', 'true');
    await booking.reason.focus();
    await patientPage.keyboard.type('Sore throat');
    await patientPage.keyboard.press('Tab');
    await expect(booking.confirm).toBeFocused();
    await patientPage.keyboard.press('Enter');

    await expect(new AppointmentsPage(patientPage).toast).toHaveText('Appointment booked successfully');
  });

  test('Escape closes the cancel dialog and focus returns to the button that opened it', { tag: '@regression' }, async ({ patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW });
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    const opener = appointments.card(doctor.name).getByRole('button', { name: 'Cancel appointment' });
    await opener.focus();

    await patientPage.keyboard.press('Enter');
    await expect(appointments.dialog).toBeVisible();
    await expect(appointments.cancelReason).toBeFocused(); // focus starts inside the dialog
    await patientPage.keyboard.press('Escape');

    await expect(appointments.dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(appointments.status(appointments.card(doctor.name))).toHaveText('Booked');
  });

  test('deactivating a doctor works from the keyboard', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();

    await adminPage.getByRole('button', { name: `Deactivate ${doctor.name}` }).focus();
    await adminPage.keyboard.press('Enter');
    await expect(doctors.dialog).toBeVisible();
    await doctors.dialog.getByRole('button', { name: 'Deactivate' }).focus();
    await adminPage.keyboard.press('Enter');

    await expect(doctors.status(doctor.name)).toHaveText('Inactive');
  });
});
