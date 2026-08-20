// Страница верификации на входе. Гость без PIN видит нейтральную заставку.
// Админ с PIN — полноэкранный светофор:
//   зелёный «ПРОПУСТИТЬ» → кнопка «Впустить» (атомарный чек-ин);
//   жёлтый «НАДЕТЬ БРАСЛЕТ» — несовершеннолетний на 16+;
//   красный «УЖЕ ИСПОЛЬЗОВАН/ПОДДЕЛКА/ОТОЗВАН»;
//   янтарный — БД недоступна: подпись подлинная, впуск под запись (outbox)
//   + офлайн-список из admin.html (localStorage).
import { parseToken, formatTicketCode, normalizeManualId, fmtTime, plural } from './ticket-format.js';
import { enqueue, pendingItems, applyResults } from './outbox.js';
import { esc } from './events-load.js';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'th_admin_key';
const LS_NAME = 'th_admin_name';
const LS_OUTBOX = 'th_checkin_outbox';

const state = {
  token: null,   // {id, sig} | null
  key: localStorage.getItem(LS_KEY) || '',
  name: localStorage.getItem(LS_NAME) || '',
  locked: false, // экран результата чек-ина зафиксирован
};

init();

function tokenFromUrl() {
  const m = location.pathname.match(/^\/s\/([^/?#]+)/);
  const raw = m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get('token');
  return parseToken(raw || '');
}

async function init() {
  state.token = tokenFromUrl();
  syncOutbox();
  window.addEventListener('online', syncOutbox);
  if (!state.key) return renderGuest();
  if (!state.token) return renderManualOnly();
  await verifyAndRender();
}

// ---------- Гость ----------
async function renderGuest() {
  let eventLine = '';
  if (state.token) {
    try {
      const r = await fetch(`/api/verify?token=${tokenParam()}`);
      const j = await r.json().catch(() => null);
      if (j?.ok && j.event) eventLine = `${j.event.title}`;
    } catch { /* молчим */ }
  }
  stage('neutral', `
    <div class="guest-brand">TRAP<span class="l2">HOUSE</span></div>
    <p class="scan-sub" style="margin-top: 10px;">Покажи этот экран на входе — админ отсканирует и впустит.</p>
    ${eventLine ? `<div class="scan-meta-pill">${esc(eventLine)}</div>` : ''}
    ${state.token ? `<div class="scan-meta-pill">билет ${formatTicketCode(state.token.id)}</div>` : ''}
  `);
  foot(`
    <button class="btn btn-ghost" id="staff-btn" type="button">Я сотрудник</button>
  `);
  $('staff-btn').onclick = renderPin;
}

function renderPin() {
  stage('neutral', `
    <div class="guest-brand">TRAP<span class="l2">HOUSE</span></div>
    <p class="scan-sub" style="margin: 10px 0 18px;">Режим сотрудника</p>
    <div class="pin-panel">
      <input type="password" id="pin-key" placeholder="Ключ администратора" autocomplete="off" />
      <input type="text" id="pin-name" placeholder="Твоё имя (видно в отчётах)" autocomplete="off" value="${esc(state.name)}" />
    </div>
  `);
  foot(`<button class="btn btn-acid" id="pin-save" type="button">Войти</button>
        <button class="btn btn-ghost" id="pin-cancel" type="button">Назад</button>`);
  $('pin-save').onclick = async () => {
    const key = $('pin-key').value.trim();
    const name = $('pin-name').value.trim();
    if (!key) return $('pin-key').focus();
    state.key = key;
    state.name = name || 'админ';
    localStorage.setItem(LS_KEY, state.key);
    localStorage.setItem(LS_NAME, state.name);
    if (state.token) await verifyAndRender();
    else renderManualOnly();
  };
  $('pin-cancel').onclick = () => (state.token ? renderGuest() : renderManualOnly());
}

// ---------- Админ ----------
function tokenParam() {
  return encodeURIComponent(`${state.token.id}.${state.token.sig}`);
}

async function verifyAndRender() {
  stage('neutral', `<div class="scan-verdict" style="color: var(--muted);">Проверяю…</div>`);
  foot('');
  let j = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`/api/verify?token=${tokenParam()}`, {
      headers: adminHeaders(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.status === 403) return badKey();
    j = await r.json().catch(() => null);
  } catch { /* сеть упала — офлайн-ветка ниже */ }

  if (!j) return renderOffline();
  if (!j.sig_valid) return renderFake();
  if (j.status === 'unknown') return renderDegraded();
  if (j.status === 'not_found') return renderNotFound();
  if (j.status === 'checked_in') return renderRepeat(j);
  if (j.status === 'revoked' || j.status === 'refunded') return renderRevoked(j);
  renderActive(j);
}

function adminHeaders() {
  // имя может быть кириллицей — в HTTP-заголовок только через encodeURIComponent
  return { 'X-Admin-Key': state.key, 'X-Admin-Name': encodeURIComponent(state.name || '') };
}

function badKey() {
  localStorage.removeItem(LS_KEY);
  state.key = '';
  renderPin();
  const el = document.querySelector('.pin-panel');
  if (el) el.insertAdjacentHTML('beforebegin', '<p class="scan-sub" style="color: var(--danger);">Ключ не подошёл — проверь и введи заново</p>');
}

function renderActive(j) {
  const minor = j.age_cat === 'minor';
  const cls = minor ? 'warn' : 'ok';
  stage(cls, `
    <div class="scan-verdict">${minor ? 'Надеть браслет' : 'Пропустить'}</div>
    ${minor ? '<p class="scan-sub">Несовершеннолетний гость — браслет обязателен, бар закрыт.</p>' : ''}
    <div class="scan-name">${esc(j.holder_name)}</div>
    <div class="scan-detail">${esc(j.event?.title || '')} · ${esc(j.wave_name || '')} · билет ${formatTicketCode(state.token.id)}</div>
  `);
  foot(`<button class="btn btn-ok btn-block" id="do-checkin" type="button">Впустить</button>
        ${scanNextBtn()}`);
  $('do-checkin').onclick = () => doCheckin();
  bindScanNext();
  beep('ok');
  vibrate([70]);
}

function renderRepeat(j) {
  stage('danger', `
    <div class="scan-verdict">Уже использован</div>
    <div class="scan-name">${esc(j.holder_name || '')}</div>
    <p class="scan-sub">Вход был в <b>${j.checked_in_at ? fmtTime(j.checked_in_at) : '—'}</b>${j.checked_by ? `, впустил: ${esc(j.checked_by)}` : ''}.
    Это скриншот или пересланный билет — не пускать.</p>
  `);
  foot(scanNextBtn());
  bindScanNext();
  beep('bad');
  vibrate([70, 70, 70]);
}

function renderFake() {
  stage('danger', `
    <div class="scan-verdict">Подделка</div>
    <p class="scan-sub">Подпись не сходится — этот QR не выпускали мы. Не пускать.</p>
  `);
  foot(scanNextBtn());
  bindScanNext();
  beep('bad');
  vibrate([70, 70, 70]);
}

function renderRevoked(j) {
  stage('danger', `
    <div class="scan-verdict">Отозван</div>
    <div class="scan-name">${esc(j.holder_name || '')}</div>
    <p class="scan-sub">Билет отозван или возвращён. Не пускать.</p>
  `);
  foot(scanNextBtn());
  bindScanNext();
  beep('bad');
}

function renderNotFound() {
  stage('danger', `
    <div class="scan-verdict">Не найден</div>
    <p class="scan-sub">Подпись похожа на нашу, но билета нет в базе. Проверь вручную по номеру или не пускай.</p>
  `);
  foot(`${manualBtn()}${scanNextBtn()}`);
  bindManual();
  bindScanNext();
  beep('bad');
}

// БД лежит, но API ответил: подпись подлинная
function renderDegraded() {
  const local = offlineLookup(state.token.id);
  let sub = 'База временно недоступна. Подпись билета <b>подлинная</b>.';
  let nameHtml = '';
  if (local) {
    nameHtml = `<div class="scan-name">${esc(local.n)}</div>`;
    if (local.c) sub = `По офлайн-списку билет <b>уже использован</b> (${fmtTime(local.c)}). Не пускать.`;
    else if (local.s && local.s !== 'active') sub = 'По офлайн-списку билет <b>отозван</b>. Не пускать.';
    else sub += local.a === 'minor' ? ' По офлайн-списку — несовершеннолетний: браслет.' : ' Есть в офлайн-списке.';
  } else {
    sub += ' В офлайн-списке не найден — сверь номер по печатному списку.';
  }
  stage('amber', `
    <div class="scan-verdict">Проверка вручную</div>
    ${nameHtml}
    <p class="scan-sub">${sub}</p>
    <div class="scan-meta-pill">билет ${formatTicketCode(state.token.id)}</div>
    <div class="scan-meta-pill" id="outbox-pill"></div>
  `);
  const blocked = local && (local.c || (local.s && local.s !== 'active'));
  foot(`
    ${blocked ? '' : '<button class="btn btn-ok btn-block" id="do-offline" type="button">Впустить под запись</button>'}
    ${scanNextBtn()}
  `);
  if (!blocked) {
    $('do-offline').onclick = () => {
      const list = loadOutbox();
      saveOutbox(enqueue(list, { ticketId: state.token.id, by: state.name, at: new Date().toISOString() }));
      markOfflineUsed(state.token.id);
      stageLockOk('Впущен под запись', 'Синхронизируем с базой, когда она оживёт.');
      syncOutbox();
    };
  }
  updateOutboxPill();
  beep('warn');
  vibrate([50, 40]);
}

// Сеть недоступна вообще (API не ответил)
function renderOffline() {
  const local = offlineLookup(state.token.id);
  let body;
  if (local) {
    const blocked = local.c || (local.s && local.s !== 'active');
    body = blocked
      ? `<div class="scan-name">${esc(local.n)}</div><p class="scan-sub">По офлайн-списку билет уже использован или отозван. Не пускать.</p>`
      : `<div class="scan-name">${esc(local.n)}</div><p class="scan-sub">Есть в офлайн-списке${local.a === 'minor' ? ' — несовершеннолетний, браслет' : ''}. Впусти под запись.</p>`;
  } else {
    body = `<p class="scan-sub">Интернета нет, и билета нет в офлайн-списке. Сверь номер по печатному списку гостей.</p>`;
  }
  stage('amber', `
    <div class="scan-verdict">Офлайн-режим</div>
    ${body}
    <div class="scan-meta-pill">билет ${formatTicketCode(state.token.id)}</div>
  `);
  const canAdmit = local && !local.c && (!local.s || local.s === 'active');
  foot(`${canAdmit ? '<button class="btn btn-ok btn-block" id="do-offline" type="button">Впустить под запись</button>' : ''}${scanNextBtn()}`);
  if (canAdmit) {
    $('do-offline').onclick = () => {
      saveOutbox(enqueue(loadOutbox(), { ticketId: state.token.id, by: state.name, at: new Date().toISOString() }));
      markOfflineUsed(state.token.id);
      stageLockOk('Впущен под запись', 'Отметка сохранена на этом телефоне и уйдёт в базу при появлении сети.');
    };
  }
  beep('warn');
}

async function doCheckin() {
  $('do-checkin').disabled = true;
  $('do-checkin').textContent = 'Отмечаю…';
  let j = null;
  let status = 0;
  try {
    const r = await fetch('/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ token: `${state.token.id}.${state.token.sig}`, by: state.name }),
    });
    status = r.status;
    j = await r.json().catch(() => null);
  } catch { /* сеть упала между verify и чек-ином */ }

  if (j?.ok && j.first) {
    stageLockOk('Впущен', `${j.holder_name}${j.age_cat === 'minor' ? ' · браслет надет?' : ''} · ${fmtTime(j.checked_in_at)}`);
    return;
  }
  if (j?.ok && j.first === false) return renderRepeat({ holder_name: j.holder_name, checked_in_at: j.checked_in_at, checked_by: j.checked_by });
  if (status === 403) return badKey();
  if (j?.error === 'revoked') return renderRevoked({ holder_name: '' });
  // 503 или сеть — уходим в запись
  saveOutbox(enqueue(loadOutbox(), { ticketId: state.token.id, by: state.name, at: new Date().toISOString() }));
  markOfflineUsed(state.token.id);
  stageLockOk('Впущен под запись', 'База не ответила — отметка досинхронизируется автоматически.');
}

function stageLockOk(title, sub) {
  state.locked = true;
  stage('ok', `
    <div class="scan-verdict">${esc(title)}</div>
    <p class="scan-sub">${esc(sub)}</p>
  `);
  foot(scanNextBtn());
  bindScanNext();
  beep('ok');
  vibrate([70]);
}

// ---------- Ручной ввод ----------
function renderManualOnly() {
  stage('neutral', `
    <div class="guest-brand">TRAP<span class="l2">HOUSE</span></div>
    <p class="scan-sub" style="margin: 10px 0 18px;">Режим сотрудника · ${esc(state.name)}</p>
    <div class="pin-panel">
      <input type="text" id="manual-id" placeholder="Номер билета, напр. 7K3F-9QZ2-MX" autocomplete="off" />
    </div>
    <div class="scan-meta-pill" id="outbox-pill"></div>
  `);
  foot(`<button class="btn btn-acid" id="manual-go" type="button">Найти билет</button>
        <button class="btn btn-ghost" id="logout" type="button">Выйти из режима</button>`);
  $('manual-go').onclick = manualLookup;
  $('manual-id').onkeydown = (e) => { if (e.key === 'Enter') manualLookup(); };
  $('logout').onclick = () => { localStorage.removeItem(LS_KEY); state.key = ''; renderGuest(); };
  updateOutboxPill();
}

function manualBtn() {
  return '<button class="btn btn-ghost" id="manual-open" type="button">Ввести номер вручную</button>';
}
function bindManual() {
  const b = $('manual-open');
  if (b) b.onclick = renderManualOnly;
}

async function manualLookup() {
  const id = normalizeManualId($('manual-id').value);
  if (!id) { $('manual-id').focus(); return; }
  let j = null;
  try {
    const r = await fetch(`/api/verify?manual=1&id=${id}`, { headers: adminHeaders() });
    if (r.status === 403) return badKey();
    j = await r.json().catch(() => null);
  } catch { /* offline */ }
  state.token = { id, sig: null };
  if (!j) return renderOffline();
  if (j.status === 'unknown') return renderDegraded();
  if (j.status === 'not_found') return renderNotFound();
  if (j.status === 'checked_in') return renderRepeat(j);
  if (j.status === 'revoked' || j.status === 'refunded') return renderRevoked(j);
  // active: чек-ин по голому id (доверенный режим админа)
  renderActive(j);
  $('do-checkin').onclick = async () => {
    $('do-checkin').disabled = true;
    try {
      const r = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders() },
        body: JSON.stringify({ id, by: state.name }),
      });
      const jj = await r.json().catch(() => null);
      if (jj?.ok && jj.first) return stageLockOk('Впущен', `${jj.holder_name} · ${fmtTime(jj.checked_in_at)}`);
      if (jj?.ok) return renderRepeat(jj);
    } catch { /* ignore */ }
    saveOutbox(enqueue(loadOutbox(), { ticketId: id, by: state.name, at: new Date().toISOString() }));
    stageLockOk('Впущен под запись', 'Отметка досинхронизируется.');
  };
}

