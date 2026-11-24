# JobHelper Gate 1 黄金闭环与安全边界验收报告

- **验收日期**：2026-11-24
- **验收分支**：`feat/m5-gate1-acceptance`
- **复现命令**：`npm run test:gate1`（完整回归：`npm test`）
- **测试夹具**：[fixtures/mock-ats/server.ts](../fixtures/mock-ats/server.ts) · [fixtures/mock-ats/test/gate1-acceptance.test.ts](../fixtures/mock-ats/test/gate1-acceptance.test.ts)

---

## 一、主路径验收结果（G1-01 ~ G1-08）

| 编号 | 验收场景 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| **G1-01** | BYOK 模型配置、三段探测（含 `stream_options` 400 自动降级）、虚构档案与测试 PDF 导入 | **PASS** | `streaming=true`、`toolCalling=true`、`vision=true`；密钥仅存凭据库，未入 SQLite |
| **G1-02** | 创建 `job-001` 任务锁定不可变档案快照与授权 PDF | **PASS** | `profileVersionId` 锁定，页面自动跳转至 `/login` |
| **G1-03** | 登录页只读观察、密码脱敏 `[密码]`、拒绝自动填密码、`request_user_action(login)` | **PASS** | `SUBMIT_GUARD_BLOCKED`；四轴状态：`waiting_user / login / opened / not_submitted` |
| **G1-04** | 人工登录后点击「已处理，请检查」，新 `epoch` 观察并完成文本填写、下拉选择与 PDF 上传回读 | **PASS** | 姓名/城市回读一致，`DOM.setFileInputFiles` 上传并保留真实文件名 `LinXinghe_Resume.pdf` |
| **G1-05** | 缺失字段「是否接受短期出差」触发结构化问题卡并实时回传 | **PASS** | `ask_user_question` 按 `callId + questionId` 接回用户回答并填入表单 |
| **G1-06** | 人工接管、旧 `epoch` 失效、用户改值为「林星河（人工修改版）」、恢复后准确读回新值 | **PASS** | 旧 `epoch` 调用抛出租约失效错误；恢复后读回人工新值，未覆盖回旧值 |
| **G1-07** | 截图证据、`report_filling_ready`、`request_submission_confirmation` | **PASS** | 四轴状态：`waiting_user / submission_confirmation / filling_ready / not_submitted`（绝不误标已投递） |
| **G1-08** | 人工在网页亲自提交（`mode=success`），只读检查回执 `APP-2026-0001` 并核验结果 | **PASS** | Mock ATS 精确记录 1 笔提交；任务收敛为 `closed / none / done / submitted_verified`，岗位进度同步为 `submitted_verified` |

---

## 二、安全与异常边界验收结果（G1-S01 ~ G1-S10）

| 编号 | 边界/故障注入项 | 状态 | 关键验证结论 |
| --- | --- | --- | --- |
| **G1-S01** | 接管后迟到旧 `epoch` 动作注入 | **PASS** | 100% 拒绝并抛出租约过期错误 |
| **G1-S02** | Submit Hard-Guard 全路径阻断（ref 点击 / 表单 `Enter` / 坐标点击 / 任意脚本） | **PASS** | 4 条路径全部拦截，Mock ATS 提交计数保持 `0` |
| **G1-S03** | 核对卡展示后人工接管并恢复 | **PASS** | 原 `confirmationId` 自动置 `invalidated` |
| **G1-S04** | 提交回执超时（`mode=timeout` HTTP 504） | **PASS** | 停留在 `waiting_user / result_check / verifying / unknown`，Mock ATS 提交计数保持 `1`，绝不自动重投 |
| **G1-S05** | `running` 状态强退重启恢复 | **PASS** | 自动恢复为 `interrupted`，`unknown` 任务保持待核验，零写操作重放 |
| **G1-S06** | 问题卡超时后迟到补答 | **PASS** | `expired_pending` 回答回挂原 `questionId` 并重入队 |
| **G1-S07** | 切换全局默认档案 B | **PASS** | 既有 `job-001` 仍锁定档案 A 快照，新建 `job-002` 使用档案 B |
| **G1-S08** | 重复开始同一未完成岗位（含 `utm_source` 跟踪参数） | **PASS** | 幂等复用原 `taskId` |
| **G1-S09** | `job-001` 与 `job-002` 并行隔离 | **PASS** | 档案快照与任务级 CDP `Target.getTargets` 互不可见 |
| **G1-S10** | BYOK 429 限流错误 | **PASS** | `runTaskTurnInKernel` 收敛为 `model_error` 并返回真实限流提示，保留历史进度 |

---

## 三、Gate 1 验收期间发现并修复的真实缺陷

1. **受管材料上传文件名修复**：`LocalMaterialService` 原将材料落盘为 `materials/<uuid>.pdf`，导致浏览器 `DOM.setFileInputFiles` 上传时回读及站点收到的文件名为 UUID。现已改为 `materials/<uuid>/<sanitizedFileName>`，既防止同名覆盖，又保证招聘官网收到真实简历文件名。
2. **真实桌面联调闭环补全**：补齐 `OpenAiCompatibleAdapter` 对不支持 `stream_options` 网关的 400 自动降级、`user_message` 消费游标注入、`onRunFinished` 正常结束/出错状态收敛，以及 `ask_user_question` 实时回答直连回传。

---

## 四、用本机已启动桌面端 + 真实模型实测指引

如需用你已在桌面端配置好的 **DeepSeek Flash 10.12 多模态** 亲自体验完整桌面流程：
1. 重建并重启桌面端使 M5 修复生效：`npm run build && npm --workspace @jobhelper/desktop run build && npm run dev:desktop`
2. 另开一个终端启动本地可重置测试站：`npm run mock-ats`（默认监听 `http://127.0.0.1:4100`）
3. 在桌面端粘贴 `http://127.0.0.1:4100/apply/job-001` 创建任务，右侧网页输入测试密码 `123456`、图形验证码 `8848` 体验完整人机协同网申闭环。
