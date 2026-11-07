const { AxeBuilder } = require('@axe-core/playwright');
const { test, expect } = require('../support/local-app');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TODAY, TOMORROW } = require('../support/clinic-time');

// Past appointments need the clock to move, so each test runs its own copy of the app.
// The clock starts at Monday 10:00 IST.

const ASHA_RAO = { id: 1, name: 'Dr. Asha Rao' };

async function bookAndLetStart({ patient, clock }) {
  await patient.book(ASHA_RAO.id, { date: TODAY, time: '10:30', reason: 'Fever' });
  await patient.book(ASHA_RAO.id, { date: TODAY, time: '11:00', reason: 'Cough' });
  await patient.book(ASHA_RAO.id, { date: TOMORROW, time: '10:00', reason: 'Check-up' });
  clock.advance(90); // 11:30: the first two have started
}

test.describe('Marking outcomes and the history (the clock moves in these tests)', () => {
  test('an admin marks started appointments, and upcoming ones have no outcome buttons', { tag: '@regression' }, async ({ admin, patient, clock, localPageFor }) => {
    await bookAndLetStart({ patient, clock });
    const appointments = new AppointmentsPage(await localPageFor(admin));
    await appointments.goto();
    await expect(appointments.card('Check-up').getByRole('button', { name: 'Mark completed' })).toHaveCount(0);

    await appointments.card('Fever').getByRole('button', { name: 'Mark completed' }).click();
    await expect(appointments.toast).toHaveText('Marked as completed.');
    await appointments.card('Cough').getByRole('button', { name: 'Mark no-show' }).click();

    await expect(appointments.toast).toHaveText('Marked as no-show.');
    await expect(appointments.status(appointments.card('Fever'))).toHaveText('Completed');
    await expect(appointments.status(appointments.card('Cough'))).toHaveText('No-show');
    await expect(appointments.card('Fever').getByRole('button')).toHaveCount(0);
    await expect(appointments.count('completed')).toHaveText('1');
    await expect(appointments.count('no-show')).toHaveText('1');
  });

  test('the patient sees past appointments, most recent first, with their final status', { tag: '@regression' }, async ({ admin, patient, clock, localPageFor }) => {
    await bookAndLetStart({ patient, clock });
    const [fever, cough] = await (await patient.appointments()).json();
    await admin.markOutcome(fever.id, 'completed');
    await admin.markOutcome(cough.id, 'no-show');
    const appointments = new AppointmentsPage(await localPageFor(patient));

    await appointments.goto();

    await expect(appointments.section('Upcoming').locator('.reason')).toHaveText(['Check-up']);
    const history = appointments.section('History');
    await expect(history.locator('.reason')).toHaveText(['Cough', 'Fever']);
    await expect(history.getByTestId('appointment-status')).toHaveText(['No-show', 'Completed']);
    await expect(history.getByRole('button')).toHaveCount(0);
    await expect(history.getByRole('link')).toHaveCount(0);
  });

  test('a started appointment not yet marked shows as booked in the history, without patient actions', { tag: '@regression' }, async ({ patient, clock, localPageFor }) => {
    await bookAndLetStart({ patient, clock });
    const appointments = new AppointmentsPage(await localPageFor(patient));

    await appointments.goto();

    const fever = appointments.card('Fever');
    await expect(appointments.section('History').filter({ hasText: 'Fever' })).toHaveCount(1);
    await expect(appointments.status(fever)).toHaveText('Booked');
    await expect(fever.getByRole('button')).toHaveCount(0);
  });

  test('the admin view with history, summary and outcome buttons passes accessibility checks', { tag: '@regression' }, async ({ admin, patient, clock, localPageFor, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox crashes intermittently during this axe scan; see "Known issues" in docs/test-strategy.md');
    await bookAndLetStart({ patient, clock });
    const [fever] = await (await patient.appointments()).json();
    await admin.markOutcome(fever.id, 'completed');
    const page = await localPageFor(admin);
    const appointments = new AppointmentsPage(page);
    await appointments.goto();
    // Known issue: in Firefox, under full-suite load, the axe scan below occasionally crashes
    // the page ("Page crashed"), whatever locator waits before it (see docs/test-strategy.md).
    await expect(appointments.card('Cough').locator('button', { hasText: 'Mark no-show' })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

    expect(results.violations).toEqual([]);
  });
});
