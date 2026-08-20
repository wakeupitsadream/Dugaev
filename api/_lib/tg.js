// Уведомление владельцу в Telegram о продаже. Деградация молча:
// не настроен бот или Telegram недоступен — заказ всё равно проходит.
export async function notifyOwner(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.warn('tg notify failed:', e.message);
  }
}
