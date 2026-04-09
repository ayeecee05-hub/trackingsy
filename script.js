const scriptURL = "https://script.google.com/macros/s/AKfycbxlJuasFxMEU2CJzBc1OS084EWUOg5vK0XKTpPARDDAjxPjeWS96qWuPyrjyp5i8FjKFA/exec";
let currentUser   = null;
let borrowers     = [];
let html5QrScanner = null;
let deferredInstallPrompt = null;
let pendingLoginUser = null; // holds user while PIN modal is open

// ── PWA: register service worker ─────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ── PWA: capture install prompt ───────────────────────────────────────────────
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const banner = document.getElementById("installBanner");
  if (banner) banner.style.display = "flex";
});

window.addEventListener("appinstalled", () => {
  const banner = document.getElementById("installBanner");
  if (banner) banner.style.display = "none";
  deferredInstallPrompt = null;
});

// ── Countdown helpers ─────────────────────────────────────────────────────────
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA);
  const b = new Date(dateStrB);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function getDueInfo(dueDate) {
  const today = new Date().toISOString().split("T")[0];
  const diff  = daysBetween(today, dueDate);
  if (diff < 0) {
    const d = Math.abs(diff);
    return { label: `${d} day${d > 1 ? "s" : ""} overdue`, cls: "due-overdue", progress: 100 };
  } else if (diff === 0) {
    return { label: "Due today!", cls: "due-today", progress: 90 };
  } else if (diff === 1) {
    return { label: "Due tomorrow", cls: "due-soon", progress: 65 };
  } else if (diff <= 3) {
    return { label: `Due in ${diff} days`, cls: "due-soon", progress: 40 };
  } else {
    return { label: `Due in ${diff} days`, cls: "due-ok", progress: 10 };
  }
}

// ── Notification banner ───────────────────────────────────────────────────────
function showNotification(message, type = "info") {
  const banner = document.getElementById("notification");
  banner.innerText = message;
  banner.className = type;
  banner.style.display = "block";
  banner.style.top = "20px";
  setTimeout(() => {
    banner.style.top = "-100px";
    setTimeout(() => banner.style.display = "none", 500);
  }, 3000);
}

// ── Confirmation modal ────────────────────────────────────────────────────────
function showConfirm({ icon = "📦", title, message, onConfirm }) {
  document.getElementById("confirmIcon").innerText    = icon;
  document.getElementById("confirmTitle").innerText   = title;
  document.getElementById("confirmMessage").innerText = message;
  document.getElementById("confirmModal").style.display = "flex";

  const yesBtn = document.getElementById("confirmYes");
  const noBtn  = document.getElementById("confirmNo");
  const newYes = yesBtn.cloneNode(true);
  const newNo  = noBtn.cloneNode(true);
  yesBtn.parentNode.replaceChild(newYes, yesBtn);
  noBtn.parentNode.replaceChild(newNo, noBtn);

  newYes.addEventListener("click", () => {
    document.getElementById("confirmModal").style.display = "none";
    onConfirm();
  });
  newNo.addEventListener("click", () => {
    document.getElementById("confirmModal").style.display = "none";
  });
}

document.addEventListener("click", e => {
  const modal = document.getElementById("confirmModal");
  if (e.target === modal) modal.style.display = "none";
});

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll("section").forEach(sec => sec.style.display = "none");
  const target = document.getElementById(pageId);
  target.style.display = "block";
  target.style.animation = "none";
  target.offsetHeight;
  target.style.animation = "";

  if (pageId === "dashboardPage")     loadItemStockStatus();
  if (pageId === "borrowPage")        loadBorrowItems();
  if (pageId === "returnPage")        loadReturnItems();
  if (pageId === "userDashboardPage") { loadBorrowedItems(); loadProfileStats(); }
}

// ── Load users ────────────────────────────────────────────────────────────────
function loadUsers() {
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => { borrowers = users; renderBorrowers(users); })
    .catch(() => showNotification("Error loading users", "error"));
}

function renderBorrowers(list) {
  const container = document.getElementById("usersContainer");
  container.innerHTML = "";

  if (!list || list.length === 0) {
    container.innerHTML = `
      <div class="empty-state-full">
        <div class="empty-icon">👤</div>
        <p>No borrowers registered yet.</p>
        <small>Ask an admin to register you first.</small>
      </div>`;
    return;
  }

  list.forEach(u => {
    const card     = document.createElement("div");
    card.className = "borrower-card";
    const initials = u.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    card.innerHTML = `
      <div class="borrower-avatar">${initials}</div>
      <h3>${u.name}</h3>
      <p>ID: ${u.id}</p>`;
    card.onclick = () => openPinModal(u);
    container.appendChild(card);
  });
}

