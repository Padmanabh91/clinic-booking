const { createDb } = require('./db');
const { createApp } = require('./app');
const { loadConfig } = require('./config');

const FORCE_CLOSE_AFTER_MS = 10000;

// Starts the app and returns shutdown(). Shutting down stops new connections, lets requests
// already in progress finish, then closes the database so nothing is left half-written.
function start(config = loadConfig(), { log = console.log } = {}) {
  const { bugs, dbPath, port, host, trustProxy, secureCookies } = config;
  const db = createDb(dbPath, bugs);
  const server = createApp(db, bugs, { trustProxy, secureCookies }).listen(port, host, () => {
    log(`Clinic Booking running at http://${host}:${server.address().port}`);
    if (bugs.size > 0) log(`BUG MODE is on: ${[...bugs].join(', ')}`);
  });

  let closing = null;
  function shutdown() {
    closing ??= new Promise((resolve) => {
      server.close(() => {
        db.close();
        log('Closed the database. Goodbye.');
        resolve();
      });
      server.closeIdleConnections(); // keep-alive connections with nothing in progress
      // A request that never finishes must not keep the process alive for ever.
      setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS).unref();
    });
    return closing;
  }

  return { server, db, shutdown };
}

if (require.main === module) {
  const { shutdown } = start();
  // Docker and most hosts send SIGTERM to stop the app; Ctrl+C sends SIGINT.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      console.log(`${signal} received, shutting down.`);
      shutdown().then(() => process.exit(0));
    });
  }
}

module.exports = { start };
