// Общая обвязка витрины: шапка, меню на телефоне, появление блоков по скроллу.
// Одна и та же для главной и страниц второго уровня.
const $ = (id) => document.getElementById(id);

let closeMenuFn = () => {};
export function closeMenu() { closeMenuFn(); }

export function initChrome() {
  initHeader();
  initMenu();
  markCurrentNav();
  initStickyCta();
  addMyTickets();
}

// Липкая кнопка появляется снизу, когда карточка ближайшей ночи ушла с экрана
// (на главной), а на остальных страницах — сразу. Приходит и уходит одним путём.
function initStickyCta() {
  const bar = $('sticky-cta');
  if (!bar) return;
  const card = $('next-event');
  if (!card || !('IntersectionObserver' in window)) { bar.classList.add('is-on'); return; }
  new IntersectionObserver((entries) => {
    const visible = entries.some((en) => en.isIntersecting) && !card.hidden;
    bar.classList.toggle('is-on', !visible);
  }, { threshold: 0.15 }).observe(card);
}

// Купленные проходки лежат в localStorage этого браузера — даём к ним вход
// из меню, чтобы перед ночью не искать ссылку в чатах.
function addMyTickets() {
  const nav = document.querySelector('#menu nav');
  if (!nav) return;
  let key = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('px_tickets_')) { key = k; break; }
    }
  } catch { return; }
  if (!key) return;
  const a = document.createElement('a');
  a.href = `/e/${key.slice('px_tickets_'.length)}#saved-tickets`;
  a.className = 'is-mine';
  a.innerHTML = 'Мои проходки <small>ссылки на твои именные QR</small>';
  nav.appendChild(a);
}

// Шапка прозрачна над сценой и становится стеклом, когда под ней контент
function initHeader() {
  const header = $('site-header');
  if (!header) return;
  let raf = 0;
  const update = () => {
    raf = 0;
    header.classList.toggle('is-solid', window.scrollY > 24);
  };
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
  update();
}

// Полноэкранное меню: открывается изредка — стандартная анимация, ссылки
// входят лесенкой. Пока открыто, страница под ним выключена (inert),
// фокус живёт внутри и возвращается на кнопку после закрытия.
function initMenu() {
  const btn = $('burger');
  const menu = $('menu');
  if (!btn || !menu) return;
  const layers = () => ['main', '.site-footer', '#sticky-cta', '#site-header .top-nav'].map((s) => document.querySelector(s)).filter(Boolean);

  const open = () => {
    menu.inert = false;
    menu.classList.add('is-open');
    document.body.classList.add('menu-open');
    btn.setAttribute('aria-expanded', 'true');
    layers().forEach((el) => { el.inert = true; });
    menu.focus({ preventScroll: true });
  };
  const close = () => {
    menu.classList.remove('is-open');
    document.body.classList.remove('menu-open');
    btn.setAttribute('aria-expanded', 'false');
    layers().forEach((el) => { el.inert = false; });
    menu.inert = true;
    btn.focus({ preventScroll: true });
  };
  closeMenuFn = () => { if (menu.classList.contains('is-open')) close(); };
  btn.onclick = () => (menu.classList.contains('is-open') ? close() : open());
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
    // якорь на этой же странице: сначала закрыть, потом ехать
    if (a.getAttribute('href')?.startsWith('#')) close();
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('is-open')) close();
  });
}

// Подсветить в шапке страницу, на которой стоим
function markCurrentNav() {
  const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  document.querySelectorAll('.top-nav a, .menu nav a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    if (href.replace(/\.html$/, '') === here) a.classList.add('is-here');
  });
}

// Появление по скроллу. Один раз: страница не должна воевать с читателем
// повторными въездами. Без IntersectionObserver — просто показываем.
export function observeReveal(root = document) {
  const els = [...root.querySelectorAll('.reveal, .reveal-stagger')];
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('is-in');
      io.unobserve(en.target);
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  els.forEach((el) => io.observe(el));
}

// Слова в отдельные span'ы — для входа «по одному». Вложенные акценты
// (<span class="x">) сохраняются: делим только текстовые узлы.
export function wrapWords(el) {
  const walk = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          const s = document.createElement('span');
          s.className = 'w';
          s.textContent = part;
          frag.appendChild(s);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        walk(n);
      }
    });
  };
  walk(el);
}
