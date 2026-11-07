const { test, expect } = require('../support/fixtures');
const { FIXED_NOW, TODAY, TOMORROW, LAST_BOOKABLE_DAY } = require('../support/clinic-time');

// Completed and no-show need the start time to pass, so marking them is tested with a
// moving clock in tests/server/lifecycle.spec.js. The shared server's clock never moves.

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  const { error } = await response.json();
  expect(error.code).toBe(code);
  return error;
}

test.describe('Every cancellation records who, when and why', () => {
  test('a patient cancelling with a reason', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    const cancelled = await (await patient.cancel(booked.id, '  Feeling better  ')).json();

    expect(cancelled).toMatchObject({
      status: 'cancelled', cancelledBy: 'patient', cancelledAt: FIXED_NOW, cancelReason: 'Feeling better',
    });
  });

  test('an admin cancelling without a reason', { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    const cancelled = await (await admin.cancel(booked.id)).json();

    expect(cancelled).toMatchObject({
      status: 'cancelled', cancelledBy: 'clinic', cancelledAt: FIXED_NOW, cancelReason: 'No reason given.',
    });
  });

  test('a reason over 200 characters is refused', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    await expectError(await patient.cancel(booked.id, 'x'.repeat(201)), 400, 'INVALID_INPUT');
    expect((await patient.cancel(booked.id, 'x'.repeat(200))).status()).toBe(200);
  });

  test('a booked appointment has no cancellation details', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    expect(booked).toMatchObject({ cancelledAt: null, cancelledBy: null, cancelReason: null });
  });
});

test.describe('Marking completed or no-show', () => {
  test('is refused before the appointment starts', { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TODAY, time: '10:30' })).json();

    const error = await expectError(await admin.markOutcome(booked.id, 'completed'), 422, 'NOT_STARTED');

    expect(error.message).toBe("An appointment can't be marked before it starts.");
  });

  test('is for admins only', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    await expectError(await patient.markOutcome(booked.id, 'completed'), 403, 'FORBIDDEN');
  });

  test('only takes completed or no-show', { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    for (const status of ['booked', 'cancelled', 'done', undefined]) {
      await expectError(await admin.markOutcome(booked.id, status), 400, 'INVALID_INPUT');
    }
  });

  test('a cancelled appointment cannot be marked', { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    await patient.cancel(booked.id);

    await expectError(await admin.markOutcome(booked.id, 'no-show'), 409, 'ALREADY_CANCELLED');
  });
});

test.describe('Admin filters', () => {
  // Every test's admin sees all appointments on the shared server, so each filters by its own doctor.
  async function setUp({ patient, newPatient, doctor }) {
    const other = await newPatient();
    const a = await (await patient.book(doctor.id, { date: TODAY, time: '15:00' })).json();
    const b = await (await other.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    const c = await (await patient.book(doctor.id, { date: LAST_BOOKABLE_DAY, time: '10:00' })).json();
    await other.cancel(b.id);
    return { a, b, c };
  }
  const ids = async (response) => (await response.json()).map((x) => x.id);

  test('by doctor', { tag: '@regression' }, async ({ patient, newPatient, admin, doctor, newDoctor }) => {
    const { a, b, c } = await setUp({ patient, newPatient, doctor });
    const elsewhere = await newDoctor();
    await patient.book(elsewhere.id, { date: TOMORROW, time: '11:00' });

    expect(await ids(await admin.filteredAppointments({ doctorId: doctor.id }))).toEqual([a.id, b.id, c.id]);
  });

  test('by date range, including both ends', { tag: '@regression' }, async ({ patient, newPatient, admin, doctor }) => {
    const { a, b } = await setUp({ patient, newPatient, doctor });

    expect(await ids(await admin.filteredAppointments({ doctorId: doctor.id, from: TODAY, to: TOMORROW }))).toEqual([a.id, b.id]);
    expect(await ids(await admin.filteredAppointments({ doctorId: doctor.id, from: TOMORROW, to: TOMORROW }))).toEqual([b.id]);
  });

  test('by status', { tag: '@regression' }, async ({ patient, newPatient, admin, doctor }) => {
    const { b } = await setUp({ patient, newPatient, doctor });

    expect(await ids(await admin.filteredAppointments({ doctorId: doctor.id, status: 'cancelled' }))).toEqual([b.id]);
  });

  test('a patient filtering still sees only their own', { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const { a, c } = await setUp({ patient, newPatient, doctor });

    expect(await ids(await patient.filteredAppointments({ doctorId: doctor.id }))).toEqual([a.id, c.id]);
  });

  const invalidFilters = [
    ['a doctor that is not a number', { doctorId: 'abc' }],
    ['an impossible date', { from: '2030-02-31' }],
    ['From after To', { from: TOMORROW, to: TODAY }],
    ['an unknown status', { status: 'lost' }],
  ];
  for (const [title, filters] of invalidFilters) {
    test(`refuses ${title}`, { tag: '@regression' }, async ({ admin }) => {
      await expectError(await admin.filteredAppointments(filters), 400, 'INVALID_INPUT');
    });
  }
});

test.describe('Admin summary', () => {
  test('counts each status for the doctor and dates chosen', { tag: '@regression' }, async ({ patient, newPatient, admin, doctor }) => {
    const other = await newPatient();
    await patient.book(doctor.id, { date: TODAY, time: '15:00' });
    const b = await (await other.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    await patient.book(doctor.id, { date: LAST_BOOKABLE_DAY, time: '10:00' });
    await other.cancel(b.id);

    const all = await (await admin.summary({ doctorId: doctor.id })).json();
    const firstTwoDays = await (await admin.summary({ doctorId: doctor.id, from: TODAY, to: TOMORROW, status: 'booked' })).json();

    expect(all).toEqual({ counts: { booked: 2, cancelled: 1, completed: 0, 'no-show': 0 }, total: 3 });
    // The status filter is ignored: the summary compares statuses.
    expect(firstTwoDays).toEqual({ counts: { booked: 1, cancelled: 1, completed: 0, 'no-show': 0 }, total: 2 });
  });

  test('is for admins only', { tag: '@regression' }, async ({ patient }) => {
    await expectError(await patient.summary(), 403, 'FORBIDDEN');
  });

  test('refuses bad filters', { tag: '@regression' }, async ({ admin }) => {
    await expectError(await admin.summary({ from: 'yesterday' }), 400, 'INVALID_INPUT');
  });
});
