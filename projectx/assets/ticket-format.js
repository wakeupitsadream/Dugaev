// Чистые функции форматирования и валидации. Без DOM, без сети —
// используются на клиенте, в serverless и в тестах.

export const TZ = 'Asia/Yekaterinburg'; // Оренбург и Магнитогорск — UTC+5

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

const MONTHS_SHORT = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЯ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

function zoned(iso) {
  // Разбираем дату в частях нужного пояса независимо от пояса устройства.
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: wdMap[parts.weekday] ?? 0,
  };
}

// «29» + «АВГ» — для датабокса карточки
export function dateBox(iso) {
  const z = zoned(iso);
  return { day: String(z.day), mon: MONTHS_SHORT[z.month - 1] };
}

// «сб · 29 августа · 22:00»
export function fmtWhen(iso) {
  const z = zoned(iso);
  const hh = String(z.hour).padStart(2, '0');
  const mm = String(z.minute).padStart(2, '0');
  return `${WEEKDAYS_SHORT[z.weekday]} · ${z.day} ${MONTHS_GEN[z.month - 1]} · ${hh}:${mm}`;
}

// «29 августа, 22:00» — для билета
export function fmtTicketWhen(iso) {
  const z = zoned(iso);
  const hh = String(z.hour).padStart(2, '0');
  const mm = String(z.minute).padStart(2, '0');
  return `${z.day} ${MONTHS_GEN[z.month - 1]}, ${hh}:${mm}`;
}

// «23:41» из timestamp — время чек-ина
export function fmtTime(iso) {
  const z = zoned(iso);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

// ---- Токены билетов ----
// Токен: "{id}.{sig}", id — 10 симв base32 Crockford, sig — 20 симв.
const ID_RE = /^[0-9a-z]{10}$/;
const SIG_RE = /^[0-9a-z]{20}$/;

export function parseToken(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const dot = s.indexOf('.');
  if (dot === -1) return null;
  const id = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  if (!ID_RE.test(id) || !SIG_RE.test(sig)) return null;
  return { id, sig };
}

// «7K3F-9QZ2-MX» — номер билета для людей (диктуется охране)
export function formatTicketCode(id) {
  const up = String(id).toUpperCase();
  return [up.slice(0, 4), up.slice(4, 8), up.slice(8)].filter(Boolean).join('-');
}

// Ручной ввод номера: терпим к регистру, дефисам и путанице O/0, I/L/1
export function normalizeManualId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase().replace(/[\s-]/g, '')
    .replace(/o/g, '0').replace(/[il]/g, '1').replace(/u/g, 'v');
  return ID_RE.test(s) ? s : null;
}

// ---- Телефон (РФ) ----
// Маска для поля с фиксированным префиксом «+7»: в инпуте живут только
// 10 цифр номера. Привычные «8…» и вставленный «+7…» приводятся сами.
export function stripRuPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d[0] === '8') d = d.slice(1);
  else if (d[0] === '7' && d.length > 10) d = d.slice(1);
  return d.slice(0, 10);
}

// «9123456789» → «912 345-67-89» (частичный ввод форматируется по мере набора)
export function formatRuPhoneDigits(digits) {
  const s = String(digits || '').replace(/\D/g, '').slice(0, 10);
  let out = s.slice(0, 3);
  if (s.length > 3) out += ' ' + s.slice(3, 6);
  if (s.length > 6) out += '-' + s.slice(6, 8);
  if (s.length > 8) out += '-' + s.slice(8, 10);
  return out;
}

// Режим смешанного поля «телега или телефон»: ввод, начинающийся с цифры
// или «+», считаем телефоном (включается маска +7); с «@» или буквы — ник.
export function detectContactMode(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'free';
  return /^[+\d]/.test(s) ? 'phone' : 'free';
}

export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  let d = digits;
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1);
  if (d.length !== 10) return null;
  return '+7' + d;
}

// ---- Возрастные правила ----
// На ивент 18+ нельзя купить билет с пометкой «несовершеннолетний».
export function validateAttendees(attendees, ageRating) {
  const errors = [];
  if (!Array.isArray(attendees) || attendees.length < 1) {
    return { ok: false, errors: [{ i: -1, code: 'empty' }] };
  }
  if (attendees.length > 10) {
    return { ok: false, errors: [{ i: -1, code: 'too_many' }] };
  }
  attendees.forEach((a, i) => {
    const name = (a && typeof a.name === 'string' ? a.name : '').trim();
    if (name.length < 2) errors.push({ i, code: 'name' });
    if (a && a.minor && Number(ageRating) >= 18) errors.push({ i, code: 'minor_forbidden' });
  });
  return { ok: errors.length === 0, errors };
}

export function ageLabel(rating) {
  return `${rating}+`;
}
