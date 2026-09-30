# 受管 Chrome Profile 与单 Agent Demo 技术设计

日期：2026-09-27。状态：已实施；具体证据和实现差异见实施任务。场景假设见 [计划入口](./README.md)。

## Profile 管理

### 新的生命周期层先生成可用端点再进入现有工作区流程

依据用户的新方向，增加持久 Profile、运行实例和 Profile Manager。首选实验保留现有扩展与原生 Tab Group，通过受支持的扩展安装接口自动引导；普通 Chrome 与 Chrome for Testing 都需按所选固定版本验证，不能将 `--load-extension` 的限制视为所有安装方式都不可用。Profile、实例、端点、workspace 和 tab 分别记录关系。设计细节与待验证条件见 [Profile 管理提案](../../90-Proposals/MCP-Managed-Chrome-Profiles.md)。

候选工具为 `list_browser_profiles`、`create_browser_profile`、`open_browser_profile`、`stop_browser_profile`，按新 MCP 契约版本增加工具和票据结果。列表默认枚举持久目录中打开及关闭的可见 Profile。创建把目录准备、启动、扩展安装/加载、认证和就绪核对组合为一个公开请求；打开对已有 Profile 执行确保就绪流程。现有 workspace 请求不暗中创建 Profile 或启动浏览器。

新增内部逻辑类型草案如下；公开 schema 另行定义。路径、PID、进程创建时间、bootstrap 凭据存储在内部记录中，不作为 Agent 定位参数。

```typescript
export interface ManagedProfile {
  profileRef: string;
  displayName: string;
  ownerPrincipalId: string;
  dataDirKey: string;
  runtimeRef: string;
  endpointRef: string | null;
  identityPublicKeyHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedBrowserInstance {
  instanceRef: string;
  profileRef: string;
  browserState: 'starting' | 'running' | 'stopping' | 'stopped' | 'unknown';
  extensionState: 'unknown' | 'missing' | 'connecting' | 'connected' | 'disconnected';
  inventoryReconciled: boolean;
  generation: number;
  pid: number | null;
  processCreatedAt: string | null;
  observedAt: string;
  problemCode: string | null;
}

export interface ProfileManagementAuthority {
  principalId: string;
  sessionRef: string;
  scopes: readonly string[];
}

export interface ManagedBootstrapGrant {
  grantRef: string;
  profileRef: string;
  instanceRef: string;
  generation: number;
  secretHash: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface ManagedConnectionClaim {
  instanceRef: string;
  generation: number;
  bootstrap?: { grantRef: string; secret: string };
}

export interface ProfileRequestAuthority {
  requestRef: string;
  profileRef: string;
  principalId: string;
}

export interface ManagedChromeRuntime {
  runtimeRef: string;
  executablePath: string;
  browserVersion: string;
  extensionVersion: string;
  extensionDigest: string;
}
```

`ready` 从已核验的浏览器运行、扩展认证和 inventory 事实推导。列表以 Profile 持久记录为基础关联实例观测，不能从在线 socket 列表反推 Profile 全集。Broker 重启时先返回需要核对的状态，再通过进程及握手更新事实。

启动成功需要实例身份、扩展认证和新鲜 inventory 三者成立；同一 Profile 同时启动必须幂等返回已有启动票据/实例或明确拒绝，不能启动两个实例。单次受管启动的凭据必须与该 Profile、启动代次和扩展身份精确关联，不能靠“下一个连接进来的扩展”决定归属。

建议受管目录为空目录，扩展资源来源于构建产物，每个实例的 bootstrap 配置单独生成；不复制用户已配对的扩展存储。创建过程中失败时，报告已分配的 `profile_ref` 和失败阶段，保留可恢复记录；后续打开继续处理同一资源。停止先收尾本轮 workspace，再正常关闭本产品拥有的进程并确认落盘，保留 Profile 以便新会话有权复用。

## MCP 契约

### 四个生命周期工具使用持久引用并共享现有票据查询入口

