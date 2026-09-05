// Единый конверт ответов: { ok: true, ... } | { ok: false, error, message }.
export function ok(res, data = {}, status = 200) {
  res.status(status).json({ ok: true, ...data });
}

export function fail(res, status, error, message, extra = {}) {
  res.status(status).json({ ok: false, error, message, ...extra });
}

export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

export function onlyMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  fail(res, 405, 'method_not_allowed', 'Метод не поддерживается');
  return false;
}
