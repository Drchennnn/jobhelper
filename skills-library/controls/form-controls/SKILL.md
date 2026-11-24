---
name: form-controls
description: JobHelper 通用招聘表单控件手册：涵盖标准文本、原生下拉、自定义搜索/级联下拉（choose_option）、单选复选、动态增删区块与多附件上传的观察-填写-回读规范。
domains: ["*"]
dom_markers: ["ant-select", "el-select", "select2", "sd-Select", "phoenix-select", "form"]
---

# 通用招聘表单控件操作规范（JobHelper）

## 1. 标准执行闭环
1. **先观察再操作**：调用 `observe` 获取当前页面 `generation` 与有效元素 `ref`；页面滚动、点击弹窗或触发联动后旧 `ref` 自动失效，必须重新 `observe`。
2. **先探测再落值**：对不确定的自定义控件调用 `inspect_control(ref)`，核实标签、禁用/只读状态、当前值以及是否命中 `Submit Hard-Guard`。
3. **只读排障探针**：遇到表单校验报错或折叠项遗漏时，使用受控只读探针 `run(probe="form_errors")`、`run(probe="dom_summary")` 或 `run(probe="custom_control_state")`，禁止尝试任意脚本求值。

## 2. 分类控件策略
- **标准输入框 / 文本域**：使用 `act(action="fill", ref, value)`，完成后检查返回的 `readbackValue` 是否与预期一致。
- **原生 `<select>`**：使用 `act(action="select", ref, value)` 并核对回读值。
- **自定义下拉 / 搜索下拉 / 多级联选择器（省市区、学校、专业、岗位类别）**：
  - 优先使用 `act(action="choose_option", ref, optionText="目标项")`；
  - 若下拉内含搜索过滤框，传入 `searchQuery="关键词"`；
  - 若为多级联菜单（如 `["广东省", "深圳市", "南山区"]`），传入 `optionPath=["广东省", "深圳市", "南山区"]` 按层级点击并核对回读结果；
  - 若控件结构极其特殊无法自动命中，调用 `screenshot` 视觉确认后再决策，必要时交由 `request_user_action(reason="manual_control")` 处理。
- **单选 / 复选 / 同意隐私协议**：先用 `inspect_control(ref)` 确认不是最终提交按钮，再使用 `act(action="check", ref)` 或 `act(action="click", ref)`；隐私/条款类确认若涉及敏感声明或无法判断意愿，使用 `ask_user_question` 询问用户。
- **动态增删区块（教育/实习/项目/获奖经历）**：
  - 按档案条数逐段点击“添加/新增”按钮，每次新增后先 `observe` 确认新区块 `ref` 已挂载，再按区块顺序逐项填写；
  - 优先倒序或按页面提示顺序（通常从最近经历到早期经历）填入，填写完当前区块再展开下一区块，避免 DOM 重排导致 `ref` 错位。
- **简历与多证书附件上传**：
  - 仅允许传入当前任务已授权的 `materialId`（单文件）或 `materialIds`（多文件 `<input type="file" multiple>`）调用 `act(action="upload", ref, ...)`；
  - 校验回读文件名与授权材料一致，并等待页面解析/上传进度条稳定后再继续，避免解析结果异步覆盖已填字段。

## 3. 安全红线与人工移交
- **禁止自动填写敏感字段**：遇到密码、短信验证码、图形/滑块验证码，立即调用 `request_user_action(reason="login"|"captcha")`。
- **禁止编造缺失事实**：遇到档案快照与个人事实库中均缺失的必填字段（如期望薪资、可到岗日期、是否接受调剂），立即调用 `ask_user_question`，保存确认答案后再继续。
- **最终提交闸门**：所有必填项填完并通过 `run(probe="form_errors")` 确认无阻断性错误后，依次调用 `capture_confirmation_screenshot`、`report_filling_ready` 与 `request_submission_confirmation`，由用户在右侧真实网页核对后亲自点击最终提交。
