const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const rules = require('./rules');
const security = require('./security');
const { hashPassword, verifyPassword, transaction } = require('./db');

class ApiError extends Error {
  // details are extra fields sent inside the error, such as the appointments in the way.
  constructor(status, code, message, { headers = {}, details = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.details = details;
  }
}

const COOKIE = 'sid';
// Checked when the email is unknown, so a wrong email takes as long as a wrong password
// and response times don't reveal which emails are registered.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < security.PASSWORD_MIN) {
    throw new ApiError(400, 'INVALID_INPUT', `Password must be at least ${security.PASSWORD_MIN} characters.`);
  }
  if (password.length > security.PASSWORD_MAX) {
    throw new ApiError(400, 'INVALID_INPUT', `Password must be at most ${security.PASSWORD_MAX} characters.`);
  }
}
const isText = (value, min, max) =>
  typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;

// The database's unique indexes are the final guard against two simultaneous bookings.
// Turns their errors into the same answers the checks before them give.
function bookingConflict(err) {
  const message = String(err?.message);
  if (message.includes('UNIQUE constraint failed: appointments.doctor_id')) {
    return new ApiError(409, 'SLOT_TAKEN', 'That slot has just been taken.');
  }
  if (message.includes('UNIQUE constraint failed: appointments.patient_id')) {
    return new ApiError(409, 'PATIENT_BUSY', 'You already have an appointment at that time.');
  }
  return null;
}

