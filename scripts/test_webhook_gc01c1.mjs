import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';

// Variables globales para simular el entorno
const SECRET = 'test-secret';
process.env.BSALE_WEBHOOK_RECEIVER_KEY = SECRET;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

let mockInsertResult = { error: null };
let insertedPayloads = [];

// Mock global fetch para interceptar llamadas de Supabase
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (url.toString().includes('/rest/v1/bsale_webhook_events')) {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      insertedPayloads.push(body);

      const headers = { get: () => null };
      if (mockInsertResult.error) {
        return {
          ok: false,
          status: 409,
          headers,
          json: async () => mockInsertResult.error,
          text: async () => JSON.stringify(mockInsertResult.error)
        };
      }
      return {
        ok: true,
        status: 201,
        headers,
        json: async () => [body],
        text: async () => JSON.stringify([body])
      };
    }
  }
  return originalFetch(url, options);
};


// Importar la ruta dinámicamente DESPUÉS de hacer los mocks de entorno
const route = await import('../src/app/api/integraciones/bsale/webhooks/payments/[key]/route.ts');

function createRequest(bodyStr, key = SECRET, contentType = 'application/json', method = 'POST') {
  return new NextRequest(`http://localhost/api/webhook/${key}`, {
    method,
    headers: { 'Content-Type': contentType },
    body: bodyStr
  });
}

function createJsonRequest(bodyObj, key = SECRET) {
  return createRequest(JSON.stringify(bodyObj), key);
}

test('1. Secret incorrecto (misma longitud) -> rechazo (404)', async () => {
  const req = createJsonRequest({}, 'test-secr3t'); // Same length
  const res = await route.POST(req, { params: Promise.resolve({ key: 'test-secr3t' }) });
  assert.equal(res.status, 404);
});

test('1b. Secret incorrecto (distinta longitud) -> rechazo (404)', async () => {
  const req = createJsonRequest({}, 'wrong-secret-long'); 
  const res = await route.POST(req, { params: Promise.resolve({ key: 'wrong-secret-long' }) });
  assert.equal(res.status, 404);
});

test('1c. Secret no configurado -> rechazo (404)', async () => {
  delete process.env.BSALE_WEBHOOK_RECEIVER_KEY;
  const req = createJsonRequest({}, SECRET);
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 404);
  process.env.BSALE_WEBHOOK_RECEIVER_KEY = SECRET; // restore
});

test('2. Content-Type inválido -> 400', async () => {
  const req = createRequest('{}', SECRET, 'text/plain');
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('3a. Content-Length explícito > 16KB -> 413 rápido', async () => {
  const req = createRequest('{}', SECRET, 'application/json');
  req.headers.set('content-length', '20000');
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 413);
});

test('3b. Body real > 16KB aunque Content-Length falte -> 413', async () => {
  const hugeBody = JSON.stringify({ cpnId: '1', resource: 'A'.repeat(17000), resourceId: 1, topic: 'payment', action: 'POST', send: 1000 });
  const req = createRequest(hugeBody, SECRET);
  req.headers.delete('content-length');
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 413);
});

test('3c. Body real > 16KB aunque Content-Length declare menos -> 413', async () => {
  const hugeBody = JSON.stringify({ cpnId: '1', resource: 'A'.repeat(17000), resourceId: 1, topic: 'payment', action: 'POST', send: 1000 });
  const req = createRequest(hugeBody, SECRET);
  req.headers.set('content-length', '100'); // Miente
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 413);
});

test('3d. Body exactamente en o bajo el límite -> permitido', async () => {
  insertedPayloads = [];
  const bodyUnderLimit = JSON.stringify({ cpnId: '1', resource: 'A'.repeat(10000), resourceId: 1, topic: 'payment', action: 'POST', send: 1000 });
  const req = createRequest(bodyUnderLimit, SECRET);
  req.headers.delete('content-length');
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 200);
});

test('4. JSON inválido -> 400', async () => {
  const req = createRequest('invalid-json{', SECRET);
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('5. Topic distinto de payment -> rechazo', async () => {
  const req = createJsonRequest({ cpnId: '1', resource: 'abc', resourceId: 1, topic: 'document', action: 'POST', send: 1000 });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('6. Action inválida -> rechazo', async () => {
  const req = createJsonRequest({ cpnId: '1', resource: 'abc', resourceId: 1, topic: 'payment', action: 'DELETE', send: 1000 });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('7. resourceId inválido -> rechazo', async () => {
  const req = createJsonRequest({ cpnId: '1', resource: 'abc', resourceId: 'abc', topic: 'payment', action: 'POST', send: 1000 });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('8. send inválido -> rechazo', async () => {
  const req = createJsonRequest({ cpnId: '1', resource: 'abc', resourceId: 1, topic: 'payment', action: 'POST', send: 'abc' });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 400);
});

test('9. Evento válido se acepta e inserta como UNMAPPED', async () => {
  insertedPayloads = [];
  mockInsertResult = { error: null };
  const req = createJsonRequest({ cpnId: 'mi-empresa', resource: '/v1/payments/10.json', resourceId: 10, topic: 'payment', action: 'PUT', send: 1690000000 });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 200);
  assert.equal(insertedPayloads.length, 1);
  assert.equal(insertedPayloads[0].status, 'UNMAPPED');
  assert.equal(insertedPayloads[0].cpn_id, 'mi-empresa');
});

test('10. Mismo evento repetido -> idempotente (200)', async () => {
  mockInsertResult = { error: { code: '23505', message: 'duplicate key' } };
  const req = createJsonRequest({ cpnId: '1', resource: 'abc', resourceId: 1, topic: 'payment', action: 'POST', send: 1000 });
  const res = await route.POST(req, { params: Promise.resolve({ key: SECRET }) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.message, 'Duplicate event acknowledged');
});
