// Главная PROJECT X: сцена со знаком, три правила по скроллу, афиша,
// лента афиш, манифест, программа, фейсконтроль. Данные и формулы — в модулях,
// здесь только связка с DOM и движение.
import { SITE } from './data/config.js';
import { GALLERY, SHOW_PROGRAM } from './data/events.js';
import { loadEvents, upcoming, esc } from './events-load.js';
import { waveStates, fromPrice, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel } from './ticket-format.js';
import { faceControl, shareText } from './facecontrol.js';
import { springTo, projectMomentum, velocityFrom } from './spring.js';
import { initChrome, observeReveal, wrapWords } from './chrome.js';

const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

const state = { events: [], nearest: null };

init();

async function init() {
  initChrome();
  renderBands();
  renderReel();
  initManifest();
  initFaceControl();
  initHeroMotion();
  initNightScene();
  observeReveal();

  const { events } = await loadEvents();
  state.events = events;
  state.nearest = upcoming(events)[0] || null;
  renderNext();
  renderAfisha();
  renderCta();
  startCountdown();

  // раз в минуту подтягиваем остатки волн — лестница не должна врать
  setInterval(async () => {
    const fresh = await loadEvents();
    state.events = fresh.events;
    state.nearest = upcoming(fresh.events)[0] || null;
    renderAfisha();
    renderNext();
  }, 60_000);
}

// ---------- Ближайшая ночь в hero ----------
function renderNext() {
  const e = state.nearest;
  const card = $('next-event');
  if (!e) { card.hidden = true; return; }
  const db = dateBox(e.startsAt);
  const price = fromPrice(e.waves);
  $('ne-day').textContent = db.day;
  $('ne-mon').textContent = db.mon;
  $('ne-title').textContent = e.title;
  $('ne-meta').innerHTML = `<b>${esc(e.venue || 'SECRET PLACE')}</b> · ${esc(fmtWhen(e.startsAt))} · ${esc(ageLabel(e.ageRating))}`;
  $('ne-link').textContent = price ? `Взять проходку · от ${price} ₽` : 'Подробнее';
  card.href = `/e/${e.id}`;
  card.hidden = false;

  const sticky = $('sticky-buy');
  sticky.href = `/e/${e.id}`;
  sticky.textContent = price ? `Проходки от ${price} ₽` : 'Смотреть афишу';
  $('header-buy').href = `/e/${e.id}`;
}

function renderCta() {
  const e = state.nearest;
  if (!e) return;
  const price = fromPrice(e.waves);
  const db = dateBox(e.startsAt);
  $('cta-lead').innerHTML =
    `<b>${db.day} ${esc(db.mon)}</b> · ${esc(e.venue || 'SECRET PLACE')}${price ? ` · от <b>${price} ₽</b>` : ''}. ` +
    'Проходка берётся за минуту, вход — по именному QR. Адрес придёт в проходку перед стартом.';
  const btn = $('cta-buy');
  btn.href = `/e/${e.id}`;
  btn.textContent = price ? `Взять проходку · ${price} ₽` : 'Подробнее о ночи';
}

// ---------- Счётчик ----------
let cdTimer = null;
function startCountdown() {
  const e = state.nearest;
  if (!e) return;
  const target = Date.parse(e.startsAt);
  $('countdown').hidden = false;
  const tick = () => {
    let left = Math.max(0, target - Date.now());
    const d = Math.floor(left / 86400_000);
    left -= d * 86400_000;
    const h = Math.floor(left / 3600_000);
    left -= h * 3600_000;
    const m = Math.floor(left / 60_000);
    const s = Math.floor((left - m * 60_000) / 1000);
    $('cd-d').textContent = String(d);
    $('cd-d-l').textContent = plural(d, 'день', 'дня', 'дней');
    $('cd-h').textContent = String(h).padStart(2, '0');
    $('cd-m').textContent = String(m).padStart(2, '0');
    $('cd-s').textContent = String(s).padStart(2, '0');
  };
  tick();
  clearInterval(cdTimer);
  cdTimer = setInterval(tick, 1000);
}

