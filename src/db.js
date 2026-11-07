const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// Runs fn inside a transaction that also blocks other writers, so the checks fn makes
// still hold when it writes. Any error rolls everything back.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Each entry upgrades the database by one version, recorded in PRAGMA user_version.
// Never edit a migration that has shipped: add a new one to the end instead.
// Timestamps are Bangalore-local "YYYY-MM-DDTHH:MM" strings, like appointment dates and times.
const MIGRATIONS = [
  // 1: the original schema. IF NOT EXISTS lets databases made before migrations existed adopt it.
  `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('patient', 'admin'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL,
      working_days TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id),
      patient_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled'))
    );
    -- The database itself refuses two active bookings for one slot.
    CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot
      ON appointments (doctor_id, date, time) WHERE status = 'booked';
  `,
  // 2: groundwork for doctor management, patient profiles and the appointment history.
  `
    ALTER TABLE users ADD COLUMN phone TEXT;
    ALTER TABLE doctors ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
    ALTER TABLE appointments ADD COLUMN created_at TEXT;
    ALTER TABLE appointments ADD COLUMN cancelled_at TEXT;
    ALTER TABLE appointments ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE appointments ADD COLUMN cancel_reason TEXT;

    CREATE TABLE doctor_leave (
      id INTEGER PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id),
      date TEXT NOT NULL,
      reason TEXT,
      UNIQUE (doctor_id, date)
    );
    CREATE TABLE clinic_holidays (
      date TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE INDEX appointments_by_patient ON appointments (patient_id, date);
    CREATE INDEX appointments_by_doctor ON appointments (doctor_id, date);
    -- The database itself refuses a patient two active bookings at the same time.
    CREATE UNIQUE INDEX one_booking_per_patient_slot
      ON appointments (patient_id, date, time) WHERE status = 'booked';
  `,
  // 3: sessions that expire and store only a hash of their token, and failed sign-ins for
  // the sign-in limit. Old sessions have neither, so everyone signs in again once.
  `
    DROP TABLE sessions;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX sessions_by_user ON sessions (user_id);

    CREATE TABLE login_attempts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      ip TEXT NOT NULL,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX login_attempts_by_email ON login_attempts (email, attempted_at);
    CREATE INDEX login_attempts_by_ip ON login_attempts (ip, attempted_at);
  `,
  // 4: completed and no-show statuses, who recorded them and when, and links between a
  // rescheduled appointment and its replacement. SQLite can't change a CHECK constraint,
  // so the table is rebuilt with every row and index copied across.
  `
    CREATE TABLE appointments_v4 (
      id INTEGER PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id),
      patient_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled', 'completed', 'no-show')),
      created_at TEXT,
      cancelled_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancel_reason TEXT,
      rescheduled_from INTEGER REFERENCES appointments(id),
      outcome_at TEXT,
      outcome_by INTEGER REFERENCES users(id)
    );
    INSERT INTO appointments_v4
      (id, doctor_id, patient_id, date, time, reason, status, created_at, cancelled_at, cancelled_by, cancel_reason)
      SELECT id, doctor_id, patient_id, date, time, reason, status, created_at, cancelled_at, cancelled_by, cancel_reason
      FROM appointments;
    DROP TABLE appointments;
    ALTER TABLE appointments_v4 RENAME TO appointments;

    CREATE UNIQUE INDEX one_booking_per_slot
      ON appointments (doctor_id, date, time) WHERE status = 'booked';
    CREATE UNIQUE INDEX one_booking_per_patient_slot
      ON appointments (patient_id, date, time) WHERE status = 'booked';
    CREATE INDEX appointments_by_patient ON appointments (patient_id, date);
    CREATE INDEX appointments_by_doctor ON appointments (doctor_id, date);
    -- An appointment can be moved once; after that its replacement is the one to move.
    CREATE UNIQUE INDEX one_reschedule_per_appointment
      ON appointments (rescheduled_from) WHERE rescheduled_from IS NOT NULL;
  `,
];
const LATEST_VERSION = MIGRATIONS.length;

const schemaVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

// Brings the database up to the latest version (or to target, which tests use to build
// a database as an older release left it). Each step runs in its own transaction,
// so a failed step leaves the database exactly as the previous version left it.
function migrate(db, target = LATEST_VERSION) {
  const current = schemaVersion(db);
  if (current > LATEST_VERSION) {
    throw new Error(`The database is at version ${current}, but this app only knows up to version ${LATEST_VERSION}.`);
  }
  for (let version = current + 1; version <= target; version += 1) {
    try {
      transaction(db, () => {
        db.exec(MIGRATIONS[version - 1]);
        db.exec(`PRAGMA user_version = ${version}`);
      });
    } catch (err) {
      throw new Error(`Database migration ${version} failed, so the database was left at version ${version - 1}: ${err.message}`);
    }
  }
}

function createDb(dbPath, bugs) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON'); // has no effect inside a transaction, so set it first
  migrate(db);

  if (bugs.has('double-booking')) {
    if (dbPath !== ':memory:') throw new Error('Bug mode only runs on an in-memory database.');
    db.exec('DROP INDEX one_booking_per_slot; DROP INDEX one_booking_per_patient_slot;');
  }

  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) seed(db);
  return db;
}

function seed(db) {
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  addUser.run('Clinic Admin', 'admin@clinic.test', hashPassword('Admin@12345'), 'admin');
  addUser.run('Demo Patient', 'patient@clinic.test', hashPassword('Patient@123'), 'patient');

  const addDoctor = db.prepare('INSERT INTO doctors (name, specialty, working_days) VALUES (?, ?, ?)');
  addDoctor.run('Dr. Asha Rao', 'General Medicine', '1,2,3,4,5');
  addDoctor.run('Dr. Vikram Nair', 'Dermatology', '1,3,5');
  addDoctor.run('Dr. Meera Iyer', 'Pediatrics', '2,4,6');
}

module.exports = {
  createDb, migrate, transaction, schemaVersion, LATEST_VERSION, hashPassword, verifyPassword,
};
