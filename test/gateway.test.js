import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { test as nodeTest } from 'node:test';
import { GATEWAY_KEY, MISTRAL_KEY, SECOND_GATEWAY_KEY, sleep, startStack, userSays, waitFor } from './support/stack.js';

// Every test here waits on network events. A limit per test means a bug that
// makes one of them wait forever is reported as that test failing, and the
// others still run.
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Sends raw bytes over a socket and returns everything the server sent back. */
function rawExchange(port, text, { waitMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the server kept the connection open for more than ${waitMs} ms`));
    }, waitMs);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {}); // a reset after the response is fine
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ response: Buffer.concat(chunks).toString('latin1'), elapsedMs: Date.now() - startedAt });
    });
  });
}

// ---------------------------------------------------------------------------
// Health and public routes
// ---------------------------------------------------------------------------

test('GET /health answers without a key, never contacts Mistral, and is not logged', async (t) => {
  const stack = await startStack(t);
  const res = await fetch(`${stack.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await sleep(30);
  assert.equal(stack.mock.requests.length, 0);
  assert.equal(stack.logs.length, 0);
});

test('/health works with the Host header Railway uses for deploy checks', async (t) => {
  const stack = await startStack(t);
  const { response } = await rawExchange(stack.port, 'GET /health HTTP/1.1\r\nHost: healthcheck.railway.app\r\nConnection: close\r\n\r\n');
  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.match(response, /\{"status":"ok"\}$/);
});

test('GET / says the service is up without revealing the model or any key', async (t) => {
  const stack = await startStack(t);
  const res = await fetch(`${stack.url}/`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(JSON.parse(text).status, 'ok');
  assert.ok(!text.includes('mistral-large-2512'));
  assert.ok(!text.includes(GATEWAY_KEY) && !text.includes(MISTRAL_KEY));
});

test('HEAD /health answers with no body', async (t) => {
  const stack = await startStack(t);
  const res = await fetch(`${stack.url}/health`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('public routes only accept GET and HEAD', async (t) => {
  const stack = await startStack(t);
  const res = await fetch(`${stack.url}/health`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('a request with no key is refused and never reaches Mistral', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat(userSays('hi'), { key: null });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  const { error } = await res.json();
  assert.equal(error.code, 'invalid_api_key');
  assert.equal(error.type, 'authentication_error');
  assert.match(error.message, /No API key provided/);
  await sleep(30);
  assert.equal(stack.mock.requests.length, 0);
});

test('a wrong key is refused', async (t) => {
  const stack = await startStack(t);
  for (const key of ['wrong-key-wrong-key-wrong-key', GATEWAY_KEY.slice(0, -1), `${GATEWAY_KEY}x`, GATEWAY_KEY.toUpperCase()]) {
    const res = await stack.chat(userSays('hi'), { key });
    assert.equal(res.status, 401, key);
    assert.match((await res.json()).error.message, /Incorrect API key/);
  }
  assert.equal(stack.mock.requests.length, 0);
});

test('the Mistral key itself does not open the gateway', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat(userSays('hi'), { key: MISTRAL_KEY });
  assert.equal(res.status, 401);
  assert.equal(stack.mock.requests.length, 0);
});

test('every configured gateway key works', async (t) => {
  const stack = await startStack(t);
  for (const key of [GATEWAY_KEY, SECOND_GATEWAY_KEY]) {
    const res = await stack.chat(userSays('hi'), { key });
    assert.equal(res.status, 200, key);
    await res.text();
  }
});

test('only the Bearer scheme is accepted, in any letter case', async (t) => {
  const stack = await startStack(t);
  const attempt = (authorization) => fetch(`${stack.url}/v1/models`, { headers: { authorization } });
  assert.equal((await attempt(`bearer ${GATEWAY_KEY}`)).status, 200);
  assert.equal((await attempt(`BEARER   ${GATEWAY_KEY}`)).status, 200);
  assert.equal((await attempt(GATEWAY_KEY)).status, 401);
  assert.equal((await attempt(`Basic ${Buffer.from(`user:${GATEWAY_KEY}`).toString('base64')}`)).status, 401);
  assert.equal((await attempt(`Bearer ${GATEWAY_KEY} extra`)).status, 401);
  assert.equal((await attempt('Bearer ')).status, 401);
});

test('a key in the URL or in another header does not authenticate', async (t) => {
  const stack = await startStack(t);
  assert.equal((await fetch(`${stack.url}/v1/models?api_key=${GATEWAY_KEY}`)).status, 401);
  assert.equal((await fetch(`${stack.url}/v1/models`, { headers: { 'x-api-key': GATEWAY_KEY } })).status, 401);
  assert.equal((await fetch(`${stack.url}/v1/models`, { headers: { 'api-key': GATEWAY_KEY } })).status, 401);
});

test('without a key every path answers 401, so nothing can be probed', async (t) => {
  const stack = await startStack(t);
  for (const path of ['/v1/chat/completions', '/v1/models', '/v1/does-not-exist', '/admin', '/.env']) {
    assert.equal((await fetch(`${stack.url}${path}`)).status, 401, path);
  }
});

test('the key is checked before the body is looked at', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat('this is not json', { key: 'wrong-key-wrong-key-wrong-key' });
  assert.equal(res.status, 401);
});

test('an upload without a valid key is refused at once, without waiting for the body', async (t) => {
  const stack = await startStack(t);
  // Each request starts a body, sends only its first bytes, and then keeps
  // the connection open. A gateway that read the body before checking the key
  // would sit waiting for the rest; this one must answer and hang up. The
  // announced size is well inside the limit, so only the key can be the
  // reason for the refusal.
  const start = '{"model":"mistral-large-2512",';
  const uploads = {
    'with a declared length': `Content-Length: 1000000\r\n\r\n${start}`,
    'sent in chunks': `Transfer-Encoding: chunked\r\n\r\n${start.length.toString(16)}\r\n${start}\r\n`,
  };
  for (const [name, upload] of Object.entries(uploads)) {
    for (const authorization of ['Authorization: Bearer wrong-key-wrong-key-wrong-key\r\n', '']) {
      const { response, elapsedMs } = await rawExchange(stack.port,
        `POST /v1/chat/completions HTTP/1.1\r\nHost: gateway\r\n${authorization}Content-Type: application/json\r\n${upload}`);
      assert.match(response, /^HTTP\/1\.1 401 /, name);
      assert.match(response, /connection: close/i, name);
      assert.ok(elapsedMs < 1500, `${name}: the connection stayed open for ${elapsedMs} ms`);
    }
  }
  assert.equal(stack.mock.requests.length, 0);
});

test('an oversized upload is refused as soon as it is announced, without reading it', async (t) => {
  const stack = await startStack(t);
  // A valid key this time. The body claims 1 GB, far over the limit, and only
  // its first bytes are sent. The refusal must not wait for more.
  const { response, elapsedMs } = await rawExchange(stack.port, [
    'POST /v1/chat/completions HTTP/1.1',
    'Host: gateway',
    `Authorization: Bearer ${GATEWAY_KEY}`,
    'Content-Type: application/json',
    'Content-Length: 1000000000',
    '',
    '{"model":"mistral-large-2512",',
  ].join('\r\n'));
  assert.match(response, /^HTTP\/1\.1 413 /);
  assert.match(response, /connection: close/i);
  assert.match(response, /"code":"request_too_large"/);
  assert.ok(elapsedMs < 1500, `the connection stayed open for ${elapsedMs} ms`);
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

test('GET /v1/models lists exactly the one model this endpoint serves', async (t) => {
  const stack = await startStack(t);
  const res = await stack.get('/v1/models');
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.object, 'list');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, 'mistral-large-2512');
  assert.equal(list.data[0].object, 'model');
  assert.equal(typeof list.data[0].created, 'number');
  assert.equal(stack.mock.requests.length, 0, 'the model list must not be fetched from Mistral');
});

test('GET /v1/models/{id} knows the served model and nothing else', async (t) => {
  const stack = await startStack(t);
  const found = await stack.get('/v1/models/mistral-large-2512');
  assert.equal(found.status, 200);
  assert.equal((await found.json()).id, 'mistral-large-2512');
  const missing = await stack.get('/v1/models/gpt-4o');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'model_not_found');
});

test('MISTRAL_MODEL changes the served model everywhere', async (t) => {
  const stack = await startStack(t, { env: { MISTRAL_MODEL: 'mistral-large-4' } });
  assert.equal((await (await stack.get('/v1/models')).json()).data[0].id, 'mistral-large-4');
  const old = await stack.chat(userSays('hi'));
  assert.equal(old.status, 404);
  assert.match((await old.json()).error.message, /It serves "mistral-large-4"/);
});

// ---------------------------------------------------------------------------
// Chat completions: the request that reaches Mistral
// ---------------------------------------------------------------------------

test('a chat completion is relayed, and the answer comes back byte for byte', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat(userSays('hello there'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const text = await res.text();
  assert.equal(text, stack.mock.last.responseText);
  const completion = JSON.parse(text);
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'echo: hello there');
  assert.equal(completion.usage.prompt_tokens, 12);
});

test('Mistral receives the Mistral key, and the gateway key appears nowhere', async (t) => {
  const stack = await startStack(t);
  await (await stack.chat(userSays('hi'))).text();
  const upstream = stack.mock.last;
  assert.equal(upstream.headers.authorization, `Bearer ${MISTRAL_KEY}`);
  assert.ok(!JSON.stringify(upstream.headers).includes(GATEWAY_KEY));
  assert.ok(!upstream.raw.includes(GATEWAY_KEY));
});

test('nothing else the caller sent in headers is passed on to Mistral', async (t) => {
  const stack = await startStack(t);
  await (await stack.chat(userSays('hi'), {
    headers: {
      cookie: 'session=private',
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
      'x-custom-secret': 'private',
      'user-agent': 'SomeApp/1.0 (private build)',
      'accept-encoding': 'gzip, br',
      origin: 'https://private.example',
    },
  })).text();
  assert.deepEqual(Object.keys(stack.mock.last.headers).sort(), [
    'accept', 'accept-encoding', 'authorization', 'connection', 'content-length', 'content-type', 'host', 'user-agent',
  ]);
  assert.equal(stack.mock.last.headers.accept, 'application/json');
  assert.equal(stack.mock.last.headers['accept-encoding'], 'identity');
  assert.equal(stack.mock.last.headers['content-type'], 'application/json');
  assert.equal(stack.mock.last.headers['user-agent'], 'mistral3-gateway/1.0');
});

test('a request with no model gets the served model', async (t) => {
  const stack = await startStack(t);
  for (const model of [undefined, null, '']) {
    const res = await stack.chat({ model, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200, String(model));
    await res.text();
    assert.equal(stack.mock.last.body.model, 'mistral-large-2512');
  }
});

test('any other model is refused without contacting Mistral', async (t) => {
  const stack = await startStack(t);
  for (const model of ['gpt-4o', 'mistral-large-latest', 'mistral-large-4', 'Mistral-Large-2512', ' mistral-large-2512', 42, { id: 'x' }, ['mistral-large-2512']]) {
    const res = await stack.chat({ model, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 404, JSON.stringify(model));
    const { error } = await res.json();
    assert.equal(error.code, 'model_not_found');
    assert.match(error.message, /It serves "mistral-large-2512"/);
  }
  assert.equal(stack.mock.requests.length, 0);
});

test('what ordinary OpenAI clients send is accepted by a strict Mistral', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({
    model: 'mistral-large-2512',
    store: false,
    user: 'end-user-77',
    max_completion_tokens: 512,
    seed: 11,
    temperature: 0.3,
    logit_bias: null,
    stream_options: { include_usage: true },
    messages: [
      { role: 'developer', content: 'Be brief.' },
      { role: 'user', content: 'first', name: 'alice' },
      { role: 'assistant', content: 'reply', reasoning_content: 'thinking...', refusal: null, tool_calls: null },
      { role: 'user', content: 'second' },
    ],
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).choices[0].message.content, 'echo: second');
  assert.deepEqual(stack.mock.last.body, {
    model: 'mistral-large-2512',
    temperature: 0.3,
    max_tokens: 512,
    random_seed: 11,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
  });
  const entry = await stack.logFor((line) => line.path === '/v1/chat/completions');
  assert.deepEqual([...entry.adjusted].sort(), [
    '-messages.name', '-messages.reasoning_content', '-store', '-stream_options', '-user',
    'developer->system', 'max_completion_tokens->max_tokens', 'seed->random_seed',
  ]);
});

test("a field Mistral does not support comes back as Mistral's own error, with the field named", async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ ...userSays('hi'), logit_bias: { 50256: -100 } });
  assert.equal(res.status, 422);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const body = await res.json();
  const upstream = JSON.parse(stack.mock.last.responseText);

  // Everything Mistral sent is still there...
  const { error, ...rest } = body;
  assert.deepEqual(rest, upstream);
  assert.deepEqual(body.detail[0].loc, ['body', 'logit_bias']);
  // ...and an explanation has been added where OpenAI clients look for it.
  assert.deepEqual(error, {
    message: 'Mistral rejected the request: logit_bias: Extra inputs are not permitted',
    type: 'invalid_request_error',
    param: 'logit_bias',
    code: 'extra_forbidden',
  });

  const entry = await stack.logFor((line) => line.status === 422);
  assert.deepEqual(entry.rejected, ['logit_bias (extra_forbidden)']);
  assert.equal(entry.level, 'warn');
});

test('the request body reaches Mistral intact, including Unicode', async (t) => {
  const stack = await startStack(t);
  const content = 'caf\u00e9 \u4f60\u597d \u{1F600} "quotes" \\backslash\\ \u2028 line\nbreak \u0000 null';
  const res = await stack.chat(userSays(content));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, `echo: ${content}`);
  assert.equal(stack.mock.last.body.messages[0].content, content);
});

test('a multi-megabyte request and response pass through unharmed', async (t) => {
  const stack = await startStack(t);
  const content = 'x'.repeat(3 * 1024 * 1024) + '\u{1F600}';
  const res = await stack.chat(userSays(content));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(sha256(stack.mock.last.body.messages[0].content), sha256(content));
  assert.equal(sha256(text), sha256(stack.mock.last.responseText));
  assert.ok(text.length > 3 * 1024 * 1024);
});

test('the body is parsed as JSON whatever Content-Type the client sent', async (t) => {
  const stack = await startStack(t);
  // curl -d sends form-encoded by default; a missing header is also common.
  for (const type of ['application/x-www-form-urlencoded', 'text/plain', 'application/json; charset=utf-8']) {
    const res = await stack.chat(userSays('hi'), { headers: { 'content-type': type } });
    assert.equal(res.status, 200, type);
    await res.text();
    assert.equal(stack.mock.last.headers['content-type'], 'application/json');
  }
});

// ---------------------------------------------------------------------------
// Chat completions: requests the gateway refuses itself
// ---------------------------------------------------------------------------

test('bodies that are not a JSON object are refused', async (t) => {
  const stack = await startStack(t);
  for (const body of ['', '{', 'not json', '[1,2,3]', '"text"', '42', 'null', '{"messages": [}']) {
    const res = await stack.chat(body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error.code, 'invalid_json');
  }
  assert.equal(stack.mock.requests.length, 0);
});

test('absurdly nested JSON is refused, not fatal', async (t) => {
  const stack = await startStack(t);
  const depth = 200_000;
  const res = await stack.chat(`{"messages":${'['.repeat(depth)}${']'.repeat(depth)}}`);
  const answer = await res.json();
  // Which of two correct outcomes happens depends on the JavaScript engine.
  // Where writing such a body back out overflows the stack (Node 22 and 24),
  // the gateway refuses it itself. Where it does not (Node 26), the body is
  // forwarded like any other and the upstream rejects it.
  if (res.status === 400) {
    assert.equal(answer.error.code, 'invalid_json');
    assert.equal(stack.mock.requests.length, 0);
  } else {
    assert.equal(res.status, 422, 'expected a refusal by the gateway (400) or by the upstream (422)');
    assert.equal(stack.mock.requests.length, 1);
  }
  assert.equal((await stack.get('/v1/models')).status, 200, 'the gateway must still be running');
  assert.ok(!stack.logs.some((line) => line.level === 'error'), 'a malformed request is the caller\'s mistake, not a gateway error');
});

test('a body over the size limit is refused, announced or not', async (t) => {
  const stack = await startStack(t, { overrides: { maxBodyBytes: 2048 } });
  const tooBig = JSON.stringify(userSays('x'.repeat(4096)));

  // Announced by Content-Length.
  const announced = await stack.chat(tooBig);
  assert.equal(announced.status, 413);
  assert.equal((await announced.json()).error.code, 'request_too_large');

  // Not announced: sent in chunks with no Content-Length.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(`${stack.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${GATEWAY_KEY}` } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(tooBig.slice(0, 1000));
    req.end(tooBig.slice(1000));
  });
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.text).error.code, 'request_too_large');

  assert.equal(stack.mock.requests.length, 0);
  // A body just under the limit still works.
  const fits = await stack.chat(userSays('x'.repeat(1500)));
  assert.equal(fits.status, 200);
  await fits.text();
});

