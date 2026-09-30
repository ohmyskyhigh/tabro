# 受管 Chrome Profile 与单 Agent Demo 实施任务

日期：2026-09-27。状态：实施完成。123 条实施 TODO 已登记；最终证据、内部组织差异和支持边界见 [实施结果](./implementation-report.md)。以下保留各任务原始设计与阶段验证意图，当前可执行入口以实施结果和 Demo 运行手册为准。全部命令从仓库根目录运行；模拟测试不能替代真实 Chrome 证据。

## 执行入口

### 实施以稳定 TODO 编号和真实执行证据逐项验收

每个 `Pxx-yy` 是稳定 TODO ID。完成一项后，将 `[ ]` 改为 `[x]`，并在该任务末尾记录实现路径、验证命令/结果和证据路径；仅编辑了文件不算通过测试。阶段门槛必须在本阶段的检查全部通过后勾选。失败项保持未勾选并记录具体阻塞，不绕过门槛，不把计划修改计作实现完成。

执行顺序：`0.0 → 0.1/G0 → 1.1 → 1.2/G1 → 2.1 → 2.2 → 2.3/G2 → 3.1 → 3.2/G3 → 4.1 → 4.2 → 4.3 → 4.4/G4`。G2 通过内部集成入口证明组件行为；G3 才要求公开 MCP 全链路，避免管理器实现反过来依赖尚未接入的工具。

每个新测试文件由所属任务创建，再执行该任务命令。任务 1.1 只形成契约草案；生产 canonical schema 由 3.1 与 catalog/presenter/adapter 成套切换。任务 0.1 自带最小持久状态测试页，不依赖 4.2 的演示站。物理浏览器实验走显式 CLI，不放进默认 `pnpm test`；`.test.ts` 覆盖确定的模拟/协议/故障行为，物理结果另存报告。

执行证据建议保存在 `artifacts/real-world/<run-id>/plan-execution/<todo-id>/`，包含脱敏命令记录、结果和必要的资源引用。每阶段完成后在文末状态表登记证据；运行时版本、传输方式及退出行为的未知项由 G0 实测锁定，不留给后续编码者猜测。

## 执行准备

### 任务 0.0 先记录现有改动和隔离环境再开始浏览器实验

文件：本任务清单、`tests/demo/README.md`（首次创建）、阶段证据；只读检查现有配置和代码，不复制 token 或用户浏览器数据进入报告。

方案：记录当前分支、提交与未提交文件，识别已有工作并保留。实验使用独立数据库、managed-root、run ID 和 loopback 端口。已有 Native host 可复用其 URL 转发能力；先核对实际注册，不无条件覆盖用户现有注册。Bootstrap/实验配置必须在扩展首次连接前指定实验 Broker 地址。

依赖：无。

交付物：可复用的环境清单、基线检查报告、独立资源边界和明确启动入口。

**执行 TODO**

- [x] `P00-01` 记录当前提交、分支、全部修改/未跟踪文件和本任务改动边界；保留现有未提交工作。
- [x] `P00-02` 记录 Node、pnpm、Windows、浏览器及 Native host 实际版本/路径；只记录 token 是否可用，不记录内容。
- [x] `P00-03` 为实验指定独立数据库、受管根和 run ID；分配空闲 loopback MCP/relay/fixture 端口并保存实际地址。
- [x] `P00-04` 核对 Native host 注册和固定扩展 ID；优先复用现有透明转发，不更改用户其他 Profile 的连接配置。
- [x] `P00-05` 在 tests/demo/README.md 写明实验启动、资源归属、退出和证据路径；新测试默认不得启动物理 Chrome。
- [x] `P00-06` 运行本任务基线命令并记录结果；区分原有失败和新增问题，明确 G0 所需前置是否满足。

验证：`git status --short`、`git diff --stat`、`node --version`、`pnpm --version`、`pnpm verify`。现有失败单独记录、判断是否阻塞本任务，不能清空未提交改动来取得通过。

## 可行性

### 任务 0.1 先证明空 Profile 能自动加载扩展并保留重开后的身份

文件：新增 `tools/probe-managed-chrome.ts`、`tests/helpers/managed-chrome-probe-fixture.ts`、`tests/real-world/managed-chrome-probe.test.ts`；更新 `tests/demo/README.md`；使用 `tools/build-extension.ts` 的构建结果。实验依赖如需新增库，在此固定版本并记录，不能等到 G0 之后才安装实验所需依赖。

方案：选定固定版本 Chrome，Chrome for Testing 可作为基线；通过受支持的 CDP 扩展安装接口或 Puppeteer 封装自动加载当前扩展。新 Profile 使用空数据目录，Native Messaging 注册作为一次性前置。实验从受控安装连接读取扩展公钥并与认证端点核对，不能用连接顺序猜测。验证原生 Tab Group、经现有 Broker/扩展的一次页面操作、持久 Cookie/localStorage、扩展身份和关闭重开。正式一次性 grant 与持久管理器在后续实现，实验不表示产品已完成。

依赖：任务 0.0、可用浏览器、扩展构建和 Native Messaging 配置；本次只规划，不下载或启动浏览器。

交付物：版本/参数清单、自动加载方法、安装连接与 `chrome.debugger` 共存证据、正常关闭和 Broker/启动器退出后的进程行为报告。由实验锁定浏览器、库版本、端口或 pipe 方案。

**执行 TODO**

