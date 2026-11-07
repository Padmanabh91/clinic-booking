const { test, expect } = require('../support/fixtures');
const { TODAY, TOMORROW, SATURDAY, FIRST_DAY_TOO_FAR } = require('../support/clinic-time');

const NEXT_WEDNESDAY = '2030-01-09';

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  const { error } = await response.json();
  expect(error.code).toBe(code);
  return error;
}

const byId = async (client) => Object.fromEntries((await (await client.appointments()).json()).map((a) => [a.id, a]));

test.describe('Moving an appointment', () => {
  test('books the new slot and keeps the original as a linked, cancelled record', { tag: '@regression' }, async ({ patient, doctor }) => {
    const original = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00', reason: 'Back pain' })).json();

    const response = await patient.reschedule(original.id, { date: NEXT_WEDNESDAY, time: '14:30' });

    expect(response.status()).toBe(201);
    const moved = await response.json();
    expect(moved).toMatchObject({
      doctorId: doctor.id, date: NEXT_WEDNESDAY, time: '14:30', reason: 'Back pain', status: 'booked',
      rescheduledFromId: original.id, rescheduledToId: null,
    });
    expect((await byId(patient))[original.id]).toMatchObject({
      date: TOMORROW, time: '10:00', status: 'cancelled', cancelledBy: 'patient',
      cancelReason: 'Moved to a new time.', rescheduledToId: moved.id,
    });
  });

  test('frees the old slot and takes the new one', { tag: '@regression' }, async ({ patient, doctor }) => {
    const original = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();

    await patient.reschedule(original.id, { date: TOMORROW, time: '11:00' });

    const slots = (await (await patient.slots(doctor.id, TOMORROW)).json()).slots;
    expect(slots.find((s) => s.time === '10:00').available).toBe(true);
    expect(slots.find((s) => s.time === '11:00').available).toBe(false);
  });

  test('the new appointment can be moved again, but the old one cannot', { tag: '@regression' }, async ({ patient, doctor }) => {
    const original = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    const moved = await (await patient.reschedule(original.id, { date: TOMORROW, time: '11:00' })).json();

    await expectError(await patient.reschedule(original.id, { date: TOMORROW, time: '12:00' }), 409, 'ALREADY_CANCELLED');
    expect((await patient.reschedule(moved.id, { date: TOMORROW, time: '12:00' })).status()).toBe(201);
  });
});

test.describe('The 2-hour rule (the clock is fixed at 10:00 IST)', () => {
  test('allows moving exactly 2 hours before', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TODAY, time: '12:00' })).json();

    expect((await patient.reschedule(booked.id, { date: TOMORROW, time: '12:00' })).status()).toBe(201);
  });

  test('refuses moving less than 2 hours before, and changes nothing', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TODAY, time: '11:30' })).json();

    const error = await expectError(await patient.reschedule(booked.id, { date: TOMORROW, time: '12:00' }), 422, 'RESCHEDULE_TOO_LATE');

    expect(error.message).toBe('Appointments can be moved up to 2 hours before they start.');
    expect(Object.values(await byId(patient)).map((a) => a.status)).toEqual(['booked']);
  });
});

test.describe('A refused move changes nothing', () => {
  const refusals = [
    ['a slot someone else has', 409, 'SLOT_TAKEN'],
    ['the same slot', 422, 'SAME_SLOT'],
    ['a past slot', 422, 'SLOT_IN_PAST'],
    ["a day the doctor doesn't work", 422, 'NOT_WORKING_DAY'],
    ['a day the doctor is on leave', 422, 'DOCTOR_ON_LEAVE'],
    ['a day too far ahead', 422, 'TOO_FAR_AHEAD'],
    ['a time that is not a slot', 422, 'INVALID_SLOT'],
  ];
  for (const [title, status, code] of refusals) {
    test(`moving to ${title}`, { tag: '@regression' }, async ({ patient, newPatient, admin, doctor }) => {
      const original = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
      const other = await newPatient();
      await other.book(doctor.id, { date: TOMORROW, time: '15:00' });
      await admin.addLeave(doctor.id, { date: NEXT_WEDNESDAY });
      const target = {
        'a slot someone else has': { date: TOMORROW, time: '15:00' },
        'the same slot': { date: TOMORROW, time: '10:00' },
        'a past slot': { date: TODAY, time: '09:30' },
        "a day the doctor doesn't work": { date: SATURDAY, time: '10:00' },
        'a day the doctor is on leave': { date: NEXT_WEDNESDAY, time: '10:00' },
        'a day too far ahead': { date: FIRST_DAY_TOO_FAR, time: '10:00' },
        'a time that is not a slot': { date: TOMORROW, time: '13:00' },
      }[title];

      await expectError(await patient.reschedule(original.id, target), status, code);

      expect(Object.values(await byId(patient))).toEqual([expect.objectContaining({ id: original.id, status: 'booked' })]);
    });
  }

  test('moving to a time the patient is busy with another doctor', { tag: '@regression' }, async ({ patient, doctor, newDoctor }) => {
    const other = await newDoctor();
    const original = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    await patient.book(other.id, { date: TOMORROW, time: '11:00' });

    await expectError(await patient.reschedule(original.id, { date: TOMORROW, time: '11:00' }), 409, 'PATIENT_BUSY');

    expect((await byId(patient))[original.id].status).toBe('booked');
  });
});

test.describe('Who can move what', () => {
  test("a patient cannot move someone else's appointment", { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();
    const theirs = await (await other.book(doctor.id, { date: TOMORROW })).json();

    await expectError(await patient.reschedule(theirs.id, { date: TOMORROW, time: '11:00' }), 403, 'FORBIDDEN');
  });

  test("an admin cannot move a patient's appointment", { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    await expectError(await admin.reschedule(booked.id, { date: TOMORROW, time: '11:00' }), 403, 'FORBIDDEN');
  });

  test('a cancelled appointment cannot be moved', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();
    await patient.cancel(booked.id);

    await expectError(await patient.reschedule(booked.id, { date: TOMORROW, time: '11:00' }), 409, 'ALREADY_CANCELLED');
  });

  test('unknown appointments and bad input are refused', { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    await expectError(await patient.reschedule(999999, { date: TOMORROW, time: '11:00' }), 404, 'NOT_FOUND');
    await expectError(await patient.reschedule(booked.id, { date: '2030-02-31', time: '11:00' }), 400, 'INVALID_INPUT');
    await expectError(await patient.reschedule(booked.id, { date: TOMORROW }), 400, 'INVALID_INPUT');
  });

  test('signing in is needed', { tag: '@regression' }, async ({ newClient }) => {
    await expectError(await (await newClient()).reschedule(1, { date: TOMORROW, time: '11:00' }), 401, 'UNAUTHENTICATED');
  });
});
