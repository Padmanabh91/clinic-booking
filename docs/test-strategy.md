# Test Strategy: Clinic Booking

How the test suite is built, why it is built that way, and the conventions that keep it reliable. What is tested, rule by rule, is in the [test plan](test-plan.md).

## Running the tests
| Command | Runs |
|---|---|
| `npm test` | Everything, in Chromium, Firefox and WebKit |
| `npm run test:smoke` | Only the `@smoke` tests: the journeys and the core booking, cancellation and sign-in tests |
| `npx playwright test --grep @regression` | Everything except the smoke tests |
| `npm run test:api` / `test:db` / `test:server` | One layer |
| `npx playwright test --project=chromium` | The UI tests in one browser |
| `npm run test:bugs` | Bug mode (see below) |
| `npm run report` | Opens the last HTML report |

Every test is tagged either `@smoke` or `@regression`, never both.

## The layers, and why each exists
| Layer | Folder | What it covers | Why it exists |
|---|---|---|---|
| API | `tests/api/` | Booking rules, boundaries, permissions, error codes | Fast, with no browser, so it can try many combinations. Most rules are proved here. |
| Database | `tests/db/` | Migrations, constraints, transactions | The database is the last line of defence. These prove it refuses bad data even if the API checks are bypassed, and that upgrades keep existing data. |
| Server | `tests/server/` | Session expiry, the sign-in limit, outcomes after the start time, settings, clean shutdown | Each test needs time to pass or special settings, so it runs its own copy of the app (see below). The SIGTERM test runs only on Linux and macOS, because Windows can't send that signal to Node. |
| UI | `tests/ui/` | What users see: messages, states, focus, layout, accessibility | Proves the rules reach the user correctly. Screens are reached through page objects in `tests/pages/`. |
| Journeys | `tests/ui/journeys/` | A patient's and an admin's whole journey, a race for one slot, a session ending mid-booking | Checks the pieces work together. Each journey is one test made of named steps (`test.step`). |
| Accessibility | `tests/ui/accessibility.spec.js`, `keyboard.spec.js` | axe checks (WCAG 2.1 AA) on every screen and dialog, and keyboard use | Catches common accessibility problems automatically. |
| Bug mode | `scripts/bug-mode.js` | The API and server suites, with known bugs switched on | Proves the tests can fail (see below). |

## Bug mode
A passing suite doesn't show that it could ever fail. The app has ten known bugs (listed in `src/bugs.js` and the README) that can be switched on with the `BUGS` setting. `npm run test:bugs`:
1. runs the API and server tests with no bugs, and stops if anything fails;
2. runs them again once per bug, and expects at least one test to fail each time;
3. lists the tests that caught each bug, and fails if any bug was missed.

Bug mode always uses an in-memory database, so it never touches saved data. When a new rule is added, add a bug that breaks it where it fits, so the tests for the rule are proved too.

## Clocks
- **Fixed clock.** The shared test server always thinks it is Monday 7 Jan 2030, 10:00 IST (`FIXED_NOW` in `tests/support/clinic-time.js`). Date rules give the same result whatever day the tests run. Dates in tests come from the constants in that file, such as `TODAY`, `TOMORROW` and `LAST_BOOKABLE_DAY`.
- **Movable clock.** Some rules need time to pass: session expiry, the 15-minute sign-in window, marking an appointment after it starts. Those tests use the `clock` fixture from `tests/support/local-app.js`. `clock.advance(minutes)` moves only that test's copy of the app, and the clock is reset after each test.

## Isolation
- **Shared server, separate data.** Most tests share one server started by Playwright, with a fresh in-memory database for each run. They stay independent because each test creates its own patient and doctor through the API (`tests/support/fixtures.js`). Tests on the shared server must only touch data they created, or filter to it (for example the admin filters tests filter to their own doctor).
- **App copies.** A test whose changes affect everyone runs on its own copy of the app, started on a free port with its own in-memory database (`tests/support/local-app.js`). This applies to tests that:
  - move the clock;
  - add clinic holidays;
  - deactivate every doctor;
  - need content they fully control, such as the phone layout tests.

  Use `localPageFor(client)` to open a browser page on that copy.
