# mistral3

Your own endpoint for Mistral Large 3, deployed on Railway and protected by a key you choose. It speaks the OpenAI Chat Completions API, so apps and code written for OpenAI can use it by changing their base URL.

**Where the model runs.** Not on Railway. This service forwards each request to Mistral's hosted `mistral-large-2512`, which is the model published as open weights at [mistralai/Mistral-Large-3-675B-Instruct-2512](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512). Running those weights yourself takes a server with eight H200- or B200-class GPUs (the weights are about 680 GB). Railway has no GPUs and allows at most 24 GB of memory per container. So Railway hosts your endpoint, your key and your logs; Mistral runs the model and bills you per token. Prompts and answers pass through Mistral's API under Mistral's terms. The gateway keeps no copy of them.

**Retirement date.** Mistral has deprecated `mistral-large-2512` and lists 29 April 2027 as the day it is switched off. See [Model retirement](#model-retirement).

## Deploy on Railway

### 1. Get a Mistral API key

Sign in at [console.mistral.ai](https://console.mistral.ai), make sure the account is on a plan with API access, then open [API Keys](https://console.mistral.ai/api-keys) and select **New key**. The key is shown once, so copy it straight away. Mistral asks for an expiry date on each key; note it, because every request fails once the key expires.

### 2. Make up a gateway key

This is the key your own apps will send. It must be different from the Mistral key and at least 16 characters long.

```bash
openssl rand -hex 32
```

### 3. Create the service

1. In the Railway dashboard, click **New Project** and choose **GitHub repo**, then pick this repository.
2. Choose **Add variables** rather than Deploy Now, and set:
   - `MISTRAL_API_KEY`: the key from step 1
   - `GATEWAY_API_KEY`: the key from step 2
3. Click **Deploy**. Railway builds the service from the `Dockerfile`.

Railway may offer to import variable names from `.env.example`. The two keys are empty in that file on purpose, and the gateway refuses to start until both are filled in. Variable changes on Railway are staged, so they take effect only after you deploy them.

### 4. Give it a public address

In the service's **Settings**, find **Networking → Public Networking** and click **Generate Domain**. You get an address like `https://your-service.up.railway.app`.

While in Settings, set the healthcheck path to `/health`. Railway then waits for a new version to answer before sending traffic to it.

### 5. Check that it works

```bash
GATEWAY_API_KEY=your-gateway-key node scripts/check.js https://your-service.up.railway.app
```

This needs Node 22 or newer and a copy of this repository on your computer. It runs seven checks (under a thousand tokens in total) covering a plain completion, a request written the way OpenAI apps write it, a stream, and a tool call. Each failure is printed with its cause. **Run it once after the first deploy**: it is the first time this code meets the real Mistral API (see [What was tested](#what-was-tested-and-what-was-not)).

Without Node, a single request shows whether the basics work:

```bash
curl https://your-service.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer your-gateway-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "mistral-large-2512", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Use it

In any app that accepts an OpenAI-compatible endpoint, enter these three settings:

| Setting | Value |
| --- | --- |
| Base URL | `https://your-service.up.railway.app/v1` |
| API key | your gateway key |
| Model | `mistral-large-2512` |

From Python, with the OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="https://your-service.up.railway.app/v1", api_key="your-gateway-key")
reply = client.chat.completions.create(
    model="mistral-large-2512",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

Streaming (`"stream": true`), tool calls, JSON output and image inputs pass through to Mistral unchanged. Use streaming for long answers: Railway ends any request that goes five minutes without data.

## Variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MISTRAL_API_KEY` | yes | | Your Mistral key. It stays on the server and is never sent to callers. |
| `GATEWAY_API_KEY` | yes | | The key callers must send. Several keys can be listed, separated by commas. |
| `MISTRAL_MODEL` | no | `mistral-large-2512` | The one Mistral model this endpoint serves. |
| `MISTRAL_BASE_URL` | no | `https://api.mistral.ai/v1` | Where requests are forwarded. |
| `PORT` | no | `8080` | Railway sets this itself. |

To replace a gateway key without downtime, list the old and new keys together, move your apps to the new one, then remove the old one.

## What the gateway does

| Route | Key needed | Purpose |
| --- | --- | --- |
| `POST /v1/chat/completions` | yes | Forwarded to Mistral. |
| `GET /v1/models` | yes | Lists the one model served. |
| `GET /health` | no | Says the service is up. Never contacts Mistral. |

A caller sends the gateway key; the gateway replaces it with your Mistral key. Nothing else the caller sends in headers reaches Mistral. Only the configured model can be requested, so a gateway key cannot be used to run other models on your Mistral account.

### Adjustments to requests

Mistral's API rejects a whole request if it contains one field it does not know. OpenAI clients send several such fields, so the gateway makes these changes and no others:

| An OpenAI client sends | Mistral receives | Known from |
| --- | --- | --- |
| `max_completion_tokens` | `max_tokens` | error reports [1](https://github.com/openclaw/openclaw/issues/56546), [2](https://github.com/actions/ai-inference/issues/172) |
| `seed` | `random_seed` | Mistral's request schema |
| `store` | removed | error reports [1](https://github.com/openclaw/openclaw/issues/56546), [3](https://github.com/aliou/pi-ts-aperture/issues/95) |
| `stream_options` | removed | error report [4](https://github.com/cline/cline/issues/582) |
| `user`, `safety_identifier` | removed | Mistral's request schema |
| message role `developer` | role `system` | Mistral's request schema |
| `name` on a message that is not a tool result | removed | Mistral's request schema |
| `reasoning_content`, `reasoning`, `thinking` on assistant messages | removed | error reports [5](https://github.com/yetone/magpie/issues/5462), [6](https://github.com/charmbracelet/crush/issues/1590), [7](https://github.com/BerriAI/litellm/issues/30835) |
| a top-level or message field set to `null` | removed (except a message's `content`) | Mistral's request schema |

Everything else is forwarded as it is. If Mistral rejects it, the caller gets Mistral's own status and error, with one addition: Mistral reports a rejected field in a shape that OpenAI clients display as a bare "Error code: 422", so the gateway adds a standard `error.message` naming the field, for example `Mistral rejected the request: logit_bias: Extra inputs are not permitted`. Successful answers and streams are relayed byte for byte.

### Logs

One JSON line per request: status, duration, and which adjustments were made. Never a key, a prompt or an answer. In Railway's log view, `@level:error` filters to failures and `@requestId:...` finds one request.

## When something goes wrong

| What you see | Cause | Fix |
| --- | --- | --- |
| The deploy crashes; the log says `Configuration problem: ...` | A variable is missing or invalid. | Fix the variable the line names, then deploy again. |
| `401 invalid_api_key` | No gateway key was sent, or the wrong one. | Send `Authorization: Bearer <gateway key>`. It is not the Mistral key. |
| `404 not_found`, "Unknown path" | The app's base URL lacks `/v1`, or it called an API this gateway does not offer. | End the base URL with `/v1`. [Limits](#limits) lists what is not offered. |
| `404 model_not_found` | The app asked for a different model. | Use the model name from `GET /v1/models`. |
| `422`, "Mistral rejected the request: *field*: ..." | The app sent an option Mistral does not accept. | Turn that option off in the app. The log line lists the fields under `rejected`. |
| `429` | Your Mistral account's rate limit. | Wait and retry; the limits are in the Mistral console. |
| `502 upstream_auth_failed` | Mistral refused `MISTRAL_API_KEY`: it is wrong, deleted or expired. | Create a new Mistral key and update the variable. |
| `502 upstream_unreachable` | The gateway could not connect to Mistral. | Retry. If it persists, check that `MISTRAL_BASE_URL` is unset or correct. |
| `504 upstream_timeout` | Mistral sent nothing for 290 seconds. | Send `"stream": true` for long answers. |
| `413 request_too_large` | The request is over 32 MB. | Send images as URLs instead of inline data. |
| A `404` from Mistral, and the log line carries a `hint` | The model may have been retired. | See [Model retirement](#model-retirement). |

## Limits

- **One model, one API.** Each deployment serves one model through Chat Completions. There are no embeddings, no `/v1/responses` and no legacy `/v1/completions`.
- **No spending cap.** The gateway does not rate-limit. Anyone holding a gateway key can spend your Mistral balance, so treat it like a password. If one leaks, change `GATEWAY_API_KEY` and deploy.
- **No browser access from other sites.** The gateway sends no CORS headers, so a web page on another domain cannot call it from the browser. Server-side apps and scripts are unaffected.
- **Time.** Railway ends a request after five minutes without data and after fifteen minutes in any case.
- **No monitoring after deploy.** Railway checks `/health` only when a new version starts.

## Model retirement

Mistral deprecated `mistral-large-2512` at the end of October 2026 and lists 29 April 2027 as its retirement date ([model overview](https://docs.mistral.ai/models)). Mistral's [lifecycle policy](https://docs.mistral.ai/inference/model-lifecycle) says requests to a retired model return 404. From that day this endpoint will pass on that 404, and each failing request will be logged with a hint that the model may have been retired.

To move to another model, set `MISTRAL_MODEL` to its exact id, deploy, change the model name in your apps, and run `scripts/check.js` again. Mistral names [Mistral Large 4](https://docs.mistral.ai/models/mistral-large-4-0) (`mistral-large-4`) as the replacement. It is a different model from the one this repository is named after, with different prices and possibly different behaviour, so check before relying on it.

The open weights on Hugging Face are not affected by the retirement. Running them needs the hardware described at the top.

## Costs

- **Mistral** bills per token. In November 2026 `mistral-large-2512` was listed at about $0.50 per million input tokens and $1.50 per million output tokens. Check Mistral's pricing page for the current figures.
- **Railway** charges for the plan (Hobby is $5 a month) and for resources used ($10 per GB of memory and $20 per vCPU per month). In local tests the gateway used about 60 MB of memory idle and up to about 200 MB under sustained load, which is roughly $0.60 to $2 a month of memory. See [Railway's pricing](https://docs.railway.com/pricing/plans).

## What was tested, and what was not

Tested:

- `npm test` runs 148 tests against the gateway and a stand-in for Mistral's API, and passes on Node 22, 24 and 26. The stand-in accepts only the fields in Mistral's published request schema and answers violations with error bodies copied from the public reports linked above.
- The official OpenAI SDKs for Python (3.51.0) and Node (7.57.0), Mistral's own Python SDK (3.7.0) and curl were run against the gateway and the stand-in: completions, streaming, tool calls, errors.
- Under load: 30,000 mixed requests with every answer checked and memory use flat, and 300 simultaneous streams.

Not tested:

- **The real Mistral API.** It was not reachable from where this was built, and no key was available. The adjustments marked "Mistral's request schema" above rest on the schema, not on observed responses. This is what `scripts/check.js` is for.
- **The Docker image.** It was never built. The `Dockerfile` copies `package.json` and `src/`; that set of files was run on its own, on the Node version the base image currently provides (24.22.3).
- **A Railway deployment.** The steps above follow Railway's documentation as of November 2026.
- **Specific apps** such as Open WebUI, LibreChat or editor plugins.

## Development

Node 22 or newer. There is nothing to install: the gateway and its tests use only Node's standard library.

```bash
npm test

cp .env.example .env        # then fill in the two keys
node --env-file=.env src/server.js
```

| Path | Contents |
| --- | --- |
| `src/server.js` | Startup and shutdown. |
| `src/app.js` | Key check, routes, and the proxy to Mistral. |
| `src/translate.js` | The request adjustments. |
| `src/errors.js` | The readable message added to Mistral's errors. |
| `src/config.js` | Variables and their checks. |
| `scripts/check.js` | The deployment check. |
| `test/` | The tests, and the stand-in for Mistral's API in `test/support/`. |
