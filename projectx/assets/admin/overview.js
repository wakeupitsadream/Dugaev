// Сводка по выбранной ночи: шапка, ключевые цифры, продажи по дням,
// заполнение волн, кривая входа и живая лента сканов.
import {
  $, state, on, visible, nightById, phaseOf, pill, countdown, isPublic, esc, icon, toast, copyText, siteUrl,
  fmtWhen, fmtTime, plural, rub, priceLabel, coverAttr, coverPh,
} from './core.js';
import { TZ } from '../ticket-format.js';

export function show() {
  render();
}
on('stats', () => visible('overview') && render());
on('night', () => visible('overview') && render());
on('events', () => visible('overview') && renderHero());

const cur = () => (state.stats && state.stats.event_id === state.night ? state.stats : null);

function render() {
  renderHero();
  const s = cur();
  if (!nightById(state.night)) {
    for (const id of ['ov-kpis', 'ov-days', 'ov-waves', 'ov-curve', 'ov-feed']) $(id).innerHTML = '';
    $('ov-kpis').hidden = true;
    for (const el of document.querySelectorAll('[data-view="overview"] .grid-2')) el.hidden = true;
    return;
  }
  $('ov-kpis').hidden = false;
  for (const el of document.querySelectorAll('[data-view="overview"] .grid-2')) el.hidden = false;
  if (!s) {
    $('ov-kpis').innerHTML = Array.from({ length: 5 }, () => '<div class="kpi"><div class="sk" style="height:12px;width:60%"></div><div class="sk" style="height:30px;width:70%;margin-top:6px"></div></div>').join('');
    for (const id of ['ov-days', 'ov-waves', 'ov-curve', 'ov-feed']) $(id).innerHTML = '<div class="sk" style="height:120px"></div>';
    return;
  }
  renderKpis(s);
  renderDays(s);
  renderWaves(s);
  // вход по времени и лента сканов нужны с ночи — до неё это пустые блоки
  const e = nightById(state.night);
  const door = (s.checkin_curve || []).length || (s.last_scans || []).length || ['live', 'stale', 'past'].includes(phaseOf(e));
  $('ov-door').hidden = !door;
  if (door) {
    renderCurve(s);
    renderFeed(s);
  }
}

function renderHero() {
  const host = $('ov-hero');
  const e = nightById(state.night);
  if (!e) {
    host.innerHTML = state.dbOk
      ? `<div class="empty">${icon('calendar')}<b>Ночей пока нет</b><span class="small">Создай первую — вставь пост из Telegram, и поля заполнятся сами.</span>
          <a class="b b-primary" href="#events/new">${icon('plus')}Новая ночь</a></div>`
      : `<div class="empty">${icon('alert')}<b>База данных не отвечает</b><span class="small">Подключи Neon Postgres в Vercel и нажми «Инициализировать БД» в разделе «Сервис».</span>
          <a class="b b-ghost" href="#service">Сервис</a></div>`;
    return;
  }
  const pub = isPublic(e);
  host.innerHTML = `<div class="nh">
    <div class="nh-cover"${coverAttr(e.posterUrl)}>${coverPh(e.posterUrl)}</div>
    <div class="nh-main">
      <div class="nh-meta">${pill(e)}<span class="muted">${esc(countdown(e))}</span></div>
      <div class="nh-title">${esc(e.title)}</div>
      <div class="nh-sub">${esc(fmtWhen(e.startsAt).toLowerCase())}${e.venue ? ` · ${esc(e.venue)}` : ''}</div>
      <div class="nh-acts">
        <a class="b b-ghost b-sm" href="#events/${encodeURIComponent(e.id)}">${icon('edit')}Изменить</a>
        ${pub ? `<a class="b b-ghost b-sm" href="/e/${encodeURIComponent(e.id)}" target="_blank" rel="noopener">${icon('external')}Страница</a>
        <button class="b b-ghost b-sm" type="button" data-copy-link>${icon('copy')}Ссылка</button>` : ''}
        ${e.status === 'draft' ? `<a class="b b-primary b-sm" href="#events/${encodeURIComponent(e.id)}">${icon('send')}Опубликовать</a>` : ''}
      </div>
    </div>
  </div>`;
  const cb = host.querySelector('[data-copy-link]');
  if (cb) cb.onclick = async () => { if (await copyText(siteUrl(e))) toast('Ссылка скопирована'); };
}