- [x] `P01-01` 实现 probe CLI 参数/路径/端口验证、超时、退出码和 JSON 报告，拒绝复用不属于本轮的目录。
- [x] `P01-02` 准备固定版本运行时；需要实验依赖时锁版本，并记录可执行文件版本及扩展产物摘要。
- [x] `P01-03` 创建最小 probe fixture，提供持久 Cookie、localStorage 和 DOM 标记；不依赖后续三账户站点。
- [x] `P01-04` 生成临时实验扩展构建，仅覆写初始 relay URL，保持 manifest key 与业务实现；记录该配置差异，首次连接不能进入默认生产 Broker。
- [x] `P01-05` 用空目录启动可见 Chrome，自动安装/加载扩展；检查安装接口实际返回的固定扩展 ID。
- [x] `P01-06` 经 Native Messaging 观察认证，读取受控扩展的公钥并精确对应端点；不得复制私钥或凭据到报告。
- [x] `P01-07` 使用当前十四工具申请工作区、核对真实 Tab Group，并通过扩展 send_cdp_command 读写测试页状态。
- [x] `P01-08` 验证安装管理连接存在、断开、重新连接三种场景，确认没有破坏扩展 debugger attachment。
- [x] `P01-09` 正常关闭并重开同一目录，核对持久 Cookie/localStorage、公钥、端点身份；分别验证启动器退出和 Broker 重启行为。
- [x] `P01-10` 实现本任务故障测试并执行 probe；报告每项 passed/failed/unverified、真实进程清理结果和固定技术组合，全部必要项通过才勾 G0。

验证：`pnpm exec tsx tools/probe-managed-chrome.ts --run-id=managed-profile-probe`；`pnpm exec vitest run tests/real-world/managed-chrome-probe.test.ts`。反例覆盖扩展目录缺失、Native host 未注册、目录占用、安装超时、启动者中断、身份不匹配。安装连接断开及重连后均验证扩展业务。禁止结束用户已有 Chrome。

门槛 G0：新目录到可用端点全自动完成，真实标签组和扩展页面操作成功，重开后数据和身份保持。失败则解决该实验，不展开完整 Demo 实现。

G0 实测额外修复：扩展在 ACK 前因库存变化拒绝时，以同一 attempt ID 最多刷新重试两次，ACK 后错误不重试；Broker shutdown 停止 recovery pump 并等待 worker 完成后关闭 SQLite。`tests/integration/websocket-gateway.test.ts` 与 `tests/integration/broker-shutdown.test.ts` 有回归证据。实验失败报告与目录保留，未改写为成功。生成的 Chrome/扩展文件加入 ESLint 的 artifact 排除范围。

## 资源与契约

### 任务 1.1 将确认的用户旅程逐层映射到新版契约设计

文件：本计划、`doc/90-Proposals/MCP-Managed-Chrome-Profiles.md`；后续正式应用规范时涉及 `doc/01-Product/Product-Definition.md`、`doc/02-User-Experience/User-Experience-Definition.md`、`doc/02-User-Experience/Operational-Defaults.md`、`doc/03-User-Interface/MCP-Contract.md`、`doc/03-User-Interface/MCP-Contract.schema.json`、`doc/04-System/System-Architecture.md`、`doc/05-Components/Component-Architecture.md`、`doc/06-Files/Repository-Map.md` 及对应索引和 changelog。

方案：本任务在计划/提案中定稿接口与规范变更清单，生产规范的成套应用留到任务 3.1，避免运行时代码直接导入 canonical JSON schema 时出现阶段性失配。按技术设计明确管理主体、幂等键、就绪结果、停止屏障和版本，准备 Product → Files 追踪。准备修订整体调试连接表述，准确区分管理器生命周期连接与扩展页面执行；首版支持 Windows、一个验证版本和独立数据目录。

依赖：已确认目标流程；G0 为技术路线提供证据。契约 v2、scope 等仍是本方案建议，不冒充已批准规范。

交付物：输入/输出、状态矩阵、错误与恢复动作、旧适配器升级说明、Product 到 Files 的一致追踪。

**执行 TODO**

- [x] `P11-01` 定稿四个工具的严格输入、同步/异步输出、状态枚举、引用格式及失败结果；区分连接就绪与自动化暂停。
- [x] `P11-02` 给 create 定义持久主体范围的幂等键；明确同键不同参数、已关闭票据、部分创建失败及新会话重试的返回行为。
- [x] `P11-03` 定义 display_name 长度、分页上限、队列容量、启动/关闭超时、grant 过期及并发数，写入技术设计的建议默认值。
- [x] `P11-04` 列出 Profile principal/scope 与 workspace session/lineage 的权限矩阵，含列表、打开、停止、查询/关闭请求和越权反例。
- [x] `P11-05` 定稿原子停止屏障、活跃工作区/请求阻塞和失联实例处理；明确不把暂停端点等同于停止进程。
- [x] `P11-06` 在提案准备 Product→UX→UI→System→Components→Files 的具体变更清单及 v1→v2 升级矩阵，注明 3.1 成套应用。
- [x] `P11-07` 执行本任务检查，确保生产 v1 schema/catalog 仍一致；将草案输入/输出样例交给 3.1 的实际 wire 测试。

验证：`pnpm exec vitest run tests/contract/public-documentation.test.ts tests/contract/mcp-contract-v1.test.ts` 确认此阶段现有契约仍有效；`rg -n 'remote-debugging|fourteen|十四|contract_version' doc/01-Product doc/02-User-Experience doc/03-User-Interface doc/04-System` 定位后续成套更新范围。v2 测试在任务 3.1 创建执行，不依赖尚未创建的文件。

### 任务 1.2 持久保存 Profile 和管理主体并保持旧数据库可读

文件：新增 `apps/broker/src/storage/sqlite/profile-repository.ts`、`apps/broker/src/storage/sqlite/migrations/006-managed-profiles.sql`、`tests/integration/profile-repository.test.ts`；调整 `apps/broker/src/storage/repositories.ts`、`apps/broker/src/storage/sqlite/database.ts`、`apps/broker/src/storage/sqlite/request-repository.ts`、`apps/broker/src/storage/index.ts`、`apps/broker/src/mcp/caller-evidence.ts`。

