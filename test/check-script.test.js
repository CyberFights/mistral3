// scripts/check.js is what tells a deployment apart from a working deployment,
// so it is tested like the rest: run for real, as a separate process, against
// the gateway and the Mistral stand-in.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATEWAY_KEY, MISTRAL_KEY, SECOND_GATEWAY_KEY, startStack } from './support/stack.js';

const SCRIPT = fileURLToPath(new URL('../scripts/check.js', import.meta.url));
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);

/** Runs the script and resolves with its exit code and output. */
function runCheck(args, env = {}) {
  return new Promise((resolve, reject) => {
    // The servers under test live in this process, so the script must run
    // alongside it (spawn), never block it (spawnSync).
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lines = (stdout, marker) => stdout.split('\n').filter((line) => line.startsWith(`  ${marker}`));

test('against a working gateway every check passes', async (t) => {
  const stack = await startStack(t);
  const { code, stdout, stderr } = await runCheck([stack.url], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 0, stdout + stderr);
  assert.equal(lines(stdout, 'ok').length, 7, stdout);
  assert.equal(lines(stdout, 'FAIL').length, 0, stdout);
  assert.match(stdout, /All 7 checks passed\./);
  assert.match(stdout, /serves "mistral-large-2512"/);
  assert.ok(!stdout.includes('Note:'), `no notes expected:\n${stdout}`);

  // It really exercised the adjustments: this is the request "written the way
  // OpenAI apps write it", as the stand-in received it.
  const translated = stack.mock.requests.map((request) => request.body).find((body) => body?.random_seed === 1);
  assert.ok(translated, 'the OpenAI-style request should have reached the stand-in');
  assert.equal(translated.max_tokens, 16);
  assert.deepEqual(translated.messages.map((message) => message.role), ['system', 'user']);
  for (const field of ['seed', 'store', 'user', 'max_completion_tokens', 'stop']) assert.ok(!(field in translated), field);
  // And a tool call with its follow-up.
  assert.ok(stack.mock.requests.some((request) => request.body?.messages?.at(-1)?.role === 'tool'));
});

test('the address may be given with a trailing slash or /v1, and the key as a list', async (t) => {
  const stack = await startStack(t);
  for (const address of [`${stack.url}/`, `${stack.url}/v1`, `${stack.url}/v1/`]) {
    const { code, stdout } = await runCheck([address], { GATEWAY_API_KEY: ` ${SECOND_GATEWAY_KEY} , another-key-that-is-not-used` });
    assert.equal(code, 0, `${address}\n${stdout}`);
  }
  // The address can also come from GATEWAY_URL.
  const viaEnv = await runCheck([], { GATEWAY_API_KEY: GATEWAY_KEY, GATEWAY_URL: stack.url });
  assert.equal(viaEnv.code, 0, viaEnv.stdout);
});

test('a request field that Mistral refuses is reported by name, and the other checks still run', async (t) => {
  const stack = await startStack(t);
  // The first request that reaches Mistral is answered the way the real API
  // answers a field it does not accept.
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'max_tokens'], msg: 'Extra inputs are not permitted', input: 16 }] }));
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.deepEqual(lines(stdout, 'FAIL'), ['  FAIL  Mistral answers a chat request']);
  assert.match(stdout, /HTTP 422: Mistral rejected the request: max_tokens: Extra inputs are not permitted \[extra_forbidden\]/);
  assert.equal(lines(stdout, 'ok').length, 6, stdout);
  assert.match(stdout, /6 of 7 checks passed\./);
});

test('a wrong MISTRAL_API_KEY on the server is named as the cause', async (t) => {
  const stack = await startStack(t, { upstreamKey: 'a-different-mistral-key-0123456789' });
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}Mistral answers a chat request\n\s+HTTP 502: The gateway is misconfigured: Mistral rejected its API key\. Check MISTRAL_API_KEY\. \[upstream_auth_failed\]\n\s+Set MISTRAL_API_KEY on the service/);
  // The three checks that never reach Mistral pass; the rest would only
  // repeat the same failure, so they are skipped.
  assert.equal(lines(stdout, 'ok').length, 3, stdout);
  assert.deepEqual(lines(stdout, 'FAIL').length, 1, stdout);
  assert.match(stdout, /The remaining 3 checks were skipped/);
  assert.match(stdout, /3 of 7 checks passed\./);
});

