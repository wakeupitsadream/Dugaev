// Интерактив «Фейсконтроль» ECHO — чистая логика без DOM.
// Правила бренда: дневная тусовка с 14 лет, ночная — строго 18+.
import { plural } from './ticket-format.js';

export function faceControl(raw) {
  const age = Number(String(raw ?? '').trim());
  if (!Number.isInteger(age) || age <= 0 || age > 120) {
    return { verdict: 'invalid' };
  }
  if (age < 14) {
    const wait = 14 - age;
    return {
      verdict: 'early',
      age,
      wait,
      title: 'Рано',
      sub: `Не пустим даже на дневную, и спорить бесполезно. Возвращайся через ${wait} ${plural(wait, 'год', 'года', 'лет')} — дверь будет твоя.`,
    };
  }
  if (age <= 17) {
    return {
      verdict: 'list',
      age,
      title: 'Дневная твоя',
      sub: `${age} — допуск на дневную (16:00–21:00) получен, браслет выдадут на входе. На ночную — с 18: там текильщицы и паспорт-контроль.`,
    };
  }
  return {
    verdict: 'okay',
    age,
    title: 'Обе твои',
    sub: `${age} — проходишь и на дневную, и на ночную. С 00:00 до 00:30 на ночную вообще бесплатно — бери фри-проходку.`,
  };
}

// Текст для «скопировать и похвастаться»
export function shareText(result, siteUrl) {
  const base = `Фейсконтроль ECHO: ${result.title.toUpperCase()}.`;
  return `${base} Проверь себя — ${siteUrl}`;
}
