// Мини-дашборд организатора: продажи, выручка, чек-ины, лента сканов,
// сервис (инициализация БД, боевой самотест).
// Это витрина тех же данных, которые позже заберёт TG-бот через /api/stats.
import { plural, fmtWhen, fmtTime } from './ticket-format.js';
import { esc } from './events-load.js';
import { activeWave } from './waves.js';
import { qrSvg } from './qr.js';

const $ = (id) => document.getElementById(id);
const rub = (v) => (Number(v) === 0 ? 'фри' : `${v} ₽`);
const LS_KEY = 'th_admin_key';
const LS_NAME = 'th_admin_name';

const state = {
  key: localStorage.getItem(LS_KEY) || '',
  name: localStorage.getItem(LS_NAME) || '',
  events: [],
  current: null,
  pollTimer: null,
  adminEvents: [], // афиша с черновиками — для редактора событий
  editorWaves: [],
};

init();

function init() {
  if (!state.key) return showGate();
  boot();
}

function showGate(err) {
  $('gate').hidden = false;
  $('dash').hidden = true;
  $('gate-err').textContent = 'Ключ не подошёл';
  $('gate-err').style.display = err ? 'block' : 'none';
  $('gate-name').value = state.name;
  $('gate-go').onclick = () => {
    state.key = $('gate-key').value.trim();
    state.name = $('gate-name').value.trim() || 'админ';
    if (!state.key) {
      $('gate-key').focus();
      $('gate-err').textContent = 'Введи ключ администратора.';
      $('gate-err').style.display = 'block';
      return;
    }
    localStorage.setItem(LS_KEY, state.key);
    localStorage.setItem(LS_NAME, state.name);
    boot();
  };
}

function headers() {
  return { 'X-Admin-Key': state.key };
}

function bindLogout() {
  const b = $('btn-logout');
  if (!b) return;
  b.onclick = () => {
    if (!window.confirm('Выйти из админки на этом устройстве? Ключ придётся вводить заново.')) return;
    localStorage.removeItem(LS_KEY);
    state.key = '';
    $('gate-key').value = '';
    showGate();
  };
}

async function boot() {
  let j = null;
  let status = 0;
  try {
    const r = await fetch('/api/stats?include_drafts=1', { headers: headers() });
    status = r.status;
    j = await r.json().catch(() => null);
  } catch { /* ниже */ }

  if (status === 403) {
    localStorage.removeItem(LS_KEY);
    state.key = '';
    return showGate(true);
  }
  $('gate').hidden = true;
  $('dash').hidden = false;
  bindLogout(); // ключ лежит в localStorage телефона, который на входе ходит по рукам
  bindService(); // кнопки сервиса доступны и до инициализации БД
  bindWalkin();
  bindEventEditor();
  bindPending();
  bindSources();

  if (!j || !j.ok) {
    $('db-missing').style.display = 'block';
    return;
  }
  state.events = j.events || [];
  const sel = $('ev-select');
  sel.innerHTML = state.events
    .map((e) => `<option value="${esc(e.id)}">${esc(e.title)} · ${esc(fmtWhen(toIso(e.starts_at)))}</option>`)
    .join('');
  const upcoming = state.events.find((e) => e.status === 'onsale');
  if (upcoming) sel.value = upcoming.id;
  sel.onchange = () => loadEvent(sel.value);
  $('btn-offline').onclick = downloadOfflineList;
  $('btn-print').onclick = printList;
  if (sel.value) loadEvent(sel.value);
}

function toIso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

async function loadEvent(eventId) {
  state.current = eventId;
  clearInterval(state.pollTimer);
  await refresh();
  state.pollTimer = setInterval(refresh, 30_000);
}

