const { test, expect } = require('../support/local-app');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TOMORROW } = require('../support/clinic-time');

// Each test runs its own copy of the app with deliberately awkward content (the longest
// unbroken names and reasons the API allows), so the result never depends on what other
// tests happened to leave on a shared server.

const PHONE = { width: 375, height: 740 };
const ASHA_RAO = 1; // seeded doctor, Monday to Friday

// The outermost elements that stick out past the right edge (empty when the page fits),
// so a failure names the culprit instead of just saying the page is too wide.
const overflowing = (page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  const sticksOut = (e) => e.getBoundingClientRect().right > width + 0.5;
  return [...document.querySelectorAll('body *')]
    .filter((e) => sticksOut(e) && !sticksOut(e.parentElement))
    .map((e) => `<${e.tagName.toLowerCase()}${e.className ? ` class="${e.className}"` : ''}> "${e.textContent.trim().slice(0, 40)}"`);
});

async function expectEachFits(page, addresses) {
  for (const address of addresses) {
    await page.goto(address);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('loading')).toHaveCount(0);
    await expect(page.getByTestId('list-loading')).toHaveCount(0);
    expect(await overflowing(page), address).toEqual([]);
  }
}

async function addAwkwardContent({ admin, patient }) {
  const doctor = await (await admin.createDoctor({ name: `Dr.${'Z'.repeat(77)}`, specialty: 'S'.repeat(80) })).json();
  const booked = await (await patient.book(doctor.id, { date: TOMORROW, time: '10:00', reason: 'x'.repeat(200) })).json();
  const cancelled = await (await patient.book(ASHA_RAO, { date: TOMORROW, time: '11:00', reason: 'y'.repeat(200) })).json();
  await patient.cancel(cancelled.id, 'z'.repeat(200));
  await admin.addLeave(doctor.id, { date: '2030-01-09', reason: 'L'.repeat(100) });
  await admin.addHoliday({ date: '2030-01-26', name: 'H'.repeat(80) });
  return { doctor, booked };
}

test.describe('Phone layout at 375px wide, with the longest names and reasons allowed', () => {
  test('sign-in and registration fit', { tag: '@regression' }, async ({ newClient, localPageFor }) => {
    const page = await localPageFor(await newClient());
    await page.setViewportSize(PHONE);

    await expectEachFits(page, ['/#/login', '/#/register']);
  });

  test("a patient's screens fit, including the cancel dialog", { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    const { doctor, booked } = await addAwkwardContent({ admin, patient });
    const page = await localPageFor(patient);
    await page.setViewportSize(PHONE);

    await expectEachFits(page, ['/#/book', '/#/appointments', `/#/appointments/${booked.id}/reschedule`, '/#/password']);

    const appointments = new AppointmentsPage(page);
    await appointments.goto();
    await appointments.openCancelDialog(appointments.card(doctor.name));
    const box = await appointments.dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(await overflowing(page)).toEqual([]);
  });

  test("an admin's screens fit, and every menu link is visible", { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    const { doctor } = await addAwkwardContent({ admin, patient });
    const page = await localPageFor(admin);
    await page.setViewportSize(PHONE);

    await expectEachFits(page, ['/#/appointments', '/#/doctors', '/#/doctors/new', `/#/doctors/${doctor.id}`,
      `/#/doctors/${doctor.id}/leave`, '/#/holidays']);

    for (const name of ['All appointments', 'Doctors', 'Holidays', 'Change password']) {
      await expect(page.getByRole('navigation').getByRole('link', { name, exact: true })).toBeInViewport();
    }
  });

  test('the admin list still fits with filters applied and the summary shown', { tag: '@regression' }, async ({ admin, patient, localPageFor }) => {
    const { doctor } = await addAwkwardContent({ admin, patient });
    const page = await localPageFor(admin);
    await page.setViewportSize(PHONE);
    const appointments = new AppointmentsPage(page);
    await appointments.goto();

    await appointments.filter({ doctor: String(doctor.id), from: TOMORROW, to: TOMORROW });

    await expect(appointments.count('total')).toHaveText('1');
    expect(await overflowing(page)).toEqual([]);
  });
});
