// Офлайн-очередь чек-инов — чистая логика без localStorage и без сети.
// Хранение и отправка — забота вызывающего кода (scan-page.js).
// Запись: { ticketId, by, at } (at — ISO-время нажатия «Впустить под запись»).

export function enqueue(list, entry) {
  if (!entry || typeof entry.ticketId !== 'string' || !entry.ticketId) return list;
  if (list.some((e) => e.ticketId === entry.ticketId)) return list; // идемпотентно
  return [...list, { ticketId: entry.ticketId, by: entry.by || '', at: entry.at || '' }];
}

// Что отправлять при синхронизации (порядок сохраняется)
export function pendingItems(list) {
  return [...list];
}

// Убираем успешно синхронизированные; неудачные остаются в очереди.
// results: [{ ticketId, ok }]
export function applyResults(list, results) {
  const okIds = new Set(results.filter((r) => r && r.ok).map((r) => r.ticketId));
  return list.filter((e) => !okIds.has(e.ticketId));
}