async function refresh() {
  if (!state.current) return;
  let j = null;
  try {
    const r = await fetch(`/api/stats?event_id=${encodeURIComponent(state.current)}`, { headers: headers() });
    j = await r.json().catch(() => null);
  } catch { /* сеть мигнула — не трогаем экран */ }
  if (!j || !j.ok) return;
  state.lastStats = j;

  // «осталось» — из волн (та же математика, что видит гость на сайте)
  const leftTotal = (j.by_wave || []).reduce((s, w) => s + Math.max(0, Number(w.quota) - Number(w.sold)), 0);
  const sold = j.sold ?? 0;
  const checked = j.checked_in ?? 0;
  const conv = sold > 0 ? Math.round((checked / sold) * 100) : 0;
  const prov = Object.fromEntries((j.by_provider || []).map((p) => [p.provider, p]));
  const onlineN = (prov.transfer?.n ?? 0) + (prov.stub?.n ?? 0);
  const onlineRub = (prov.transfer?.rub ?? 0) + (prov.stub?.rub ?? 0);
  const doorRub = prov.door?.rub ?? 0;
  const pending = j.pending || [];
  const pendingN = pending.reduce((s, o) => s + o.qty, 0);
  const pendingRub = j.pending_rub ?? pending.reduce((s, o) => s + o.amount_rub, 0);
  $('tiles').innerHTML = [
    { n: sold, label: 'проходок оплачено', sub: `переводом ${onlineN} · на входе ${prov.door?.n ?? 0}` },
    { n: `${(j.revenue_rub ?? 0).toLocaleString('ru-RU')} ₽`, label: 'выручка', sub: `переводом ${onlineRub.toLocaleString('ru-RU')} ₽ · на входе ${doorRub.toLocaleString('ru-RU')} ₽` },
    { n: pendingN, label: 'ждут оплаты', sub: pendingN ? `${pending.length} ${plural(pending.length, 'бронь', 'брони', 'броней')} · ${pendingRub.toLocaleString('ru-RU')} ₽` : 'все брони закрыты' },
    { n: checked, label: 'вошло на тусовку', sub: sold ? `${conv}% от оплаченных` : '' },
    { n: leftTotal, label: 'осталось мест', sub: j.capacity ? `вместимость ${j.capacity}` : '' },
  ]
    .map((t) => `<div class="tile"><div class="t-num">${esc(String(t.n))}</div><div class="t-label">${esc(t.label)}</div>${t.sub ? `<div class="t-sub">${esc(t.sub)}</div>` : ''}</div>`)
    .join('');

  // продажи по дням
  const days = j.sales_by_day || [];
  $('sales-panel').hidden = days.length === 0;
  if (days.length) {
    const maxRub = Math.max(...days.map((d) => d.rub));
    $('sales-table').innerHTML =
      `<tr><th>День</th><th class="num">Проходок</th><th class="num">Выручка</th><th style="width: 42%;"></th></tr>` +
      days
        .map((d) => `<tr><td>${esc(d.d.slice(5).split('-').reverse().join('.'))}</td>
              <td class="num">${d.n}</td><td class="num">${d.rub.toLocaleString('ru-RU')} ₽</td>
              <td class="bar-cell"><i style="width:${maxRub ? Math.max(4, Math.round((d.rub / maxRub) * 100)) : 0}%"></i></td></tr>`)
        .join('');
  }

  $('waves-table').innerHTML =
    `<tr><th>Волна</th><th class="num">Цена</th><th class="num">Продано</th><th class="num">Остаток</th><th style="width: 34%;">Заполнение</th></tr>` +
    (j.by_wave || [])
      .map((w) => {
        const pct = Math.round((Number(w.sold) / Number(w.quota)) * 100);
        return `<tr><td>${esc(w.name)}${w.public === false ? ' <span class="muted">(скрытая)</span>' : ''}</td><td class="num">${rub(w.price_rub)}</td>
                <td class="num">${w.sold} / ${w.quota}</td>
                <td class="num">${Math.max(0, Number(w.quota) - Number(w.sold))}</td>
                <td class="bar-cell"><i style="width:${Math.max(2, pct)}%; ${pct >= 100 ? 'background: var(--dim);' : ''}"></i></td></tr>`;
      })
      .join('');

  renderWalkinWaves();
  renderPending(pending);
  renderSources(j.sources || []);

  const curve = j.checkin_curve || [];
  $('curve-section').hidden = curve.length === 0;
  if (curve.length) {
    const max = Math.max(...curve.map((c) => Number(c.n)));
    $('curve-table').innerHTML =
      `<tr><th>Время</th><th class="num">Вошло</th><th style="width: 50%;"></th></tr>` +
      curve
        .map(
          (c) => `<tr><td>${esc(fmtTime(c.t))}</td><td class="num">${c.n}</td>
                  <td><div style="height: 10px; width: ${Math.round((Number(c.n) / max) * 100)}%; background: var(--acid); border-radius: 5px;"></div></td></tr>`
        )
        .join('');
  }

  const feed = j.last_scans || [];
  $('scan-feed').innerHTML = feed.length
    ? feed
        .map((s) => {
          const dot = s.result === 'ok' || s.result === 'ok_preview' ? 'dot-ok' : s.result === 'degraded' ? 'dot-degraded' : 'dot-repeat';
          const label = { ok: 'впущен', ok_preview: 'проверен', repeat: 'повторный скан', bad_sig: 'подделка', not_found: 'не найден', revoked: 'отозван', refunded: 'возврат' }[s.result] || s.result;
          return `<div class="scan-feed-item"><span class="dot ${dot}"></span>
                  <span>${esc(fmtTime(s.at))}</span><span><b>${esc(label)}</b>${s.holder ? ' · ' + esc(s.holder) : ''}</span>
                  ${s.by ? `<span class="muted" style="margin-left: auto;">${esc(s.by)}</span>` : ''}</div>`;
        })
        .join('')
    : '<p class="muted">Пока пусто</p>';
}

// Офлайн-список для двери: снапшот билетов в localStorage этого устройства.
// scan.html найдёт гостя даже без интернета.
async function downloadOfflineList() {
  if (!state.current) return;
  $('offline-note').textContent = 'Скачиваю…';
  let j = null;
  try {
    const r = await fetch(`/api/stats?event_id=${encodeURIComponent(state.current)}&list=1`, { headers: headers() });
    j = await r.json().catch(() => null);
  } catch { /* ниже */ }
  if (!j || !j.ok || !j.tickets) {
    $('offline-note').textContent = 'Не получилось — проверь сеть';
    return;
  }
  const map = {};
  for (const t of j.tickets) {
    map[t.id] = { n: t.holder_name, a: t.age_cat, s: t.status, c: t.checked_in_at };
  }
  try {
    localStorage.setItem(`th_offline_${state.current}`, JSON.stringify(map));
    const n = j.tickets.length;
    $('offline-note').textContent = `Сохранено на этом телефоне: ${n} ${plural(n, 'гость', 'гостя', 'гостей')}`;
    renderGuestsTable(j.tickets);
  } catch {
    $('offline-note').textContent = 'Не хватило места в браузере';
  }
}

