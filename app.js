'use strict';

/* ---------- Constants ---------- */
const CATS = {
  expense: [
    ['อาหาร', '🍜'], ['เดินทาง', '🚌'], ['ช้อปปิ้ง', '🛍️'], ['บิล/สาธารณูปโภค', '💡'],
    ['ที่พัก', '🏠'], ['สุขภาพ', '💊'], ['บันเทิง', '🎬'], ['อื่นๆ', '🏷️'],
  ],
  income: [
    ['เงินเดือน', '💼'], ['โบนัส', '🎁'], ['ขายของ', '🛒'], ['อื่นๆ', '💰'],
  ],
};

/* ---------- Helpers ---------- */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const money = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmt = (n) => '฿' + money.format(n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage เต็ม/ถูกบล็อก */ } };

function emojiOf(cat, type) {
  const hit = (CATS[type] || []).concat(CATS.expense, CATS.income).find((c) => c[0] === cat);
  return hit ? hit[1] : '🏷️';
}

/* ---------- State ---------- */
let cfg = load('cfg', { url: '', token: '' });
let month = toYMD(new Date()).slice(0, 7);
let cache = load('cache', {});      // { '2026-10': [items] }
let pending = load('pending', []);  // [{ op:'add'|'update'|'delete', item?, id? }]
let editing = null;
let formType = 'expense';
let formCat = '';
let online = true;
let loadError = '';

/* ---------- API ---------- */
async function request(fn) {
  let res;
  try {
    res = await fn();
  } catch (e) {
    const err = new Error('ออฟไลน์');
    err.kind = 'net';
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    const err = new Error('ตอบกลับไม่ถูกต้อง — ตรวจสอบ URL และการ Deploy (Anyone)');
    err.kind = 'server';
    throw err;
  }
  if (!json.ok) {
    const err = new Error(json.error || 'เกิดข้อผิดพลาด');
    err.kind = json.error === 'unauthorized' ? 'auth' : 'server';
    throw err;
  }
  return json;
}

function apiGet(params) {
  const u = new URL(cfg.url);
  Object.entries({ ...params, token: cfg.token }).forEach(([k, v]) => u.searchParams.set(k, v));
  return request(() => fetch(u.toString()));
}

function apiPost(body) {
  // ใช้ text/plain เพื่อเลี่ยง CORS preflight ที่ Apps Script ไม่รองรับ
  return request(() => fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: cfg.token }),
  }));
}

/* ---------- Data ---------- */
function withPending(base, m) {
  let list = base.slice();
  for (const p of pending) {
    if (p.op === 'add') {
      if (p.item.date.startsWith(m) && !list.some((x) => x.id === p.item.id)) list.push(p.item);
    } else if (p.op === 'update') {
      const i = list.findIndex((x) => x.id === p.item.id);
      const inMonth = p.item.date.startsWith(m);
      if (i >= 0 && inMonth) list[i] = p.item;
      else if (i >= 0) list.splice(i, 1);
      else if (inMonth) list.push(p.item);
    } else if (p.op === 'delete') {
      list = list.filter((x) => x.id !== p.id);
    }
  }
  return list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
}

const pendingIds = () => new Set(pending.filter((p) => p.item).map((p) => p.item.id));

let flushing = false;
async function flush() {
  if (flushing || !pending.length || !cfg.url) return;
  flushing = true;
  try {
    while (pending.length) {
      const p = pending[0];
      try {
        await apiPost(p.op === 'delete' ? { action: 'delete', id: p.id } : { action: p.op, item: p.item });
        pending.shift();
        save('pending', pending);
      } catch (e) {
        if (e.kind === 'net') { online = false; break; }
        if (e.kind === 'auth') { loadError = 'Token ไม่ถูกต้อง'; openSettings('Token ไม่ถูกต้อง กรุณาตรวจสอบ', true); break; }
        pending.shift(); // รายการที่ server ปฏิเสธ ทิ้งเพื่อไม่ให้คิวค้าง
        save('pending', pending);
        toast('บางรายการบันทึกไม่ได้: ' + e.message);
      }
    }
  } finally {
    flushing = false;
  }
}

