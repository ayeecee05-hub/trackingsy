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

const scriptURL = "https://script.google.com/macros/s/AKfycbz-s0vmF-RjgGhR1T7TKkHxVH8hNM8IixtfXb_cfbqvqTtWFzaxjw2Qgc2QuNoQ-3ToTg/exec";

// ── Philippine Time (UTC+8) helpers ───────────────────────────────────────────
// Always use these instead of new Date().toISOString() to avoid UTC date shift.
function getPHTDate() {
  // Returns a Date object whose local-style values reflect PHT (UTC+8)
  const now = new Date();
  // Offset in ms between UTC and PHT
  const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
  return new Date(now.getTime() + PHT_OFFSET_MS - (now.getTimezoneOffset() * 60 * 1000));
}

function getPHTDateString() {
  // Returns today's date in PHT as "YYYY-MM-DD"
  const pht = getPHTDate();
  const y   = pht.getUTCFullYear();
  const m   = String(pht.getUTCMonth() + 1).padStart(2, "0");
  const d   = String(pht.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysToPHTString(dateStr, days) {
  // Adds N days to a "YYYY-MM-DD" string and returns a new "YYYY-MM-DD" string
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split("T")[0];
}

let currentUser      = null;
let allBorrowers     = [];
let html5QrScanner   = null;

// ── Theme toggle ──────────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") {
    document.body.classList.remove("dark");
    document.getElementById("toggleTheme").textContent = "🌙 Switch to Dark";
  } else {
    document.body.classList.add("dark");
    document.getElementById("toggleTheme").textContent = "☀️ Switch to Light";
  }
})();

document.getElementById("toggleTheme").addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  document.getElementById("toggleTheme").textContent = isDark ? "☀️ Switch to Light" : "🌙 Switch to Dark";
});

// ── Notification ──────────────────────────────────────────────────────────────
function showNotification(message, type = "info") {
  const banner = document.getElementById("notification");
  banner.innerText     = message;
  banner.className     = type;
  banner.style.display = "block";
  banner.style.top     = "20px";
  setTimeout(() => {
    banner.style.top = "-100px";
    setTimeout(() => (banner.style.display = "none"), 500);
  }, 3000);
}

// ── Page navigation ───────────────────────────────────────────────────────────
function showPage(pageId) {
  ["dashboardPage", "userDashboardPage", "borrowPage", "returnPage"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === pageId ? "block" : "none";
  });
  if (pageId === "userDashboardPage") loadUserDashboard();
  if (pageId === "borrowPage")        populateBorrowSelect();
  if (pageId === "returnPage")        populateReturnSelect();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ══════════════════════════════════════════════════════════════════════════════
// BORROWER CARDS — pagination (10 per page)
// ══════════════════════════════════════════════════════════════════════════════
const USERS_PER_PAGE    = 10;
let   usersPage         = 1;
let   filteredBorrowers = [];

function loadBorrowers() {
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => {
      allBorrowers      = users;
      filteredBorrowers = users;
      usersPage         = 1;
      renderBorrowerPage();
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
    const card = document.createElement("div");
    card.className = "borrower-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Select ${user.name}`);
    card.innerHTML = `
      <div class="borrower-avatar">${initials}</div>
      <h3>${user.name}</h3>`;
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
document.getElementById("borrowerSearch").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  filteredBorrowers = allBorrowers.filter(u =>
    u.name.toLowerCase().includes(q)
  );
  usersPage = 1;
  renderBorrowerPage();
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
    showPage("userDashboardPage");
  } else {
    document.getElementById("pinError").style.display = "block";
    document.getElementById("pinInput").value = "";
    document.getElementById("pinInput").focus();
  }
}

// ── QR scanner ────────────────────────────────────────────────────────────────
document.getElementById("qrScanBtn").addEventListener("click", () => {
  document.getElementById("qrScannerBox").style.display = "block";
  startQrScanner();
});
document.getElementById("qrCloseBtn").addEventListener("click", stopQrScanner);

function startQrScanner() {
  if (html5QrScanner) {
    const old = html5QrScanner;
    html5QrScanner = null;
    old.stop().catch(() => {}).finally(() => {
      old.clear().catch(() => {});
      _doStartScanner();
    });
  } else {
    _doStartScanner();
  }
}

function _doStartScanner() {
  const readerEl = document.getElementById("qr-reader");
  if (!readerEl) { showNotification("QR reader not found.", "error"); return; }
  readerEl.innerHTML = "";

  try { html5QrScanner = new Html5Qrcode("qr-reader"); }
  catch (e) { showNotification("Could not initialise QR scanner.", "error"); return; }

  html5QrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    decodedText => {
      const scannedId = String(decodedText).trim();
      stopQrScanner();
      const user = allBorrowers.find(u => String(u.id) === scannedId);
      if (user) {
        showNotification(`Welcome, ${user.name}! 👋`, "success");
        currentUser = user;
        showPage("userDashboardPage");
      } else {
        showNotification(`ID "${scannedId}" not registered. Ask an admin.`, "error");
      }
    },
    () => {}
  ).catch(err => {
    html5QrScanner = null;
    document.getElementById("qrScannerBox").style.display = "none";
    let msg = "Camera access denied or unavailable.";
    if (err && err.message) {
      if (err.message.toLowerCase().includes("permission"))  msg = "Camera permission denied. Allow access and try again.";
      if (err.message.toLowerCase().includes("notfound"))    msg = "No camera found on this device.";
      if (err.message.toLowerCase().includes("notreadable")) msg = "Camera is in use by another app.";
    }
    showNotification(msg, "error");
  });
}

