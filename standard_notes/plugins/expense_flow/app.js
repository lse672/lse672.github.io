/* Expense Flow — a Standard Notes editor plugin.
 * The note's text holds the data as JSON, so it is encrypted and synced like any other note.
 *
 * Data shape:
 * {
 *   "kind": "expense-flow", "version": 1, "currency": "EUR",
 *   "cats": [{ "id": "food", "name": "Food", "color": "#E0A526",
 *              "subs": [{ "id": "groceries", "name": "Groceries" }] }],
 *   "srcs": [{ "id": "salary", "name": "Salary", "color": "#3F9A5A" }],
 *   "tx":   [{ "id": "...", "type": "out", "amount": 12.5, "label": "Bread",
 *              "cat": "food", "sub": "groceries", "date": "2026-10-02", "note": "" }],
 *   "rec":  [{ "id": "...", "type": "out", "amount": 700, "label": "Rent", "cat": "home", "sub": "rent",
 *              "note": "", "date": "2026-08-05", "repeat": "monthly", "until": null,
 *              "skip": ["2026-09-05"], "edits": { "2026-10-05": { "amount": 710 } } }]
 * }
 * "tx" are one-off entries. "rec" are recurring series: their occurrences are computed,
 * never stored, up to today. "skip" lists deleted occurrences, "edits" per-occurrence changes.
 * Computing occurrences (instead of writing them into the note when it opens) means opening
 * the note on two devices never produces two competing saves.
 */
