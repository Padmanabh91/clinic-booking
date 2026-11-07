const { test, expect } = require('../support/fixtures');
const { TODAY, TOMORROW, SATURDAY, LAST_FRIDAY, LAST_BOOKABLE_DAY } = require('../support/clinic-time');

// Holidays close the clinic for every doctor, so they are tested on separate copies of the
// app (tests/server/holidays.spec.js). Everything here only touches each test's own doctor.

const TUESDAY = 2;
const THURSDAY = 4;
const NEXT_THURSDAY = '2030-01-10';

async function expectError(response, status, code) {
  expect(response.status()).toBe(status);
  const { error } = await response.json();
  expect(error.code).toBe(code);
  return error;
}

const bookedIds = async (client) => (await (await client.appointments()).json())
  .filter((a) => a.status === 'booked').map((a) => a.id);

test.describe('Listing doctors', () => {
  test('patients see only active doctors; admins see all, with their status', { tag: '@regression' }, async ({ patient, admin, doctor, newDoctor }) => {
    const inactive = await newDoctor();
    await admin.updateDoctor(inactive.id, { active: false });

    const forPatients = await (await patient.doctors()).json();
    const forAdmins = await (await admin.allDoctors()).json();

    expect(forPatients).toContainEqual({ ...doctor, active: true });
    expect(forPatients.map((d) => d.id)).not.toContain(inactive.id);
    expect(forAdmins).toContainEqual({ ...inactive, active: false });
  });
});

test.describe('Editing a doctor', () => {
  test('changes only the fields sent', { tag: '@regression' }, async ({ admin, doctor }) => {
    const response = await admin.updateDoctor(doctor.id, { specialty: '  Cardiology  ' });

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      doctor: { ...doctor, specialty: 'Cardiology' }, cancelledAppointments: [],
    });
  });

  const invalidEdits = [
    ['nothing to change', {}],
    ['a one-letter name', { name: 'A' }],
    ['a blank specialty', { specialty: '  ' }],
    ['no working days', { workingDays: [] }],
    ['a day number out of range', { workingDays: [7] }],
    ['active that is not true or false', { active: 'no' }],
  ];
  for (const [title, data] of invalidEdits) {
    test(`refuses ${title}`, { tag: '@regression' }, async ({ admin, doctor }) => {
      await expectError(await admin.updateDoctor(doctor.id, data), 400, 'INVALID_INPUT');
    });
  }

  test('returns 404 for an unknown doctor', { tag: '@regression' }, async ({ admin }) => {
    await expectError(await admin.updateDoctor(999999, { name: 'Dr. Nobody' }), 404, 'NOT_FOUND');
  });

  test('removing a working day with bookings on it lists them and changes nothing', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    const onTuesday = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();

    const error = await expectError(await admin.updateDoctor(doctor.id, { workingDays: [1, 3, 4, 5] }), 409, 'HAS_APPOINTMENTS');

    expect(error.message).toBe('This change affects 1 booked appointment. Confirm to cancel it.');
    expect(error.appointments).toEqual([expect.objectContaining({ id: onTuesday.id, patientName: patient.user.name })]);
    expect((await (await admin.allDoctors()).json()).find((d) => d.id === doctor.id).workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(await bookedIds(patient)).toEqual([onTuesday.id]);
  });

  test('confirming cancels only the bookings on removed days, and says why', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    const onTuesday = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00' })).json();
    const onThursday = await (await patient.book(doctor.id, { date: NEXT_THURSDAY, time: '10:00' })).json();

    const response = await admin.updateDoctor(doctor.id, { workingDays: [1, 3, 4, 5], cancelAffected: true });

    expect(response.status()).toBe(200);
    const reason = `${doctor.name} no longer works on this day.`;
    expect((await response.json()).cancelledAppointments).toEqual([
      expect.objectContaining({ id: onTuesday.id, status: 'cancelled', cancelReason: reason }),
    ]);
    expect(await bookedIds(patient)).toEqual([onThursday.id]);
  });
});

