const base = require('../../support/fixtures');
const local = require('../../support/local-app');
const { LoginPage } = require('../../pages/login-page');
const { BookingPage } = require('../../pages/booking-page');
const { TOMORROW } = require('../../support/clinic-time');

const { expect } = base;

base.test.describe('Two patients race for the same slot', { tag: '@smoke' }, () => {
  base.test('exactly one gets it; the other is told and sees the slot taken', async ({ pageFor, newPatient, admin, doctor }) => {
    const pages = [await pageFor(await newPatient()), await pageFor(await newPatient())];
    const forms = pages.map((page) => new BookingPage(page));
    for (const booking of forms) {
      await booking.goto();
      await booking.choose(doctor, TOMORROW);
      await booking.slot('10:00').click();
      await booking.reason.fill('Fever');
    }

    // Both press Confirm at the same moment, each in their own browser context.
    await Promise.all(forms.map((booking) => booking.confirm.click()));

    // Each page ends up either on its appointments (won) or with the error (lost).
    const outcome = (page, booking) => Promise.race([
      page.getByRole('heading', { level: 1, name: 'My appointments' }).waitFor().then(() => 'won'),
      booking.error.filter({ hasText: 'That slot has just been taken.' }).waitFor().then(() => 'lost'),
    ]);
    const results = await Promise.all(pages.map((page, i) => outcome(page, forms[i])));
    expect([...results].sort()).toEqual(['lost', 'won']);

    const loser = forms[results.indexOf('lost')];
    await expect(loser.slot('10:00')).toBeDisabled();
    const booked = (await (await admin.filteredAppointments({ doctorId: doctor.id, status: 'booked' })).json());
    expect(booked).toHaveLength(1);
  });
});

local.test.describe('A session ending while the patient is on the booking page', { tag: '@smoke' }, () => {
  // The clock has to move 8 hours, so this runs on its own copy of the app.
  local.test('confirming sends them to sign-in with an explanation, and nothing is booked', async ({ patient, localPageFor, clock, localApp }) => {
    const page = await localPageFor(patient);
    const booking = new BookingPage(page);
    await booking.goto();
    await booking.choose({ id: 1 }, TOMORROW);
    await booking.slot('10:00').click();
    await booking.reason.fill('Fever');

    clock.advance(8 * 60); // 8 hours without using the session
    await booking.confirm.click();

    const login = new LoginPage(page);
    await expect(login.heading).toBeVisible();
    await expect(login.error).toHaveText('Your session has ended. Please sign in again.');
    expect(localApp.db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n).toBe(0);
  });
});
