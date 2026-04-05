---
name: deploy
description: 贷准项目一键部署：更新缓存版本号 → git push → 推送 ECS → 验证线上
---

## Deploy Skill

1. **确认改动范围**：识别本次所有修改的 JS/CSS 文件（app.js / style.css / config.js / worker.js）
2. **更新缓存版本号**：在 `index.html` 中找到引用了上述文件的 `?v=X.X` 字符串，将版本号 +1（如 `?v=1.5` → `?v=1.6`）；每个文件单独更新，不得遗漏
3. **Worker 部署**（如果 worker.js 有改动）：运行 `npx wrangler@4 deploy`，确认输出包含新的 Version ID
4. **前端部署**：运行 `scp index.html style.css config.js app.js qr.jpg qr_agent_1.jpg root@8.136.1.233:/usr/share/nginx/html/`
5. **Git 提交**：`git add` 所有改动文件，commit message 简明描述本次改动，`git push`
6. **验证**：curl `https://dzhun.com.cn` 检查返回 200，并确认 HTML 中版本号已更新
7. **报告**：列出本次改动的文件清单和新版本号