(() => {
  'use strict';

  const VERSION = '0.1.0'; // keep in sync with ?v= in index.html and "version" in ext.json
  const MARK = 'Expense Flow'; // start of preview_plain, used by the empty-text safety check
  const SAVE_COLOR = '#A7B4C2', DEFICIT_COLOR = '#cc2128', NONE_COLOR = '#9AA4B0';
  const PALETTE = ['#E0A526', '#3B6EA8', '#7A5BB5', '#D2557A', '#4FA3D9', '#E07A3F', '#6B8494', '#13857A', '#4A3F9E', '#9A8F7E', '#3F9A5A', '#B5651D'];

  // ---------- dates (local, string-based to avoid timezone drift) ----------
  // Function declarations, so every helper exists before any state is initialised.
  function pad(n) { return String(n).padStart(2, '0'); }
  function toStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function todayStr() { return toStr(new Date()); }
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
  function occurrences(start, repeat, from, end) {
    const out = [];
    for (let n = 0; n < 3000; n++) {
      const s = nthDate(start, repeat, n);
      if (s > end) break;
      if (s >= from) out.push(s);
    }
    return out;
  }

  // ---------- defaults ----------
  const sub = (id, name) => ({ id, name });
  function defaultCats() {
    return [
      { id: 'food', name: 'Food', color: '#E0A526', subs: [sub('groceries', 'Groceries'), sub('restaurants', 'Restaurants')] },
      { id: 'home', name: 'Housing', color: '#3B6EA8', subs: [sub('rent', 'Rent or mortgage'), sub('energy', 'Energy'), sub('upkeep', 'Upkeep')] },
      { id: 'transport', name: 'Transport', color: '#7A5BB5', subs: [sub('fuel', 'Fuel'), sub('public', 'Public transport'), sub('car', 'Car upkeep')] },
      { id: 'leisure', name: 'Leisure', color: '#D2557A', subs: [sub('outings', 'Outings'), sub('travel', 'Travel'), sub('sport', 'Sport')] },
      { id: 'health', name: 'Health', color: '#4FA3D9', subs: [sub('doctor', 'Doctor'), sub('pharmacy', 'Pharmacy')] },
      { id: 'shopping', name: 'Shopping', color: '#E07A3F', subs: [sub('clothes', 'Clothes'), sub('household', 'Household')] },
      { id: 'bills', name: 'Bills & subscriptions', color: '#6B8494', subs: [sub('telecom', 'Phone & internet'), sub('insurance', 'Insurance'), sub('subscriptions', 'Subscriptions')] },
      { id: 'savings', name: 'Savings', color: '#13857A', subs: [sub('account', 'Savings account'), sub('emergency', 'Emergency fund')] },
      { id: 'invest', name: 'Investments', color: '#4A3F9E', subs: [sub('stocks', 'Stocks'), sub('property', 'Property')] },
      { id: 'other', name: 'Other', color: '#9A8F7E', subs: [] },
    ];
  }
  function defaultSrcs() {
    return [{ id: 'salary', name: 'Salary', color: '#3F9A5A' }, { id: 'other-income', name: 'Other income', color: '#8DBF5A' }];
  }
  function emptyData() {
    return { kind: 'expense-flow', version: 1, currency: 'EUR', cats: defaultCats(), srcs: defaultSrcs(), tx: [], rec: [] };
  }

  // ---------- state ----------
  let relay = null;
  let note = null;           // note object streamed from Standard Notes
  let lastText = null;       // text we last loaded or saved
  let data = emptyData();
  let readOnly = false;
  const ui = { period: todayStr().slice(0, 7), filter: null, search: '', showSubs: true };
  let form = { mode: 'new', id: null, date: null }; // mode: new | tx | occ | series

  const $ = (id) => document.getElementById(id);
  const standalone = window.parent === window; // opened directly in a browser for development
  const diag = { streams: 0, log: [] };

  // ---------- formatting ----------
  const cents = (v) => Math.round((Number(v) || 0) * 100);
  function money(c) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency || 'EUR' }).format(c / 100); }
    catch { return (c / 100).toFixed(2); }
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : NONE_COLOR);
  const monthLabel = (key) => parse(key + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const REPEAT_LABEL = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

  // ---------- model ----------
  function catOf(e) {
    const list = e.type === 'in' ? data.srcs : data.cats;
    return list.find((c) => c.id === e.cat) || { id: '_none', name: e.type === 'in' ? 'Removed source' : 'Uncategorized', color: NONE_COLOR, subs: [] };
  }
  function subOf(e, c) { c = c || catOf(e); return e.sub && c.subs ? c.subs.find((s) => s.id === e.sub) || null : null; }
  function keysOf(e) {
    const c = catOf(e);
    if (e.type === 'in') return ['in:' + c.id];
    const s = subOf(e, c);
    return ['out:' + c.id, 'sub:' + c.id + ':' + (s ? s.id : '_none')];
  }
  function range() {
    if (ui.period === 'all') return ['0000-01-01', '9999-12-31'];
    return [ui.period + '-01', ui.period + '-31'];
  }

  // One-off entries plus the occurrences of every series, from `from` to `to` (never past today).
  function entries(from, to) {
    const out = data.tx.filter((t) => t.date >= from && t.date <= to);
    const today = todayStr();
    const cap = to < today ? to : today;
    for (const r of data.rec) {
      const end = r.until && r.until < cap ? r.until : cap;
      const skip = new Set(r.skip || []);
      for (const d of occurrences(r.date, r.repeat, from, end)) {
        if (skip.has(d)) continue;
        const e = (r.edits && r.edits[d]) || {};
        out.push({
          id: `occ:${r.id}:${d}`, recId: r.id, date: d, type: r.type,
          amount: e.amount ?? r.amount, label: e.label ?? r.label, cat: e.cat ?? r.cat,
          sub: e.sub ?? r.sub, note: e.note ?? r.note, edited: !!(r.edits && r.edits[d]),
        });
      }
    }
    return out;
  }

  function totals() {
    const [from, to] = range();
    const list = entries(from, to);
    let inc = 0, out = 0;
    const byCat = new Map(), bySub = new Map(), bySrc = new Map();
    for (const e of list) {
      const a = cents(e.amount), c = catOf(e);
      if (e.type === 'in') { inc += a; bySrc.set(c.id, (bySrc.get(c.id) || 0) + a); continue; }
      out += a;
      byCat.set(c.id, (byCat.get(c.id) || 0) + a);
      const s = subOf(e, c), sid = s ? s.id : '_none';
      if (!bySub.has(c.id)) bySub.set(c.id, new Map());
      const m = bySub.get(c.id);
      m.set(sid, (m.get(sid) || 0) + a);
    }
    return { list, inc, out, byCat, bySub, bySrc };
  }
  const hasRealSubs = (m) => !!m && [...m.keys()].some((k) => k !== '_none');
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  function subName(cid, sid) {
    if (sid === '_none') return 'Unspecified';
    const c = data.cats.find((x) => x.id === cid);
    const s = c && c.subs.find((x) => x.id === sid);
    return s ? s.name : 'Unspecified';
  }

  // ---------- rendering ----------
  function render() {
    const T = totals();
    const isAll = ui.period === 'all';
    $('month-btn').textContent = isAll ? 'All time' : monthLabel(ui.period);
    $('all-btn').setAttribute('aria-pressed', String(isAll));
    $('prev').disabled = $('next').disabled = isAll;

    const rest = T.inc - T.out;
    const when = isAll ? 'So far' : ui.period === todayStr().slice(0, 7) ? 'This month' : 'In ' + monthLabel(ui.period);
    $('summary').innerHTML = !T.list.length
      ? `<span class="muted">${esc(when)}, nothing recorded yet.</span>`
      : `${esc(when)}, <strong class="in">${esc(money(T.inc))}</strong> came in, <strong>${esc(money(T.out))}</strong> went out, ` +
        (rest >= 0 ? `<strong>${esc(money(rest))}</strong> left.` : `<strong class="neg">${esc(money(-rest))}</strong> over.`);

    drawSankey(T);
    renderTotals(T);
    renderChips(T);
    renderList(T);
    renderRecurring();

    $('form').classList.toggle('disabled', readOnly);
    for (const el of $('form').elements) el.disabled = readOnly || (el.name === 'f-type' && form.mode === 'occ');
  }

  function renderTotals(T) {
    const rows = sortDesc(T.byCat);
    if (!rows.length) { $('totals').innerHTML = '<li class="muted" style="display:block">No spending in this period.</li>'; return; }
    let html = '';
    for (const [id, v] of rows) {
      const c = data.cats.find((x) => x.id === id) || { name: 'Uncategorized', color: NONE_COLOR };
      html += `<li title="${T.out ? Math.round(v / T.out * 100) : 0}% of spending"><span class="dot" style="background:${safeColor(c.color)}"></span><span>${esc(c.name)}</span><span class="num">${esc(money(v))}</span></li>`;
      const m = T.bySub.get(id);
      if (ui.showSubs && hasRealSubs(m)) for (const [sid, sv] of sortDesc(m))
        html += `<li class="sub"><span>${esc(subName(id, sid))}</span><span class="num">${esc(money(sv))}</span></li>`;
    }
    $('totals').innerHTML = html;
  }

  function renderChips(T) {
    const used = new Set(T.list.flatMap(keysOf));
    const chip = (key, name, color) => `<button type="button" class="chip" data-filter="${esc(key || '')}" aria-pressed="${ui.filter === key}">${color ? `<span class="dot" style="background:${safeColor(color)}"></span>` : ''}${esc(name)}</button>`;
    let html = chip(null, 'All');
    for (const c of data.srcs) if (used.has('in:' + c.id)) html += chip('in:' + c.id, c.name, c.color);
    for (const c of data.cats) if (used.has('out:' + c.id)) html += chip('out:' + c.id, c.name, c.color);
    if (used.has('out:_none')) html += chip('out:_none', 'Uncategorized', NONE_COLOR);
    if (ui.filter && ui.filter.startsWith('sub:')) {
      const [, cid, sid] = ui.filter.split(':');
      const c = data.cats.find((x) => x.id === cid);
      html += chip(ui.filter, (c ? c.name : 'Uncategorized') + ' › ' + subName(cid, sid), c ? c.color : NONE_COLOR);
    }
    $('chips').innerHTML = html;
  }

  function renderList(T) {
    const q = ui.search.trim().toLowerCase();
    const rows = T.list.filter((e) => {
      if (ui.filter && !keysOf(e).includes(ui.filter)) return false;
      if (q) {
        const c = catOf(e), s = subOf(e, c);
        if (!`${e.label} ${e.note || ''} ${c.name} ${s ? s.name : ''}`.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || String(a.label).localeCompare(String(b.label)));
    if (!rows.length) {
      $('list').innerHTML = `<p class="empty">${T.list.length ? 'Nothing matches this filter.' : 'Add your first entry above: a purchase, a bill, a salary.'}</p>`;
      return;
    }
    let html = '', day = null;
    for (const e of rows) {
      if (e.date !== day) {
        day = e.date;
        html += `<div class="dayhead">${esc(parse(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: ui.period === 'all' ? 'numeric' : undefined }))}</div>`;
      }
      const c = catOf(e), s = subOf(e, c);
      const meta = [c.name + (s ? ' › ' + s.name : ''), e.recId ? (REPEAT_LABEL[(data.rec.find((r) => r.id === e.recId) || {}).repeat] || 'Recurring') : '', e.note].filter(Boolean).join(' · ');
      html += `<button type="button" class="row" data-edit="${esc(e.id)}">
        <span class="bar" style="background:${safeColor(c.color)}"></span>
        <span class="t">${e.recId ? '↻ ' : ''}${esc(e.label)}<small>${esc(meta)}</small></span>
        <span class="amount${e.type === 'in' ? ' in' : ''}">${e.type === 'in' ? '+' : '−'}${esc(money(cents(e.amount)))}</span></button>`;
    }
    $('list').innerHTML = html;
  }

  function recText(r) {
    const d = parse(r.date);
    let t;
    if (r.repeat === 'weekly') t = 'Every ' + d.toLocaleDateString(undefined, { weekday: 'long' });
    else if (r.repeat === 'monthly') t = 'Monthly, on day ' + d.getDate();
    else t = 'Yearly, on ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    if (r.until) t += r.until < todayStr() ? ', ended ' + parse(r.until).toLocaleDateString() : ', until ' + parse(r.until).toLocaleDateString();
    return t;
  }
  function renderRecurring() {
    if (!data.rec.length) {
      $('recurring').innerHTML = '<p class="empty">None yet. Pick Weekly, Monthly or Yearly when adding an entry.</p>';
      return;
    }
    $('recurring').innerHTML = data.rec.slice().sort((a, b) => a.label.localeCompare(b.label)).map((r) => {
      const c = catOf(r);
      return `<button type="button" class="recrow" data-series="${esc(r.id)}">
        <span class="dot" style="background:${safeColor(c.color)}"></span>
        <span>${esc(r.label)}<small>${esc(recText(r))}</small></span>
        <span class="num"${r.type === 'in' ? ' style="color:var(--success)"' : ''}>${r.type === 'in' ? '+' : '−'}${esc(money(cents(r.amount)))}</span></button>`;
    }).join('');
  }

  // ---------- Sankey diagram (drawn by hand: no outside library) ----------
  let lastT = null;
  function drawSankey(T) {
    lastT = T;
    const box = $('sankey');
    if (!T.inc && !T.out) { box.innerHTML = '<p class="empty">Add an income or an expense to see where your money goes.</p>'; return; }
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#1d2330';
    const cols = [[], [], [], []], links = [];
    const node = (col, key, name, color, value) => { const n = { col, key, name, color: safeColor(color), value, inY: 0, outY: 0 }; cols[col].push(n); return n; };

    const budget = node(1, '', 'Budget', '#000000', Math.max(T.inc, T.out));
    budget.color = fg;
    for (const [id, v] of sortDesc(T.bySrc)) {
      const s = data.srcs.find((x) => x.id === id) || { name: 'Removed source', color: NONE_COLOR };
      links.push([node(0, 'in:' + id, s.name, s.color, v), budget, v]);
    }
    if (T.out > T.inc) links.push([node(0, '', T.inc ? 'Overspent' : 'Not covered by income', DEFICIT_COLOR, T.out - T.inc), budget, T.out - T.inc]);
    for (const [id, v] of sortDesc(T.byCat)) {
      const c = data.cats.find((x) => x.id === id) || { name: 'Uncategorized', color: NONE_COLOR };
      const n = node(2, 'out:' + id, c.name, c.color, v);
      links.push([budget, n, v]);
      const m = T.bySub.get(id);
      if (ui.showSubs && hasRealSubs(m)) for (const [sid, sv] of sortDesc(m)) {
        const sn = node(3, `sub:${id}:${sid}`, subName(id, sid), c.color, sv);
        sn.parent = n;
        links.push([n, sn, sv]);
      }
    }
    if (T.inc > T.out) links.push([budget, node(2, '', 'Unspent', SAVE_COLOR, T.inc - T.out), T.inc - T.out]);

    const nCols = cols[3].length ? 4 : 3;
    const W = Math.max(nCols === 4 ? 560 : 300, box.clientWidth || 600);
    const NW = 12, GAP = 14, M = 14;
    const maxN = Math.max(...cols.map((c) => c.length));
    const k = (Math.max(200, maxN * 40) - GAP * (maxN - 1)) / budget.value; // pixels per cent
    const xOf = (c) => c * (W - NW) / (nCols - 1);
    let H = 0;
    for (let c = 0; c < 3; c++) {
      let y = 0;
      for (const n of cols[c]) { n.x = xOf(c); n.y = y; n.h = Math.max(3, n.value * k); y += n.h + GAP; }
      H = Math.max(H, y - GAP);
    }
    let y = 0;
    for (const n of cols[3]) { y = Math.max(y, n.parent.y); n.x = xOf(3); n.y = y; n.h = Math.max(3, n.value * k); y += n.h + GAP; }
    H = Math.max(H, y - GAP);

    let svg = `<svg width="${W}" height="${H + 2 * M}" viewBox="0 ${-M} ${W} ${H + 2 * M}" role="img" aria-label="Sankey diagram: income to budget, then to categories and sub-categories">`;
    for (const [s, t, v] of links) {
      const w = v * k, x0 = s.x + NW, x1 = t.x, xm = (x0 + x1) / 2;
      const ys = s.y + s.outY, yt = t.y + t.inY;
      s.outY += w; t.inY += w;
      const color = t === budget ? s.color : t.color;
      svg += `<path d="M${x0},${ys}C${xm},${ys} ${xm},${yt} ${x1},${yt}L${x1},${yt + w}C${xm},${yt + w} ${xm},${ys + w} ${x0},${ys + w}Z" fill="${color}" fill-opacity="${s.col === 2 ? 0.3 : 0.42}"><title>${esc(s.name)} → ${esc(t.name)}: ${esc(money(v))}</title></path>`;
    }
    for (const n of cols.flat()) {
      const right = n.col === nCols - 1;
      const lx = right ? n.x - 6 : n.x + NW + 6, cy = n.y + n.h / 2;
      svg += `<rect x="${n.x}" y="${n.y}" width="${NW}" height="${n.h}" rx="2" fill="${n.color}"${n.key ? ` data-key="${esc(n.key)}"` : ''}><title>${esc(n.name)}: ${esc(money(n.value))}</title></rect>`;
      svg += `<text class="lbl" x="${lx}" y="${cy}" dy="-0.15em" text-anchor="${right ? 'end' : 'start'}"><tspan font-weight="600">${esc(n.name)}</tspan><tspan class="amt" x="${lx}" dy="1.2em">${esc(money(n.value))}</tspan></text>`;
    }
    box.innerHTML = svg + '</svg>';
  }
  if (window.ResizeObserver) {
    let w = 0;
    new ResizeObserver((en) => { const nw = Math.round(en[0].contentRect.width); if (nw !== w) { w = nw; if (lastT) drawSankey(lastT); } }).observe($('sankey'));
  }

  // ---------- persistence ----------
  function previewText() {
    const key = todayStr().slice(0, 7);
    const list = entries(key + '-01', key + '-31');
    const sum = (t) => list.filter((e) => e.type === t).reduce((s, e) => s + cents(e.amount), 0);
    return `${MARK} · ${monthLabel(key)}: ${money(sum('in'))} in, ${money(sum('out'))} out`;
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

  function normalise(parsed) {
    const d = { ...emptyData(), ...parsed };
    d.cats = (Array.isArray(d.cats) && d.cats.length ? d.cats : defaultCats()).map((c) => ({ ...c, subs: Array.isArray(c.subs) ? c.subs : [] }));
    d.srcs = Array.isArray(d.srcs) && d.srcs.length ? d.srcs : defaultSrcs();
    d.rec = d.rec.map((r) => ({ skip: [], edits: {}, ...r }));
    return d;
  }

  function load(text) {
    $('notice').hidden = true;
    readOnly = false;
    try { readOnly = !!(relay && note && relay.getItemAppDataValue(note, 'locked')); } catch { /* no app data on this note */ }
    if (!text || !text.trim()) {
      data = emptyData();
    } else {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.tx) || !Array.isArray(parsed.rec)) throw new Error('not an Expense Flow note');
        data = normalise(parsed);
      } catch {
        // Never overwrite text we don't understand without asking.
        data = emptyData();
        readOnly = true;
        showNotice(
          'This note already contains text that isn’t an Expense Flow ledger (it may belong to another editor, such as Upcoming Expenses). ' +
          'Switch back to that editor to keep it, or replace it with an empty ledger.',
          'Replace with empty ledger',
          () => { readOnly = false; data = emptyData(); $('notice').hidden = true; save(); }
        );
      }
    }
    if (readOnly && $('notice').hidden) showNotice('This note is locked, so changes are turned off.');
    lastText = text;
    closeCatEditor();
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
  const F = {
    type: () => document.querySelector('input[name="f-type"]:checked').value,
    setType: (v) => { document.querySelector(`input[name="f-type"][value="${v}"]`).checked = true; },
  };
  function fillCats(type, cat, subId) {
    const list = type === 'in' ? data.srcs : data.cats;
    let opts = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (cat && !list.some((c) => c.id === cat)) opts = `<option value="${esc(cat)}">${type === 'in' ? 'Removed source' : 'Uncategorized'}</option>` + opts;
    $('f-cat').innerHTML = opts;
    if (cat) $('f-cat').value = cat;
    fillSubs(type, subId);
  }
  function fillSubs(type, subId) {
    const c = type === 'out' ? data.cats.find((x) => x.id === $('f-cat').value) : null;
    const subs = c && c.subs ? c.subs : [];
    $('f-sub').innerHTML = '<option value="">No sub-category</option>' + subs.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    $('f-sub').value = subId && subs.some((s) => s.id === subId) ? subId : '';
    $('f-sub').hidden = !subs.length;
  }
  function fillFields(e, type) {
    F.setType(type);
    $('f-amount').value = e ? String(e.amount).replace('.', (1.5).toLocaleString().charAt(1)) : '';
    $('f-label').value = e ? e.label : '';
    $('f-note').value = e ? e.note || '' : '';
    fillCats(type, e ? e.cat : null, e ? e.sub : null);
    $('f-err').textContent = '';
  }
  function setButtons(mode) {
    $('f-title').textContent = { new: 'New entry', tx: 'Edit entry', occ: 'Edit this occurrence', series: 'Edit recurring series' }[mode];
    $('f-submit').textContent = mode === 'new' ? 'Add entry' : 'Save changes';
    $('f-cancel').hidden = mode === 'new';
    $('f-series').hidden = mode !== 'occ';
    $('f-end').hidden = mode !== 'series';
    $('f-delete').hidden = mode === 'new';
    $('f-delete').textContent = mode === 'occ' ? 'Skip this occurrence' : mode === 'series' ? 'Delete series' : 'Delete';
    $('f-repeat').hidden = !(mode === 'new' || mode === 'series');
    $('f-until').hidden = $('f-repeat').hidden || $('f-repeat').value === 'none';
  }
  function resetForm() {
    form = { mode: 'new', id: null, date: null };
    fillFields(null, 'out');
    let d = todayStr();
    if (ui.period !== 'all' && !d.startsWith(ui.period)) d = ui.period + '-01';
    $('f-date').value = d;
    $('f-repeat').value = 'none';
    $('f-until').value = '';
    $('f-info').hidden = true;
    setButtons('new');
    if (relay || standalone) render();
  }
  function scrollTo(el, block) { if (el.scrollIntoView) el.scrollIntoView({ block }); }
  function scrollToForm() { scrollTo($('form'), 'nearest'); $('f-amount').focus(); }

  function startEdit(id) {
    if (readOnly) return;
    if (id.startsWith('occ:')) {
      const [, recId, date] = id.split(':');
      const r = data.rec.find((x) => x.id === recId);
      if (!r) return;
      const e = entries(date, date).find((x) => x.id === id);
      form = { mode: 'occ', id: recId, date };
      fillFields(e, r.type);
      $('f-date').value = date;
      $('f-info').hidden = false;
      $('f-info').textContent = `Part of “${r.label}” (${recText(r).toLowerCase()}). Changes here only affect ${parse(date).toLocaleDateString()}.`;
      setButtons('occ');
    } else {
      const t = data.tx.find((x) => x.id === id);
      if (!t) return;
      form = { mode: 'tx', id, date: null };
      fillFields(t, t.type);
      $('f-date').value = t.date;
      $('f-info').hidden = true;
      setButtons('tx');
    }
    render();
    scrollToForm();
  }
  function startSeries(recId) {
    if (readOnly) return;
    const r = data.rec.find((x) => x.id === recId);
    if (!r) return;
    form = { mode: 'series', id: recId, date: null };
    fillFields(r, r.type);
    $('f-date').value = r.date;
    $('f-repeat').value = r.repeat;
    $('f-until').value = r.until || '';
    $('f-info').hidden = false;
    $('f-info').textContent = 'Changes apply to every occurrence, except the ones you edited one by one. The date is the first occurrence.';
    setButtons('series');
    render();
    scrollToForm();
  }

  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (readOnly) return;
    const err = (m, el) => { $('f-err').textContent = m; if (el) el.focus(); };
    const raw = $('f-amount').value.replace(/\s/g, '').replace(',', '.');
    const amount = Math.round(parseFloat(raw) * 100) / 100;
    if (!/^\d+(\.\d{0,2})?$/.test(raw) || !(amount > 0)) return err('Enter a positive amount, e.g. 12.50.', $('f-amount'));
    const label = $('f-label').value.trim();
    if (!label) return err('Give the entry a title.', $('f-label'));
    const date = $('f-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('Pick a date.', $('f-date'));
    const type = F.type();
    const fields = { type, amount, label, cat: $('f-cat').value, sub: type === 'out' ? $('f-sub').value : '', note: $('f-note').value.trim() };
    const repeat = $('f-repeat').value;
    const until = $('f-until').value || null;

    if (form.mode === 'occ') {
      const r = data.rec.find((x) => x.id === form.id);
      if (!r) return;
      const { type: _t, ...change } = fields;
      if (date !== form.date) {
        // Moving an occurrence: skip the original date and record a one-off entry on the new one.
        r.skip = [...new Set([...(r.skip || []), form.date])].sort();
        if (r.edits) delete r.edits[form.date];
        data.tx.push({ id: newId(), ...fields, date });
      } else {
        r.edits = r.edits || {};
        r.edits[form.date] = change;
      }
    } else if (form.mode === 'series' || (form.mode === 'new' && repeat !== 'none')) {
      if (repeat === 'none') return err('Pick how often it repeats.', $('f-repeat'));
      if (until && until < date) return err('The end date must be after the first occurrence.', $('f-until'));
      if (form.mode === 'series') Object.assign(data.rec.find((x) => x.id === form.id), fields, { date, repeat, until });
      else data.rec.push({ id: newId(), ...fields, date, repeat, until, skip: [], edits: {} });
    } else if (form.mode === 'tx') {
      Object.assign(data.tx.find((x) => x.id === form.id), fields, { date });
    } else {
      data.tx.push({ id: newId(), ...fields, date });
    }
    resetForm();
    save();
  });

  document.querySelectorAll('input[name="f-type"]').forEach((r) => r.addEventListener('change', () => fillCats(F.type(), null, null)));
  $('f-cat').addEventListener('change', () => fillSubs(F.type(), null));
  $('f-repeat').addEventListener('change', () => { $('f-until').hidden = $('f-repeat').value === 'none'; });
  $('f-cancel').addEventListener('click', resetForm);
  $('f-series').addEventListener('click', () => startSeries(form.id));
  $('f-end').addEventListener('click', () => {
    const r = data.rec.find((x) => x.id === form.id);
    if (!r || !confirm(`End “${r.label}” today? Past occurrences are kept.`)) return;
    r.until = todayStr();
    resetForm();
    save();
  });
  $('f-delete').addEventListener('click', () => {
    if (form.mode === 'occ') {
      const r = data.rec.find((x) => x.id === form.id);
      if (!r || !confirm(`Skip “${r.label}” on ${parse(form.date).toLocaleDateString()}?`)) return;
      r.skip = [...new Set([...(r.skip || []), form.date])].sort();
      if (r.edits) delete r.edits[form.date];
    } else if (form.mode === 'series') {
      const r = data.rec.find((x) => x.id === form.id);
      if (!r || !confirm(`Delete “${r.label}” and all its occurrences, past ones included? To keep the history, use “End series today” instead.`)) return;
      data.rec = data.rec.filter((x) => x.id !== form.id);
    } else {
      const t = data.tx.find((x) => x.id === form.id);
      if (!t || !confirm(`Delete “${t.label}”?`)) return;
      data.tx = data.tx.filter((x) => x.id !== form.id);
    }
    resetForm();
    save();
  });

  // ---------- list, chips, diagram, period ----------
  $('list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) startEdit(b.dataset.edit); });
  $('recurring').addEventListener('click', (e) => { const b = e.target.closest('[data-series]'); if (b) startSeries(b.dataset.series); });
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    const k = b.dataset.filter || null;
    ui.filter = ui.filter === k ? null : k;
    render();
  });
  $('sankey').addEventListener('click', (e) => {
    const r = e.target.closest('rect[data-key]');
    if (!r) return;
    ui.filter = ui.filter === r.dataset.key ? null : r.dataset.key;
    render();
    scrollTo($('list'), 'start');
  });
  function shift(n) { const [y, m] = ui.period.split('-').map(Number); ui.period = toStr(new Date(y, m - 1 + n, 1)).slice(0, 7); ui.filter = null; render(); }
  $('prev').addEventListener('click', () => shift(-1));
  $('next').addEventListener('click', () => shift(1));
  $('month-btn').addEventListener('click', () => { if (ui.period === 'all') { ui.period = todayStr().slice(0, 7); ui.filter = null; render(); } });
  $('all-btn').addEventListener('click', () => { ui.period = 'all'; ui.filter = null; render(); });
  $('search').addEventListener('input', (e) => { ui.search = e.target.value; renderList(totals()); });
  $('subs-toggle').addEventListener('change', (e) => { ui.showSubs = e.target.checked; render(); });

  // ---------- category editor ----------
  let draft = null;
  function closeCatEditor() { draft = null; $('cat-editor').open = false; $('cat-body').innerHTML = ''; }
  $('cat-editor').addEventListener('toggle', () => {
    if (!$('cat-editor').open) { draft = null; $('cat-body').innerHTML = ''; return; }
    draft = { cats: JSON.parse(JSON.stringify(data.cats)), srcs: JSON.parse(JSON.stringify(data.srcs)) };
    drawCatEditor();
  });
  function drawCatEditor() {
    const dis = readOnly ? ' disabled' : '';
    const block = (c, list, i) => `<div class="cat-block">
      <div class="cat-row">
        <input type="color" value="${safeColor(c.color)}" data-list="${list}" data-i="${i}" data-f="color" aria-label="Color of ${esc(c.name)}"${dis}>
        <input value="${esc(c.name)}" maxlength="40" data-list="${list}" data-i="${i}" data-f="name" aria-label="Category name"${dis}>
        <button type="button" class="icon-btn" data-del="${list}:${i}" aria-label="Delete ${esc(c.name)}" title="Delete"${dis}>✕</button>
      </div>
      ${list === 'cats' ? c.subs.map((s, j) => `<div class="sub-row">
        <input value="${esc(s.name)}" maxlength="40" data-list="cats" data-i="${i}" data-j="${j}" data-f="sub" aria-label="Sub-category of ${esc(c.name)}"${dis}>
        <button type="button" class="icon-btn" data-delsub="${i}:${j}" aria-label="Delete ${esc(s.name)}" title="Delete"${dis}>✕</button></div>`).join('') +
        `<button type="button" class="link-btn" data-addsub="${i}"${dis}>+ Add sub-category</button>` : ''}
    </div>`;
    $('cat-body').innerHTML = `
      <h3>Expense categories</h3>${draft.cats.map((c, i) => block(c, 'cats', i)).join('')}
      <div class="actions"><button type="button" class="quiet" data-add="cats"${dis}>Add category</button></div>
      <h3>Income sources</h3>${draft.srcs.map((c, i) => block(c, 'srcs', i)).join('')}
      <div class="actions"><button type="button" class="quiet" data-add="srcs"${dis}>Add source</button></div>
      <p class="form-err" id="cat-err" role="alert"></p>
      <div class="actions"><button type="button" id="cat-save"${dis}>Save categories</button><button type="button" class="quiet" id="cat-cancel">Cancel</button></div>`;
  }
  $('cat-body').addEventListener('input', (e) => {
    const t = e.target;
    if (!draft || !t.dataset.f) return;
    const c = draft[t.dataset.list][Number(t.dataset.i)];
    if (t.dataset.f === 'sub') c.subs[Number(t.dataset.j)].name = t.value;
    else c[t.dataset.f] = t.value;
  });
  $('cat-body').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || !draft) return;
    const focusLast = (sel) => { const all = $('cat-body').querySelectorAll(sel); if (all.length) all[all.length - 1].select(); };
    if (t.dataset.del) { const [l, i] = t.dataset.del.split(':'); draft[l].splice(Number(i), 1); drawCatEditor(); }
    else if (t.dataset.delsub) { const [i, j] = t.dataset.delsub.split(':').map(Number); draft.cats[i].subs.splice(j, 1); drawCatEditor(); }
    else if (t.dataset.addsub) {
      const i = Number(t.dataset.addsub);
      draft.cats[i].subs.push({ id: 's-' + newId().slice(0, 8), name: 'New sub-category' });
      drawCatEditor();
      focusLast(`[data-f="sub"][data-i="${i}"]`);
    } else if (t.dataset.add) {
      const l = t.dataset.add;
      draft[l].push(l === 'cats'
        ? { id: 'c-' + newId().slice(0, 8), name: 'New category', color: PALETTE[draft.cats.length % PALETTE.length], subs: [] }
        : { id: 'i-' + newId().slice(0, 8), name: 'New source', color: PALETTE[(draft.srcs.length + 10) % PALETTE.length] });
      drawCatEditor();
      focusLast(`[data-f="name"][data-list="${l}"]`);
    } else if (t.id === 'cat-cancel') closeCatEditor();
    else if (t.id === 'cat-save') {
      if (readOnly) return;
      const all = [...draft.cats, ...draft.srcs];
      all.forEach((c) => { c.name = c.name.trim(); (c.subs || []).forEach((s) => { s.name = s.name.trim(); }); });
      const err = (m) => { $('cat-err').textContent = m; };
      if (all.some((c) => !c.name)) return err('Every category needs a name.');
      if (draft.cats.some((c) => c.subs.some((s) => !s.name))) return err('Every sub-category needs a name.');
      if (!draft.cats.length || !draft.srcs.length) return err('Keep at least one expense category and one income source.');
      data.cats = draft.cats;
      data.srcs = draft.srcs;
      closeCatEditor();
      resetForm();
      save();
    }
  });

  // ---------- diagnostics ----------
  function logDiag(item) {
    diag.streams++;
    const c = (item && item.content) || {};
    diag.log.unshift({
      t: new Date().toLocaleTimeString(),
      uuid: item && item.uuid ? item.uuid.slice(0, 8) : '—',
      title: c.title || '',
      textLen: typeof c.text === 'string' ? c.text.length : `(${typeof c.text})`,
      previewLen: typeof c.preview_plain === 'string' ? c.preview_plain.length : 0,
      meta: !!(item && item.isMetadataUpdate),
      keys: Object.keys(c).join(', '),
    });
    diag.log.length = Math.min(diag.log.length, 6);
    renderDiag();
  }
  function renderDiag() {
    const env = relay ? `${relay.environment || '?'} / ${relay.platform || '?'}` : (standalone ? 'browser preview' : 'not connected');
    $('diag').querySelector('pre').textContent =
      `Plugin version: ${VERSION}\nEnvironment: ${env}\nMessages received: ${diag.streams}\nText we loaded: ${lastText == null ? '—' : lastText.length + ' chars'}\n` +
      `Entries: ${data.tx.length} one-off, ${data.rec.length} recurring\n\n` +
      diag.log.map((d) => `${d.t}  note ${d.uuid} "${d.title}"\n  text: ${d.textLen} chars, preview: ${d.previewLen}, metadata-only: ${d.meta}\n  fields: ${d.keys}`).join('\n\n');
  }

  // ---------- start ----------
  if (!standalone && typeof ComponentRelay === 'undefined') {
    // Running inside Standard Notes but the connection library didn't load:
    // refuse to edit rather than pretend to save.
    readOnly = true;
    resetForm();
    render();
    renderDiag();
    showNotice('Couldn’t connect to Standard Notes (component-relay.js failed to load), so this note can’t be read or saved. Check that component-relay.js is uploaded next to index.html, then reopen the note.');
  } else if (standalone) {
    // Development preview with sample data (nothing is saved).
    const t = todayStr(), m = t.slice(0, 7);
    data = emptyData();
    data.tx = [
      { id: 'a', type: 'out', amount: 64.3, label: 'Supermarket', cat: 'food', sub: 'groceries', date: m + '-02', note: '' },
      { id: 'b', type: 'out', amount: 38, label: 'Dinner out', cat: 'food', sub: 'restaurants', date: m + '-03', note: '' },
      { id: 'c', type: 'out', amount: 55, label: 'Fuel', cat: 'transport', sub: 'fuel', date: m + '-01', note: '' },
      { id: 'd', type: 'out', amount: 120, label: 'Concert', cat: 'leisure', sub: '', date: m + '-01', note: 'Friends' },
    ];
    data.rec = [
      { id: 'r1', type: 'in', amount: 2400, label: 'Salary', cat: 'salary', sub: '', note: '', date: addDays(m + '-01', -61).slice(0, 8) + '01', repeat: 'monthly', until: null, skip: [], edits: {} },
      { id: 'r2', type: 'out', amount: 850, label: 'Rent', cat: 'home', sub: 'rent', note: '', date: addDays(m + '-01', -61).slice(0, 8) + '01', repeat: 'monthly', until: null, skip: [], edits: {} },
      { id: 'r3', type: 'out', amount: 300, label: 'Monthly savings', cat: 'savings', sub: 'account', note: '', date: addDays(m + '-01', -61).slice(0, 8) + '01', repeat: 'monthly', until: null, skip: [], edits: {} },
    ];
    resetForm();
    render();
    renderDiag();
  } else {
    const Relay = ComponentRelay.default || ComponentRelay;
    relay = new Relay({
      targetWindow: window,
      options: { coallesedSaving: true, coallesedSavingDelay: 400, acceptsThemes: true },
      // Required since component-relay 2.3: called on every save. Returning undefined
      // lets Standard Notes keep sizing the editor itself.
      handleRequestForContentHeight: () => undefined,
    });
    // Surface any error during saving instead of failing silently.
    window.addEventListener('error', (e) => {
      showNotice(`Something went wrong, so your last change may not be saved (${String(e.message || 'unknown error').replace(/\.+$/, '')}). Reopen the note before editing again.`);
    });
    renderDiag();
    relay.streamContextItem((item) => {
      const isNewNote = !note || item.uuid !== note.uuid;
      note = item;
      logDiag(item);
      const text = (item.content && item.content.text) || '';
      const preview = (item.content && item.content.preview_plain) || '';
      // Safety: an empty text on a note that already has our summary as its preview
      // means the app didn't send the real content. Never let the user overwrite it.
      if (!text.trim() && preview.startsWith(MARK)) {
        lastText = null;
        data = emptyData();
        readOnly = true;
        resetForm();
        render();
        showNotice('Standard Notes sent this note without its content, so editing is turned off to protect your ledger. Open “Connection details” at the bottom and share what it shows.');
        renderDiag();
        return;
      }
      // Reload when switching notes or when the text changed elsewhere (e.g. another device).
      if (isNewNote || text !== lastText) load(text);
      renderDiag();
    });
  }
})();
