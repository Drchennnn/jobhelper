---
name: ats-hotjob
description: 大易 / WeCruit 现代版招聘站（*.hotjob.cn 的 /pb/ 与 /mc/ 路径）JobHelper 原生适配手册：Ant Design v3 控件、跨标签自动保存覆盖风险、级联选择与回执核验。
domains: ["*.hotjob.cn"]
dom_markers: ["wecruit", "ant-select", "am-list", "ant-cascader"]
---

# 大易 / WeCruit 招聘系统操作手册（现代版 `/pb/` & `/mc/`）

> 适用范围：大易 WeCruit 现代版招聘门户（常见路径包含 `/pb/` 或 `/mc/`，组件多基于 Ant Design v3 / Antd Mobile）。若页面出现 `/wt/`、`dy-form`、`saveSet` 或 `Wdate` 标识，请改用 `ats-hotjob-wt`。

## 1. 登录与跨标签覆盖警告
1. 发现手机号验证码、微信扫码或图形验证码登录页时，立即调用 `request_user_action(reason="login")`。
2. **跨标签自动保存覆盖风险**：WeCruit 部分版本每约 60 秒向服务端自动同步在线简历草稿；请勿同时在多个标签页编辑同一账号的在线简历，保持单任务单页签顺序填写。

## 2. 控件交互规范（`ant-select` / `ant-cascader` / `am-list`）
- **标准与搜索下拉（`ant-select`）**：
  - 使用 `act(action="choose_option", ref, optionText="...", searchQuery="...")`；
  - Antd v3 的下拉列表挂载在页面尾部 portal 中，若手动 `click` 展开后再 `observe`，注意在快照末尾查找 `option` / `menuitem` 节点。
- **省市区 / 专业级联选择（`ant-cascader`）**：
  - 传入 `act(action="choose_option", ref, optionPath=["省", "市", "区"])` 按级点选，并 `observe` 确认显示值完整。
- **日期控件（`ant-calendar-picker`）**：
  - 加载 `form-dates`，使用 `inspect_control(ref)` 判断只读性，按先年再月顺序选择，严禁发送 `Enter`。
- **移动端适配页（`/mc/` + `am-list`）**：
  - 某些行项需要点击整行进入子浮层选择再点击浮层“确定”按钮；每次点击“确定”前用 `inspect_control` 核实其属于当前选择器而非页面最终提交按钮。

## 3. 多段经历与附件
- 教育、实习、项目经历通常分模块保存：每个模块填完后可先查看是否存在本模块“保存”按钮，保存后 `observe` 确认列表已出现刚填记录，再继续下一模块。
- 上传授权 PDF 简历与补充证书（成绩单/英语证书等）时，使用 `act(action="upload", ref, materialId)` 或 `materialIds` 并核对回读文件名。

## 4. 核对卡与人工提交
1. 使用 `run(probe="form_errors")` 排查 `ant-form-explain` / `has-error` 校验错误。
2. 缺失必填项一律通过 `ask_user_question` 向用户核实，不猜测。
3. 完成后依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，交由用户在右侧网页亲自点击最终提交并只读核验回执。
