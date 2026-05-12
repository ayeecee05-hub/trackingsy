// ─────────────────────────────────────────────────────────────────────────────
// CTU Danao Equipment Borrowing System — script.js
//
// Three-step flow:
//   BORROW:  Student "Request Item"     → status = "Pending"
//            Admin clicks "Hand Over"   → status = "Borrowed"
//
//   RETURN:  Student clicks "↩ Return Item" → status = "Return Pending"
//            Admin clicks "Confirm Return"  → status = "Returned"
// ─────────────────────────────────────────────────────────────────────────────

const scriptURL = "https://script.google.com/macros/s/AKfycbyB9luieFgCbBJRsT4O2MzDGTLN0wbDa-eRQXWZcocYdLzk-erSqNhtZxsFIrCF871OTw/exec";


// ── Philippine Time (UTC+8) helpers ────────────────────────────────────────────
// Always derive the PHT date from Intl/toLocaleDateString so the result is
// correct regardless of the device's own timezone (PH phone, UTC server, etc.)
function getPHTDateString() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  // en-CA locale gives "YYYY-MM-DD" format natively
}
function addDaysToPHTString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Build as local date (no UTC shift) then add days via UTC to avoid DST jumps
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split("T")[0];
}

let currentUser      = null;
let allBorrowers     = [];

// ── Restore session on page refresh ──────────────────────────────────────────
(function restoreSession() {
  try {
    const saved = sessionStorage.getItem("currentUser");
    if (saved) {
      currentUser = JSON.parse(saved);
      // Use a flag so showPage knows this is a restore (not a fresh login)
      window._restoringSession = true;
    }
  } catch(e) { sessionStorage.removeItem("currentUser"); }
})();

// ── Borrower session timeout (10 minutes of inactivity) ──────────────────────
const BORROWER_SESSION_MS = 10 * 60 * 1000;
let   borrowerSessionTimer = null;

function resetBorrowerSession() {
  clearTimeout(borrowerSessionTimer);
  if (!currentUser) return;
  borrowerSessionTimer = setTimeout(() => {
    if (currentUser) {
      logoutUser(true);
    }
  }, BORROWER_SESSION_MS);
}

["click", "keydown", "touchstart"].forEach(evt =>
  document.addEventListener(evt, () => { if (currentUser) resetBorrowerSession(); }, { passive: true })
);

// ── Log out the current borrower ──────────────────────────────────────────────
function logoutUser(timedOut = false) {
  clearTimeout(borrowerSessionTimer);
  stopDashboardPoll();
  currentUser = null;
  sessionStorage.removeItem("currentUser");
  showPage("dashboardPage");
  showNotification(timedOut ? "Session expired. Please select your name again." : "Logged out.", "info");
}

// ── Pull-to-refresh (PWA native feel) ─────────────────────────────────────────
(function initPullToRefresh() {
  const THRESHOLD   = 72;  // px of pull needed to trigger
  const MAX_PULL    = 110; // max visual drag
  let startY        = 0;
  let pulling       = false;
  let pullDistance  = 0;

  // Create the PTR indicator element
  const ptr = document.createElement("div");
  ptr.id = "ptrIndicator";
  ptr.innerHTML = `<div class="ptr-arrow">↓</div><span class="ptr-label">Pull to refresh</span>`;
  ptr.style.cssText = [
    "position:fixed","top:0","left:0","right:0","z-index:9999",
    "display:flex","align-items:center","justify-content:center","gap:8px",
    "height:0px","overflow:hidden","transition:none",
    "background:var(--surface,#161b22)","border-bottom:1px solid var(--border,rgba(255,255,255,0.08))",
    "font-size:12px","color:var(--text3,rgba(230,237,243,0.42))",
    "pointer-events:none","will-change:height"
  ].join(";");
  document.body.prepend(ptr);

  function canPull() {
    // Only pull on the main dashboard pages (not login/modals)
    const userDash = document.getElementById("userDashboardPage");
    const mainDash = document.getElementById("dashboardPage");
    const isUserDash  = userDash && userDash.style.display !== "none";
    const isMainDash  = mainDash && mainDash.style.display !== "none";
    return (isUserDash || isMainDash) && window.scrollY <= 4;
  }

  document.addEventListener("touchstart", e => {
    if (!canPull()) return;
    startY = e.touches[0].clientY;
    pulling = false;
    pullDistance = 0;
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!canPull()) return;
    const deltaY = e.touches[0].clientY - startY;
    if (deltaY < 8) return; // ignore tiny movements
    pulling = true;
    pullDistance = Math.min(deltaY * 0.55, MAX_PULL); // dampen drag
    const h = Math.round(pullDistance);
    ptr.style.height = h + "px";

    const arrow = ptr.querySelector(".ptr-arrow");
    const label = ptr.querySelector(".ptr-label");
    if (pullDistance >= THRESHOLD) {
      if (arrow) { arrow.textContent = "↺"; arrow.style.transform = "rotate(180deg)"; }
      if (label) label.textContent = "Release to refresh";
      ptr.style.color = "var(--accent,#4fc3f7)";
    } else {
      if (arrow) { arrow.textContent = "↓"; arrow.style.transform = "none"; }
      if (label) label.textContent = "Pull to refresh";
      ptr.style.color = "var(--text3,rgba(230,237,243,0.42))";
    }
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    ptr.style.transition = "height 0.25s ease";
    ptr.style.height = "0px";

    if (pullDistance >= THRESHOLD) {
      const arrow = ptr.querySelector(".ptr-arrow");
      const label = ptr.querySelector(".ptr-label");
      if (arrow) arrow.textContent = "↺";
      if (label) label.textContent = "Refreshing…";
      ptr.style.height = "48px";
      ptr.style.color  = "var(--accent,#4fc3f7)";

      // Determine which page is active and refresh accordingly
      const userDash = document.getElementById("userDashboardPage");
      const isUserDash = userDash && userDash.style.display !== "none";

      if (isUserDash && currentUser) {
        loadUserDashboard();
        loadStockPanel();
      } else {
        loadBorrowers();
        loadStockPanel();
      }
      showNotification("Refreshed!", "success");

      // Collapse PTR bar after a moment
      setTimeout(() => {
        ptr.style.transition = "height 0.3s ease";
        ptr.style.height = "0px";
        if (arrow) arrow.style.transform = "none";
      }, 900);
    }

    setTimeout(() => { ptr.style.transition = "none"; pullDistance = 0; }, 400);
  });
})();


(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") {
    document.body.classList.remove("dark");
    document.getElementById("toggleTheme").textContent = "🌙";
  } else {
    document.body.classList.add("dark");
    document.getElementById("toggleTheme").textContent = "☀️";
  }
})();

document.getElementById("toggleTheme").addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  document.getElementById("toggleTheme").textContent = isDark ? "☀️" : "🌙";
});

// ── Toast notification (with optional undo action) ────────────────────────────
let _toastTimer = null;
let _toastUndoFn = null;

