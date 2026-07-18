import { GamePlanApi } from "./api.js";

const CACHE_KEY = "gameplan-live-bootstrap-v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GOOGLE_TOKEN_KEY = "gameplan-google-id-token-v1";

const state = {
  jobs: [],
  customers: [],
  equipmentTypes: [],
  jobTypes: [],
  accessConditions: [],
  products: [],
  brands: [],
  fulfillmentConditions: [],
  live: false,
  ready: false,
  cached: false,
  refreshing: false,
  loadError: "",
  lastUpdated: "",
  loadDurationMs: 0,
  currentUser: { displayName: "", email: "", roleName: "Employee", permissions: {} },
  staffChoices: [],
  pinSession: null,
  googleIdentity: null,
  authenticated: false
};
const api = new GamePlanApi(window.GAMEPLAN_CONFIG);

const authGate = document.querySelector("#authGate");
const authStatus = document.querySelector("#authStatus");
const googleSignInButton = document.querySelector("#googleSignInButton");
const googleSignOutButton = document.querySelector("#googleSignOut");

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(atob(normalized).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")));
  } catch (_) {
    return null;
  }
}

function tokenIsUsable(token) {
  const payload = decodeJwtPayload(token);
  return Boolean(payload && payload.exp && payload.exp * 1000 > Date.now() + 60_000);
}

function setAuthStatus(message, error = false) {
  if (!authStatus) return;
  authStatus.textContent = message;
  authStatus.classList.toggle("error", error);
}

function showAuthGate(message = "Sign in with an approved Google account.", error = false) {
  state.authenticated = false;
  state.googleIdentity = null;
  api.clearGoogleIdToken();
  authGate?.classList.add("open");
  authGate?.setAttribute("aria-hidden", "false");
  setAuthStatus(message, error);
}

function hideAuthGate() {
  authGate?.classList.remove("open");
  authGate?.setAttribute("aria-hidden", "true");
}

function acceptGoogleCredential(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !tokenIsUsable(token)) throw new Error("Google returned an expired or invalid sign-in token.");
  sessionStorage.setItem(GOOGLE_TOKEN_KEY, token);
  api.setGoogleIdToken(token);
  state.googleIdentity = { email: payload.email || "", name: payload.name || payload.email || "" };
}

async function authorizeGoogleCredential(token) {
  acceptGoogleCredential(token);
  const authorization = await api.authenticate();
  state.currentUser = authorization.currentUser || state.currentUser;
  state.staffChoices = authorization.staffChoices || [];
  state.authenticated = true;
  hideAuthGate();
  renderCurrentUser();
}

function loadGoogleIdentityLibrary() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector('script[data-gameplan-google-identity]');
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google sign-in could not load.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.gameplanGoogleIdentity = "true";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Google sign-in could not load."));
    document.head.appendChild(script);
  });
}

async function initializeGoogleAuthentication() {
  const clientId = String(window.GAMEPLAN_CONFIG?.googleClientId || "").trim();
  if (!clientId) {
    showAuthGate("Google Client ID is missing from js/config.js.", true);
    return;
  }
  try {
    await loadGoogleIdentityLibrary();
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: async response => {
        try {
          setAuthStatus("Verifying your account…");
          await authorizeGoogleCredential(response.credential);
          const hasCachedBootstrap = loadCachedBootstrap();
          updateDataStatus();
          go(location.hash.slice(1) || "today");
          await loadLiveData({ forceLoading: !hasCachedBootstrap });
        } catch (error) {
          console.error(error);
          showAuthGate(error.message || "Google sign-in failed.", true);
        }
      },
      auto_select: false,
      cancel_on_tap_outside: false
    });
    googleSignInButton.innerHTML = "";
    window.google.accounts.id.renderButton(googleSignInButton, {
      theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 300
    });

    const saved = sessionStorage.getItem(GOOGLE_TOKEN_KEY) || "";
    if (tokenIsUsable(saved)) {
      await authorizeGoogleCredential(saved);
      const hasCachedBootstrap = loadCachedBootstrap();
      updateDataStatus();
      go(location.hash.slice(1) || "today");
      await loadLiveData({ forceLoading: !hasCachedBootstrap });
    } else {
      sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
      showAuthGate("Sign in with an approved Google account.");
    }
  } catch (error) {
    console.error(error);
    showAuthGate(error.message || "Google sign-in could not start.", true);
  }
}

function signOutOfGamePlan() {
  clearPinSession(false);
  sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
  api.clearGoogleIdToken();
  state.authenticated = false;
  state.currentUser = { displayName: "", email: "", roleName: "Employee", permissions: {} };
  state.staffChoices = [];
  state.ready = false;
  state.live = false;
  state.cached = false;
  window.google?.accounts?.id?.disableAutoSelect();
  showAuthGate("Signed out. Use an approved Google account to continue.");
  go(location.hash.slice(1) || "today");
}


const scheduleState = {
  weekStart: startOfWeek(new Date()),
  selectedDay: toDateKey(new Date())
};

let jobsViewFilter = "all";
let jobsViewWeekStart = "";
let jobStatusFilters = new Set(["Quote", "Tentative", "Scheduled"]);

const view = document.querySelector("#view");
const title = document.querySelector("#title");
const sub = document.querySelector("#subtitle");
const toastBox = document.querySelector("#toast");
const dataStatus = document.querySelector("#dataStatus");
const drawer = document.querySelector("#jobDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const drawerContent = document.querySelector("#drawerContent");

const todayDate = new Intl.DateTimeFormat("en-US",{weekday:"long",month:"long",day:"numeric"}).format(new Date());

const PIN_SESSION_KEY = "gameplan-pin-session-v1";

function loadPinSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PIN_SESSION_KEY) || "null");
    if (saved && saved.token && saved.expiresAt > Date.now()) state.pinSession = saved;
  } catch (_) {
    sessionStorage.removeItem(PIN_SESSION_KEY);
  }
}

function effectiveUser() {
  if (state.currentUser?.sharedAccount && state.pinSession?.employee && state.pinSession.expiresAt > Date.now()) {
    return state.pinSession.employee;
  }
  return state.currentUser || {};
}

function clearPinSession(showMessage = false) {
  state.pinSession = null;
  sessionStorage.removeItem(PIN_SESSION_KEY);
  renderCurrentUser();
  if (showMessage) toast("GamePlan locked. The next accountable action will require a PIN.");
}

