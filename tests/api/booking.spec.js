const { test, expect } = require('../support/fixtures');
const {
  TODAY, TOMORROW, LAST_FRIDAY, SATURDAY, LAST_BOOKABLE_DAY, FIRST_DAY_TOO_FAR, MONDAY,
} = require('../support/clinic-time');

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  expect((await response.json()).error.code).toBe(code);
}

test.describe('Booking an appointment', () => {
  test('books a free slot', { tag: '@smoke' }, async ({ patient, doctor }) => {
    const response = await patient.book(doctor.id, { date: TOMORROW, time: '10:00', reason: 'Fever' });

    expect(response.status()).toBe(201);
    expect(await response.json()).toMatchObject({
      doctorId: doctor.id, date: TOMORROW, time: '10:00', reason: 'Fever', status: 'booked', patientId: patient.user.id,
    });
  });

  test('marks a booked slot as unavailable', { tag: '@regression' }, async ({ patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });

    const { slots } = await (await patient.slots(doctor.id, TOMORROW)).json();

    expect(slots.find((s) => s.time === '10:00').available).toBe(false);
    expect(slots.find((s) => s.time === '10:30').available).toBe(true);
  });

  test('requires sign-in', { tag: '@regression' }, async ({ newClient, doctor }) => {
    const client = await newClient();

    await expectError(await client.book(doctor.id), 401, 'UNAUTHENTICATED');
  });
});

test.describe('Double-booking', () => {
  test('refuses a slot another patient already has', { tag: '@smoke' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });

    await expectError(await other.book(doctor.id, { date: TOMORROW, time: '10:00' }), 409, 'SLOT_TAKEN');
  });

  test('lets only one of two simultaneous requests win', { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();

    const responses = await Promise.all([
      patient.book(doctor.id, { date: TOMORROW, time: '11:00' }),
      other.book(doctor.id, { date: TOMORROW, time: '11:00' }),
    ]);

    expect(responses.map((r) => r.status()).sort()).toEqual([201, 409]);
  });

  test('refuses a patient two doctors at the same time', { tag: '@regression' }, async ({ patient, doctor, newDoctor }) => {
    const secondDoctor = await newDoctor();
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });

    await expectError(await patient.book(secondDoctor.id, { date: TOMORROW, time: '10:00' }), 409, 'PATIENT_BUSY');
  });

  test('allows the same doctor and time on a different day', { tag: '@regression' }, async ({ patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });

    const response = await patient.book(doctor.id, { date: '2030-01-09', time: '10:00' });

    expect(response.status()).toBe(201);
  });

  test('frees the slot again after a cancellation', { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();
    const appointment = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    await patient.cancel(appointment.id);

    const response = await other.book(doctor.id, { date: TOMORROW, time: '10:00' });

    expect(response.status()).toBe(201);
  });
});

test.describe('Date and time rules (the clock is fixed at Monday 10:00 IST)', () => {
  test('refuses a date in the past', { tag: '@regression' }, async ({ patient, doctor }) => {
    await expectError(await patient.book(doctor.id, { date: LAST_FRIDAY, time: '10:00' }), 422, 'SLOT_IN_PAST');
  });

  test('refuses an earlier slot today', { tag: '@regression' }, async ({ patient, doctor }) => {
    await expectError(await patient.book(doctor.id, { date: TODAY, time: '09:30' }), 422, 'SLOT_IN_PAST');
  });

  test('refuses the slot starting right now', { tag: '@regression' }, async ({ patient, doctor }) => {
    await expectError(await patient.book(doctor.id, { date: TODAY, time: '10:00' }), 422, 'SLOT_IN_PAST');
  });

  test('accepts the next slot today', { tag: '@regression' }, async ({ patient, doctor }) => {
    const response = await patient.book(doctor.id, { date: TODAY, time: '10:30' });

    expect(response.status()).toBe(201);
  });

  test('accepts the last bookable day, 30 days ahead', { tag: '@regression' }, async ({ patient, doctor }) => {
    const response = await patient.book(doctor.id, { date: LAST_BOOKABLE_DAY });

    expect(response.status()).toBe(201);
  });

  test('refuses 31 days ahead', { tag: '@regression' }, async ({ patient, doctor }) => {
    await expectError(await patient.book(doctor.id, { date: FIRST_DAY_TOO_FAR }), 422, 'TOO_FAR_AHEAD');
  });

  test("refuses a day the doctor doesn't work", { tag: '@regression' }, async ({ patient, doctor }) => {
    await expectError(await patient.book(doctor.id, { date: SATURDAY }), 422, 'NOT_WORKING_DAY');
  });

  test('offers no slots on a non-working day', { tag: '@regression' }, async ({ patient, newDoctor }) => {
    const mondayOnly = await newDoctor({ workingDays: [MONDAY] });

    const body = await (await patient.slots(mondayOnly.id, TOMORROW)).json();

    expect(body).toMatchObject({ working: false, slots: [] });
  });

  for (const [title, time] of [['the lunch break', '13:00'], ['before opening', '08:30'], ['after closing', '17:00'], ['off the half hour', '10:15']]) {
    test(`refuses a time in ${title}`, { tag: '@regression' }, async ({ patient, doctor }) => {
      await expectError(await patient.book(doctor.id, { time }), 422, 'INVALID_SLOT');
    });
  }
});

test.describe('Input validation', () => {
  for (const [title, date] of [['an impossible date', '2030-02-31'], ['a wrongly formatted date', '08-01-2030']]) {
    test(`rejects ${title}`, { tag: '@regression' }, async ({ patient, doctor }) => {
      await expectError(await patient.book(doctor.id, { date }), 400, 'INVALID_INPUT');
    });
  }

  const reasons = [
    ['too short', 'ab', 400],
    ['only spaces', '     ', 400],
    ['the minimum 3 characters', 'abc', 201],
    ['the maximum 200 characters', 'a'.repeat(200), 201],
    ['201 characters', 'a'.repeat(201), 400],
  ];
  for (const [title, reason, status] of reasons) {
    test(`reason that is ${title} returns ${status}`, { tag: '@regression' }, async ({ patient, doctor }) => {
      const response = await patient.book(doctor.id, { reason });

      expect(response.status()).toBe(status);
    });
  }

  test('returns 404 for an unknown doctor', { tag: '@regression' }, async ({ patient }) => {
    await expectError(await patient.book(99999999), 404, 'NOT_FOUND');
  });

  test('returns 400 for a body that is not valid JSON', { tag: '@regression' }, async ({ patient }) => {
    const response = await patient.request.post('/api/appointments', {
      headers: { 'Content-Type': 'application/json' },
      data: '{not json',
    });

    expect(response.status()).toBe(400);
  });
});
