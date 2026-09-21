// Выгрузка оплат в CSV для чеков в «Мой налог» — чистая логика без DOM.
// Разделитель «;» и BOM — чтобы Excel на Windows открыл файл с кириллицей
// и разбил на колонки без импорта.
const PROVIDER = { transfer: 'перевод', door: 'на входе', stub: 'демо', card: 'карта' };

function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtDate(iso, tz = 'Asia/Yekaterinburg') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

export const ORDER_COLUMNS = ['Дата оплаты', 'Код брони', 'Сумма, ₽', 'Проходок', 'Гость', 'Телефон', 'Способ', 'Подтвердил', 'Источник', 'Заказ'];

// orders: [{ paid_at, pay_code, amount_rub, qty, buyer_name, buyer_phone, provider, confirmed_by, src, id }]
export function ordersCsv(orders, { tz } = {}) {
  const lines = [ORDER_COLUMNS.map(cell).join(';')];
  for (const o of orders || []) {
    lines.push([
      fmtDate(o.paid_at, tz),
      o.pay_code || '',
      Number(o.amount_rub || 0),
      Number(o.qty || 0),
      o.buyer_name || '',
      o.buyer_phone && o.buyer_phone !== 'касса' ? o.buyer_phone : '',
      PROVIDER[o.provider] || o.provider || '',
      o.confirmed_by || '',
      o.src || '',
      o.id || '',
    ].map(cell).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFileName(eventId, nowMs = Date.now()) {
  const d = new Date(nowMs).toISOString().slice(0, 10);
  return `oplaty-${String(eventId || 'event').replace(/[^\w-]/g, '')}-${d}.csv`;
}
