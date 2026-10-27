# 模型配置

模型配置分为三层：omp 的模型目录决定「有哪些模型可选」，`models.yml` 决定「provider / 模型 / 凭据长什么样」，`config.yml` 决定「哪个角色用哪个模型」。PiDeck 把这三层都做了可视化入口，本页说明它们之间的实际读写关系。

## 四个文件的分工

| 文件 | 位置 | 作用 |
|---|---|---|
| `models.yml` | `~/.omp/agent/` | omp 实际读取的模型与凭据权威源（`providers.<name>.apiKey`） |
| `models.json` | `~/.omp/agent/` | PiDeck 侧的模型表单数据与兼容镜像 |
| `config.yml` | `~/.omp/agent/` | 全局设置权威源；模型角色、预设、循环顺序、回退链都在这里 |
| `auth.json` | — | 已废弃，PiDeck 不再读写 |

### 各入口读的是哪份文件

| 入口 | 读取 | 写入 |
|---|---|---|
| 配置管理 → Models 页（Provider 卡片、模型网格、连接测试） | `models.json`；文件不存在时回退 `models.yml` 并尽力迁移一份 json | `models.json`，随后把整表镜像到 `models.yml`（镜像失败仅告警） |
| 配置管理 → Auth 页 | `models.yml`；文件不存在时回退 `models.json` | 对 `models.yml` 做原位 patch，随后同步一份 `models.json` 镜像（失败仅告警） |
| 配置导出 | `models.yml` | — |
| 配置导入 | 包内数据 + 本机 `models.yml` 作为合并基线 | `models.json` 与 `models.yml` |
| 运行中的会话 | omp 自己读 `models.yml` | — |

由此有两个容易踩到的点：

- **手改 `models.yml` 的 provider/模型清单不会出现在 Models 页**：Models 页以 `models.json` 为准。若要让手改生效并可见，改完在源文件页把 `models.json` 也同步（或删掉 `models.json` 让 PiDeck 重新迁移）。
- **在 Models 页保存会用 `models.json` 的内容整表重写 `models.yml`**。想保留 `models.yml` 里的注释，只改 key 时请用 Auth 页（它按 YAML Document 原位修改），不要用 Models 页保存。

## 模型目录

模型列表由 omp 提供，PiDeck 不内置任何模型清单：

1. 首次需要列表时先执行 `omp --help` 探测命令形态：新版走 `models --json`，旧版回退表格形式的 `--list-models`。
2. 默认只取 `kind = chat` 的条目（对话模型）；「模型角色」页需要生图/语音等条目，此时追加 `--kind all`。
3. 结果按进程内存缓存（选择器、角色页各一份），不再重复拉起子进程。目录刷新可能走网络，首次可能耗时十几秒。
4. `kind = embedding` 的条目不会出现在任何选择器里。

目录条目里的 `kind` 取值：`chat`、`image`、`search`、`tts`、`stt`、`judge`、`tiny`（旧版 omp 不返回 `kind`，此时全部按可对话模型处理）。

### 为什么模型选择器只出现一部分模型

- **会话内模型切换**（状态栏模型菜单）只列 `kind = chat`。
- **模型角色页**按角色接受的 kind 过滤，见下节。

## models.yml 结构

```yaml
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    apiKey: OPENAI_API_KEY
    api: openai-completions
    models:
      - id: gpt-5
        name: GPT-5
        reasoning: true
        contextWindow: 400000
        maxTokens: 128000
        input: ["text","image"]
        compat:
          supportsReasoningEffort: true
  local-gateway:
    baseUrl: http://127.0.0.1:8080/v1
    apiKey: "!op read op://dev/gateway-key"
    models:
      - id: qwen3-coder
```

字段说明：

| 字段 | 说明 |
|---|---|
| `providers.<name>.baseUrl` | 该 provider 的接口地址 |
| `providers.<name>.apiKey` | 凭据。可以是明文、环境变量名，或 `!command` 形式；PiDeck 原样保存，不做前缀或类型判断 |
| `providers.<name>.api` | 接口形态。PiDeck 会把别名规范化：`anthropic`/`anthropic-messages` → `anthropic-messages`，`openai-chat-completions` → `openai-completions`，缺省或未知值 → `openai-completions`；其余按原值保留（`openai-responses`、`openai-codex-responses`、`google-generative-ai`、`mistral-conversations`） |
| `providers.<name>.models[]` | 模型数组，`id` 必填；`name`、`reasoning`、`contextWindow`、`maxTokens`、`input`、`compat`、`thinking`、`thinkingLevelMap` 等由 omp 解释 |
| 其它字段 | 镜像时原样保留，不做白名单过滤 |

保存时的约束：

