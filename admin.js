// ─────────────────────────────────────────────────────────────────────────────
// CTU Danao Borrowing System — admin.js (redesigned)
// ─────────────────────────────────────────────────────────────────────────────

const scriptURL = "https://script.google.com/macros/s/AKfycby-l5d01eTIZUkksXW_pj9lXvzrnTB07UKgR05f8TwIfNIcn0GUMHwjoMy4z6BFP59_ow/exec"
// ── SafeFetch utility (safe JSON parsing from Apps Script) ──────────────────
function safeFetch(url, options) {
  return fetch(url, options)
    .then(res => res.text())
    .then(text => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        console.error("Non-JSON response from Apps Script:", trimmed.slice(0, 300));
        throw new Error("Server returned a non-JSON response. The web app deployment may need to be re-published as 'Anyone' access.");
      }
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        console.error("JSON parse error:", e, "Raw:", trimmed.slice(0, 300));
        throw new Error("Failed to parse server response.");
      }
    });
}

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
let allTransactions       = [];
let allHistoryTransactions = [];
let archivedTransactions  = [];
let allUsers              = [];
let allPending            = [];
let allReturnRequests     = [];
let selectedReturns       = new Set();
let selectedPending       = new Set();
let filteredTx            = [];
let archiveFilteredTx     = [];
let allItems              = [];  // raw items list from server
let itemIdMap             = {};  // normalizedItemName -> itemId

// ── Transaction log pagination ───────────────────────────────────────────────
const TX_PER_PAGE    = 20;
let   txCurrentPage  = 1;
let searchTimeout;
let qrInstance            = null;
let studentPenalties      = {};
const ARCHIVE_DAYS = 30;

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

// ── Admin session token (stored in memory after login) ───────────────────────
// Sent with every POST so Apps Script can verify admin identity
// without relying on Session.getActiveUser() (which is empty for web fetches).
let _adminSessionToken = "";
function getAdminToken() { return _adminSessionToken; }

// ── Login ────────────────────────────────────────────────────────────────────
async function checkPassword() {
  const entered = document.getElementById("adminPassword").value;
  const hashed  = await hashPassword(entered);
  if (hashed === ADMIN_PASSWORD_HASH) {
    _adminSessionToken = entered;   // store plaintext for API verification
    document.getElementById("loginScreen").style.display  = "none";
    document.getElementById("appShell").style.display     = "flex";
    showNotification("Admin access granted", "success");
    resetSessionTimer();
    startAutoRefresh();
    
    // Ensure data is migrated to new format on login
    fetch(scriptURL + "?action=diagnostic").then(r => r.json())
      .then(result => {
        if (result.status === "NEEDS_MIGRATION") {
          showNotification("Migrating data format... please wait", "info");
          // Trigger migration by calling any GET action
          fetch(scriptURL + "?action=getItems").then(() => {
            showNotification("Data migration complete", "success");
            refreshAll();
          });
        } else {
          refreshAll();
        }
      });
  } else {
    showNotification("Incorrect password", "error");
    document.getElementById("adminPassword").value = "";
    document.getElementById("adminPassword").focus();
  }
}

function logoutAdmin(timedOut = false) {
  _adminSessionToken = "";          // clear token on logout
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
  pageAccountability: { title: "Accountability",   desc: "Monitor student violations and status" },
  pageDamagedItems:   { title: "Damaged Items",    desc: "Items returned in damaged or broken condition" },
  pageArchive:      { title: "Archive",            desc: "Older completed transactions" },
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
  if (pageId === "pageTransactions") renderTransactions(allTransactions, true);
  if (pageId === "pageArchive")      renderArchiveTransactions(archivedTransactions);
  if (pageId === "pageItems")        { loadItemsTable(); loadDamagedItemsTable(); }
  if (pageId === "pageAccountability") loadAccountabilityTable();
  if (pageId === "pageDamagedItems")   loadDamagedItems();
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
  if (allHistoryTransactions.length === 0 && allTransactions.length === 0) {
    loadTransactions();
  }
}

function isDateStringOlderThan(dateStr, days) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const cutoff = new Date(date);
  cutoff.setDate(cutoff.getDate() + days);
  const today = new Date(getPHTDateString());
  return cutoff < today;
}

function isArchivedTransaction(tx) {
  const archiveStatuses = ["Returned", "Late Returned", "Rejected"];
  if (!archiveStatuses.includes(tx.status)) return false;
  const compareDate = tx.returnDate || tx.dueDate;
  return compareDate ? isDateStringOlderThan(compareDate, ARCHIVE_DAYS) : false;
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

  // Update problem alerts
  updateProblemAlerts();
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

function updateProblemAlerts() {
  const todayStr = getPHTDateString();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);

  // Find URGENT (overdue or due today) and WARNING (due within 2 days)
  const urgent = [];   // Red — immediate action needed
  const warning = [];  // Yellow — watch closely

  allTransactions.forEach(tx => {
    if (tx.status === "Overdue") {
      const overdueCount = urgent.filter(i => i.includes(tx.item)).length;
      if (overdueCount === 0) {
        urgent.push(`${tx.item} (${tx.studentName || tx.studentId}) is overdue`);
      }
    } else if (tx.status === "Borrowed" && tx.dueDate) {
      const daysDiff = Math.ceil((new Date(tx.dueDate.split("-")[0], tx.dueDate.split("-")[1] - 1, tx.dueDate.split("-")[2]) - today) / 86400000);
      if (daysDiff <= 0) {
        urgent.push(`${tx.item} from ${tx.studentName || tx.studentId} due today!`);
      } else if (daysDiff <= 2) {
        warning.push(`${tx.item} due in ${daysDiff} day${daysDiff !== 1 ? "s" : ""} (${tx.studentName || tx.studentId})`);
      }
    }
  });

  // Check for pending requests at risk
  const pendingRisk = allPending.filter(p => p.dueDate && p.dueDate <= todayStr);
  pendingRisk.forEach(p => {
    urgent.push(`${p.item} request (${p.studentName || p.studentId}) due today`);
  });

  // Update UI
  const urgentAlert = document.getElementById("urgentAlert");
  const warningAlert = document.getElementById("warningAlert");
  const alertSection = document.getElementById("criticalAlertsSection");

  if (urgent.length > 0) {
    const alertText = document.getElementById("urgentAlertText");
    alertText.innerHTML = `${urgent.length} item${urgent.length !== 1 ? "s" : ""} need immediate attention: ${urgent.slice(0, 2).join(" · ")}${urgent.length > 2 ? "..." : ""}`;
    urgentAlert.style.display = "block";
  } else if (urgentAlert) {
    urgentAlert.style.display = "none";
  }

  if (warning.length > 0) {
    const alertText = document.getElementById("warningAlertText");
    alertText.innerHTML = `${warning.length} item${warning.length !== 1 ? "s" : ""} due soon: ${warning.slice(0, 2).join(" · ")}${warning.length > 2 ? "..." : ""}`;
    warningAlert.style.display = "block";
  } else if (warningAlert) {
    warningAlert.style.display = "none";
  }

  if (urgentAlert && warningAlert) {
    alertSection.style.display = (urgent.length > 0 || warning.length > 0) ? "block" : "none";
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
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
${(tx.equipmentId && tx.equipmentId !== "") || itemIdMap[normalizeName(tx.item).toLowerCase()] ? `<span class="mono-chip" style="font-size:10px;">🏷 ${(tx.equipmentId && tx.equipmentId !== "") ? tx.equipmentId : itemIdMap[normalizeName(tx.item).toLowerCase()]}</span>` : ""}
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
  const recent = [...allTransactions]
    .sort((a, b) => (b.borrowDate || "").localeCompare(a.borrowDate || ""))
    .slice(0, 10);
  if (recent.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No transactions yet.</td></tr>`;
    return;
  }
  recent.forEach(tx => {
const itemId = (tx.equipmentId && tx.equipmentId !== "")
  ? tx.equipmentId
  : (itemIdMap[normalizeName(tx.item).toLowerCase()] || "—");
const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td>${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="mono-chip">${itemId}</span></td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate}</span></td>
      <td>${statusPill(tx.status)}</td>`;
    tbody.appendChild(row);
  });
}

