# JobHelper 统一工具契约规范（v0.1）

> 本规范定义 `@jobhelper/tools` 的单一工具契约。内置 Agent Runtime（`@jobhelper/runtime`）与可选本机 MCP 适配层（`@jobhelper/mcp-adapter`）**必须共用同一份工具定义、参数校验与执行路由**，杜绝双实现漂移。

---

## 1. 角色工具边界总览

| 角色 | 命名空间 | 浏览器权限 | v1 核心工具数 | 严禁调用 |
|---|---|---|---|---|
| **总助手 (`coordinator`)** | `coordinator` | **无** | 11 项（可扩展研究/日历插件） | 一切浏览器工具、投递确认/结果上报工具 |
| **投递助手 (`application`)** | `application` | **仅限当前 `taskId` 所属标签页** | 浏览器 8+1 项 + 业务 15 项 + 技能 2 项 | `start_application*`、跨任务标签访问、无授权提交 |

所有工具调用上下文（`ToolCallContext`）强制注入：
- `taskId`、`runId`、`epoch`、`callId`、`role`
- 冻结的 `profileVersionId` 与 `authorizedMaterialIds`
- 当轮 `attentionLocked: boolean`（一旦本轮登记了人工待办或核对卡，**后续所有写操作与浏览器操作一律拒绝**，迫使模型优雅结束本轮）

---

## 2. 总助手（`coordinator`）工具契约

| 工具名 | 分类 | 副作用 | 输入要点 | 输出要点 | 相比锦鲤的变化 |
|---|---|---|---|---|---|
| `get_career_overview` | 档案概览 | 只读 | 无 | 档案列表、当前默认档案、附件概况、本地岗位统计 | 改为读取本地 SQLite |
| `read_profile` | 档案 | 只读 | `profileId?` | 完整结构化档案与当前 `profileVersionId` | 改为读取本地档案版本库 |
| `edit_profile` | 档案 | 写入 | `profileId`, `patch`, `confirmed?` | 更新后的新 `profileVersionId` 与变更摘要 | 增删整段经历仍要求用户明确要求 + `confirmed=true` |
| `list_materials` | 材料 | 只读 | `profileId?` | 简历/证书/作品集列表（ID、类型、文件名、SHA-256、大小） | 本地受管理附件库 |
| `read_material` | 材料 | 只读 | `materialId`, `view?: 'text'\|'image'\|'structured'`, `page?`, `offset?` | 分页文本/解析内容或图像引用 + `nextPage`/`nextOffset` | 合并原 `read_material` 与对话附件读取体验 |
| `remember_user_info` | 事实库 | 写入 | `key`, `value`, `scope: 'global'\|'profile'`, `profileId?` | 已保存的个人事实记录 | 本地 `user_facts` 表 |
| `add_tracked_position` | 进度 | 写入 | `company`, `title`, `applyUrl`, `sourceNote?` | `positionId`（若已有同 URL 岗位返回已有记录） | 仅记录明确来源，不捏造链接 |
| `update_progress` | 进度 | 写入 | `positionId`, `stage`, `note?`, `closedReason?` | 更新后的岗位进度 | 仅在用户明确告知时更新；禁止把填表中标为已投递 |
| `start_application` | 派工 | 写入 | `applyUrl`, `positionId?`, `profileId?`, `materialIds?`, `note?` | `{ taskId, reused, statusSummary }` | 本地事务创建 + 幂等去重；删除额度扣次提示 |
| `start_applications` | 批量派工 | 写入 | `items: Array<StartApplicationInput>` | 逐项 `{ taskId, reused, error? }` | 批量派发独立投递任务，互不串档案 |
| `application_status` | 查询 | 只读 | `taskIds?`, `filter?` | 每个任务的四轴状态、等待原因、最近一步摘要 | 查询本地 SQLite 全部投递任务 |

> **v2 可选扩展工具**（需用户配置对应外部搜索/日历数据源，v1 不伪造离线可用）：`web_search`、本地日历日程、`interview_prep` 笔记工具。

---

