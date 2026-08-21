// Интерактив «Фейсконтроль» — чистая логика без DOM.
// Правила бренда: вход с 14 лет; 14–17 — целевая аудитория (браслет на входе);
// 18+ пускаем с шуткой; младше 14 — «рано», ждём.
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
      sub: `Не пустим, и спорить бесполезно. Но мы никуда не денемся — возвращайся через ${wait} ${plural(wait, 'год', 'года', 'лет')}, дверь будет твоя.`,
    };
  }
  if (age <= 17) {
    return {
      verdict: 'list',
      age,
      title: 'Ты в списке',
      sub: `${age} — допуск получен. Браслет выдадут на входе: он же твой пропуск обратно, если выйдешь подышать.`,
    };
  }
  return {
    verdict: 'okay',
    age,
    title: 'Ну ладно',
    sub: `${age} — формально пустим, но будешь самым взрослым на танцполе. Морально подготовься объяснять, что такое рилсы.`,
  };
}

// Текст для «скопировать и похвастаться»
export function shareText(result, siteUrl) {
  const base = `Фейсконтроль TRAP HOUSE: ${result.title.toUpperCase()}.`;
  return `${base} Проверь себя — ${siteUrl}`;
}
