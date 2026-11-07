const { expect } = require('@playwright/test');

class BookingPage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Book an appointment' });
    this.clinicNote = page.getByTestId('clinic-note');
    this.doctor = page.getByLabel('Doctor');
    this.date = page.getByLabel('Date');
    this.slots = page.getByTestId('slots');
    this.reason = page.getByLabel('Reason for visit');
    this.confirm = page.getByRole('button', { name: 'Confirm booking' });
    this.error = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/#/book');
    await expect(this.heading).toBeVisible();
  }

  slot(time) {
    return this.slots.getByRole('button', { name: time, exact: true });
  }

  async choose(doctor, date) {
    await this.doctor.selectOption(String(doctor.id));
    await this.date.fill(date);
  }

  async book(doctor, { date, time, reason }) {
    await this.choose(doctor, date);
    await this.slot(time).click();
    await this.reason.fill(reason);
    await this.confirm.click();
  }
}

module.exports = { BookingPage };
