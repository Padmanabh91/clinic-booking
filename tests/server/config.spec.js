const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { loadConfig } = require('../../src/config');

test.describe('Server settings', () => {
  test('defaults suit running on your own computer', { tag: '@regression' }, () => {
    expect(loadConfig({})).toEqual({
      bugs: new Set(),
      dbPath: path.join(__dirname, '..', '..', 'data', 'clinic.db'),
      port: 3000,
      host: '127.0.0.1',
      trustProxy: false,
      secureCookies: false,
    });
  });

  test('cookies are HTTPS-only by default in production, unless turned off', { tag: '@regression' }, () => {
    expect(loadConfig({ NODE_ENV: 'production' }).secureCookies).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).secureCookies).toBe(false);
    expect(loadConfig({ COOKIE_SECURE: 'true' }).secureCookies).toBe(true);
  });

  test('a COOKIE_SECURE value other than true or false stops the server starting', { tag: '@regression' }, () => {
    expect(() => loadConfig({ COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE must be "true" or "false", not "yes".');
  });

  for (const [value, expected] of [['true', true], ['false', false], ['1', 1], ['loopback', 'loopback']]) {
    test(`TRUST_PROXY=${value} is passed to Express as ${JSON.stringify(expected)}`, { tag: '@regression' }, () => {
      expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toBe(expected);
    });
  }

  test('bug mode always uses an in-memory database', { tag: '@regression' }, () => {
    const config = loadConfig({ BUGS: 'no-login-limit, no-session-expiry', DB_PATH: 'data/real.db' });

    expect(config.bugs).toEqual(new Set(['no-login-limit', 'no-session-expiry']));
    expect(config.dbPath).toBe(':memory:');
  });

  test('an unknown bug name stops the server starting', { tag: '@regression' }, () => {
    expect(() => loadConfig({ BUGS: 'typo' })).toThrow('Unknown bug "typo"');
  });
});

test.describe('Test runner settings', () => {
  // Loads playwright.config.js afresh with CI set or unset, since it reads CI when loaded.
  // env overrides CI and TEST_PORT for the load (undefined removes them); both are put back after.
  function loadRunnerConfig(ci, env = {}) {
    const file = path.join(__dirname, '..', '..', 'playwright.config.js');
    const settings = { CI: ci ? 'true' : undefined, ...env };
    const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    const apply = (values) => {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    };
    apply(settings);
    delete require.cache[require.resolve(file)];
    try {
      return { config: require(file), chosenPort: process.env.TEST_PORT };
    } finally {
      apply(saved);
      delete require.cache[require.resolve(file)];
    }
  }

  test('the test server uses the port in TEST_PORT', { tag: '@regression' }, () => {
    const { config } = loadRunnerConfig(false, { TEST_PORT: '45678' });

    expect(config.use.baseURL).toBe('http://127.0.0.1:45678');
    expect(config.webServer.env.PORT).toBe('45678');
    expect(config.webServer.url).toBe('http://127.0.0.1:45678/api/health');
  });

  test('without TEST_PORT, a free port is chosen and kept for the workers', { tag: '@regression' }, () => {
    const { config, chosenPort } = loadRunnerConfig(false, { TEST_PORT: undefined });

    expect(Number(chosenPort)).toBeGreaterThan(0);
    expect(Number(chosenPort)).toBeLessThan(65536);
    expect(config.use.baseURL).toBe(`http://127.0.0.1:${chosenPort}`);
  });

  test('failures keep a screenshot and video, and a trace on the retry', { tag: '@regression' }, () => {
    expect(loadRunnerConfig(false).config.use).toMatchObject({
      trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure',
    });
  });

  test('tests are retried once in CI and never locally', { tag: '@regression' }, () => {
    expect(loadRunnerConfig(true).config.retries).toBe(1);
    expect(loadRunnerConfig(false).config.retries).toBe(0);
  });

  test('the HTML report is written and not opened', { tag: '@regression' }, () => {
    expect(loadRunnerConfig(false).config.reporter).toContainEqual(['html', { open: 'never' }]);
  });
});
