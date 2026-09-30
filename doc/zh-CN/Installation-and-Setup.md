# 安装与设置

本指南帮助 Windows 用户从零完成 Tabro、浏览器扩展、自动配对、Codex/Hermes MCP 注册和基础验证。精确运行时边界以英文 [Real-World Runbook](../06-Files/Real-World-Runbook.md) 为准。

## 路径选择

### 普通用户使用 GitHub Release，开发者才需要源码构建

| 目标 | 选择 |
| --- | --- |
| 安装并使用已经发布的版本 | GitHub Release 更新器 |
| 修改 TypeScript、扩展或 Native Host | 源码安装 |
| 更新已经安装的 Release | 已安装目录中的 `update-local.ps1` |

两条路径不要混用同一个 Broker 端口同时启动。默认 MCP 端口为 `7331`，扩展 relay 端口为 `7332`。

## Release 安装

### 独立更新器会验证下载内容后再修改安装目录

先确认 Node.js：

```powershell
node --version
```

需要 `22.12.0` 或更高版本。然后执行：

```powershell
Invoke-WebRequest `
  https://github.com/ohmyskyhigh/tabro/releases/latest/download/octopus-browser-relay-update.ps1 `
  -OutFile .\octopus-browser-relay-update.ps1
pwsh -NoProfile -File .\octopus-browser-relay-update.ps1
```

更新器完成前会依次验证：

1. GitHub Release ZIP 的 SHA-256；
2. 包内 `release-manifest.json`；
3. 每个包内文件的相对路径、大小和 SHA-256；
4. Broker 启动后的健康状态和版本。

默认安装结构：

```text
%LOCALAPPDATA%\Octopus Browser Relay\
├── bootstrap\
│   ├── current-release.json
│   ├── broker-launcher.mjs
│   ├── mcp-stdio-adapter.mjs
│   ├── codex-mcp.toml
│   ├── hermes-mcp.txt
│   └── INSTALLATION.md
├── browser-extension\
├── data\
├── releases\0.3.0\
├── update-local.ps1
└── stop-installed-broker.ps1
```

### 更新器输出必须证明目标版本已经运行

最终 JSON 至少应满足：

```json
{
  "status": "UPDATED",
  "version": "0.3.0",
  "broker": {
    "health": {
      "status": "ok",
      "serviceVersion": "0.3.0"
    }
  }
}
```

保存 `extensionPath`。浏览器加载的是该目录，不是 Release ZIP。

## 扩展安装

### 每个浏览器配置文件安装同一个稳定目录但保留独立配置文件身份

在每个 Chrome、Chromium 或 AdsPower 配置文件中重复：

1. 打开 `chrome://extensions`。
2. 开启**开发者模式**。
3. 点击**加载已解压的扩展程序**。
4. 选择更新器返回的 `extensionPath`，默认是 `%LOCALAPPDATA%\Octopus Browser Relay\browser-extension`。
5. 确认扩展 ID 为 `caekiojlchhifdomfghejkbfpmaklafe`。
6. 点击扩展详情中的**扩展程序选项**。
7. 保持 **Native companion (recommended)**。
8. 等待状态变为 `connected`。

扩展会自动生成类似 `MINT-WAVE` 的两词配对代码和类似 `mintwave` 的短昵称，也允许在设置页把代码改成两个三至八字母的英文单词。保存的代码会在该浏览器配置文件中持续保留，无需把代码输入 Broker。已有端点改名必须先通过原配置文件密钥认证；昵称冲突会保留当前代码并显示错误，直到用户选择另一组词。

### 多配置文件验证以 Broker 的已连接端点数量为准

```powershell
Invoke-RestMethod http://127.0.0.1:7331/health | ConvertTo-Json -Depth 8
```

准备三个配置文件时，要求 `connectedEndpoints` 为 `3`。`endpointCount` 可能包含以前配对但当前离线的端点，因此不能替代 `connectedEndpoints`。

## Codex 配置

### Codex 配置使用生成的 TOML 而不复制本地令牌内容

打开：

```text
%LOCALAPPDATA%\Octopus Browser Relay\bootstrap\codex-mcp.toml
```

将整个 `[mcp_servers.tabro]` 区块合并到当前 Codex `config.toml`。不要把 `admin-token.txt` 的内容复制进配置、聊天或提交记录。保存后新建 Codex 会话，让 Codex 启动新的 stdio 适配器进程。

## Hermes 配置

### Hermes 配置命令会注册默认配置文件和所有已安装命名配置文件

运行以下文件中的命令：

```text
%LOCALAPPDATA%\Octopus Browser Relay\bootstrap\hermes-mcp.txt
```

该命令会发现 Hermes 默认配置文件以及当前已安装的所有命名配置文件，并为每个隔离配置文件分别注册同一个 Tabro MCP。然后为要使用的每个配置文件新建会话并执行：

```powershell
hermes -p <profile> mcp test tabro
```

通过条件是连接成功并发现 18 个工具。以后新建 Hermes 配置文件时，需要再次运行 `hermes-mcp.txt` 中的命令，再为该配置文件新建会话。

## 源码安装

### 源码路径会安装依赖、构建所有目标并生成开发配置交接文件

需要 Git、Node.js、pnpm 11、PowerShell、Visual Studio C++ Build Tools 和 Windows SDK：

```powershell
git clone https://github.com/ohmyskyhigh/tabro.git
Set-Location .\tabro
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pwsh -NoProfile -File .\tools\install-local.ps1 -Install -StartBroker
```

生成路径：

