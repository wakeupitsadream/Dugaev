// Чекаут-шторка, которую можно тянуть пальцем.
//
// До этого шторка открывалась и закрывалась CSS-переходом: её нельзя было
// потянуть, поймать на лету и передумать. На телефоне это главный жест —
// человек тянет лист вниз, чтобы закрыть, и ждёт, что лист будет приклеен к
// пальцу, а после отпускания продолжит движение с той же скоростью.
//
// Здесь: 1:1-слежение за пальцем, сопротивление вверх за границей, бросок
// с проекцией инерции и передачей скорости в пружину, перехват анимации на
// любом кадре. Настольная раскладка (боковая панель) жест не получает —
// там мышь и есть кнопка закрытия.
import { springTo, projectMomentum, rubberband, velocityFrom } from './spring.js';

const DRAG_THRESHOLD = 10; // px — пока палец не сдвинулся, это ещё тап, а не перетаскивание
const DISMISS_RATIO = 0.35; // доля высоты: дальше неё бросок читается как «закрыть»
const NO_DRAG = 'input, textarea, select, button, a, label, [contenteditable]';

export function makeSheetDraggable({ sheet, isOpen, onClose }) {
  if (!sheet) return { close() {} };

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 760px)');

  let spring = null;      // текущая пружина, если шторка летит сама
  let dragging = false;   // палец уже увёл лист (порог пройден)
  let pending = false;    // палец опущен, ждём, тап это или перетаскивание
  let startY = 0;
  let baseY = 0;          // положение листа в момент захвата — с него и продолжаем
  let history = [];
  let pointerId = null;
  let suppressClick = false; // клик, которым поймали летящий лист, не должен нажимать кнопку

  const height = () => sheet.getBoundingClientRect().height || window.innerHeight;
  const setY = (y) => {
    sheet.style.transform = y === 0 ? '' : `translate3d(0, ${y}px, 0)`;
  };
  const liveY = () => {
    const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(sheet.style.transform || '');
    return m ? parseFloat(m[1]) : 0;
  };

  const stopSpring = () => {
    if (!spring || spring.done) return { value: liveY(), velocity: 0 };
    return spring.stop();
  };

  // Прогресс перетаскивания уводит подложку: чем дальше лист, тем светлее фон —
  // движение сообщает, куда всё идёт, ещё до того, как палец отпущен.
  const setProgress = (y) => {
    const p = Math.max(0, Math.min(1, y / height()));
    document.body.style.setProperty('--sheet-progress', String(1 - p));
  };
  const markDragging = (on) => {
    sheet.classList.toggle('is-dragging', on);
    document.body.classList.toggle('sheet-dragging', on);
  };
  const clearProgress = () => document.body.style.removeProperty('--sheet-progress');

  const finish = (y, velocity) => {
    const h = height();
    // Куда лист уедет по инерции — цель выбираем по проекции, а не по точке отпускания
    const projected = y + projectMomentum(velocity);
    const dismiss = projected > h * DISMISS_RATIO;
    const target = dismiss ? h : 0;
    // Перелёт уместен только после броска: медленное возвращение должно быть спокойным
    const damping = Math.abs(velocity) > 0.4 ? 0.82 : 1;

    if (reduced.matches) {
      setY(target);
      setProgress(target);
      markDragging(false);
      if (dismiss) onClose();
      else sheet.style.transform = '';
      return;
    }

    spring = springTo({
      from: y,
      to: target,
      velocity, // шов между пальцем и анимацией: скорость не теряется
      damping,
      response: 0.3,
      onUpdate: (v) => {
        setY(v);
        setProgress(v);
      },
      onRest: () => {
        sheet.style.transform = '';
        if (dismiss) clearProgress();
        else document.body.style.setProperty('--sheet-progress', '1');
        if (dismiss) onClose();
        // класс снимаем кадром позже: иначе CSS-переход подхватит остаток пути
        requestAnimationFrame(() => markDragging(false));
      },
    });
  };

  sheet.addEventListener('pointerdown', (e) => {
    if (!isOpen() || !mobile.matches || e.button !== 0) return;

    // Летящий лист можно поймать где угодно — это важнее правила «не таскать за
    // кнопки». Нажатие на кнопку во время полёта означает «останови», а не
    // «нажми»: сам клик после такого перехвата мы гасим.
    const flying = Boolean(spring) && !spring.done;
    if (!flying) {
      if (e.target.closest(NO_DRAG)) return;  // в покое по полям и кнопкам не таскаем
      if (sheet.scrollTop > 0) return;        // содержимое прокручено — сначала вверх
    } else {
      suppressClick = true;
    }

    const caught = stopSpring();              // перехват: продолжаем с того места, где поймали
    spring = null;
    baseY = caught.value;
    startY = e.clientY;
    history = [{ t: e.timeStamp, y: e.clientY }];
    pending = true;
    pointerId = e.pointerId;
    setY(baseY);
    // Без этого браузер начинает своё перетаскивание текста и забирает
    // указатель себе — жест обрывается на середине (pointercancel).
    e.preventDefault();
  });

  sheet.addEventListener('dragstart', (e) => e.preventDefault());

  sheet.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true // на перехвате, до обработчиков кнопок
  );

  sheet.addEventListener('pointermove', (e) => {
    if (!pending || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    history.push({ t: e.timeStamp, y: e.clientY });
    if (history.length > 12) history.shift();

    if (!dragging) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return; // порог: тап не должен дёргать лист
      // Палец пошёл вверх. Если лист стоит на месте — это прокрутка содержимого,
      // а не жест. Но если лист уже смещён вниз (тянут или поймали в полёте),
      // движение вверх возвращает его назад — это продолжение жеста.
      if (dy < 0 && baseY <= 1 && sheet.scrollTop <= 0 && sheet.scrollHeight > sheet.clientHeight) {
        pending = false;
        return;
      }
      dragging = true;
      markDragging(true);
      sheet.setPointerCapture(pointerId); // палец может уехать за пределы листа
    }

    const raw = baseY + dy;
    // Вверх за границу — сопротивление, а не жёсткий упор
    const y = raw < 0 ? -rubberband(-raw, height()) : raw;
    setY(y);
    setProgress(y);
    e.preventDefault();
  });

  const release = (e) => {
    if (!pending || (pointerId !== null && e.pointerId !== pointerId)) return;
    const wasDragging = dragging;
    pending = false;
    dragging = false;
    pointerId = null;
    if (!wasDragging) return; // это был тап — ничего не двигаем

    if (e.type === 'pointercancel') {
      // Систему что-то отвлекло (звонок, жест ОС). Намерения закрыть не было —
      // возвращаем лист на место, а не додумываем за человека.
      finish(liveY(), 0);
      return;
    }
    history.push({ t: e.timeStamp, y: e.clientY });
    finish(liveY(), velocityFrom(history));
  };

  sheet.addEventListener('pointerup', release);
  sheet.addEventListener('pointercancel', release);

  return {
    // закрытие кнопкой/подложкой — той же пружиной и по тому же пути, что и жестом
    close() {
      if (!mobile.matches || reduced.matches) {
        sheet.style.transform = '';
        clearProgress();
        onClose();
        return;
      }
      const caught = stopSpring();
      spring = springTo({
        from: caught.value,
        to: height(),
        velocity: caught.velocity,
        damping: 1,
        response: 0.3,
        onUpdate: (v) => {
          setY(v);
          setProgress(v);
        },
        onRest: () => {
          onClose();
          sheet.style.transform = '';
          clearProgress();
          requestAnimationFrame(() => markDragging(false));
        },
      });
      markDragging(true); // на время полёта CSS-переход не мешает
    },
    // открытие: сбросить следы прошлого жеста
    reset() {
      stopSpring();
      spring = null;
      sheet.style.transform = '';
      document.body.style.setProperty('--sheet-progress', '1');
      markDragging(false);
    },
  };
}