// ---------- Живой знак в hero ----------
// Курсор наклоняет знак и уводит свет — через пружину, а не напрямую:
// прямая привязка к мыши выглядит механической, у пружины есть инерция.
// На телефоне знак и свет отвечают на прокрутку (параллакс в три слоя).
function initHeroMotion() {
  if (reduced.matches) return;
  const hero = $('hero');
  const mark = $('hero-mark');
  const light = $('hero-light');
  const bgx = $('hero-bgx');
  if (!hero || !mark) return;

  const pose = { rx: 0, ry: 0, lx: 0, ly: 0, scroll: 0 };
  const apply = () => {
    mark.style.transform = `perspective(900px) rotateX(${pose.rx.toFixed(2)}deg) rotateY(${pose.ry.toFixed(2)}deg) translate3d(0, ${(pose.scroll * 0.18).toFixed(1)}px, 0)`;
    light.style.transform = `translate3d(${pose.lx.toFixed(1)}px, ${(pose.ly + pose.scroll * 0.12).toFixed(1)}px, 0)`;
    bgx.style.transform = `translate3d(0, ${(pose.scroll * 0.06).toFixed(1)}px, 0) rotate(${(pose.scroll * 0.02).toFixed(2)}deg)`;
  };

  // пружина, которую можно дёргать сколько угодно: новая цель — та же пружина
  const tracker = (key) => {
    let sp = null;
    return (target) => {
      if (sp && !sp.done) { sp.retarget(target); return; }
      sp = springTo({ from: pose[key], to: target, damping: 1, response: 0.55, onUpdate: (v) => { pose[key] = v; apply(); } });
    };
  };
  const toRx = tracker('rx');
  const toRy = tracker('ry');
  const toLx = tracker('lx');
  const toLy = tracker('ly');

  if (finePointer.matches) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1; // -1..1
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      toRy(nx * 9);
      toRx(-ny * 7);
      toLx(nx * 48);
      toLy(ny * 30);
    });
    hero.addEventListener('pointerleave', () => { toRx(0); toRy(0); toLx(0); toLy(0); });
  }

  let raf = 0;
  const onScroll = () => {
    raf = 0;
    const y = window.scrollY;
    if (y > window.innerHeight * 1.2) return; // сцена ушла — не считаем зря
    pose.scroll = y;
    apply();
  };
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(onScroll); }, { passive: true });
}

// ---------- Три правила: сцена по скроллу ----------
// Секция высокая, сцена липкая; прогресс прокрутки внутри секции ведёт X и
// три утверждения. Считаем только пока секция на экране, двигаем только
// transform/opacity, значения ставим прямо на элементы.
function initNightScene() {
  const sec = $('night');
  if (!sec) return;
  const x = $('night-x');
  const rules = [...sec.querySelectorAll('.night-rule')];
  const ticks = [...sec.querySelectorAll('.night-nav i')];
  const idx = $('night-idx');

  if (reduced.matches || window.innerHeight < 520) {
    sec.classList.add('is-static');
    return;
  }

  // Каждое правило владеет своей третью прокрутки секции и полностью читаемо
  // в середине этой трети (плато), гаснет к её краям. Так слово гарантированно
  // доходит до полной непрозрачности, а не мелькает на переходе.
  const seg = 1 / rules.length;
  const update = () => {
    raf = 0;
    const r = sec.getBoundingClientRect();
    const total = r.height - window.innerHeight;
    if (total <= 0) return;
    const p = Math.min(1, Math.max(0, -r.top / total));

    x.style.transform = `rotate(${(p * 140).toFixed(2)}deg) scale(${(1 + p * 0.5).toFixed(3)})`;
    x.style.opacity = (0.12 + p * 0.12).toFixed(3);

    let current = 0;
    let best = Infinity;
    rules.forEach((el, i) => {
      const mid = i * seg + seg / 2;
      const d = Math.abs(p - mid) / seg;          // 0 в центре трети, 1 у центра соседа
      // Плато у центра (d<0.25 — полная непрозрачность), спад к соседу. У краёв
      // секции первое/последнее слово так остаётся видно с p=0 и до p=1.
      const vis = 1 - Math.min(1, Math.max(0, (d - 0.25) / 0.75));
      el.style.opacity = vis.toFixed(3);
      el.style.transform = `translate3d(0, ${((p - mid) / seg * -56).toFixed(1)}px, 0)`;
      if (Math.abs(p - mid) < best) { best = Math.abs(p - mid); current = i; }
    });
    ticks.forEach((t, i) => {
      const f = Math.min(1, Math.max(0, (p - i * seg) / seg));
      t.style.setProperty('--f', f.toFixed(3));
    });
    idx.textContent = `0${current + 1} / 0${rules.length}`;
  };

  let raf = 0;
  // Считаем на каждом кадре прокрутки: замер дешёвый, а гейт по видимости
  // однажды оставлял три правила на нулевой прозрачности, если наблюдатель
  // ещё не отработал. update() сам ничего не делает, когда секция за экраном.
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}

