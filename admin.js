// ─────────────────────────────────────────────────────────────────────────────
// CTU Danao Borrowing System — admin.js (redesigned)
// ─────────────────────────────────────────────────────────────────────────────

const scriptURL = "https://script.google.com/macros/s/AKfycbwLMk4IPiNUv04cZNjEw1pjeLkvTcWHi8mgTVwuNzeZVHBVzsSfO4Hli9PI-uQ7P0KuUQ/exec";

// ─────────────────────────────────────────────────────────────────────────────
// CTU Danao Borrowing System — admin.js (redesigned)
// ─────────────────────────────────────────────────────────────────────────────

// Uses Intl API — always correct regardless of the browser's local timezone.
function getPHTDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  // "en-CA" locale gives yyyy-mm-dd format natively
}

function getPHTTimeString(opts = {}) {
  return new Date().toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    ...opts
  });
}

// ── Admin password (SHA-256) ─────────────────────────────────────────────────
// Default: ctu@danao2025
const ADMIN_PASSWORD_HASH = "48d2a5bbcf422ccd1b69e2a82fb90bafb52384953e77e304bef856084be052b6";

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ── Session timeout (15 min) ─────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
let sessionTimer = null;

function resetSessionTimer() {
  clearTimeout(sessionTimer);
  window._sessionResetAt = Date.now();
  sessionTimer = setTimeout(() => {
    if (document.getElementById("appShell").style.display !== "none") {
      logoutAdmin(true);
    }
  }, SESSION_TIMEOUT_MS);
}
["click", "keydown", "mousemove", "touchstart"].forEach(evt =>
  document.addEventListener(evt, resetSessionTimer, { passive: true })
);

// ── Auto-refresh ─────────────────────────────────────────────────────────────
let autoRefreshInterval = null;
const AUTO_REFRESH_MS   = 30 * 1000;

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshInterval = setInterval(() => {
    loadPendingRequests();
    loadReturnRequests();
    updateKpiCards();
  }, AUTO_REFRESH_MS);
}
function stopAutoRefresh() {
  if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
}

// ── State ────────────────────────────────────────────────────────────────────
let allTransactions  = [];
let allUsers         = [];
let allPending       = [];
let allReturnRequests = [];
let selectedReturns   = new Set();
let filteredTx       = [];
let searchTimeout;
let qrInstance       = null;
let studentPenalties = {};

// ── Toast notification ───────────────────────────────────────────────────────
let _toastTimer = null;
function showNotification(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  // Clear any existing timer so rapid calls don't overlap
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  toast.innerText      = message;
  toast.className      = type;
  toast.style.display  = "block";
  toast.style.opacity  = "1";
  toast.style.top      = "20px";

  // Auto-dismiss after 3.5s
  _toastTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.top     = "-80px";
    setTimeout(() => { toast.style.display = "none"; toast.style.opacity = "1"; }, 500);
  }, 3500);
}

// ── Login ────────────────────────────────────────────────────────────────────
async function checkPassword() {
  const entered = document.getElementById("adminPassword").value;
  const hashed  = await hashPassword(entered);
  if (hashed === ADMIN_PASSWORD_HASH) {
    document.getElementById("loginScreen").style.display  = "none";
    document.getElementById("appShell").style.display     = "flex";
    showNotification("Admin access granted", "success");
    resetSessionTimer();
    startAutoRefresh();
    refreshAll();
  } else {
    showNotification("Incorrect password", "error");
    document.getElementById("adminPassword").value = "";
    document.getElementById("adminPassword").focus();
  }
}

function logoutAdmin(timedOut = false) {
  stopAutoRefresh();
  clearTimeout(sessionTimer);
  document.getElementById("appShell").style.display    = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("adminPassword").value = "";
  showNotification(timedOut ? "Session expired — please log in again." : "Logged out", timedOut ? "error" : "info");
}

// ── Refresh all data ─────────────────────────────────────────────────────────
function refreshAll() {
  loadPendingRequests();
  loadReturnRequests();
  loadTransactions();
  loadItemsTable();
  loadQrStudentList();
  updateSyncTime();
}

function updateSyncTime() {
  const el = document.getElementById("syncTime");
  if (el) {
    el.textContent = new Date().toLocaleTimeString("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit", minute: "2-digit"
    });
  }
}

// Tick the sidebar clock every second so it stays live
setInterval(updateSyncTime, 1000);

// ── Page navigation (sidebar) ────────────────────────────────────────────────
const pageMeta = {
  pageDashboard:    { title: "Dashboard",          desc: "Overview of borrowing activity" },
  pagePending:      { title: "Pending Borrows",    desc: "Review and hand over requested items" },
  pageReturns:      { title: "Pending Returns",    desc: "Confirm returned items" },
  pageTransactions: { title: "Transaction Log",    desc: "Full history of all borrow events" },
  pageItems:        { title: "Inventory",          desc: "Manage available equipment and quantities" },
  pageStudents:     { title: "Students",           desc: "Register, edit, and manage borrowers" },
  pageAnalytics:    { title: "Analytics",          desc: "Visual overview of borrowing activity" }
};

function switchPage(pageId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  const page = document.getElementById(pageId);
  if (page) page.classList.add("active");

  const navBtn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (navBtn) navBtn.classList.add("active");

  const meta = pageMeta[pageId] || {};
  document.getElementById("topbarTitle").textContent = meta.title || "";
  document.getElementById("topbarDesc").textContent  = meta.desc  || "";

  // Load data when switching to specific pages
  if (pageId === "pagePending")      loadPendingRequests();
  if (pageId === "pageReturns")      loadReturnRequests();
  if (pageId === "pageTransactions") renderTransactions(allTransactions);
  if (pageId === "pageAnalytics")    loadCharts();
  if (pageId === "pageDashboard")    renderDashboard();
  if (pageId === "pageStudents")     loadStudentsPage();

  // Close sidebar on mobile
  if (window.innerWidth <= 700) {
    closeSidebar();
  }
}

function toggleSidebar() {
  const sidebar   = document.getElementById("sidebar");
  const backdrop  = document.getElementById("sidebarBackdrop");
  const isOpen    = sidebar.classList.toggle("open");
  if (backdrop) backdrop.classList.toggle("visible", isOpen);
  // Prevent body scroll while drawer is open on mobile
  document.body.style.overflow = isOpen ? "hidden" : "";
}

function closeSidebar() {
  const sidebar  = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  sidebar.classList.remove("open");
  if (backdrop) backdrop.classList.remove("visible");
  document.body.style.overflow = "";
}

// ── Students Page ────────────────────────────────────────────────────────────
function loadStudentsPage() {
  // Load users if not already loaded
  if (allUsers.length === 0) {
    fetch(scriptURL + "?action=getUsers").then(r => r.json()).then(u => {
      allUsers = Array.isArray(u) ? u : [];
      renderStudentsTable(allUsers);
      const scb = document.getElementById("studentCountBadge");
      if (scb) scb.textContent = `${allUsers.length} student${allUsers.length !== 1 ? "s" : ""}`;
    }).catch(() => showNotification("Error loading students.", "error"));
  } else {
    renderStudentsTable(allUsers);
  }
}

