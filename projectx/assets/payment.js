// Контракт оплаты. v1 — провайдер 'stub': заказ становится paid мгновенно
// на сервере, редиректа нет. Подключение реального провайдера (ЮKassa/СБП):
//  1) сервер в /api/order создаёт заказ status='pending' + expires_at и
//     возвращает payment.redirect_url;
//  2) клиент (этот модуль) уводит гостя на redirect_url;
//  3) вебхук /api/pay/webhook помечает заказ paid → билеты активны.
// Меняется ТОЛЬКО этот модуль и серверный провайдер — остальной код не трогаем.
export function handlePayment(payment) {
  if (payment && payment.redirect_url) {
    window.location.href = payment.redirect_url;
    return 'redirect';
  }
  return 'paid';
}
