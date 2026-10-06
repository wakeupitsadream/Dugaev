// Ночи: карточки с афишей, статусом и продажами. Отсюда — создать новую,
// поправить, сделать копию на новую дату, открыть страницу, удалить пустую.
import {
  $, state, api, on, visible, reloadEvents, phaseOf, pill, isPublic, esc, icon, toast, confirmDlg, busy,
  fmtWhen, plural, rub, coverAttr, coverPh, setNight,
} from './core.js';

const FILTERS = {
  all: ['Все', () => true],
  soon: ['Скоро', (e) => ['onsale', 'soldout', 'live'].includes(phaseOf(e))],
  draft: ['Черновики', (e) => e.status === 'draft'],
  past: ['Прошедшие', (e) => ['past', 'stale', 'cancelled'].includes(phaseOf(e))],
};
let filter = 'all';

export function show() {
  bindOnce();
  render();
}
on('events', () => visible('events') && render());

function order(list) {
  const now = Date.now();
  const rank = (e) => {
    const ph = phaseOf(e, now);
    if (ph === 'live') return 0;
    if (ph === 'onsale' || ph === 'soldout') return 1;
    if (ph === 'draft') return 2;
    return 3;
  };
  return [...list].sort((a, b) => rank(a) - rank(b)
    || (rank(a) < 3 ? Date.parse(a.startsAt) - Date.parse(b.startsAt) : Date.parse(b.startsAt) - Date.parse(a.startsAt)));
}

function card(e) {
  const waves = e.waves || [];
  const quota = waves.reduce((s, w) => s + Number(w.quota || 0), 0);
  const sold = waves.reduce((s, w) => s + Number(w.sold || 0), 0);
  const pct = quota ? Math.min(100, Math.round((sold / quota) * 100)) : 0;
  const ph = phaseOf(e);
  const canDelete = !sold && !Number(e.pending) && !Number(e.revenue);
  const id = encodeURIComponent(e.id);
  return `<article class="ev" data-id="${esc(e.id)}">
    <a class="ev-cover" href="#events/${id}"${coverAttr(e.posterUrl)} aria-label="${esc(e.title)}">${coverPh(e.posterUrl)}${pill(e)}</a>
    <div class="ev-b">
      <div class="ev-d">${esc(fmtWhen(e.startsAt))}</div>
      <h3 class="ev-t"><a href="#events/${id}">${esc(e.title)}</a></h3>
      <div class="ev-v">${e.secret ? 'SECRET PLACE · ' : ''}${esc(e.venue || 'место не указано')}</div>
      ${quota ? `<div class="ev-m">
        <div class="meter${ph === 'past' || ph === 'stale' ? ' is-dim' : ''}"><i style="width:${Math.max(2, pct)}%"></i></div>
        <div class="ev-s"><span><b>${sold}</b> из ${quota}</span>${e.revenue ? `<span><b>${esc(rub(e.revenue))}</b></span>` : ''}${Number(e.pending) ? `<span class="warn-t">ждут ${e.pending}</span>` : ''}</div>
      </div>` : ['draft', 'onsale'].includes(e.status) ? '<div class="ev-s"><span class="warn-t">цены не указаны</span></div>' : ''}
    </div>
    <div class="ev-f">
      <a class="b b-quiet b-sm" href="#events/${id}">${icon('edit')}Изменить</a>
      <a class="b b-quiet b-sm" href="#events/copy/${id}" title="Новая ночь с теми же местом, ценами и программой">${icon('copy')}Копия</a>
      ${isPublic(e) ? `<a class="b b-quiet b-sm" href="/e/${id}" target="_blank" rel="noopener">${icon('external')}Сайт</a>` : ''}
      ${['onsale', 'soldout', 'live'].includes(ph) ? `<button class="b b-quiet b-sm" type="button" data-ev="stats">${icon('chart')}Сводка</button>` : ''}
      ${canDelete ? `<button class="b b-quiet b-sm" type="button" data-ev="delete" title="Удалить — продаж нет">${icon('trash')}</button>` : ''}
    </div>
  </article>`;
}

function render() {
  const all = state.events;
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, [, fn]]) => [k, all.filter(fn).length]));
  $('ev-filter').innerHTML = Object.entries(FILTERS)
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, [label]]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="${filter === k}">${esc(label)} <span class="n">${counts[k]}</span></button>`)
    .join('');
  $('ev-filter').hidden = all.length < 2;
  const list = order(all.filter(FILTERS[filter]?.[1] || (() => true)));
  const create = `<a class="ev ev-new" href="#events/new"><span class="plus">${icon('plus')}</span><span><b>Новая ночь</b><br><span class="small muted">из поста в Telegram или с нуля</span></span></a>`;
  if (!state.dbOk) {
    $('ev-list').innerHTML = `<div class="card empty" style="grid-column:1/-1">${icon('alert')}<b>База данных не отвечает</b><span class="small">Ночи хранятся в базе — подключи её в разделе «Сервис».</span><a class="b b-ghost" href="#service">Сервис</a></div>`;
    return;
  }
  $('ev-list').innerHTML = create + list.map(card).join('');
}

async function remove(id, btn) {
  const e = state.events.find((x) => x.id === id);
  if (!e) return;
  const ok = await confirmDlg({
    title: 'Удалить ночь?',
    text: `«${e.title}» исчезнет из панели${isPublic(e) ? ', с сайта и из бота' : ''}. Отменить это нельзя.`,
    ok: 'Удалить', danger: true,
  });
  if (!ok) return;
  const r = await busy(btn, () => api('/api/event-upsert', { method: 'POST', body: { action: 'delete', id } }));
  if (!r.ok) {
    toast(r.message, 'err', 6000);
    return;
  }
  await reloadEvents();
  toast('Ночь удалена');
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  $('ev-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    render();
  });
  $('ev-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ev]');
    if (!b) return;
    const id = b.closest('.ev')?.dataset.id;
    if (b.dataset.ev === 'delete') remove(id, b);
    else if (b.dataset.ev === 'stats') {
      setNight(id);
      location.hash = '#overview';
    }
  });
}

