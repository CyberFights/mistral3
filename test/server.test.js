// Runs the real entry point (node src/server.js) as its own process, the way
// Railway does: configured only through environment variables, stopped with
// signals.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMockMistral } from './support/mock-mistral.js';
import { GATEWAY_KEY, MISTRAL_KEY, sleep, userSays, waitFor } from './support/stack.js';

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Starts the gateway process with exactly the given environment. */
function launch(t, env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '', lines: [], exit: null };
  child.stdout.on('data', (chunk) => {
    run.stdout += chunk;
    run.lines = run.stdout.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { unparseable: line };
      }
    });
  });
  child.stderr.on('data', (chunk) => { run.stderr += chunk; });
  run.exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    run.exit = { code, signal };
    resolve(run.exit);
  }));
  run.line = (match, what) => waitFor(() => run.lines.find(match), { timeoutMs: 5000, what });
  t.after(() => {
    if (run.exit === null) child.kill('SIGKILL');
  });
  return run;
}

/** Starts the gateway process in front of a stand-in upstream and waits until it listens. */
async function launchWithUpstream(t) {
  const mock = await startMockMistral({ apiKey: MISTRAL_KEY });
  t.after(() => mock.close());
  const port = await freePort();
  const run = launch(t, { MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: GATEWAY_KEY, MISTRAL_BASE_URL: mock.url, PORT: String(port) });
  await run.line((line) => /listening/i.test(line.message ?? ''), 'the gateway to start listening');
  return { run, mock, port, url: `http://127.0.0.1:${port}` };
}

