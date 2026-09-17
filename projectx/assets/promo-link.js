// Ссылка промоутера: метка src из имени (латиница, цифры, дефис), не длиннее
// 24 символов — сервер режет utm.src на 32. Чистые функции, без DOM.
const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function promoSlug(name) {
  const s = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[а-яё]/g, (ch) => MAP[ch] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return /[a-z0-9]{2,}/.test(s) ? s : '';
}

export function promoLink(base, eventId, slug) {
  return `${String(base).replace(/\/+$/, '')}/e/${encodeURIComponent(eventId)}?src=${encodeURIComponent(slug)}`;
}
