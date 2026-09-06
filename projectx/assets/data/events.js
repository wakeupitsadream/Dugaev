// Сид афиши PROJECT X: данные без логики. Потребители:
//  1) клиент — фолбэк, когда /api/events недоступен;
//  2) /api/seed — начальное наполнение БД;
//  3) /api/events — деградация при упавшей БД.
//
// Бренд: ночные вечеринки 18+, FC/DC (фейсконтроль и дресс-код).
// Регламент — двери 22:00, старт 23:00 (см. SITE.doorsOpen / SITE.showStart).
// Фишка бренда: SECRET PLACE — площадку не объявляют заранее, адрес приходит
// перед вечеринкой. Город — Оренбург (@project.x.prty).
//
// Прошедшие события ниже — реальные, сняты с афиш @project.x.prty.
// Всё, что помечено ЗАГЛУШКА, заменяет владелец: боевой способ правки —
// раздел «События» в админке (без деплоя).
export const EVENTS = [
  {
    // ЗАГЛУШКА: ближайшая вечеринка — рыба под реальный анонс.
    // Владелец меняет дату, название и волны цен в админке.
    id: 'px-oren-posvyashenie',
    brand: 'projectx',
    title: 'PROJECT X — ПОСВЯЩЕНИЕ',
    city: 'orenburg',
    venue: 'SECRET PLACE', // площадку объявляем перед вечеринкой — так у бренда всегда
    address: null, // адрес приходит в проходке, поэтому здесь пусто
    // ЗАГЛУШКА: дату заменит владелец. 22:00 — это двери, старт в 23:00.
    startsAt: '2026-10-09T22:00:00+05:00',
    endsAt: '2026-10-10T06:00:00+05:00', // технически «до утра»; точный финиш — за площадкой
    ageRating: 18,
    status: 'onsale',
    posterUrl: '/assets/photos/logo-badge.jpg', // ЗАГЛУШКА: пока фирменный бейдж — заменить афишей события
    descr:
      'Посвящение первокурсников по правилам PROJECT X: ну очень стильная тусовка, ' +
      'о которой даже не могли мечтать. Место — SECRET PLACE, адрес приходит перед стартом. ' +
      'FC/DC и строго 18+: паспорт с собой. Двери в 22:00, музыка с 23:00 и до утра.',
    // ЗАГЛУШКА: состав собран из реальных афиш бренда — финальный line-up подтверждает владелец
    lineup: ['DJ SHENDI', 'DJ JOKER', 'DJ DYSSHA', 'DJ DIZAYNER', 'NEXTIME WEBPUNK', 'MOTI MAR TEAM'],
    // ЗАГЛУШКА: цены и квоты — ориентир по ночному Оренбургу, реальные ставит владелец
    waves: [
      { waveNo: 1, name: 'Ранняя волна', priceRub: 500, quota: 100 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 700, quota: 150 },
      { waveNo: 3, name: 'На входе', priceRub: 1000, quota: 150 },
    ],
  },

  // ---- Архив: реальные вечеринки с афиш @project.x.prty ----
  // Время старта на афишах 2021 года не указано — стоит регламентные 23:00.
  // Волны цен архива не восстановить, поэтому waves пустые: карточка архива
  // цену не показывает («как это было»).
  {
    id: 'px-oren-posvyat-2022',
    brand: 'projectx',
    title: 'СУМАСШЕДШИЙ ПОСВЯТ',
    city: 'orenburg',
    venue: 'CTUDИЯ CLUB',
    address: 'Алтайская 5/1, Оренбург',
    startsAt: '2022-10-01T23:00:00+05:00', // с афиши: 01.10.22, 23:00
    endsAt: null,
    ageRating: 18,
    status: 'past',
    posterUrl: '/assets/photos/poster-posvyat-2022.jpg',
    descr:
      'Посвящение, которое в городе вспоминают до сих пор: CTUDИЯ CLUB, старт в 23:00 ' +
      'и полный танцпол первокурсников. Молодость простит.',
    lineup: [],
    waves: [],
  },
  {
    id: 'px-oren-halloween-2021',
    brand: 'projectx',
    title: 'ХЭЛЛОУИН',
    city: 'orenburg',
    venue: 'SECRET PLACE',
    address: null,
    startsAt: '2021-10-30T23:00:00+05:00', // с афиши: 30.10.21
    endsAt: null,
    ageRating: 18,
    status: 'past',
    posterUrl: '/assets/photos/poster-halloween.jpg',
    descr:
      'Самая эпическая ночь осени: грим, костюмы и SECRET PLACE, адрес которого узнали ' +
      'только свои. FC/DC на дверях работал жёстче обычного.',
    lineup: [],
    waves: [],
  },
  {
    id: 'px-oren-posvyashenie-2021',
    brand: 'projectx',
    title: 'ПОСВЯЩЕНИЕ',
    city: 'orenburg',
    venue: 'SECRET PLACE',
    address: null,
    startsAt: '2021-10-02T23:00:00+05:00', // с афиши: 02.10.21
    endsAt: null,
    ageRating: 18,
    status: 'past',
    posterUrl: '/assets/photos/poster-posvyashenie.jpg',
    descr:
      'Вторая ночь бренда и первое настоящее посвящение. SECRET PLACE, FC/DC, 18+ — ' +
      'и зал, который не расходился до утра.',
    lineup: [],
    waves: [],
  },
  {
    id: 'px-oren-znakomstvo-2021',
    brand: 'projectx',
    title: 'ЗНАКОМСТВО',
    city: 'orenburg',
    venue: 'SECRET PLACE',
    address: null,
    startsAt: '2021-09-17T23:00:00+05:00', // с афиши: 17.09.21
    endsAt: null,
    ageRating: 18,
    status: 'past',
    posterUrl: '/assets/photos/poster-znakomstvo.jpg',
    descr:
      'С этой ночи всё началось: 17 сентября 2021-го, SECRET PLACE, guest DJ под вопросами ' +
      'на афише и город, который пришёл знакомиться.',
    lineup: [],
    waves: [],
  },
];