// ── KPI cards ────────────────────────────────────────────────────────────────
function updateKpiCards() {
  const todayStr = getPHTDateString();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);

  const overdue  = allTransactions.filter(tx => tx.status === "Overdue").length;
  const borrowed = allTransactions.filter(tx => tx.status === "Borrowed").length;
  const pending  = allPending.length;

  const kpiStudents = document.getElementById("kpiStudents");
  const kpiPending  = document.getElementById("kpiPending");
  const kpiBorrowed = document.getElementById("kpiBorrowed");
  const kpiOverdue  = document.getElementById("kpiOverdue");

  if (kpiPending)  kpiPending.textContent  = pending;
  if (kpiBorrowed) kpiBorrowed.textContent = borrowed;
  if (kpiOverdue)  kpiOverdue.textContent  = overdue;

  // Students count requires separate fetch or uses loaded allUsers
  if (allUsers.length > 0 && kpiStudents) {
    kpiStudents.textContent = allUsers.length;
  } else {
    fetch(scriptURL + "?action=getUsers").then(r => r.json()).then(u => {
      allUsers = Array.isArray(u) ? u : [];
      if (kpiStudents) kpiStudents.textContent = allUsers.length;
      renderStudentsTable(allUsers);
      const scb = document.getElementById("studentCountBadge");
      if (scb) scb.textContent = `${allUsers.length} student${allUsers.length !== 1 ? "s" : ""}`;
    }).catch(() => {});
  }

  // Update nav badges
  updateNavBadge("navBadgePending", pending);
  updateNavBadge("navBadgeReturns", allReturnRequests.length);
}

function updateNavBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent  = count;
    el.style.display = "inline-flex";
  } else {
    el.style.display = "none";
  }
}

// ── Dashboard render ─────────────────────────────────────────────────────────
function renderDashboard() {
  renderDashPending();
  renderDashOverdue();
  renderDashRecent();
  renderActiveBorrowers();
  updateKpiCards();
}

let abFilter = "all";

function setAbFilter(filter, btn) {
  abFilter = filter;
  document.querySelectorAll(".ab-filter-btn").forEach(b => {
    b.classList.remove("active","danger","warn");
  });
  if (btn) {
    btn.classList.add("active");
    if (filter === "Overdue") btn.classList.add("danger");
    if (filter === "Return Pending") btn.classList.add("warn");
  }
  renderActiveBorrowers();
}

function renderActiveBorrowers() {
  const grid = document.getElementById("activeBorrowersGrid");
  const countBadge = document.getElementById("activeBorrowersCount");
  if (!grid) return;

  const todayStr = getPHTDateString();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);

  // Active = Borrowed, Overdue, Return Pending
  const activeStatuses = ["Borrowed", "Overdue", "Return Pending"];
  let active = allTransactions.filter(tx => activeStatuses.includes(tx.status));

  // Apply filter
  if (abFilter !== "all") {
    active = active.filter(tx => tx.status === abFilter);
  }

  // Update count badge
  const totalActive = allTransactions.filter(tx => activeStatuses.includes(tx.status)).length;
  if (countBadge) {
    countBadge.textContent = `${totalActive} active`;
    countBadge.style.display = totalActive > 0 ? "inline-block" : "none";
  }

  grid.innerHTML = "";

  if (active.length === 0) {
    grid.innerHTML = `
      <div class="ab-empty" style="grid-column:1/-1;">
        <span class="empty-icon">${abFilter === "all" ? "🎉" : "🔍"}</span>
        ${abFilter === "all"
          ? "No active borrowers right now."
          : `No <strong>${abFilter}</strong> borrowers right now.`}
      </div>`;
    return;
  }

  // Sort: Overdue first, then Return Pending, then Borrowed; within each group by due date asc
  const order = { "Overdue": 0, "Return Pending": 1, "Borrowed": 2 };
  active.sort((a, b) => {
    const so = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (so !== 0) return so;
    return (a.dueDate || "").localeCompare(b.dueDate || "");
  });

  active.forEach(tx => {
    let daysLabel = "";
    let daysCls   = "ab-days-ok";
    let cardCls   = "";
    let dueCls    = "";

    if (tx.dueDate) {
      const p   = tx.dueDate.split("-");
      const due = new Date(+p[0], +p[1] - 1, +p[2]);
      const diff = Math.round((due - today) / 86400000); // positive = days left, negative = overdue

      if (tx.status === "Overdue") {
        const over = Math.abs(diff);
        daysLabel = `${over}d overdue`;
        daysCls   = "ab-days-overdue";
        cardCls   = "ab-overdue";
        dueCls    = "overdue";
      } else if (tx.status === "Return Pending") {
        daysLabel = "Return pending";
        daysCls   = "ab-days-retpend";
        cardCls   = "ab-return-pending";
        dueCls    = diff < 0 ? "overdue" : diff <= 2 ? "due-soon" : "";
      } else if (diff <= 0) {
        daysLabel = "Due today";
        daysCls   = "ab-days-soon";
        cardCls   = "ab-due-soon";
        dueCls    = "due-soon";
      } else if (diff <= 2) {
        daysLabel = `${diff}d left`;
        daysCls   = "ab-days-soon";
        cardCls   = "ab-due-soon";
        dueCls    = "due-soon";
      } else {
        daysLabel = `${diff}d left`;
        daysCls   = "ab-days-ok";
        dueCls    = "";
      }
    }

    const card = document.createElement("div");
    card.className = `ab-card ${cardCls}`;
    const penalties = studentPenalties[tx.studentId] || 0;
    const penaltyHtml = penalties > 0 ? `<span style="font-size:10px;background:rgba(255,107,107,0.2);color:#ff6b6b;padding:2px 6px;border-radius:4px;font-weight:700;">⚠️ ${penalties} late return${penalties !== 1 ? 's' : ''}</span>` : "";
    card.innerHTML = `
      <div class="ab-top">
        <div class="ab-student">
          <div class="ab-name">${tx.studentName || "—"}</div>
          <div class="ab-id">${tx.studentId}</div>
        </div>
        ${statusPill(tx.status)}
      </div>
      ${penaltyHtml}
      <div class="ab-item">
        <span class="ab-item-icon">📦</span>
        <span>${tx.item}</span>
      </div>
      <div class="ab-dates">
        <div class="ab-dates-left">
          <div class="ab-date-row">
            <span class="ab-date-label">Borrowed</span>
            <span class="ab-date-val">${tx.borrowDate || "—"}</span>
          </div>
          <div class="ab-date-row">
            <span class="ab-date-label">Due</span>
            <span class="ab-date-val ${dueCls}">${tx.dueDate || "—"}</span>
          </div>
        </div>
        ${daysLabel ? `<span class="ab-days-badge ${daysCls}">${daysLabel}</span>` : ""}
      </div>`;
    grid.appendChild(card);
  });
}

function renderDashPending() {
  const tbody = document.getElementById("dashPendingBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!allPending || allPending.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty"><span class="empty-icon">✅</span>No pending requests</td></tr>`;
    return;
  }
  allPending.slice(0, 8).forEach((req, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${req.studentId}</span> <span style="font-size:12px;">${req.studentName || ""}</span></td>
      <td style="font-weight:600;">${req.item}</td>
      <td><span class="date-chip">${req.dueDate || "—"}</span></td>
      <td>
        <button class="btn btn-success btn-sm" onclick="confirmHandover(${i})">Hand Over</button>
      </td>`;
    tbody.appendChild(row);
  });
}

