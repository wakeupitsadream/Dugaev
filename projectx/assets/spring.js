// Пружина на requestAnimationFrame — без библиотек (сайт собирается без сборщика).
//
// Зачем не CSS-переход: переход нельзя перехватить на лету. Если гость тянет
// шторку, отпускает и тут же хватает снова, анимация обязана продолжиться с той
// точки, где палец её застал, и с той скоростью, с которой она шла. Пружина это
// умеет по своей природе: новая цель — просто новое значение, движение
// непрерывно.
//
// Параметры взяты в терминах Apple (WWDC «Designing Fluid Interfaces»), а не
// физики: damping (коэффициент затухания, 1 = без перелёта) и response (за
// сколько секунд значение приходит к цели). Пересчёт в жёсткость/трение:
//   k = (2π / response)²   c = 2 · damping · √k
const TAU = Math.PI * 2;
const REST_DELTA = 0.05; // px — ближе этого к цели глаз уже не различает
const REST_SPEED = 0.05; // px/ms

export function springTo({
  from,
  to,
  velocity = 0, // px/ms, знак сохраняем — это скорость пальца при отпускании
  damping = 1,
  response = 0.35,
  onUpdate,
  onRest,
}) {
  const k = (TAU / response) ** 2 / 1_000_000; // 1/мс², чтобы считать в миллисекундах
  const c = (2 * damping * TAU) / response / 1000;

  let value = from;
  let v = velocity;
  let target = to;
  let raf = 0;
  let prev = null;
  let stopped = false;

  const step = (now) => {
    if (stopped) return;
    if (prev === null) prev = now;
    // Кадр мог быть длинным (вкладка ушла в фон) — режем шаг, иначе пружину
    // «выстреливает» за пределы экрана.
    let dt = Math.min(now - prev, 32);
    prev = now;

    // Интегрируем мелкими шагами: на длинном кадре явная схема разъезжается.
    for (let t = 0; t < dt; t += 1) {
      const h = Math.min(1, dt - t);
      const a = -k * (value - target) - c * v;
      v += a * h;
      value += v * h;
    }

    onUpdate(value);

    if (Math.abs(value - target) < REST_DELTA && Math.abs(v) < REST_SPEED) {
      value = target;
      onUpdate(value);
      stopped = true;
      onRest?.();
      return;
    }
    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);

  return {
    // перехват: вернуть текущее положение и скорость, чтобы продолжить с них
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      return { value, velocity: v };
    },
    // сменить цель на лету, не теряя скорость (без «кирпичной стены» при развороте)
    retarget(next) {
      target = next;
    },
    get done() {
      return stopped;
    },
  };
}

// Куда уедет объект, если отпустить его с этой скоростью. Экспоненциальное
// затухание — та же формула, что у инерционной прокрутки iOS; учебное
// v²/(2a) даёт заметно другой (более короткий) бросок.
export function projectMomentum(velocity /* px/ms */, decelerationRate = 0.998) {
  return (velocity * decelerationRate) / (1 - decelerationRate);
}

// Сопротивление за границей: чем дальше тянут, тем меньше объект следует за
// пальцем. Жёсткий стоп читается как «залипло», прогрессивное — как «дальше нет».
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Скорость по короткой истории точек (последние ~100 мс), а не по двум
// последним событиям: одиночный кадр даёт шумную оценку и рваный бросок.
export function velocityFrom(history, windowMs = 100) {
  if (history.length < 2) return 0;
  const last = history[history.length - 1];
  let first = history[0];
  for (let i = history.length - 1; i >= 0; i--) {
    if (last.t - history[i].t > windowMs) break;
    first = history[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.y - first.y) / dt; // px/ms
}