以下为拟议 v2 输入；不直接覆盖现有规范 schema。工具参数不能包含任意磁盘路径、PID、扩展 ID、启动参数或调用主体 ID。

```typescript
export interface ListBrowserProfilesInput {
  cursor?: string;
  limit?: number;
}

export interface CreateBrowserProfileInput {
  display_name: string;
  idempotency_key: string;
}

export interface OpenBrowserProfileInput {
  profile_ref: string;
}

export interface StopBrowserProfileInput {
  profile_ref: string;
}

export interface BrowserProfileFacts {
  profile_ref: string;
  display_name: string;
  instance_ref: string | null;
  browser_state: ManagedBrowserInstance['browserState'];
  extension_state: ManagedBrowserInstance['extensionState'];
  ready: boolean;
  automation_paused: boolean | null;
  endpoint_nickname: string | null;
  observed_at: string;
  problem_code: string | null;
}
```

列表是同步只读查询，默认所有运行状态，分页与权限过滤先于结果输出。三个写工具复用 `accepted -> get_browser_request -> terminal`。创建接受时在同一数据库事务中预留 Profile 引用、请求与幂等映射；此时尚不创建目录或启动进程。扩展结果、实例引用、阶段和可恢复错误写入新票据结果分支。创建/打开终态成功必须满足 `ready`，停止成功必须确认实例退出；连接断开本身不能证明停止成功。

创建幂等键只用于去重，不是请求身份或资源引用。按持久主体与键唯一约束；相同参数重试返回原操作与 Profile，不同参数返回冲突。原票据已关闭时返回已用键及 Profile 引用，调用者改用打开工具。并发打开由每 Profile 操作锁合并或返回现有操作引用；同一 Profile 的启动与停止串行，跨 Profile 可同时推进。首版运行时上限配置为至少支持三个并发启动，限制排队长度和启动超时。

### 持久管理权来自认证主体并与工作区会话所有权分开

当前 `apps/broker/src/mcp/auth.ts` 已得到持久 principal，但 `CallerEvidence` 只传运行时会话信息。实现应从已验证的 `AuthInfo.clientId/scopes` 显式构造管理上下文，不能解析会话字符串或接受模型提供的 owner。Profile 归属于创建者 principal；同一 principal 的新会话可列出和打开，其他 principal 默认不可见且不能控制。共享与转让首版不做。

新增 `profiles:read`、`profiles:manage` scope；安装配置明确赋予需要管理能力的本机 Agent。旧 token 不因持有 `browser:write` 自动得到进程关闭权限。Profile 操作票据通过关联记录保存 `principalId` 和 `profileRef`，并扩展权限判断分支；原工作区票据继续按 requester/owner session 与 lineage 判断。`get_browser_request` 和关闭票据都必须按票据种类检查相应权限。

执行审查后采用 `profile_requests` 关联表保存上述管理权限字段，避免为本功能重建现有 `request_tickets` 及其外键依赖。原票据仍记录 requester session 供审计；凡存在 Profile 关联，授权必须先走 principal/scope 分支，拒绝后不能退回 requester/owner 判断。请求列表、分页、查询、关闭和恢复都使用相同规则；现有网页 CDP 人工裁决不能直接重启 Profile 生命周期请求。

停止先在 Profile 操作锁内建立停止屏障，禁止新的工作区准入，再核对是否仍存在活跃工作区或在途操作。存在则返回具体阻塞引用并解除屏障，不自动越权终止；无阻塞才正常关闭实例。首版无强制关闭参数。`kill_browser_endpoint` 仍是暂停自动化。管理器进程结束、切换功能开关也不隐含用户授权停止所有浏览器。

### Broker 与适配器共同采用 v2 并在不匹配时拒绝执行

建议协调升级而不维护两套长期并行的公开工具目录：新 catalog 18 个工具，`contract_version: '2'`，原十四工具的输入和业务语义保持。同步更新 canonical JSON schema、validators、presenter、HTTP gateway、stdio adapter 和目录断言。新增工具不能只改 gateway，因为适配器注册目录和输出验证目前都来自共享静态 schema。

