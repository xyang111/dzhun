#!/bin/bash
set -e
cd /Users/yang/Desktop/贷准

# 部署 Worker
npx wrangler@4 deploy

# 更新版本号（强制刷新浏览器缓存）
TS=$(date +%s)
for f in index.html checkup.html; do
  sed -i '' "s/style\.css?v=[0-9]*/style.css?v=${TS}/g" "$f"
  sed -i '' "s/config\.js?v=[0-9]*/config.js?v=${TS}/g" "$f"
  sed -i '' "s/app\.js?v=[0-9]*/app.js?v=${TS}/g" "$f"
done

# 混淆 JS（保护源码）
javascript-obfuscator app.js \
  --output app.obf.js \
  --compact true \
  --identifier-names-generator hexadecimal \
  --rename-globals false \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --split-strings true \
  --split-strings-chunk-length 10 \
  --numbers-to-expressions true \
  --disable-console-output false \
  --self-defending false

javascript-obfuscator config.js \
  --output config.obf.js \
  --compact true \
  --identifier-names-generator hexadecimal \
  --rename-globals false \
  --string-array true \
  --string-array-encoding rc4 \
  --string-array-threshold 0.75 \
  --split-strings true \
  --split-strings-chunk-length 10 \
  --disable-console-output false \
  --self-defending false

# 同步前端到 ECS（上传混淆版，服务器上覆盖为 app.js / config.js）
git add index.html checkup.html style.css config.js app.js qr.jpg qr_agent_1.jpg
git commit -m "deploy $(date '+%Y-%m-%d %H:%M')" || true
git push origin main
scp index.html checkup.html style.css qr.jpg qr_agent_1.jpg root@8.136.1.233:/usr/share/nginx/html/
scp app.obf.js root@8.136.1.233:/usr/share/nginx/html/app.js
scp config.obf.js root@8.136.1.233:/usr/share/nginx/html/config.js

echo "✅ 部署完成"
