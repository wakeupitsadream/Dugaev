// Блоки витрины, общие для главной и страниц второго уровня: карточка ночи,
// лента афиш, сцена «три правила», ленты программы, фейсконтроль.
// Каждая функция берёт свои элементы по id и молчит, если их нет на странице.
import { SITE } from './data/config.js';
import { GALLERY, SHOW_PROGRAM } from './data/events.js';
import { esc } from './events-load.js';
import { waveStates, fromPrice, totalSold } from './waves.js';
import { goingCount } from './social.js';
import { plural, dateBox, fmtWhen, ageLabel } from './ticket-format.js';
import { faceControl, shareText } from './facecontrol.js';
import { addressIsPublic } from './secret-place.js';
import { springTo, projectMomentum, velocityFrom } from './spring.js';

const $ = (id) => document.getElementById(id);
export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
export const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

export const RESIDENTS = [
  'DJ SHENDI', 'DJ JOKER', 'DJ DYSSHA', 'DJ DIZAYNER', 'ASIO', 'REBEL X KLOPOTA', 'ARTURQUE',
  'SANTI X ENDI', 'VANULA', 'NEXTIME WEBPUNK', 'MOTI MAR TEAM', 'BOBRBOY', 'GARAGUL', 'DRUCY LIBERUM', 'KEENDY',
];

// ---------- Карточка ближайшей ночи ----------
export function nightCard(e) {
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
          <span><b>${esc(e.venue || 'SECRET PLACE')}</b>${e.address ? ` · ${esc(e.address)}` : ''}</span>
          ${e.address ? '' : `<span class="nc-secret">Адрес — в проходке сразу после покупки${addressIsPublic(e) ? '' : ', остальным за сутки до ночи'}</span>`}
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

export function renderAfisha(gridId, list) {
  const grid = $(gridId);
  if (!grid) return;
  if (!list.length) {
    // Между ночами сайт не должен превращаться в тупик: держим интригу
    // тизером и превращаем интерес в контакт, а не в уход в Instagram.
    renderNextTeaser(grid);
    return;
  }
  const html = list.map(nightCard).join('');
  if (grid.dataset.html === html) return; // ежеминутное обновление не должно моргать карточкой под курсором
  grid.dataset.html = html;
  grid.innerHTML = html;
}

// ---------- Пустое состояние: следующая ночь готовится ----------
// Показывается там, где обычно карточки афиши. Форма шлёт заявку в тот же
// /api/cityrequest (kind: notify) — новых serverless-функций не заводим.
export function renderNextTeaser(host) {
  const t = SITE.nextTeaser || {};
  host.innerHTML = `
    <div class="teaser">
      <div class="teaser-when">
        <span class="kicker">Следующая ночь</span>
        <b>${esc(t.when || 'Готовится')}</b>
        <p>${esc(t.note || 'Дата и площадка объявляются позже. Ранняя волна всегда дешевле.')}</p>
      </div>
      <form class="teaser-form" id="notify-form" novalidate>
        <label class="tf-label" for="nf-contact">Напишем тебе первым</label>
        <div class="field">
          <input type="text" id="nf-contact" placeholder="@ник в Telegram или телефон" autocomplete="off" aria-label="Ник или телефон" />
          <div class="err" role="alert" id="err-nf-contact">Оставь ник или телефон</div>
        </div>
        <div style="position: absolute; left: -9999px;" aria-hidden="true">
          <input type="text" id="nf-website" tabindex="-1" autocomplete="off" />
        </div>
        <label class="check">
          <input type="checkbox" id="nf-consent" />
          <span>Согласен на обработку данных — <a href="/privacy.html" target="_blank" rel="noopener">политика</a></span>
        </label>
        <div class="err" role="alert" id="err-nf-consent" style="margin: -8px 0 10px;">Без согласия не сможем принять заявку</div>
        <button class="btn btn-acid btn-block" id="nf-send" type="submit">Позовите меня</button>
        <p class="form-note" id="nf-note">Одно сообщение, когда откроется продажа. Без спама.</p>
      </form>
    </div>`;
  bindNotifyForm();
}

function bindNotifyForm() {
  const form = $('notify-form');
  if (!form) return;
  const bad = (id, is) => { $(`err-${id}`)?.classList.toggle('is-on', is); return is; };
  $('nf-contact').oninput = () => bad('nf-contact', false);
  $('nf-consent').onchange = (e) => { if (e.target.checked) bad('nf-consent', false); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const contact = $('nf-contact').value.trim();
    const consent = $('nf-consent').checked;
    let stop = false;
    if (bad('nf-contact', contact.length < 2)) stop = true;
    if (bad('nf-consent', !consent)) stop = true;
    if (stop) return;
    const btn = $('nf-send');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    let sent = false;
    try {
      const r = await fetch('/api/cityrequest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'notify', contact, consent, website: $('nf-website').value }),
      });
      sent = r.ok;
    } catch { /* деградация ниже */ }
    btn.disabled = false;
    if (sent) {
      form.innerHTML = '<div class="teaser-done"><b>Записали.</b> Напишем, как только откроется продажа — ты узнаешь раньше афиши.</div>';
      return;
    }
    // связь подвела — не врём про «принято», даём прямой канал
    btn.textContent = 'Позовите меня';
    const note = $('nf-note');
    note.textContent = 'Связь подвела. Напиши в директ — добавим в список: ';
    const a = document.createElement('a');
    a.href = SITE.instagramDm;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'открыть директ';
    note.append(a);
  };
}