新适配器在连接前检查 health 的 `mcpContractVersion`，且所有 `/mcp` 请求附带拟议 `x-octopus-contract-version: 2`。新 Broker 对缺少或不支持版本的认证请求返回明确的 `MCP_CONTRACT_VERSION_UNSUPPORTED`，不签发票据、不调度。旧适配器不发送该头，因此会被明确拒绝并提示升级；新适配器连接旧 Broker 也在注册本地工具前失败。该头是应用契约版本，不取代 MCP 自身的协议协商。

旧 Profile 功能尚不存在，迁移不需编造历史 Profile；旧端点、工作区和票据原样保留。v2 presenter 读取旧十四工具的持久事实并输出当前契约，需兼容性测试证明，不能直接把旧票据 JSON 强转成新工具结果。

### 实施默认值与错误分支在接入 MCP 前固定下来

以下是本计划的实现默认值，进入正式契约/运行配置时同步校验，不代表当前产品已有这些参数。

| 项目 | 建议默认值或规则 | 验证方式 |
| --- | --- | --- |
| display_name | trim 后 1–80 个 UTF-16 code units；允许重名 | 空白、边界、超长、同名不同引用 |
| idempotency_key | 8–128 个 ASCII 字符，仅字母、数字及 `._:-` | 非法字符、超长、同键同参/异参 |
| list limit | 默认 50，范围 1–100；以 createdAt/profileRef 稳定排序 | 分页无重复、跨主体游标拒绝 |
| 启动并发 | 默认 3；每 Profile 同时最多一个生命周期操作 | 三路同时推进、同 Profile 无双实例 |
| 待调度容量 | 默认 32 个去重后操作；超限在预留资源前拒绝 | 满队列下无新目录、Profile 或票据 |
| 打开总时限 | 默认 120 秒，含安装/认证/inventory；排队另有 120 秒上限 | 超时有明确阶段与保留资源 |
| 正常关闭时限 | 默认 30 秒，超时不强杀 | 已断连但进程未退出不得成功 |
| grant | 32 字节随机秘密，TTL 300 秒，一次初始化消费 | 重放、过期、同实例合法重连 |
| 锁和 claim | 优先复用现有 worker lease 配置，续租间隔不大于租期的三分之一 | 时钟推进/失租后无迟到副作用 |
| summary 延迟 | A/B/C 初始 45/90/60 秒，run 开始前固定 | 以真实事件计算重叠 |

错误分支至少区分：`PROFILE_NOT_FOUND`（也用于不可见资源）、`PROFILE_ACCESS_DENIED`（可见但无管理权）、`PROFILE_IDEMPOTENCY_CONFLICT`、`PROFILE_QUEUE_FULL`、`PROFILE_IN_USE`、`PROFILE_INSTANCE_UNVERIFIED`、`PROFILE_START_TIMEOUT`、`PROFILE_STOP_TIMEOUT`、`MANAGED_RUNTIME_UNAVAILABLE`、`MANAGED_EXTENSION_UNAVAILABLE`、`MANAGED_BOOTSTRAP_REJECTED`、`PROFILE_IDENTITY_MISMATCH` 与 `MCP_CONTRACT_VERSION_UNSUPPORTED`。接入 schema 时合并到统一错误定义，不能散落为未验证的任意字符串。每个失败须保留已知阶段/资源事实及是否可重试；不得把 unknown 当作 stopped。

查询需要 `profiles:read`，创建/打开/停止还需 `profiles:manage`；读取或关闭 Profile 操作票据同时核对其持久主体与相应 scope。公开 `automation_paused` 为未知时取 null；不可把未知转换成可执行。版本不匹配在认证成功后返回明确 HTTP 409 错误，未认证仍为 401，避免未认证请求触及 Profile 权限或分配逻辑。

## 持久化

### Profile 目录与实例观测分别存储且不从在线连接倒推资源

