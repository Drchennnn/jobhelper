---
name: ats-hotjob-wt
description: 大易经典版 / 央国企定制招聘站（*.hotjob.cn/wt/、job.chinatelecom.com.cn 等）JobHelper 原生适配手册：dy-form、saveSet 分块保存、Wdate 日期框与多附件核验规范。
domains: ["*.hotjob.cn", "job.chinatelecom.com.cn"]
dom_markers: ["dy-form", "saveSet", "Wdate", "mode400"]
---

# 大易经典版（`/wt/` / `dy-form`）操作手册（JobHelper 原生适配版）

> 适用范围：路径含 `/wt/`、模板含 `dy-form` / `saveSet` / `mode400` / `Wdate` 的大易经典版招聘网站（常见于电信、金融、制造等央国企校招系统）。若页面为 `/pb/` 或 `ant-select` 体系，请使用 `ats-hotjob`。

## 1. 登录与账号前置
1. 经典版站点常含图形验证码 + 账号密码或手机验证码登录，严禁自动填写密码或验证码；发现后立即调用 `request_user_action(reason="login")`。
2. 登录后先 `observe` 判断当前处于“岗位详情页”、“在线简历维护页”还是“投递确认页”，并调用 `update_task_details` 记录公司与岗位信息。

## 2. 分块保存机制（`saveSet`）与防丢数据
- 经典版简历往往按“基本信息 / 教育背景 / 实习经历 / 家庭成员 / 奖惩情况 / 附件上传”分节独立保存（`saveSet` 模式）。
- **逐节闭环**：每次只专注填写一个区块，填完立即核对该区块回读值；若该区块带有“保存本项 / 保存”按钮（非“提交简历/申请职位”），先 `inspect_control(ref)` 确认不是最终提交按钮后再点击保存，随后 `observe` 确认保存成功提示且页面已落盘，再进入下一区块。
- 切勿在未保存当前区块前直接切换左侧简历分节菜单，否则已填内容可能丢失。

## 3. 高频老旧控件处理
- **日期控件（`Wdate` / My97DatePicker）**：
  - 加载 `form-dates` 并用 `inspect_control(ref)` 检查 `readOnly` 属性；
  - 若 `readOnly === false`，优先按页面格式（常见 `YYYY-MM-DD` 或 `YYYY-MM`）调用 `act(action="fill", ref, value)` 并核对回读；
  - 若 `Wdate` 渲染在独立跨文档 iframe 中导致受控点击被 Submit Hard-Guard 拦截，立即调用 `request_user_action(reason="manual_control")` 请用户在右侧网页快速点选该日期字段。
- **多级选择与弹窗字典（学校、专业、籍贯、民族、政治面貌）**：
  - 原生 `<select>` 用 `act(action="select", ref, value)`；
  - 自定义弹窗或下拉用 `act(action="choose_option", ref, optionText="...", optionPath=[...])`。
- **敏感扩展必填项（家庭成员、政治面貌、生源地、身高体重、是否服从调剂等）**：
  - 档案快照中未提供的任何信息**绝对禁止编造**，统一汇总后通过 `ask_user_question` 向用户一次性确认。

## 4. 最终核对与人工提交
1. 通过 `run(probe="form_errors")` 与 `run(probe="dom_summary")` 核查各分节完整度（确保必填区块均显示已完成/无红字）。
2. 依次执行 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，引导用户在右侧真实网页亲自点击最终投递按钮。
3. 用户提交后只读 `observe` 核验回执或“已投递职位”列表，再调用 `report_submission_result`。
