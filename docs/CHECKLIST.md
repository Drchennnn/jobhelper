# JobHelper 总控工程 Checklist 与阶段门禁（M0 – M6）

> 本文档是主代理统筹项目推进的**唯一进度与验收基准**。每个阶段（Milestone）均包含交付物清单、门禁验证条件（Gate）与 Git 合入收尾要求（遵循 [AGENTS.md](../AGENTS.md)）。
>
> **状态图例**：`[x]` 已完成 · `[-]` 进行中 · `[ ]` 未开始 · `[!]` 阻塞/待决策

---

## 零、全局红线不变量（所有阶段必须持续守住）

每一阶段 Gate 验收与任意 PR 合入前，必须核对以下 12 条架构红线：

- [ ] **INV-01 四轴状态解耦**：`executionState`、`waitingReason`、`applicationStage`、`outcome` 独立落库；单轮 `run` 结束或 `filling_ready` 绝不等于 `submitted_verified`。
- [ ] **INV-02 租约防迟到（Epoch Fencing）**：所有有副作用的浏览器/业务请求携带 `(taskId, epoch)`；用户接管时先撤租约与 CDP，旧 epoch 请求必须 100% 被拒绝。
- [ ] **INV-03 角色权限硬隔离**：`coordinator` 无任何浏览器操作能力；`application` 仅限访问本任务标签页，不可派生其他岗位任务。
- [ ] **INV-04 档案快照锁定**：投递任务创建时锁定 `profileVersionId` 与授权附件清单；切换全局默认档案不得静默改变既有任务绑定。
- [ ] **INV-05 幂等去重创建**：同未完成岗位/URL 并发或重复发起，必须合并/打开原任务，防止重复创建与重复投递。
- [ ] **INV-06 Submit Hard-Guard 全路径受控**：`act(click)`、`act(press, 'Enter')`、坐标点击与受限脚本均过统一提交闸门；v1 默认由用户在右侧网页手动最终提交。
- [ ] **INV-07 核对卡版本绑定**：确认卡绑定 `taskId + confirmationId + operation + contentHash`；表单内容或附件变动后旧授权立即失效，绝不永久授权。
- [ ] **INV-08 禁止自动重放提交**：`applicationStage >= submit_attempted` 或应用崩溃重启/API 超时后，仅允许只读核验，严禁自动重试点击提交。
- [ ] **INV-09 问题卡与迟到答案**：问答绑定 `callId + questionId`；超时只产生 `pending`，绝不视作同意或允许猜测；迟到答案必须回挂原问题。
- [ ] **INV-10 凭据安全边界**：模型 API Key 仅存系统凭据服务（`safeStorage` / DPAPI），绝不写入明文 SQLite、日志、聊天气泡或招聘网页上下文；页面密码/OTP 字段观测脱敏且禁止自动填写。
- [ ] **INV-11 SQLite 单一业务真相**：先原子写入 SQLite（状态、事件、动作账本），再推送 UI 或驱动 Worker；不靠模型对话历史反推业务状态。
- [ ] **INV-12 诚实证据与无平台商业残留**：不引入付费墙/扣次/云浏览器/强制遥测；所有未实测站点能力不得宣称已支持。

---

## M0 — 架构框架、契约定义与治理基线（当前阶段）

**目标**：固化 monorepo 结构、跨进程类型契约、SQLite DDL 蓝图、核心 ADR、工具规范与 Gate 1 验收方案，不编写任何业务实现逻辑。

### 交付清单
- [x] M0.1 根配置与工作区骨架（`package.json`、`tsconfig.base.json`、`.gitignore`、`.editorconfig`、`README.md`）
- [x] M0.2 核心架构规格文档（[docs/ARCHITECTURE.md](./ARCHITECTURE.md)）
- [x] M0.3 总控 Checklist 与阶段门禁（[docs/CHECKLIST.md](./CHECKLIST.md)）
- [x] M0.4 统一工具契约文档（[docs/TOOL_CONTRACTS.md](./TOOL_CONTRACTS.md)）
- [x] M0.5 数据库设计文档与首版 DDL（[docs/DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)、`packages/storage/migrations/0001_initial.sql`）
- [x] M0.6 Gate 1 黄金闭环验收方案（[docs/ACCEPTANCE_GATE1.md](./ACCEPTANCE_GATE1.md)）
- [x] M0.7 架构决策记录 ADR-0001 ~ ADR-0004（`docs/ADR/`）
- [x] M0.8 `packages/*` 九个领域包骨架与纯 TypeScript 契约接口定义
- [x] M0.9 `apps/desktop`、`apps/workbench`、`skills-library/`、`fixtures/mock-ats/` 骨架占位
- [x] M0.10 用户审阅 M0 框架与 Checklist，已确认 4 项关键技术选型（见文末“已确认的 M0→M1 选型决议”）
- [x] M0.11 按 [AGENTS.md](../AGENTS.md) 规范提交 M0 基线（校验 author、`--no-ff` 合入 `main` 并推送 `origin/main`）

