import { GamePlanApi } from "./api.js";

const demoJobs = [
  {id:"JOB-2026-0187",number:"GP-2026-0187",customer:"John Smith",phone:"+18315550101",time:"10:00 AM",date:"Tomorrow",type:"Treadmill Delivery",address:"123 Main St, Soquel",status:"Scheduled",total:245,crewSize:2,duration:"2 hr 15 min",buildRequired:true,buildComplete:false,equipment:[{brand:"NordicTrack",model:"T 6.5 S",type:"Treadmill",imageUrl:""}]},
  {id:"JOB-2026-0188",number:"GP-2026-0188",customer:"Sarah Johnson",phone:"+18315550102",time:"11:00 AM",date:"Today",type:"Pickup",address:"456 Ocean St, Santa Cruz",status:"Scheduled",total:110,crewSize:2,duration:"1 hr 20 min",buildRequired:false,buildComplete:true,equipment:[{brand:"Precor",model:"EFX",type:"Elliptical",imageUrl:""}]},
  {id:"JOB-2026-0189",number:"GP-2026-0189",customer:"Mike Davis",phone:"+18315550103",time:"9:00 AM",date:"Tomorrow",type:"Delivery · 2 Items",address:"789 Bay Ave, Capitola",status:"Tentative",total:180,crewSize:2,duration:"2 hr",buildRequired:true,buildComplete:false,equipment:[{brand:"Schwinn",model:"190",type:"Upright Exercise Bike",imageUrl:""}]},
  {id:"JOB-2026-0190",number:"GP-2026-0190",customer:"Emily Davis",phone:"+18315550104",time:"1:30 PM",date:"Today",type:"Home Gym Package",address:"321 Lighthouse Ave, Santa Cruz",status:"Scheduled",total:395,crewSize:2,duration:"4 hr 30 min",buildRequired:false,buildComplete:true,equipment:[{brand:"Inspire",model:"M3",type:"Home Gym",imageUrl:""}]}
];

const demoCustomers = [
  {id:"CUS-001",name:"John Smith",phone:"(831) 555-0101",email:"john@example.com",jobs:3},
  {id:"CUS-002",name:"Sarah Johnson",phone:"(831) 555-0102",email:"sarah@example.com",jobs:1},
  {id:"CUS-003",name:"Mike Davis",phone:"(831) 555-0103",email:"mike@example.com",jobs:2}
];

const state = {
  jobs: demoJobs,
  customers: demoCustomers,
  equipmentTypes: [
    {id:"EQP-UPBIKE",name:"Upright Exercise Bike"},
    {id:"EQP-RECBIKE",name:"Recumbent Exercise Bike"},
    {id:"EQP-ELLIP",name:"Elliptical"},
    {id:"EQP-TREAD",name:"Treadmill"},
    {id:"EQP-ROW",name:"Rowing Machine"},
    {id:"EQP-BENCH",name:"Weight Bench"},
    {id:"EQP-WSET",name:"Weight Set"},
    {id:"EQP-RACK",name:"Squat Rack"},
    {id:"EQP-HGYM",name:"Home Gym"},
    {id:"EQP-HOOP",name:"Basketball Hoop"},
    {id:"EQP-TABLE",name:"Table Tennis Table"},
    {id:"EQP-OTHER",name:"Other"}
  ],
  jobTypes: [
    {id:"JT-DEL",name:"Delivery"},{id:"JT-PICK",name:"Pickup"},
    {id:"JT-DELASM",name:"Delivery + Assembly"},{id:"JT-PICKDIS",name:"Pickup + Disassembly"},
    {id:"JT-EXCH",name:"Exchange"},{id:"JT-DISP",name:"Disposal Pickup"}
  ],
  accessConditions: [
    {id:"ACC-GARAGE",name:"Garage"},{id:"ACC-SINGLE",name:"Single Level"},
    {id:"ACC-STAIR1",name:"First Flight of Stairs"},{id:"ACC-STAIRX",name:"Each Additional Flight"},
    {id:"ACC-LONG",name:"Long Carry"},{id:"ACC-NARROW",name:"Narrow Doorway"},
    {id:"ACC-HEAVY",name:"Heavy or Commercial Access"}
  ],
  products: [],
  brands: [],
  fulfillmentConditions: [
    {id:"NIB",name:"New In Box"},
    {id:"FLR",name:"Floor Model"},
    {id:"IBD",name:"In-Box Delivery"}
  ],
  live: false
};
const api = new GamePlanApi(window.GAMEPLAN_CONFIG);

const scheduleState = {
  weekStart: startOfWeek(new Date()),
  selectedDay: toDateKey(new Date())
};

