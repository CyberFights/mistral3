// The production path: the gateway talks to Mistral over HTTPS.
//
// The other tests use a plain-HTTP stand-in. These run the real gateway
// process against an HTTPS stand-in to check that TLS works and, above all,
// that the gateway refuses to talk to a server it cannot verify. The Mistral
// API key must never be sent to an impostor.
//
// A throwaway certificate is generated with the openssl command for each run;
// without openssl the tests are skipped.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMockMistral } from './support/mock-mistral.js';
import { GATEWAY_KEY, MISTRAL_KEY, userSays, waitFor } from './support/stack.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}
const test = (name, fn) => nodeTest(name, { timeout: 30_000, skip: hasOpenssl ? false : 'the openssl command is not available' }, fn);

/** Creates a self-signed certificate valid for the given host names. */
function makeCertificate(t, names) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath,
    '-subj', `/CN=${names[0]}`,
    '-addext', `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`,
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), certPath };
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Runs the gateway process against an HTTPS stand-in that uses `certificate`. */
async function launch(t, certificate, { trust }) {
  const mock = await startMockMistral({ apiKey: MISTRAL_KEY, tls: { key: certificate.key, cert: certificate.cert } });
  t.after(() => mock.close());
  const port = await freePort();
  const env = { PATH: process.env.PATH, MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: GATEWAY_KEY, MISTRAL_BASE_URL: mock.url, PORT: String(port) };
  if (trust) env.NODE_EXTRA_CA_CERTS = certificate.certPath;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const lines = () => stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitFor(() => /listening/i.test(stdout), { timeoutMs: 5000, what: 'the gateway to start listening' });
  const chat = (body) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const logFor = (match) => waitFor(() => lines().find(match), { what: 'the request log line' });
  return { mock, chat, lines, logFor, output: () => stdout };
}

test('over HTTPS with a certificate it can verify, completions and streams work', async (t) => {
  const certificate = makeCertificate(t, ['localhost']);
  const { mock, chat, lines } = await launch(t, certificate, { trust: true });
  assert.match(mock.url, /^https:\/\/localhost:/);
  assert.ok(!lines().some((line) => line.level === 'warn'), 'an https upstream needs no warning');

  const plain = await chat(userSays('over tls'));
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).choices[0].message.content, 'echo: over tls');
  assert.equal(mock.last.headers.authorization, `Bearer ${MISTRAL_KEY}`);

  const stream = await chat({ ...userSays('one two three four'), stream: true });
  assert.equal(stream.status, 200);
  const arrivals = [];
  let text = '';
  for await (const chunk of stream.body) {
    arrivals.push(performance.now());
    text += new TextDecoder().decode(chunk);
  }
  assert.equal(text, mock.last.responseText, 'the stream must be relayed byte for byte over TLS too');
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.ok(arrivals.length >= 4 && arrivals.at(-1) - arrivals[0] >= 60, 'the stream must not be buffered over TLS');

  // Upstream errors are explained over TLS too.
  const rejected = await chat({ ...userSays('x'), logit_bias: { 1: 1 } });
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error.message, /logit_bias: Extra inputs are not permitted/);
});

test('an upstream whose certificate cannot be verified is refused, and the key is never sent', async (t) => {
  const certificate = makeCertificate(t, ['localhost']);
  const { mock, chat, logFor, output } = await launch(t, certificate, { trust: false });

  const res = await chat(userSays('to an impostor'));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'upstream_unreachable');

  const entry = await logFor((line) => line.error === 'upstream_unreachable');
  assert.match(entry.upstreamError, /SELF_SIGNED|UNABLE_TO_VERIFY/);
  assert.equal(mock.requests.length, 0, 'the connection must fail before any request, and so before the key, is sent');
  assert.ok(!output().includes(MISTRAL_KEY));
});

test('a verifiable certificate issued for a different host name is refused, and the key is never sent', async (t) => {
  // Trusted, but for another name: the stand-in is reached as "localhost".
  const certificate = makeCertificate(t, ['api.some-other-host.example']);
  const { mock, chat, logFor } = await launch(t, certificate, { trust: true });

  const res = await chat(userSays('to the wrong host'));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'upstream_unreachable');

  const entry = await logFor((line) => line.error === 'upstream_unreachable');
  assert.equal(entry.upstreamError, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(mock.requests.length, 0);
});
