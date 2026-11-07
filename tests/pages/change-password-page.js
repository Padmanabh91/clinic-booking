const { expect } = require('@playwright/test');

class ChangePasswordPage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { level: 1, name: 'Change password' });
    this.current = page.getByLabel('Current password');
    this.next = page.getByLabel('New password');
    this.submit = page.getByRole('main').getByRole('button', { name: 'Change password' });
    this.error = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/#/password');
    await expect(this.heading).toBeVisible();
  }

  async change(currentPassword, newPassword) {
    await this.current.fill(currentPassword);
    await this.next.fill(newPassword);
    await this.submit.click();
  }
}

module.exports = { ChangePasswordPage };