// ---------- Лента афиш: постеры как объекты ----------
// Прокрутка родная (инерция платформы лучше нашей), наклон карточки —
// от расстояния до центра ленты. На мыши добавляем перетаскивание с
// доводкой по инерции: без него лента на десктопе мёртвая.
export function renderReel(reelId, items = GALLERY) {
  const reel = $(reelId);
  if (!reel) return;
  reel.innerHTML = items.map(
    (g) => `
      <figure class="reel-item">
        <img src="${esc(g.src)}" alt="${esc(g.title)}" loading="lazy" draggable="false" onerror="this.closest('figure').classList.add('no-img')" />
        <figcaption><span class="rt">${esc(g.title)}</span><span class="rn">${esc(g.note)}</span></figcaption>
      </figure>`
  ).join('');
  const cards = [...reel.children];

  if (!reduced.matches) {
    let raf = 0;
    // Центры карточек считаем от статичной раскладки один раз (и на resize):
    // читать rect у уже наклонённой карточки — значит считать наклон от
    // собственного результата и дёргать layout на каждой записи.
    let centers = [];
    let cw = 0;
    const measure = () => {
      cw = reel.clientWidth;
      centers = cards.map((el) => el.offsetLeft + el.offsetWidth / 2);
    };
    const tilt = () => {
      raf = 0;
      const mid = reel.scrollLeft + cw / 2;
      const ds = centers.map((c) => Math.max(-1, Math.min(1, ((c - mid) / cw) * 2)));
      cards.forEach((el, i) => {
        const d = ds[i];
        el.style.transform = `rotateY(${(-d * 16).toFixed(2)}deg) translate3d(0, 0, ${(-Math.abs(d) * 90).toFixed(1)}px)`;
        el.style.setProperty('--sheen', (0.3 + Math.abs(d) * 0.6).toFixed(2));
      });
    };
    measure();
    reel.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(tilt); }, { passive: true });
    window.addEventListener('resize', () => { measure(); if (!raf) raf = requestAnimationFrame(tilt); });
    tilt();
    requestAnimationFrame(() => {
      const first = cards[0];
      if (first) reel.scrollLeft = Math.max(0, first.offsetLeft - (reel.clientWidth - first.offsetWidth) / 2);
      tilt();
    });
  }
  if (finePointer.matches) initReelDrag(reel, cards);
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
  const release = () => {
    if (!dragging) return;
    dragging = false;
    const v = -velocityFrom(history);
    const projected = reel.scrollLeft + projectMomentum(v, 0.995);
    const target = nearestSnap(reel, items, projected);
    fling = springTo({
      from: reel.scrollLeft, to: target, velocity: v, damping: 1, response: 0.6,
      onUpdate: (val) => { reel.scrollLeft = val; },
      onRest: () => { reel.classList.remove('is-dragging'); fling = null; },
    });
  };
  reel.addEventListener('pointerup', release);
  reel.addEventListener('pointercancel', release);
  reel.addEventListener('click', (e) => {
    if (history.length > 3 && Math.abs(history.at(-1).y - history[0].y) > 8) { e.preventDefault(); history = []; }
  }, true);
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

