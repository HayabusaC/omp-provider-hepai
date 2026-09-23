# OMP HepAI Provider

[English](README.md) | [简体中文](README.zh-CN.md)

HepAI is an artificial intelligence platform built by the **Computing Center of the [Institute of High Energy Physics, Chinese Academy of Sciences](https://english.ihep.cas.cn/)**. Serving fields including particle physics, astrophysics, synchrotron radiation, neutron science, and accelerator science, it connects models, data, computing resources, domain knowledge, scientific software, and agents. Its goal is to make AI reusable and shareable research infrastructure that accelerates scientific discovery. Based on the distributed deployment framework HaiDDF, the platform turns AI assets—including models, scientific tools, data, and agents—into discoverable, accessible, interoperable, and reusable resources. It aggregates mainstream large language models and exposes them through standards-compatible interfaces.

This plugin registers `hepai` in the [oh-my-pi Harness](https://omp.sh/), discovers models available to the current API key, preserves their original model IDs, and uses OMP's Responses, Chat Completions, and Anthropic Messages transports. HepAI/HaiDDF provides the upstream API.

## HepAI and upstream links

- HepAI Portal: <https://ai.ihep.ac.cn>
- HepAI production API: <https://aiapi.ihep.ac.cn/apiv2>
- HepAI API documentation
  - <https://aiapi.ihep.ac.cn/#/api-reference/docs>
  - <https://docs-ai.ihep.ac.cn/s/hai/doc/api-UticaXRzFe>
- HaiDDF source repository: <https://github.com/stcapo/hai-ddf>
- HepAI platform introduction and tutorial: <https://indico.ihep.ac.cn/event/30798/>

**HepAI API compatibility verified:** 2026-09-23.

HepAI monetary values are CNY: catalog prices, funds/credits, `original_price`, `discount_amount`, `payable_amount`, and all `cost_breakdown.*.cost` values, including `internal_reasoning`. The plugin writes USD values to OMP using `CNY × 0.143`. Token counts, quantities, IDs, and `total_discount_rate` retain their original values.

## HepAI API

Model API and cloud-list paths use `https://aiapi.ihep.ac.cn`; website SSO, model details, and billing use `https://ai.ihep.ac.cn`.

| Method | API domain | Path | Authentication | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `https://aiapi.ihep.ac.cn` | `/apiv2/models` | Model API key | Authoritative list of models accessible to the current key |
| `GET` |  | `/apiv2/portal/model/list_cloud_models?page=1&page_size=-1` | None | Complete initial model catalog and metadata fallback |
| `POST` |  | `/apiv2/responses` | Model API key | Responses transport and probe |
| `POST` |  | `/apiv2/chat/completions` | Model API key | Chat Completions transport and probe |
| `POST` |  | `/apiv2/anthropic/v1/messages` | Model API key | Anthropic transport and probe |
| `GET` | `https://ai.ihep.ac.cn/` | `/oauth/ihep/login` | Browser SSO session | Obtain the website `hai_refresh` cookie |
| `POST` |  | `/api/v1/auths/refresh` | `hai_refresh` cookie, `X-HAI-Session: 1` | Obtain/refresh the website token |
| `GET` |  | `/apiv2/portal/model/cloud_models_details?model_name=<id>` | Website SSO `token` cookie and Bearer token | Optional metadata for one accessible model |
| `POST` |  | `/apiv2/portal/billing/invoke_records` | Website token | Invocation records and authoritative billing amounts |

The Anthropic OMP transport receives base URL `https://aiapi.ihep.ac.cn/apiv2/anthropic` and appends `/v1/messages` itself.

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
```

`/hepai-login` accepts a user-provided HepAI model API key and saves it in OMP `AuthStorage`. `GET /apiv2/models` lists models accessible to that key.

Models whose IDs contain any of these case-insensitive keywords are classified as `Specific`:

- BOSS
- COMET
- HXMT
- BESIII
- HEPS
- NRS
- NPD
- XRD
- XIWU
- OCLIMAX
- reconstruct
- particle
- sensor
- materials
- protein
- algorithm
- simulation
- metadata
- filter
- analysis
- number

They are excluded by default. To retain them, disable the plugin setting and refresh the model catalog:

```powershell
omp plugin config set omp-provider-hepai filterSpecificModels false
omp models refresh
```

Set it to `true` and refresh again to filter them.

Models whose IDs contain any of these case-insensitive keywords are classified as `Agent`:

- agent
- master
- Dr
- explorer

They are also excluded by default. To retain them, disable the independent Agent filter and refresh:

```powershell
omp plugin config set omp-provider-hepai filterAgentModels false
omp models refresh
```

Set it to `true` and refresh again to filter them.

## Technical behavior

### Credentials

The extension registers two independent providers:

| Provider ID | Credential | Purpose |
| --- | --- | --- |
| `hepai` | HepAI model API key | Model discovery and inference |
| `hepai-website-sso` | Website `hai_refresh` cookie and token | Model-detail metadata and billing |

The website token is sent to model details and website billing as a Bearer token and `token` cookie. The model API key is sent to `/apiv2/models` and inference endpoints. The initial cloud-list request has no authorization header.

### Model discovery

OMP calls the provider's dynamic model loader after resolving the `hepai` credential.

1. With a model API key, the loader first requests `GET /apiv2/models`. Its model IDs are authoritative when the request succeeds.
2. The loader requests `/portal/model/list_cloud_models?page=1&page_size=-1` once for fallback IDs and metadata, then deduplicates the candidate IDs. If `/apiv2/models` fails, the cloud list supplies the IDs.
3. Before applying any filter, the plugin uses the complete deduplicated candidate set to request `/portal/model/cloud_models_details?model_name=<id>` on `ai.ihep.ac.cn`, with bounded concurrency. A successful website SSO preflight or login triggers an online OMP model-catalog refresh.
4. Detail records are matched by exact model ID, then non-empty fields merge in cloud list → website details → `/apiv2/models` priority order. Only after every candidate's detail request and metadata merge have completed does filtering begin. The five filters and all subsequent mappings are specified below.

#### Complete registration order

1. Read `/apiv2/models`; when successful, only models in its `data[].id` may be registered. If that request fails, use `model_name → id` from the cloud model list.
2. Deduplicate candidate IDs, then request website details for every candidate ID before any filtering. A detail response must match the requested ID exactly through `id` or `model_name` and cannot introduce another model.
3. Merge records for one ID in cloud list → website details → `/apiv2/models` order. A later non-`null`, non-`undefined`, non-empty-string field replaces the earlier value. For display-name fields, placeholder strings are also treated as empty and cannot erase a valid lower-priority name. This is a shallow field merge; nested objects are not recursively merged.
4. Apply five filters in order to the merged records: no valid display name → ID contains `demo` → unqualified duplicate ID → Specific → Agent. Exact IDs `aliyun/qwen3.8-max`, `moonshot/kimi-k3`, and `Metadata_completion_model` are exempt from the first three filters; they are not exempt from Specific or Agent filtering. The last two filters are controlled independently and default to enabled.
5. Independently calculate the “all five filters passed” set as though both optional filters were enabled, regardless of their current settings. Only this set receives the Context/Max output fallback and K-token normalization in the table below. Models visible only because either optional filter was disabled retain their source limits.
6. Map visible models to `ProviderModelConfig`, group by provider, naturally sort by display name, break name ties by ID, and return the result through `fetchDynamicModels`.

OMP writes the dynamic catalog returned by `fetchDynamicModels` to its SQLite model cache and reuses it for OMP's configured cache lifetime; the plugin does not create a separate model-registration database. `omp models refresh` forces the complete pipeline to run again and updates that cache.

#### Provider registration parameters

| OMP `registerProvider("hepai", …)` parameter | Registered value or source |
| --- | --- |
| `baseUrl` | `https://aiapi.ihep.ac.cn/apiv2` |
| `api` | `hepai-auto` |
| `streamSimple` | Plugin automatic routing across Responses / Chat Completions / Anthropic Messages |
| `authHeader` | `true`; the model API key is sent as Bearer authentication |
| `apiKey` | Omitted normally; set to environment-variable name `HEPAI_API_KEY` only when `HEPAI_DEV_USE_ENV=1` |
| `fetchDynamicModels(apiKey)` | Runs the discovery, merge, filtering, mapping, and sorting pipeline above |

#### Registered model field mapping

JSON paths below are relative to the merged per-model record from the three sources above. `valid(x)` means a finite non-negative number. All price results use `Number(value.toFixed(12))`.

| OMP `ProviderModelConfig` field | HepAI JSON field or formula | Missing, invalid, and supplemental behavior |
| --- | --- | --- |
| `id` | `/apiv2/models.data[].id`; if that endpoint fails, cloud-list `data[].model_name`, then `data[].id` | Preserved verbatim and exactly deduplicated; detail records do not change it |
| `name` | First valid `display_name` string or array element → `display_label` → exempt-ID display name | `""`, whitespace, `"{}"`, `"[]"`, `"null"`, and `"undefined"` are invalid case-insensitively; a non-exempt model without a valid name is removed by filter 1 |
| `api` | Constant `"hepai-auto"` | Not read from HepAI JSON |
| `reasoning` | Constant `true` | Ignores incomplete or incorrect `is_reasoning` / `capabilities.reasoning` metadata |
| `thinking` | Not written directly by the plugin | OMP derives the actual effort ladder from model ID, `reasoning: true`, and its bundled catalog/policy; the upstream endpoint remains authoritative about request acceptance |
| `input` | Starts as `["text"]`; becomes `["text", "image"]` when `capabilities.input_modalities ?? input_modalities` contains `"image"` | Other modalities are not written to this OMP field |
| `contextWindow` | Positive integer `context_window ?? limitations.context_window`, floored | In the all-five-filters set: missing Context or source pair `8192/2048` uses the OMP bundled-catalog reference; without a reference it is `128000`. Otherwise, when Context and Max output are both `<=1024`, Context is multiplied by `1000` |
| `maxTokens` | Positive integer `max_output_tokens ?? limitations.max_output_tokens`, floored | On the fallback above, uses the OMP reference `maxTokens`, capped at its Context; without a reference it is `min(32768, contextWindow)`. Otherwise, when both source values are `<=1024`, it is multiplied by `1000`; if only this field is missing while Context is valid, it is `16384` |
| `cost.input` | `round12((valid(input_price_per_mtoken) ?? valid(model_pricing.pricing_details.input_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.prompt) ?? 0) × discount × 0.143)` | The implementation selects the source price first, then multiplies the full value by the discount and exchange rate before rounding; `round12` applies to the complete product |
| `cost.output` | `(valid(output_price_per_mtoken) ?? valid(model_pricing.pricing_details.output_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.completion) ?? 0) × discount × 0.143`, then `round12` | Missing or invalid source price becomes `0` |
| `cost.cacheRead` | `(valid(model_pricing.pricing_details.cache_read_input_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.input_cache_read) ?? 0) × discount × 0.143`, then `round12` | Missing or invalid source price becomes `0` |
| `cost.cacheWrite` | `(valid(model_pricing.pricing_details.cache_creation_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.input_cache_write) ?? 0) × discount × 0.143`, then `round12` | Missing or invalid source price becomes `0` |
| `premiumMultiplier`, `preferWebsockets`, `headers`, `compat` | Not written | OMP may add applicable runtime data during post-registration model construction and policy resolution; these are not direct HepAI JSON mappings |

For all four price formulas, `discount = valid(model_pricing.discount_rate) ?? 1`, and the unit is USD per million tokens. These are provisional catalog estimates while a request is running; post-response settlement still rewrites costs from the authoritative invoice fields documented below.

The dynamic loader returns registered models grouped alphabetically by the highest-priority available `provider`, then sorted by display name with numeric-aware ordering and by ID for ties. When `provider` is unavailable, the ID prefix before `/` supplies the group; unprefixed IDs use `Other`. Model IDs and display names are unchanged. OMP's model picker applies its own display sorting.

Without SSO, discovery uses cloud-list metadata. Missing Context follows the OMP-catalog or `128000/32768` rule above; a missing Max output alone uses `16384`; unknown prices use `0`.

### Transport routing

The registered model API is `hepai-auto`. OMP's built-in transports handle streaming.

| Model ID | Initial order |
| --- | --- |
| Contains `claude` or an `anthropic/` segment | Anthropic Messages → Responses → Chat Completions |
| All other IDs | Responses → Chat Completions → Anthropic Messages |

Events are buffered until a transport succeeds. The last successful transport for each model ID is saved in OMP's agent directory at `cache/hepai-transports.json` (normally under `~/.omp`) and reused after restart. Only the model ID and transport name are stored. A compatibility error on the cached transport removes that entry before fallback; authentication and upstream errors do not invalidate it.

The next transport is tried after protocol/model compatibility errors such as HTTP `400`, `404`, `405`, or `422`. Routing stops on:

- HTTP `401` or `403`;
- HTTP `5xx`;
- stream errors outside the protocol/model compatibility class.

### Optional transport diagnostics

Normal requests select and cache a working transport automatically. `/hepai-test <model-id>` is an optional troubleshooting command. It sends one minimal, non-streaming request to each inference endpoint in parallel and classifies each result as:

- `supported`
- `model-unsupported`
- `auth-failed`
- `endpoint-missing`
- `request-rejected`
- `upstream-error`

If one or more protocols work, the command reports the normal priority winner as a suggestion. It does not change routing or its persistent cache. The probes make real, potentially billable API requests with an output limit of 16 tokens.

## Commands

| Command | Behavior |
| --- | --- |
| `/hepai-login` | Prompts for and saves the `hepai` model API key in OMP `AuthStorage` |
| `/hepai-test <model-id>` | Optional transport diagnostic; probes all three protocols and defaults to the selected HepAI model when the argument is omitted |
| `/login hepai-website-sso` | Opens `https://ai.ihep.ac.cn/oauth/ihep/login` and stores the website refresh session and token in OMP |
| `/hepai-website-auth` | Reports whether `hepai-website-sso` credentials are stored and shows the login command |
| `/hepai-settle` | Resumes exact-ID settlement of pending bills for the current session |

## Website SSO and billing

Model discovery and inference use the model API key. Website SSO enables model details and billing.

`/login hepai-website-sso` captures the website `hai_refresh` cookie through OMP browser-session login, then calls `POST /api/v1/auths/refresh` to obtain a website token. OMP stores the refresh cookie and token as OAuth credentials. Before using a JWT with less than 900 seconds remaining, the plugin renews it through the same endpoint.

The website login uses an isolated Chromium session and checks `hai_refresh` against the refresh endpoint URL, which matches the cookie's path scope. The browser closes after capture. Each issued JWT has a lifetime of 3,600 seconds, and `hai_refresh` does not rotate.

At the first `session_start` of each OMP process, website SSO is checked. A saved valid `hai_refresh` renews the website token in headless mode. A missing or expired refresh session opens browser-session SSO in interactive TUI mode; headless mode requires a later `/login hepai-website-sso`. IHEP usernames and passwords stay in the browser SSO flow.

### Response-to-bill matching

For each successful model response, the plugin captures the `x-request-id` response header as `requestId`, `x-trace-id` as an optional `traceId`, and the response body's `id` as `responseId`. OMP persists `responseId` on its assistant message. The plugin saves `requestId`, `traceId`, `responseId`, request time, and session path in `<session>.hepai-billing.json` before starting the billing lookup.

The lookup posts `page`, `page_size`, `start_date`, and `end_date` to `/apiv2/portal/billing/invoke_records`. The endpoint ignores a request-body `request_id`, so the plugin scans every page in a ±1-day window around the request, 100 records per page, until it finds an exact match or reaches the reported total. A record matches only when `remarks.request_id === requestId` and, if a trace header was captured, `remarks.trace_id === traceId`. Record order, time proximity, response-body `id`, and billing `invoke_id` are not matching keys. `invoke_id` is saved after a successful match.

Fetched invoices are stored in OMP's global agent directory at `<agentDir>/cache/hepai-invoices.json` (normally `~/.omp/agent/cache/hepai-invoices.json`). OMP's active profile or `PI_CODING_AGENT_DIR` determines `<agentDir>`, so sessions share a cache within one profile without mixing profiles. Entries expire after 30 days and are pruned on the next write. The cache is keyed by `requestId`; a matching cached invoice avoids another page scan. It stores only request/trace IDs, invoice ID, request time, token counts, and billing amounts. It excludes the raw `remarks`, username, API key, request headers, prompts, and response previews.

### Authoritative session cost settlement

After the exact-ID lookup, the plugin first normalizes the observed nested shape or legacy top-level shape and persists it as sidecar `billing`; OMP session `Usage` is then mapped only from that sidecar object. HepAI's `completion`/`output_tokens` and `internal_reasoning`/`reasoning_tokens` are independent billed token groups; neither is a subset of the other. OMP has only one output cost bucket, so the mapping uses `usage.output = completion + internal_reasoning` and also records the separately billed reasoning count in `reasoningTokens`. `totalTokens` is input + combined output + both cache token counts. Top-level `payable_amount` is converted to USD in the sidecar and becomes OMP's authoritative total.

The fields actually read and their fallback order are below, from left to right. Invalid values (non-finite numbers, or negative/non-integer token counts) are treated as missing. An entirely missing optional token component becomes `0`, but missing `payable_amount` rejects settlement so an estimate is never presented as an authoritative bill.

HepAI theoretically has five standard billing groups: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, and `internal_reasoning`. Actual bills are sparse: when a group's tokens or cost are zero, that group may be omitted entirely from `std_amounts`, `std_costs`, or `cost_breakdown`. Once either bill shape supplies any `cost_breakdown`, an omitted group is treated as an authoritative zero and is not filled with an OMP estimate. OMP component estimates survive only when both the nested and legacy breakdown objects are entirely absent.

| HepAI source and fallback | First written to sidecar `billing` | Then written from sidecar to OMP session |
| --- | --- | --- |
| `input_tokens` = `standard_invoke_record.input_tokens` → `*.std_amounts.prompt` → prompt/input breakdown amount → `0` | `standard_invoke_record.input_tokens = input_tokens` | `usage.input = billing.standard_invoke_record.input_tokens` |
| `completion_tokens` = `standard_invoke_record.output_tokens` → `billing_basis.usage.output_tokens` → `*.std_amounts.completion` → completion/output breakdown amount → `0` | `standard_invoke_record.output_tokens = completion_tokens` | `usage.output = billing.standard_invoke_record.output_tokens + billing.standard_invoke_record.reasoning_tokens` |
| `reasoning_tokens` = `standard_invoke_record.reasoning_tokens` → `usage.output_tokens_details.reasoning_tokens`/`thinking_tokens` → `*.std_amounts.internal_reasoning` → reasoning breakdown amount → `0` | `standard_invoke_record.reasoning_tokens = reasoning_tokens` | `usage.reasoningTokens = billing.standard_invoke_record.reasoning_tokens`; it is a subset of combined `usage.output` |
| `cache_read_tokens` = `standard_invoke_record.cache_read_tokens` → `*.std_amounts.input_cache_read` → `usage.cache_read_input_tokens` → cache-read breakdown amount → `0` | `standard_invoke_record.cache_read_tokens = cache_read_tokens` | `usage.cacheRead = billing.standard_invoke_record.cache_read_tokens` |
| `cache_write_tokens` = `standard_invoke_record.cache_write_tokens` → `*.std_amounts.input_cache_write` → `usage.cache_creation_input_tokens` → cache-write breakdown amount → `0` | `standard_invoke_record.cache_write_tokens = cache_write_tokens` | `usage.cacheWrite = billing.standard_invoke_record.cache_write_tokens` |
| The token buckets above | No separate `totalTokens`; it can be recomputed from the fields above | `usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite` |
| `prompt_cost` = `billing_basis.cost_breakdown.prompt.cost` → legacy `prompt.cost`/`input.cost` → `0` | `cost_breakdown.prompt.cost = prompt_cost × 0.143` | `usage.cost.input = billing.cost_breakdown.prompt.cost × billing.total_discount_rate` |
| `completion_cost` = `completion.cost`/`output.cost` → `0` | `cost_breakdown.completion.cost = completion_cost × 0.143` | `usage.cost.output = (billing.cost_breakdown.completion.cost + billing.cost_breakdown.internal_reasoning.cost) × billing.total_discount_rate` |
| `reasoning_cost` = `internal_reasoning.cost` → `0` | `cost_breakdown.internal_reasoning.cost = reasoning_cost × 0.143`, retained separately | Not written separately to OMP `Usage` |
| `cache_read_cost` = `input_cache_read.cost` → `cache_read.cost`/`cacheRead.cost` → `0` | `cost_breakdown.input_cache_read.cost = cache_read_cost × 0.143` | `usage.cost.cacheRead = billing.cost_breakdown.input_cache_read.cost × billing.total_discount_rate` |
| `cache_write_cost` = `input_cache_write.cost` → `cache_write.cost`/`cacheWrite.cost` → `0` | `cost_breakdown.input_cache_write.cost = cache_write_cost × 0.143` | `usage.cost.cacheWrite = billing.cost_breakdown.input_cache_write.cost × billing.total_discount_rate` |
| top-level `payable_amount`; missing or invalid rejects settlement | `payable_amount = payable_amount × 0.143` | `usage.cost.total = billing.payable_amount` |
| top-level `original_price` → `payable_amount + discount_amount` → `payable_amount` | `original_price = original_price × 0.143` | Not written separately to OMP `Usage` |
| top-level `discount_amount` → `max(0, original_price - payable_amount)` | `discount_amount = discount_amount × 0.143` | Not written separately to OMP `Usage` |

Here `total_discount_rate = billing_basis.total_discount_rate → top-level total_discount_rate → 1`. It is stored as sidecar `billing.total_discount_rate` and used only for OMP component costs when a breakdown exists. Sidecar `cost_breakdown.*.cost` values are pre-discount amounts converted to USD; total cost always comes directly from `payable_amount × 0.143`.

When `standard_invoke_record` exists, its canonical token counts win over duplicate fields; `billing_basis.usage` and `std_amounts` only fill gaps. HepAI meters and prices completion and reasoning tokens independently. Because OMP requires `reasoningTokens` to be a subset of `usage.output`, the plugin combines the two only in the sidecar-to-OMP mapping. Both the observed nested breakdown and the legacy top-level breakdown are converted from CNY before entering the sidecar; omitted zero-value groups remain zero, and OMP estimates survive only when no breakdown exists.

Each of the five component `cost` values is a pre-discount CNY amount returned by HepAI. OMP component cost is calculated as `cost × total_discount_rate × 0.143`. If a bill contains `cost_breakdown`, an omitted group means that group's cost is `0`; OMP's response-time component estimates survive only when both the nested and legacy `cost_breakdown` objects are entirely absent. `payable_amount × 0.143` is always authoritative for OMP `cost.total`, so the component sum never replaces the billed total.

Mapping when a legacy `cost_breakdown` is present:

- `payable_amount` sets `usage.cost.total` and includes all billed items.
- `original_price`, `discount_amount`, `payable_amount`, and each `cost_breakdown.*.cost` use `CNY × 0.143`; token `amount` and `total_discount_rate` retain their original values.
- The sidecar records `currency: "USD"`, `sourceCurrency: "CNY"`, `exchangeRate: 0.143`, and the converted breakdown, including `internal_reasoning`.
- `usage.output` combines completion and `internal_reasoning` tokens; `usage.cost.output` combines their discounted costs. `reasoningTokens` identifies the reasoning subset; `totalTokens` counts the combined output once. Input and cache components map to their OMP fields.
- Sensitive invocation fields outside the ID association and billing breakdown are excluded from the sidecar.

Settlement locates the assistant entry by `responseId`, updates its OMP `Usage`, and persists it with `SessionManager.rewriteEntries()`. `@oh-my-pi/omp-stats` then re-ingests the session. Request IDs settle once. Pending records survive restart; exhausted retries are marked `failed`. Restart or `/hepai-settle` retries pending and failed records after SSO login.

### SSO requirements

- Website SSO login uses the Chromium launcher bundled with OMP.
- Chromium must reach `ai.ihep.ac.cn` and `newlogin.ihep.ac.cn`. For `ERR_CONNECTION_CLOSED` on Windows, configure the system proxy for browser-session; it does not inherit `HTTP_PROXY`/`HTTPS_PROXY`.
- Website SSO starts on `ai.ihep.ac.cn`; IHEP unified authentication completes on `newlogin.ihep.ac.cn`.

## Configuration and security

For isolated development, `HEPAI_DEV_USE_ENV=1` makes OMP resolve `HEPAI_API_KEY`. Normal login uses `/hepai-login`.

OMP stores credentials in local SQLite `AuthStorage`. Protect the OMP data directory, session sidecars, and invoice cache with account permissions and disk encryption; SQLite credentials have no stated DPAPI or OS keychain protection.

Catalog prices provide provisional USD component estimates at `CNY price × model_pricing.discount_rate × 0.143`, with a missing discount rate treated as `1`. Settlement replaces the total with `payable_amount × 0.143`; component prices are replaced only when the invoice supplies `cost_breakdown` and then use the invoice's separate `total_discount_rate`. OMP cost fields have no currency marker and may display a fixed `$` prefix.

## Development and verification

From the parent workspace:

```powershell
npm run typecheck --workspace omp-provider-hepai
npm test --workspace omp-provider-hepai
npm run build --workspace omp-provider-hepai
```

The live integration test discovers HepAI models and performs one generation request using temporary OMP configuration:

```powershell
$env:HEPAI_E2E = "1"
bun test test/omp-auth-e2e.test.ts
```

Set `HEPAI_API_KEY` in the environment before running the live test. The test makes billable requests and finds `omp` on `PATH`; `OMP_BIN` selects another executable.