## 3. 投递助手（`application`）浏览器工具契约

保留锦鲤已验证有效的 `observe → inspect_control → act → observe` 闭环，去除未在桌面端实际交付的实验性工具名，并强化 **Submit Hard-Guard**。

| 工具名 | 读写属性 | 输入要点 | 输出要点 | 安全与不变量约束 |
|---|---|---|---|---|
| `observe` | 只读 | `tabId?`, `includeBounds?`, `maxNodes?` | `{ tabId, url, title, generation, snapshot, truncated, spillId? }` | 密码字段值强制脱敏为 `[密码]`；每次成功调用刷新 `generation` 与短生命周期 `ref` |
| `candidates` | 只读 | `query`, `role?`, `limit?` | 匹配的候选控件列表（含 `ref`、标签、附近文本、状态） | 仅在当前 `generation` 内有效 |
| `inspect_control` | 只读 | `ref` | 控件完整属性、所属表单、是否只读/禁用、可见下拉选项预览、是否命中提交闸门 | 供消歧自定义下拉/日期/上传控件 |
| `screenshot` | 只读 | `tabId?`, `clip?`, `fullPage?` | 本地截图文件 ID + 尺寸/DPR（若模型支持 vision 则附带图像块） | 走主进程原生隐藏视图安全捕获与 DPR 归一化 |
| `act` | **写入** | `action: 'click'\|'fill'\|'select'\|'check'\|'scroll'\|'press'\|'upload'\|'navigate'`, `ref?`, `value?`, `materialId?`, `key?`, `point?`, `dy?` | `{ ok, readback?, changed?, nextActionHint }` | **核心安全闸门**：<br>1. 强制校验 `epoch` 与 `generation`；<br>2. `fill`/`select` 必须执行后回读比对；<br>3. 拒绝自动填写密码/验证码/OTP；<br>4. 拒绝点击提交按钮、表单内 `Enter`、跨 iframe 点击与未授权提交坐标；<br>5. `upload` 仅接受当前任务已授权的 `materialId` |
| `tabs` | 读/写 | `op: 'list'\|'select'\|'open'\|'close'`, `tabId?`, `url?` | 当前任务所属标签页列表与活动标签 | 严格限定当前 `taskId`；禁止关闭最后一个标签；URL 经 `browserUrl` 校验（仅 HTTP/HTTPS） |
| `network` | 只读 | `filter?`, `limit?` | 最近页面网络请求摘要（状态码、URL、耗时，不含敏感 Cookie/Auth 头） | 用于判断是否提交发包或接口报错，协助回执核验 |
| `read_spill` | 只读 | `spillId`, `offset?`, `limit?` | 超大观察结果或网络响应的分片读取 | 防止单次工具输出撑爆上下文 |
| `run`（受限） | **默认只读 / 受控** | `probe: 'dom_summary'\|'form_errors'\|'custom_control_state'`, `args?` | 声明式探针 JSON 结果 | **安全强化**：v1 禁止模型执行任意自由 JS 字符串（杜绝通过 `page.evaluate` 绕过 Submit Hard-Guard） |

---

## 4. 投递助手（`application`）业务与协作工具契约

