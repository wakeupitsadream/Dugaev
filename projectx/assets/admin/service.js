// Сервис: статус разбора постов, настройка бота, боевой самотест,
// инициализация базы, выход с устройства.
import { $, state, api, on, visible, loadStats, esc, toast, busy, fmtTime } from './core.js';
import { activeWave } from '../waves.js';

export function show() {
  bindOnce();
  render();
}
on('events', () => visible('service') && render());

function render() {
  $('svc-ai').innerHTML = state.ai
    ? `<span class="st" style="background:var(--ok)"></span><div><b>ИИ подключён</b><p class="small muted">Посты разбирает нейросеть, правила подстраховывают: дата, цены и место из поста попадают в форму и в черновик из бота.</p></div>`
    : `<span class="st" style="background:var(--warn)"></span><div><b>Работают правила</b><p class="small muted">Посты разбираются без ИИ — привычные анонсы (дата, «двери 22:00», «первые 50 — 700₽», адрес) читаются уверенно. Для вольных текстов добавь в Vercel ключ POLZA_API_KEY или ANTHROPIC_API_KEY и сделай Redeploy.</p></div>`;
  $('svc-who').innerHTML = `Ты вошёл как <b>${esc(state.name || 'админ')}</b>. Ключ хранится только в этом браузере — на чужом телефоне после смены выйди из панели.`;
}

// «Настроить бота»: сервер регистрирует вебхук, команды и описание в
// Telegram (api/tg-webhook.js, action=setup). Токен остаётся на сервере.
async function setupBot() {
  const note = $('bot-note');
  note.textContent = 'Настраиваю…';
  const r = await busy($('svc-bot'), () => api('/api/tg-webhook', { method: 'POST', body: { action: 'setup' }, timeout: 30000 }));
  if (!r.ok) {
    note.textContent = `Не получилось: ${r.message}`;
    toast('Бот не настроен', 'err');
    return;
  }
  const j = r.j;
  const wh = j.webhook || {};
  const parts = [`${j.message || `Готово: @${j.bot?.username}`}.`];
  if (wh.url) parts.push(`Вебхук: ${wh.url}${wh.redirected_from ? ` (после редиректа с ${wh.redirected_from})` : ''}.`);
  if (wh.pending) parts.push(`В очереди Telegram: ${wh.pending}.`);
  parts.push(wh.last_error ? `Последняя ошибка Telegram: ${wh.last_error}.` : 'Ошибок доставки Telegram не видит.');
  if (j.delivery === null) parts.push('Проверочное сообщение не отправлено: TELEGRAM_CHAT_ID не задан.');
  else if (j.delivery?.ok) parts.push('Проверочное сообщение владельцу доставлено.');
  else parts.push(`Проверочное сообщение владельцу НЕ доставлено: ${j.delivery?.error || 'неизвестная ошибка'}.`);
  const w = j.welcome;
  if (w?.via === 'photo') parts.push('Приветствие с афишей отправлено тебе — так его увидит гость.');
  else if (w?.via === 'text') parts.push(`Приветствие отправлено текстом${w.photo_error ? ` (афиша не прошла: ${w.photo_error})` : ''}.`);
  else if (w) parts.push(`Приветствие НЕ отправлено: ${w.error || 'неизвестная ошибка'}.`);
  if (j.username_mismatch) {
    parts.push(`Внимание: в Vercel TELEGRAM_BOT_USERNAME=${j.username_mismatch.env}, а бот — @${j.username_mismatch.actual}. Исправь переменную, иначе кнопки на сайте ведут не туда.`);
  }
  note.textContent = parts.join(' ');
  toast('Бот настроен');
}

