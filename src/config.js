// Reads and validates configuration from environment variables.
//
// The gateway refuses to start when its configuration is unsafe or incomplete.
// An endpoint in front of a paid API must never come up without a key in front
// of it, so every problem here is fatal rather than a warning.

export const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

// Mistral's hosted Mistral Large 3. Mistral deprecated this model on
// 2026-10-30 and retires it on 2027-04-29; see "Model retirement" in the
// README. Change it with the MISTRAL_MODEL variable, no code change needed.
export const DEFAULT_MODEL = 'mistral-large-2512';

export const DEFAULT_PORT = 8080;
export const MIN_GATEWAY_KEY_LENGTH = 16;

// Largest request body the gateway will buffer. Requests are parsed in memory
// because the model name and a few fields have to be checked and rewritten.
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Railway's edge closes a request after 5 minutes with no data transferred.
// Giving up slightly earlier lets the gateway answer with a clear 504 instead
// of the client seeing a bare disconnect.
export const UPSTREAM_TIMEOUT_MS = 290_000;

// Header values may only hold visible ASCII. A key with a stray space, quote
// mark or line break would otherwise fail on every request instead of once,
// clearly, at startup.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const HOW_TO_GENERATE = 'Generate one with: openssl rand -hex 32';

export function loadConfig(env = process.env) {
  const problems = [];
  const warnings = [];

  const mistralApiKey = (env.MISTRAL_API_KEY ?? '').trim();
  if (!mistralApiKey) {
    problems.push('MISTRAL_API_KEY is not set. Create a key at https://console.mistral.ai and set it as a variable.');
  } else if (!VISIBLE_ASCII.test(mistralApiKey)) {
    problems.push('MISTRAL_API_KEY contains spaces or characters that cannot be sent in a header. Paste the key exactly, with no quotes.');
  }

  const gatewayKeys = [...new Set(
    (env.GATEWAY_API_KEY ?? '').split(',').map((key) => key.trim()).filter(Boolean),
  )];
  if (gatewayKeys.length === 0) {
    problems.push(`GATEWAY_API_KEY is not set. This is the key your own apps send to this gateway. ${HOW_TO_GENERATE}`);
  }
  gatewayKeys.forEach((key, index) => {
    const label = gatewayKeys.length > 1 ? `GATEWAY_API_KEY (entry ${index + 1})` : 'GATEWAY_API_KEY';
    if (!VISIBLE_ASCII.test(key)) {
      problems.push(`${label} contains spaces or characters that cannot be sent in a header. Separate several keys with commas only.`);
    } else if (key.length < MIN_GATEWAY_KEY_LENGTH) {
      problems.push(`${label} is too short (${key.length} characters, minimum ${MIN_GATEWAY_KEY_LENGTH}). ${HOW_TO_GENERATE}`);
    }
    if (mistralApiKey && key === mistralApiKey) {
      problems.push(`${label} is the same as MISTRAL_API_KEY. They must differ: the gateway key is what you hand to apps, and the Mistral key must never leave this server. ${HOW_TO_GENERATE}`);
    }
  });

  const model = (env.MISTRAL_MODEL ?? '').trim() || DEFAULT_MODEL;

  let baseUrl = DEFAULT_BASE_URL;
  const rawBaseUrl = (env.MISTRAL_BASE_URL ?? '').trim();
  if (rawBaseUrl) {
    let parsed = null;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      problems.push(`MISTRAL_BASE_URL is not a valid URL: "${rawBaseUrl}". Expected something like ${DEFAULT_BASE_URL}`);
    }
    if (parsed) {
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        problems.push(`MISTRAL_BASE_URL must start with https:// (got "${parsed.protocol}//").`);
      } else if (parsed.username || parsed.password) {
        problems.push('MISTRAL_BASE_URL must not contain a username or password. Use MISTRAL_API_KEY for credentials.');
      } else if (parsed.search || parsed.hash) {
        problems.push('MISTRAL_BASE_URL must not contain a query string or fragment.');
      } else {
        baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
        const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if (parsed.protocol === 'http:' && !isLoopback) {
          warnings.push('MISTRAL_BASE_URL uses plain http://, so the Mistral API key and every prompt travel unencrypted. Use https:// unless this is a private network you control.');
        }
      }
    }
  }

  let port = DEFAULT_PORT;
  const rawPort = (env.PORT ?? '').trim();
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`PORT must be a whole number between 1 and 65535 (got "${rawPort}").`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    mistralApiKey,
    gatewayKeys: Object.freeze(gatewayKeys),
    model,
    baseUrl,
    port,
    maxBodyBytes: MAX_BODY_BYTES,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    warnings: Object.freeze(warnings),
  });
}
