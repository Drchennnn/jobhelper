---
name: form-controls
description: JobHelper 通用招聘表单控件手册：处理标准文本、原生下拉、自定义下拉搜索、单选/复选与简历附件上传的观察-填写-回读规范。
domains: ["*"]
dom_markers: ["ant-select", "el-select", "select2", "form"]
---

# 通用招聘表单控件操作规范（JobHelper）

## 1. 标准闭环
1. 先调用 `observe` 获取当前页面 `generation` 与有效元素 `ref`。
2. 遇到自定义下拉或模糊控件时，先用 `inspect_control(ref)` 核实标签、禁用状态与是否命中提交闸门。
3. 每次 `act(fill)` 或 `act(select)` 后核对返回的 `readbackValue`；如出现异常或页面联动变化，重新 `observe`。

## 2. 禁止越线项
- 遇到密码框、短信验证码、图形/滑块验证码：立即调用 `request_user_action(reason="login"|"captcha")`，禁止尝试填写。
- 遇到档案缺失的必填事实：调用 `ask_user_question`，禁止编造任何经历、成绩或意愿。
- 所有必填字段填完并回读无误后，依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，由用户在右侧网页亲自点击最终提交。
