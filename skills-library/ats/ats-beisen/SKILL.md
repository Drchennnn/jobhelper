---
name: ats-beisen
description: 北森招聘系统（*.zhiye.com）JobHelper 原生适配手册：登录扫码接管、phoenix-* 控件与日历处理、简历解析覆盖风险、无自动保存提示及提交后核验规范。
domains: ["*.zhiye.com"]
dom_markers: ["phoenix-select", "phoenix-calendar", "phoenix-input", "phoenix-button"]
---

# 北森招聘系统操作手册（JobHelper 原生适配版）

> 适用范围：常见校招/社招北森站点（`*.zhiye.com`）。实际页面结构因企业定制模板而异，所有动作以当前页 `observe` 与 `inspect_control` 实时结果为准。

## 1. 登录与前置检查
1. 进入页面后先 `observe` 检查 URL 与标题：若包含 `/login`、手机号验证码登录或微信扫码弹窗，立即调用 `request_user_action(reason="login")`，请用户在右侧网页完成登录并点击「已处理，请检查」。
2. 若页面提示“职位已下架 / 投递已截止 / 已投递该职位”，核对页面文字证据后调用 `report_job_unavailable`。
3. 成功进入表单页后，及时调用 `update_task_details` 记录准确的公司与岗位名称。

## 2. 简历附件上传与自动解析注意事项
- 北森常见“上传简历自动解析”入口会异步回填并**覆盖下方已填好的基本信息与经历区块**。
- **推荐顺序**：先完成授权 PDF 简历上传（`act(action="upload", ref, materialId)`）并等待解析完成（重新 `observe` 确认解析提示消失），再逐项核对并补齐/修正所有字段，避免重复劳动或被覆盖。

## 3. 北森高频控件处理（`phoenix-*`）
- **无自动保存特性**：多数北森表单在切换页面或刷新前不会自动保存草稿；如页面提供“暂存/保存草稿”按钮，可在关键分块完成后提示或按需操作，避免触发无意刷新。
- **下拉与搜索框（`phoenix-select`）**：
  - 优先使用 `act(action="choose_option", ref, optionText="...", searchQuery="...")`；
  - 省市区、院校、专业等多级联动项传入 `optionPath` 按级选择；
  - 每次选完后 `observe` 确认选中标签已显示在输入框内，而非停留在未选中输入态。
- **日期选择器（`phoenix-calendar`）**：配合加载 `form-dates`，优先用 `inspect_control` 判断是否只读，先切年份再选月份，严禁按 `Enter`。
- **动态区块（教育/实习/项目/语言/获奖）**：
  - 检查已有空卡片数量，不够时点击该区块“新增/添加”按钮；
  - 填完每条经历后检查该区块是否有独立“保存”小按钮（与最终提交区分），若有则先 `inspect_control` 确认非最终提交后再点击保存。

## 4. 提交前核验与人工提交
1. 运行 `run(probe="form_errors")` 检查全页必填红字提示与未闭合校验错误；若有缺失真实信息，使用 `ask_user_question` 补齐。
2. 依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`。
3. 北森点击最终提交后常弹出极验/滑块验证码：首版全程由用户在右侧网页亲自点击提交并完成验证；用户回报已提交后，执行只读 `observe` 核验“投递成功 / 申请编号 / 我的申请记录”再调用 `report_submission_result`。