async function refresh() {
  render();
  if (!cfg.url) return;
  await flush();
  try {
    const data = await apiGet({ action: 'list', month });
    cache[month] = data.items;
    save('cache', cache);
    online = true;
    loadError = '';
  } catch (e) {
    if (e.kind === 'net') online = false;
    else if (e.kind === 'auth') { loadError = 'Token ไม่ถูกต้อง'; openSettings('Token ไม่ถูกต้อง กรุณาตรวจสอบ', true); }
    else loadError = e.message;
  }
  render();
}

/* ---------- Render ---------- */
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
}

function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const today = toYMD(new Date());
  const yest = toYMD(new Date(Date.now() - 86400000));
  if (ymd === today) return 'วันนี้';
  if (ymd === yest) return 'เมื่อวาน';
  return new Date(y, m - 1, d).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderStatus() {
  const el = $('#status');
  const n = pending.length;
  let msg = '', warn = false;
  if (!cfg.url) { msg = 'ยังไม่ได้เชื่อมต่อ Google Sheets — แตะ ⚙ เพื่อตั้งค่า'; warn = true; }
  else if (loadError) { msg = loadError; warn = true; }
  else if (!online) msg = 'ออฟไลน์ — แสดงข้อมูลที่บันทึกไว้' + (n ? ` · รอซิงก์ ${n} รายการ` : '');
  else if (n) msg = `กำลังซิงก์ ${n} รายการ…`;
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('warn', warn);
}

function render() {
  $('#monthLabel').textContent = monthLabel(month);
  renderStatus();

  const items = withPending(cache[month] || [], month);
  const inc = items.filter((i) => i.type === 'income').reduce((s, i) => s + i.amount, 0);
  const exp = items.filter((i) => i.type === 'expense').reduce((s, i) => s + i.amount, 0);
  const bal = inc - exp;

  const balEl = $('#balance');
  balEl.textContent = (bal < 0 ? '−' : '') + fmt(Math.abs(bal));
  balEl.classList.toggle('neg', bal < 0);
  $('#sumInc').textContent = fmt(inc);
  $('#sumExp').textContent = fmt(exp);

  // Breakdown
  const byCat = {};
  items.filter((i) => i.type === 'expense').forEach((i) => { byCat[i.category] = (byCat[i.category] || 0) + i.amount; });
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $('#breakdownCard').hidden = !rows.length;
  const max = rows.length ? rows[0][1] : 1;
  $('#breakdown').innerHTML = rows.map(([cat, v]) => `
    <div class="bar-row">
      <span class="emoji">${emojiOf(cat, 'expense')}</span>
      <div>
        <div class="bar-meta"><span>${esc(cat)}</span><span>${fmt(v)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, (v / max) * 100)}%"></div></div>
      </div>
      <span class="bar-pct">${exp ? Math.round((v / exp) * 100) : 0}%</span>
    </div>`).join('');

  // List
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">ยังไม่มีรายการในเดือนนี้<br>แตะ + เพื่อเพิ่มรายการแรก</div>';
    return;
  }
  const pend = pendingIds();
  const days = {};
  items.forEach((i) => { (days[i.date] = days[i.date] || []).push(i); });
  list.innerHTML = Object.keys(days).sort().reverse().map((d) => {
    const dayItems = days[d];
    const net = dayItems.reduce((s, i) => s + (i.type === 'income' ? i.amount : -i.amount), 0);
    return `
      <div class="day"><span>${esc(dayLabel(d))}</span><span>${net < 0 ? '−' : ''}${fmt(Math.abs(net))}</span></div>
      <div class="group">
        ${dayItems.map((i) => `
          <button class="item" data-id="${esc(i.id)}">
            <span class="ico">${emojiOf(i.category, i.type)}</span>
            <span><div class="t">${esc(i.category)}</div>${i.note ? `<div class="n">${esc(i.note)}</div>` : ''}</span>
            <span class="amt ${i.type === 'income' ? 'inc' : 'exp'}">${i.type === 'income' ? '+' : '−'}${fmt(i.amount)}${pend.has(i.id) ? '<span class="sync">⏳ รอซิงก์</span>' : ''}</span>
          </button>`).join('')}
      </div>`;
  }).join('');
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- Sheets ---------- */
function showSheet(el) {
  $('#backdrop').hidden = false;
  el.hidden = false;
}
function closeSheets() {
  $('#backdrop').hidden = true;
  $('#entry').hidden = true;
  $('#settings').hidden = true;
  editing = null;
}

