# OMP HepAI Provider

[English](README.md) | [简体中文](README.zh-CN.md)

An unofficial Oh My Pi companion provider for HepAI/HaiDDF. It adds provider `hepai`, discovers the models available to the current API key, preserves their original IDs, and sends requests through OMP's native Responses, Chat Completions, or Anthropic Messages transport.

This plugin is downstream of and subordinate to HepAI/HaiDDF. It is not an official HepAI or HaiDDF distribution, does not replace the HepAI Portal or upstream documentation, and cannot guarantee compatibility beyond the snapshot below.

## HepAI and upstream links

- HepAI Portal: <https://ai.ihep.ac.cn>
- HepAI production API: <https://aiapi.ihep.ac.cn/apiv2>
- HaiDDF source repository: <https://github.com/stcapo/hai-ddf>
- HepAI API reference: <https://docs-ai.ihep.ac.cn/s/hai/doc/api-UticaXRzFe>

**Upstream compatibility snapshot: 2026-09-22.** This plugin is built against and verified with OMP 18.2.7. HepAI/HaiDDF changes frequently; the paths, payloads, authentication behavior, billing fields, and compatibility notes documented here describe the production deployment verified through that date, not a permanent upstream contract.

> **Currency rule: every raw monetary value returned by HepAI is CNY.** This applies to catalog prices, fund/credit amounts, `original_price`, `discount_amount`, `payable_amount`, and every monetary `cost` inside `cost_breakdown`, including `internal_reasoning`. The plugin converts all of them to OMP's USD-denominated fields using `CNY × 0.143`. Token counts, quantities, IDs, and `total_discount_rate` are not monetary values and are not converted.

## HepAI API snapshot

All runtime paths use `https://aiapi.ihep.ac.cn`.

| Method | Path | Authentication | Used by |
| --- | --- | --- | --- |
| `GET` | `/apiv2/models` | Model API key | Authoritative accessible model list |
| `GET` | `/apiv2/portal/model/list_cloud_models?page=<n>&page_size=100` | None | Optional model metadata enrichment |
| `POST` | `/apiv2/responses` | Model API key | Responses transport and probe |
| `POST` | `/apiv2/chat/completions` | Model API key | Chat Completions transport and probe |
| `POST` | `/apiv2/anthropic/v1/messages` | Model API key | Anthropic transport and probe |
| `GET` | `/apiv2/portal/user/login_sso` | Browser SSO session | Obtain `refresh-token` |
| `GET` | `/apiv2/portal/user/refresh` | `refresh-token` cookie | Obtain/refresh Portal JWT |
| `GET` | `/apiv2/portal/billing/mine/all_funds` | Portal JWT | Fund totals |
| `POST` | `/apiv2/portal/billing/invoke_records` | Portal JWT | Invocation records and authoritative charges |

The Anthropic OMP transport receives base URL `https://aiapi.ihep.ac.cn/apiv2/anthropic` and appends `/v1/messages` itself.

Verified alternatives that are intentionally unused:

- `GET /apiv2/v1/models` also returned a model list, but the plugin uses `/apiv2/models`.
- `POST /apiv2/v1/messages` and `POST /apiv2/messages` returned HTTP 405.
- `/apiv2/api/v1/model-catalog` returned an HTML application rather than a JSON catalog.

## Quick start

From the parent workspace:

```powershell
npm install
omp plugin link .\omp-provider-hepai
```

Then in OMP:

```text
/hepai-login
/reload
/model
/hepai-test openai/gpt-5.6-sol
```

`/hepai-login` asks for a HepAI model API key and saves it through OMP `AuthStorage`. The plugin does not write `.env`, `models.yml`, or its own key file.

The model API key is always supplied by the user. The plugin does not request, create, derive, or import a model API key from any HepAI or Portal endpoint. `GET /apiv2/models` is called only after a key has been entered and is used solely to list the models accessible to that key.

## How it works

### 1. Registration and credentials

The extension registers two independent providers:

| Provider ID | Credential | Purpose |
| --- | --- | --- |
| `hepai` | HepAI model API key | Model discovery and inference |
| `hepai-portal-sso` | Portal refresh cookie and access JWT | Portal billing only |

Credentials are never crossed: the Portal JWT is not sent to inference endpoints, and the model API key is not sent to Portal billing endpoints.

### 2. Model discovery

OMP calls the provider's dynamic model loader after resolving the `hepai` credential.

