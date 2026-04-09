const scriptURL = "https://script.google.com/macros/s/AKfycbzXK9F0QiNQxxaH_Qtzag0Bu1qCz6rYjLOlAGKa-Swks8-O6_hiUM9Jeoi6fDRxM6SpgQ/exec"; // Replace with your Apps Script Web App URL
const ADMIN_PASSWORD = "12345";
let allTransactions = [];
let allUsers        = [];
let allPending      = [];
let searchTimeout;
let qrInstance      = null;

// Pending hand-over / reject callbacks
let pendingHandoverCallback = null;
let pendingRejectCallback   = null;

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
    loadPendingRequests();
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
  document.getElementById("panelPending").style.display      = tab === "pending"      ? "block" : "none";
  document.getElementById("panelTransactions").style.display = tab === "transactions" ? "block" : "none";
  document.getElementById("panelItems").style.display        = tab === "items"        ? "block" : "none";
  document.getElementById("tabPending").classList.toggle("active",       tab === "pending");
  document.getElementById("tabTransactions").classList.toggle("active",  tab === "transactions");
  document.getElementById("tabItems").classList.toggle("active",         tab === "items");
  if (tab === "pending") loadPendingRequests();
}

// ── Register borrower ─────────────────────────────────────────────────────────
function setFieldError(fieldId, errorId, message) {
  const field = document.getElementById(fieldId);
  const err   = document.getElementById(errorId);
  if (!field || !err) return;
  field.classList.add("field-invalid");
  field.classList.remove("field-valid");
  err.textContent   = message;
  err.style.display = "block";
}

function setFieldValid(fieldId, errorId) {
  const field = document.getElementById(fieldId);
  const err   = document.getElementById(errorId);
  if (!field || !err) return;
  field.classList.remove("field-invalid");
  field.classList.add("field-valid");
  err.style.display = "none";
}

function clearFieldState(fieldId, errorId) {
  const field = document.getElementById(fieldId);
  const err   = document.getElementById(errorId);
  if (field) { field.classList.remove("field-invalid", "field-valid"); }
  if (err)   { err.style.display = "none"; }
}

