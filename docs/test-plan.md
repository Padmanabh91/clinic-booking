# Test Plan: Clinic Booking

## Goal
Show that patients at the Bangalore clinic can book, reschedule and cancel appointments reliably, that admins can manage doctors and schedules without silently losing bookings, and that the booking rules, permissions and sign-in protections can't be bypassed.

How the suite is built and run is in the [test strategy](test-strategy.md).

## In scope
- Registration, sign-in, sign-out, sessions and changing a password
- Viewing doctors and available slots
- Booking, rescheduling and cancellation rules
- Appointment statuses (booked, cancelled, completed, no-show) and the history
- What patients and admins can each see and do
- Doctor management: editing, deactivating, leave days and clinic holidays
- Admin filters and the summary of statuses
- Security: permissions, session expiry, the sign-in limit, sign-in timing, token storage, security headers
- Database upgrades (migrations)
- Accessibility of each screen (WCAG 2.1 AA automated checks, plus keyboard tests)
- Loading, empty and error states, and the layout at 375px wide
- Chromium, Firefox and WebKit

## Out of scope
- Load and performance testing
- Penetration testing and dependency scanning. Security testing covers the rules listed below (R14 to R20) and one script-injection check
- Screen reader and manual accessibility testing beyond the keyboard tests
- Email or SMS reminders, payments, per-doctor working hours and doctor sign-in, which the app doesn't have

## Approach
| Layer | Tests | Used for | Why |
|---|---|---|---|
| API tests | 147 | Rules, boundaries, permissions, error codes | Fast, so they can cover many input combinations |
| Database tests | 22 | Migrations, constraints, transactions | Prove the data stays safe even if the API checks are bypassed |
| Server tests | 53 | Anything that needs time to pass, settings, clean shutdown | Each runs its own copy of the app, so it can move the clock |
| UI and accessibility tests | 117 per browser | User-facing behaviour, states, error messages, axe checks and keyboard use | Confirm the rules reach the user correctly |
| Journey tests | 4 per browser | Full patient and admin journeys, plus a race and a session expiring | Check the pieces work together, end to end |
| Bug mode | 10 bugs | Switches on known bugs and expects failures | Proves the tests can actually fail |

In total that is 585 test runs (the UI and journey tests run in Chromium, Firefox and WebKit). 27 are tagged `@smoke` and the rest `@regression`.

### How tests stay reliable
- **Fixed clock:** the shared test server runs at Monday 7 Jan 2030, 10:00 IST, so date rules give the same result every day.
- **Movable clock:** tests that need time to pass run on their own copy of the app and move only its clock.
- **Independent data:** each test creates its own patient and doctor through the API, so tests can run in parallel in any order. Tests that affect everyone, such as holidays, use their own copy of the app.
- **Fresh database:** every run starts with an empty in-memory database.

## Business rules and coverage
Folders are under `tests/`.

