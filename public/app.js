const appEl = document.getElementById('app');
const navEl = document.getElementById('nav');
const toastEl = document.getElementById('toast');
const SITE_TITLE = 'Clinic Booking, Bangalore';
let currentUser = null;
let toastTimer;
let firstRender = true;
let loadingTimer;
let loginNotice = '';
// The admin's appointment filters stay while moving around the app.
let appointmentFilters = {};

// While an async click or submit handler runs, its button is marked busy and repeat clicks or
// submits are ignored, so a slow request can't be sent twice. aria-disabled is used instead of
// disabled because disabling a focused button would throw keyboard focus back to the page.
function busyWhile(kind, handler) {
  return (event) => {
    const owner = event.currentTarget;
    if (kind === 'submit') event.preventDefault();
    if (owner.dataset.busy) return;
    const result = handler(event);
    if (!(result instanceof Promise)) return;
    const button = kind === 'submit' ? owner.querySelector('button[type="submit"]') : owner;
    owner.dataset.busy = 'true';
    button?.setAttribute('aria-disabled', 'true');
    const done = () => {
      delete owner.dataset.busy;
      button?.removeAttribute('aria-disabled');
    };
    result.then(done, done);
  };
}

// Builds elements with textContent, so user-entered text is never parsed as HTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'onsubmit' || (key === 'onclick' && tag === 'button')) node.addEventListener(key.slice(2), busyWhile(key.slice(2), value));
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

class ApiError extends Error {
  constructor(message, { code, status, sessionEnded = false, details = {} } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details; // the whole error the server sent, e.g. the appointments in the way
    // The app has already sent the user to sign-in, so callers should not show this error.
    this.sessionEnded = sessionEnded;
  }
}

const MESSAGES = {
  offline: "We couldn't reach the clinic. Check your connection and try again.",
  server: 'Something went wrong on our side. Please try again.',
  sessionEnded: 'Your session has ended. Please sign in again.',
};

// Signed-in calls that come back unauthenticated mean the session ended, so go to sign-in.
function endSession() {
  currentUser = null;
  appointmentFilters = {};
  loginNotice = MESSAGES.sessionEnded;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  go('#/login');
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(MESSAGES.offline, { code: 'NETWORK_ERROR', status: 0 });
  }

  let data = null;
  if (response.status !== 204) {
    // A proxy or crash can send back HTML instead of JSON.
    try { data = await response.json(); } catch { data = null; }
  }

  if (!response.ok) {
    const code = data?.error?.code || 'SERVER_ERROR';
    if (code === 'UNAUTHENTICATED' && currentUser) {
      endSession();
      throw new ApiError(MESSAGES.sessionEnded, { code, status: response.status, sessionEnded: true });
    }
    throw new ApiError(data?.error?.message || MESSAGES.server, { code, status: response.status, details: data?.error });
  }
  if (data === null && response.status !== 204) {
    throw new ApiError(MESSAGES.server, { code: 'SERVER_ERROR', status: response.status });
  }
  return data;
}

// Shows a short message. Errors use { error: true } so they don't look like a success.
function toast(message, { error = false } = {}) {
  toastEl.classList.toggle('error', error);
  toastEl.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.textContent = ''; }, 6000);
}

