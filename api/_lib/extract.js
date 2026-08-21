// Анализ поста TG-канала через Claude (Haiku — дёшево, задача экстракции).
// Строгий tool use с форсированным tool_choice — модель обязана вернуть
// валидный JSON по схеме. Нет ключа/ошибка — вызывающий код деградирует
// в «переслать владельцу вручную».
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';

const TOOL = {
  name: 'save_post_analysis',
  description: 'Сохранить результат анализа поста канала вечеринок',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'confidence', 'event'],
    properties: {
      kind: {
        type: 'string',
        enum: ['announcement', 'update', 'cancellation', 'other'],
        description:
          'announcement — анонс новой вечеринки с датой; update — изменение цен/условий/места уже анонсированной; cancellation — отмена/перенос; other — всё остальное (фотоотчёты, мемы, розыгрыши)',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      event: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'city', 'venue', 'date', 'timeStart', 'timeEnd', 'ageRating', 'prices', 'descr', 'targetSlug'],
        properties: {
          title: { type: ['string', 'null'], description: 'Название вечеринки, как в посте' },
          city: { type: ['string', 'null'], description: 'Город (Оренбург, Магнитогорск, …)' },
          venue: { type: ['string', 'null'], description: 'Клуб/площадка' },
          date: { type: ['string', 'null'], description: 'Дата вечеринки YYYY-MM-DD' },
          timeStart: { type: ['string', 'null'], description: 'Время начала HH:MM' },
          timeEnd: { type: ['string', 'null'], description: 'Время окончания HH:MM' },
          ageRating: { type: ['integer', 'null'], description: 'Возрастной рейтинг: 14, 16 или 18' },
          prices: {
            type: 'array',
            description: 'Цены/волны из поста, по возрастанию',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'priceRub'],
              properties: {
                name: { type: 'string', description: 'Название тарифа/волны' },
                priceRub: { type: 'integer', description: 'Цена в рублях' },
              },
            },
          },
          descr: { type: ['string', 'null'], description: 'Короткое описание для афиши, 1-2 предложения из поста' },
          targetSlug: {
            type: ['string', 'null'],
            description: 'Для update/cancellation: слаг существующего события из списка в системном промпте',
          },
        },
      },
    },
  },
};

export function extractorAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// text — текст/подпись поста; knownEvents — [{id,title,startsAt}] для матчинга
export async function extractPost(text, knownEvents, nowIso) {
  if (!extractorAvailable()) return { kind: 'unavailable' };
  const client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
  try {
    const known = (knownEvents || [])
      .map((e) => `- ${e.id}: ${e.title} (${String(e.startsAt).slice(0, 10)})`)
      .join('\n');
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        `Ты анализируешь посты Telegram-канала организатора вечеринок TRAP HOUSE ` +
        `(дневные безалкогольные тусовки 14+ в Оренбурге и Магнитогорске, обычно 16:00-22:00). ` +
        `Сегодня ${nowIso}. Извлекай ТОЛЬКО то, что явно написано в посте; чего нет — null. ` +
        `Даты вида «21 сентября» относи к ближайшему будущему. ` +
        `Существующие события на сайте:\n${known || '(нет)'}`,
      messages: [{ role: 'user', content: `Пост канала:\n\n${String(text).slice(0, 3000)}` }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'save_post_analysis' },
    });
    const call = response.content.find((b) => b.type === 'tool_use');
    if (!call) return { kind: 'error' };
    return call.input;
  } catch (e) {
    console.warn('extract failed:', e.message);
    return { kind: 'error' };
  }
}