test('compressed request bodies are refused with a clear message', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat(userSays('hi'), { headers: { 'content-encoding': 'gzip' } });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, 'unsupported_content_encoding');
});

test('wrong methods and unknown paths get specific answers', async (t) => {
  const stack = await startStack(t);

  const get = await stack.get('/v1/chat/completions');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  const post = await fetch(`${stack.url}/v1/models`, { method: 'POST', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  const unknown = await stack.get('/v1/embeddings');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'not_found');

  // The usual mistake: a base URL without /v1.
  const missingPrefix = await fetch(`${stack.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: '{}' });
  assert.equal(missingPrefix.status, 404);
  assert.match((await missingPrefix.json()).error.message, /Did you mean \/v1\/chat\/completions/);
});

test('odd request lines get an error, and the gateway keeps running', async (t) => {
  const stack = await startStack(t);
  const auth = `Authorization: Bearer ${GATEWAY_KEY}\r\n`;
  for (const target of ['////', '/%zz', '/v1/models/%E0%A4%A', '*', '/v1/chat/completions/../../health?x=1', `/${'a'.repeat(5000)}`, 'http://other.example/v1/models']) {
    const { response } = await rawExchange(stack.port, `GET ${target} HTTP/1.1\r\nHost: gateway\r\n${auth}Connection: close\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 [2-4]\d\d /, target);
  }
  assert.equal((await stack.get('/v1/models')).status, 200);
});