function statusPill(status) {
  const map = {
    "Borrowed":        "s-borrowed",
    "Pending":         "s-pending",
    "Returned":        "s-returned",
    "Late Returned":   "s-returned-late",
    "Returned (Late)": "s-returned-late",
    "Overdue":         "s-overdue",
    "Return Pending":  "s-return-pending",
    "Rejected":        "s-rejected"
  };
  // Guard against missing, undefined, or raw Date string values
  // (happens when the sheet's Status column is missing/shifted)
  const knownStatuses = Object.keys(map);
  const safeStatus = (status && knownStatuses.includes(String(status))) ? String(status) : "—";
  const cls = map[safeStatus] || "";
  return `<span class="status-pill ${cls}">${safeStatus}</span>`;
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
    body: JSON.stringify({ action: "register", studentId, name: sName, email , adminToken: getAdminToken() })
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
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getPendingRequests")
    .then(r => r.json())
    .then(data => {
      allPending = Array.isArray(data) ? data : [];
      renderPendingTable(allPending);
      renderDashPending();
      updateKpiCards();
    })
    .catch(() => {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty" style="color:var(--danger);">Error loading requests.</td></tr>`;
    });
}

function renderPendingTable(requests) {
  const tbody = document.getElementById("pendingTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty"><span class="empty-icon">✅</span>No pending requests — all handled.</td></tr>`;
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

    // Calculate urgency: check if due date is today or tomorrow
    const todayStr = getPHTDateString();
    const urgencyClass = req.dueDate && req.dueDate <= todayStr ? "s-overdue" : 
                         req.dueDate && req.dueDate === addDaysToPHTString(todayStr, 1) ? "s-pending" : "";
    const urgencyLabel = req.dueDate && req.dueDate <= todayStr ? "🔴 URGENT" : 
                         req.dueDate && req.dueDate === addDaysToPHTString(todayStr, 1) ? "🟡 WARNING" : "Normal";
    const urgencyHtml = urgencyClass ? `<span class="status-pill ${urgencyClass}" style="font-weight:700;">${urgencyLabel}</span>` : `<span style="font-size:11px;color:var(--text3);">Normal</span>`;

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" class="pending-checkbox" data-index="${index}" onchange="updatePendingSelection()"></td>
      <td><span class="mono-chip">${req.studentId}</span></td>
      <td style="font-weight:600;">${req.studentName || "—"}</td>
      <td style="font-weight:600;">${req.item}</td>
      <td><span class="mono-chip">${itemIdMap[normalizeName(req.item).toLowerCase()] || "—"}</span></td>
      <td><span class="date-chip">${req.borrowDate || "—"}</span></td>
      <td style="font-size:12px;color:var(--text3);">${durationText}</td>
      <td><span class="date-chip" style="color:var(--warning);">${req.dueDate || "—"}</span></td>
      <td>${urgencyHtml}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" onclick="confirmHandover(${index})">✅ Hand Over</button>
          <button class="btn btn-danger  btn-sm" onclick="confirmReject(${index})">✗ Reject</button>
        </div>
      </td>`;
    tbody.appendChild(row);
  });

  selectedPending.clear();
  document.getElementById("selectAllPending").checked = false;
  document.getElementById("bulkApproveBtn").style.display = "none";
}

function updatePendingSelection() {
  selectedPending.clear();
  document.querySelectorAll(".pending-checkbox:checked").forEach(cb => {
    selectedPending.add(parseInt(cb.dataset.index));
  });
  const bulkBtn = document.getElementById("bulkApproveBtn");
  if (selectedPending.size > 0) {
    bulkBtn.style.display = "inline-flex";
    bulkBtn.textContent = `✅ Approve Selected (${selectedPending.size})`;
  } else {
    bulkBtn.style.display = "none";
  }
}

function toggleSelectAllPending() {
  const isChecked = document.getElementById("selectAllPending").checked;
  document.querySelectorAll(".pending-checkbox").forEach(cb => {
    cb.checked = isChecked;
  });
  updatePendingSelection();
}

function bulkApprovePending() {
  if (selectedPending.size === 0) {
    showNotification("No items selected.", "error");
    return;
  }

  const itemsToApprove = Array.from(selectedPending).map(idx => allPending[idx]);
  let approved = 0;
  showNotification(`Processing ${itemsToApprove.length} hand-overs…`, "info");

  Promise.all(itemsToApprove.map(req => {
    return fetch(scriptURL, {
      method: "POST",
      body: JSON.stringify({ action: "confirmBorrow", studentId: req.studentId, item: req.item, rowIndex: req.rowIndex , adminToken: getAdminToken() })
    }).then(r => r.json()).then(data => { if (data.success) approved++; });
  })).then(() => {
    showNotification(`✅ ${approved}/${itemsToApprove.length} hand-overs completed.`, "success");
    loadPendingRequests();
    loadTransactions();
    loadItemsTable();
    renderActiveBorrowers();
  }).catch(() => showNotification("Error during bulk hand-over.", "error"));
}

