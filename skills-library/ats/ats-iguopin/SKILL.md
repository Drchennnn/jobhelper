---
name: ats-iguopin
description: 国聘网（*.iguopin.com）JobHelper 原生适配手册：共享在线简历完整度核查、“无××”区块开关、ant-picker 日期与多证书附件上传及人工提交核验。
domains: ["*.iguopin.com", "iguopin.com"]
dom_markers: ["apply-btn", "item-section-tpl", "ant-picker", "iguopin"]
---

# 国聘网招聘系统操作手册（JobHelper 原生适配版）

> 适用范围：国聘网（`www.iguopin.com`、`*.iguopin.com`）校招与社招岗位投递流程。

## 1. 登录与岗位可用性核对
1. 国聘投递前需完成手机号验证码/扫码登录；遇到登录弹窗或跳转登录页时立即调用 `request_user_action(reason="login")`。
2. 若岗位页显示“已结束 / 停止招聘 / 已投递”，保存页面文字证据并调用 `report_job_unavailable`。

## 2. 共享在线简历特性与“无××”开关
- **全站共享在线简历**：国聘的在线简历在多岗位间共享，修改在线简历会影响后续投递；因此填写或修改简历字段前，务必严格对照当前任务锁定的 `profileVersionId` 快照与用户已确认事实，不要随意删除已有真实经历。
- **完整度缺项检查**：国聘投递前常校验未填写的必填板块（类似缺失板块提示列表）。先用 `run(probe="dom_summary")` 与 `run(probe="form_errors")` 盘点所有带必填星号或未完成标记的板块（`item-section-tpl`）。
- **“无××”开关处理**：对工作经历、实习经历、项目经历、获奖经历、资格证书等板块，若候选人档案中确实没有对应经历，优先勾选该板块的“无工作经历 / 无实习经历 / 无获奖情况”开关（勾选前可结合档案事实核实；不确定时用 `ask_user_question` 询问用户），避免留空导致完整度校验不通过。

## 3. 控件填写与多附件上传
- **下拉与多级选择器**：使用 `act(action="choose_option", ref, optionText="...", searchQuery="...", optionPath=[...])` 并 `observe` 回读确认。
- **日期选择（`ant-picker`）**：加载 `form-dates`，使用 `inspect_control(ref)` 判断只读性，按先年再月顺序选择并回读起止年月，严禁按 `Enter`。
- **多证书与简历附件**：支持使用 `act(action="upload", ref, materialId)` 上传主简历，或在多文件上传控件传入已授权的 `materialIds` 批量挂载成绩单/证书，核对回读文件名准确无误。

## 4. 最终核对与人工提交
1. 再次运行 `run(probe="form_errors")` 确认在线简历完整度达标且无表单错误。
2. 依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，引导用户在右侧真实网页核对岗位与简历信息后亲自点击投递按钮（如 `apply-btn` / “确认投递”）。
3. 用户提交后执行只读 `observe` 检查“投递成功 / 已投递”回执证据，再调用 `report_submission_result`。
