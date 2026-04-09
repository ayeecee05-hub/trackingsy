const scriptURL = "https://script.google.com/macros/s/AKfycbxlJuasFxMEU2CJzBc1OS084EWUOg5vK0XKTpPARDDAjxPjeWS96qWuPyrjyp5i8FjKFA/exec"; // Replace with your Apps Script Web App URL
const ADMIN_PASSWORD = "12345";
let allTransactions = [];
let allUsers        = [];
let searchTimeout;
let qrInstance      = null;

// ── Notification ──────────────────────────────────────────────────────────────
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

// ── Password gate ─────────────────────────────────────────────────────────────
function checkPassword() {
  const entered = document.getElementById("adminPassword").value;
  if (entered === ADMIN_PASSWORD) {
    document.getElementById("loginSection").style.display  = "none";
    document.getElementById("adminSection").style.display  = "block";
    showNotification("Admin access granted", "success");
    loadTransactions();
    loadItemsTable();
    loadQrStudentList();
  } else {
    showNotification("Access denied", "error");
  }
}

function logoutAdmin() {
  document.getElementById("adminSection").style.display = "none";
  document.getElementById("loginSection").style.display = "block";
  document.getElementById("adminPassword").value = "";
  showNotification("Logged out successfully", "info");
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("panelTransactions").style.display = tab === "transactions" ? "block" : "none";
  document.getElementById("panelItems").style.display        = tab === "items"        ? "block" : "none";
  document.getElementById("tabTransactions").classList.toggle("active", tab === "transactions");
  document.getElementById("tabItems").classList.toggle("active", tab === "items");
}

// ── Register borrower ─────────────────────────────────────────────────────────
// Feature 2: Input sanitization — validates ID (numeric only) and name
// (letters/spaces/hyphens/periods only) before sending to the spreadsheet.
document.getElementById("adminForm").addEventListener("submit", e => {
  e.preventDefault();
  const studentId = document.getElementById("adminId").value.trim();
  const name      = document.getElementById("adminName").value.trim();
  const email     = document.getElementById("adminEmail").value.trim();

  // Validate Student ID: must be non-empty and numeric only
  if (!studentId) {
    showNotification("Student ID is required.", "error");
    return;
  }
  if (!/^\d+$/.test(studentId)) {
    showNotification("Student ID must contain numbers only.", "error");
    document.getElementById("adminId").focus();
    return;
  }

  // Validate Name: must be non-empty and contain only letters, spaces, hyphens, periods
  if (!name) {
    showNotification("Name is required.", "error");
    return;
  }
  if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(name)) {
    showNotification("Name must contain letters only (no numbers or special characters).", "error");
    document.getElementById("adminName").focus();
    return;
  }

  // Validate Email format if provided (optional field)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showNotification("Please enter a valid email address.", "error");
    document.getElementById("adminEmail").focus();
    return;
  }

  // Sanitize: trim and normalize whitespace in name
  const sanitizedName = name.replace(/\s+/g, " ").trim();

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "register", studentId, name: sanitizedName, email })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification(data.message, "success");
      document.getElementById("adminForm").reset();
      updateSummaryStats();
      loadQrStudentList();
    } else {
      showNotification(data.message || "Registration failed.", "error");
    }
  })
  .catch(() => showNotification("Error registering borrower.", "error"));
});

// ── Real-time field validation feedback ───────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const idField   = document.getElementById("adminId");
  const nameField = document.getElementById("adminName");

  if (idField) {
    idField.addEventListener("input", () => {
      const val = idField.value.trim();
      if (val && !/^\d+$/.test(val)) {
        idField.style.borderColor = "var(--highlight)";
        idField.title = "Student ID must be numeric only";
      } else {
        idField.style.borderColor = "";
        idField.title = "";
      }
    });
  }

  if (nameField) {
    nameField.addEventListener("input", () => {
      const val = nameField.value.trim();
      if (val && !/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(val)) {
        nameField.style.borderColor = "var(--highlight)";
        nameField.title = "Name must contain letters only";
      } else {
        nameField.style.borderColor = "";
        nameField.title = "";
      }
    });
  }
});