- **Auth 页**只改 `providers.<name>.apiKey`（原位 patch，保留注释与手工字段）；提交数据里缺席或为空的 provider 视为清空该 key，provider 本身及其 `models`/`baseUrl` 保留。改完会再同步一份 `models.json` 镜像。
- **`models.yml` 解析失败时拒绝保存**，提示先到源文件页修复；`providers: null` 或 `openai:` 这类空声明会按空映射补全，不会报错。
- **Models 页 / 源文件页保存**以 `models.json` 为准，把整表镜像成 `models.yml`（字段顺序固定，注释不保留）；镜像失败会以警告提示，不会静默分叉。

## 模型角色

`config.yml` 的 `modelRoles.<role>` 决定各场景用哪个模型，选择器值格式为：

```text
provider/modelId[:thinkingLevel]
```

例如 `anthropic/claude-sonnet-4-5:high`。省略 `:thinkingLevel` 表示沿用默认思考档。

共 15 个角色，选模型时按角色接受的 kind 过滤：

| 角色组 | 角色 | 接受的 kind |
|---|---|---|
| 对话 | `default`、`smol`、`slow`、`vision`、`plan`、`commit`、`task`、`advisor` | `chat` |
| 对话 | `tiny`、`memory` | `tiny`、`chat` |
| 按 kind | `image` | `image` |
| 按 kind | `web` | `search`、`chat` |
| 按 kind | `speech` | `tts` |
| 按 kind | `dictation` | `stt` |
| 按 kind | `judge` | `judge`、`tiny`、`chat` |

`vision` 角色选的是文本模型：它负责描述图片，因此候选仍是 `chat` 模型，而不是 `kind = image` 的生图模型。

角色写入全局 `config.yml`，运行中的会话需要重启后才会用上新配置。

## 模型预设

预设把「全部角色 + 默认思考档」存成命名快照，写在 `config.yml` 的 `modelPresets.<name>`：

```yaml
modelPresets:
  fast-coding:
    modelRoles:
      default: anthropic/claude-sonnet-4-5
      smol: anthropic/claude-haiku-4-5
    defaultThinkingLevel: medium
```

- 名字必须以字母开头，只能包含字母、数字、下划线和连字符。
- 应用预设会**整体替换** `modelRoles`（预设里没有的角色会被清掉）。
- 预设没记录 `defaultThinkingLevel` 时，保留当前顶层档位。
- 结构不合法的预设不会出现在应用/删除列表中，但仍留在文件里，可用源文件页修复。

## 循环顺序与回退链

- `cycleOrder`：逗号分隔的角色列表，决定模型快速切换时依次经过的角色；清空即删除该键，回到 omp 默认顺序。
- `retry.fallbackChains`：把角色或模型选择器映射到有序的回退选择器；删除最后一条链会一并删掉空的 `retry` 键。

两者都写全局 `config.yml`，与预设一样需要重启会话生效。

## 导入与导出

- 导出包**不包含任何 `apiKey`**（明文密钥、环境变量名、`!command` 一律省略），并带上 `modelRoles`、`modelPresets`、`cycleOrder`、`retry.fallbackChains` 与设置页可编辑的 `config.yml` 键。
- 导入时以本机 `models.yml` 为合并基线：包内缺失或为空的 key 保留本机已有值，只有包内显式非空 key 才覆盖。
- `models.yml` 存在解析诊断时导入直接中止，避免先丢弃可修复内容再覆盖。
- 旧包里的 `auth.json` 会被忽略。

## 常见问题

**模型列表为空**

1. 在终端执行 `omp --help`，确认存在 `models`（或 `--list-models`）命令；
2. 目录首次拉取可能走网络，等待或检查代理设置；
3. 打开「设置 → 缓存与日志」查看应用日志，确认是否有 `pi model list returned no parsable entries`。

**保存后会话仍然 401**

- 检查 `models.yml` 里对应 provider 的 `apiKey` 是否真的写入（Auth 页保存的是这份文件）；
- 若刚导入过配置，确认本机原有的 key 是否仍在（导出包不带 key）；
- omp 对凭据的解析以 `models.yml` 为准，`auth.json` 不再参与。

**Auth 页提示没有运行中的 Agent**

OAuth 的 provider 列表与凭据都由 omp 运行时提供：先启动一个会话，再回到 Auth 页（弹窗聚焦时会自动重新探测）。

**Auth 页提示当前 omp 版本没有可用的 OAuth provider**

旧版 omp 没有 `get_login_providers` 等命令，此时仍可用下方的 API Key 表单。

**保存时报 `models.yml` 解析失败**

说明文件本身已损坏。`models.yml` 不在配置管理的源文件页（那里只提供 `config.yml`、`models.json`、`trust.json`），请用外部编辑器打开 `~/.omp/agent/models.yml` 修复。PiDeck 不会把无法解析的文件重写成半份配置。