function pinModalHtml(requiredPermission, purpose) {
  const choices = state.staffChoices || [];
  return `<div class="pin-backdrop open" id="pinBackdrop">
    <section class="pin-modal" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
      <button class="pin-close" id="pinClose" aria-label="Cancel">×</button>
      <div class="pin-icon">●●●●</div>
      <h2 id="pinTitle">Employee verification</h2>
      <p>${esc(purpose || "Enter your PIN to continue.")}</p>
      <label class="field"><span>Employee</span>
        <select id="pinEmployee">
          <option value="">Choose employee</option>
          ${choices.map(person => `<option value="${esc(person.id)}">${esc(person.displayName)} · ${esc(person.roleName)}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>PIN</span><input id="pinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="4–8 digits"></label>
      <div class="pin-error" id="pinError"></div>
      <button class="button primary-action" id="pinSubmit">Verify & Continue</button>
    </section>
  </div>`;
}

function requestPin(requiredPermission = "", purpose = "") {
  if (!state.currentUser?.sharedAccount) return Promise.resolve("");
  const active = state.pinSession;
  if (active?.token && active.expiresAt > Date.now()) {
    const allowed = !requiredPermission || Boolean(active.employee?.permissions?.[requiredPermission]);
    if (allowed) return Promise.resolve(active.token);
  }

  return new Promise((resolve, reject) => {
    document.body.insertAdjacentHTML("beforeend", pinModalHtml(requiredPermission, purpose));
    const backdrop = document.querySelector("#pinBackdrop");
    const select = document.querySelector("#pinEmployee");
    const input = document.querySelector("#pinInput");
    const submit = document.querySelector("#pinSubmit");
    const errorBox = document.querySelector("#pinError");
    const close = () => { backdrop?.remove(); reject(new Error("Verification cancelled.")); };
    document.querySelector("#pinClose").onclick = close;
    backdrop.onclick = event => { if (event.target === backdrop) close(); };
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit.click(); });
    submit.onclick = async () => {
      const staffProfileId = select.value;
      const pin = input.value.trim();
      if (!staffProfileId || !pin) {
        errorBox.textContent = "Choose your name and enter your PIN.";
        return;
      }
      submit.disabled = true;
      submit.textContent = "Verifying…";
      errorBox.textContent = "";
      try {
        const result = await api.verifyPin(staffProfileId, pin);
        if (requiredPermission && !result.employee?.permissions?.[requiredPermission]) {
          throw new Error("Manager authorization is required for this action.");
        }
        const expiresAt = Date.now() + Number(result.expiresInSeconds || 900) * 1000;
        state.pinSession = { token: result.token, employee: result.employee, expiresAt };
        sessionStorage.setItem(PIN_SESSION_KEY, JSON.stringify(state.pinSession));
        backdrop.remove();
        renderCurrentUser();
        resolve(result.token);
      } catch (error) {
        errorBox.textContent = error.message || "PIN verification failed.";
        submit.disabled = false;
        submit.textContent = "Verify & Continue";
        input.value = "";
        input.focus();
      }
    };
    setTimeout(() => select.focus(), 0);
  });
}

function renderCurrentUser() {
  const name = document.querySelector("#profileName");
  const role = document.querySelector("#profileRole");
  const avatar = document.querySelector("#profileAvatar");
  const user = effectiveUser();
  const shared = Boolean(state.currentUser?.sharedAccount);
  if (name) name.textContent = shared && !state.pinSession ? "Shared Employee Account" : (user.displayName || user.email || "GamePlan User");
  if (role) role.textContent = shared && !state.pinSession ? "PIN required for accountable actions" : `${user.roleName || "Employee"}${shared ? " · Switch Employee" : ""}`;
  if (avatar) avatar.textContent = (user.displayName || user.email || "G").trim().charAt(0).toUpperCase();
  const profile = document.querySelector(".profile");
  if (googleSignOutButton) googleSignOutButton.hidden = !state.authenticated;
  if (profile) {
    profile.classList.toggle("profile-action", shared);
    profile.onclick = shared ? () => clearPinSession(true) : null;
    profile.title = shared ? "Lock GamePlan / Switch Employee" : "";
  }
}


function startOfWeek(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  date.setDate(date.getDate() - ((day + 6) % 7));
  return date;
}

function addDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseJobDate(job) {
  const raw = job.scheduledDate || job.dateISO || job.appointmentDate || job.dateTime || job.date || "";
  if (!raw) return null;
  const normalized = String(raw).trim().toLowerCase();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (normalized === "today") return now;
  if (normalized === "tomorrow") return addDays(now, 1);
  if (normalized === "yesterday") return addDays(now, -1);
  const isoOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(raw));
  const parsed = isoOnly ? new Date(`${raw}T12:00:00`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDurationHours(job) {
  const numeric = Number(job.durationHours || job.estimatedHours || 0);
  if (numeric > 0) return numeric;
  const text = String(job.duration || "").toLowerCase();
  const hours = Number((text.match(/([\d.]+)\s*h/) || [])[1] || 0);
  const minutes = Number((text.match(/([\d.]+)\s*m/) || [])[1] || 0);
  return hours + minutes / 60 || 1;
}

function timeSortValue(job) {
  const raw = job.scheduledTime || job.time || "";
  const match = String(raw).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return 9999;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = (match[3] || "").toUpperCase();
  if (suffix === "PM" && hour !== 12) hour += 12;
  if (suffix === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function jobsForDate(date) {
  const key = toDateKey(date);
  return state.jobs
    .filter(job => ["Scheduled", "Completed"].includes(job.status))
    .filter(job => toDateKey(parseJobDate(job)) === key)
    .sort((a, b) => timeSortValue(a) - timeSortValue(b));
}

function isTodayJob(job) {
  const date = parseJobDate(job);
  return Boolean(date) && toDateKey(date) === toDateKey(new Date()) && ["Scheduled", "Completed"].includes(job.status);
}

function isScheduledBuildAlert(job) {
  return job.status === "Scheduled" && job.buildRequired && !job.buildComplete && Boolean(parseJobDate(job));
}

function scheduleLoadInfo(jobs) {
  const hours = jobs.reduce((sum, job) => sum + parseDurationHours(job), 0);
  const capacity = 8;
  const percent = Math.round((hours / capacity) * 100);
  const level = percent > 100 ? "over" : percent >= 80 ? "heavy" : percent >= 45 ? "steady" : "open";
  const label = level === "over" ? "Over capacity" : level === "heavy" ? "Nearly full" : level === "steady" ? "Steady" : "Open";
  return { hours, percent, level, label };
}

function weekLabel(start) {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const first = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(start);
  const last = new Intl.DateTimeFormat("en-US", sameMonth ? { day: "numeric", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(end);
  return `${first}–${last}`;
}

function renderSchedule() {
  const days = Array.from({ length: 7 }, (_, index) => addDays(scheduleState.weekStart, index));
  const selectedDate = days.find(day => toDateKey(day) === scheduleState.selectedDay) || days[0];
  scheduleState.selectedDay = toDateKey(selectedDate);
  const selectedJobs = jobsForDate(selectedDate);
  const weekJobs = days.flatMap(jobsForDate);
  const weekKeys = new Set(days.map(toDateKey));
  const tentativeWeekJobs = state.jobs
    .filter(job => job.status === "Tentative")
    .filter(job => weekKeys.has(toDateKey(parseJobDate(job))))
    .sort((a, b) => parseJobDate(a) - parseJobDate(b) || timeSortValue(a) - timeSortValue(b));
  const weekBuildJobs = weekJobs.filter(isScheduledBuildAlert);
  const unscheduled = state.jobs.filter(job => !parseJobDate(job) && job.status !== "Cancelled");
  const selectedTitle = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(selectedDate);

  return `<div class="schedule-planner">
    <section class="schedule-toolbar">
      <button class="button neutral schedule-nav" data-week-nav="-1" aria-label="Previous week">←</button>
      <div class="schedule-range"><span>Weekly operations plan</span><strong>${weekLabel(scheduleState.weekStart)}</strong></div>
      <button class="button neutral schedule-nav" data-week-nav="1" aria-label="Next week">→</button>
      <button class="button schedule-today" data-week-today>This Week</button>
    </section>

    <section class="schedule-summary">
      <button class="stat stat-action" data-summary-filter="scheduled"><b>${weekJobs.length}</b><span>Scheduled jobs</span></button>
      <button class="stat stat-action" data-summary-filter="tentative"><b>${tentativeWeekJobs.length}</b><span>Awaiting confirmation</span></button>
      <button class="stat stat-action" data-summary-filter="builds"><b>${weekBuildJobs.length}</b><span>Needs Build</span></button>
      <button class="stat stat-action" data-summary-filter="unscheduled"><b>${unscheduled.length}</b><span>Unscheduled</span></button>
    </section>

    <section class="week-grid" aria-label="Weekly schedule">
      ${days.map(day => {
        const jobs = jobsForDate(day);
        const tentativeJobs = state.jobs.filter(job => job.status === "Tentative" && toDateKey(parseJobDate(job)) === toDateKey(day));
        const load = scheduleLoadInfo(jobs);
        const selected = toDateKey(day) === scheduleState.selectedDay;
        const today = toDateKey(day) === toDateKey(new Date());
        return `<button class="week-day ${selected ? "selected" : ""} ${today ? "today" : ""}" data-select-day="${toDateKey(day)}">
          <div class="week-day__top"><span>${new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(day)}</span><b>${day.getDate()}</b></div>
          <div class="capacity-track"><i class="${load.level}" style="width:${Math.min(load.percent, 100)}%"></i></div>
          <div class="week-day__meta"><strong>${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}</strong><span>${tentativeJobs.length ? `${tentativeJobs.length} Pending` : jobs.filter(isScheduledBuildAlert).length ? `${jobs.filter(isScheduledBuildAlert).length} Needs Build` : load.label}</span></div>
          <div class="status-dots">${jobs.slice(0, 5).map(job => `<i class="${badgeClass(job.status)}" title="${esc(job.status)}"></i>`).join("")}${tentativeJobs.length ? `<i class="tentative pending-marker" title="${tentativeJobs.length} awaiting confirmation"></i>` : ""}</div>
        </button>`;
      }).join("")}
    </section>

    <section class="card schedule-agenda">
      <div class="head"><div><h2>${selectedTitle}</h2><span class="agenda-subtitle">${selectedJobs.length ? `${selectedJobs.length} scheduled ${selectedJobs.length === 1 ? "job" : "jobs"}` : "No jobs scheduled"}</span></div><button class="button" data-demo-action="New Job">＋ New Job</button></div>
      <div class="body agenda-list">
        ${selectedJobs.length ? selectedJobs.map(job => `<article class="agenda-job" data-open-job="${esc(job.id)}">
          <div class="agenda-time"><strong>${esc(job.time || job.scheduledTime || "Time TBD")}</strong><span>${esc(job.duration || "")}</span></div>
          <div class="agenda-line"></div>
          <div class="agenda-main"><div class="agenda-main__top"><h3>${esc(job.customer)}</h3><span class="badge ${badgeClass(job.status)}">${esc(job.status)}</span></div><p>${esc(job.type)} · ${esc(job.address)}</p><div class="agenda-tags"><span>${esc(job.crewSize || "—")} crew</span>${job.buildRequired && !job.buildComplete ? `<span class="build-warning">Needs Build</span>` : ""}</div></div>
          <button class="button neutral" data-open-job="${esc(job.id)}">Open</button>
        </article>`).join("") : `<div class="empty-agenda"><b>Open day</b><span>This day currently has no scheduled work.</span><button class="button" data-demo-action="New Job">Schedule a Job</button></div>`}
      </div>
    </section>

    ${unscheduled.length ? `<section class="card unscheduled-card"><div class="head"><h2>Unscheduled Jobs</h2><span class="badge tentative">${unscheduled.length}</span></div><div class="body list">${unscheduled.slice(0, 8).map(job => `<div class="row" data-open-job="${esc(job.id)}"><div><b>${esc(job.customer)}</b><span>${esc(job.type)} · ${esc(job.address)}</span></div><span class="badge ${badgeClass(job.status)}">${esc(job.status)}</span></div>`).join("")}</div></section>` : ""}
  </div>`;
}

function toast(message) {
  toastBox.innerHTML = `<div class="toast">${message}</div>`;
  setTimeout(() => toastBox.innerHTML = "", 2800);
}

function badgeClass(status) {
  return ({
    Scheduled:"scheduled",
    Tentative:"tentative",
    Completed:"completed",
    Cancelled:"cancelled",
    "Needs Attention":"attention"
  })[status] || "";
}

function queueItem(job) {
  const action = job.status === "Tentative" ? "Review" : "Open";
  return `<article data-job-id="${job.id}">
    <div class="icon">${job.status === "Tentative" ? "▣" : "◇"}</div>
    <div>
      <h3>${job.customer}</h3>
      <p>${job.time} · ${job.type}<br>${job.address}</p>
      <span class="badge ${badgeClass(job.status)}">${job.status}</span>
      ${job.buildRequired && !job.buildComplete ? `<span class="badge tentative">Needs Build</span>` : ""}
    </div>
    <button class="button" data-open-job="${job.id}">${action}</button>
  </article>`;
}

function lifecycleIcon(step) {
  if (step === "Completed") return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.6 2.6L16.5 9"></path></svg>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"></rect><path d="M8 3v5M16 3v5M4 9.5h16"></path>${step === "Quote" ? '<path d="M8 13h3M8 16h6"></path>' : step === "Tentative" ? '<path d="M8 13h3M14.5 13h1.5M8 16h8"></path>' : '<path d="m8 14 2 2 5-5"></path>'}</svg>`;
}

