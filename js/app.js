import { GamePlanApi } from "./api.js?v=3.2.8-alpha8-p013-fix01";

const CACHE_KEY = "gameplan-live-bootstrap-v2";
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
  authenticated: false,
  staffManagement: { loaded: false, loading: false, profiles: [], roles: [], loginAccounts: [] }
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

const PIN_SESSION_KEY = "gameplan-pin-session-v2";
const PIN_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function loadPinSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PIN_SESSION_KEY) || "null");
    if (saved && saved.token && saved.expiresAt > Date.now()) state.pinSession = saved;
    else sessionStorage.removeItem(PIN_SESSION_KEY);
  } catch (_) {
    sessionStorage.removeItem(PIN_SESSION_KEY);
  }
}

function touchPinSession() {
  if (!state.pinSession?.token) return;
  state.pinSession.expiresAt = Date.now() + PIN_IDLE_TIMEOUT_MS;
  sessionStorage.setItem(PIN_SESSION_KEY, JSON.stringify(state.pinSession));
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
  if (showMessage) toast("GamePlan locked. The next accountable action will require an employee PIN.");
}

function pinModalHtml({ purpose = "Enter your PIN to continue.", managerApproval = false } = {}) {
  return `<div class="pin-backdrop open" id="pinBackdrop">
    <section class="pin-modal ${managerApproval ? "manager-approval" : ""}" role="dialog" aria-modal="true" aria-labelledby="pinTitle">
      <button class="pin-close" id="pinClose" aria-label="Cancel">×</button>
      <div class="pin-icon">●●●●</div>
      <h2 id="pinTitle">${managerApproval ? "Manager approval" : "Employee verification"}</h2>
      <p>${esc(purpose)}</p>
      <label class="field"><span>${managerApproval ? "Manager PIN" : "Employee PIN"}</span><input id="pinInput" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="4–8 digits"></label>
      <div class="pin-error" id="pinError"></div>
      <button class="button primary-action" id="pinSubmit">${managerApproval ? "Approve Action" : "Verify & Continue"}</button>
    </section>
  </div>`;
}

function promptForPin({ requiredPermission = "", purpose = "", managerApproval = false, saveEmployeeSession = true } = {}) {
  return new Promise((resolve, reject) => {
    document.body.insertAdjacentHTML("beforeend", pinModalHtml({ purpose, managerApproval }));
    const backdrop = document.querySelector("#pinBackdrop");
    const input = document.querySelector("#pinInput");
    const submit = document.querySelector("#pinSubmit");
    const errorBox = document.querySelector("#pinError");
    const close = () => { backdrop?.remove(); reject(new Error("Verification cancelled.")); };
    document.querySelector("#pinClose").onclick = close;
    backdrop.onclick = event => { if (event.target === backdrop) close(); };
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit.click(); });
    submit.onclick = async () => {
      const pin = input.value.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        errorBox.textContent = "Enter your 4–8 digit PIN.";
        return;
      }
      submit.disabled = true;
      submit.textContent = "Verifying…";
      errorBox.textContent = "";
      try {
        const result = await api.verifyPin(pin, requiredPermission);
        const expiresAt = Date.now() + Number(result.expiresInSeconds || 900) * 1000;
        if (saveEmployeeSession) {
          state.pinSession = { token: result.token, employee: result.employee, expiresAt };
          sessionStorage.setItem(PIN_SESSION_KEY, JSON.stringify(state.pinSession));
          renderCurrentUser();
        }
        backdrop.remove();
        resolve({ token: result.token, employee: result.employee, expiresAt });
      } catch (error) {
        errorBox.textContent = error.message || "PIN verification failed.";
        submit.disabled = false;
        submit.textContent = managerApproval ? "Approve Action" : "Verify & Continue";
        input.value = "";
        input.focus();
      }
    };
    setTimeout(() => input.focus(), 0);
  });
}

async function requestPin(requiredPermission = "", purpose = "") {
  if (!state.currentUser?.sharedAccount) return "";
  const active = state.pinSession;
  if (active?.token && active.expiresAt > Date.now()) {
    const allowed = !requiredPermission || Boolean(active.employee?.permissions?.[requiredPermission]);
    if (allowed) {
      touchPinSession();
      return active.token;
    }
  }
  const result = await promptForPin({ requiredPermission, purpose, managerApproval: false, saveEmployeeSession: true });
  return result.token;
}

async function requestManagerApproval(purpose = "Manager approval is required for this action.") {
  if (!state.currentUser?.sharedAccount) {
    if (!can("canApproveSchedule")) throw new Error("Manager authorization is required for this action.");
    return "";
  }
  if (state.pinSession?.token && state.pinSession.expiresAt > Date.now() && state.pinSession.employee?.permissions?.canApproveSchedule) {
    touchPinSession();
    return state.pinSession.token;
  }
  const result = await promptForPin({
    requiredPermission: "canApproveSchedule",
    purpose,
    managerApproval: true,
    saveEmployeeSession: false
  });
  return result.token;
}

function renderCurrentUser() {
  const name = document.querySelector("#profileName");
  const role = document.querySelector("#profileRole");
  const avatar = document.querySelector("#profileAvatar");
  const user = effectiveUser();
  const shared = Boolean(state.currentUser?.sharedAccount);
  if (name) name.textContent = shared && !state.pinSession ? "Shared Employee Account" : (user.displayName || user.email || "GamePlan User");
  if (role) role.textContent = shared && !state.pinSession ? "PIN required only for accountable actions" : `${user.roleName || "Employee"}${shared ? " · Tap to lock / switch" : ""}`;
  if (avatar) avatar.textContent = (user.displayName || user.email || "G").trim().charAt(0).toUpperCase();
  const profile = document.querySelector(".profile");
  if (googleSignOutButton) googleSignOutButton.hidden = !state.authenticated;
  if (profile) {
    profile.classList.toggle("profile-action", shared);
    profile.onclick = shared ? event => {
      if (event.target === googleSignOutButton) return;
      clearPinSession(true);
    } : null;
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


function jobDetailsComplete(job) {
  return String(job.detailsStatus || "").toLowerCase() === "complete";
}

function jobNeedsDetails(job) {
  const status = String(job.status || "").toLowerCase();
  if (["completed", "cancelled"].includes(status)) return false;
  return !jobDetailsComplete(job);
}

function jobHasFutureAppointment(job) {
  if (!job || !job.dateTime) return false;
  const appointment = new Date(job.dateTime);
  return !Number.isNaN(appointment.getTime()) && appointment.getTime() >= Date.now();
}

function jobNeedsOfficeAttention(job) {
  const status = String(job.status || "").toLowerCase();
  return status === "tentative" && jobHasFutureAppointment(job);
}

function statusCount(status) {
  if (status === "Needs Attention") return state.jobs.filter(jobNeedsOfficeAttention).length;
  return state.jobs.filter(job => job.status === status).length;
}

function homeStatusButtons() {
  const cards = [
    ["Tentative", "tentative", "▣"],
    ["Needs Attention", "attention", "!"],
    ["Scheduled", "scheduled", "✓"],
    ["Completed", "completed", "✓"]
  ];
  return `<section class="home-status-grid" aria-label="Job status filters">${cards.map(([label,tone,icon]) =>
    `<button class="home-status-card ${tone}" type="button" data-home-status="${esc(label)}"><i>${icon}</i><b>${statusCount(label)}</b><span>${esc(label)}</span></button>`
  ).join("")}</section>`;
}

function employeeDisplayName(value) {
  return String(value || "").replace(/\s*\[[^\]]+\]\s*$/, "").trim();
}

function needsAttentionCard(job) {
  const equipment = job.equipment || [];
  const deliveryCount = equipment.reduce((sum,item) => item.deliveryRequired === false ? sum : sum + Math.max(1,Number(item.quantity || 1)), 0);
  const pickupCount = equipment.reduce((sum,item) => item.pickupRequired === true ? sum + Math.max(1,Number(item.quantity || 1)) : sum, 0);
  const itemLines = [
    deliveryCount ? `${deliveryCount} Item${deliveryCount === 1 ? "" : "s"} Delivery` : "",
    pickupCount ? `${pickupCount} Item${pickupCount === 1 ? "" : "s"} Pickup` : ""
  ].filter(Boolean).join("<br>");
  const createdByName = employeeDisplayName(job.createdBy) || "Unknown employee";
  const detailsComplete = jobDetailsComplete(job);
  const label = detailsComplete ? "AWAITING MANAGER APPROVAL" : "DETAILS NEEDED";
  const action = detailsComplete
    ? `<button class="button attention-complete" type="button" data-review-job="${esc(job.id)}">Review Appointment</button>`
    : `<button class="button attention-complete" type="button" data-complete-details="${esc(job.id)}">Complete Details</button>`;
  const stageClass = detailsComplete ? "awaiting-approval" : "details-needed";
  return `<article class="attention-job-card ${stageClass}" data-job-id="${esc(job.id)}">
    <div class="attention-rail"></div><div class="attention-symbol">${detailsComplete ? "✓" : "!"}</div>
    <div class="attention-copy"><strong>${label}</strong><h3>${esc(job.customer)}</h3>
      <p>${esc(job.date)} · ${esc(job.time)}<br>${itemLines || esc(job.type)}<br><span class="attention-created-by">Set up by: ${esc(createdByName)}</span></p>
      <span class="badge tentative">${esc(job.status)}</span></div>
    ${action}
  </article>`;
}

function equipmentTypeName(item) {
  return state.equipmentTypes.find(type => type.id === item.equipmentTypeId)?.name || item.typeName || item.type || "Equipment";
}

function detailsItemIcon(item) {
  const type = state.equipmentTypes.find(value => value.id === item.equipmentTypeId) || { id:item.equipmentTypeId, name:equipmentTypeName(item) };
  return gpIcon(iconNameFor(type));
}

function productOptionsFor(item) {
  return state.products.filter(product => product.equipmentTypeId === item.equipmentTypeId)
    .map(product => `<option value="${esc(product.id)}" ${product.id===item.productId?"selected":""}>${esc([product.brand,product.model].filter(Boolean).join(" "))}</option>`).join("");
}

function completeDetailsItemCard(item,index) {
  const pickupOnly = item.pickupRequired === true && item.deliveryRequired === false;
  const isNew = String(item.condition).toLowerCase() === "new";
  const title = pickupOnly ? equipmentTypeName(item) : `${isNew ? "New" : "Used"} ${equipmentTypeName(item)}`;
  if (pickupOnly) return `<section class="complete-item-card pickup-only-detail-card" data-details-item="${index}">
    <div class="complete-item-head"><span class="item-number">${index+1}</span><i class="equipment-reference-icon">${detailsItemIcon(item)}</i><div><h3>${esc(title)}</h3><p>Quantity: ${Math.max(1,Number(item.quantity||1))}</p></div></div>
    <div class="pickup-detail-notice"><b>No equipment details required</b><span>Manufacturer, model, condition, and photos will be recorded during the Pickup Item Checklist.</span></div>
  </section>`;
  if (isNew) return `<section class="complete-item-card" data-details-item="${index}">
    <div class="complete-item-head"><span class="item-number">${index+1}</span><i class="equipment-reference-icon">${detailsItemIcon(item)}</i><div><h3>${esc(title)}</h3><p>Quantity: ${Math.max(1,Number(item.quantity||1))}</p></div></div>
    <label class="details-field"><span>Model</span><select data-detail-product><option value="">Select model…</option>${productOptionsFor(item)}</select></label>
    <div class="details-product-image" data-product-image>${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="Selected equipment">`:`<span>▧<small>Image will appear when<br>model is selected</small></span>`}</div>
  </section>`;
  return `<section class="complete-item-card" data-details-item="${index}">
    <div class="complete-item-head"><span class="item-number">${index+1}</span><i class="equipment-reference-icon">${detailsItemIcon(item)}</i><div><h3>${esc(title)}</h3><p>Quantity: ${Math.max(1,Number(item.quantity||1))}</p></div></div>
    <label class="details-field"><span>Manufacturer</span><input data-detail-manufacturer value="${esc(item.brand||"")}" placeholder="Enter manufacturer"></label>
    <label class="details-field"><span>Equipment Type</span><input data-detail-equipment-type value="${esc(equipmentTypeName(item))}" placeholder="Enter equipment type"></label>
    <label class="details-field"><span>Model</span><input data-detail-model value="${esc(item.model && item.model !== equipmentTypeName(item) ? item.model : "")}" placeholder="Enter model or identifying description"></label>
    <label class="details-photo-field"><span>Photo <small>(Required)</small></span><div class="details-photo-control ${item.imageUrl?"has-photo":""}" data-photo-control>
      ${item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="Used equipment photo">`:`<b>▣</b><em>Tap to take photo</em>`}
      <input type="file" accept="image/*" capture="environment" data-detail-photo aria-label="Take equipment photo">
    </div></label>
  </section>`;
}

function openCompleteDetails(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  const deliveryItems = (job.equipment || []).filter(item => item.deliveryRequired !== false && !item.pickupRequired);
  const pickupItems = (job.equipment || []).filter(item => item.pickupRequired);
  const allItems = [...deliveryItems,...pickupItems];
  drawerContent.innerHTML = `<div class="complete-details-screen" data-details-job="${esc(job.id)}">
    ${renderLifecycle(job.status)}
    ${renderJobSummaryCard(job, { showItemCounts: true })}
    <p class="complete-instruction">Complete the required details for delivery items. Pickup items will be documented during the Pickup Item Checklist.</p>
    ${deliveryItems.length?`<h2 class="complete-section-title">DELIVERY ITEMS (${deliveryItems.length})</h2>${deliveryItems.map((item,i)=>completeDetailsItemCard(item,i)).join("")}`:""}
    ${pickupItems.length?`<h2 class="complete-section-title">PICKUP ITEMS (${pickupItems.length})</h2>${pickupItems.map((item,i)=>completeDetailsItemCard(item,deliveryItems.length+i)).join("")}`:""}
    ${job.hasPickup?`<h2 class="complete-section-title">PICKUP DETAILS</h2><section class="pickup-details-card"><fieldset><legend>Pickup Type <small>(Required)</small></legend><label><input type="radio" name="pickupType" value="Sale" ${job.pickupType==="Sale"?"checked":""}> Pickup for Sale</label><label><input type="radio" name="pickupType" value="Disposal" ${job.pickupType==="Disposal"?"checked":""}> Pickup for Disposal</label></fieldset><label class="details-field stacked"><span>Pickup Notes <small>(Optional)</small></span><textarea name="pickupNotes" placeholder="Add any notes about the pickup…">${esc(job.pickupNotes||"")}</textarea></label></section>`:""}
    <div class="complete-details-error" data-details-error></div>
    <button class="button save-details-button" type="button" data-save-details>▣ &nbsp; Save Details</button>
  </div>`;
  drawer.classList.add("open","complete-details-open"); drawerBackdrop.classList.add("open"); drawer.setAttribute("aria-hidden","false");
  bindCompleteDetails(job, allItems);
}

function fileToDataUrl(file) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("The photo could not be read."));reader.readAsDataURL(file);});
}