方案：新增 Profile、实例、grant、幂等映射、操作锁及 `profile_requests` 关联表。保留现有请求表 owner/requester CHECK，通过关联表和新的授权分支承载持久管理权，避免重建请求表及其外键。先检查迁移编号。直接使用认证 principal，保留 session/lineage；原有端点不自动变成受管 Profile。目录使用不可变键，权限过滤先于分页。

依赖：任务 1.1。

交付物：关闭仍可见的目录、稳定管理权、唯一实例约束、迁移与恢复查询。创建票据与 Profile 预留原子提交，目录/进程副作用留到确认交付之后。

**执行 TODO**

- [x] `P12-01` 复核迁移序号和现有数据库表结构，使用可重复的 v0.3 脱敏数据库 fixture，不修改已有 migration。
- [x] `P12-02` 创建 Profile 表及 immutable dataDirKey/runtime/principal 约束，端点映射允许首次认证前为空。
- [x] `P12-03` 创建实例表和每 Profile 至多一个未结束实例的唯一约束，保留进程身份、代次和观测事实。
- [x] `P12-04` 创建 grant 哈希/期限/消费记录、主体范围创建幂等表和 Profile 操作队列/锁表。
- [x] `P12-05` 创建 profile_requests 关联表，关联真实 ticket/profile/principal；保留原请求表 CHECK 与所有历史外键。
- [x] `P12-06` 实现原子预留 Profile、ticket 与幂等记录；参数冲突回滚，接受失败仍可发现预留资源，不能已启动进程。
- [x] `P12-07` 实现主体过滤后的稳定游标分页和可见记录查询；游标绑定查询主体/范围，不能枚举其他主体。
- [x] `P12-08` 从已认证 AuthInfo 显式构造管理上下文；实现 scope 更新/读取所需 repository 接口，拒绝模型提供 principal。
- [x] `P12-09` 装配 repository 导出及数据库初始化，新增引用的类型/factory 支持与实际使用处同步，保持 typecheck。
- [x] `P12-10` 实现迁移重复执行、回滚中断、外键完整性及原票据/端点/工作区逐项保留测试。
- [x] `P12-11` 测试同键并发、唯一实例、跨主体分页、目录键冲突与不可写数据库；运行本任务检查并记录 G1 证据。

验证：`pnpm exec vitest run tests/integration/profile-repository.test.ts tests/integration/sqlite-workspace-store.test.ts`；`pnpm typecheck`。反例包括同幂等键并发创建、同键不同参数、同名不同 Profile、跨主体访问、分页泄露、事务中断、磁盘不可写、重复迁移、v0.3 数据升级。旧票据/端点/工作区事实必须保持，旧端点不能被赋予进程管理权。

门槛 G1：契约边界清楚；目录、权限和迁移通过。阶段内不需要启动浏览器。

## 浏览器运行时

### 任务 2.1 启动器能够识别复用和正常关闭唯一受管实例

文件：新增 `apps/broker/src/profiles/chrome-launcher.ts`、`apps/broker/src/profiles/runtime-config.ts`、`tests/unit/chrome-launcher.test.ts`；调整 `apps/broker/src/runtime/config.ts`、`package.json`、`pnpm-lock.yaml`。若正式 Launcher 使用 G0 的试验库，将必要依赖列入生产依赖并核对发布打包。

方案：按 G0 锁定的方法启动可见 Chrome，使用独立数据目录、稳定扩展目录和私有管理连接。记录 PID、创建时间、可执行路径、数据目录及启动标识。运行时在安装时准备，创建请求不下载。重新连接前校验归属，正常停止等待实际退出；处理库的自动退出清理，避免 Broker 重启隐式关闭 Chrome。

依赖：G0、任务 1.2。

交付物：可测试的 launch/inspect/close 接口、受管路径校验和超时结果，无按进程名关闭或任意用户路径入口。

**执行 TODO**

- [x] `P21-01` 把 G0 通过的浏览器/传输组合固化为 RuntimeConfig，验证版本、扩展摘要、可执行文件与当前平台。
- [x] `P21-02` 创建稳定 user-data/extension 布局，使用受管根下的随机键；验证最终路径、Windows 大小写及 junction/reparse 逃逸。
- [x] `P21-03` 实现启动前持久标识和目录互斥，禁止第二个进程把启动转发给未知的既有实例。
- [x] `P21-04` 启动可见窗口并记录 PID、创建时间、执行路径、数据目录和私有调试定位；仅接受 loopback 连接。
- [x] `P21-05` 实现 inspect/reconnect，核对完整进程身份；过期 DevToolsActivePort 文件不得单独证明实例归属。
- [x] `P21-06` 限制管理连接可做的操作为引导、空窗口准备、状态核对和正常关闭，业务页面继续走扩展。
- [x] `P21-07` 实现正常 close、退出等待和有界超时；无法证明退出时保留 unknown/错误，不批量结束 Chrome。
- [x] `P21-08` 验证 Broker/库对象退出不会隐式杀死所有受管浏览器；配置或替换存在该行为的进程封装。
- [x] `P21-09` 处理缺少普通窗口的打开路径：在正确实例准备空窗口并重新核对，失败返回明确原因，不新建第二个实例。
- [x] `P21-10` 实现本任务单元故障用例、运行检查，再通过正式 Launcher 重跑 G0 物理实验。

验证：`pnpm exec vitest run tests/unit/chrome-launcher.test.ts`；重跑 G0 实验但改用正式 Launcher。覆盖 PID 重用、同目录外部进程、Windows 单实例转发、空格路径、目录越界/链接逃逸、无写权限、启动即退出、关闭超时和启动者意外退出。无法检查进程不得断言已关闭。

### 任务 2.2 受管扩展用一次性凭据绑定正确 Profile 与启动代次