### M0 门禁出口条件
- 目录树与文档自洽，所有包依赖方向单向无环（`@jobhelper/contracts` 零内部依赖）。
- 尚未引入业务实现代码与重型构建产物。

---

## M1 — 本地核心底座（依赖安装、SQLite 存储、档案材料、凭据与 BYOK 模型路由）

**目标**：打通本地数据持久层、档案快照与材料管理、系统密钥存储以及 BYOK 模型适配与能力探测，使整个 monorepo 可编译、可单测。

### 交付清单
- [x] M1.1 工程化基建落地：安装 TypeScript、`@types/node`、Vitest；打通根级 `npm run build`、`npm run typecheck` 与 `npm test`。
- [x] M1.2 `@jobhelper/storage` 实现：基于内置 `node:sqlite` 的 WAL/外键连接、迁移执行器（执行 `0001_initial.sql`，含校验和校验与失败句柄回收）、嵌套 savepoint 事务、全套 Repository 实现（`PreferencesRepo`、`ProviderRepo`、`ProfileRepo`、`PositionRepo`、`TaskRepo`、`RunRepo`、`EventRepo`、`HumanInTheLoopRepo`、`ActionLedgerRepo`、`ArtifactRepo`、`SiteMemoryRepo`）。
- [x] M1.3 `@jobhelper/core` 档案与材料服务：结构化档案 CRUD、不可变 `ProfileVersionSnapshot`（canonical JSON SHA-256）、全局默认档案记忆与切换隔离、个人事实记忆、本地附件托管目录（路径安全校验、SHA-256 完整性校验、大小限制、任务级授权检查与受控分页文本读取）。
- [x] M1.4 `@jobhelper/model-router` 凭据服务：基于 Electron `safeStorage`（Windows DPAPI）结构接口的 `SafeStorageCredentialStore`（加密不可用时拒绝明文落盘）+ 单元测试 `InMemoryCredentialStore`。
- [x] M1.5 `@jobhelper/model-router` BYOK 适配器：实现 OpenAI-compatible（含 DeepSeek `reasoning_content`）、Anthropic、Gemini 三个标准流式/JSON 适配器，支持流式输出（text + reasoning）、Tool Calling、Vision base64 图像输入、AbortSignal 取消、密钥自动脱敏与 Usage 计量。
- [x] M1.6 连通性与能力探测（Capability Probe）：真实三段探测并持久化 `streaming` / `tool_calling` / `vision` 能力，输出清晰错误分类（`auth_failed`、`rate_limited`、`timeout`、`aborted`、`network_error`、`provider_error`）。

### M1 门禁出口条件
- [x] `npm run clean && npm run build && npm run typecheck && npm test` 全绿（9 项核心测试覆盖存储迁移与重启恢复、档案快照隔离、材料完整性、凭据加密隔离、三协议流式与工具调用及能力探测、401/429/timeout/abort 故障分类）。
- [ ] 可选：待用户提供真实 BYOK API 配置后补充一次线上端点连通性实测（不阻塞进入 M2）。

---

## M2 — 任务调度、执行租约与浏览器安全执行层

**目标**：实现任务生命周期状态机、去重创建、`ControlLease`、`ScopedCdpBridge`、`WebContentsView` 管理与 `Submit Hard-Guard`。

