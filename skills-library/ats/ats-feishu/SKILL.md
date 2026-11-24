---
name: ats-feishu
description: 飞书招聘 / 字节系官网（*.jobs.feishu.cn、jobs.bytedance.com）JobHelper 原生适配手册：atsx-*/ud__* 组件识别、无自动草稿风险、Escape 误清空规避与最终提交核验。
domains: ["*.jobs.feishu.cn", "jobs.bytedance.com"]
dom_markers: ["atsx-", "ud__", "formily-item-", "atsx-select"]
---

# 飞书招聘系统操作手册（JobHelper 原生适配版）

> 适用范围：飞书招聘门户（`*.jobs.feishu.cn`）及字节跳动等采用 `atsx-*` / `ud__*` / Formily 组件体系的招聘官网。

## 1. 登录与投递资格检查
1. 飞书招聘通常需要手机号短信验证码或飞书扫码登录；检测到登录页或登录弹窗时立即调用 `request_user_action(reason="login")`。
2. 若页面提示“投递次数已达上限 / 该职位已关闭 / 已投递”，收集页面证据文本后调用 `report_job_unavailable`。

## 2. 核心防踩坑规则
- **无自动云端草稿风险**：部分飞书投递表单刷新或意外返回后会丢失当前页未提交内容；切勿随意调用 `act(action="navigate")` 离开当前表单页。
- **谨慎使用 `Escape` 键**：在 `atsx-*` / `ud__*` 浮层或内联编辑抽屉中发送 `Escape` 可能导致整个编辑抽屉关闭或清空刚输入内容；关闭下拉优先选择目标选项或点击安全空白区，避免无故按 `Escape`。
- **简历上传与智能解析**：
  - 优先在表单顶部上传授权简历（`act(action="upload", ref, materialId)`），等待智能解析完毕并重新 `observe`；
  - 飞书解析有时会把教育经历时间或学历层次解析错位，务必对照锁定档案快照逐项回读核正。

## 3. 组件交互策略（`atsx-*` / `ud__*` / `formily-item-*`）
- **下拉与多选标签（`atsx-select` / `ud__select`）**：
  - 使用 `act(action="choose_option", ref, optionText="...", searchQuery="...")`；
  - 若为多选意向城市/岗位志愿，分次调用 `choose_option` 或在展开后逐项勾选并 `observe` 确认已生成的 tag 数量与顺序。
- **日期范围控件**：
  - 加载 `form-dates`，通过 `inspect_control(ref)` 判断是否为只读面板；起止时间依次选定年份与月份并回读双端值。
- **表单错误扫描**：
  - 填写完成后执行 `run(probe="form_errors")` 检查 `formily-item-explain-error` 或红色校验提示，定位所有遗漏必填项。

## 4. 核对卡与只读回执
1. 若遇到内推码、是否接受调剂、意向工作地排序、开源主页等档案未记录项，通过 `ask_user_question` 向用户确认。
2. 确认无报错后，依次执行 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，由用户在右侧真实网页完成最终提交。
3. 用户反馈已提交后，执行只读 `observe` 核实“投递成功 / 个人中心-投递记录”页面证据，再调用 `report_submission_result`。
