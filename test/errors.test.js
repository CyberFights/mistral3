import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUpstreamError } from '../src/errors.js';

// Real response bodies from Mistral's API, as quoted in public bug reports.
const EXTRA_FIELD_2026 = { detail: [{ type: 'extra_forbidden', loc: ['body', 'messages', 2, 'assistant', 'reasoning_content'], msg: 'Extra inputs are not permitted' }] };
const EXTRA_FIELD_WITH_INPUT = { detail: [{ type: 'extra_forbidden', loc: ['body', 'max_completion_tokens'], msg: 'Extra inputs are not permitted', input: 200 }] };
const EXTRA_FIELD_2024 = { object: 'error', message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted', input: { include_usage: true } }] }, type: 'invalid_request_error', param: null, code: null };

test('a rejected field is named in a message OpenAI clients display', () => {
  const { error, rejected } = describeUpstreamError(422, EXTRA_FIELD_WITH_INPUT);
  assert.deepEqual(error, {
    message: 'Mistral rejected the request: max_completion_tokens: Extra inputs are not permitted',
    type: 'invalid_request_error',
    param: 'max_completion_tokens',
    code: 'extra_forbidden',
  });
  assert.deepEqual(rejected, ['max_completion_tokens (extra_forbidden)']);
});

test('a rejected field inside a message is located precisely', () => {
  const { error, rejected } = describeUpstreamError(422, EXTRA_FIELD_2026);
  assert.equal(error.message, 'Mistral rejected the request: messages.2.assistant.reasoning_content: Extra inputs are not permitted');
  assert.equal(error.param, 'messages.2.assistant.reasoning_content');
  assert.deepEqual(rejected, ['messages.2.assistant.reasoning_content (extra_forbidden)']);
});

test("the older response shape, with the list nested under 'message', is understood too", () => {
  const { error } = describeUpstreamError(422, EXTRA_FIELD_2024);
  assert.equal(error.message, 'Mistral rejected the request: stream_options: Extra inputs are not permitted');
  assert.equal(error.code, 'extra_forbidden');
});

test('several problems are all listed, up to a limit', () => {
  const entry = (name) => ({ type: 'extra_forbidden', loc: ['body', name], msg: 'Extra inputs are not permitted' });
  const two = describeUpstreamError(422, { detail: [entry('store'), entry('user')] });
  assert.equal(two.error.message, 'Mistral rejected the request: store: Extra inputs are not permitted; user: Extra inputs are not permitted');
  assert.equal(two.error.param, 'store');

  const many = describeUpstreamError(422, { detail: Array.from({ length: 8 }, (_, i) => entry(`field${i}`)) });
  assert.match(many.error.message, /field4: Extra inputs are not permitted \(and 3 more\)$/);
  assert.ok(!many.error.message.includes('field5'));
  assert.equal(many.rejected.length, 8);
});

test('the rejected value is never repeated, in the message or for the log', () => {
  const body = {
    detail: [
      { type: 'extra_forbidden', loc: ['body', 'notes'], msg: 'Extra inputs are not permitted', input: 'private-conversation-text' },
      { type: 'string_type', loc: ['body', 'messages', 0, 'user', 'content'], msg: 'Input should be a valid string', input: { secret: 'private-object-value' }, ctx: { hint: 'private-context' } },
    ],
  };
  const text = JSON.stringify(describeUpstreamError(422, body));
  for (const secret of ['private-conversation-text', 'private-object-value', 'private-context']) {
    assert.ok(!text.includes(secret), `${secret} leaked into ${text}`);
  }
  assert.match(text, /notes: Extra inputs are not permitted/);
  assert.match(text, /messages\.0\.user\.content: Input should be a valid string/);
});

test("Mistral's ordinary error shape keeps its own message, type and code", () => {
  const { error, rejected } = describeUpstreamError(400, { object: 'error', message: 'Invalid model: mistral-large-2512', type: 'invalid_model', param: null, code: '1500' });
  assert.deepEqual(error, { message: 'Invalid model: mistral-large-2512', type: 'invalid_model', param: null, code: '1500' });
  assert.equal(rejected, null);
});

test('a bare message or a text detail is used as it is, with a type that fits the status', () => {
  assert.deepEqual(describeUpstreamError(429, { message: 'Requests rate limit exceeded' }).error,
    { message: 'Requests rate limit exceeded', type: 'rate_limit_error', param: null, code: null });
  assert.deepEqual(describeUpstreamError(503, { message: 'Service unavailable' }).error,
    { message: 'Service unavailable', type: 'api_error', param: null, code: null });
  assert.deepEqual(describeUpstreamError(404, { detail: 'Model not found' }).error,
    { message: 'Model not found', type: 'invalid_request_error', param: null, code: null });
});

test('a body that already has an "error" is left alone, whatever it holds', () => {
  assert.equal(describeUpstreamError(400, { error: { message: 'Already OpenAI-style', type: 'x' } }), null);
  assert.equal(describeUpstreamError(400, { error: 'a plain string', message: 'other text' }), null);
  assert.equal(describeUpstreamError(400, { error: { code: 5 }, detail: 'text' }), null);
  assert.equal(describeUpstreamError(400, { error: null, message: 'text' }), null);
});

test('bodies with nothing to explain are left alone', () => {
  for (const body of [{}, { status: 'failed' }, { message: '' }, { message: '   ' }, { message: 42 }, { detail: [] }, { detail: ['text', 7, null] }, { detail: {} }, [], 'text', 42, null, undefined]) {
    assert.equal(describeUpstreamError(500, body), null, JSON.stringify(body));
  }
});

test('malformed validation entries do not break the explanation', () => {
  const { error, rejected } = describeUpstreamError(422, { detail: [{ loc: 'not-a-list', msg: 42 }, { loc: ['body', { odd: 1 }, 'field', null, 3], msg: 'bad', type: 7 }, 'ignored'] });
  assert.equal(error.message, 'Mistral rejected the request: invalid value; field.3: bad');
  assert.equal(error.param, null);
  assert.equal(error.code, null);
  assert.deepEqual(rejected, ['(request) (invalid)', 'field.3 (invalid)']);
});

test('very long upstream text is cut to a sensible length', () => {
  const long = describeUpstreamError(500, { message: 'x'.repeat(5000) });
  assert.ok(long.error.message.length < 320);
  const longField = describeUpstreamError(422, { detail: [{ loc: ['body', 'f'.repeat(5000)], msg: 'm'.repeat(5000), type: 't'.repeat(5000) }] });
  assert.ok(longField.error.message.length < 500, String(longField.error.message.length));
  assert.ok(longField.rejected[0].length < 320);
});
