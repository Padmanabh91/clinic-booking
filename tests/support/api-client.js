const { TOMORROW } = require('./clinic-time');

// A thin wrapper over the REST API. Each client keeps its own login cookie.
class ApiClient {
  constructor(request) {
    this.request = request;
    this.user = null;
  }

  health() {
    return this.request.get('/api/health');
  }

  register(data) {
    return this.request.post('/api/register', { data });
  }

  login(email, password) {
    return this.request.post('/api/login', { data: { email, password } });
  }

  logout() {
    return this.request.post('/api/logout');
  }

  me() {
    return this.request.get('/api/me');
  }

  changePassword(currentPassword, newPassword) {
    return this.request.post('/api/me/password', { data: { currentPassword, newPassword } });
  }

  config() {
    return this.request.get('/api/config');
  }

  createDoctor(data) {
    return this.request.post('/api/doctors', { data });
  }

  doctors() {
    return this.request.get('/api/doctors');
  }

  allDoctors() {
    return this.request.get('/api/admin/doctors');
  }

  updateDoctor(doctorId, data) {
    return this.request.patch(`/api/doctors/${doctorId}`, { data });
  }

  leaveDays(doctorId) {
    return this.request.get(`/api/doctors/${doctorId}/leave`);
  }

  addLeave(doctorId, data) {
    return this.request.post(`/api/doctors/${doctorId}/leave`, { data });
  }

  removeLeave(doctorId, date) {
    return this.request.delete(`/api/doctors/${doctorId}/leave/${date}`);
  }

  holidays() {
    return this.request.get('/api/holidays');
  }

  addHoliday(data) {
    return this.request.post('/api/holidays', { data });
  }

  removeHoliday(date) {
    return this.request.delete(`/api/holidays/${date}`);
  }

  slots(doctorId, date) {
    return this.request.get(`/api/doctors/${doctorId}/slots`, { params: { date } });
  }

  appointments() {
    return this.request.get('/api/appointments');
  }

  book(doctorId, { date = TOMORROW, time = '10:00', reason = 'Routine check-up' } = {}) {
    return this.request.post('/api/appointments', { data: { doctorId, date, time, reason } });
  }

  cancel(appointmentId, reason) {
    return this.request.post(`/api/appointments/${appointmentId}/cancel`, reason === undefined ? {} : { data: { reason } });
  }

  reschedule(appointmentId, { date, time }) {
    return this.request.post(`/api/appointments/${appointmentId}/reschedule`, { data: { date, time } });
  }

  markOutcome(appointmentId, status) {
    return this.request.post(`/api/appointments/${appointmentId}/outcome`, { data: { status } });
  }

  // filters: { doctorId, from, to, status }, each optional.
  filteredAppointments(filters) {
    return this.request.get('/api/appointments', { params: filters });
  }

  summary(filters = {}) {
    return this.request.get('/api/appointments/summary', { params: filters });
  }
}

module.exports = { ApiClient };