// Monday first, as the clinic's week is shown. Values match the API (0 is Sunday).
const DAYS = [
  [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday'],
].map(([value, name]) => ({ value, name, short: name.slice(0, 3) }));
const dayList = (days) => DAYS.filter((d) => days.includes(d.value)).map((d) => d.short).join(', ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const formatDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function field(label, input) {
  return el('div', {}, el('label', { for: input.id, text: label }), input);
}

// Shows a screen with its heading and page title. After the first screen, focus moves
// to the heading so keyboard and screen reader users start at the new content.
function showScreen(title, ...content) {
  clearTimeout(loadingTimer);
  appEl.removeAttribute('aria-busy');
  document.title = `${title} | ${SITE_TITLE}`;
  const heading = el('h1', { tabindex: '-1', text: title });
  appEl.replaceChildren(heading, ...content.filter(Boolean));
  if (!firstRender) heading.focus();
}

// Changing the hash already triggers render, so only render directly when it won't change.
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const homeRoute = () => (currentUser?.role === 'admin' ? '#/appointments' : '#/book');

function renderNav() {
  navEl.replaceChildren();
  if (!currentUser) return;
  const isAdmin = currentUser.role === 'admin';
  if (!isAdmin) navEl.append(el('a', { href: '#/book', text: 'Book appointment' }));
  navEl.append(el('a', { href: '#/appointments', text: isAdmin ? 'All appointments' : 'My appointments' }));
  if (isAdmin) {
    navEl.append(el('a', { href: '#/doctors', text: 'Doctors' }), el('a', { href: '#/holidays', text: 'Holidays' }));
  }
  navEl.append(
    el('a', { href: '#/password', text: 'Change password' }),
    el('span', { 'data-testid': 'current-user', text: currentUser.name }),
    el('button', {
      class: 'link', type: 'button', text: 'Log out',
      onclick: async () => {
        try {
          await api('/logout', { method: 'POST' });
          currentUser = null;
          appointmentFilters = {};
          go('#/login');
        } catch (e) {
          if (!e.sessionEnded) toast(e.message, { error: true });
        }
      },
    }),
  );
}

function renderLogin() {
  const email = el('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = el('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = el('p', { class: 'error', role: 'alert', text: loginNotice });
  loginNotice = '';
  showScreen('Sign in',
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try {
            currentUser = await api('/login', { method: 'POST', body: { email: email.value, password: password.value } });
            go(homeRoute());
          } catch (e) { error.textContent = e.message; }
        },
      },
      field('Email', email), field('Password', password), error,
      el('button', { type: 'submit', text: 'Sign in' })),
    ),
    el('p', {}, 'New here? ', el('a', { href: '#/register', text: 'Create an account' })),
  );
}

function renderRegister() {
  const name = el('input', { id: 'name', autocomplete: 'name', required: true });
  const email = el('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = el('input', { id: 'password', type: 'password', autocomplete: 'new-password', required: true });
  const error = el('p', { class: 'error', role: 'alert' });
  showScreen('Create an account',
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try {
            currentUser = await api('/register', {
              method: 'POST', body: { name: name.value, email: email.value, password: password.value },
            });
            go(homeRoute());
          } catch (e) { error.textContent = e.message; }
        },
      },
      field('Full name', name), field('Email', email), field('Password (at least 8 characters)', password), error,
      el('button', { type: 'submit', text: 'Create account' })),
    ),
    el('p', {}, 'Already registered? ', el('a', { href: '#/login', text: 'Sign in' })),
  );
}

function renderChangePassword() {
  const current = el('input', { id: 'current-password', type: 'password', autocomplete: 'current-password', required: true });
  const next = el('input', { id: 'new-password', type: 'password', autocomplete: 'new-password', required: true });
  const error = el('p', { class: 'error', role: 'alert' });
  showScreen('Change password',
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try {
            await api('/me/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
            toast('Password changed. Any other devices have been signed out.');
            go(homeRoute());
          } catch (e) {
            if (!e.sessionEnded) error.textContent = e.message;
          }
        },
      },
      field('Current password', current), field('New password (at least 8 characters)', next), error,
      el('button', { type: 'submit', text: 'Change password' })),
    ),
  );
}

// Shows a doctor's slots for a date as buttons to choose from. If the doctor or date changes
// while slots are loading, only the latest answer is shown. onError shows a loading error.
function slotPicker(onError) {
  const element = el('div', { class: 'slots', 'data-testid': 'slots' });
  let latestRequest = 0;
  let selected = null;

  async function load(doctorId, date) {
    const request = ++latestRequest;
    selected = null;
    element.replaceChildren();
    if (!date) return;
    element.setAttribute('aria-busy', 'true');
    element.replaceChildren(el('p', { class: 'muted', 'data-testid': 'slots-loading', text: 'Loading times…' }));
    let result;
    try {
      result = await api(`/doctors/${doctorId}/slots?date=${date}`);
    } catch (e) {
      if (request === latestRequest) {
        element.removeAttribute('aria-busy');
        element.replaceChildren();
        if (!e.sessionEnded) onError(e.message);
      }
      return;
    }
    if (request !== latestRequest) return; // the doctor or date changed while this was loading
    element.removeAttribute('aria-busy');
    if (!result.working) {
      element.replaceChildren(el('p', { class: 'muted', text: result.message || 'The doctor does not work on this day.' }));
      return;
    }
    element.replaceChildren(...result.slots.map((slot) => {
      const button = el('button', {
        type: 'button', class: 'slot', text: slot.time, disabled: !slot.available, 'aria-pressed': 'false',
        onclick: () => {
          selected = slot.time;
          element.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        },
      });
      return button;
    }));
  }

  return { element, load, selected: () => selected };
}