function bindCompleteDetails(job, items) {
  const screen = drawerContent.querySelector(".complete-details-screen");
  screen.querySelectorAll("[data-detail-product]").forEach(select => select.onchange = () => {
    const card=select.closest("[data-details-item]"); const item=items[Number(card.dataset.detailsItem)]; const product=state.products.find(value=>value.id===select.value);
    item.productId=select.value; item.brand=product?.brand||""; item.model=product?.model||""; item.imageUrl=product?.imageUrl||"";
    const image=card.querySelector("[data-product-image]"); image.innerHTML=item.imageUrl?`<img src="${esc(item.imageUrl)}" alt="${esc(item.model)}">`:`<span>▧<small>Product image is not available</small></span>`;
  });
  screen.querySelectorAll("[data-detail-photo]").forEach(input => input.onchange = async () => {
    const file=input.files?.[0]; if(!file)return; const card=input.closest("[data-details-item]"); const item=items[Number(card.dataset.detailsItem)];
    item.photoDataUrl=await fileToDataUrl(file); item.photoName=file.name||`equipment-${Date.now()}.jpg`;
    const control=card.querySelector("[data-photo-control]"); control.classList.add("has-photo"); control.querySelectorAll("img,b,em").forEach(el=>el.remove()); control.insertAdjacentHTML("afterbegin",`<img src="${item.photoDataUrl}" alt="Equipment photo preview">`);
  });
  screen.querySelector("[data-save-details]").onclick = async event => {
    const button=event.currentTarget; const errorBox=screen.querySelector("[data-details-error]"); errorBox.textContent="";
    const payloadItems=items.map((item,index)=>{
      const card=screen.querySelector(`[data-details-item="${index}"]`);
      const pickupOnly=item.pickupRequired===true&&item.deliveryRequired===false;
      const isNew=String(item.condition).toLowerCase()==="new";
      return {
        jobEquipmentId:item.id, condition:item.condition, equipmentTypeId:item.equipmentTypeId,
        deliveryRequired:item.deliveryRequired!==false, pickupRequired:item.pickupRequired===true,
        productId:!pickupOnly&&isNew?(card.querySelector("[data-detail-product]")?.value||""):"",
        manufacturer:pickupOnly?"":(isNew?item.brand:(card.querySelector("[data-detail-manufacturer]")?.value.trim()||"")),
        equipmentTypeText:pickupOnly?equipmentTypeName(item):(isNew?equipmentTypeName(item):(card.querySelector("[data-detail-equipment-type]")?.value.trim()||"")),
        model:pickupOnly?"":(isNew?item.model:(card.querySelector("[data-detail-model]")?.value.trim()||"")),
        photoDataUrl:pickupOnly?"":(item.photoDataUrl||""), photoName:pickupOnly?"":(item.photoName||"")
      };
    });
    const missing=payloadItems.find((detail,index)=>{
      const source=items[index];
      const pickupOnly=source.pickupRequired===true&&source.deliveryRequired===false;
      if(pickupOnly)return false;
      return String(detail.condition).toLowerCase()==="new"
        ? !detail.productId
        : !detail.manufacturer||!detail.model||(!detail.photoDataUrl&&!source.imageUrl);
    });
    const pickupType=screen.querySelector('[name="pickupType"]:checked')?.value||"";
    if(missing){errorBox.textContent="Choose a model for every new delivery item and add a manufacturer, equipment type, model, and photo for every used delivery item.";return;}
    if(job.hasPickup&&!pickupType){errorBox.textContent="Choose Pickup for Sale or Pickup for Disposal.";return;}
    button.disabled=true;button.textContent="Saving…";
    try{const pinToken=await requestPin("canCreateQuote","Enter your employee PIN to save equipment details.");await api.updateJobDetails(job.id,payloadItems,pickupType,screen.querySelector('[name="pickupNotes"]')?.value||"",pinToken);touchPinSession();toast("Job details saved.");closeJob();await loadLiveData();go("today");}
    catch(error){console.error(error);errorBox.textContent=error.message||"The details could not be saved.";button.disabled=false;button.textContent="▣  Save Details";}
  };
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


function jobItemCounts(job) {
  const equipment = job?.equipment || [];
  return {
    delivery: equipment.reduce((sum, item) => item.deliveryRequired === false ? sum : sum + Math.max(1, Number(item.quantity || 1)), 0),
    pickup: equipment.reduce((sum, item) => item.pickupRequired === true ? sum + Math.max(1, Number(item.quantity || 1)) : sum, 0)
  };
}

function renderJobSummaryCard(job, options = {}) {
  const counts = jobItemCounts(job);
  const createdByName = employeeDisplayName(job.createdBy) || "Unknown employee";
  const countLines = options.showItemCounts ? `
      ${counts.delivery ? `<div class="detail-line"><span>Delivery</span><strong>${counts.delivery} Item${counts.delivery === 1 ? "" : "s"}</strong></div>` : ""}
      ${counts.pickup ? `<div class="detail-line"><span>Pickup</span><strong>${counts.pickup} Item${counts.pickup === 1 ? "" : "s"}</strong></div>` : ""}` : "";
  return `<section class="detail-card job-summary-card">
      <div class="job-summary-top"><span>Job #${esc(job.number || job.id)}</span><span class="badge ${badgeClass(job.status)}">${esc(job.status)}</span></div>
      <h3>${esc(job.customer)}</h3>
      <div class="customer-address">${esc(job.address)}</div>
      <div class="detail-line"><span>Appointment</span><strong>${esc(job.date)}, ${esc(job.time)}</strong></div>
      <div class="detail-line"><span>Estimated duration</span><strong>${esc(job.duration || "—")}</strong></div>${countLines}
      <div class="detail-line summary-created-by"><span>Set up by</span><strong>${esc(createdByName)}</strong></div>
    </section>`;
}

function equipmentImage(item) {
  const pickupOnly = item?.pickupRequired === true && item?.deliveryRequired === false;
  if (pickupOnly) {
    return `<div class="equipment-photo equipment-photo--generic" aria-label="Pickup item">${gpIcon(iconNameFor(item))}</div>`;
  }
  if (item?.imageUrl) {
    return `<img class="equipment-photo" src="${esc(item.imageUrl)}" alt="${esc([item.brand, item.model].filter(Boolean).join(" ") || "Equipment")}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'equipment-photo equipment-photo--generic',textContent:'Equipment'}))">`;
  }
  return `<div class="equipment-photo equipment-photo--generic" aria-label="Equipment image unavailable">${gpIcon(iconNameFor(item))}</div>`;
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


const PICKUP_APPEARANCE_QUESTIONS = [
  ["covers", "Covers and end caps are intact"],
  ["upholstery", "Upholstery is acceptable"],
  ["wheels", "Transport wheels are intact and work"]
];

const PICKUP_FUNCTION_QUESTIONS = [
  ["sound", "Machine sounds appropriate"],
  ["console", "Console display works fully"],
  ["buttons", "All buttons function properly"],
  ["heartRate", "Heart rate monitor works"],
  ["fans", "Fans work"],
  ["folds", "Unit folds and locks"]
];

function pickupInspectionComplete(job) {
  return String(job.pickupInspectionStatus || "").toLowerCase() === "complete";
}

function pickupQuestionRow(key, label) {
  return `<div class="pickup-question" data-pickup-question="${esc(key)}">
    <span>${esc(label)}</span>
    <div class="pickup-response-group" role="radiogroup" aria-label="${esc(label)}">
      ${["Pass","Issue","N/A"].map(value => `<label><input type="radio" name="pickup-${esc(key)}" value="${value}"><em>${value}</em></label>`).join("")}
    </div>
    <label class="pickup-issue-note"><span>Issue notes</span><textarea placeholder="Describe the issue…"></textarea></label>
  </div>`;
}

function pickupInspectionItemCard(item, index) {
  const title = [item.brand, item.model].filter(Boolean).join(" ") || `Used ${equipmentTypeName(item)}`;
  return `<section class="pickup-inspection-item" data-pickup-item="${index}">
    <div class="complete-item-head"><span class="item-number">${index + 1}</span><i class="equipment-reference-icon">${detailsItemIcon(item)}</i><div><h3>${esc(title)}</h3><p>${esc(equipmentTypeName(item))} · Quantity: ${Math.max(1, Number(item.quantity || 1))}</p></div></div>
    <h3 class="pickup-card-title">Appearance</h3>
    <div class="pickup-question-list">${PICKUP_APPEARANCE_QUESTIONS.map(([key,label]) => pickupQuestionRow(`${index}-appearance-${key}`, label)).join("")}</div>
    <h3 class="pickup-card-title">Function</h3>
    <div class="pickup-question-list">${PICKUP_FUNCTION_QUESTIONS.map(([key,label]) => pickupQuestionRow(`${index}-function-${key}`, label)).join("")}</div>
    <label class="details-photo-field"><span>Pickup Photo <small>(Required)</small></span><div class="details-photo-control" data-pickup-photo-control>
      <b>▣</b><em>Tap to take photo</em>
      <input type="file" accept="image/*" capture="environment" data-pickup-photo aria-label="Take pickup equipment photo">
    </div></label>
    <fieldset class="pickup-disassembly"><legend>Disassembled?</legend>
      <label><input type="radio" name="disassembled-${index}" value="No" checked> No</label>
      <label><input type="radio" name="disassembled-${index}" value="Yes"> Yes</label>
    </fieldset>
    <label class="details-field stacked pickup-disassembly-notes"><span>Description of disassembly</span><textarea placeholder="Describe what was removed or disassembled…"></textarea></label>
    <label class="details-field stacked"><span>Item Notes <small>(Optional)</small></span><textarea data-pickup-item-notes placeholder="Add any additional notes…"></textarea></label>
  </section>`;
}

function signatureCanvasMarkup() {
  return `<div class="signature-wrap">
    <canvas data-customer-signature width="900" height="300" aria-label="Customer signature pad"></canvas>
    <div class="signature-placeholder">Customer signs here</div>
    <button type="button" class="button neutral signature-clear" data-clear-signature>Clear Signature</button>
  </div>`;
}

function setupSignaturePad(screen) {
  const canvas = screen.querySelector("[data-customer-signature]");
  const placeholder = screen.querySelector(".signature-placeholder");
  if (!canvas) return { hasSignature: () => false, dataUrl: () => "" };
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let drawing = false;
  let signed = false;

  const position = event => {
    const rect = canvas.getBoundingClientRect();
    const point = event.touches?.[0] || event;
    return {
      x: (point.clientX - rect.left) * (canvas.width / rect.width),
      y: (point.clientY - rect.top) * (canvas.height / rect.height)
    };
  };
  const start = event => {
    event.preventDefault();
    drawing = true;
    const p = position(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = event => {
    if (!drawing) return;
    event.preventDefault();
    const p = position(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    signed = true;
    placeholder?.classList.add("hidden");
  };
  const end = () => { drawing = false; };

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  canvas.addEventListener("touchstart", start, { passive:false });
  canvas.addEventListener("touchmove", move, { passive:false });
  canvas.addEventListener("touchend", end);

  screen.querySelector("[data-clear-signature]")?.addEventListener("click", () => {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    signed = false;
    placeholder?.classList.remove("hidden");
  });

  return {
    hasSignature: () => signed,
    dataUrl: () => signed ? canvas.toDataURL("image/png") : ""
  };
}

function normalizedPickupType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "sale" || type === "trade-in" || type === "trade in") return "Trade-In";
  if (type === "disposal") return "Disposal";
  return "";
}

function openPickupInspection(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  const pickupItems = (job.equipment || []).filter(item => item.pickupRequired);
  if (!pickupItems.length) return toast("This job has no pickup items.");

  drawerContent.innerHTML = `<div class="complete-details-screen pickup-inspection-screen" data-pickup-job="${esc(job.id)}">
    <section class="complete-job-summary"><div><b>${esc(job.customer)}</b><span>${esc(job.date)} at ${esc(job.time)}</span><small>${esc(job.address)}</small></div><span class="badge ${badgeClass(job.status)}">${esc(job.status)}</span><footer><span>Job #${esc(job.number||job.id)}<br>${pickupItems.length} Pickup Item${pickupItems.length===1?"":"s"}</span><span>${esc(job.type)}<br>${esc(job.duration||"")}</span></footer></section>
    <p class="complete-instruction">Inspect each pickup item, document its condition, attach a current photo, and obtain the customer’s signature.</p>
    <h2 class="complete-section-title">PICKUP FOR</h2>
    <section class="pickup-details-card pickup-type-readonly"><span>Pickup Type</span><strong>${esc(normalizedPickupType(job.pickupType)||"Not selected")}</strong><small>Set when the appointment details were completed.</small></section>
    <h2 class="complete-section-title">EQUIPMENT INSPECTION (${pickupItems.length})</h2>
    ${pickupItems.map(pickupInspectionItemCard).join("")}
    <h2 class="complete-section-title">OVERALL CONDITION</h2>
    <section class="pickup-details-card overall-condition-card"><fieldset><legend>Overall Condition <small>(Required)</small></legend>
      ${["Excellent","Good","Fair","Poor"].map(value=>`<label><input type="radio" name="overallCondition" value="${value}"> ${value}</label>`).join("")}
    </fieldset>
    <label class="details-field stacked"><span>Additional Notes <small>(Optional)</small></span><textarea name="pickupInspectionNotes" placeholder="Add any final notes about the pickup…"></textarea></label></section>
    <h2 class="complete-section-title">CUSTOMER ACKNOWLEDGMENT</h2>
    <section class="pickup-details-card signature-card"><p>I confirm that the equipment listed above was picked up and that the condition notes shown are an accurate record of the employee’s assessment at the time of pickup.</p>
      <label class="details-field"><span>Customer Name</span><input name="signatureName" value="${esc(job.customer)}" placeholder="Customer name"></label>
      ${signatureCanvasMarkup()}
    </section>
    <div class="complete-details-error" data-pickup-error></div>
    <button class="button save-details-button" type="button" data-finalize-pickup>✓ &nbsp; Finalize Pickup</button>
  </div>`;

  drawer.classList.add("open","complete-details-open");
  drawerBackdrop.classList.add("open");
  drawer.setAttribute("aria-hidden","false");

  const screen = drawerContent.querySelector(".pickup-inspection-screen");
  const signature = setupSignaturePad(screen);

  screen.querySelectorAll("[data-pickup-question]").forEach(row => {
    row.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener("change", () => row.classList.toggle("has-issue", input.value === "Issue" && input.checked));
    });
  });

  screen.querySelectorAll('[name^="disassembled-"]').forEach(input => {
    input.addEventListener("change", () => {
      const card = input.closest("[data-pickup-item]");
      card?.classList.toggle("is-disassembled", input.value === "Yes" && input.checked);
    });
  });

  screen.querySelectorAll("[data-pickup-photo]").forEach(input => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const card = input.closest("[data-pickup-item]");
      const index = Number(card.dataset.pickupItem);
      const dataUrl = await fileToDataUrl(file);
      pickupItems[index].inspectionPhotoDataUrl = dataUrl;
      pickupItems[index].inspectionPhotoName = file.name || "pickup-photo.jpg";
      const control = card.querySelector("[data-pickup-photo-control]");
      control.classList.add("has-photo");
      control.innerHTML = `<img src="${esc(dataUrl)}" alt="Pickup equipment photo"><input type="file" accept="image/*" capture="environment" data-pickup-photo aria-label="Retake pickup equipment photo">`;
      control.querySelector("input").addEventListener("change", input.onchange || (()=>{}));
      openPickupPhotoRebind(control, pickupItems[index]);
    });
  });

  screen.querySelector("[data-finalize-pickup]").onclick = async event => {
    const button = event.currentTarget;
    const errorBox = screen.querySelector("[data-pickup-error]");
    errorBox.textContent = "";
    const pickupType = normalizedPickupType(job.pickupType);
    const overallCondition = screen.querySelector('[name="overallCondition"]:checked')?.value || "";
    if (!pickupType) return void(errorBox.textContent = "Pickup type is missing. Complete the job details before beginning the inspection.");
    if (!overallCondition) return void(errorBox.textContent = "Choose an overall condition.");
    if (!signature.hasSignature()) return void(errorBox.textContent = "Customer signature is required.");

    const items = [];
    for (let index=0; index<pickupItems.length; index++) {
      const card = screen.querySelector(`[data-pickup-item="${index}"]`);
      const responses = {};
      let missing = false;
      card.querySelectorAll("[data-pickup-question]").forEach(row => {
        const selected = row.querySelector('input[type="radio"]:checked');
        if (!selected) { missing = true; return; }
        const key = row.dataset.pickupQuestion.split("-").slice(1).join("-");
        const note = row.querySelector("textarea")?.value.trim() || "";
        if (selected.value === "Issue" && !note) missing = true;
        responses[key] = { result:selected.value, note };
      });
      if (missing) return void(errorBox.textContent = `Complete every inspection response and add notes for issues on item ${index+1}.`);
      if (!pickupItems[index].inspectionPhotoDataUrl) return void(errorBox.textContent = `Add a current pickup photo for item ${index+1}.`);
      const disassembled = card.querySelector(`[name="disassembled-${index}"]:checked`)?.value === "Yes";
      const disassemblyNotes = card.querySelector(".pickup-disassembly-notes textarea")?.value.trim() || "";
      if (disassembled && !disassemblyNotes) return void(errorBox.textContent = `Describe the disassembly for item ${index+1}.`);
      items.push({
        jobEquipmentId: pickupItems[index].id,
        responses,
        photoDataUrl: pickupItems[index].inspectionPhotoDataUrl,
        photoName: pickupItems[index].inspectionPhotoName,
        disassembled,
        disassemblyNotes,
        notes: card.querySelector("[data-pickup-item-notes]")?.value.trim() || ""
      });
    }

    const signatureName = screen.querySelector('[name="signatureName"]').value.trim();
    if (!signatureName) return void(errorBox.textContent = "Enter the customer name for the signature.");

    button.disabled = true;
    button.textContent = "Finalizing…";
    try {
      const pinToken = await requestPin("canCreateQuote","Enter your employee PIN to finalize this pickup.");
      await api.finalizePickupInspection(job.id, {
        pickupType,
        overallCondition,
        notes: screen.querySelector('[name="pickupInspectionNotes"]').value.trim(),
        signatureName,
        signatureDataUrl: signature.dataUrl(),
        items
      }, pinToken);
      touchPinSession();
      toast("Pickup inspection finalized.");
      closeJob();
      await loadLiveData();
      openJob(job.id);
    } catch (error) {
      console.error(error);
      errorBox.textContent = error.message || "The pickup inspection could not be finalized.";
      button.disabled = false;
      button.textContent = "✓  Finalize Pickup";
    }
  };
}

