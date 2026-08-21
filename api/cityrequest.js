// «Привезите к нам»: заявка города. Пишем владельцу в TG (fire-and-forget),
// БД не требуется. Деградацию (TG не настроен/упал) гость не видит —
// заявка всё равно «принята», а клиент дополнительно предлагает deep-link.
import { ok, fail, noStore, onlyMethod } from './_lib/respond.js';
import { notifyOwner } from './_lib/tg.js';

export default async function handler(req, res) {
  noStore(res);
  if (!onlyMethod(req, res, 'POST')) return;

  const b = req.body || {};
  // honeypot — боту отвечаем «успехом», никого не уведомляя
  if (typeof b.website === 'string' && b.website.trim() !== '') return ok(res);

  const city = String(b.city || '').trim().slice(0, 40);
  const contact = String(b.contact || '').trim().slice(0, 64);
  const fields = {};
  if (city.length < 2) fields.city = 'Напиши город';
  if (contact.length < 2) fields.contact = 'Телега или телефон — чтобы позвать первым';
  if (b.consent !== true) fields.consent = 'Нужно согласие на обработку данных';
  if (Object.keys(fields).length) return fail(res, 400, 'validation', 'Проверь поля', { fields });

  await notifyOwner(`🌍 Заявка «привезите к нам»\nГород: ${city}\nКонтакт: ${contact}`);
  ok(res);
}
