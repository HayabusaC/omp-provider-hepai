# OMP HepAI Provider

这是面向 OMP 的独立 Provider 实现，并非从其他 HepAI 插件 fork。包版本：`0.3.0`。

[English](README.md) | [简体中文](README.zh-CN.md)

这是 HepAI/HaiDDF 的非官方 Oh My Pi 附属 provider。它将 HepAI 作为 provider `hepai` 接入 OMP，动态发现当前 API Key 可用的模型，原样保留模型 ID，并通过 OMP 原生 Responses、Chat Completions 或 Anthropic Messages transport 发起请求。

本插件从属于 HepAI/HaiDDF，是面向 OMP 的下游兼容层；它不是 HepAI 或 HaiDDF 的官方发行物，不替代 HepAI Portal 或上游文档，也不承诺超出下述快照范围的兼容性。

## HepAI 与上游链接

- HepAI Portal：<https://ai.ihep.ac.cn>
- HepAI 生产 API：<https://aiapi.ihep.ac.cn/apiv2>
- HaiDDF 源码仓库：<https://github.com/stcapo/hai-ddf>
- HepAI API 参考文档：<https://docs-ai.ihep.ac.cn/s/hai/doc/api-UticaXRzFe>

**上游兼容性维护与实测截止：2026-09-22。** 本插件基于 OMP 18.2.7 构建并完成验证。HepAI/HaiDDF 变动频繁；本文中的路径、请求/响应结构、鉴权行为、账单字段和兼容性说明，仅代表截至该日期对生产环境的实测快照，不应视为永久稳定的上游契约。

> **币种规则：HepAI 返回的所有原始金额数据均为 CNY。** 这包括 catalog 单价、经费/credit 金额、`original_price`、`discount_amount`、`payable_amount`，以及 `cost_breakdown` 内每一个收费项的 `cost`（包括 `internal_reasoning`）。插件将这些金额全部按 `CNY × 0.143` 换算后写入 OMP 的 USD 计费字段。token 数量、计量数量、各类 ID 和 `total_discount_rate` 不是金额，不做换算。

## HepAI API 快照

所有运行时路径均使用 `https://aiapi.ihep.ac.cn`。

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/apiv2/models` | 模型 API Key | 当前 Key 可访问模型的权威列表 |
| `GET` | `/apiv2/portal/model/list_cloud_models?page=<n>&page_size=100` | 无 | 可选模型元数据增强 |
| `POST` | `/apiv2/responses` | 模型 API Key | Responses transport 与探测 |
| `POST` | `/apiv2/chat/completions` | 模型 API Key | Chat Completions transport 与探测 |
| `POST` | `/apiv2/anthropic/v1/messages` | 模型 API Key | Anthropic transport 与探测 |
| `GET` | `/apiv2/portal/user/login_sso` | 浏览器 SSO 会话 | 获取 `refresh-token` |
| `GET` | `/apiv2/portal/user/refresh` | `refresh-token` cookie | 获取/刷新 Portal JWT |
| `GET` | `/apiv2/portal/billing/mine/all_funds` | Portal JWT | 经费汇总 |
| `POST` | `/apiv2/portal/billing/invoke_records` | Portal JWT | 调用记录与权威账单金额 |

OMP Anthropic transport 接收的 base URL 是 `https://aiapi.ihep.ac.cn/apiv2/anthropic`，并自行追加 `/v1/messages`。

已验证但明确不使用的候选路径：