推荐新增 `managed_profiles`、`managed_browser_instances`、`managed_bootstrap_grants`、创建幂等映射、Profile 操作队列和 `profile_requests` 关联表。现有请求表的 `authority_scope` CHECK 仅允许 owner/requester，首版不修改该 CHECK、不重建被多个表引用的请求表。新增关联表承载 Profile 权限与队列扩展，应用层据此选择新的授权路径。迁移候选为 `apps/broker/src/storage/sqlite/migrations/006-managed-profiles.sql`，执行前再次检查编号。

Profile 表保存不可变目录键、运行时选择、主体和已认证端点关联。实例表保存启动代次、PID、进程创建时间、已校验可执行路径与数据目录、私有管理连接定位及观测时间。同一 Profile 至多一个未结束实例，数据库约束与进程内锁同时防重复。目录从安装配置的数据根和 Broker 生成的键推导；display name 不参与拼接路径，最终解析路径必须留在受管根内。

持久布局建议为 `<managed-root>/profiles/<profile-key>/user-data/` 与同级 `extension/`。受管扩展目录保持稳定绝对路径和 manifest key，避免发布目录变化导致扩展丢失或身份变化。新版本只在实例停止后原子更新扩展文件；不复制或重置 `user-data`。grant 的明文只短暂存在于受当前操作系统账户保护的本地引导文件，数据库只存哈希，日志和 Agent 输出均脱敏。

### Broker 重启必须重新核对实例且不能盲目重复执行启动

恢复顺序：读取持久 Profile 与未结束实例 -> 标记观测待核对 -> 验证进程身份和目录锁 -> 恢复扩展连接 -> 对齐认证代次和 inventory -> 更新可用性。PID、启动时间、可执行路径、数据目录任一不一致，禁止复用或关闭该 PID。只有足够证据证明进程退出才报告 stopped；证据不足保留 unknown 和原因。

对创建目录、启动进程、加载扩展、认证、停止各边界记录 checkpoint。崩溃后先探测实际效果，再决定继续、失败或 uncertain，不能重放一次 spawn。当进程已启动但尚未写入 PID 时，利用启动前记录的唯一目录和启动标识核对；不能可靠恢复时保留占用状态并拒绝再次启动。迟到的旧代次连接不能覆盖新实例。MCP 接受回复交付失败时，不应出现目录或浏览器副作用；已预留记录保持可识别的失败状态。

生命周期 worker 同时持有请求 claim 和 Profile 操作锁，长启动期间必须续租。每次外部副作用前及写回结果时校验两者代次；失去任一锁就停止推进，迟到回调不能覆盖后继操作。操作锁过期不证明浏览器已退出，接手者仍必须检查进程与目录锁。首次未被 Agent 接收到的 accepted 可能已交付给 stdio 适配器，创建幂等键用于覆盖这个现有传输窗口。

## 自动引导

### Chrome Launcher 只管理受管实例并把扩展安装与页面控制分开

建议封装少量 browser-level CDP 操作：安装/检查扩展、核对实例、正常关闭；业务页面不经该连接自动化。阶段 0 比较固定版本的普通 Chrome 与 Chrome for Testing，首版只承诺实测通过的一种版本组合。可选用固定版本 `puppeteer-core` 封装安装接口，浏览器可执行文件由安装配置明确指定；不要在每次创建 Profile 时临时下载浏览器。

首选实验使用仅 loopback 的随机调试端口，便于 Broker 重启后重新连接；端点只内部保存且与进程身份联合校验。浏览器仍有私有调试监听，不能宣称断开客户端后端口也消失。若所选版本只能使用 pipe，必须额外证明管理进程丢失后的恢复与停止路径，不能默认匿名 pipe 能被新 Broker 接续。Puppeteer 的退出清理也须实测；如封装无法满足浏览器独立存活要求，Launcher 自行持有进程生命周期并只复用安装接口。

