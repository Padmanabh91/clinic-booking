const { DatabaseSync } = require('node:sqlite');
const { test, expect } = require('@playwright/test');
const { createDb, migrate, schemaVersion, LATEST_VERSION } = require('../../src/db');

const NO_BUGS = new Set();

// The schema exactly as the app created it before migrations existed (user_version 0).
const PRE_MIGRATION_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('patient', 'admin')));
  CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
  CREATE TABLE doctors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, specialty TEXT NOT NULL, working_days TEXT NOT NULL);
  CREATE TABLE appointments (id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES doctors(id),
    patient_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL, time TEXT NOT NULL, reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')));
  CREATE UNIQUE INDEX one_booking_per_slot ON appointments (doctor_id, date, time) WHERE status = 'booked';
  INSERT INTO users VALUES (1, 'Old Admin', 'old-admin@clinic.test', 'salt:hash', 'admin');
  INSERT INTO users VALUES (2, 'Old Patient', 'old-patient@clinic.test', 'salt:hash', 'patient');
  INSERT INTO sessions VALUES ('old-token', 2);
  INSERT INTO doctors VALUES (1, 'Dr. Old', 'General Medicine', '1,2,3,4,5');
  INSERT INTO doctors VALUES (2, 'Dr. Older', 'Dermatology', '1,3,5');
  INSERT INTO appointments VALUES (1, 1, 2, '2030-01-08', '10:00', 'Fever', 'booked');
  INSERT INTO appointments VALUES (2, 1, 2, '2030-01-08', '11:00', 'Cough', 'cancelled');
`;

function makePreMigrationDb(file, extraSql = '') {
  const db = new DatabaseSync(file);
  db.exec(PRE_MIGRATION_SCHEMA + extraSql);
  db.close();
}

const names = (db, type) => db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
  .all(type).map((row) => row.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test.describe('Creating a new database', () => {
  test('starts at the latest version with every table and index', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);

    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(names(db, 'table')).toEqual(
      ['appointments', 'clinic_holidays', 'doctor_leave', 'doctors', 'login_attempts', 'sessions', 'users']);
    expect(names(db, 'index')).toEqual(expect.arrayContaining([
      'appointments_by_doctor', 'appointments_by_patient', 'one_booking_per_patient_slot', 'one_booking_per_slot',
      'sessions_by_user', 'login_attempts_by_email', 'login_attempts_by_ip',
    ]));
    expect(columns(db, 'appointments')).toEqual(expect.arrayContaining(
      ['created_at', 'cancelled_at', 'cancelled_by', 'cancel_reason']));
    expect(columns(db, 'users')).toContain('phone');
    expect(columns(db, 'sessions')).toEqual(['token_hash', 'user_id', 'created_at', 'last_seen_at']);
    expect(columns(db, 'login_attempts')).toEqual(['id', 'email', 'ip', 'attempted_at']);
    db.close();
  });

  test('adds the demo accounts and doctors, all active', { tag: '@regression' }, () => {
    const db = createDb(':memory:', NO_BUGS);

    expect(db.prepare('SELECT email FROM users ORDER BY id').all().map((u) => u.email))
      .toEqual(['admin@clinic.test', 'patient@clinic.test']);
    expect(db.prepare('SELECT name, specialty, working_days, active FROM doctors ORDER BY id').all().map((d) => ({ ...d }))).toEqual([
      { name: 'Dr. Padmanabh', specialty: 'General Medicine', working_days: '1,2,3,4,5', active: 1 },
      { name: 'Dr. Padmanabh', specialty: 'Dermatology', working_days: '1,3,5', active: 1 },
      { name: 'Dr. Padmanabh', specialty: 'Pediatrics', working_days: '2,4,6', active: 1 },
    ]);
    db.close();
  });
});

test.describe('Upgrading an existing database', () => {
  test('a database made before migrations keeps its users, doctors and appointments', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    makePreMigrationDb(file);

    const db = createDb(file, NO_BUGS);

    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(2); // demo data is not added on top
    // Old sessions stored the raw token and never expired, so everyone signs in again once.
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
    expect(db.prepare('SELECT name, active FROM doctors ORDER BY id').all().map((d) => ({ ...d }))).toEqual([
      { name: 'Dr. Old', active: 1 },
      { name: 'Dr. Older', active: 1 },
    ]);
    expect(db.prepare('SELECT id, reason, status, created_at FROM appointments ORDER BY id').all().map((a) => ({ ...a })))
      .toEqual([
        { id: 1, reason: 'Fever', status: 'booked', created_at: null },
        { id: 2, reason: 'Cough', status: 'cancelled', created_at: null },
      ]);
    db.close();
  });

  test('opening an up-to-date database again changes nothing', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    createDb(file, NO_BUGS).close();

    const db = createDb(file, NO_BUGS);

    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM doctors').get().n).toBe(3);
    db.close();
  });

  test('a database from a newer version of the app is refused', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    newer.close();

    expect(() => createDb(file, NO_BUGS)).toThrow(`The database is at version ${LATEST_VERSION + 1}`);
  });

  test('a failed upgrade is rolled back and leaves the data untouched', { tag: '@regression' }, async ({}, testInfo) => {
    // A patient with two bookings at the same time can't get the new one-booking-per-patient index.
    const file = testInfo.outputPath('clinic.db');
    makePreMigrationDb(file, "INSERT INTO appointments VALUES (3, 2, 2, '2030-01-08', '10:00', 'Rash', 'booked');");

    expect(() => createDb(file, NO_BUGS)).toThrow('Database migration 2 failed, so the database was left at version 1');

    const db = new DatabaseSync(file);
    expect(schemaVersion(db)).toBe(1);
    expect(columns(db, 'users')).not.toContain('phone');
    expect(names(db, 'table')).not.toContain('doctor_leave');
    expect(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n).toBe(3);
    db.close();
  });
});

test.describe('Upgrading to version 4 (appointment statuses rebuilt)', () => {
  // A database as release 3 left it, with a booked and a clinic-cancelled appointment.
  function makeVersion3Db(file) {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, 3);
    db.exec(`
      INSERT INTO users (id, name, email, password_hash, role) VALUES
        (1, 'Admin', 'a@clinic.test', 'x', 'admin'), (2, 'Pat', 'p@clinic.test', 'x', 'patient');
      INSERT INTO doctors (id, name, specialty, working_days) VALUES (1, 'Dr. One', 'ENT', '1,2,3,4,5');
      INSERT INTO appointments (id, doctor_id, patient_id, date, time, reason, status, created_at,
        cancelled_at, cancelled_by, cancel_reason) VALUES
        (1, 1, 2, '2030-01-08', '10:00', 'Fever', 'booked', '2030-01-07T09:00', NULL, NULL, NULL),
        (2, 1, 2, '2030-01-08', '11:00', 'Cough', 'cancelled', '2030-01-07T09:05', '2030-01-07T09:30', 1, 'Dr. One is on leave on this day.');
    `);
    db.close();
  }

  test('keeps every appointment and its cancellation details', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    makeVersion3Db(file);

    const db = createDb(file, NO_BUGS);

    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT * FROM appointments ORDER BY id').all().map((a) => ({ ...a }))).toEqual([
      { id: 1, doctor_id: 1, patient_id: 2, date: '2030-01-08', time: '10:00', reason: 'Fever', status: 'booked',
        created_at: '2030-01-07T09:00', cancelled_at: null, cancelled_by: null, cancel_reason: null,
        rescheduled_from: null, outcome_at: null, outcome_by: null },
      { id: 2, doctor_id: 1, patient_id: 2, date: '2030-01-08', time: '11:00', reason: 'Cough', status: 'cancelled',
        created_at: '2030-01-07T09:05', cancelled_at: '2030-01-07T09:30', cancelled_by: 1,
        cancel_reason: 'Dr. One is on leave on this day.', rescheduled_from: null, outcome_at: null, outcome_by: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('keeps the booking guards, and new ids carry on after the old ones', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    makeVersion3Db(file);
    const db = createDb(file, NO_BUGS);
    const insert = db.prepare(`INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status)
      VALUES (1, ?, '2030-01-08', '10:00', 'x', 'booked')`);

    expect(() => insert.run(1)).toThrow('UNIQUE constraint failed: appointments.doctor_id'); // another patient, same slot
    expect(() => insert.run(2)).toThrow('UNIQUE constraint failed: appointments.patient_id'); // same patient, same time
    expect(names(db, 'index')).toEqual(expect.arrayContaining([
      'appointments_by_doctor', 'appointments_by_patient', 'one_booking_per_patient_slot', 'one_booking_per_slot',
      'one_reschedule_per_appointment',
    ]));
    const next = db.prepare(`INSERT INTO appointments (doctor_id, patient_id, date, time, reason, status)
      VALUES (1, 2, '2030-01-09', '10:00', 'x', 'booked')`).run();
    expect(Number(next.lastInsertRowid)).toBe(3);
    db.close();
  });
});

test.describe('Upgrading to version 5 (the demo doctors renamed)', () => {
  test('renames only untouched demo doctors, and keeps their specialty, days and appointments', { tag: '@regression' }, async ({}, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    const before = new DatabaseSync(file);
    before.exec('PRAGMA foreign_keys = ON');
    migrate(before, 4);
    before.exec(`
      INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'Pat', 'p@clinic.test', 'x', 'patient');
      INSERT INTO doctors (id, name, specialty, working_days) VALUES
        (1, 'Dr. Asha Rao', 'General Medicine', '1,2,3,4,5'),
        (2, 'Dr. Vikram Nair', 'Dermatology', '1,3'),
        (3, 'Dr. Meera Iyer', 'Cardiology', '2,4,6'),
        (4, 'Dr. Asha Rao', 'General Medicine', '1');
      INSERT INTO appointments (id, doctor_id, patient_id, date, time, reason, status)
        VALUES (1, 1, 1, '2030-01-08', '10:00', 'Fever', 'booked');
    `);
    before.close();

    const db = createDb(file, NO_BUGS);

    expect(schemaVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT id, name, specialty, working_days FROM doctors ORDER BY id').all().map((d) => ({ ...d }))).toEqual([
      { id: 1, name: 'Dr. Padmanabh', specialty: 'General Medicine', working_days: '1,2,3,4,5' },
      { id: 2, name: 'Dr. Padmanabh', specialty: 'Dermatology', working_days: '1,3' },
      { id: 3, name: 'Dr. Meera Iyer', specialty: 'Cardiology', working_days: '2,4,6' }, // an admin changed its specialty
      { id: 4, name: 'Dr. Asha Rao', specialty: 'General Medicine', working_days: '1' }, // not a demo doctor
    ]);
    expect(db.prepare('SELECT doctor_id, reason, status FROM appointments').all().map((a) => ({ ...a })))
      .toEqual([{ doctor_id: 1, reason: 'Fever', status: 'booked' }]);
    db.close();
  });
});