function renderLifecycle(status) {
  const order = ["Quote","Tentative","Scheduled","Completed"];
  const cancelled = status === "Cancelled";
  const currentIndex = cancelled ? 1 : Math.max(0, order.indexOf(status));
  return `<div class="lifecycle-wrap"><div class="lifecycle">${order.map((step,index)=>{
    const cls = index < currentIndex ? "done" : index === currentIndex && !cancelled ? "current" : "";
    return `<div class="life-step ${cls} life-${step.toLowerCase()}"><div class="life-icon">${lifecycleIcon(step)}</div><span>${step}</span>${index < order.length - 1 ? '<i class="life-arrow">→</i>' : ''}</div>`;
  }).join("")}</div>${cancelled ? `<div class="cancel-branch"><span>↘</span><strong>Cancelled</strong></div>` : ""}</div>`;
}

function equipmentImage(item) {
  return item.imageUrl
    ? `<img class="equipment-photo" src="${item.imageUrl}" alt="${item.brand} ${item.model}">`
    : `<div class="equipment-photo">Equipment</div>`;
}

function can(permission) {
  return Boolean(effectiveUser()?.permissions?.[permission]);
}

function isManager() {
  return can("canApproveSchedule");
}

function permissionNotice(text) {
  return `<div class="permission-notice"><strong>Manager approval required</strong><span>${esc(text)}</span></div>`;
}

function workflowActions(job) {
  const today = isTodayJob(job) && job.status === "Scheduled";
  if (job.status === "Tentative") {
    const confirm = (isManager() || state.currentUser?.sharedAccount)
      ? `<button class="button primary-action" data-status-action="Scheduled" data-job-id="${esc(job.id)}">✓ Confirm Appointment</button>`
      : permissionNotice("This appointment is awaiting manager confirmation before it is added to the finalized schedule.");
    return `${confirm}
      <button class="button neutral" data-demo-action="Edit / Reschedule">Edit / Reschedule</button>
      <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
  }
  if (job.status === "Scheduled" && today) return `
    <a class="button call-action" href="tel:${esc(job.phone)}">Call Customer</a>
    <a class="button neutral map-action" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address || "")}" target="_blank" rel="noopener">View on Map</a>
    <button class="button green primary-action" data-status-action="Completed" data-job-id="${esc(job.id)}">✓ Complete Job</button>`;
  if (job.status === "Scheduled") {
    if (!isManager() && !state.currentUser?.sharedAccount) return permissionNotice("This appointment is finalized. A manager must reschedule or cancel it.");
    return `
      <button class="button neutral" data-demo-action="Edit / Reschedule">Edit / Reschedule</button>
      <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
  }
  if (job.status === "Quote") return `<button class="button primary-action" data-status-action="Tentative" data-job-id="${esc(job.id)}">Schedule Appointment</button>`;
  return "";
}

