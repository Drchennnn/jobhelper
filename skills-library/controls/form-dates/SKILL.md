---
name: form-dates
description: JobHelper 招聘站日期、年月控件与起止时间选择器手册：处理只读日期框、年月面板及回读核对。
domains: ["*"]
dom_markers: ["date-picker", "el-date", "ant-picker", "phoenix-calendar", "laydate"]
---

# 日期与年月控件操作规范（JobHelper）

1. 先用 `inspect_control(ref)` 检查日期输入框是否 `readOnly`。
2. 若可编辑，优先按页面 placeholder 提示格式（如 `YYYY-MM` 或 `YYYY-MM-DD`）调用 `act(fill)` 并验证回读值。
3. 若为只读弹窗日历，先 `act(click, ref)` 打开面板，再 `observe` 定位年份、月份与具体日期按钮依次点击，完成后重新 `observe` 确认输入框已落值。
4. 切勿在日期输入框内发送 `Enter` 键，防止误触表单提交。
