// Работа с Telegram Bot API. Деградация молча: не настроен бот или
// Telegram недоступен — основной сценарий (заказ, вебхук) не ломается.
export function tgConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

// Имя бота для deep-link «Получить в Telegram» (без @). Публично, не секрет.
export function tgBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '') || null;
}

// Вызов Bot API с полным ответом: { ok:true, result } или { ok:false, error, code }.
// Ошибки Telegram («can't parse entities», «chat not found», 401 по токену)
// пишутся в лог — молчаливый null их прятал.
export async function tgCall(method, payload, timeoutMs = 4000) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN не задан', code: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok) return { ok: true, result: j.result };
    const error = (j && j.description) || `HTTP ${r.status}`;
    console.warn(`tg ${method}: ${error}`);
    return { ok: false, error, code: (j && j.error_code) || r.status };
  } catch (e) {
    console.warn(`tg ${method} failed: ${e.message}`);
    return { ok: false, error: e.message, code: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Упрощённая форма: result или null (большинству вызовов важен только факт)
export async function tgApi(method, payload, timeoutMs = 4000) {
  const r = await tgCall(method, payload, timeoutMs);
  return r.ok ? r.result : null;
}

// Сообщение владельцу (уведомления о продажах, заявках, постах).
// replyMarkup — опциональная inline-клавиатура (кнопки подтверждения).
export async function notifyOwner(text, replyMarkup) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await tgApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }, 2500);
}
