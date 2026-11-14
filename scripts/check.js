#!/usr/bin/env node
// Checks a running gateway end to end, including the real Mistral API behind it.
//
//   GATEWAY_API_KEY=<your gateway key> node scripts/check.js https://<your-domain>
//
// It sends a handful of tiny requests (well under a thousand tokens in total)
// that cover what apps actually do: a plain completion, a request written the
// way OpenAI clients write it, a stream, and a tool call with its follow-up.
// A failure shows the HTTP status and the error message; when Mistral refuses
// a request field, the message names that field.
//
// Exit code: 0 if every check passed, 1 if any failed, 2 if it could not start.

const TIMEOUT_MS = 120_000;

function cannotStart(problem) {
  console.error(`${problem}\n\nUsage:\n  GATEWAY_API_KEY=<your gateway key> node scripts/check.js https://<your-domain>`);
  process.exit(2);
}

const rawUrl = (process.argv[2] ?? process.env.GATEWAY_URL ?? '').trim();
// GATEWAY_API_KEY may hold several keys, as on the server. The first is used.
const key = (process.env.GATEWAY_API_KEY ?? '').split(',')[0].trim();

if (!rawUrl) cannotStart('No address given.');
if (!key) cannotStart('GATEWAY_API_KEY is not set.');

let parsedUrl = null;
try {
  parsedUrl = new URL(rawUrl);
} catch {
  cannotStart(`"${rawUrl}" is not a valid address. It should look like https://your-service.up.railway.app`);
}
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLocal)) {
  cannotStart('Use the https:// address of the gateway. Over plain http the key would travel unencrypted.');
}
// Accept the address with or without a trailing slash or /v1.
const root = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');

/** A failure that makes the remaining checks pointless. */
class Stop extends Error {}

async function call(path, { body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${root}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect: the key must only go to the address given.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`No answer within ${TIMEOUT_MS / 1000} seconds.`);
    const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    throw new Stop(`Could not connect to ${root} (${reason}). Check the address, and that the service has a public domain.`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Stop(`${root} answered with a redirect to ${res.headers.get('location') ?? 'another address'}. Use the final https:// address.`);
  }
  return res;
}

/** "HTTP 422: <the error message>" for a response that was not the expected one. */
async function describe(res) {
  return (await readFailure(res)).message;
}

async function readFailure(res) {
  const text = await res.text();
  let message = text.trim().replace(/\s+/g, ' ').slice(0, 300) || '(empty response)';
  let code = null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error?.message === 'string') {
      message = parsed.error.message;
      if (typeof parsed.error.code === 'string') {
        code = parsed.error.code;
        message += ` [${code}]`;
      }
    }
  } catch { /* not JSON: show the text */ }
  return { message: `HTTP ${res.status}: ${message}`, status: res.status, code };
}

async function chat(body) {
  const res = await call('/v1/chat/completions', { body });
  if (res.status !== 200) {
    const failure = await readFailure(res);
    throw Object.assign(new Error(failure.message), failure);
  }
  return res;
}

// Failures of the first request to Mistral that every later request would
// repeat. Each is a setting on the service, not something about one request.
function settingToFix(failure) {
  if (failure.code === 'upstream_auth_failed') return 'Set MISTRAL_API_KEY on the service to a valid Mistral API key, then redeploy. Mistral keys carry an expiry date.';
  if (failure.code === 'upstream_unreachable' || failure.code === 'upstream_redirect') return 'The gateway cannot reach Mistral. Remove MISTRAL_BASE_URL from the service unless you set it on purpose.';
  if (failure.status === 404 || /invalid model/i.test(failure.message)) {
    return `Mistral does not serve "${model}" to this account. If the model has been retired, set MISTRAL_MODEL to a current one (see "Model retirement" in the README).`;
  }
  return null;
}

const quote = (text) => JSON.stringify(String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));

let model; // learned from /v1/models
const notes = [];

