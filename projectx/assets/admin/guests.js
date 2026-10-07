// Гости ночи: касса на входе, список проходок с поиском и фильтрами,
// переоформление и аннулирование, офлайн-копия для сканера и печать.
import {
  $, state, api, on, visible, loadStats, nightById, esc, icon, toast, dialog, promptDlg, busy, fmtTime, fmtWhen,
  plural, priceLabel, initials, ls,
} from './core.js';
import { formatTicketCode as code } from '../ticket-format.js';

const g = { id: null, list: null, at: 0, filter: 'all', q: '', loading: false };

export function show() {
  bindOnce();
  renderWalkinWaves();
  if (g.id !== state.night || !g.list || Date.now() - g.at > 60_000) loadGuests();
  else renderList();
}
on('night', () => {
  g.id = null;
  g.list = null;
  $('walkin-log').innerHTML = '';
  if (visible('guests')) show();
});
on('stats', () => visible('guests') && renderWalkinWaves());
on('refresh', () => visible('guests') && loadGuests());

// ---------- список ----------
async function loadGuests({ save = false } = {}) {
  const id = state.night;
  if (!id) {
    $('guests-table').innerHTML = '';
    return null;
  }
  if (!g.list || g.id !== id) $('guests-table').innerHTML = '<div class="sk" style="height:180px"></div>';
  g.loading = true;
  const r = await api(`/api/stats?event_id=${encodeURIComponent(id)}&list=1`, { timeout: 20000 });
  g.loading = false;
  if (state.night !== id) return null;
  if (!r.ok || !Array.isArray(r.j.tickets)) {
    $('guests-table').innerHTML = `<div class="empty">${icon('alert')}<b>Список не загрузился</b><span class="small">${esc(r.message || '')}</span></div>`;
    return null;
  }
  g.id = id;
  g.list = r.j.tickets;
  g.at = Date.now();
  // офлайн-копия на этом телефоне уже есть — держим её свежей
  if (save || ls.get(`th_offline_${id}`)) saveOffline(id, g.list, save);
  renderList();
  return g.list;
}

// Снимок для сканера: scan.html найдёт гостя даже без интернета.
// o — заказ: дверь в офлайне принимает наличные за неоплаченную бронь
function saveOffline(id, tickets, loud) {
  const map = {};
  for (const t of tickets) map[t.id] = { n: t.holder_name, a: t.age_cat, s: t.status, c: t.checked_in_at, o: t.order_id };
  const okSave = ls.set(`th_offline_${id}`, JSON.stringify(map));
  const n = tickets.length;
  $('offline-note').textContent = okSave
    ? `Офлайн-копия на этом телефоне: ${n} ${plural(n, 'гость', 'гостя', 'гостей')} · обновлено в ${fmtTime(new Date().toISOString())}`
    : 'Не хватило места в браузере для офлайн-копии';
  if (loud) toast(okSave ? 'Список сохранён на этом телефоне — сканер работает и без сети' : 'Не хватило места в браузере', okSave ? 'ok' : 'err');
}

const GROUPS = {
  all: ['Все', () => true],
  in: ['Пришли', (t) => Boolean(t.checked_in_at)],
  wait: ['Ещё не пришли', (t) => t.status === 'active' && !t.checked_in_at],
  unpaid: ['Ждут оплаты', (t) => t.status === 'reserved'],
  off: ['Сняты', (t) => ['revoked', 'refunded', 'cancelled', 'expired'].includes(t.status)],
};
const STATUS = {
  active: ['', ''],
  reserved: ['ждёт оплаты', 'warn-t'],
  expired: ['бронь сгорела', 'muted'],
  cancelled: ['отменена', 'muted'],
  revoked: ['аннулирована', 'bad-t'],
  refunded: ['возврат', 'bad-t'],
};

