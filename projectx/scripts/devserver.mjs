#!/usr/bin/env node
// Локальный стенд для тестов и обхода страниц: статика + rewrites как в
// vercel.json (cleanUrls, /e /t /s) + api/*.js через шим Vercel-хендлера
// (req.query, req.body, res.status().json()). На прод не выкладывается
// (.vercelignore). Запуск из папки projectx:
//   DEV_PGLITE=1 ADMIN_KEY=test-admin-123 TICKET_SECRET=<строка> PORT=8791 node scripts/devserver.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SITE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
};

const API = {};
for (const name of ['events', 'order', 'ticket', 'verify', 'checkin', 'stats', 'seed', 'cityrequest', 'tg-webhook', 'poster', 'walkin', 'event-upsert']) {
  try {
    API[`/api/${name}`] = (await import(path.join(ROOT, 'api', `${name}.js`))).default;
  } catch (e) {
    console.warn(`api/${name}.js не загружен:`, e.message);
  }
}

// rewrites из vercel.json: страницы без .html, /e/:slug → event, /t/:token → ticket, /s/:token → scan
function resolvePage(pathname) {
  if (pathname === '/') return '/index.html';
  if (/^\/e\/[^/]+$/.test(pathname)) return '/event.html';
  if (/^\/t\/[^/]+$/.test(pathname)) return '/ticket.html';
  if (/^\/s\/[^/]+$/.test(pathname)) return '/scan.html';
  if (!path.extname(pathname)) return `${pathname}.html`;
  return pathname;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API через шим ----
  if (API[pathname]) {
    req.query = Object.fromEntries(url.searchParams);
    req.body = await readBody(req);
    let code = 200;
    const shim = {
      status(c) { code = c; return shim; },
      setHeader(k, v) { res.setHeader(k, v); },
      json(obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); },
      send(body) { res.statusCode = code; res.end(body); },
      end(body) { res.statusCode = code; res.end(body); },
    };
    try {
      await API[pathname](req, shim);
    } catch (e) {
      console.error(pathname, e);
      if (!res.headersSent) { res.statusCode = 500; res.end('shim error: ' + e.message); }
    }
    return;
  }

  // ---- статика ----
  const rel = resolvePage(pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || /\/(node_modules|test|scripts)\//.test(file) || /BRIEF\.md$/.test(file)) {
    res.statusCode = 404; res.end('not found'); return;
  }
  let st;
  try { st = await stat(file); } catch { st = null; }
  if (!st || !st.isFile()) {
    // как у Vercel: своя страница 404, если есть
    try {
      const nf = await readFile(path.join(ROOT, '404.html'));
      res.statusCode = 404; res.setHeader('Content-Type', MIME['.html']); res.end(nf);
    } catch {
      res.statusCode = 404; res.end('not found');
    }
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const buf = await readFile(file);
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Content-Length', end - start + 1);
    res.end(buf.subarray(start, end + 1));
    return;
  }
  res.end(await readFile(file));
}).listen(PORT, () => console.log(`dev on :${PORT}`));
