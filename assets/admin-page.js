// Мини-дашборд организатора: продажи, выручка, чек-ины, лента сканов,
// сервис (инициализация БД, боевой самотест).
// Это витрина тех же данных, которые позже заберёт TG-бот через /api/stats.
import { plural, fmtWhen, fmtTime } from './ticket-format.js';
import { esc } from './events-load.js';
import { activeWave } from './waves.js';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'th_admin_key';
const LS_NAME = 'th_admin_name';

const state = {
  key: localStorage.getItem(LS_KEY) || '',
  name: localStorage.getItem(LS_NAME) || '',
  events: [],
  current: null,
  pollTimer: null,
};

init();

function init() {
  if (!state.key) return showGate();
  boot();
}

function showGate(err) {
  $('gate').hidden = false;
  $('dash').hidden = true;
  $('gate-err').style.display = err ? 'block' : 'none';
  $('gate-name').value = state.name;
  $('gate-go').onclick = () => {
    state.key = $('gate-key').value.trim();
    state.name = $('gate-name').value.trim() || 'админ';
    if (!state.key) return $('gate-key').focus();
    localStorage.setItem(LS_KEY, state.key);
    localStorage.setItem(LS_NAME, state.name);
    boot();
  };
}

function headers() {
  return { 'X-Admin-Key': state.key };
}

async function boot() {
  let j = null;
  let status = 0;
  try {
    const r = await fetch('/api/stats', { headers: headers() });
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
  bindService(); // кнопки сервиса доступны и до инициализации БД

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

  // «осталось» — из волн (та же математика, что видит гость на сайте)
  const leftTotal = (j.by_wave || []).reduce((s, w) => s + Math.max(0, Number(w.quota) - Number(w.sold)), 0);
  $('tiles').innerHTML = [
    { n: j.sold ?? 0, label: 'билетов продано' },
    { n: `${(j.revenue_rub ?? 0).toLocaleString('ru-RU')} ₽`, label: 'выручка' },
    { n: j.checked_in ?? 0, label: 'вошло на тусовку' },
    { n: leftTotal, label: 'осталось мест' },
    { n: j.minors ?? 0, label: 'браслетов (16+)' },
  ]
    .map((t) => `<div class="tile"><div class="t-num">${esc(String(t.n))}</div><div class="t-label">${esc(t.label)}</div></div>`)
    .join('');

  $('waves-table').innerHTML =
    `<tr><th>Волна</th><th class="num">Цена</th><th class="num">Продано</th><th class="num">Квота</th></tr>` +
    (j.by_wave || [])
      .map(
        (w) => `<tr><td>${esc(w.name)}</td><td class="num">${w.price_rub} ₽</td>
                <td class="num">${w.sold}</td><td class="num">${w.quota}</td></tr>`
      )
      .join('');

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

function renderGuestsTable(tickets) {
  $('print-list').hidden = false;
  $('guests-table').innerHTML =
    `<tr><th>Гость</th><th>Билет</th><th>Возраст</th><th>Статус</th><th>Вошёл</th></tr>` +
    tickets
      .map(
        (t) => `<tr><td>${esc(t.holder_name)}</td><td>${esc(t.id.toUpperCase())}</td>
                <td>${t.age_cat === 'minor' ? 'браслет' : '18+'}</td>
                <td>${t.status === 'active' ? '' : esc(t.status)}</td>
                <td>${t.checked_in_at ? esc(fmtTime(t.checked_in_at)) : ''}</td></tr>`
      )
      .join('');
}

async function printList() {
  if ($('print-list').hidden) await downloadOfflineList();
  if (!$('print-list').hidden) window.print();
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
    if (!row(Boolean(ticket), 'покупка проходит (заказ + билет)', ticket ? order.j.order_id : order.j?.message)) {
      throw new Error('stop');
    }
    const token = ticket.url.replace('/t/', '');

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