// ── PIN Modal ─────────────────────────────────────────────────────────────────
// Feature 1: Replaced browser prompt() with an inline PIN modal for better UX
// and security. QR scan bypasses PIN as it is the trusted hardware path.

function openPinModal(user) {
  pendingLoginUser = user;
  document.getElementById("pinModalName").innerText = `Hello, ${user.name}!`;
  document.getElementById("pinModalHint").innerText =
    `Enter your 4-digit PIN\n(Default: last 4 digits of your Student ID)`;
  document.getElementById("pinInput").value = "";
  document.getElementById("pinError").style.display = "none";
  document.getElementById("pinModal").style.display = "flex";
  setTimeout(() => document.getElementById("pinInput").focus(), 50);
}

function closePinModal() {
  document.getElementById("pinModal").style.display = "none";
  pendingLoginUser = null;
}

function submitPin() {
  if (!pendingLoginUser) return;
  const pin         = document.getElementById("pinInput").value.trim();
  const expectedPin = String(pendingLoginUser.id).slice(-4);
  if (pin !== expectedPin) {
    document.getElementById("pinError").style.display = "block";
    document.getElementById("pinInput").value = "";
    document.getElementById("pinInput").focus();
    return;
  }
  closePinModal();
  currentUser = pendingLoginUser;
  showPage("userDashboardPage");
}

// ── QR Code Scanner ───────────────────────────────────────────────────────────
function startQrScanner() {
  const box = document.getElementById("qrScannerBox");
  box.style.display = "block";

  if (html5QrScanner) {
    html5QrScanner.clear().catch(() => {});
  }

  html5QrScanner = new Html5Qrcode("qr-reader");
  html5QrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    decodedText => {
      // QR contains the student ID — find matching borrower
      const scannedId = String(decodedText).trim();
      const match     = borrowers.find(b => String(b.id) === scannedId);

      stopQrScanner();

      if (match) {
        showNotification(`Welcome, ${match.name}!`, "success");
        // QR scan is the trusted hardware path — bypass PIN
        currentUser = match;
        showPage("userDashboardPage");
      } else {
        showNotification(`ID "${scannedId}" not registered.`, "error");
      }
    },
    () => {} // ignore per-frame errors
  ).catch(err => {
    stopQrScanner();
    showNotification("Camera access denied or unavailable.", "error");
    console.error("QR scanner error:", err);
  });
}

function stopQrScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().catch(() => {});
    html5QrScanner.clear().catch(() => {});
    html5QrScanner = null;
  }
  document.getElementById("qrScannerBox").style.display = "none";
}

// ── Search ────────────────────────────────────────────────────────────────────
function searchBorrowers() {
  const query    = document.getElementById("borrowerSearch").value.trim().toLowerCase();
  const filtered = query
    ? borrowers.filter(b =>
        String(b.id).toLowerCase().includes(query) ||
        String(b.name).toLowerCase().includes(query))
    : borrowers;

  if (filtered.length === 0) {
    document.getElementById("usersContainer").innerHTML =
      `<div class="empty-state-full"><div class="empty-icon">🔍</div><p>No borrower found.</p><small>Try a different name or ID.</small></div>`;
    return;
  }
  renderBorrowers(filtered);
}

// ── Borrow items dropdown ─────────────────────────────────────────────────────
function loadBorrowItems() {
  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      const select     = document.getElementById("borrowItem");
      select.innerHTML = "";
      const available  = items.filter(it => it.quantity > 0);
      if (available.length === 0) {
        select.innerHTML = "<option value=''>No items available</option>";
        return;
      }
      available.forEach(it => {
        const opt     = document.createElement("option");
        opt.value     = it.name;
        opt.innerText = `${it.name} (Available: ${it.quantity})`;
        select.appendChild(opt);
      });
    })
    .catch(() => showNotification("Error loading items", "error"));
}