安装连接不得抢占现有 `chrome.debugger` 的页面 attachment；实验必须验证安装连接在场、断开和重新连接三种情况下业务调用均可用。正常关闭只针对已经重新验证归属的实例；超时返回关闭失败/未知，不回退到按名称批量杀 Chrome。

### 受管扩展必须先领取本次启动凭据再完成身份绑定

推荐为受管扩展资源生成本地 bootstrap 配置，保持现有 manifest key。`managed-bootstrap.ts` 在 service worker 建立业务连接前读取配置；已有人工安装扩展无此配置，保持现有入口。受管配置缺失或失效时不自行退化成外部端点注册。每个新 Profile 自行生成现有 ECDSA 身份，重开继续使用同一私钥。

在 relay-v2 的 HELLO 中增加可选的受管引导字段，引用一次性 grant；Broker 先核验到期时间、实例、启动代次和凭据，再进行现有 challenge/AUTH。只有公钥持有证明成功，才原子消耗 grant 并将 Profile 与 endpoint、公钥哈希绑定。失败、过期、重复使用、不同公钥或旧启动代次必须拒绝。已建立连接的网络重连复用经过认证的映射；新浏览器实例领取新的 grant，不靠昵称或连接到达顺序绑定。

service worker 重启同样属于当前实例重连：已绑定身份通过正常签名认证重新接入，不重复消费初始化 grant；Broker 必须重新确认实例仍在。已消费的引导文件不能被当成新实例授权。旧 Broker 不支持新增字段时，新受管引导明确失败；普通扩展与新 Broker 的兼容不等于新受管扩展也兼容旧 Broker。

具体采用 `ManagedConnectionClaim`：受管 HELLO 总是携带 instanceRef/generation，只有首次认证附带 bootstrap。重连必须同时匹配持久公钥、当前实例和已核验进程；已知受管端点省略受管声明时拒绝接入。扩展本地标记和 bootstrap 文件中的代次发生变化，说明是新启动，必须重新领取 grant；所有 onInstalled/onStartup/alarm/初始连接入口共用一次初始化，避免服务 worker 事件竞争。bootstrap 的 native relay URL 在首次 connect 前写入，不能先误连默认 7332 再切换。

首次注册时为现有 endpoint nickname 规则生成可用标识并处理碰撞，不把任意 display name 塞进现有 pairing code 格式。保存身份的既有 Profile 与数据库公钥不符时返回身份冲突，不能自动替换。Native host 若仅透明转发既有 envelope，无需增加它对 Profile 的管理职责，但需集成测试确认消息大小与转发兼容。

### 就绪结果需要进程、认证连接和可用窗口共同成立

`ready` 条件为：正确实例运行、预期扩展版本及能力通过、认证端点与当前 Profile/代次匹配、新鲜 inventory 至少含一个可用窗口。连接存在但缺少标签组或 debugger 能力不能算完成。无可用窗口时由 Launcher 的启动策略确保正常窗口存在，随后重新观测；不预先为 Agent 创建工作区。

`ready` 表示 Profile 接入链路就绪；执行权仍由当前 endpoint/workspace 控制状态决定，打开操作不能清除已有暂停。公开结果必须同时提供执行暂停事实或对应动作限制，避免把就绪误读为已经获得工作区权限。

打开运行但未连接的 Profile 先等待和修复原实例；不自动开第二个，不覆盖身份。修复需要重装/重载扩展时先确认没有活跃工作区，否则返回阻塞。自动重试有时限；失败保留 profile_ref、阶段、实际运行状态和建议下一动作。

## 基础

### 多端点申请已经具备而单 Agent 演示仍需独立证据

`request_browser_workspace` 接受 `required_workspace_count: 3` 和三个实际发现的 `designated_endpoints`。每个端点只计一次；容量不足或指定端点不可用会在签发票据前拒绝。执行中失败则保留并报告已经创建的工作区，演示不能将此展示为成功或无条件重新申请整组。

