// The request handler: authentication, routing, and the proxy to Mistral.

import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { describeUpstreamError } from './errors.js';
import { log as defaultLog } from './log.js';
import { toMistralRequest } from './translate.js';

const USER_AGENT = 'mistral3-gateway/1.0';

// Upstream response headers that are never passed on to the caller.
const NOT_FORWARDED = new Set([
  // These describe a single connection, not the response (RFC 9110, 7.6.1).
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  // These belong to the upstream's own address and would be wrong, or leak
  // its cookies, if they were repeated from this one.
  'set-cookie', 'alt-svc', 'strict-transport-security', 'www-authenticate', 'location',
]);

// Error responses up to this size are read in full so that an explanation
// OpenAI clients can display is added to them. Real API errors are far
// smaller; anything bigger is relayed as it is.
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const noop = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest();
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const errorBody = (message, type, code) => ({ error: { message, type, param: null, code } });

class BodyError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Builds the handler for http.createServer().
 * `config` comes from loadConfig(); `log` can be replaced in tests.
 */
export function createApp(config, { log = defaultLog } = {}) {
  const chatUrl = new URL(`${config.baseUrl}/chat/completions`);
  const transport = chatUrl.protocol === 'https:' ? https : http;

  // A fresh connection per request. Reusing idle connections saves a little
  // time per call, but a reused connection that the other side has just closed
  // fails the request, and a chat request cannot safely be sent twice. Next to
  // the seconds a completion takes, one handshake is not worth that risk.
  const agent = new transport.Agent({ keepAlive: false });

  // Keys are compared as fixed-length digests, in constant time, so neither
  // the length nor the content of a key can be learned from response timing.
  const keyDigests = config.gatewayKeys.map(sha256);

  const startedAtSeconds = Math.floor(Date.now() / 1000);
  const modelObject = { id: config.model, object: 'model', created: startedAtSeconds, owned_by: 'mistralai' };

  function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
  }

  function isValidKey(token) {
    const digest = sha256(token);
    let valid = false;
    // No early exit: every configured key is always checked.
    for (const expected of keyDigests) {
      if (timingSafeEqual(digest, expected)) valid = true;
    }
    return valid;
  }

  function sendJson(req, res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(payload));
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    };
    // Answering before the request body has been read (a rejected key, an
    // oversized body): close the connection instead of reading the rest.
    const expectsBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
    if (expectsBody && !req.complete) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length']) > config.maxBodyBytes) {
        reject(new BodyError('too_large'));
        return;
      }
      const chunks = [];
      let size = 0;
      const stop = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('close', onClose);
      };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          stop();
          req.pause();
          reject(new BodyError('too_large'));
        } else {
          chunks.push(chunk);
        }
      };
      const onEnd = () => {
        stop();
        resolve(Buffer.concat(chunks, size));
      };
      const onClose = () => {
        stop();
        reject(new BodyError('client_closed'));
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('close', onClose);
    });
  }

  function forwardableHeaders(upstreamHeaders) {
    const headers = {};
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      if (NOT_FORWARDED.has(name) || name.startsWith('access-control-')) continue;
      headers[name] = value;
    }
    return headers;
  }

  function proxyChatCompletion(req, res, payload, ctx) {
    const upstreamReq = transport.request(chatUrl, {
      method: 'POST',
      agent,
      // Built from scratch: nothing the caller sent (their key, cookies, IP
      // address, custom headers) is passed on to Mistral.
      headers: {
        authorization: `Bearer ${config.mistralApiKey}`,
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: ctx.stream ? 'text/event-stream' : 'application/json',
        // Uncompressed, so stream chunks are relayed the moment they arrive.
        'accept-encoding': 'identity',
        'user-agent': USER_AGENT,
      },
    });

    let answered = false; // a response to the caller has been started
    let clientGone = false;
    let timedOut = false;

    const failWith = (status, code, message) => {
      if (answered || clientGone) return;
      answered = true;
      ctx.error = code;
      sendJson(req, res, status, errorBody(message, 'api_error', code));
    };

    // The caller disconnected (for example, pressed "stop"): end the upstream
    // request too, so Mistral stops generating.
    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      upstreamReq.destroy();
    });

    // Fires when the upstream connection has been silent for this long,
    // whether while waiting for the response or in the middle of a stream.
    upstreamReq.setTimeout(config.upstreamTimeoutMs, () => {
      timedOut = true;
      upstreamReq.destroy();
    });

    upstreamReq.on('error', (err) => {
      ctx.upstreamError = err.code ?? err.message;
      if (timedOut) {
        failWith(504, 'upstream_timeout', `The model did not answer within ${Math.round(config.upstreamTimeoutMs / 1000)} seconds. For long answers, send "stream": true.`);
      } else {
        failWith(502, 'upstream_unreachable', 'The gateway could not reach the Mistral API. Try again shortly.');
      }
    });

    upstreamReq.on('response', (upstreamRes) => {
      upstreamRes.on('error', noop);
      const status = upstreamRes.statusCode;
      ctx.upstreamStatus = status;
      ctx.ttfbMs = Date.now() - ctx.startedAt;

      // The caller's key was already accepted, so a 401 here means the
      // gateway's own Mistral key is wrong. Passing it on would tell the
      // caller, misleadingly, that their key is the problem.
      if (status === 401) {
        upstreamRes.resume();
        failWith(502, 'upstream_auth_failed', 'The gateway is misconfigured: Mistral rejected its API key. Check MISTRAL_API_KEY.');
        return;
      }
      // Never relay a redirect: a client that followed it would send the
      // gateway key to whatever address it points at.
      if (status >= 300 && status < 400) {
        upstreamRes.resume();
        failWith(502, 'upstream_redirect', 'The gateway is misconfigured: the upstream answered with a redirect. Check MISTRAL_BASE_URL.');
        return;
      }
      if (answered || clientGone) {
        upstreamRes.resume();
        return;
      }

      const headers = forwardableHeaders(upstreamRes.headers);

      // Starts the response to the caller. Returns false if that failed.
      const begin = (responseHeaders) => {
        try {
          res.writeHead(status, responseHeaders);
        } catch {
          upstreamRes.resume();
          failWith(502, 'upstream_bad_response', 'The upstream sent a response the gateway could not relay.');
          return false;
        }
        answered = true;
        return true;
      };

      upstreamRes.on('close', () => {
        if (upstreamRes.complete || clientGone) return;
        // The upstream broke off part-way.
        const code = timedOut ? 'upstream_stalled' : 'upstream_incomplete';
        if (res.headersSent) {
          // The status line has already gone out, so the honest signal is to
          // cut the connection: the caller then sees a failed response
          // instead of a truncated answer that looks complete.
          ctx.error = code;
          res.destroy();
        } else {
          failWith(timedOut ? 504 : 502, code, 'The Mistral API broke off its answer part-way. Try again.');
        }
      });

      const encoding = upstreamRes.headers['content-encoding'];
      const isReadableError = status >= 400
        && /json/i.test(String(upstreamRes.headers['content-type'] ?? ''))
        && (encoding === undefined || encoding === 'identity');

      if (!isReadableError) {
        // The normal case. Bytes are relayed exactly as received, as they
        // arrive, with backpressure.
        if (!begin(headers)) return;
        res.flushHeaders();
        upstreamRes.pipe(res);
        return;
      }

      // An error with a JSON body. It is small, so read it whole and add an
      // explanation that OpenAI clients can display (see errors.js).
      const chunks = [];
      let size = 0;
      let relayingAsIs = false;
      upstreamRes.on('data', (chunk) => {
        if (relayingAsIs) return; // pipe() below is handling the rest
        chunks.push(chunk);
        size += chunk.length;
        if (size <= MAX_ERROR_BODY_BYTES) return;
        relayingAsIs = true;
        if (!begin(headers)) return;
        for (const buffered of chunks) res.write(buffered);
        upstreamRes.pipe(res);
      });
      upstreamRes.on('end', () => {
        if (relayingAsIs || answered || clientGone) return;
        let body = Buffer.concat(chunks, size);
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          const described = describeUpstreamError(status, parsed);
          if (described) {
            parsed.error = described.error;
            body = Buffer.from(JSON.stringify(parsed));
            if (described.rejected) ctx.rejected = described.rejected;
          }
        } catch { /* not JSON after all: relay it as it is */ }
        if (!begin({ ...headers, 'content-length': body.length })) return;
        res.end(body);
      });
    });

    upstreamReq.end(payload);
  }

  async function handleChatCompletion(req, res, ctx) {
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && String(encoding).toLowerCase() !== 'identity') {
      sendJson(req, res, 415, errorBody('Compressed request bodies are not supported. Send the JSON uncompressed.', 'invalid_request_error', 'unsupported_content_encoding'));
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err instanceof BodyError && err.reason === 'too_large') {
        const limitMb = Math.floor(config.maxBodyBytes / (1024 * 1024));
        sendJson(req, res, 413, errorBody(`The request body is larger than this gateway accepts (${limitMb} MB). Send large images as URLs instead of inline data.`, 'invalid_request_error', 'request_too_large'));
        return;
      }
      if (err instanceof BodyError) return; // the caller went away mid-upload
      throw err;
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(req, res, 400, errorBody('The request body is not valid JSON.', 'invalid_request_error', 'invalid_json'));
      return;
    }
    if (!isPlainObject(body)) {
      sendJson(req, res, 400, errorBody('The request body must be a JSON object.', 'invalid_request_error', 'invalid_json'));
      return;
    }

    // This endpoint serves exactly one model. Refusing other names keeps a
    // gateway key from being used to run other (possibly pricier) models on
    // the same Mistral account.
    if (body.model === undefined || body.model === null || body.model === '') {
      body.model = config.model;
    } else if (body.model !== config.model) {
      const asked = String(typeof body.model === 'string' ? body.model : JSON.stringify(body.model)).slice(0, 120);
      sendJson(req, res, 404, errorBody(`The model "${asked}" is not available on this endpoint. It serves "${config.model}".`, 'invalid_request_error', 'model_not_found'));
      return;
    }

    ctx.stream = body.stream === true;
    ctx.adjusted = toMistralRequest(body);

    let payload;
    try {
      payload = Buffer.from(JSON.stringify(body));
    } catch {
      // Parsing copes with any nesting depth; writing the JSON back out does
      // not. Only a deliberately pathological body gets here.
      sendJson(req, res, 400, errorBody('The request body is nested too deeply to process.', 'invalid_request_error', 'invalid_json'));
      return;
    }
    proxyChatCompletion(req, res, payload, ctx);
  }

  async function route(req, res, ctx) {
    let path;
    try {
      path = new URL(req.url, 'http://gateway.invalid').pathname;
    } catch {
      ctx.path = '(unparseable)';
      sendJson(req, res, 400, errorBody('The request URL could not be parsed.', 'invalid_request_error', 'invalid_url'));
      return;
    }
    ctx.path = path.slice(0, 200);

    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const methodNotAllowed = (allow) => sendJson(req, res, 405,
      errorBody(`${req.method} is not supported on ${ctx.path}. Use ${allow}.`, 'invalid_request_error', 'method_not_allowed'),
      { allow });

    // Public: tells Railway (and you) that the service is up. It never
    // contacts Mistral, so it costs nothing and cannot fail a deploy because
    // of an upstream outage.
    if (path === '/health' || path === '/') {
      if (!isRead) return methodNotAllowed('GET, HEAD');
      const payload = path === '/health'
        ? { status: 'ok' }
        : { status: 'ok', service: 'mistral3-gateway', usage: "POST /v1/chat/completions with the header 'Authorization: Bearer <your gateway key>'" };
      sendJson(req, res, 200, payload);
      return;
    }

    // Everything else needs a key, checked before any request body is read.
    const token = bearerToken(req);
    if (token === null || !isValidKey(token)) {
      const message = token === null
        ? "No API key provided. Send your gateway key in the Authorization header: 'Authorization: Bearer <key>'."
        : 'Incorrect API key provided. Use the gateway key (GATEWAY_API_KEY), not your Mistral key.';
      sendJson(req, res, 401, errorBody(message, 'authentication_error', 'invalid_api_key'), { 'www-authenticate': 'Bearer' });
      return;
    }

    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') return methodNotAllowed('POST');
      await handleChatCompletion(req, res, ctx);
      return;
    }

    if (path === '/v1/models') {
      if (!isRead) return methodNotAllowed('GET, HEAD');
      sendJson(req, res, 200, { object: 'list', data: [modelObject] });
      return;
    }

    if (path.startsWith('/v1/models/')) {
      if (!isRead) return methodNotAllowed('GET, HEAD');
      let id = path.slice('/v1/models/'.length);
      try {
        id = decodeURIComponent(id);
      } catch { /* keep the raw text; it will simply not match */ }
      if (id === config.model) {
        sendJson(req, res, 200, modelObject);
      } else {
        sendJson(req, res, 404, errorBody(`The model "${id.slice(0, 120)}" is not available on this endpoint. It serves "${config.model}".`, 'invalid_request_error', 'model_not_found'));
      }
      return;
    }

    const hint = path === '/chat/completions' || path === '/models'
      ? ` Did you mean /v1${path}? Set your client's base URL so that it ends with /v1.`
      : ' Available: POST /v1/chat/completions, GET /v1/models.';
    sendJson(req, res, 404, errorBody(`Unknown path ${ctx.path}.${hint}`, 'invalid_request_error', 'not_found'));
  }

  function logRequest(req, res, ctx) {
    if (ctx.path === '/health') return; // deploy checks and uptime monitors would drown everything else
    const delivered = res.writableFinished;
    const status = res.headersSent ? res.statusCode : 0;
    const outcome = delivered ? String(status) : (ctx.error ?? 'client_closed');

    let level = 'info';
    if (ctx.error || status >= 500) level = 'error';
    else if (delivered && status >= 400) level = 'warn';

    const entry = {
      requestId: ctx.requestId,
      method: req.method,
      path: ctx.path,
      status,
      durationMs: Date.now() - ctx.startedAt,
    };
    if (!delivered) entry.incomplete = true;
    if (ctx.error) entry.error = ctx.error;
    if (ctx.stream !== undefined) entry.stream = ctx.stream;
    if (ctx.ttfbMs !== undefined) entry.ttfbMs = ctx.ttfbMs;
    if (ctx.upstreamStatus !== undefined) entry.upstreamStatus = ctx.upstreamStatus;
    if (ctx.upstreamError !== undefined) entry.upstreamError = ctx.upstreamError;
    if (ctx.adjusted?.length) entry.adjusted = ctx.adjusted;
    if (ctx.rejected) entry.rejected = ctx.rejected;
    if (ctx.upstreamStatus === 404) {
      entry.hint = `Mistral answered 404. If this keeps happening, the model "${config.model}" may have been retired; set MISTRAL_MODEL to a current model.`;
    }
    log(level, `${req.method} ${ctx.path} ${outcome}`, entry);
  }

  return function handle(req, res) {
    const railwayId = req.headers['x-railway-request-id'];
    const ctx = {
      startedAt: Date.now(),
      // Railway's own id when present, so these lines match its HTTP logs.
      requestId: typeof railwayId === 'string' && railwayId ? railwayId.slice(0, 100) : randomUUID(),
      path: '',
    };

    // Without listeners, an error event on either stream would crash the
    // process. Failures are handled through the close events instead.
    req.on('error', noop);
    res.on('error', noop);
    res.on('close', () => logRequest(req, res, ctx));

    route(req, res, ctx).catch((err) => {
      ctx.error = 'internal_error';
      log('error', 'Unhandled error while handling a request', { requestId: ctx.requestId, stack: err?.stack ?? String(err) });
      if (!res.headersSent) {
        sendJson(req, res, 500, errorBody('The gateway hit an internal error.', 'api_error', 'internal_error'));
      } else {
        res.destroy();
      }
    });
  };
}