文件：新增 `apps/broker/src/profiles/bootstrap-grants.ts`、`apps/browser-extension/src/identity/managed-bootstrap.ts`、`tests/unit/managed-bootstrap.test.ts`；调整 `apps/browser-extension/src/service-worker.ts`、`apps/browser-extension/src/config.ts`、`apps/browser-extension/src/identity/device-identity.ts`、`apps/browser-extension/src/transport/websocket-client.ts`、`apps/broker/src/extension-relay/websocket-server.ts`、`apps/shared/protocol/src/relay/v2-messages.ts`、`tests/contract/relay-v2.test.ts`、`tests/integration/websocket-gateway.test.ts`。

方案：受管扩展连接前加载私有 bootstrap 配置，在 HELLO 中提交可选 grant 信息；Broker 校验后走 challenge/AUTH，公钥证明成功才消耗凭据并绑定实例。新 Profile 独立生成密钥；重开复用，网络重连沿用已认证实例映射。普通扩展不带新字段时保留现有流程。稳定 manifest key 和扩展路径，Native host 继续透明转发。

依赖：任务 1.2、2.1。

交付物：Profile → instance → authenticated endpoint 关联、独立身份、引导错误与能力检查。

**执行 TODO**

- [x] `P22-01` 创建具有足够随机性的短期 grant；数据库只保存哈希，绑定 profile/instance/generation，支持原子消费。
- [x] `P22-02` 原子写入当前 Profile 的 bootstrap 配置，包含实例、代次、实验/正式 relay URL；限制本地访问并清理已消费秘密。
- [x] `P22-03` 在扩展首次 connect 前完成 bootstrap/settings 初始化；onInstalled/onStartup/alarm/初始入口复用同一初始化任务。
- [x] `P22-04` 在 HELLO schema 增加可选 ManagedConnectionClaim；首次包含 grant，重连始终带实例和代次。
- [x] `P22-05` 在 Broker 先校验 grant 与受管进程，再完成公钥签名认证，认证成功才绑定 Profile 和消费 grant。
- [x] `P22-06` 保存每 Profile 独立密钥，重开只复用自己的身份；扩展配置损坏或公钥不符返回冲突，不静默重置。
- [x] `P22-07` 实现当前实例重连和 service worker 重启路径；已知受管端点省略声明、旧代次或重放 grant 必须拒绝。
- [x] `P22-08` 处理 AUTH 已提交但应答丢失：持有同一密钥的同实例通过新 challenge 恢复，不能把新实例凭据当作可重复消费。
- [x] `P22-09` 处理昵称碰撞和现有配对格式；自动生成新候选且有重试上限，不能占用已有端点身份。
- [x] `P22-10` 检查 manifest key、原生宿主 origin、消息转发和版本能力；旧外部扩展接入新 Broker 必须继续有效。
- [x] `P22-11` 验证受管标记存在但配置缺失时不会转成普通端点注册；旧 Broker 明确拒绝新受管流程。
- [x] `P22-12` 实现三路乱序、认证中断、重放、过期、旧代次和重启测试；执行本任务检查并保存脱敏证据。

验证：`pnpm exec vitest run tests/unit/managed-bootstrap.test.ts tests/contract/relay-v2.test.ts tests/integration/websocket-gateway.test.ts`。三 Profile 乱序引导；覆盖过期/重放凭据、伪造公钥、旧代次迟到、认证前断线、service worker 重启、昵称碰撞及人工安装扩展重连。错误连接不得修改映射，日志不含明文凭据。

### 任务 2.3 管理器将创建打开停止和恢复组织成可核对的阶段

文件：新增 `apps/broker/src/profiles/profile-manager.ts`、`apps/broker/src/profiles/profile-reconciler.ts`、`apps/broker/src/profiles/types.ts`、`tests/integration/managed-profiles.test.ts`；调整 `apps/broker/src/runtime/bootstrap.ts`、`apps/broker/src/core/octopus/octopus-broker.ts` 的工作区准入钩子与 `apps/broker/src/storage/sqlite/request-repository.ts` 的租约接口。

方案：组合资源、Launcher、bootstrap、连接和 inventory。每 Profile 串行，跨 Profile 有限并发；create/open 只在 ready 时成功。部分失败保留引用，open 不建第二份。stop 建立屏障并阻止新 workspace 准入，核对所有工作区/在途操作后关闭。恢复先核对实际效果，处理 spawn 前后崩溃窗口，不能无条件重放启动。

依赖：任务 2.1、2.2。

交付物：列表运行/连接状态、就绪规则、可恢复失败、关闭后数据保持、Broker 重启核对。

**执行 TODO**

- [x] `P23-01` 实现管理器依赖接口和测试替身，组装 repository、Launcher、bootstrap、连接、inventory 与时钟。
- [x] `P23-02` 实现 create 的登记后各阶段 checkpoint：准备目录、启动、加载、认证、inventory、ready。
- [x] `P23-03` 实现 open 的 stopped/starting/running-ready/running-disconnected/unknown 分支；复用原实例并保留失败资源。
- [x] `P23-04` 实现每 Profile 顺序队列和全局有限并发，重复 open 合并效果但每张票据仍有明确归属与结果。
- [x] `P23-05` 实现请求 claim 与 Profile 锁续租及代次校验；失租后禁止新的外部副作用和迟到结果写回。
- [x] `P23-06` 给既有 workspace 准入加入受管实例 stopping 屏障，建立屏障和检查活跃工作在同一协调边界内完成。
- [x] `P23-07` 实现 stop 阻塞结果与屏障释放；无阻塞才关闭，已关闭则幂等成功，关闭超时保留真实状态。
- [x] `P23-08` 定义 ready 的完整判定；连接断开、能力不足、缺窗口、identity 不符或陈旧 inventory 都不能误报。
- [x] `P23-09` 实现 Broker 启动核对和周期状态更新；处理用户手动关闭 Chrome、进程崩溃与后台进程仍在的差别。
- [x] `P23-10` 实现 spawn 后尚未落库、认证后未记录结果、close 后未落库的恢复；不明效果进入 uncertain 并阻止盲目重启。
- [x] `P23-11` 实现实例级 repair 的有界重试和活跃工作区限制，不能自动解除 endpoint/workspace 暂停。
- [x] `P23-12` 通过内部集成入口运行本任务故障测试和真实单 Profile 闭环，记录 G2，不依赖尚未接入的公开管理工具。

