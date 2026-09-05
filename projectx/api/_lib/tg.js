// Работа с Telegram Bot API. Деградация молча: не настроен бот или
// Telegram недоступен — основной сценарий (заказ, вебхук) не ломается.
export function tgConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export async function tgApi(method, payload, timeoutMs = 4000) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    return j && j.ok ? j.result : null;
  } catch (e) {
    console.warn(`tg ${method} failed:`, e.message);
    return null;
  }
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
