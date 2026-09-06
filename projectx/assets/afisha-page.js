// Страница «Афиша»: ближайшие ночи + стена постеров прошедших.
import { GALLERY } from './data/events.js';
import { loadEvents, upcoming, pastEvents, esc } from './events-load.js';
import { dateBox, fmtWhen } from './ticket-format.js';
import { initChrome, observeReveal } from './chrome.js';
import { renderAfisha, pointBuyLinks, finePointer, reduced } from './blocks.js';

const $ = (id) => document.getElementById(id);

init();

async function init() {
  initChrome();
  const { events } = await loadEvents();
  const next = upcoming(events);
  renderAfisha('afisha-grid', next);
  pointBuyLinks(next[0] || null);
  $('afisha-count').textContent = next.length
    ? `${next.length === 1 ? 'одна ночь' : `${next.length} ночи`} в продаже`
    : 'анонс скоро';
  renderWall(events);
  observeReveal();
}

// Стена постеров: прошедшие ночи из базы (со ссылкой на страницу ночи) плюс
// афиши из архива, которых в базе нет. Каждый постер — карточка-объект:
// на мыши наклоняется к курсору, на телефоне просто ложится в сетку.
function renderWall(events) {
  const wall = $('poster-wall');
  const past = pastEvents(events);
  const byPoster = new Map(past.map((e) => [e.posterUrl, e]));
  const items = GALLERY.map((g) => {
    const ev = byPoster.get(g.src);
    const db = ev ? dateBox(ev.startsAt) : null;
    return { src: g.src, title: g.title, note: ev ? `${fmtWhen(ev.startsAt)} · ${ev.venue}` : g.note, href: ev ? `/e/${ev.id}` : null, day: db?.day, mon: db?.mon };
  });
  wall.innerHTML = items.map((it) => {
    const tag = it.href ? 'a' : 'div';
    const href = it.href ? ` href="${esc(it.href)}"` : '';
    return `
      <${tag} class="poster"${href}>
        <img src="${esc(it.src)}" alt="${esc(it.title)}" loading="lazy" draggable="false" onerror="this.closest('.poster').classList.add('no-img')" />
        ${it.day ? `<span class="p-date"><b>${it.day}</b><small>${esc(it.mon)}</small></span>` : ''}
        <span class="p-cap"><b>${esc(it.title)}</b><small>${esc(it.note)}</small></span>
      </${tag}>`;
  }).join('');

  if (!finePointer.matches || reduced.matches) return;
  // наклон к курсору: hover — десятки раз в день, поэтому движение едва заметное
  wall.querySelectorAll('.poster').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      // hover — десятки раз в день: наклон едва заметный; нажатие — через --s
      el.style.transform = `perspective(700px) rotateX(${(-ny * 3).toFixed(2)}deg) rotateY(${(nx * 4).toFixed(2)}deg) translateY(-2px) scale(var(--s, 1))`;
      el.style.setProperty('--gx', `${((nx + 1) * 50).toFixed(1)}%`);
      el.style.setProperty('--gy', `${((ny + 1) * 50).toFixed(1)}%`);
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
      el.style.removeProperty('--gx');
      el.style.removeProperty('--gy');
    });
  });
}