// ── Load transactions ─────────────────────────────────────────────────────────
function loadTransactions() {
  fetch(scriptURL + "?action=getAllHistory")
    .then(res => res.json())
    .then(history => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      allTransactions = history.map(tx => {
        if (tx.status === "Borrowed" && tx.dueDate) {
          const parts   = tx.dueDate.split("-");
          const dueDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
          if (dueDate < today) return { ...tx, status: "Overdue" };
        }
        return tx;
      });
      renderTransactions(allTransactions);
      updateSummaryStats();
    })
    .catch(() => showNotification("Error loading transactions", "error"));
}

function renderTransactions(transactions) {
  const tbody = document.querySelector("#transactionsTable tbody");
  tbody.innerHTML = "";
  if (!transactions || transactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No transactions found yet.</td></tr>`;
    return;
  }
  transactions.forEach(tx => {
    const s   = (tx.status || "").toLowerCase();
    const cls = s === "returned" ? "status-returned" : s === "borrowed" ? "status-borrowed" : s === "overdue" ? "status-overdue" : "";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${tx.studentId}</td>
      <td>${tx.item}</td>
      <td>${tx.borrowDate}</td>
      <td>${tx.dueDate}</td>
      <td>${tx.returnDate || "-"}</td>
      <td class="${cls}">${tx.status}</td>`;
    tbody.appendChild(row);
  });
}

function filterTransactions() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query    = document.getElementById("searchInput").value.toLowerCase();
    const filtered = allTransactions.filter(tx => {
      return String(tx.studentId).toLowerCase().includes(query) ||
             String(tx.item).toLowerCase().includes(query) ||
             String(tx.studentName || "").toLowerCase().includes(query);
    });
    renderTransactions(filtered.length > 0 ? filtered : []);
  }, 400);
}

function resetFilter() {
  document.getElementById("searchInput").value = "";
  renderTransactions(allTransactions);
}

// ── Item Management ───────────────────────────────────────────────────────────
function loadItemsTable() {
  const tbody = document.getElementById("itemsTableBody");
  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">Loading…</td></tr>`;

  fetch(scriptURL + "?action=getItems")
    .then(res => res.json())
    .then(items => {
      tbody.innerHTML = "";
      if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">No items yet. Add one above.</td></tr>`;
        return;
      }
      items.forEach(it => {
        const status = it.quantity === 0 ? "red" : it.quantity <= 2 ? "amber" : "green";
        const label  = status === "green" ? "In Stock" : status === "amber" ? "Low Stock" : "Out of Stock";
        const row    = document.createElement("tr");
        row.innerHTML = `
          <td><strong>${it.name}</strong></td>
          <td>
            <div class="qty-control">
              <button class="qty-btn" onclick="adjustQty('${it.name}', ${it.quantity}, -1)">−</button>
              <span class="qty-value">${it.quantity}</span>
              <button class="qty-btn" onclick="adjustQty('${it.name}', ${it.quantity}, 1)">＋</button>
            </div>
          </td>
          <td><span class="stock-tag ${status}">${label}</span></td>
          <td>
            <button class="item-delete-btn" onclick="deleteItem('${it.name}', ${it.quantity})">🗑</button>
          </td>`;
        tbody.appendChild(row);
      });
    })
    .catch(() => {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--highlight);">Error loading items.</td></tr>`;
    });
}

