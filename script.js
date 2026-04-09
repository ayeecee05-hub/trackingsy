// ─────────────────────────────────────────────────────────────────────────────
// CTU Danao Equipment Borrowing System — script.js
// Two-step borrow flow:
//   Student submits → status = "Pending"
//   Admin confirms  → status = "Borrowed"  (stock decremented only at this step)
// ─────────────────────────────────────────────────────────────────────────────

const scriptURL = "https://script.google.com/macros/s/AKfycbzXK9F0QiNQxxaH_Qtzag0Bu1qCz6rYjLOlAGKa-Swks8-O6_hiUM9Jeoi6fDRxM6SpgQ/exec"; // Replace with your Apps Script Web App URL

let currentUser    = null;   // { id, name }
let allBorrowers   = [];
let html5QrScanner = null;

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
  banner.innerText  = message;
  banner.className  = type;
  banner.style.display = "block";
  banner.style.top  = "20px";
  setTimeout(() => {
    banner.style.top = "-100px";
    setTimeout(() => (banner.style.display = "none"), 500);
  }, 3000);
}

// ── Page navigation ───────────────────────────────────────────────────────────
function showPage(pageId) {
  const pages = ["dashboardPage", "userDashboardPage", "borrowPage", "returnPage"];
  pages.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === pageId ? "block" : "none";
  });
  if (pageId === "userDashboardPage") loadUserDashboard();
  if (pageId === "borrowPage")        populateBorrowSelect();
  if (pageId === "returnPage")        populateReturnSelect();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Load borrowers ────────────────────────────────────────────────────────────
function loadBorrowers() {
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => {
      allBorrowers = users;
      renderBorrowerCards(users);
    })
    .catch(() => showNotification("Error loading users.", "error"));
}

function renderBorrowerCards(users) {
  const container = document.getElementById("usersContainer");
  container.innerHTML = "";
  if (!users || users.length === 0) {
    container.innerHTML = `
      <div class="empty-state-full">
        <div class="empty-icon">👤</div>
        <p>No borrowers registered yet.</p>
        <small>Ask an admin to register you.</small>
      </div>`;
    return;
  }
  users.forEach(user => {
    const initials = user.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const card = document.createElement("div");
    card.className = "borrower-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Select ${user.name}`);
    card.innerHTML = `
      <div class="borrower-avatar">${initials}</div>
      <h3>${user.name}</h3>
      <p>${user.id}</p>`;
    card.addEventListener("click",  () => openPinModal(user));
    card.addEventListener("keydown", e => { if (e.key === "Enter") openPinModal(user); });
    container.appendChild(card);
  });
}

// ── Borrower search ───────────────────────────────────────────────────────────
document.getElementById("borrowerSearch").addEventListener("input", e => {
  const q  = e.target.value.toLowerCase();
  const filtered = allBorrowers.filter(u =>
    u.name.toLowerCase().includes(q) || String(u.id).includes(q)
  );
  renderBorrowerCards(filtered);
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
  const entered = document.getElementById("pinInput").value.trim();
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
  if (html5QrScanner) return;
  html5QrScanner = new Html5Qrcode("qr-reader");
  html5QrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 220 },
    qrCodeMessage => {
      stopQrScanner();
      const scannedId = qrCodeMessage.trim();
      const user = allBorrowers.find(u => String(u.id) === scannedId);
      if (user) {
        currentUser = user;
        showPage("userDashboardPage");
      } else {
        showNotification("QR code not found. Please register first.", "error");
      }
    }
  ).catch(() => showNotification("Camera access denied.", "error"));
}

function stopQrScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().catch(() => {});
    html5QrScanner = null;
  }
  document.getElementById("qrScannerBox").style.display = "none";
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Classify transactions
      const borrowed  = history.filter(tx => tx.status === "Borrowed");
      const pending   = history.filter(tx => tx.status === "Pending");
      const returned  = history.filter(tx => tx.status === "Returned");

      const overdue = borrowed.filter(tx => {
        if (!tx.dueDate) return false;
        const parts   = tx.dueDate.split("-");
        const dueDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return dueDate < today;
      });

      const dueSoon = borrowed.filter(tx => {
        if (!tx.dueDate) return false;
        const parts   = tx.dueDate.split("-");
        const dueDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        const diff    = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
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
      const lateCount = history.filter(tx => tx.isLate === true || tx.isLate === "TRUE").length;
      const onTimeRate = totalBorrows > 0
        ? Math.round(((totalBorrows - lateCount) / totalBorrows) * 100) + "%"
        : "—";
      document.getElementById("profileOnTime").textContent = onTimeRate;
      document.getElementById("profileOverdue").textContent = overdue.length;
      document.getElementById("profileOverdue").className =
        "profile-stat-value" + (overdue.length > 0 ? " profile-stat-overdue-active" : " profile-stat-overdue");

      // Overdue alert
      if (overdue.length > 0) {
        document.getElementById("overdueAlert").style.display = "block";
        const list = document.getElementById("overdueAlertList");
        list.innerHTML = overdue.map(tx => `
          <div class="overdue-alert-item">📦 ${tx.item} — due ${tx.dueDate}</div>`).join("");
      } else {
        document.getElementById("overdueAlert").style.display = "none";
      }

      // Borrowed items list
      const borrowedList = document.getElementById("borrowedList");
      borrowedList.innerHTML = "";
      if (borrowed.length === 0) {
        borrowedList.innerHTML = `<li style="text-align:center;color:var(--text-muted);border-left:none;background:none;">No items currently borrowed.</li>`;
      } else {
        borrowed.forEach(tx => {
          const parts   = (tx.dueDate || "").split("-");
          const dueDate = parts.length === 3 ? new Date(+parts[0], +parts[1]-1, +parts[2]) : null;
          const diff    = dueDate ? Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24)) : null;
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

      // Pending section
      const pendingSection = document.getElementById("pendingSection");
      const pendingList    = document.getElementById("pendingList");
      if (pending.length > 0) {
        pendingSection.style.display = "block";
        pendingList.innerHTML = pending.map(tx => `
          <li>
            <span>⏳ <strong>${tx.item}</strong></span>
            <span class="pending-pill">Pending</span>
          </li>`).join("");
      } else {
        pendingSection.style.display = "none";
      }
    })
    .catch(() => showNotification("Error loading your data.", "error"));
}