验证：`pnpm exec vitest run tests/integration/managed-profiles.test.ts`；`pnpm typecheck`。逐阶段注入崩溃，特别是 spawn 后尚未落库；并发 open/open、open/stop、stop/workspace-create。覆盖缺窗口、缺 capability、扩展已断但进程仍在、一路失败其余完成、身份存储损坏。停止不能越过活跃工作区或误结束其他进程。

门槛 G2：通过内部集成入口调用正式管理器，真实单 Profile 创建就绪、停止、重开通过；三路认证不串线；Broker 重启和并发测试通过。此门槛不要求尚未接入的四个公开 MCP 工具。

## MCP 与发布

### 任务 3.1 生命周期操作进入现有持久票据和版本化工具目录

文件：调整 `apps/broker/src/core/octopus/octopus-broker.ts`、`apps/broker/src/core/octopus/mcp-presenter.ts`、`apps/broker/src/core/octopus/reference-factory.ts`、`apps/broker/src/mcp/server.ts`、`apps/shared/protocol/src/mcp/tool-catalog.ts`、`apps/shared/protocol/src/mcp/validators.ts`、`apps/shared/protocol/src/domain/references.ts`、`apps/shared/protocol/src/domain/facts.ts`、`apps/shared/protocol/src/error-codes.ts`、`apps/shared/protocol/src/index.ts`、`apps/mcp-stdio-adapter/src/server.ts`；新增 `tests/contract/profile-management.test.ts`、`tests/contract/mcp-contract-v2.test.ts`；调整 `tests/integration/mcp-gateway.test.ts`、`tests/integration/mcp-stdio-adapter.test.ts` 和 `tests/integration/octopus-broker.test.ts`。

方案：按任务 1.1 的追踪清单、仓库规范流程，在同一完整变更中切换 canonical 文档/schema、catalog、presenter、gateway、adapter 和相关测试。增加同步列表与三个异步工具，不在 handler 直接 spawn。回复交付后才调度，Profile 请求走独立资源队列；get/close/list request 优先核验关联表管理权，不退回旧会话权限。输出公开引用、端点昵称与事实，Agent 再用原 workspace 工具，ready 不解除端点暂停。

依赖：G1、G2。

交付物：18 工具的 v2 schema、适配器/Broker 版本检查、新旧票据正确呈现、管理请求去重与查询，旧十四工具语义保持。

同时调整现有 `tests/contract/mcp-contract-v1.test.ts` 中对运行时十四工具的断言；如保留历史契约测试，应使用明确冻结的 v1 fixture，而不能继续以当前 canonical schema 冒充 v1。构建与安装检查中的硬编码工具数量一并核对。

**执行 TODO**

- [x] `P31-01` 按任务 1.1 清单成套更新 canonical 文档/schema、相关索引和 changelog；记录已确认需求与实现证据。
- [x] `P31-02` 增加四工具 catalog、profile/instance 引用、输入/输出 validators 和 presenter，18 个工具都有严格 schema。
- [x] `P31-03` 增加只读 list 与三个 submit 分支，关联 Profile Manager，提交处理器不直接启动或关闭浏览器。
- [x] `P31-04` 扩展 accepted/result/get_request/close_request 的 Profile 分支，结果保留部分资源与当前运行/连接事实。
- [x] `P31-05` 在请求查询、列表、关闭及恢复中优先校验 profile_requests 管理权；拒绝后禁止 fallback 到旧 session 规则。
- [x] `P31-06` 接入 HTTP 回复交付后调度；测试交付前无副作用、交付失败和 adapter 已收/Agent 未收时的幂等恢复。
- [x] `P31-07` 接入 Profile 锁与 worker 续租，避免旧通用 pump 把 Profile 请求错误路由到 extension 或 tab lane。
- [x] `P31-08` 增加契约版本 health、请求 header 和启动预检，缺失/错误版本在签发票据前拒绝。
- [x] `P31-09` 更新 stdio tool 注册与输出验证，保留单会话身份和 MCP 协议自身协商；新旧 adapter/Broker 组合都可诊断。
- [x] `P31-10` 限制旧网页请求裁决/控制工具对 Profile 票据的使用，避免通过 resolve_browser_request 绕过生命周期恢复。
- [x] `P31-11` 改造 v1 测试为历史 fixture 或迁移断言，新增 v2 完整 wire 测试，清理运行时硬编码十四工具。
- [x] `P31-12` 确保原十四工具行为回归通过；Profile 打开不自动创建 workspace，也不清除暂停控制。
- [x] `P31-13` 运行本任务检查和 typecheck，从实际 MCP 工具列表核实 18 项及参数/结果，再进入安装交付。

验证：`pnpm exec vitest run tests/contract/profile-management.test.ts tests/contract/mcp-contract-v2.test.ts tests/integration/mcp-gateway.test.ts tests/integration/mcp-stdio-adapter.test.ts tests/integration/octopus-broker.test.ts`。覆盖旧适配器→新 Broker、新适配器→旧 Broker、非法参数、越权、回复丢失、同键重试、跨会话恢复、仅进程就绪、错误成功结果。版本不匹配不得产生票据或浏览器副作用；校验实际 HTTP 与 stdio 结果。

