# OMP HepAI Provider

[English](README.md) | [简体中文](README.zh-CN.md)

HepAI 是**[中国科学院高能物理研究所](https://ihep.cas.cn)计算中心**建设的人工智能平台，面向粒子物理、天体物理、同步辐射、中子科学、加速器等多领域，连接模型、数据、算力、专业知识、科研软件和智能体，推动AI成为可复用、可共享的新型科研基础设施，加速科学发现。平台基于分布式部署框架（HaiDDF）将人工智能要素（如：模型、科学工具、数据、智能体等）转换为可发现、可接入、可交互和可重用的资源，聚合多种主流大语言模型，通过兼容标准接口的方式供用户调用。
本插件在[oh-my-pi Harness](https://omp.sh/)中注册 `hepai`，发现当前 API Key 可用的模型，保留原始模型 ID，并使用 OMP 的 Responses、Chat Completions 和 Anthropic Messages 传输协议。上游 API 由 HepAI/HaiDDF 提供。

## HepAI 与上游链接

- HepAI Portal：<https://ai.ihep.ac.cn>
- HepAI 生产 API：<https://aiapi.ihep.ac.cn/apiv2>
- HepAI API 参考文档
  - <https://aiapi.ihep.ac.cn/#/api-reference/docs>
  - <https://docs-ai.ihep.ac.cn/s/hai/doc/api-UticaXRzFe>
- HaiDDF 源码仓库：<https://github.com/stcapo/hai-ddf>
- HepAI平台介绍与使用教程：https://indico.ihep.ac.cn/event/30798/

**HepAI API 兼容性实测日期：** 2026/09/23。

HepAI 金额以 CNY 计价：catalog 单价、经费/credit、`original_price`、`discount_amount`、`payable_amount`，以及所有 `cost_breakdown.*.cost`（包括 `internal_reasoning`）。插件按 `CNY × 0.143` 写入 OMP 的 USD 字段。token 数量、计量数量、ID 和 `total_discount_rate` 保留原值。

## HepAI API

模型 API 与云模型列表使用 `https://aiapi.ihep.ac.cn`；网站 SSO、模型详情与账单使用 `https://ai.ihep.ac.cn`。

| 方法 | API域名 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- | --- |
| `GET` | `https://aiapi.ihep.ac.cn` | `/apiv2/models` | 模型 API Key | 当前 Key 可访问模型的权威列表 |
| `GET` |  | `/apiv2/portal/model/list_cloud_models?page=1&page_size=-1` | 无 | 完整初始模型目录与元数据兜底 |
| `POST` |  | `/apiv2/responses` | 模型 API Key | Responses transport 与探测 |
| `POST` |  | `/apiv2/chat/completions` | 模型 API Key | Chat Completions transport 与探测 |
| `POST` |  | `/apiv2/anthropic/v1/messages` | 模型 API Key | Anthropic transport 与探测 |
| `GET` | `https://ai.ihep.ac.cn/` | `/oauth/ihep/login` | 浏览器 SSO 会话 | 获取网站 `hai_refresh` cookie |
| `POST` |  | `/api/v1/auths/refresh` | `hai_refresh` cookie、`X-HAI-Session: 1` | 换取/续签网站 token |
| `GET` |  | `/apiv2/portal/model/cloud_models_details?model_name=<id>` | 网站 SSO `token` cookie 和 Bearer token | 单个可访问模型的可选元数据 |
| `POST` |  | `/apiv2/portal/billing/invoke_records` | 网站 token | 调用记录与权威账单金额 |

OMP Anthropic transport 接收的 base URL 是 `https://aiapi.ihep.ac.cn/apiv2/anthropic`，并自行追加 `/v1/messages`。

## 快速开始

在父级 workspace 中运行：

```powershell
npm install
omp plugin link .\omp-provider-hepai
```

然后在 OMP 中运行：

```text
/hepai-login
/reload
/model
```

`/hepai-login` 接收用户提供的 HepAI 模型 API Key，并保存到 OMP `AuthStorage`。`GET /apiv2/models` 列出该 Key 可访问的模型。

模型 ID 不区分大小写包含以下任一关键词时归入 `Specific` 类：

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

这类模型默认剔除；如需保留，关闭插件设置并刷新模型目录：

```powershell
omp plugin config set omp-provider-hepai filterSpecificModels false
omp models refresh
```

将其设为 `true` 并再次刷新即可重新过滤。

模型 ID 不区分大小写包含以下任一关键词时归入 `Agent` 类：

- agent
- master
- Dr
- explorer

也默认剔除。如需保留，关闭独立的 Agent 过滤开关并刷新：

```powershell
omp plugin config set omp-provider-hepai filterAgentModels false
omp models refresh
```

将其设为 `true` 并再次刷新即可重新过滤。

## 技术行为

### 凭据

扩展注册两个相互独立的 provider：

| Provider ID | 凭据 | 用途 |
| --- | --- | --- |
| `hepai` | HepAI 模型 API Key | 模型发现和推理 |
| `hepai-website-sso` | 网站 `hai_refresh` cookie 与 token | 模型详情元数据与账单 |

网站 token 作为 Bearer token 和 `token` cookie 用于模型详情及网站账单。模型 API Key 用于 `/apiv2/models` 和推理接口。初始云模型列表请求不带 Authorization 头。

### 模型发现

OMP 解析 `hepai` 凭据后调用 provider 的动态模型加载器。

1. 有模型 API Key 时，加载器先请求 `GET /apiv2/models`；请求成功后以其模型 ID 为准。
2. 加载器单次请求 `/portal/model/list_cloud_models?page=1&page_size=-1`，取得兜底模型 ID 和元数据，再对候选 ID 去重。`/apiv2/models` 请求失败时使用云模型列表中的 ID。
3. 在执行任何过滤之前，插件使用完整的去重候选集，对每个 ID 向 `ai.ihep.ac.cn` 请求 `/portal/model/cloud_models_details?model_name=<id>`，并限制并发数。网站 SSO 预检或登录成功后会触发 OMP 在线模型目录刷新。
4. 详情记录按模型 ID 精确匹配，再按云模型列表 → 网站详情 → `/apiv2/models` 的优先级合并非空字段。所有候选模型的详情请求与元数据合并完成之后，才开始执行过滤。五轮过滤及后续映射规则见下文。

#### 完整注册顺序

1. 读取 `/apiv2/models`；成功时只允许注册该响应 `data[].id` 中的模型。该请求失败时，改用云模型列表的 `model_name → id`。
2. 对候选 ID 去重，然后在执行任何过滤之前为每个候选 ID 请求网站详情。详情响应必须按 `id` 或 `model_name` 与请求 ID 精确匹配，不能引入候选列表以外的模型。
3. 同一 ID 的记录按云模型列表 → 网站详情 → `/apiv2/models` 顺序合并，后者的非 `null`、非 `undefined`、非空字符串字段覆盖前者；显示名字段还会把占位字符串视为空值，不能覆盖低优先级来源中的有效名称。这是字段级浅合并，嵌套对象不做递归合并。
4. 对合并结果依次执行五轮过滤：无有效显示名 → ID 含 `demo` → 无斜杠重复 ID → Specific → Agent。精确 ID `aliyun/qwen3.8-max`、`moonshot/kimi-k3` 和 `Metadata_completion_model` 豁免前三轮过滤，但不豁免 Specific 或 Agent 过滤；后两轮由开关控制且默认开启。
5. 无论后两个开关实际是否关闭，另行按 Specific、Agent 均开启计算“完整五轮过滤存活集”。只有这个集合中的模型才执行下表的 Context/Max output fallback 和 K-token 单位修正。因关闭后两个开关才重新出现的模型保留原始数值。
6. 将实际可见模型映射为 `ProviderModelConfig`，再按 provider 分组、显示名自然排序、ID 破同名并列，最后由 `fetchDynamicModels` 返回给 OMP。

`fetchDynamicModels` 返回的动态模型目录由 OMP 写入其 SQLite model cache，并按 OMP 的缓存生命周期复用；插件不另建模型注册数据库。`omp models refresh` 会强制重新执行完整流程并更新该缓存。

#### Provider 注册参数

| OMP `registerProvider("hepai", …)` 参数 | 写入值或来源 |
| --- | --- |
| `baseUrl` | `https://aiapi.ihep.ac.cn/apiv2` |
| `api` | `hepai-auto` |
| `streamSimple` | 插件的自动传输路由：Responses / Chat Completions / Anthropic Messages |
| `authHeader` | `true`，模型 API Key 以 Bearer 认证发送 |
| `apiKey` | 正常运行不写；仅 `HEPAI_DEV_USE_ENV=1` 时设为环境变量名 `HEPAI_API_KEY` |
| `fetchDynamicModels(apiKey)` | 执行上述发现、合并、过滤、映射和排序流程 |

#### 注册模型字段对应表

下表中的 JSON 路径均相对于上述三个来源合并后的单个模型记录。`valid(x)` 表示有限非负数；价格结果统一执行 `Number(value.toFixed(12))`。

| OMP `ProviderModelConfig` 字段 | HepAI JSON 字段或公式 | 缺失、异常及补充规则 |
| --- | --- | --- |
| `id` | `/apiv2/models.data[].id`；该接口失败时为云列表 `data[].model_name`，再退到 `data[].id` | 原样保留、精确去重；详情记录不改变 ID |
| `name` | 第一个有效的 `display_name`（字符串或数组元素）→ `display_label` → 豁免 ID 的显示名 | `""`、纯空白、`"{}"`、`"[]"`、`"null"`、`"undefined"` 不区分大小写视为无效；非豁免模型没有有效名称时在第一轮过滤中剔除 |
| `api` | 固定值 `"hepai-auto"` | 不从 HepAI JSON 读取 |
| `reasoning` | 固定值 `true` | 不采用不完整或错误的 `is_reasoning` / `capabilities.reasoning` |
| `thinking` | 插件不直接写入 | OMP 根据模型 ID、`reasoning: true` 和内置 catalog/policy 生成实际思考强度；上游最终决定请求是否接受 |
| `input` | 基础值 `["text"]`；若 `capabilities.input_modalities ?? input_modalities` 数组包含 `"image"`，则为 `["text", "image"]` | 其他模态不写入当前 OMP 字段 |
| `contextWindow` | 正整数 `context_window ?? limitations.context_window`，取整 | 完整五轮过滤存活集内：Context 缺失或原始组合为 `8192/2048` 时，使用 OMP bundled catalog 参考值；无参考时为 `128000`。否则若 Context 与 Max output 都 `<=1024`，Context 乘 `1000` |
| `maxTokens` | 正整数 `max_output_tokens ?? limitations.max_output_tokens`，取整 | 触发上述 fallback 时使用 OMP 参考模型 `maxTokens`，并限制为不超过参考 Context；无参考时为 `min(32768, contextWindow)`。否则若两个原始值都 `<=1024`，本值乘 `1000`；仅本字段缺失而 Context 有效时为 `16384` |
| `cost.input` | `round12(valid(input_price_per_mtoken) ?? valid(model_pricing.pricing_details.input_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.prompt) ?? 0) × discount × 0.143` | 实际实现先选原价，再整体乘折扣和汇率并舍入；表中 `round12` 表示对整个乘积舍入 |
| `cost.output` | `(valid(output_price_per_mtoken) ?? valid(model_pricing.pricing_details.output_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.completion) ?? 0) × discount × 0.143`，最后 `round12` | 缺失或非法原价为 `0` |
| `cost.cacheRead` | `(valid(model_pricing.pricing_details.cache_read_input_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.input_cache_read) ?? 0) × discount × 0.143`，最后 `round12` | 缺失或非法原价为 `0` |
| `cost.cacheWrite` | `(valid(model_pricing.pricing_details.cache_creation_cost_per_million_tokens) ?? valid(model_pricing.pricing_details.rates.input_cache_write) ?? 0) × discount × 0.143`，最后 `round12` | 缺失或非法原价为 `0` |
| `premiumMultiplier`、`preferWebsockets`、`headers`、`compat` | 不写入 | OMP 可在注册后的模型构建与 policy 解析阶段补充适用的运行时数据；不是 HepAI JSON 的直接映射 |

四项价格公式中的 `discount = valid(model_pricing.discount_rate) ?? 1`，单位均为 USD/百万 token。这里是会话进行中的 catalog 估价；完成请求后的账单结算仍按后文的权威账单字段重写费用。

动态加载器返回的注册模型先按最高优先级的可用 `provider` 字母排序分组，组内按显示名称自然排序，同名时按 ID 排序。缺少 `provider` 时使用模型 ID 中 `/` 前的前缀；无前缀的模型归入 `Other`。模型 ID 与显示名称不变。OMP 模型选择器另有显示排序规则。

没有 SSO 时，模型发现使用云模型列表元数据。Context 缺失按上表查询 OMP catalog 或使用 `128000/32768`；仅 Max output 缺失时使用 `16384`；未知价格为 `0`。

### 传输路由

注册的模型 API 为 `hepai-auto`，由 OMP 内置传输协议处理流式响应。

| 模型 ID | 初始顺序 |
| --- | --- |
| 包含 `claude` 或 `anthropic/` 片段 | Anthropic Messages → Responses → Chat Completions |
| 其他 ID | Responses → Chat Completions → Anthropic Messages |

传输成功前暂存事件。每个模型 ID 最后成功的传输协议保存在 OMP agent 目录的 `cache/hepai-transports.json`（通常位于 `~/.omp` 下），重启后继续使用。文件只保存模型 ID 和协议名称。已缓存协议出现兼容性错误时，先删除该条目再尝试其他协议；认证错误和上游错误不会使其失效。

遇到 HTTP `400`、`404`、`405`、`422` 等协议/模型兼容错误时尝试下一个传输协议。以下情况停止路由：

- HTTP `401` 或 `403`；
- HTTP `5xx`；
- 协议/模型兼容错误之外的流错误。

### 可选传输诊断

正常请求会自动选择并缓存可用传输协议。`/hepai-test <model-id>` 是可选的排障命令，会并行向三个推理 endpoint 各发送一个最小非流式请求，并将结果分类为：

- `supported`
- `model-unsupported`
- `auth-failed`
- `endpoint-missing`
- `request-rejected`
- `upstream-error`

若有一个或多个协议可用，命令会按正常优先级报告建议协议，不修改路由或持久缓存。探测会产生真实、可能计费的 API 请求，输出上限为 16 token。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/hepai-login` | 提示输入 `hepai` 模型 API Key，并保存到 OMP `AuthStorage` |
| `/hepai-test <model-id>` | 可选传输诊断；探测三种协议，省略参数时使用当前选中的 HepAI 模型 |
| `/login hepai-website-sso` | 打开 `https://ai.ihep.ac.cn/oauth/ihep/login`，并将网站刷新会话及 token 保存到 OMP |
| `/hepai-website-auth` | 报告 `hepai-website-sso` 是否已保存，并显示登录命令 |
| `/hepai-settle` | 恢复当前 session 中 pending 账单的精确 ID 结算 |

## 网站 SSO 与账单

模型发现与推理使用模型 API Key。网站 SSO 提供模型详情与账单。

`/login hepai-website-sso` 通过 OMP browser-session 捕获网站的 `hai_refresh` cookie，再调用 `POST /api/v1/auths/refresh` 取得网站 token。OMP 将刷新 Cookie 和 token 保存为 OAuth 凭据；JWT 剩余有效期小于 900 秒时，插件会在使用前通过相同接口续签。

网站登录使用隔离的 Chromium 会话，按刷新接口 URL 匹配 `hai_refresh` 的 Path 范围；捕获后关闭浏览器。JWT每次签发的有效期均为 3,600 秒，`hai_refresh` 不轮换。

每个 OMP 进程首次 `session_start` 时检查网站 SSO；已保存的有效 `hai_refresh` 可在无界面模式下续签网站 token。刷新会话缺失或失效时，交互式 TUI 打开 browser-session SSO；无界面模式需之后执行 `/login hepai-website-sso`。IHEP 用户名和密码留在浏览器 SSO 流程中。

### 响应与账单的精确关联

每次模型请求成功后，插件从响应头提取 `x-request-id` 作为 `requestId`、可选的 `x-trace-id` 作为 `traceId`，并以响应体的 `id` 作为 `responseId`。OMP 将 `responseId` 保存在 assistant 消息中。插件先把 `requestId`、`traceId`、`responseId`、请求时间和 session 路径写入 `<session>.hepai-billing.json`，再启动账单查询。

查询向 `/apiv2/portal/billing/invoke_records` 发送 `page`、`page_size`、`start_date` 和 `end_date`。接口会忽略请求体中的 `request_id`，因此插件在请求时间前后各 1 天的范围内逐页读取，每页 100 条，直到精确匹配或读完接口报告的总页数。只有 `remarks.request_id === requestId` 且已捕获 trace ID 时 `remarks.trace_id === traceId` 才算匹配。记录顺序、时间接近程度、响应体 `id` 和账单 `invoke_id` 都不是匹配键；匹配后才保存 `invoke_id`。

读取过的账单缓存在 OMP 全局 agent 目录的 `<agentDir>/cache/hepai-invoices.json`（默认 `~/.omp/agent/cache/hepai-invoices.json`）。`<agentDir>` 随 OMP 当前 profile 或 `PI_CODING_AGENT_DIR` 确定，因此同一 profile 的 session 共用缓存，不同 profile 不混用。记录在 30 天后失效，并在下次写入时清理。缓存以 `requestId` 为键；命中后无需再次逐页查询。缓存只保存 request/trace ID、账单 ID、请求时间、token 数和账单金额，不保存原始 `remarks`、用户名、API Key、请求头、prompt 或响应预览。

### Session 真实费用结算

精确匹配账单后，插件先把实际嵌套结构或旧版顶层结构规范化并持久化到 sidecar `billing`，再只从这份 sidecar `billing` 映射 OMP session `Usage`。HepAI 的 `completion`/`output_tokens` 与 `internal_reasoning`/`reasoning_tokens` 是两个独立 token 计费组，彼此不是子集。OMP 只有一个 output 费用桶，因此映射时 `usage.output = completion + internal_reasoning`，同时以 `reasoningTokens` 标记其中由 HepAI 单独计费的 reasoning 数量；`totalTokens` 为 input、合并后的 output 和两种 cache token 数之和。顶层 `payable_amount` 换算为 USD 后写入 sidecar，并成为 OMP 的权威总费用。

实际读取字段及缺失时的 fallback 顺序如下。顺序从左到右；无效值（非有限数、负 token 或非整数 token）视为缺失。可选 token 分项全部缺失时为 `0`，但 `payable_amount` 缺失时拒绝结算，防止把估算费用误写成权威账单。

HepAI 理论上有五个标准计费组：`prompt`、`completion`、`input_cache_read`、`input_cache_write` 和 `internal_reasoning`。实际账单是稀疏响应：某组的 token 或费用为 0 时，`std_amounts`、`std_costs` 或 `cost_breakdown` 中可能完全不返回该组。只要账单提供了任一 `cost_breakdown`，未出现的组就按账单值 `0` 处理，不会用 OMP 估算费用补回；只有整个新旧 `cost_breakdown` 都缺失时，才保留响应结束时的 OMP 估算分项。

| HepAI 来源及 fallback | 先写入 sidecar `billing` | 再由 sidecar 写入 OMP session |
| --- | --- | --- |
| `input_tokens` = `standard_invoke_record.input_tokens` → `*.std_amounts.prompt` → prompt/input breakdown amount → `0` | `standard_invoke_record.input_tokens = input_tokens` | `usage.input = billing.standard_invoke_record.input_tokens` |
| `completion_tokens` = `standard_invoke_record.output_tokens` → `billing_basis.usage.output_tokens` → `*.std_amounts.completion` → completion/output breakdown amount → `0` | `standard_invoke_record.output_tokens = completion_tokens` | `usage.output = billing.standard_invoke_record.output_tokens + billing.standard_invoke_record.reasoning_tokens` |
| `reasoning_tokens` = `standard_invoke_record.reasoning_tokens` → `usage.output_tokens_details.reasoning_tokens`/`thinking_tokens` → `*.std_amounts.internal_reasoning` → reasoning breakdown amount → `0` | `standard_invoke_record.reasoning_tokens = reasoning_tokens` | `usage.reasoningTokens = billing.standard_invoke_record.reasoning_tokens`；它是合并后 `usage.output` 的子集 |
| `cache_read_tokens` = `standard_invoke_record.cache_read_tokens` → `*.std_amounts.input_cache_read` → `usage.cache_read_input_tokens` → cache-read breakdown amount → `0` | `standard_invoke_record.cache_read_tokens = cache_read_tokens` | `usage.cacheRead = billing.standard_invoke_record.cache_read_tokens` |
| `cache_write_tokens` = `standard_invoke_record.cache_write_tokens` → `*.std_amounts.input_cache_write` → `usage.cache_creation_input_tokens` → cache-write breakdown amount → `0` | `standard_invoke_record.cache_write_tokens = cache_write_tokens` | `usage.cacheWrite = billing.standard_invoke_record.cache_write_tokens` |
| 上述 token 桶 | 不另存 `totalTokens`；可由上述字段重算 | `usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite` |
| `prompt_cost` = `billing_basis.cost_breakdown.prompt.cost` → 旧版 `prompt.cost`/`input.cost` → `0` | `cost_breakdown.prompt.cost = prompt_cost × 0.143` | `usage.cost.input = billing.cost_breakdown.prompt.cost × billing.total_discount_rate` |
| `completion_cost` = `completion.cost`/`output.cost` → `0` | `cost_breakdown.completion.cost = completion_cost × 0.143` | `usage.cost.output = (billing.cost_breakdown.completion.cost + billing.cost_breakdown.internal_reasoning.cost) × billing.total_discount_rate` |
| `reasoning_cost` = `internal_reasoning.cost` → `0` | `cost_breakdown.internal_reasoning.cost = reasoning_cost × 0.143`，独立保留 | 不单独写入 OMP `Usage` |
| `cache_read_cost` = `input_cache_read.cost` → `cache_read.cost`/`cacheRead.cost` → `0` | `cost_breakdown.input_cache_read.cost = cache_read_cost × 0.143` | `usage.cost.cacheRead = billing.cost_breakdown.input_cache_read.cost × billing.total_discount_rate` |
| `cache_write_cost` = `input_cache_write.cost` → `cache_write.cost`/`cacheWrite.cost` → `0` | `cost_breakdown.input_cache_write.cost = cache_write_cost × 0.143` | `usage.cost.cacheWrite = billing.cost_breakdown.input_cache_write.cost × billing.total_discount_rate` |
| 顶层 `payable_amount`；缺失或无效时拒绝结算 | `payable_amount = payable_amount × 0.143` | `usage.cost.total = billing.payable_amount` |
| 顶层 `original_price` → `payable_amount + discount_amount` → `payable_amount` | `original_price = original_price × 0.143` | 不单独写入 OMP `Usage` |
| 顶层 `discount_amount` → `max(0, original_price - payable_amount)` | `discount_amount = discount_amount × 0.143` | 不单独写入 OMP `Usage` |

其中 `total_discount_rate = billing_basis.total_discount_rate → 顶层 total_discount_rate → 1`。该折扣率写入 sidecar `billing.total_discount_rate`，并只用于账单提供 breakdown 时计算 OMP 分项费用；sidecar 的各组 `cost_breakdown.*.cost` 保存换算为 USD 的折扣前金额，总费用始终直接使用 `payable_amount × 0.143`。

当 `standard_invoke_record` 存在时，其规范 token 数优先于所有重复字段；`billing_basis.usage` 和 `std_amounts` 只补缺失字段，不覆盖规范值。HepAI 的 completion 和 reasoning token 独立计量、独立计价；由于 OMP 要求 `reasoningTokens` 是 `usage.output` 的子集，插件只在 sidecar → OMP 映射层将两者合并进 output。实际嵌套 breakdown 和旧版顶层 breakdown 都按 CNY 换算后进入 sidecar；存在 breakdown 时，省略的零值组保持为零，只有整个 breakdown 缺失时才保留 OMP 估算分项。

五组费用的 `cost` 均是 HepAI 返回的 CNY 分项原价。插件计算 OMP 分项费用时使用 `cost × total_discount_rate × 0.143`。如果账单存在 `cost_breakdown`，其中未出现的组表示该组费用为 `0`；只有整个嵌套及旧版 `cost_breakdown` 都缺失时，才保留模型响应结束时的 OMP 估算分项。`payable_amount × 0.143` 始终是 OMP `cost.total` 的权威值，因此分项之和不被用来替代总价。

存在旧结构 `cost_breakdown` 时的字段映射：

- `payable_amount` 写入 `usage.cost.total`，包含全部收费项目。
- `original_price`、`discount_amount`、`payable_amount` 和每个 `cost_breakdown.*.cost` 按 `CNY × 0.143` 换算；token `amount` 和 `total_discount_rate` 保留原值。
- sidecar 记录 `currency: "USD"`、`sourceCurrency: "CNY"`、`exchangeRate: 0.143` 以及完整换算后的 breakdown，包括 `internal_reasoning`。
- `usage.output` 合并 completion 与 `internal_reasoning` token；`usage.cost.output` 合并两者折后费用。`reasoningTokens` 标识推理子集，`totalTokens` 只计算一次合并后的 output。input 与 cache 项写入对应 OMP 字段。
- ID 关联和账单明细以外的敏感调用字段不写入 sidecar。

结算按 `responseId` 定位 assistant entry，更新其 OMP `Usage`，并通过 `SessionManager.rewriteEntries()` 持久化。随后由 `@oh-my-pi/omp-stats` 重新 ingest。每个 request ID 结算一次。pending 记录跨重启保留；重试耗尽后标为 `failed`。SSO 登录后，重启或 `/hepai-settle` 会重试 pending 和 failed 记录。

### SSO 要求

- 网站 SSO 登录使用 OMP 内置的 Chromium 启动器。
- Chromium 需要访问 `ai.ihep.ac.cn` 和 `newlogin.ihep.ac.cn`。Windows 上遇到 `ERR_CONNECTION_CLOSED` 时，为 browser-session 配置系统代理；它不继承 `HTTP_PROXY`/`HTTPS_PROXY`。
- 网站 SSO 从 `ai.ihep.ac.cn` 发起，IHEP 统一认证由 `newlogin.ihep.ac.cn` 完成。

## 配置与安全

隔离开发时，`HEPAI_DEV_USE_ENV=1` 让 OMP 读取 `HEPAI_API_KEY`。正常登录使用 `/hepai-login`。

OMP 将凭据保存在本地 SQLite `AuthStorage`。使用账户权限和磁盘加密保护 OMP 数据目录、session sidecar 和账单缓存；SQLite 凭据没有明确的 DPAPI 或系统钥匙串保护。

Catalog 价格按 `CNY price × model_pricing.discount_rate × 0.143` 提供临时 USD 分项估算，折扣率缺失时按 `1`。结算用 `payable_amount × 0.143` 替换总费用；只有账单提供 `cost_breakdown` 时才替换分项价格，并使用账单自身独立的 `total_discount_rate`。OMP 成本字段没有币种标记，界面可能显示固定 `$` 前缀。

## 开发与验证

在父级 workspace 中运行：

```powershell
npm run typecheck --workspace omp-provider-hepai
npm test --workspace omp-provider-hepai
npm run build --workspace omp-provider-hepai
```

真实服务集成测试使用临时 OMP 配置，发现 HepAI 模型并执行一次生成：

```powershell
$env:HEPAI_E2E = "1"
bun test test/omp-auth-e2e.test.ts
```

运行前在环境变量中设置 `HEPAI_API_KEY`。该测试会产生真实费用，从 `PATH` 查找 `omp`；`OMP_BIN` 可指定其他可执行文件。