// ---------- Офлайн-список и очередь ----------
function offlineLookup(id) {
  // офлайн-списки кладёт admin.html: th_offline_<eventId> = { id: {n,a,s,c} }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('th_offline_')) continue;
      const map = JSON.parse(localStorage.getItem(k) || '{}');
      if (map[id]) return map[id];
    }
  } catch { /* повреждённый кэш не должен ломать вход */ }
  return null;
}

function markOfflineUsed(id) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('th_offline_')) continue;
      const map = JSON.parse(localStorage.getItem(k) || '{}');
      if (map[id]) {
        map[id].c = new Date().toISOString();
        localStorage.setItem(k, JSON.stringify(map));
      }
    }
  } catch { /* ignore */ }
}

function loadOutbox() {
  try { return JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]'); } catch { return []; }
}
function saveOutbox(list) {
  try { localStorage.setItem(LS_OUTBOX, JSON.stringify(list)); } catch { /* ignore */ }
  updateOutboxPill();
}

async function syncOutbox() {
  if (!state.key) return;
  const items = pendingItems(loadOutbox());
  if (!items.length) return;
  const results = [];
  for (const it of items) {
    try {
      const r = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders() },
        body: JSON.stringify({ id: it.ticketId, by: it.by, at: it.at }),
      });
      const j = await r.json().catch(() => null);
      // ok (first или повтор) и «отозван» считаем доставленным; 5xx — попробуем позже
      results.push({ ticketId: it.ticketId, ok: Boolean(j && (j.ok || j.error === 'revoked' || j.error === 'not_found')) });
    } catch {
      results.push({ ticketId: it.ticketId, ok: false });
    }
  }
  saveOutbox(applyResults(loadOutbox(), results));
}

