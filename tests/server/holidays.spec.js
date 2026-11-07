const { test, expect } = require('../support/local-app');
const { TODAY, TOMORROW, LAST_FRIDAY } = require('../support/clinic-time');

// Holidays close the clinic for every doctor, so each test runs its own copy of the app.

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  const { error } = await response.json();
  expect(error.code).toBe(code);
  return error;
}

test.describe('Clinic holidays', () => {
  test('close the day for every doctor', { tag: '@regression' }, async ({ admin, patient, newDoctor }) => {
    const [first, second] = [await newDoctor(), await newDoctor()];

    const response = await admin.addHoliday({ date: TOMORROW, name: '  Republic Day  ' });

    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual({ holiday: { date: TOMORROW, name: 'Republic Day' }, cancelledAppointments: [] });
    const message = 'The clinic is closed on this day for Republic Day.';
    for (const doctor of [first, second]) {
      expect(await (await patient.slots(doctor.id, TOMORROW)).json())
        .toMatchObject({ working: false, reason: 'CLINIC_CLOSED', message, slots: [] });
      const error = await expectError(await patient.book(doctor.id, { date: TOMORROW }), 422, 'CLINIC_CLOSED');
      expect(error.message).toBe(message);
    }
  });

  test('anyone can see upcoming holidays', { tag: '@regression' }, async ({ admin, newClient }) => {
    await admin.addHoliday({ date: '2030-01-26', name: 'Republic Day' });
    await admin.addHoliday({ date: TOMORROW, name: 'Founders Day' });

    const visitor = await newClient();

    expect(await (await visitor.holidays()).json()).toEqual([
      { date: TOMORROW, name: 'Founders Day' },
      { date: '2030-01-26', name: 'Republic Day' },
    ]);
  });

  test('a day with bookings for several doctors is refused until confirmed, and lists them all', { tag: '@regression' }, async ({ admin, patient, newDoctor }) => {
    const [first, second] = [await newDoctor(), await newDoctor()];
    const a = await (await patient.book(first.id, { date: TOMORROW, time: '10:00' })).json();
    const b = await (await patient.book(second.id, { date: TOMORROW, time: '11:00' })).json();

    const refused = await expectError(await admin.addHoliday({ date: TOMORROW, name: 'Republic Day' }), 409, 'HAS_APPOINTMENTS');
    expect(refused.message).toBe('This change affects 2 booked appointments. Confirm to cancel them.');
    expect(refused.appointments.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(await (await admin.holidays()).json()).toEqual([]);

    const response = await admin.addHoliday({ date: TOMORROW, name: 'Republic Day', cancelAffected: true });

    expect(response.status()).toBe(201);
    const reason = 'The clinic is closed on this day for Republic Day.';
    expect((await (await patient.appointments()).json()).map((x) => [x.status, x.cancelReason]))
      .toEqual([['cancelled', reason], ['cancelled', reason]]);
  });

  test('removing a holiday opens the day again, but cancelled bookings stay cancelled', { tag: '@regression' }, async ({ admin, patient, newDoctor }) => {
    const doctor = await newDoctor();
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    await admin.addHoliday({ date: TOMORROW, name: 'Republic Day', cancelAffected: true });

    expect((await admin.removeHoliday(TOMORROW)).status()).toBe(204);

    expect((await patient.book(doctor.id, { date: TOMORROW, time: '11:00' })).status()).toBe(201);
    expect((await (await patient.appointments()).json()).map((x) => x.status)).toEqual(['cancelled', 'booked']);
    await expectError(await admin.removeHoliday(TOMORROW), 404, 'NOT_FOUND');
  });

  const invalidHolidays = [
    ['a day that is already a holiday', { date: TOMORROW, name: 'Again' }, 409, 'HOLIDAY_EXISTS'],
    ['a past date', { date: LAST_FRIDAY, name: 'Old Day' }, 422, 'DATE_IN_PAST'],
    ['a missing name', { date: '2030-01-26' }, 400, 'INVALID_INPUT'],
    ['an impossible date', { date: '2030-02-30', name: 'Nowhere Day' }, 400, 'INVALID_INPUT'],
  ];
  for (const [title, data, status, code] of invalidHolidays) {
    test(`refuses ${title}`, { tag: '@regression' }, async ({ admin }) => {
      await admin.addHoliday({ date: TOMORROW, name: 'Republic Day' });

      await expectError(await admin.addHoliday(data), status, code);
    });
  }
});

test.describe('Who is affected by a schedule change (the clock moves in these tests)', () => {
  test('appointments that have already started are never cancelled', { tag: '@regression' }, async ({ admin, patient, newDoctor, clock, localApp }) => {
    const doctor = await newDoctor();
    const started = await (await patient.book(doctor.id, { date: TODAY, time: '10:30' })).json();
    const later = await (await patient.book(doctor.id, { date: TODAY, time: '15:00' })).json();
    clock.advance(30); // now 10:30, so the first one has started

    const refused = await expectError(await admin.addHoliday({ date: TODAY, name: 'Sudden Closure' }), 409, 'HAS_APPOINTMENTS');
    expect(refused.appointments.map((a) => a.id)).toEqual([later.id]);

    const deactivated = await admin.updateDoctor(doctor.id, { active: false, cancelAffected: true });
    expect((await deactivated.json()).cancelledAppointments.map((a) => a.id)).toEqual([later.id]);
    expect(localApp.db.prepare('SELECT status FROM appointments WHERE id = ?').get(started.id).status).toBe('booked');
  });

  test('records which admin cancelled and when', { tag: '@regression' }, async ({ admin, patient, newDoctor, clock, localApp }) => {
    const doctor = await newDoctor();
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    clock.advance(5);

    await admin.addLeave(doctor.id, { date: TOMORROW, reason: 'Conference', cancelAffected: true });

    expect({ ...localApp.db.prepare('SELECT cancelled_at, cancelled_by, cancel_reason FROM appointments WHERE id = ?').get(booked.id) })
      .toEqual({ cancelled_at: clock.now(), cancelled_by: 1, cancel_reason: `${doctor.name} is on leave on this day.` });
  });
});