function renderDashOverdue() {
  const tbody = document.getElementById("dashOverdueBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const todayStr = getPHTDateString();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);
  const overdueItems = allTransactions.filter(tx => tx.status === "Overdue");
  if (overdueItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty"><span class="empty-icon">🎉</span>No overdue items</td></tr>`;
    return;
  }
  overdueItems.forEach(tx => {
    const p    = tx.dueDate.split("-");
    const due  = new Date(+p[0], +p[1] - 1, +p[2]);
    const days = Math.floor((today - due) / 86400000);
    const row  = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span> <span style="font-size:12px;">${tx.studentName || ""}</span></td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="date-chip overdue">${tx.dueDate}</span></td>
      <td><span class="status-pill s-overdue">${days}d overdue</span></td>`;
    tbody.appendChild(row);
  });
}

function renderDashRecent() {
  const tbody = document.getElementById("dashRecentBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const recent = [...allTransactions].reverse().slice(0, 10);
  if (recent.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No transactions yet.</td></tr>`;
    return;
  }
  recent.forEach(tx => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td>${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate}</span></td>
      <td>${statusPill(tx.status)}</td>`;
    tbody.appendChild(row);
  });
}

function statusPill(status) {
  const map = {
    "Borrowed":       "s-borrowed",
    "Pending":        "s-pending",
    "Returned":       "s-returned",
    "Returned (Late)": "s-returned-late",
    "Overdue":        "s-overdue",
    "Return Pending": "s-return-pending",
    "Rejected":       "s-rejected"
  };
  const cls = map[status] || "";
  return `<span class="status-pill ${cls}">${status}</span>`;
}

// ── Registration form ─────────────────────────────────────────────────────────
function setFormError(inputId, errorId, msg) {
  const input = document.getElementById(inputId);
  const err   = document.getElementById(errorId);
  if (input) { input.classList.add("invalid"); input.classList.remove("valid"); }
  if (err)   { err.textContent = msg; err.style.display = "block"; }
}
function setFormValid(inputId, errorId) {
  const input = document.getElementById(inputId);
  const err   = document.getElementById(errorId);
  if (input) { input.classList.remove("invalid"); input.classList.add("valid"); }
  if (err)   { err.style.display = "none"; }
}
function clearFormState(inputId, errorId) {
  const input = document.getElementById(inputId);
  const err   = document.getElementById(errorId);
  if (input) { input.classList.remove("invalid", "valid"); }
  if (err)   { err.style.display = "none"; }
}

document.addEventListener("DOMContentLoaded", () => {
  // Login on enter
  const pwInput = document.getElementById("adminPassword");
  if (pwInput) pwInput.addEventListener("keypress", e => { if (e.key === "Enter") { e.preventDefault(); checkPassword(); } });

  // Register form
  const adminForm = document.getElementById("adminForm");
  if (adminForm) {
    adminForm.addEventListener("submit", e => {
      e.preventDefault();
      submitRegisterForm();
    });

    // Real-time validation
    const idField = document.getElementById("adminId");
    const nameField = document.getElementById("adminName");
    const emailField = document.getElementById("adminEmail");

    if (idField) idField.addEventListener("input", () => {
      const v = idField.value.trim();
      if (!v) { clearFormState("adminId","adminIdError"); return; }
      if (!/^\d+$/.test(v)) setFormError("adminId","adminIdError","Numbers only.");
      else if (v.length < 5) setFormError("adminId","adminIdError",`${v.length}/5 digits minimum.`);
      else if (v.length > 12) setFormError("adminId","adminIdError","Max 12 digits.");
      else setFormValid("adminId","adminIdError");
    });
    if (nameField) nameField.addEventListener("input", () => {
      const v = nameField.value.trim();
      if (!v) { clearFormState("adminName","adminNameError"); return; }
      if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(v)) setFormError("adminName","adminNameError","Letters only.");
      else if (v.length < 2) setFormError("adminName","adminNameError","Too short.");
      else setFormValid("adminName","adminNameError");
    });
    if (emailField) emailField.addEventListener("input", () => {
      const v = emailField.value.trim();
      if (!v) { clearFormState("adminEmail","adminEmailError"); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) setFormError("adminEmail","adminEmailError","Enter a valid email.");
      else setFormValid("adminEmail","adminEmailError");
    });
  }

  // Search inputs
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.addEventListener("input", filterTransactions);

  const qrSearch = document.getElementById("qrStudentSearch");
  if (qrSearch) qrSearch.addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    const filtered = allUsers.filter(u =>
      String(u.name).toLowerCase().includes(q) || String(u.id).toLowerCase().includes(q)
    );
    renderQrStudentList(filtered);
  });

  // Session countdown
  setInterval(() => {
    const el = document.getElementById("sessionCountdown");
    if (!el || document.getElementById("appShell").style.display === "none") return;
    const remaining = Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - (window._sessionResetAt || Date.now())));
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.textContent = `${mins}:${String(secs).padStart(2,"0")}`;
  }, 1000);
});

function submitRegisterForm() {
  const studentId = document.getElementById("adminId").value.trim();
  const name      = document.getElementById("adminName").value.trim();
  const email     = document.getElementById("adminEmail").value.trim();
  let   hasError  = false;

  if (!studentId) { setFormError("adminId","adminIdError","Student ID is required."); hasError = true; }
  else if (!/^\d+$/.test(studentId)) { setFormError("adminId","adminIdError","Numbers only."); hasError = true; }
  else if (studentId.length < 5 || studentId.length > 12) { setFormError("adminId","adminIdError","5–12 digits required."); hasError = true; }
  else setFormValid("adminId","adminIdError");

  const sName = name.replace(/\s+/g," ").trim();
  if (!sName) { setFormError("adminName","adminNameError","Name is required."); hasError = true; }
  else if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(sName)) { setFormError("adminName","adminNameError","Letters only."); hasError = true; }
  else if (sName.length < 2 || sName.length > 60) { setFormError("adminName","adminNameError","2–60 characters required."); hasError = true; }
  else setFormValid("adminName","adminNameError");

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFormError("adminEmail","adminEmailError","Invalid email."); hasError = true; }
  else if (email) setFormValid("adminEmail","adminEmailError");

  if (hasError) return;

  if (allUsers.some(u => String(u.id) === studentId)) {
    setFormError("adminId","adminIdError","This ID is already registered.");
    return;
  }

  const submitBtn = document.querySelector("#adminForm button[type=submit]");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Registering…"; }

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "register", studentId, name: sName, email })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showNotification(data.message, "success");
      document.getElementById("adminForm").reset();
      ["adminId","adminName","adminEmail"].forEach((id, i) =>
        clearFormState(id, ["adminIdError","adminNameError","adminEmailError"][i])
      );
      loadQrStudentList();
      updateKpiCards();
    } else {
      showNotification(data.message || "Registration failed.", "error");
    }
  })
  .catch(() => showNotification("Network error during registration.", "error"))
  .finally(() => {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Register Student"; }
  });
}

// ── Pending borrow requests ──────────────────────────────────────────────────
function loadPendingRequests() {
  const tbody = document.getElementById("pendingTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getPendingRequests")
    .then(r => r.json())
    .then(data => {
      allPending = Array.isArray(data) ? data : [];
      renderPendingTable(allPending);
      renderDashPending();
      updateKpiCards();
    })
    .catch(() => {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--danger);">Error loading requests.</td></tr>`;
    });
}

function renderPendingTable(requests) {
  const tbody = document.getElementById("pendingTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><span class="empty-icon">✅</span>No pending requests — all handled.</td></tr>`;
    return;
  }

  requests.forEach((req, index) => {
    let durationText = "—";
    if (req.borrowDate && req.dueDate) {
      const b = req.borrowDate.split("-");
      const d = req.dueDate.split("-");
      const days = Math.round((new Date(+d[0], +d[1]-1, +d[2]) - new Date(+b[0], +b[1]-1, +b[2])) / 86400000);
      if (!isNaN(days) && days > 0) durationText = `${days} day${days !== 1 ? "s" : ""}`;
    }
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${req.studentId}</span></td>
      <td style="font-weight:600;">${req.studentName || "—"}</td>
      <td style="font-weight:600;">${req.item}</td>
      <td><span class="date-chip">${req.borrowDate || "—"}</span></td>
      <td style="font-size:12px;color:var(--text3);">${durationText}</td>
      <td><span class="date-chip" style="color:var(--warning);">${req.dueDate || "—"}</span></td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" onclick="confirmHandover(${index})">✅ Hand Over</button>
          <button class="btn btn-danger  btn-sm" onclick="confirmReject(${index})">✗ Reject</button>
        </div>
      </td>`;
    tbody.appendChild(row);
  });
}

function confirmHandover(index) {
  const req = allPending[index];
  if (!req) return;
  document.getElementById("handoverMessage").innerHTML =
    `Hand over <strong>${req.item}</strong> to <strong>${req.studentName || req.studentId}</strong>?<br>
     <small style="color:var(--text3);">Status → <em>Borrowed</em>, stock −1</small>`;
  const modal = document.getElementById("handoverModal");
  modal.classList.add("open");
  document.getElementById("handoverYes").onclick = () => { modal.classList.remove("open"); executeHandover(req); };
  document.getElementById("handoverNo").onclick  = () => { modal.classList.remove("open"); };
}

function executeHandover(req) {
  showNotification("Processing hand-over…", "info");
  const btns = document.querySelectorAll(".handover-btn, #pendingTableBody .btn-success, #dashPendingBody .btn-success");
  btns.forEach(b => { b.disabled = true; b.textContent = "Processing…"; });

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "confirmBorrow", studentId: req.studentId, item: req.item, rowIndex: req.rowIndex })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showNotification(`✅ "${req.item}" handed over to ${req.studentName || req.studentId}`, "success");
      loadPendingRequests();
      loadTransactions();
      loadItemsTable();
    } else {
      showNotification(`❌ ${data.message || "Hand-over failed. Please try again."}`, "error");
      btns.forEach(b => { b.disabled = false; b.textContent = "✅ Hand Over"; });
      loadPendingRequests();
    }
  })
  .catch(() => {
    showNotification("❌ Network error during hand-over. Please try again.", "error");
    btns.forEach(b => { b.disabled = false; b.textContent = "✅ Hand Over"; });
    loadPendingRequests();
  });
}

function confirmReject(index) {
  const req = allPending[index];
  if (!req) return;
  document.getElementById("rejectMessage").innerHTML =
    `Reject the request for <strong>${req.item}</strong> from <strong>${req.studentName || req.studentId}</strong>?<br>
     <small style="color:var(--text3);">No stock change will occur.</small>`;
  const modal = document.getElementById("rejectModal");
  modal.classList.add("open");
  document.getElementById("rejectYes").onclick = () => { modal.classList.remove("open"); executeReject(req); };
  document.getElementById("rejectNo").onclick  = () => { modal.classList.remove("open"); };
}

function executeReject(req) {
  showNotification("Rejecting request…", "info");
  const btn = document.getElementById("rejectYes");
  if (btn) { btn.disabled = true; btn.textContent = "Rejecting…"; }

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "rejectBorrow", studentId: req.studentId, item: req.item, rowIndex: req.rowIndex })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showNotification(`Request for "${req.item}" rejected.`, "info");
      loadPendingRequests();
      loadTransactions();
    } else {
      showNotification(data.message || "Rejection failed.", "error");
    }
  })
  .catch(() => showNotification("Network error during rejection.", "error"))
  .finally(() => { if (btn) { btn.disabled = false; btn.textContent = "Yes, Reject"; } });
}

// ── Pending return requests ──────────────────────────────────────────────────
function loadReturnRequests() {
  const tbody = document.getElementById("returnsTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getReturnRequests")
    .then(r => r.json())
    .then(data => {
      allReturnRequests = Array.isArray(data) ? data : [];
      renderReturnsTable(allReturnRequests);
      updateNavBadge("navBadgeReturns", allReturnRequests.length);
    })
    .catch(() => {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty" style="color:var(--danger);">Error loading return requests.</td></tr>`;
    });
}

function renderReturnsTable(requests) {
  const tbody = document.getElementById("returnsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty"><span class="empty-icon">✅</span>No pending return requests.</td></tr>`;
    return;
  }

  requests.forEach((req, index) => {
    const today = getPHTDateString();
    const isOverdue = req.dueDate && req.dueDate < today;
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" class="return-checkbox" data-index="${index}" onchange="updateReturnSelection()"></td>
      <td><span class="mono-chip">${req.studentId}</span></td>
      <td style="font-weight:600;">${req.studentName || "—"}</td>
      <td style="font-weight:600;">${req.item}</td>
      <td><span class="date-chip">${req.borrowDate || "—"}</span></td>
      <td><span class="date-chip" style="color:${isOverdue ? 'var(--danger)' : 'var(--warning)'};">${req.dueDate || "—"}${isOverdue ? ' ⚠️' : ''}</span></td>
      <td><span class="date-chip" style="color:var(--success);">${req.returnDate || today}</span></td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="confirmReturnRequest(${index})">✅ Confirm Return</button>
      </td>`;
    tbody.appendChild(row);
  });
  
  selectedReturns.clear();
  document.getElementById("selectAllReturns").checked = false;
  document.getElementById("bulkConfirmBtn").style.display = "none";
}