test.describe('Deactivating a doctor', () => {
  test('stops new bookings and offers no slots, saying why', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    await admin.updateDoctor(doctor.id, { active: false });

    const message = `${doctor.name} is not taking appointments.`;
    expect(await (await patient.slots(doctor.id, TOMORROW)).json())
      .toEqual({ date: TOMORROW, working: false, reason: 'DOCTOR_UNAVAILABLE', message, slots: [] });
    const error = await expectError(await patient.book(doctor.id, { date: TOMORROW }), 422, 'DOCTOR_UNAVAILABLE');
    expect(error.message).toBe(message);
  });

  test('with upcoming bookings, is refused until confirmed', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TODAY, time: '10:30' })).json();

    const error = await expectError(await admin.updateDoctor(doctor.id, { active: false }), 409, 'HAS_APPOINTMENTS');

    expect(error.appointments.map((a) => a.id)).toEqual([booked.id]);
    expect((await (await patient.doctors()).json()).map((d) => d.id)).toContain(doctor.id);
  });

  test('once confirmed, cancels every upcoming booking and the patient sees why', { tag: '@regression' }, async ({ admin, patient, newPatient, doctor }) => {
    const other = await newPatient();
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    await other.book(doctor.id, { date: LAST_BOOKABLE_DAY, time: '15:00' });

    const response = await admin.updateDoctor(doctor.id, { active: false, cancelAffected: true });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.doctor.active).toBe(false);
    expect(body.cancelledAppointments).toHaveLength(2);
    const [mine] = await (await patient.appointments()).json();
    expect(mine).toMatchObject({ status: 'cancelled', cancelReason: `${doctor.name} is no longer taking appointments.` });
  });

  test('reactivating makes the doctor bookable again', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    await admin.updateDoctor(doctor.id, { active: false });

    await admin.updateDoctor(doctor.id, { active: true });

    expect((await patient.book(doctor.id, { date: TOMORROW })).status()).toBe(201);
  });

  test("a patient's own cancellation is recorded as theirs, not the clinic's", { tag: '@regression' }, async ({ patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW })).json();

    const cancelled = await (await patient.cancel(booked.id)).json();

    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledBy: 'patient', cancelReason: 'No reason given.' });
  });
});