### 交付清单
- [ ] M2.1 `@jobhelper/core` 状态机与 `TaskService`：实现四轴合法转移校验器、同 URL/岗位并发去重（共享创建 Promise + 复用未完成任务）、关闭/重启恢复（`running`/`queued` → `interrupted`）。
- [ ] M2.2 `@jobhelper/core` `ControlLease` & `TaskControls` & `Scheduler`：独立任务租约、可配置并发上限（1–5）、FIFO 排队、`stopTask` 先撤 lease/CDP 再异步停 worker 并维护 `stopping` 状态。
- [ ] M2.3 `@jobhelper/core` `ConfirmationService`：核对卡生成、`contentHash` 绑定、单次消费、内容变更自动失效、超时与拒绝语义。
- [ ] M2.4 `@jobhelper/browser-bridge` `TaskTabManager`：基于 Electron `WebContentsView` 管理任务级标签页、共享 `persist:jobhelper-<browserProfileId>` 分区、`setWindowOpenHandler` 新弹窗归入同任务、隐藏视图保持非零 viewport、渲染器崩溃隔离处理。
- [ ] M2.5 `@jobhelper/browser-bridge` `ScopedCdpBridge`：本机随机端口 WebSocket 服务（`maxPayload: 80 MiB`）、ephemeral token 鉴权、每帧校验 `TaskControls.assert(taskId, epoch)`、未首次导航弹窗延迟暴露、隐藏视图 DPR 归一化截图。
- [ ] M2.6 `@jobhelper/browser-bridge` `BrowserController` & `Submit Hard-Guard`：
  - `observe`（AXTree 提取、密码框脱敏、短生命周期 `ref`、`generation` 失效）。
  - `fill` / `select` / `upload` 执行后强制回读校验。
  - 密码/验证码/OTP 字段硬拒绝。
  - **Submit Hard-Guard**：拦截点击提交按钮、表单内 `Enter` 键、坐标命中提交元素、跨 iframe 点击与任意脚本提交。
- [ ] M2.7 Electron 主进程骨架接通（`apps/desktop/main`）：主窗口创建、Preload `contextBridge`、主进程 ↔ Worker IPC 通道与超时清理、Worker 崩溃重启恢复。

### M2 门禁出口条件
- 自动化测试证明：
  1. `stopTask` 后立即投递旧 `epoch` 命令 100% 失败；
  2. 尝试通过 `click`、`Enter`、坐标点击及受限脚本触发测试页提交按钮均被 `Submit Hard-Guard` 拦截；
  3. 任务 A 的 CDP 连接无法枚举或操作任务 B 或工作台窗口；
  4. 模拟主进程重启后 `running` 任务自动转为 `interrupted` 且不重放动作。

---

## M3 — 统一工具层、按需 Skills 与 Agent Runtime 闭环

**目标**：搭建内置轻量 TypeScript Agent Runtime、统一工具注册表、按需 Skills 加载器与可选任务级 MCP 适配器，跑通“总助手派工 → 投递助手观察填写 → 问答/接管/核对”无头闭环。

### 交付清单
- [ ] M3.1 `@jobhelper/tools` 统一工具注册表：实现角色隔离白名单（`coordinator` vs `application`）与完整参数 schema 校验（见 [TOOL_CONTRACTS.md](./TOOL_CONTRACTS.md)）。
- [ ] M3.2 投递助手浏览器工具集接入：`observe`、`candidates`、`inspect_control`、`screenshot`、`act`、`tabs`、`network`、`read_spill`（以及默认只读受限的 `run`）。
- [ ] M3.3 投递助手业务工具集接入：`read_profile`、`read_material`、`ask_user_question`、`request_user_action`、`capture_confirmation_screenshot`、`request_submission_confirmation`、`request_manual_submission`、`request_operation_confirmation`、`report_filling_ready`、`report_submit_attempted`、`report_submission_result`、`update_task_details`、`remember_user_info`、`skill_load`。
- [ ] M3.4 协调助手工具集接入：`get_career_overview`、`read_profile`、`edit_profile`、`list_materials`、`read_material`、`add_tracked_position`、`update_progress`、`start_application`、`start_applications`、`application_status`、`remember_user_info`。
- [ ] M3.5 `@jobhelper/skills` 本地 Skills 知识库引擎：解析 frontmatter 元数据索引、基于 URL/DOM 特征推荐、按需单篇加载、本地草稿审阅流；适配首批核心控件/站点 Skill（对照 `skills-library/` 核对工具名与读回条件，不盲抄原版 Runtime 私有指令）。
- [ ] M3.6 `@jobhelper/runtime` 核心执行循环：
  - 每轮冻结模型配置、档案快照、附件清单与 Skill 索引版本；
  - 流式增量输出（按 `attemptId` 聚合 text/reasoning，停止保留 partial）；
  - 上下文裁剪器（保留表单账本、已确认事实、未解决错误与待办，折叠过期大快照与历史截图）；
  - `ask_user_question` 挂起等待（默认 120s）、超时转 pending、迟到答案按 `callId + questionId` 回挂；
  - `attention` 置位后拒绝同轮后续有副作用工具调用；
  - 运行中无附件普通消息 `splice` 注入边界处理。