function equipmentBuildControl(job, item) {
  if (!item.buildRequired) return `<span class="badge completed">No Build Needed</span>`;
  if (item.buildComplete) return `<span class="badge completed">Build Complete ✓</span>`;
  if (job.status !== "Scheduled") return `<span class="build-warning">Needs Build</span>`;
  return `<button class="button build-complete-button" data-build-complete="${esc(item.id)}" data-job-id="${esc(job.id)}">Mark Build Complete</button>`;
}

function openJob(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  drawerContent.innerHTML = `
    ${renderLifecycle(job.status)}
    <section class="detail-card job-summary-card">
      <div class="job-summary-top"><span>Job #${esc(job.number || job.id)}</span><span class="badge ${badgeClass(job.status)}">${esc(job.status)}</span></div>
      <h3>${esc(job.customer)}</h3>
      <div class="customer-address">${esc(job.address)}</div>
      <div class="detail-line"><span>Appointment</span><strong>${esc(job.date)}, ${esc(job.time)}</strong></div>
      <div class="detail-line"><span>Estimated duration</span><strong>${esc(job.duration || "—")}</strong></div>
    </section>

    <section class="detail-card">
      <h3>Equipment (${job.equipment?.length || 0})</h3>
      ${(job.equipment || []).map(item => `<div class="equipment-card">
        ${equipmentImage(item)}
        <div class="equipment-copy"><strong>${esc(item.brand || "")} ${esc(item.model || "")}</strong><small>${esc(item.type || "")}</small></div>
        <div class="equipment-build-action">${equipmentBuildControl(job, item)}</div>
      </div>`).join("")}
    </section>

    <section class="detail-card">
      <div class="detail-line"><span>Crew</span><strong>${esc(job.crewSize || "—")} Person Crew</strong></div>
      <div class="detail-line"><span>Estimated duration</span><strong>${esc(job.duration || "—")}</strong></div>
      <div class="detail-line"><span>Total price</span><strong class="detail-total">$${Number(job.total || 0).toFixed(2)}</strong></div>
    </section>

    <div class="drawer-actions">
      ${workflowActions(job)}
    </div>
  `;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");
  drawer.setAttribute("aria-hidden","false");
  bindDynamic();
}

async function changeJobStatus(jobId, newStatus) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  const managerOnly = newStatus === "Scheduled" || (job.status === "Scheduled" && ["Tentative", "Cancelled"].includes(newStatus));

  const messages = {
    Scheduled: `Confirm ${job.customer}'s appointment and add it to the Weekly Planner?`,
    Completed: `Mark ${job.customer}'s job complete?`,
    Cancelled: `Cancel ${job.customer}'s job? It will remain in job history.` ,
    Tentative: `Move this quote to Tentative?`
  };
  if (!window.confirm(messages[newStatus] || `Change status to ${newStatus}?`)) return;
  const buttons = drawerContent.querySelectorAll("[data-status-action]");
  buttons.forEach(button => button.disabled = true);
  try {
    const requiredPermission = managerOnly ? "canApproveSchedule" : "canCreateQuote";
    const pinToken = await requestPin(requiredPermission, managerOnly ? "Manager PIN required to finalize or change the schedule." : "Enter your employee PIN to record this action.");
    await api.updateJobStatus(jobId, newStatus, "Updated from Job Details", pinToken);
    toast(newStatus === "Scheduled" ? "Appointment confirmed and added to the Weekly Planner." : `Job marked ${newStatus}.`);
    closeJob();
    await loadLiveData();
    go(newStatus === "Scheduled" ? "schedule" : "jobs");
  } catch (error) {
    console.error(error);
    toast(error.message || "The job status could not be updated.");
    buttons.forEach(button => button.disabled = false);
  }
}

