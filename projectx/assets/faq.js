// FAQ: аккордеон на <details> с анимацией раскрытия.
// Высота — единственное место, где её оправдано анимировать: у раскрытия
// нет transform-эквивалента. Коротко (200 мс), ease-out, прерываемо через WAAPI.
import { initChrome, observeReveal } from './chrome.js';

initChrome();
observeReveal();

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

document.querySelectorAll('.faq details').forEach((d) => {
  const summary = d.querySelector('summary');
  const body = d.querySelector('.faq-a');
  let anim = null;

  summary.addEventListener('click', (e) => {
    e.preventDefault();
    if (reduced.matches) { d.open = !d.open; return; }
    anim?.cancel();
    if (d.open) {
      // закрытие: сначала анимация, потом убираем open — иначе содержимое исчезнет мгновенно
      const h = body.offsetHeight;
      anim = body.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 200, easing: EASE });
      anim.onfinish = () => { d.open = false; anim = null; };
    } else {
      d.open = true;
      const h = body.offsetHeight;
      anim = body.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 220, easing: EASE });
      anim.onfinish = () => { anim = null; };
    }
  });
});
