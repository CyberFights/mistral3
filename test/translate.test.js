import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMistralRequest } from '../src/translate.js';
import { REQUEST_FIELDS, validateRequest } from './support/mock-mistral.js';

const messages = () => [{ role: 'user', content: 'hi' }];

test('a request that is already valid for Mistral is not touched', () => {
  // Every field in Mistral's schema, with a non-null value, and all four
  // message types. Nothing here may be changed, removed or reordered.
  const body = {
    model: 'mistral-large-2512',
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 256,
    stream: true,
    stop: ['END'],
    random_seed: 42,
    metadata: { trace: 'abc' },
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'abcdefghi', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'abcdefghi', name: 'lookup' },
      { role: 'assistant', content: 'The answer is', prefix: true },
    ],
    response_format: { type: 'json_object' },
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} }, strict: true } }],
    tool_choice: 'any',
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    min_tokens: 1,
    repetition_penalty: 1.1,
    top_k: 40,
    logprobs: true,
    top_logprobs: 3,
    prompt_logprobs: false,
    top_prompt_logprobs: 0,
    n: 1,
    prediction: { type: 'content', content: 'x' },
    parallel_tool_calls: false,
    reasoning_effort: 'none',
    prompt_mode: 'reasoning',
    guardrails: [],
    prompt_cache_key: 'k',
    service_tier: 'auto',
    safe_prompt: true,
  };
  assert.deepEqual(new Set(Object.keys(body)), REQUEST_FIELDS, 'this test must cover every field in the schema');

  const before = JSON.stringify(body);
  const adjustments = toMistralRequest(body);
  assert.deepEqual(adjustments, []);
  assert.equal(JSON.stringify(body), before);
});

test('max_completion_tokens becomes max_tokens', () => {
  const body = { messages: messages(), max_completion_tokens: 300 };
  assert.deepEqual(toMistralRequest(body), ['max_completion_tokens->max_tokens']);
  assert.deepEqual(body, { messages: messages(), max_tokens: 300 });
});

test('max_completion_tokens wins when both limits are given', () => {
  const body = { messages: messages(), max_tokens: 100, max_completion_tokens: 300 };
  toMistralRequest(body);
  assert.equal(body.max_tokens, 300);
  assert.ok(!('max_completion_tokens' in body));
});

test('a zero limit is kept, not mistaken for "not set"', () => {
  const body = { messages: messages(), max_completion_tokens: 0, seed: 0 };
  toMistralRequest(body);
  assert.equal(body.max_tokens, 0);
  assert.equal(body.random_seed, 0);
});

test('seed becomes random_seed', () => {
  const body = { messages: messages(), seed: 7 };
  assert.deepEqual(toMistralRequest(body), ['seed->random_seed']);
  assert.deepEqual(body, { messages: messages(), random_seed: 7 });
});

test('an explicit random_seed is kept over seed', () => {
  const body = { messages: messages(), seed: 7, random_seed: 99 };
  toMistralRequest(body);
  assert.equal(body.random_seed, 99);
  assert.ok(!('seed' in body));
});

test('bookkeeping fields are removed', () => {
  const body = {
    messages: messages(),
    store: false,
    user: 'user-1234',
    safety_identifier: 'hashed-user',
    stream_options: { include_usage: true },
    temperature: 0.2,
  };
  const adjustments = toMistralRequest(body);
  assert.deepEqual(adjustments.sort(), ['-safety_identifier', '-store', '-stream_options', '-user']);
  assert.deepEqual(body, { messages: messages(), temperature: 0.2 });
});

test('fields set to null are removed, whatever their name', () => {
  const body = { messages: messages(), temperature: null, logit_bias: null, functions: null, max_tokens: null, max_completion_tokens: null, seed: null };
  assert.deepEqual(toMistralRequest(body), []);
  assert.deepEqual(body, { messages: messages() });
});

test('falsy values that are not null survive', () => {
  const body = { messages: messages(), temperature: 0, stream: false, stop: '', safe_prompt: false, n: 0 };
  toMistralRequest(body);
  assert.deepEqual(body, { messages: messages(), temperature: 0, stream: false, stop: '', safe_prompt: false, n: 0 });
});

test('anything else Mistral does not support is left in place, to be rejected by Mistral', () => {
  // Dropping these silently would change what the caller asked for.
  const body = { messages: messages(), logit_bias: { 50256: -100 }, functions: [{ name: 'f' }], modalities: ['text', 'audio'], made_up_field: 1 };
  assert.deepEqual(toMistralRequest(body), []);
  assert.deepEqual(Object.keys(body).sort(), ['functions', 'logit_bias', 'made_up_field', 'messages', 'modalities']);
});

test('the developer role becomes system', () => {
  const body = { messages: [{ role: 'developer', content: 'Be brief.' }, { role: 'user', content: 'hi' }] };
  assert.deepEqual(toMistralRequest(body), ['developer->system']);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Be brief.' });
});

test('name is removed from every message except tool results', () => {
  const body = {
    messages: [
      { role: 'system', content: 's', name: 'sys' },
      { role: 'user', content: 'u', name: 'alice' },
      { role: 'assistant', content: 'a', name: 'bot' },
      { role: 'tool', content: 't', tool_call_id: 'abcdefghi', name: 'lookup' },
    ],
  };
  assert.deepEqual(toMistralRequest(body), ['-messages.name']);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a' },
    { role: 'tool', content: 't', tool_call_id: 'abcdefghi', name: 'lookup' },
  ]);
});