const STATUS_RU = { active: '', reserved: 'ждёт оплаты', expired: 'бронь сгорела', cancelled: 'отменена', revoked: 'аннулирована', refunded: 'возврат' };

function renderGuestsTable(tickets) {
  $('print-list').hidden = false;
  $('guests-table').innerHTML =
    `<tr><th>Гость</th><th>Проходка</th><th>Статус</th><th>Вошёл</th><th class="no-print"></th></tr>` +
    tickets
      .map((t) => {
        const editable = (t.status === 'active' || t.status === 'reserved') && !t.checked_in_at;
        const acts = editable
          ? `<button class="act-link" data-act="rename" data-id="${esc(t.id)}" data-name="${esc(t.holder_name)}" type="button">переоформить</button>` +
            `<button class="act-link danger" data-act="void" data-id="${esc(t.id)}" data-name="${esc(t.holder_name)}" type="button">аннулировать</button>`
          : '';
        return `<tr><td>${esc(t.holder_name)}</td><td>${esc(t.id.toUpperCase())}</td>
                <td>${esc(STATUS_RU[t.status] ?? t.status)}</td>
                <td>${t.checked_in_at ? esc(fmtTime(t.checked_in_at)) : ''}</td>
                <td class="no-print">${acts}</td></tr>`;
      })
      .join('');
  $('guests-table').querySelectorAll('.act-link').forEach((b) => { b.onclick = () => guestAction(b.dataset.act, b.dataset.id, b.dataset.name); });
}

// Переоформление и аннулирование — через кассу (/api/walkin), только владелец
async function guestAction(act, id, name) {
  let body;
  if (act === 'rename') {
    const nn = window.prompt(`Новое имя для проходки ${id.toUpperCase()} (сейчас: ${name})`, name);
    if (!nn || nn.trim().length < 2) return;
    body = { action: 'rename', ticket_id: id, name: nn.trim() };
  } else {
    if (!window.confirm(`Аннулировать проходку ${name}? Вход по ней перестанет работать, место вернётся в продажу.`)) return;
    const refunded = window.confirm('Деньги за неё возвращены? ОК — отметить как возврат, Отмена — просто аннулировать.');
    const note = window.prompt('Причина (необязательно)', '') || '';
    body = { action: 'void', ticket_id: id, status: refunded ? 'refunded' : 'revoked', note };
  }
  let j = null;
  try {
    const r = await fetch('/api/walkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ ...body, by: state.name }),
    });
    j = await r.json().catch(() => null);
  } catch { /* ниже */ }
  if (!j?.ok) {
    window.alert(j?.message || 'Не получилось — проверь сеть');
    return;
  }
  await downloadOfflineList();
  refresh();
}

// ---------- Ожидающие оплаты ----------
function renderPending(list) {
  const host = $('pending-list');
  if (!host) return;
  if (!list.length) {
    host.innerHTML = '<p class="muted">Пока никто не ждёт</p>';
    return;
  }
  const now = Date.now();
  host.innerHTML = list
    .map((o) => {
      const left = o.expires_at ? Math.max(0, Math.round((Date.parse(o.expires_at) - now) / 60000)) : null;
      const names = (o.tickets || []).map((t) => t.holder_name).join(', ');
      return `<div class="pending-row ${o.claimed_at ? 'is-claimed' : ''}" data-id="${esc(o.id)}">
        <div class="pr-code">${esc(o.pay_code || '—')}</div>
        <div class="pr-main">
          <b>${esc(o.buyer_name)}</b> · ${esc(o.buyer_phone)}${o.buyer_tg ? ` · @${esc(o.buyer_tg)}` : ''}${o.tg ? ' · в боте' : ''}
          <small>${o.qty} × ${o.amount_rub / o.qty} ₽ = <b>${o.amount_rub} ₽</b> · ${esc(names)}</small>
          <small>${o.claimed_at
            ? `<span class="pr-claimed">нажал «Я перевёл»</span> ${esc(fmtTime(o.claimed_at))} — проверь банк`
            : left === null ? '' : left > 0 ? `сгорит через ${left} мин` : 'срок вышел, сгорит при следующем обновлении'}</small>
        </div>
        <div class="pr-acts">
          <button class="btn btn-acid btn-sm" data-act="confirm" type="button">Подтвердить</button>
          <button class="btn btn-ghost btn-sm" data-act="cancel" type="button">Отменить</button>
        </div>
      </div>`;
    })
    .join('');
  host.querySelectorAll('.pending-row').forEach((row) => {
    row.querySelectorAll('button').forEach((b) => {
      b.onclick = () => pendingAction(b.dataset.act, row.dataset.id, row);
    });
  });
}