function addItem() {
  const name = document.getElementById("newItemName").value.trim();
  const qty  = parseInt(document.getElementById("newItemQty").value);

  if (!name)      { showNotification("Item name is required.", "error"); return; }
  if (isNaN(qty) || qty < 0) { showNotification("Enter a valid quantity.", "error"); return; }

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "addItem", name, quantity: qty })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification(`"${name}" added!`, "success");
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
  const newQty = currentQty + delta;
  if (newQty < 0) { showNotification("Quantity cannot go below 0.", "error"); return; }

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "updateItemQty", name, quantity: newQty })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) loadItemsTable();
    else showNotification(data.message || "Failed to update quantity.", "error");
  })
  .catch(() => showNotification("Error updating quantity.", "error"));
}

function deleteItem(name, quantity) {
  if (quantity > 0) {
    showNotification(`Cannot delete "${name}" — set quantity to 0 first.`, "error");
    return;
  }
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "deleteItem", name })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) { showNotification(`"${name}" deleted.`, "success"); loadItemsTable(); }
    else showNotification(data.message || "Failed to delete.", "error");
  })
  .catch(() => showNotification("Error deleting item.", "error"));
}

// ── QR Code generation ────────────────────────────────────────────────────────
function loadQrStudentList() {
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => {
      allUsers = users;
      renderQrStudentList(users);
    })
    .catch(() => {
      document.getElementById("qrStudentList").innerHTML =
        "<p class='empty-state'>Error loading students.</p>";
    });
}

function renderQrStudentList(users) {
  const container = document.getElementById("qrStudentList");
  container.innerHTML = "";
  if (!users || users.length === 0) {
    container.innerHTML = "<p class='empty-state'>No students registered.</p>";
    return;
  }
  users.forEach(u => {
    const row = document.createElement("div");
    row.className = "qr-student-row";
    row.innerHTML = `
      <div class="qr-student-info">
        <strong>${u.name}</strong>
        <small>ID: ${u.id}</small>
      </div>
      <button class="qr-gen-btn" onclick="showQrModal('${u.id}', '${u.name.replace(/'/g, "\\'")}')">QR</button>`;
    container.appendChild(row);
  });
}

function showQrModal(studentId, studentName) {
  document.getElementById("qrPrintName").innerText = studentName;
  document.getElementById("qrPrintId").innerText   = "ID: " + studentId;

  const container = document.getElementById("qrPrintCode");
  container.innerHTML = "";

  if (qrInstance) { try { qrInstance.clear(); } catch(e) {} }

  qrInstance = new QRCode(container, {
    text:          String(studentId),
    width:         200,
    height:        200,
    colorDark:     "#000000",
    colorLight:    "#ffffff",
    correctLevel:  QRCode.CorrectLevel.H
  });

  showModal("qrPrintModal");
}

function printQr() {
  const name = document.getElementById("qrPrintName").innerText;
  const id   = document.getElementById("qrPrintId").innerText;
  const img  = document.querySelector("#qrPrintCode img");
  if (!img) { showNotification("QR not ready yet.", "error"); return; }

  const win = window.open("", "_blank");
  win.document.write(`
    <!DOCTYPE html><html><head>
    <title>QR Code — ${name}</title>
    <style>
      body { font-family: sans-serif; text-align: center; padding: 40px; }
      h2   { margin: 0 0 4px; font-size: 20px; }
      p    { margin: 0 0 20px; color: #555; font-size: 13px; }
      img  { border: 2px solid #eee; border-radius: 8px; padding: 10px; }
      small{ display:block; margin-top:12px; color:#999; font-size:11px; }
    </style></head><body>
    <h2>${name}</h2>
    <p>${id}</p>
    <img src="${img.src}" width="200" height="200">
    <small>CTU Danao Equipment Borrowing System</small>
    <script>window.onload = () => { window.print(); window.close(); }<\/script>
    </body></html>`);
  win.document.close();
}

// QR search filter
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("qrStudentSearch").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    const filtered = allUsers.filter(u =>
      String(u.name).toLowerCase().includes(q) ||
      String(u.id).toLowerCase().includes(q)
    );
    renderQrStudentList(filtered);
  });
});

