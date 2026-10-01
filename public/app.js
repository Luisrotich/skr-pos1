const root = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const state = {
  user: null,
  page: 'dashboard',
  products: [],
  cart: new Map(),
  register: null,
  online: navigator.onLine,
  searchTimer: 0,
  searchVersion: 0,
  searchController: null,
  checkoutId: null,
  searchCache: new Map(),
};
const money = (value) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(Number(value || 0));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function toast(message, isError = false) {
  toastNode.textContent = message;
  toastNode.classList.toggle('toast-error', isError);
  toastNode.classList.add('toast-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastNode.classList.remove('toast-visible'), 3200);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      credentials: 'same-origin', cache: 'no-store',
    });
    if (response.status === 503) setOffline();
    else {
      state.online = true;
      document.querySelectorAll('.connection-badge').forEach((badge) => { badge.textContent = 'Online'; badge.classList.remove('offline'); });
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    setOffline();
    document.querySelector('#complete-sale')?.setAttribute('disabled', '');
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function searchProducts(value, onResults) {
  const normalized = value.trim();
  const cacheKey = normalized.toLowerCase();
  const cached = state.searchCache.get(cacheKey);

  if (!normalized) {
    onResults(state.products.slice(0, 40));
    return;
  }

  if (cached && Date.now() - cached.cachedAt < 5000) {
    onResults(cached.products);
    return;
  }

  if (normalized.length < 2 && !/^\d+$/.test(normalized)) {
    onResults([]);
    return;
  }

  clearTimeout(state.searchTimer);
  state.searchController?.abort();
  const requestVersion = ++state.searchVersion;
  state.searchTimer = setTimeout(async () => {
    const controller = new AbortController();
    state.searchController = controller;
    try {
      const result = await api(`/products?q=${encodeURIComponent(normalized)}&limit=40`, { signal: controller.signal });
      if (requestVersion === state.searchVersion) {
        const products = result.products.slice(0, 40);
        state.searchCache.set(cacheKey, { cachedAt: Date.now(), products });
        onResults(products);
      }
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message, true);
    }
  }, 120);
}

function setOffline() {
  state.online = false;
  document.querySelectorAll('.connection-badge').forEach((badge) => {
    badge.textContent = 'Offline'; badge.classList.add('offline');
  });
}

window.addEventListener('offline', setOffline);
window.addEventListener('online', () => {
  state.online = true;
  document.querySelectorAll('.connection-badge').forEach((badge) => { badge.textContent = 'Online'; badge.classList.remove('offline'); });
  renderCart();
});

function showAuth(mode = 'login', error = '') {
  const setup = mode === 'setup';
  root.innerHTML = `
    <main class="auth-layout">
      <section class="auth-aside"><div class="brand-lockup"><span class="brand-mark">R</span><span>ROTICH<span class="brand-light"> / POS</span></span></div>
        <div class="auth-message"><p class="eyebrow">SALES DESK</p><h1>Good business<br>starts here.</h1><p>A clear view of every sale, every shift, every shelf.</p></div><span class="aside-index">01 — DAILY OPERATIONS</span>
      </section>
      <section class="auth-form-wrap"><div class="auth-form-head"><span class="connection-badge">${state.online ? 'Connected' : 'Offline'}</span><span class="secure-label">SECURE ACCESS</span></div>
        <form id="auth-form" class="auth-form"><p class="eyebrow">${setup ? 'FIRST-RUN SETUP' : 'WELCOME BACK'}</p><h2>${setup ? 'Create your admin' : 'Sign in'}</h2>
          <p class="form-intro">${setup ? 'This creates the only initial administrator account.' : 'Use your ROTICH POS account to continue.'}</p>
          ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
          ${setup ? '<label>Full name<input name="name" autocomplete="name" required minlength="2" maxlength="100"></label>' : ''}
          <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="64" autocapitalize="none"></label>
          <label>Password<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 12 : 1}" maxlength="256"></label>
          ${setup ? '<p class="field-hint">Use at least 12 characters. This password cannot be recovered.</p>' : ''}
          <button class="button button-primary button-wide" type="submit">${setup ? 'Create admin account' : 'Sign in'} <span aria-hidden="true">→</span></button>
        </form><p class="auth-foot">ROTICH POS <span>•</span> Cash sales only</p></section>
    </main>`;
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      if (setup) {
        await api('/setup/initial-admin', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        toast('Admin account created. Sign in to continue.'); showAuth('login');
      } else {
        const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        state.user = result.user; await openApp();
      }
    } catch (error) {
      if (!state.online) setOffline();
      button.disabled = false; showAuth(setup ? 'setup' : 'login', error.message);
    }
  });
}