// Боевой самотест: бронь → подтверждение → проходка → скан → повтор →
// статистика → уборка. Ключ не покидает устройство.
const TEST_PHONE = '+70000000000'; // маркер тестовых заказов, их чистит cleanupTest
async function selfTest() {
  const list = $('selftest-list');
  const note = $('svc-note');
  list.innerHTML = '';
  note.textContent = 'Проверяю…';
  const row = (ok, name, detail = '') => {
    list.insertAdjacentHTML('beforeend', `<div class="feed-i"><span class="dot ${ok ? 'dot-ok' : 'dot-bad'}"></span>
      <span class="w"><b>${ok ? 'OK' : 'Ошибка'}</b> · ${esc(name)}</span>${detail ? `<span class="by">${esc(String(detail).slice(0, 48))}</span>` : ''}</div>`);
    return ok;
  };
  await busy($('svc-selftest'), async () => {
    try {
      const ev = await api('/api/events');
      const live = ev.ok && !ev.j.degraded && ev.j.events?.length;
      if (!row(Boolean(live), 'база отвечает, афиша живая', live ? `${ev.j.events.length} ночей` : 'нет данных')) throw new Error('stop');
      const target = ev.j.events.find((e) => e.status === 'onsale' && activeWave(e.waves));
      if (!row(Boolean(target), 'есть ночь в продаже', target?.title || 'нет')) throw new Error('stop');
      const wave = activeWave(target.waves);

      const order = await api('/api/order', {
        method: 'POST',
        body: {
          event_id: target.id, wave_no: wave.waveNo,
          buyer: { name: 'ТЕХ. ПРОВЕРКА', phone: TEST_PHONE },
          attendees: [{ name: 'ТЕХ. ПРОВЕРКА', minor: false }],
          consent: true, website: '',
        },
      });
      const ticket = order.ok && order.j.tickets?.[0];
      if (!row(Boolean(ticket), 'бронь проходит', ticket ? `${order.j.order_id}${order.j.pay_code ? ' · ' + order.j.pay_code : ''}` : order.message)) throw new Error('stop');
      const token = ticket.url.replace('/t/', '');

      if (order.j.payment?.status === 'pending') {
        const v0 = await api(`/api/verify?token=${encodeURIComponent(token)}`);
        row(v0.j?.status === 'reserved', 'до оплаты проходка не пускает', v0.j?.status);
        const conf = await api('/api/walkin', { method: 'POST', body: { action: 'confirm', order_id: order.j.order_id, provider: 'transfer', by: 'самотест' } });
        if (!row(conf.ok, 'подтверждение оплаты включает проходку', conf.ok ? conf.j.pay_code : conf.message)) throw new Error('stop');
      }
      const t = await api(`/api/ticket?token=${encodeURIComponent(token)}`);
      row(Boolean(t.ok && t.j.ticket), 'проходка открывается', t.j?.ticket?.holderName);
      const v1 = await api(`/api/verify?token=${encodeURIComponent(token)}`);
      row(v1.j?.status === 'active', 'скан: проходка активна', v1.j?.status);
      let c1 = await api('/api/checkin', { method: 'POST', body: { token, by: 'самотест' } });
      // ночь ещё не началась (самотест обычно гоняют заранее): дверь обязана
      // сказать «не та ночь», а впустить — только по явному подтверждению
      if (c1.j?.error === 'wrong_night') {
        row(true, 'проходка до дня ночи не пускается без подтверждения', c1.j.night === 'early' ? 'ночь ещё не началась' : 'ночь уже прошла');
        c1 = await api('/api/checkin', { method: 'POST', body: { token, by: 'самотест', force: true } });
      }
      row(c1.ok && c1.j.first === true, 'вход: впущен', c1.j?.checked_in_at ? fmtTime(c1.j.checked_in_at) : c1.message);
      const c2 = await api('/api/checkin', { method: 'POST', body: { token, by: 'самотест', force: true } });
      row(c2.ok && c2.j.first === false, 'повторный вход отклонён');
      const st = await api(`/api/stats?event_id=${encodeURIComponent(target.id)}`);
      row(Boolean(st.ok && st.j.sold >= 1 && st.j.checked_in >= 1), 'статистика видит продажу и вход', st.ok ? `продано ${st.j.sold}, вошло ${st.j.checked_in}` : '');
      const cl = await api('/api/seed', { method: 'POST', body: { cleanupTest: true } });
      row(cl.ok, 'тестовые данные убраны, места вернулись', cl.ok ? `заказов: ${cl.j.cleaned}` : '');
      note.textContent = 'Самотест завершён — если всё зелёное, боевая связка работает.';
      loadStats();
    } catch {
      note.textContent = 'Самотест остановлен на красном шаге — смотри список ниже.';
    }
  });
}

async function seed() {
  const note = $('seed-note');
  note.textContent = 'Инициализирую…';
  const r = await busy($('svc-seed'), () => api('/api/seed', { method: 'POST', body: { demoSold: $('svc-demo').checked }, timeout: 30000 }));
  if (r.ok) {
    note.textContent = `Готово: схема применена, ночей засеяно — ${r.j.seeded}. Перезагружаю…`;
    setTimeout(() => location.reload(), 1200);
  } else {
    note.textContent = `Не получилось: ${r.message || 'проверь, что DATABASE_URL добавлен и сделан Redeploy'}`;
  }
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  $('svc-bot').onclick = setupBot;
  $('svc-selftest').onclick = selfTest;
  $('svc-seed').onclick = seed;
}