function openPickupPhotoRebind(control, item) {
  const input = control.querySelector("[data-pickup-photo]");
  if (!input) return;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    item.inspectionPhotoDataUrl = await fileToDataUrl(file);
    item.inspectionPhotoName = file.name || "pickup-photo.jpg";
    control.classList.add("has-photo");
    const img = control.querySelector("img");
    if (img) img.src = item.inspectionPhotoDataUrl;
  });
}

function pickupSummaryMarkup(job) {
  if (!pickupInspectionComplete(job)) return "";
  const summary = job.pickupSummary || {};
  return `<section class="detail-card pickup-summary-card">
    <div class="job-summary-top"><h3>Pickup Summary</h3><span class="badge completed">Complete</span></div>
    <div class="detail-line"><span>Pickup for</span><strong>${esc(summary.pickupType || job.pickupType || "—")}</strong></div>
    <div class="detail-line"><span>Overall condition</span><strong>${esc(summary.overallCondition || "—")}</strong></div>
    <div class="detail-line"><span>Issues found</span><strong>${Number(summary.issueCount || 0)}</strong></div>
    <div class="detail-line"><span>Photos</span><strong>${Number(summary.photoCount || 0)} Attached</strong></div>
    <div class="detail-line"><span>Customer signature</span><strong>Received ✓</strong></div>
    <div class="detail-line"><span>Completed by</span><strong>${esc(summary.completedBy || "—")}</strong></div>
    ${summary.notes ? `<p class="pickup-summary-notes">${esc(summary.notes)}</p>` : ""}
  </section>`;
}