- **Rule of thumb:** if a test would break another test running at the same time, or would be broken by one, it belongs on an app copy.
- **Free port per run.** `playwright.config.js` gives the shared server a free port when the run starts, and keeps it in `TEST_PORT` for the workers. Two runs at once can't collide, and setting `TEST_PORT` yourself fixes the port.

## Conventions
- **Exact lookups.** Use `exact: true` on label and role lookups whose names could match others: `getByLabel('To')` also matches "Doctor", and `getByLabel('Date')` matches "New date".
- **Wait before reading a list.** Don't call `.all()` (or read counts directly) before the list has rendered: `.all()` doesn't wait. Assert first, for example `await expect(cards).toHaveCount(1)`, then read.
- **Clock tests respect the 8-hour session expiry.** Moving the clock 8 hours or more ends every session, which is correct behaviour. Sign in again after a long move.
- **One assertion per expected wait.** When the app has to do something before the next step, wait for it with one web-first assertion (`await expect(...).toBeVisible()`, `toHaveText`, and so on) rather than fixed sleeps or several checks of the same thing.
- **Hold requests to see in-between states.** To test a loading state, hold the request with `page.route` until the test releases it, instead of relying on timing (see `tests/ui/states.spec.js`).
- **Name the culprit.** When a check can fail for many reasons, make it report what failed. For example, the phone layout check lists the elements that stick out, instead of just saying the page is too wide.
- **Tag every test.** Add `{ tag: '@smoke' }` or `{ tag: '@regression' }` to each new test.
- **Pick seeded doctors by id or specialty.** The three seeded doctors share one name. Use the constants in `tests/support/doctors.js`, and `doctorLabel()` for the "Name · Specialty" text the app shows.

## Failures, traces and reports
- Screenshots and video are kept for failed tests, in `test-results/`.
- A trace is recorded on the first retry. Tests are only retried in CI (once), so locally you get a trace by rerunning a failure with `--trace=on`.
- The HTML report is always written to `playwright-report/`.

## CI
`.github/workflows/tests.yml` runs on every push to `main` and every pull request.
- **Four parallel test jobs:**
  - `api` runs the API, database and server tests, then bug mode.
  - `ui (chromium)`, `ui (firefox)` and `ui (webkit)` each install one browser and run the UI and journey tests in it.
- **A fifth job, `docker`**, builds the image, checks `/api/health`, checks that the data survives a new container, and checks that `docker stop` closes the database and exits with code 0.
- **Artifacts:** every test job uploads its HTML report (`report-<job>`), even when tests fail. On failure it also uploads `test-results/` with traces, screenshots and videos (`test-results-<job>`).
- **Node version:** read from `.nvmrc`, so CI uses the same Node as local development.

## Known issues
- **Firefox can crash when axe runs right after a Playwright role lookup.** Seen with Playwright 1.65.0 and @axe-core/playwright 4.14.0; it is a tooling problem, not an app bug, and the error is "Page crashed".
  - **After a `getByRole('region')` lookup it happens every time.** The appointments page object therefore finds sections by their heading (`AppointmentsPage.section`). Never use `getByRole('region')` in a test that runs axe.
  - **One page crashes intermittently, whatever the locator.** The axe check of the admin history page (`tests/ui/history.spec.js`) crashed Firefox in 3 of the last 4 full runs, and in about 1 in 10 runs when run alone. It is a browser crash during the scan ("Page crashed"), not an assertion failure. This check is skipped in Firefox and still runs in Chromium and WebKit.
    - Making it wait by text instead of a role lookup did not stop it: 0 crashes in 90 runs at first, then a crash again in the next full run. So for this page the trigger is not the role lookup, and the cause is unknown.
    - The same page in Chromium and WebKit, and similar admin pages in Firefox, have never crashed.
  - **CI's single retry would usually hide it.** Check the HTML report for tests marked flaky.
- **WebKit doesn't move focus to links with Tab.** Like Safari with its default settings, WebKit skips links with Tab and Option+Tab. In WebKit, the skip-link test focuses the link directly and checks the rest.
- **The computer sleeping fails tests.** If the computer goes to sleep during a run, tests that are mid-request fail and the run's duration is wrong. Rerun, and keep the computer awake for full runs.
