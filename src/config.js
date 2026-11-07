const path = require('node:path');
const { parseBugs } = require('./bugs');

// TRUST_PROXY takes Express's "trust proxy" values: true, false, a number of proxies,
// or addresses such as "loopback". Set it when running behind a hosting proxy.
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

// COOKIE_SECURE=true sends the sign-in cookie over HTTPS only. It defaults to on in production.
function parseSecureCookies(value, nodeEnv) {
  if (value === undefined || value === '') return nodeEnv === 'production';
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error(`COOKIE_SECURE must be "true" or "false", not "${value}".`);
}

// Reads the server's settings from environment variables.
function loadConfig(env = process.env) {
  const bugs = parseBugs(env.BUGS);
  return {
    bugs,
    // Bug mode never touches the saved demo data.
    dbPath: bugs.size > 0 ? ':memory:' : env.DB_PATH || path.join(__dirname, '..', 'data', 'clinic.db'),
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    secureCookies: parseSecureCookies(env.COOKIE_SECURE, env.NODE_ENV),
  };
}

module.exports = { loadConfig };