// ---------------------------------------------------------------------------
// What comes back from Mistral
// ---------------------------------------------------------------------------

test("upstream headers about Mistral's own address are not repeated; the rest are", async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat(userSays('hi'));
  await res.text();
  for (const name of ['set-cookie', 'alt-svc', 'strict-transport-security', 'access-control-allow-origin']) {
    assert.equal(res.headers.get(name), null, name);
  }
  assert.equal(res.headers.get('x-ratelimit-remaining-tokens'), '499000');
  assert.equal(res.headers.get('x-upstream-request-id'), 'mock-req-1');
});

test('a rate limit from Mistral is passed on with its Retry-After', async (t) => {
  const stack = await startStack(t);
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 429, { message: 'Requests rate limit exceeded' }, { 'retry-after': '7' }));
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '7');
  assert.deepEqual(await res.json(), {
    message: 'Requests rate limit exceeded',
    error: { message: 'Requests rate limit exceeded', type: 'rate_limit_error', param: null, code: null },
  });
  const entry = await stack.logFor((line) => line.status === 429);
  assert.equal(entry.level, 'warn');
});

test('a server error from Mistral is passed on with its status and message', async (t) => {
  const stack = await startStack(t);
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 503, { message: 'Service unavailable' }));
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    message: 'Service unavailable',
    error: { message: 'Service unavailable', type: 'api_error', param: null, code: null },
  });
  assert.equal((await stack.logFor((line) => line.status === 503)).level, 'error');
});

