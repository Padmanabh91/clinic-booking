// Known bugs that bug mode can switch on, to prove the tests catch them.
const KNOWN_BUGS = [
  'double-booking', 'past-booking', 'cancel-any', 'late-cancel', 'role-escalation',
  'no-session-expiry', 'no-login-limit', 'closed-day-booking', 'reschedule-keeps-old', 'early-outcome',
];

// Reads a comma-separated list such as the BUGS environment variable.
function parseBugs(value = '') {
  const bugs = new Set(value.split(',').map((b) => b.trim()).filter(Boolean));
  for (const bug of bugs) {
    if (!KNOWN_BUGS.includes(bug)) throw new Error(`Unknown bug "${bug}". Known bugs: ${KNOWN_BUGS.join(', ')}`);
  }
  return bugs;
}

module.exports = { KNOWN_BUGS, parseBugs };