| ID | Rule | Tests |
|---|---|---|
| R1 | A slot can't be booked twice | `api/booking`, `ui/booking`, `ui/journeys/negative` |
| R2 | A patient can't have two appointments at the same time | `api/booking`, `db/database` |
| R3 | A slot must start after the current time | `api/booking`, `ui/booking` |
| R4 | Bookings open up to 30 days ahead | `api/booking` |
| R5 | Slots run every 30 minutes, 09:00-16:30, with lunch 13:00-14:00 | `api/booking` |
| R6 | Bookings are only allowed on the doctor's working days | `api/booking`, `ui/booking` |
| R7 | The reason for visit must be 3-200 characters | `api/booking` |
| R8 | Patients can cancel up to 2 hours before the start | `api/cancellation`, `ui/cancellation` |
| R9 | Admins can cancel at any time | `api/cancellation`, `ui/cancellation` |
| R10 | Patients can only see, cancel and move their own appointments | `api/cancellation`, `api/reschedule` |
| R11 | Registering always creates a patient, never an admin | `api/auth` |
| R12 | Only admins can add, edit and deactivate doctors, and manage leave and holidays | `api/cancellation`, `api/doctors` |
| R13 | All times use Bangalore time (IST) | `api/auth`, `ui/booking` |
| R14 | A session ends after 8 hours unused, or 7 days after sign-in | `server/sessions`, `ui/errors`, `ui/journeys/negative` |
| R15 | After 5 failed sign-ins for an email (or 50 from one address) in 15 minutes, sign-in waits | `api/security`, `server/login-limits`, `ui/account` |
| R16 | An unknown email takes as long to refuse as a wrong password | `server/login-limits` |
| R17 | Only a hash of each session token is stored; the cookie is HttpOnly and SameSite=Strict | `server/sessions`, `api/security` |
| R18 | Every response carries the security headers; API answers are never cached | `api/security`, `ui/account` |
| R19 | Changing a password needs the current one and signs out every other session | `api/account`, `ui/account` |
| R20 | Passwords are 8-128 characters | `api/auth`, `api/account` |
| R21 | Patients can't see or book inactive doctors | `api/doctors`, `ui/admin-doctors`, `ui/clinic-wide` |
| R22 | No bookings on a doctor's leave days | `api/doctors`, `ui/admin-doctors`, `ui/journeys/admin` |
| R23 | No bookings on clinic holidays | `server/holidays`, `ui/clinic-wide` |
| R24 | A schedule change never cancels bookings silently: they are listed first and only cancelled once confirmed, with the reason shown to the patient. Started appointments are never affected | `api/doctors`, `server/holidays`, `ui/admin-doctors`, `ui/journeys/admin` |
| R25 | Rescheduling moves to a free slot with the same doctor under the 2-hour rule, keeps the original as a linked record, and changes nothing if refused | `api/reschedule`, `server/lifecycle`, `ui/reschedule`, `ui/journeys/patient` |
| R26 | Only admins mark completed or no-show, and only once the appointment has started | `api/lifecycle`, `server/lifecycle`, `ui/history` |
| R27 | Every cancellation records who cancelled, when and why | `api/lifecycle`, `server/holidays`, `ui/reschedule` |
| R28 | Admins filter by doctor, dates and status; the summary counts every status for the same doctor and dates | `api/lifecycle`, `server/lifecycle`, `ui/admin-filters`, `ui/journeys/admin` |
| R29 | The database upgrades one version at a time, and a failed step is rolled back | `db/migrations` |
| R30 | Every screen works at 375px wide and from the keyboard | `ui/phone-layout`, `ui/keyboard` |
| R31 | On SIGTERM the server finishes open requests and closes the database cleanly | `server/shutdown` |

## Test design techniques
- **Boundary values:** exactly 2 hours vs 1.5 hours before (cancel and reschedule), day 30 vs day 31, reason of 200 vs 201 characters, password of 7 vs 8 and 128 vs 129 characters, session idle for 7h59 vs 8h, the 5th vs 6th failed sign-in, marking an outcome at 1 minute before vs the start time.
- **Equivalence classes:** valid and invalid dates, times, emails, statuses and filters.
- **Negative testing:** other patients' data, missing sign-in, malformed requests, server and network failures, a session ending mid-task.
- **State transitions:** booked to cancelled, completed or no-show; cancelling twice; moving an appointment that was already moved; a slot becoming free after a cancellation or move.
- **Concurrency:** two patients confirming the same slot at the same moment from separate browser contexts.

## Known limits
- The server handles requests one at a time, so the race tests check the outcome (exactly one booking) rather than proving a true parallel race.
- Automated accessibility checks find only some accessibility problems.
- The sign-in limit counts failures per email and per network address. Behind a hosting proxy, `TRUST_PROXY` must be set, or every visitor shares the proxy's address.
- Known tool issues and their workarounds are listed in the [test strategy](test-strategy.md#known-issues).