async function renderBook() {
  const [doctors, config] = await Promise.all([api('/doctors'), api('/config')]);
  const clinicNote = el('p', { class: 'note', 'data-testid': 'clinic-note', text: `Clinic location: ${config.city}. All times are in ${config.city} time (${config.timeZoneLabel}).` });

  if (doctors.length === 0) {
    showScreen('Book an appointment', clinicNote,
      el('div', { class: 'card' },
        el('p', { 'data-testid': 'no-doctors', text: 'No doctors are available for booking right now. Please check back later.' })));
    return;
  }

  const doctor = el('select', { id: 'doctor', required: true },
    ...doctors.map((d) => el('option', { value: d.id, text: `${d.name} (${d.specialty})` })));
  const date = el('input', { id: 'date', type: 'date', required: true, min: config.today, max: config.lastBookableDate, value: config.today });
  const reason = el('textarea', { id: 'reason', rows: 3, maxlength: 200, required: true });
  const error = el('p', { class: 'error', role: 'alert' });
  const picker = slotPicker((message) => { error.textContent = message; });

  let loadedFor = null;
  function loadSlots() {
    loadedFor = `${doctor.value}|${date.value}`;
    return picker.load(doctor.value, date.value);
  }

  // Browsers differ in when date inputs fire input and change, so listen for both.
  // Skipping unchanged values keeps the chosen slot when change fires later, on blur.
  function reloadIfChanged() {
    if (`${doctor.value}|${date.value}` !== loadedFor) {
      error.textContent = '';
      loadSlots();
    }
  }
  doctor.addEventListener('change', reloadIfChanged);
  date.addEventListener('input', reloadIfChanged);
  date.addEventListener('change', reloadIfChanged);

  showScreen('Book an appointment',
    clinicNote,
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          if (!picker.selected()) { error.textContent = 'Choose a time slot.'; return; }
          try {
            await api('/appointments', {
              method: 'POST',
              body: { doctorId: Number(doctor.value), date: date.value, time: picker.selected(), reason: reason.value },
            });
            toast('Appointment booked successfully');
            location.hash = '#/appointments';
          } catch (e) {
            if (e.sessionEnded) return;
            await loadSlots();
            error.textContent = e.message;
          }
        },
      },
      field('Doctor', doctor),
      field('Date', date),
      el('fieldset', {}, el('legend', { text: 'Available times' }), picker.element),
      field('Reason for visit', reason),
      error,
      el('button', { type: 'submit', text: 'Confirm booking' })),
    ),
  );
  await loadSlots();
}

let dialogCount = 0;

// Opens a modal dialog with a button to back out and a button to go ahead. onConfirm gets
// close() to call when it is done; if it throws, the error is shown in the dialog.
function openDialog({ title, body, keepText, confirmText, onConfirm }) {
  dialogCount += 1;
  const titleId = `dialog-title-${dialogCount}`;
  const errorEl = el('p', { class: 'error', role: 'alert' });
  const dialog = el('dialog', { 'aria-labelledby': titleId }, el('h2', { id: titleId, text: title }), ...body, errorEl);
  const close = () => dialog.close();
  dialog.append(el('div', { class: 'actions' },
    el('button', { type: 'button', class: 'secondary', text: keepText, onclick: close }),
    el('button', {
      type: 'button', class: 'danger', text: confirmText,
      onclick: async () => {
        errorEl.textContent = '';
        try {
          await onConfirm(close);
        } catch (e) {
          if (!e.sessionEnded) errorEl.textContent = e.message;
        }
      },
    }),
  ));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function confirmCancel(appointment) {
  const reason = el('textarea', { id: 'cancel-reason-input', rows: 2, maxlength: 200 });
  openDialog({
    title: 'Cancel this appointment?',
    body: [
      el('p', { text: `${appointment.doctorName}, ${formatDate(appointment.date)} at ${appointment.time}` }),
      field('Reason (optional)', reason),
    ],
    keepText: 'Keep appointment',
    confirmText: 'Yes, cancel it',
    onConfirm: async (close) => {
      await api(`/appointments/${appointment.id}/cancel`, { method: 'POST', body: { reason: reason.value } });
      close();
      toast('Appointment cancelled successfully');
      await renderAppointments();
    },
  });
}

const STATUS_LABELS = { booked: 'Booked', cancelled: 'Cancelled', completed: 'Completed', 'no-show': 'No-show' };
const when = (a) => `${formatDate(a.date)} at ${a.time}`;
const queryString = (filters) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return query ? `?${query}` : '';
};

