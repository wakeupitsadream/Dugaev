// Анализ поста-анонса: правила (assets/post-parse.js) всегда, ИИ — если в
// Vercel есть ключ (POLZA_API_KEY или ANTHROPIC_API_KEY). Правила дают
// результат мгновенно и бесплатно; ИИ дописывает то, что правилам не
// далось (название, описание, программа), но цены и количества проверены
// правилами — им доверяем больше, если они нашлись.
import { parsePost } from '../../assets/post-parse.js';
import { extractPost, extractorAvailable } from './extract.js';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

export function mergeAi(rules, ai) {
  const d = { ...rules.draft };
  const x = (ai && ai.event) || {};
  const took = [];
  const take = (key, ok, val) => {
    if (ok && (!d[key] || !rules.found[key === 'timeStart' ? 'timeStart' : key])) { d[key] = val; took.push(key); }
  };
  take('title', x.title && x.title.length >= 3, String(x.title || '').toUpperCase().slice(0, 60));
  take('date', isDate(x.date), x.date);
  take('timeStart', isTime(x.timeStart), x.timeStart);
  take('timeEnd', isTime(x.timeEnd), x.timeEnd);
  take('venue', x.venue && x.venue.length >= 2, String(x.venue || '').slice(0, 80));
  take('address', x.address && x.address.length >= 4, String(x.address || '').slice(0, 120));
  if (x.secret === true && !d.secret) { d.secret = true; d.address = ''; took.push('secret'); }
  if ([16, 18].includes(Number(x.ageRating)) && !rules.found.age) d.ageRating = Number(x.ageRating);
  // описание и программа: у ИИ обычно лучше связный текст
  if (x.descr && x.descr.length >= 40 && (!rules.found.descr || /^В программе:/.test(d.descr))) { d.descr = x.descr.slice(0, 1500); took.push('descr'); }
  if (Array.isArray(x.program) && x.program.length > d.program.length) { d.program = x.program.slice(0, 12); took.push('program'); }
  if (Array.isArray(x.lineup) && x.lineup.length > d.lineup.length) { d.lineup = x.lineup.slice(0, 10); took.push('lineup'); }
  // цены: правила знают «первые 50» и «на входе»; ИИ — если правила ничего не нашли
  const aiPrices = (x.prices || []).filter((p) => Number.isInteger(p.priceRub) && p.priceRub >= 0 && p.priceRub <= 50000);
  if (!d.waves.length && aiPrices.length) {
    d.waves = aiPrices.slice(0, 6).map((p, i) => {
      const first = /перв\S*\s*(\d{1,4})/i.exec(p.name || '');
      return { waveNo: i + 1, name: String(p.name || `Волна ${i + 1}`).slice(0, 40), priceRub: p.priceRub, quota: first ? Number(first[1]) : 100, public: !/на\s+входе/i.test(p.name || '') };
    });
    took.push('waves');
  }
  // подсказки правил о том, что ИИ уже нашёл, больше не нужны
  const fixed = { title: /Название/, date: /Дата не найдена/, timeStart: /Время начала/, timeEnd: /Время окончания|До утра/, venue: /Площадка/, address: /Адрес/, waves: /Цены не найдены/ };
  const notes = rules.notes.filter((n) => !took.some((k) => fixed[k] && fixed[k].test(n)));
  return { draft: d, found: { ...rules.found, ...Object.fromEntries(took.map((k) => [k, true])) }, notes, took };
}

// text → { draft, found, notes, engine: 'rules'|'rules+ai', kind }
export async function analyzePost(text, { nowMs = Date.now(), known = [], extract = extractPost, ai = extractorAvailable() } = {}) {
  const rules = parsePost(text, { nowMs });
  const kind = rules.found.date ? 'announcement' : 'other';
  if (!ai) return { ...rules, engine: 'rules', kind };
  let x = null;
  try {
    x = await extract(text, known, new Date(nowMs + 5 * 3600_000).toISOString().slice(0, 10));
  } catch {
    x = null;
  }
  if (!x || x.kind === 'error' || x.kind === 'unavailable') return { ...rules, engine: 'rules', kind, aiFailed: true };
  const merged = mergeAi(rules, x);
  return { ...merged, engine: 'rules+ai', kind: x.kind === 'other' && rules.found.date ? 'announcement' : x.kind, targetSlug: x.event?.targetSlug || null };
}