- `GET /apiv2/v1/models` 也返回模型列表，但插件使用 `/apiv2/models`。
- `POST /apiv2/v1/messages` 和 `POST /apiv2/messages` 返回 HTTP 405。
- `/apiv2/api/v1/model-catalog` 返回 HTML 应用，而不是 JSON catalog。

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
/hepai-test openai/gpt-5.6-sol
```

`/hepai-login` 会请求 HepAI 模型 API Key，并通过 OMP `AuthStorage` 保存。插件不会写入 `.env`、`models.yml` 或自建 Key 文件。

模型 API Key 始终由用户本人输入。插件不会从任何 HepAI 或 Portal API endpoint 请求、创建、推导或导入模型 API Key。只有在用户输入 Key 后，插件才调用 `GET /apiv2/models`，且该接口仅用于列出这个 Key 可访问的模型。

## 工作原理

### 1. 注册与凭据

扩展注册两个相互独立的 provider：

| Provider ID | 凭据 | 用途 |
| --- | --- | --- |
| `hepai` | HepAI 模型 API Key | 模型发现和推理 |
| `hepai-portal-sso` | Portal refresh cookie 与 access JWT | 仅用于 Portal 账单 |

两类凭据不会混用：Portal JWT 不会发送到推理接口，模型 API Key 也不会发送到 Portal 账单接口。

### 2. 模型发现

OMP 解析 `hepai` 凭据后调用 provider 的动态模型加载器。

1. `GET /apiv2/models` 返回当前 API Key 可访问的权威模型 ID。
2. 插件读取公共 Portal catalog，每页 100 条，最多 50 页。
3. catalog 按模型 ID 精确匹配，可补充显示名称、上下文/输出上限、推理能力、图片输入能力及已验证的每百万 token 价格；catalog 中的金额单价按 `× 0.143` 从 CNY 换算到 OMP 的 USD 字段。
4. 最终只暴露 `/models` 返回的 ID；公共 catalog 绝不会添加当前 Key 无权访问的模型。

如果 catalog 加载失败，模型发现仍会返回 API Key 范围内的模型。OMP 必填数值字段使用明确的执行默认值：上下文窗口 `128000`、最大输出 `16384`、未知价格 `0`。

### 3. 协议选择与回退

注册的模型 API 为 `hepai-auto`。它把流式请求交给 OMP 内置 transport，不自行实现协议解析器。

| 模型 ID | 初始顺序 |
| --- | --- |
| 包含 `claude` 或 `anthropic/` 片段 | Anthropic Messages → Responses → Chat Completions |
| 其他 ID | Responses → Chat Completions → Anthropic Messages |

某次尝试成功前，插件会暂存事件，避免失败协议泄漏部分响应。成功的 transport 会按模型 ID 缓存在当前 OMP 进程中。

HTTP `400`、`404`、`405`、`422` 等协议/模型兼容错误允许回退；以下情况明确停止回退：

- HTTP `401` 或 `403`，因为切换协议无法修复凭据；
- HTTP `5xx`，因为回退会掩盖上游故障；
- 无法归类为协议/模型不兼容的流错误。

### 4. 能力探测

`/hepai-test <model-id>` 会并行向三个推理 endpoint 各发送一个最小非流式请求，并将结果分类为：

- `supported`
- `model-unsupported`
- `auth-failed`
- `endpoint-missing`
- `request-rejected`
- `upstream-error`

若有一个或多个协议可用，命令会按正常优先级选出首选协议，并写入该模型的进程内缓存。探测会产生真实、可能计费的 API 请求，输出上限为 16 token。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/hepai-login` | 提示输入 `hepai` 模型 API Key，并保存到 OMP `AuthStorage` |
| `/hepai-test <model-id>` | 探测三种推理协议；省略参数时使用当前选中的 HepAI 模型 |
| `/hepai-portal-auth` | 报告 `hepai-portal-sso` 是否已保存，并显示登录命令 |
| `/hepai-billing` | 汇总最近 30 天第一页 20 条调用记录与经费信息 |
| `/hepai-settle` | 恢复当前 session 中 pending 账单的精确 ID 结算 |
| `/login hepai-portal-sso` | 打开 IHEP SSO 浏览器流程，并将返回的 Portal 凭据保存到 OMP |

## Portal SSO 与账单

Portal 访问是可选功能；列出和调用模型都不需要 Portal 登录。

`/login hepai-portal-sso` 要求 OMP browser-session 登录只捕获 HepAI 的 `refresh-token` cookie。插件用该 cookie 换取 Portal access JWT，并通过 OMP 原生 OAuth 凭据保存两者。插件不会请求或保存用户的 IHEP 用户名和密码。

`/hepai-billing` 并行读取：

- `GET /apiv2/portal/billing/mine/all_funds`
- `POST /apiv2/portal/billing/invoke_records`

调用记录请求固定为第 1 页、每页 20 条，并以 `YYYY-MM-DD` 格式发送最近 30 天的 `start_date`/`end_date`。汇总结果包含经费数量、credit 合计、输入/输出 token 和折后 `payable_amount` 合计。所有展示的金额均由 CNY 统一执行 `× 0.143`，并明确标记为 USD。若账单请求返回 `401` 或 `403`，插件会要求 OMP 刷新一次 Portal 凭据，并只重试一次。

原始调用记录可能包含 Authorization header、IP 地址、prompt、响应预览、trace ID 和 Key 标识；该命令会忽略且绝不显示这些字段。

### 请求 ID 对照

2026-09-22 使用 `hepai/deepseek-v4-pro` 实测确认：Responses、Chat Completions、Anthropic Messages 都返回响应体顶层 `id`，响应头还包含 `x-request-id` 和 `x-trace-id`；三次请求均能在 `/apiv2/portal/billing/invoke_records` 中找到。

账单中的数值型 `invoke_id` 是独立的数据库标识，不等于响应体 `id`。记录关联方式如下：

- 响应头 `x-request-id` 等于 `remarks.request_id`，这是主要的精确关联键；
- 响应头 `x-trace-id` 等于 `remarks.trace_id`；
- 对本次实测响应，响应体顶层 `id` 会出现在 `remarks.response_preview` 中。

账单可能异步入库，新调用可能需要短暂等待才会出现。原始 `remarks` 含敏感信息，不应整体写入日志。

### Session 真实费用结算

HepAI assistant 调用成功后，`input`、`output`、`cacheRead`、`cacheWrite`、`reasoningTokens` 和 `totalTokens` 仍完全由 OMP 原生协议解析器提供。插件不修改 OMP `Usage` 结构或 token 解析逻辑。

