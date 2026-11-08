const { test, expect } = require('@playwright/test');
const { createDb, transaction } = require('../../src/db');
const { bookingConflict } = require('../../src/app');
const { startLocalApp } = require('../support/local-app');
const { FIXED_NOW, TOMORROW } = require('../support/clinic-time');

// Same fixed clock as the test server.
process.env.FIXED_NOW = FIXED_NOW;

const NO_BUGS = new Set();
const PATIENT_ID = 2; // the seeded demo patient
const DOCTOR_ID = 1; // the seeded General Medicine doctor, Monday to Friday

function addAppointment(db, { doctorId = DOCTOR_ID, patientId = PATIENT_ID, time = '10:00', status = 'booked' } = {}) {
  return db.prepare(
    "INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status) VALUES (?, ?, ?, ?, 'Check-up', ?)"
  ).run(doctorId, patientId, TOMORROW, time, status);
}

function addDoctor(db) {
  return Number(db.prepare("INSERT INTO doctors (name, specialty, working_days) VALUES ('Dr. Extra', 'ENT', '1,2,3,4,5')")
    .run().lastInsertRowid);
}

test.describe('Booking guards in the database', () => {
  test('refuses two active bookings for one slot', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('B', 'b@clinic.test', 'x', 'patient')").run();
    addAppointment(db);

    expect(() => addAppointment(db, { patientId: 3 })).toThrow('UNIQUE constraint failed: appointments.doctor_id');
    db.close();
  });

  test('refuses a patient two active bookings at the same time', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    addAppointment(db);

    expect(() => addAppointment(db, { doctorId: addDoctor(db) })).toThrow('UNIQUE constraint failed: appointments.patient_id');
    db.close();
  });

  test('cancelled bookings do not block the slot', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    addAppointment(db, { status: 'cancelled' });

    expect(() => addAppointment(db)).not.toThrow();
    db.close();
  });

  test('the API answers each guard with the matching error', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    addAppointment(db);
    const errorFrom = (insert) => { try { insert(); } catch (err) { return bookingConflict(err); } return null; };

    const slotTaken = errorFrom(() => addAppointment(db, { patientId: 1 }));
    const patientBusy = errorFrom(() => addAppointment(db, { doctorId: addDoctor(db) }));

    expect(slotTaken).toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
    expect(patientBusy).toMatchObject({ status: 409, code: 'PATIENT_BUSY' });
    expect(bookingConflict(new Error('UNIQUE constraint failed: users.email'))).toBeNull();
    db.close();
  });

  test('bug mode removes both guards, and only in memory', { tag: '@regression' }, async ({}, testInfo) => {
    const db = createDb(':memory:', new Set(['double-booking']));
    addAppointment(db);

    expect(() => addAppointment(db)).not.toThrow();
    expect(() => createDb(testInfo.outputPath('clinic.db'), new Set(['double-booking'])))
      .toThrow('Bug mode only runs on an in-memory database.');
    db.close();
  });
});

test.describe('Doctors, leave and holidays', () => {
  test('a doctor is active unless set otherwise, and active is only 0 or 1', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    const id = addDoctor(db);

    expect(db.prepare('SELECT active FROM doctors WHERE id = ?').get(id).active).toBe(1);
    expect(() => db.prepare('UPDATE doctors SET active = 2 WHERE id = ?').run(id)).toThrow('CHECK constraint failed');
    db.close();
  });

  test('leave is one entry per doctor per day, for a real doctor', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    const addLeave = db.prepare('INSERT INTO doctor_leave (doctor_id, date, reason) VALUES (?, ?, ?)');
    addLeave.run(DOCTOR_ID, TOMORROW, 'Conference');

    expect(() => addLeave.run(DOCTOR_ID, TOMORROW, 'Again')).toThrow('UNIQUE constraint failed');
    expect(() => addLeave.run(999, TOMORROW, null)).toThrow('FOREIGN KEY constraint failed');
    db.close();
  });

  test('a clinic holiday is one entry per day and needs a name', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    const addHoliday = db.prepare('INSERT INTO clinic_holidays (date, name) VALUES (?, ?)');
    addHoliday.run('2030-01-26', 'Republic Day');

    expect(() => addHoliday.run('2030-01-26', 'Again')).toThrow('UNIQUE constraint failed');
    expect(() => addHoliday.run('2030-01-27', null)).toThrow('NOT NULL constraint failed');
    db.close();
  });
});

test.describe('Appointment statuses and rescheduling', () => {
  test('allows booked, cancelled, completed and no-show, and nothing else', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    const { lastInsertRowid: id } = addAppointment(db);
    const setStatus = db.prepare('UPDATE appointments SET status = ? WHERE id = ?');

    for (const status of ['cancelled', 'completed', 'no-show', 'booked']) expect(() => setStatus.run(status, id)).not.toThrow();
    expect(() => setStatus.run('rescheduled', id)).toThrow('CHECK constraint failed');
    db.close();
  });

  test('an appointment can be replaced by only one other, and it must exist', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);
    const { lastInsertRowid: original } = addAppointment(db, { status: 'cancelled' });
    const replace = db.prepare(`INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status, rescheduled_from)
      VALUES (1, 2, ?, ?, 'Check-up', 'booked', ?)`);
    replace.run(TOMORROW, '11:00', original);

    expect(() => replace.run(TOMORROW, '12:00', original)).toThrow('UNIQUE constraint failed: appointments.rescheduled_from');
    expect(() => replace.run(TOMORROW, '14:00', 999)).toThrow('FOREIGN KEY constraint failed');
    db.close();
  });
});

test.describe('Transactions', () => {
  test('keeps the changes and returns the result when nothing fails', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);

    const id = transaction(db, () => addAppointment(db).lastInsertRowid);

    expect(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE id = ?').get(id).n).toBe(1);
    db.close();
  });

  test('undoes every change when something fails', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);

    expect(() => transaction(db, () => {
      addAppointment(db);
      throw new Error('stop');
    })).toThrow('stop');

    expect(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n).toBe(0);
    expect(() => transaction(db, () => addAppointment(db))).not.toThrow(); // no transaction left open
    db.close();
  });
});

test.describe('Through the running app', () => {
  test('records when an appointment was booked, in clinic time', { tag: '@regression' }, async ({ request }) => {
    const app = await startLocalApp();
    const { db } = app;
    try {
      expect((await request.post(`${app.url}/api/login`, {
        data: { email: 'patient@clinic.test', password: 'Patient@123' },
      })).status()).toBe(200);

      const response = await request.post(`${app.url}/api/appointments`, {
        data: { doctorId: DOCTOR_ID, date: TOMORROW, time: '10:00', reason: 'Fever' },
      });

      expect(response.status()).toBe(201);
      const { id } = await response.json();
      expect(db.prepare('SELECT created_at FROM appointments WHERE id = ?').get(id).created_at).toBe(FIXED_NOW);
    } finally {
      await app.close();
    }
  });

  test('the health check reports a database that cannot be reached', { tag: '@regression' }, async ({ request }) => {
    const app = await startLocalApp();
    const { db } = app;
    try {
      expect(await (await request.get(`${app.url}/api/health`)).json()).toEqual({ status: 'ok', database: 'ok' });

      db.close();
      const response = await request.get(`${app.url}/api/health`);

      expect(response.status()).toBe(503);
      expect(await response.json()).toEqual({ status: 'error', database: 'unavailable' });
    } finally {
      await app.close();
    }
  });
});