// Helper function to add days to PHT date string
function addDaysToPHTString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split("T")[0];
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
    body: JSON.stringify({ action: "confirmBorrow", studentId: req.studentId, item: req.item, rowIndex: req.rowIndex , adminToken: getAdminToken() })
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
    body: JSON.stringify({ action: "rejectBorrow", studentId: req.studentId, item: req.item, rowIndex: req.rowIndex , adminToken: getAdminToken() })
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
  if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getReturnRequests")
    .then(r => r.json())
    .then(data => {
      allReturnRequests = Array.isArray(data) ? data : [];
      renderReturnsTable(allReturnRequests);
      updateNavBadge("navBadgeReturns", allReturnRequests.length);
    })
    .catch(() => {
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-empty" style="color:var(--danger);">Error loading return requests.</td></tr>`;
    });
}

function renderReturnsTable(requests) {
  const tbody = document.getElementById("returnsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty"><span class="empty-icon">✅</span>No pending return requests.</td></tr>`;
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
      <td><span class="mono-chip">${itemIdMap[normalizeName(req.item).toLowerCase()] || "—"}</span></td>
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
  document.getElementById("adminReturnDamage").onclick = () => {
    modal.classList.remove("open");
    const txId = req.rowIndex || index;
    console.log("Opening damage report for:", { txId, studentName: req.studentName, item: req.item });
    openDamageReportModal(txId, req.studentName || req.studentId, req.item);
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
    body: JSON.stringify({ action: "confirmReturn", 
      studentId: req.studentId, 
      item: req.item, 
      returnDate, 
      rowIndex: req.rowIndex,
      condition: condition,
      isLate: isLate
    , adminToken: getAdminToken() })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      const conditionIcon = condition === "Good" ? "✅" : condition === "Damaged" ? "⚠️" : "❌";
      const lateText = isLate ? " [LATE]" : "";
      showNotification(`${conditionIcon} "${req.item}" return confirmed (${condition})${lateText}.`, "success");
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
      body: JSON.stringify({ action: "confirmReturn", 
        studentId: req.studentId, 
        item: req.item, 
        returnDate: today, 
        rowIndex: req.rowIndex,
        condition: condition,
        isLate: isLate
      , adminToken: getAdminToken() })
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
      const processed = (Array.isArray(history) ? history : []).map(tx => {
        let result = { ...tx };
        if (tx.status === "Borrowed" && tx.dueDate) {
          const p = tx.dueDate.split("-");
          if (new Date(+p[0], +p[1]-1, +p[2]) < today) result.status = "Overdue";
        }
        if ((tx.status === "Returned" || tx.status === "Late Returned") && tx.returnDate && tx.dueDate) {
          const rp = tx.returnDate.split("-");
          const dp = tx.dueDate.split("-");
          const returnDate = new Date(+rp[0], +rp[1]-1, +rp[2]);
          const dueDate = new Date(+dp[0], +dp[1]-1, +dp[2]);
          if (returnDate > dueDate) {
            result.status = "Late Returned";
            result.isLate = true;
          }
        }
        return result;
      });
      // Sort transaction log newest first by borrow date
      processed.sort((a, b) => (b.borrowDate || "").localeCompare(a.borrowDate || ""));
      allHistoryTransactions = processed;
      archivedTransactions = allHistoryTransactions.filter(isArchivedTransaction);
      allTransactions = allHistoryTransactions.filter(tx => !isArchivedTransaction(tx));
      filteredTx = allTransactions;
      archiveFilteredTx = archivedTransactions;
      renderTransactions(allTransactions);
      renderArchiveTransactions(archivedTransactions);
      loadDamagedItems();
      updateKpiCards();
      renderDashboard();
    })
    .catch(() => showNotification("Error loading transactions.", "error"));
}

function renderTransactions(transactions, resetPage = false) {
  if (resetPage) txCurrentPage = 1;
  filteredTx = transactions;

  const tbody        = document.querySelector("#transactionsTable tbody");
  const paginationEl = document.getElementById("txPagination");
  const pageLabel    = document.getElementById("txPageLabel");
  const prevBtn      = document.getElementById("txPrevBtn");
  const nextBtn      = document.getElementById("txNextBtn");
  const countEl      = document.getElementById("txCount");

  if (!tbody) return;
  tbody.innerHTML = "";

  if (!transactions || transactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty">No transactions found.</td></tr>`;
    if (paginationEl) paginationEl.style.display = "none";
    if (countEl) countEl.textContent = "";
    return;
  }

  const totalPages = Math.ceil(transactions.length / TX_PER_PAGE);
  if (txCurrentPage > totalPages) txCurrentPage = totalPages;
  if (txCurrentPage < 1) txCurrentPage = 1;

  const start = (txCurrentPage - 1) * TX_PER_PAGE;
  const page  = transactions.slice(start, start + TX_PER_PAGE);

  page.forEach(tx => {
// Use the transaction's own stored equipment ID first,
// fall back to itemIdMap lookup only if empty
const itemId = (tx.equipmentId && tx.equipmentId !== "") 
  ? tx.equipmentId 
  : (itemIdMap[normalizeName(tx.item).toLowerCase()] || "—");    
    // Condition pill with color coding
    let condClass = "c-good";
    let condIcon = "✅";
    if (tx.condition === "Damaged") {
      condClass = "c-damaged";
      condIcon = "⚠️";
    } else if (tx.condition === "Broken") {
      condClass = "c-broken";
      condIcon = "❌";
    }
    const condBadge = `<span class="condition-pill ${condClass}">${condIcon} ${tx.condition || "Good"}</span>`;
    
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td>${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="mono-chip">${itemId}</span></td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate}</span></td>
      <td><span class="date-chip">${tx.returnDate || "—"}</span></td>
      <td>${statusPill(tx.status)}</td>
      <td>${condBadge}</td>`;
    tbody.appendChild(row);
  });

  // Count label
  const showing = `${start + 1}–${Math.min(start + TX_PER_PAGE, transactions.length)} of ${transactions.length}`;
  if (countEl) countEl.textContent = showing;

  // Pagination controls
  if (paginationEl) {
    if (totalPages > 1) {
      paginationEl.style.display = "flex";
      if (prevBtn)   prevBtn.disabled      = txCurrentPage === 1;
      if (nextBtn)   nextBtn.disabled      = txCurrentPage === totalPages;
      if (pageLabel) pageLabel.textContent = `Page ${txCurrentPage} of ${totalPages}`;
    } else {
      paginationEl.style.display = "none";
    }
  }
}

function changeTxPage(delta) {
  const totalPages = Math.ceil(filteredTx.length / TX_PER_PAGE);
  const next = txCurrentPage + delta;
  if (next < 1 || next > totalPages) return;
  txCurrentPage = next;
  renderTransactions(filteredTx);
  // Scroll table into view smoothly
  const panel = document.getElementById("pageTransactions");
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderArchiveTransactions(transactions) {
  const tbody = document.querySelector("#archiveTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!transactions || transactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="table-empty">No archived transactions yet.</td></tr>`;
    return;
  }
  transactions.forEach(tx => {
// Use the transaction's own stored equipment ID first,
// fall back to itemIdMap lookup only if empty
const itemId = (tx.equipmentId && tx.equipmentId !== "") 
  ? tx.equipmentId 
  : (itemIdMap[normalizeName(tx.item).toLowerCase()] || "—");    
    // Condition pill with color coding
    let condClass = "c-good";
    let condIcon = "✅";
    if (tx.condition === "Damaged") {
      condClass = "c-damaged";
      condIcon = "⚠️";
    } else if (tx.condition === "Broken") {
      condClass = "c-broken";
      condIcon = "❌";
    }
    const condBadge = `<span class="condition-pill ${condClass}">${condIcon} ${tx.condition || "Good"}</span>`;
    
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td>${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="mono-chip">${itemId}</span></td>
      <td><span class="date-chip">${tx.borrowDate}</span></td>
      <td><span class="date-chip">${tx.dueDate}</span></td>
      <td><span class="date-chip">${tx.returnDate || "—"}</span></td>
      <td>${statusPill(tx.status)}</td>
      <td>${condBadge}</td>`;
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
    renderTransactions(filtered, true);
  }, 300);
}

function resetFilter() {
  const si = document.getElementById("searchInput");
  const sf = document.getElementById("statusFilter");
  if (si) si.value = "";
  if (sf) sf.value = "";
  renderTransactions(allTransactions, true);
}

function filterArchiveTransactions() {
  const query  = (document.getElementById("archiveSearch")?.value || "").toLowerCase();
  const status = document.getElementById("archiveStatusFilter")?.value || "";
  archiveFilteredTx = archivedTransactions.filter(tx =>
    (!query  || String(tx.studentId).toLowerCase().includes(query) ||
                String(tx.item).toLowerCase().includes(query) ||
                String(tx.studentName || "").toLowerCase().includes(query)) &&
    (!status || tx.status === status)
  );
  renderArchiveTransactions(archiveFilteredTx);
}

function resetArchiveFilter() {
  const si = document.getElementById("archiveSearch");
  const sf = document.getElementById("archiveStatusFilter");
  if (si) si.value = "";
  if (sf) sf.value = "";
  renderArchiveTransactions(archivedTransactions);
}

// ── Damaged Items ─────────────────────────────────────────────────────────────
let allDamagedItems = [];
let filteredDamagedItems = [];

function loadDamagedItems() {
  fetch(scriptURL + "?action=getDamagedItems")
    .then(r => r.json())
    .then(data => {
      allDamagedItems = Array.isArray(data) ? data : [];
      filteredDamagedItems = allDamagedItems;
      renderDamagedItemsTable(allDamagedItems);
      const badge = document.getElementById("damagedItemsCount");
      if (badge) {
        badge.textContent = `${allDamagedItems.length} item${allDamagedItems.length !== 1 ? "s" : ""}`;
        badge.style.display = allDamagedItems.length > 0 ? "inline-block" : "none";
      }
    })
    .catch(err => {
      console.error("Error loading damaged items:", err);
      showNotification("Error loading damaged items.", "error");
    });
}

function renderDamagedItemsTable(items) {
  const tbody = document.getElementById("damagedItemsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><span class="empty-icon">✅</span>No damaged or broken items on record.</td></tr>`;
    return;
  }

  items.forEach(tx => {
    // Condition pill with color coding - handle both DAMAGED and Damaged
    let condClass = "c-good";
    let condIcon = "✅";
    const condValue = String(tx.condition || "").trim();
    if (condValue === "Damaged") {
      condClass = "c-damaged";
      condIcon = "⚠️";
    } else if (condValue === "Broken") {
      condClass = "c-broken";
      condIcon = "❌";
    }
    
    const condBadge = `<span class="condition-pill ${condClass}">${condIcon} ${tx.condition}</span>`;

    // Status pill with color coding
    let statusClass = "s-returned";
    let statusIcon = "✅";
    if (tx.status === "Late Returned") {
      statusClass = "s-returned-late";
      statusIcon = "⚠️";
    }
    
    const statusBadge = `<span class="status-pill ${statusClass}">${statusIcon} ${tx.status}</span>`;

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${tx.studentId}</span></td>
      <td style="font-weight:600;">${tx.studentName || "—"}</td>
      <td style="font-weight:600;">${tx.item}</td>
      <td><span class="mono-chip">${tx.itemId || "—"}</span></td>
      <td><span class="date-chip">${tx.borrowDate || "—"}</span></td>
      <td><span class="date-chip">${tx.returnDate || "—"}</span></td>
      <td>${condBadge}</td>
      <td>${statusBadge}</td>
      <td>${tx.description || "—"}</td>`;
    tbody.appendChild(row);
  });
}

function filterDamagedItems() {
  const q    = (document.getElementById("damagedSearch")?.value || "").toLowerCase();
  const type = document.getElementById("damageTypeFilter")?.value || "";
  const filtered = allDamagedItems.filter(tx =>
    (!type || tx.condition === type) &&
    (!q || (tx.studentId||"").toLowerCase().includes(q) ||
           (tx.studentName||"").toLowerCase().includes(q) ||
           (tx.item||"").toLowerCase().includes(q))
  );
  filteredDamagedItems = filtered;
  renderDamagedItemsTable(filtered);
}

function resetDamagedFilter() {
  const si = document.getElementById("damagedSearch");
  const sf = document.getElementById("damageTypeFilter");
  if (si) si.value = "";
  if (sf) sf.value = "";
  renderDamagedItemsTable(allDamagedItems);
}

function exportDamagedCSV() {
  if (!allDamagedItems.length) { showNotification("No damaged items to export.", "error"); return; }
  const headers = ["Student ID","Name","Item","Item ID","Borrow Date","Return Date","Condition","Status"];
  const rows = allDamagedItems.map(tx => [
    tx.studentId, tx.studentName||"", tx.item,
    itemIdMap[normalizeName(tx.item).toLowerCase()] || tx.itemId || "",
    tx.borrowDate||"", tx.returnDate||"", tx.condition, tx.status
  ]);
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(","))
    .join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `damaged-items-${getPHTDateString()}.csv`
  });
  a.click();
  URL.revokeObjectURL(a.href);
  showNotification("CSV exported.", "success");
}

function exportTransactionsCSV() {
  if (!allTransactions || allTransactions.length === 0) {
    showNotification("No transactions to export.", "error");
    return;
  }
  const headers = ["Student ID","Name","Item","Item ID","Borrow Date","Due Date","Return Date","Status","Late Return"];
  const rows = allTransactions.map(tx =>
    [tx.studentId, tx.studentName || "", tx.item, itemIdMap[normalizeName(tx.item).toLowerCase()] || "", tx.borrowDate, tx.dueDate, tx.returnDate || "", tx.status, tx.isLate ? "Yes" : "No"]
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
  const container = document.getElementById("itemsContainer");
  if (!container) return;
  
  container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);">Loading items...</div>`;

  // Fetch BOTH items and active transactions to show TRUE available counts
  Promise.all([
    fetch(scriptURL + "?action=getItems").then(r => r.json()),
    fetch(scriptURL + "?action=getAllHistory").then(r => r.json())
  ])
    .then(([response, history]) => {
      if (!container) return;
      
      // Handle both old and new response formats
      let items = Array.isArray(response) ? response : (response && response.items ? response.items : []);
      
      // Show debug info if available
      if (response && response.debug) {
        console.log(`[loadItemsTable] 📊 DEBUG INFO:`);
        console.log(`  Sheet: ${response.debug.sheetName}`);
        console.log(`  Total Rows: ${response.debug.totalRows}`);
        console.log(`  Header Row:`, response.debug.headerRow);
        console.log(`  Data Rows:`);
        if (response.debug.allDataRows) {
          response.debug.allDataRows.forEach(row => {
            console.log(`    Row ${row.rowNumber}: A="${row.colA}" | B="${row.colB}" | C="${row.colC}"`);
          });
        }
      }
      
      console.log(`[loadItemsTable] Raw items response:`, items);
      console.log(`[loadItemsTable] Received ${Array.isArray(items) ? items.length : 0} items`);
      if (Array.isArray(items)) {
        items.forEach((it, idx) => {
          console.log(`  [${idx}] itemId="${it.itemId}", itemName="${it.itemName}"`);
        });
      }
      
      // Handle both old and new response formats for history
      let transactionsList = Array.isArray(history) ? history : (history && history.data ? history.data : (history && Array.isArray(history) ? history : []));
      console.log(`[loadItemsTable] Received ${Array.isArray(transactionsList) ? transactionsList.length : 0} transactions`);
      
      container.innerHTML = "";

      // Build/refresh the itemIdMap so all tables can look up IDs by name
      allItems = Array.isArray(items) ? items : [];
      itemIdMap = {};
      allItems.forEach(it => {
        const key = normalizeName(it.itemName).toLowerCase();
        if (!itemIdMap[key]) itemIdMap[key] = it.itemId;
      });

      if (!allItems || allItems.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);">No items yet — add one to get started.</div>`;
        console.log(`[loadItemsTable] No items to display`);
        return;
      }

      // Count currently borrowed items by name AND build a set of borrowed itemIds
      // Include "Return Pending" so items don't show as available until return is confirmed
      const borrowedByName = {};
      const borrowedItemIds = new Set();
      (transactionsList || []).forEach(tx => {
        if (tx.status === "Borrowed" || tx.status === "Overdue" || tx.status === "Return Pending") {
          const key = normalizeName(tx.item);
          if (!key) return;
          borrowedByName[key] = (borrowedByName[key] || 0) + 1;
          // Track the specific itemId from transaction if available
          if (tx.itemId) {
            borrowedItemIds.add(tx.itemId);
          }
        }
      });

      console.log(`[loadItemsTable] Borrowed items by name:`, borrowedByName);
      console.log(`[loadItemsTable] Borrowed item IDs:`, Array.from(borrowedItemIds));

      // Group items by itemName (category)
      const grouped = {};
      allItems.forEach(it => {
        const key = normalizeName(it.itemName);
        console.log(`[loadItemsTable] Grouping item: itemId="${it.itemId}", itemName="${it.itemName}" → key="${key}"`);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(it);
      });

      console.log(`[loadItemsTable] Grouped into ${Object.keys(grouped).length} categories:`);
      Object.keys(grouped).forEach(cat => {
        console.log(`  - "${cat}": ${grouped[cat].length} items`);
      });

      // Create a card for each category
      Object.entries(grouped).forEach(([categoryName, categoryItems], catIndex) => {
        // Use a safe numeric index-based ID to avoid special characters breaking getElementById
        const categoryId = `cat-idx-${catIndex}`;
        const total = categoryItems.length;
        const out = borrowedByName[categoryName] || 0;
        const available = Math.max(0, total - out);

        console.log(`[loadItemsTable] Creating category card ${catIndex}: "${categoryName}" (${available}/${total})`);

        // Item name header with checkbox (accordion)
        const headerDiv = document.createElement("div");
        headerDiv.className = "inventory-item-header";
        headerDiv.id = categoryId;
        headerDiv.style.cssText = `
          display: flex;
          align-items: center;
          padding: 10px 12px;
          background: rgba(79,195,247,0.08);
          border: 1px solid rgba(79,195,247,0.2);
          border-radius: 8px;
          cursor: pointer;
          user-select: none;
          transition: all 0.2s;
        `;

        // Checkbox
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `check-${categoryId}`;
        checkbox.style.cssText = "margin-right:10px;cursor:pointer;width:18px;height:18px;";

        // Item name text
        const nameLabel = document.createElement("label");
        nameLabel.htmlFor = `check-${categoryId}`;
        nameLabel.style.cssText = "flex:1;cursor:pointer;font-weight:600;color:var(--text);";
        nameLabel.textContent = `${categoryName} (${available}/${total})`;

        // Expand/collapse arrow
        const arrow = document.createElement("span");
        arrow.className = "accordion-arrow";
        arrow.textContent = "▶";
        arrow.style.cssText = "margin-left:auto;transition:transform 0.2s;font-size:12px;color:var(--text3);";

        headerDiv.appendChild(checkbox);
        headerDiv.appendChild(nameLabel);
        headerDiv.appendChild(arrow);

        // Items container (initially hidden)
        const itemsDiv = document.createElement("div");
        itemsDiv.id = `${categoryId}-items`;
        itemsDiv.style.cssText = `
          display: none;
          flex-direction: column;
          gap: 6px;
          padding-left: 28px;
          margin-top: 4px;
          margin-bottom: 8px;
        `;

        // Track how many of this category are borrowed to mark them
        let borrowedCount = 0;
        const borrowedThisCategory = out || 0;

        categoryItems.forEach(item => {
          const itemRow = document.createElement("div");
          itemRow.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 10px;
            background: rgba(255,255,255,0.03);
            border-left: 2px solid var(--accent);
            border-radius: 4px;
            font-size: 13px;
          `;

          // Mark first N items as borrowed based on borrowedByName count
          const isBorrowed = borrowedCount < borrowedThisCategory;
          if (isBorrowed) borrowedCount++;

          const idText = document.createElement("span");
          idText.className = "item-detail-id";
          idText.textContent = item.itemId;
          idText.style.cssText = "font-family:var(--mono);font-weight:600;color:var(--accent);";

          // Add borrowed indicator if needed
          const statusDiv = document.createElement("div");
          statusDiv.style.cssText = "display:flex;align-items:center;gap:8px;margin-left:auto;";

          if (isBorrowed) {
            const borrowedBadge = document.createElement("span");
            borrowedBadge.textContent = "🔴 Borrowed";
            borrowedBadge.style.cssText = "font-size:12px;color:var(--warning);font-weight:600;";
            statusDiv.appendChild(borrowedBadge);
          }

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "btn btn-ghost btn-sm";
          deleteBtn.textContent = "🗑 Delete";
          deleteBtn.style.cssText = "margin-left:8px;";
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteItemById(item.itemId);
          });

          itemRow.appendChild(idText);
          statusDiv.appendChild(deleteBtn);
          itemRow.appendChild(statusDiv);
          itemsDiv.appendChild(itemRow);
        });

        // Toggle expand/collapse on header click
        headerDiv.addEventListener("click", () => {
          const isVisible = itemsDiv.style.display === "flex";
          itemsDiv.style.display = isVisible ? "none" : "flex";
          arrow.style.transform = isVisible ? "rotate(0deg)" : "rotate(90deg)";
          checkbox.checked = !isVisible;
        });

        // Prevent checkbox click from double-triggering
        checkbox.addEventListener("click", (e) => {
          e.stopPropagation();
          headerDiv.click();
        });

        container.appendChild(headerDiv);
        container.appendChild(itemsDiv);
      });
      console.log(`[loadItemsTable] ✅ Display complete: ${allItems.length} items in ${Object.keys(grouped).length} categories`);
    })
    .catch(err => {
      console.error(`[loadItemsTable] Error:`, err);
      if (container) container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">⚠️ Error loading items: ${err.message}</div>`;
    });
}

function normalizeItemName(str) {
  return String(str || "").trim().replace(/\s+/g, " ");
}

function normalizeName(str) {
  return String(str || "").trim().replace(/\s+/g, " ");
}

// ── Damaged Items ────────────────────────────────────────────────────────────
function loadDamagedItemsTable() {
  const container = document.getElementById("damagedItemsContainer");
  if (!container) return;
  
  container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);">Loading damaged items...</div>`;

  fetch(scriptURL + "?action=getDamagedItems")
    .then(r => r.json())
    .then(response => {
      if (!container) return;
      
      // Handle both old and new response formats
      let damagedItems = Array.isArray(response) ? response : (response && response.data ? response.data : (response && response.items ? response.items : []));
      
      console.log(`[loadDamagedItemsTable] Received ${Array.isArray(damagedItems) ? damagedItems.length : 0} damaged items`);
      
      container.innerHTML = "";

      if (!damagedItems || damagedItems.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3);">No damaged items recorded.</div>`;
        return;
      }

      // Group damaged items by item name
      const grouped = {};
      damagedItems.forEach(it => {
        const key = normalizeName(it.item);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(it);
      });

      // Create a card for each item name
      Object.entries(grouped).forEach(([itemName, itemList], catIndex) => {
        const categoryId = `dmg-cat-${catIndex}`;
        const total = itemList.length;

        // Item name header with checkbox (accordion)
        const headerDiv = document.createElement("div");
        headerDiv.className = "inventory-item-header";
        headerDiv.id = categoryId;
        headerDiv.style.cssText = `
          display: flex;
          align-items: center;
          padding: 10px 12px;
          background: rgba(248,81,73,0.08);
          border: 1px solid rgba(248,81,73,0.2);
          border-radius: 8px;
          cursor: pointer;
          user-select: none;
          transition: all 0.2s;
        `;

        // Checkbox
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `check-${categoryId}`;
        checkbox.style.cssText = "margin-right:10px;cursor:pointer;width:18px;height:18px;";

        // Item name text
        const nameLabel = document.createElement("label");
        nameLabel.htmlFor = `check-${categoryId}`;
        nameLabel.style.cssText = "flex:1;cursor:pointer;font-weight:600;color:var(--text);";
        nameLabel.textContent = `${itemName} (${total})`;

        // Expand/collapse arrow
        const arrow = document.createElement("span");
        arrow.className = "accordion-arrow";
        arrow.textContent = "▶";
        arrow.style.cssText = "margin-left:auto;transition:transform 0.2s;font-size:12px;color:var(--text3);";

        headerDiv.appendChild(checkbox);
        headerDiv.appendChild(nameLabel);
        headerDiv.appendChild(arrow);

        // Items container (initially hidden)
        const itemsDiv = document.createElement("div");
        itemsDiv.id = `${categoryId}-items`;
        itemsDiv.style.cssText = `
          display: none;
          flex-direction: column;
          gap: 6px;
          padding-left: 28px;
          margin-top: 4px;
          margin-bottom: 8px;
        `;

        itemList.forEach(item => {
          const itemRow = document.createElement("div");
          itemRow.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 10px;
            background: rgba(255,255,255,0.03);
            border-left: 2px solid var(--danger);
            border-radius: 4px;
            font-size: 13px;
          `;

          const idText = document.createElement("span");
          idText.className = "item-detail-id";
          idText.textContent = item.itemId;
          idText.style.cssText = "font-family:var(--mono);font-weight:600;color:var(--danger);";

          itemRow.appendChild(idText);
          itemsDiv.appendChild(itemRow);
        });

        // Toggle expand/collapse on header click
        headerDiv.addEventListener("click", () => {
          const isVisible = itemsDiv.style.display === "flex";
          itemsDiv.style.display = isVisible ? "none" : "flex";
          arrow.style.transform = isVisible ? "rotate(0deg)" : "rotate(90deg)";
          checkbox.checked = !isVisible;
        });

        // Prevent checkbox click from double-triggering
        checkbox.addEventListener("click", (e) => {
          e.stopPropagation();
          headerDiv.click();
        });

        container.appendChild(headerDiv);
        container.appendChild(itemsDiv);
      });
      console.log(`[loadDamagedItemsTable] ✅ Display complete: ${damagedItems.length} items`);
    })
    .catch(err => {
      console.error(`[loadDamagedItemsTable] Error:`, err);
      if (container) container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">⚠️ Error loading damaged items: ${err.message}</div>`;
    });
}



function addItem() {
  const name = document.getElementById("newItemName").value.trim();
  const id   = document.getElementById("newItemId").value.trim();
  
  if (!name) { 
    showNotification("Item name is required.", "error"); 
    return; 
  }
  if (!id) { 
    showNotification("Item ID is required.", "error"); 
    return; 
  }

  console.log(`[addItem] Adding item: ID="${id}", Name="${name}"`);

  fetch(scriptURL, { 
    method: "POST", 
    body: JSON.stringify({ 
      action: "addItem", 
      itemId: id, 
      itemName: name,
      adminToken: getAdminToken() 
    }) 
  })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log(`[addItem] Server response:`, data);
      
      if (data.success) {
        showNotification(`"${name}" (${id}) added successfully.`, "success");
        
        // Clear form fields
        const nameField = document.getElementById("newItemName");
        const idField = document.getElementById("newItemId");
        if (nameField) nameField.value = "";
        if (idField) idField.value = "";
        
        // Reload items table after a brief delay to ensure server-side persistence
        setTimeout(() => {
          console.log(`[addItem] Reloading items table...`);
          loadItemsTable();
        }, 500);
      } else {
        console.error(`[addItem] Server returned error:`, data.message);
        showNotification(data.message || "Failed to add item.", "error");
      }
    })
    .catch(err => {
      console.error(`[addItem] Error:`, err);
      showNotification(`Error adding item: ${err.message}`, "error");
    });
}

function deleteItemById(itemId) {
  if (!itemId) {
    showNotification("Invalid item ID.", "error");
    return;
  }
  
  if (!confirm(`Delete item "${itemId}"? This cannot be undone.`)) return;
  
  console.log(`[deleteItemById] Deleting item: ${itemId}`);
  
  fetch(scriptURL, { 
    method: "POST", 
    body: JSON.stringify({ 
      action: "deleteItem", 
      itemId,
      adminToken: getAdminToken() 
    }) 
  })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log(`[deleteItemById] Server response:`, data);
      
      if (data.success) { 
        showNotification(`"${itemId}" deleted.`, "success"); 
        loadItemsTable(); 
      }
      else {
        console.error(`[deleteItemById] Server returned error:`, data.message);
        showNotification(data.message || "Failed to delete.", "error");
      }
    })
    .catch(err => {
      console.error(`[deleteItemById] Error:`, err);
      showNotification(`Error deleting item: ${err.message}`, "error");
    });
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
    const historySource = allHistoryTransactions.length > 0 ? allHistoryTransactions : allTransactions;
    const studentTx = historySource.filter(tx => tx.studentId === u.id);
    const totalBorrows = studentTx.length;
    const currentItems = studentTx.filter(tx => ["Borrowed", "Overdue", "Return Pending"].includes(tx.status)).length;
    const lateReturns = studentTx.filter(tx => tx.status === "Late Returned").length;
    
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
  document.getElementById("studentHistoryBody").innerHTML = `<tr><td colspan="7" class="table-empty">Loading history…</td></tr>`;
  document.getElementById("studentHistoryModal").classList.add("open");

  if (allTransactions.length === 0) {
    fetch(scriptURL + "?action=getAllHistory")
      .then(r => r.json())
      .then(history => {
        allTransactions = Array.isArray(history) ? history : [];
        renderStudentHistory(studentId);
      })
      .catch(() => {
        const tbody = document.getElementById("studentHistoryBody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Unable to load history.</td></tr>`;
      });
  } else {
    renderStudentHistory(studentId);
  }
}

function renderStudentHistory(studentId) {
  const tbody = document.getElementById("studentHistoryBody");
  if (!tbody) return;
  
  const studentTx = allTransactions.filter(tx => tx.studentId === studentId);
  if (!studentTx || studentTx.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No borrowing history found.</td></tr>`;
    return;
  }
  
  // Sort by borrow date descending (most recent first)
  studentTx.sort((a, b) => b.borrowDate.localeCompare(a.borrowDate));
  
  tbody.innerHTML = "";
  studentTx.forEach(tx => {
    const row = document.createElement("tr");
    const isLate = tx.status === "Late Returned";
    const conditionIcon = tx.condition ? 
      (tx.condition === "Good" ? "✅" : tx.condition === "Damaged" ? "⚠️" : tx.condition === "Broken" ? "❌" : "🔴") : "—";
    
    row.innerHTML = `
      <td style="font-weight:600;">${tx.item}</td>
<td><span class="mono-chip">${(tx.equipmentId && tx.equipmentId !== "") ? tx.equipmentId : (itemIdMap[normalizeName(tx.item).toLowerCase()] || "—")}</span></td>
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
    if (row.cells.length < 7) return; // Skip empty rows
    
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

  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "updateUser", studentId, name, email , adminToken: getAdminToken() }) })
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
  fetch(scriptURL, { method: "POST", body: JSON.stringify({ action: "deleteUser", studentId , adminToken: getAdminToken() }) })
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

// ── Student Accountability System ───────────────────────────────────────────
function calculateStudentStatus(studentId) {
  // Count violations: late returns + damaged items
  const studentTxs = allTransactions.filter(tx => tx.studentId === studentId);
  const lateCount = studentTxs.filter(tx => tx.isLate).length;
  const damagedCount = studentTxs.filter(tx => tx.condition === "Damaged" || tx.condition === "Broken").length;
  const violations = lateCount + damagedCount;

  // Status badge logic
  let status = "trusted";
  if (violations >= 3) status = "suspended";
  else if (violations >= 1) status = "caution";

  return { status, violations, lateCount, damagedCount };
}

function getStatusBadge(status) {
  const badges = {
    "trusted": "🟢 Trusted",
    "caution": "🟡 Caution",
    "suspended": "🔴 Suspended"
  };
  return badges[status] || "—";
}

function openAccountabilityModal(studentId) {
  const user = allUsers.find(u => u.id === studentId);
  if (!user) { showNotification("Student not found.", "error"); return; }

  const { status, violations, lateCount, damagedCount } = calculateStudentStatus(studentId);
  const studentTxs = allTransactions.filter(tx => tx.studentId === studentId);
  
  let html = `
    <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;margin-bottom:12px;">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Student Name</div>
      <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:12px;">${user.name}</div>
      
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Status</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:16px;">${getStatusBadge(status)}</div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;color:var(--text3);">Total Violations</div>
          <div style="font-size:18px;font-weight:700;color:${violations > 0 ? 'var(--danger)' : 'var(--success)'}">${violations}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);">Total Transactions</div>
          <div style="font-size:18px;font-weight:700;color:var(--accent)">${studentTxs.length}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);">Late Returns</div>
          <div style="font-size:18px;font-weight:700;color:${lateCount > 0 ? 'var(--warning)' : 'var(--text2)'}">${lateCount}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text3);">Damaged Items</div>
          <div style="font-size:18px;font-weight:700;color:${damagedCount > 0 ? 'var(--danger)' : 'var(--text2)'}">${damagedCount}</div>
        </div>
      </div>
    </div>

    <hr class="divider" style="margin:12px 0;">
    
    <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 8px;">Issue History</div>
    <div style="max-height:200px;overflow-y:auto;">
      <table class="data-table" style="font-size:12px;">
        <thead><tr>
          <th>Item</th><th>Issue Type</th><th>Date</th>
        </tr></thead>
        <tbody>`;
  
  studentTxs.filter(tx => tx.isLate || tx.condition === "Damaged" || tx.condition === "Broken").forEach(tx => {
    const issueType = tx.isLate ? "🕐 Late Return" : (tx.condition === "Broken" ? "❌ Broken" : "⚠️ Damaged");
    html += `<tr><td>${tx.item}</td><td>${issueType}</td><td>${tx.returnDate || tx.dueDate}</td></tr>`;
  });
  
  if (studentTxs.filter(tx => tx.isLate || tx.condition === "Damaged" || tx.condition === "Broken").length === 0) {
    html += `<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:20px;">No issues recorded</td></tr>`;
  }
  
  html += `</tbody></table></div>`;
  
  document.getElementById("accountabilityContent").innerHTML = html;
  document.getElementById("studentAccountabilityModal").classList.add("open");
}

function loadAccountabilityTable() {
  const tbody = document.getElementById("accountabilityTableBody");
  const topCard = document.getElementById("topViolatorCard");
  if (!tbody) return;
  tbody.innerHTML = "";

  // Calculate status for all users
  const accountabilityData = allUsers.map(user => {
    const { status, violations, lateCount, damagedCount } = calculateStudentStatus(user.id);
    return { ...user, status, violations, lateCount, damagedCount };
  }).filter(u => u.violations > 0).sort((a,b) => b.violations - a.violations);

  // Display top violator card
  if (topCard) {
    if (accountabilityData.length > 0) {
      const topStudent = accountabilityData[0];
      const statusBadge = getStatusBadge(topStudent.status);
      topCard.innerHTML = `
        <div class="panel" style="background:linear-gradient(135deg,rgba(248,81,73,0.1) 0%,rgba(244,67,54,0.05) 100%);border:1px solid rgba(248,81,73,0.3);">
          <div class="panel-header" style="background:rgba(248,81,73,0.08);">
            <span class="panel-title"><span class="panel-title-icon">🚨</span> Top Violator</span>
          </div>
          <div class="panel-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:center;">
              <div>
                <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Student Name</div>
                <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:12px;">${topStudent.name}</div>
                <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Status</div>
                <div style="font-size:14px;font-weight:600;">${statusBadge}</div>
              </div>
              <div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                  <div style="background:rgba(248,81,73,0.12);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Total Violations</div>
                    <div style="font-size:24px;font-weight:800;color:var(--danger);">${topStudent.violations}</div>
                  </div>
                  <div style="background:rgba(255,152,0,0.12);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Late Returns</div>
                    <div style="font-size:20px;font-weight:700;color:#ff8f00;">${topStudent.lateCount}</div>
                  </div>
                  <div style="background:rgba(255,87,34,0.12);padding:12px;border-radius:8px;text-align:center;">
                    <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Damaged Items</div>
                    <div style="font-size:20px;font-weight:700;color:#e65100;">${topStudent.damagedCount}</div>
                  </div>
                  <button class="btn btn-danger" onclick="openAccountabilityModal('${topStudent.id}')" style="padding:8px;font-size:12px;">View Details →</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    } else {
      topCard.innerHTML = "";
    }
  }

  if (accountabilityData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><span class="empty-icon">✅</span>All students in good standing!</td></tr>`;
    return;
  }

  accountabilityData.forEach(user => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="mono-chip">${user.id}</span></td>
      <td>${user.name}</td>
      <td>${getStatusBadge(user.status)}</td>
      <td><strong style="color:var(--danger);">${user.violations}</strong></td>
      <td>${user.lateCount}</td>
      <td>${user.damagedCount}</td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="openAccountabilityModal('${user.id}')">📊 View</button>
      </td>`;
    tbody.appendChild(row);
  });
}

function filterAccountabilityTable() {
  const query = (document.getElementById("accountabilitySearch")?.value || "").toLowerCase();
  const status = document.getElementById("accountabilityStatusFilter")?.value || "";
  const tbody = document.getElementById("accountabilityTableBody");
  if (!tbody) return;

  const rows = tbody.querySelectorAll("tr");
  rows.forEach(row => {
    const idCell = row.querySelector("td:nth-child(1)")?.textContent.toLowerCase();
    const nameCell = row.querySelector("td:nth-child(2)")?.textContent.toLowerCase();
    const statusCell = row.querySelector("td:nth-child(3)")?.textContent.toLowerCase();
    
    const matchesQuery = !query || idCell.includes(query) || nameCell.includes(query);
    const matchesStatus = !status || statusCell.includes(status);
    
    row.style.display = matchesQuery && matchesStatus ? "" : "none";
  });
}

function resetAccountabilityFilter() {
  const si = document.getElementById("accountabilitySearch");
  const sf = document.getElementById("accountabilityStatusFilter");
  if (si) si.value = "";
  if (sf) sf.value = "";
  loadAccountabilityTable();
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

// ── Damage Report Modal ──────────────────────────────────────────────────────
function openDamageReportModal(txId, studentName, item) {
  document.getElementById("damageReportStudent").value = studentName;
  document.getElementById("damageReportItem").value = item;
  document.getElementById("damageReportTxId").value = txId;
  document.getElementById("damageReportSeverity").value = "Damaged";
  document.getElementById("damageReportDescription").value = "";
  const err = document.getElementById("damageReportError");
  if (err) { err.textContent = ""; err.style.display = "none"; }
  openModal("damageReportModal");
}

function submitDamageReport() {
  const txId = document.getElementById("damageReportTxId").value;
  const severity = document.getElementById("damageReportSeverity").value;
  const description = document.getElementById("damageReportDescription").value.trim();
  const errEl = document.getElementById("damageReportError");

  if (!description || description.length < 3) {
    errEl.textContent = "Description must be at least 3 characters.";
    errEl.style.display = "block";
    return;
  }

  const submitBtn = document.querySelector("#damageReportModal .btn-danger");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting…"; }

  const reportDate = getPHTDateString();

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({
      action: "logDamageReport",
      txId: txId,
      severity: severity,
      description: description,
      reportDate: reportDate,
      adminToken: getAdminToken()
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showNotification(data.message || "✅ Damage report submitted.", "success");
      closeModal("damageReportModal");
      loadDamagedItems();
      loadReturnRequests();
      loadTransactions();
    } else {
      errEl.textContent = data.message || "Failed to submit report.";
      errEl.style.display = "block";
    }
  })
  .catch(() => {
    errEl.textContent = "Network error while submitting report.";
    errEl.style.display = "block";
  })
  .finally(() => {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "📋 Submit Report"; }
  });
}