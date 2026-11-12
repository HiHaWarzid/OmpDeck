# 配置与 Skills

PiDeck 提供图形化配置入口，减少频繁查找和编辑 pi 配置文件的成本。

## 配置管理

配置弹窗包含以下页面：

- Models：Provider 卡片、模型网格和连接测试。
- Auth：omp 原生 OAuth 登录/登出 + API Key 管理。
- Settings：类型感知的键值编辑器（读写 `config.yml`）。
- 源文件：查看和编辑 `config.yml`、`models.json`、`trust.json` 原文。
- Skills：管理全局 Skills。

<img class="doc-screenshot" src="/images/config.png" alt="配置管理界面">

### 配置文件分工

| 文件 | 作用 |
|---|---|
| `models.yml` | omp 的模型与凭据权威源（`providers.<name>.apiKey`）。Auth 页只改这里的 key，并保留注释与其它手工字段。 |
| `models.json` | PiDeck 的模型表单数据与兼容镜像：Models 页以它为读源，保存时再整表镜像到 `models.yml`。 |
| `config.yml` | 设置权威源。Settings 页、模型角色、预设、循环顺序、回退链都写这里。 |

读写顺序（Models 页先读 json、Auth 页与导出先读 yml）和字段格式见 [模型配置](/guide/models)。`auth.json` 已不再被读写：凭据只认 `models.yml`。`models.yml` 解析失败时，Auth 页会拒绝保存并提示先修复，避免把损坏文件重写成半份配置。

### OAuth 登录

Auth 页顶部是 omp 原生 OAuth 区域，直接调用 omp 的 `get_login_providers` / `login` / `get_logout_accounts` / `logout`：

1. 需要一个运行中的 Agent（provider 列表与凭据都由 omp 运行时提供），没有会话时该区域只显示提示。
2. 点「登录」后 omp 返回授权地址，PiDeck 自动用系统浏览器打开，并展示可复制的回跳地址与授权码输入框；切到其它 tab 也不会丢掉回调。
3. 已登录的 provider 显示「已登录」，可用「管理凭据」展开已存凭据，逐条「登出」。
4. 旧版 omp 没有这些 RPC 时显示「当前 omp 版本没有可用的 OAuth provider」，不影响下方 API Key 编辑。

### API Key

- 从内置供应商预设选择，或手填任意 provider 名；值写入 `models.yml` 的 `providers.<name>.apiKey`。
- 清空某个 provider 的 key 并保存 = 删除该 provider 的 `apiKey`（provider 本身及其 `models`/`baseUrl` 保留）。
- 环境变量名与 `!command` 形式原样保存，PiDeck 不做前缀或类型判断。
- 配置导出包不包含任何 `apiKey`；导入时保留目标机器已有的 key。

## 模型角色

设置弹窗的「模型角色」页把 omp 的 `modelRoles` 可视化，分两组共 15 个角色：

- 对话角色：`default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`memory`、`task`、`advisor`。
- 按 kind 选择的角色：`image`、`web`、`speech`、`dictation`、`judge`。

选择模型时只列出该角色接受的 kind；同一页还提供模型预设（`modelPresets`）、模型快速切换顺序（`cycleOrder`）和回退链（`retry.fallbackChains`），全部写入全局 `config.yml`，运行中的会话需重启后生效。

角色可用的 kind、选择器格式、预设规则与排障步骤见 [模型配置](/guide/models)。

## pi 路径

应用启动时会自动检测系统中的 `pi` 命令。自动检测失败时，可以在设置中手动输入路径。

Windows 下支持常见路径形式：

```text
"C:\Program Files\pi\pi.cmd"
C:\\Program Files\\pi\\pi.cmd
C:\Program Files\pi\pi
```

## 代理设置

PiDeck 区分两类代理：

- pi agent 子进程代理：影响实际 Agent 进程。
- 桌面端代理：影响模型拉取、连接测试等桌面应用请求。

这种拆分可以避免桌面端检测和 Agent 执行互相干扰。

## 外部编辑器管理

设置中新增“编辑器”配置页，支持检测、启用/禁用和配置系统中的外部编辑器。

### 支持的编辑器

- Visual Studio Code（含 Insiders、VSCodium）
- Cursor
- Zed
- IntelliJ IDEA
- WebStorm
- PhpStorm
- PyCharm

### 检测方式

Windows 下按以下顺序尝试：

1. **PATH 环境变量**：如果编辑器命令已在系统 PATH 中，直接使用
2. **常见安装目录**：检测各编辑器的标准安装路径
3. **Windows 注册表**：扫描已安装应用的注册表信息

检测到的编辑器会自动启用，你也可以手动添加或修改路径，或禁用不使用的编辑器。

### 使用方式

编辑器配置好后，在以下位置可以看到编辑器入口：

- **项目右键菜单** → 用编辑器打开项目
- **文件右键菜单** → 在编辑器中打开文件

## Skills 管理

Skills 页面支持查看全局 Skill、创建模板、启用或禁用、删除和打开目录。删除操作会使用应用内确认弹窗，避免误删。
