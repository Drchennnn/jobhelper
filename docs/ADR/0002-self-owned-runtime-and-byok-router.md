# ADR-0002：自建轻量 TypeScript Agent Runtime 与 BYOK 模型适配层

- **状态**：已采纳（M0 基线）
- **日期**：2026-11-24

## 背景
参考对象使用闭源/候选版的 `@deepseek-ai/dsh`（DeepSeek Harness）作为子进程运行框架，并深度耦合官方模型路由、计费回合与远端状态镜像。JobHelper 的核心产品定位是 BYOK（用户自带任意兼容模型 API）和本地可控执行。

## 决策
1. **自建轻量、可测试的 TypeScript Agent Runtime（`@jobhelper/runtime`）** 运行在共享 Agent Worker 进程内，为每个 `taskId` 维护独立运行实例与上下文状态。
2. 抽象 **`@jobhelper/model-router`** 统一适配 OpenAI-compatible、Anthropic、Gemini 等协议，将流式增量（text/reasoning）、Tool Calling、Vision 输入、AbortSignal 取消、Usage 计量和错误分类归一化。
3. 强制提供**模型能力探测**（`streaming`、`tool_calling`、`vision`），对无视觉模型自动走纯可访问性树模式，对无工具调用模型拒绝启动投递任务。
4. 工具层（`@jobhelper/tools`）保持协议无关：内置 Runtime 直接进程内调用 `ToolRegistry`，可选 `@jobhelper/mcp-adapter` 将同一份 `ToolRegistry` 包装为本机 Streamable HTTP MCP，避免重复实现。

## 权衡与后果
- **收益**：无第三方专有 Harness 锁定；完全掌控 `epoch` 取消边界、`ask_user_question` 迟到答案回挂、过期页面快照裁剪与按需 Skills 注入；显著降低每任务子进程内存开销。
- **代价**：需要自行维护主流 BYOK 提供商的流式/工具调用边角兼容测试矩阵（已在 M1 与 M6 纳入验证）。