async function markOutcome(appointment, status) {
  try {
    await api(`/appointments/${appointment.id}/outcome`, { method: 'POST', body: { status } });
    toast(`Marked as ${STATUS_LABELS[status].toLowerCase()}.`);
    await renderAppointments();
  } catch (e) {
    if (!e.sessionEnded) toast(e.message, { error: true });
  }
}

function appointmentCard(a, { config, isAdmin, started, byId }) {
  const movedTo = a.rescheduledToId && byId.get(a.rescheduledToId);
  const movedFrom = a.rescheduledFromId && byId.get(a.rescheduledFromId);
  const upcoming = a.status === 'booked' && !started;
  return el('article', { class: 'card', 'data-testid': 'appointment-card' },
    el('div', { class: 'row' },
      el('h3', { text: a.doctorName }),
      el('span', {
        class: `status ${a.status}`, 'data-testid': 'appointment-status',
        text: a.rescheduledToId ? 'Rescheduled' : STATUS_LABELS[a.status],
      })),
    el('p', { class: 'muted', text: `${a.specialty} · ${config.city}` }),
    el('p', { class: 'muted', text: `${formatDate(a.date)} at ${a.time} ${config.timeZoneLabel}` }),
    isAdmin && el('p', { class: 'muted', text: `Patient: ${a.patientName}` }),
    el('p', { class: 'reason', text: a.reason }),
    a.rescheduledToId && el('p', { class: 'muted', 'data-testid': 'moved', text: movedTo ? `Moved to ${when(movedTo)}.` : 'Moved to a new time.' }),
    a.rescheduledFromId && el('p', { class: 'muted', 'data-testid': 'moved', text: movedFrom ? `Moved from ${when(movedFrom)}.` : 'Moved from an earlier time.' }),
    a.status === 'cancelled' && !a.rescheduledToId && a.cancelledBy
      && el('p', { class: 'muted', 'data-testid': 'cancel-reason', text: `Cancelled by the ${a.cancelledBy}: ${a.cancelReason}` }),
    (upcoming || (isAdmin && a.status === 'booked')) && el('div', { class: 'actions start' },
      upcoming && !isAdmin && el('a', { class: 'button secondary', href: `#/appointments/${a.id}/reschedule`, text: 'Reschedule' }),
      upcoming && el('button', { type: 'button', class: 'secondary', text: 'Cancel appointment', onclick: () => confirmCancel(a) }),
      isAdmin && !upcoming && el('button', { type: 'button', class: 'secondary', text: 'Mark completed', onclick: () => markOutcome(a, 'completed') }),
      isAdmin && !upcoming && el('button', { type: 'button', class: 'secondary', text: 'Mark no-show', onclick: () => markOutcome(a, 'no-show') })),
  );
}

// Upcoming: booked and not started yet, soonest first. History: everything else, most recent first.
function appointmentSections(appointments, config, isAdmin) {
  // Dates and times are fixed-width Bangalore-local strings, so they compare as text.
  const hasStarted = (a) => `${a.date}T${a.time}` <= config.now;
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const isUpcoming = (a) => a.status === 'booked' && !hasStarted(a);
  const card = (a) => appointmentCard(a, { config, isAdmin, started: hasStarted(a), byId });
  const section = (id, title, items, emptyText) => el('section', { 'aria-labelledby': id },
    el('h2', { id, text: title }),
    ...(items.length ? items.map(card) : [el('p', { class: 'muted', text: emptyText })]));
  return [
    section('upcoming-title', 'Upcoming', appointments.filter(isUpcoming), 'No upcoming appointments.'),
    section('history-title', 'History', appointments.filter((a) => !isUpcoming(a)).reverse(), 'No past or cancelled appointments.'),
  ];
}

function showSummary(container, { counts, total }) {
  const entry = (label, value, id) => el('div', {}, el('dt', { text: label }), el('dd', { 'data-testid': `count-${id}`, text: String(value) }));
  container.replaceChildren(
    el('h2', { id: 'summary-title', text: 'Summary' }),
    el('dl', { class: 'summary' },
      ...Object.entries(STATUS_LABELS).map(([status, label]) => entry(label, counts[status], status)),
      entry('Total', total, 'total')),
  );
}