function confirmReturnRequest(index) {
  const req = allReturnRequests[index];
  if (!req) return;
  const today = getPHTDateString();
  document.getElementById("adminReturnMessage").innerHTML =
    `Confirm return of <strong>${req.item}</strong> from <strong>${req.studentName || req.studentId}</strong>?<br>
     <small style="color:var(--text3);">Return date: <strong>${today}</strong> · Stock +1</small>`;
  document.getElementById("returnCondition").value = "Good";
  const modal = document.getElementById("adminReturnModal");
  modal.classList.add("open");
  document.getElementById("adminReturnYes").onclick = () => { 
    modal.classList.remove("open"); 
    const condition = document.getElementById("returnCondition").value;
    executeConfirmReturn(req, today, condition); 
  };
  document.getElementById("adminReturnNo").onclick  = () => { modal.classList.remove("open"); };
}

function executeConfirmReturn(req, returnDate, condition = "Good") {
  showNotification("Confirming return…", "info");
  
  // Check if return is late and add penalty
  let isLate = false;
  if (req.dueDate && returnDate > req.dueDate) {
    isLate = true;
    if (!studentPenalties[req.studentId]) studentPenalties[req.studentId] = 0;
    studentPenalties[req.studentId]++;
  }
  
  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ 
      action: "confirmReturn", 
      studentId: req.studentId, 
      item: req.item, 
      returnDate, 
      rowIndex: req.rowIndex,
      condition: condition,
      isLate: isLate
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      const conditionIcon = condition === "Good" ? "✅" : condition === "Damaged" ? "⚠️" : "❌";
      const lateText = isLate ? " [LATE]" : "";
      showNotification(`${conditionIcon} "${req.item}" return confirmed${lateText}.`, "success");
      loadReturnRequests();
      loadTransactions();
      loadItemsTable();
      renderActiveBorrowers();
    } else {
      showNotification(data.message || "Confirmation failed.", "error");
    }
  })
  .catch(() => showNotification("Network error during return confirmation.", "error"));
}

