import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, DEFAULT_BASE_URL, DEFAULT_MODEL, loadConfig } from '../src/config.js';

const MISTRAL_KEY = 'mistral-test-key-0123456789abcdef';
const GATEWAY_KEY = 'gateway-test-key-0123456789abcdef';
const valid = { MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: GATEWAY_KEY };

/** Loads a config expected to fail and returns its list of problems. */
function problemsOf(env) {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err}`);
    return err.problems;
  }
  assert.fail('expected the configuration to be rejected, but it was accepted');
}

test('the two keys alone are enough; everything else has a default', () => {
  const config = loadConfig(valid);
  assert.equal(config.mistralApiKey, MISTRAL_KEY);
  assert.deepEqual([...config.gatewayKeys], [GATEWAY_KEY]);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.model, 'mistral-large-2512');
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.baseUrl, 'https://api.mistral.ai/v1');
  assert.equal(config.port, 8080);
  assert.deepEqual([...config.warnings], []);
});

test('refuses to start with no keys, and names both', () => {
  const problems = problemsOf({});
  assert.equal(problems.length, 2);
  assert.match(problems[0], /MISTRAL_API_KEY is not set/);
  assert.match(problems[1], /GATEWAY_API_KEY is not set/);
});

test('refuses to start without a gateway key, so the endpoint is never open', () => {
  for (const value of [undefined, '', '   ', ',', ' , , ']) {
    const problems = problemsOf({ MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: value });
    assert.equal(problems.length, 1, `value ${JSON.stringify(value)}`);
    assert.match(problems[0], /GATEWAY_API_KEY is not set/);
  }
});

test('refuses a gateway key that is the Mistral key', () => {
  const problems = problemsOf({ MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: MISTRAL_KEY });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /same as MISTRAL_API_KEY/);
  // Also when it hides among several keys.
  const hidden = problemsOf({ MISTRAL_API_KEY: MISTRAL_KEY, GATEWAY_API_KEY: `${GATEWAY_KEY},${MISTRAL_KEY}` });
  assert.equal(hidden.length, 1);
  assert.match(hidden[0], /entry 2.*same as MISTRAL_API_KEY/);
});

test('refuses short gateway keys', () => {
  assert.match(problemsOf({ ...valid, GATEWAY_API_KEY: 'changeme' })[0], /too short \(8 characters, minimum 16\)/);
  assert.match(problemsOf({ ...valid, GATEWAY_API_KEY: 'a'.repeat(15) })[0], /too short/);
  assert.doesNotThrow(() => loadConfig({ ...valid, GATEWAY_API_KEY: 'a'.repeat(16) }));
});

test('never repeats a key in an error message', () => {
  const secret = 'short-secret';
  for (const problem of problemsOf({ MISTRAL_API_KEY: 'bad key with spaces', GATEWAY_API_KEY: secret })) {
    assert.ok(!problem.includes(secret), problem);
    assert.ok(!problem.includes('bad key with spaces'), problem);
  }
});

test('accepts several gateway keys, trims them and drops duplicates', () => {
  const second = 'second-gateway-key-0123456789';
  const config = loadConfig({ ...valid, GATEWAY_API_KEY: ` ${GATEWAY_KEY} , ${second},${GATEWAY_KEY}, ` });
  assert.deepEqual([...config.gatewayKeys], [GATEWAY_KEY, second]);
});

test('trims stray whitespace and line breaks from pasted keys', () => {
  const config = loadConfig({ MISTRAL_API_KEY: `  ${MISTRAL_KEY}\n`, GATEWAY_API_KEY: `${GATEWAY_KEY}\r\n` });
  assert.equal(config.mistralApiKey, MISTRAL_KEY);
  assert.deepEqual([...config.gatewayKeys], [GATEWAY_KEY]);
});

test('refuses keys that could not be sent in a header', () => {
  assert.match(problemsOf({ ...valid, MISTRAL_API_KEY: 'key with spaces inside it' })[0], /MISTRAL_API_KEY contains spaces or characters/);
  assert.match(problemsOf({ ...valid, MISTRAL_API_KEY: '\u201cquoted-key-0123456789\u201d' })[0], /MISTRAL_API_KEY contains/);
  assert.match(problemsOf({ ...valid, GATEWAY_API_KEY: 'two words that are long enough' })[0], /GATEWAY_API_KEY contains spaces/);
});

test('MISTRAL_MODEL overrides the model, and blank falls back to the default', () => {
  assert.equal(loadConfig({ ...valid, MISTRAL_MODEL: ' mistral-large-4 ' }).model, 'mistral-large-4');
  assert.equal(loadConfig({ ...valid, MISTRAL_MODEL: '   ' }).model, DEFAULT_MODEL);
});

test('MISTRAL_BASE_URL is normalised', () => {
  assert.equal(loadConfig({ ...valid, MISTRAL_BASE_URL: 'https://api.mistral.ai/v1/' }).baseUrl, 'https://api.mistral.ai/v1');
  assert.equal(loadConfig({ ...valid, MISTRAL_BASE_URL: 'https://example.com:8443/eu/v1///' }).baseUrl, 'https://example.com:8443/eu/v1');
  assert.equal(loadConfig({ ...valid, MISTRAL_BASE_URL: '   ' }).baseUrl, DEFAULT_BASE_URL);
});

test('refuses unusable base URLs', () => {
  assert.match(problemsOf({ ...valid, MISTRAL_BASE_URL: 'api.mistral.ai/v1' })[0], /not a valid URL/);
  assert.match(problemsOf({ ...valid, MISTRAL_BASE_URL: 'ftp://api.mistral.ai/v1' })[0], /must start with https:\/\//);
  assert.match(problemsOf({ ...valid, MISTRAL_BASE_URL: 'https://user:pass@api.mistral.ai/v1' })[0], /must not contain a username or password/);
  assert.match(problemsOf({ ...valid, MISTRAL_BASE_URL: 'https://api.mistral.ai/v1?key=1' })[0], /must not contain a query string/);
});

test('warns about unencrypted upstreams, except on this machine', () => {
  const remote = loadConfig({ ...valid, MISTRAL_BASE_URL: 'http://10.0.0.5:8000/v1' });
  assert.equal(remote.warnings.length, 1);
  assert.match(remote.warnings[0], /unencrypted/);
  for (const local of ['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1']) {
    assert.deepEqual([...loadConfig({ ...valid, MISTRAL_BASE_URL: local }).warnings], [], local);
  }
});

test('PORT must be a real port number', () => {
  assert.equal(loadConfig({ ...valid, PORT: '3000' }).port, 3000);
  assert.equal(loadConfig({ ...valid, PORT: ' 65535 ' }).port, 65535);
  for (const bad of ['0', '65536', '-1', '80.5', 'http', '8080abc']) {
    assert.match(problemsOf({ ...valid, PORT: bad })[0], /PORT must be a whole number/, bad);
  }
});

test('reports every problem at once', () => {
  const problems = problemsOf({ GATEWAY_API_KEY: 'tiny', MISTRAL_BASE_URL: 'nope', PORT: 'x' });
  assert.equal(problems.length, 4);
});

test('the configuration cannot be changed after loading', () => {
  const config = loadConfig(valid);
  assert.throws(() => { config.model = 'other'; }, TypeError);
  assert.throws(() => { config.gatewayKeys.push('extra'); }, TypeError);
});
