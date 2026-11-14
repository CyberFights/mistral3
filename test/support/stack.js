// Starts a gateway in front of the Mistral stand-in, for the integration tests.

import http from 'node:http';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { startMockMistral } from './mock-mistral.js';

export const MISTRAL_KEY = 'mistral-upstream-secret-0123456789';
export const GATEWAY_KEY = 'gateway-client-secret-0123456789';
export const SECOND_GATEWAY_KEY = 'gateway-second-secret-0123456789';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something truthy, or fails after `timeoutMs`. */
export async function waitFor(check, { timeoutMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * Starts the stand-in and a gateway pointed at it.
 *  - env: extra environment variables for loadConfig().
 *  - overrides: config values to replace after loading (limits, timeouts).
 *  - upstreamKey: the key the stand-in expects (differs from MISTRAL_KEY to
 *    simulate a wrong MISTRAL_API_KEY).
 */
export async function startStack(t, { env = {}, overrides = {}, upstreamKey = MISTRAL_KEY } = {}) {
  const mock = await startMockMistral({ apiKey: upstreamKey });
  const logs = [];
  const config = {
    ...loadConfig({
      MISTRAL_API_KEY: MISTRAL_KEY,
      GATEWAY_API_KEY: `${GATEWAY_KEY},${SECOND_GATEWAY_KEY}`,
      MISTRAL_BASE_URL: mock.url,
      ...env,
    }),
    ...overrides,
  };
  const server = http.createServer(createApp(config, {
    log: (level, message, fields) => logs.push({ level, message, ...fields }),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const stack = {
    url: `http://127.0.0.1:${port}`,
    port,
    mock,
    logs,
    server,
    /** POSTs a chat completion through the gateway. */
    chat(body, { key = GATEWAY_KEY, headers = {}, signal } = {}) {
      return fetch(`${stack.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
      });
    },
    get(path, { key = GATEWAY_KEY, headers = {} } = {}) {
      return fetch(`${stack.url}${path}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
    },
    /** Waits for the gateway's log line for a request (written when it ends). */
    logFor(match, what = 'the request log line') {
      return waitFor(() => logs.find(match), { what });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
    },
  };
  t.after(() => stack.close());
  return stack;
}

export const userSays = (text) => ({ model: 'mistral-large-2512', messages: [{ role: 'user', content: text }] });
