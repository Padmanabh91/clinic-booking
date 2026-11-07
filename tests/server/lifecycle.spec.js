const { test, expect } = require('../support/local-app');
const { TODAY, TOMORROW } = require('../support/clinic-time');

// These need appointments whose start time has passed, so each runs its own copy of the app
// and moves its clock. The clock starts at Monday 10:00 IST.

const ASHA_RAO = 1; // seeded doctor, Monday to Friday

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  expect((await response.json()).error.code).toBe(code);
}

test.describe('Marking completed or no-show (the clock moves in these tests)', () => {
  test('can be done from the start time, and records who and when', { tag: '@regression' }, async ({ patient, admin, clock, localApp }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TODAY, time: '10:30' })).json();
    clock.advance(29);
    await expectError(await admin.markOutcome(booked.id, 'completed'), 422, 'NOT_STARTED');

    clock.advance(1);
    const response = await admin.markOutcome(booked.id, 'completed');

    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('completed');
    expect({ ...localApp.db.prepare('SELECT outcome_at, outcome_by FROM appointments WHERE id = ?').get(booked.id) })
      .toEqual({ outcome_at: clock.now(), outcome_by: 1 });
  });

  test('a mistake can be corrected', { tag: '@regression' }, async ({ patient, admin, clock }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TODAY, time: '10:30' })).json();
    clock.advance(60);
    await admin.markOutcome(booked.id, 'completed');

    const response = await admin.markOutcome(booked.id, 'no-show');

    expect((await response.json()).status).toBe('no-show');
  });

  test('a completed appointment cannot be cancelled or moved', { tag: '@regression' }, async ({ patient, admin, clock }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TODAY, time: '10:30' })).json();
    clock.advance(60);
    await admin.markOutcome(booked.id, 'completed');

    await expectError(await admin.cancel(booked.id), 409, 'NOT_BOOKED');
    await expectError(await patient.reschedule(booked.id, { date: TOMORROW, time: '10:00' }), 409, 'NOT_BOOKED');
  });

  test('the patient sees the final status in their list', { tag: '@regression' }, async ({ patient, admin, clock }) => {
    const first = await (await patient.book(ASHA_RAO, { date: TODAY, time: '10:30' })).json();
    const second = await (await patient.book(ASHA_RAO, { date: TODAY, time: '11:00' })).json();
    clock.advance(90);
    await admin.markOutcome(first.id, 'completed');
    await admin.markOutcome(second.id, 'no-show');

    const statuses = (await (await patient.appointments()).json()).map((a) => a.status);

    expect(statuses).toEqual(['completed', 'no-show']);
  });

  test('the summary counts them', { tag: '@regression' }, async ({ patient, admin, clock }) => {
    const first = await (await patient.book(ASHA_RAO, { date: TODAY, time: '10:30' })).json();
    const second = await (await patient.book(ASHA_RAO, { date: TODAY, time: '11:00' })).json();
    await patient.book(ASHA_RAO, { date: TOMORROW, time: '10:00' });
    clock.advance(90);
    await admin.markOutcome(first.id, 'completed');
    await admin.markOutcome(second.id, 'no-show');

    expect(await (await admin.summary({ from: TODAY, to: TODAY })).json())
      .toEqual({ counts: { booked: 0, cancelled: 0, completed: 1, 'no-show': 1 }, total: 2 });
    expect(await (await admin.summary()).json())
      .toEqual({ counts: { booked: 1, cancelled: 0, completed: 1, 'no-show': 1 }, total: 3 });
  });
});

test.describe('Moving an appointment as time passes', () => {
  // A day later the session has ended (8 hours unused), so the patient signs in again.
  const signInAgain = (patient) => patient.login(patient.user.email, patient.user.password);

  test('is still allowed exactly 2 hours before', { tag: '@regression' }, async ({ patient, clock }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TOMORROW, time: '10:00' })).json();
    clock.advance(22 * 60); // Tuesday 08:00
    await signInAgain(patient);

    expect((await patient.reschedule(booked.id, { date: TOMORROW, time: '14:00' })).status()).toBe(201);
  });

  test('is refused one minute later', { tag: '@regression' }, async ({ patient, clock }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TOMORROW, time: '10:00' })).json();
    clock.advance(22 * 60 + 1);
    await signInAgain(patient);

    await expectError(await patient.reschedule(booked.id, { date: TOMORROW, time: '14:00' }), 422, 'RESCHEDULE_TOO_LATE');
  });

  test('records when the original was moved', { tag: '@regression' }, async ({ patient, clock, localApp }) => {
    const booked = await (await patient.book(ASHA_RAO, { date: TOMORROW, time: '10:00' })).json();
    clock.advance(15);

    await patient.reschedule(booked.id, { date: TOMORROW, time: '11:00' });

    expect({ ...localApp.db.prepare('SELECT status, cancelled_at, cancelled_by FROM appointments WHERE id = ?').get(booked.id) })
      .toEqual({ status: 'cancelled', cancelled_at: clock.now(), cancelled_by: patient.user.id });
  });
});