### 任务 3.2 安装升级准备运行时并保护 Profile 和旧工作区

文件：调整 `tools/install-local.ps1`、`tools/update-local.ps1`、`tools/stage-release.ts`、`tools/copy-assets.ts`（按新资源需要）、`tools/installed-broker-launcher.mjs`、`tools/installed-mcp-adapter-launcher.mjs`、`apps/broker/src/runtime/bootstrap.ts`、`apps/shared/protocol/src/version.ts`、`package.json`、`apps/mcp-stdio-adapter/package.json`、`apps/browser-extension/manifest.json`；新增 `tests/real-world/managed-profile-installation.test.ts`；调整 `tests/real-world/setup-readiness-checks.test.ts`、`doc/zh-CN/Installation-and-Setup.md` 与根 README。

方案：安装配置明确浏览器版本/路径、受管根、扩展、Native host 注册和管理 scope。Broker、adapter、extension 成套发布；检查活跃工作、一致性备份 SQLite 后迁移切换。token 轮换保持 principal，或明确迁移授权，不能因创建新 principal 丢失 Profile 可见性。运行中不热替换扩展文件，安全重启时更新。

依赖：任务 3.1。

交付物：可重复安装、版本诊断、升级复用和回退演练。功能关闭禁止创建/启动，仍保留列表、诊断和已授权实例的收尾。

**执行 TODO**

- [x] `P32-01` 确定正式运行时获取方式、固定版本及校验方式；安装配置记录实际路径，创建工具不临时下载 Chrome。
- [x] `P32-02` 将必要 Launcher 库纳入 production bundle，stage 产物包含迁移、扩展和运行时配置，不能依赖开发机 node_modules。
- [x] `P32-03` 同步 root package、adapter package、extension manifest 和 shared version，验证 release manifest 无版本漂移。
- [x] `P32-04` 实现安装生成 managed-root、Native host 与 Broker/adapter 配置，默认不开外网监听。
- [x] `P32-05` 为需要管理能力的本机 principal 显式配置 profiles scopes；升级和 token 轮换维持 principal 或迁移明确映射。
- [x] `P32-06` 在隔离 Windows 安装根测试新装；检查生成配置，不覆盖用户原有 Agent 配置或无关注册。
- [x] `P32-07` 升级先检查活跃工作和受管实例，再用 SQLite 一致性备份保存数据库/配置，迁移成功后切换运行时。
- [x] `P32-08` 保持 Profile 扩展绝对路径和 manifest key；仅停止实例后更新扩展文件，验证下一次启动仍保留身份和 Cookie。
- [x] `P32-09` 实现禁用新建/启动的功能开关，目录读取、诊断和已授权实例的收尾仍可用。
- [x] `P32-10` 实际演练升级失败和旧版回退，导出新 Profile 元数据并保留目录；记录旧版不显示新资源的限制。
- [x] `P32-11` 运行本任务安装检查/build，再用真实 MCP Agent 完成单 Profile 闭环，保存 G3 证据及恢复步骤。

验证：`pnpm exec vitest run tests/real-world/managed-profile-installation.test.ts tests/real-world/setup-readiness-checks.test.ts`；`pnpm build`。在隔离 Windows 安装根测试新装、缺浏览器、错误 Native host origin、旧库升级、token 更新、运行中升级阻塞、扩展路径移动和旧版回退。失败保留原安装与数据。

门槛 G3：一个真实 MCP Agent 完成单 Profile 创建、自动连接、操作、停止和重开，安装与回退通过。此时核心流程已交付，再扩展三浏览器演示。

## 多浏览器演示

### 任务 4.1 一个客户端的三个端点需要独立路由与进度证据

文件：新增 `tests/helpers/simulated-v2-extension.ts`、`tests/e2e/single-agent-multi-extension.test.ts`；小范围调整 `tests/e2e/multi-agent-multi-extension.test.ts` 的共享辅助引用。

方案：一个客户端/会话申请三个指定端点的 workspace；延迟 B，A/C 可先完成，同一 tab 的依赖操作仍按序。保留旧三 Agent 测试。

依赖：任务 3.1，不依赖物理浏览器或站点。

交付物：一会话三端点的自动化回归证据。

**执行 TODO**

- [x] `P41-01` 提取现有模拟扩展辅助代码，确保旧多 Agent 测试保持原断言与语义。
- [x] `P41-02` 创建只有一个 MCP 客户端和一个 caller session 的三端点测试，校验三个 workspace 的 owner 一致。
- [x] `P41-03` 验证三路命令只到各自 endpoint/tab，错误引用组合拒绝且没有浏览器副作用。
- [x] `P41-04` 延迟 B，证明 A/C 独立完成；同 tab 的第二步必须等第一步完整请求周期结束。
- [x] `P41-05` 覆盖容量不足、重复指定、第三路部分失败、断线恢复，核对已建 workspace 被保留且不重复创建。
- [x] `P41-06` 运行新旧 E2E，报告明确标为模拟证据，不能用于替代 G4 真实浏览器。

验证：`pnpm exec vitest run tests/e2e/single-agent-multi-extension.test.ts tests/e2e/multi-agent-multi-extension.test.ts`。覆盖仅两个端点、重复指定、第三路创建失败、混用 workspace/tab、一路断连。部分成功必须保留已建工作区，不重复创建整组。

### 任务 4.2 同源三账户站点展示隔离任务和可观察的等待

文件：新增 `tests/demo/fixture-server.ts`、`tests/demo/fixture-server.test.ts`、`tests/demo/types.ts`、`tools/prepare-single-agent-demo.ts`。

方案：loopback 站点，固定日期、按 run 分区，持久 Cookie 区分 Alice/Bob/Carol，三个浏览器访问同一 URL。Agent 经页面建立测试身份、选最早到期事项、填备注、完成并生成延迟摘要；服务端不代选答案。视觉实现前另做参考调研，使用常规表单与可读 DOM，首版无控制大屏。

