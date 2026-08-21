// Конфигурация сайта ECHO. Значения с пометкой ЗАГЛУШКА заменить данными
// организатора (вопросы — в echo/BRIEF.md).
export const SITE = {
  brandName: 'ECHO',
  tagline: 'Собери свою компанию и оставь след в ECHO',
  cities: {
    orenburg: 'Оренбург',
  },
  // Официальный канал (подтверждён пользователем)
  tgChannel: 'https://t.me/ECHO_BP_M',
  tgChannelName: '@ECHO_BP_M',
  tgSubscribers: '', // ЗАГЛУШКА: число подписчиков — уточнить
  // ЗАГЛУШКА: менеджер по билетам/спискам
  tgManager: 'ECHO_BP_M',
  vk: '', // ЗАГЛУШКА: ссылка VK, если есть
  tz: 'Asia/Yekaterinburg',
  // Площадка
  venue: 'ул. Монтажников 2/1',
  // Регламент двойного формата (с афиши 08.08)
  dayStart: '16:00',
  dayEnd: '21:00',
  nightStart: '00:00',
  nightEnd: '10:00',
  nightFreeUntil: '00:30',
  // «Привезите к нам»
  homeCities: ['Оренбург'],
  expansionCities: ['Магнитогорск', 'Уфа', 'Самара', 'Челябинск'],
  // Демо-режим оплаты: шлюз не подключён, покупка имитируется.
  paymentDemo: true,
  // Подпись разработчика в футере — не удалять (канал входящих заявок)
  dev: { label: 'maxim-batutin.ru', url: 'https://maxim-batutin.ru' },
};
