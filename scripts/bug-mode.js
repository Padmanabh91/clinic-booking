// Proves the tests catch real failures. It runs the API and server suites once with no bugs,
// then once for each known bug switched on, and expects that bug to turn tests red.
// The server suite starts its own copies of the app, so it can move the clock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { KNOWN_BUGS: BUGS } = require('../src/bugs');
const reportFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-bugs-')), 'report.json');

function failedTests(suites = [], parents = []) {
  return suites.flatMap((suite) => {
    const trail = suite.file === suite.title ? parents : [...parents, suite.title];
    return [
      ...(suite.specs || []).filter((spec) => !spec.ok).map((spec) => [...trail, spec.title].join(' > ')),
      ...failedTests(suite.suites, trail),
    ];
  });
}

function runSuite(bug) {
  const result = spawnSync('npx playwright test --project=api --project=server --retries=0 --reporter=json', {
    shell: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BUGS: bug, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
  });
  if (result.error) throw result.error;
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  return { total: report.stats.expected + report.stats.unexpected, failed: failedTests(report.suites) };
}

const baseline = runSuite('');
if (baseline.failed.length > 0) {
  console.error('The suite must pass with no bugs first. Failing tests:', baseline.failed);
  process.exit(1);
}
console.log(`No bugs: all ${baseline.total} API and server tests pass.\n`);

let missed = 0;
for (const bug of BUGS) {
  const { failed } = runSuite(bug);
  if (failed.length === 0) missed += 1;
  console.log(`${failed.length > 0 ? 'CAUGHT' : 'MISSED'}  ${bug}`);
  failed.forEach((title) => console.log(`        - ${title}`));
}

console.log(`\n${BUGS.length - missed} of ${BUGS.length} bugs caught.`);
process.exit(missed > 0 ? 1 : 0);