// Факты для hero — регламент бренда с афиш (18+, FC/DC, двери 22:00 / старт 23:00, SECRET PLACE)
export const FACTS = [
  { n: '18+', label: 'FC/DC — фейсконтроль и дресс-код. Паспорт с собой.' },
  { n: '22:00', label: 'Двери. Старт в 23:00 — и дальше без пауз до утра.' },
  { n: '?', label: 'SECRET PLACE — площадку объявляем перед вечеринкой, адрес придёт в проходке.' },
];

// Фотолента «как это было» — реальные афиши @project.x.prty.
// Годы на части афиш не указаны (16 мая, 09.12) — подписи оставлены как на макете.
export const GALLERY = [
  { src: '/assets/photos/poster-znakomstvo.jpg', title: 'ЗНАКОМСТВО', note: '17.09.21 · SECRET PLACE' },
  { src: '/assets/photos/poster-posvyashenie.jpg', title: 'ПОСВЯЩЕНИЕ', note: '02.10.21 · SECRET PLACE' },
  { src: '/assets/photos/poster-halloween.jpg', title: 'ХЭЛЛОУИН', note: '30.10.21 · SECRET PLACE' },
  { src: '/assets/photos/poster-posvyat-2022.jpg', title: 'СУМАСШЕДШИЙ ПОСВЯТ', note: '01.10.22 · CTUDИЯ CLUB · 23:00' },
  { src: '/assets/photos/poster-studia-1102.jpg', title: 'CLUB CTUDИЯ', note: '11.02.23 · Алтайская 5/1 · двери 22:00' },
  { src: '/assets/photos/poster-night-student.jpg', title: 'НОЧЬ СТУДЕНТА', note: '16 мая · Волгоградская 46/3 «РЕЖИССЕР»' },
  { src: '/assets/photos/poster-gigant-free-bar.jpg', title: 'FREE BAR', note: '09.12 · ГИГАНТ ХОЛЛ · промокод DVIZH' },
];

// Шоу-программа: что бывает на ночах PROJECT X (всё — с реальных афиш)
export const SHOW_PROGRAM = [
  {
    title: 'Диджеи бренда',
    text: 'DJ SHENDI, DJ JOKER, DJ DYSSHA, DJ DIZAYNER, ASIO, REBEL X KLOPOTA, ARTURQUE, SANTI X ENDI, VANULA. Кто именно встанет за пульт — объявляем на афише перед вечеринкой.',
  },
  {
    title: 'MC и танцоры',
    text: 'NEXTIME WEBPUNK на микрофоне и MOTI MAR TEAM на танцполе. Они держат зал, когда сет только разгоняется.',
  },
  {
    title: 'Live-выступления',
    text: 'BOBRBOY, GARAGUL, DRUCY LIBERUM, KEENDY — живые номера прямо посреди ночи, без фонограммы и без пауз в музыке.',
  },
  {
    title: 'SECRET PLACE',
    text: 'Площадку не объявляем заранее — адрес прилетает перед стартом тем, у кого есть проходка. Так у нас с самой первой ночи.',
  },
  {
    title: 'Посвящение первокурсников',
    text: 'Осенью — «Посвящение» и «Ночь студента»: тот самый повод, ради которого весь город берёт проходку заранее. Молодость простит.',
  },
  {
    title: 'Red cups и американ-пати',
    text: 'Красные стаканы, конфетти и та самая атмосфера вечеринки, о которой даже не могли мечтать. На ГИГАНТ ХОЛЛ работал FREE BAR по промокоду DVIZH — будет ли он в следующий раз, скажем в Instagram.',
  },
  {
    title: 'Фото-зона',
    text: 'Отдельный свет под контент: кадры выходят как надо с первого дубля, а лучшие уходят к нам в ленту.',
  },
  {
    title: 'FC/DC на дверях',
    text: 'Фейсконтроль и дресс-код, строго 18+ по паспорту. Двери в 22:00 — заходить лучше пораньше, ближе к полуночи на входе собирается очередь.',
  },
];