test('reasoning copied back into assistant turns is removed', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', reasoning_content: 'they said hi', reasoning: 'r', thinking: 't' },
      { role: 'user', content: 'again' },
    ],
  };
  const adjustments = toMistralRequest(body);
  assert.deepEqual(adjustments.sort(), ['-messages.reasoning', '-messages.reasoning_content', '-messages.thinking']);
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'hello' });
});

test('an empty reasoning_content is removed too', () => {
  // Some clients add the field to every assistant turn, even when empty.
  const body = { messages: [{ role: 'assistant', content: 'x', reasoning_content: '' }] };
  toMistralRequest(body);
  assert.deepEqual(body.messages[0], { role: 'assistant', content: 'x' });
});

test('reasoning fields are only removed from assistant turns', () => {
  const body = { messages: [{ role: 'user', content: 'hi', reasoning_content: 'odd' }] };
  assert.deepEqual(toMistralRequest(body), []);
  assert.equal(body.messages[0].reasoning_content, 'odd');
});

test('null message fields are removed, but a null content is kept', () => {
  const body = {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'abcdefghi', type: 'function', function: { name: 'f', arguments: '{}' } }], refusal: null, audio: null, function_call: null, annotations: null },
      { role: 'assistant', content: 'done', tool_calls: null, refusal: null },
      { role: 'tool', content: 'ok', tool_call_id: 'abcdefghi', name: null },
    ],
  };
  toMistralRequest(body);
  assert.deepEqual(Object.keys(body.messages[0]), ['role', 'content', 'tool_calls']);
  assert.equal(body.messages[0].content, null);
  assert.deepEqual(body.messages[1], { role: 'assistant', content: 'done' });
  assert.deepEqual(body.messages[2], { role: 'tool', content: 'ok', tool_call_id: 'abcdefghi' });
});

test('message content is never altered', () => {
  const content = [
    { type: 'text', text: 'store user seed reasoning_content null \u{1F600}' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: null } },
  ];
  const body = { messages: [{ role: 'user', content: structuredClone(content) }] };
  toMistralRequest(body);
  assert.deepEqual(body.messages[0].content, content);
});

test('the list of adjustments holds field names only, never values', () => {
  const body = {
    user: 'private-user-id',
    seed: 123456789,
    stream_options: { include_usage: true, note: 'private-note' },
    messages: [{ role: 'assistant', content: 'x', name: 'private-name', reasoning_content: 'private-thoughts' }],
  };
  const text = JSON.stringify(toMistralRequest(body));
  for (const secret of ['private-user-id', '123456789', 'private-note', 'private-name', 'private-thoughts']) {
    assert.ok(!text.includes(secret), `${secret} leaked into ${text}`);
  }
});

test('each adjustment is reported once, however often it applies', () => {
  const body = { messages: Array.from({ length: 50 }, () => ({ role: 'user', content: 'x', name: 'n' })) };
  assert.deepEqual(toMistralRequest(body), ['-messages.name']);
});

test('malformed message lists are left for Mistral to reject', () => {
  for (const value of [undefined, null, 'text', 42, {}, [null, 'text', 7, [], { role: 'user', content: 'ok' }]]) {
    const body = { messages: value };
    assert.doesNotThrow(() => toMistralRequest(body));
  }
});

test('a "__proto__" key in the request cannot affect other objects', () => {
  const body = JSON.parse('{"messages":[{"role":"user","content":"x","__proto__":{"polluted":true}}],"__proto__":{"polluted":true}}');
  toMistralRequest(body);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('typical OpenAI client requests come out acceptable to Mistral', () => {
  // Shapes that real clients send, each of which Mistral rejects as-is.
  const requests = [
    // OpenAI SDK defaults used by coding agents (store + max_completion_tokens).
    { model: 'm', messages: messages(), store: false, max_completion_tokens: 4096, stream: true, stream_options: { include_usage: true } },
    // Chat UIs that tag the end user and pin a seed.
    { model: 'm', messages: messages(), user: 'u-1', seed: 1, temperature: 0.7, top_p: 1, presence_penalty: 0, frequency_penalty: 0 },
    // Libraries that serialise every unset option as null.
    { model: 'm', messages: messages(), logit_bias: null, logprobs: null, top_logprobs: null, functions: null, function_call: null, tools: null, tool_choice: null, response_format: null, n: 1, stop: null, service_tier: null, audio: null, modalities: null },
    // Newer OpenAI examples: developer role, named participants.
    { model: 'm', messages: [{ role: 'developer', content: 'd' }, { role: 'user', content: 'u', name: 'alice' }] },
    // A conversation started on a reasoning model and continued here.
    { model: 'm', messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a', reasoning_content: 'r', refusal: null, annotations: null, audio: null, function_call: null, tool_calls: null }, { role: 'user', content: 'u2' }] },
    // A tool round trip in OpenAI's format.
    {
      model: 'm',
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      parallel_tool_calls: true,
      messages: [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'abcdefghi', type: 'function', function: { name: 'f', arguments: '{}' } }], refusal: null },
        { role: 'tool', tool_call_id: 'abcdefghi', content: '42' },
      ],
    },
  ];
  for (const request of requests) {
    assert.notDeepEqual(validateRequest(structuredClone(request)), [], 'the sample should be rejected before translation, or it proves nothing');
    toMistralRequest(request);
    assert.deepEqual(validateRequest(request), [], JSON.stringify(request));
  }
});
