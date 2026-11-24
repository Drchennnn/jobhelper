# JobHelper 本地数据目录、备份迁移与 Windows 构建打包指南

> 本文档说明 JobHelper 桌面端在 Windows 环境下的数据存储布局、安全备份与换机迁移步骤，以及生产构建与安装包打包流程。

---

## 1. Windows 本地数据目录结构

JobHelper 为严格 **Local-First（本地优先）** 桌面应用，所有业务状态、不可变档案快照、上传附件、截图证据与凭据均保存在本机用户目录下，不依赖任何云端服务器。

默认数据根目录（Electron `app.getPath('userData')`）：

```text
%APPDATA%\@jobhelper\desktop\
├── jobhelper.db            # SQLite 业务主数据库（WAL 模式，单一业务真相）
├── jobhelper.db-wal        # SQLite WAL 日志（运行期间存在）
├── jobhelper.db-shm        # SQLite 共享内存索引（运行期间存在）
├── credentials.enc.json    # BYOK 模型 API Key 密文存储（Windows DPAPI / safeStorage）
├── materials\              # 本地托管简历 PDF 与补充证书目录（按 materialId 分目录保留真实文件名）
├── artifacts\              # 核对卡截图与页面观察溢出产物
└── Partitions\             # Electron BrowserProfile 持久化招聘站登录态分区（persist:jobhelper-*）
```

> **重要兼容性说明**：`electron-main.ts` 保持默认包名 `@jobhelper/desktop` 作为 `userData` 路径。未来若调整安装包 `productName` 或 `app.setName(...)`，**必须**提供旧目录自动迁移逻辑，避免已保存的 `jobhelper.db` 与 `credentials.enc.json` 失联。

内置与外部 Skills 知识库路径：
- **内置 Skills**：随应用分发位于 `<appRoot>/skills-library/`（包含 `ats/` 与 `controls/`）。
- **外部本机 Skills（方案 A）**：可在「设置与技能」页挂载任意本机目录，支持 `<dir>/<skill-name>/SKILL.md` 与 `<dir>/ats/<skill-name>/SKILL.md` 两种布局；内置 Skill 同名优先。

---

## 2. 数据备份与换机迁移

### 2.1 完整本地备份（建议每投递完一批岗位执行）
1. **先完全退出 JobHelper 桌面端**，确保 SQLite 自动完成 WAL checkpoint 并将写入合并回 `jobhelper.db`（避免拷贝出不完整数据库）。
2. 复制以下目录与文件到安全备份位置（例如加密移动硬盘或私有网盘）：
   - `%APPDATA%\@jobhelper\desktop\jobhelper.db`
   - `%APPDATA%\@jobhelper\desktop\materials\`
   - `%APPDATA%\@jobhelper\desktop\artifacts\`（可选，保留历史核对截图证据）
   - 若挂载了自定义外部 Skills 目录，一并备份该目录。

PowerShell 一键备份示例（需先关闭 JobHelper）：

```powershell
$src = "$env:APPDATA\@jobhelper\desktop"
$dst = "$HOME\Desktop\jobhelper-backup-$(Get-Date -Format 'yyyyMMdd-HHmm')"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\jobhelper.db" "$dst\" -Force
if (Test-Path "$src\materials") { Copy-Item "$src\materials" "$dst\materials" -Recurse -Force }
if (Test-Path "$src\artifacts") { Copy-Item "$src\artifacts" "$dst\artifacts" -Recurse -Force }
```

### 2.2 换机恢复注意事项
1. 在新电脑安装/构建并首次启动一次 JobHelper 以生成 `%APPDATA%\@jobhelper\desktop\`，然后完全退出。
2. 将备份的 `jobhelper.db`、`materials\`（及可选 `artifacts\`）还原至 `%APPDATA%\@jobhelper\desktop\`（如目标目录残留旧的 `-wal`/`-shm` 文件请先删除）。
3. **凭据重新录入（安全设计）**：`credentials.enc.json` 使用 **Windows DPAPI** 绑定当前操作系统的本机用户密钥，**无法直接跨电脑解密**；请在新电脑启动 JobHelper 后，前往「设置与技能」重新录入 BYOK API Key 并执行一次三段能力探测。
4. **浏览器登录态（Partitions）**：招聘网站的 Cookie/Session 通常包含设备绑定特征，建议换机后在右侧网页重新登录目标招聘站，不建议直接拷贝 `Partitions\`。

---

## 3. Windows 生产构建与本地运行

前置环境：Node.js `>= 22.12.0`（推荐 Node 24 LTS，内置 `node:sqlite`，零原生 C++ 编译依赖）、npm `>= 10.0.0`。

```powershell
# 1. 安装依赖
npm install

# 2. 清理并编译全部领域包（packages/*）
npm run clean
npm run build
npm run typecheck

# 3. 编译桌面主进程与预加载脚本（apps/desktop）
npm --workspace @jobhelper/desktop run build

# 4. 构建前端工作台生产资源（apps/workbench -> apps/workbench/dist）
npm --workspace @jobhelper/workbench run build

# 5. 运行 Gate 1 与全量自动化回归测试
npm run test:gate1
npm test

# 6. 启动桌面应用
npm run dev:desktop
```

---

## 4. Windows 安装包（NSIS / Portable）打包说明

若需将本地构建产物封装为 Windows 独立分发包（`.exe` 安装包或绿色免安装目录），可使用 `electron-builder`（建议在 CI 或独立发布分支引入）并确保打包配置包含以下静态资源映射：

- 主入口：`apps/desktop/dist/main/electron-main.js`
- 预加载脚本：`apps/desktop/dist/preload/electron-preload.cjs`
- 前端工作台构建目录：`apps/workbench/dist/**`（打包至 `resources/workbench/` 或保持相对路径）
- 内置 Skills 知识库：`skills-library/**`（作为 `extraResources` 打包，以便运行时直接从文件系统按需读取）
- SQLite 迁移文件：`packages/storage/migrations/0001_initial.sql`（确保随 `@jobhelper/storage` 产物完整打包）

打包前红线核查：
1. 严禁将任何 `.env*`、`credentials.enc.json`、`jobhelper.db` 或个人真实简历文件打入安装包。
2. 启动打包后的 `.exe` 后，确认 Electron 内置 `safeStorage.isEncryptionAvailable()` 返回 `true` 且 `node:sqlite` 可正常执行迁移与写入。
3. 验证本地回环端口（Scoped CDP Bridge / 可选 MCP Server）仅监听 `127.0.0.1` 随机端口，不对外网暴露。

---

## 5. 常见排障

| 现象 | 原因与处理 |
| --- | --- |
| 启动提示 `safeStorage` 不可用 | 确认在标准 Windows 交互式桌面会话下运行（非无头服务会话），禁止降级明文存储 API Key。 |
| 某模型探测 `toolCalling: false` | 该模型不支持标准 Function Calling；投递任务会主动拒绝启动，请在「设置与技能」切换支持工具调用的模型。 |
| OpenAI 兼容服务商返回 HTTP 400（`stream_options`） | `OpenAiCompatibleAdapter` 已内置自动降级重试，无需手动改动。 |
| 升级后页面样式未刷新 | 重新执行 `npm --workspace @jobhelper/workbench run build` 后重启桌面端。 |