test('a wrong MISTRAL_API_KEY shows up as a gateway fault, not as the caller\'s key being wrong', async (t) => {
  const stack = await startStack(t, { upstreamKey: 'the-real-upstream-key-is-different' });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('www-authenticate'), null);
  const { error } = await res.json();
  assert.equal(error.code, 'upstream_auth_failed');
  assert.match(error.message, /MISTRAL_API_KEY/);
  const entry = await stack.logFor((line) => line.error === 'upstream_auth_failed');
  assert.equal(entry.level, 'error');
  assert.equal(entry.upstreamStatus, 401);
});

test('a redirect from the upstream is never relayed', async (t) => {
  const stack = await startStack(t);
  stack.mock.next((req, res) => {
    res.writeHead(307, { location: 'https://elsewhere.example/v1/chat/completions' });
    res.end();
  });
  const res = await fetch(`${stack.url}/v1/chat/completions`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(userSays('hi')),
  });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('location'), null);
  assert.equal((await res.json()).error.code, 'upstream_redirect');
});

test('an unreachable upstream gives a 502', async (t) => {
  // Port 1 on this machine: nothing listens there, so connections are refused.
  const stack = await startStack(t, { env: { MISTRAL_BASE_URL: 'http://127.0.0.1:1/v1' } });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'upstream_unreachable');
  const entry = await stack.logFor((line) => line.error === 'upstream_unreachable');
  assert.equal(entry.upstreamError, 'ECONNREFUSED');
});

