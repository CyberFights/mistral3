// A stand-in for Mistral's chat completions API, used by the tests.
//
// The real API cannot be called from the test suite, so this aims to be as
// strict as the real one in the ways that matter to the gateway:
//
//  - It accepts only the request fields in Mistral's published schema
//    (mistralai Python client 3.7.0, ChatCompletionRequest and the four
//    message types) and rejects anything else the way the real API does:
//    HTTP 422 with {"detail":[{"type":"extra_forbidden","loc":[...],...}]}.
//    That error shape is copied from real responses quoted in public bug
//    reports (see the README).
//  - It enforces the order of messages around tool calls and answers a
//    violation with the body the real API sends (HTTP 400, type
//    "invalid_request_message_order", code "3230"), also copied from a
//    public bug report.
//  - It requires the Mistral API key, and nothing but that key.
//  - It answers in Mistral's response and streaming formats, including tool
//    calls.
//
// It is a model of the real API, not the real API. See "What was not tested"
// in the README.

import http from 'node:http';
import https from 'node:https';

export const REQUEST_FIELDS = new Set([
  'model', 'temperature', 'top_p', 'max_tokens', 'stream', 'stop', 'random_seed',
  'metadata', 'messages', 'response_format', 'tools', 'tool_choice',
  'presence_penalty', 'frequency_penalty', 'min_tokens', 'repetition_penalty',
  'top_k', 'logprobs', 'top_logprobs', 'prompt_logprobs', 'top_prompt_logprobs',
  'n', 'prediction', 'parallel_tool_calls', 'reasoning_effort', 'prompt_mode',
  'guardrails', 'prompt_cache_key', 'service_tier', 'safe_prompt',
]);

export const MESSAGE_FIELDS = {
  system: new Set(['role', 'content']),
  user: new Set(['role', 'content']),
  assistant: new Set(['role', 'content', 'tool_calls', 'prefix']),
  tool: new Set(['role', 'content', 'tool_call_id', 'name']),
};

/** Returns Mistral-style validation errors for a request body (empty if valid). */
export function validateRequest(body) {
  const errors = [];
  const forbidden = (loc, input) => errors.push({ type: 'extra_forbidden', loc, msg: 'Extra inputs are not permitted', input });

  for (const [key, value] of Object.entries(body)) {
    if (!REQUEST_FIELDS.has(key)) forbidden(['body', key], value);
  }
  if (!Array.isArray(body.messages)) {
    errors.push({ type: 'missing', loc: ['body', 'messages'], msg: 'Field required' });
    return errors;
  }
  body.messages.forEach((message, index) => {
    const allowed = MESSAGE_FIELDS[message?.role];
    if (!allowed) {
      errors.push({ type: 'union_tag_invalid', loc: ['body', 'messages', index], msg: `Input tag '${message?.role}' found using 'role' does not match any of the expected tags: 'assistant', 'system', 'tool', 'user'` });
      return;
    }
    for (const [key, value] of Object.entries(message)) {
      if (!allowed.has(key)) forbidden(['body', 'messages', index, message.role, key], value);
    }
  });
  return errors;
}

/**
 * Returns Mistral's complaint about the order of the messages, or null.
 *
 * The wording of the first two is the real API's. The third (a tool result
 * whose id matches no call) is this stand-in's own wording: it is here so a
 * gateway that lost a tool_call_id on the way could not go unnoticed.
 */