1. `GET /apiv2/models` returns the authoritative, API-key-scoped model IDs.
2. The plugin fetches the public Portal catalog, up to 50 pages of 100 records.
3. Catalog rows are matched by exact model ID and can add display name, context/output limits, reasoning support, image input, and verified per-million-token prices. Catalog monetary prices are converted from CNY to OMP's USD fields with `× 0.143`.
4. Only IDs returned by `/models` are exposed. The public catalog never adds inaccessible models.

If catalog loading fails, discovery still returns the API-key-scoped models. Required OMP numeric fields then use explicit execution defaults: context window `128000`, maximum output `16384`, and unknown prices `0`.

### 3. Protocol selection and fallback

The registered model API is `hepai-auto`. It delegates streaming to OMP's built-in transports rather than implementing protocol parsers.

| Model ID | Initial order |
| --- | --- |
| Contains `claude` or an `anthropic/` segment | Anthropic Messages → Responses → Chat Completions |
| All other IDs | Responses → Chat Completions → Anthropic Messages |

Before an attempt succeeds, events are held so a rejected protocol does not leak a partial response. A successful transport is cached by model ID for the current OMP process.

Fallback is allowed for protocol/model compatibility failures such as HTTP `400`, `404`, `405`, or `422`. It deliberately stops on:

- HTTP `401` or `403`, because changing protocol cannot fix credentials;
- HTTP `5xx`, because fallback would hide an upstream failure;
- a stream error that is not classified as protocol/model incompatibility.

### 4. Capability probing

`/hepai-test <model-id>` sends one minimal, non-streaming request to each inference endpoint in parallel. It classifies each result as:

- `supported`
- `model-unsupported`
- `auth-failed`
- `endpoint-missing`
- `request-rejected`
- `upstream-error`

If one or more protocols work, the command selects the normal priority winner and stores it as that model's in-process preferred transport. The probe makes real billable API requests with an output limit of 16 tokens.

## Commands

| Command | Behavior |
| --- | --- |
| `/hepai-login` | Prompts for and saves the `hepai` model API key in OMP `AuthStorage` |
| `/hepai-test <model-id>` | Probes all three inference protocols; defaults to the selected HepAI model when the argument is omitted |
| `/hepai-portal-auth` | Reports whether `hepai-portal-sso` credentials are stored and shows the login command |
| `/hepai-billing` | Summarizes funds and the first 20 invocation records from the last 30 days |
| `/hepai-settle` | Resumes exact-ID settlement of pending bills for the current session |
| `/login hepai-portal-sso` | Opens the IHEP SSO browser flow and stores the returned Portal credential in OMP |

## Portal SSO and billing

Portal access is optional and is not needed to list or invoke models.

`/login hepai-portal-sso` asks OMP's browser-session login to capture only the HepAI `refresh-token` cookie. The plugin exchanges that cookie for a Portal access JWT and stores both through native OMP OAuth credentials. It never asks for or stores the user's IHEP username or password.

`/hepai-billing` concurrently reads:

- `GET /apiv2/portal/billing/mine/all_funds`
- `POST /apiv2/portal/billing/invoke_records`

The invocation request uses page 1, page size 20, and the last 30 days as `YYYY-MM-DD` `start_date`/`end_date` values. The summary reports fund counts, credit totals, input/output tokens, and the post-discount `payable_amount` total. Every displayed monetary value is converted from CNY with `× 0.143` and explicitly labelled USD. If billing returns `401` or `403`, OMP is asked to refresh the Portal credential once and the request is retried once.

Raw invocation records can contain authorization headers, IP addresses, prompts, response previews, trace IDs, and key identifiers; the command ignores and never displays those fields.

### Request ID correlation

Live verification on 2026-09-22 with `hepai/deepseek-v4-pro` confirmed that Responses, Chat Completions, and Anthropic Messages all return a top-level response `id`, plus `x-request-id` and `x-trace-id` response headers. The three requests all appeared in `/apiv2/portal/billing/invoke_records`.

The numeric billing `invoke_id` is a separate database identifier and is not equal to the response body's `id`. Correlate records as follows:

- response header `x-request-id` equals `remarks.request_id` (the primary exact join key);
- response header `x-trace-id` equals `remarks.trace_id`;
- the response body's top-level `id` is present in `remarks.response_preview` for the verified responses.

Billing insertion may be asynchronous, so a new invocation can take a short time to appear. Raw `remarks` are sensitive and should not be logged wholesale.

### Authoritative session cost settlement

For successful HepAI assistant turns, OMP's native protocol parsers remain the sole source of `input`, `output`, `cacheRead`, `cacheWrite`, `reasoningTokens`, and `totalTokens`. The plugin does not change the OMP `Usage` shape or token parsing.