function renderCats() {
  const box = $('#cats');
  box.innerHTML = CATS[formType].map(([name, e]) => `
    <button type="button" class="chip ${name === formCat ? 'on' : ''}" role="radio" aria-checked="${name === formCat}" data-cat="${esc(name)}">
      <span class="e">${e}</span><span>${esc(name)}</span>
    </button>`).join('');
}

function setType(t) {
  formType = t;
  document.querySelectorAll('#typeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  if (!CATS[t].some((c) => c[0] === formCat)) formCat = '';
  renderCats();
}

function openEntry(item) {
  editing = item || null;
  formCat = item ? item.category : '';
  setType(item ? item.type : 'expense');
  $('#amount').value = item ? String(item.amount) : '';
  $('#date').value = item ? item.date : toYMD(new Date());
  $('#note').value = item ? item.note : '';
  $('#btnDelete').hidden = !item;
  showSheet($('#entry'));
  if (!item) setTimeout(() => $('#amount').focus(), 120);
}

function openSettings(msg, isErr) {
  $('#entry').hidden = true;
  $('#cfgUrl').value = cfg.url;
  $('#cfgToken').value = cfg.token;
  const hint = $('#cfgMsg');
  hint.textContent = msg || '';
  hint.className = 'hint' + (isErr ? ' err' : '');
  showSheet($('#settings'));
}

/* ---------- Events ---------- */
$('#fab').addEventListener('click', () => openEntry());
$('#btnSettings').addEventListener('click', () => openSettings());
$('#backdrop').addEventListener('click', closeSheets);
$('#btnCloseSettings').addEventListener('click', closeSheets);

$('#prev').addEventListener('click', () => shiftMonth(-1));
$('#next').addEventListener('click', () => shiftMonth(1));
function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  refresh();
}

$('#typeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (b) setType(b.dataset.type);
});

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  formCat = b.dataset.cat;
  renderCats();
});

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const item = withPending(cache[month] || [], month).find((i) => i.id === b.dataset.id);
  if (item) openEntry(item);
});

$('#entry').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = parseFloat($('#amount').value.replace(/,/g, ''));
  if (!(amount > 0)) { toast('กรอกจำนวนเงินให้ถูกต้อง'); $('#amount').focus(); return; }
  if (!formCat) {
    toast('เลือกหมวดหมู่ก่อน');
    const c = $('#cats');
    c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
    return;
  }
  const item = {
    id: editing ? editing.id : uid(),
    date: $('#date').value || toYMD(new Date()),
    type: formType,
    category: formCat,
    amount: Math.round(amount * 100) / 100,
    note: $('#note').value.trim(),
    createdAt: editing ? editing.createdAt : new Date().toISOString(),
  };
  pending.push({ op: editing ? 'update' : 'add', item });
  save('pending', pending);
  month = item.date.slice(0, 7);
  closeSheets();
  render();
  toast(editing ? 'แก้ไขแล้ว' : 'บันทึกแล้ว');
  refresh();
});

$('#btnDelete').addEventListener('click', () => {
  if (!editing) return;
  if (!confirm('ลบรายการนี้?')) return;
  pending.push({ op: 'delete', id: editing.id });
  save('pending', pending);
  closeSheets();
  render();
  toast('ลบแล้ว');
  refresh();
});

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#cfgUrl').value.trim();
  const token = $('#cfgToken').value.trim();
  const hint = $('#cfgMsg');
  hint.className = 'hint';
  hint.textContent = 'กำลังทดสอบการเชื่อมต่อ…';
  const prev = cfg;
  cfg = { url, token };
  try {
    await apiGet({ action: 'ping' });
    save('cfg', cfg);
    hint.className = 'hint ok';
    hint.textContent = 'เชื่อมต่อสำเร็จ ✓';
    loadError = '';
    setTimeout(() => { closeSheets(); refresh(); }, 600);
  } catch (err) {
    cfg = prev;
    hint.className = 'hint err';
    hint.textContent = err.kind === 'auth' ? 'Token ไม่ถูกต้อง' : (err.kind === 'net' ? 'เชื่อมต่อไม่ได้ ตรวจสอบ URL และอินเทอร์เน็ต' : err.message);
  }
});

window.addEventListener('online', () => { online = true; refresh(); });
window.addEventListener('offline', () => { online = false; render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

/* ---------- Boot ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
render();
if (!cfg.url) openSettings('วาง URL ของ Web App และ Token เพื่อเริ่มใช้งาน');
else refresh();
