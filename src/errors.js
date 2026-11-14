// Makes Mistral's error responses readable in OpenAI clients.
//
// OpenAI clients look for the explanation of a failure in `error.message`.
// Mistral reports some failures in other shapes; most importantly, a request
// field it does not accept comes back as {"detail":[{loc, msg, type}, ...]}.
// The OpenAI SDKs then show nothing but "Error code: 422", which leaves the
// caller guessing which field was the problem.
//
// describeUpstreamError() derives an OpenAI-style error object from such a
// body. The gateway adds it next to Mistral's original fields, which are all
// kept, so clients written for either API can read the result.

const MAX_PROBLEMS_SHOWN = 5;
const MAX_TEXT = 300;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}...` : text);

/** ["body","messages",2,"assistant","name"] becomes "messages.2.assistant.name". */
function fieldPath(loc) {
  if (!Array.isArray(loc)) return '';
  const parts = loc.filter((part) => typeof part === 'string' || typeof part === 'number').map(String);
  if (parts[0] === 'body') parts.shift();
  return clip(parts.join('.'), 200);
}

function validationProblems(body) {
  // Current responses carry the list at the top level; older ones nested it
  // under "message".
  const detail = Array.isArray(body.detail)
    ? body.detail
    : (isPlainObject(body.message) && Array.isArray(body.message.detail) ? body.message.detail : null);
  if (!detail) return null;
  const problems = detail.filter(isPlainObject).map((entry) => ({
    path: fieldPath(entry.loc),
    text: typeof entry.msg === 'string' ? clip(entry.msg, 200) : 'invalid value',
    type: typeof entry.type === 'string' ? clip(entry.type, 80) : null,
  }));
  return problems.length > 0 ? problems : null;
}

/**
 * Returns { error, rejected } for an upstream error body, or null when the
 * body already has an OpenAI-style error or no explanation can be derived.
 *
 *  - error: the object to add under "error".
 *  - rejected: for validation failures, the field paths and error types, for
 *    the gateway's log. Never any text or value from the request.
 *
 * The value Mistral rejected (its "input") is deliberately left out of both:
 * it can be a piece of the conversation.
 */
export function describeUpstreamError(status, body) {
  if (!isPlainObject(body)) return null;
  // Already in OpenAI's shape, or "error" is used for something else: either
  // way the body is left exactly as it is.
  if (Object.hasOwn(body, 'error')) return null;

  let type = 'invalid_request_error';
  if (status === 429) type = 'rate_limit_error';
  else if (status >= 500) type = 'api_error';

  const problems = validationProblems(body);
  if (problems) {
    const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).map((problem) => (problem.path ? `${problem.path}: ${problem.text}` : problem.text));
    const more = problems.length > MAX_PROBLEMS_SHOWN ? ` (and ${problems.length - MAX_PROBLEMS_SHOWN} more)` : '';
    return {
      error: {
        message: `Mistral rejected the request: ${shown.join('; ')}${more}`,
        type,
        param: problems[0].path || null,
        code: problems[0].type,
      },
      rejected: problems.slice(0, 20).map((problem) => `${problem.path || '(request)'} (${problem.type ?? 'invalid'})`),
    };
  }

  const text = [body.message, body.detail].find((value) => typeof value === 'string' && value.trim() !== '');
  if (text === undefined) return null;
  return {
    error: {
      message: clip(text),
      type: typeof body.type === 'string' ? body.type : type,
      param: typeof body.param === 'string' ? body.param : null,
      code: typeof body.code === 'string' || typeof body.code === 'number' ? body.code : null,
    },
    rejected: null,
  };
}
