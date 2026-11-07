// Session, sign-in and HTTP security rules. Times are Bangalore-local "YYYY-MM-DDTHH:MM"
// strings from rules.now(), so the test server's fixed clock applies here too.
const crypto = require('node:crypto');
const rules = require('./rules');

const SESSION_IDLE_MINUTES = 8 * 60;
const SESSION_MAX_MINUTES = 7 * 24 * 60;
const LOGIN_WINDOW_MINUTES = 15;
// Few failures per email stops password guessing on one account. The higher limit per
// address stops one address trying many accounts without blocking a shared office network.
const MAX_FAILURES_PER_EMAIL = 5;
const MAX_FAILURES_PER_IP = 50;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

// Only a hash of each session token is stored, so a leaked database can't be used to sign in.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

// A session ends after 8 hours without use, or 7 days after sign-in, whichever comes first.
function sessionExpired(session, now) {
  return session.last_seen_at <= rules.shiftTime(now, -SESSION_IDLE_MINUTES)
    || session.created_at <= rules.shiftTime(now, -SESSION_MAX_MINUTES);
}

function removeExpiredSessions(db, now) {
  db.prepare('DELETE FROM sessions WHERE last_seen_at <= ? OR created_at <= ?')
    .run(rules.shiftTime(now, -SESSION_IDLE_MINUTES), rules.shiftTime(now, -SESSION_MAX_MINUTES));
}

// How many minutes until sign-in is allowed again, or 0 if it is allowed now.
// Old failures are removed first, so the table only holds the current window.
function loginWaitMinutes(db, { email, ip }, now) {
  db.prepare('DELETE FROM login_attempts WHERE attempted_at <= ?').run(rules.shiftTime(now, -LOGIN_WINDOW_MINUTES));
  const waits = [
    ['email', email, MAX_FAILURES_PER_EMAIL],
    ['ip', ip, MAX_FAILURES_PER_IP],
  ].map(([column, value, limit]) => {
    const times = db.prepare(`SELECT attempted_at FROM login_attempts WHERE ${column} = ? ORDER BY attempted_at`)
      .all(value).map((row) => row.attempted_at);
    if (times.length < limit) return 0;
    // Sign-in opens again once enough of the oldest failures have left the window.
    const freedAt = rules.shiftTime(times[times.length - limit], LOGIN_WINDOW_MINUTES);
    return rules.minutesUntil(...freedAt.split('T'));
  });
  return Math.max(...waits);
}

function recordLoginFailure(db, { email, ip }, now) {
  db.prepare('INSERT INTO login_attempts (email, ip, attempted_at) VALUES (?, ?, ?)').run(email, ip, now);
}

function clearLoginFailures(db, email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
}

// The page only loads its own script and stylesheet and never needs to be framed.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

function securityHeaders({ secureCookies }) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    // Browsers ignore HSTS over plain HTTP, so it is only sent when the site uses HTTPS.
    if (secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    // API answers contain personal details, so they must never be cached.
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  };
}

module.exports = {
  SESSION_IDLE_MINUTES, SESSION_MAX_MINUTES, LOGIN_WINDOW_MINUTES,
  MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP, PASSWORD_MIN, PASSWORD_MAX, CONTENT_SECURITY_POLICY,
  hashToken, newToken, sessionExpired, removeExpiredSessions,
  loginWaitMinutes, recordLoginFailure, clearLoginFailures, securityHeaders,
};
