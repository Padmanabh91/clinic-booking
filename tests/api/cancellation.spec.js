const { test, expect } = require('../support/fixtures');
const { TODAY, TOMORROW } = require('../support/clinic-time');

const book = async (client, doctor, details) => (await client.book(doctor.id, details)).json();

test.describe('Cancelling an appointment', () => {
  test('cancels your own appointment', { tag: '@smoke' }, async ({ patient, doctor }) => {
    const appointment = await book(patient, doctor);

    const response = await patient.cancel(appointment.id);

    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('cancelled');
  });

  test("cannot cancel another patient's appointment", { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();
    const appointment = await book(patient, doctor);

    const response = await other.cancel(appointment.id);

    expect(response.status()).toBe(403);
    const [stillBooked] = await (await patient.appointments()).json();
    expect(stillBooked.status).toBe('booked');
  });

  test('cannot cancel twice', { tag: '@regression' }, async ({ patient, doctor }) => {
    const appointment = await book(patient, doctor);
    await patient.cancel(appointment.id);

    const response = await patient.cancel(appointment.id);

    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('ALREADY_CANCELLED');
  });

  test('returns 404 for an unknown appointment', { tag: '@regression' }, async ({ patient }) => {
    expect((await patient.cancel(99999999)).status()).toBe(404);
  });
});

test.describe('2-hour cancellation rule (the clock is fixed at 10:00 IST)', () => {
  test('allows cancelling exactly 2 hours before', { tag: '@smoke' }, async ({ patient, doctor }) => {
    const appointment = await book(patient, doctor, { date: TODAY, time: '12:00' });

    expect((await patient.cancel(appointment.id)).status()).toBe(200);
  });

  test('refuses cancelling less than 2 hours before', { tag: '@smoke' }, async ({ patient, doctor }) => {
    const appointment = await book(patient, doctor, { date: TODAY, time: '11:30' });

    const response = await patient.cancel(appointment.id);

    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('CANCEL_TOO_LATE');
  });

  test('lets an admin cancel inside the 2-hour window', { tag: '@regression' }, async ({ patient, admin, doctor }) => {
    const appointment = await book(patient, doctor, { date: TODAY, time: '11:30' });

    expect((await admin.cancel(appointment.id)).status()).toBe(200);
  });
});

test.describe('Who can see and do what', () => {
  test('a patient sees only their own appointments', { tag: '@regression' }, async ({ patient, newPatient, doctor }) => {
    const other = await newPatient();
    await book(patient, doctor, { date: TOMORROW, time: '10:00' });
    await book(other, doctor, { date: TOMORROW, time: '10:30' });

    const appointments = await (await patient.appointments()).json();

    expect(appointments).toHaveLength(1);
    expect(appointments[0].patientId).toBe(patient.user.id);
  });

  test("an admin sees every patient's appointments", { tag: '@regression' }, async ({ patient, newPatient, admin, doctor }) => {
    const other = await newPatient();
    await book(patient, doctor, { date: TOMORROW, time: '10:00' });
    await book(other, doctor, { date: TOMORROW, time: '10:30' });

    const appointments = await (await admin.appointments()).json();
    const forThisDoctor = appointments.filter((a) => a.doctorId === doctor.id);

    expect(forThisDoctor.map((a) => a.patientId).sort()).toEqual([patient.user.id, other.user.id].sort());
  });

  test('a patient cannot add a doctor', { tag: '@regression' }, async ({ patient }) => {
    const response = await patient.createDoctor({ name: 'Dr. Fake', specialty: 'None' });

    expect(response.status()).toBe(403);
  });
});
