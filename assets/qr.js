// Рендер QR в SVG-строку. Без DOM — тестируется в node.
// Энкодер — вендоренный qrcode-generator (MIT), assets/vendor/qrcodegen.mjs.
import qrcode from './vendor/qrcodegen.mjs';

// ECC 'M' — устойчивость к бликам/трещинам экрана при коротком URL.
export function qrSvg(text, { ecc = 'M', margin = 2 } = {}) {
  const qr = qrcode(0, ecc); // 0 — автоподбор версии
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR-код билета">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#0a0a0c"/></svg>`
  );
}
