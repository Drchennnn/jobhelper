# Mock ATS Fixture（Gate 1 验收测试夹具规划）

本目录将在 **M5（Gate 1）** 实现一个零外部依赖、可一键重置的本地 HTTP 招聘表单测试站点，用于端到端验收 [docs/ACCEPTANCE_GATE1.md](../../docs/ACCEPTANCE_GATE1.md)。

## 计划路由与故障注入能力

- `POST /reset`：清空会话、表单草稿与提交记录。
- `GET /login`：模拟登录页（账号、密码框、模拟图形验证码），验证自动填充拒绝与人工接管。
- `GET /apply/job-001` & `GET /apply/job-002`：包含文本输入、原生/自定义下拉、日期控件、多行经历、必填缺失问题、PDF 简历上传、`保存草稿`与`最终提交`按钮。
- `POST /api/submit?mode=success|timeout|error`：
  - `success`：正常展示含岗位名与申请编号的官网回执页；
  - `timeout`：服务端记录提交但模拟断连超时无回执，验证任务停留在 `verifying / unknown` 且绝不自动重投；
  - `error`：模拟服务端校验失败。