test('an upstream that never answers gives a 504 once the time limit passes', async (t) => {
  const stack = await startStack(t, { overrides: { upstreamTimeoutMs: 250 } });
  stack.mock.next(() => { /* accept the request and stay silent */ });
  const startedAt = Date.now();
  const res = await stack.chat(userSays('hi'));
  const elapsed = Date.now() - startedAt;
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, 'upstream_timeout');
  assert.ok(elapsed >= 240 && elapsed < 2000, `answered after ${elapsed} ms`);
});

test('a slow answer inside the time limit is not cut off', async (t) => {
  const stack = await startStack(t, { overrides: { upstreamTimeoutMs: 400 } });
  stack.mock.next(async (req, res, body, { sendJson }) => {
    await sleep(200);
    sendJson(res, 200, { ok: true });
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('the explanation added to an error never repeats the value that was rejected', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ ...userSays('hi'), notes: 'private-rejected-value', extra_settings: { inner: 'private-nested-value' } });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.message, 'Mistral rejected the request: notes: Extra inputs are not permitted; extra_settings: Extra inputs are not permitted');
  assert.ok(!JSON.stringify(body.error).includes('private-'));
  const entry = await stack.logFor((line) => line.status === 422);
  assert.ok(!JSON.stringify(entry).includes('private-'), 'the rejected values must not reach the log');
});

test("Mistral's ordinary error shape gets the same treatment, keeping its type and code", async (t) => {
  const stack = await startStack(t);
  const upstream = { object: 'error', message: 'Requests rate limit exceeded', type: 'rate_limited', param: null, code: '3505' };
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 429, upstream));
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ...upstream, error: { message: 'Requests rate limit exceeded', type: 'rate_limited', param: null, code: '3505' } });
});