function renderKpis(s) {
  const prov = Object.fromEntries((s.by_provider || []).map((p) => [p.provider, p]));
  const online = (prov.transfer?.n || 0) + (prov.stub?.n || 0);
  const door = prov.door?.n || 0;
  const onlineRub = (prov.transfer?.rub || 0) + (prov.stub?.rub || 0);
  const doorRub = prov.door?.rub || 0;
  const sold = Number(s.sold || 0);
  const checked = Number(s.checked_in || 0);
  const pending = s.pending || [];
  const pendingN = pending.reduce((a, o) => a + o.qty, 0);
  const claimed = pending.filter((o) => o.claimed_at).length;
  const pendingRub = s.pending_rub ?? pending.reduce((a, o) => a + o.amount_rub, 0);
  const waves = s.by_wave || [];
  const left = waves.reduce((a, w) => a + Math.max(0, Number(w.quota) - Number(w.sold)), 0);
  const quota = waves.reduce((a, w) => a + Number(w.quota), 0);
  const refunded = s.refunded && s.refunded.n ? s.refunded : null;
  const tiles = [
    { n: sold, l: 'Оплачено проходок', s: sold ? `переводом ${online} · на входе ${door}` : 'продаж пока нет', cls: 'is-acc' },
    { n: rub(s.revenue_rub || 0), l: 'Выручка', s: refunded ? `возвраты: ${refunded.n} на ${rub(refunded.rub)}` : `переводом ${rub(onlineRub)} · касса ${rub(doorRub)}` },
    {
      n: pendingN, l: 'Ждут оплаты', href: '#orders', cls: pendingN ? 'is-warn' : '',
      s: pendingN ? `${pending.length} ${plural(pending.length, 'бронь', 'брони', 'броней')} · ${rub(pendingRub)}${claimed ? ` · ${claimed} уже ${plural(claimed, 'перевёл', 'перевели', 'перевели')}` : ''}` : 'все брони закрыты',
    },
    { n: checked, l: 'Вошли на ночь', s: sold ? `${Math.round((checked / sold) * 100)}% от оплаченных` : '—' },
    { n: left, l: 'Осталось мест', s: `из ${quota}${s.capacity ? ` · вместимость ${s.capacity}` : ''}` },
  ];
  $('ov-kpis').innerHTML = tiles.map((t) => {
    const tag = t.href ? 'a' : 'div';
    return `<${tag} class="kpi ${t.cls || ''}"${t.href ? ` href="${t.href}"` : ''}>
      <span class="kpi-l">${esc(t.l)}</span><span class="kpi-n">${esc(String(t.n))}</span>${t.s ? `<span class="kpi-s">${esc(t.s)}</span>` : ''}</${tag}>`;
  }).join('');
}

// 14 дней до сегодняшнего (или до ночи, если она прошла) — пустые дни тоже
// видны, иначе график врёт о динамике
function renderDays(s) {
  const rows = s.sales_by_day || [];
  const by = new Map(rows.map((r) => [r.d, r]));
  const e = nightById(state.night);
  const endMs = Math.min(Date.now(), e ? Date.parse(e.startsAt) + 86400_000 : Date.now());
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(endMs - i * 86400_000).toLocaleDateString('en-CA', { timeZone: TZ });
    days.push({ d, n: by.get(d)?.n || 0, rub: by.get(d)?.rub || 0 });
  }
  const total = rows.reduce((a, r) => a + r.n, 0);
  const totalRub = rows.reduce((a, r) => a + r.rub, 0);
  $('ov-days-sum').textContent = total ? `${total} ${plural(total, 'проходка', 'проходки', 'проходок')} · ${rub(totalRub)}` : '';
  if (!total) {
    $('ov-days').innerHTML = `<div class="bars-empty">За две недели оплат пока не было</div>`;
    return;
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  $('ov-days').innerHTML = `<div class="bars">${days.map((d) => {
    const h = d.n ? Math.max(5, Math.round((d.n / max) * 84)) : 2;
    const label = d.d.slice(8, 10) + '.' + d.d.slice(5, 7);
    return `<div class="bar${d.n ? '' : ' is-zero'}" title="${esc(label)}: ${d.n} шт · ${esc(rub(d.rub))}"><div class="bar-t"><b>${d.n || ''}</b><i style="height:${h}%"></i></div><span>${esc(label)}</span></div>`;
  }).join('')}</div>`;
}