document.getElementById("adminForm").addEventListener("submit", e => {
  e.preventDefault();
  const studentId = document.getElementById("adminId").value.trim();
  const name      = document.getElementById("adminName").value.trim();
  const email     = document.getElementById("adminEmail").value.trim();
  let   hasError  = false;

  if (!studentId) {
    setFieldError("adminId", "adminIdError", "Student ID is required.");
    hasError = true;
  } else if (!/^\d+$/.test(studentId)) {
    setFieldError("adminId", "adminIdError", "Student ID must contain numbers only — no letters or symbols.");
    hasError = true;
  } else if (studentId.length < 5 || studentId.length > 12) {
    setFieldError("adminId", "adminIdError", "Student ID must be between 5 and 12 digits.");
    hasError = true;
  } else {
    setFieldValid("adminId", "adminIdError");
  }

  const sanitizedName = name.replace(/\s+/g, " ").trim();
  if (!sanitizedName) {
    setFieldError("adminName", "adminNameError", "Name is required.");
    hasError = true;
  } else if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(sanitizedName)) {
    setFieldError("adminName", "adminNameError", "Name must contain letters only — no numbers or special characters.");
    hasError = true;
  } else if (sanitizedName.length < 2 || sanitizedName.length > 60) {
    setFieldError("adminName", "adminNameError", "Name must be between 2 and 60 characters.");
    hasError = true;
  } else {
    setFieldValid("adminName", "adminNameError");
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFieldError("adminEmail", "adminEmailError", "Please enter a valid email address.");
    hasError = true;
  } else if (email) {
    setFieldValid("adminEmail", "adminEmailError");
  }

  if (hasError) return;

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({ action: "register", studentId, name: sanitizedName, email })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification(data.message, "success");
      document.getElementById("adminForm").reset();
      ["adminId","adminName","adminEmail"].forEach((id, i) =>
        clearFieldState(id, ["adminIdError","adminNameError","adminEmailError"][i])
      );
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
  const idField    = document.getElementById("adminId");
  const nameField  = document.getElementById("adminName");
  const emailField = document.getElementById("adminEmail");

  if (idField) {
    idField.addEventListener("input", () => {
      const val = idField.value.trim();
      if (!val) { clearFieldState("adminId", "adminIdError"); return; }
      if (!/^\d+$/.test(val)) {
        setFieldError("adminId", "adminIdError", "Numbers only — no letters or symbols.");
      } else if (val.length < 5) {
        setFieldError("adminId", "adminIdError", `${val.length}/5 digits minimum`);
      } else if (val.length > 12) {
        setFieldError("adminId", "adminIdError", "Maximum 12 digits.");
      } else {
        setFieldValid("adminId", "adminIdError");
      }
    });
  }

  if (nameField) {
    nameField.addEventListener("input", () => {
      const val = nameField.value.trim();
      if (!val) { clearFieldState("adminName", "adminNameError"); return; }
      if (!/^[A-Za-zÀ-ÿ\s\-\.]+$/.test(val)) {
        setFieldError("adminName", "adminNameError", "Letters only — no numbers or special characters.");
      } else if (val.length < 2) {
        setFieldError("adminName", "adminNameError", "Name is too short.");
      } else if (val.length > 60) {
        setFieldError("adminName", "adminNameError", "Name is too long (max 60 characters).");
      } else {
        setFieldValid("adminName", "adminNameError");
      }
    });
  }

  if (emailField) {
    emailField.addEventListener("input", () => {
      const val = emailField.value.trim();
      if (!val) { clearFieldState("adminEmail", "adminEmailError"); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        setFieldError("adminEmail", "adminEmailError", "Enter a valid email (e.g. student@ctu.edu.ph).");
      } else {
        setFieldValid("adminEmail", "adminEmailError");
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ── PENDING REQUESTS ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * Loads all transactions with status "Pending" from the spreadsheet and
 * renders them in the pending queue table. The badge on the tab updates too.
 */
function loadPendingRequests() {
  const tbody = document.getElementById("pendingTableBody");
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:18px;">Loading pending requests…</td></tr>`;

  fetch(scriptURL + "?action=getPendingRequests")
    .then(res => res.json())
    .then(data => {
      allPending = Array.isArray(data) ? data : [];
      renderPendingTable(allPending);
      updatePendingBadge(allPending.length);
      updateSummaryStats();
    })
    .catch(() => {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--highlight);">Error loading pending requests.</td></tr>`;
    });
}

function renderPendingTable(requests) {
  const tbody = document.getElementById("pendingTableBody");
  tbody.innerHTML = "";

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:32px;">
          <div style="font-size:28px;margin-bottom:8px;">✅</div>
          <div style="color:var(--success);font-weight:600;">No pending requests</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">All borrow requests have been handled.</div>
        </td>
      </tr>`;
    return;
  }

  requests.forEach((req, index) => {
    const row = document.createElement("tr");
    row.className = "pending-row";
    row.innerHTML = `
      <td><span class="mono-id">${req.studentId}</span></td>
      <td><strong>${req.studentName || "—"}</strong></td>
      <td>${req.item}</td>
      <td><span class="date-chip">${req.borrowDate || "—"}</span></td>
      <td><span class="date-chip due">${req.dueDate || "—"}</span></td>
      <td>
        <div class="pending-action-btns">
          <button
            class="handover-btn"
            onclick="confirmHandover(${index})"
            title="Mark as handed over — confirms borrow and reduces stock"
          >✅ Hand Over</button>
          <button
            class="reject-btn"
            onclick="confirmReject(${index})"
            title="Reject this request — no stock change"
          >✗ Reject</button>
        </div>
      </td>`;
    tbody.appendChild(row);
  });
}

function updatePendingBadge(count) {
  const badge = document.getElementById("pendingBadge");
  const statEl = document.getElementById("totalPending");
  if (statEl) statEl.innerText = count;
  if (!badge) return;
  if (count > 0) {
    badge.textContent  = count;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

/**
 * Opens the hand-over confirmation modal for a specific pending request.
 * On confirm, calls the Apps Script with action "confirmBorrow" and the
 * row identifier so the backend can flip status Pending → Borrowed and
 * decrement stock.
 */
function confirmHandover(index) {
  const req = allPending[index];
  if (!req) return;

  document.getElementById("handoverMessage").innerHTML =
    `Hand over <strong>${req.item}</strong> to <strong>${req.studentName || req.studentId}</strong>?
     <br><small style="color:var(--text-muted);">Status will change to <em>Borrowed</em> and stock will decrease by 1.</small>`;

  const modal = document.getElementById("handoverModal");
  modal.style.display = "flex";

  pendingHandoverCallback = () => {
    modal.style.display = "none";
    executeHandover(req);
  };
  pendingRejectCallback = null;

  document.getElementById("handoverYes").onclick = pendingHandoverCallback;
  document.getElementById("handoverNo").onclick  = () => { modal.style.display = "none"; };
}

function executeHandover(req) {
  showNotification("Processing hand-over…", "info");

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({
      action:    "confirmBorrow",
      studentId: req.studentId,
      item:      req.item,
      rowIndex:  req.rowIndex   // pass spreadsheet row index for targeted update
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification(`✅ "${req.item}" handed over to ${req.studentName || req.studentId}`, "success");
      loadPendingRequests();
      loadTransactions();
      loadItemsTable();
    } else {
      showNotification(data.message || "Hand-over failed. Please try again.", "error");
    }
  })
  .catch(() => showNotification("Network error during hand-over.", "error"));
}

/**
 * Opens the reject confirmation modal. On confirm, calls Apps Script with
 * action "rejectBorrow" to mark the row as Rejected (no stock change).
 */
function confirmReject(index) {
  const req = allPending[index];
  if (!req) return;

  document.getElementById("rejectMessage").innerHTML =
    `Reject the request for <strong>${req.item}</strong> from <strong>${req.studentName || req.studentId}</strong>?
     <br><small style="color:var(--text-muted);">The request will be marked <em>Rejected</em>. No stock change will occur.</small>`;

  const modal = document.getElementById("rejectModal");
  modal.style.display = "flex";

  document.getElementById("rejectYes").onclick = () => {
    modal.style.display = "none";
    executeReject(req);
  };
  document.getElementById("rejectNo").onclick = () => { modal.style.display = "none"; };
}

function executeReject(req) {
  showNotification("Rejecting request…", "info");

  fetch(scriptURL, {
    method: "POST",
    body: JSON.stringify({
      action:    "rejectBorrow",
      studentId: req.studentId,
      item:      req.item,
      rowIndex:  req.rowIndex
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      showNotification(`Request for "${req.item}" rejected.`, "info");
      loadPendingRequests();
      loadTransactions();
    } else {
      showNotification(data.message || "Rejection failed. Please try again.", "error");
    }
  })
  .catch(() => showNotification("Network error during rejection.", "error"));
}

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
    const cls = s === "returned"  ? "status-returned"
              : s === "borrowed"  ? "status-borrowed"
              : s === "overdue"   ? "status-overdue"
              : s === "pending"   ? "status-pending"
              : s === "rejected"  ? "status-rejected"
              : "";
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
    const filtered = allTransactions.filter(tx =>
      String(tx.studentId).toLowerCase().includes(query) ||
      String(tx.item).toLowerCase().includes(query) ||
      String(tx.studentName || "").toLowerCase().includes(query)
    );
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

  if (!name)           { showNotification("Item name is required.", "error"); return; }
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
    text:         String(studentId),
    width:        200,
    height:       200,
    colorDark:    "#000000",
    colorLight:   "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
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
    const q        = e.target.value.toLowerCase();
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
  if (modalId === "borrowersModal")         showBorrowersList();
  else if (modalId === "transactionsModal") showTransactionsList();
  else if (modalId === "overdueModal")      showOverdueList();
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
    const cls = s === "returned" ? "status-returned"
              : s === "borrowed" ? "status-borrowed"
              : s === "overdue"  ? "status-overdue"
              : s === "pending"  ? "status-pending"
              : s === "rejected" ? "status-rejected"
              : "";
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
  document.getElementById("overdueItems").innerText      = allTransactions.filter(tx => tx.status === "Overdue").length;
  document.getElementById("totalPending").innerText      = allPending.length;
  updatePendingBadge(allPending.length);
}