`tests/e2e/multi-agent-multi-extension.test.ts` 当前创建三个客户端和三个模拟扩展。新增测试需使用一个客户端和一个会话。`tests/real-world/fixture-server.ts` 的现有标记页可保留用于原测试；`navigate-fixtures.ts` 使用旧工具，不能直接作为本 Demo 驱动器。

## 数据流

### 单一 Agent 通过现有链路分别操作三个浏览器

```text
一条自然语言指令
        |
一个 Agent 会话 -- 一个 stdio MCP 适配器
        |
Profile MCP -- Profile Manager -- 三个持久目录与受管浏览器实例
        |                         自动加载扩展、认证、核对 inventory
        |
现有 Broker：三个工作区、逐请求票据、逐标签页排序
        |
        +-- Native Messaging -- 扩展 A -- Chrome profile A -- 账户 A
        +-- Native Messaging -- 扩展 B -- Chrome profile B -- 账户 B
        +-- Native Messaging -- 扩展 C -- Chrome profile C -- 账户 C
                                                              |
                                  同一演示站 /workspace 与隔离账户数据
                                                              |
                                页面回读 + 票据证据 + 站点事件记录
                                                              |
                                             汇总与独立验收报告
```

## 组件

### 演示辅助组件准备和检查环境而不代替 Agent 完成任务

拟新增路径，均非现有实现：

```text
apps/broker/src/profiles/profile-manager.ts 管理持久 Profile 与启动停止事务
apps/broker/src/profiles/chrome-launcher.ts  Windows 运行时、锁、进程身份与正常关闭
apps/broker/src/profiles/profile-reconciler.ts Broker 重启与实例观测核对
apps/broker/src/profiles/bootstrap-grants.ts 一次性引导凭据与代次校验
apps/broker/src/profiles/runtime-config.ts   固定浏览器与扩展版本配置
apps/broker/src/profiles/types.ts            受管资源和管理上下文类型
apps/broker/src/storage/sqlite/profile-repository.ts Profile 与运行实例持久记录
apps/broker/src/storage/sqlite/migrations/006-managed-profiles.sql 候选迁移
apps/browser-extension/src/identity/managed-bootstrap.ts 启动关联与一次性引导
apps/mcp-stdio-adapter/src/demo-trace.ts      可选的真实 MCP 输入输出脱敏记录
tests/demo/types.ts                         演示配置和证据类型
tests/demo/fixture-server.ts                同源账户、待办表单、摘要任务、事件记录
tests/demo/fixture-server.test.ts           账户隔离和写入结果测试
tests/demo/evidence-verifier.ts             证据一致性校验，无 MCP 写操作
tests/demo/evidence-verifier.test.ts        缺证、串账户、重复写入的反例
tests/demo/README.md                        环境准备、提示词和演示步骤
tests/helpers/simulated-v2-extension.ts     从现有 E2E 提取的测试扩展
tests/e2e/single-agent-multi-extension.test.ts 单客户端三端点测试
tools/prepare-single-agent-demo.ts          启动站点并生成演示配置
tools/verify-single-agent-demo.ts           对保存证据做离线核验
tools/probe-managed-chrome.ts               单 Profile 自动加载扩展的真实实验
```

辅助输出位于 `artifacts/real-world/<run-id>/single-agent-demo/`，不包含令牌、Cookie、私钥或浏览器私有定位符。未来脚本应校验 run ID 和输出路径，避免复位操作超出该轮演示数据。

### 同源 Cookie 与服务端账户分区共同证明配置文件隔离

正式演示由 Agent 创建并启动三个 Profile，再通过演示站设置页建立三个虚构账户的独立会话。业务阶段三个浏览器打开同一 `/workspace` URL；账户由有有效期的持久 Cookie 解析，不能由查询参数指定。已登录页面不提供随意切换账户的捷径。

未建立会话时显示设置未完成，不能自动分配默认账户。三个 profile 若意外共享会话，预检因账户重复失败。待办写入必须绑定当前账户和本轮 run ID，错误账户不能修改其他账户的事项。

