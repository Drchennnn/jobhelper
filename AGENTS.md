# JobHelper 协作与 Git 提交合入规范

本文件定义了本仓库所有会话（含 Codex、Gemini、Antigravity 及人工协作）和阶段门禁流程必须默认遵守的协作规则。

## Git 提交与合入规范（强制执行）

### 1. 作者信息校验
- 每次执行 `git commit` 前，必须确认本地仓库的 `git config` 为：
  - `user.name = "Drchennnn"`
  - `user.email = "drchennnn@gmail.com"`
- 严禁使用未在 GitHub 验证的其他邮箱（或与上述不一致的作者信息）提交。
- 推荐在提交前执行校验：
  ```bash
  git config user.name
  git config user.email
  ```

### 2. 允许分支开发，但必须真实合入 `main`
- 开发、调试与 gate 验收可以在 `feat/*`、`codex/*`、`review/*` 等分支上进行。
- 每个阶段通过验收并收尾时，**必须**切换回默认分支 `main`，通过保留原提交历史的普通 merge（`git merge --no-ff <branch>`）合并回 `main`，并执行 `git push origin main`。
- **严禁使用 squash merge**（禁止 `git merge --squash` 或在 PR 中使用 Squash and merge）。

### 3. 禁止“脱钩式同步”
- 严禁将实际开发 commits 遗留在特性/评审分支上，仅在 `main` 上单独发一笔 `docs` / `sync` 提交草草收尾。
- 必须确保完整且真实的开发 commit 历史合入并推送到 `origin/main`，以保证代码历史可追溯且 GitHub 贡献图准确统计。

## 阶段验收收尾检查清单
- [ ] `git config user.name` 为 `Drchennnn`，`git config user.email` 为 `drchennnn@gmail.com`
- [ ] 所有已完成并通过 gate 验收的 `feat/*`、`codex/*`、`review/*` 分支均已通过 `git merge --no-ff` 合入 `main`
- [ ] 工作区干净（`git status` 无未提交改动）
- [ ] 已执行 `git push origin main`，且 `origin/main` 包含完整提交历史