async function markBuildComplete(jobId, jobEquipmentId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  if (!window.confirm("Mark this equipment build complete?")) return;
  const button = drawerContent.querySelector(`[data-build-complete="${CSS.escape(jobEquipmentId)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "Saving…";
  }
  try {
    const pinToken = await requestPin("canCreateQuote", "Enter your employee PIN to certify this equipment build.");
    await api.updateEquipmentBuildStatus(jobId, jobEquipmentId, true, pinToken);
    toast("Equipment build marked complete.");
    await loadLiveData();
    openJob(jobId);
  } catch (error) {
    console.error(error);
    toast(error.message || "The build status could not be updated.");
    if (button) {
      button.disabled = false;
      button.textContent = "Mark Build Complete";
    }
  }
}

function closeJob() {
  drawer.classList.remove("open");
  drawerBackdrop.classList.remove("open");
  drawer.setAttribute("aria-hidden","true");
}

const views = {
  today: {
    title:"Today's GamePlan", sub:todayDate,
    html:()=>`<div class="grid two">
      <div class="grid">
        <section class="alert">
          <b>🔧</b>
          <div class="copy"><strong>Build Alerts</strong><span>${state.jobs.filter(isScheduledBuildAlert).length} scheduled jobs still need equipment assembled.</span></div>
          <button class="button" data-job-filter="builds">View Items</button>
        </section>
        <section class="card">
          <div class="head"><h2>Today's Queue</h2></div>
          <div class="body queue">${state.jobs.filter(isTodayJob).length ? state.jobs.filter(isTodayJob).map(queueItem).join("") : `<div class="empty-agenda"><b>No scheduled jobs today</b><span>Confirmed work scheduled for today will appear here.</span></div>`}</div>
        </section>
      </div>
      <div class="grid">
        <section class="card">
          <div class="head"><h2>Quick Actions</h2></div>
          <div class="body quick">
            <button data-demo-action="New Job">＋<br>New Job</button>
            <button data-quick-quote>≈<br>Quick Quote</button>
            <button data-route="schedule">▣<br>Schedule</button>
          </div>
        </section>
        <section class="card">
          <div class="head"><h2>Today</h2></div>
          <div class="body stats">
            <div class="stat"><b>${state.jobs.filter(j=>j.status==="Scheduled" && isTodayJob(j)).length}</b><span>Scheduled</span></div>
            <div class="stat"><b>${state.jobs.filter(j=>j.status==="Tentative" && parseJobDate(j) && toDateKey(parseJobDate(j))===toDateKey(new Date())).length}</b><span>Tentative</span></div>
            <div class="stat"><b>${state.jobs.filter(j=>isScheduledBuildAlert(j) && isTodayJob(j)).length}</b><span>Need Build</span></div>
            <div class="stat"><b>0</b><span>Conflicts</span></div>
          </div>
        </section>
      </div>
    </div>`
  },

  schedule: {
    title:"Schedule", sub:"Weekly operations planner",
    html:()=>renderSchedule()
  },

  jobs: {
    title:"Jobs", sub:"Quotes, tentative appointments, scheduled work, and history",
    html:()=>{
      const weekStart = jobsViewWeekStart ? new Date(`${jobsViewWeekStart}T12:00:00`) : null;
      const weekKeys = weekStart ? new Set(Array.from({length:7}, (_,i)=>toDateKey(addDays(weekStart,i)))) : null;
      let filteredJobs = state.jobs;
      let heading = "All Jobs";
      let subtitle = "";

      if (jobsViewFilter === "scheduled-week") {
        filteredJobs = state.jobs.filter(job => ["Scheduled","Completed"].includes(job.status) && weekKeys?.has(toDateKey(parseJobDate(job))));
        heading = "Scheduled Jobs";
        subtitle = `Jobs scheduled for ${weekLabel(weekStart)}`;
      } else if (jobsViewFilter === "tentative-week") {
        filteredJobs = state.jobs.filter(job => job.status === "Tentative" && weekKeys?.has(toDateKey(parseJobDate(job))));
        heading = "Awaiting Confirmation";
        subtitle = `Tentative jobs for ${weekLabel(weekStart)}`;
      } else if (jobsViewFilter === "builds-week") {
        filteredJobs = state.jobs.filter(job => isScheduledBuildAlert(job) && weekKeys?.has(toDateKey(parseJobDate(job))));
        heading = "Needs Build";
        subtitle = `Unfinished scheduled builds for ${weekLabel(weekStart)}`;
      } else if (jobsViewFilter === "unscheduled") {
        filteredJobs = state.jobs.filter(job => !parseJobDate(job) && job.status !== "Cancelled");
        heading = "Unscheduled Jobs";
        subtitle = "Jobs that still need an appointment date";
      } else if (jobsViewFilter === "builds") {
        filteredJobs = state.jobs.filter(isScheduledBuildAlert);
        heading = "Build Alerts";
        subtitle = "Scheduled jobs with unfinished equipment builds";
      } else {
        filteredJobs = state.jobs.filter(job => jobStatusFilters.has(job.status));
      }

      filteredJobs = [...filteredJobs].sort((a,b) => {
        const ad=parseJobDate(a), bd=parseJobDate(b);
        if (ad && bd) return ad-bd || timeSortValue(a)-timeSortValue(b);
        if (ad) return -1;
        if (bd) return 1;
        return String(a.customer||"").localeCompare(String(b.customer||""));
      });

      const filteredMode = jobsViewFilter !== "all";
      const emptyTitle = jobsViewFilter.includes("builds") ? "No build alerts" : jobsViewFilter === "tentative-week" ? "No jobs awaiting confirmation" : jobsViewFilter === "scheduled-week" ? "No scheduled jobs" : jobsViewFilter === "unscheduled" ? "No unscheduled jobs" : "No jobs found";
      const emptyText = jobsViewFilter.includes("builds") ? "All scheduled equipment builds are complete." : "There are no jobs in this view.";

      const statusOptions = ["Quote", "Tentative", "Scheduled", "Completed", "Cancelled"];
      const filterControls = filteredMode ? `<button class="button neutral" data-clear-job-filter>Show All Jobs</button>` : `<div class="job-filter-bar" aria-label="Filter jobs by status">${statusOptions.map(status => `<button class="job-filter-chip ${jobStatusFilters.has(status) ? "active" : ""} ${badgeClass(status)}" data-toggle-job-status="${status}" aria-pressed="${jobStatusFilters.has(status)}">${status}</button>`).join("")}</div>`;

      return `<section class="card"><div class="head jobs-head"><div><h2>${heading}</h2>${subtitle ? `<span class="agenda-subtitle">${subtitle}</span>` : ""}</div><div class="head-actions">${filterControls}<button class="button" data-demo-action="New Job">New Job</button></div></div><div class="body list">${filteredJobs.length ? filteredJobs.map(j=>`<div class="row" data-open-job="${j.id}"><div><b>${j.customer}</b><span>${j.number} · ${j.type} · ${j.date} ${j.time}</span></div><span class="badge ${badgeClass(j.status)}">${j.status}</span></div>`).join("") : `<div class="empty-agenda"><b>${emptyTitle}</b><span>${emptyText}</span></div>`}</div></section>`;
    }
  },

  roster: {
    title:"Roster", sub:"Customers and saved service addresses",
    html:()=>`<section class="card"><div class="head"><h2>Customers</h2><button class="button" data-demo-action="Add Customer">Add Customer</button></div><div class="body list">${state.customers.map(c=>`<div class="row"><div><b>${c.name}</b><span>${c.phone} · ${c.email || ""}</span></div><span class="badge">${c.jobs || 0} jobs</span></div>`).join("")}</div></section>`
  },

  more: {
    title:"More", sub:"Administration and app information",
    html:()=>`<div class="grid two"><section class="card"><div class="head"><h2>Administration</h2></div><div class="body list"><button class="row" data-demo-action="Settings"><div><b>Settings</b><span>Pricing, timing, availability, and app rules</span></div><b>⚙</b></button><button class="row" data-demo-action="Huddle Together"><div><b>Huddle Together</b><span>Group scheduled jobs into one operational route</span></div><b>↝</b></button></div></section><section class="card"><div class="head"><h2>System</h2></div><div class="body"><div class="row"><div><b>Data source</b><span>${state.live ? "Live GamePlan CMS" : state.cached ? "Cached live data" : "Not connected"}</span></div><span class="badge ${state.live ? "completed" : "tentative"}">${state.live ? "Live" : state.cached ? "Cached" : "Offline"}</span></div></div></section></div>`
  }
};

function bindDynamic() {
  document.querySelectorAll("[data-open-job]").forEach(el => {
    el.onclick = (event) => {
      event.stopPropagation();
      openJob(el.dataset.openJob);
    };
  });
  document.querySelectorAll("[data-demo-action]").forEach(el => {
    el.onclick = () => {
      if (["New Job","New Tentative"].includes(el.dataset.demoAction)) openWizard("job");
      else toast(`${el.dataset.demoAction} becomes active in a later version.`);
    };
  });
  document.querySelectorAll("[data-status-action]").forEach(el => {
    el.onclick = () => changeJobStatus(el.dataset.jobId, el.dataset.statusAction);
  });
  document.querySelectorAll("[data-build-complete]").forEach(el => {
    el.onclick = () => markBuildComplete(el.dataset.jobId, el.dataset.buildComplete);
  });
  document.querySelectorAll("[data-job-filter]").forEach(el => {
    el.onclick = () => {
      jobsViewFilter = el.dataset.jobFilter;
      go("jobs");
    };
  });
  document.querySelectorAll("[data-clear-job-filter]").forEach(el => {
    el.onclick = () => {
      jobsViewFilter = "all";
      jobsViewWeekStart = "";
      go("jobs");
    };
  });
  document.querySelectorAll("[data-toggle-job-status]").forEach(el => {
    el.onclick = () => {
      const status = el.dataset.toggleJobStatus;
      if (jobStatusFilters.has(status)) jobStatusFilters.delete(status);
      else jobStatusFilters.add(status);
      go("jobs");
    };
  });
  view.querySelectorAll("[data-summary-filter]").forEach(el => {
    el.onclick = () => {
      const filter = el.dataset.summaryFilter;
      const weekStartKey = toDateKey(scheduleState.weekStart);
      if (filter === "tentative") {
        const days = Array.from({length:7}, (_,i)=>addDays(scheduleState.weekStart,i));
        const weekKeys = new Set(days.map(toDateKey));
        const matches = state.jobs.filter(job => job.status === "Tentative" && weekKeys.has(toDateKey(parseJobDate(job))));
        if (matches.length === 1) {
          openJob(matches[0].id);
          return;
        }
        jobsViewFilter = "tentative-week";
      } else if (filter === "scheduled") {
        jobsViewFilter = "scheduled-week";
      } else if (filter === "builds") {
        jobsViewFilter = "builds-week";
      } else {
        jobsViewFilter = "unscheduled";
      }
      jobsViewWeekStart = weekStartKey;
      go("jobs");
    };
  });
  document.querySelectorAll("[data-quick-quote]").forEach(el => el.onclick = () => openWizard("quote"));
  view.querySelectorAll("[data-route]").forEach(el => {
    el.onclick = () => go(el.dataset.route);
  });
  view.querySelectorAll("[data-week-nav]").forEach(el => {
    el.onclick = () => {
      scheduleState.weekStart = addDays(scheduleState.weekStart, Number(el.dataset.weekNav) * 7);
      scheduleState.selectedDay = toDateKey(scheduleState.weekStart);
      go("schedule");
    };
  });
  view.querySelectorAll("[data-select-day]").forEach(el => {
    el.onclick = () => {
      scheduleState.selectedDay = el.dataset.selectDay;
      go("schedule");
    };
  });
  view.querySelectorAll("[data-week-today]").forEach(el => {
    el.onclick = () => {
      scheduleState.weekStart = startOfWeek(new Date());
      scheduleState.selectedDay = toDateKey(new Date());
      go("schedule");
    };
  });
}

function loadingView() {
  if (state.loadError && !state.ready) {
    return `<div class="app-state app-state--error"><div class="app-state__icon">!</div><h2>GamePlan could not load</h2><p>${esc(state.loadError)}</p><button class="button" data-retry-load>Retry</button></div>`;
  }
  return `<div class="app-state"><div class="loading-spinner" aria-hidden="true"></div><h2>Loading GamePlan…</h2><p>Fetching the latest jobs, customers, and schedule.</p></div>`;
}

function updateDataStatus() {
  if (state.refreshing) {
    dataStatus.textContent = state.ready ? "Refreshing…" : "Loading…";
    dataStatus.className = "demo loading";
  } else if (state.live) {
    dataStatus.textContent = state.loadDurationMs ? `Live CMS · ${(state.loadDurationMs / 1000).toFixed(1)}s` : "Live CMS";
    dataStatus.className = "demo live";
  } else if (state.cached) {
    const stamp = state.lastUpdated ? new Date(state.lastUpdated).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}) : "earlier";
    dataStatus.textContent = `Cached · ${stamp}`;
    dataStatus.className = "demo cached";
  } else {
    dataStatus.textContent = "Offline";
    dataStatus.className = "demo error";
  }
}

function applyBootstrapData(data, {cached = false, timestamp = new Date().toISOString()} = {}) {
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.customers = Array.isArray(data.customers) ? data.customers : [];
  state.equipmentTypes = Array.isArray(data.equipmentTypes) ? data.equipmentTypes : [];
  state.jobTypes = Array.isArray(data.jobTypes) ? data.jobTypes : [];
  state.accessConditions = Array.isArray(data.accessConditions) ? data.accessConditions : [];
  state.products = Array.isArray(data.products) ? data.products : [];
  state.brands = Array.isArray(data.brands) ? data.brands : [];
  state.fulfillmentConditions = Array.isArray(data.fulfillmentConditions) ? data.fulfillmentConditions : [];
  state.currentUser = cached
    ? (state.currentUser || { displayName: "", email: "", roleName: "Employee", permissions: {} })
    : (data.currentUser || { displayName: "", email: "", roleName: "Employee", permissions: {} });
  state.staffChoices = cached ? (state.staffChoices || []) : (data.staffChoices || []);
  state.ready = true;
  state.cached = cached;
  state.live = !cached;
  state.lastUpdated = timestamp;
  state.loadError = "";
}

function loadCachedBootstrap() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached?.data || !cached?.timestamp) return false;
    if (Date.now() - new Date(cached.timestamp).getTime() > CACHE_MAX_AGE_MS) return false;
    applyBootstrapData(cached.data, {cached:true, timestamp:cached.timestamp});
    return true;
  } catch (error) {
    console.warn("GamePlan cache could not be read.", error);
    return false;
  }
}

function go(route) {
  renderCurrentUser();
  const selected = views[route] ? route : "today";
  const v = views[selected];
  title.textContent = v.title;
  sub.textContent = state.ready ? v.sub : "Preparing your live workspace";
  view.innerHTML = state.ready ? v.html() : loadingView();
  document.querySelectorAll("[data-route]").forEach(b => b.classList.toggle("active", b.dataset.route === selected));
  bindDynamic();
  document.querySelector("[data-retry-load]")?.addEventListener("click", () => loadLiveData({forceLoading:true}));
  history.replaceState({}, "", `#${selected}`);
}

async function loadLiveData({forceLoading = false} = {}) {
  if (!state.authenticated) {
    showAuthGate("Sign in with an approved Google account.");
    return;
  }
  if (!api.isConfigured) {
    state.loadError = "The live CMS URL is not configured.";
    state.refreshing = false;
    updateDataStatus();
    go(location.hash.slice(1) || "today");
    return;
  }
  const started = performance.now();
  state.refreshing = true;
  state.loadError = "";
  updateDataStatus();
  if (forceLoading && !state.cached) state.ready = false;
  go(location.hash.slice(1) || "today");
  try {
    const data = await api.getBootstrap();
    const timestamp = new Date().toISOString();
    applyBootstrapData(data, {cached:false, timestamp});
    state.loadDurationMs = Math.round(performance.now() - started);
    localStorage.setItem(CACHE_KEY, JSON.stringify({timestamp, data}));
    localStorage.setItem("gameplan-last-bootstrap-ms", String(state.loadDurationMs));
    console.info(`[GamePlan] Bootstrap ${state.loadDurationMs} ms`);
  } catch (error) {
    console.error(error);
    state.loadError = error.message || "The live CMS did not respond.";
    if (/sign-in|Google account|authorized|token/i.test(state.loadError)) {
      sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
      showAuthGate(state.loadError, true);
    }
    if (!state.ready) state.live = false;
    if (state.cached) toast("Could not refresh. Showing the last successful live data.");
  } finally {
    state.refreshing = false;
    updateDataStatus();
    go(location.hash.slice(1) || "today");
  }
}

document.addEventListener("click", event => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton && !routeButton.closest("#view")) go(routeButton.dataset.route);
});