function renderList() {
  const list = g.list || [];
  const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, [, fn]]) => [k, list.filter(fn).length]));
  $('g-filter').innerHTML = Object.entries(GROUPS)
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, [label]]) => `<button type="button" class="chip" data-gf="${k}" aria-pressed="${g.filter === k}">${esc(label)} <span class="n">${counts[k]}</span></button>`)
    .join('');
  const q = g.q.trim().toLowerCase().replace(/-/g, '');
  const shown = list
    .filter(GROUPS[g.filter]?.[1] || (() => true))
    .filter((t) => !q || t.holder_name.toLowerCase().includes(q) || t.id.includes(q));
  $('g-count').textContent = String(list.filter((t) => t.status === 'active' || t.status === 'reserved').length);
  const e = nightById(state.night);
  $('print-head').innerHTML = e ? `<h2>${esc(e.title)} — список гостей</h2><p>${esc(fmtWhen(e.startsAt))} · ${list.filter((t) => t.status === 'active').length} проходок</p>` : '';
  if (!list.length) {
    $('guests-table').innerHTML = `<div class="empty">${icon('users')}<b>Гостей пока нет</b><span class="small">Проходки появятся здесь после первой брони или оформления в кассе.</span></div>`;
    return;
  }
  if (!shown.length) {
    $('guests-table').innerHTML = `<div class="empty"><span class="small">Никого не нашлось${q ? ` по «${esc(g.q)}»` : ''}</span></div>`;
    return;
  }
  $('guests-table').innerHTML = shown.map((t) => {
    const [label, cls] = STATUS[t.status] || [t.status, 'muted'];
    // неоплаченную бронь снимают целиком в «Бронях» — иначе место вернулось бы дважды
    const canRename = (t.status === 'active' || t.status === 'reserved') && !t.checked_in_at;
    const canVoid = t.status === 'active' && !t.checked_in_at;
    const st = t.checked_in_at
      ? `<span class="ok-t">вошёл в ${esc(fmtTime(t.checked_in_at))}</span>`
      : label ? `<span class="${cls}">${esc(label)}</span>` : '<span class="muted">ждём на входе</span>';
    return `<div class="g${t.checked_in_at ? ' is-in' : ''}">
      <span class="g-av">${t.checked_in_at ? icon('check') : esc(initials(t.holder_name))}</span>
      <span class="g-tx"><span class="g-n">${esc(t.holder_name)}${t.age_cat === 'minor' ? ' <span class="tag tag-warn">до 18</span>' : ''}</span><span class="g-c">${esc(code(t.id))}</span></span>
      <span class="g-st">${st}</span>
      <span class="g-menu">
        ${canRename ? `<button class="b b-quiet b-sm b-icon" type="button" data-ga="rename" data-id="${esc(t.id)}" title="Переоформить на другое имя" aria-label="Переоформить">${icon('edit')}</button>` : ''}
        ${canVoid ? `<button class="b b-quiet b-sm b-icon" type="button" data-ga="void" data-id="${esc(t.id)}" title="Аннулировать" aria-label="Аннулировать">${icon('x')}</button>` : ''}
      </span>
    </div>`;
  }).join('');
}

// Переоформление и аннулирование — через кассу (/api/walkin), только владелец
async function guestAction(kind, id, btn) {
  const t = (g.list || []).find((x) => x.id === id);
  if (!t) return;
  let body;
  if (kind === 'rename') {
    const name = await promptDlg({
      title: 'Переоформить проходку',
      text: `${code(id)} сейчас на имя «${t.holder_name}». QR останется тем же — гостю ничего пересылать не нужно.`,
      value: t.holder_name, placeholder: 'Имя и фамилия', ok: 'Переоформить', min: 2,
    });
    if (!name || name === t.holder_name) return;
    body = { action: 'rename', ticket_id: id, name };
  } else {
    const v = await dialog({
      title: `Аннулировать проходку?`,
      body: `<p><b>${esc(t.holder_name)}</b> · ${esc(code(id))}. Вход по ней перестанет работать, место вернётся в продажу.</p>
        <div class="radios">
          <label class="radio"><input type="radio" name="kind" value="refunded" checked /><span><b>Деньги вернули</b><small>В выручке и выгрузке — как возврат</small></span></label>
          <label class="radio"><input type="radio" name="kind" value="revoked" /><span><b>Без возврата</b><small>Например, проходка выдана по ошибке</small></span></label>
        </div>
        <input class="in" name="note" placeholder="Причина — необязательно" maxlength="200" autocomplete="off" />`,
      actions: [
        { label: 'Отмена', value: null, kind: 'ghost' },
        { label: 'Аннулировать', kind: 'danger', collect: (f) => ({ status: f.kind.value, note: f.note.value.trim() }) },
      ],
    });
    if (!v) return;
    body = { action: 'void', ticket_id: id, status: v.status, note: v.note };
  }
  const r = await busy(btn, () => api('/api/walkin', { method: 'POST', body: { ...body, by: state.name } }));
  if (!r.ok) {
    toast(r.message || 'Не получилось — проверь сеть', 'err', 6000);
    return;
  }
  toast(kind === 'rename' ? 'Проходка переоформлена' : 'Проходка аннулирована');
  await loadGuests();
  loadStats();
}