// ── Item stock status panel ───────────────────────────────────────────────────
function loadItemStockStatus() {
  const panel = document.getElementById("stockList");
  if (!panel) return;

  panel.innerHTML = `
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>`;

  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      panel.innerHTML = "";
      if (!items || items.length === 0) {
        panel.innerHTML = "<p class='empty-state'>No stock information found.</p>";
        return;
      }
      const iconsByName = {
        "Projector": "📽️", "Laptop": "💻", "Camera": "📷",
        "Multimeter": "📐", "Microscope": "🔬", "Tablet": "📱",
        "Router": "📡", "Headset": "🎧", "Soldering Iron": "🛠️",
        "Cable": "🔌", "default": "📦"
      };
      items.forEach(it => {
        const status  = it.quantity === 0 ? "red" : it.quantity <= 2 ? "amber" : "green";
        const label   = status === "green" ? "In stock" : status === "amber" ? "Low stock" : "Out of stock";
        const icon    = iconsByName[it.name] || iconsByName.default;
        const itemRow = document.createElement("div");
        itemRow.className = "stock-item";
        itemRow.innerHTML = `
          <span class="stock-icon">${icon}</span>
          <span class="stock-name">${it.name} <small>(${it.quantity} available)</small></span>
          <span class="stock-tag ${status}">${status === "green" ? "✅" : status === "amber" ? "⚠️" : "⛔"} ${label}</span>`;
        panel.appendChild(itemRow);
      });
    })
    .catch(() => { panel.innerHTML = "<p class='empty-state'>Unable to load availability data.</p>"; });
}

// ── Return items dropdown ─────────────────────────────────────────────────────
function loadReturnItems() {
  if (!currentUser) return;
  fetch(scriptURL + "?action=getBorrowed&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(items => {
      const select     = document.getElementById("returnItem");
      select.innerHTML = "";
      if (items.length === 0) {
        select.innerHTML = "<option value=''>No borrowed items</option>";
        return;
      }
      items.forEach(item => {
        const opt     = document.createElement("option");
        opt.value     = item.name;
        opt.innerText = `${item.name} (Borrowed: ${item.borrowDate})`;
        select.appendChild(opt);
      });
    })
    .catch(() => showNotification("Error loading borrowed items", "error"));
}

// ── Currently borrowed list + stats ──────────────────────────────────────────
function loadBorrowedItems() {
  if (!currentUser) return;
  fetch(scriptURL + "?action=getBorrowed&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(items => {
      const list = document.getElementById("borrowedList");
      list.innerHTML = "";
      let overdueCount = 0, dueSoonCount = 0;
      const overdueItems = [];

      if (items.length === 0) {
        list.innerHTML = `
          <div class="empty-state-full">
            <div class="empty-icon">📭</div>
            <p>No items currently borrowed.</p>
            <small>Press <strong>＋ Borrow Item</strong> to get started.</small>
          </div>`;
      } else {
        items.forEach(item => {
          const { label, cls, progress } = getDueInfo(item.dueDate);
          const isOverdue = cls === "due-overdue";
          const isDueSoon = cls === "due-soon" || cls === "due-today";
          if (isOverdue) { overdueCount++; overdueItems.push(item); }
          if (isDueSoon)  dueSoonCount++;

          const li     = document.createElement("li");
          li.className = isOverdue ? "overdue" : "";
          li.innerHTML = `
            <div class="borrow-item-row">
              <div class="borrow-item-info">
                <span class="borrow-item-name">${item.name}</span>
                <span class="borrow-item-dates">Borrowed: ${item.borrowDate} &nbsp;·&nbsp; Due: ${item.dueDate}</span>
              </div>
              <span class="due-badge ${cls}">${label}</span>
            </div>
            <div class="due-progress-track">
              <div class="due-progress-bar ${cls}" style="width:${progress}%"></div>
            </div>`;
          list.appendChild(li);
        });
      }

      document.getElementById("statCurrent").innerText = items.length;
      document.getElementById("statOverdue").innerText = overdueCount;
      document.getElementById("statDueSoon").innerText = dueSoonCount;

      const alertBox  = document.getElementById("overdueAlert");
      const alertList = document.getElementById("overdueAlertList");
      if (overdueItems.length > 0) {
        const today = new Date().toISOString().split("T")[0];
        alertList.innerHTML = overdueItems.map(item => {
          const days = Math.abs(daysBetween(today, item.dueDate));
          return `<span class="overdue-alert-item">📦 ${item.name} — ${days} day${days > 1 ? "s" : ""} overdue</span>`;
        }).join("");
        alertBox.style.display = "block";
      } else {
        alertBox.style.display = "none";
      }
    })
    .catch(() => showNotification("Error loading borrowed items", "error"));
}