test.describe('Leave days', () => {
  test('close the day for that doctor only', { tag: '@regression' }, async ({ admin, patient, doctor, newDoctor }) => {
    const colleague = await newDoctor();

    const response = await admin.addLeave(doctor.id, { date: TOMORROW, reason: '  Conference  ' });

    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual({ leave: { date: TOMORROW, reason: 'Conference' }, cancelledAppointments: [] });
    const message = `${doctor.name} is on leave on this day.`;
    expect(await (await patient.slots(doctor.id, TOMORROW)).json())
      .toMatchObject({ working: false, reason: 'DOCTOR_ON_LEAVE', message, slots: [] });
    const error = await expectError(await patient.book(doctor.id, { date: TOMORROW }), 422, 'DOCTOR_ON_LEAVE');
    expect(error.message).toBe(message);
    expect((await patient.book(doctor.id, { date: NEXT_THURSDAY })).status()).toBe(201);
    expect((await patient.book(colleague.id, { date: TOMORROW, time: '11:00' })).status()).toBe(201);
  });

  test('a day with bookings is refused until confirmed, then they are cancelled with the reason', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    const booked = await (await patient.book(doctor.id, { date: TOMORROW, time: '14:00' })).json();

    const refused = await expectError(await admin.addLeave(doctor.id, { date: TOMORROW }), 409, 'HAS_APPOINTMENTS');
    expect(refused.appointments.map((a) => a.id)).toEqual([booked.id]);
    expect((await (await admin.leaveDays(doctor.id)).json())).toEqual([]);

    const response = await admin.addLeave(doctor.id, { date: TOMORROW, cancelAffected: true });

    expect(response.status()).toBe(201);
    expect((await response.json()).cancelledAppointments).toEqual([
      expect.objectContaining({ id: booked.id, status: 'cancelled', cancelReason: `${doctor.name} is on leave on this day.` }),
    ]);
  });

  test('are listed from today onwards, in date order', { tag: '@regression' }, async ({ admin, doctor }) => {
    await admin.addLeave(doctor.id, { date: NEXT_THURSDAY, reason: 'Training' });
    await admin.addLeave(doctor.id, { date: TODAY });

    expect(await (await admin.leaveDays(doctor.id)).json()).toEqual([
      { date: TODAY, reason: null },
      { date: NEXT_THURSDAY, reason: 'Training' },
    ]);
  });

  test('removing one opens the day again', { tag: '@regression' }, async ({ admin, patient, doctor }) => {
    await admin.addLeave(doctor.id, { date: TOMORROW });

    expect((await admin.removeLeave(doctor.id, TOMORROW)).status()).toBe(204);

    expect((await patient.book(doctor.id, { date: TOMORROW })).status()).toBe(201);
    await expectError(await admin.removeLeave(doctor.id, TOMORROW), 404, 'NOT_FOUND');
  });

  test('a day already on leave is refused', { tag: '@regression' }, async ({ admin, doctor }) => {
    await admin.addLeave(doctor.id, { date: TOMORROW });

    await expectError(await admin.addLeave(doctor.id, { date: TOMORROW }), 409, 'LEAVE_EXISTS');
  });

  const invalidLeave = [
    ['a past date', { date: LAST_FRIDAY }, 422, 'DATE_IN_PAST'],
    ['an impossible date', { date: '2030-02-31' }, 400, 'INVALID_INPUT'],
    ['a reason over 100 characters', { date: TOMORROW, reason: 'x'.repeat(101) }, 400, 'INVALID_INPUT'],
  ];
  for (const [title, data, status, code] of invalidLeave) {
    test(`refuses ${title}`, { tag: '@regression' }, async ({ admin, doctor }) => {
      await expectError(await admin.addLeave(doctor.id, data), status, code);
    });
  }

  test("a day the doctor doesn't work can still be marked, and slots say they don't work", { tag: '@regression' }, async ({ admin, patient, newDoctor }) => {
    const tuesdaysAndThursdays = await newDoctor({ workingDays: [TUESDAY, THURSDAY] });

    expect((await admin.addLeave(tuesdaysAndThursdays.id, { date: SATURDAY })).status()).toBe(201);

    expect(await (await patient.slots(tuesdaysAndThursdays.id, SATURDAY)).json()).toMatchObject({ reason: 'NOT_WORKING_DAY' });
  });
});

test.describe('Who can manage doctors', () => {
  const adminOnly = [
    ['see every doctor', (c) => c.allDoctors()],
    ['edit a doctor', (c, id) => c.updateDoctor(id, { name: 'Dr. Changed' })],
    ['list leave days', (c, id) => c.leaveDays(id)],
    ['add a leave day', (c, id) => c.addLeave(id, { date: TOMORROW })],
    ['remove a leave day', (c, id) => c.removeLeave(id, TOMORROW)],
    ['add a holiday', (c) => c.addHoliday({ date: TOMORROW, name: 'Fake Day' })],
    ['remove a holiday', (c) => c.removeHoliday(TOMORROW)],
  ];
  for (const [title, call] of adminOnly) {
    test(`a patient cannot ${title}`, { tag: '@regression' }, async ({ patient, doctor }) => {
      await expectError(await call(patient, doctor.id), 403, 'FORBIDDEN');
    });

    test(`signing in is needed to ${title}`, { tag: '@regression' }, async ({ newClient, doctor }) => {
      await expectError(await call(await newClient(), doctor.id), 401, 'UNAUTHENTICATED');
    });
  }
});
