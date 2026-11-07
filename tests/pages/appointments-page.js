const { expect } = require('@playwright/test');

class AppointmentsPage {
  constructor(page) {
    this.page = page;
    this.dialog = page.getByRole('dialog', { name: 'Cancel this appointment?' });
    this.cancelReason = this.dialog.getByLabel('Reason (optional)');
    this.confirmCancel = this.dialog.getByRole('button', { name: 'Yes, cancel it' });
    this.keep = this.dialog.getByRole('button', { name: 'Keep appointment' });
    this.dialogError = this.dialog.getByRole('alert');
    this.toast = page.getByRole('status');
    // Admin only
    this.filters = page.getByRole('form', { name: 'Filter appointments' });
    this.filterError = this.filters.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/#/appointments');
    await expect(this.page.getByRole('heading', { level: 1, name: /appointments/i })).toBeVisible();
  }

  card(text) {
    return this.page.getByTestId('appointment-card').filter({ hasText: text });
  }

  status(card) {
    return card.getByTestId('appointment-status');
  }

  // Cards in the Upcoming or History section, in the order shown. The section is found by its
  // heading rather than getByRole('region'): in Firefox, a region query followed by an axe scan
  // crashes the page (seen with Playwright 1.65 and @axe-core/playwright 4.14).
  section(name) {
    return this.page.locator('section')
      .filter({ has: this.page.getByRole('heading', { level: 2, name, exact: true }) })
      .getByTestId('appointment-card');
  }

  async openCancelDialog(card) {
    await card.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(this.dialog).toBeVisible();
  }

  async filter({ doctor, from, to, status } = {}) {
    if (doctor !== undefined) await this.filters.getByLabel('Doctor', { exact: true }).selectOption(doctor);
    if (from !== undefined) await this.filters.getByLabel('From', { exact: true }).fill(from);
    if (to !== undefined) await this.filters.getByLabel('To', { exact: true }).fill(to);
    if (status !== undefined) await this.filters.getByLabel('Status', { exact: true }).selectOption(status);
    await this.filters.getByRole('button', { name: 'Apply filters' }).click();
  }

  count(status) {
    return this.page.getByTestId(`count-${status}`);
  }
}

class ReschedulePage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Move appointment' });
    this.current = page.getByTestId('current-appointment');
    this.date = page.getByLabel('New date');
    this.slots = page.getByTestId('slots');
    this.confirm = page.getByRole('button', { name: 'Move appointment' });
    this.error = page.getByRole('main').getByRole('alert');
  }

  slot(time) {
    return this.slots.getByRole('button', { name: time, exact: true });
  }

  async moveTo(date, time) {
    await this.date.fill(date);
    await this.slot(time).click();
    await this.confirm.click();
  }
}

module.exports = { AppointmentsPage, ReschedulePage };