function getDueBadge(daysLeft) {
  if (daysLeft === null) return { badgeClass: "due-ok", badgeText: "—", barClass: "due-ok", barWidth: 50 };
  if (daysLeft < 0)  return { badgeClass: "due-overdue", badgeText: `${Math.abs(daysLeft)}d overdue`, barClass: "due-overdue", barWidth: 100 };
  if (daysLeft === 0) return { badgeClass: "due-today",  badgeText: "Due today", barClass: "due-today", barWidth: 95 };
  if (daysLeft <= 2)  return { badgeClass: "due-soon",   badgeText: `${daysLeft}d left`, barClass: "due-soon", barWidth: 70 };
  return { badgeClass: "due-ok", badgeText: `${daysLeft}d left`, barClass: "due-ok", barWidth: Math.min(60, daysLeft * 8) };
}

// ── Populate selects ──────────────────────────────────────────────────────────
function populateBorrowSelect() {
  const today = new Date();
  document.getElementById("borrowDate").value =
    today.toISOString().split("T")[0];

  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      const select = document.getElementById("borrowItem");
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

function populateReturnSelect() {
  const today = new Date();
  document.getElementById("returnDate").value =
    today.toISOString().split("T")[0];

  if (!currentUser) return;

  fetch(scriptURL + "?action=getHistory&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(history => {
      // Only show actually borrowed items (not pending, not returned)
      const borrowed = history.filter(tx => tx.status === "Borrowed");
      const select   = document.getElementById("returnItem");
      select.innerHTML = "";
      if (borrowed.length === 0) {
        select.innerHTML = `<option disabled selected>No items to return</option>`;
        return;
      }
      borrowed.forEach(tx => {
        const opt = document.createElement("option");
        opt.value       = tx.item;
        opt.textContent = `${tx.item} (due ${tx.dueDate})`;
        select.appendChild(opt);
      });
    })
    .catch(() => showNotification("Error loading items.", "error"));
}

// ── Borrow form — submits a PENDING request ───────────────────────────────────
document.getElementById("borrowForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("No user selected.", "error"); return; }

  const item       = document.getElementById("borrowItem").value;
  const borrowDate = document.getElementById("borrowDate").value;

  // Due date = borrow date + 3 days
  const dueDateObj = new Date(borrowDate);
  dueDateObj.setDate(dueDateObj.getDate() + 3);
  const dueDate = dueDateObj.toISOString().split("T")[0];

  showConfirmModal(
    "📋",
    "Submit Borrow Request",
    `Request <strong>${item}</strong>?<br>
     <small style="color:var(--text-muted);">
       Borrow date: ${borrowDate} · Due: ${dueDate}<br>
       Status will be <strong style="color:var(--warning);">Pending</strong> until the admin hands over the item.
     </small>`,
    () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({
          action:     "requestBorrow",   // ← NEW action name (Pending)
          studentId:  currentUser.id,
          item,
          borrowDate,
          dueDate
        })
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

// ── Return form ───────────────────────────────────────────────────────────────
document.getElementById("returnForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("No user selected.", "error"); return; }

  const item       = document.getElementById("returnItem").value;
  const returnDate = document.getElementById("returnDate").value;

  showConfirmModal(
    "↩",
    "Confirm Return",
    `Return <strong>${item}</strong> on <strong>${returnDate}</strong>?`,
    () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({
          action:     "returnItem",
          studentId:  currentUser.id,
          item,
          returnDate
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showNotification(`${item} returned successfully! ✅`, "success");
          showPage("userDashboardPage");
        } else {
          showNotification(data.message || "Return failed.", "error");
        }
      })
      .catch(() => showNotification("Network error. Please try again.", "error"));
    }
  );
});

// ── Confirm modal helper ──────────────────────────────────────────────────────
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

// ── Stock panel ───────────────────────────────────────────────────────────────
function loadStockPanel() {
  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      const list = document.getElementById("stockList");
      list.innerHTML = "";
      if (!items || items.length === 0) {
        list.innerHTML = `<div class="empty-state">No items configured yet.</div>`;
        return;
      }
      items.forEach(it => {
        const statusClass = it.quantity === 0 ? "red" : it.quantity <= 2 ? "amber" : "green";
        const label       = statusClass === "green" ? "In Stock" : statusClass === "amber" ? "Low Stock" : "Out of Stock";
        const div = document.createElement("div");
        div.className = "stock-item";
        div.innerHTML = `
          <span class="stock-icon">📦</span>
          <span class="stock-name">
            ${it.name}
            <small>${it.quantity} available</small>
          </span>
          <span class="stock-tag ${statusClass}">${label}</span>`;
        list.appendChild(div);
      });
    })
    .catch(() => {
      document.getElementById("stockList").innerHTML =
        `<div class="empty-state">Could not load stock info.</div>`;
    });
}

// ── PWA install banner ────────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById("installBanner");
  if (banner && !sessionStorage.getItem("installDismissed")) {
    banner.style.display = "flex";
  }
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

// ── Service Worker registration ───────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadBorrowers();
loadStockPanel();