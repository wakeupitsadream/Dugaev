// SECRET PLACE: правило раскрытия адреса площадки.
//
// Модель бренда (решение владельца):
//   • купил проходку — адрес виден в ней СРАЗУ после покупки;
//   • всем остальным — публично за сутки до ночи (сайт и Instagram).
// То есть проходка даёт не только вход, но и знание раньше города — это и
// есть довод взять её заранее, а не «когда-нибудь потом».
//
// Модуль чистый (без DOM и БД): им пользуются и серверные функции api/*,
// и страницы. Один источник правды — иначе адрес рано или поздно утечёт
// в публичную афишу.
export const PUBLIC_REVEAL_MS = 24 * 3600_000; // за сколько до старта адрес становится публичным

// Момент, когда адрес открывается всем
export function publicRevealAt(startsAt) {
  const t = Date.parse(startsAt);
  return Number.isFinite(t) ? new Date(t - PUBLIC_REVEAL_MS).toISOString() : null;
}

// Виден ли адрес публике (в афише, в карточке, без покупки).
// Прошедшие ночи не прячем: это уже история, а не интрига.
export function addressIsPublic(event, nowMs = Date.now()) {
  if (!event) return false;
  if (event.status === 'past') return true;
  const t = Date.parse(event.startsAt || event.starts_at);
  if (!Number.isFinite(t)) return false;
  return nowMs >= t - PUBLIC_REVEAL_MS;
}

// Что показать вместо адреса тому, кто ещё не купил
export function addressTeaser(event, nowMs = Date.now()) {
  const t = Date.parse(event?.startsAt || event?.starts_at);
  if (!Number.isFinite(t)) return 'адрес придёт в проходку';
  const left = t - PUBLIC_REVEAL_MS - nowMs;
  if (left <= 0) return 'адрес ниже';
  const days = Math.floor(left / 86400_000);
  const hours = Math.floor((left % 86400_000) / 3600_000);
  const when = days > 0 ? `через ${days} ${plural(days, 'день', 'дня', 'дней')}` : `через ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  return `адрес — в проходке сразу, всем остальным ${when}`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