function shell(content) {
  const admin = state.user.role === 'ADMIN';
  const nav = admin
    ? [['dashboard', 'Overview', '◫'], ['products', 'Products', '▦'], ['categories', 'Categories', '◈'], ['inventory', 'Inventory', '▤'], ['sales', 'Sales', '↗'], ['cashiers', 'Cashiers', '♙'], ['registers', 'Registers', '◷'], ['expenses', 'Expenses', '−'], ['reports', 'Reports', '▥'], ['audit', 'Audit log', '≡']]
    : [['pos', 'New sale', '＋'], ['my-sales', 'Recent receipts', '▧']];
  root.innerHTML = `<div class="app-frame"><aside class="sidebar"><a class="brand-lockup" href="#dashboard"><span class="brand-mark">R</span><span>ROTICH<span class="brand-light"> / POS</span></span></a>
    <div class="workspace-label">WORKSPACE <span>MAIN REGISTER</span></div><nav class="side-nav" aria-label="Main navigation">${nav.map(([id, label, icon]) => `<button class="nav-item ${state.page === id ? 'active' : ''}" data-page="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="user-chip"><span class="avatar">${escapeHtml(state.user.name.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(state.user.name)}</strong><small>${admin ? 'Administrator' : 'Cashier'}</small></span></div><button class="signout-button" id="signout" title="Sign out" aria-label="Sign out">↗</button></div></aside>
    <main class="main-area"><header class="topbar"><div class="breadcrumb">ROTICH <span>/</span> ${escapeHtml(state.page.replace('-', ' '))}</div><div class="topbar-right"><span class="connection-badge ${state.online ? '' : 'offline'}">${state.online ? 'Online' : 'Offline'}</span><span class="date-label">${new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium' }).format(new Date())}</span><button class="signout-button mobile-signout" id="signout-mobile" title="Sign out" aria-label="Sign out">↗</button></div></header><div class="page-content">${content}</div></main></div>`;
  root.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => loadPage(button.dataset.page)));
  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* The session may already have expired. */ }
    state.user = null; showAuth('login');
  };
  document.querySelector('#signout').addEventListener('click', signOut);
  document.querySelector('#signout-mobile').addEventListener('click', signOut);
}

async function loadPage(page = state.page) {
  state.page = page;
  try {
    if (page === 'pos') return await renderPos();
    if (page === 'my-sales') return await renderSales(true);
    if (page === 'dashboard') {
      const data = await api('/dashboard');
      shell(`<div class="page-heading"><div><p class="eyebrow">TODAY AT A GLANCE</p><h1>Overview</h1></div><span class="date-pill">${new Intl.DateTimeFormat('en-KE', { dateStyle: 'full' }).format(new Date())}</span></div>
        <section class="metric-grid">${metric('Sales today', money(data.summary.today_sales), 'Cash received')}${metric('Transactions', data.summary.transactions, 'Completed today')}${metric('Products', data.summary.products, `${data.summary.low_stock} low in stock`)}${metric('Gross profit', money(data.summary.today_profit), `${money(data.summary.today_expenses)} expenses`)}</section>
        <section class="content-section"><div class="section-heading"><div><p class="eyebrow">LATEST ACTIVITY</p><h2>Recent sales</h2></div><button class="text-button" data-page="sales">All sales →</button></div>${saleTable(data.recentSales)}</section>`);
    } else if (page === 'products') await renderProducts();
    else if (page === 'categories') await renderCategories();
    else if (page === 'inventory') await renderInventory();
    else if (page === 'sales') await renderSales(false);
    else if (page === 'cashiers') await renderCashiers();
    else if (page === 'registers') await renderRegisters();
    else if (page === 'expenses') await renderExpenses();
    else if (page === 'reports') await renderReports();
    else if (page === 'audit') await renderAudit();
    root.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => loadPage(button.dataset.page)));
    bindReceiptActions();
  } catch (error) {
    if (!state.online) setOffline();
    shell(`<div class="page-heading"><div><p class="eyebrow">CONNECTION REQUIRED</p><h1>${state.online ? 'Unable to load this view' : 'You are offline'}</h1></div></div><div class="empty-state"><span>!</span><h2>${escapeHtml(error.message)}</h2><p>POS records are never saved offline. Reconnect to continue.</p><button class="button button-secondary" id="retry">Try again</button></div>`);
    document.querySelector('#retry').addEventListener('click', () => loadPage(page));
  }
}