After the assistant message has been allowed to persist normally, the plugin writes a per-session `<session>.hepai-billing.json` sidecar containing the exact `responseId ↔ requestId ↔ traceId ↔ invokeId` association. It polls `POST /apiv2/portal/billing/invoke_records` in the background with bounded retries. A record is accepted only when `remarks.request_id` exactly equals the captured request ID and, when a trace ID was captured, `remarks.trace_id` also exactly matches. It never selects the newest/nearest record or infers a match from a balance change.

Once found, `payable_amount` is the authoritative total. Every monetary value from HepAI is treated as CNY and converted with `CNY × 0.143` before storage: this includes `original_price`, `discount_amount`, `payable_amount`, and every `cost_breakdown.*.cost`. Non-monetary quantities such as token `amount` and the dimensionless `total_discount_rate` are not converted. The sidecar marks the converted values as `currency: "USD"`, records `sourceCurrency: "CNY"` and `exchangeRate: 0.143`, and retains the complete converted breakdown. Mappable discounted breakdown costs populate `usage.cost.input`, `output`, `cacheRead`, and `cacheWrite`; `internal_reasoning` remains a separate sidecar item and is not folded into output. All billed items, including unmapped ones, remain included in `usage.cost.total` through the converted `payable_amount`. Unrelated sensitive invocation fields are not copied.

The exact assistant entry is found by `responseId` and rewritten through OMP 18.2.7's native atomic `SessionManager.rewriteEntries()` implementation. The live message object is updated through the shared session/runtime reference, then `@oh-my-pi/omp-stats` re-ingests sessions. Settled request IDs are idempotent. Pending entries survive restart; missing Portal SSO leaves them pending without affecting inference. A finite retry run ends in `failed`, and restart or `/hepai-settle` reactivates pending/failed entries after login.

### SSO compatibility notes

- Native browser-session login support is required.
- If the browser immediately reports `ERR_CONNECTION_CLOSED`, ensure the Chromium session can reach `aiapi.ihep.ac.cn` and `newlogin.ihep.ac.cn`. OMP 18.2.7's browser-session does not inherit `HTTP_PROXY`/`HTTPS_PROXY`; on Windows it may require the equivalent system proxy to be enabled for the login, then restored afterward.
- The production refresh route currently reports an undocumented missing `query/self` field. The plugin retries with `?self=1` only for that exact FastAPI validation error.
- `ai.ihep.ac.cn`, `aiapi.ihep.ac.cn`, and `ddf.ihep.ac.cn` are not treated as interchangeable OAuth origins.

## Configuration and security

There is no normal user-facing environment-variable configuration. For isolated development only, setting `HEPAI_DEV_USE_ENV=1` makes OMP resolve `HEPAI_API_KEY`; the switch is off by default.

OMP 18.2.7 stores native credentials in its local SQLite `AuthStorage`. This plugin creates no additional plaintext credential store, but does not claim that the SQLite payload is protected by Windows DPAPI or an OS keychain. Protect the OMP data directory using normal account permissions and disk encryption.

HepAI catalog prices are converted with `CNY × 0.143` and remain useful provisional USD estimates while inference is running. They are not the final bill: completed settlement replaces monetary usage with the similarly converted Portal invoice. OMP 18.2.7 has no currency field and may render a fixed `$` prefix.

## Source layout

| File | Responsibility |
| --- | --- |
| `index.ts` | Provider registration, model discovery, transport dispatch, commands |
| `endpoints.ts` | Canonical HepAI URLs |
| `catalog.ts` | Public catalog pagination and OMP model metadata mapping |
| `capabilities.ts` | Probe bodies, classification, transport ordering and fallback rules |
| `portal-auth.ts` | Browser SSO, refresh-cookie validation and JWT refresh |
| `portal-client.ts` | Billing requests and privacy-preserving aggregation |
| `billing-types.ts` | Authoritative invoice validation and CNY-to-USD cost mapping |
| `billing-sidecar.ts` | Atomic, per-session request/response/trace/invoke persistence |
| `billing-settlement.ts` | Pending retries, exact matching, OMP atomic rewrite and stats re-ingest |

## Development and verification

From the parent workspace:

```powershell
npm run typecheck --workspace omp-provider-hepai
npm test --workspace omp-provider-hepai
npm run build --workspace omp-provider-hepai
```

The optional live integration test uses an isolated OMP config root and native `AuthStorage`, removes `HEPAI_API_KEY` and `HEPAI_DEV_USE_ENV` from the child process, discovers real HepAI models, and performs a generation request:

```powershell
$env:HEPAI_E2E = "1"
bun test test/omp-auth-e2e.test.ts
```

It is skipped by default to avoid unrequested network usage and billing.