const checks = [
  ['The gateway is up', async () => {
    const res = await call('/health', { auth: false });
    if (res.status !== 200) {
      throw new Stop(`${await describe(res)}\nThe address answers, but not as a healthy gateway. On Railway, look at the deploy logs: a line starting "Configuration problem" says which variable to fix.`);
    }
  }],

  ['Requests without a key are refused', async () => {
    const res = await call('/v1/models', { auth: false });
    if (res.status !== 401) throw new Error(`Expected HTTP 401 without a key, got ${res.status}. Is this address the gateway?`);
  }],

  ['The gateway key is accepted', async () => {
    const res = await call('/v1/models');
    if (res.status === 401) throw new Stop('The gateway refused this key. Use one of the values of GATEWAY_API_KEY set on the service (not the Mistral key).');
    if (res.status !== 200) throw new Stop(await describe(res));
    model = (await res.json())?.data?.[0]?.id;
    if (typeof model !== 'string') throw new Stop('The model list did not name a model.');
    return `serves ${quote(model)}`;
  }],

  ['Mistral answers a chat request', async () => {
    let res;
    try {
      res = await chat({ model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 16 });
    } catch (err) {
      const fix = settingToFix(err);
      if (fix) throw new Stop(`${err.message}\n${fix}`);
      throw err;
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || reply.trim() === '') throw new Error(`The answer had no text: ${JSON.stringify(data).slice(0, 300)}`);
    const tokens = data?.usage?.total_tokens;
    return `${quote(reply)}${Number.isFinite(tokens) ? `, ${tokens} tokens` : ''}`;
  }],

  ['A request written the way OpenAI apps write it is accepted', async () => {
    // Fields and names that OpenAI clients send and Mistral's API does not
    // take as they are. The gateway has to adjust every one of them.
    const res = await chat({
      model,
      messages: [
        { role: 'developer', content: 'Answer in one word.' },
        { role: 'user', name: 'check', content: 'Say ready.' },
      ],
      max_completion_tokens: 16,
      seed: 1,
      store: false,
      user: 'deployment-check',
      temperature: 0.2,
      top_p: 1,
      n: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      stop: null,
    });
    return quote((await res.json())?.choices?.[0]?.message?.content);
  }],

  ['A streamed answer arrives piece by piece', async () => {
    const res = await chat({
      model,
      messages: [{ role: 'user', content: 'Count from 1 to 5. Digits only, separated by spaces.' }],
      max_tokens: 32,
      stream: true,
      stream_options: { include_usage: true },
    });
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) throw new Error(`Expected a stream (text/event-stream), got "${type}".`);

    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let events = 0;
    let done = false;
    let sawUsage = false;
    const arrivals = new Set();
    for await (const piece of res.body) {
      arrivals.add(Math.floor(performance.now()));
      pending += decoder.decode(piece, { stream: true });
      let end;
      while ((end = pending.search(/\r?\n\r?\n/)) !== -1) {
        const event = pending.slice(0, end);
        pending = pending.slice(end).replace(/^\r?\n\r?\n/, '');
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            done = true;
            continue;
          }
          const chunk = JSON.parse(payload);
          events += 1;
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') text += delta;
          if (chunk?.usage) sawUsage = true;
        }
      }
    }
    if (events === 0 || text.trim() === '') throw new Error('The stream carried no text.');
    if (!done) throw new Error('The stream did not end with "data: [DONE]".');
    if (!sawUsage) notes.push('The stream did not report token usage, so apps will show no token counts for streamed answers.');
    if (arrivals.size < 2) notes.push('The whole stream arrived in one piece. It may be too short to tell, or something between you and the gateway is buffering it.');
    return `${quote(text)} in ${events} events`;
  }],

  ['A tool call and its follow-up work', async () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Returns the current local time in a city.',
        parameters: { type: 'object', properties: { city: { type: 'string', description: 'Name of the city' } }, required: ['city'] },
      },
    }];
    const question = { role: 'user', content: 'What time is it in Paris right now? Use the tool.' };

    const first = await (await chat({ model, messages: [question], tools, tool_choice: 'required', max_tokens: 64 })).json();
    const message = first?.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];
    if (toolCall?.function?.name !== 'get_current_time') throw new Error(`The model did not call the tool: ${JSON.stringify(first?.choices?.[0]).slice(0, 300)}`);

    // Send the model's own message back the way the OpenAI SDKs do: as it was
    // received, plus the empty fields those SDKs add.
    const echoed = { ...message, refusal: null, annotations: null, audio: null, function_call: null };
    const result = { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ city: 'Paris', time: '14:05' }) };
    const second = await (await chat({ model, messages: [question, echoed, result], tools, tool_choice: 'auto', max_tokens: 64 })).json();
    const answer = second?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || answer.trim() === '') throw new Error(`No text answer after the tool result: ${JSON.stringify(second?.choices?.[0]).slice(0, 300)}`);
    return `called ${toolCall.function.name}(${String(toolCall.function.arguments).slice(0, 40)}), then answered ${quote(answer)}`;
  }],
];

console.log(`Checking ${root}\n`);
let passed = 0;
let ran = 0;
for (const [name, run] of checks) {
  ran += 1;
  try {
    const detail = await run();
    passed += 1;
    console.log(`  ok    ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    for (const line of String(err?.message ?? err).split('\n')) console.log(`        ${line}`);
    if (err instanceof Stop) {
      if (ran < checks.length) console.log(`\n  The remaining ${checks.length - ran} checks were skipped: they cannot pass until this one does.`);
      break;
    }
  }
}

for (const note of notes) console.log(`\n  Note: ${note}`);

if (passed === checks.length) {
  console.log(`\nAll ${checks.length} checks passed.`);
} else {
  console.log(`\n${passed} of ${checks.length} checks passed.`);
  process.exitCode = 1;
}
