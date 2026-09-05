// Волновое ценообразование — чистая логика без DOM.
// Волна: { waveNo, name, priceRub, quota, sold }.
// Состояния: past (распродана/закрыта) → active (продаётся сейчас) → next (ждёт).

export function waveStates(waves) {
  const sorted = [...waves].sort((a, b) => a.waveNo - b.waveNo);
  let activeFound = false;
  return sorted.map((w) => {
    const sold = clampInt(w.sold ?? 0, 0, w.quota);
    const left = w.quota - sold;
    let state;
    if (left <= 0) {
      state = 'past';
    } else if (!activeFound) {
      state = 'active';
      activeFound = true;
    } else {
      state = 'next';
    }
    return { ...w, sold, left, state };
  });
}

export function activeWave(waves) {
  return waveStates(waves).find((w) => w.state === 'active') || null;
}

// «от N ₽» для карточки: цена активной волны; всё распродано → null
export function fromPrice(waves) {
  const a = activeWave(waves);
  return a ? a.priceRub : null;
}

export function totalSold(waves) {
  return waves.reduce((s, w) => s + clampInt(w.sold ?? 0, 0, w.quota), 0);
}

export function totalQuota(waves) {
  return waves.reduce((s, w) => s + w.quota, 0);
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v) || 0);
  return Math.min(hi, Math.max(lo, n));
}

// ---- Демо-симуляция продаж (используется ТОЛЬКО без БД) ----
// Детерминирована: продажи «растут» по мере приближения ивента,
// джиттер — от 10-минутного ведра времени, НИКАКОГО Math.random.
const RAMP_DAYS = 30; // продажи открываются за 30 дней до старта

export function demoSold(eventId, waveNo, quota, startsAtMs, nowMs) {
  const saleStart = startsAtMs - RAMP_DAYS * 86400_000;
  const t = clamp((nowMs - saleStart) / (startsAtMs - saleStart), 0, 1);
  // волны заполняются каскадом: первая быстрее, следующая — со сдвигом
  const fill = clamp(t * 1.65 - (waveNo - 1) * 0.62, 0, 1);
  const bucket = Math.floor(nowMs / 600_000); // 10 минут
  const jitter = hash(`${eventId}:${waveNo}:${bucket}`) % 3; // 0..2 билета «живости»
  return Math.min(quota, Math.round(quota * fill) + (fill > 0 && fill < 1 ? jitter : 0));
}

export function demoWaves(event, nowMs) {
  const startsAtMs = Date.parse(event.startsAt);
  return event.waves.map((w) => ({
    ...w,
    sold: demoSold(event.id, w.waveNo, w.quota, startsAtMs, nowMs),
  }));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// FNV-1a — стабильный хеш для джиттера
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
