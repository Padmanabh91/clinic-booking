const { expect } = require('@playwright/test');

// The dialog that lists booked appointments a schedule change would cancel.
class AffectedAppointmentsDialog {
  constructor(page) {
    this.dialog = page.getByRole('dialog');
    this.list = this.dialog.getByTestId('affected-appointments');
    this.goBack = this.dialog.getByRole('button', { name: 'Go back' });
    this.confirm = this.dialog.getByRole('button', { name: /^Cancel \d+ appointments? and save$/ });
  }
}

class DoctorsPage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Doctors' });
    this.addDoctor = page.getByRole('link', { name: 'Add a doctor' });
    this.dialog = page.getByRole('dialog');
    this.affected = new AffectedAppointmentsDialog(page);
    this.toast = page.getByRole('status');
  }

  async goto() {
    await this.page.goto('/#/doctors');
    await expect(this.heading).toBeVisible();
  }

  card(doctorName) {
    return this.page.getByTestId('doctor-card').filter({ has: this.page.getByRole('heading', { name: doctorName, exact: true }) });
  }

  status(doctorName) {
    return this.card(doctorName).getByTestId('doctor-status');
  }

  async startDeactivating(doctorName) {
    await this.page.getByRole('button', { name: `Deactivate ${doctorName}` }).click();
    await expect(this.dialog).toBeVisible();
    await this.dialog.getByRole('button', { name: 'Deactivate' }).click();
  }
}

class DoctorFormPage {
  constructor(page) {
    this.page = page;
    this.name = page.getByLabel('Name', { exact: true });
    this.specialty = page.getByLabel('Specialty');
    this.save = page.getByRole('button', { name: 'Save doctor' });
    this.error = page.getByRole('main').getByRole('alert');
    this.affected = new AffectedAppointmentsDialog(page);
  }

  day(name) {
    return this.page.getByRole('checkbox', { name });
  }
}

// Leave days for a doctor and clinic holidays share one layout.
class ScheduleDatesPage {
  constructor(page) {
    this.page = page;
    this.date = page.getByLabel('Date', { exact: true });
    this.entries = page.getByTestId('schedule-entry').locator('span'); // the text, without its Remove button
    this.error = page.getByRole('main').getByRole('alert');
    this.affected = new AffectedAppointmentsDialog(page);
    this.toast = page.getByRole('status');
  }

  async gotoLeave(doctor) {
    await this.page.goto(`/#/doctors/${doctor.id}/leave`);
    await expect(this.page.getByRole('heading', { level: 1, name: `Leave days for ${doctor.name}` })).toBeVisible();
    this.note = this.page.getByLabel('Reason (optional)');
    this.add = this.page.getByRole('button', { name: 'Add leave day' });
  }

  async gotoHolidays() {
    await this.page.goto('/#/holidays');
    await expect(this.page.getByRole('heading', { level: 1, name: 'Clinic holidays' })).toBeVisible();
    this.note = this.page.getByLabel('Holiday name');
    this.add = this.page.getByRole('button', { name: 'Add holiday' });
  }

  async addDate(date, note = '') {
    await this.date.fill(date);
    await this.note.fill(note);
    await this.add.click();
  }
}

module.exports = { DoctorsPage, DoctorFormPage, ScheduleDatesPage };