// ── Modal helpers ─────────────────────────────────────────────────────────────
function showModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.style.display = "flex";
  if (modalId === "borrowersModal")    showBorrowersList();
  else if (modalId === "transactionsModal") showTransactionsList();
  else if (modalId === "overdueModal") showOverdueList();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = "none";
}

window.addEventListener("click", event => {
  if (event.target.classList.contains("modal")) event.target.style.display = "none";
});

function showBorrowersList() {
  const container = document.getElementById("borrowersListContent");
  container.innerHTML = "<p class='empty-message'>Loading...</p>";
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => {
      if (!users || users.length === 0) {
        container.innerHTML = "<p class='empty-message'>No registered users yet.</p>";
        return;
      }
      const list = document.createElement("div");
      list.className = "user-list";
      users.forEach(user => {
        const item = document.createElement("div");
        item.className = "user-item";
        item.innerHTML = `<strong>${user.name}</strong> (ID: ${user.id})<br><small>${user.email || "No email"}</small>`;
        list.appendChild(item);
      });
      container.innerHTML = "";
      container.appendChild(list);
    })
    .catch(() => { container.innerHTML = "<p class='empty-message'>Error loading users.</p>"; });
}

function showTransactionsList() {
  const container = document.getElementById("transactionsListContent");
  container.innerHTML = "";
  if (!allTransactions || allTransactions.length === 0) {
    container.innerHTML = "<p class='empty-message'>No transactions found.</p>";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>
    <th>Student ID</th><th>Name</th><th>Item</th>
    <th>Borrow Date</th><th>Due Date</th><th>Return Date</th><th>Status</th>
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  allTransactions.forEach(tx => {
    const s   = (tx.status || "").toLowerCase();
    const cls = s === "returned" ? "status-returned" : s === "borrowed" ? "status-borrowed" : s === "overdue" ? "status-overdue" : "";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${tx.studentId}</td><td>${tx.studentName || "-"}</td><td>${tx.item}</td>
      <td>${tx.borrowDate}</td><td>${tx.dueDate}</td>
      <td>${tx.returnDate || "-"}</td><td class="${cls}">${tx.status}</td>`;
    tbody.appendChild(row);
  });
  container.appendChild(table);
}

function showOverdueList() {
  const container  = document.getElementById("overdueListContent");
  container.innerHTML = "";
  const overdueItems = allTransactions.filter(tx => tx.status === "Overdue");
  if (overdueItems.length === 0) {
    container.innerHTML = "<p class='empty-message'>No overdue items. 🎉</p>";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>
    <th>Student ID</th><th>Name</th><th>Item</th><th>Due Date</th><th>Days Overdue</th>
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  overdueItems.forEach(tx => {
    const parts       = tx.dueDate.split("-");
    const dueDate     = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
    const row         = document.createElement("tr");
    row.innerHTML = `
      <td>${tx.studentId}</td><td>${tx.studentName || "-"}</td><td>${tx.item}</td>
      <td>${tx.dueDate}</td>
      <td class="status-overdue"><strong>${daysOverdue} day${daysOverdue !== 1 ? "s" : ""}</strong></td>`;
    tbody.appendChild(row);
  });
  container.appendChild(table);
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("searchInput").addEventListener("input", filterTransactions);

  document.getElementById("adminPassword").addEventListener("keypress", e => {
    if (e.key === "Enter") { e.preventDefault(); checkPassword(); }
  });
  document.getElementById("adminLoginBtn").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); checkPassword(); }
  });
});

// ── Summary stats ─────────────────────────────────────────────────────────────
function updateSummaryStats() {
  fetch(scriptURL + "?action=getUsers")
    .then(res => res.json())
    .then(users => {
      document.getElementById("totalBorrowers").innerText = Array.isArray(users) ? users.length : 0;
    }).catch(() => {});
  document.getElementById("totalTransactions").innerText = allTransactions.length;
  document.getElementById("overdueItems").innerText = allTransactions.filter(tx => tx.status === "Overdue").length;
}