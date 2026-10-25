/* Upcoming Expenses — a Standard Notes editor plugin.
 * The note's text holds the data as JSON, so it is encrypted and synced like any other note.
 *
 * Data shape:
 * {
 *   "version": 1,
 *   "currency": "EUR",
 *   "expenses": [
 *     { "id": "...", "name": "Rent", "amount": 850, "category": "Home",
 *       "date": "2026-11-01", "repeat": "monthly", "until": null,
 *       "paid": ["2026-11-01"] }
 *   ]
 * }
 * "date" is the first due date; "paid" lists the occurrence dates already paid.
 */
(() => {
  'use strict';

  // ---------- state ----------
  let relay = null;
  let note = null;           // note object streamed from Standard Notes
  let lastText = null;       // text we last loaded or saved
  let data = emptyData();
  let readOnly = false;
  let editingId = null;
  const ui = { hidePaid: false, horizon: 12 };

  const $ = (id) => document.getElementById(id);
  const standalone = window.parent === window; // opened directly in a browser for development

  function emptyData() {
    return { version: 1, currency: 'EUR', expenses: [] };
  }

  // ---------- dates (local, string-based to avoid timezone drift) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  const todayStr = () => toStr(new Date());
  const monthKey = (s) => s.slice(0, 7);

  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return toStr(d); }

  // nth occurrence of a series, clamping day 29–31 to the end of shorter months
  function nthDate(start, repeat, n) {
    const d = parse(start);
    if (repeat === 'weekly') return addDays(start, 7 * n);
    if (repeat === 'monthly') {
      const total = d.getMonth() + n;
      const y = d.getFullYear() + Math.floor(total / 12);
      const m = ((total % 12) + 12) % 12;
      return toStr(new Date(y, m, Math.min(d.getDate(), daysInMonth(y, m))));
    }
    if (repeat === 'yearly') {
      const y = d.getFullYear() + n;
      return toStr(new Date(y, d.getMonth(), Math.min(d.getDate(), daysInMonth(y, d.getMonth()))));
    }
    return start;
  }

  function occurrences(exp, from, to) {
    const out = [];
    const end = exp.until && exp.until < to ? exp.until : to;
    if (exp.repeat === 'none' || !exp.repeat) {
      if (exp.date >= from && exp.date <= end) out.push(exp.date);
      return out;
    }
    for (let n = 0; n < 2000; n++) {
      const s = nthDate(exp.date, exp.repeat, n);
      if (s > end) break;
      if (s >= from) out.push(s);
    }
    return out;
  }

  // ---------- formatting ----------
  function money(v) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency || 'EUR' }).format(v);
    } catch { return v.toFixed(2); }
  }
  const monthLabel = (key) =>
    parse(key + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const dayLabel = (s, withMonth) =>
    parse(s).toLocaleDateString(undefined, withMonth ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const repeatLabel = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

  // ---------- computing the view ----------
  function buildView() {
    const today = todayStr();
    const now = new Date();
    const lookBack = toStr(new Date(now.getFullYear() - 1, now.getMonth(), 1));
    const thisMonthStart = toStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const horizonEnd = toStr(new Date(now.getFullYear(), now.getMonth() + ui.horizon, 0));
    const in30 = addDays(today, 30);

    const overdue = [];
    const months = new Map();
    let dueSoon = 0, dueSoonCount = 0, overdueTotal = 0, horizonTotal = 0;

    for (const exp of data.expenses) {
      for (const date of occurrences(exp, lookBack, horizonEnd)) {
        const paid = (exp.paid || []).includes(date);
        const row = { exp, date, paid };
        if (!paid && date < today) {
          overdue.push(row);
          overdueTotal += exp.amount;
          continue;
        }
        if (date < thisMonthStart) continue; // older paid items aren't shown
        if (!paid) {
          horizonTotal += exp.amount;
          if (date <= in30) { dueSoon += exp.amount; dueSoonCount++; }
        }
        const key = monthKey(date);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(row);
      }
    }
    const byDate = (a, b) => a.date.localeCompare(b.date) || a.exp.name.localeCompare(b.exp.name);
    overdue.sort(byDate);
    for (const rows of months.values()) rows.sort(byDate);

    // make sure every month in the horizon appears, even empty ones
    for (let i = 0; i < ui.horizon; i++) {
      const key = monthKey(toStr(new Date(now.getFullYear(), now.getMonth() + i, 1)));
      if (!months.has(key)) months.set(key, []);
    }
    const sortedMonths = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { overdue, months: sortedMonths, overdueTotal, dueSoon, dueSoonCount, horizonTotal, today };
  }

  // ---------- rendering ----------
  function rowHtml({ exp, date, paid }, today) {
    const late = !paid && date < today;
    const cls = ['row', paid ? 'is-paid' : '', late ? 'is-late' : '', date === today ? 'is-today' : ''].join(' ');
    const meta = [exp.category, repeatLabel[exp.repeat]].filter(Boolean).map(esc).join(', ');
    return `
      <li class="${cls}">
        <label class="check" title="${paid ? 'Mark as unpaid' : 'Mark as paid'}">
          <input type="checkbox" data-toggle="${esc(exp.id)}" data-date="${date}" ${paid ? 'checked' : ''} ${readOnly ? 'disabled' : ''}>
        </label>
        <span class="day">${esc(dayLabel(date, late))}</span>
        <button type="button" class="name" data-edit="${esc(exp.id)}" ${readOnly ? 'disabled' : ''}>
          ${esc(exp.name)}${meta ? `<small>${meta}</small>` : ''}
        </button>
        <span class="amount">${esc(money(exp.amount))}</span>
      </li>`;
  }

  function render() {
    const v = buildView();

    $('summary').innerHTML = `
      <p><strong>${esc(money(v.dueSoon))}</strong> due in the next 30 days
        <span class="muted">(${v.dueSoonCount} ${v.dueSoonCount === 1 ? 'payment' : 'payments'})</span></p>
      ${v.overdueTotal > 0 ? `<p class="late"><strong>${esc(money(v.overdueTotal))}</strong> overdue</p>` : ''}
      <p class="muted">${esc(money(v.horizonTotal))} still to pay over the next ${ui.horizon} months</p>`;

    let html = '';
    if (v.overdue.length) {
      html += `<div class="month overdue">
        <h2><span>Overdue</span><span>${esc(money(v.overdueTotal))}</span></h2>
        <ul>${v.overdue.map((r) => rowHtml(r, v.today)).join('')}</ul></div>`;
    }

    let running = v.overdueTotal;
    for (const [key, all] of v.months) {
      const rows = ui.hidePaid ? all.filter((r) => !r.paid) : all;
      const unpaid = all.filter((r) => !r.paid).reduce((s, r) => s + r.exp.amount, 0);
      running += unpaid;
      html += `<div class="month">
        <h2><span>${esc(monthLabel(key))}</span>
          <span>${esc(money(unpaid))} <small class="muted" title="Running total of unpaid expenses">${esc(money(running))} total</small></span></h2>
        ${rows.length ? `<ul>${rows.map((r) => rowHtml(r, v.today)).join('')}</ul>`
                      : `<p class="empty">${all.length ? 'All paid.' : 'Nothing planned.'}</p>`}
      </div>`;
    }
    if (!data.expenses.length) {
      html = `<p class="empty lead">Add your first upcoming expense above: a bill, a subscription, a yearly tax, anything you know is coming.</p>` + html;
    }
    $('timeline').innerHTML = html;

    const cats = [...new Set(data.expenses.map((e) => e.category).filter(Boolean))].sort();
    $('categories').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');

    $('form').classList.toggle('disabled', readOnly);
    for (const el of $('form').elements) el.disabled = readOnly;
  }

  // ---------- persistence ----------
  function previewText() {
    const v = buildView();
    const parts = [`${money(v.dueSoon)} due in 30 days`];
    if (v.overdueTotal > 0) parts.push(`${money(v.overdueTotal)} overdue`);
    return parts.join(', ');
  }

  function save() {
    const text = JSON.stringify(data, null, 2);
    lastText = text;
    render();
    if (!relay || !note || readOnly) return;
    relay.saveItemWithPresave(note, () => {
      note.content.text = text;
      note.content.preview_plain = previewText();
      note.content.preview_html = null;
    });
  }

  function load(text) {
    $('notice').hidden = true;
    readOnly = !!(relay && note && relay.getItemAppDataValue(note, 'locked'));
    if (!text || !text.trim()) {
      data = emptyData();
    } else {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.expenses)) throw new Error('not an expense list');
        data = { ...emptyData(), ...parsed };
      } catch {
        // Never overwrite text we don't understand without asking.
        data = emptyData();
        readOnly = true;
        showNotice(
          'This note already contains text that isn’t an expense list. ' +
          'Switch back to another editor to keep it, or replace it with an empty list.',
          'Replace with empty list',
          () => { readOnly = false; data = emptyData(); $('notice').hidden = true; save(); }
        );
      }
    }
    if (readOnly && $('notice').hidden) showNotice('This note is locked, so changes are turned off.');
    lastText = text;
    resetForm();
    render();
  }

  function showNotice(msg, actionLabel, action) {
    const n = $('notice');
    n.innerHTML = `<p>${esc(msg)}</p>`;
    if (actionLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'danger';
      b.textContent = actionLabel;
      b.addEventListener('click', action);
      n.appendChild(b);
    }
    n.hidden = false;
  }

  // ---------- form ----------
  function resetForm() {
    editingId = null;
    $('form').reset();
    $('f-date').value = todayStr();
    $('f-until').hidden = true;
    $('f-submit').textContent = 'Add expense';
    $('f-cancel').hidden = true;
    $('f-delete').hidden = true;
  }

  function startEdit(id) {
    const exp = data.expenses.find((e) => e.id === id);
    if (!exp) return;
    editingId = id;
    $('f-name').value = exp.name;
    $('f-amount').value = exp.amount;
    $('f-date').value = exp.date;
    $('f-repeat').value = exp.repeat || 'none';
    $('f-until').value = exp.until || '';
    $('f-until').hidden = (exp.repeat || 'none') === 'none';
    $('f-category').value = exp.category || '';
    $('f-submit').textContent = 'Save changes';
    $('f-cancel').hidden = false;
    $('f-delete').hidden = false;
    $('f-name').focus();
  }

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (readOnly) return;
    const repeat = $('f-repeat').value;
    const fields = {
      name: $('f-name').value.trim(),
      amount: Math.round(parseFloat($('f-amount').value) * 100) / 100,
      date: $('f-date').value,
      repeat,
      until: repeat !== 'none' && $('f-until').value ? $('f-until').value : null,
      category: $('f-category').value.trim(),
    };
    if (!fields.name || !fields.date || !Number.isFinite(fields.amount)) return;
    if (editingId) {
      const exp = data.expenses.find((x) => x.id === editingId);
      Object.assign(exp, fields);
    } else {
      data.expenses.push({ id: newId(), ...fields, paid: [] });
    }
    resetForm();
    save();
  });

  $('f-repeat').addEventListener('change', () => { $('f-until').hidden = $('f-repeat').value === 'none'; });
  $('f-cancel').addEventListener('click', resetForm);
  $('f-delete').addEventListener('click', () => {
    const exp = data.expenses.find((x) => x.id === editingId);
    if (!exp) return;
    const msg = exp.repeat && exp.repeat !== 'none'
      ? `Delete “${exp.name}” and all its future payments?` : `Delete “${exp.name}”?`;
    if (!confirm(msg)) return;
    data.expenses = data.expenses.filter((x) => x.id !== editingId);
    resetForm();
    save();
  });

  // ---------- timeline interactions ----------
  $('timeline').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset.toggle || readOnly) return;
    const exp = data.expenses.find((x) => x.id === t.dataset.toggle);
    if (!exp) return;
    const set = new Set(exp.paid || []);
    t.checked ? set.add(t.dataset.date) : set.delete(t.dataset.date);
    exp.paid = [...set].sort();
    save();
  });
  $('timeline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) startEdit(b.dataset.edit);
  });

  $('hide-paid').addEventListener('change', (e) => { ui.hidePaid = e.target.checked; render(); });
  $('horizon').addEventListener('change', (e) => { ui.horizon = Number(e.target.value); render(); });

  // ---------- start ----------
  if (standalone || typeof ComponentRelay === 'undefined') {
    // Development preview with sample data (nothing is saved).
    const t = todayStr();
    data = {
      version: 1, currency: 'EUR', expenses: [
        { id: 'a', name: 'Rent', amount: 850, category: 'Home', date: t.slice(0, 8) + '01', repeat: 'monthly', until: null, paid: [] },
        { id: 'b', name: 'Car insurance', amount: 420, category: 'Car', date: addDays(t, 20), repeat: 'yearly', until: null, paid: [] },
        { id: 'c', name: 'Phone', amount: 19.99, category: 'Subscriptions', date: addDays(t, -3), repeat: 'monthly', until: null, paid: [] },
        { id: 'd', name: 'New laptop', amount: 1200, category: 'Tech', date: addDays(t, 75), repeat: 'none', until: null, paid: [] },
      ],
    };
    resetForm();
    render();
  } else {
    const Relay = ComponentRelay.default || ComponentRelay;
    relay = new Relay({
      targetWindow: window,
      options: { coallesedSaving: true, coallesedSavingDelay: 400, acceptsThemes: true },
    });
    relay.streamContextItem((item) => {
      const isNewNote = !note || item.uuid !== note.uuid;
      note = item;
      if (item.isMetadataUpdate) return;
      const text = item.content.text || '';
      // Reload when switching notes or when the text changed elsewhere (e.g. another device).
      if (isNewNote || text !== lastText) load(text);
    });
  }
})();