function renderWaves(s) {
  const waves = s.by_wave || [];
  const quota = waves.reduce((a, w) => a + Number(w.quota), 0);
  const sold = waves.reduce((a, w) => a + Number(w.sold), 0);
  $('ov-fill-sub').textContent = quota ? `занято ${sold} из ${quota} · ${Math.round((sold / quota) * 100)}%` : '';
  if (!waves.length) {
    $('ov-waves').innerHTML = `<div class="empty">${icon('ticket')}<span class="small">Цен ещё нет — добавь волны в настройках ночи.</span></div>`;
    return;
  }
  // «продаётся сейчас» — только пока ночь в продаже
  const selling = ['onsale', 'live'].includes(phaseOf(nightById(state.night)));
  let activeFound = !selling;
  $('ov-waves').innerHTML = waves.map((w) => {
    const q = Number(w.quota);
    const n = Number(w.sold);
    const left = Math.max(0, q - n);
    const pct = q ? Math.round((n / q) * 100) : 0;
    const pub = w.public !== false;
    let tag = '';
    if (left === 0) tag = '<span class="tag">распродана</span>';
    else if (pub && !activeFound) { activeFound = true; tag = '<span class="tag tag-ok">продаётся сейчас</span>'; }
    if (!pub) tag += ' <span class="tag">только касса</span>';
    return `<div class="wv">
      <div class="wv-n">${esc(w.name)} ${tag}</div><div class="wv-p">${esc(priceLabel(w.price_rub))}</div>
      <div class="meter${left === 0 ? ' is-dim' : ''}"><i style="width:${Math.max(2, pct)}%"></i></div>
      <div class="wv-s"><span>${n} из ${q}</span><span>${left ? `осталось ${left}` : 'мест нет'}</span></div>
    </div>`;
  }).join('');
}

function renderCurve(s) {
  const curve = s.checkin_curve || [];
  if (!curve.length) {
    $('ov-curve').innerHTML = `<div class="bars-empty">Вход начнётся, когда откроются двери — здесь появится поток гостей</div>`;
    return;
  }
  const pts = curve.slice(-24);
  const max = Math.max(1, ...pts.map((c) => c.n));
  $('ov-curve').innerHTML = `<div class="bars">${pts.map((c) => {
    const h = Math.max(5, Math.round((c.n / max) * 84));
    return `<div class="bar" title="${esc(fmtTime(c.t))}: ${c.n}"><div class="bar-t"><b>${c.n}</b><i style="height:${h}%"></i></div><span>${esc(fmtTime(c.t))}</span></div>`;
  }).join('')}</div>`;
}

const SCAN = {
  ok: ['впущен', 'dot-ok'],
  ok_preview: ['проверен', 'dot-ok'],
  repeat: ['повторный скан', 'dot-warn'],
  degraded: ['офлайн-проверка', 'dot-warn'],
  bad_sig: ['подделка', 'dot-bad'],
  not_found: ['не найден', 'dot-bad'],
  revoked: ['аннулирован', 'dot-bad'],
  refunded: ['возврат', 'dot-bad'],
};
function renderFeed(s) {
  const feed = s.last_scans || [];
  if (!feed.length) {
    $('ov-feed').innerHTML = `<div class="bars-empty">Сканов пока нет. Сканер — на телефоне хостес по ключу двери.</div>`;
    return;
  }
  $('ov-feed').innerHTML = feed.slice(0, 12).map((x) => {
    const [label, dot] = SCAN[x.result] || [x.result, 'dot-warn'];
    return `<div class="feed-i"><span class="dot ${dot}"></span><span class="t">${esc(fmtTime(x.at))}</span>
      <span class="w"><b>${esc(label)}</b>${x.holder ? ` · ${esc(x.holder)}` : ''}</span>${x.by ? `<span class="by">${esc(x.by)}</span>` : ''}</div>`;
  }).join('');
}