// ---------- касса ----------
function renderWalkinWaves() {
  const sel = $('wi-wave');
  const s = state.stats && state.stats.event_id === state.night ? state.stats : null;
  if (!s) return;
  const prev = sel.value;
  const opts = (s.by_wave || []).map((w) => {
    const left = Math.max(0, Number(w.quota) - Number(w.sold));
    const hidden = w.public === false;
    return { no: Number(w.wave_no), left, hidden, label: `${w.name} · ${priceLabel(w.price_rub)} · осталось ${left}${hidden ? ' · только касса' : ''}` };
  });
  sel.innerHTML = opts.length
    ? opts.map((o) => `<option value="${o.no}" ${o.left === 0 ? 'disabled' : ''}>${esc(o.label)}</option>`).join('')
    : '<option value="">Сначала добавь цены в настройках ночи</option>';
  // по умолчанию — последняя открытая публичная волна (обычно «на входе»);
  // скрытый гостевой список выбирают руками
  const avail = opts.filter((o) => o.left > 0 && !o.hidden);
  sel.value = prev && opts.some((o) => String(o.no) === prev && o.left > 0) ? prev : String(avail.at(-1)?.no ?? opts.find((o) => o.left > 0)?.no ?? '');
  $('wi-add').disabled = !opts.some((o) => o.left > 0);
}

async function walkin() {
  // Enter дважды подряд — две продажи: пока первая уходит, кнопка занята
  if ($('wi-add').disabled) return;
  const name = $('wi-name').value.trim();
  if (name.length < 2) {
    $('f-wi-name').classList.add('is-error');
    $('wi-name').focus();
    return;
  }
  const r = await busy($('wi-add'), () => api('/api/walkin', {
    method: 'POST',
    body: {
      event_id: state.night,
      wave_no: Number($('wi-wave').value),
      name,
      checkin: $('wi-checkin').checked,
      by: `касса · ${state.name}`,
    },
  }));
  const log = $('walkin-log');
  if (r.ok) {
    $('wi-name').value = '';
    log.insertAdjacentHTML('afterbegin', `<div class="feed-i"><span class="dot dot-ok"></span><span class="w"><b>${esc(r.j.ticket.holder_name)}</b> · ${esc(priceLabel(r.j.price_rub))}${r.j.checked_in_at ? ' · впущен' : ''}</span>
      <a class="by" href="${esc(r.j.ticket.url)}" target="_blank" rel="noopener">проходка ↗</a></div>`);
    toast(`${r.j.ticket.holder_name}: проходка оформлена${r.j.checked_in_at ? ', гость впущен' : ''}`);
    $('wi-name').focus();
    loadStats();
    loadGuests();
  } else {
    const next = r.j.next_wave ? ` Следующая: ${r.j.next_wave.name} за ${priceLabel(r.j.next_wave.priceRub)}.` : '';
    log.insertAdjacentHTML('afterbegin', `<div class="feed-i"><span class="dot dot-bad"></span><span class="w">${esc((r.message || 'Не получилось') + next)}</span></div>`);
    if (r.j.error === 'wave_sold_out') loadStats();
  }
  while (log.children.length > 6) log.lastElementChild.remove();
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  $('wi-add').onclick = walkin;
  $('wi-name').addEventListener('input', () => $('f-wi-name').classList.remove('is-error'));
  $('wi-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') walkin(); });
  $('g-search').addEventListener('input', (e) => {
    g.q = e.target.value;
    renderList();
  });
  $('g-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gf]');
    if (!b) return;
    g.filter = b.dataset.gf;
    renderList();
  });
  $('guests-table').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ga]');
    if (b) guestAction(b.dataset.ga, b.dataset.id, b);
  });
  $('btn-offline').onclick = () => busy($('btn-offline'), () => loadGuests({ save: true }));
  $('btn-print').onclick = async () => {
    if (!g.list || g.id !== state.night) await loadGuests();
    const prev = g.filter;
    const prevQ = g.q;
    g.filter = 'all';
    g.q = '';
    renderList();
    window.print();
    g.filter = prev;
    g.q = prevQ;
    renderList();
  };
}