依赖：G3；现有 A/B/C 标记页继续供原测试使用。

交付物：设置入口、待办、备注、摘要状态、事件和初始快照。候选端口 7341，占用时报错或返回实际新端口，不杀占用进程。

**执行 TODO**

- [x] `P42-01` 实现独立 run 的服务端账户/待办数据和初始快照，固定时区、演示日期及可确定的最早事项规则。
- [x] `P42-02` 实现页面测试账户入口与持久 Cookie，已登录账户不靠 query 参数切换；三个浏览器共享同一业务 URL。
- [x] `P42-03` 实现可读取的常规表单、账户标记、备注提交和完成状态；按账户/run 校验服务端写入。
- [x] `P42-04` 实现可配置异步摘要、去重和事件时间记录，运行前冻结配置；站点不替 Agent 决策或填写答案。
- [x] `P42-05` 按照技术设计增大真实演示延迟并要求先处理三路事项、再连续发起摘要，避免 3–8 秒窗口导致假失败。
- [x] `P42-06` 实现 fixture CLI 的 ready 信息、实际端口、健康检查、PID 归属和退出处理；后台服务不打开多余终端窗口。
- [x] `P42-07` 落实 run ID/端口/输出路径验证、当前 run 复位及普通访问的权限边界；保存初始快照供差异校验。
- [x] `P42-08` 执行本任务测试和站点启动检查，确认三账户隔离及错误写入不改变数据。

验证：`pnpm exec vitest run tests/demo/fixture-server.test.ts`；`pnpm exec tsx tools/prepare-single-agent-demo.ts --run-id=demo-rehearsal --port=7341`；`Invoke-RestMethod http://127.0.0.1:7341/health`。覆盖缺 Cookie、重复账户、跨账户写入、错误任务、重复提交、端口冲突和 run ID 越界。仅复位当前 run。

### 任务 4.3 真实 MCP 记录让验收器拒绝缺失或错误的完成证据

文件：新增 `apps/mcp-stdio-adapter/src/demo-trace.ts`、`tests/unit/demo-trace.test.ts`、`tests/demo/evidence-verifier.ts`、`tests/demo/evidence-verifier.test.ts`、`tools/verify-single-agent-demo.ts`；调整 `apps/mcp-stdio-adapter/src/config.ts` 和 `apps/mcp-stdio-adapter/src/server.ts` 的可选 trace 接入。

方案：演示显式开启本地 trace，记录调用、实际 Broker 结果、时间、run ID 与会话关联；不改结果、不代调用、不重发写操作，脱敏认证信息。准备配置先不含 Profile 分工，创建后根据真实结果补全，不能预造引用。验收器关联 trace、页面回读、初始快照和事件；结合本轮完整运行记录验证仅一个 Agent，局部 trace 不被称为所有活动的完整证明。

依赖：任务 3.1、4.2。

交付物：脱敏记录、JSON 证据、逐项通过/失败/未验证报告，必要项非通过退出非零。

**执行 TODO**

- [x] `P43-01` 定义 trace/config/evidence 格式及版本，区分原始观察与验收推论；准备配置不预填虚假引用。
- [x] `P43-02` 实现显式开启的 adapter trace，使用本地受控输出路径，stdout 仅用于 MCP；处理并发写入和进程中断。
- [x] `P43-03` 脱敏认证、bootstrap、Cookie 和私钥字段，保存真实请求/结果/时间及会话关联，不重复执行工具调用。
- [x] `P43-04` 实现 verifier 从原始结果提取 profile/instance/endpoint/workspace/tab 映射，拒绝混用 run、session 或实例。
- [x] `P43-05` 核验三账户任务规则、备注、未修改其他事项、页面回读和摘要实际重叠，不能只信 Agent 汇总。
- [x] `P43-06` 核验停止 Bob 后混合列表、再次打开同一身份、重复 open 复用、最终三个关闭仍可见和 Broker 重启记录。
- [x] `P43-07` 实现 JSON 与可读报告，每项 passed/failed/unverified；缺记录、trace 写失败或必要项未验证使进程非零退出。
- [x] `P43-08` 运行所有缺证/串线/篡改时间/重复端点等反例和 trace 测试，演示前实际探测输出目录可写。

验证：`pnpm exec vitest run tests/unit/demo-trace.test.ts tests/demo/evidence-verifier.test.ts`。反例含不同 session、重复端点、仅 accepted、漏页面回读、错误备注、修改其他事项、串账户、串行摘要、只有模拟证据、trace 写入失败和漏脱敏。实演前证明记录路径可写。

### 任务 4.4 一个真实 Agent 连续完成两轮创建工作停止与复用

文件：`tests/demo/README.md`；结果位于 `artifacts/real-world/<run-id>/single-agent-demo/`。

方案：只预装运行时、启动站点和 trace。一个实际 Agent 先 list，三次 create 并轮询就绪，再处理三账户任务。保存结果后仅终止并停止 Bob，list 证明 Alice/Carol 在线、Bob 关闭仍可见；open Bob 验证 Profile、扩展身份、账户持久状态和任务结果，再次 open 复用实例。最后收尾工作区并 stop，资源继续可查。第二轮新 run、新 Profile，保留第一轮证据。

依赖：任务 4.1 至 4.3。

交付物：两轮真实报告、版本、用时、账户隔离、混合状态、重开结果及收尾清单。不预先保证三至五分钟，不用子 Agent 或其他浏览器工具代办。

**执行 TODO**