test('error bodies the gateway has nothing to add to are relayed byte for byte', async (t) => {
  const stack = await startStack(t);
  const cases = [
    // Already in OpenAI's shape.
    { status: 400, type: 'application/json', text: '{"error": {"message": "already explained", "type": "x"},  "spacing":   "kept"}' },
    // JSON with no recognisable explanation.
    { status: 500, type: 'application/json', text: '{"status":"failed","trace":["a","b"]}' },
    // Claims to be JSON but is not.
    { status: 502, type: 'application/json', text: '<html>Bad gateway</html>' },
    // Not JSON at all, such as an error page from a proxy in front of the API.
    { status: 503, type: 'text/html; charset=utf-8', text: '<html><body>Service temporarily unavailable</body></html>' },
    { status: 500, type: 'text/plain', text: '{"message":"looks like JSON, but is labelled as text"}' },
  ];
  for (const { status, type, text } of cases) {
    stack.mock.next((req, res) => {
      res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
    const res = await stack.chat(userSays('hi'));
    assert.equal(res.status, status, text);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(await res.text(), text);
  }
});

test('an error sent without a declared length, in several pieces, is handled the same', async (t) => {
  const stack = await startStack(t);
  stack.mock.next(async (req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' }); // chunked
    res.write('{"detail":[{"type":"extra_forbidden",');
    await sleep(20);
    res.write('"loc":["body","foo"],');
    await sleep(20);
    res.end('"msg":"Extra inputs are not permitted","input":1}]}');
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.message, 'Mistral rejected the request: foo: Extra inputs are not permitted');
  assert.equal(body.detail[0].input, 1);
});

test('an unusually large error body is relayed whole and untouched', async (t) => {
  const stack = await startStack(t);
  const text = JSON.stringify({ message: 'big', padding: 'p'.repeat(300 * 1024) });
  stack.mock.next(async (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    for (let offset = 0; offset < text.length; offset += 20_000) {
      res.write(text.slice(offset, offset + 20_000));
      await sleep(1);
    }
    res.end();
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 500);
  const received = await res.text();
  assert.equal(received.length, text.length);
  assert.equal(sha256(received), sha256(text));
});

test('a compressed error body is relayed untouched, with its encoding header', async (t) => {
  const stack = await startStack(t);
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const packed = gzipSync(JSON.stringify({ message: 'compressed error' }));
  stack.mock.next((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': packed.length });
    res.end(packed);
  });
  // http.request does not decompress, so the raw bytes can be compared.
  const { status, headers, bytes } = await new Promise((resolve, reject) => {
    const body = JSON.stringify(userSays('hi'));
    const req = http.request(`${stack.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(status, 500);
  assert.equal(headers['content-encoding'], 'gzip');
  assert.ok(bytes.equals(packed));
  assert.deepEqual(JSON.parse(gunzipSync(bytes).toString()), { message: 'compressed error' });
});

test('an error answer that breaks off part-way becomes a clear 502', async (t) => {
  const stack = await startStack(t);
  stack.mock.next(async (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': 500 });
    res.write('{"message":"cut');
    await sleep(30);
    res.destroy();
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'upstream_incomplete');
  assert.equal((await stack.logFor((line) => line.error === 'upstream_incomplete')).upstreamStatus, 500);
});

test('an error answer that stalls part-way becomes a 504 after the time limit', async (t) => {
  const stack = await startStack(t, { overrides: { upstreamTimeoutMs: 250 } });
  stack.mock.next((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': 500 });
    res.write('{"message":"then nothing');
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 504);
  assert.match((await res.json()).error.code, /^upstream_(stalled|timeout)$/);
});

test('successful answers are never altered, even if they contain error-like fields', async (t) => {
  const stack = await startStack(t);
  const text = '{"id":"x",  "detail":[{"loc":["body","a"],"msg":"m"}], "message":"not an error", "choices":[]}';
  stack.mock.next((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), text);
});

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

const TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: 'Returns the current local time in a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
const ASKS_THE_TIME = { role: 'user', content: 'What time is it in Paris?' };

test('a tool call and its follow-up, written the way OpenAI clients write them, are accepted', async (t) => {
  const stack = await startStack(t);

  const first = await stack.chat({ model: 'mistral-large-2512', messages: [ASKS_THE_TIME], tools: [TIME_TOOL], tool_choice: 'required', parallel_tool_calls: false });
  assert.equal(first.status, 200, await first.clone().text());
  const firstText = await first.text();
  assert.equal(firstText, stack.mock.last.responseText, 'the tool call must come back exactly as Mistral sent it');
  const { message, finish_reason: finishReason } = JSON.parse(firstText).choices[0];
  assert.equal(finishReason, 'tool_calls');
  assert.equal(message.tool_calls[0].function.name, 'get_current_time');
  // The request reached Mistral with the tool definition untouched.
  assert.deepEqual(stack.mock.last.body.tools, [TIME_TOOL]);
  assert.equal(stack.mock.last.body.tool_choice, 'required');
  assert.equal(stack.mock.last.body.parallel_tool_calls, false);

  // The OpenAI SDKs send the assistant message back as received, plus these
  // empty fields of their own, which Mistral would reject.
  const echoed = { ...message, refusal: null, annotations: null, audio: null, function_call: null };
  const result = { role: 'tool', tool_call_id: message.tool_calls[0].id, content: '{"time":"14:05"}' };
  const second = await stack.chat({ model: 'mistral-large-2512', messages: [ASKS_THE_TIME, echoed, result], tools: [TIME_TOOL], tool_choice: 'auto' });
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal((await second.json()).choices[0].message.content, 'The tool said {"time":"14:05"}.');

  // What Mistral received: the call and its result intact, the empty fields gone.
  assert.deepEqual(stack.mock.last.body.messages, [ASKS_THE_TIME, message, result]);
});

test('an assistant turn that only calls a tool keeps its null content, and a tool result keeps its name', async (t) => {
  const stack = await startStack(t);
  const call = { id: 'a1B2c3D4e', type: 'function', function: { name: 'get_current_time', arguments: '{"city":"Paris"}' } };
  const messages = [
    ASKS_THE_TIME,
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'a1B2c3D4e', name: 'get_current_time', content: '14:05' },
  ];
  const res = await stack.chat({ model: 'mistral-large-2512', messages, tools: [TIME_TOOL] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).choices[0].message.content, 'The tool said 14:05.');
  assert.deepEqual(stack.mock.last.body.messages, messages);
  const entry = await stack.logFor((line) => line.path === '/v1/chat/completions');
  assert.equal(entry.adjusted, undefined, 'nothing in this request needed adjusting');
});

test('several tool calls in one turn, each with its result, are accepted', async (t) => {
  const stack = await startStack(t);
  const calls = ['Paris', 'Tokyo'].map((city, index) => ({ id: `call0000${index}`, type: 'function', function: { name: 'get_current_time', arguments: JSON.stringify({ city }) } }));
  const messages = [
    ASKS_THE_TIME,
    { role: 'assistant', content: '', tool_calls: calls, refusal: null },
    { role: 'tool', tool_call_id: 'call00000', content: '14:05' },
    { role: 'tool', tool_call_id: 'call00001', content: '22:05' },
  ];
  const res = await stack.chat({ model: 'mistral-large-2512', messages, tools: [TIME_TOOL] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stack.mock.last.body.messages.length, 4);
  assert.deepEqual(stack.mock.last.body.messages[1], { role: 'assistant', content: '', tool_calls: calls });
});

test('a streamed tool call is relayed unchanged', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ model: 'mistral-large-2512', messages: [ASKS_THE_TIME], tools: [TIME_TOOL], tool_choice: 'any', stream: true, stream_options: { include_usage: true } });
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.text();
  assert.equal(text, stack.mock.last.responseText);
  const events = text.split('\n\n').filter((event) => event.startsWith('data: {')).map((event) => JSON.parse(event.slice(6)));
  const withCall = events.find((event) => event.choices[0].delta.tool_calls);
  assert.equal(withCall.choices[0].delta.tool_calls[0].function.name, 'get_current_time');
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
});

test("Mistral's complaint about the order of messages reaches the caller in readable form", async (t) => {
  const stack = await startStack(t);
  // A conversation that ends with the assistant's own turn: the real API
  // refuses this with exactly this body.
  const res = await stack.chat({ model: 'mistral-large-2512', messages: [ASKS_THE_TIME, { role: 'assistant', content: 'It is 14:05.' }] });
  assert.equal(res.status, 400);
  const message = 'Expected last role User or Tool (or Assistant with prefix True) for serving but got assistant';
  assert.deepEqual(await res.json(), {
    object: 'error',
    message,
    type: 'invalid_request_message_order',
    param: null,
    code: '3230',
    raw_status_code: 400,
    error: { message, type: 'invalid_request_message_order', param: null, code: '3230' },
  });
});

test('a tool result that answers no tool call is refused by Mistral, not repaired or hidden', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ model: 'mistral-large-2512', messages: [ASKS_THE_TIME, { role: 'tool', tool_call_id: 'a1B2c3D4e', content: '14:05' }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.message, "Unexpected role 'tool' after role 'user'");
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('a stream is relayed chunk by chunk as it is produced, not saved up', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ ...userSays('one two three four five six seven eight'), stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);

  const arrivals = [];
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of res.body) {
    arrivals.push(performance.now());
    text += decoder.decode(chunk, { stream: true });
  }

  // The stand-in pauses 25 ms between words: nine pauses, roughly 225 ms.
  assert.ok(arrivals.length >= 6, `expected many separate deliveries, got ${arrivals.length}`);
  const spread = arrivals.at(-1) - arrivals[0];
  assert.ok(spread >= 120, `the chunks arrived within ${spread.toFixed(0)} ms of each other, as if buffered`);

  assert.equal(text, stack.mock.last.responseText, 'the stream must be relayed byte for byte');
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const events = text.split('\n\n').filter(Boolean).map((line) => line.replace(/^data: /, ''));
  const words = events.slice(0, -1).map((event) => JSON.parse(event).choices[0].delta.content ?? '').join('');
  assert.equal(words, 'echo: one two three four five six seven eight');
  assert.ok(JSON.parse(events.at(-2)).usage.completion_tokens > 0, 'the last chunk carries the token usage');
  assert.equal(stack.mock.last.headers.accept, 'text/event-stream');
});

test('the first chunk reaches the caller while the stream is still running', async (t) => {
  const stack = await startStack(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stack.mock.next(async (req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseChunk('id', { content: 'first' }));
    await gate; // nothing more until the test has seen the first chunk
    res.end('data: [DONE]\n\n');
  });
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"content":"first"/);
  release();
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.equal(rest, 'data: [DONE]\n\n');
});

test('the response status and headers reach the caller before any of the body', async (t) => {
  const stack = await startStack(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stack.mock.next(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await gate; // no body at all until the test has received the headers
    res.end('data: [DONE]\n\n');
  });
  // If the gateway held the headers back until the first body byte, this
  // would never resolve, because the body waits on the line after it.
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  assert.equal(res.status, 200);
  release();
  assert.equal(await res.text(), 'data: [DONE]\n\n');
});

test('when the caller disconnects mid-stream, the request to Mistral is ended too', async (t) => {
  const stack = await startStack(t);
  stack.mock.next(async (req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 400 && !res.destroyed; i++) {
      res.write(sseChunk('id', { content: `word${i} ` }));
      await sleep(10);
    }
    res.end('data: [DONE]\n\n');
  });
  const controller = new AbortController();
  const res = await stack.chat({ ...userSays('hi'), stream: true }, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());

  await waitFor(() => stack.mock.last.closedEarly, { what: 'the upstream request to be ended' });
  const entry = await stack.logFor((line) => line.path === '/v1/chat/completions');
  assert.equal(entry.message, 'POST /v1/chat/completions client_closed');
  assert.equal(entry.incomplete, true);
  assert.equal(entry.level, 'info', 'a caller pressing stop is not an error');
  assert.equal(entry.error, undefined);
});

test('when the caller disconnects before any answer, the request to Mistral is ended too', async (t) => {
  const stack = await startStack(t);
  stack.mock.next(() => { /* stay silent */ });
  const controller = new AbortController();
  const pending = stack.chat(userSays('hi'), { signal: controller.signal });
  await waitFor(() => stack.mock.requests.length === 1, { what: 'the request to reach the upstream' });
  controller.abort();
  await assert.rejects(pending);
  await waitFor(() => stack.mock.last.closedEarly, { what: 'the upstream request to be ended' });
  const entry = await stack.logFor((line) => line.path === '/v1/chat/completions');
  assert.equal(entry.status, 0);
  assert.equal(entry.incomplete, true);
});

test('a stream that breaks off upstream fails for the caller instead of looking complete', async (t) => {
  const stack = await startStack(t);
  stack.mock.next(async (req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseChunk('id', { content: 'partial ' }));
    await sleep(40);
    res.destroy(); // the connection drops with no final chunk
  });
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  assert.equal(res.status, 200);
  let received = '';
  await assert.rejects(async () => {
    for await (const chunk of res.body) received += new TextDecoder().decode(chunk);
  });
  assert.match(received, /partial/);
  assert.ok(!received.includes('[DONE]'));
  const entry = await stack.logFor((line) => line.error === 'upstream_incomplete');
  assert.equal(entry.level, 'error');
  assert.equal(entry.incomplete, true);
});

test('a stream that goes silent upstream is cut after the time limit', async (t) => {
  const stack = await startStack(t, { overrides: { upstreamTimeoutMs: 250 } });
  stack.mock.next((req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseChunk('id', { content: 'then silence' }));
  });
  const startedAt = Date.now();
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  await assert.rejects(async () => {
    for await (const chunk of res.body) void chunk;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 240 && elapsed < 2000, `cut after ${elapsed} ms`);
  assert.ok(await stack.logFor((line) => line.error === 'upstream_stalled'));
});

test('a steady stream longer than the time limit is not cut: the limit is on silence', async (t) => {
  const stack = await startStack(t, { overrides: { upstreamTimeoutMs: 200 } });
  stack.mock.next(async (req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 12; i++) {
      res.write(sseChunk('id', { content: `${i} ` }));
      await sleep(50); // 600 ms in total, never silent for 200 ms
    }
    res.end('data: [DONE]\n\n');
  });
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  const text = await res.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.equal(text.split('\n\n').filter(Boolean).length, 13);
});

test('an error answer to a streaming request is passed on as JSON', async (t) => {
  const stack = await startStack(t);
  const res = await stack.chat({ ...userSays('hi'), stream: true, logit_bias: { 1: 1 } });
  assert.equal(res.status, 422);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal((await res.json()).detail[0].type, 'extra_forbidden');
});

test('many streams at once each get their own answer', async (t) => {
  const stack = await startStack(t);
  const results = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
    const res = await stack.chat({ ...userSays(`request number ${i} of forty`), stream: i % 2 === 0 });
    const text = await res.text();
    if (i % 2 !== 0) return JSON.parse(text).choices[0].message.content;
    return text.split('\n\n').filter((line) => line && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? '').join('');
  }));
  results.forEach((content, i) => assert.equal(content, `echo: request number ${i} of forty`));
});

test('a long stream arrives complete and in order', async (t) => {
  const stack = await startStack(t);
  const total = 5000;
  stack.mock.next((req, res, body, { sseChunk }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < total; i++) res.write(sseChunk('id', { content: `${i},` }));
    res.end('data: [DONE]\n\n');
  });
  const res = await stack.chat({ ...userSays('hi'), stream: true });
  const text = await res.text();
  assert.equal(sha256(text), sha256(stack.mock.last.responseText));
  const numbers = text.split('\n\n').filter((line) => line && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content).join('');
  assert.equal(numbers, Array.from({ length: total }, (_, i) => `${i},`).join(''));
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

test('logs never contain a key or anything from the conversation', async (t) => {
  const stack = await startStack(t);
  const prompt = 'my-private-prompt-text-zebra';
  await (await stack.chat({ ...userSays(prompt), user: 'private-end-user-id' })).text();
  await (await stack.chat({ ...userSays(prompt), stream: true })).text();
  await (await stack.chat(userSays(prompt), { key: 'a-wrong-key-that-was-tried-0123' })).text();
  await (await stack.chat({ ...userSays(prompt), bad_field: 'private-field-value' })).text();
  await (await stack.chat({ model: 'private-model-name', messages: [] })).text();
  await (await fetch(`${stack.url}/v1/models?token=private-query-value`, { headers: { authorization: `Bearer ${GATEWAY_KEY}` } })).text();
  await waitFor(() => stack.logs.length === 6, { what: 'six log lines' });

  const everything = JSON.stringify(stack.logs);
  for (const secret of [GATEWAY_KEY, MISTRAL_KEY, prompt, 'echo:', 'private-end-user-id', 'a-wrong-key-that-was-tried-0123', 'private-field-value', 'private-model-name', 'private-query-value']) {
    assert.ok(!everything.includes(secret), `"${secret}" appeared in the logs`);
  }
});

test('each request is logged once, with what is needed to trace it', async (t) => {
  const stack = await startStack(t);
  await (await stack.chat({ ...userSays('hi'), stream: true }, { headers: { 'x-railway-request-id': 'railway-req-abc123' } })).text();
  const entry = await stack.logFor((line) => line.path === '/v1/chat/completions');
  await sleep(30);
  assert.equal(stack.logs.length, 1);
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'POST /v1/chat/completions 200');
  assert.equal(entry.requestId, 'railway-req-abc123', "Railway's request id is reused so the lines can be matched");
  assert.equal(entry.method, 'POST');
  assert.equal(entry.status, 200);
  assert.equal(entry.upstreamStatus, 200);
  assert.equal(entry.stream, true);
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal(typeof entry.ttfbMs, 'number');
  assert.ok(entry.ttfbMs <= entry.durationMs);
  assert.equal(entry.adjusted, undefined);
  assert.equal(entry.incomplete, undefined);
});

test('a refused key is logged as a warning', async (t) => {
  const stack = await startStack(t);
  await (await stack.chat(userSays('hi'), { key: 'wrong-key-wrong-key-wrong-key' })).text();
  const entry = await stack.logFor((line) => line.status === 401);
  assert.equal(entry.level, 'warn');
});

test('a 404 from Mistral is logged with a hint that the model may have been retired', async (t) => {
  const stack = await startStack(t);
  stack.mock.next((req, res, body, { sendJson }) => sendJson(res, 404, { detail: 'Model not found' }));
  const res = await stack.chat(userSays('hi'));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.message, 'Model not found');
  const entry = await stack.logFor((line) => line.upstreamStatus === 404);
  assert.match(entry.hint, /may have been retired; set MISTRAL_MODEL/);
});

// ---------------------------------------------------------------------------
// Staying up
// ---------------------------------------------------------------------------

test('a caller that vanishes mid-upload does not disturb the gateway', async (t) => {
  const stack = await startStack(t);
  await new Promise((resolve) => {
    const socket = net.connect(stack.port, '127.0.0.1', () => {
      socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: gateway\r\nAuthorization: Bearer ${GATEWAY_KEY}\r\nContent-Length: 5000\r\n\r\n{"model":`);
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 50);
    });
  });
  await sleep(50);
  assert.equal(stack.mock.requests.length, 0);
  const res = await stack.chat(userSays('still here?'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'echo: still here?');
});

test('several requests on one kept-alive connection all work', async (t) => {
  const stack = await startStack(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const ports = new Set();
  for (let i = 0; i < 5; i++) {
    const body = JSON.stringify(userSays(`turn ${i}`));
    const text = await new Promise((resolve, reject) => {
      const req = http.request(`${stack.url}/v1/chat/completions`, {
        method: 'POST',
        agent,
        headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        ports.add(res.socket.localPort);
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(JSON.parse(text).choices[0].message.content, `echo: turn ${i}`);
  }
  assert.equal(ports.size, 1, 'all five requests should have shared one connection');
});
