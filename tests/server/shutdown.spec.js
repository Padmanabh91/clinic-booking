const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test, expect } = require('@playwright/test');
const { start } = require('../../src/server');
const { loadConfig } = require('../../src/config');
const { FIXED_NOW } = require('../support/clinic-time');

process.env.FIXED_NOW = FIXED_NOW;

// A file database, as in production, on a free port.
function startOnFile(file, logs = []) {
  const config = { ...loadConfig({}), dbPath: file, port: 0, host: '127.0.0.1' };
  return start(config, { log: (line) => logs.push(line) });
}

const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

test.describe('Shutting down', () => {
  test('stops taking requests, then closes the database with its data saved', { tag: '@regression' }, async ({ request }, testInfo) => {
    const file = testInfo.outputPath('clinic.db');
    const logs = [];
    const { server, db, shutdown } = startOnFile(file, logs);
    await once(server, 'listening');
    const url = urlOf(server);
    expect((await request.post(`${url}/api/login`, { data: { email: 'patient@clinic.test', password: 'Patient@123' } })).status()).toBe(200);
    expect((await request.post(`${url}/api/appointments`, { data: { doctorId: 1, date: '2030-01-08', time: '10:00', reason: 'Fever' } })).status()).toBe(201);

    await shutdown();

    expect(server.listening).toBe(false);
    expect(() => db.prepare('SELECT 1').get()).toThrow();
    expect(logs).toContain('Closed the database. Goodbye.');
    await expect(request.get(`${url}/api/health`, { timeout: 2000 })).rejects.toThrow();
    const reopened = new DatabaseSync(file);
    expect(reopened.prepare('SELECT reason FROM appointments').all().map((row) => row.reason)).toEqual(['Fever']);
    reopened.close();
  });

  test('asking twice shuts down once', { tag: '@regression' }, async ({}, testInfo) => {
    const logs = [];
    const { server, shutdown } = startOnFile(testInfo.outputPath('clinic.db'), logs);
    await once(server, 'listening');

    await Promise.all([shutdown(), shutdown()]);

    expect(logs.filter((line) => line.startsWith('Closed the database'))).toHaveLength(1);
  });

  // Windows can't deliver SIGTERM to a process, so this runs on Linux and macOS (including CI).
  test('SIGTERM makes the real server shut down cleanly and exit with code 0', { tag: '@regression' }, async ({}, testInfo) => {
    test.skip(process.platform === 'win32', 'Windows cannot send SIGTERM to a Node process');
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: '0', DB_PATH: testInfo.outputPath('clinic.db'), BUGS: '' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    await expect.poll(() => output, { timeout: 10000 }).toContain('Clinic Booking running at');

    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');

    expect(code).toBe(0);
    expect(output).toContain('SIGTERM received, shutting down.');
    expect(output).toContain('Closed the database. Goodbye.');
  });
});