// Filters for the admin's list. They only replace the saved filters once the server accepts
// them, so a bad combination can't leave the page stuck on an error.
function filterForm(doctors, load) {
  const error = el('p', { class: 'error', role: 'alert' });
  const doctor = el('select', { id: 'filter-doctor' }, el('option', { value: '', text: 'All doctors' }),
    ...doctors.map((d) => el('option', { value: d.id, text: d.active ? d.name : `${d.name} (inactive)` })));
  const from = el('input', { id: 'filter-from', type: 'date' });
  const to = el('input', { id: 'filter-to', type: 'date' });
  const status = el('select', { id: 'filter-status' }, el('option', { value: '', text: 'All statuses' }),
    ...Object.entries(STATUS_LABELS).map(([value, text]) => el('option', { value, text })));
  const fields = { doctorId: doctor, from, to, status };
  for (const [key, input] of Object.entries(fields)) input.value = appointmentFilters[key] ?? '';

  async function apply(filters) {
    error.textContent = '';
    const previous = appointmentFilters;
    appointmentFilters = filters;
    try {
      await load();
    } catch (e) {
      appointmentFilters = previous;
      if (!e.sessionEnded) error.textContent = e.message;
    }
  }

  return el('form', {
    class: 'card filters', 'aria-label': 'Filter appointments',
    onsubmit: () => apply(Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]))),
  },
  el('div', { class: 'filter-fields' },
    field('Doctor', doctor), field('From', from), field('To', to), field('Status', status)),
  error,
  el('div', { class: 'actions start' },
    el('button', { type: 'submit', text: 'Apply filters' }),
    el('button', {
      type: 'button', class: 'secondary', text: 'Clear filters',
      onclick: () => {
        Object.values(fields).forEach((input) => { input.value = ''; });
        return apply({});
      },
    })));
}

async function renderAppointments() {
  const isAdmin = currentUser.role === 'admin';
  const [config, doctors] = await Promise.all([api('/config'), isAdmin ? api('/admin/doctors') : []]);
  const list = el('div', { 'data-testid': 'appointment-list' });
  const summary = isAdmin && el('section', { class: 'card', 'aria-labelledby': 'summary-title' });

  async function load() {
    list.setAttribute('aria-busy', 'true');
    // The first load has nothing to show yet; later loads keep the old list until the new one arrives.
    if (!list.hasChildNodes()) list.replaceChildren(el('p', { class: 'muted', 'data-testid': 'list-loading', text: 'Loading appointments…' }));
    try {
      const [appointments, counts] = await Promise.all([
        api(`/appointments${queryString(appointmentFilters)}`),
        isAdmin ? api(`/appointments/summary${queryString({ ...appointmentFilters, status: '' })}`) : null,
      ]);
      if (isAdmin) showSummary(summary, counts);
      const filtered = Object.values(appointmentFilters).some(Boolean);
      list.replaceChildren(...(appointments.length === 0 && filtered
        ? [el('p', { class: 'muted', 'data-testid': 'no-matches', text: 'No appointments match these filters. Try a wider date range, or clear the filters.' })]
        : appointmentSections(appointments, config, isAdmin)));
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  showScreen(isAdmin ? 'All appointments' : 'My appointments',
    isAdmin && filterForm(doctors, load),
    summary,
    list,
  );
  await load();
}

// Moves a booked appointment to another free slot with the same doctor.
async function renderReschedule(id) {
  const [appointments, config] = await Promise.all([api('/appointments'), api('/config')]);
  const appointment = appointments.find((a) => a.id === id);
  if (!appointment || appointment.status !== 'booked') throw new Error('That appointment can no longer be moved.');

  const date = el('input', { id: 'date', type: 'date', required: true, min: config.today, max: config.lastBookableDate, value: appointment.date });
  const error = el('p', { class: 'error', role: 'alert' });
  const picker = slotPicker((message) => { error.textContent = message; });
  let loadedFor = null;
  const loadSlots = () => {
    loadedFor = date.value;
    return picker.load(appointment.doctorId, date.value);
  };
  const reloadIfChanged = () => {
    if (date.value !== loadedFor) {
      error.textContent = '';
      loadSlots();
    }
  };
  date.addEventListener('input', reloadIfChanged);
  date.addEventListener('change', reloadIfChanged);

  showScreen('Move appointment',
    el('p', {
      class: 'note', 'data-testid': 'current-appointment',
      text: `Currently ${when(appointment)} ${config.timeZoneLabel} with ${appointment.doctorName}.`,
    }),
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          if (!picker.selected()) { error.textContent = 'Choose a time slot.'; return; }
          try {
            const moved = await api(`/appointments/${id}/reschedule`, {
              method: 'POST', body: { date: date.value, time: picker.selected() },
            });
            toast(`Appointment moved to ${when(moved)}.`);
            location.hash = '#/appointments';
          } catch (e) {
            if (e.sessionEnded) return;
            await loadSlots();
            error.textContent = e.message;
          }
        },
      },
      field('New date', date),
      el('fieldset', {}, el('legend', { text: 'Available times' }), picker.element),
      error,
      el('button', { type: 'submit', text: 'Move appointment' })),
    ),
    el('p', {}, el('a', { href: '#/appointments', text: 'Keep the current time' })),
  );
  await loadSlots();
}