const chatRequest = (url, body, options = {}) => fetch(`${url}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
  ...options,
});

const canConnect = (port, host) => new Promise((resolve) => {
  const socket = net.connect(port, host);
  socket.on('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});

// ---------------------------------------------------------------------------

test('with no variables set, the process exits with an error instead of serving', async (t) => {
  const run = launch(t, {});
  const exit = await run.exited;
  assert.equal(exit.code, 1);
  assert.equal(run.stderr, '');
  assert.ok(run.lines.every((line) => line.level === 'error'), 'every line should be a JSON error line');
  assert.match(run.stdout, /MISTRAL_API_KEY is not set/);
  assert.match(run.stdout, /GATEWAY_API_KEY is not set/);
  assert.match(run.stdout, /did not start/);
});

test('with only the Mistral key set, the process still refuses to start', async (t) => {
  const run = launch(t, { MISTRAL_API_KEY: MISTRAL_KEY });
  assert.equal((await run.exited).code, 1);
  assert.match(run.stdout, /GATEWAY_API_KEY is not set/);
});

test('it starts on PORT, answers the health check, and says what it is serving', async (t) => {
  const { run, port, url } = await launchWithUpstream(t);
  const started = run.lines[0];
  assert.equal(started.level, 'info');
  assert.equal(started.port, port);
  assert.equal(started.model, 'mistral-large-2512');
  assert.equal(started.gatewayKeys, 1);

  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(run.stderr, '');
});

test('it accepts connections over both IPv4 and IPv6', async (t) => {
  const { port } = await launchWithUpstream(t);
  assert.equal(await canConnect(port, '127.0.0.1'), true, 'IPv4');
  const hasIPv6 = Object.values(os.networkInterfaces()).flat().some((address) => address.family === 'IPv6' && address.internal);
  if (!hasIPv6) {
    t.diagnostic('this machine has no IPv6 loopback; IPv6 not checked');
    return;
  }
  assert.equal(await canConnect(port, '::1'), true, 'IPv6');
});

test('a complete request works through the real process, and its output holds no secrets', async (t) => {
  const { run, url } = await launchWithUpstream(t);
  const prompt = 'private-prompt-from-the-process-test';
  const res = await chatRequest(url, { ...userSays(prompt), stream: true });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  await run.line((line) => line.path === '/v1/chat/completions', 'the request log line');

  assert.ok(run.lines.every((line) => !line.unparseable), 'every output line must be a JSON object');
  for (const secret of [MISTRAL_KEY, GATEWAY_KEY, prompt]) {
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), `"${secret}" appeared in the process output`);
  }
});

test('idle connections are kept slightly longer than the 60 seconds Railway keeps them', async (t) => {
  const { url } = await launchWithUpstream(t);
  const res = await fetch(`${url}/health`);
  await res.text();
  const seconds = Number(/timeout=(\d+)/.exec(res.headers.get('keep-alive') ?? '')?.[1]);
  assert.ok(seconds > 60, `keep-alive timeout is ${seconds} seconds`);
});

test('on SIGTERM a stream in progress is finished, then the process exits cleanly', async (t) => {
  const { run, mock, url, port } = await launchWithUpstream(t);
  mock.next(async (req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 20; i++) {
      res.write(sseChunk('id', { content: `${i} ` }));
      await sleep(40); // about 800 ms in total
    }
    res.end('data: [DONE]\n\n');
  });

  const res = await chatRequest(url, { ...userSays('hi'), stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });

  run.child.kill('SIGTERM'); // a new deployment is taking over
  await run.line((line) => /SIGTERM received/.test(line.message ?? ''), 'the shutdown log line');
  assert.equal(await canConnect(port, '127.0.0.1'), false, 'no new connections once shutdown has begun');

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.ok(text.endsWith('data: [DONE]\n\n'), 'the stream must run to its end');
  assert.equal(text.split('\n\n').filter(Boolean).length, 21);

  const exit = await run.exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(run.stdout, /All requests finished/);
});

test('on SIGTERM with only idle connections open, the process exits promptly', async (t) => {
  const { run, url } = await launchWithUpstream(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await new Promise((resolve, reject) => {
    http.get(`${url}/health`, { agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  assert.equal(Object.keys(agent.freeSockets).length, 1, 'the test needs an idle connection left open');

  const startedAt = Date.now();
  run.child.kill('SIGTERM');
  const exit = await run.exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.ok(Date.now() - startedAt < 3000, 'it must not wait out the keep-alive timeout');
});

test('a connection that goes idle during shutdown does not hold the process open', async (t) => {
  const { run, mock, url } = await launchWithUpstream(t);
  mock.next(async (req, res, body, { sendJson }) => {
    await sleep(400);
    sendJson(res, 200, { ok: true });
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const body = JSON.stringify(userSays('hi'));
  const answered = new Promise((resolve, reject) => {
    const req = http.request(`${url}/v1/chat/completions`, {
      method: 'POST',
      agent,
      headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  await waitFor(() => mock.requests.length === 1, { what: 'the request to be in flight' });

  const startedAt = Date.now();
  run.child.kill('SIGTERM');
  const { status, text } = await answered;
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(text), { ok: true });
  // The client would happily keep this connection open and idle.
  const exit = await run.exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.ok(Date.now() - startedAt < 3000, `took ${Date.now() - startedAt} ms to exit after the last response`);
});

test('a second SIGTERM stops the process at once, even with a request in flight', async (t) => {
  const { run, mock, url } = await launchWithUpstream(t);
  mock.next(() => { /* never answers */ });
  const pending = chatRequest(url, userSays('hi')).catch(() => 'failed');
  await waitFor(() => mock.requests.length === 1, { what: 'the request to be in flight' });

  run.child.kill('SIGTERM');
  await run.line((line) => /SIGTERM received/.test(line.message ?? ''), 'the first shutdown line');
  await sleep(100);
  assert.equal(run.exit, null, 'still waiting for the request in flight');

  run.child.kill('SIGTERM');
  const exit = await run.exited;
  assert.equal(exit.code, 1);
  assert.equal(await pending, 'failed');
});

test('if the port is already taken, the process says so and exits', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  const run = launch(t, { MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: GATEWAY_KEY, PORT: String(port) });
  assert.equal((await run.exited).code, 1);
  assert.match(run.stdout, new RegExp(`Could not listen on port ${port}`));
});
