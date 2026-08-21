// Сид афиши: данные без логики. Потребители:
//  1) клиент — фолбэк, когда /api/events недоступен;
//  2) /api/seed — начальное наполнение БД;
//  3) /api/events — деградация при упавшей БД.
// Концепция бренда: дневные БЕЗАЛКОГОЛЬНЫЕ тусовки 14+ (двери 16:00,
// старт 17:00, финиш 22:00 — «домой до темноты»).
// ЗАГЛУШКА: даты, площадки и названия ближайших тус заменить реальными из
// t.me/trap_house56 — только этот файл (или через TG-конвейер в БД).
export const EVENTS = [
  {
    id: 'th-oren-back-to-school',
    brand: 'traphouse',
    title: 'BACK TO SCHOOL',
    city: 'orenburg',
    venue: 'площадка придёт в билете', // ЗАГЛУШКА: клуб/лофт из анонса
    address: 'Оренбург, центр',
    startsAt: '2026-09-05T16:00:00+05:00',
    endsAt: '2026-09-05T22:00:00+05:00',
    ageRating: 14,
    status: 'onsale',
    posterUrl: '/assets/photos/live-stage.jpg',
    descr:
      'Открываем сезон: два зала, свет как на большом концерте, шоу-программа и ноль алкоголя. Двери в 16:00, старт в 17:00, в 22:00 расходимся — все дома засветло.',
    lineup: [], // объявляется в телеге — блок на странице сам скажет об этом
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 300, quota: 80 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 400, quota: 120 },
      { waveNo: 3, name: 'На входе', priceRub: 500, quota: 100 },
    ],
  },
  {
    id: 'th-mgn-magnitka-move',
    brand: 'traphouse',
    title: 'MAGNITKA MOVE',
    city: 'magnitogorsk',
    venue: 'площадка придёт в билете', // ЗАГЛУШКА
    address: 'Магнитогорск',
    startsAt: '2026-09-19T16:00:00+05:00',
    endsAt: '2026-09-19T22:00:00+05:00',
    ageRating: 14,
    status: 'onsale',
    posterUrl: '/assets/photos/lasers-red.jpg',
    descr:
      'TRAP HOUSE снова в Магнитке. Дневной формат 14+: батлы, съёмка клипа, чёрный box и лучшие диджеи. Без алкоголя — и это проверяется на входе.',
    lineup: [],
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 300, quota: 70 },
      { waveNo: 2, name: 'Вторая волна', priceRub: 400, quota: 100 },
      { waveNo: 3, name: 'На входе', priceRub: 500, quota: 80 },
    ],
  },
  {
    id: 'th-oren-foam-party',
    brand: 'traphouse',
    title: 'ПЕННАЯ ТУСА',
    city: 'orenburg',
    venue: 'open air', // прошедшая — для «как это было»
    address: 'Оренбург',
    startsAt: '2026-07-21T16:00:00+05:00',
    endsAt: '2026-07-21T22:00:00+05:00',
    ageRating: 14,
    status: 'past',
    posterUrl: '/assets/photos/foam-cannon.jpg',
    descr: 'Как это было: пенная пушка, открытая площадка и полный танцпол.',
    lineup: [],
    waves: [
      { waveNo: 1, name: 'Первая волна', priceRub: 300, quota: 150 },
      { waveNo: 2, name: 'На входе', priceRub: 500, quota: 150 },
    ],
  },
];

// Факты для hero (из регламента бренда)
export const FACTS = [
  { n: '14+', label: 'возраст входа — фейсконтроль на дверях' },
  { n: '0%', label: 'алкоголя — это правило входа, не мелкий шрифт' },
  { n: '22:00', label: 'финиш — домой засветло и без вопросов' },
];

// Фотолента «Как это выглядит»: реальные кадры с тус.
// ЗАГЛУШКА: даты-теги уточнить у организатора (взяты по мотивам фотоленты).
export const GALLERY = [
  { src: '/assets/photos/crowd-red.jpg', title: 'ТАНЦПОЛ', note: 'клуб · Оренбург' },
  { src: '/assets/photos/foam-day.jpg', title: 'ПЕННАЯ', note: '21.07 · open air' },
  { src: '/assets/photos/live-stage.jpg', title: 'ЖИВЬЁМ', note: 'приглашённый артист' },
  { src: '/assets/photos/club-neon.jpg', title: 'НЕОН', note: 'основной зал' },
  { src: '/assets/photos/foam-cannon.jpg', title: 'ПУШКА', note: '21.07 · пенная' },
  { src: '/assets/photos/lasers-red.jpg', title: 'ЛАЗЕРЫ', note: 'Магнитогорск' },
  { src: '/assets/photos/mc-mask.jpg', title: 'MC', note: 'маска-шоу' },
];

// Шоу-программа — что происходит на каждой тусе
export const SHOW_PROGRAM = [
  { title: 'Кольцевая лампа', text: 'Снимай контент прямо на танцполе — свет как у блогеров, только вокруг ещё и толпа.' },
  { title: 'Танцевальные батлы', text: 'Тренды из рилсов под быстрый микс. Кто сдался — тот проиграл.' },
  { title: 'Съёмка клипа', text: 'Общее видео всей тусой с сюжетным переходом. Потом оно разлетается по сторис.' },
  { title: 'Угадай мелодию', text: 'Пять секунд на трек. Клиповое мышление наконец-то пригодилось.' },
  { title: 'Диджеи и MC', text: 'Лучшие в городе, плюс выступления приглашённых артистов.' },
  { title: 'Чёрный box', text: 'Коробка с сюрпризом на каждой тусовке. Что внутри — узнаешь на месте.' },
  { title: 'Подарки и конкурсы', text: 'От партнёров. Безалкогольные коктейли — самым активным на танцполе.' },
  { title: 'Видеограф', text: 'Работает всю тусу. Свои кадры забираешь бесплатно.' },
];