- [ ] M3.7 `@jobhelper/mcp-adapter`（可选外部适配）：提供基于同一份 `ToolRegistry` 的本机随机端口 Streamable HTTP MCP 封装（带 `timingSafeEqual` token 鉴权与 `/mcp/<taskId>` 绑定）。

### M3 门禁出口条件
- 无头集成测试跑通：总助手调用 `start_application` → 投递助手在本地测试表单上完成 `observe → act(fill) → observe(verify) → ask_user_question → request_submission_confirmation`。
- 验证上下文裁剪有效（多步操作后 token 占用可控，不会把全量 Skills 塞进 prompt）。

---

## M4 — 桌面工作台 UI 与人机协同交互

**目标**：交付完整可用的桌面工作台界面，实现总助手与投递任务分屏体验、真实网页嵌入与几何同步、接管/问答/核对/回执全套结构化卡片。

### 交付清单
- [ ] M4.1 统一单套导航框架（`apps/workbench`）：助手 / 投递任务 / 档案与材料 / 求职进度 / 设置与技能；彻底消除双侧栏和“云桌面”语义混淆。
- [ ] M4.2 首次引导与设置页：BYOK 模型服务商增删改、一键能力探测结果展示、密钥录入状态（前端永不回显明文）、并发上限设置、浏览器身份分区管理、Skills 列表与草稿审阅、本地日志导出。
- [ ] M4.3 档案与材料页：结构化档案编辑器、版本快照查看、PDF 简历与证书附件导入/预览、个人事实记忆库管理、全局默认档案切换。
- [ ] M4.4 总助手页：长期会话流、所选档案展示、可折叠工具调用卡、派出的多个投递任务实时进度卡片（含四轴徽章与待处理提示）。
- [ ] M4.5 投递任务列表与快捷创建：按 全部/排队/执行中/待我处理/已结束 筛选；支持“直接粘贴岗位 URL”创建弹窗（创建前明确展示岗位、目标 URL、所选档案与授权附件）。
- [ ] M4.6 任务详情双栏工作台（核心界面）：
  - **顶栏**：岗位名称、锁定档案标识、四轴状态徽章、当前控制权徽章（`助手操作中` / `停止中...` / `由你操作`）、一键「我来操作」/「已处理，请检查」/「关闭任务」按钮。
  - **左栏**：有序事件流、`clientMessageId` 幂等发送、可展开工具参数/结果/错误卡、结构化**问题卡**（含“同时保存到档案”勾选）、结构化**人工待办卡**（区分“去右侧网页操作”与“在左栏回答”）、结构化**核对卡**（岗位、关键字段、缺失项、所选附件、截图摘要与人工提交指引）、**结果待核验卡**（提供“重新检查网页”与“我已在官网手动提交”确认弹窗）。
  - **右栏**：与主进程同步几何矩形的真实原生 `WebContentsView` 容器，处理 resize/弹层遮挡/窗口隐藏；支持网页地址栏只读展示、刷新/前进后退（操作前自动暂停 Agent）及拆出独立窗口。
- [ ] M4.7 求职进度页：展示全部本地岗位记录，区分 `submitted_verified`（官网回执）与 `user_reported`（用户手动报告），支持后续笔试/面试阶段手动维护。

### M4 门禁出口条件
- 桌面端打包启动流畅，窗口缩放、切换任务、弹层弹出时不出现原生 `WebContentsView` 遮挡或错位。
- 全套结构化卡片交互均由 SQLite 事件流驱动，关闭重开应用后界面状态完整还原。

---

## M5 — Gate 1 黄金闭环与异常/安全边界验收

**目标**：严格执行 [docs/ACCEPTANCE_GATE1.md](./ACCEPTANCE_GATE1.md) 全部验收场景，拿到首个端到端可复现证据包。

