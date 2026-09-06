// «Привезите к нам»: заявка из другого города. Живёт на странице контактов.
import { SITE } from './data/config.js';
import { esc } from './events-load.js';
import { detectContactMode, stripRuPhone, formatRuPhoneDigits } from './ticket-format.js';

const $ = (id) => document.getElementById(id);

export function initCityForm() {
  const form = $('city-form');
  if (!form) return;
  const done = new Set(SITE.homeCities);
  $('city-request-chips').innerHTML = [
    ...SITE.homeCities.map((c) => `<span class="chip is-on">${esc(c)} ✓</span>`),
    ...SITE.expansionCities.map((c) => `<button type="button" class="chip" data-city="${esc(c)}">${esc(c)}</button>`),
    '<span class="chip chip-ghost">Твой город?</span>',
  ].join('');
  document.querySelectorAll('#city-request-chips .chip[data-city]').forEach((chip) => {
    chip.onclick = () => {
      $('cf-city').value = chip.dataset.city;
      $('cf-contact').focus();
    };
  });

  $('cf-consent').onchange = (e) => {
    if (e.target.checked) e.target.closest('.check')?.classList.remove('is-error');
  };

  // «@ник или телефон»: начал с цифры/+ — поле превращается в телефонное
  // с фиксированным «+7» и маской; @ник остаётся свободным текстом
  const contactState = { mode: 'free', digits: '' };
  const contactInput = $('cf-contact');
  contactInput.oninput = (e) => {
    const raw = e.target.value;
    if (contactState.mode === 'free' && detectContactMode(raw) === 'phone') contactState.mode = 'phone';
    if (contactState.mode === 'phone') {
      if (!raw.trim()) {
        contactState.mode = 'free';
        contactState.digits = '';
        $('cf-prefix').classList.add('hidden');
        e.target.removeAttribute('inputmode');
        e.target.value = '';
      } else {
        contactState.digits = stripRuPhone(raw);
        $('cf-prefix').classList.remove('hidden');
        e.target.setAttribute('inputmode', 'numeric');
        e.target.value = formatRuPhoneDigits(contactState.digits);
      }
    }
    toggleErr('cf-contact', false);
  };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const city = $('cf-city').value.trim();
    const contact = contactState.mode === 'phone'
      ? (contactState.digits.length === 10 ? '+7' + contactState.digits : '')
      : contactInput.value.trim();
    const consent = $('cf-consent').checked;
    let bad = false;
    toggleErr('cf-city', city.length < 2) && (bad = true);
    $('err-cf-contact').textContent = contactState.mode === 'phone'
      ? 'Укажи номер телефона'
      : 'Оставь ник или телефон — позовём первым';
    toggleErr('cf-contact', contact.length < 2) && (bad = true);
    toggleErr('cf-consent', !consent) && (bad = true);
    $('cf-consent').closest('.check')?.classList.toggle('is-error', !consent);
    if (bad || done.has(city)) {
      if (done.has(city)) $('cf-note').textContent = `${city} — мы уже здесь! Смотри афишу на главной.`;
      return;
    }
    const btn = $('cf-send');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    let ok = false;
    try {
      const r = await fetch('/api/cityrequest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, contact, consent, website: $('cf-website').value }),
      });
      ok = r.ok;
    } catch { /* деградация ниже */ }
    btn.disabled = false;
    if (ok) {
      btn.textContent = 'Заявка принята';
      $('cf-note').textContent = `${city} в списке. Как наберётся достаточно заявок — напишем тебе первому.`;
    } else {
      // сервер недоступен — уводим заявку в директ, без «ошибки 500»
      btn.textContent = 'Отправить заявку';
      const opened = window.open(SITE.instagramDm, '_blank', 'noopener');
      const note = $('cf-note');
      note.textContent = '';
      if (opened) {
        note.textContent = `Открыли директ — напиши «Привезите PROJECT X в ${city}», заявка уйдёт напрямую организаторам.`;
      } else {
        // Safari на iPhone блокирует окно, открытое после ожидания сети: жест
        // к этому моменту «протух». Обещать «открыли» тогда нельзя.
        note.append(`Связь подвела. Напиши в директ «Привезите PROJECT X в ${city}» — `);
        const a = document.createElement('a');
        a.href = SITE.instagramDm;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'открыть директ';
        note.append(a);
      }
    }
  };

  function toggleErr(id, isBad) {
    const el = $(`err-${id}`);
    if (el) el.classList.toggle('is-on', isBad);
    return isBad;
  }
}