function metric(label, value, note) { return `<article class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`; }
function saleTable(sales, allowVoid = false) {
  if (!sales?.length) return '<div class="empty-inline">No sales recorded yet.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Cashier</th><th>Date</th><th class="align-right">Total</th>${allowVoid ? '<th>Status</th><th></th>' : ''}</tr></thead><tbody>${sales.map((sale) => `<tr><td><button class="table-link" data-receipt="${escapeHtml(sale.id)}">${escapeHtml(sale.receipt_number)}</button></td><td>${escapeHtml(sale.cashier_name)}</td><td>${new Date(sale.created_at).toLocaleString()}</td><td class="align-right">${money(sale.total)}</td>${allowVoid ? `<td><span class="stock-tag ${sale.status === 'VOIDED' ? 'stock-low' : ''}">${sale.status}</span></td><td>${sale.status === 'COMPLETED' ? `<button class="text-button" data-void="${escapeHtml(sale.id)}">Void</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

async function renderProducts() {
  const data = await api('/products?limit=100');
  state.products = data.products;
  shell(`<div class="page-heading"><div><p class="eyebrow">CATALOG</p><h1>Products</h1></div><button class="button button-primary" id="add-product">＋ Add product</button></div><div class="toolbar"><label class="search-box"><span>⌕</span><input id="product-search" placeholder="Search name, SKU or barcode" autocomplete="off"></label><span class="result-count">${data.products.length} products</span></div><div id="product-table">${productTable(data.products)}</div>`);
  document.querySelector('#add-product').addEventListener('click', () => openProductForm());
  document.querySelector('#product-search').addEventListener('input', (event) => {
    searchProducts(event.target.value, (products) => {
      document.querySelector('#product-table').innerHTML = productTable(products);
      bindProductActions();
    });
  });
  bindProductActions();
}

function productTable(products) {
  if (!products.length) return '<div class="empty-state"><span>▦</span><h2>No products found</h2><p>Add products to begin taking sales.</p></div>';
  return `<div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th>Category</th><th class="align-right">Price</th><th class="align-right">In stock</th><th></th></tr></thead><tbody>${products.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.category_name || 'Uncategorized')}</td><td class="align-right">${money(item.selling_price)}</td><td class="align-right">${item.stock_quantity}</td><td><button class="icon-button" data-deactivate="${item.id}" aria-label="Deactivate ${escapeHtml(item.name)}" title="Deactivate product">×</button></td></tr>`).join('')}</tbody></table></div>`;
}
function bindProductActions() {
  document.querySelectorAll('[data-deactivate]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Deactivate this product? It will no longer appear at checkout.')) return;
    try { await api(`/products/${button.dataset.deactivate}`, { method: 'DELETE' }); toast('Product deactivated.'); await renderProducts(); }
    catch (error) { toast(error.message, true); }
  }));
}

async function openProductForm() {
  const categories = await api('/categories');
  const dialog = document.createElement('dialog'); dialog.className = 'modal';
  dialog.innerHTML = `<form id="product-form"><div class="modal-heading"><div><p class="eyebrow">CATALOG</p><h2>Add product</h2></div><button class="icon-button" type="button" data-close aria-label="Close">×</button></div><div class="form-grid"><label class="span-two">Product name<input name="name" required maxlength="160"></label><label>SKU<input name="sku" required maxlength="80"></label><label>Barcode<input name="barcode" maxlength="100"></label><label>Category<select name="categoryId"><option value="">Uncategorized</option>${categories.categories.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Selling price<input name="sellingPrice" type="number" min="0" step="0.01" required></label><label>Cost price<input name="costPrice" type="number" min="0" step="0.01" value="0" required></label><label>Opening stock<input name="stockQuantity" type="number" min="0" step="1" value="0" required></label><label>Low-stock alert<input name="lowStockThreshold" type="number" min="0" step="1" value="5" required></label></div><div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button class="button button-primary" id="save-product" type="submit">Save product</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('#product-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = dialog.querySelector('#save-product'); button.disabled = true;
  try {
  const formData = Object.fromEntries(new FormData(event.currentTarget));

  const result = await api('/products', {
    method: 'POST',
    body: JSON.stringify(formData)
  });

  dialog.close();

 // Immediately add the new product to the current list
await renderProducts();
  toast('Product created.');
} catch (error) {
  button.disabled = false;
  toast(error.message, true);
}
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
}

async function renderInventory() {
  const data = await api('/inventory');
  shell(`<div class="page-heading"><div><p class="eyebrow">STOCK CONTROL</p><h1>Inventory</h1></div></div><div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th class="align-right">On hand</th><th class="align-right">Alert at</th><th>Status</th><th></th></tr></thead><tbody>${data.inventory.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.sku)}</td><td class="align-right">${item.stock_quantity}</td><td class="align-right">${item.low_stock_threshold}</td><td><span class="stock-tag ${item.low_stock ? 'stock-low' : ''}">${item.low_stock ? 'Low stock' : 'In stock'}</span></td><td><button class="text-button" data-adjust="${item.id}" data-name="${escapeHtml(item.name)}">Adjust</button></td></tr>`).join('')}</tbody></table></div>`);
  document.querySelectorAll('[data-adjust]').forEach((button) => button.addEventListener('click', async () => {
    const quantity = Number(prompt(`Adjustment for ${button.dataset.name}. Use a negative number to remove stock.`));
    if (!Number.isInteger(quantity) || quantity === 0) return;
    const reason = prompt('Reason for adjustment:'); if (!reason?.trim()) return;
    try { await api('/inventory/adjust', { method: 'POST', body: JSON.stringify({ productId: button.dataset.adjust, quantity, reason }) }); toast('Stock adjusted.'); await renderInventory(); }
    catch (error) { toast(error.message, true); }
  }));
}

async function renderCategories() {
  const data = await api('/categories');
  shell(`<div class="page-heading"><div><p class="eyebrow">PRODUCT ORGANIZATION</p><h1>Categories</h1></div><button class="button button-primary" id="add-category">＋ Add category</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>${data.categories.map((item) => `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.description || '—')}</td><td><button class="text-button" data-category="${item.id}" data-name="${escapeHtml(item.name)}" data-description="${escapeHtml(item.description || '')}">Edit</button><button class="icon-button" data-delete-category="${item.id}" aria-label="Deactivate ${escapeHtml(item.name)}">×</button></td></tr>`).join('') || '<tr><td colspan="3">No categories yet.</td></tr>'}</tbody></table></div>`);
  document.querySelector('#add-category').addEventListener('click', async () => {
    const name = prompt('Category name:'); if (!name) return;
    const description = prompt('Description (optional):') || '';
    try { await api('/categories', { method: 'POST', body: JSON.stringify({ name, description }) }); toast('Category created.'); await renderCategories(); }
    catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', async () => {
    const name = prompt('Category name:', button.dataset.name); if (!name) return;
    const description = prompt('Description:', button.dataset.description) || '';
    try { await api(`/categories/${button.dataset.category}`, { method: 'PUT', body: JSON.stringify({ name, description }) }); toast('Category updated.'); await renderCategories(); }
    catch (error) { toast(error.message, true); }
  }));
  document.querySelectorAll('[data-delete-category]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Deactivate this category? Products will remain available.')) return;
    try { await api(`/categories/${button.dataset.deleteCategory}`, { method: 'DELETE' }); toast('Category deactivated.'); await renderCategories(); }
    catch (error) { toast(error.message, true); }
  }));
}

async function renderRegisters() {
  const data = await api('/register/sessions');
  shell(`<div class="page-heading"><div><p class="eyebrow">CASH CONTROL</p><h1>Register sessions</h1></div></div><div class="table-wrap"><table><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Status</th><th class="align-right">Opening</th><th class="align-right">Expected</th><th class="align-right">Counted</th><th class="align-right">Variance</th></tr></thead><tbody>${data.sessions.map((item) => `<tr><td><strong>${escapeHtml(item.cashier_name)}</strong></td><td>${new Date(item.opened_at).toLocaleString()}</td><td>${item.closed_at ? new Date(item.closed_at).toLocaleString() : '—'}</td><td><span class="stock-tag ${item.status === 'OPEN' ? '' : 'stock-low'}">${item.status}</span></td><td class="align-right">${money(item.opening_balance)}</td><td class="align-right">${item.expected_closing_balance == null ? '—' : money(item.expected_closing_balance)}</td><td class="align-right">${item.closing_balance == null ? '—' : money(item.closing_balance)}</td><td class="align-right">${item.variance == null ? '—' : money(item.variance)}</td></tr>`).join('') || '<tr><td colspan="8">No register sessions yet.</td></tr>'}</tbody></table></div>`);
}

async function renderSales(own, filters = {}) {
  const params = new URLSearchParams({ limit: '100', ...filters });
  const data = await api(`/sales?${params}`);
  shell(`<div class="page-heading"><div><p class="eyebrow">${own ? 'CASHIER HISTORY' : 'TRANSACTION HISTORY'}</p><h1>${own ? 'Recent receipts' : 'Sales'}</h1></div></div>
    ${own ? '' : `<form id="sales-filter" class="toolbar"><label>Receipt<input name="receipt" placeholder="Receipt number" value="${escapeHtml(filters.receipt || '')}"></label><label>From<input name="from" type="date" value="${escapeHtml(filters.from || '')}"></label><label>To<input name="to" type="date" value="${escapeHtml(filters.to || '')}"></label><button class="button button-secondary" type="submit">Filter</button></form>`}
    ${saleTable(data.sales, !own)}`);
  bindReceiptActions();
  bindVoidActions();
  document.querySelector('#sales-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    renderSales(false, Object.fromEntries(Object.entries(values).filter(([, value]) => value)));
  });
}
function bindReceiptActions() {
  document.querySelectorAll('[data-receipt]').forEach((button) => button.addEventListener('click', async () => {
    try { printReceipt(await api(`/sales/${button.dataset.receipt}`)); }
    catch (error) { toast(error.message, true); }
  }));
}
function bindVoidActions() {
  document.querySelectorAll('[data-void]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Void this sale and return its items to inventory?')) return;
    const reason = prompt('Reason for voiding this sale:'); if (!reason?.trim()) return;
    try {
      await api(`/sales/${button.dataset.void}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      toast('Sale voided and stock restored.'); await renderSales(false);
    } catch (error) { toast(error.message, true); }
  }));
}
function printReceipt(data) {
  const sale = data.sale; const printWindow = window.open('', '_blank', 'width=420,height=720');
  if (!printWindow) return toast('Allow pop-ups to print this receipt.', true);
  const rows = data.items.map((item) => `<tr><td>${escapeHtml(item.name)}<br>${item.quantity} × ${money(item.unit_price)}</td><td>${money(item.subtotal)}</td></tr>`).join('');
  printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sale.receipt_number)}</title><style>body{font:13px monospace;width:72mm;margin:5mm auto;color:#111}h1,p{text-align:center;margin:5px 0}table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:4px 0;vertical-align:top}td:last-child{text-align:right}.total{font-weight:bold;border-top:1px dashed #111;padding-top:8px}.center{text-align:center}@media print{body{width:auto;margin:0}}</style></head><body><h1>ROTICH POS</h1><p>Receipt ${escapeHtml(sale.receipt_number)}</p><p>${new Date(sale.created_at).toLocaleString()}</p><p>Cashier: ${escapeHtml(sale.cashier_name || state.user.name)}</p><hr><table>${rows}</table><hr><table><tr><td>Subtotal</td><td>${money(sale.subtotal)}</td></tr><tr class="total"><td>TOTAL</td><td>${money(sale.total)}</td></tr><tr><td>Paid</td><td>${money(sale.amount_paid)}</td></tr><tr><td>Change</td><td>${money(sale.change_due ?? sale.change)}</td></tr></table><p>Payment: CASH</p><p class="center">Thank you for shopping with us.</p><script>window.onload=()=>window.print()<\/script></body></html>`);
  printWindow.document.close();
}

