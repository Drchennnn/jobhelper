# ADR-0001：采用 Electron `WebContentsView` + 任务级 `ScopedCdpBridge` 驱动本机招聘浏览器

- **状态**：已采纳（M0 基线）
- **日期**：2026-11-24

## 背景
JobHelper 需要让用户在同一桌面窗口中实时观看助手填写网申，并随时一键接管操作真实招聘网页（处理登录、扫码、验证码与最终提交），同时允许多个投递任务在后台并行排队或执行且互不越权干扰。

## 决策
1. 使用 **Electron `BrowserWindow` + 原生 `WebContentsView`** 承载每个任务的真实招聘标签页，而不是 `<webview>`、iframe 或云端远程桌面串流。
2. **禁止开启 Chromium 全局 `--remote-debugging-port`**。主进程实现任务作用域的 `ScopedCdpBridge`（本机随机端口 WebSocket + ephemeral token + 每帧校验 `taskId + epoch`），经 Electron 原生 `webContents.debugger` 仅向当前任务暴露其所属标签页。
3. 同一用户身份下的任务默认共享招聘站点登录态分区（`persist:jobhelper-<browserProfileId>`）；多账号场景通过显式选择不同 `browserProfileId` 隔离，不默认让每个任务重新登录。
4. 为兼容多附件上传（如一次上传多份 PDF/证书 base64 编码），WebSocket `maxPayload` 默认设为 `80 MiB`。

## 权衡与后果
- **收益**：消除云浏览器和远程画面串流成本；用户接管零延迟操作原生页面；任务间 CDP 硬隔离；停止任务可毫秒级断链并拒绝迟到请求。
- **代价**：主进程需负责右侧浏览器槽位（Browser Slot）与原生视图的几何矩形同步、窗口缩放与弹窗遮挡协调；需要仔细处理隐藏视图截图时的合成帧刷新与 DPR 归一化。