function showNotification(message, type = "info", undoLabel = null, undoFn = null) {
  const banner = document.getElementById("notification");
  if (!banner) return;

  // Clear any existing timer
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  _toastUndoFn = undoFn || null;

  // Build inner HTML
  if (undoLabel && undoFn) {
    banner.innerHTML = `
      <span class="toast-msg">${message}</span>
      <button class="toast-undo-btn" id="toastUndoBtn">${undoLabel}</button>`;
  } else {
    banner.innerHTML = `<span class="toast-msg">${message}</span>`;
  }

  banner.className     = type;
  banner.style.display = "flex";
  banner.style.top     = "20px";

  const undoBtn = document.getElementById("toastUndoBtn");
  if (undoBtn && undoFn) {
    undoBtn.addEventListener("click", () => {
      clearTimeout(_toastTimer);
      banner.style.top = "-100px";
      setTimeout(() => { banner.style.display = "none"; banner.innerHTML = ""; }, 400);
      undoFn();
      _toastUndoFn = null;
    });
  }

  _toastTimer = setTimeout(() => {
    banner.style.top = "-100px";
    setTimeout(() => { banner.style.display = "none"; banner.innerHTML = ""; }, 500);
  }, undoFn ? 6000 : 3000);
}

// ── Page navigation ───────────────────────────────────────────────────────────
function showPage(pageId) {
  ["dashboardPage", "userDashboardPage", "borrowPage", "returnPage"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === pageId ? "block" : "none";
  });
  if (pageId === "userDashboardPage") loadUserDashboard();
  if (pageId === "borrowPage")        { stopDashboardPoll(); populateBorrowSelect(); }
  if (pageId === "returnPage")        { stopDashboardPoll(); populateReturnSelect(); }
  // Silently refresh status badges whenever the main dashboard comes back into view
  if (pageId === "dashboardPage")     refreshStatusBadges();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Re-fetches history only (fast) and repaints card badges — no full page reload
function refreshStatusBadges() {
  fetch(scriptURL + "?action=getAllHistory")
    .then(r => r.json())
    .then(history => {
      borrowerStatusMap = computeStatusMap(Array.isArray(history) ? history : []);
      renderBorrowerPage();
    })
    .catch(() => {}); // fail silently — stale badges are better than an error
}

// ══════════════════════════════════════════════════════════════════════════════
// BORROWER CARDS — pagination (10 per page)
// ══════════════════════════════════════════════════════════════════════════════
const USERS_PER_PAGE    = 10;
let   usersPage         = 1;
let   filteredBorrowers = [];
let   borrowerActiveFilter = "all";  // "all" | "Overdue" | "Borrowed" | "Pending" | "az"

// Map of studentId → array of all active statuses (used to badge cards)
let borrowerStatusMap = {};

function computeStatusMap(history) {
  const priority = { "Overdue": 4, "Borrowed": 3, "Return Pending": 2, "Pending": 1 };
  const map = {};        // studentId → worst single status (for card badge)
  const allMap = {};     // studentId → Set of all active statuses
  const todayStr = getPHTDateString();
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);
  history.forEach(tx => {
    let status = tx.status;
    if (status === "Borrowed" && tx.dueDate) {
      const p = tx.dueDate.split("-");
      if (new Date(+p[0], +p[1] - 1, +p[2]) < today) status = "Overdue";
    }
    if (!priority[status]) return;
    // Track worst status for card badge
    const cur = map[tx.studentId];
    if (!cur || priority[status] > priority[cur]) map[tx.studentId] = status;
    // Track all active statuses for stats bar
    if (!allMap[tx.studentId]) allMap[tx.studentId] = new Set();
    allMap[tx.studentId].add(status);
  });
  // Attach allMap to map object so stats bar can use it
  map._allMap = allMap;
  return map;
}

function loadBorrowers() {
  Promise.all([
    fetch(scriptURL + "?action=getUsers").then(r => r.json()),
    fetch(scriptURL + "?action=getAllHistory").then(r => r.json())
  ])
  .then(([users, history]) => {
    borrowerStatusMap = computeStatusMap(Array.isArray(history) ? history : []);
    allBorrowers      = users;
    filteredBorrowers = users;
    usersPage         = 1;
    renderBorrowerPage();
    handleDeepLink(users);
  })
  .catch(() => showNotification("Error loading users.", "error"));
}