function updateOutboxPill() {
  const pill = $('outbox-pill');
  if (!pill) return;
  const n = loadOutbox().length;
  pill.style.display = n ? '' : 'none';
  pill.textContent = n ? `в очереди на синхронизацию: ${n} ${plural(n, 'отметка', 'отметки', 'отметок')}` : '';
}

// ---------- Общие куски UI ----------
function stage(kind, html) {
  const el = $('stage');
  el.className = `scan-stage stage-${kind}`;
  el.innerHTML = html;
}
function foot(html) {
  $('foot').innerHTML = html;
}
function scanNextBtn() {
  return '<button class="btn btn-ghost" id="scan-next" type="button">Готов к следующему скану</button>';
}
function bindScanNext() {
  const b = $('scan-next');
  if (b) b.onclick = () => {
    // камера откроет новую ссылку сама; этот экран просто в исходное
    state.locked = false;
    renderManualOnly();
  };
}

// ---------- Отклик: звук и вибрация ----------
function vibrate(pattern) {
  // без жеста пользователя Chrome блокирует vibrate и сорит в консоль
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(pattern);
}
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = kind === 'ok' ? [[880, 0.12]] : kind === 'warn' ? [[600, 0.1], [600, 0.1]] : [[220, 0.16], [180, 0.2]];
    let t = audioCtx.currentTime;
    for (const [freq, dur] of seq) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur);
      t += dur + 0.06;
    }
  } catch { /* звук не критичен */ }
}
