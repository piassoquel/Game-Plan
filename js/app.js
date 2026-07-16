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

const state = { jobs: demoJobs, customers: demoCustomers, live: false };
const api = new GamePlanApi(window.GAMEPLAN_CONFIG);

const view = document.querySelector("#view");
const title = document.querySelector("#title");
const sub = document.querySelector("#subtitle");
const toastBox = document.querySelector("#toast");
const dataStatus = document.querySelector("#dataStatus");
const drawer = document.querySelector("#jobDrawer");
const drawerBackdrop = document.querySelector("#drawerBackdrop");
const drawerContent = document.querySelector("#drawerContent");

const todayDate = new Intl.DateTimeFormat("en-US",{weekday:"long",month:"long",day:"numeric"}).format(new Date());

function toast(message) {
  toastBox.innerHTML = `<div class="toast">${message}</div>`;
  setTimeout(() => toastBox.innerHTML = "", 2800);
}

function badgeClass(status) {
  return ({
    Scheduled:"scheduled",
    Tentative:"tentative",
    Completed:"completed",
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

function renderLifecycle(status) {
  const order = ["Quote","Tentative","Scheduled","Completed"];
  const currentIndex = Math.max(0, order.indexOf(status));
  return `<div class="lifecycle">${order.map((step,index)=>{
    const cls = index < currentIndex ? "done" : index === currentIndex ? "current" : "";
    const icon = step === "Quote" ? "▤" : step === "Tentative" ? "▣" : step === "Scheduled" ? "▦" : "✓";
    return `<div class="life-step ${cls}"><div class="life-icon">${icon}</div>${step}</div>`;
  }).join("")}</div>`;
}

function equipmentImage(item) {
  return item.imageUrl
    ? `<img class="equipment-photo" src="${item.imageUrl}" alt="${item.brand} ${item.model}">`
    : `<div class="equipment-photo">Equipment</div>`;
}

function openJob(jobId) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return;
  drawerContent.innerHTML = `
    ${renderLifecycle(job.status)}
    <section class="detail-card">
      <span class="badge ${badgeClass(job.status)}">${job.status}</span>
      <h3>${job.customer}</h3>
      <div>${job.address}</div>
      <div class="detail-line"><span>Appointment</span><strong>${job.date}, ${job.time}</strong></div>
      <div class="detail-line"><span>Estimated duration</span><strong>${job.duration || "—"}</strong></div>
    </section>

    <section class="detail-card">
      <h3>Equipment (${job.equipment?.length || 0})</h3>
      ${(job.equipment || []).map(item => `<div class="equipment-card">
        ${equipmentImage(item)}
        <div><strong>${item.brand || ""} ${item.model || ""}</strong><small>${item.type || ""}</small></div>
        ${job.buildRequired && !job.buildComplete ? `<span class="build-warning">Needs Build</span>` : `<span class="badge completed">Ready</span>`}
      </div>`).join("")}
      ${job.buildRequired ? `<div class="detail-line"><span>Build status</span><strong>${job.buildComplete ? "Built" : "Not Built"}</strong></div>` : ""}
    </section>

    <section class="detail-card">
      <div class="detail-line"><span>Crew size</span><strong>${job.crewSize || "—"}</strong></div>
      <div class="detail-line"><span>Total price</span><strong>$${Number(job.total || 0).toFixed(2)}</strong></div>
    </section>

    <div class="drawer-actions">
      <a class="button" href="tel:${job.phone}">Call Customer</a>
      ${job.buildRequired && !job.buildComplete ? `<button class="button green" data-demo-action="Mark as Built">Mark as Built</button>` : ""}
      <button class="button neutral" data-demo-action="View on Map">View on Map</button>
    </div>
  `;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");
  drawer.setAttribute("aria-hidden","false");
  bindDynamic();
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
            <button data-route="roster">◎<br>Find Customer</button>
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
    title:"Schedule", sub:"Internal GamePlan schedule",
    html:()=>`<section class="card"><div class="head"><h2>Upcoming Jobs</h2><button class="button" data-demo-action="New Tentative">New Tentative</button></div><div class="body list">${state.jobs.map(j=>`<div class="row" data-open-job="${j.id}"><div><b>${j.date}, ${j.time} · ${j.customer}</b><span>${j.type} · ${j.address}</span></div><span class="badge ${badgeClass(j.status)}">${j.status}</span></div>`).join("")}</div></section>`
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
    el.onclick = () => toast(`${el.dataset.demoAction} becomes active in a later milestone.`);
  });
  view.querySelectorAll("[data-route]").forEach(el => {
    el.onclick = () => go(el.dataset.route);
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

document.querySelector("#closeDrawer").onclick = closeJob;
drawerBackdrop.onclick = closeJob;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(console.error));
}

go(location.hash.slice(1) || "today");
loadLiveData();
