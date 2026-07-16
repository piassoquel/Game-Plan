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
  live: false
};
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
    el.onclick = () => {
      if (["New Job","New Tentative"].includes(el.dataset.demoAction)) openWizard();
      else toast(`${el.dataset.demoAction} becomes active in a later version.`);
    };
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
    if (Array.isArray(data.equipmentTypes) && data.equipmentTypes.length) state.equipmentTypes = data.equipmentTypes;
    if (Array.isArray(data.jobTypes) && data.jobTypes.length) state.jobTypes = data.jobTypes;
    if (Array.isArray(data.accessConditions) && data.accessConditions.length) state.accessConditions = data.accessConditions;
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
const DRAFT_KEY = "gameplan-job-draft-v0.3";

const blankDraft = () => ({
  step: 0,
  customerMode: "existing",
  customerId: "",
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  address: "",
  jobTypeId: "JT-DEL",
  equipment: [{equipmentTypeId:"EQP-TREAD",condition:"New",brand:"",model:"",quantity:1,storeAssembly:true,buildRequired:true}],
  access: ["ACC-SINGLE"],
  scheduledDate: "",
  scheduledTime: "",
  crewSize: 2,
  internalNotes: ""
});
let draft = blankDraft();

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]));
}
function selectedCustomer() { return state.customers.find(c => c.id === draft.customerId); }
function optionList(items, current) {
  return items.map(item => `<option value="${esc(item.id)}" ${item.id===current?"selected":""}>${esc(item.name)}</option>`).join("");
}
function openWizard() {
  const saved = localStorage.getItem(DRAFT_KEY);
  if (saved) {
    try { draft = {...blankDraft(), ...JSON.parse(saved)}; } catch { draft = blankDraft(); }
  } else draft = blankDraft();
  renderWizard();
  wizard.classList.add("open"); wizardBackdrop.classList.add("open");
  wizard.setAttribute("aria-hidden","false");
}
function closeWizard() {
  wizard.classList.remove("open"); wizardBackdrop.classList.remove("open");
  wizard.setAttribute("aria-hidden","true");
}
function saveDraft(showToast=true) {
  syncWizardInputs();
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  if (showToast) toast("Job draft saved on this device.");
}
function clearDraft() { localStorage.removeItem(DRAFT_KEY); draft = blankDraft(); }
function stepHeading(titleText, description) {
  return `<div class="step-wrap"><h2>${titleText}</h2><p>${description}</p>`;
}
function renderCustomerStep() {
  const query = `${draft.firstName} ${draft.lastName}`.trim().toLowerCase();
  const results = state.customers.filter(c => !query || c.name.toLowerCase().includes(query) || (c.phone||"").includes(query)).slice(0,8);
  return `${stepHeading("Who is this job for?","Find an existing customer or add a new one.")}
    ${localStorage.getItem(DRAFT_KEY)?`<div class="draft-banner"><span>An unfinished job draft was restored.</span><button type="button" class="text-button" id="discardDraft">Discard</button></div>`:""}
    <div class="choice-grid" style="margin-bottom:16px">
      <label class="choice"><input type="radio" name="customerMode" value="existing" ${draft.customerMode==="existing"?"checked":""}><strong>Existing Customer</strong><small>Search the roster</small></label>
      <label class="choice"><input type="radio" name="customerMode" value="new" ${draft.customerMode==="new"?"checked":""}><strong>New Customer</strong><small>Create a new roster entry later</small></label>
    </div>
    ${draft.customerMode==="existing" ? `
      <div class="field"><label>Search customers</label><input id="customerSearch" value="${esc(query)}" placeholder="Name or phone number" autocomplete="off"></div>
      <div class="search-results">${results.length ? results.map(c=>`<button type="button" class="customer-result ${draft.customerId===c.id?"selected":""}" data-select-customer="${esc(c.id)}"><div><strong>${esc(c.name)}</strong><small>${esc(c.phone||"No phone")} · ${esc(c.email||"No email")}</small></div><span>${draft.customerId===c.id?"✓":"›"}</span></button>`).join("") : `<div class="notice">No matching customers. Choose New Customer to enter their information.</div>`}</div>
    ` : `
      <div class="form-grid"><div class="field"><label>First name</label><input name="firstName" value="${esc(draft.firstName)}" required></div><div class="field"><label>Last name</label><input name="lastName" value="${esc(draft.lastName)}" required></div></div>
      <div class="form-grid"><div class="field"><label>Phone</label><input name="phone" type="tel" value="${esc(draft.phone)}" required></div><div class="field"><label>Email</label><input name="email" type="email" value="${esc(draft.email)}"></div></div>
    `}
    <div class="field"><label>Service address</label><input name="address" value="${esc(draft.address)}" placeholder="Customer delivery or pickup address" required></div>
  </div>`;
}
function renderEquipmentStep() {
  return `${stepHeading("What equipment is involved?","Add each item and choose the services it requires.")}
    <div class="field"><label>Job type</label><select name="jobTypeId">${optionList(state.jobTypes,draft.jobTypeId)}</select></div>
    <div id="equipmentEditors">${draft.equipment.map((item,index)=>`
      <div class="equipment-editor">
        <div class="equipment-editor__head"><strong>Item ${index+1}</strong>${draft.equipment.length>1?`<button type="button" class="remove-link" data-remove-equipment="${index}">Remove</button>`:""}</div>
        <div class="form-grid">
          <div class="field"><label>Equipment type</label><select data-equipment-field="equipmentTypeId" data-index="${index}">${optionList(state.equipmentTypes,item.equipmentTypeId)}</select></div>
          <div class="field"><label>Condition</label><select data-equipment-field="condition" data-index="${index}"><option ${item.condition==="New"?"selected":""}>New</option><option ${item.condition==="Used"?"selected":""}>Used</option></select></div>
          <div class="field"><label>Brand</label><input data-equipment-field="brand" data-index="${index}" value="${esc(item.brand)}" placeholder="NordicTrack"></div>
          <div class="field"><label>Model</label><input data-equipment-field="model" data-index="${index}" value="${esc(item.model)}" placeholder="T 6.5 S"></div>
        </div>
        <div class="choice-grid">
          <label class="choice"><input type="checkbox" data-equipment-field="storeAssembly" data-index="${index}" ${item.storeAssembly?"checked":""}><strong>Store Assembly</strong><small>Build before delivery</small></label>
          <label class="choice"><input type="checkbox" data-equipment-field="buildRequired" data-index="${index}" ${item.buildRequired?"checked":""}><strong>Build Required</strong><small>Add to build alerts</small></label>
        </div>
      </div>`).join("")}</div>
    <button type="button" class="add-row" id="addEquipment">＋ Add Another Item</button>
  </div>`;
}
function renderAccessStep() {
  return `${stepHeading("What is access like?","Select every condition that affects delivery time or difficulty.")}
    <div class="choice-grid">${state.accessConditions.map(a=>`<label class="choice"><input type="checkbox" name="access" value="${esc(a.id)}" ${draft.access.includes(a.id)?"checked":""}><strong>${esc(a.name)}</strong><small>${a.id.includes("STAIR")?"Adds time and access charge":"Include when applicable"}</small></label>`).join("")}</div>
  </div>`;
}
function renderScheduleStep() {
  return `${stepHeading("When should we hold the appointment?","This creates the scheduling information for a tentative job.")}
    <div class="form-grid">
      <div class="field"><label>Date</label><input name="scheduledDate" type="date" value="${esc(draft.scheduledDate)}"></div>
      <div class="field"><label>Start time</label><input name="scheduledTime" type="time" value="${esc(draft.scheduledTime)}"></div>
    </div>
    <div class="field"><label>Crew size</label><select name="crewSize"><option value="1" ${draft.crewSize==1?"selected":""}>1 person</option><option value="2" ${draft.crewSize==2?"selected":""}>2 people</option><option value="3" ${draft.crewSize==3?"selected":""}>3 people</option></select></div>
    <div class="field"><label>Internal notes</label><textarea name="internalNotes" rows="4" placeholder="Parking, customer requests, timing notes…">${esc(draft.internalNotes)}</textarea></div>
    <div class="notice">Conflict detection, Google travel time, and automatic duration will be added in the Smart Scheduling and Maps versions.</div>
  </div>`;
}
function renderReviewStep() {
  const customer = draft.customerMode==="existing" ? selectedCustomer()?.name || "Customer not selected" : `${draft.firstName} ${draft.lastName}`.trim();
  const accessNames = state.accessConditions.filter(a=>draft.access.includes(a.id)).map(a=>a.name).join(", ") || "None selected";
  const dateText = draft.scheduledDate || "Not scheduled";
  return `${stepHeading("Review the GamePlan","Confirm the information before saving this working draft.")}
    <div class="summary-grid">
      <div class="summary-box"><span>Customer</span><strong>${esc(customer)}</strong></div>
      <div class="summary-box"><span>Appointment</span><strong>${esc(dateText)} ${esc(draft.scheduledTime||"")}</strong></div>
      <div class="summary-box"><span>Equipment</span><strong>${draft.equipment.length} item${draft.equipment.length===1?"":"s"}</strong></div>
      <div class="summary-box"><span>Crew</span><strong>${draft.crewSize} person${draft.crewSize==1?"":"s"}</strong></div>
    </div>
    <div class="review-section"><h3>Address</h3><p>${esc(draft.address||"Not entered")}</p></div>
    <div class="review-section"><h3>Equipment</h3>${draft.equipment.map(i=>`<p><strong>${esc(i.brand)} ${esc(i.model)}</strong> · ${esc(state.equipmentTypes.find(t=>t.id===i.equipmentTypeId)?.name||i.equipmentTypeId)} · ${esc(i.condition)}${i.buildRequired?" · Needs Build":""}</p>`).join("")}</div>
    <div class="review-section"><h3>Access</h3><p>${esc(accessNames)}</p></div>
    <div class="notice">Secure CMS writes are intentionally disabled until employee authentication is active. “Save Job Draft” stores this record on the current device without adding customer information to the public API.</div>
  </div>`;
}
function syncWizardInputs() {
  if (!wizardForm) return;
  const data = new FormData(wizardForm);
  ["customerMode","firstName","lastName","phone","email","address","jobTypeId","scheduledDate","scheduledTime","internalNotes"].forEach(key => {
    if (data.has(key)) draft[key] = data.get(key);
  });
  if (data.has("crewSize")) draft.crewSize = Number(data.get("crewSize"));
  if (draft.step===2) draft.access = data.getAll("access");
  wizardForm.querySelectorAll("[data-equipment-field]").forEach(el=>{
    const i=Number(el.dataset.index), key=el.dataset.equipmentField;
    if (!draft.equipment[i]) return;
    draft.equipment[i][key] = el.type==="checkbox" ? el.checked : el.value;
  });
}
function validateWizardStep() {
  syncWizardInputs();
  if (draft.step===0) {
    if (draft.customerMode==="existing" && !draft.customerId) return "Select an existing customer.";
    if (draft.customerMode==="new" && (!draft.firstName.trim() || !draft.phone.trim())) return "Enter the new customer's name and phone.";
    if (!draft.address.trim()) return "Enter the service address.";
  }
  if (draft.step===1 && !draft.equipment.length) return "Add at least one equipment item.";
  return "";
}
function renderWizard() {
  const renderers=[renderCustomerStep,renderEquipmentStep,renderAccessStep,renderScheduleStep,renderReviewStep];
  wizardStepLabel.textContent=`Step ${draft.step+1} of 5`;
  wizardProgress.innerHTML=Array.from({length:5},(_,i)=>`<i class="${i<=draft.step?"active":""}"></i>`).join("");
  wizardForm.innerHTML=renderers[draft.step]();
  wizardBack.style.visibility=draft.step===0?"hidden":"visible";
  wizardNext.textContent=draft.step===4?"Save Job Draft":"Continue";
  bindWizardStep();
}
function bindWizardStep() {
  wizardForm.querySelectorAll('input[name="customerMode"]').forEach(el=>el.onchange=()=>{syncWizardInputs();draft.customerMode=el.value;draft.customerId="";renderWizard();});
  wizardForm.querySelectorAll("[data-select-customer]").forEach(el=>el.onclick=()=>{draft.customerId=el.dataset.selectCustomer;renderWizard();});
  const search=wizardForm.querySelector("#customerSearch");
  if(search) search.oninput=()=>{draft.firstName=search.value;draft.lastName="";renderWizard();setTimeout(()=>wizardForm.querySelector("#customerSearch")?.focus(),0);};
  wizardForm.querySelector("#discardDraft")?.addEventListener("click",()=>{clearDraft();renderWizard();});
  wizardForm.querySelector("#addEquipment")?.addEventListener("click",()=>{syncWizardInputs();draft.equipment.push({equipmentTypeId:"EQP-OTHER",condition:"New",brand:"",model:"",quantity:1,storeAssembly:false,buildRequired:false});renderWizard();});
  wizardForm.querySelectorAll("[data-remove-equipment]").forEach(el=>el.onclick=()=>{syncWizardInputs();draft.equipment.splice(Number(el.dataset.removeEquipment),1);renderWizard();});
}
wizardNext.onclick=()=>{
  const error=validateWizardStep();
  if(error){toast(error);return;}
  if(draft.step<4){draft.step++;saveDraft(false);renderWizard();}
  else {saveDraft(false);toast("Job draft saved on this device.");closeWizard();}
};
wizardBack.onclick=()=>{syncWizardInputs();draft.step=Math.max(0,draft.step-1);saveDraft(false);renderWizard();};
document.querySelector("#closeWizard").onclick=()=>{saveDraft(false);closeWizard();};
document.querySelector("#saveDraftTop").onclick=()=>saveDraft(true);
wizardBackdrop.onclick=()=>{saveDraft(false);closeWizard();};


document.querySelector("#closeDrawer").onclick = closeJob;
drawerBackdrop.onclick = closeJob;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(console.error));
}

go(location.hash.slice(1) || "today");
loadLiveData();
