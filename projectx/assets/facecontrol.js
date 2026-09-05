// Интерактив «Фейсконтроль» PROJECT X — чистая логика без DOM.
// Правила бренда: ночные вечеринки строго 18+, вход по паспорту.
// Младше 18 — «рано», считаем годы до совершеннолетия; 18 и старше — проходишь.
import { plural } from './ticket-format.js';

export function faceControl(raw) {
  const age = Number(String(raw ?? '').trim());
  if (!Number.isInteger(age) || age <= 0 || age > 120) {
    return { verdict: 'invalid' };
  }
  if (age < 18) {
    const wait = 18 - age;
    return {
      verdict: 'early',
      age,
      wait,
      title: 'Рано',
      sub: `Ночь начинается с паспорта, а в нём пока не те цифры. Возвращайся через ${wait} ${plural(wait, 'год', 'года', 'лет')} — дверь будет твоя.`,
    };
  }
  return {
    verdict: 'okay',
    age,
    title: 'Проходишь',
    sub: `${age} — показываешь паспорт на входе, и танцпол твой до шести утра. Двери в 23:00, дальше только мы и бит.`,
  };
}

// Текст для «скопировать и похвастаться»
export function shareText(result, siteUrl) {
  const base = `Фейсконтроль PROJECT X: ${result.title.toUpperCase()}.`;
  return `${base} Проверь себя — ${siteUrl}`;
}