// ----- Admin: doctors, leave days and clinic holidays -----

const cancelledNote = (result) => {
  const n = result.cancelledAppointments?.length ?? 0;
  return n ? ` ${plural(n, 'appointment')} cancelled.` : '';
};

// Sends a schedule change. If booked appointments are in the way, the server refuses the
// change and lists them; they are shown, and only cancelled if the admin confirms.
// afterFirstTry runs once the first attempt has an answer, e.g. to close an earlier dialog.
async function sendScheduleChange({ send, title, onDone, afterFirstTry = () => {} }) {
  let result;
  try {
    result = await send(false);
  } catch (e) {
    if (e.code !== 'HAS_APPOINTMENTS') throw e;
    afterFirstTry();
    const affected = e.details.appointments;
    const n = affected.length;
    openDialog({
      title,
      body: [
        el('p', { text: `${plural(n, 'booked appointment')} will be cancelled. Patients will see the reason in their appointments.` }),
        el('ul', { class: 'affected', 'data-testid': 'affected-appointments' },
          ...affected.map((a) => el('li', { text: `${formatDate(a.date)} at ${a.time}: ${a.patientName} with ${a.doctorName}` }))),
      ],
      keepText: 'Go back',
      confirmText: `Cancel ${plural(n, 'appointment')} and save`,
      onConfirm: async (close) => {
        const confirmed = await send(true);
        close();
        await onDone(confirmed);
      },
    });
    return;
  }
  afterFirstTry();
  await onDone(result);
}

async function renderDoctors() {
  const doctors = await api('/admin/doctors');
  const cards = doctors.map((d) => el('article', { class: 'card', 'data-testid': 'doctor-card' },
    el('div', { class: 'row' },
      el('h2', { text: d.name }),
      el('span', { class: `status ${d.active ? 'booked' : 'cancelled'}`, 'data-testid': 'doctor-status', text: d.active ? 'Active' : 'Inactive' })),
    el('p', { class: 'muted', text: d.specialty }),
    el('p', { class: 'muted', text: `Works ${dayList(d.workingDays)}` }),
    el('div', { class: 'actions start' },
      el('a', { class: 'button secondary', href: `#/doctors/${d.id}`, text: 'Edit', 'aria-label': `Edit ${d.name}` }),
      el('a', { class: 'button secondary', href: `#/doctors/${d.id}/leave`, text: 'Leave days', 'aria-label': `Leave days for ${d.name}` }),
      d.active
        ? el('button', { type: 'button', class: 'secondary', text: 'Deactivate', 'aria-label': `Deactivate ${d.name}`, onclick: () => confirmDeactivate(d) })
        : el('button', { type: 'button', class: 'secondary', text: 'Reactivate', 'aria-label': `Reactivate ${d.name}`, onclick: () => reactivate(d) })),
  ));
  showScreen('Doctors',
    el('p', {}, el('a', { class: 'button', href: '#/doctors/new', text: 'Add a doctor' })),
    ...(cards.length ? cards : [el('p', { class: 'muted', text: 'No doctors yet.' })]),
  );
}

function confirmDeactivate(doctor) {
  openDialog({
    title: `Deactivate ${doctor.name}?`,
    body: [el('p', { text: 'Patients will no longer be able to book with this doctor. You can reactivate them later.' })],
    keepText: 'Keep active',
    confirmText: 'Deactivate',
    onConfirm: (close) => sendScheduleChange({
      send: (cancelAffected) => api(`/doctors/${doctor.id}`, { method: 'PATCH', body: { active: false, cancelAffected } }),
      title: `Deactivate ${doctor.name}?`,
      afterFirstTry: close,
      onDone: async (result) => {
        toast(`${doctor.name} deactivated.${cancelledNote(result)}`);
        await renderDoctors();
      },
    }),
  });
}

