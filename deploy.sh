#!/bin/bash
set -e
cd /Users/yang/Desktop/贷准

# 部署 Worker
npx wrangler@4 deploy

# 同步前端到 ECS
git add index.html style.css config.js app.js qr.jpg qr_agent_1.jpg
git commit -m "deploy $(date '+%Y-%m-%d %H:%M')" || true
git push origin main
scp index.html style.css config.js app.js qr.jpg qr_agent_1.jpg root@8.136.1.233:/usr/share/nginx/html/

echo "✅ 部署完成"