export function messageOrderProblem(messages) {
  let previous = null; // the message before the current one
  let openCalls = new Set(); // ids of the calls made by the latest assistant turn
  for (const message of messages) {
    if (message.role === 'tool') {
      const followsCall = previous?.role === 'tool' || (previous?.role === 'assistant' && openCalls.size > 0);
      if (!followsCall) return `Unexpected role 'tool' after role '${previous?.role ?? 'none'}'`;
      if (!openCalls.has(message.tool_call_id)) {
        return `Tool result with id '${message.tool_call_id}' does not answer a tool call of the previous assistant message`;
      }
    } else if (message.role === 'assistant') {
      openCalls = new Set((Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call) => call?.id));
    } else {
      openCalls = new Set();
    }
    previous = message;
  }
  if (previous?.role === 'assistant' && previous.prefix !== true) {
    return 'Expected last role User or Tool (or Assistant with prefix True) for serving but got assistant';
  }
  return null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const lastUserText = (body) => {
  const last = [...body.messages].reverse().find((message) => message.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
};

// Headers a real deployment sits behind: some must be relayed to the caller,
// some must not.
const EXTRA_HEADERS = {
  'set-cookie': ['__cf_bm=upstream-cookie; path=/; HttpOnly'],
  'alt-svc': 'h3=":443"; ma=86400',
  'strict-transport-security': 'max-age=15552000',
  'access-control-allow-origin': '*',
  'x-ratelimit-remaining-tokens': '499000',
  'x-upstream-request-id': 'mock-req-1',
};

/**
 * Starts the stand-in on a free local port.
 * Pass `tls: { key, cert }` to serve HTTPS, as the real API does.
 */
export async function startMockMistral({ apiKey, model = 'mistral-large-2512', tls = null } = {}) {
  const requests = [];
  let override = null;
  let counter = 0;

  const completionId = () => `cmpl-${String(++counter).padStart(6, '0')}`;
  const sendJson = (res, status, payload, headers = {}) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...EXTRA_HEADERS, ...headers });
    res.end(text);
  };

  const sseChunk = (id, delta, finishReason = null, usage) => {
    const chunk = { id, object: 'chat.completion.chunk', created: 1794600000, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  const onRequest = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, raw, body: null, closedEarly: false };
      requests.push(record);
      res.on('close', () => {
        if (!res.writableFinished) record.closedEarly = true;
      });

      // Keep a copy of every byte sent back, so tests can check that the
      // gateway relayed the response exactly.
      const sent = [];
      const keep = (chunk) => {
        if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') sent.push(Buffer.from(chunk));
      };
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = (chunk, ...rest) => {
        keep(chunk);
        return write(chunk, ...rest);
      };
      res.end = (chunk, ...rest) => {
        keep(chunk);
        return end(chunk, ...rest);
      };
      Object.defineProperty(record, 'responseText', { get: () => Buffer.concat(sent).toString('utf8') });

      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        sendJson(res, 401, { message: 'Unauthorized', request_id: 'mock' });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        sendJson(res, 404, { message: 'no Route matched with those values' });
        return;
      }
      try {
        record.body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { message: 'invalid json' });
        return;
      }
      const body = record.body;

      const errors = validateRequest(body);
      if (errors.length > 0) {
        sendJson(res, 422, { detail: errors });
        return;
      }
      if (body.model !== model) {
        sendJson(res, 400, { object: 'error', message: `Invalid model: ${body.model}`, type: 'invalid_model', param: null, code: '1500' });
        return;
      }

      const orderProblem = messageOrderProblem(body.messages);
      if (orderProblem) {
        sendJson(res, 400, { object: 'error', message: orderProblem, type: 'invalid_request_message_order', param: null, code: '3230', raw_status_code: 400 });
        return;
      }

      if (override) {
        const handler = override;
        override = null;
        await handler(req, res, body, { sendJson, sseChunk, completionId });
        return;
      }

      // What to answer:
      //  - a tool call, when tools are offered, the caller insists on one
      //    ("any", "required" or a named function) and the user has just spoken;
      //  - a sentence quoting the tool result, right after a tool result;
      //  - otherwise an echo of the last user message.
      const last = body.messages.at(-1);
      const insistsOnTool = body.tool_choice === 'any' || body.tool_choice === 'required' || isObject(body.tool_choice);
      let text = `echo: ${lastUserText(body)}`;
      let toolCalls = null;
      if (Array.isArray(body.tools) && body.tools.length > 0 && insistsOnTool && last.role === 'user') {
        text = '';
        toolCalls = [{ id: 'D681PevKs', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"city": "Paris"}' }, index: 0 }];
      } else if (last.role === 'tool') {
        text = `The tool said ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}.`;
      }
      const finishReason = toolCalls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 12, total_tokens: 12 + text.length, completion_tokens: text.length };

      if (body.stream === true) {
        const id = completionId();
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...EXTRA_HEADERS });
        res.write(sseChunk(id, { role: 'assistant', content: '' }));
        // One word per chunk, with a pause, so tests can tell a relayed
        // stream from one that was buffered and delivered all at once.
        for (const word of toolCalls ? [] : text.split(/(?<= )/)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (res.destroyed) return;
          res.write(sseChunk(id, { content: word }));
        }
        if (toolCalls) res.write(sseChunk(id, { tool_calls: toolCalls }));
        res.write(sseChunk(id, { content: '' }, finishReason, usage));
        res.end('data: [DONE]\n\n');
        return;
      }

      sendJson(res, 200, {
        id: completionId(),
        object: 'chat.completion',
        created: 1794600000,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text, tool_calls: toolCalls }, finish_reason: finishReason }],
        usage,
      });
    });
  };

  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: tls ? `https://localhost:${port}/v1` : `http://127.0.0.1:${port}/v1`,
    requests,
    /** The most recent request the mock received. */
    get last() {
      return requests.at(-1);
    },
    /** Replaces the default behaviour for the next valid request only. */
    next(handler) {
      override = handler;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