- [x] `P44-01` 记录本轮真实 Agent 与唯一 runtime 会话；adapter 进程可在批次间重启并恢复相同身份（实现差异见实施结果）；启动固定版本运行时/站点/trace，确认生命周期工具确实可用。
- [x] `P44-02` 执行计划提示词：list 后 create 三次、轮询至就绪，从真实结果形成分工，不能用准备脚本代建。
- [x] `P44-03` 经原有 workspace/CDP 工具建立三个测试账户，读取同一 URL 的不同数据，处理事项并连续发起摘要。
- [x] `P44-04` 轮询三个任务并回读页面，保存真实业务结果、票据终态、原始 trace 与站点事件。
- [x] `P44-05` 先终止 Bob 的工作区并正常 stop，list 证明 Bob 关闭仍可见而 Alice/Carol 在线。
- [x] `P44-06` 重新 open Bob 并分配当前工作区，验证账户数据、Profile/扩展身份；重复 open 核对实例不变。
- [x] `P44-07` 收尾全部工作区并 stop，验证三个 Profile 均保留；保存旧引用，不假设重开后 tab_ref 不变。
- [x] `P44-08` 为本轮执行 verifier；另做 Broker 重启核对证据；失败保持未完成，不修改服务端或报告补造成功。
- [x] `P44-09` 用新 run/new Profiles 完成第二轮，通过全部必要项；最后运行完整回归，登记 G4、资源收尾和仍需处理的引用。

验证：经 MCP 实际执行后运行 `pnpm exec tsx tools/verify-single-agent-demo.ts --run-id=demo-rehearsal`，第二轮另用 run ID。接不入真实 Agent 就报告未完成，不能用脚本冒充。实现阶段最终运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`。

门槛 G4：计划入口十二项验收均有证据，两轮全部通过，模拟与真实结果分别报告。

## 验收门槛

### 每个阶段必须有可重复检查的产物才能推进依赖阶段

- [x] G0：固定版本真实 Chrome 自动接入、原生标签组、页面执行及重开通过。
- [x] G1：契约明确，目录、权限、迁移反例和旧数据保留通过。
- [x] G2：启动、停止、身份绑定、并发与恢复通过。
- [x] G3：真实 MCP 单 Profile 闭环、安装升级、版本拒绝和回退通过。
- [x] G4：两次单 Agent 三真实 Profile 演示通过独立验收。

## 执行记录

### 每个阶段登记实际证据后才改变完成状态

本版共 13 个任务、123 个实施 TODO，已完成。设计阶段和本次实施分开记录，未把计划文字本身算作代码或实测。阶段证据如下；测试覆盖和实现差异详见 [实施结果](./implementation-report.md)。

| 阶段 | 状态 | 证据与命令结果 | 阻塞/下一步 |
| --- | --- | --- | --- |
| 准备 0.0 | 完成 | `artifacts/real-world/managed-profile-execution/plan-execution/P00/`；原基线 `pnpm verify` 通过 | 原有改动保留 |
| G0 自动引导 | 完成 | `artifacts/real-world/managed-probe-007/managed-chrome-probe/report.json`；6 个 probe 单元测试、gateway 与 shutdown 回归通过 | Chrome 153.0.8010.53；私有 loopback CDP；启动器正常退出后浏览器存活 |
| G1 资源与契约 | 完成 | profile-repository 迁移/回滚/旧事实保留、Profile 权限契约测试通过 | 006 一致性快照、持久 principal 与幂等映射 |
| G2 浏览器运行时 | 完成 | `artifacts/real-world/profile-manager-005/profile-manager/report.json`；管理器、引导和 Launcher 回归 | 自动认证、停止重开、Broker 重启复用；周期核对集成于管理器 |
| G3 MCP 与安装 | 完成 | `managed-profile-execution/` 安装/失败回退日志；`profile-upgrade-probe-001/report.json`（均位于 artifacts/real-world） | 真实打包 MCP、运行中拒绝升级、v0.3.0 往返、metadata 保留 |
| G4 多浏览器演示 | 完成 | `single-agent-demo-002` 与 `single-agent-demo-003` 各 25 项 passed；全量 verify + smoke 通过 | 六个 Profile 已停止保留；失败 001 保留不计通过 |

## 回退

### 回退必须保留受管数据且不让旧版本误操作新实例

G0 失败保留报告，不改称 direct-CDP 业务方案已成功。G1/G2 内部迭代可关闭创建/启动入口，保留记录和诊断，不删除目录。G3 回退先阻止新任务，由有权会话收尾工作区与受管实例，再停止 Broker；无法收尾则保留现场并报告阻塞。

迁移前用 SQLite 支持的一致性备份保存原库和配置。只使用旧版经过验证可读的数据库或迁移前快照，不能假设旧二进制可直接打开新增 schema。恢复快照前导出新增 Profile 元数据供以后恢复，保留目录并明确旧版不会显示这些新记录；不伪造历史票据，不回滚网站操作。扩展回退仅在实例停止后执行，不删除登录和身份存储。

G4 失败保留部分结果与引用，按现有恢复/终止语义处理。停止站点只结束本轮站点进程；浏览器用受管引用逐个关闭，不清空数据库，不按进程名批量终止。

## 证据索引

### 各任务的实现位置和验证结果可从报告追溯

P11/P12：canonical v2 文档与 schema、profile repository、profile-management 契约和迁移测试。P21/P22/P23：profiles 目录、扩展 managed-bootstrap、Launcher/管理器/引导测试及正式物理探针。P31：十八工具 catalog、gateway/adapter 版本检查与原工具回归。P32：配置/升级脚本、隔离安装日志及真正 v0.3.0 迁移回退报告。P41：单 Agent 三端点 E2E，含重复指定、第三路断线恢复和独立进度。P42/P43：tests/demo 站点、trace 与验收反例。P44：两轮实际 Agent MCP trace、进程快照、业务事件、最终列表和独立验收。

完整路径、命令与证据限制见 [实施结果](./implementation-report.md) 和 [Demo 运行手册](../../../tests/demo/RUNBOOK.md)。