const wizard = document.querySelector("#jobWizard");
const wizardBackdrop = document.querySelector("#wizardBackdrop");
const wizardForm = document.querySelector("#jobWizardForm");
const wizardStepLabel = document.querySelector("#wizardStepLabel");
const wizardProgress = document.querySelector("#wizardProgress");
const wizardBack = document.querySelector("#wizardBack");
const wizardNext = document.querySelector("#wizardNext");
const wizardTitle = document.querySelector("#wizardTitle");
const DRAFT_KEY = "gameplan-job-draft-v0.3.1";
const blankItem=()=>({condition:"New",equipmentTypeId:"EQP-TREAD",brandId:"",brand:"",productId:"",model:"",fulfillmentConditionId:"NIB",notes:""});
const blankDraft=()=>({mode:"job",step:0,customerMode:"existing",customerId:"",customerSearch:"",firstName:"",lastName:"",phone:"",email:"",addressId:"",address:"",jobTypeId:"JT-DEL",equipment:[blankItem()],access:["ACC-SINGLE"],scheduledDate:"",scheduledTime:"",internalNotes:""});
let draft=blankDraft();
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}
function selectedCustomer(){return state.customers.find(c=>c.id===draft.customerId);}
function selectedType(item){return state.equipmentTypes.find(t=>t.id===item.equipmentTypeId)||{};}
function crewSize(){return Math.max(1,...draft.equipment.map(i=>Number(selectedType(i).defaultCrewSize||2)));}
function optionList(items,current,label="name"){return items.map(x=>`<option value="${esc(x.id)}" ${x.id===current?"selected":""}>${esc(x[label])}</option>`).join("");}
function openWizard(mode="job"){
  const saved=mode==="job"?localStorage.getItem(DRAFT_KEY):null;
  draft=saved?{...blankDraft(),...JSON.parse(saved)}:blankDraft(); draft.mode=mode; draft.step=0;
  wizardTitle.textContent=mode==="quote"?"Quick Quote":"New Job";
  document.querySelector("#saveDraftTop").style.display=mode==="quote"?"none":"block";
  renderWizard(); wizard.classList.add("open");wizardBackdrop.classList.add("open");wizard.setAttribute("aria-hidden","false");
}
function closeWizard(){wizard.classList.remove("open");wizardBackdrop.classList.remove("open");wizard.setAttribute("aria-hidden","true");}
function saveDraft(show=true){sync();localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));if(show)toast("Saved to finish later on this device.");}
function heading(a,b){return `<div class="step-wrap"><h2>${a}</h2><p>${b}</p>`;}
function customerStep(){
 const q=draft.customerSearch.toLowerCase(); const results=state.customers.filter(c=>!q||c.name.toLowerCase().includes(q)||(c.phone||"").includes(q)).slice(0,10);
 const c=selectedCustomer(); const addresses=c?.addresses||[];
 return `${heading("Who is this job for?","Choose a customer; their saved addresses load automatically.")}
 <div class="choice-grid"><label class="choice"><input type="radio" name="customerMode" value="existing" ${draft.customerMode==="existing"?"checked":""}><strong>Existing Customer</strong></label><label class="choice"><input type="radio" name="customerMode" value="new" ${draft.customerMode==="new"?"checked":""}><strong>New Customer</strong></label></div>
 ${draft.customerMode==="existing"?`<div class="field sticky-search"><label>Search customers</label><input id="customerSearch" value="${esc(draft.customerSearch)}" autocomplete="off"><div class="search-results" id="customerResults">${results.map(x=>`<button type="button" class="customer-result ${x.id===draft.customerId?"selected":""}" data-select-customer="${esc(x.id)}"><div><strong>${esc(x.name)}</strong><small>${esc(x.phone||"")}</small></div><span>${x.id===draft.customerId?"✓":"›"}</span></button>`).join("")}</div></div>`:`<div class="form-grid"><div class="field"><label>First name</label><input name="firstName" value="${esc(draft.firstName)}"></div><div class="field"><label>Last name</label><input name="lastName" value="${esc(draft.lastName)}"></div><div class="field"><label>Phone</label><input name="phone" value="${esc(draft.phone)}"></div><div class="field"><label>Email</label><input name="email" value="${esc(draft.email)}"></div></div>`}
 ${draft.customerMode==="existing"&&c?`<div class="field"><label>Service address</label>${addresses.length?`<div class="choice-grid">${addresses.map(a=>`<label class="choice"><input type="radio" name="addressId" value="${esc(a.id)}" ${draft.addressId===a.id?"checked":""}><strong>${esc(a.label||"Saved address")}</strong><small>${esc(a.address)}</small></label>`).join("")}<label class="choice"><input type="radio" name="addressId" value="new" ${draft.addressId==="new"?"checked":""}><strong>Use another address</strong></label></div>`:`<div class="notice">No saved address for this customer.</div>`}</div>`:""}
 ${draft.customerMode==="new"||draft.addressId==="new"||(!addresses.length&&c)?`<div class="field"><label>Service address</label><input name="address" value="${esc(draft.address)}" placeholder="Start typing an address"></div>`:""}</div>`;
}
function itemEditor(item,i){
 const isNew=item.condition==="New"; const brands=[...new Map(state.products.filter(p=>p.equipmentTypeId===item.equipmentTypeId).map(p=>[p.brandId||p.brand,{id:p.brandId||p.brand,name:p.brand}])).values()];
 const products=state.products.filter(p=>p.equipmentTypeId===item.equipmentTypeId&&(p.brandId===item.brandId||p.brand===item.brandId));
 return `<div class="equipment-editor"><div class="equipment-editor__head"><strong>Item ${i+1}</strong>${draft.equipment.length>1?`<button type="button" class="remove-link" data-remove-equipment="${i}">Remove</button>`:""}</div>
 <div class="choice-grid"><label class="choice"><input type="radio" data-item-condition="${i}" value="New" ${isNew?"checked":""}><strong>New</strong><small>Choose from product catalog</small></label><label class="choice"><input type="radio" data-item-condition="${i}" value="Used" ${!isNew?"checked":""}><strong>Used</strong><small>Enter flexible details</small></label></div>
 <div class="field"><label>Equipment type</label><select data-equipment-field="equipmentTypeId" data-index="${i}">${optionList(state.equipmentTypes,item.equipmentTypeId)}</select></div>
 ${isNew?`<div class="form-grid"><div class="field"><label>Brand</label><select data-equipment-field="brandId" data-index="${i}"><option value="">Choose brand</option>${optionList(brands,item.brandId)}</select></div><div class="field"><label>Model</label><select data-equipment-field="productId" data-index="${i}"><option value="">Choose model</option>${products.map(p=>`<option value="${esc(p.id)}" ${p.id===item.productId?"selected":""}>${esc(p.model)}</option>`).join("")}</select></div></div><div class="field"><label>Fulfillment condition</label><select data-equipment-field="fulfillmentConditionId" data-index="${i}">${state.fulfillmentConditions.map(f=>`<option value="${esc(f.id)}" ${f.id===item.fulfillmentConditionId?"selected":""}>${esc(f.name)}</option>`).join("")}</select><small class="field-note">Floor Model and In-Box Delivery waive the build charge. Final overrides are manager-only.</small></div>`:`<div class="form-grid"><div class="field"><label>Brand</label><input data-equipment-field="brand" data-index="${i}" value="${esc(item.brand)}"></div><div class="field"><label>Model</label><input data-equipment-field="model" data-index="${i}" value="${esc(item.model)}"></div></div><div class="field"><label>Description / notes</label><textarea data-equipment-field="notes" data-index="${i}">${esc(item.notes)}</textarea></div>`}
 <div class="auto-rule">Crew: <strong>${esc(selectedType(item).defaultCrewSize||2)} people</strong> · Build: <strong>${isNew&&item.fulfillmentConditionId==="NIB"?"Required":"Not charged"}</strong></div></div>`;
}
function equipmentStep(){return `${heading("What equipment is involved?","Choose New or Used first. New products use the catalog; used products use text fields.")}<div class="field"><label>Job type</label><select name="jobTypeId">${optionList(state.jobTypes,draft.jobTypeId)}</select></div>${draft.equipment.map(itemEditor).join("")}<button type="button" class="add-row" id="addEquipment">＋ Add Another Item</button></div>`;}
function accessStep(){return `${heading("Delivery conditions","Select every condition that applies.")}<div class="choice-grid">${state.accessConditions.map(a=>`<label class="choice"><input type="checkbox" name="access" value="${esc(a.id)}" ${draft.access.includes(a.id)?"checked":""}><strong>${esc(a.name)}</strong><small>${Number(a.flatCharge||0)?`Adds $${a.flatCharge}`:"Select when applicable"}</small></label>`).join("")}</div></div>`;}
function scheduleStep(){return `${heading("When should we hold the appointment?","Crew size is calculated automatically and cannot be changed by employees.")}<div class="form-grid"><div class="field"><label>Date</label><input name="scheduledDate" type="date" value="${esc(draft.scheduledDate)}"></div><div class="field"><label>Start time</label><input name="scheduledTime" type="time" value="${esc(draft.scheduledTime)}"></div></div><div class="summary-box"><span>Required crew</span><strong>${crewSize()} people</strong></div><div class="field"><label>Internal notes</label><textarea name="internalNotes">${esc(draft.internalNotes)}</textarea></div></div>`;}
function quoteEstimate(){const item=draft.equipment[0],t=selectedType(item);let low=75+Number(t.defaultAssemblyCharge||0);if(item.condition==="Used")low+=25;if(item.fulfillmentConditionId!=="NIB")low-=Number(t.defaultAssemblyCharge||0);low+=state.accessConditions.filter(a=>draft.access.includes(a.id)).reduce((n,a)=>n+Number(a.flatCharge||0),0);low=Math.max(75,Math.round(low/5)*5);return [low,low+50];}
function reviewStep(){const [low,high]=quoteEstimate();if(draft.mode==="quote")return `${heading("Quick Quote estimate","A range protects the store until travel, exact product, and access details are confirmed.")}<div class="quote-price"><span>Estimated price</span><strong>$${low}–$${high}</strong></div><div class="review-section"><h3>Address</h3><p>${esc(draft.address||"Address entered")}</p></div><div class="review-section"><h3>Equipment</h3><p>${esc(selectedType(draft.equipment[0]).name||"Equipment")} · ${esc(draft.equipment[0].condition)}</p></div><div class="review-section"><h3>Conditions</h3><p>${esc(state.accessConditions.filter(a=>draft.access.includes(a.id)).map(a=>a.name).join(", ")||"None")}</p></div><div class="notice">Estimate subject to final equipment, access, travel, and service details.</div></div>`;
 const c=draft.customerMode==="existing"?selectedCustomer()?.name:`${draft.firstName} ${draft.lastName}`;return `${heading("Review the GamePlan","Confirm the working draft.")}<div class="summary-grid"><div class="summary-box"><span>Customer</span><strong>${esc(c)}</strong></div><div class="summary-box"><span>Crew</span><strong>${crewSize()} people</strong></div><div class="summary-box"><span>Equipment</span><strong>${draft.equipment.length} item(s)</strong></div><div class="summary-box"><span>Appointment</span><strong>${esc(draft.scheduledDate||"Unscheduled")}</strong></div></div><div class="review-section"><h3>Address</h3><p>${esc(draft.address)}</p></div><div class="notice">Save & Finish Later stores this on the current device. Creating this job writes it directly to the live GamePlan CMS.</div></div>`;}
