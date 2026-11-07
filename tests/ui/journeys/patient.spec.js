const { test, expect, newPatientData } = require('../../support/fixtures');
const { LoginPage, RegisterPage } = require('../../pages/login-page');
const { BookingPage } = require('../../pages/booking-page');
const { AppointmentsPage, ReschedulePage } = require('../../pages/appointments-page');
const { TOMORROW } = require('../../support/clinic-time');

const NEXT_WEDNESDAY = '2030-01-09';

test.describe('Patient journey', { tag: '@smoke' }, () => {
  test('register, sign in, book, reschedule, cancel with a reason, see the history, sign out', async ({ page, doctor }) => {
    const me = newPatientData();
    const login = new LoginPage(page);
    const booking = new BookingPage(page);
    const appointments = new AppointmentsPage(page);

    await test.step('register, then sign out and sign in again', async () => {
      const register = new RegisterPage(page);
      await register.goto();
      await register.createAccount(me);
      await expect(page.getByTestId('current-user')).toHaveText(me.name);
      await page.getByRole('button', { name: 'Log out' }).click();
      await expect(login.heading).toBeVisible();
      await login.signIn(me.email, me.password);
      await expect(booking.heading).toBeVisible();
    });

    await test.step('book, and see it in Upcoming', async () => {
      await booking.book(doctor, { date: TOMORROW, time: '10:00', reason: 'Persistent cough' });
      await expect(appointments.toast).toHaveText('Appointment booked successfully');
      const upcoming = appointments.section('Upcoming');
      await expect(upcoming).toHaveCount(1);
      await expect(upcoming).toContainText('Tue, 8 Jan 2030 at 10:00 IST');
      await expect(upcoming).toContainText('Persistent cough');
    });

    await test.step('reschedule to another day', async () => {
      await appointments.section('Upcoming').getByRole('link', { name: 'Reschedule' }).click();
      await new ReschedulePage(page).moveTo(NEXT_WEDNESDAY, '14:30');
      await expect(appointments.toast).toHaveText('Appointment moved to Wed, 9 Jan 2030 at 14:30.');
      await expect(appointments.section('Upcoming')).toContainText('Wed, 9 Jan 2030 at 14:30 IST');
      await expect(appointments.status(appointments.section('History'))).toHaveText('Rescheduled');
    });

    await test.step('cancel with a reason, and see it in History', async () => {
      await appointments.openCancelDialog(appointments.section('Upcoming'));
      await appointments.cancelReason.fill('Feeling better');
      await appointments.confirmCancel.click();
      await expect(appointments.toast).toHaveText('Appointment cancelled successfully');
      await expect(page.getByText('No upcoming appointments.')).toBeVisible();
      const history = appointments.section('History');
      await expect(appointments.status(history)).toHaveText(['Cancelled', 'Rescheduled']); // most recent first
      await expect(history.first().getByTestId('cancel-reason')).toHaveText('Cancelled by the patient: Feeling better');
    });

    await test.step('sign out, and stay signed out after a reload', async () => {
      await page.getByRole('button', { name: 'Log out' }).click();
      await expect(login.heading).toBeVisible();
      await page.reload();
      await expect(login.heading).toBeVisible();
    });
  });
});