// ---------- Афиша ----------
function renderAfisha() {
  const grid = $('afisha-grid');
  const list = upcoming(state.events);
  if (!list.length) {
    grid.innerHTML = `<p class="muted">Ближайшая ночь ещё не анонсирована — следи за <a class="acid" href="${esc(SITE.instagram)}" target="_blank" rel="noopener">Instagram*</a>.</p>`;
    return;
  }
  grid.innerHTML = list.map(nightCard).join('');
}

function nightCard(e) {
  const db = dateBox(e.startsAt);
  const ws = waveStates(e.waves);
  const active = ws.find((w) => w.state === 'active');
  const price = fromPrice(e.waves);
  const going = goingCount(e.id, Date.parse(e.startsAt), totalSold(e.waves), Date.now());
  const poster = e.posterUrl
    ? `<img src="${esc(e.posterUrl)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  const priceHtml = price === null
    ? '<span class="badge badge-soldout">sold out</span>'
    : `<span class="nc-price"><small>от</small>${price} ₽</span>`;
  const leftHtml = active
    ? `<span class="nc-left">${esc(active.name.toLowerCase())} · осталось <b>${active.left}</b> ${plural(active.left, 'проходка', 'проходки', 'проходок')}</span>`
    : '';
  return `
    <a class="night-card" href="/e/${esc(e.id)}">
      <div class="nc-poster">
        ${poster}
        <div class="nc-date"><b>${db.day}</b><small>${esc(db.mon)}</small></div>
        <div class="nc-badges"><span class="badge badge-age">${esc(ageLabel(e.ageRating))}</span><span class="badge badge-dry">FC/DC</span></div>
      </div>
      <div class="nc-body">
        <div class="nc-title">${esc(e.title)}</div>
        <div class="nc-meta">
          <span><b>${esc(e.venue || 'SECRET PLACE')}</b>${e.address ? ` · ${esc(e.address)}` : ' · адрес придёт в проходку'}</span>
          <span>${esc(fmtWhen(e.startsAt))} · двери ${esc(SITE.doorsOpen)}</span>
          <span>уже идут <b>${going}</b></span>
        </div>
        <div class="nc-foot">
          <div>${priceHtml}<br />${leftHtml}</div>
          <span class="btn btn-acid nc-cta">${price === null ? 'Подробнее' : 'Взять проходку'}</span>
        </div>
      </div>
    </a>`;
}

// ---------- Лента афиш: постеры как объекты ----------
// Прокрутка родная (инерция платформы лучше нашей), наклон карточки —
// от расстояния до центра ленты. На мыши добавляем перетаскивание с
// доводкой по инерции: без него лента на десктопе мёртвая.
function renderReel() {
  const reel = $('reel');
  if (!reel) return;
  reel.innerHTML = GALLERY.map(
    (g) => `
      <figure class="reel-item">
        <img src="${esc(g.src)}" alt="${esc(g.title)}" loading="lazy" draggable="false" onerror="this.closest('figure').classList.add('no-img')" />
        <figcaption><span class="rt">${esc(g.title)}</span><span class="rn">${esc(g.note)}</span></figcaption>
      </figure>`
  ).join('');
  const items = [...reel.children];

  if (!reduced.matches) {
    let raf = 0;
    const tilt = () => {
      raf = 0;
      const rr = reel.getBoundingClientRect();
      const cx = rr.left + rr.width / 2;
      items.forEach((el) => {
        const b = el.getBoundingClientRect();
        const d = Math.max(-1, Math.min(1, ((b.left + b.width / 2 - cx) / rr.width) * 2));
        el.style.transform = `rotateY(${(-d * 16).toFixed(2)}deg) translate3d(0, 0, ${(-Math.abs(d) * 90).toFixed(1)}px)`;
        el.style.setProperty('--sheen', (0.3 + Math.abs(d) * 0.6).toFixed(2));
      });
    };
    reel.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(tilt); }, { passive: true });
    window.addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(tilt); });
    tilt();
    // ближайшая ночь по центру — с неё и начинается история
    requestAnimationFrame(() => {
      const first = items[0];
      if (first) reel.scrollLeft = Math.max(0, first.offsetLeft - (reel.clientWidth - first.offsetWidth) / 2);
      tilt();
    });
  }

  if (finePointer.matches) initReelDrag(reel, items);
}

function initReelDrag(reel, items) {
  let dragging = false;
  let startX = 0;
  let startLeft = 0;
  let history = [];
  let fling = null;

  const stopFling = () => { if (fling && !fling.done) fling.stop(); fling = null; };

  reel.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    stopFling();
    dragging = true;
    startX = e.clientX;
    startLeft = reel.scrollLeft;
    history = [{ t: e.timeStamp, y: e.clientX }];
    reel.classList.add('is-dragging');
    reel.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  reel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    reel.scrollLeft = startLeft - (e.clientX - startX);
    history.push({ t: e.timeStamp, y: e.clientX });
    if (history.length > 12) history.shift();
  });
  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    // скорость пальца → куда уедет лента → ближайшая карточка к этой точке
    const v = -velocityFrom(history);
    const projected = reel.scrollLeft + projectMomentum(v, 0.995);
    const target = nearestSnap(reel, items, projected);
    fling = springTo({
      from: reel.scrollLeft,
      to: target,
      velocity: v,
      damping: 1,
      response: 0.6,
      onUpdate: (val) => { reel.scrollLeft = val; },
      onRest: () => { reel.classList.remove('is-dragging'); fling = null; },
    });
  };
  reel.addEventListener('pointerup', release);
  reel.addEventListener('pointercancel', release);
  // клик по карточке после перетаскивания — не клик
  reel.addEventListener('click', (e) => { if (history.length > 3 && Math.abs(history.at(-1).y - history[0].y) > 8) { e.preventDefault(); history = []; } }, true);
}

function nearestSnap(reel, items, left) {
  const center = left + reel.clientWidth / 2;
  let best = left;
  let bestD = Infinity;
  items.forEach((el) => {
    const c = el.offsetLeft + el.offsetWidth / 2;
    const d = Math.abs(c - center);
    if (d < bestD) { bestD = d; best = c - reel.clientWidth / 2; }
  });
  const max = reel.scrollWidth - reel.clientWidth;
  return Math.max(0, Math.min(max, best));
}

// ---------- Манифест: слова входят по одному ----------
function initManifest() {
  const ps = [...document.querySelectorAll('#manifest p:not(.m-note)')];
  ps.forEach((p) => {
    wrapWords(p);
    p.querySelectorAll('.w').forEach((w, i) => { w.style.transitionDelay = `${Math.min(i * 34, 900)}ms`; });
  });
  if (!('IntersectionObserver' in window)) { ps.forEach((p) => p.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
  }, { threshold: 0.35 });
  ps.forEach((p) => io.observe(p));
}

// ---------- Программа: две ленты навстречу ----------
function renderBands() {
  const titles = SHOW_PROGRAM.map((p) => p.title);
  const residents = [
    'DJ SHENDI', 'DJ JOKER', 'DJ DYSSHA', 'DJ DIZAYNER', 'ASIO', 'REBEL X KLOPOTA', 'ARTURQUE',
    'SANTI X ENDI', 'VANULA', 'NEXTIME WEBPUNK', 'MOTI MAR TEAM', 'BOBRBOY', 'GARAGUL', 'DRUCY LIBERUM', 'KEENDY',
  ];
  const row = (arr) => {
    const half = arr.map((t) => `<span>${esc(t)}</span><span class="x">✕</span>`).join('');
    return half + half; // две копии — бесшовный цикл на -50%
  };
  $('band-1').innerHTML = row(titles);
  $('band-2').innerHTML = row(residents);
}

// ---------- Фейсконтроль ----------
function initFaceControl() {
  const input = $('face-age');
  if (!input) return;
  const run = () => {
    const r = faceControl(input.value);
    if (r.verdict === 'invalid') {
      input.focus();
      input.classList.add('is-invalid');
      $('face-err')?.classList.add('is-on');
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
      return;
    }
    input.classList.remove('is-invalid');
    $('face-err')?.classList.remove('is-on');
    const bubble = $('face-bubble');
    bubble.className = `face-bubble fb-${r.verdict}`;
    $('fb-title').textContent = r.title;
    $('fb-sub').textContent = r.sub;
    const res = $('face-result');
    // штамп ставится заново на каждый ответ: снять и вернуть класс
    res.classList.add('hidden');
    void res.offsetWidth;
    res.classList.remove('hidden');
    const copy = $('face-copy');
    copy.textContent = 'Скопировать и похвастаться';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareText(r, location.origin));
        copy.textContent = 'Скопировано';
      } catch {
        copy.textContent = 'Не вышло — заскринь';
      }
    };
  };
  $('face-check').onclick = run;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('face-again').onclick = () => {
    $('face-result').classList.add('hidden');
    input.value = '';
    input.focus();
  };
}
