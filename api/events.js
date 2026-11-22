// GET  /api/events?venue=gillette  -> { ok, memory, records }   (newest first)
// POST /api/events  (event record)  -> { ok, id, memory }
// Runs as a Vercel function, and under `npm run dev` through the plugin in vite.config.js.
// Uses plain Node req/res so it behaves the same in both.

import { validateRecord, saveRecord, listRecords, BadRequest, MAX_BYTES } from '../server/events.js';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new BadRequest('send Content-Type: application/json', 415);
  if (Number(req.headers['content-length'] || 0) > MAX_BYTES) throw new BadRequest('body over 50 KB', 413);
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BYTES) throw new BadRequest('body over 50 KB', 413);
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadRequest('body is not valid JSON'); }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const venue = new URL(req.url, 'http://x').searchParams.get('venue') || 'gillette';
      const { records, memory, reason } = await listRecords(venue);
      return send(res, 200, { ok: true, memory, ...(reason && { reason }), records });
    }
    if (req.method === 'POST') {
      const rec = validateRecord(await readJson(req));
      const { id, memory, reason } = await saveRecord(rec);
      return send(res, 201, { ok: true, id, memory, ...(reason && { reason }) });
    }
    res.setHeader('allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'use GET or POST' });
  } catch (e) {
    if (e instanceof BadRequest) return send(res, e.status, { ok: false, error: e.message });
    console.error('api/events failed:', e?.name || 'Error'); // no message: it could carry request details
    return send(res, 500, { ok: false, error: 'server error' });
  }
}