// ── Profile card ──────────────────────────────────────────────────────────────
function loadProfileStats() {
  if (!currentUser) return;
  const initials = currentUser.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  document.getElementById("profileAvatar").innerText = initials;
  document.getElementById("profileName").innerText   = currentUser.name;
  document.getElementById("profileId").innerText     = "ID: " + currentUser.id;

  ["profileTotal", "profileOnTime", "profileOverdue"].forEach(id => {
    document.getElementById(id).innerText = "…";
  });

  fetch(scriptURL + "?action=getHistory&studentId=" + currentUser.id)
    .then(res => res.json())
    .then(history => {
      const total    = history.length;
      const overdue  = history.filter(tx => {
        if (tx.returnDate) return false;
        return new Date().toISOString().split("T")[0] > tx.dueDate;
      }).length;
      const returned        = history.filter(tx => tx.returnDate);
      const returnedOnTime  = returned.filter(tx => tx.returnDate <= tx.dueDate).length;
      const onTimeRate      = returned.length > 0
        ? Math.round((returnedOnTime / returned.length) * 100) + "%"
        : total === 0 ? "—" : "N/A";

      document.getElementById("profileTotal").innerText   = total || "0";
      document.getElementById("profileOnTime").innerText  = onTimeRate;
      document.getElementById("profileOverdue").innerText = overdue || "0";
      document.getElementById("profileOverdue").classList.toggle("profile-stat-overdue-active", overdue > 0);
    })
    .catch(() => {
      ["profileTotal", "profileOnTime", "profileOverdue"].forEach(id => {
        document.getElementById(id).innerText = "—";
      });
    });
}

// ── Borrow form ───────────────────────────────────────────────────────────────
document.getElementById("borrowForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("Please select your name first.", "error"); return; }
  const item = document.getElementById("borrowItem").value;
  const borrowDate = document.getElementById("borrowDate").value;
  if (!item || !borrowDate) { showNotification("Please fill in all fields.", "error"); return; }

  showConfirm({
    icon: "📦", title: "Confirm Borrow",
    message: `Borrow "${item}" today? It will be due in 3 days.`,
    onConfirm: () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({ action: "borrow", studentId: currentUser.id, item, borrowDate })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) { showNotification(`"${item}" borrowed successfully!`, "success"); showPage("userDashboardPage"); }
        else showNotification(data.message || "Error borrowing item.", "error");
      })
      .catch(() => showNotification("Error borrowing item", "error"));
    }
  });
});

// ── Return form ───────────────────────────────────────────────────────────────
document.getElementById("returnForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!currentUser) { showNotification("Please select your name first.", "error"); return; }
  const item = document.getElementById("returnItem").value;
  const returnDate = document.getElementById("returnDate").value;
  if (!item || !returnDate) { showNotification("Please fill in all fields.", "error"); return; }

  showConfirm({
    icon: "↩️", title: "Confirm Return",
    message: `Return "${item}" today? This cannot be undone.`,
    onConfirm: () => {
      fetch(scriptURL, {
        method: "POST",
        body: JSON.stringify({ action: "return", studentId: currentUser.id, item, returnDate })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) { showNotification(`"${item}" returned successfully!`, "success"); showPage("userDashboardPage"); }
        else showNotification(data.message || "Error returning item.", "error");
      })
      .catch(() => showNotification("Error returning item", "error"));
    }
  });
});

// ── Theme toggle ──────────────────────────────────────────────────────────────
// Feature 3: Label reflects the CURRENT state and updates dynamically.
function updateThemeLabel() {
  const isDark = document.body.classList.contains("dark");
  document.getElementById("toggleTheme").textContent = isDark ? "🌙 Switch to Light" : "☀️ Switch to Dark";
}

document.getElementById("toggleTheme").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateThemeLabel();
  showNotification(isDark ? "Dark mode enabled" : "Light mode enabled", "info");
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Restore saved theme
  if (localStorage.getItem("theme") === "dark") document.body.classList.add("dark");
  else if (localStorage.getItem("theme") === "light") document.body.classList.remove("dark");

  // Sync theme toggle label to current state on load
  updateThemeLabel();

  const today = new Date().toISOString().split("T")[0];
  document.getElementById("borrowDate").value = today;
  document.getElementById("returnDate").value = today;

  loadUsers();
  showPage("dashboardPage");

  document.getElementById("borrowerSearch").addEventListener("input", searchBorrowers);

  // QR scanner buttons
  document.getElementById("qrScanBtn").addEventListener("click", startQrScanner);
  document.getElementById("qrCloseBtn").addEventListener("click", stopQrScanner);

  // PIN modal buttons
  document.getElementById("pinSubmitBtn").addEventListener("click", submitPin);
  document.getElementById("pinCancelBtn").addEventListener("click", closePinModal);
  document.getElementById("pinInput").addEventListener("keydown", e => {
    if (e.key === "Enter") submitPin();
  });
  // Close PIN modal on backdrop click
  document.getElementById("pinModal").addEventListener("click", e => {
    if (e.target === document.getElementById("pinModal")) closePinModal();
  });

  // PWA install banner
  document.getElementById("installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === "accepted") document.getElementById("installBanner").style.display = "none";
    deferredInstallPrompt = null;
  });
  document.getElementById("installDismiss").addEventListener("click", () => {
    document.getElementById("installBanner").style.display = "none";
  });
});