// ── Bulk Return Confirmation ────────────────────────────────────────────────
function updateReturnSelection() {
  selectedReturns.clear();
  document.querySelectorAll(".return-checkbox:checked").forEach(cb => {
    selectedReturns.add(parseInt(cb.dataset.index));
  });
  const bulkBtn = document.getElementById("bulkConfirmBtn");
  if (selectedReturns.size > 0) {
    bulkBtn.style.display = "block";
    bulkBtn.textContent = `✅ Confirm Selected (${selectedReturns.size})`;
  } else {
    bulkBtn.style.display = "none";
  }
}

function toggleSelectAllReturns() {
  const isChecked = document.getElementById("selectAllReturns").checked;
  document.querySelectorAll(".return-checkbox").forEach(cb => {
    cb.checked = isChecked;
  });
  updateReturnSelection();
}

function bulkConfirmReturns() {
  if (selectedReturns.size === 0) {
    showNotification("No items selected.", "error");
    return;
  }
  
  const today = getPHTDateString();
  const condition = document.getElementById("returnCondition")?.value || "Good";
  const itemsToConfirm = Array.from(selectedReturns).map(idx => allReturnRequests[idx]);
  
  let confirmed = 0;
  showNotification(`Confirming ${itemsToConfirm.length} items…`, "info");
  
  Promise.all(itemsToConfirm.map(req => {
    const isLate = req.dueDate && today > req.dueDate;
    if (isLate && !studentPenalties[req.studentId]) studentPenalties[req.studentId] = 0;
    if (isLate) studentPenalties[req.studentId]++;
    
    return fetch(scriptURL, {
      method: "POST",
      body: JSON.stringify({ 
        action: "confirmReturn", 
        studentId: req.studentId, 
        item: req.item, 
        returnDate: today, 
        rowIndex: req.rowIndex,
        condition: condition,
        isLate: isLate
      })
    }).then(r => r.json()).then(data => { if (data.success) confirmed++; });
  })).then(() => {
    showNotification(`✅ ${confirmed}/${itemsToConfirm.length} items confirmed.`, "success");
    loadReturnRequests();
    loadTransactions();
    loadItemsTable();
    renderActiveBorrowers();
  }).catch(() => showNotification("Error during bulk confirmation.", "error"));
}

// ── Transactions ─────────────────────────────────────────────────────────────
function loadTransactions() {
  fetch(scriptURL + "?action=getAllHistory")
    .then(r => r.json())
    .then(history => {
      const todayStr = getPHTDateString();
      const [ty, tm, td] = todayStr.split("-").map(Number);
      const today = new Date(ty, tm - 1, td);
      allTransactions = (Array.isArray(history) ? history : []).map(tx => {
        if (tx.status === "Borrowed" && tx.dueDate) {
          const p = tx.dueDate.split("-");
          if (new Date(+p[0], +p[1]-1, +p[2]) < today) return { ...tx, status: "Overdue" };
        }
        // Check if returned late (returnDate > dueDate)
        if (tx.status === "Returned" && tx.returnDate && tx.dueDate) {
          const rp = tx.returnDate.split("-");
          const dp = tx.dueDate.split("-");
          const returnDate = new Date(+rp[0], +rp[1]-1, +rp[2]);
          const dueDate = new Date(+dp[0], +dp[1]-1, +dp[2]);
          if (returnDate > dueDate) return { ...tx, status: "Returned (Late)", isLate: true };
        }
        return tx;
      });
      filteredTx = allTransactions;
      renderTransactions(allTransactions);
      updateKpiCards();
      renderDashboard();
    })
    .catch(() => showNotification("Error loading transactions.", "error"));
}

function renderTransactions(transactions) {
  const tbody = document.querySelector("#transactionsTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!transactions || transactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No transactions found.</td></tr>`;
    return;
  }
  transactions.forEach(tx => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td>${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate}</span></td>
      <td><span class="date-chip ${tx.returnDate ? "" : ""}">${tx.returnDate || "—"}</span></td>
      <td>${statusPill(tx.status)}</td>`;
    tbody.appendChild(row);
  });
}

function filterTransactions() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query  = (document.getElementById("searchInput")?.value || "").toLowerCase();
    const status = document.getElementById("statusFilter")?.value || "";
    const filtered = allTransactions.filter(tx =>
      (!query  || String(tx.studentId).toLowerCase().includes(query) ||
                  String(tx.item).toLowerCase().includes(query) ||
                  String(tx.studentName || "").toLowerCase().includes(query)) &&
      (!status || tx.status === status)
    );
    renderTransactions(filtered);
  }, 300);
}

function resetFilter() {
  const si = document.getElementById("searchInput");
  const sf = document.getElementById("statusFilter");
  if (si) si.value = "";
  if (sf) sf.value = "";
  renderTransactions(allTransactions);
}

function exportTransactionsCSV() {
  if (!allTransactions || allTransactions.length === 0) {
    showNotification("No transactions to export.", "error");
    return;
  }
  const headers = ["Student ID","Name","Item","Borrow Date","Due Date","Return Date","Status","Late Return"];
  const rows = allTransactions.map(tx =>
    [tx.studentId, tx.studentName || "", tx.item, tx.borrowDate, tx.dueDate, tx.returnDate || "", tx.status, tx.isLate ? "Yes" : "No"]
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(",")
  );
  const csv  = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `CTU_Transactions_${getPHTDateString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotification("CSV exported.", "success");
}

// ── Inventory ────────────────────────────────────────────────────────────────
function loadItemsTable() {
  const tbody = document.getElementById("itemsTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="table-empty">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getItems")
    .then(r => r.json())
    .then(items => {
      if (!tbody) return;
      tbody.innerHTML = "";
      if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="table-empty">No items yet — add one.</td></tr>`;
        return;
      }
      items.forEach(it => {
        const tagCls = it.quantity === 0 ? "s-overdue" : it.quantity <= 2 ? "s-pending" : "s-returned";
        const tagLbl = it.quantity === 0 ? "Out of Stock" : it.quantity <= 2 ? "Low Stock" : "In Stock";
        const row = document.createElement("tr");
        row.innerHTML = `
          <td style="font-weight:600;">${it.name}</td>
          <td>
            <div class="qty-control">
              <button class="qty-btn" onclick="adjustQty('${it.name}',${it.quantity},-1)">−</button>
              <span class="qty-val">${it.quantity}</span>
              <button class="qty-btn" onclick="adjustQty('${it.name}',${it.quantity},1)">+</button>
            </div>
          </td>
          <td><span class="status-pill ${tagCls}">${tagLbl}</span></td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="deleteItem('${it.name}',${it.quantity})">🗑</button>
          </td>`;
        tbody.appendChild(row);
      });
    })
    .catch(() => {
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="table-empty" style="color:var(--danger);">Error loading items.</td></tr>`;
    });
}

function addItem() {
  const name = document.getElementById("newItemName").value.trim();
  const qty  = parseInt(document.getElementById("newItemQty").value);
  if (!name)                { showNotification("Item name is required.", "error"); return; }
  if (isNaN(qty) || qty < 0) { showNotification("Enter a valid quantity.", "error"); return; }

  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "addItem", name, quantity: qty }) })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showNotification(`"${name}" added.`, "success");
        document.getElementById("newItemName").value = "";
        document.getElementById("newItemQty").value  = "";
        loadItemsTable();
      } else {
        showNotification(data.message || "Failed to add item.", "error");
      }
    })
    .catch(() => showNotification("Error adding item.", "error"));
}

