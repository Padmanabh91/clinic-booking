const { test, expect } = require('../support/fixtures');
const { DoctorsPage, DoctorFormPage, ScheduleDatesPage } = require('../pages/admin-pages');
const { BookingPage } = require('../pages/booking-page');
const { AppointmentsPage } = require('../pages/appointments-page');
const { TOMORROW } = require('../support/clinic-time');
const { doctorLabel } = require('../support/doctors');

// Each test changes only its own doctor. Holidays close the clinic for everyone, so their
// UI tests run on separate copies of the app in clinic-wide.spec.js.

test.describe('Adding and editing doctors', () => {
  test('an admin adds a doctor', { tag: '@regression' }, async ({ adminPage }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await doctors.addDoctor.click();
    const form = new DoctorFormPage(adminPage);
    const name = `Dr. New ${Date.now()}`;
    const added = { name, specialty: 'Cardiology' };

    await form.name.fill(name);
    await form.specialty.fill('Cardiology');
    await form.day('Tuesday').uncheck();
    await form.day('Thursday').uncheck();
    await form.save.click();

    await expect(doctors.toast).toHaveText(`${doctorLabel(added)} added.`);
    await expect(doctors.status(added)).toHaveText('Active');
    await expect(doctors.card(added)).toContainText('Works Mon, Wed, Fri');
  });

  test('an admin edits a doctor', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await adminPage.getByRole('link', { name: `Edit ${doctorLabel(doctor)}`, exact: true }).click();
    const form = new DoctorFormPage(adminPage);
    await expect(form.name).toHaveValue(doctor.name);

    const edited = { ...doctor, specialty: 'Dermatology' };
    await form.specialty.fill(edited.specialty);
    await form.day('Saturday').check();
    await form.save.click();

    await expect(doctors.toast).toHaveText(`${doctorLabel(edited)} saved.`);
    await expect(doctors.card(edited)).toContainText('Works Mon, Tue, Wed, Thu, Fri, Sat');
  });

  test('removing a working day with bookings shows them, and Go back changes nothing', { tag: '@regression' }, async ({ adminPage, admin, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '10:00' });
    await adminPage.goto(`/#/doctors/${doctor.id}`);
    const form = new DoctorFormPage(adminPage);

    await form.day('Tuesday').uncheck();
    await form.save.click();

    await expect(form.affected.list).toHaveText(`Tue, 8 Jan 2030 at 10:00: ${patient.user.name} with ${doctorLabel(doctor)}`);
    await form.affected.goBack.click();
    await expect(form.affected.dialog).toBeHidden();
    const saved = (await (await admin.allDoctors()).json()).find((d) => d.id === doctor.id);
    expect(saved.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  test('an unknown doctor address explains the problem', { tag: '@regression' }, async ({ adminPage }) => {
    await adminPage.goto('/#/doctors/999999');

    await expect(adminPage.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible();
    await expect(adminPage.getByRole('alert')).toHaveText('Doctor not found.');
  });
});

test.describe('Deactivating doctors', () => {
  test('asks first, then patients can no longer choose the doctor', { tag: '@regression' }, async ({ adminPage, patientPage, doctor }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();

    await doctors.startDeactivating(doctor);

    await expect(doctors.toast).toHaveText(`${doctorLabel(doctor)} deactivated.`);
    await expect(doctors.status(doctor)).toHaveText('Inactive');
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await expect(booking.doctor.locator(`option[value="${doctor.id}"]`)).toHaveCount(0);
  });

  test('Keep active leaves the doctor bookable', { tag: '@regression' }, async ({ adminPage, doctor }) => {
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();
    await adminPage.getByRole('button', { name: `Deactivate ${doctorLabel(doctor)}`, exact: true }).click();

    await doctors.dialog.getByRole('button', { name: 'Keep active' }).click();

    await expect(doctors.dialog).toBeHidden();
    await expect(doctors.status(doctor)).toHaveText('Active');
  });

  test('with bookings, lists them and cancels them only once confirmed', { tag: '@regression' }, async ({ adminPage, patientPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '11:00' });
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();

    await doctors.startDeactivating(doctor);
    await expect(doctors.affected.list).toHaveText(`Tue, 8 Jan 2030 at 11:00: ${patient.user.name} with ${doctorLabel(doctor)}`);
    await doctors.affected.confirm.click();

    await expect(doctors.toast).toHaveText(`${doctorLabel(doctor)} deactivated. 1 appointment cancelled.`);
    await expect(doctors.status(doctor)).toHaveText('Inactive');
    const appointments = new AppointmentsPage(patientPage);
    await appointments.goto();
    const card = appointments.card(doctor.name);
    await expect(appointments.status(card)).toHaveText('Cancelled');
    await expect(card.getByTestId('cancel-reason'))
      .toHaveText(`Cancelled by the clinic: ${doctor.name} is no longer taking appointments.`);
  });

  test('an inactive doctor can be reactivated', { tag: '@regression' }, async ({ adminPage, admin, doctor }) => {
    await admin.updateDoctor(doctor.id, { active: false });
    const doctors = new DoctorsPage(adminPage);
    await doctors.goto();

    await adminPage.getByRole('button', { name: `Reactivate ${doctorLabel(doctor)}`, exact: true }).click();

    await expect(doctors.toast).toHaveText(`${doctorLabel(doctor)} reactivated.`);
    await expect(doctors.status(doctor)).toHaveText('Active');
  });
});

test.describe('Leave days', () => {
  test('an admin adds and removes a leave day, and patients see the day closed meanwhile', { tag: '@regression' }, async ({ adminPage, patientPage, doctor }) => {
    const leave = new ScheduleDatesPage(adminPage);
    await leave.gotoLeave(doctor);

    await leave.addDate(TOMORROW, 'Conference');

    await expect(leave.toast).toHaveText('Leave day added.');
    await expect(leave.entries).toHaveText(['Tue, 8 Jan 2030: Conference']);
    const booking = new BookingPage(patientPage);
    await booking.goto();
    await booking.choose(doctor, TOMORROW);
    await expect(booking.slots).toHaveText(`${doctor.name} is on leave on this day.`);

    await adminPage.getByRole('button', { name: 'Remove leave on Tue, 8 Jan 2030' }).click();

    await expect(leave.toast).toHaveText('Leave day removed.');
    await expect(leave.entries).toHaveCount(0);
    await expect(adminPage.getByText('No leave days coming up.')).toBeVisible();
  });

  test('a leave day with bookings cancels them only once confirmed', { tag: '@regression' }, async ({ adminPage, patient, doctor }) => {
    await patient.book(doctor.id, { date: TOMORROW, time: '15:30' });
    const leave = new ScheduleDatesPage(adminPage);
    await leave.gotoLeave(doctor);

    await leave.addDate(TOMORROW);
    await expect(leave.affected.list).toHaveText(`Tue, 8 Jan 2030 at 15:30: ${patient.user.name} with ${doctorLabel(doctor)}`);
    await leave.affected.confirm.click();

    await expect(leave.toast).toHaveText('Leave day added. 1 appointment cancelled.');
    await expect(leave.entries).toHaveText(['Tue, 8 Jan 2030']);
  });

  test('a day already on leave shows the reason it was refused', { tag: '@regression' }, async ({ adminPage, admin, doctor }) => {
    await admin.addLeave(doctor.id, { date: TOMORROW });
    const leave = new ScheduleDatesPage(adminPage);
    await leave.gotoLeave(doctor);

    await leave.addDate(TOMORROW);

    await expect(leave.error).toHaveText('That day is already a leave day.');
  });
});

test.describe('Admin pages are for admins', () => {
  for (const address of ['#/doctors', '#/doctors/new', '#/holidays']) {
    test(`a patient opening ${address} goes to the booking page`, { tag: '@regression' }, async ({ patientPage }) => {
      await patientPage.goto(`/${address}`);

      await expect(new BookingPage(patientPage).heading).toBeVisible();
      await expect(patientPage).toHaveURL(/#\/book$/);
    });
  }

  test('an admin has links to doctors and holidays', { tag: '@regression' }, async ({ adminPage }) => {
    await adminPage.goto('/#/appointments');

    await adminPage.getByRole('link', { name: 'Doctors' }).click();
    await expect(new DoctorsPage(adminPage).heading).toBeFocused();
    await expect(adminPage).toHaveTitle('Doctors | Clinic Booking, Bangalore');
    await adminPage.getByRole('link', { name: 'Holidays' }).click();
    await expect(adminPage.getByRole('heading', { level: 1, name: 'Clinic holidays' })).toBeFocused();
  });

  test('a patient has no links to them', { tag: '@regression' }, async ({ patientPage }) => {
    await new BookingPage(patientPage).goto();

    await expect(patientPage.getByRole('link', { name: 'Doctors' })).toHaveCount(0);
    await expect(patientPage.getByRole('link', { name: 'Holidays' })).toHaveCount(0);
    await expect(patientPage.getByRole('navigation')).not.toContainText('false');
  });
});
