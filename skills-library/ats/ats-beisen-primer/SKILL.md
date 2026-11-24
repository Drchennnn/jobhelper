---
name: ats-beisen-primer
description: 北森招聘系统（*.zhiye.com）JobHelper 适配入门手册：登录页扫码接管、phoenix-* 组件识别与分块填写回读规则。
domains: ["*.zhiye.com"]
dom_markers: ["phoenix-select", "phoenix-calendar", "phoenix-input"]
---

# 北森招聘系统操作手册（JobHelper 适配版）

1. **登录识别**：URL 包含 `/login` 或页面出现微信扫码/手机号验证码入口时，立即调用 `request_user_action(reason="login")`，等待用户手动登录并点击「已处理，请检查」。
2. **字段填写**：按区块逐项 `observe → act → observe` 填写基本信息、教育经历、实习/项目经历；遇到 `phoenix-calendar` 配合加载 `form-dates`。
3. **最终提交**：北森提交后可能触发极验验证；首版全部通过 `report_filling_ready` + `request_submission_confirmation` 交由用户在右侧网页核对后亲自点击提交，随后只读核验回执。