function adjustQty(name, currentQty, delta) {
  // Re-fetch live items first to avoid stale-closure overwrite (e.g. after
  // a borrow confirmation already deducted stock in the Sheet).
  fetch(scriptURL + "?action=getItems")
    .then(r => r.json())
    .then(items => {
      const live = items.find(it => it.name.toLowerCase() === name.toLowerCase());
      const liveQty = live ? Number(live.quantity) : currentQty;
      const newQty  = liveQty + delta;
      if (newQty < 0) { showNotification("Quantity cannot go below 0.", "error"); return; }
      return fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({ action: "updateItemQty", name, quantity: newQty })
      });
    })
    .then(r => r && r.json())
    .then(data => {
      if (!data) return;
      if (data.success) loadItemsTable();
      else showNotification(data.message || "Failed to update.", "error");
    })
    .catch(() => showNotification("Error updating quantity.", "error"));
}

function deleteItem(name, quantity) {
  if (quantity > 0) { showNotification(`Set quantity to 0 first to delete "${name}".`, "error"); return; }
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "deleteItem", name }) })
    .then(r => r.json())
    .then(data => {
      if (data.success) { showNotification(`"${name}" deleted.`, "success"); loadItemsTable(); }
      else showNotification(data.message || "Failed to delete.", "error");
    })
    .catch(() => showNotification("Error deleting item.", "error"));
}

// ── Students (QR + table) ────────────────────────────────────────────────────
function loadQrStudentList() {
  fetch(scriptURL + "?action=getUsers")
    .then(r => r.json())
    .then(users => {
      allUsers = Array.isArray(users) ? users : [];
      renderQrStudentList(allUsers);
      renderStudentsTable(allUsers);
      const el = document.getElementById("studentCountBadge");
      if (el) el.textContent = `${allUsers.length} student${allUsers.length !== 1 ? "s" : ""}`;
      const kpi = document.getElementById("kpiStudents");
      if (kpi) kpi.textContent = allUsers.length;
    })
    .catch(() => {
      const el = document.getElementById("qrStudentList");
      if (el) el.innerHTML = `<div style="text-align:center;padding:16px;color:var(--danger);font-size:12px;">Error loading students.</div>`;
    });
}

function renderQrStudentList(users) {
  const container = document.getElementById("qrStudentList");
  if (!container) return;
  container.innerHTML = "";
  if (!users || users.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text3);font-size:12px;">No students found.</div>`;
    return;
  }
  users.forEach(u => {
    const row = document.createElement("div");
    row.className = "student-row";
    row.innerHTML = `
      <div class="student-info">
        <span class="student-name">${u.name}</span>
        <span class="student-id">${u.id}</span>
      </div>
      <div class="student-btns">
        <button class="btn btn-ghost btn-sm" onclick="showQrModal('${u.id}','${u.name.replace(/'/g,"\\'")}')">QR</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditStudentModal('${u.id}','${u.name.replace(/'/g,"\\'")}','${(u.email||"").replace(/'/g,"\\'")}')">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteStudent('${u.id}','${u.name.replace(/'/g,"\\'")}')">🗑</button>
      </div>`;
    container.appendChild(row);
  });
}

function renderStudentsTable(users) {
  const tbody = document.getElementById("studentsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No students registered.</td></tr>`;
    return;
  }
  users.forEach(u => {
    // Calculate borrowing stats for this student
    const studentTx = allTransactions.filter(tx => tx.studentId === u.id);
    const totalBorrows = studentTx.length;
    const currentItems = studentTx.filter(tx => ["Borrowed", "Overdue", "Return Pending"].includes(tx.status)).length;
    const lateReturns = studentTx.filter(tx => tx.status === "Returned (Late)").length;
    
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${u.id}</span></td>
      <td style="font-weight:600;">${u.name}</td>
      <td style="text-align:center;font-family:var(--mono);">${totalBorrows}</td>
      <td style="text-align:center;font-family:var(--mono);">${currentItems}</td>
      <td style="text-align:center;font-family:var(--mono);${lateReturns > 0 ? 'color:var(--danger);font-weight:600;' : ''}">${lateReturns}</td>
      <td>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-primary btn-sm" onclick="showStudentHistory('${u.id}','${u.name.replace(/'/g,"\\'")}')">📋 History</button>
          <button class="btn btn-ghost btn-sm" onclick="showQrModal('${u.id}','${u.name.replace(/'/g,"\\'")}')">QR</button>
          <button class="btn btn-ghost btn-sm" onclick="openEditStudentModal('${u.id}','${u.name.replace(/'/g,"\\'")}','${(u.email||"").replace(/'/g,"\\'")}')">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteStudent('${u.id}','${u.name.replace(/'/g,"\\'")}')">🗑</button>
        </div>
      </td>`;
    tbody.appendChild(row);
  });
}

function filterStudentTable() {
  const q = (document.getElementById("studentTableSearch")?.value || "").toLowerCase();
  const filtered = allUsers.filter(u =>
    String(u.name).toLowerCase().includes(q) || String(u.id).toLowerCase().includes(q)
  );
  renderStudentsTable(filtered);
}

// ── Student History ──────────────────────────────────────────────────────────
function showStudentHistory(studentId, studentName) {
  document.getElementById("studentHistoryTitle").innerText = `${studentName} (${studentId})`;
  document.getElementById("historyFilter").value = "all";
  document.getElementById("historySearch").value = "";
  renderStudentHistory(studentId);
  document.getElementById("studentHistoryModal").classList.add("open");
}

function renderStudentHistory(studentId) {
  const tbody = document.getElementById("studentHistoryBody");
  if (!tbody) return;
  
  const studentTx = allTransactions.filter(tx => tx.studentId === studentId);
  if (!studentTx || studentTx.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No borrowing history found.</td></tr>`;
    return;
  }
  
  // Sort by borrow date descending (most recent first)
  studentTx.sort((a, b) => b.borrowDate.localeCompare(a.borrowDate));
  
  tbody.innerHTML = "";
  studentTx.forEach(tx => {
    const row = document.createElement("tr");
    const isLate = tx.status === "Returned (Late)";
    const conditionIcon = tx.condition ? 
      (tx.condition === "Good" ? "✅" : tx.condition === "Damaged" ? "⚠️" : tx.condition === "Broken" ? "❌" : "🔴") : "—";
    
    row.innerHTML = `
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate || "—"}</span></td>
      <td><span class="date-chip">${tx.returnDate || "—"}</span></td>
      <td>${statusPill(tx.status)}</td>
      <td style="text-align:center;">${conditionIcon}</td>`;
    tbody.appendChild(row);
  });
}