function quoteAddressStep(){return `${heading("Where is the delivery?","No customer name or phone number is required.")}<div class="field"><label>Service address</label><input name="address" value="${esc(draft.address)}" placeholder="Start typing an address"></div></div>`;}
function quoteEquipmentStep(){return `${heading("What is being delivered?","Choose New or Used, then the equipment type. Exact item details are optional for an estimate.")}${itemEditor(draft.equipment[0],0)}</div>`;}
function sync(){const fd=new FormData(wizardForm);["customerMode","firstName","lastName","phone","email","address","addressId","jobTypeId","scheduledDate","scheduledTime","internalNotes"].forEach(k=>{if(fd.has(k))draft[k]=fd.get(k)});if(draft.step===2||draft.mode==="quote"&&draft.step===2)draft.access=fd.getAll("access");wizardForm.querySelectorAll("[data-equipment-field]").forEach(el=>{const i=+el.dataset.index;if(draft.equipment[i])draft.equipment[i][el.dataset.equipmentField]=el.value;});}
function validate(){sync();if(draft.mode==="quote"&&draft.step===0&&!draft.address.trim())return "Enter the delivery address.";if(draft.mode==="job"&&draft.step===0){if(draft.customerMode==="existing"&&!draft.customerId)return "Select a customer.";if(draft.customerMode==="new"&&(!draft.firstName||!draft.phone))return "Enter the customer name and phone.";if(!draft.address)return "Select or enter a service address.";}return "";}
function renderWizard(){const steps=draft.mode==="quote"?[quoteAddressStep,quoteEquipmentStep,accessStep,reviewStep]:[customerStep,equipmentStep,accessStep,scheduleStep,reviewStep];wizardStepLabel.textContent=`Step ${draft.step+1} of ${steps.length}`;wizardProgress.innerHTML=steps.map((_,i)=>`<i class="${i<=draft.step?"active":""}"></i>`).join("");wizardProgress.style.gridTemplateColumns=`repeat(${steps.length},1fr)`;wizardForm.innerHTML=steps[draft.step]();wizardBack.style.visibility=draft.step?"visible":"hidden";wizardNext.textContent=draft.step===steps.length-1?(draft.mode==="quote"?"Done":"Create Job"):"Continue";bindStep();}
function bindStep(){
 wizardForm.querySelectorAll('input[name="customerMode"]').forEach(el=>el.onchange=()=>{sync();draft.customerMode=el.value;draft.customerId="";draft.address="";renderWizard();});
 const search=wizardForm.querySelector("#customerSearch");if(search)search.oninput=()=>{draft.customerSearch=search.value;const q=draft.customerSearch.toLowerCase();const box=wizardForm.querySelector("#customerResults");box.innerHTML=state.customers.filter(c=>!q||c.name.toLowerCase().includes(q)||(c.phone||"").includes(q)).slice(0,10).map(x=>`<button type="button" class="customer-result" data-select-customer="${esc(x.id)}"><div><strong>${esc(x.name)}</strong><small>${esc(x.phone||"")}</small></div><span>›</span></button>`).join("");bindCustomerButtons();};
 bindCustomerButtons();wizardForm.querySelectorAll('input[name="addressId"]').forEach(el=>el.onchange=()=>{draft.addressId=el.value;if(el.value!=="new"){const a=selectedCustomer()?.addresses?.find(x=>x.id===el.value);draft.address=a?.address||"";}renderWizard();});
 wizardForm.querySelectorAll("[data-item-condition]").forEach(el=>el.onchange=()=>{sync();draft.equipment[+el.dataset.itemCondition]={...blankItem(),condition:el.value};renderWizard();});
 wizardForm.querySelectorAll('select[data-equipment-field="equipmentTypeId"],select[data-equipment-field="brandId"]').forEach(el=>el.onchange=()=>{sync();const item=draft.equipment[+el.dataset.index];if(el.dataset.equipmentField==="equipmentTypeId"){item.brandId="";item.productId="";}else item.productId="";renderWizard();});
 wizardForm.querySelector("#addEquipment")?.addEventListener("click",()=>{sync();draft.equipment.push(blankItem());renderWizard();});wizardForm.querySelectorAll("[data-remove-equipment]").forEach(el=>el.onclick=()=>{draft.equipment.splice(+el.dataset.removeEquipment,1);renderWizard();});
}
function bindCustomerButtons(){wizardForm.querySelectorAll("[data-select-customer]").forEach(el=>el.onclick=()=>{draft.customerId=el.dataset.selectCustomer;const c=selectedCustomer();const a=c?.addresses?.find(x=>x.default)||c?.addresses?.[0];draft.addressId=a?.id||"new";draft.address=a?.address||"";renderWizard();});}
wizardNext.onclick=async()=>{
 const err=validate();if(err)return toast(err);
 const count=draft.mode==="quote"?4:5;
 if(draft.step<count-1){draft.step++;if(draft.mode==="job")saveDraft(false);renderWizard();return;}
 if(draft.mode==="quote"){closeWizard();toast("Quick Quote complete.");return;}
 sync();
 wizardNext.disabled=true;wizardBack.disabled=true;wizardNext.textContent="Creating…";
 try{
   const pinToken = await requestPin("canCreateQuote", "Enter your employee PIN to create this job and stamp your name into its history.");
   const result=await api.createJob(draft, pinToken);
   localStorage.removeItem(DRAFT_KEY);
   closeWizard();
   toast(`${result.jobNumber || "Job"} created in the live CMS.`);
   await loadLiveData();
   go("jobs");
 }catch(error){
   console.error(error);
   toast(error.message || "The job could not be created.");
   wizardNext.disabled=false;wizardBack.disabled=false;renderWizard();
 }
};
wizardBack.onclick=()=>{sync();draft.step=Math.max(0,draft.step-1);renderWizard();};document.querySelector("#closeWizard").onclick=closeWizard;document.querySelector("#saveDraftTop").onclick=()=>saveDraft(true);wizardBackdrop.onclick=closeWizard;

document.querySelector("#closeDrawer").onclick = closeJob;
drawerBackdrop.onclick = closeJob;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(console.error));
}

loadPinSession();
updateDataStatus();
go(location.hash.slice(1) || "today");
if (googleSignOutButton) {
  googleSignOutButton.addEventListener("click", event => {
    event.stopPropagation();
    signOutOfGamePlan();
  });
}
initializeGoogleAuthentication();
