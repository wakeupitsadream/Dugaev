import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../assets/qr.js';

test('qrSvg строит валидный SVG с белой подложкой и тёмными модулями', () => {
  const svg = qrSvg('https://traphouse-demo.vercel.app/s/7k3f9qz2mx.abcdefghjkmnpqrstvwx');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('<path d="M'));
  assert.ok(svg.endsWith('</svg>'));
});

test('qrSvg детерминирован', () => {
  const url = 'https://example.com/s/abc';
  assert.equal(qrSvg(url), qrSvg(url));
});

test('разный текст — разный QR', () => {
  assert.notEqual(qrSvg('https://a.example'), qrSvg('https://b.example'));
});