const view = document.querySelector("#view");
const title = document.querySelector("#title");
const sub = document.querySelector("#subtitle");
const toastBox = document.querySelector("#toast");
const dataStatus = document.querySelector("#dataStatus");
const drawer = document.querySelector("#jobDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const drawerContent = document.querySelector("#drawerContent");

const todayDate = new Intl.DateTimeFormat("en-US",{weekday:"long",month:"long",day:"numeric"}).format(new Date());

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
  const raw = job.scheduledDate || job.dateISO || job.appointmentDate || job.date || "";
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
  const unscheduled = state.jobs.filter(job => !parseJobDate(job) && job.status !== "Cancelled");
  const totalHours = weekJobs.reduce((sum, job) => sum + parseDurationHours(job), 0);
  const selectedTitle = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(selectedDate);

  return `<div class="schedule-planner">
    <section class="schedule-toolbar">
      <button class="button neutral schedule-nav" data-week-nav="-1" aria-label="Previous week">←</button>
      <div class="schedule-range"><span>Weekly operations plan</span><strong>${weekLabel(scheduleState.weekStart)}</strong></div>
      <button class="button neutral schedule-nav" data-week-nav="1" aria-label="Next week">→</button>
      <button class="button schedule-today" data-week-today>This Week</button>
    </section>

    <section class="schedule-summary">
      <div class="stat"><b>${weekJobs.length}</b><span>Scheduled jobs</span></div>
      <div class="stat"><b>${Math.round(totalHours * 10) / 10}</b><span>Estimated hours</span></div>
      <div class="stat"><b>${state.jobs.filter(job => job.status === "Tentative" && parseJobDate(job)).length}</b><span>Awaiting confirmation</span></div>
      <div class="stat"><b>${unscheduled.length}</b><span>Unscheduled</span></div>
    </section>

    <section class="week-grid" aria-label="Weekly schedule">
      ${days.map(day => {
        const jobs = jobsForDate(day);
        const load = scheduleLoadInfo(jobs);
        const selected = toDateKey(day) === scheduleState.selectedDay;
        const today = toDateKey(day) === toDateKey(new Date());
        return `<button class="week-day ${selected ? "selected" : ""} ${today ? "today" : ""}" data-select-day="${toDateKey(day)}">
          <div class="week-day__top"><span>${new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(day)}</span><b>${day.getDate()}</b></div>
          <div class="capacity-track"><i class="${load.level}" style="width:${Math.min(load.percent, 100)}%"></i></div>
          <div class="week-day__meta"><strong>${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}</strong><span>${load.label}</span></div>
          <div class="status-dots">${jobs.slice(0, 6).map(job => `<i class="${badgeClass(job.status)}" title="${esc(job.status)}"></i>`).join("")}</div>
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

function workflowActions(job) {
  if (job.status === "Tentative") return `
    <button class="button primary-action" data-status-action="Scheduled" data-job-id="${esc(job.id)}">✓ Confirm Appointment</button>
    <button class="button neutral" data-demo-action="Edit / Reschedule">Edit / Reschedule</button>
    <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
  if (job.status === "Scheduled") return `
    <button class="button green primary-action" data-status-action="Completed" data-job-id="${esc(job.id)}">✓ Mark Complete</button>
    <button class="button neutral" data-demo-action="Edit / Reschedule">Edit / Reschedule</button>
    <button class="button red" data-status-action="Cancelled" data-job-id="${esc(job.id)}">Cancel Job</button>`;
  if (job.status === "Quote") return `<button class="button primary-action" data-status-action="Tentative" data-job-id="${esc(job.id)}">Hold Tentative Appointment</button>`;
  return "";
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
        <div><strong>${esc(item.brand || "")} ${esc(item.model || "")}</strong><small>${esc(item.type || "")}</small></div>
        ${job.buildRequired && !job.buildComplete ? `<span class="build-warning">Needs Build</span>` : `<span class="badge completed">Ready</span>`}
      </div>`).join("")}
      ${job.buildRequired ? `<div class="detail-line"><span>Build status</span><strong class="${job.buildComplete ? "" : "danger-text"}">${job.buildComplete ? "Built" : "Not Built"}</strong></div>` : ""}
    </section>

    <section class="detail-card">
      <div class="detail-line"><span>Crew</span><strong>${esc(job.crewSize || "—")} Person Crew</strong></div>
      <div class="detail-line"><span>Estimated duration</span><strong>${esc(job.duration || "—")}</strong></div>
      <div class="detail-line"><span>Total price</span><strong class="detail-total">$${Number(job.total || 0).toFixed(2)}</strong></div>
    </section>

    <div class="drawer-actions">
      ${workflowActions(job)}
      <a class="button call-action" href="tel:${esc(job.phone)}">Call Customer</a>
      <button class="button neutral" data-demo-action="Send Confirmation">Send Confirmation</button>
      <button class="button neutral" data-demo-action="View on Map">View on Map</button>
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
    await api.updateJobStatus(jobId, newStatus, "Updated from Job Details");
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
          <div class="copy"><strong>Build Alerts</strong><span>${state.jobs.filter(j=>j.buildRequired&&!j.buildComplete).length} upcoming jobs still need equipment assembled.</span></div>
          <button class="button" data-route="jobs">View Items</button>
        </section>
        <section class="card">
          <div class="head"><h2>Today's Queue</h2></div>
          <div class="body queue">${state.jobs.map(queueItem).join("")}</div>
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
            <div class="stat"><b>${state.jobs.filter(j=>j.status==="Scheduled").length}</b><span>Scheduled</span></div>
            <div class="stat"><b>${state.jobs.filter(j=>j.status==="Tentative").length}</b><span>Tentative</span></div>
            <div class="stat"><b>${state.jobs.filter(j=>j.buildRequired&&!j.buildComplete).length}</b><span>Need Build</span></div>
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
    html:()=>`<section class="card"><div class="head"><h2>All Jobs</h2><button class="button" data-demo-action="New Job">New Job</button></div><div class="body list">${state.jobs.map(j=>`<div class="row" data-open-job="${j.id}"><div><b>${j.customer}</b><span>${j.number} · ${j.type} · ${j.date} ${j.time}</span></div><span class="badge ${badgeClass(j.status)}">${j.status}</span></div>`).join("")}</div></section>`
  },

  roster: {
    title:"Roster", sub:"Customers and saved service addresses",
    html:()=>`<section class="card"><div class="head"><h2>Customers</h2><button class="button" data-demo-action="Add Customer">Add Customer</button></div><div class="body list">${state.customers.map(c=>`<div class="row"><div><b>${c.name}</b><span>${c.phone} · ${c.email || ""}</span></div><span class="badge">${c.jobs || 0} jobs</span></div>`).join("")}</div></section>`
  },

  more: {
    title:"More", sub:"Administration and app information",
    html:()=>`<div class="grid two"><section class="card"><div class="head"><h2>Administration</h2></div><div class="body list"><button class="row" data-demo-action="Settings"><div><b>Settings</b><span>Pricing, timing, availability, and app rules</span></div><b>⚙</b></button><button class="row" data-demo-action="Huddle Together"><div><b>Huddle Together</b><span>Group scheduled jobs into one operational route</span></div><b>↝</b></button></div></section><section class="card"><div class="head"><h2>System</h2></div><div class="body"><div class="row"><div><b>Data source</b><span>${state.live ? "Live GamePlan CMS" : "Demo fallback"}</span></div><span class="badge ${state.live ? "completed" : "tentative"}">${state.live ? "Live" : "Demo"}</span></div></div></section></div>`
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

function go(route) {
  const selected = views[route] ? route : "today";
  const v = views[selected];
  title.textContent = v.title;
  sub.textContent = v.sub;
  view.innerHTML = v.html();
  document.querySelectorAll("[data-route]").forEach(b => b.classList.toggle("active", b.dataset.route === selected));
  bindDynamic();
  history.replaceState({}, "", `#${selected}`);
}

async function loadLiveData() {
  if (!api.isConfigured) {
    dataStatus.textContent = "Demo Data";
    dataStatus.className = "demo error";
    return;
  }
  try {
    const data = await api.getBootstrap();
    state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    state.customers = Array.isArray(data.customers) ? data.customers : [];
    if (Array.isArray(data.equipmentTypes) && data.equipmentTypes.length) state.equipmentTypes = data.equipmentTypes;
    if (Array.isArray(data.jobTypes) && data.jobTypes.length) state.jobTypes = data.jobTypes;
    if (Array.isArray(data.accessConditions) && data.accessConditions.length) state.accessConditions = data.accessConditions;
    if (Array.isArray(data.products)) state.products = data.products;
    if (Array.isArray(data.brands)) state.brands = data.brands;
    if (Array.isArray(data.fulfillmentConditions) && data.fulfillmentConditions.length) state.fulfillmentConditions = data.fulfillmentConditions;
    state.live = true;
    dataStatus.textContent = "Live CMS";
    dataStatus.className = "demo live";
    go(location.hash.slice(1) || "today");
  } catch (error) {
    console.error(error);
    dataStatus.textContent = "Demo Fallback";
    dataStatus.className = "demo error";
    toast("Live CMS connection failed. Showing demo data.");
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
   const result=await api.createJob(draft);
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

go(location.hash.slice(1) || "today");
loadLiveData();