```text
.relay-data\bootstrap\PAIRING.md
.relay-data\bootstrap\MCP-REGISTRATION.md
.relay-data\bootstrap\codex-mcp.toml
.relay-data\bootstrap\hermes-mcp.txt
dist\browser-extension
dist\native-host\relay-native-host.exe
```

源码扩展应从 `dist\browser-extension` 加载。Release 扩展应从 `%LOCALAPPDATA%` 下的稳定目录加载。

### 源码预检会把未完成动作作为结构化 JSON 返回

```powershell
pwsh -NoProfile -File .\tools\real-world-preflight.ps1
```

`READY` 表示构建、注册、交接文件和健康入口已就绪。`ACTION_REQUIRED` 与退出码 `10` 表示仍有安装动作，不代表脚本崩溃。

## 更新

### 已安装更新器复用稳定扩展目录并保留 Broker 数据

```powershell
pwsh -NoProfile -File "$env:LOCALAPPDATA\Octopus Browser Relay\update-local.ps1"
```

更新期间：

1. 新版本先下载和验证；
2. 安装器拥有的旧 Broker 才会被停止；
3. 新版本放入新的版本目录；
4. 扩展稳定目录被同步；
5. Native Messaging 和 MCP 启动入口更新；
6. 新 Broker 启动并验证健康；
7. 已连接旧扩展收到一次重载请求并重新连接；
8. 失败时恢复之前的发布状态。

配对密钥和昵称保存在浏览器配置文件中；Broker 的端点、工作区、票据和审计状态保存在 `data` 中，两者不会因正常更新被重置。

## 停止

### 停止脚本必须匹配安装器记录的 PID 和绝对启动入口

Release 安装：

```powershell
pwsh -NoProfile -File "$env:LOCALAPPDATA\Octopus Browser Relay\stop-installed-broker.ps1"
```

源码安装：

```powershell
pwsh -NoProfile -File .\tools\stop-local-broker.ps1
```

不要使用按端口批量结束进程的命令。停止脚本拒绝停止命令行不匹配的进程。

## 故障排查

### Broker 健康但扩展离线时优先检查 Native Messaging 注册和扩展路径

- 确认 `7331/health` 与 `7332/health` 都可访问；
- 确认扩展仍从稳定目录加载；
- 确认扩展设置选择 **Native companion**；
- 重新运行更新器修复 Native Messaging manifest 和注册表；
- 扩展报告重复版本不匹配时，先修复文件，再重载一次。

### Broker 无法启动时先确认端口占用和 PID 文件对应关系

检查：

```powershell
Get-NetTCPConnection -LocalPort 7331,7332 -ErrorAction SilentlyContinue
```

如果端口属于另一个应用，应明确停止该应用或使用其他端口。不要让两个 Broker 共享同一 SQLite 数据目录。

### Agent 已连接但工具数量不正确时应检查 MCP 注册入口

Codex/Hermes 必须启动 `bootstrap\mcp-stdio-adapter.mjs`，连接 `http://127.0.0.1:7331/mcp`，并引用本地 token 文件。Hermes 的每个隔离配置文件都必须拥有自己的 MCP 注册；可以重新运行 `hermes-mcp.txt` 一次性修复当前所有配置文件。修改后创建新会话。正确结果是 18 个工具。

## 安全

### 安装和问题报告不得泄露本地认证及浏览器私有信息

不要提交或粘贴：

- `admin-token.txt` 内容；
- `.relay-data` 或 Release `data` 目录；
- SQLite 文件；
- 扩展私钥；
- Chrome 私有窗口/标签页 ID；
- 包含用户名或浏览器配置文件名的本机绝对路径截图。

Parent: [`中文文档`](./README.md).

## 受管 Chrome

### 启用受管 Profile 后不再需要逐个手工安装扩展

本地开发安装运行 `pwsh -NoProfile -File tools/install-local.ps1 -Install -EnableManagedProfiles`。从当前源码构建的离线发布包运行 `tools/update-local.ps1 -PackagePath <zip> -EnableManagedProfiles`。本功能尚未发布远程 Release；旧发布包不会因为添加参数而具备新能力。安装器要求 Chrome 153.0.8010.53，检查固定扩展身份并设置私有目录权限。一次性 Native host 注册完成后，Agent 用 MCP 创建/打开 Profile 即可自动连接。外部已有 Profile 保留原人工安装旅程。

生成的 `data/managed-profiles.json` 保存浏览器路径、版本、扩展摘要、受管根和 relay 地址。不要移动已建 Profile 的扩展目录。设置 `launchesEnabled: false` 并重启 Broker 可禁用 create/open，同时保留有权主体的 list/stop；不要删除配置或数据库来禁用功能。

### 升级和回退必须先完成工作并保留受管数据

新 updater 拒绝存在活跃工作区、未完成请求或未结束受管实例的升级。用 MCP 终止工作区、正常停止 Profile 后再升级。关闭 Broker 后再次检查，SQLite VACUUM INTO 生成一致性快照，配置与新 Profile 元数据保存在 `data/upgrade-backups/`。失败会恢复先前安装、配置和数据库快照。

真正降级到旧版前保留升级后的数据库及 Profile 元数据，恢复迁移前快照并使用旧版 Broker/adapter；旧版不会显示升级后新增的 Profile，但数据目录应保留。v0.3.0 → v2 → v0.3.0 的隔离实测见 `artifacts/real-world/profile-upgrade-probe-001/report.json`。不要直接拿旧二进制打开未知的新 schema，不回滚网站副作用。