AssistantMessage 正常落盘后，插件为每个 session 写入 `<session>.hepai-billing.json` sidecar，保存精确的 `responseId ↔ requestId ↔ traceId ↔ invokeId` 关联，并在后台有限重试 `POST /apiv2/portal/billing/invoke_records`。只有 `remarks.request_id` 与捕获的 request ID 完全相同，且已捕获 trace ID 时 `remarks.trace_id` 也完全相同，记录才会被接受。插件绝不会使用最新/时间最近的记录，也不会通过余额变化猜测关联。

查到账单后，`payable_amount` 是总费用的唯一权威值。HepAI 返回的每个金额都按 CNY 处理，并在保存前统一执行 `CNY × 0.143`：包括 `original_price`、`discount_amount`、`payable_amount` 以及每个 `cost_breakdown.*.cost`。token 数量 `amount` 等非金额字段和无量纲的 `total_discount_rate` 不换算。sidecar 将换算后的值标记为 `currency: "USD"`，同时记录 `sourceCurrency: "CNY"`、`exchangeRate: 0.143` 和完整的已换算 breakdown。可映射且已折扣的 breakdown 费用写入 `usage.cost.input`、`output`、`cacheRead` 和 `cacheWrite`；`internal_reasoning` 作为独立 sidecar 项保留，不合并进 output。包括无法映射项目在内的全部收费仍通过换算后的 `payable_amount` 计入 `usage.cost.total`；无关的敏感调用字段不会被复制。

插件通过 `responseId` 精确定位 assistant entry，并使用 OMP 18.2.7 原生原子 `SessionManager.rewriteEntries()` 重写。共享的 session/runtime 消息引用同步更新，之后由 `@oh-my-pi/omp-stats` 重新 ingest。已 settled 的 request ID 幂等，不会重复修改；pending 状态跨重启保留。未配置 Portal SSO 时不会影响推理，只保持 pending；一轮有限重试耗尽后标为 `failed`，重启或 `/hepai-settle` 会在登录后重新激活 pending/failed 项。

### SSO 兼容说明

- OMP 客户端必须支持原生 browser-session 登录。
- 若浏览器立即报告 `ERR_CONNECTION_CLOSED`，请确保 Chromium 会话能访问 `aiapi.ihep.ac.cn` 和 `newlogin.ihep.ac.cn`。OMP 18.2.7 的 browser-session 不继承 `HTTP_PROXY`/`HTTPS_PROXY`；Windows 上可能需要在登录期间启用对应的系统代理，完成后再恢复原设置。
- 生产 refresh 路由当前会报告未记录的 `query/self` 缺失字段。插件仅在遇到这一精确 FastAPI 校验错误时以 `?self=1` 重试。
- `ai.ihep.ac.cn`、`aiapi.ihep.ac.cn` 和 `ddf.ihep.ac.cn` 不会被视为可互换的 OAuth origin。

## 配置与安全

正常使用没有面向用户的环境变量配置。仅在隔离开发环境中，设置 `HEPAI_DEV_USE_ENV=1` 才会让 OMP 从 `HEPAI_API_KEY` 解析凭据；该开关默认关闭。

OMP 18.2.7 将原生凭据保存在本地 SQLite `AuthStorage`。插件不会创建额外的明文凭据存储，但也不声称 SQLite 载荷受 Windows DPAPI 或系统钥匙串保护。请使用正常的账户权限和磁盘加密保护 OMP 数据目录。

HepAI catalog 价格按 `CNY × 0.143` 换算，在推理进行时作为 USD 临时估算，但不是最终账单。结算完成后，插件使用同样换算后的 Portal 账单替换 monetary usage。OMP 18.2.7 没有币种字段，界面可能固定显示 `$` 前缀。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `index.ts` | Provider 注册、模型发现、transport 调度和命令 |
| `endpoints.ts` | HepAI 规范 URL |
| `catalog.ts` | 公共 catalog 分页和 OMP 模型元数据映射 |
| `capabilities.ts` | 探测请求、分类、transport 顺序和回退规则 |
| `portal-auth.ts` | 浏览器 SSO、refresh cookie 校验和 JWT 刷新 |
| `portal-client.ts` | 账单请求和隐私安全的汇总 |
| `billing-types.ts` | 权威账单校验和 CNY 到 USD 的费用映射 |
| `billing-sidecar.ts` | 按 session 原子保存 request/response/trace/invoke 关联 |
| `billing-settlement.ts` | pending 重试、精确匹配、OMP 原子重写和 stats 重新 ingest |

## 开发与验证

在父级 workspace 中运行：

```powershell
npm run typecheck --workspace omp-provider-hepai
npm test --workspace omp-provider-hepai
npm run build --workspace omp-provider-hepai
```

可选真实集成测试使用隔离的 OMP 配置根目录和原生 `AuthStorage`，从子进程删除 `HEPAI_API_KEY` 与 `HEPAI_DEV_USE_ENV`，发现真实 HepAI 模型并执行一次生成：

```powershell
$env:HEPAI_E2E = "1"
bun test test/omp-auth-e2e.test.ts
```

该测试默认跳过，避免未经请求的联网调用和计费。