async function renderCashiers() {
  const data = await api('/users');
  shell(`<div class="page-heading"><div><p class="eyebrow">TEAM ACCESS</p><h1>Cashiers</h1></div><button class="button button-primary" id="add-cashier">＋ Add cashier</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${data.users.filter((user) => user.role === 'CASHIER').map((user) => `<tr><td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.username)}</td><td><span class="stock-tag ${user.status === 'ACTIVE' ? '' : 'stock-low'}">${user.status}</span></td><td>${new Date(user.created_at).toLocaleDateString()}</td><td><button class="text-button" data-user="${user.id}" data-name="${escapeHtml(user.name)}" data-status="${user.status}">Edit</button></td></tr>`).join('') || '<tr><td colspan="5">No cashier accounts yet.</td></tr>'}</tbody></table></div>`);
  document.querySelector('#add-cashier').addEventListener('click', async () => {
    const name = prompt('Cashier full name:'); if (!name) return;
    const username = prompt('Username:'); if (!username) return;
    const password = prompt('Temporary password (at least 12 characters):'); if (!password) return;
    try { await api('/users', { method: 'POST', body: JSON.stringify({ name, username, password }) }); toast('Cashier created.'); await renderCashiers(); }
    catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-user]').forEach((button) => button.addEventListener('click', async () => {
    const name = prompt('Cashier name:', button.dataset.name); if (!name) return;
    const status = button.dataset.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await api(`/users/${button.dataset.user}`, { method: 'PUT', body: JSON.stringify({ name, status }) });
      if (confirm('Reset this cashier password now?')) { const password = prompt('New password (at least 12 characters):'); if (password) await api(`/users/${button.dataset.user}/password`, { method: 'PUT', body: JSON.stringify({ password }) }); }
      toast('Cashier updated.'); await renderCashiers();
    } catch (error) { toast(error.message, true); }
  }));
}

