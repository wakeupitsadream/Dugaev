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
  let opening = false; // намерение храним явно, а не выводим из DOM

  summary.addEventListener('click', (e) => {
    e.preventDefault();
    if (reduced.matches) {
      d.open = !d.open;
      if (d.open) body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
      return;
    }
    // Перехват: стартуем с показанной высоты, а не с натуральной
    const cur = anim ? body.getBoundingClientRect().height : (d.open ? body.offsetHeight : 0);
    anim?.cancel();
    if (d.open && !opening || (anim && opening)) {
      // закрываем: сначала анимация, потом снимаем open, иначе содержимое исчезнет мгновенно
      opening = false;
      anim = body.animate([{ height: `${cur}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 200, easing: EASE });
      anim.onfinish = () => { d.open = false; anim = null; };
    } else {
      opening = true;
      d.open = true;
      const target = body.offsetHeight;
      anim = body.animate([{ height: `${cur}px`, opacity: cur ? 1 : 0 }, { height: `${target}px`, opacity: 1 }], { duration: 220, easing: EASE });
      anim.onfinish = () => { anim = null; opening = false; };
    }
  });
});
