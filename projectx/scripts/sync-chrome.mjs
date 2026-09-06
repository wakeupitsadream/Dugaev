#!/usr/bin/env node
// Единая шапка, меню и футер для страниц витрины. Разметка лежит здесь один
// раз, а в HTML вклеивается между маркерами <!-- chrome:header --> …
// <!-- /chrome:header --> и <!-- chrome:footer --> … <!-- /chrome:footer -->.
// Запуск: node scripts/sync-chrome.mjs (после правки шапки/меню/футера).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'afisha.html', 'night.html', 'fc.html', 'rules.html', 'faq.html', 'contacts.html'];

const NAV = [
  ['/afisha', 'Афиша', 'ближайшие ночи и проходки'],
  ['/night', 'Ночь', 'три правила и как всё устроено'],
  ['/fc', 'FC/DC', 'дресс-код и что взять с собой'],
  ['/rules', 'Правила', 'чтобы не развернули на дверях'],
  ['/faq', 'FAQ', 'вопросы, которые задают все'],
  ['/contacts', 'Контакты', 'Instagram*, директ, свой город'],
];

const HEADER = `<!-- chrome:header -->
  <header class="site-header" id="site-header">
    <div class="container">
      <a class="logo" href="/" aria-label="PROJECT X — на главную">PRO<span class="lx">X</span>JECT</a>
      <nav class="top-nav" aria-label="Основная навигация">
${NAV.map(([href, label]) => `        <a href="${href}">${label}</a>`).join('\n')}
      </nav>
      <a class="btn btn-acid header-cta" id="header-buy" href="/afisha">Проходки</a>
      <button class="burger" id="burger" type="button" aria-expanded="false" aria-controls="menu" aria-label="Меню"><span></span><span></span></button>
    </div>
  </header>

  <!-- Полноэкранное меню (телефон). Шапка остаётся над ним: бургер складывается в крестик -->
  <div class="menu" id="menu" role="dialog" aria-modal="true" aria-label="Меню" tabindex="-1" inert>
    <nav>
${NAV.map(([href, label, note]) => `      <a href="${href}">${label} <small>${note}</small></a>`).join('\n')}
    </nav>
    <div class="menu-foot">
      <a class="btn btn-acid btn-block" id="menu-buy" href="/afisha">Проходки</a>
      <a href="https://www.instagram.com/project.x.prty" target="_blank" rel="noopener">@project.x.prty — Instagram*</a>
      <span>Оренбург · 18+ · FC/DC · двери 22:00 · старт 23:00</span>
    </div>
  </div>
  <!-- /chrome:header -->`;

const FOOTER = `<!-- chrome:footer -->
  <footer class="site-footer">
    <div class="container f-grid">
      <div>
        <a class="logo" href="/">PRO<span class="lx">X</span>JECT</a>
        <p class="f-note" style="margin-top: 10px;">
          Мероприятия 18+. Вход строго по документу, на дверях FC/DC — фейсконтроль и дресс-код.
          Двери 22:00, старт 23:00, расходимся под утро.
        </p>
        <p class="f-note"><!-- ЗАГЛУШКА: реквизиты организатора -->ИП (реквизиты уточняются) · © 2026 PROJECT X · Оренбург</p>
      </div>
      <nav class="f-links" aria-label="Разделы">
${NAV.map(([href, label]) => `        <a href="${href}">${label}</a>`).join('\n')}
        <a href="/privacy.html">Политика</a>
        <a href="https://www.instagram.com/project.x.prty" target="_blank" rel="noopener">Instagram*</a>
      </nav>
      <div class="dev-sign">Дизайн и разработка — <a href="https://maxim-batutin.ru" target="_blank" rel="noopener">maxim-batutin.ru</a></div>
    </div>
    <div class="container"><p class="f-note" style="margin-top: 18px;">* Instagram принадлежит Meta, признанной экстремистской организацией и запрещённой в РФ.</p></div>
  </footer>
  <!-- /chrome:footer -->`;

const swap = (html, tag, block) => {
  const re = new RegExp(`<!-- chrome:${tag} -->[\\s\\S]*?<!-- /chrome:${tag} -->`);
  if (!re.test(html)) throw new Error(`нет маркеров chrome:${tag}`);
  return html.replace(re, block);
};

let changed = 0;
for (const name of PAGES) {
  const file = join(ROOT, name);
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { console.warn(`пропуск: ${name} нет`); continue; }
  const next = swap(swap(html, 'header', HEADER), 'footer', FOOTER);
  if (next !== html) { writeFileSync(file, next); changed++; console.log(`обновлено: ${name}`); }
}
console.log(`готово, изменено файлов: ${changed}`);
