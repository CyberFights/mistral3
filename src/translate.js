// Adjusts an OpenAI-style chat request so that Mistral's API accepts it.
//
// Mistral's API is strict: a single field it does not know fails the whole
// request with "422 extra_forbidden". Ordinary OpenAI clients send several
// such fields. This module fixes only the cases listed below and leaves
// everything else untouched, so anything else Mistral does not support still
// comes back to the caller as Mistral's own, specific error rather than being
// silently ignored.
//
// The lists come from Mistral's published request schema (mistralai Python
// client 3.7.0) and from the error reports linked in the README.

// Exact equivalents that only differ in name.
const RENAMED = [
  // OpenAI's current name for the output limit. It wins if both are given.
  { from: 'max_completion_tokens', to: 'max_tokens', overwrite: true },
  // Same meaning, different name. An explicit random_seed is kept.
  { from: 'seed', to: 'random_seed', overwrite: false },
];

// Bookkeeping fields that never change what the model generates.
//  - store, user, safety_identifier: OpenAI-side storage and end-user tagging.
//  - stream_options: asks OpenAI to report token usage on a stream. Mistral
//    always reports usage in the last chunk and has no such option.
const DROPPED = ['store', 'user', 'safety_identifier', 'stream_options'];

// Reasoning text that some clients copy back into earlier assistant turns.
// Mistral rejects these fields, and Mistral Large 3 has no use for them.
const DROPPED_FROM_ASSISTANT = ['reasoning_content', 'reasoning', 'thinking'];

const has = (object, key) => Object.hasOwn(object, key);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Adjusts `body` in place.
 * Returns the names of the adjustments made, for logging. Names only: no
 * values from the request are ever included.
 */
export function toMistralRequest(body) {
  const adjustments = new Set();

  // null means "not set" in both APIs, so removing it never changes meaning,
  // and it keeps unset OpenAI-only options from being rejected.
  for (const key of Object.keys(body)) {
    if (body[key] === null) delete body[key];
  }

  for (const { from, to, overwrite } of RENAMED) {
    if (!has(body, from)) continue;
    if (overwrite || !has(body, to)) body[to] = body[from];
    delete body[from];
    adjustments.add(`${from}->${to}`);
  }

  for (const key of DROPPED) {
    if (!has(body, key)) continue;
    delete body[key];
    adjustments.add(`-${key}`);
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isPlainObject(message)) adjustMessage(message, adjustments);
    }
  }

  return [...adjustments];
}

function adjustMessage(message, adjustments) {
  // OpenAI renamed "system" to "developer" for its newer models. Mistral only
  // knows "system".
  if (message.role === 'developer') {
    message.role = 'system';
    adjustments.add('developer->system');
  }

  // As above, null means "not set". `content` is the exception: a null
  // content is meaningful on an assistant turn that only calls tools.
  for (const key of Object.keys(message)) {
    if (key !== 'content' && message[key] === null) delete message[key];
  }

  // Mistral only accepts `name` on tool results.
  if (message.role !== 'tool' && has(message, 'name')) {
    delete message.name;
    adjustments.add('-messages.name');
  }

  if (message.role === 'assistant') {
    for (const key of DROPPED_FROM_ASSISTANT) {
      if (!has(message, key)) continue;
      delete message[key];
      adjustments.add(`-messages.${key}`);
    }
  }
}