function filterStudentHistory() {
  const filter = document.getElementById("historyFilter").value;
  const search = (document.getElementById("historySearch").value || "").toLowerCase();
  const tbody = document.getElementById("studentHistoryBody");
  const rows = tbody.querySelectorAll("tr");
  
  rows.forEach(row => {
    if (row.cells.length < 6) return; // Skip empty rows
    
    const item = row.cells[0].textContent.toLowerCase();
    const status = row.cells[4].textContent.toLowerCase();
    
    let show = true;
    
    // Apply status filter
    if (filter === "returned" && !status.includes("returned")) show = false;
    else if (filter === "late" && !status.includes("late")) show = false;
    else if (filter === "current" && (status.includes("returned") || status.includes("rejected"))) show = false;
    
    // Apply search filter
    if (search && !item.includes(search)) show = false;
    
    row.style.display = show ? "" : "none";
  });
}

// ── QR Code ──────────────────────────────────────────────────────────────────
function showQrModal(studentId, studentName) {
  document.getElementById("qrPrintName").innerText = studentName;
  document.getElementById("qrPrintId").innerText   = "ID: " + studentId;
  const container = document.getElementById("qrPrintCode");
  container.innerHTML = "";
  if (qrInstance) { try { qrInstance.clear(); } catch(e) {} }
  // Build the URL so it always points to index.html regardless of how
  // admin.html is served (with or without .html extension, subdirs, etc.)
  const basePath = window.location.pathname
    .replace(/\/[^/]*$/, "/")   // strip filename, keep trailing slash
    .replace(/\/$/, "");         // remove trailing slash for clean join
  const appUrl = window.location.origin + basePath + "/index.html" +
    "?user=" + encodeURIComponent(String(studentId));
  qrInstance = new QRCode(container, {
    text: appUrl, width: 200, height: 200,
    colorDark: "#000000", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });
  openModal("qrPrintModal");
}

function printQr() {
  const name = document.getElementById("qrPrintName").innerText;
  const id   = document.getElementById("qrPrintId").innerText;
  const img  = document.querySelector("#qrPrintCode img");
  if (!img) { showNotification("QR not ready yet.", "error"); return; }
  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html><html><head><title>QR — ${name}</title>
  <style>body{font-family:sans-serif;text-align:center;padding:40px;}h2{margin:0 0 4px;font-size:20px;}p{margin:0 0 20px;color:#555;font-size:13px;}img{border:2px solid #eee;border-radius:8px;padding:10px;}small{display:block;margin-top:12px;color:#999;font-size:11px;}</style>
  </head><body><h2>${name}</h2><p>${id}</p><img src="${img.src}" width="200" height="200"><small>CTU Danao Equipment Borrowing System</small>
  <script>window.onload=()=>{window.print();window.close();}<\/script></body></html>`);
  win.document.close();
}

// ── Edit / Delete student ────────────────────────────────────────────────────
function openEditStudentModal(studentId, name, email) {
  document.getElementById("editStudentId").value    = studentId;
  document.getElementById("editStudentName").value  = name;
  document.getElementById("editStudentEmail").value = email || "";
  const err = document.getElementById("editStudentError");
  if (err) { err.textContent = ""; err.style.display = "none"; }
  openModal("editStudentModal");
}
function closeEditStudentModal() { closeModal("editStudentModal"); }

function saveEditStudent() {
  const studentId = document.getElementById("editStudentId").value.trim();
  const name      = document.getElementById("editStudentName").value.trim();
  const email     = document.getElementById("editStudentEmail").value.trim();
  const errEl     = document.getElementById("editStudentError");

  if (!name || name.length < 2) { errEl.textContent = "Name must be at least 2 characters."; errEl.style.display = "block"; return; }
  if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(name)) { errEl.textContent = "Letters only."; errEl.style.display = "block"; return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = "Invalid email."; errEl.style.display = "block"; return; }

  const saveBtn = document.getElementById("editStudentSaveBtn");
  saveBtn.disabled    = true;
  saveBtn.textContent = "Saving…";

  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "updateUser", studentId, name, email }) })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showNotification(`${name} updated.`, "success");
        closeEditStudentModal();
        loadQrStudentList();
        loadTransactions();
      } else {
        errEl.textContent = data.message || "Update failed."; errEl.style.display = "block";
      }
    })
    .catch(() => { errEl.textContent = "Network error."; errEl.style.display = "block"; })
    .finally(() => { saveBtn.disabled = false; saveBtn.textContent = "Save Changes"; });
}

function confirmDeleteStudent(studentId, name) {
  document.getElementById("deleteStudentMessage").innerHTML =
    `Delete <strong>${name}</strong> (ID: ${studentId})?<br>
     <small style="color:var(--text3);">This cannot be undone. Students with active borrows cannot be deleted.</small>`;
  openModal("deleteStudentModal");
  document.getElementById("deleteStudentYes").onclick = () => { closeModal("deleteStudentModal"); executeDeleteStudent(studentId, name); };
  document.getElementById("deleteStudentNo").onclick  = () => { closeModal("deleteStudentModal"); };
}

function executeDeleteStudent(studentId, name) {
  showNotification("Deleting student…", "info");
  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "deleteUser", studentId }) })
    .then(r => r.json())
    .then(data => {
      if (data.success) { showNotification(`${name} removed.`, "success"); loadQrStudentList(); updateKpiCards(); }
      else showNotification(data.message || "Could not delete student.", "error");
    })
    .catch(() => showNotification("Network error during deletion.", "error"));
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("open");
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("open");
}
window.addEventListener("click", e => {
  if (e.target.classList.contains("modal-overlay")) e.target.classList.remove("open");
});

// ── Update summary stats (alias) ─────────────────────────────────────────────
function updateSummaryStats() { updateKpiCards(); }

// ═══════════════════════════════════════════════════════════════════════════════
// CHARTS / ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════
const chartInstances = {};

function loadCharts() {
  if (allTransactions && allTransactions.length > 0) {
    renderAllCharts(allTransactions);
    updateAnalyticsKpis(allTransactions);
  } else {
    fetch(scriptURL + "?action=getAllHistory")
      .then(r => r.json())
      .then(history => {
        const todayStr = getPHTDateString();
        const [ty, tm, td] = todayStr.split("-").map(Number);
        const today = new Date(ty, tm - 1, td);
        const processed = (Array.isArray(history) ? history : []).map(tx => {
          if (tx.status === "Borrowed" && tx.dueDate) {
            const p = tx.dueDate.split("-");
            if (new Date(+p[0], +p[1]-1, +p[2]) < today) return { ...tx, status: "Overdue" };
          }
          return tx;
        });
        renderAllCharts(processed);
        updateAnalyticsKpis(processed);
      })
      .catch(() => showNotification("Error loading chart data.", "error"));
  }
}

function updateAnalyticsKpis(transactions) {
  const total    = transactions.length;
  const returned = transactions.filter(tx => tx.status === "Returned");
  const onTime   = returned.filter(tx => !tx.isLate).length;
  const pct      = returned.length > 0 ? ((onTime / returned.length) * 100).toFixed(1) + "%" : "N/A";

  const normalize = s => String(s).trim().replace(/\s+/g, " ");
  const counts = {};
  transactions.filter(tx => tx.status !== "Rejected").forEach(tx => { const k = normalize(tx.item); counts[k] = (counts[k] || 0) + 1; });
  const topItem = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];

  const el1 = document.getElementById("aKpiTotal");
  const el2 = document.getElementById("aKpiOnTime");
  const el3 = document.getElementById("aKpiTopItem");
  if (el1) el1.textContent = total;
  if (el2) el2.textContent = pct;
  if (el3) el3.textContent = topItem ? topItem[0] : "—";
}

function renderAllCharts(transactions) {
  drawMonthlyTrendChart(transactions);
  drawMostBorrowedChart(transactions);
  drawStatusChart(transactions);
  drawOnTimeChart(transactions);
}

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function chartDefaults() {
  return {
    textColor:  "#8b949e",
    gridColor:  "rgba(255,255,255,0.06)",
    fontFamily: "'Inter','Segoe UI',sans-serif"
  };
}

function getChartColors(count) {
  const palette = ["#4fc3f7","#3fb950","#d29922","#f85149","#a371f7","#4dd0e1","#aed581","#ff8a65","#f06292","#7986cb"];
  return Array.from({ length: count }, (_, i) => palette[i % palette.length]);
}

function drawMonthlyTrendChart(transactions) {
  destroyChart("monthlyTrend");
  const container = document.getElementById("chartMonthlyTrend");
  if (!container) return;
  container.innerHTML = "";

  const monthCounts = {};
  transactions.filter(tx => tx.borrowDate && tx.status !== "Rejected").forEach(tx => {
    const parts = tx.borrowDate.split("-");
    if (parts.length < 2) return;
    const key = `${parts[0]}-${parts[1].padStart(2,"0")}`;
    monthCounts[key] = (monthCounts[key] || 0) + 1;
  });
  const sortedKeys = Object.keys(monthCounts).sort();
  if (sortedKeys.length === 0) { container.innerHTML = "<p class='chart-empty'>No borrow date data yet.</p>"; return; }

  const labels = sortedKeys.map(k => {
    const [y, m] = k.split("-");
    return new Date(+y, +m-1, 1).toLocaleString("default", { month: "short", year: "2-digit" });
  });
  const data = sortedKeys.map(k => monthCounts[k]);
  const { textColor, gridColor, fontFamily } = chartDefaults();

  const canvas = document.createElement("canvas");
  canvas.height = 220;
  container.appendChild(canvas);

  chartInstances["monthlyTrend"] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Borrows", data,
        borderColor: "#4fc3f7",
        backgroundColor: "rgba(79,195,247,0.08)",
        pointBackgroundColor: "#4fc3f7",
        pointRadius: 5, fill: true, tension: 0.35
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} borrow${ctx.parsed.y !== 1 ? "s" : ""}` } } },
      scales: {
        x: { ticks: { color: textColor, font: { family: fontFamily } }, grid: { color: gridColor } },
        y: { beginAtZero: true, ticks: { color: textColor, font: { family: fontFamily }, stepSize: 1 }, grid: { color: gridColor } }
      }
    }
  });
}