| 工具名 | 分类 | 触发状态效果 | 输入要点 | 输出要点 | 与锦鲤原版对照 |
|---|---|---|---|---|---|
| `read_profile` | 资料读取 | 无 | `section?` | 本任务锁定的 `profileVersionId` 对应结构化档案 + 相关个人事实 | 只读任务冻结快照，不读全局切换后的新档案 |
| `read_material` | 资料读取 | 无 | `materialId`, `view?`, `page?` | 仅限当前任务已授权附件列表中的文件内容 | 禁止越权读取未授权本地文件 |
| `ask_user_question` | 事实补答 | 挂起等待；超时转 `waiting_user(missing_info)` | `questions: Array<{ questionId, prompt, options?, allowFreeText, saveToProfileDefault? }>` | `{ status: 'answered'\|'pending', answers? }` | 保留 `callId + questionId` 绑定与迟到答案机制 |
| `request_user_action` | 人工接管 | 持久化待办 + 锁定本轮 `attention` → 轮末转 `waiting_user` | `reason: 'login'\|'captcha'\|'manual_control'\|'upload'\|'other'`, `summary`, `instructions`, `targetTabId?` | `{ todoId, acknowledged: true }` | 调用后阻止同轮继续操作网页 |
| `capture_confirmation_screenshot` | 核对准备 | 记录确认证据截图 | `label`, `fullPage?` | `{ artifactId, path, sha256 }` | 供核对卡展示已填内容证据 |
| `report_filling_ready` | 填写里程碑 | 推进 `applicationStage = 'filling_ready'` | `filledSummary`, `missingItems[]`, `attachmentIds[]` | `{ recorded: true, stage: 'filling_ready' }` | 替代原 `report_application_service_completed`，**彻底移除计费副作用** |
| `request_submission_confirmation` | 最终核对 | 生成绑定 `contentHash` 的核对卡 + 锁定本轮 → `waiting_user(submission_confirmation)` | `jobTitle`, `company`, `keyFieldsSummary`, `missingItems[]`, `attachmentIds[]`, `screenshotArtifactIds[]`, `contentHash` | `{ confirmationId, status: 'pending' }` | v1 默认展示核对卡并引导用户在右侧网页亲自提交 |
| `request_manual_submission` | 手动提交引导 | 锁定本轮 → `waiting_user(manual_submit)` | `reason`, `instructions`, `screenshotArtifactIds[]` | `{ todoId, mode: 'manual_submit' }` | 明确区分“填好待人工提交”与“已提交成功” |
| `request_operation_confirmation` | 敏感操作确认 | 锁定本轮 → `waiting_user` | `operation: 'save_draft'\|'irreversible_step'`, `summary`, `contentHash` | `{ confirmationId, status: 'pending' }` | 区分普通保存/不可逆步骤与最终提交 |
| `report_submit_attempted` | 提交事实 | 推进 `applicationStage = 'submit_attempted'`, `outcome = 'unknown'` | `source: 'user_manual'\|'authorized_click'`, `evidenceNote` | `{ recorded: true }` | 替代原 `report_application_submitted`，防止重试重复提交 |
| `report_submission_result` | 回执核验 | 推进 `outcome = 'submitted_verified'` 或保持 `unknown`/`verifying` | `verified: boolean`, `receiptText?`, `receiptUrl?`, `screenshotArtifactId?` | `{ outcome, applicationStage }` | 替代原 `report_submission_success`；必须附带页面回执证据 |
| `update_task_details` | 元信息 | 更新任务标题/公司/岗位元信息 | `company?`, `jobTitle?`, `department?`, `deadline?` | `{ updated: true }` | 从招聘页面读取准确岗位名称后回写 |
| `remember_user_info` | 事实记忆 | 写入待审或已确认个人事实 | `key`, `value`, `confirmedByUser: boolean` | `{ factId }` | 仅保存用户明确确认的事实，禁止编造 |
| `report_job_unavailable` | 异常终止 | `outcome = 'job_unavailable'` | `reason`, `evidenceText` | `{ recorded: true }` | 岗位已下架/已截止/已投递过 |
| `search_site_memories` / `save_site_memory` | 本地经验 | 读写本地站点经验库 | `domain`, `query` / `domain`, `note`, `draft?` | 匹配的站点提示 / 本地经验条目 | 替代原远端 `search_memories` + `submit_skill_draft`，先落本地审阅 |

---

## 5. Skills 工具（按需加载）

| 工具名 | 读写属性 | 输入要点 | 输出要点 | 约束 |
|---|---|---|---|---|
| `skill_list` | 只读 | `domain?`, `tag?` | 匹配的 Skill 元数据列表（名称、简介、适用特征） | 仅返回索引，不返回全文 |
| `skill_load` | 只读 | `skillName` | 对应 `SKILL.md` 正文与版本号 | 按需按篇加载；Runtime 记录当前轮已加载清单，供上下文管理与审计 |
