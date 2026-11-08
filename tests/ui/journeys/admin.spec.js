const { test, expect } = require('../../support/local-app');
const { LoginPage } = require('../../pages/login-page');
const { DoctorsPage, DoctorFormPage, ScheduleDatesPage } = require('../../pages/admin-pages');
const { AppointmentsPage } = require('../../pages/appointments-page');
const { TODAY, TOMORROW } = require('../../support/clinic-time');
const { doctorLabel } = require('../../support/doctors');

// Marking an appointment completed needs its start time to pass, so this journey runs on its
// own copy of the app and moves the clock. The clock starts at Monday 10:00 IST.

test.describe('Admin journey', { tag: '@smoke' }, () => {
  test('sign in, add a doctor, add leave over a booking, mark an appointment completed, filter', async ({ browser, localApp, patient, localPageFor, clock }) => {
    const context = await browser.newContext({ baseURL: localApp.url });
    const page = await context.newPage();
    const doctors = new DoctorsPage(page);
    const appointments = new AppointmentsPage(page);
    const newDoctor = { name: 'Dr. Journey Rao', specialty: 'Cardiology' };
    const { name, specialty } = newDoctor;
    let doctorId;

    await test.step('sign in', async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.signIn('admin@clinic.test', 'Admin@12345');
      await expect(page.getByRole('heading', { level: 1, name: 'All appointments' })).toBeVisible();
    });

    await test.step('add a doctor', async () => {
      await page.getByRole('link', { name: 'Doctors' }).click();
      await doctors.addDoctor.click();
      const form = new DoctorFormPage(page);
      await form.name.fill(name);
      await form.specialty.fill(specialty);
      await form.save.click();
      await expect(doctors.toast).toHaveText(`${doctorLabel(newDoctor)} added.`);
      await expect(doctors.status(newDoctor)).toHaveText('Active');
      doctorId = (await (await patient.doctors()).json()).find((d) => d.name === name).id;
    });

    await test.step('the patient books with the new doctor, today and tomorrow', async () => {
      expect((await patient.book(doctorId, { date: TODAY, time: '10:30', reason: 'Chest pain' })).status()).toBe(201);
      expect((await patient.book(doctorId, { date: TOMORROW, time: '11:00', reason: 'Follow-up' })).status()).toBe(201);
    });

    await test.step('add a leave day over the booking, see it listed, and confirm', async () => {
      const leave = new ScheduleDatesPage(page);
      await leave.gotoLeave({ id: doctorId, ...newDoctor });
      await leave.addDate(TOMORROW, 'Conference');
      await expect(leave.affected.list).toHaveText(`Tue, 8 Jan 2030 at 11:00: ${patient.user.name} with ${doctorLabel(newDoctor)}`);
      await leave.affected.confirm.click();
      await expect(leave.toast).toHaveText('Leave day added. 1 appointment cancelled.');
    });

    await test.step('the patient sees why it was cancelled', async () => {
      const mine = new AppointmentsPage(await localPageFor(patient));
      await mine.goto();
      await expect(mine.card('Follow-up').getByTestId('cancel-reason'))
        .toHaveText(`Cancelled by the clinic: ${name} is on leave on this day.`);
    });

    await test.step("once today's appointment has started, mark it completed", async () => {
      clock.advance(30); // 10:30
      await appointments.goto();
      await appointments.card('Chest pain').getByRole('button', { name: 'Mark completed' }).click();
      await expect(appointments.toast).toHaveText('Marked as completed.');
      await expect(appointments.status(appointments.card('Chest pain'))).toHaveText('Completed');
    });

    await test.step("filter to the doctor and check the summary", async () => {
      await appointments.filter({ doctor: String(doctorId) });
      await expect(appointments.count('booked')).toHaveText('0');
      await expect(appointments.count('cancelled')).toHaveText('1');
      await expect(appointments.count('completed')).toHaveText('1');
      await expect(appointments.count('no-show')).toHaveText('0');
      await expect(appointments.count('total')).toHaveText('2');
      await expect(appointments.section('History').locator('.reason')).toHaveText(['Follow-up', 'Chest pain']);
    });

    await context.close();
  });
});
