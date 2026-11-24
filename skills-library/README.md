# JobHelper Local Skills Library

本目录存放 JobHelper 受管理的本地按需 Skills 知识库（**与工具执行层 `@jobhelper/tools` 解耦**）。

## 目录分层

- `ats/`：招聘系统站点手册（如 `ats-beisen`、`ats-mokahr`、`ats-feishu`、`ats-hotjob`、`ats-iguopin` 等），在检测到匹配域名或 DOM 特征后按需加载。
- `controls/`：招聘站通用表单/日期/上传控件手册（如 `form-controls`、`form-dates`、`form-uniapp`），作为站点手册之外的通用补充。
- `drafts/`：投递过程中产出的本地改进草稿，经用户在设置页审阅确认后方可合入正式库。

## 适配原则（M3 / M6）

1. **禁止整包盲拷贝原版指令**：参考材料中的原始 Skills 正文依赖旧 Runtime 工具名与私有行为，导入本目录前必须逐篇核对 JobHelper 工具名称（`observe` / `inspect_control` / `act` / `request_user_action` 等）、参数契约与动作读回条件。
2. **验证码类策略**：JobHelper v1 默认将登录与图形/滑块验证码交由人工接管，不默认启用自动解题工具。
3. **按需加载**：Runtime 仅向模型暴露元数据索引（`skill_list`），单轮仅加载当前页面实际命中的 1~3 份正文（`skill_load`）。