function workflowActions(job) {
  const today = isTodayJob(job) && job.status === "Scheduled";
  if (job.status === "Tentative") {
    if (!jobDetailsComplete(job)) {
      return `<button class="button primary-action" data-complete-details="${esc(job.id)}">Complete Job Details</button>
        ${permissionNotice("Complete the required job details before manager approval.")}
        <button class="button neutral" data-reschedule-job="${esc(job.id)}">Edit / Reschedule</button>
        <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
    }
    const confirm = (isManager() || state.currentUser?.sharedAccount)
      ? `<button class="button primary-action" data-status-action="Scheduled" data-job-id="${esc(job.id)}">✓ Confirm Appointment</button>`
      : permissionNotice("This appointment is awaiting manager confirmation before it is added to the finalized schedule.");
    return `${confirm}
      <button class="button neutral" data-reschedule-job="${esc(job.id)}">Edit / Reschedule</button>
      <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
  }
  if (job.status === "Scheduled" && today) {
    const pickupAction = job.hasPickup
      ? (pickupInspectionComplete(job)
          ? `<span class="pickup-ready-note">Pickup inspection complete ✓</span>`
          : `<button class="button pickup-inspection-action" data-pickup-inspection="${esc(job.id)}">Begin Pickup Inspection</button>`)
      : "";
    const completeAction = job.hasPickup && !pickupInspectionComplete(job)
      ? `<button class="button green primary-action" disabled title="Finalize the pickup inspection first">✓ Complete Job</button>`
      : `<button class="button green primary-action" data-status-action="Completed" data-job-id="${esc(job.id)}">✓ Complete Job</button>`;
    return `
      <a class="button call-action" href="tel:${esc(job.phone)}">Call Customer</a>
      <a class="button neutral map-action" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address || "")}" target="_blank" rel="noopener">View on Map</a>
      ${pickupAction}
      ${completeAction}`;
  }
  if (job.status === "Scheduled") {
    const pickupAction = job.hasPickup && !pickupInspectionComplete(job)
      ? `<button class="button pickup-inspection-action" data-pickup-inspection="${esc(job.id)}">Begin Pickup Inspection</button>`
      : "";
    if (!isManager() && !state.currentUser?.sharedAccount) return `${pickupAction}${permissionNotice("This appointment is finalized. A manager must reschedule or cancel it.")}`;
    return `
      ${pickupAction}
      <button class="button neutral" data-reschedule-job="${esc(job.id)}">Edit / Reschedule</button>
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
    ${renderJobSummaryCard(job)}

    <section class="detail-card">
      <h3>Equipment (${job.equipment?.length || 0})</h3>
      ${(job.equipment || []).map(item => `<div class="equipment-card">
        ${equipmentImage(item)}
        <div class="equipment-copy"><strong>${esc(item.brand || "")} ${esc(item.model || "")}</strong><small>${esc(item.type || "")}</small></div>
        <div class="equipment-build-action">${equipmentBuildControl(job, item)}</div>
      </div>`).join("")}
    </section>

    ${pickupSummaryMarkup(job)}

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
    const pinToken = await requestPin("canCreateQuote", "Enter your employee PIN to record this action.");
    const approvalToken = managerOnly
      ? await requestManagerApproval("A manager PIN is required to finalize or change the schedule. The active employee will remain signed in.")
      : "";
    await api.updateJobStatus(jobId, newStatus, "Updated from Job Details", pinToken, approvalToken);
    touchPinSession();
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
    touchPinSession();
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
  drawer.classList.remove("open","complete-details-open","pickup-inspection-open");
  drawerBackdrop.classList.remove("open");
  drawer.setAttribute("aria-hidden","true");
}


function staffRoleName(roleId) {
  return state.staffManagement.roles.find(role => role.id === roleId)?.name || roleId || "Unassigned";
}

function sharedLoginName(loginAccountId) {
  const account = state.staffManagement.loginAccounts.find(item => item.id === loginAccountId);
  return account?.email || loginAccountId || "Shared account";
}

async function loadStaffManagement(force = false) {
  if (!can("canEditCMS")) throw new Error("Administrator access is required.");
  if (state.staffManagement.loading) return;
  if (state.staffManagement.loaded && !force) return;
  state.staffManagement.loading = true;
  go("employees");
  try {
    const pinToken = await requestPin("canEditCMS", "Enter an administrator PIN to manage employees.");
    const data = await api.getStaffManagement(pinToken);
    state.staffManagement = {
      loaded: true,
      loading: false,
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      roles: Array.isArray(data.roles) ? data.roles : [],
      loginAccounts: Array.isArray(data.loginAccounts) ? data.loginAccounts : []
    };
    touchPinSession();
  } catch (error) {
    state.staffManagement.loading = false;
    if (error.message !== "Verification cancelled.") toast(error.message || "Employees could not be loaded.");
  }
  go("employees");
}

function employeeEditorHtml(profile = null) {
  const isNew = !profile;
  const shared = profile ? Boolean(profile.sharedAccount) : true;
  const active = profile ? Boolean(profile.active) : true;
  const pinEnabled = profile ? Boolean(profile.pinEnabled) : shared;
  const sharedAccounts = state.staffManagement.loginAccounts.filter(account => account.sharedAccount && account.active);
  const selectedAccount = profile?.loginAccountId || sharedAccounts[0]?.id || "";
  return `<div class="employee-modal-backdrop" id="employeeModalBackdrop">
    <section class="employee-modal" role="dialog" aria-modal="true" aria-labelledby="employeeModalTitle">
      <button class="pin-close" data-close-employee aria-label="Close">×</button>
      <h2 id="employeeModalTitle">${isNew ? "Add Employee" : "Edit Employee"}</h2>
      <p>${isNew ? "Create a secure GamePlan staff profile." : `Update ${esc(profile.displayName)}'s access, role, or PIN.`}</p>
      <form id="employeeForm">
        <input type="hidden" name="staffProfileId" value="${esc(profile?.id || "")}">
        <label class="field"><span>Display name</span><input name="displayName" required maxlength="80" value="${esc(profile?.displayName || "")}" autocomplete="off"></label>
        <label class="field"><span>Role</span><select name="roleId" required>${state.staffManagement.roles.map(role => `<option value="${esc(role.id)}" ${role.id === profile?.roleId ? "selected" : ""}>${esc(role.name)}</option>`).join("")}</select></label>
        <fieldset class="employee-login-choice"><legend>Google login</legend>
          <label><input type="radio" name="loginMode" value="shared" ${shared ? "checked" : ""}> Shared store account</label>
          <label><input type="radio" name="loginMode" value="personal" ${!shared ? "checked" : ""}> Personal Google account</label>
        </fieldset>
        <label class="field employee-shared-field"><span>Shared account</span><select name="loginAccountId">${sharedAccounts.map(account => `<option value="${esc(account.id)}" ${account.id === selectedAccount ? "selected" : ""}>${esc(account.email)}</option>`).join("")}</select></label>
        <label class="field employee-personal-field"><span>Google email</span><input name="googleEmail" type="email" value="${esc(shared ? "" : (profile?.googleEmail || ""))}" placeholder="name@playitagainsoquel.com" autocomplete="email"></label>
        <div class="employee-pin-fields">
          <label class="check-row"><input type="checkbox" name="pinEnabled" ${pinEnabled ? "checked" : ""}> Enable this employee's GamePlan PIN</label>
          <div class="form-grid">
            <label class="field"><span>${profile?.pinConfigured ? "New PIN (leave blank to keep current)" : "PIN"}</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" placeholder="4–8 digits"></label>
            <label class="field"><span>Confirm PIN</span><input name="confirmPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" placeholder="Repeat PIN"></label>
          </div>
          <small class="form-help">For shared-account employees, this PIN identifies the employee. For Managers and Admins with personal Google logins, it can also approve restricted actions on the shared store device. PINs are salted and hashed on the server.</small>
        </div>
        <label class="check-row"><input type="checkbox" name="active" ${active ? "checked" : ""}> Active</label>
        <div class="employee-form-error" id="employeeFormError"></div>
        <div class="employee-modal-actions"><button type="button" class="button neutral" data-close-employee>Cancel</button><button type="submit" class="button primary-action">${isNew ? "Add Employee" : "Save Changes"}</button></div>
      </form>
    </section>
  </div>`;
}

function openEmployeeEditor(profileId = "") {
  const profile = state.staffManagement.profiles.find(item => item.id === profileId) || null;
  document.body.insertAdjacentHTML("beforeend", employeeEditorHtml(profile));
  const backdrop = document.querySelector("#employeeModalBackdrop");
  const form = document.querySelector("#employeeForm");
  const close = () => backdrop?.remove();
  backdrop.querySelectorAll("[data-close-employee]").forEach(button => button.onclick = close);
  backdrop.onclick = event => { if (event.target === backdrop) close(); };
  const syncMode = () => {
    const shared = form.elements.loginMode.value === "shared";
    form.querySelector(".employee-shared-field").hidden = !shared;
    form.querySelector(".employee-personal-field").hidden = shared;
    form.querySelector(".employee-pin-fields").hidden = false;
  };
  form.querySelectorAll('[name="loginMode"]').forEach(input => input.onchange = syncMode);
  syncMode();
  form.onsubmit = async event => {
    event.preventDefault();
    const errorBox = form.querySelector("#employeeFormError");
    const submit = form.querySelector('[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    data.active = form.elements.active.checked;
    data.pinEnabled = form.elements.pinEnabled.checked;
    const shared = data.loginMode === "shared";
    if (!data.displayName.trim()) return errorBox.textContent = "Enter the employee's display name.";
    if (!data.roleId) return errorBox.textContent = "Choose a role.";
    if (shared && !data.loginAccountId) return errorBox.textContent = "Choose the shared Google account.";
    if (!shared && !data.googleEmail.trim()) return errorBox.textContent = "Enter the personal Google email.";
    if (data.pin || data.confirmPin) {
      if (!/^\d{4,8}$/.test(data.pin)) return errorBox.textContent = "PINs must contain 4–8 digits.";
      if (data.pin !== data.confirmPin) return errorBox.textContent = "The PIN entries do not match.";
    }
    submit.disabled = true;
    submit.textContent = "Saving…";
    errorBox.textContent = "";
    try {
      const pinToken = await requestPin("canEditCMS", "Administrator verification is required to save employee changes.");
      await api.saveStaffProfile(data, pinToken);
      touchPinSession();
      close();
      await loadStaffManagement(true);
      toast(`${data.displayName.trim()} was saved.`);
    } catch (error) {
      errorBox.textContent = error.message || "The employee could not be saved.";
      submit.disabled = false;
      submit.textContent = profile ? "Save Changes" : "Add Employee";
    }
  };
}

function renderEmployees() {
  if (!can("canEditCMS")) return `<div class="app-state app-state--error"><div class="app-state__icon">!</div><h2>Administrator access required</h2><p>Your GamePlan role does not allow employee management.</p><button class="button neutral" data-route="more">Back to More</button></div>`;
  if (state.staffManagement.loading) return `<div class="app-state"><div class="loading-spinner"></div><h2>Loading employees…</h2></div>`;
  if (!state.staffManagement.loaded) return `<div class="app-state"><div class="employee-admin-icon">♙</div><h2>Employee Management</h2><p>Manage employee and manager roles, shared-account PINs, personal Google logins, and active status.</p><button class="button" data-load-staff>Open Employee Management</button></div>`;
  const profiles = [...state.staffManagement.profiles].sort((a,b) => Number(b.active)-Number(a.active) || a.displayName.localeCompare(b.displayName));
  return `<section class="card employees-card"><div class="head employees-head"><div><h2>Employees</h2><span class="agenda-subtitle">${profiles.filter(item=>item.active).length} active · ${profiles.length} total</span></div><button class="button" data-add-employee>＋ Add Employee</button></div><div class="body employee-list">${profiles.map(profile => `<article class="employee-row ${profile.active ? "" : "inactive"}">
    <div class="employee-avatar">${esc(profile.displayName.charAt(0).toUpperCase())}</div>
    <div class="employee-copy"><b>${esc(profile.displayName)}</b><span>${esc(staffRoleName(profile.roleId))} · ${profile.sharedAccount ? `Shared login: ${esc(sharedLoginName(profile.loginAccountId))}` : esc(profile.googleEmail)}</span><small>${profile.pinConfigured ? (profile.sharedAccount ? "Employee PIN configured" : "Approval PIN configured") : (profile.sharedAccount ? "PIN not configured" : "Personal Google sign-in · no approval PIN")}</small></div>
    <div class="employee-status"><span class="badge ${profile.active ? "completed" : "attention"}">${profile.active ? "Active" : "Inactive"}</span><button class="button neutral" data-edit-employee="${esc(profile.id)}">Edit</button></div>
  </article>`).join("") || `<div class="empty-agenda"><b>No employees yet</b><span>Add the first staff profile to begin.</span></div>`}</div></section>`;
}

const views = {
  today: {
    title:"Today's GamePlan", sub:todayDate,
    html:()=>{const attention=state.jobs.filter(jobNeedsOfficeAttention);return `<div class="home-dashboard">
      ${homeStatusButtons()}
      <section class="card needs-attention-card"><div class="head"><div><h2>Needs Attention</h2><span class="attention-count">${attention.length}</span></div></div><div class="body attention-list">${attention.length?attention.map(needsAttentionCard).join(""):`<div class="empty-agenda"><b>Nothing needs attention</b><span>Tentative jobs remain here until details are complete and a manager confirms the appointment.</span></div>`}</div></section>
      <div class="grid two"><section class="card"><div class="head"><h2>Today's Schedule</h2></div><div class="body queue">${state.jobs.filter(isTodayJob).length?state.jobs.filter(isTodayJob).map(queueItem).join(""):`<div class="empty-agenda"><b>No scheduled jobs today</b><span>Confirmed work scheduled for today will appear here.</span></div>`}</div></section>
      <section class="card mobile-workflow-card"><div class="head"><div><h2>Start Here</h2><span class="agenda-subtitle">New Job Workflow</span></div></div><div class="body v3-actions"><button class="v3-primary-action" data-demo-action="New Job"><span class="v3-action-icon">＋</span><span><b>New Job</b><small>Delivery, Pickup, or Delivery &amp; Pickup</small></span><em>›</em></button><div class="v3-secondary-actions single-action"><button data-route="schedule"><b>Schedule</b><small>View the weekly plan</small></button></div></div></section></div>
    </div>`;}
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
      } else if (jobsViewFilter === "attention") {
        filteredJobs = state.jobs.filter(jobNeedsOfficeAttention);
        heading = "Needs Attention";
        subtitle = "Jobs awaiting details or manager approval";
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
    html:()=>`<div class="grid two"><section class="card"><div class="head"><h2>Administration</h2></div><div class="body list">${can("canEditCMS") ? `<button class="row" data-route="employees"><div><b>Employee Management</b><span>Add staff, assign roles, manage PINs, and deactivate access</span></div><b>›</b></button>` : ""}<button class="row" data-demo-action="Settings"><div><b>Settings</b><span>Pricing, timing, availability, and app rules</span></div><b>⚙</b></button><button class="row" data-demo-action="Huddle Together"><div><b>Huddle Together</b><span>Group scheduled jobs into one operational route</span></div><b>↝</b></button></div></section><section class="card"><div class="head"><h2>System</h2></div><div class="body"><div class="row"><div><b>Data source</b><span>${state.live ? "Live GamePlan CMS" : state.cached ? "Cached live data" : "Not connected"}</span></div><span class="badge ${state.live ? "completed" : "tentative"}">${state.live ? "Live" : state.cached ? "Cached" : "Offline"}</span></div></div></section></div>`
  },

  employees: {
    title:"Employee Management", sub:"Roles, PINs, login accounts, and access",
    html:()=>renderEmployees()
  }
};

function bindDynamic() {
  view.querySelectorAll("[data-complete-details]").forEach(el => el.onclick = () => openCompleteDetails(el.dataset.completeDetails));
  view.querySelectorAll("[data-review-job]").forEach(el => el.onclick = () => openJob(el.dataset.reviewJob));
  view.querySelectorAll("[data-home-status]").forEach(el => el.onclick = () => { const status=el.dataset.homeStatus; if(status==="Needs Attention"){const matches=state.jobs.filter(jobNeedsOfficeAttention); if(matches.length===1){return jobDetailsComplete(matches[0]) ? openJob(matches[0].id) : openCompleteDetails(matches[0].id);} jobsViewFilter="attention";} else {jobsViewFilter=status.toLowerCase();} go("jobs"); });
  document.querySelectorAll("[data-open-job]").forEach(el => {
    el.onclick = (event) => {
      event.stopPropagation();
      const job = state.jobs.find(item => item.id === el.dataset.openJob);
      if (jobsViewFilter === "attention" && job && !jobDetailsComplete(job)) {
        openCompleteDetails(job.id);
        return;
      }
      openJob(el.dataset.openJob);
    };
  });
  document.querySelectorAll("[data-reschedule-job]").forEach(el => {
    el.onclick = () => openReschedule(el.dataset.rescheduleJob);
  });
  document.querySelectorAll("[data-demo-action]").forEach(el => {
    el.onclick = () => {
      if (["New Job","New Tentative"].includes(el.dataset.demoAction)) openWizard("job");
      else toast(`${el.dataset.demoAction} becomes active in a later version.`);
    };
  });
  document.querySelectorAll("[data-pickup-inspection]").forEach(el => {
    el.onclick = () => openPickupInspection(el.dataset.pickupInspection);
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
  view.querySelector("[data-load-staff]")?.addEventListener("click", () => loadStaffManagement());
  view.querySelector("[data-add-employee]")?.addEventListener("click", () => openEmployeeEditor());
  view.querySelectorAll("[data-edit-employee]").forEach(el => el.onclick = () => openEmployeeEditor(el.dataset.editEmployee));
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
const DRAFT_KEY = "gameplan-job-draft-v3-alpha2";
const UX_STEPS = ["Job Type", "Customer", "Equipment", "Details", "Appointment", "Summary"];
const blankItem = () => ({
  condition: "",
  equipmentTypeId: "",
  quantity: 1,
  brandId: "",
  brand: "",
  productId: "",
  model: "",
  fulfillmentConditionId: "NIB",
  notes: "",
  movement: "delivery"
});
const blankDraft = () => ({
  mode: "job",
  step: 0,
  customerMode: "new",
  customerId: "",
  customerSearch: "",
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  addressId: "",
  address: "",
  jobTypeId: "",
  equipment: [],
  access: [],
  destinationId: "",
  flights: "",
  scheduledDate: "",
  scheduledTime: "",
  internalNotes: "",
  dismissedCustomerIds: [],
  moreAccessOpen: false,
  appointmentWeekStart: "",
  appointmentView: "dates",
  editingFromSummary: false,
  editStep: null,
  pendingCondition: "",
  rescheduleJobId: "",
  rescheduleReturnJobId: ""
});
let draft = blankDraft();
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}
function selectedCustomer(){return state.customers.find(c=>c.id===draft.customerId);}
function selectedType(item){return state.equipmentTypes.find(t=>t.id===item.equipmentTypeId)||{};}
function optionList(items,current,label="name"){return items.map(x=>`<option value="${esc(x.id)}" ${x.id===current?"selected":""}>${esc(x[label])}</option>`).join("");}
function normalizePhone(value){
  const digits=String(value||"").replace(/\D/g,"").slice(0,10);
  if(digits.length<4)return digits;
  if(digits.length<7)return `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
}
function iconNameFor(item, kind="equipment"){
  const explicit=String(item?.iconName||"").trim().toLowerCase();
  if(explicit)return explicit;
  const text=`${item?.id||""} ${item?.name||""}`.toLowerCase();
  const map=kind==="access"?[
    ["garage","garage"],["stair","stairs"],["upstairs","upstairs"],["single","single-level"],
    ["main floor","single-level"],["mobile","mobile-home"],["narrow","narrow"],["hall","hallway"],
    ["driveway","walkway"],["assembly","assembly"],["gate","gate"]
  ]:[
    ["tread","treadmill"],["recumbent","recumbent-bike"],["upright","upright-bike"],["bike","upright-bike"],
    ["ellipt","elliptical"],["row","rower"],["home gym","home-gym"],["weight bench","bench"],
    ["weight set","weights"],["squat","squat-rack"],["basket","basketball"],["table tennis","table-tennis"]
  ];
  return map.find(([needle])=>text.includes(needle))?.[1]||"equipment";
}
function gpIcon(name){
  const paths={
    "treadmill":`<path d="M5 19h14M7 17l3-8h8l2 8M11 9V5h5l2 4"/>`,
    "upright-bike":`<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M9 17l3-7 4 7M10 10h5M13 10l-2-3h3"/>`,
    "recumbent-bike":`<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M8 17l4-4h4l2 4M10 13l-2-5h5"/>`,
    "elliptical":`<path d="M7 20h10M9 20l2-9 3 9M11 11l-2-5M14 9l2-5M8 8h3M14 6h3"/>`,
    "rower":`<circle cx="17" cy="16" r="3"/><path d="M4 18h10M7 18l5-7h5M12 11l-3-3"/>`,
    "home-gym":`<path d="M5 20V7h14v13M8 7V4h8v3M9 11h6M10 15h4"/>`,
    "bench":`<path d="M4 15h16M7 15v5M17 15v5M8 11h8M10 11V8h4v3"/>`,
    "weights":`<path d="M4 10v4M7 8v8M17 8v8M20 10v4M7 12h10"/>`,
    "squat-rack":`<path d="M6 20V4M18 20V4M6 8h12M9 12h6M8 20h8"/>`,
    "basketball":`<path d="M5 4h14M12 4v6M8 10h8v4H8zM12 14v6M9 20h6"/>`,
    "table-tennis":`<path d="M4 10h16M6 10v10M18 10v10M12 10v10M8 6h5M13 6l3 2"/>`,
    "garage":`<path d="M4 20V9l8-5 8 5v11M7 20v-8h10v8M7 15h10"/>`,
    "single-level":`<path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>`,
    "mobile-home":`<path d="M3 9h18v9H3zM6 9V6h10v3M7 18a2 2 0 1 0 0 .1M17 18a2 2 0 1 0 0 .1"/>`,
    "stairs":`<path d="M4 19h4v-4h4v-4h4V7h4"/>`,
    "upstairs":`<path d="M4 19h4v-4h4v-4h4V7h4M16 4h4v4"/>`,
    "assembly":`<path d="M14 6a4 4 0 0 0-5 5l-5 5 4 4 5-5a4 4 0 0 0 5-5l-3 3-3-3z"/>`,
    "narrow":`<path d="M8 4v16M16 4v16M11 12h2M10 10l-2 2 2 2M14 10l2 2-2 2"/>`,
    "hallway":`<path d="M5 4h14v16H5zM9 4v16M15 4v16"/>`,
    "walkway":`<path d="M5 20c2-8 5-8 7-16M13 20c1-6 3-8 6-12"/>`,
    "gate":`<path d="M5 20V6M19 20V6M5 9h14M8 9v11M12 9v11M16 9v11"/>`,
    "delivery-truck":`<path d="M3 7h11v10H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>`,
    "pickup-box":`<path d="M5 8h14v11H5zM5 8l3-4h8l3 4M9 12h6"/><path d="M12 16V10M9.5 12.5 12 10l2.5 2.5"/>`,
    "delivery-swap":`<path d="M3 7h10v9H3zM13 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M6 4h11M14 2l3 2-3 2"/>`,
    "equipment":`<path d="M5 8h14v11H5zM8 8V5h8v3M9 13h6"/>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.equipment}</svg>`;
}
function startOfLocalDay(date){const d=new Date(date);d.setHours(0,0,0,0);return d;}
function addLocalDays(date,n){const d=new Date(date);d.setDate(d.getDate()+n);return d;}
function dateKeyLocal(date){const d=new Date(date);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function dateLabel(date){return new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric"}).format(date);}
function jobsOnDate(key){
  return state.jobs.filter(job=>{
    if (draft.mode === "reschedule" && job.id === draft.rescheduleJobId) return false;
    const jobKey=String(job.scheduledDate||job.dateISO||job.appointmentDate||job.dateTime||job.date||"").slice(0,10);
    const status=String(job.status||"").toLowerCase();
    return jobKey===key && /scheduled|tentative/.test(status) && !/cancel|complete/.test(status);
  });
}
function minutesFromTime(value){
  const raw=String(value||"").trim();
  const match=raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if(!match)return null;
  let hour=Number(match[1]);const minute=Number(match[2]);const suffix=(match[3]||"").toUpperCase();
  if(suffix==="PM"&&hour!==12)hour+=12;if(suffix==="AM"&&hour===12)hour=0;
  return hour*60+minute;
}
function appointmentWeekStart(){
  if(draft.appointmentWeekStart){const d=new Date(`${draft.appointmentWeekStart}T12:00:00`);if(!Number.isNaN(d.getTime()))return d;}
  const today=startOfLocalDay(new Date());const day=today.getDay();const monday=addLocalDays(today,-((day+6)%7));
  draft.appointmentWeekStart=dateKeyLocal(monday);return monday;
}
function appointmentWeekLabel(start){
  const end=addLocalDays(start,6);const sameMonth=start.getMonth()===end.getMonth();
  const first=new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}).format(start);
  const last=new Intl.DateTimeFormat("en-US",sameMonth?{day:"numeric"}:{month:"short",day:"numeric"}).format(end);
  return `${first}–${last}`;
}
function estimatedDraftMinutes(){
  // A normal delivery begins with a small handling/arrival allowance rather
  // than a blanket one-hour base. Equipment rules then supply the actual
  // on-site duration. This allows a straightforward job to fit into a real
  // 45-minute opening before another appointment.
  let minutes=15;
  draft.equipment.forEach(item=>{
    const type=selectedType(item);const qty=Math.max(1,Number(item.quantity||1));
    const perItem=Number(
      type.defaultDurationMinutes||type.defaultOnSiteMinutes||type.estimatedMinutes||
      type.deliveryMinutes||type.durationMinutes||type.laborMinutes||0
    );
    minutes+=qty*(perItem>0?perItem:30);
    if(item.condition==="New"){
      const assembly=Number(type.defaultAssemblyMinutes||type.assemblyMinutes||30);
      minutes+=qty*Math.max(0,assembly);
    }
  });
  if(draft.destinationId==="upstairs")minutes+=draft.flights==="3+"?45:Number(draft.flights||1)*15;
  return Math.max(30,Math.ceil(minutes/15)*15);
}
function formatEstimatedDuration(minutes=estimatedDraftMinutes()){
  const hours=Math.floor(minutes/60);const remainder=minutes%60;
  if(!hours)return `${minutes} minutes`;
  if(!remainder)return `${hours} ${hours===1?"hour":"hours"}`;
  return `${hours} ${hours===1?"hour":"hours"} ${remainder} minutes`;
}
function jobInterval(job){
  const start=minutesFromTime(job.scheduledTime||job.time||"");if(start===null)return null;
  const duration=Math.max(30,Math.round(parseDurationHours(job)*60));
  return {start,end:start+duration};
}
function slotConflicts(dateKey,startMinutes,durationMinutes){
  const end=startMinutes+durationMinutes;
  return jobsOnDate(dateKey).some(job=>{const interval=jobInterval(job);return interval&&startMinutes<interval.end&&end>interval.start;});
}
function dayAvailability(date){
  const today=startOfLocalDay(new Date());
  if(date<today)return {tone:"past",label:"Past",detail:"Not selectable",disabled:true};
  if(date.getDay()===0)return {tone:"closed",label:"Closed",detail:"Store rule",disabled:true};
  const slots=availableSlotsForDate(dateKeyLocal(date));const open=slots.filter(slot=>!slot.disabled).length;
  if(open===0)return {tone:"full",label:"Full",detail:"No availability",disabled:true};
  if(open<=2)return {tone:"nearly",label:"Nearly Full",detail:`${open} open ${open===1?"slot":"slots"}`};
  if(open<=5)return {tone:"limited",label:"Limited",detail:`${open} open slots`};
  return {tone:"open",label:"Open",detail:`${open} open slots`};
}
function availableSlotsForDate(dateKey){
  const duration=estimatedDraftMinutes();
  return ["10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00"].map(value=>{
    const mins=minutesFromTime(value);const disabled=slotConflicts(dateKey,mins,duration);
    const tone=disabled?"unavailable":mins<720?"preferred":mins<780?"limited":mins<840?"approval":"rare";
    const [h,m]=value.split(":").map(Number);
    const label=new Intl.DateTimeFormat("en-US",{hour:"numeric",minute:"2-digit"}).format(new Date(2026,0,1,h,m));
    return {value,label,tone,disabled};
  });
}
function timeSlotsForSelectedDate(){return draft.scheduledDate?availableSlotsForDate(draft.scheduledDate):[];}
function quoteEstimate(){
  let total=30;
  draft.equipment.forEach(item=>{
    const type=selectedType(item);const qty=Math.max(1,Number(item.quantity||1));
    total+=qty*(Number(type.defaultOnSiteCharge||0)+Number(type.defaultAssemblyCharge||0)*(item.condition==="New"?1:0));
  });
  total+=state.accessConditions.filter(a=>draft.access.includes(a.id)).reduce((n,a)=>n+Number(a.flatCharge||0),0);
  return Math.max(30,Math.round(total/5)*5);
}
function crewSize(){return Math.max(1,...draft.equipment.map(i=>Number(selectedType(i).defaultCrewSize||2)));}
function openWizard(){
  // A tap on New Job always begins a new workflow. Draft data is preserved only
  // while moving between screens in the currently open wizard.
  localStorage.removeItem(DRAFT_KEY);
  draft=blankDraft();
  draft.mode="job";
  draft.step=0;
  wizardTitle.textContent="New Job";
  renderWizard();wizard.classList.add("open");wizardBackdrop.classList.add("open");wizard.setAttribute("aria-hidden","false");
}
function openReschedule(jobId){
  const job=state.jobs.find(item=>item.id===jobId);
  if(!job)return toast("Job could not be found.");
  localStorage.removeItem(DRAFT_KEY);
  draft=blankDraft();
  draft.mode="reschedule";
  draft.rescheduleJobId=job.id;
  draft.rescheduleReturnJobId=job.id;
  draft.step=4;
  const dt=job.dateTime?new Date(job.dateTime):null;
  if(dt&&!Number.isNaN(dt.getTime())){
    draft.scheduledDate=dateKeyLocal(dt);
    draft.scheduledTime=`${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
    draft.appointmentWeekStart=draft.scheduledDate;
  }
  draft.appointmentView="dates";
  wizardTitle.textContent="Reschedule Job";
  closeJob();
  renderWizard();
  wizard.classList.add("open");
  wizardBackdrop.classList.add("open");
  wizard.setAttribute("aria-hidden","false");
}
function closeWizard(){wizard.classList.remove("open");wizardBackdrop.classList.remove("open");wizard.setAttribute("aria-hidden","true");}
function saveDraft(show=true){sync();localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));if(show)toast("Saved to finish later on this device.");}
function stepHeading(title,subtitle){return `<div class="ux-step"><div class="ux-step__heading"><h2>${title}</h2><p>${subtitle}</p></div>`;}
function resolveJobType(kind){
  const types=state.jobTypes||[];
  const normalized=types.map(item=>({...item,search:`${item.id||""} ${item.name||""}`.toLowerCase()}));
  if(kind==="delivery-pickup") return normalized.find(item=>/delivery/.test(item.search)&&/pickup|pick up/.test(item.search));
  if(kind==="pickup") return normalized.find(item=>/pickup|pick up/.test(item.search)&&!/delivery/.test(item.search));
  return normalized.find(item=>/delivery/.test(item.search)&&!/pickup|pick up/.test(item.search));
}
function jobTypeCard(kind,label,description,icon){
  const type=resolveJobType(kind);
  return `<button type="button" class="job-type-card" data-job-type-choice="${kind}" ${type?"":"disabled"}><i>${gpIcon(icon)}</i><span><b>${label}</b><small>${type?description:"This job type is not active in the CMS."}</small></span><em>›</em></button>`;
}
function jobTypeStep(){
  return `${stepHeading("What type of job is this?","Choose one to continue.")}
    <div class="job-type-card-list" role="radiogroup" aria-label="Job type">
      ${jobTypeCard("delivery","Delivery","Deliver equipment to the customer.","delivery-truck")}
      ${jobTypeCard("pickup","Pickup","Pick up equipment from the customer.","pickup-box")}
      ${jobTypeCard("delivery-pickup","Delivery & Pickup","Deliver equipment and bring another item back.","delivery-swap")}
    </div>
    <p class="ux-helper job-type-helper">One tap moves directly to Customer Information.</p>
  </div>`;
}
function customerText(value){
  return String(value||"").trim().toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function customerPhoneDigits(value){return String(value||"").replace(/\D/g,"");}
function customerAddresses(customer){return Array.isArray(customer?.addresses)?customer.addresses:[];}
function customerAutofillValues(customer){
  const fullName=String(customer?.name||customer?.customerName||"").trim();
  const nameParts=fullName.split(/\s+/).filter(Boolean);
  const firstName=String(customer?.firstName||customer?.givenName||nameParts.shift()||"").trim();
  const lastName=String(customer?.lastName||customer?.familyName||nameParts.join(" ")||"").trim();
  const phone=String(customer?.phone||customer?.phoneNumber||customer?.mobile||"").trim();
  const addresses=customerAddresses(customer);
  const preferred=addresses.find(item=>item?.default===true||String(item?.default).toLowerCase()==="true")||addresses[0]||{};
  const address=String(preferred?.address||preferred?.formattedAddress||customer?.address||customer?.deliveryAddress||"").trim();
  return {firstName,lastName,phone:normalizePhone(phone),address};
}
function rankCustomerMatches(){
  const first=customerText(draft.firstName);
  const last=customerText(draft.lastName);
  const phone=customerPhoneDigits(draft.phone);
  const address=customerText(draft.address);
  const dismissed=new Set((Array.isArray(draft.dismissedCustomerIds)?draft.dismissedCustomerIds:[]).map(String));
  const hasName=first.length>=2&&last.length>=2;
  const hasFullPhone=phone.length===10;
  const hasFullAddress=address.length>=10&&address.split(" ").length>=3;
  if(!hasName&&!hasFullPhone&&!hasFullAddress)return [];

  return state.customers.map(customer=>{
    if(dismissed.has(String(customer.id)))return null;
    const values=customerAutofillValues(customer);
    const cFirst=customerText(values.firstName);
    const cLast=customerText(values.lastName);
    const cPhone=customerPhoneDigits(values.phone);
    const addresses=[...customerAddresses(customer).map(a=>customerText(a.address||a.formattedAddress)),customerText(values.address)].filter(Boolean);

    const exactFirst=hasName&&cFirst===first;
    const exactLast=hasName&&cLast===last;
    const closeFirst=hasName&&first.length>=3&&cFirst.length>=3&&(cFirst.startsWith(first)||first.startsWith(cFirst));
    const closeLast=hasName&&last.length>=3&&cLast.length>=3&&(cLast===last||cLast.endsWith(` ${last}`)||last.endsWith(` ${cLast}`));
    const strongName=hasName&&((exactFirst&&exactLast)||((exactFirst||closeFirst)&&(exactLast||closeLast)));
    const exactPhone=hasFullPhone&&cPhone.length===10&&cPhone===phone;
    const exactAddress=hasFullAddress&&addresses.some(a=>a===address);

    // Once a full phone or a complete name has been entered, conflicting data
    // should disqualify a weak address-only result.
    const phoneConflict=hasFullPhone&&cPhone.length===10&&!exactPhone;
    const nameConflict=hasName&&!strongName;

    let score=0;const reasons=[];
    if(exactPhone){score+=140;reasons.push("Exact phone match");}
    if(strongName){score+=90;reasons.push(exactFirst&&exactLast?"Exact name match":"Strong name match");}
    if(exactAddress){score+=70;reasons.push("Exact address match");}

    const qualifies=exactPhone||strongName||(exactAddress&&!phoneConflict&&!nameConflict)||(strongName&&exactAddress);
    if(!qualifies)return null;
    if(phoneConflict&&!strongName)return null;
    if(nameConflict&&!exactPhone)return null;

    return {customer,score,reasons:[...new Set(reasons)]};
  }).filter(Boolean)
    .sort((a,b)=>b.score-a.score||String(a.customer.name||"").localeCompare(String(b.customer.name||"")))
    .slice(0,5);
}
function customerCandidateMarkup(match, secondary=false){
  const {customer,reasons,score}=match;
  const values=customerAutofillValues(customer);
  const confidence=score>=130?"Strong match":"Possible match";
  return `<article class="ux-match__candidate${secondary?" ux-match__candidate--secondary":""}"><div><span class="ux-match__confidence">${confidence} · ${esc(reasons[0]||"Customer details match")}</span><b>${esc(customer.name||`${values.firstName} ${values.lastName}`.trim())}</b><small>${esc(values.phone||"")}${values.address?`<br>${esc(values.address)}`:""}</small></div><div class="ux-match__actions"><button type="button" class="ux-match__use" data-select-customer="${esc(customer.id)}">Use Customer</button><button type="button" class="ux-match__dismiss" data-dismiss-customer="${esc(customer.id)}">Not This One</button></div></article>`;
}
function customerMatchMarkup(){
  if(draft.customerId){
    const customer=selectedCustomer();
    if(customer)return `<section class="ux-match ux-match--confirmed"><div class="ux-match__title"><span><b>Existing customer selected</b><small>${esc(customer.name)}</small></span><strong>✓</strong></div><button type="button" class="ux-match__change" data-clear-customer>Change customer</button></section>`;
  }
  const matches=rankCustomerMatches();
  if(!matches.length)return "";
  const [primary,...others]=matches;
  return `<section class="ux-match ux-match--attention" role="status" aria-live="polite"><div class="ux-match__title"><span><b>Possible customer match</b><small>Review before creating a duplicate record.</small></span><strong>!</strong></div><div class="ux-match__list">${customerCandidateMarkup(primary)}${others.length?`<details class="ux-match__others"><summary>${others.length} other possible match${others.length===1?"":"es"}</summary><div class="ux-match__other-list">${others.map(match=>customerCandidateMarkup(match,true)).join("")}</div></details>`:""}</div></section>`;
}
function customerStep(){
  const phone=normalizePhone(draft.phone);
  return `${stepHeading("Customer Information","Who is this job for?")}
    <div id="customerMatchMount">${customerMatchMarkup()}</div>
    <div class="ux-form-stack">
      <label class="ux-field"><span>Customer Name</span><div class="ux-name-grid"><input name="firstName" autocomplete="given-name" placeholder="First name" value="${esc(draft.firstName)}"><input name="lastName" autocomplete="family-name" placeholder="Last name" value="${esc(draft.lastName)}"></div></label>
      <label class="ux-field"><span>Phone Number</span><input name="phone" inputmode="tel" autocomplete="tel" placeholder="(831) 555-1234" value="${esc(phone)}"></label>
      <label class="ux-field"><span>Delivery Address</span><input name="address" autocomplete="street-address" placeholder="Start typing an address" value="${esc(draft.address)}"><small>Address verification uses the existing GamePlan address service.</small></label>
    </div>
  </div>`;
}
function bindCustomerMatchActions(){
  wizardForm.querySelectorAll("[data-select-customer]").forEach(el=>el.onclick=()=>{
    const c=state.customers.find(x=>String(x.id)===String(el.dataset.selectCustomer));if(!c)return;
    // Capture any current form edits first, then replace them with the chosen customer.
    // Do not call saveDraft() here because saveDraft() syncs the old form values
    // back into draft before the screen is re-rendered.
    sync();
    const values=customerAutofillValues(c);
    draft.customerId=c.id;
    draft.firstName=values.firstName;
    draft.lastName=values.lastName;
    draft.phone=values.phone;
    draft.address=values.address||draft.address;
    draft.dismissedCustomerIds=[];
    localStorage.setItem(DRAFT_KEY,JSON.stringify(draft));
    renderWizard();
  });
  wizardForm.querySelectorAll("[data-dismiss-customer]").forEach(el=>el.onclick=()=>{
    const id=el.dataset.dismissCustomer;
    draft.dismissedCustomerIds=[...new Set([...(draft.dismissedCustomerIds||[]),id])];
    updateCustomerMatchMount();
  });
  wizardForm.querySelector("[data-clear-customer]")?.addEventListener("click",()=>{
    draft.customerId="";draft.dismissedCustomerIds=[];updateCustomerMatchMount();
  });
}
function updateCustomerMatchMount(){
  const mount=wizardForm.querySelector("#customerMatchMount");if(!mount)return;
  mount.innerHTML=customerMatchMarkup();bindCustomerMatchActions();
}
let customerMatchTimer=0;
function scheduleCustomerMatchUpdate(){
  clearTimeout(customerMatchTimer);
  customerMatchTimer=setTimeout(updateCustomerMatchMount,260);
}
function popularEquipment(){
  const favorites=state.equipmentTypes.filter(x=>x.quickAccess===true||String(x.quickAccess).toLowerCase()==="true");
  return (favorites.length?favorites:state.equipmentTypes.slice(0,4));
}
function selectedJobTypeRecord(){
  return (state.jobTypes||[]).find(type=>String(type.id)===String(draft.jobTypeId))||{};
}
function selectedJobTypeSearch(){
  const type=selectedJobTypeRecord();
  return `${type.id||""} ${type.name||""}`.toLowerCase();
}
function isDeliveryPickupDraft(){
  const search=selectedJobTypeSearch();
  return /delivery/.test(search)&&/pickup|pick up/.test(search);
}
function isPickupOnlyDraft(){
  const search=selectedJobTypeSearch();
  return /pickup|pick up/.test(search)&&!/delivery/.test(search);
}
function itemMovement(item){
  if(String(item?.movement||"").toLowerCase()==="pickup"||item?.pickupRequired===true)return "pickup";
  return "delivery";
}
function equipmentCard(type,movement="delivery"){
  return `<button type="button" class="ux-icon-card" data-add-equipment="${esc(type.id)}" data-equipment-movement="${movement}"><i>${gpIcon(iconNameFor(type))}</i><span>${esc(type.name)}</span><small>Tap to add</small></button>`;
}
function equipmentChooser(movement,popular,more){
  return `<h3 class="ux-section-label">Popular Equipment</h3>
    <div class="ux-card-grid">${popular.map(type=>equipmentCard(type,movement)).join("")}</div>
    ${more.length?`<details class="ux-more"><summary>More Equipment <span>⌄</span></summary><div class="ux-card-grid">${more.map(type=>equipmentCard(type,movement)).join("")}</div></details>`:""}`;
}
function selectedEquipmentChip(item,index){
  const type=selectedType(item);
  if(itemMovement(item)==="pickup"){
    return `<button type="button" class="ux-selected-item" data-edit-equipment="${index}"><i>${gpIcon(iconNameFor(type))}</i><span><b>${esc(type.name||"Equipment")}</b><small>Pickup item · Tap to remove</small></span><strong>✓</strong></button>`;
  }
  return `<button type="button" class="ux-selected-item" data-edit-equipment="${index}"><i>${gpIcon(iconNameFor(type))}</i><span><b>${esc(item.condition)} ${esc(type.name||"Equipment")}</b><small>Delivery item · Quantity ${Math.max(1,Number(item.quantity||1))} · Tap to edit</small></span><strong>✓</strong></button>`;
}
function equipmentStep(){
  const pickupOnly=isPickupOnlyDraft();
  const combined=isDeliveryPickupDraft();
  const popular=popularEquipment();const popularIds=new Set(popular.map(x=>x.id));const more=state.equipmentTypes.filter(x=>!popularIds.has(x.id));
  const deliveryItems=draft.equipment.map((item,index)=>({item,index})).filter(entry=>itemMovement(entry.item)==="delivery");
  const pickupItems=draft.equipment.map((item,index)=>({item,index})).filter(entry=>itemMovement(entry.item)==="pickup");

  if(combined){
    return `${stepHeading("Delivery & Pickup Items","What are we delivering and picking up?")}
      <section class="ux-combined-equipment-section">
        <h3 class="ux-section-label">Delivery Items</h3>
        <p class="ux-helper">Choose New or Used, then tap each equipment type being delivered.</p>
        <div class="ux-condition" role="radiogroup" aria-label="Delivery item condition"><button type="button" class="ux-segment ${draft.pendingCondition==="New"?"selected":""}" data-condition="New" aria-pressed="${draft.pendingCondition==="New"}">New</button><button type="button" class="ux-segment ${draft.pendingCondition==="Used"?"selected":""}" data-condition="Used" aria-pressed="${draft.pendingCondition==="Used"}">Used</button></div>
        ${equipmentChooser("delivery",popular,more)}
        <section class="ux-selected-list"><h3>Delivery Items</h3>${deliveryItems.length?deliveryItems.map(entry=>selectedEquipmentChip(entry.item,entry.index)).join(""):`<div class="ux-empty-selection">No delivery items added yet</div>`}</section>
      </section>
      <section class="ux-combined-equipment-section">
        <h3 class="ux-section-label">Pickup Items</h3>
        <p class="ux-helper">Tap each equipment type being picked up. Used is assumed.</p>
        ${equipmentChooser("pickup",popular,more)}
        <section class="ux-selected-list"><h3>Pickup Items</h3>${pickupItems.length?pickupItems.map(entry=>selectedEquipmentChip(entry.item,entry.index)).join(""):`<div class="ux-empty-selection">No pickup items added yet</div>`}</section>
      </section>
      <div id="equipmentEditMount"></div>
    </div>`;
  }

  return `${stepHeading(pickupOnly?"Pickup Items":"Equipment",pickupOnly?"What equipment are we picking up?":"What are we moving?")}
    ${pickupOnly?`<p class="ux-helper">Tap each equipment type to add it. Add as many pickup items as needed.</p>`:`<div class="ux-condition" role="radiogroup" aria-label="Condition"><button type="button" class="ux-segment ${draft.pendingCondition==="New"?"selected":""}" data-condition="New" aria-pressed="${draft.pendingCondition==="New"}">New</button><button type="button" class="ux-segment ${draft.pendingCondition==="Used"?"selected":""}" data-condition="Used" aria-pressed="${draft.pendingCondition==="Used"}">Used</button></div><p class="ux-helper">Choose New or Used, then tap an equipment type.</p>`}
    ${equipmentChooser(pickupOnly?"pickup":"delivery",popular,more)}
    <section class="ux-selected-list"><h3>${pickupOnly?"Pickup Items":"Selected Equipment"}</h3>${draft.equipment.length?draft.equipment.map(selectedEquipmentChip).join(""):`<div class="ux-empty-selection">Nothing added yet</div>`}</section>
    <div id="equipmentEditMount"></div>
  </div>`;
}
function equipmentEditSheet(index){
  const item=draft.equipment[index];if(!item)return "";const type=selectedType(item);
  if(itemMovement(item)==="pickup"){
    return `<div class="ux-sheet-backdrop open" id="equipmentEditSheet"><section class="ux-sheet" role="dialog" aria-modal="true"><div class="ux-sheet-handle"></div><h3>${esc(type.name||"Pickup Item")}</h3><p class="ux-helper">Equipment details will be completed later on the Pickup Details Sheet.</p><button type="button" class="button danger" id="removeEditedEquipment">Remove Item</button><button type="button" class="button neutral" id="closeEquipmentEdit">Done</button></section></div>`;
  }
  return `<div class="ux-sheet-backdrop open" id="equipmentEditSheet"><section class="ux-sheet" role="dialog" aria-modal="true"><div class="ux-sheet-handle"></div><h3>Edit ${esc(type.name||"Equipment")}</h3><div class="ux-condition"><button type="button" class="ux-segment ${item.condition==="New"?"selected":""}" data-edit-condition="New">New</button><button type="button" class="ux-segment ${item.condition==="Used"?"selected":""}" data-edit-condition="Used">Used</button></div><label class="ux-field"><span>Quantity</span><div class="ux-quantity"><button type="button" data-qty-change="-1">−</button><b>${Math.max(1,Number(item.quantity||1))}</b><button type="button" data-qty-change="1">＋</button></div></label><button type="button" class="button danger" id="removeEditedEquipment">Remove Item</button><button type="button" class="button neutral" id="closeEquipmentEdit">Done</button></section></div>`;
}
function accessSearchText(access){return `${access?.id||""} ${access?.name||""}`.toLowerCase();}
function findAccessCondition(terms){
  const needles=Array.isArray(terms)?terms:[terms];
  return state.accessConditions.find(access=>needles.some(term=>accessSearchText(access).includes(term)));
}
function destinationAccessCondition(key,flights=draft.flights){
  if(key==="garage")return findAccessCondition(["garage"]);
  if(key==="main")return findAccessCondition(["main floor","main level","single level","single-level"]);
  if(key==="mobile")return findAccessCondition(["mobile home","mobile"]);
  if(key==="upstairs") {
    const flightText=String(flights||"");
    if(flightText==="1")return findAccessCondition(["1 flight","one flight"] )||findAccessCondition(["upstairs","stairs"]);
    if(flightText==="2")return findAccessCondition(["2 flight","two flight"] )||findAccessCondition(["upstairs","stairs"]);
    if(flightText==="3+")return findAccessCondition(["3 flight","three flight","multiple flight"] )||findAccessCondition(["upstairs","stairs"]);
    return findAccessCondition(["upstairs","stairs"]);
  }
  return null;
}
function primaryAccessIds(){
  return new Set(["garage","main","mobile","upstairs"].map(key=>destinationAccessCondition(key)?.id).filter(Boolean).map(String));
}
function rebuildDestinationAccess(){
  const destination=destinationAccessCondition(draft.destinationId,draft.flights);
  draft.access=destination?[destination.id]:[];
}
function selectDestination(key){
  draft.destinationId=key;
  if(key!=="upstairs")draft.flights="";
  rebuildDestinationAccess();
}
function destinationLabel(){
  return ({garage:"Garage",main:"Main Level",mobile:"Mobile Home",upstairs:"Upstairs"})[draft.destinationId]||"Not selected";
}
function destinationCard(key,label,description,icon){
  const selected=draft.destinationId===key;
  return `<button type="button" class="ux-icon-card destination-card ${selected?"selected":""}" data-destination="${key}"><i>${gpIcon(icon)}</i><span>${label}</span><small>${description}</small>${selected?"<strong>✓</strong>":""}</button>`;
}
function deliveryDetailsStep(){
  const price=quoteEstimate();
  return `${stepHeading("Delivery Details","Where is the equipment going?")}
    <div class="ux-price-card"><small>Estimated Delivery Price</small><strong>$${price}</strong><span>Updates automatically</span></div>
    <h3 class="ux-section-label">Destination</h3>
    <div class="ux-card-grid destination-grid">
      ${destinationCard("garage","Garage","Equipment stays in the garage","garage")}
      ${destinationCard("main","Main Level","Inside the home, no stairs","single-level")}
      ${destinationCard("mobile","Mobile Home","Mobile or manufactured home","mobile-home")}
      ${destinationCard("upstairs","Upstairs","One or more flights","upstairs")}
    </div>
    ${draft.destinationId==="upstairs"?`<section class="ux-progressive-panel"><h3>How many flights?</h3><div class="ux-flight-options">${["1","2","3+"].map(value=>`<button type="button" class="ux-flight ${draft.flights===value?"selected":""}" data-flights="${value}">${value} ${value==="1"?"Flight":"Flights"}</button>`).join("")}</div></section>`:""}
    <details class="ux-more access-more other-condition" data-more-access ${draft.moreAccessOpen?"open":""}>
      <summary><span><b>Other Special Condition</b><small>Add anything unusual the crew should know</small></span><em>⌄</em></summary>
      <div class="ux-more-body">
        <label class="ux-field special-condition-field"><span>Special condition <small>Optional</small></span><textarea name="internalNotes" rows="4" maxlength="500" placeholder="Example: locked gate, steep driveway, rear entrance, or call before arrival">${esc(draft.internalNotes)}</textarea></label>
        <p class="ux-helper">This note helps the crew prepare. It does not change the estimated price.</p>
      </div>
    </details>
    <p class="ux-helper delivery-helper">GamePlan applies stair pricing and labor rules in the background.</p>
  </div>`;
}
function appointmentStep(){
  const weekStart=appointmentWeekStart();
  const days=Array.from({length:7},(_,i)=>addLocalDays(weekStart,i));
  const slots=draft.scheduledDate?timeSlotsForSelectedDate():[];
  const showingTimes=draft.appointmentView==="times"&&draft.scheduledDate;
  const selectedDate=draft.scheduledDate?new Date(`${draft.scheduledDate}T12:00:00`):null;
  return `${stepHeading("Reserve Appointment","When would the customer like the appointment?")}
    ${draft.mode==="reschedule"?`<div class="ux-price-card small"><small>Current job</small><strong>${esc(state.jobs.find(job=>job.id===draft.rescheduleJobId)?.customer||"Reschedule")}</strong><span>Select the corrected appointment date and time.</span></div>`:`<div class="ux-price-card small"><small>Estimated Delivery Price</small><strong>$${quoteEstimate()}</strong><span>Estimated time: ${formatEstimatedDuration()}</span></div>`}
    ${showingTimes?`
      <div class="ux-appointment-panel slide-in">
        <button type="button" class="ux-back-to-dates" data-back-to-dates>← Choose Another Date</button>
        <h3 class="ux-section-label">${esc(new Intl.DateTimeFormat("en-US",{weekday:"long",month:"long",day:"numeric"}).format(selectedDate))}</h3>
        <div class="ux-time-list">${slots.map(slot=>`<button type="button" class="ux-time-slot ${slot.tone} ${draft.scheduledTime===slot.value?"selected":""}" data-time="${slot.value}" ${slot.disabled?"disabled":""}><b>${slot.label}</b><span>${slot.disabled?"Unavailable":slot.tone==="preferred"?(slot.value==="10:00"?"Best Choice":"Preferred"):slot.tone==="limited"?"Limited":slot.tone==="approval"?"Manager Approval":"Rare — Approval"}</span></button>`).join("")}</div>
      </div>`:`
      <div class="ux-appointment-panel slide-in">
        <div class="ux-week-header"><button type="button" data-appointment-week="-1" aria-label="Previous week">←</button><div><h3 class="ux-section-label">Select a Date</h3><strong>${appointmentWeekLabel(weekStart)}</strong></div><button type="button" data-appointment-week="1" aria-label="Next week">→</button></div>
        <div class="ux-date-list">${days.map(day=>{const key=dateKeyLocal(day),a=dayAvailability(day);return `<button type="button" class="ux-date-card ${a.tone} ${draft.scheduledDate===key?"selected":""}" data-date="${key}" ${a.disabled?"disabled":""}><span><b>${dateLabel(day)}</b><small>${a.detail}</small></span><strong><i></i>${a.label}</strong><em>›</em></button>`;}).join("")}</div>
      </div>`}
  </div>`;
}
function customerName(){const c=selectedCustomer();return c?.name||`${draft.firstName} ${draft.lastName}`.trim();}
function summaryCard(key,title,body,icon){return `<button type="button" class="ux-summary-card" data-edit-step="${key}"><i>${gpIcon(icon)}</i><span><small>${title}</small><b>${body}</b></span><em>›</em></button>`;}
function summaryStep(){
  if(draft.mode==="reschedule"){
    const job=state.jobs.find(item=>item.id===draft.rescheduleJobId);
    const date=draft.scheduledDate?new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric"}).format(new Date(`${draft.scheduledDate}T12:00:00`)):"Not selected";
    const time=timeSlotsForSelectedDate().find(x=>x.value===draft.scheduledTime)?.label||draft.scheduledTime||"Not selected";
    return `${stepHeading("Review Reschedule","Confirm the corrected appointment before returning to Manager Approval.")}
      ${job?renderJobSummaryCard({...job,date,time},{showItemCounts:true}):""}
      <div class="ux-summary-list">${summaryCard(4,"New Appointment",`${esc(date)} at ${esc(time)}`,"equipment")}</div>
    </div>`;
  }
  const deliveryItems=draft.equipment.filter(item=>itemMovement(item)==="delivery").map(i=>`${Math.max(1,Number(i.quantity||1))}× ${i.condition} ${selectedType(i).name||"Equipment"}`);
  const pickupItems=draft.equipment.filter(item=>itemMovement(item)==="pickup").map(i=>`${Math.max(1,Number(i.quantity||1))}× ${selectedType(i).name||"Equipment"}`);
  const items=[deliveryItems.length?`Delivery: ${deliveryItems.join(" · ")}`:"",pickupItems.length?`Pickup: ${pickupItems.join(" · ")}`:""].filter(Boolean).join("<br>");
  const access=[destinationLabel(),draft.destinationId==="upstairs"&&draft.flights?`${draft.flights} flight${draft.flights==="1"?"":"s"}`:""].filter(Boolean).join(" · ");
  const specialCondition=String(draft.internalNotes||"").trim();
  const date=draft.scheduledDate?new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric"}).format(new Date(`${draft.scheduledDate}T12:00:00`)):"Not selected";
  const time=timeSlotsForSelectedDate().find(x=>x.value===draft.scheduledTime)?.label||draft.scheduledTime||"Not selected";
  return `${stepHeading("Job Summary","Does everything look correct?")}
    <div class="ux-status-banner"><i>✓</i><span><b>Tentative Appointment Ready</b><small>Manager approval is required before Scheduled.</small></span></div>
    <div class="ux-summary-list">
      ${summaryCard(1,"Customer",`${esc(customerName())}<br><small>${esc(draft.phone)} · ${esc(draft.address)}</small>`,"single-level")}
      ${summaryCard(2,"Equipment",esc(items),iconNameFor(selectedType(draft.equipment[0])))}
      ${summaryCard(3,"Delivery Details",`${esc(access)}${specialCondition?`<br><small>${esc(specialCondition)}</small>`:""}`,"stairs")}
      ${summaryCard(4,"Appointment",`${esc(date)} at ${esc(time)}`,"equipment")}
      <button type="button" class="ux-summary-card optional" id="equipmentDetailsLater"><i>${gpIcon("assembly")}</i><span><small>Equipment Details</small><b>Add make, model, notes, and photos later</b></span><em>›</em></button>
    </div>
    <section class="ux-review-price" aria-label="Estimated delivery price">
      <span>Estimated Delivery Price</span>
      <strong>$${quoteEstimate()}</strong>
      <small>Final charge may change if job details change.</small>
    </section>
  </div>`;
}
function sync(){
  const fd=new FormData(wizardForm);
  ["firstName","lastName","phone","email","address","jobTypeId","scheduledDate","scheduledTime","internalNotes"].forEach(k=>{if(fd.has(k))draft[k]=fd.get(k)});
  draft.phone=normalizePhone(draft.phone);
}
function validate(){
  sync();
  if(draft.step===0&&!draft.jobTypeId)return "Choose a job type.";
  if(draft.step===1){if(!draft.firstName.trim())return "Enter the customer's first name.";if(draft.phone.replace(/\D/g,"").length!==10)return "Enter a valid 10-digit phone number.";if(!draft.address.trim())return "Enter the customer address.";}
  if(draft.step===2&&draft.equipment.length<1)return "Add at least one equipment item.";
  if(draft.step===2&&isDeliveryPickupDraft()){
    if(!draft.equipment.some(item=>itemMovement(item)==="delivery"))return "Add at least one delivery item.";
    if(!draft.equipment.some(item=>itemMovement(item)==="pickup"))return "Add at least one pickup item.";
  }
  if(draft.step===3&&!draft.destinationId)return "Choose where the equipment is going.";
  if(draft.step===3&&draft.destinationId==="upstairs"&&!draft.flights)return "Choose the number of flights.";
  if(draft.step===4&&(!draft.scheduledDate||!draft.scheduledTime))return "Choose an available date and time.";
  return "";
}
function renderWizard(){
  const steps=[jobTypeStep,customerStep,equipmentStep,deliveryDetailsStep,appointmentStep,summaryStep];
  wizardStepLabel.textContent=draft.mode==="reschedule"?(draft.step===4?"Select Appointment":"Final Review"):`Step ${draft.step+1} of ${steps.length}`;
  wizardProgress.innerHTML=UX_STEPS.map((label,i)=>`<i class="${i<=draft.step?"active":""}" title="${label}"></i>`).join("");
  wizardProgress.style.gridTemplateColumns=`repeat(${steps.length},1fr)`;
  wizardForm.innerHTML=steps[draft.step]();
  wizardBack.style.visibility=draft.mode==="reschedule"?"visible":(draft.step?"visible":"hidden");
  wizardNext.style.visibility=draft.step===0?"hidden":"visible";
  wizardBack.textContent=draft.editingFromSummary?"Cancel Edit":"Back";
  wizardNext.textContent=draft.mode==="reschedule"?(draft.step===4?"Review Change":"Save & Return"):draft.editingFromSummary?"Save Edit":draft.step===steps.length-1?"Save & Return":draft.step===4?"Reserve Appointment":"Continue";
  wizardNext.classList.add("primary-action");
  bindStep();
}
function bindStep(){
  wizardForm.querySelectorAll("[data-job-type-choice]").forEach(el=>el.onclick=()=>{
    const type=resolveJobType(el.dataset.jobTypeChoice);
    if(!type)return toast("That job type is not active in the CMS.");
    draft.jobTypeId=type.id;draft.step=1;saveDraft(false);renderWizard();
  });
  if(draft.step===1){
    const fields=[...wizardForm.querySelectorAll('input[name="firstName"],input[name="lastName"],input[name="phone"],input[name="address"]')];
    fields.forEach(input=>input.addEventListener("input",()=>{
      if(input.name==="phone")input.value=normalizePhone(input.value);
      draft[input.name]=input.value;
      draft.customerId="";
      // Keep dismissed suggestions dismissed for the remainder of this draft.
      scheduleCustomerMatchUpdate();
    }));
    bindCustomerMatchActions();
  }
  wizardForm.querySelectorAll("[data-condition]").forEach(el=>el.onclick=()=>{draft.pendingCondition=el.dataset.condition;saveDraft(false);renderWizard();});
  wizardForm.querySelectorAll("[data-add-equipment]").forEach(el=>el.onclick=()=>{
    const movement=el.dataset.equipmentMovement|| (isPickupOnlyDraft()?"pickup":"delivery");
    if(movement==="delivery"&&!draft.pendingCondition){toast("Choose New or Used first.");return;}
    draft.equipment.push({
      ...blankItem(),
      condition:movement==="pickup"?"Used":draft.pendingCondition,
      movement,
      deliveryRequired:movement==="delivery",
      pickupRequired:movement==="pickup",
      equipmentTypeId:el.dataset.addEquipment,
      quantity:1
    });
    saveDraft(false);renderWizard();
  });
  wizardForm.querySelectorAll("[data-edit-equipment]").forEach(el=>el.onclick=()=>openEquipmentEditor(Number(el.dataset.editEquipment)));
  wizardForm.querySelectorAll("[data-destination]").forEach(el=>el.onclick=()=>{selectDestination(el.dataset.destination);renderWizard();});
  wizardForm.querySelectorAll("[data-flights]").forEach(el=>el.onclick=()=>{draft.flights=el.dataset.flights;rebuildDestinationAccess();renderWizard();});
  wizardForm.querySelectorAll("[data-access-modifier]").forEach(el=>el.onclick=()=>{const id=el.dataset.accessModifier;draft.access=draft.access.includes(id)?draft.access.filter(x=>String(x)!==String(id)):[...draft.access,id];renderWizard();});
  wizardForm.querySelector("[data-more-access]")?.addEventListener("toggle",event=>{draft.moreAccessOpen=event.currentTarget.open;});
  wizardForm.querySelector('textarea[name="internalNotes"]')?.addEventListener("input",event=>{draft.internalNotes=event.currentTarget.value;});
  wizardForm.querySelectorAll("[data-date]").forEach(el=>el.onclick=()=>{draft.scheduledDate=el.dataset.date;draft.scheduledTime="";draft.appointmentView="times";renderWizard();});
  wizardForm.querySelector("[data-back-to-dates]")?.addEventListener("click",()=>{draft.appointmentView="dates";renderWizard();});
  wizardForm.querySelectorAll("[data-appointment-week]").forEach(el=>el.onclick=()=>{const current=appointmentWeekStart();const next=addLocalDays(current,Number(el.dataset.appointmentWeek)*7);draft.appointmentWeekStart=dateKeyLocal(next);draft.appointmentView="dates";renderWizard();});
  wizardForm.querySelectorAll("[data-time]").forEach(el=>el.onclick=()=>{draft.scheduledTime=el.dataset.time;renderWizard();});
  wizardForm.querySelectorAll("[data-edit-step]").forEach(el=>el.onclick=()=>{
    draft.editingFromSummary=true;
    draft.editStep=Number(el.dataset.editStep);
    draft.step=draft.editStep;
    saveDraft(false);
    renderWizard();
  });
  wizardForm.querySelector("#equipmentDetailsLater")?.addEventListener("click",()=>toast("Equipment details will remain available from the Job Summary after creation."));
}
function openEquipmentEditor(index){
  const mount=wizardForm.querySelector("#equipmentEditMount");if(!mount)return;mount.innerHTML=equipmentEditSheet(index);
  const sheet=mount.querySelector("#equipmentEditSheet");
  const close=()=>{sheet?.remove();renderWizard();};
  mount.querySelector("#closeEquipmentEdit").onclick=close;
  sheet.onclick=e=>{if(e.target===sheet)close();};
  mount.querySelectorAll("[data-edit-condition]").forEach(el=>el.onclick=()=>{draft.equipment[index].condition=el.dataset.editCondition;openEquipmentEditor(index);});
  mount.querySelectorAll("[data-qty-change]").forEach(el=>el.onclick=()=>{draft.equipment[index].quantity=Math.max(1,Number(draft.equipment[index].quantity||1)+Number(el.dataset.qtyChange));openEquipmentEditor(index);});
  mount.querySelector("#removeEditedEquipment").onclick=()=>{draft.equipment.splice(index,1);close();};
}
wizardNext.onclick=async()=>{
  const err=validate();if(err)return toast(err);

  if(draft.mode==="reschedule"){
    if(draft.step===4){draft.step=5;renderWizard();return;}
    wizardNext.disabled=true;wizardBack.disabled=true;wizardNext.textContent="Saving…";
    try{
      const pinToken=await requestPin("canCreateQuote","Enter your employee PIN to save the corrected appointment.");
      await api.updateJobSchedule(draft.rescheduleJobId,draft.scheduledDate,draft.scheduledTime,pinToken);
      touchPinSession();
      const returnJobId=draft.rescheduleReturnJobId;
      localStorage.removeItem(DRAFT_KEY);draft=blankDraft();closeWizard();
      await loadLiveData();
      openJob(returnJobId);
      toast("Appointment rescheduled. Review the job before manager approval.");
    }catch(error){console.error(error);toast(error.message||"The appointment could not be rescheduled.");wizardNext.disabled=false;wizardBack.disabled=false;renderWizard();}
    return;
  }

  // Edits launched from Screen 6 are saved directly back to Screen 6.
  if(draft.editingFromSummary){
    sync();
    draft.editingFromSummary=false;
    draft.editStep=null;
    draft.step=5;
    saveDraft(false);
    renderWizard();
    toast("Edit saved.");
    return;
  }

  const count=6;
  if(draft.step<count-1){draft.step++;saveDraft(false);renderWizard();return;}

  sync();
  wizardNext.disabled=true;
  wizardBack.disabled=true;
  wizardNext.textContent="Saving…";
  try{
    const pinToken=await requestPin("canCreateQuote","Enter your employee PIN to save this tentative appointment and stamp your name into its history.");
    const payload={
      ...draft,
      equipment:draft.equipment.map(item=>({
        ...item,
        movement:itemMovement(item),
        deliveryRequired:itemMovement(item)==="delivery",
        pickupRequired:itemMovement(item)==="pickup"
      })),
      status:"Tentative",
      estimatedPrice:quoteEstimate(),
      estimatedDurationMinutes:estimatedDraftMinutes(),
      customerName:customerName()
    };
    delete payload.editingFromSummary;
    delete payload.editStep;

    const result=await api.createJob(payload,pinToken);
    if(!result)throw new Error("The CMS did not confirm that the job was saved.");

    touchPinSession();
    localStorage.removeItem(DRAFT_KEY);
    draft=blankDraft();
    closeWizard();

    const jobLabel=result.jobNumber||result.jobId||result.id||"New job";
    toast(`✓ ${jobLabel} saved as Tentative.`);
    await loadLiveData();
    go("today");
  }catch(error){
    console.error(error);
    toast(error.message||"The tentative job could not be saved.");
    wizardNext.disabled=false;
    wizardBack.disabled=false;
    renderWizard();
  }
};
wizardBack.onclick=()=>{
  sync();
  if(draft.mode==="reschedule"){
    if(draft.step===5){draft.step=4;renderWizard();return;}
    const returnJobId=draft.rescheduleReturnJobId;
    draft=blankDraft();closeWizard();openJob(returnJobId);return;
  }
  if(draft.editingFromSummary){
    draft.editingFromSummary=false;
    draft.editStep=null;
    draft.step=5;
    renderWizard();
    return;
  }
  draft.step=Math.max(0,draft.step-1);
  renderWizard();
};
document.querySelector("#closeWizard").onclick=closeWizard;

wizardBackdrop.onclick=closeWizard;

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