### 交付清单
- [ ] M5.1 构建可重置本地测试站点 `fixtures/mock-ats`（含模拟登录页、多类表单控件、附件上传、确认提交页、可配置的正常回执/超时无回执故障注入）。
- [ ] M5.2 执行主路径 8 步黄金闭环：虚构简历 + 真实 BYOK 配置 → 建任务 → 读字段 → 填表并回读 → 人工接管改值 → 恢复后读到新值 → 展示核对卡 → 人工提交 → 读回执。
- [ ] M5.3 执行安全与异常边界 10 项必测项：
  - [ ] 旧 `epoch` 动作注入被拒绝
  - [ ] Submit Hard-Guard 阻断 click / Enter / 坐标 / 脚本提交
  - [ ] 修改已填内容使既有核对卡失效
  - [ ] 模拟回执超时后停在 `verifying` + `unknown`，绝不自动重投
  - [ ] 模拟应用强制退出重启，运行中任务恢复为 `interrupted` 不重放写操作
  - [ ] 迟到问题回答回挂原 `questionId`
  - [ ] 切换全局默认档案不影响既有任务
  - [ ] 同一岗位重复点开始复用原任务
  - [ ] 总助手批量派发 2 个以上岗位，互不串档案和网页
  - [ ] API 超时/限流时展示真实错误并保留已完成步骤
- [ ] M5.4 产出 Gate 1 验收报告与日志/截图证据归档。

### M5 门禁出口条件
- Gate 1 全部主路径与 10 项边界测试 100% 通过，无 P0/P1 缺陷。

---

## M6 — 真实招聘站点兼容、复杂控件与性能成本基线

**目标**：在 Gate 1 稳固后，逐站验证主流中国招聘 ATS 系统的复杂控件、附件上传、耗时与模型 Token 成本，逐步完善本地 Skills 体系。

### 交付清单
- [ ] M6.1 按需适配首批主流站点 Skills（对照 JobHelper 工具契约重写/校验工具示例与读回条件）：
  - [ ] `ats-beisen`（北森 `*.zhiye.com`）
  - [ ] `ats-mokahr`（MokaHR `app.mokahr.com`）
  - [ ] `ats-feishu`（飞书招聘 `*.jobs.feishu.cn`）
  - [ ] `ats-hotjob` / `ats-hotjob-wt`（大易/WeCruit）
  - [ ] `ats-iguopin`（国聘）
  - [ ] `form-controls` + `form-dates`（通用下拉/级联/日期控件）
- [ ] M6.2 复杂控件专项验证：级联地区选择器、只读日期面板、多段动态增删教育/实习经历区块、大文件 PDF 简历与多证书上传（验证 80 MiB CDP 通道）。
- [ ] M6.3 多 BYOK 服务商兼容矩阵测试（记录各模型在工具调用准确率、视觉定位能力、单岗位平均步数、耗时与 Token 成本的实测基准）。
- [ ] M6.4 站点本地经验记忆（`search_memories` / `create_memory`）与 Skill 本地草稿审阅流程打磨。
- [ ] M6.5 Windows 安装包打包构建与数据目录备份/迁移文档。

---

## 多代理协作与 Git 合入规范检查（每阶段必做）

遵循 [AGENTS.md](../AGENTS.md)：
- [ ] 每次提交前确认 `git config user.name` 为 `Drchennnn`，`git config user.email` 为 `drchennnn@gmail.com`。
- [ ] 阶段开发在特性分支（如 `feat/m1-storage-router`、`feat/m2-browser-bridge`）进行，子代理按包边界划分所有权，避免同时修改同一文件。
- [ ] 阶段通过 Gate 验收后，切换回 `main`，执行 `git merge --no-ff <branch>`（**严禁 squash merge**），保持完整真实开发提交历史。
- [ ] 确认 `git status` 工作区干净后执行 `git push origin main`（待配置远程仓库后）。

---

## 已确认的 M0 → M1 选型决议（2026-11-24）

1. **Git 远程仓库与 M0 提交**：已确认远程仓库为 `https://github.com/Drchennnn/jobhelper`，在 `feat/m0-architecture-scaffold` 分支提交 M0 并通过 `git merge --no-ff` 合入 `main` 推送。
2. **SQLite 驱动**：已确认采用 Node/Electron 内置 **`node:sqlite`**（`DatabaseSync`，零原生 C++ 编译依赖；M2 选定内嵌支持 `node:sqlite` 的 Electron 35+ 版本）。
3. **前端 UI 栈**：`apps/workbench` 已确认采用 **React + Vite + TypeScript + Tailwind CSS**。
4. **首版最终提交策略**：已确认 v1 默认采用**核对卡展示后由用户在右侧真实网页手动点击最终提交**，同时保留 `ConfirmationService` 的授权单次代点契约供后续版本开启。
