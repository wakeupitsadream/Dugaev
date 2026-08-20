// Сид афиши: данные без логики. Используется тремя потребителями:
//  1) клиент — фолбэк, когда /api/events недоступен;
//  2) /api/seed — начальное наполнение БД;
//  3) /api/events — деградация при упавшей БД.
// Легенда полей: id — слаг (и ключ БД); ageRating — 16|18; status — onsale|past|draft;
// waves — волны цен (quota — сколько билетов продаётся по этой цене).
// ЗАГЛУШКА: названия клубов, адреса, даты, цены и лайнапы заменить фактами
// организатора — только этот файл, больше ничего править не нужно.
export const EVENTS = [
  {
    id: 'th-oren-neon-drip',
    brand: 'traphouse',
    title: 'NEON DRIP',
    city: 'orenburg',
    venue: 'клуб «БУНКЕР»', // ЗАГЛУШКА
    address: 'Оренбург, центр — точка придёт в билете', // ЗАГЛУШКА
    startsAt: '2026-08-29T22:00:00+05:00',
    endsAt: '2026-08-30T04:00:00+05:00',
    ageRating: 18,
    status: 'onsale',
    posterUrl: null, // фото афиши появится — заменится автоматически
    descr:
      'Открытие осеннего сезона. Два танцпола, свет как на фестивале, дресс-код — чёрный. Паспорт обязателен.',
    lineup: ['DJ KAMAZ', 'YUNG PLITA', 'SABURA b2b DVIZH'], // ЗАГЛУШКА
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 500, quota: 60 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 700, quota: 80 },
      { waveNo: 3, name: 'Последняя волна', priceRub: 900, quota: 60 },
    ],
  },
  {
    id: 'th-oren-young-blood',
    brand: 'traphouse',
    title: 'YOUNG BLOOD 16+',
    city: 'orenburg',
    venue: 'лофт «АНГАР»', // ЗАГЛУШКА
    address: 'Оренбург — точка придёт в билете', // ЗАГЛУШКА
    startsAt: '2026-09-05T17:00:00+05:00',
    endsAt: '2026-09-05T22:00:00+05:00',
    ageRating: 16,
    status: 'onsale',
    posterUrl: null,
    descr:
      'Дневной формат для 16+. Без алкоголя вообще: только музыка, танцпол и бар с лимонадами. Родители могут выдыхать — на входе браслеты и контроль.',
    lineup: ['DJ KAMAZ', 'MC FRESH'], // ЗАГЛУШКА
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 400, quota: 80 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 550, quota: 100 },
    ],
  },
  {
    id: 'th-mgn-takeover',
    brand: 'traphouse',
    title: 'MAGNITKA TAKEOVER',
    city: 'magnitogorsk',
    venue: 'клуб «ЦЕХ»', // ЗАГЛУШКА
    address: 'Магнитогорск — точка придёт в билете', // ЗАГЛУШКА
    startsAt: '2026-09-12T22:00:00+05:00',
    endsAt: '2026-09-13T04:00:00+05:00',
    ageRating: 18,
    status: 'onsale',
    posterUrl: null,
    descr:
      'TRAP HOUSE впервые забирает Магнитку. Привозим весь оренбургский состав и локальных резидентов.',
    lineup: ['DJ KAMAZ', 'YUNG PLITA', 'LOCAL HEROES'], // ЗАГЛУШКА
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 500, quota: 70 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 700, quota: 90 },
    ],
  },
  {
    id: 'th-oren-season-opening',
    brand: 'traphouse',
    title: 'SEASON OPENING',
    city: 'orenburg',
    venue: 'клуб «БУНКЕР»', // ЗАГЛУШКА
    address: 'Оренбург',
    startsAt: '2026-07-25T22:00:00+05:00',
    endsAt: '2026-07-26T04:00:00+05:00',
    ageRating: 18,
    status: 'past',
    posterUrl: null,
    descr: 'Как это было: солд-аут за три дня до старта.',
    lineup: [],
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 500, quota: 100 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 700, quota: 100 },
    ],
  },
];

// Цифры для hero. ЗАГЛУШКА: подтвердить у организатора.
export const FACTS = [
  { n: '12', label: 'тусовок за сезон' },
  { n: '3500+', label: 'гостей прошло через вход' },
  { n: '2', label: 'города: Оренбург и Магнитогорск' },
];

// Подписи для галереи «как это было» (заменятся реальными фото).
export const GALLERY = [
  { title: 'SEASON OPENING', note: 'июль · Оренбург' },
  { title: 'BLACK ROOM', note: 'июнь · Оренбург' },
  { title: 'FIRST DROP', note: 'май · Магнитогорск' },
  { title: 'ACID NIGHT', note: 'апрель · Оренбург' },
  { title: 'NO SLEEP', note: 'март · Оренбург' },
  { title: 'WARM UP', note: 'февраль · Магнитогорск' },
];