function renderBorrowerPage() {
  const container  = document.getElementById("usersContainer");
  const pagination = document.getElementById("usersPagination");
  const pageLabel  = document.getElementById("usersPageLabel");
  const prevBtn    = document.getElementById("usersPrevBtn");
  const nextBtn    = document.getElementById("usersNextBtn");

  container.innerHTML = "";

  // ── Update dashboard stats bar ────────────────────────────────────────────
  updateDashboardStatsBar();

  if (!filteredBorrowers || filteredBorrowers.length === 0) {
    container.innerHTML = `
      <div class="empty-state-full">
        <div class="empty-icon">👤</div>
        <p>No borrowers found.</p>
        <small>Try a different name or ID, or ask an admin to register you.</small>
      </div>`;
    if (pagination) pagination.style.display = "none";
    return;
  }

  const totalPages = Math.ceil(filteredBorrowers.length / USERS_PER_PAGE);
  if (usersPage > totalPages) usersPage = totalPages;

  const start     = (usersPage - 1) * USERS_PER_PAGE;
  const pageUsers = filteredBorrowers.slice(start, start + USERS_PER_PAGE);

  pageUsers.forEach(user => {
    const initials = user.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const status   = borrowerStatusMap[user.id];                       // worst status (for ring)
    const allStatuses = (borrowerStatusMap._allMap && borrowerStatusMap._allMap[user.id])
                          ? [...borrowerStatusMap._allMap[user.id]]
                          : (status ? [status] : []);
    const badgeMap = {
      "Overdue":        ["card-badge-overdue",  "Overdue"],
      "Borrowed":       ["card-badge-borrowed", "Borrowed"],
      "Return Pending": ["card-badge-return",   "Returning"],
      "Pending":        ["card-badge-pending",  "Pending"],
    };
    // Show a badge for every distinct active status (e.g. both Overdue + Borrowed)
    const badgeHTML = allStatuses
      .filter(s => badgeMap[s])
      .sort((a, b) => {
        const pri = { "Overdue": 4, "Borrowed": 3, "Return Pending": 2, "Pending": 1 };
        return (pri[b] || 0) - (pri[a] || 0);
      })
      .map(s => {
        const [cls, label] = badgeMap[s];
        return `<span class="card-status-badge ${cls}">${label}</span>`;
      })
      .join("");
    const card = document.createElement("div");
    card.className = "borrower-card" + (status === "Overdue" ? " card-overdue-ring" : "");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Select ${user.name}`);
    card.innerHTML = `
      <div class="borrower-avatar">${initials}</div>
      <h3>${user.name}</h3>
      ${badgeHTML}`;
    card.addEventListener("click",  () => openPinModal(user));
    card.addEventListener("keydown", e => { if (e.key === "Enter") openPinModal(user); });
    container.appendChild(card);
  });

  if (pagination) {
    if (totalPages > 1) {
      pagination.style.display = "flex";
      if (pageLabel) pageLabel.textContent = `Page ${usersPage} of ${totalPages}  (${filteredBorrowers.length} users)`;
      if (prevBtn)   prevBtn.disabled = usersPage === 1;
      if (nextBtn)   nextBtn.disabled = usersPage === totalPages;
    } else {
      pagination.style.display = "none";
    }
  }
}

function changeUsersPage(delta) {
  const totalPages = Math.ceil(filteredBorrowers.length / USERS_PER_PAGE);
  const next = usersPage + delta;
  if (next < 1 || next > totalPages) return;
  usersPage = next;
  renderBorrowerPage();
}

// ── Borrower search ───────────────────────────────────────────────────────────
// ── Shared helper: apply search + status filter ──────────────────────────────
function applyBorrowerFilter() {
  const q = (document.getElementById("borrowerSearch").value || "").toLowerCase();
  let list = allBorrowers.filter(u =>
    u.name.toLowerCase().includes(q) ||
    String(u.id).toLowerCase().includes(q)
  );

  if (borrowerActiveFilter === "az") {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  } else if (borrowerActiveFilter !== "all") {
    // Match if the student has the filtered status among ANY of their active transactions
    list = list.filter(u => {
      const allStatuses = borrowerStatusMap._allMap && borrowerStatusMap._allMap[u.id];
      if (allStatuses) return allStatuses.has(borrowerActiveFilter);
      return borrowerStatusMap[u.id] === borrowerActiveFilter;
    });
  }

  filteredBorrowers = list;
  usersPage = 1;
  renderBorrowerPage();
}

// ── Filter strip button handler ──────────────────────────────────────────────
function setBorrowerFilter(filter, btn) {
  borrowerActiveFilter = filter;
  document.querySelectorAll(".bfilter-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  applyBorrowerFilter();
}

document.getElementById("borrowerSearch").addEventListener("input", () => {
  applyBorrowerFilter();
});

// ── PIN modal ─────────────────────────────────────────────────────────────────
function openPinModal(user) {
  currentUser = null;
  document.getElementById("pinModalTitle").textContent = `Hello, ${user.name}`;
  document.getElementById("pinInput").value = "";
  document.getElementById("pinError").style.display = "none";
  document.getElementById("pinModal").style.display = "flex";
  setTimeout(() => document.getElementById("pinInput").focus(), 50);

  document.getElementById("pinSubmitBtn").onclick = () => verifyPin(user);
  document.getElementById("pinCancelBtn").onclick = () => {
    document.getElementById("pinModal").style.display = "none";
  };
  document.getElementById("pinInput").onkeydown = e => {
    if (e.key === "Enter") verifyPin(user);
  };
}

function verifyPin(user) {
  const entered  = document.getElementById("pinInput").value.trim();
  const expected = String(user.id).slice(-4);
  if (entered === expected) {
    document.getElementById("pinModal").style.display = "none";
    currentUser = user;
    sessionStorage.setItem("currentUser", JSON.stringify(user));
    resetBorrowerSession();
    showPage("userDashboardPage");
  } else {
    document.getElementById("pinError").style.display = "block";
    document.getElementById("pinInput").value = "";
    document.getElementById("pinInput").focus();
  }
}

// ── User dashboard polling (auto-refresh while Pending items exist) ──────────
// Polls every 15 s when the student has a Pending or Return Pending item so
// the status updates automatically once the admin confirms, no manual refresh.
let _dashPollTimer = null;

function startDashboardPoll() {
  stopDashboardPoll();
  _dashPollTimer = setInterval(() => {
    // Only poll when the userDashboardPage is actually visible
    const page = document.getElementById("userDashboardPage");
    if (page && page.style.display !== "none" && currentUser) {
      loadUserDashboard();
    } else {
      stopDashboardPoll();
    }
  }, 15000);
}

function stopDashboardPoll() {
  if (_dashPollTimer) { clearInterval(_dashPollTimer); _dashPollTimer = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// BORROW HISTORY — paginated table with filter
// ══════════════════════════════════════════════════════════════════════════════
const HISTORY_PER_PAGE  = 5;
let   historyPage       = 1;
let   historyFilter     = "all";
let   allHistoryRecords = [];

const HISTORY_ICONS = {
  "Projector":"📽️","Laptop":"💻","Camera":"📷","Multimeter":"📐",
  "Microscope":"🔬","Tablet":"📱","Router":"📡","Headset":"🎧",
  "Soldering Iron":"🛠️","Cable":"🔌","Keyboard":"⌨️","Mouse":"🖱️",
  "Speaker":"🔊","Monitor":"🖥️","Printer":"🖨️"
};

function getHistoryIcon(name) {
  for (const key of Object.keys(HISTORY_ICONS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return HISTORY_ICONS[key];
  }
  return "📦";
}

function filterHistory(filter, btn) {
  historyFilter = filter;
  historyPage   = 1;
  document.querySelectorAll(".history-filter-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderHistoryTable();
}

function changeHistoryPage(delta) {
  const records    = getFilteredHistory();
  const totalPages = Math.ceil(records.length / HISTORY_PER_PAGE);
  const next       = historyPage + delta;
  if (next < 1 || next > totalPages) return;
  historyPage = next;
  renderHistoryTable();
}

function getFilteredHistory() {
  // Only show "terminal" statuses in history — exclude active/pending items
  const terminalStatuses = ["Returned", "Returned (Late)", "Rejected"];
  let records = allHistoryRecords.filter(tx => terminalStatuses.includes(tx.status));
  if (historyFilter !== "all") records = records.filter(tx => tx.status === historyFilter);
  // Most recent first (sort by borrowDate desc)
  return records.slice().sort((a, b) => (b.borrowDate || "").localeCompare(a.borrowDate || ""));
}

function renderHistoryTable() {
  const wrap       = document.getElementById("historyTableWrap");
  const pagination = document.getElementById("historyPagination");
  const pageLabel  = document.getElementById("historyPageLabel");
  const prevBtn    = document.getElementById("historyPrevBtn");
  const nextBtn    = document.getElementById("historyNextBtn");
  const countBadge = document.getElementById("historyCount");

  const records    = getFilteredHistory();
  const total      = allHistoryRecords.filter(tx => ["Returned", "Returned (Late)", "Rejected"].includes(tx.status)).length;
  if (countBadge) countBadge.textContent = total + " record" + (total !== 1 ? "s" : "");

  if (records.length === 0) {
    wrap.innerHTML = `<div class="history-empty">No ${historyFilter === "all" ? "" : historyFilter.toLowerCase() + " "}records yet.</div>`;
    if (pagination) pagination.style.display = "none";
    return;
  }

  const totalPages = Math.ceil(records.length / HISTORY_PER_PAGE);
  if (historyPage > totalPages) historyPage = totalPages;
  const start = (historyPage - 1) * HISTORY_PER_PAGE;
  const page  = records.slice(start, start + HISTORY_PER_PAGE);

  const pillClass = s => {
    switch(s) {
      case "Returned":        return "returned";
      case "Returned (Late)": return "returned-late";
      case "Rejected":        return "rejected";
      case "Borrowed":        return "borrowed";
      case "Overdue":         return "overdue";
      case "Pending":         return "pending";
      case "Return Pending":  return "ret-pend";
      default:                return "pending";
    }
  };

  const rows = page.map(tx => {
    const icon     = getHistoryIcon(tx.item);
    const pill     = pillClass(tx.status);
    const lateTag  = tx.isLate ? `<span class="history-late-tag">⚠ Late</span>` : "";
    const retDate  = tx.returnDate || "—";
    return `
      <tr>
        <td><span class="history-item-name">${icon} ${tx.item}</span></td>
        <td><span class="history-date">${tx.borrowDate || "—"}</span></td>
        <td><span class="history-date">${tx.dueDate || "—"}</span></td>
        <td><span class="history-date">${retDate}</span></td>
        <td><span class="history-pill ${pill}">${tx.status}</span>${lateTag}</td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `
    <table class="history-table" aria-label="Borrow history">
      <thead>
        <tr>
          <th>Item</th>
          <th>Borrowed</th>
          <th>Due</th>
          <th>Returned</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  if (totalPages > 1) {
    if (pagination) {
      pagination.style.display = "flex";
      if (prevBtn)   prevBtn.disabled      = historyPage === 1;
      if (nextBtn)   nextBtn.disabled      = historyPage === totalPages;
      if (pageLabel) pageLabel.textContent = `${historyPage} / ${totalPages}`;
    }
  } else {
    if (pagination) pagination.style.display = "none";
  }
}

// ── User dashboard ────────────────────────────────────────────────────────────
function loadUserDashboard() {
  if (!currentUser) return;
  document.getElementById("profileAvatar").textContent =
    currentUser.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  document.getElementById("profileName").textContent = currentUser.name;
  document.getElementById("profileId").textContent   = "ID: " + currentUser.id;

  fetch(scriptURL + "?action=getHistory&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(history => {
      const todayStr = getPHTDateString();
      const [ty, tm, td] = todayStr.split("-").map(Number);
      const today = new Date(ty, tm - 1, td);

      // Store full history for the history table
      allHistoryRecords = history;
      historyPage       = 1;
      renderHistoryTable();

      const borrowed      = history.filter(tx => tx.status === "Borrowed" || tx.status === "Overdue");
      const pending       = history.filter(tx => tx.status === "Pending");
      const returnPending = history.filter(tx => tx.status === "Return Pending");

      // Build cancel buttons for pending requests in the borrower dashboard
      const pendingSection = document.getElementById("pendingSection");
      const pendingList = document.getElementById("pendingList");
      if (pending.length > 0) {
        fetch(scriptURL + "?action=getPendingRequests")
          .then(res => res.json())
          .then(allPending => {
            const userPending = Array.isArray(allPending)
              ? allPending.filter(p => String(p.studentId) === String(currentUser.id))
              : [];

            pendingList.innerHTML = "";
            if (userPending.length > 0) {
              userPending.forEach(tx => {
                const li = document.createElement("li");
                li.className = "pending-card-item";
                li.innerHTML = `
                  <div class="pending-card-content">
                    <div class="pending-card-info">
                      <div class="pending-card-name">📋 ${tx.item}</div>
                      <div class="pending-card-meta">Requested ${tx.borrowDate} · Due ${tx.dueDate || "—"}</div>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="cancelPendingRequest(${tx.rowIndex}, '${tx.item.replace(/'/g, "\\'")}')">Cancel</button>
                  </div>`;
                pendingList.appendChild(li);
              });
              pendingSection.style.display = "block";
            } else {
              pendingList.innerHTML = `<li style='color:var(--text-muted);text-align:center;border-left:none;background:none;padding:12px 0;'>No cancellable pending requests found.</li>`;
              pendingSection.style.display = "none";
            }
          })
          .catch(() => {
            pendingSection.style.display = "none";
            pendingList.innerHTML = `<li style='color:var(--text-muted);'>Unable to load pending request actions right now.</li>`;
          });
      } else {
        pendingSection.style.display = "none";
      }

      // Reclassify any "Borrowed" item whose due date has passed as overdue
      // (the spreadsheet only updates via the admin; this keeps the borrower view accurate)
      const overdue = borrowed.filter(tx => {
        if (!tx.dueDate) return false;
        const p = tx.dueDate.split("-");
        return new Date(+p[0], +p[1] - 1, +p[2]) < today;
      });

      const dueSoon = borrowed.filter(tx => {
        if (!tx.dueDate) return false;
        const p    = tx.dueDate.split("-");
        const diff = Math.ceil((new Date(+p[0], +p[1] - 1, +p[2]) - today) / 86400000);
        return diff >= 0 && diff <= 2;
      });

      // Stats
      document.getElementById("statCurrent").textContent = borrowed.length;
      document.getElementById("statPending").textContent = pending.length;
      document.getElementById("statDueSoon").textContent = dueSoon.length;
      document.getElementById("statOverdue").textContent = overdue.length;

      // Profile stats
      const totalBorrows = history.filter(tx =>
        tx.status !== "Pending" && tx.status !== "Rejected"
      ).length;
      document.getElementById("profileTotal").textContent = totalBorrows;

      // On-time rate based on ALL completed returns (both "Returned" and "Returned (Late)")
      const completedReturns = history.filter(tx =>
        tx.status === "Returned" || tx.status === "Returned (Late)"
      );
      const lateReturns = completedReturns.filter(tx =>
        tx.status === "Returned (Late)" || tx.isLate === true || tx.isLate === "TRUE"
      );
      const onTimeRate = completedReturns.length > 0
        ? Math.round(((completedReturns.length - lateReturns.length) / completedReturns.length) * 100) + "%"
        : "—";
      document.getElementById("profileOnTime").textContent  = onTimeRate;
      document.getElementById("profileOverdue").textContent = overdue.length;
      document.getElementById("profileOverdue").className   =
        "profile-stat-value" + (overdue.length > 0 ? " profile-stat-overdue-active" : " profile-stat-overdue");

      // Overdue alert
      const alertBox = document.getElementById("overdueAlert");
      if (overdue.length > 0) {
        alertBox.style.display = "block";
        document.getElementById("overdueAlertList").innerHTML =
          overdue.map(tx => `<div class="overdue-alert-item">📦 ${tx.item} — due ${tx.dueDate}</div>`).join("");
      } else {
        alertBox.style.display = "none";
      }

      // ════════════════════════════════════════════════════════════════════
      // ✅ BIG OVERDUE ALERT BANNER (new feature)
      // ════════════════════════════════════════════════════════════════════
      const bigOverdueAlert = document.getElementById("bigOverdueAlert");
      if (overdue.length > 0 && bigOverdueAlert) {
        document.getElementById("overdueItemCount").textContent = overdue.length;
        bigOverdueAlert.style.display = "block";
      } else if (bigOverdueAlert) {
        bigOverdueAlert.style.display = "none";
      }

      // ════════════════════════════════════════════════════════════════════
      // ✅ BORROWING STATUS CARD (new feature)
      // Show how many more items can be borrowed
      // ════════════════════════════════════════════════════════════════════
      const MAX_BORROW_LIMIT = 5; // Maximum items a student can have at once
      const currentlyOut = borrowed.length;
      const canBorrow = Math.max(0, MAX_BORROW_LIMIT - currentlyOut);
      
      const statusCanBorrow = document.getElementById("statusCanBorrow");
      const statusCurrentOut = document.getElementById("statusCurrentOut");
      const statusHealth = document.getElementById("statusHealth");
      
      if (statusCanBorrow) statusCanBorrow.textContent = canBorrow;
      if (statusCurrentOut) statusCurrentOut.textContent = currentlyOut;
      
      // Determine account health status
      if (statusHealth) {
        if (overdue.length > 0) {
          statusHealth.textContent = "⚠️ Overdue";
          statusHealth.style.color = "var(--highlight)";
        } else if (accountabilityStatus === "suspended") {
          statusHealth.textContent = "🔴 Suspended";
          statusHealth.style.color = "var(--highlight)";
        } else if (accountabilityStatus === "caution") {
          statusHealth.textContent = "🟡 Caution";
          statusHealth.style.color = "var(--warning)";
        } else {
          statusHealth.textContent = "✅ Good";
          statusHealth.style.color = "var(--success)";
        }
      }

      // ── Accountability Status Alert ────────────────────────────────────────
      // Calculate student accountability status based on late returns + damaged items
      const studentId = currentUser.id;
      const lateReturnCount = history.filter(tx => 
        (tx.status === "Returned (Late)" || tx.isLate === true || tx.isLate === "TRUE")
      ).length;
      const damagedCount = history.filter(tx => 
        tx.condition === "Damaged" || tx.condition === "Broken"
      ).length;
      const totalViolations = lateReturnCount + damagedCount;

      let accountabilityStatus = "trusted";
      if (totalViolations >= 3) accountabilityStatus = "suspended";
      else if (totalViolations >= 1) accountabilityStatus = "caution";

      const accountabilityAlert = document.getElementById("accountabilityAlert");
      if (accountabilityStatus !== "trusted") {
        accountabilityAlert.style.display = "block";
        const statusBadges = {
          "caution": { icon: "🟡", title: "Account Caution", color: "#f5a623" },
          "suspended": { icon: "🔴", title: "Account Suspended", color: "#f05454" }
        };
        const statusInfo = statusBadges[accountabilityStatus];
        document.getElementById("accountabilityAlertIcon").textContent = statusInfo.icon;
        document.getElementById("accountabilityAlertTitle").textContent = statusInfo.title;
        document.getElementById("accountabilityAlertTitle").style.color = statusInfo.color;
        
        const detailsHtml = `
          <div class="accountability-stat-row">
            <span class="accountability-stat-item">Late Returns: <span class="accountability-stat-value">${lateReturnCount}</span></span>
            <span class="accountability-stat-item">Damaged Items: <span class="accountability-stat-value">${damagedCount}</span></span>
          </div>
          <div class="accountability-stat-item" style="font-size: 11px; color: var(--text-muted);">
            ${accountabilityStatus === "suspended" 
              ? "⚠️ Your account is suspended due to multiple violations. Please contact the admin." 
              : "⚠️ Please be more careful with borrowed items and return them on time."}
          </div>`;
        document.getElementById("accountabilityAlertDetails").innerHTML = detailsHtml;
      } else {
        accountabilityAlert.style.display = "none";
      }

      // ── Due-soon reminder banner ────────────────────────────────────────
      // Show a prominent yellow banner for items due within 2 days (but not overdue)
      const dueSoonBanner = document.getElementById("dueSoonBanner");
      if (dueSoon.length > 0) {
        const reminderText = dueSoon.map(tx => {
          const p = tx.dueDate.split("-");
          const due = new Date(+p[0], +p[1] - 1, +p[2]);
          const diff = Math.ceil((due - today) / 86400000);
          const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : `in ${diff} days`;
          return `<strong>${tx.item}</strong> is due ${when}!`;
        }).join(" · ");

        if (!dueSoonBanner) {
          // Create banner if it doesn't exist yet
          const banner = document.createElement("div");
          banner.id = "dueSoonBanner";
          banner.className = "due-soon-banner";
          banner.innerHTML = `
            <div class="due-soon-banner-inner">
              <span class="due-soon-banner-icon">⏰</span>
              <div class="due-soon-banner-body">
                <div class="due-soon-banner-title">Reminder</div>
                <div class="due-soon-banner-msg">${reminderText}</div>
              </div>
              <button class="due-soon-banner-close" onclick="this.parentElement.parentElement.style.display='none'" aria-label="Dismiss reminder">✕</button>
            </div>`;
          // Insert before the borrowed items list
          const borrowedList = document.getElementById("borrowedList");
          borrowedList.parentNode.insertBefore(banner, borrowedList);
        } else {
          dueSoonBanner.style.display = "block";
          dueSoonBanner.querySelector(".due-soon-banner-msg").innerHTML = reminderText;
        }
      } else if (dueSoonBanner) {
        dueSoonBanner.style.display = "none";
      }

      // ── Active items — unified borrow flow stepper list ──────────────────
      // Combines borrowed + pending + return-pending into one visual tracker.
      // Each card shows a 4-step progress stepper so the student always knows
      // exactly where their transaction is in the lifecycle.
      const borrowedList = document.getElementById("borrowedList");
      borrowedList.innerHTML = "";

      // Gather all active transactions (not yet returned/rejected)
      // Include "Overdue" explicitly — the spreadsheet sets this status server-side
      // via the daily checkOverdue trigger, so we must handle it here too.
      const activeItems = history.filter(tx =>
        ["Borrowed", "Overdue", "Pending", "Return Pending"].includes(tx.status)
      );

      if (activeItems.length === 0) {
        borrowedList.innerHTML = `<li style="text-align:center;color:var(--text-muted);border-left:none;background:none;padding:18px 0;">No active items right now.</li>`;
      } else {
        activeItems.forEach(tx => {
          const p       = (tx.dueDate || "").split("-");
          const dueDate = p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
          const diff    = dueDate ? Math.ceil((dueDate - today) / 86400000) : null;
          const isOverdue = diff !== null && diff < 0 && tx.status === "Borrowed";

          const effectiveStatus = isOverdue ? "Overdue" : tx.status;
          const { badgeClass, badgeText, barClass, barWidth } = getDueBadge(diff);

          // Flow card variant CSS class
          const cardVariant = {
            "Pending":        "flow-pending",
            "Borrowed":       isOverdue ? "flow-overdue" : "flow-borrowed",
            "Overdue":        "flow-overdue",
            "Return Pending": "flow-ret-pending"
          }[effectiveStatus] || "flow-borrowed";

          // ── 4-step stepper config ─────────────────────────────────────────
          // step-done = completed, step-active = current, (empty) = future
          const steps = buildFlowSteps(effectiveStatus);

          // Status bar hint text
          const hintMap = {
            "Pending":        "⏳ Waiting for admin to hand over the item",
            "Borrowed":       diff === null ? "Item currently with you" : diff === 0 ? "⚠️ Due today — please return!" : diff > 0 ? `${diff} day${diff !== 1 ? "s" : ""} remaining before due date` : "",
            "Overdue":        `⚠️ ${Math.abs(diff)}d overdue — please return immediately`,
            "Return Pending": "↩ Waiting for admin to confirm receipt"
          };
          const hintText  = hintMap[effectiveStatus] || "";

          const statusLabel = {
            "Pending":        "Request Submitted",
            "Borrowed":       isOverdue ? "⚠️ Overdue" : "✅ Item With You",
            "Overdue":        "⚠️ Overdue",
            "Return Pending": "↩ Return Submitted"
          }[effectiveStatus] || effectiveStatus;

          const icon = getHistoryIcon(tx.item);
          const dateInfo = tx.status === "Pending"
            ? `Requested ${tx.borrowDate} · Due ${tx.dueDate || "—"}`
            : tx.status === "Return Pending"
            ? `Borrowed ${tx.borrowDate} · Returning ${tx.returnDate || "today"}`
            : `Borrowed ${tx.borrowDate} · Due ${tx.dueDate || "—"}`;

          const dueProgressHTML = tx.status === "Borrowed" && diff !== null
            ? `<div class="flow-due-track"><div class="due-progress-bar ${barClass}" style="width:${barWidth}%"></div></div>`
            : "";

          const li = document.createElement("li");
          li.style.cssText = "list-style:none;padding:0;margin:0;border:none;background:none;";
          li.innerHTML = `
            <div class="borrow-flow-card ${cardVariant}">
              <div class="flow-card-header">
                <div class="flow-card-left">
                  <span class="borrow-flow-name">${icon} ${tx.item}</span>
                  <span class="borrow-flow-dates">${dateInfo}</span>
                </div>
                ${tx.status === "Borrowed" || tx.status === "Overdue" ? `<span class="due-badge ${badgeClass}">${badgeText}</span>` : ""}
              </div>
              <div class="flow-card-footer">
                <div class="flow-stepper-compact">${steps}</div>
                <div class="borrow-flow-status-bar" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                  <div>
                    <span class="flow-status-label">${statusLabel}</span>
                    <span class="borrow-flow-status-hint">${hintText}</span>
                  </div>
                  ${(tx.status === "Borrowed" || tx.status === "Overdue") ? `<button class="quick-return-btn" onclick="showPage('returnPage')">↩ Quick Return</button>` : ""}
                </div>
              </div>
            </div>`;
          borrowedList.appendChild(li);
        });
      }

      // Show return pending items as a separate card section if any exist
      const returnPendingSection = document.getElementById("returnPendingSection");
      const returnPendingList = document.getElementById("returnPendingList");
      if (returnPending.length > 0 && returnPendingList) {
        returnPendingList.innerHTML = "";
        returnPending.forEach(tx => {
          const li = document.createElement("li");
          li.className = "return-pending-item";
          li.innerHTML = `
            <div class="pending-card-content">
              <div class="pending-card-info">
                <div class="pending-card-name">↩ ${tx.item}</div>
                <div class="pending-card-meta">Returning ${tx.returnDate || "today"} · Borrowed ${tx.borrowDate}</div>
              </div>
            </div>`;
          returnPendingList.appendChild(li);
        });
        if (returnPendingSection) returnPendingSection.style.display = "block";
      } else {
        if (returnPendingSection) returnPendingSection.style.display = "none";
      }

      // ── Auto-poll logic ───────────────────────────────────────────────────
      const needsPoll = pending.length > 0 || returnPending.length > 0;
      if (needsPoll) {
        if (!_dashPollTimer) startDashboardPoll();
      } else {
        stopDashboardPoll();
      }
    })
    .catch(() => showNotification("Error loading your data.", "error"));
}

function getDueBadge(daysLeft) {
  if (daysLeft === null) return { badgeClass: "due-ok",     badgeText: "—",                           barClass: "due-ok",      barWidth: 50  };
  if (daysLeft < 0)     return { badgeClass: "due-overdue", badgeText: `${Math.abs(daysLeft)}d overdue`, barClass: "due-overdue", barWidth: 100 };
  if (daysLeft === 0)   return { badgeClass: "due-today",   badgeText: "Due today",                   barClass: "due-today",   barWidth: 95  };
  if (daysLeft <= 2)    return { badgeClass: "due-soon",    badgeText: `${daysLeft}d left`,            barClass: "due-soon",    barWidth: 70  };
  return { badgeClass: "due-ok", badgeText: `${daysLeft}d left`, barClass: "due-ok", barWidth: Math.min(60, daysLeft * 8) };
}

// ── Borrow Flow Stepper ───────────────────────────────────────────────────────
// Builds the 4-step HTML stepper for the given transaction status.
// Steps: 1=Request Submitted, 2=Admin Hands Over, 3=Return Submitted, 4=Admin Confirms
function buildFlowSteps(status) {
  // step state: "done" | "active" | ""
  const stateMap = {
    "Pending":        ["active", "",       "",       ""],
    "Borrowed":       ["done",   "active", "",       ""],
    "Overdue":        ["done",   "active", "",       ""],
    "Return Pending": ["done",   "done",   "active", ""],
    "Returned":       ["done",   "done",   "done",   "done"]
  };
  const states = stateMap[status] || ["active", "", "", ""];

  const stepDefs = [
    { label: "Request\nSubmitted",   icon: "1" },
    { label: "Admin\nHands Over",    icon: "2" },
    { label: "Return\nSubmitted",    icon: "3" },
    { label: "Admin\nConfirms",      icon: "4" }
  ];

  return stepDefs.map((s, i) => {
    const state     = states[i];
    const cls       = state ? `step-${state}` : "";
    const dotInner  = state === "done" ? "✓" : s.icon;
    const labelHtml = s.label.replace("\n", "<br>");
    return `
      <div class="flow-step ${cls}">
        <div class="flow-dot">${dotInner}</div>
        <span class="flow-label">${labelHtml}</span>
      </div>`;
  }).join("");
}

// ── Populate borrow select ────────────────────────────────────────────────────
function populateBorrowSelect() {
  const todayStr = getPHTDateString();
  document.getElementById("borrowDate").value = todayStr;

  // Default due date = today + 3 days; min = tomorrow, max = today + 30 days
  const dueDateInput = document.getElementById("borrowDueDate");
  dueDateInput.value = addDaysToPHTString(todayStr, 3);
  dueDateInput.min   = addDaysToPHTString(todayStr, 1);
  dueDateInput.max   = addDaysToPHTString(todayStr, 30);

  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      const select    = document.getElementById("borrowItem");
      select.innerHTML = "";
      // Normalize names: trim & collapse spaces; merge duplicates by name
      const normalized = {};
      items.forEach(it => {
        const key = it.name.trim().replace(/\s+/g, " ");
        if (!normalized[key]) normalized[key] = 0;
        normalized[key] += Number(it.quantity) || 0;
      });
      const available = Object.entries(normalized).filter(([, qty]) => qty > 0);
      if (available.length === 0) {
        select.innerHTML = `<option disabled selected>No items available</option>`;
        return;
      }
      available.forEach(([name, qty]) => {
        const opt = document.createElement("option");
        opt.value       = name;
        opt.textContent = `${name} (${qty} available)`;
        select.appendChild(opt);
      });
    })
    .catch(() => showNotification("Error loading items.", "error"));
}

// ── Populate return select — only shows items currently "Borrowed" ─────────
// Items already in "Return Pending" state are excluded so the student
// cannot submit a duplicate return request.
function populateReturnSelect() {
  document.getElementById("returnDate").value = getPHTDateString();
  if (!currentUser) return;

  fetch(scriptURL + "?action=getHistory&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(history => {
      // Show items with status "Borrowed" OR "Overdue"
      // "Return Pending" items are already submitted and awaiting admin
      const eligible = history.filter(tx => tx.status === "Borrowed" || tx.status === "Overdue");
      const select   = document.getElementById("returnItem");
      select.innerHTML = "";

      if (eligible.length === 0) {
        select.innerHTML = `<option disabled selected>No items available to return</option>`;
        return;
      }
      eligible.forEach(tx => {
        const opt = document.createElement("option");
        opt.value       = tx.item;
        opt.textContent = `${tx.item} (due ${tx.dueDate})`;
        select.appendChild(opt);
      });
    })
    .catch(() => showNotification("Error loading items.", "error"));
}

// ── Borrow form — submits a Pending request ───────────────────────────────────
document.getElementById("borrowForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("No user selected.", "error"); return; }

  const item       = document.getElementById("borrowItem").value;
  const borrowDate = document.getElementById("borrowDate").value;
  const dueDate    = document.getElementById("borrowDueDate").value;

  if (!dueDate) {
    showNotification("Please select an expected return date.", "error");
    return;
  }
  if (dueDate <= borrowDate) {
    showNotification("Expected return date must be after the borrow date.", "error");
    return;
  }

  // Calculate days for display in confirm modal
  // Parse as local date (split "-") to avoid UTC midnight off-by-one
  const [by, bm, bd] = borrowDate.split("-").map(Number);
  const [dy, dm, dd] = dueDate.split("-").map(Number);
  const b = new Date(by, bm - 1, bd), d = new Date(dy, dm - 1, dd);
  const days = Math.round((d - b) / 86400000);

  showConfirmModal("📋", "Submit Borrow Request",
    `Request <strong>${item}</strong>?<br>
     <small style="color:var(--text-muted);">
       Borrow date: ${borrowDate} · Expected return: ${dueDate} (${days} day${days !== 1 ? "s" : ""})<br>
       Status will be <strong style="color:var(--warning);">Pending</strong> until the admin hands over the item.
     </small>`,
    () => {
      // Immediately go to dashboard and show an undo-capable toast
      showPage("userDashboardPage");

      let wasCancelled = false;
      // We need a reference to the pending request to cancel it
      let submittedTx = null;

      showNotification(`📋 Borrow request for "${item}" submitted!`, "success",
        "Cancel", () => {
          wasCancelled = true;
          if (submittedTx) {
            // Cancel by calling rejectBorrow on our own pending request
            fetch(scriptURL, {
              method: "POST",
              body: JSON.stringify({
                action: "rejectBorrow",
                studentId: currentUser.id,
                item: submittedTx.item,
                rowIndex: submittedTx.rowIndex
              })
            })
            .then(r => r.json())
            .then(data => {
              if (data.success) {
                showNotification(`Request for "${item}" cancelled.`, "info");
                loadUserDashboard();
              } else {
                showNotification("Could not cancel — the admin may have already processed it.", "error");
                loadUserDashboard();
              }
            })
            .catch(() => showNotification("Network error. Request may still be active.", "error"));
          } else {
            // Request hasn't come back yet — flag it for cancellation on arrival
            showNotification(`Cancelling request for "${item}"…`, "info");
          }
        }
      );

      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({ action: "requestBorrow", studentId: currentUser.id, item, borrowDate, dueDate })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          if (wasCancelled) {
            // Undo was tapped before the request came back — cancel immediately
            fetch(scriptURL + "?action=getPendingRequests")
              .then(r => r.json())
              .then(pending => {
                const match = Array.isArray(pending) && pending.find(p =>
                  String(p.studentId) === String(currentUser.id) &&
                  p.item.toLowerCase() === item.toLowerCase()
                );
                if (match) {
                  return fetch(scriptURL, {
                    method: "POST",
                    body: JSON.stringify({ action: "rejectBorrow", studentId: currentUser.id, item: match.item, rowIndex: match.rowIndex })
                  }).then(r => r.json());
                }
              })
              .then(() => {
                showNotification(`Request for "${item}" cancelled.`, "info");
                loadUserDashboard();
              })
              .catch(() => loadUserDashboard());
          } else {
            // Store for potential undo
            fetch(scriptURL + "?action=getPendingRequests")
              .then(r => r.json())
              .then(pending => {
                submittedTx = Array.isArray(pending) && pending.find(p =>
                  String(p.studentId) === String(currentUser.id) &&
                  p.item.toLowerCase() === item.toLowerCase()
                );
              })
              .catch(() => {});
            loadUserDashboard();
          }
        } else {
          showNotification(data.message || "Request failed.", "error");
        }
      })
      .catch(() => showNotification("Network error. Please try again.", "error"));
    }
  );
});

function cancelPendingRequest(rowIndex, item) {
  if (!currentUser) return;
  if (!confirm(`Cancel borrow request for "${item}"?`)) return;

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({
      action: "rejectBorrow",
      studentId: currentUser.id,
      item: item,
      rowIndex: rowIndex
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showNotification(`Request for "${item}" cancelled.`, "info");
      loadUserDashboard();
    } else {
      showNotification(data.message || "Unable to cancel request.", "error");
    }
  })
  .catch(() => showNotification("Network error. Unable to cancel request.", "error"));
}

// ── Return form — submits a "Return Pending" request ─────────────────────────
// This sets the item status to "Return Pending" in the spreadsheet.
// The admin then physically receives the item and clicks "Confirm Return"
// in the Returns tab to finalise it (status → "Returned", stock += 1).
document.getElementById("returnForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("No user selected.", "error"); return; }

  const item       = document.getElementById("returnItem").value;
  const returnDate = document.getElementById("returnDate").value;

  if (!item) {
    showNotification("Please select an item to return.", "error");
    return;
  }

  showConfirmModal("↩", "Submit Return Request",
    `Submit a return request for <strong>${item}</strong>?<br>
     <small style="color:var(--text-muted);">
       Please hand the item to the admin.<br>
       Status will update to <strong style="color:var(--success);">Returned</strong> once the admin confirms receipt.
     </small>`,
    () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({
          action:     "requestReturn",   // sets status = "Return Pending"
          studentId:  currentUser.id,
          item,
          returnDate
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showNotification("Return request submitted! Hand the item to the admin. ⏳", "success");
          showPage("userDashboardPage");
        } else {
          showNotification(data.message || "Return request failed.", "error");
        }
      })
      .catch(() => showNotification("Network error. Please try again.", "error"));
    }
  );
});

// ── Confirm modal ─────────────────────────────────────────────────────────────
function showConfirmModal(icon, title, message, onConfirm) {
  document.getElementById("confirmIcon").textContent    = icon;
  document.getElementById("confirmTitle").textContent   = title;
  document.getElementById("confirmMessage").innerHTML   = message;
  document.getElementById("confirmModal").style.display = "flex";
  document.getElementById("confirmYes").onclick = () => {
    document.getElementById("confirmModal").style.display = "none";
    onConfirm();
  };
  document.getElementById("confirmNo").onclick = () => {
    document.getElementById("confirmModal").style.display = "none";
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// STOCK PANEL — pagination (5 items per page)
// ══════════════════════════════════════════════════════════════════════════════
const STOCK_PER_PAGE = 5;
let   allStockItems  = [];
let   stockPage      = 1;

const STOCK_ICONS = {
  "Projector":"📽️","Laptop":"💻","Camera":"📷","Multimeter":"📐",
  "Microscope":"🔬","Tablet":"📱","Router":"📡","Headset":"🎧",
  "Soldering Iron":"🛠️","Cable":"🔌","Keyboard":"⌨️","Mouse":"🖱️",
  "Speaker":"🔊","Monitor":"🖥️","Printer":"🖨️","default":"📦"
};

function loadStockPanel() {
  const list = document.getElementById("stockList");
  list.innerHTML = `
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>`;

  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      // Count items by name (itemName now)
      // Items are tracked individually by ItemID, so we count how many of each name exist
      const normalized = {};
      (items || []).forEach(it => {
        const key = it.itemName.trim().replace(/\s+/g, " ");
        if (!normalized[key]) normalized[key] = 0;
        normalized[key] += 1;  // Count each item individually
      });
      allStockItems = Object.entries(normalized).map(([name, quantity]) => ({ name, quantity }));
      stockPage     = 1;
      renderStockPage();
    })
    .catch(() => {
      document.getElementById("stockList").innerHTML =
        `<div class="empty-state">Could not load stock info.</div>`;
    });
}

function renderStockPage() {
  const list       = document.getElementById("stockList");
  const pagination = document.getElementById("stockPagination");
  const pageLabel  = document.getElementById("stockPageLabel");
  const pageInfo   = document.getElementById("stockPageInfo");
  const prevBtn    = document.getElementById("stockPrevBtn");
  const nextBtn    = document.getElementById("stockNextBtn");

  list.innerHTML = "";

  if (!allStockItems || allStockItems.length === 0) {
    list.innerHTML = `<div class="empty-state">No items configured yet.</div>`;
    if (pagination) pagination.style.display = "none";
    if (pageInfo)   pageInfo.style.display   = "none";
    return;
  }

  const totalPages = Math.ceil(allStockItems.length / STOCK_PER_PAGE);
  if (stockPage > totalPages) stockPage = totalPages;

  const start     = (stockPage - 1) * STOCK_PER_PAGE;
  const pageItems = allStockItems.slice(start, start + STOCK_PER_PAGE);

  pageItems.forEach(it => {
    const statusClass = it.quantity === 0 ? "red" : it.quantity <= 2 ? "amber" : "green";
    const label       = statusClass === "green" ? "In Stock" : statusClass === "amber" ? "Low Stock" : "Out of Stock";
    const icon        = STOCK_ICONS[it.name] || STOCK_ICONS["default"];
    const div         = document.createElement("div");
    div.className     = "stock-item";
    div.innerHTML     = `
      <span class="stock-icon">${icon}</span>
      <span class="stock-name">
        ${it.name}
        <small>${it.quantity} available</small>
      </span>
      <span class="stock-tag ${statusClass}">${label}</span>`;
    list.appendChild(div);
  });

  if (totalPages > 1) {
    if (pagination) {
      pagination.style.display = "flex";
      if (prevBtn)   prevBtn.disabled      = stockPage === 1;
      if (nextBtn)   nextBtn.disabled      = stockPage === totalPages;
      if (pageLabel) pageLabel.textContent = `Page ${stockPage} of ${totalPages}`;
    }
    if (pageInfo) {
      pageInfo.style.display = "flex";
      pageInfo.textContent   = `${allStockItems.length} items total`;
    }
  } else {
    if (pagination) pagination.style.display = "none";
    if (pageInfo)   pageInfo.style.display   = "none";
  }
}

function changeStockPage(delta) {
  const totalPages = Math.ceil(allStockItems.length / STOCK_PER_PAGE);
  const next = stockPage + delta;
  if (next < 1 || next > totalPages) return;
  stockPage = next;
  renderStockPage();
}

// ── PWA install banner ────────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById("installBanner");
  if (banner && !sessionStorage.getItem("installDismissed")) banner.style.display = "flex";
});

const installBtn = document.getElementById("installBtn");
if (installBtn) {
  installBtn.addEventListener("click", () => {
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; }
    document.getElementById("installBanner").style.display = "none";
  });
}
const installDismiss = document.getElementById("installDismiss");
if (installDismiss) {
  installDismiss.addEventListener("click", () => {
    sessionStorage.setItem("installDismissed", "1");
    document.getElementById("installBanner").style.display = "none";
  });
}

// ── Service Worker ────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ── Init ──────────────────────────────────────────────────────────────────────
// ── Deep-link: ?user=STUDENTID ───────────────────────────────────────────────
// When a student scans their QR code (which encodes a URL like
// https://borrowingandreturn.netlify.app/index.html?user=323232),
// the browser opens this page with ?user= in the URL. We read it
// here after users are loaded and go straight to their PIN prompt.
function handleDeepLink(users) {
  const params  = new URLSearchParams(window.location.search);
  const userId  = params.get("user");
  if (!userId) return;
  // Clean the URL so refreshing doesn't re-trigger
  history.replaceState({}, "", window.location.pathname);
  const user = users.find(u => String(u.id) === String(userId).trim());
  if (user) {
    // QR deep-link = no PIN — go straight to the user's dashboard
    showNotification(`Welcome, ${user.name}! 👋`, "success");
    currentUser = user;
    sessionStorage.setItem("currentUser", JSON.stringify(user));
    resetBorrowerSession();
    showPage("userDashboardPage");
  } else {
    showNotification(`ID "${userId}" is not registered. Ask an admin.`, "error");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS BAR — live counts from allBorrowers + borrowerStatusMap
// ══════════════════════════════════════════════════════════════════════════════
function updateDashboardStatsBar() {
  const totalStudents = allBorrowers.length;
  let borrowed = 0, overdue = 0, pending = 0;

  const allMap = (borrowerStatusMap && borrowerStatusMap._allMap) || {};
  allBorrowers.forEach(u => {
    const statuses = allMap[u.id] || new Set();
    // Count each active status independently — a student can contribute to
    // multiple buckets if they have both a Borrowed and an Overdue item
    statuses.forEach(s => {
      if (s === "Overdue")                                   overdue++;
      else if (s === "Borrowed")                             borrowed++;
      else if (s === "Pending" || s === "Return Pending")   pending++;
    });
  });

  const el = id => document.getElementById(id);
  if (el("dashStatStudents")) el("dashStatStudents").textContent = totalStudents;
  if (el("dashStatBorrowed")) el("dashStatBorrowed").textContent = borrowed;
  if (el("dashStatOverdue"))  el("dashStatOverdue").textContent  = overdue;
  if (el("dashStatPending"))  el("dashStatPending").textContent  = pending;
}

loadBorrowers();
loadStockPanel();

// ── On-load session restore: jump straight to user dashboard if session saved ─
if (window._restoringSession && currentUser) {
  showPage("userDashboardPage");
  resetBorrowerSession();
}