function stopQrScanner() {
  document.getElementById("qrScannerBox").style.display = "none";
  if (!html5QrScanner) return;
  const scanner  = html5QrScanner;
  html5QrScanner = null;
  scanner.stop().catch(() => {}).finally(() => scanner.clear().catch(() => {}));
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

      const borrowed      = history.filter(tx => tx.status === "Borrowed");
      const pending       = history.filter(tx => tx.status === "Pending");
      const returnPending = history.filter(tx => tx.status === "Return Pending");

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
      const totalBorrows = history.filter(tx => tx.status !== "Pending" && tx.status !== "Rejected").length;
      document.getElementById("profileTotal").textContent = totalBorrows;
      const lateCount  = history.filter(tx => tx.isLate === true || tx.isLate === "TRUE").length;
      const onTimeRate = totalBorrows > 0
        ? Math.round(((totalBorrows - lateCount) / totalBorrows) * 100) + "%"
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

      // Currently borrowed list
      const borrowedList = document.getElementById("borrowedList");
      borrowedList.innerHTML = "";
      if (borrowed.length === 0) {
        borrowedList.innerHTML = `<li style="text-align:center;color:var(--text-muted);border-left:none;background:none;">No items currently borrowed.</li>`;
      } else {
        borrowed.forEach(tx => {
          const p       = (tx.dueDate || "").split("-");
          const dueDate = p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
          const diff    = dueDate ? Math.ceil((dueDate - today) / 86400000) : null;
          const { badgeClass, badgeText, barClass, barWidth } = getDueBadge(diff);
          const li = document.createElement("li");
          li.className = diff !== null && diff < 0 ? "overdue" : "";
          li.innerHTML = `
            <div class="borrow-item-row">
              <div class="borrow-item-info">
                <span class="borrow-item-name">📦 ${tx.item}</span>
                <span class="borrow-item-dates">Borrowed ${tx.borrowDate} · Due ${tx.dueDate}</span>
                <div class="due-progress-track"><div class="due-progress-bar ${barClass}" style="width:${barWidth}%"></div></div>
              </div>
              <span class="due-badge ${badgeClass}">${badgeText}</span>
            </div>`;
          borrowedList.appendChild(li);
        });
      }

      // ── Pending borrow section ────────────────────────────────────────────
      const pendingSection = document.getElementById("pendingSection");
      if (pending.length > 0) {
        pendingSection.style.display = "block";
        document.getElementById("pendingList").innerHTML = pending.map(tx => `
          <li>
            <span>⏳ <strong>${tx.item}</strong></span>
            <span class="pending-pill">Pending</span>
          </li>`).join("");
      } else {
        pendingSection.style.display = "none";
      }

      // ── Return Pending section ────────────────────────────────────────────
      // Shows items the student has submitted a return for, awaiting admin confirmation
      const returnPendingSection = document.getElementById("returnPendingSection");
      if (returnPendingSection) {
        if (returnPending.length > 0) {
          returnPendingSection.style.display = "block";
          document.getElementById("returnPendingList").innerHTML = returnPending.map(tx => `
            <li>
              <span>📦 <strong>${tx.item}</strong></span>
              <span class="pending-pill return-pending-pill">↩ Return Pending</span>
            </li>`).join("");
        } else {
          returnPendingSection.style.display = "none";
        }
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
      const available = items.filter(it => it.quantity > 0);
      if (available.length === 0) {
        select.innerHTML = `<option disabled selected>No items available</option>`;
        return;
      }
      available.forEach(it => {
        const opt = document.createElement("option");
        opt.value       = it.name;
        opt.textContent = `${it.name} (${it.quantity} available)`;
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
      // Only show items with status exactly "Borrowed"
      // "Return Pending" items are already submitted and awaiting admin
      const eligible = history.filter(tx => tx.status === "Borrowed");
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
  const b = new Date(borrowDate), d = new Date(dueDate);
  const days = Math.round((d - b) / 86400000);

  showConfirmModal("📋", "Submit Borrow Request",
    `Request <strong>${item}</strong>?<br>
     <small style="color:var(--text-muted);">
       Borrow date: ${borrowDate} · Expected return: ${dueDate} (${days} day${days !== 1 ? "s" : ""})<br>
       Status will be <strong style="color:var(--warning);">Pending</strong> until the admin hands over the item.
     </small>`,
    () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({ action: "requestBorrow", studentId: currentUser.id, item, borrowDate, dueDate })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showNotification("Request submitted! Proceed to the admin for hand-over. ⏳", "success");
          showPage("userDashboardPage");
        } else {
          showNotification(data.message || "Request failed.", "error");
        }
      })
      .catch(() => showNotification("Network error. Please try again.", "error"));
    }
  );
});

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
      allStockItems = items || [];
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
loadBorrowers();
loadStockPanel();