async function renderExpenses() {
  const data = await api('/expenses');
  shell(`<div class="page-heading"><div><p class="eyebrow">CASH CONTROL</p><h1>Expenses</h1></div><button class="button button-primary" id="add-expense">＋ Record expense</button></div><div class="table-wrap"><table><thead><tr><th>Description</th><th>Recorded by</th><th>Date</th><th class="align-right">Amount</th></tr></thead><tbody>${data.expenses.map((item) => `<tr><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.created_by_name)}</td><td>${new Date(item.created_at).toLocaleString()}</td><td class="align-right">${money(item.amount)}</td></tr>`).join('') || '<tr><td colspan="4">No expenses recorded.</td></tr>'}</tbody></table></div>`);
  document.querySelector('#add-expense').addEventListener('click', async () => {
    const description = prompt('Expense description:'); if (!description) return;
    const amount = Number(prompt('Amount (KES):')); if (!Number.isFinite(amount) || amount <= 0) return;
    try { await api('/expenses', { method: 'POST', body: JSON.stringify({ description, amount }) }); toast('Expense recorded.'); await renderExpenses(); }
    catch (error) { toast(error.message, true); }
  });
}

async function renderReports(view = 'sales', groupBy = 'day') {
  const data = view === 'sales' ? await api(`/reports/sales?groupBy=${groupBy}`)
    : view === 'profit' ? await api('/reports/profit')
      : view === 'inventory' ? await api('/reports/inventory') : await api('/reports/expenses');
  let table;
  if (view === 'sales') table = `<div class="toolbar"><label>Group by<select id="report-group">${[['day','Day'],['week','Week'],['month','Month'],['cashier','Cashier'],['product','Product'],['category','Category']].map(([id,label]) => `<option value="${id}" ${groupBy === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="table-wrap"><table><thead><tr><th>Group</th><th class="align-right">Transactions</th><th class="align-right">Units</th><th class="align-right">Revenue</th></tr></thead><tbody>${data.report.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="align-right">${item.transactions}</td><td class="align-right">${item.units}</td><td class="align-right">${money(item.revenue)}</td></tr>`).join('') || '<tr><td colspan="4">No completed sales for this period.</td></tr>'}</tbody></table></div>`;
  else if (view === 'profit') table = `<div class="table-wrap"><table><thead><tr><th>Date</th><th class="align-right">Revenue</th><th class="align-right">Cost</th><th class="align-right">Gross profit</th></tr></thead><tbody>${data.report.map((item) => `<tr><td>${new Date(item.day).toLocaleDateString()}</td><td class="align-right">${money(item.revenue)}</td><td class="align-right">${money(item.cost)}</td><td class="align-right">${money(item.profit)}</td></tr>`).join('') || '<tr><td colspan="4">No completed sales in this period.</td></tr>'}</tbody></table></div>`;
  else if (view === 'inventory') table = `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th class="align-right">Units</th><th class="align-right">Cost value</th><th class="align-right">Retail value</th><th>Status</th></tr></thead><tbody>${data.inventory.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.category_name || 'Uncategorized')}</td><td class="align-right">${item.stock_quantity}</td><td class="align-right">${money(item.stock_quantity * item.cost_price)}</td><td class="align-right">${money(item.stock_quantity * item.selling_price)}</td><td>${item.low_stock ? 'Low stock' : 'In stock'}</td></tr>`).join('') || '<tr><td colspan="6">No active products.</td></tr>'}</tbody></table></div>`;
  else table = `<div class="table-wrap"><table><thead><tr><th>Date</th><th class="align-right">Expenses</th><th class="align-right">Entries</th></tr></thead><tbody>${data.report.map((item) => `<tr><td>${new Date(item.day).toLocaleDateString()}</td><td class="align-right">${money(item.total)}</td><td class="align-right">${item.count}</td></tr>`).join('') || '<tr><td colspan="3">No recorded expenses.</td></tr>'}</tbody></table></div>`;
  shell(`<div class="page-heading"><div><p class="eyebrow">PERFORMANCE</p><h1>Reports</h1></div></div><div class="report-tabs">${[['sales','Sales'],['profit','Profit'],['inventory','Inventory'],['expenses','Expenses']].map(([id,label]) => `<button class="report-tab ${view === id ? 'active' : ''}" data-report="${id}">${label}</button>`).join('')}</div>${table}`);
  document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => renderReports(button.dataset.report)));
  document.querySelector('#report-group')?.addEventListener('change', (event) => renderReports('sales', event.target.value));
}
async function renderAudit() {
  const data = await api('/audit-logs');
  shell(`<div class="page-heading"><div><p class="eyebrow">ACCOUNTABILITY</p><h1>Audit log</h1></div></div><div class="table-wrap"><table><thead><tr><th>Action</th><th>User</th><th>Entity</th><th>Date</th></tr></thead><tbody>${data.logs.map((log) => `<tr><td><strong>${escapeHtml(log.action.replaceAll('_', ' ').toLowerCase())}</strong></td><td>${escapeHtml(log.user_name || 'System')}</td><td>${escapeHtml(log.entity)}</td><td>${new Date(log.created_at).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No activity recorded.</td></tr>'}</tbody></table></div>`);
}

async function renderPos() {
  const [productData, registerData] = await Promise.all([api('/products?limit=40'), api('/register/current')]);
  state.products = productData.products; state.register = registerData.register;
  if (!state.register) {
    shell(`<div class="page-heading"><div><p class="eyebrow">START OF SHIFT</p><h1>Open register</h1><p class="page-subtitle">Enter the cash float counted into the drawer.</p></div></div><form id="open-register" class="register-form"><label>Opening cash balance<input name="openingBalance" type="number" min="0" step="0.01" required autofocus></label><button class="button button-primary" type="submit">Open register →</button></form>`);
    document.querySelector('#open-register').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api('/register/open', { method: 'POST', body: JSON.stringify({ openingBalance: Number(new FormData(event.currentTarget).get('openingBalance')) }) }); toast('Register opened.'); await renderPos(); }
      catch (error) { toast(error.message, true); }
    });
    return;
  }
  shell(`<div class="pos-heading"><div><p class="eyebrow">CASH REGISTER</p><h1>New sale</h1></div><div class="register-open"><span></span> Register open <small>Float ${money(state.register.opening_balance)}</small><button class="text-button" id="close-register">Close shift</button></div></div>
    <div class="pos-layout"><section class="catalog-pane"><label class="search-box pos-search"><span>⌕</span><input id="pos-search" placeholder="Search product, SKU or scan barcode" autocomplete="off"></label><div class="product-grid" id="pos-products">${productCards(state.products)}</div></section>
    <aside class="cart-pane" id="cart-pane"><div class="cart-title"><div><p class="eyebrow">CURRENT ORDER</p><h2>Cart <span id="cart-count">0</span></h2></div><button class="text-button" id="clear-cart">Clear</button></div><div class="cart-items" id="cart-items"></div><div class="cart-summary"><div><span>Subtotal</span><strong id="cart-subtotal">${money(0)}</strong></div><div class="cart-total"><span>Total due</span><strong id="cart-total">${money(0)}</strong></div><label class="paid-field">Amount received<input id="amount-paid" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label><div class="change-row"><span>Change</span><strong id="cart-change">${money(0)}</strong></div><button class="button button-primary button-wide" id="complete-sale" disabled>Complete cash sale <span>→</span></button><p class="cash-only-note">CASH PAYMENT</p></div></aside>
    <button class="mobile-cart-toggle" id="mobile-cart-toggle" type="button" aria-expanded="false" aria-controls="cart-pane"><span>Cart</span><strong id="mobile-cart-count">0</strong></button>
    <div class="mobile-cart-backdrop" id="mobile-cart-backdrop"></div></div>`);
  renderCart();
  const mobileCartToggle = document.querySelector('#mobile-cart-toggle');
  const mobileCartBackdrop = document.querySelector('#mobile-cart-backdrop');
  const mobileCartPane = document.querySelector('#cart-pane');
  const setMobileCartState = (open) => {
    if (!mobileCartToggle || !mobileCartPane || !mobileCartBackdrop) return;
    mobileCartPane.classList.toggle('is-open', open);
    mobileCartBackdrop.classList.toggle('is-open', open);
    mobileCartToggle.classList.toggle('is-open', open);
    mobileCartToggle.setAttribute('aria-expanded', String(open));
  };
  mobileCartToggle?.addEventListener('click', () => {
    const isOpen = !mobileCartPane.classList.contains('is-open');
    setMobileCartState(isOpen);
  });
  mobileCartBackdrop?.addEventListener('click', () => setMobileCartState(false));

  document.querySelector('#pos-search').addEventListener('input', (event) => {
    searchProducts(event.target.value, (products) => {
      state.products = products;
      document.querySelector('#pos-products').innerHTML = productCards(state.products);
      bindAddButtons();
    });
  });
  bindAddButtons(); document.querySelector('#amount-paid').addEventListener('input', renderCart);
  document.querySelector('#clear-cart').addEventListener('click', () => { state.cart.clear(); state.checkoutId = null; renderCart(); });
  document.querySelector('#complete-sale').addEventListener('click', completeSale);
  document.querySelector('#close-register').addEventListener('click', closeRegister);
}
function productCards(products) {
  if (!products.length) return '<div class="empty-inline">No matching products.</div>';
  return products.map((item) => `<button class="product-card" data-add="${item.id}" ${Number(item.stock_quantity) < 1 ? 'disabled' : ''}><span class="product-initial">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sku)} · ${item.stock_quantity} available</small><span class="product-price">${money(item.selling_price)} <b>+</b></span></button>`).join('');
}
function bindAddButtons() {
  document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    const product = state.products.find((item) => item.id === button.dataset.add); if (!product) return;
    const existing = state.cart.get(product.id);
    if ((existing?.quantity ?? 0) >= Number(product.stock_quantity)) return toast('Not enough stock available.', true);
    state.checkoutId = null;
    state.cart.set(product.id, { ...product, quantity: (existing?.quantity ?? 0) + 1 }); renderCart();
  }));
}
function renderCart() {
  const container = document.querySelector('#cart-items'); if (!container) return;
  const items = [...state.cart.values()];
  const subtotal = items.reduce((sum, item) => sum + Math.round(Number(item.selling_price) * 100) * item.quantity, 0) / 100;
  const paid = Number(document.querySelector('#amount-paid')?.value || 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  container.innerHTML = items.length ? items.map((item) => `<div class="cart-row"><div class="cart-row-title"><strong>${escapeHtml(item.name)}</strong><small>${money(item.selling_price)} each</small></div><div class="quantity-control"><button data-quantity="${item.id}" data-step="-1" aria-label="Remove one">−</button><span>${item.quantity}</span><button data-quantity="${item.id}" data-step="1" aria-label="Add one">+</button></div><strong>${money(Number(item.selling_price) * item.quantity)}</strong><button class="remove-item" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">×</button></div>`).join('') : '<div class="cart-empty"><span>＋</span><strong>Your cart is empty</strong><small>Add an item to start a sale.</small></div>';
  const cartCount = document.querySelector('#cart-count'); const mobileCartCount = document.querySelector('#mobile-cart-count');
  if (cartCount) cartCount.textContent = String(itemCount);
  if (mobileCartCount) mobileCartCount.textContent = String(itemCount);
  document.querySelector('#cart-subtotal').textContent = money(subtotal); document.querySelector('#cart-total').textContent = money(subtotal);
  document.querySelector('#cart-change').textContent = money(Math.max(0, paid - subtotal));
  document.querySelector('#complete-sale').disabled = !items.length || paid < subtotal || !state.online;
  const mobileCartToggle = document.querySelector('#mobile-cart-toggle');
  if (mobileCartToggle) {
    mobileCartToggle.title = itemCount ? `${itemCount} item${itemCount === 1 ? '' : 's'} in cart` : 'Cart is empty';
    mobileCartToggle.disabled = !items.length;
  }
  container.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => {
    const item = state.cart.get(button.dataset.quantity); const next = item.quantity + Number(button.dataset.step);
    if (next < 1) { state.cart.delete(item.id); state.checkoutId = null; }
    else if (next <= Number(item.stock_quantity)) { state.cart.set(item.id, { ...item, quantity: next }); state.checkoutId = null; }
    else return toast('Not enough stock available.', true);
    renderCart();
  }));
  container.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart.delete(button.dataset.remove); state.checkoutId = null; renderCart(); }));
}
async function completeSale() {
  const button = document.querySelector('#complete-sale'); const amountPaid = Number(document.querySelector('#amount-paid').value); button.disabled = true;
  try {
    state.checkoutId ||= crypto.randomUUID();
    const result = await api('/sales', { method: 'POST', body: JSON.stringify({ items: [...state.cart.values()].map((item) => ({ productId: item.id, quantity: item.quantity })), amountPaid, idempotencyKey: state.checkoutId }) });
    state.cart.clear(); state.checkoutId = null;
    printReceipt({ sale: { ...result.sale, cashier_name: state.user.name }, items: result.sale.items.map((item) => ({ name: item.name, quantity: item.quantity, unit_price: item.unitPrice, subtotal: item.subtotal })) });
    toast(`Sale complete · ${result.sale.receipt_number}`); await renderPos();
  } catch (error) { if (!state.online) setOffline(); toast(error.message, true); button.disabled = !state.online; }
}
async function closeRegister() {
  const closingBalance = Number(prompt('Count the cash in the drawer and enter the closing balance:'));
  if (!Number.isFinite(closingBalance) || closingBalance < 0) return;
  try { const result = await api('/register/close', { method: 'POST', body: JSON.stringify({ closingBalance }) }); state.register = null; toast(`Register closed · variance ${money(result.variance)}`); await renderPos(); }
  catch (error) { toast(error.message, true); }
}
async function openApp() { return loadPage(state.user.role === 'CASHIER' ? 'pos' : 'dashboard'); }
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  try {
    const { setupRequired } = await api('/setup/status');
    if (setupRequired) return showAuth('setup');
    try { const result = await api('/auth/me'); state.user = result.user; await openApp(); }
    catch { showAuth('login'); }
  } catch (error) {
    setOffline(); showAuth('login', error.message === 'Failed to fetch' ? 'The POS server is unavailable. Check your connection and try again.' : error.message);
  }
}
start();