test('a model that Mistral no longer serves is named as the cause', async (t) => {
  // The gateway is set to serve a model the stand-in does not have, which is
  // what a retired model looks like.
  const stack = await startStack(t, { env: { MISTRAL_MODEL: 'mistral-large-2411' } });
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /ok {4}The gateway key is accepted \(serves "mistral-large-2411"\)/);
  assert.match(stdout, /FAIL {2}Mistral answers a chat request\n\s+HTTP 400: Invalid model: mistral-large-2411 \[1500\]\n\s+Mistral does not serve "mistral-large-2411" to this account\. If the model has been retired, set MISTRAL_MODEL/);
  assert.match(stdout, /The remaining 3 checks were skipped/);
});

test('a retired model answered with 404 is named as the cause too', async (t) => {
  const stack = await startStack(t);
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 404, { detail: 'Model not found' }));
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /HTTP 404: Model not found\n\s+Mistral does not serve "mistral-large-2512" to this account/);
});

test('a wrong gateway key stops the run with an explanation', async (t) => {
  const stack = await startStack(t);
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: 'not-the-right-gateway-key-000000' });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}The gateway key is accepted\n\s+The gateway refused this key\./);
  assert.match(stdout, /The remaining 4 checks were skipped/);
  assert.match(stdout, /2 of 7 checks passed\./);
  assert.equal(stack.mock.requests.length, 0, 'nothing may reach Mistral with a wrong key');
  assert.ok(!stdout.includes('not-the-right-gateway-key'), 'the key itself is never printed');
});

test('the Mistral key does not pass for a gateway key', async (t) => {
  const stack = await startStack(t);
  const { code, stdout } = await runCheck([stack.url], { GATEWAY_API_KEY: MISTRAL_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /not the Mistral key/);
});

test('an address where nothing listens is reported as a connection problem', async (t) => {
  // Find a free port, then close it again so that nothing is listening there.
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const { code, stdout } = await runCheck([`http://127.0.0.1:${port}`], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL {2}The gateway is up\n\s+Could not connect to http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
  assert.match(stdout, /The remaining 6 checks were skipped/);
  assert.match(stdout, /0 of 7 checks passed\./);
});

test('an address that is not the gateway fails the first check without sending the key onward', async (t) => {
  // A server that redirects everything, as a wrong or parked address might.
  const seen = [];
  const { createServer } = await import('node:http');
  const other = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' });
    res.end();
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));

  const { code, stdout } = await runCheck([`http://127.0.0.1:${other.address().port}`], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /answered with a redirect to http:\/\/127\.0\.0\.1:9\/elsewhere/);
  assert.deepEqual(seen, [undefined], 'only the keyless health request was sent, and the redirect was not followed');
});

test('it refuses to start without an address, without a key, or over plain http', async () => {
  const noAddress = await runCheck([], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(noAddress.code, 2);
  assert.match(noAddress.stderr, /No address given\.[\s\S]*Usage:/);

  const noKey = await runCheck(['https://example.invalid']);
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /GATEWAY_API_KEY is not set\./);

  const notAUrl = await runCheck(['my-service'], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(notAUrl.code, 2);
  assert.match(notAUrl.stderr, /is not a valid address/);

  // Nothing is sent: the key would travel unencrypted.
  const plainHttp = await runCheck(['http://example.invalid'], { GATEWAY_API_KEY: GATEWAY_KEY });
  assert.equal(plainHttp.code, 2);
  assert.match(plainHttp.stderr, /Use the https:\/\/ address/);
  assert.equal(plainHttp.stdout, '');
});