async function reactivate(doctor) {
  try {
    await api(`/doctors/${doctor.id}`, { method: 'PATCH', body: { active: true } });
    toast(`${doctor.name} reactivated.`);
    await renderDoctors();
  } catch (e) {
    if (!e.sessionEnded) toast(e.message, { error: true });
  }
}

async function renderDoctorForm(id) {
  const doctor = id === null ? null : (await api('/admin/doctors')).find((d) => d.id === id);
  if (id !== null && !doctor) throw new Error('Doctor not found.');
  const name = el('input', { id: 'doctor-name', required: true, maxlength: 80, value: doctor?.name ?? '' });
  const specialty = el('input', { id: 'doctor-specialty', required: true, maxlength: 80, value: doctor?.specialty ?? '' });
  const workingDays = doctor?.workingDays ?? [1, 2, 3, 4, 5];
  const dayBoxes = DAYS.map((d) => el('input', { type: 'checkbox', value: d.value, checked: workingDays.includes(d.value) }));
  const error = el('p', { class: 'error', role: 'alert' });

  const save = async () => {
    const body = {
      name: name.value, specialty: specialty.value,
      workingDays: dayBoxes.filter((box) => box.checked).map((box) => Number(box.value)),
    };
    if (!doctor) {
      const created = await api('/doctors', { method: 'POST', body });
      toast(`${created.name} added.`);
      go('#/doctors');
      return;
    }
    await sendScheduleChange({
      send: (cancelAffected) => api(`/doctors/${doctor.id}`, { method: 'PATCH', body: { ...body, cancelAffected } }),
      title: `Save changes to ${doctor.name}?`,
      onDone: (result) => {
        toast(`${result.doctor.name} saved.${cancelledNote(result)}`);
        go('#/doctors');
      },
    });
  };

  showScreen(doctor ? `Edit ${doctor.name}` : 'Add a doctor',
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try { await save(); } catch (e) { if (!e.sessionEnded) error.textContent = e.message; }
        },
      },
      field('Name', name),
      field('Specialty', specialty),
      el('fieldset', {}, el('legend', { text: 'Working days' }),
        el('div', { class: 'days' }, ...DAYS.map((d, i) => el('label', { class: 'day' }, dayBoxes[i], ` ${d.name}`)))),
      error,
      el('button', { type: 'submit', text: 'Save doctor' })),
    ),
    el('p', {}, el('a', { href: '#/doctors', text: 'Back to doctors' })),
  );
}

// A form to add a date, and the list of upcoming dates with a button to remove each.
// Shared by doctors' leave days and clinic holidays.
function dateListScreen({ title, intro, entries, describe, removeLabel, onRemove, noteLabel, noteRequired, addText, emptyText, today, onAdd }) {
  const date = el('input', { id: 'schedule-date', type: 'date', required: true, min: today });
  const note = el('input', { id: 'schedule-note', required: noteRequired, maxlength: noteRequired ? 80 : 100 });
  const error = el('p', { class: 'error', role: 'alert' });
  const items = entries.map((entry) => el('li', { 'data-testid': 'schedule-entry' },
    el('span', { text: describe(entry) }),
    el('button', {
      type: 'button', class: 'secondary', text: 'Remove', 'aria-label': removeLabel(entry),
      onclick: async () => {
        try { await onRemove(entry); } catch (e) { if (!e.sessionEnded) toast(e.message, { error: true }); }
      },
    })));
  showScreen(title,
    el('p', { class: 'note', text: intro }),
    el('div', { class: 'card' },
      el('form', {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          try {
            await onAdd(date.value, note.value.trim());
          } catch (e) { if (!e.sessionEnded) error.textContent = e.message; }
        },
      },
      field('Date', date), field(noteLabel, note), error,
      el('button', { type: 'submit', text: addText })),
    ),
    el('h2', { text: 'Coming up' }),
    items.length ? el('ul', { class: 'schedule' }, ...items) : el('p', { class: 'muted', text: emptyText }),
  );
}