function drawMostBorrowedChart(transactions) {
  destroyChart("borrowedItems");
  const container = document.getElementById("chartBorrowedItems");
  if (!container) return;
  container.innerHTML = "";

  // Normalize item names: trim whitespace + title-case so "keyboard" and
  // "Keyboard " are not counted as separate items.
  const normalize = s => String(s).trim().replace(/\s+/g, " ");
  const counts = {};
  transactions.filter(tx => tx.status !== "Rejected").forEach(tx => {
    const key = normalize(tx.item);
    counts[key] = (counts[key] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 10);
  if (sorted.length === 0) { container.innerHTML = "<p class='chart-empty'>No borrow data yet.</p>"; return; }

  const labels = sorted.map(e => e[0]);
  const data   = sorted.map(e => e[1]);
  const colors = getChartColors(labels.length);
  const { textColor, gridColor, fontFamily } = chartDefaults();

  const canvas = document.createElement("canvas");
  canvas.height = Math.max(200, labels.length * 36);
  container.appendChild(canvas);

  chartInstances["borrowedItems"] = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 5, borderSkipped: false }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x} borrow${ctx.parsed.x !== 1 ? "s" : ""}` } } },
      scales: {
        x: { beginAtZero: true, ticks: { color: textColor, font: { family: fontFamily }, stepSize: 1 }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, font: { family: fontFamily, size: 12 } }, grid: { display: false } }
      }
    }
  });
}

function drawStatusChart(transactions) {
  destroyChart("status");
  const container = document.getElementById("chartStatus");
  if (!container) return;
  container.innerHTML = "";

  const counts = {};
  transactions.forEach(tx => { const s = tx.status || "Unknown"; counts[s] = (counts[s] || 0) + 1; });
  const labels = Object.keys(counts);
  const data   = labels.map(l => counts[l]);
  if (labels.length === 0) { container.innerHTML = "<p class='chart-empty'>No transaction data yet.</p>"; return; }

  const colorMap = { "Borrowed":"#4fc3f7","Pending":"#d29922","Returned":"#3fb950","Overdue":"#f85149","Rejected":"#484f58","Return Pending":"#a371f7" };
  const colors = labels.map(l => colorMap[l] || "#7986cb");

  const { textColor, fontFamily } = chartDefaults();
  const canvas = document.createElement("canvas");
  canvas.height = 220;
  container.appendChild(canvas);

  chartInstances["status"] = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 8 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: {
        legend: { position: "bottom", labels: { color: textColor, font: { family: fontFamily }, padding: 12, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => { const total = data.reduce((a,b)=>a+b,0); const pct = ((ctx.parsed/total)*100).toFixed(1); return ` ${ctx.parsed} (${pct}%)`; } } }
      }
    }
  });
}

function drawOnTimeChart(transactions) {
  destroyChart("onTime");
  const container = document.getElementById("chartOnTime");
  if (!container) return;
  container.innerHTML = "";

  const returned = transactions.filter(tx => tx.status === "Returned");
  const onTime   = returned.filter(tx => !tx.isLate).length;
  const late     = returned.filter(tx => tx.isLate).length;
  if (returned.length === 0) { container.innerHTML = "<p class='chart-empty'>No completed returns yet.</p>"; return; }

  const { textColor, fontFamily } = chartDefaults();
  const canvas = document.createElement("canvas");
  canvas.height = 220;
  container.appendChild(canvas);

  chartInstances["onTime"] = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["On Time", "Late"],
      datasets: [{ data: [onTime, late], backgroundColor: ["#3fb950", "#f85149"], borderWidth: 0, hoverOffset: 8 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "60%",
      plugins: {
        legend: { position: "bottom", labels: { color: textColor, font: { family: fontFamily }, padding: 16 } },
        tooltip: { callbacks: { label: ctx => { const pct = ((ctx.parsed / returned.length)*100).toFixed(1); return ` ${ctx.parsed} (${pct}%)`; } } }
      }
    }
  });
}