async function pendingAction(act, orderId, row) {
  if (act === 'cancel' && !window.confirm('Отменить бронь? Места вернутся в продажу, гостю в боте придёт сообщение.')) return;
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  let j = null;
  try {
    const r = await fetch('/api/walkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify(act === 'confirm'
        ? { action: 'confirm', order_id: orderId, provider: 'transfer', by: state.name }
        : { action: 'cancel', order_id: orderId, by: state.name }),
    });
    j = await r.json().catch(() => null);
  } catch { /* ниже */ }
  if (!j?.ok) {
    row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    window.alert(j?.message || 'Не получилось — проверь сеть');
  }
  refresh();
}

function bindPending() {
  const btn = $('pc-confirm');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.onclick = async () => {
    const code = $('pc-code').value.trim();
    const note = $('pc-note');
    if (!code) { $('pc-code').focus(); return; }
    btn.disabled = true;
    note.textContent = 'Подтверждаю…';
    let j = null;
    try {
      const r = await fetch('/api/walkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ action: 'confirm', pay_code: code, provider: 'transfer', by: state.name }),
      });
      j = await r.json().catch(() => null);
    } catch { /* ниже */ }
    btn.disabled = false;
    if (j?.ok) {
      note.textContent = `Подтверждено: ${j.pay_code} · ${j.amount_rub} ₽`;
      $('pc-code').value = '';
      refresh();
    } else {
      note.textContent = j?.message || 'Не получилось — проверь сеть';
    }
  };
  $('pc-code').onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
}

// ---------- Источники продаж и QR-постеры ----------
function renderSources(list) {
  const table = $('sources-table');
  if (!table) return;
  if (!list.length) {
    table.innerHTML = '<tr><td class="muted">Продаж пока нет</td></tr>';
    return;
  }
  const max = Math.max(1, ...list.map((r) => r.paid));
  table.innerHTML =
    `<tr><th>Источник</th><th class="num">Оплачено</th><th class="num">Ждут</th><th class="num">Выручка</th><th style="width: 34%;"></th></tr>` +
    list
      .map((r) => `<tr><td>${esc(r.src)}</td><td class="num">${r.paid}</td><td class="num">${r.pending}</td>
        <td class="num">${r.rub.toLocaleString('ru-RU')} ₽</td>
        <td class="bar-cell"><i style="width:${Math.max(2, Math.round((r.paid / max) * 100))}%"></i></td></tr>`)
      .join('');
}

function srcLink() {
  const tag = $('src-tag').value.trim().toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!tag || !state.current) return null;
  return { tag, url: `${location.origin}/e/${encodeURIComponent(state.current)}?src=${encodeURIComponent(tag)}` };
}

function bindSources() {
  const copy = $('src-copy');
  const qr = $('src-qr');
  if (!copy || copy.dataset.bound) return;
  copy.dataset.bound = '1';
  copy.onclick = async () => {
    const l = srcLink();
    if (!l) { $('src-tag').focus(); return; }
    try { await navigator.clipboard.writeText(l.url); $('src-note').textContent = `Скопировано: ${l.url}`; }
    catch { $('src-note').textContent = l.url; }
  };
  qr.onclick = () => {
    const l = srcLink();
    if (!l) { $('src-tag').focus(); return; }
    downloadPoster(l);
  };
}

