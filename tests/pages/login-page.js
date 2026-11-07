const { expect } = require('@playwright/test');

class LoginPage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Sign in' });
    this.email = page.getByLabel('Email');
    this.password = page.getByLabel('Password');
    this.submit = page.getByRole('button', { name: 'Sign in' });
    this.error = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/#/login');
    await expect(this.heading).toBeVisible();
  }

  async signIn(email, password) {
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
  }
}

class RegisterPage {
  constructor(page) {
    this.page = page;
    this.name = page.getByLabel('Full name');
    this.email = page.getByLabel('Email');
    this.password = page.getByLabel('Password');
    this.submit = page.getByRole('button', { name: 'Create account' });
    this.error = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/#/register');
    await expect(this.submit).toBeVisible();
  }

  async createAccount({ name, email, password }) {
    await this.name.fill(name);
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
  }
}

module.exports = { LoginPage, RegisterPage };
