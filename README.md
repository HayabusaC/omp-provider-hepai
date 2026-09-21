# OMP HepAI Provider

Adds provider ID `hepai` for `https://aiapi.ihep.ac.cn/apiv2` on OMP 18.2.6.

- Model API keys are saved through OMP `AuthStorage` (`/hepai-login`); no `.env`, `models.yml`, or plugin key file is written.
- HepAI Portal authentication is registered in OMP's native `/login` UI with both password and IHEP SSO flows.
- Live discovery uses the deployment's verified `GET /apiv2/models` endpoint and preserves every model ID exactly.
- Requests reuse OMP's built-in Responses, Chat Completions, and Anthropic Messages transports. Anthropic/Claude model IDs prefer the verified Anthropic-compatible endpoint; other models prefer Responses. Model/endpoint compatibility rejections fall through deterministically, while 401/403 and upstream 5xx errors do not trigger misleading fallback.
- `/hepai-test <model-id>` makes one minimal non-streaming request to all three protocols and reports: supported, model unsupported, auth failure, endpoint missing, request rejected, or upstream error. Results set that model's in-process preferred transport.

## Install and authenticate

```powershell
omp plugin link .\omp-provider-hepai
```

Start OMP, run `/hepai-login`, restart (or `/reload`), then run `/hepai-test openai/gpt-5.6-sol`.

## Portal login

Portal authentication is separate from the API key used for model requests. It is intended for Portal billing and usage APIs.

- `/login hepai-portal-password` prompts for a username and a masked password. OMP stores the username and password locally in its native `AuthStorage`, then automatically signs in again when the short-lived JWT expires.
- `/login hepai-portal-sso` opens the IHEP unified-authentication browser flow. OMP stores only the resulting HepAI `refresh-token` cookie and access JWT; it does not store the user's IHEP username or password.
- `/hepai-portal-auth` reports which Portal login modes are currently configured.

The SSO flow requires an OMP client that supports native browser-session login. Portal credentials never replace the `hepai` model API key and are not sent to model endpoints.

Security note: OMP 18.2.6 stores native credentials in its local SQLite AuthStorage. The plugin does not create a separate plaintext credential file, but it also does not claim that the SQLite credential payload is encrypted with Windows DPAPI or an OS keychain. Use the SSO flow if you do not want your IHEP password retained locally, and protect the OMP data directory with normal OS account and disk-encryption controls.

`HEPAI_DEV_USE_ENV=1` is an explicit development-only switch that lets discovery use `HEPAI_API_KEY`. It is off by default so a normal installation always resolves `hepai` through OMP credentials.

## Verified deployment paths (2026-09-20)

- `GET /apiv2/models`: HTTP 200, OpenAI-style `{ object, data }`, 172 rows during testing.
- `GET /apiv2/v1/models`: also HTTP 200, but the plugin uses the shorter API-base-relative path.
- `POST /apiv2/anthropic/v1/messages`: HTTP 200 with Bearer authentication for `anthropic/claude-sonnet-4-6`; OMP receives base URL `/apiv2/anthropic` and appends `/v1/messages` itself.
- `POST /apiv2/v1/messages` and `/apiv2/messages`: HTTP 405, so they are not used as the Anthropic transport.
- `/apiv2/api/v1/model-catalog`: HTML application response, not a JSON model catalog.
- `/api/v1/model-catalog`: HTTP 404.

Only the reliable model `id` from the live `/models` response is treated as HepAI metadata and it is preserved exactly. OMP 18.2.6's `ProviderModelConfig` requires numeric context/output/cost fields even when discovery omits them, so the plugin supplies clearly labelled execution fallbacks (`128000`, `16384`, zero unknown cost) rather than presenting those values as catalog facts. Reasoning and pricing capabilities are not inferred from the documentation.

## Verification

Live verification used an isolated OMP config root and native `AuthStorage`; the child OMP process had both `HEPAI_API_KEY` and `HEPAI_DEV_USE_ENV` removed. It still discovered `hepai/openai/gpt-5.6-sol` and `hepai/anthropic/claude-sonnet-4-6`, then generated through the Anthropic-compatible transport. The opt-in test is `HEPAI_E2E=1 bun test test/omp-auth-e2e.test.ts` and skips by default to avoid unrequested network usage.