async function renderLeave(id) {
  const [doctors, leave, config] = await Promise.all([api('/admin/doctors'), api(`/doctors/${id}/leave`), api('/config')]);
  const doctor = doctors.find((d) => d.id === id);
  dateListScreen({
    title: `Leave days for ${doctor.name}`,
    intro: `${doctor.name} can't be booked on these days.`,
    entries: leave,
    describe: (l) => (l.reason ? `${formatDate(l.date)}: ${l.reason}` : formatDate(l.date)),
    removeLabel: (l) => `Remove leave on ${formatDate(l.date)}`,
    onRemove: async (l) => {
      await api(`/doctors/${id}/leave/${l.date}`, { method: 'DELETE' });
      toast('Leave day removed.');
      await renderLeave(id);
    },
    noteLabel: 'Reason (optional)',
    noteRequired: false,
    addText: 'Add leave day',
    emptyText: 'No leave days coming up.',
    today: config.today,
    onAdd: (date, reason) => sendScheduleChange({
      send: (cancelAffected) => api(`/doctors/${id}/leave`, { method: 'POST', body: { date, reason: reason || null, cancelAffected } }),
      title: `Add leave for ${doctor.name}?`,
      onDone: async (result) => {
        toast(`Leave day added.${cancelledNote(result)}`);
        await renderLeave(id);
      },
    }),
  });
}

async function renderHolidays() {
  const [holidays, config] = await Promise.all([api('/holidays'), api('/config')]);
  dateListScreen({
    title: 'Clinic holidays',
    intro: 'The clinic is closed on these days, so no doctor can be booked.',
    entries: holidays,
    describe: (h) => `${formatDate(h.date)}: ${h.name}`,
    removeLabel: (h) => `Remove ${h.name} on ${formatDate(h.date)}`,
    onRemove: async (h) => {
      await api(`/holidays/${h.date}`, { method: 'DELETE' });
      toast('Holiday removed.');
      await renderHolidays();
    },
    noteLabel: 'Holiday name',
    noteRequired: true,
    addText: 'Add holiday',
    emptyText: 'No holidays coming up.',
    today: config.today,
    onAdd: (date, name) => sendScheduleChange({
      send: (cancelAffected) => api('/holidays', { method: 'POST', body: { date, name, cancelAffected } }),
      title: 'Close the clinic on this day?',
      onDone: async (result) => {
        toast(`Holiday added.${cancelledNote(result)}`);
        await renderHolidays();
      },
    }),
  });
}

// Which screen each address shows. Anything else goes to the user's home screen,
// so the address bar always matches what is on screen.
function screenFor(route) {
  if (!currentUser) return route === 'register' ? renderRegister : renderLogin;
  if (route === 'appointments') return renderAppointments;
  if (route === 'password') return renderChangePassword;
  if (currentUser.role !== 'admin') {
    if (route === 'book') return renderBook;
    const move = route.match(/^appointments\/(\d+)\/reschedule$/);
    return move ? () => renderReschedule(Number(move[1])) : null;
  }
  if (route === 'doctors') return renderDoctors;
  if (route === 'doctors/new') return () => renderDoctorForm(null);
  if (route === 'holidays') return renderHolidays;
  const doctorRoute = route.match(/^doctors\/(\d+)(\/leave)?$/);
  if (doctorRoute) {
    const id = Number(doctorRoute[1]);
    return doctorRoute[2] ? () => renderLeave(id) : () => renderDoctorForm(id);
  }
  return null;
}

async function render() {
  const route = location.hash.replace(/^#\/?/, '');
  const screen = screenFor(route);
  if (!screen) {
    location.replace(homeRoute()); // replace, so Back doesn't return to an address that only redirects
    return;
  }
  renderNav();
  // Screens that fetch data say they are loading, unless they are quick enough not to need it.
  appEl.setAttribute('aria-busy', 'true');
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    appEl.replaceChildren(el('p', { class: 'muted', 'data-testid': 'loading', text: 'Loading…' }));
  }, 200);
  try {
    await screen();
  } catch (e) {
    if (e.sessionEnded) return;
    showScreen('Something went wrong',
      el('p', { class: 'error', role: 'alert', text: e.message }),
      el('button', { type: 'button', text: 'Try again', onclick: () => render() }));
  } finally {
    clearTimeout(loadingTimer);
    appEl.removeAttribute('aria-busy');
  }
  firstRender = false;
}

window.addEventListener('hashchange', render);
document.getElementById('skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  (appEl.querySelector('h1') || appEl).focus();
});

(async () => {
  try { currentUser = await api('/me'); } catch { currentUser = null; }
  await render();
})();