// Options: trustProxy is Express's "trust proxy" setting, needed behind a hosting proxy so
// the sign-in limit sees each visitor's real address. secureCookies sends cookies over HTTPS only.
function createApp(db, bugs, { trustProxy = false, secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(security.securityHeaders({ secureCookies }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });
  const publicDoctor = ({ id, name, specialty, working_days, active }) => ({
    id, name, specialty, workingDays: working_days.split(',').map(Number), active: active === 1,
  });

  function startSession(res, userId) {
    const token = security.newToken();
    const now = rules.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(security.hashToken(token), userId, now, now);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookies });
  }

  function sessionToken(req) {
    const pair = (req.headers.cookie || '').split(';').map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    return pair ? pair.slice(COOKIE.length + 1) : null;
  }

  function requireUser(req, res, next) {
    const token = sessionToken(req);
    const tokenHash = token && security.hashToken(token);
    const session = tokenHash && db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    const now = rules.now();
    if (session && security.sessionExpired(session, now) && !bugs.has('no-session-expiry')) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      res.clearCookie(COOKIE);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in first.');
    }
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in first.');
    if (session.last_seen_at !== now) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash);
    }
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    req.sessionHash = tokenHash;
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Admins only.');
    next();
  }

  function findDoctor(id) {
    const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(Number(id));
    if (!doctor) throw new ApiError(404, 'NOT_FOUND', 'Doctor not found.');
    return doctor;
  }

  const worksOn = (doctor, date) =>
    doctor.working_days.split(',').map(Number).includes(rules.dayOfWeek(date));

  const holidayOn = (date) => db.prepare('SELECT * FROM clinic_holidays WHERE date = ?').get(date);
  const leaveOn = (doctor, date) =>
    db.prepare('SELECT * FROM doctor_leave WHERE doctor_id = ? AND date = ?').get(doctor.id, date);

  // Why a doctor can't be booked on a date, or null if they can. Slots and booking both use it.
  // Bug mode's closed-day-booking ignores holidays and leave when booking, but not in the slots.
  function closedDay(doctor, date, { ignoreHolidaysAndLeave = false } = {}) {
    if (!doctor.active) {
      return { code: 'DOCTOR_UNAVAILABLE', message: `${doctor.name} is not taking appointments.` };
    }
    if (!worksOn(doctor, date)) {
      return { code: 'NOT_WORKING_DAY', message: 'The doctor does not work on this day.' };
    }
    if (ignoreHolidaysAndLeave) return null;
    const holiday = holidayOn(date);
    if (holiday) {
      return { code: 'CLINIC_CLOSED', message: `The clinic is closed on this day for ${holiday.name}.` };
    }
    if (leaveOn(doctor, date)) {
      return { code: 'DOCTOR_ON_LEAVE', message: `${doctor.name} is on leave on this day.` };
    }
    return null;
  }

  // cancelledBy says whether the patient or the clinic cancelled (null for cancellations made
  // before this was recorded). A rescheduled appointment links to the one that replaced it.
  const APPOINTMENT_SELECT = `
    SELECT a.id, a.date, a.time, a.reason, a.status, a.patient_id AS patientId,
           d.id AS doctorId, d.name AS doctorName, d.specialty, u.name AS patientName,
           a.cancel_reason AS cancelReason, a.cancelled_at AS cancelledAt,
           CASE WHEN a.cancelled_by IS NULL THEN NULL WHEN c.role = 'admin' THEN 'clinic' ELSE 'patient' END AS cancelledBy,
           a.rescheduled_from AS rescheduledFromId,
           (SELECT n.id FROM appointments n WHERE n.rescheduled_from = a.id) AS rescheduledToId
    FROM appointments a
    JOIN doctors d ON d.id = a.doctor_id
    JOIN users u ON u.id = a.patient_id
    LEFT JOIN users c ON c.id = a.cancelled_by`;
  const findAppointment = (id) => db.prepare(`${APPOINTMENT_SELECT} WHERE a.id = ?`).get(id);

  // Booked appointments that match the filter and haven't started yet.
  function upcomingAppointments(where, ...params) {
    return db.prepare(`${APPOINTMENT_SELECT} WHERE a.status = 'booked' AND ${where} ORDER BY a.date, a.time, a.id`)
      .all(...params).filter((a) => rules.minutesUntil(a.date, a.time) > 0);
  }

  // Schedule changes never cancel appointments silently. Unless the admin confirmed with
  // cancelAffected, a change with booked appointments in the way is refused and lists them.
  // Once confirmed, they are cancelled with who, when and why, and returned.
  function cancelForScheduleChange(affected, { confirmed, admin, reasonFor }) {
    if (affected.length === 0) return [];
    if (!confirmed) {
      const n = affected.length;
      throw new ApiError(409, 'HAS_APPOINTMENTS',
        `This change affects ${n} booked appointment${n === 1 ? '' : 's'}. Confirm to cancel ${n === 1 ? 'it' : 'them'}.`,
        { details: { appointments: affected } });
    }
    const cancel = db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
      cancel_reason = ? WHERE id = ?`);
    const now = rules.now();
    for (const appointment of affected) cancel.run(now, admin.id, reasonFor(appointment), appointment.id);
    return affected.map((a) => findAppointment(a.id));
  }

  // A schedule date must be a real date, today or later.
  function checkScheduleDate(date) {
    if (!rules.isValidDate(date)) throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid date.');
    if (date < rules.today()) throw new ApiError(422, 'DATE_IN_PAST', 'Choose today or a later date.');
  }

  const validWorkingDays = (days) => Array.isArray(days) && days.length > 0
    && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);

  // ----- Accounts -----
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return res.status(503).json({ status: 'error', database: 'unavailable' });
    }
    res.json({ status: 'ok', database: 'ok' });
  });

  app.post('/api/register', (req, res) => {
    const { name, email, password, role } = req.body ?? {};
    if (!isText(name, 2, 80)) throw new ApiError(400, 'INVALID_INPUT', 'Name must be 2-80 characters.');
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid email address.');
    }
    checkNewPassword(password);
    const normalized = email.toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
      throw new ApiError(409, 'EMAIL_TAKEN', 'That email is already registered.');
    }
    const finalRole = bugs.has('role-escalation') && role === 'admin' ? 'admin' : 'patient';
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), normalized, hashPassword(password), finalRole);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    startSession(res, user.id);
    res.status(201).json(publicUser(user));
  });

  app.post('/api/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const attempt = { email: typeof email === 'string' ? email.toLowerCase() : '', ip: req.ip };
    const now = rules.now();

    const waitMinutes = security.loginWaitMinutes(db, attempt, now);
    if (waitMinutes > 0 && !bugs.has('no-login-limit')) {
      const unit = waitMinutes === 1 ? 'minute' : 'minutes';
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS',
        `Too many failed sign-in attempts. Try again in ${waitMinutes} ${unit}.`,
        { headers: { 'Retry-After': String(waitMinutes * 60) } });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(attempt.email);
    const passwordMatches = verifyPassword(
      typeof password === 'string' ? password : '', user ? user.password_hash : DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      security.recordLoginFailure(db, attempt, now);
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
    }
    security.clearLoginFailures(db, attempt.email);
    security.removeExpiredSessions(db, now);
    startSession(res, user.id);
    res.json(publicUser(user));
  });

  app.post('/api/logout', requireUser, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    res.clearCookie(COOKIE);
    res.status(204).end();
  });

  app.get('/api/me', requireUser, (req, res) => res.json(publicUser(req.user)));

  // Changing the password signs out every other session, in case someone else has one.
  app.post('/api/me/password', requireUser, (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, req.user.password_hash)) {
      throw new ApiError(400, 'WRONG_PASSWORD', 'Your current password is incorrect.');
    }
    checkNewPassword(newPassword);
    if (newPassword === currentPassword) {
      throw new ApiError(400, 'INVALID_INPUT', 'Choose a new password that is different from your current one.');
    }
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, req.sessionHash);
    });
    res.status(204).end();
  });

  app.get('/api/config', (req, res) => {
    res.json({
      city: rules.CLINIC.city,
      timeZone: rules.CLINIC.timeZone,
      timeZoneLabel: rules.CLINIC.timeZoneLabel,
      today: rules.today(),
      now: rules.now(),
      lastBookableDate: rules.lastBookableDate(),
    });
  });

  // ----- Doctors and slots -----
  // Patients only see doctors taking appointments. Admins see every doctor.
  app.get('/api/doctors', (req, res) => {
    res.json(db.prepare('SELECT * FROM doctors WHERE active = 1 ORDER BY name, specialty, id').all().map(publicDoctor));
  });

  app.get('/api/admin/doctors', requireUser, requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM doctors ORDER BY name, specialty, id').all().map(publicDoctor));
  });

  app.post('/api/doctors', requireUser, requireAdmin, (req, res) => {
    const { name, specialty, workingDays = [1, 2, 3, 4, 5] } = req.body ?? {};
    if (!isText(name, 2, 80) || !isText(specialty, 2, 80) || !validWorkingDays(workingDays)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Name, specialty and working days are required.');
    }
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO doctors (name, specialty, working_days) VALUES (?, ?, ?)'
    ).run(name.trim(), specialty.trim(), workingDays.join(','));
    res.status(201).json(publicDoctor(findDoctor(lastInsertRowid)));
  });

  // Edits a doctor. Fields left out stay as they are. Deactivating, or removing working days,
  // affects upcoming appointments, which are handled as cancelForScheduleChange describes.
  app.patch('/api/doctors/:id', requireUser, requireAdmin, (req, res) => {
    const doctor = findDoctor(req.params.id);
    const { name, specialty, workingDays, active, cancelAffected } = req.body ?? {};
    if ([name, specialty, workingDays, active].every((value) => value === undefined)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Send at least one of name, specialty, workingDays or active.');
    }
    if (name !== undefined && !isText(name, 2, 80)) throw new ApiError(400, 'INVALID_INPUT', 'Name must be 2-80 characters.');
    if (specialty !== undefined && !isText(specialty, 2, 80)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Specialty must be 2-80 characters.');
    }
    if (workingDays !== undefined && !validWorkingDays(workingDays)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Working days must be a list of days from 0 (Sunday) to 6 (Saturday).');
    }
    if (active !== undefined && typeof active !== 'boolean') {
      throw new ApiError(400, 'INVALID_INPUT', 'Active must be true or false.');
    }

    const updated = {
      name: name?.trim() ?? doctor.name,
      specialty: specialty?.trim() ?? doctor.specialty,
      days: workingDays ?? doctor.working_days.split(',').map(Number),
      active: active ?? doctor.active === 1,
    };
    const cancelled = transaction(db, () => {
      const affected = upcomingAppointments('a.doctor_id = ?', doctor.id)
        .filter((a) => !updated.active || !updated.days.includes(rules.dayOfWeek(a.date)));
      const result = cancelForScheduleChange(affected, {
        confirmed: cancelAffected === true,
        admin: req.user,
        reasonFor: () => (updated.active
          ? `${doctor.name} no longer works on this day.`
          : `${doctor.name} is no longer taking appointments.`),
      });
      db.prepare('UPDATE doctors SET name = ?, specialty = ?, working_days = ?, active = ? WHERE id = ?')
        .run(updated.name, updated.specialty, updated.days.join(','), updated.active ? 1 : 0, doctor.id);
      return result;
    });
    res.json({ doctor: publicDoctor(findDoctor(doctor.id)), cancelledAppointments: cancelled });
  });

  // ----- Leave days and clinic holidays -----
  app.get('/api/doctors/:id/leave', requireUser, requireAdmin, (req, res) => {
    const doctor = findDoctor(req.params.id);
    res.json(db.prepare('SELECT date, reason FROM doctor_leave WHERE doctor_id = ? AND date >= ? ORDER BY date')
      .all(doctor.id, rules.today()).map((row) => ({ ...row })));
  });

  app.post('/api/doctors/:id/leave', requireUser, requireAdmin, (req, res) => {
    const doctor = findDoctor(req.params.id);
    const { date, reason = null, cancelAffected } = req.body ?? {};
    checkScheduleDate(date);
    if (reason !== null && !isText(reason, 1, 100)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Reason must be up to 100 characters.');
    }
    const cancelled = transaction(db, () => {
      if (leaveOn(doctor, date)) throw new ApiError(409, 'LEAVE_EXISTS', 'That day is already a leave day.');
      const result = cancelForScheduleChange(upcomingAppointments('a.doctor_id = ? AND a.date = ?', doctor.id, date), {
        confirmed: cancelAffected === true,
        admin: req.user,
        reasonFor: () => `${doctor.name} is on leave on this day.`,
      });
      db.prepare('INSERT INTO doctor_leave (doctor_id, date, reason) VALUES (?, ?, ?)')
        .run(doctor.id, date, reason?.trim() || null);
      return result;
    });
    res.status(201).json({ leave: { date, reason: reason?.trim() || null }, cancelledAppointments: cancelled });
  });

  // Removing a leave day opens its slots again. Appointments cancelled for it stay cancelled.
  app.delete('/api/doctors/:id/leave/:date', requireUser, requireAdmin, (req, res) => {
    const doctor = findDoctor(req.params.id);
    const { changes } = db.prepare('DELETE FROM doctor_leave WHERE doctor_id = ? AND date = ?').run(doctor.id, req.params.date);
    if (changes === 0) throw new ApiError(404, 'NOT_FOUND', 'That leave day was not found.');
    res.status(204).end();
  });

  app.get('/api/holidays', (req, res) => {
    res.json(db.prepare('SELECT date, name FROM clinic_holidays WHERE date >= ? ORDER BY date')
      .all(rules.today()).map((row) => ({ ...row })));
  });

  app.post('/api/holidays', requireUser, requireAdmin, (req, res) => {
    const { date, name, cancelAffected } = req.body ?? {};
    checkScheduleDate(date);
    if (!isText(name, 2, 80)) throw new ApiError(400, 'INVALID_INPUT', 'Holiday name must be 2-80 characters.');
    const cancelled = transaction(db, () => {
      if (holidayOn(date)) throw new ApiError(409, 'HOLIDAY_EXISTS', 'That day is already a holiday.');
      const result = cancelForScheduleChange(upcomingAppointments('a.date = ?', date), {
        confirmed: cancelAffected === true,
        admin: req.user,
        reasonFor: () => `The clinic is closed on this day for ${name.trim()}.`,
      });
      db.prepare('INSERT INTO clinic_holidays (date, name) VALUES (?, ?)').run(date, name.trim());
      return result;
    });
    res.status(201).json({ holiday: { date, name: name.trim() }, cancelledAppointments: cancelled });
  });

  app.delete('/api/holidays/:date', requireUser, requireAdmin, (req, res) => {
    const { changes } = db.prepare('DELETE FROM clinic_holidays WHERE date = ?').run(req.params.date);
    if (changes === 0) throw new ApiError(404, 'NOT_FOUND', 'That holiday was not found.');
    res.status(204).end();
  });

  app.get('/api/doctors/:id/slots', (req, res) => {
    const doctor = findDoctor(req.params.id);
    const { date } = req.query;
    if (!rules.isValidDate(date)) throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid date.');
    const closed = closedDay(doctor, date);
    if (closed) return res.json({ date, working: false, reason: closed.code, message: closed.message, slots: [] });

    const taken = new Set(db.prepare(
      "SELECT time FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'booked'"
    ).all(doctor.id, date).map((row) => row.time));
    const open = date <= rules.lastBookableDate();
    const slots = rules.SLOT_TIMES.map((time) => ({
      time,
      available: open && !taken.has(time) && rules.minutesUntil(date, time) > 0,
    }));
    res.json({ date, working: true, slots });
  });

  // ----- Appointments -----
  const STATUSES = ['booked', 'cancelled', 'completed', 'no-show'];

  // Turns ?doctorId=&from=&to=&status= into SQL conditions. Patients only ever see their own.
  function appointmentFilters(user, { doctorId, from, to, status } = {}) {
    const where = [];
    const params = [];
    if (user.role !== 'admin') {
      where.push('a.patient_id = ?');
      params.push(user.id);
    }
    if (doctorId !== undefined) {
      if (!/^\d+$/.test(doctorId)) throw new ApiError(400, 'INVALID_INPUT', 'Doctor must be a doctor id.');
      where.push('a.doctor_id = ?');
      params.push(Number(doctorId));
    }
    for (const [value, condition, label] of [[from, 'a.date >= ?', 'From'], [to, 'a.date <= ?', 'To']]) {
      if (value === undefined) continue;
      if (!rules.isValidDate(value)) throw new ApiError(400, 'INVALID_INPUT', `${label} must be a valid date.`);
      where.push(condition);
      params.push(value);
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new ApiError(400, 'INVALID_INPUT', 'From must be on or before To.');
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new ApiError(400, 'INVALID_INPUT', `Status must be one of ${STATUSES.join(', ')}.`);
      where.push('a.status = ?');
      params.push(status);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  app.get('/api/appointments', requireUser, (req, res) => {
    const { sql, params } = appointmentFilters(req.user, req.query);
    res.json(db.prepare(`${APPOINTMENT_SELECT} ${sql} ORDER BY a.date, a.time, a.id`).all(...params));
  });

  // Counts per status for the same doctor and date filters. A status filter is ignored,
  // since the point is to compare the statuses.
  app.get('/api/appointments/summary', requireUser, requireAdmin, (req, res) => {
    const { sql, params } = appointmentFilters(req.user, { ...req.query, status: undefined });
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of db.prepare(`SELECT a.status, COUNT(*) AS n FROM appointments a ${sql} GROUP BY a.status`).all(...params)) {
      counts[row.status] = row.n;
    }
    res.json({ counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) });
  });

  app.post('/api/appointments', requireUser, (req, res) => {
    const { doctorId, date, time, reason } = req.body ?? {};
    if (!Number.isInteger(doctorId) || !rules.isValidDate(date) || typeof time !== 'string') {
      throw new ApiError(400, 'INVALID_INPUT', 'Doctor, date and time are required.');
    }
    if (!isText(reason, 3, 200)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Reason must be 3-200 characters.');
    }
    const doctor = findDoctor(doctorId);
    const created = transaction(db, () => bookAppointment(req.user, doctor, { date, time, reason }));
    res.status(201).json(findAppointment(created));
  });

  // Checks every booking rule and saves the booking. Runs inside a transaction.
  // rescheduledFrom links a booking made by moving an earlier one.
  function bookAppointment(user, doctor, { date, time, reason, rescheduledFrom = null }) {
    if (!rules.SLOT_TIMES.includes(time)) {
      throw new ApiError(422, 'INVALID_SLOT', 'That time is not an appointment slot.');
    }
    const closed = closedDay(doctor, date, { ignoreHolidaysAndLeave: bugs.has('closed-day-booking') });
    if (closed?.code === 'NOT_WORKING_DAY') {
      throw new ApiError(422, 'NOT_WORKING_DAY', 'The doctor does not work on that day.');
    }
    if (closed) throw new ApiError(422, closed.code, closed.message);
    if (!bugs.has('past-booking') && rules.minutesUntil(date, time) <= 0) {
      throw new ApiError(422, 'SLOT_IN_PAST', 'That slot has already started.');
    }
    if (date > rules.lastBookableDate()) {
      throw new ApiError(422, 'TOO_FAR_AHEAD', `Bookings open ${rules.MAX_DAYS_AHEAD} days ahead.`);
    }
    const slotTaken = db.prepare(
      "SELECT 1 FROM appointments WHERE doctor_id = ? AND date = ? AND time = ? AND status = 'booked'"
    ).get(doctor.id, date, time);
    if (slotTaken && !bugs.has('double-booking')) {
      throw new ApiError(409, 'SLOT_TAKEN', 'That slot has just been taken.');
    }
    const patientBusy = db.prepare(
      "SELECT 1 FROM appointments WHERE patient_id = ? AND date = ? AND time = ? AND status = 'booked'"
    ).get(user.id, date, time);
    if (patientBusy && !bugs.has('double-booking')) {
      throw new ApiError(409, 'PATIENT_BUSY', 'You already have an appointment at that time.');
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO appointments
      (doctor_id, patient_id, date, time, reason, status, created_at, rescheduled_from)
      VALUES (?, ?, ?, ?, ?, 'booked', ?, ?)`
    ).run(doctor.id, user.id, date, time, reason.trim(), rules.now(), rescheduledFrom);
    return lastInsertRowid;
  }

  function loadAppointment(id) {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(id));
    if (!appointment) throw new ApiError(404, 'NOT_FOUND', 'Appointment not found.');
    return appointment;
  }

  // Only booked appointments can be cancelled, moved or given an outcome.
  function requireBooked(appointment) {
    if (appointment.status === 'cancelled') {
      throw new ApiError(409, 'ALREADY_CANCELLED', 'That appointment is already cancelled.');
    }
    if (appointment.status !== 'booked') {
      throw new ApiError(409, 'NOT_BOOKED', `That appointment is already marked ${appointment.status}.`);
    }
  }

  const NO_REASON = 'No reason given.';
  const checkCancelReason = (reason) => {
    if (reason !== undefined && reason !== null && !isText(reason, 0, 200)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Reason must be up to 200 characters.');
    }
    return reason?.trim() || NO_REASON;
  };

  app.post('/api/appointments/:id/cancel', requireUser, (req, res) => {
    const reason = checkCancelReason(req.body?.reason);
    const id = transaction(db, () => cancelAppointment(req.user, Number(req.params.id), reason));
    res.json(findAppointment(id));
  });

  // Checks the cancellation rules and cancels, recording who, when and why.
  // Runs inside a transaction.
  function cancelAppointment(user, appointmentId, reason) {
    const appointment = loadAppointment(appointmentId);
    const isAdmin = user.role === 'admin';
    if (!isAdmin && appointment.patient_id !== user.id && !bugs.has('cancel-any')) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only cancel your own appointments.');
    }
    requireBooked(appointment);
    const tooLate = rules.minutesUntil(appointment.date, appointment.time) < rules.CANCEL_CUTOFF_MINUTES;
    if (!isAdmin && tooLate && !bugs.has('late-cancel')) {
      throw new ApiError(422, 'CANCEL_TOO_LATE', 'Appointments can be cancelled up to 2 hours before they start.');
    }
    db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
      WHERE id = ?`).run(rules.now(), user.id, reason, appointment.id);
    return appointment.id;
  }

  // Moves a booked appointment to another free slot with the same doctor. The original is
  // kept as a cancelled appointment linked to its replacement, so the history stays complete.
  // Both happen in one transaction: if the new slot is refused, nothing changes.
  app.post('/api/appointments/:id/reschedule', requireUser, (req, res) => {
    const { date, time } = req.body ?? {};
    if (!rules.isValidDate(date) || typeof time !== 'string') {
      throw new ApiError(400, 'INVALID_INPUT', 'A new date and time are required.');
    }
    const created = transaction(db, () => {
      const original = loadAppointment(req.params.id);
      if (original.patient_id !== req.user.id) {
        throw new ApiError(403, 'FORBIDDEN', 'You can only move your own appointments.');
      }
      requireBooked(original);
      if (rules.minutesUntil(original.date, original.time) < rules.CANCEL_CUTOFF_MINUTES) {
        throw new ApiError(422, 'RESCHEDULE_TOO_LATE', 'Appointments can be moved up to 2 hours before they start.');
      }
      if (date === original.date && time === original.time) {
        throw new ApiError(422, 'SAME_SLOT', 'Choose a different time from the current one.');
      }
      if (!bugs.has('reschedule-keeps-old')) {
        db.prepare(`UPDATE appointments SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
          WHERE id = ?`).run(rules.now(), req.user.id, 'Moved to a new time.', original.id);
      }
      return bookAppointment(req.user, findDoctor(original.doctor_id),
        { date, time, reason: original.reason, rescheduledFrom: original.id });
    });
    res.status(201).json(findAppointment(created));
  });

  // Admins record whether a patient came, once the appointment has started. A mistake can be
  // corrected by marking it again.
  const OUTCOMES = ['completed', 'no-show'];
  app.post('/api/appointments/:id/outcome', requireUser, requireAdmin, (req, res) => {
    const { status } = req.body ?? {};
    if (!OUTCOMES.includes(status)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Status must be completed or no-show.');
    }
    const appointment = loadAppointment(req.params.id);
    if (!OUTCOMES.includes(appointment.status)) requireBooked(appointment);
    if (rules.minutesUntil(appointment.date, appointment.time) > 0 && !bugs.has('early-outcome')) {
      throw new ApiError(422, 'NOT_STARTED', "An appointment can't be marked before it starts.");
    }
    db.prepare('UPDATE appointments SET status = ?, outcome_at = ?, outcome_by = ? WHERE id = ?')
      .run(status, rules.now(), req.user.id, appointment.id);
    res.json(findAppointment(appointment.id));
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    err = bookingConflict(err) || err;
    if (err instanceof ApiError) {
      return res.status(err.status).set(err.headers)
        .json({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Request body is not valid JSON.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } });
  });

  return app;
}

module.exports = { createApp, bookingConflict };
