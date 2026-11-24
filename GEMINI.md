# JobHelper Gemini / Antigravity 协作规则

本仓库所有 Gemini / Antigravity 会话与门禁流程默认遵守 [AGENTS.md](./AGENTS.md) 中的规范，尤其是以下强制性 Git 提交与合入规则：

1. **作者信息校验**：每次 `git commit` 前确认本地 `git config` 为 `user.name="Drchennnn"`、`user.email="drchennnn@gmail.com"`，严禁使用未在 GitHub 验证的其他邮箱提交。
2. **允许分支开发，但必须真实合入 `main`**：开发、调试和 gate 验收可在 `feat/*`、`codex/*`、`review/*` 分支进行；每个阶段通过验收收尾时，必须通过保留原提交历史的普通 merge（`git merge --no-ff`，**严禁 squash merge**）合并回 `main` 并执行 `git push origin main`。
3. **禁止“脱钩式同步”**：不允许将实际开发 commits 遗留在分支上、只在 `main` 单独发一笔 `docs`/`sync` 提交收尾，必须保证完整 commit 历史真实进入 `origin/main`，以便 GitHub 贡献图准确统计。