// PNG-постер: крупный QR на страницу ночи с меткой, подпись бренда.
// Печатается на A4/A5 и клеится в общаге — сканы с него считаются в источниках.
function downloadPoster({ tag, url }) {
  const svg = qrSvg(url, { ecc: 'M', margin: 2 });
  const holder = document.createElement('div');
  holder.innerHTML = svg;
  const svgEl = holder.querySelector('svg');
  const vb = svgEl.viewBox.baseVal;
  const scale = 16;
  const pad = 120;
  const canvas = document.createElement('canvas');
  canvas.width = vb.width * scale + pad * 2;
  canvas.height = vb.height * scale + pad * 2 + 260;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = new Image();
  const blobUrl = URL.createObjectURL(new Blob([svgEl.outerHTML], { type: 'image/svg+xml' }));
  img.onload = () => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, pad, pad + 120, vb.width * scale, vb.height * scale);
    ctx.fillStyle = '#0a0a0c';
    ctx.textAlign = 'center';
    ctx.font = 'bold 72px sans-serif';
    ctx.fillText('PROJECT X', canvas.width / 2, 110);
    ctx.font = '36px sans-serif';
    const ev = state.events.find((e) => e.id === state.current);
    ctx.fillText(ev ? `${ev.title} · ${fmtWhen(toIso(ev.starts_at))}` : state.current, canvas.width / 2, canvas.height - 130);
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText('Сканируй — проходка за минуту', canvas.width / 2, canvas.height - 70);
    ctx.font = '26px sans-serif';
    ctx.fillStyle = '#777';
    ctx.fillText(tag, canvas.width / 2, canvas.height - 28);
    URL.revokeObjectURL(blobUrl);
    const a = document.createElement('a');
    a.download = `projectx-poster-${tag}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    $('src-note').textContent = `Постер с меткой «${tag}» скачан`;
  };
  img.src = blobUrl;
}

async function printList() {
  if ($('print-list').hidden) await downloadOfflineList();
  if (!$('print-list').hidden) window.print();
}

// ---------- Касса на входе: ручное оформление гостя ----------
function renderWalkinWaves() {
  const sel = $('wi-wave');
  if (!sel || !state.lastStats) return;
  const prev = sel.value;
  const options = (state.lastStats.by_wave || [])
    .map((w) => {
      const left = Math.max(0, Number(w.quota) - Number(w.sold));
      const hidden = w.public === false;
      return { no: Number(w.wave_no), label: `${w.name} · ${rub(w.price_rub)} · осталось ${left}${hidden ? ' · скрытая' : ''}`, left, hidden };
    });
  sel.innerHTML = options
    .map((o) => `<option value="${o.no}" ${o.left === 0 ? 'disabled' : ''}>${esc(o.label)}</option>`)
    .join('');
  // по умолчанию — последняя доступная ПУБЛИЧНАЯ волна (обычно «на входе»);
  // скрытый гостевой список выбирают руками
  const avail = options.filter((o) => o.left > 0 && !o.hidden);
  sel.value = prev && options.some((o) => String(o.no) === prev && o.left > 0) ? prev : String(avail.at(-1)?.no ?? '');
}

function bindWalkin() {
  if ($('wi-add').dataset.bound) return;
  $('wi-add').dataset.bound = '1';
  $('wi-name').oninput = () => { $('err-wi-name').style.display = 'none'; };
  $('wi-add').onclick = async () => {
    const name = $('wi-name').value.trim();
    if (name.length < 2) {
      $('err-wi-name').style.display = 'block';
      $('wi-name').focus();
      return;
    }
    const btn = $('wi-add');
    btn.disabled = true;
    btn.textContent = 'Оформляю…';
    let j = null;
    try {
      const r = await fetch('/api/walkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({
          event_id: state.current,
          wave_no: Number($('wi-wave').value),
          name,
          checkin: $('wi-checkin').checked,
          by: `касса · ${state.name}`,
        }),
      });
      j = await r.json().catch(() => null);
    } catch { /* ниже */ }
    btn.disabled = false;
    btn.textContent = 'Оформить';
    const log = $('walkin-log');
    if (j?.ok) {
      $('wi-name').value = '';
      log.insertAdjacentHTML(
        'afterbegin',
        `<div class="scan-feed-item"><span class="dot dot-ok"></span>
         <span><b>${esc(j.ticket.holder_name)}</b> · ${rub(j.price_rub)}${j.checked_in_at ? ' · впущен' : ''}</span>
         <a class="muted" style="margin-left:auto;" href="${esc(j.ticket.url)}" target="_blank" rel="noopener">билет</a></div>`
      );
      refresh();
    } else if (j?.error === 'wave_sold_out') {
      log.insertAdjacentHTML(
        'afterbegin',
        `<div class="scan-feed-item"><span class="dot dot-bad"></span>
         <span>${esc(j.message)}${j.next_wave ? ` — следующая: ${esc(j.next_wave.name)} за ${j.next_wave.priceRub} ₽` : ''}</span></div>`
      );
      refresh();
    } else {
      log.insertAdjacentHTML(
        'afterbegin',
        `<div class="scan-feed-item"><span class="dot dot-bad"></span><span>${esc(j?.message || 'Не получилось — проверь сеть')}</span></div>`
      );
    }
  };
}

// ---------- Сервис: инициализация БД и боевой самотест ----------
const TEST_PHONE = '+70000000000'; // маркер тестовых заказов, чистится cleanupTest

function bindService() {
  if ($('svc-seed').dataset.bound) return;
  $('svc-seed').dataset.bound = '1';

  $('svc-seed').onclick = async () => {
    const btn = $('svc-seed');
    btn.disabled = true;
    $('svc-note').textContent = 'Инициализирую…';
    let j = null;
    try {
      const r = await fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ demoSold: $('svc-demo').checked }),
      });
      j = await r.json().catch(() => null);
    } catch { /* ниже */ }
    btn.disabled = false;
    if (j?.ok) {
      $('svc-note').textContent = `Готово: схема применена, событий засеяно — ${j.seeded}. Перезагружаю…`;
      setTimeout(() => location.reload(), 1200);
    } else {
      $('svc-note').textContent = j?.message
        ? `Не получилось: ${j.message}`
        : 'Не получилось: проверь, что DATABASE_URL добавлен и сделан Redeploy';
    }
  };

  $('svc-selftest').onclick = runSelfTest;
  $('svc-bot').onclick = setupBot;
}

// «Настроить бота»: сервер регистрирует вебхук, команды и описание в
// Telegram (api/tg-webhook.js, action=setup). Токен остаётся на сервере.
async function setupBot() {
  const btn = $('svc-bot');
  const note = $('bot-note');
  btn.disabled = true;
  note.textContent = 'Настраиваю…';
  let j = null;
  try {
    const r = await fetch('/api/tg-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ action: 'setup' }),
    });
    j = await r.json().catch(() => null);
  } catch { /* ниже */ }
  btn.disabled = false;
  if (!j?.ok) {
    note.textContent = `Не получилось: ${j?.message || 'сервер не ответил'}`;
    return;
  }
  const wh = j.webhook || {};
  const parts = [`${j.message || `Готово: @${j.bot.username}`}.`];
  if (wh.url) parts.push(`Вебхук: ${wh.url}${wh.redirected_from ? ` (взят после редиректа с ${wh.redirected_from})` : ''}.`);
  if (wh.pending) parts.push(`В очереди Telegram: ${wh.pending}.`);
  if (wh.last_error) parts.push(`Последняя ошибка Telegram: ${wh.last_error}.`);
  else parts.push('Ошибок доставки Telegram не видит.');
  if (j.delivery === null) parts.push('Проверочное сообщение не отправлено: TELEGRAM_CHAT_ID не задан.');
  else if (j.delivery?.ok) parts.push('Проверочное сообщение владельцу доставлено — смотри чат с ботом.');
  else parts.push(`Проверочное сообщение владельцу НЕ доставлено: ${j.delivery?.error || 'неизвестная ошибка'}.`);
  const w = j.welcome;
  if (w?.via === 'photo') parts.push('Приветствие с афишей владельцу отправлено — так же его получит гость.');
  else if (w?.via === 'text') parts.push(`Приветствие владельцу отправлено текстом${w.photo_error ? ` (афиша не прошла: ${w.photo_error})` : ''}.`);
  else if (w) parts.push(`Приветствие владельцу НЕ отправлено: ${w.error || 'неизвестная ошибка'}${w.photo_error ? `; афиша: ${w.photo_error}` : ''}.`);
  if (j.username_mismatch) {
    parts.push(
      `Внимание: в Vercel TELEGRAM_BOT_USERNAME=${j.username_mismatch.env}, а бот на самом деле @${j.username_mismatch.actual} — ` +
        'исправь переменную, иначе кнопка «Получить в Telegram» на сайте ведёт не туда.'
    );
  }
  note.textContent = parts.join(' ');
}

// Боевой самотест: полный цикл покупка → билет → скан → чек-ин → повтор →
// статистика → уборка. Гоняется на этом же домене с ключом из localStorage —
// ключ не покидает устройство.
async function runSelfTest() {
  const btn = $('svc-selftest');
  const list = $('selftest-list');
  btn.disabled = true;
  list.innerHTML = '';
  const row = (ok, name, detail = '') => {
    list.insertAdjacentHTML(
      'beforeend',
      `<div class="scan-feed-item"><span class="dot ${ok ? 'dot-ok' : 'dot-bad'}"></span>
       <span><b>${ok ? 'OK' : 'FAIL'}</b> · ${esc(name)}</span>
       ${detail ? `<span class="muted" style="margin-left:auto;">${esc(String(detail).slice(0, 60))}</span>` : ''}</div>`
    );
    return ok;
  };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...headers(), ...(opts.headers || {}) },
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };

  try {
    // 1. афиша живая (из БД, не из сида)
    const ev = await api('/api/events');
    const live = ev.j?.ok && !ev.j.degraded && ev.j.events?.length;
    if (!row(Boolean(live), 'БД отвечает, афиша живая', live ? `${ev.j.events.length} событий` : 'degraded/пусто')) {
      throw new Error('stop');
    }
    const target = ev.j.events.find((e) => e.status === 'onsale' && activeWave(e.waves));
    if (!row(Boolean(target), 'есть событие в продаже', target?.title || 'нет')) throw new Error('stop');
    const wave = activeWave(target.waves);

    // 2. тестовая покупка
    const order = await api('/api/order', {
      method: 'POST',
      body: JSON.stringify({
        event_id: target.id,
        wave_no: wave.waveNo,
        buyer: { name: 'ТЕХ. ПРОВЕРКА', phone: TEST_PHONE },
        attendees: [{ name: 'ТЕХ. ПРОВЕРКА', minor: false }],
        consent: true,
        website: '',
      }),
    });
    const ticket = order.j?.ok && order.j.tickets?.[0];
    if (!row(Boolean(ticket), 'бронь проходит (заказ + билет)', ticket ? `${order.j.order_id}${order.j.pay_code ? ' · ' + order.j.pay_code : ''}` : order.j?.message)) {
      throw new Error('stop');
    }
    const token = ticket.url.replace('/t/', '');

    // 2а. оплата переводом: бронь ждёт подтверждения, подтверждаем как владелец
    if (order.j.payment?.status === 'pending') {
      const v0 = await api(`/api/verify?token=${encodeURIComponent(token)}`);
      row(v0.j?.status === 'reserved', 'до оплаты билет не проходит (reserved)', v0.j?.status);
      const conf = await api('/api/walkin', {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm', order_id: order.j.order_id, provider: 'transfer', by: 'самотест' }),
      });
      if (!row(Boolean(conf.j?.ok), 'подтверждение оплаты активирует билет', conf.j?.ok ? conf.j.pay_code : conf.j?.message)) {
        throw new Error('stop');
      }
    }

    // 3. билет читается
    const t = await api(`/api/ticket?token=${encodeURIComponent(token)}`);
    row(Boolean(t.j?.ok && t.j.ticket), 'билет открывается', t.j?.ticket?.holderName);

    // 4. верификация: активен
    const v1 = await api(`/api/verify?token=${encodeURIComponent(token)}`);
    row(v1.j?.status === 'active', 'скан: билет активен', v1.j?.status);

    // 5-6. чек-ин ровно один раз
    const c1 = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ token, by: 'самотест' }) });
    row(c1.j?.ok && c1.j.first === true, 'чек-ин: впущен', c1.j?.checked_in_at ? fmtTime(c1.j.checked_in_at) : '');
    const c2 = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ token, by: 'самотест' }) });
    row(c2.j?.ok && c2.j.first === false, 'повторный чек-ин отклонён (одноразовость)');

    // 7. статистика отражает
    const st = await api(`/api/stats?event_id=${encodeURIComponent(target.id)}`);
    row(Boolean(st.j?.ok && st.j.sold >= 1 && st.j.checked_in >= 1), 'статистика видит продажу и вход',
      st.j?.ok ? `продано ${st.j.sold}, вошло ${st.j.checked_in}` : '');

    // 8. уборка тестовых данных
    const cl = await api('/api/seed', { method: 'POST', body: JSON.stringify({ cleanupTest: true }) });
    row(Boolean(cl.j?.ok), 'тестовые данные убраны, квоты возвращены', cl.j?.ok ? `заказов: ${cl.j.cleaned}` : '');

    $('svc-note').textContent = 'Самотест завершён — если всё зелёное, боевая связка работает.';
    refresh();
  } catch {
    $('svc-note').textContent = 'Самотест остановлен на красном шаге — смотри список выше.';
  }
  btn.disabled = false;
}


// ---------- Афиша: создание и правка событий ----------
// У бренда нет TG-канала, поэтому афишей владелец управляет отсюда.
// Сервер (api/event-upsert.js) — единственный источник правды: он же
// валидирует цены/квоты и не даёт удалить проданную волну.
const EMPTY_EVENT = () => ({
  id: '', title: '', date: '', timeStart: '22:00', timeEnd: '06:00',
  ageRating: 18, status: 'onsale', venue: '', address: '', descr: '', secret: false,
  waves: [{ waveNo: 1, name: 'Проходка', priceRub: 1000, quota: 200, sold: 0, public: true }],
});

function bindEventEditor() {
  const form = $('event-form');
  if (!form) return;
  state.editorWaves = [];
  $('ee-new').onclick = () => { if (confirmDiscard()) fillEditor(EMPTY_EVENT()); };
  $('ee-select').onchange = () => {
    if (!confirmDiscard()) {
      // человек передумал уходить — возвращаем выбор на редактируемое событие
      $('ee-select').value = $('ee-id').value;
      return;
    }
    const ev = (state.adminEvents || []).find((e) => e.id === $('ee-select').value);
    if (ev) fillEditor(toEditor(ev));
  };
  $('ee-wave-add').onclick = () => {
    const next = Math.max(0, ...state.editorWaves.map((w) => w.waveNo)) + 1;
    state.editorWaves.push({ waveNo: next, name: `Волна ${next}`, priceRub: 0, quota: 50, sold: 0, public: true });
    renderEditorWaves();
  };
  $('ee-save').onclick = saveEvent;
  loadAdminEvents();
}

// событие из API → плоская форма (дата/время в поясе площадки)
function toEditor(ev) {
  const local = (iso) => {
    // в БД лежит момент времени; форма показывает часы площадки (+05:00)
    const d = new Date(new Date(iso).getTime() + 5 * 3600_000);
    return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
  };
  const st = local(ev.startsAt);
  const en = ev.endsAt ? local(ev.endsAt) : { time: '06:00' };
  return {
    id: ev.id, title: ev.title, date: st.date, timeStart: st.time, timeEnd: en.time,
    ageRating: Number(ev.ageRating), status: ev.status, venue: ev.venue || '',
    address: ev.address || '', descr: ev.descr || '', secret: Boolean(ev.secret),
    waves: (ev.waves || []).map((w) => ({ ...w, sold: Number(w.sold) || 0, public: w.public !== false })),
  };
}

async function loadAdminEvents(selectId) {
  try {
    const r = await fetch('/api/event-upsert', { headers: headers() });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) return;
    state.adminEvents = j.events || [];
    const sel = $('ee-select');
    sel.innerHTML =
      '<option value="">— выбери событие —</option>' +
      state.adminEvents
        .map((e) => {
          const mark = e.status === 'draft' ? ' · черновик' : e.status === 'past' ? ' · прошло' : '';
          return `<option value="${esc(e.id)}">${esc(e.title)} · ${esc(fmtWhen(e.startsAt))}${mark}</option>`;
        })
        .join('');
    const pick = selectId || sel.value;
    if (pick && state.adminEvents.some((e) => e.id === pick)) {
      sel.value = pick;
      fillEditor(toEditor(state.adminEvents.find((e) => e.id === pick)));
    } else if (!state.editorWaves.length) {
      fillEditor(EMPTY_EVENT());
    }
  } catch { /* редактор просто останется пустым */ }
}

// Слепок того, что сейчас в форме. Нужен, чтобы отличить «человек ничего не
// трогал» от «человек полчаса набирал описание».
function editorSnapshot() {
  return JSON.stringify([
    $('ee-id').value, $('ee-title').value, $('ee-date').value, $('ee-start').value,
    $('ee-end').value, $('ee-age').value, $('ee-status').value, $('ee-venue').value,
    $('ee-address').value, $('ee-descr').value, $('ee-secret')?.checked,
    (state.editorWaves || []).map((w) => [w.waveNo, w.name, w.priceRub, w.quota, w.public]),
  ]);
}

// Переключение события затирало форму молча: набранное описание исчезало без
// единого слова. Теперь несохранённое сначала спрашивает.
function editorDirty() {
  return Boolean(state.editorBase) && editorSnapshot() !== state.editorBase;
}
function confirmDiscard() {
  if (!editorDirty()) return true;
  return window.confirm('В форме есть несохранённые правки. Уйти и потерять их?');
}

function fillEditor(ev) {
  $('ee-id').value = ev.id || '';
  $('ee-title').value = ev.title || '';
  $('ee-date').value = ev.date || '';
  $('ee-start').value = ev.timeStart || '23:00';
  $('ee-end').value = ev.timeEnd || '06:00';
  $('ee-age').value = String(ev.ageRating || 18);
  $('ee-status').value = ev.status || 'onsale';
  $('ee-venue').value = ev.venue || '';
  $('ee-address').value = ev.address || '';
  $('ee-descr').value = ev.descr || '';
  if ($('ee-secret')) $('ee-secret').checked = Boolean(ev.secret);
  state.editorWaves = (ev.waves || []).map((w) => ({
    waveNo: Number(w.waveNo), name: w.name, priceRub: Number(w.priceRub),
    quota: Number(w.quota), sold: Number(w.sold) || 0, public: w.public !== false,
  }));
  renderEditorWaves();
  $('ee-note').textContent = ev.id ? `Правишь: ${ev.id}` : 'Новое событие';
  state.editorBase = editorSnapshot();
}

function renderEditorWaves() {
  $('ee-waves').innerHTML = state.editorWaves
    .map(
      (w, i) => `
      <div class="ef-wave" data-i="${i}">
        <input type="text" data-f="name" value="${esc(w.name)}" placeholder="Название волны" aria-label="Название волны" />
        <input type="number" data-f="priceRub" value="${w.priceRub}" min="0" max="50000" aria-label="Цена, ₽" />
        <input type="number" data-f="quota" value="${w.quota}" min="1" max="5000" aria-label="Квота" />
        <button type="button" data-act="del" ${w.sold > 0 ? 'disabled title="Есть продажи — удалить нельзя"' : 'title="Удалить волну"'}>×</button>
        ${w.sold > 0 ? `<span class="ef-sold">продано ${w.sold}</span>` : ''}
        <label class="check"><input type="checkbox" data-f="public" ${w.public !== false ? 'checked' : ''} /><span>видна на сайте (сними для гостевого списка — продаёт только касса)</span></label>
      </div>`
    )
    .join('');
  $('ee-waves').querySelectorAll('.ef-wave').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelectorAll('input').forEach((inp) => {
      const f = inp.dataset.f;
      if (f === 'public') {
        inp.onchange = () => { state.editorWaves[i].public = inp.checked; };
        return;
      }
      inp.oninput = () => {
        state.editorWaves[i][f] = f === 'name' ? inp.value : Number(inp.value);
        inp.classList.remove('ee-bad');
      };
    });
    const del = row.querySelector('[data-act="del"]');
    if (del) del.onclick = () => {
      if (state.editorWaves[i].sold > 0) return;
      state.editorWaves.splice(i, 1);
      renderEditorWaves();
    };
  });
}

async function saveEvent() {
  const btn = $('ee-save');
  const note = $('ee-note');
  btn.disabled = true;
  note.textContent = 'Сохраняю…';
  const body = {
    id: $('ee-id').value.trim() || undefined,
    title: $('ee-title').value.trim(),
    date: $('ee-date').value,
    timeStart: $('ee-start').value,
    timeEnd: $('ee-end').value,
    ageRating: Number($('ee-age').value),
    status: $('ee-status').value,
    venue: $('ee-venue').value.trim(),
    address: $('ee-address').value.trim(),
    descr: $('ee-descr').value.trim(),
    secret: Boolean($('ee-secret')?.checked),
    waves: state.editorWaves.map((w) => ({
      waveNo: w.waveNo, name: w.name, priceRub: w.priceRub, quota: w.quota, public: w.public !== false,
    })),
  };
  try {
    const r = await fetch('/api/event-upsert', {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) {
      note.textContent = j?.message || 'Не удалось сохранить';
      (j?.fields || []).forEach((f) => {
        const map = { title: 'ee-title', date: 'ee-date', timeStart: 'ee-start', timeEnd: 'ee-end', ageRating: 'ee-age', status: 'ee-status' };
        $(map[f.field])?.classList.add('ee-bad');
      });
      btn.disabled = false;
      return;
    }
    // список перечитываем ДО сообщения: fillEditor внутри пишет свой текст
    // в ту же плашку и затёр бы результат сохранения
    await loadAdminEvents(j.event_id);
    const warn = (j.warnings || []).join('; ');
    note.textContent = `${j.created ? 'Создано' : 'Обновлено'}: ${j.event_id}${warn ? ' · ' + warn : ''}`;
    // афиша и статистика могли измениться — перечитываем сводку
    if (typeof refresh === 'function' && state.current) refresh();
  } catch {
    note.textContent = 'Сеть недоступна — попробуй ещё раз';
  }
  btn.disabled = false;
}
