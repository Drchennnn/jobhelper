---
name: form-dates
description: JobHelper 招聘站日期、年月控件与起止时间范围选择器手册：处理只读日期框、先选年再选月面板、至今选项与防误触提交规范。
domains: ["*"]
dom_markers: ["date-picker", "el-date", "ant-picker", "phoenix-calendar", "laydate", "Wdate"]
---

# 日期与年月控件操作规范（JobHelper）

## 1. 先检查再决定策略
1. 调用 `inspect_control(ref)` 核查日期输入框的 `readOnly`、`disabled`、`placeholder` 与当前 `value`。
2. **可编辑输入框（`readOnly === false`）**：
   - 严格按照 `placeholder` 或相邻示例格式（常见为 `YYYY-MM`、`YYYY/MM`、`YYYY.MM` 或 `YYYY-MM-DD`）调用 `act(action="fill", ref, value)`；
   - 检查 `readbackValue` 是否落盘；若组件在失焦时格式化或清空，随后轻点页面空白非按钮区域（或 `act(action="press", key="Tab")`）并 `observe` 复核。
3. **只读弹窗日历（`readOnly === true` 或点击才弹出面板）**：
   - 先调用 `act(action="click", ref)` 打开日期面板，随后 `observe` 或 `run(probe="custom_control_state")` 检查面板层级；
   - **严格遵循“先选年、再选月、最后选日”**：许多招聘站（如 Moka、Ant Design、北森）在未切换年份时直接点月份会落到当前年份或被禁用；
   - 对标准单层/多层日期浮层，也可在打开或触发时使用 `act(action="choose_option", ref, optionPath=["2024", "9月"])` 等受控路径选择；
   - 起止时间范围控件（RangePicker）需连续点击开始年月与结束年月，确认面板自动关闭后再 `observe` 回读起止双值。

## 2. “至今 / 在读 / 在职”处理
- 优先查看字段旁是否存在“至今 / 目前在读 / 在职”复选框或开关；若有，优先勾选该项而非强行填写未来日期。
- 预计毕业时间应按档案中的真实毕业年月填写，不可用“至今”替代。

## 3. 防误触与排障红线
- **严禁在表单日期输入框内按 `Enter` 键**，执行层 Submit Hard-Guard 会拦截表单内 `Enter` 以防止隐式触发提交。
- 若关闭日期浮层需注意：部分站点的 `Escape` 键可能同时关闭外层编辑抽屉或清空未保存草稿，优先点选合法日期项关闭浮层。
- 如遇到极老旧 iframe 日历插件（如跨文档只读控件）无法通过受控动作落值，直接调用 `request_user_action(reason="manual_control")` 请用户在右侧网页手选日期。