摘要生成提供确定、可配置的延迟，初始演示配置建议 A 45 秒、B 90 秒、C 60 秒。Agent 先完成三路事项与备注，再连续发起三个摘要，避免等待第一路结束后才提交下一路。正式 run 前冻结延迟配置；若模型调用延迟仍导致不重叠，则本轮如实失败，调参后使用新 run 重新验证，不能事后修改时间证据。站点不选择待办、不替 Agent 填备注、不伪造浏览器动作。重复生成返回同一 run/事项的已有任务，同时记录重复尝试。

### 同一会话先发起独立操作再轮询多个票据

Agent 先列出受管 Profile，再通过三次创建调用各自完成自动启动和连接，等待创建票据确认就绪，发现返回的三个端点及其可用窗口。已有 Profile 则使用打开工具确保就绪。工作区申请成功后，建立 `profile_ref`、端点昵称、账户、`workspace_ref`、`tab_ref` 的对应表。

对不同工作区，先提交各自的独立步骤，再交错查询 `get_browser_request`。对存在依赖的步骤，等待前置条件成立：例如导航命令成功后仍要读取页面就绪标记；写入前核对账户；提交后回读结果。无需等待 A 的整个业务流程结束才启动 B。

暂停是票据的 `pause_condition`，不是终态。处理 `succeeded`、`failed`、`uncertain`，并给轮询设置合理总时限及退避。结果不明确时不盲目重发写操作。若票据要求人工解决，保留证据并停止该路，其他独立路可以继续。

### 证据同时关联会话身份和真实页面结果

以下是建议的新 Demo 数据类型；不是 MCP 新协议。以 canonical 输出解析生成，不能让准备工具伪造会话或票据事实。实现时使用已有协议类型替代可复用字段。

```typescript
export interface DemoAssignment {
  profileRef: string;
  endpointNickname: string;
  expectedAccountLabel: string;
}

export interface DemoRunConfig {
  runId: string;
  baseUrl: string;
  fixtureDate: string;
  assignments: [] | [DemoAssignment, DemoAssignment, DemoAssignment];
}

export interface DemoEvidence {
  runId: string;
  sessionRef: string;
  profileResults: Array<{
    profileRef: string;
    endpointNickname: string;
    workspaceRef: string;
    tabRef: string;
    observedAccountLabel: string;
    taskId: string;
    observedNote: string;
    summaryId: string;
  }>;
  toolTracePath: string;
  fixtureEventsPath: string;
}
```

准备配置的 assignments 初始为空；Agent 创建后从真实结果补全三个分工，验收不接受空分工。保存原始 MCP 接受与轮询结果的脱敏记录，以及演示站的权威账户快照和事件时间；trace 包含 Profile 列表、创建自动连接、停止后的混合状态列表、再次打开和页面回读。建议在 stdio 适配器加入显式启用的演示 trace，不增加浏览器写操作。验收器从这些记录独立推导结论，不相信 Agent 自报的成功布尔值；实现时先验证实际运行环境能采集这些证据，拿不到则报告未验证。

## 边界

### 并发演示和断线恢复采用不同验收标准

首版证明一会话多配置、隔离和任务重叠，不承诺加速倍数。模拟测试可单独让某路 CDP 返回延迟，验证其他标签页继续执行；真实演示站任务重叠不等价于同一时刻发出了多条 CDP 命令。

可选第二阶段在 B 没有不明确写入的时点断开其扩展，观察 A/C 继续以及 B 恢复后的页面核对。若完整关闭浏览器导致原标签组消失，遵守现有替换工作区语义，不能要求旧引用永久不变。该阶段不属于首版完成门槛。

### 演示清理只处理本轮会话拥有的工作区

先保存页面结果和证据，再逐一 `terminate_workspace` 并轮询，随后停止当前会话有权管理的受管实例。终止失败保留暂停状态和引用供检查。完成 Bob 的重开验证后再收尾其新工作区。Profile 与登录数据保留；不清空 Broker 数据库，不按总端点数量猜测本轮归属，不终止外部浏览器或其他会话工作。