// ---------- Три правила: сцена по скроллу ----------
// Секция высокая, сцена липкая; прогресс прокрутки внутри секции ведёт X и
// три утверждения. Считаем на каждом кадре прокрутки (замер дешёвый), двигаем
// только transform/opacity, значения ставим прямо на элементы.
export function initNightScene(sectionId = 'night') {
  const sec = $(sectionId);
  if (!sec) return;
  const x = sec.querySelector('.night-x');
  const rules = [...sec.querySelectorAll('.night-rule')];
  const ticks = [...sec.querySelectorAll('.night-nav i')];
  const idx = sec.querySelector('.night-idx');

  if (reduced.matches || window.innerHeight < 520) {
    sec.classList.add('is-static');
    return;
  }

  const seg = 1 / rules.length;
  let raf = 0;
  let lastP = -1;
  const update = () => {
    raf = 0;
    const r = sec.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return; // секция за экраном — нечего считать
    const total = r.height - window.innerHeight;
    if (total <= 0) return;
    const p = Math.min(1, Math.max(0, -r.top / total));
    if (p === lastP) return;
    lastP = p;

    x.style.transform = `rotate(${(p * 140).toFixed(2)}deg) scale(${(1 + p * 0.5).toFixed(3)})`;
    x.style.opacity = (0.12 + p * 0.12).toFixed(3);

    let current = 0;
    let best = Infinity;
    rules.forEach((el, i) => {
      const mid = i * seg + seg / 2;
      const d = Math.abs(p - mid) / seg;
      const vis = 1 - Math.min(1, Math.max(0, (d - 0.25) / 0.75));
      el.style.opacity = vis.toFixed(3);
      el.style.transform = `translate3d(0, ${((p - mid) / seg * -56).toFixed(1)}px, 0)`;
      if (Math.abs(p - mid) < best) { best = Math.abs(p - mid); current = i; }
    });
    ticks.forEach((t, i) => {
      const f = Math.min(1, Math.max(0, (p - i * seg) / seg));
      t.style.setProperty('--f', f.toFixed(3));
    });
    if (idx) idx.textContent = `0${current + 1} / 0${rules.length}`;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}

// ---------- Программа: две ленты навстречу ----------
export function renderBands(id1 = 'band-1', id2 = 'band-2') {
  const row = (arr) => {
    const half = arr.map((t) => `<span>${esc(t)}</span><span class="x">✕</span>`).join('');
    return half + half; // две копии — бесшовный цикл на -50%
  };
  if ($(id1)) $(id1).innerHTML = row(SHOW_PROGRAM.map((p) => p.title));
  if ($(id2)) $(id2).innerHTML = row(RESIDENTS);
}

// ---------- Фейсконтроль ----------
export function initFaceControl() {
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
    res.classList.add('hidden');
    void res.offsetWidth; // штамп ставится заново на каждый ответ
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

// ---------- Ссылки «взять проходку» ведут на ближайшую ночь ----------
export function pointBuyLinks(nearest) {
  const price = nearest ? fromPrice(nearest.waves) : null;
  const href = nearest ? `/e/${nearest.id}` : '/afisha';
  for (const id of ['header-buy', 'menu-buy', 'sticky-buy', 'cta-buy']) {
    const el = $(id);
    if (!el) continue;
    el.href = href;
    if (id === 'sticky-buy' || id === 'menu-buy') {
      el.textContent = price ? `Проходки от ${price} ₽` : 'Позовите меня на следующую';
    }
  }
}
