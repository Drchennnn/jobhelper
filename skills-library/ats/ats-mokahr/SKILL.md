---
name: ats-mokahr
description: MokaHR 招聘系统（*.mokahr.com）JobHelper 原生适配手册：登录态失效识别、sd-* 自定义下拉与先年再月日期面板、懒刷新必填校验及多段经历填写规范。
domains: ["*.mokahr.com"]
dom_markers: ["sd-Select", "sd-Input", "sd-basic", "sd-DatePicker"]
---

# MokaHR 招聘系统操作手册（JobHelper 原生适配版）

> 适用范围：常见 Moka 校招/社招门户（`app.mokahr.com`、`*.mokahr.com`）。不同企业主题略有差异，操作前请始终先 `observe`。

## 1. 会话有效性与登录接管
1. Moka 部分企业站允许未登录浏览岗位，但进入投递表单或点击申请时会跳转登录或触发会话失效提示（常见错误码/提示如重新登录）。
2. 一旦发现登录弹窗、手机号验证码、邮箱验证码或扫码登录入口，立即调用 `request_user_action(reason="login")`，交由用户在右侧网页完成登录。

## 2. 简历解析与附件顺序
- 若页面顶部提供“上传简历智能填充”区域，优先上传已授权的简历 PDF（`act(action="upload", ref, materialId)`），待解析结果稳定落地并重新 `observe` 后，再统一审计与修正每个区块，防止解析回填覆盖手动填写的内容。
- 注意核对附件区是否还需要单独上传成绩单/作品集等补充材料，严禁上传未经任务授权的材料 ID。

## 3. Moka 高频控件（`sd-*` 系列）
- **自定义下拉与远程搜索（`sd-Select`）**：
  - 使用 `act(action="choose_option", ref, optionText="目标选项", searchQuery="关键词")`；
  - 学校、城市、专业等选项往往需要输入 2–4 个关键词等待异步候选列表出现后再匹配点击；
  - 选完后必须 `observe` 核实回显文本已生效。
- **日期面板（`sd-DatePicker`）**：
  - 配合 `form-dates` 使用，**务必先选择年份再选择月份**，避免在默认年份下误点月份导致时间错位或禁用；
  - 若存在“至今”开关，优先勾选“至今”。
- **多段经历区块（教育/实习/项目）**：
  - Moka 常见按卡片展开编辑的模式：每次新增一段经历后立即 `observe` 获取新卡片 `ref`，逐项填完并回读后再新增下一段。
- **懒刷新必填提示**：
  - Moka 部分字段的红色必填报错仅在失焦或整表校验时才会刷新清除；使用 `run(probe="form_errors")` 查看当前真实未满足的必填项，逐项补齐后再复查一次 `form_errors`。

## 4. 核对卡与回执核验
1. 缺失事实（如内推码、意向部门、可实习时长、期望城市顺位）一律通过 `ask_user_question` 询问用户，不可擅自填默认值。
2. 全部必填校验通过后，依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，引导用户在右侧真实网页核对后点击最终提交。
3. 用户提交后只读 `observe` 核实成功页/申请状态页，拿到确凿回执文字后再调用 `report_submission_result(verified=true)`；若网络异常或结果不明，保持 `verified=false` 待核验，严禁重复点击提交。
