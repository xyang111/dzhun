# 贷准 v2.2 功能扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四个独立功能模块：OCR文件大小限制 / 查询记录折叠展示 / 代理商次数配额 / ECS PDF下载服务

**Architecture:** M2/M1/M4 为纯前端或 Worker 小改动，独立可部署；M3 新增 ECS Node.js 服务 + Nginx 反代 + Worker 路由，最后做。按 M2→M1→M4→M3 顺序执行，每个模块做完即部署验证。

**Tech Stack:** HTML/JS/CSS (前端)、Cloudflare Worker (worker.js)、Node.js + puppeteer-core + 系统 Chromium (ECS PDF服务)、Cloudflare KV (代理商配额)

---

## 文件改动总览

| 文件 | 模块 | 改动性质 |
|------|------|----------|
| `app.js` | M2, M1, M3, M4 | 修改多处函数 |
| `worker.js` | M1, M3, M4 | 修改 handleOCR + expandOCRKeys + 新增 /pdf 路由 |
| `index.html` | M1, M3 | 新增 DOM 节点 + 版本号 |
| `style.css` | M1, M3 | 新增 CSS 类 |
| `/opt/pdf-service/server.js` | M3 | ECS 新文件 |
| `/opt/pdf-service/package.json` | M3 | ECS 新文件 |
| `/etc/nginx/conf.d/dzhun.conf` 或 Nginx 配置 | M3 | 新增 location 块 |

---

## M2：OCR 文件限制（先做，防成本泄漏）

### Task 1：PDF 大小限制 3MB

**Files:**
- Modify: `app.js`（`_processPdf` 函数，约第 1000 行）

- [ ] **Step 1：修改 PDF 大小限制**

找到 `_processPdf` 函数里的：
```javascript
const maxMB = 20;
if (f.size > maxMB * 1024 * 1024) {
  alert(`文件过大（${(f.size/1024/1024).toFixed(1)}MB），请压缩至 ${maxMB}MB 以内后重试`);
```
改为：
```javascript
const maxMB = 3;
if (f.size > maxMB * 1024 * 1024) {
  alert(`PDF过大（${(f.size/1024/1024).toFixed(1)}MB），简版征信通常不超过3MB，请确认上传的是人行简版征信`);
```

- [ ] **Step 2：提交**

```bash
cd ~/Desktop/贷准
git add app.js
git commit -m "feat(M2): PDF size limit 20MB→3MB with better error msg"
```

---

### Task 2：图片数量/大小限制

**Files:**
- Modify: `app.js`（`_processImages` 函数，约第 1034 行）

- [ ] **Step 1：修改图片校验逻辑**

找到 `_processImages` 函数开头：
```javascript
function _processImages(files) {
  if (!files.length) { alert('不支持的文件格式，请上传 PDF 或图片'); return; }
  const maxMB = 20;
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  if (totalSize > maxMB * 1024 * 1024) {
    alert(`文件总大小过大（${(totalSize/1024/1024).toFixed(1)}MB），请压缩至 ${maxMB}MB 以内后重试`);
    return;
  }
```

改为：
```javascript
function _processImages(files) {
  if (!files.length) { alert('不支持的文件格式，请上传 PDF 或图片'); return; }
  const maxCount = 12;
  const maxMBEach = 3;
  if (files.length > maxCount) {
    alert(`最多上传${maxCount}张截图，简版征信通常只需2-4张`);
    return;
  }
  const oversized = files.find(f => f.size > maxMBEach * 1024 * 1024);
  if (oversized) {
    alert(`图片"${oversized.name}"超过${maxMBEach}MB，请压缩后重试`);
    return;
  }
```

- [ ] **Step 2：提交**

```bash
git add app.js
git commit -m "feat(M2): image limit 12 files, 3MB each"
```

---

### Task 3：部署 M2 并验证

- [ ] **Step 1：部署**

```bash
cd ~/Desktop/贷准
# 更新 index.html 版本号（找到 app.js?v= 那行，把版本号 +1）
# 例如：app.js?v=1775360000 → app.js?v=1775360001
scp app.js index.html root@8.136.1.233:/usr/share/nginx/html/
```

- [ ] **Step 2：验证**

打开 https://dzhun.com.cn，尝试上传一个超过 3MB 的 PDF，应弹出提示"PDF过大"。再上传正常的简版征信，应正常分析。

---

## M1：近半年查询记录折叠展示

### Task 4：Worker 提取机构名

**Files:**
- Modify: `worker.js`（rule engine query 提取，约第 505-514 行；expandOCRKeys；两个 Prompt）

- [ ] **Step 1：rule engine 加 institution 字段**

找到 worker.js 约 510 行：
```javascript
        if (dm) query_records.push({ date: toDate(dm[1], dm[2], dm[3]), type: tds[3] });
```
改为：
```javascript
        if (dm) query_records.push({ date: toDate(dm[1], dm[2], dm[3]), type: tds[3], institution: tds[2] || '' });
```

- [ ] **Step 2：expandOCRKeys 加 institution 映射**

找到：
```javascript
      const qMap = { d:'date', t:'type' };
```
改为：
```javascript
      const qMap = { d:'date', t:'type', i:'institution' };
```

- [ ] **Step 3：更新 PROMPT_OCR_TEXT 中 query_records 格式示例**

在 `PROMPT_OCR_TEXT` 里找到 query_records 相关说明（约第 174 行）：
```
6. 查询记录：只取以下6类（原文照抄type）：贷款审批、信用卡审批、担保资格审查、资信审查、保前审查、融资租赁审批。其余全部跳过。⚠️"贷后管理"≠"贷款审批"，绝对不能混淆。
```
改为：
```
6. 查询记录：只取以下6类（原文照抄type）：贷款审批、信用卡审批、担保资格审查、资信审查、保前审查、融资租赁审批。其余全部跳过。⚠️"贷后管理"≠"贷款审批"，绝对不能混淆。institution填写查询机构名称（如"招商银行"），识别不清填""。
```

找到 PROMPT_OCR_TEXT 的 query_records 示例（格式 `{"date": ..., "type": ...}`），加上 institution 字段：
```javascript
// 改前
{"date": "2025-11-20", "type": "贷款审批"},
// 改后
{"date": "2025-11-20", "type": "贷款审批", "institution": "招商银行"},
```

- [ ] **Step 4：更新 PROMPT_OCR 中的 query_records 格式示例**（同上，PROMPT_OCR 里也有示例，同样加 institution 字段）

- [ ] **Step 5：提交 worker.js**

```bash
git add worker.js
git commit -m "feat(M1): add institution field to query_records extraction"
```

---

### Task 5：前端渲染查询明细 + CSS

**Files:**
- Modify: `index.html`（在 brWrap 块之后新增 div）
- Modify: `app.js`（新增 renderQueryDetail 函数，在 renderBlastRisk 调用后调用）
- Modify: `style.css`（新增折叠样式）

- [ ] **Step 1：index.html 新增查询明细容器**

找到 `index.html` 约 340 行，`</div>` 结束 brWrap 块后，紧接着插入：
```html
        <!-- 查询机构明细（折叠） -->
        <div class="qd-wrap" id="qdWrap" style="display:none">
          <div class="card-bar" style="background:var(--raised)">
            <span class="step-tag">QUERY</span>
            <span class="card-title">近半年查询机构明细</span>
            <button class="qd-toggle" id="qdToggle" onclick="toggleQueryDetail()">查看明细 ▼</button>
          </div>
          <div class="qd-body" id="qdBody" style="display:none"></div>
        </div>
```

- [ ] **Step 2：style.css 新增折叠样式**

在 style.css 末尾追加：
```css
/* ── 查询明细折叠 ── */
.qd-wrap { border-radius: 12px; overflow: hidden; border: 1px solid var(--border2); margin-bottom: 12px; }
.qd-toggle { background: none; border: none; color: var(--accentB); font-size: 12px; cursor: pointer; padding: 0; }
.qd-body { padding: 0 16px 12px; }
.qd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.qd-table th { color: var(--silver); font-weight: 400; padding: 8px 4px 4px; text-align: left; border-bottom: 1px solid var(--border2); }
.qd-table td { padding: 7px 4px; border-bottom: 1px solid var(--border2); color: var(--text); }
.qd-table tr:last-child td { border-bottom: none; }
.qd-inst { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 3：app.js 新增 renderQueryDetail 和 toggleQueryDetail 函数**

在 app.js 里 `renderBlastRisk` 函数定义之后，追加两个函数：

```javascript
function renderQueryDetail(data) {
  const wrap = document.getElementById('qdWrap');
  if (!wrap) return;
  const refDate = data.report_date || new Date().toISOString().slice(0, 10);
  const refMs   = new Date(refDate).getTime();
  const records = (data.query_records || []).filter(q => {
    const diff = (refMs - new Date(q.date).getTime()) / 86400000;
    return diff >= 0 && diff <= 183;
  });
  if (!records.length) return;
  records.sort((a, b) => b.date.localeCompare(a.date)); // 日期倒序

  const rows = records.map(q => {
    const inst = q.institution ? `<span class="qd-inst" title="${q.institution}">${q.institution}</span>` : '<span style="color:var(--silver)">--</span>';
    return `<tr><td>${inst}</td><td>${q.type}</td><td>${q.date}</td></tr>`;
  }).join('');

  document.getElementById('qdBody').innerHTML = `
    <table class="qd-table">
      <thead><tr><th>查询机构</th><th>查询类型</th><th>日期</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  wrap.style.display = 'block';
}

function toggleQueryDetail() {
  const body = document.getElementById('qdBody');
  const btn  = document.getElementById('qdToggle');
  if (!body || !btn) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'block' : 'none';
  btn.textContent    = open ? '收起 ▲' : '查看明细 ▼';
}
```

- [ ] **Step 4：在 renderBlastRisk 调用处之后调用 renderQueryDetail**

找到 app.js 约 1328 行：
```javascript
  renderBlastRisk(data);
```
改为：
```javascript
  renderBlastRisk(data);
  renderQueryDetail(data);
```

- [ ] **Step 5：重置函数里隐藏 qdWrap**

找到 app.js 约 3333 行（reset 逻辑）：
```javascript
  ['csWrap','brWrap'].forEach(id => {
```
改为：
```javascript
  ['csWrap','brWrap','qdWrap'].forEach(id => {
```

- [ ] **Step 6：提交**

```bash
git add app.js index.html style.css
git commit -m "feat(M1): query detail collapsible section with institution names"
```

---

### Task 6：部署 M1 并验证

- [ ] **Step 1：部署 Worker（因为 worker.js 改了）**

```bash
cd ~/Desktop/贷准
npx wrangler@4 deploy
```

- [ ] **Step 2：部署前端（index.html 改了，必须更新版本号）**

更新 `index.html` 中 `style.css?v=`、`app.js?v=` 版本号各 +1，然后：
```bash
scp index.html style.css app.js root@8.136.1.233:/usr/share/nginx/html/
```

- [ ] **Step 3：验证**

上传一份有查询记录的简版征信，OCR 识别后应在"征信风险指标"下方看到"近半年查询机构明细"区块，点击"查看明细"展开，显示机构名/查询类型/日期三列表格。

---

## M4：代理商次数配额

### Task 7：前端 OCR 请求携带 agentId

**Files:**
- Modify: `app.js`（`startAnalysis` 函数内，约第 1165 行）

- [ ] **Step 1：OCR 请求 body 加 agentId**

找到约 1165 行：
```javascript
      body: JSON.stringify({ fileBlocks: _fileBlocks, cacheKey }),
```
改为：
```javascript
      body: JSON.stringify({ fileBlocks: _fileBlocks, cacheKey, agentId: window._currentAgent?.id || null }),
```

- [ ] **Step 2：提交**

```bash
git add app.js
git commit -m "feat(M4): pass agentId in OCR request"
```

---

### Task 8：Worker 代理商配额逻辑

**Files:**
- Modify: `worker.js`（`handleOCR` 函数）

- [ ] **Step 1：handleOCR 加代理商配额检查**

找到 `handleOCR` 函数里：
```javascript
  const { fileBlocks, cacheKey } = body;
  if (!fileBlocks || !fileBlocks.length) {
    return jsonResp({ error: '缺少文件内容' }, 400, request);
  }

  // 缓存查询：命中直接返回，不计入限流
  if (cacheKey && env.CACHE) {
    const cached = await env.CACHE.get(`ocr:${cacheKey}`);
    if (cached) {
      console.log('[OCR] cache hit, key:', cacheKey);
      return jsonResp({ raw: cached, _cached: true }, 200, request);
    }
  }

  // 缓存未命中，IP 限流：每 IP 每 24 小时最多 30 次
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `ocr_rate:${ip}`;
  const countRaw = await env.CACHE.get(rateLimitKey);
  const count = countRaw ? parseInt(countRaw) : 0;
  if (count >= 30) {
    return jsonResp({ error: '今日识别次数已达上限，请明日再试' }, 429, request);
  }
  await env.CACHE.put(rateLimitKey, String(count + 1), { expirationTtl: 86400 });
```

替换为：
```javascript
  const { fileBlocks, cacheKey, agentId } = body;
  if (!fileBlocks || !fileBlocks.length) {
    return jsonResp({ error: '缺少文件内容' }, 400, request);
  }

  // 缓存查询：命中直接返回，不计入限流也不扣代理商配额
  if (cacheKey && env.CACHE) {
    const cached = await env.CACHE.get(`ocr:${cacheKey}`);
    if (cached) {
      console.log('[OCR] cache hit, key:', cacheKey);
      return jsonResp({ raw: cached, _cached: true }, 200, request);
    }
  }

  // 代理商渠道：检查配额（缓存未命中时才扣）
  let agentData = null;
  if (agentId) {
    const raw = await env.ORDERS.get(`agent:${agentId}`);
    if (!raw) return jsonResp({ error: '代理商账号不存在，请联系贷准' }, 403, request);
    agentData = JSON.parse(raw);
    if (agentData.used >= agentData.quota) {
      return jsonResp({ error: `代理商额度已用完（${agentData.quota}次），请联系贷准充值` }, 403, request);
    }
  } else {
    // C 端用户：IP 限流
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitKey = `ocr_rate:${ip}`;
    const countRaw = await env.CACHE.get(rateLimitKey);
    const count = countRaw ? parseInt(countRaw) : 0;
    if (count >= 30) {
      return jsonResp({ error: '今日识别次数已达上限，请明日再试' }, 429, request);
    }
    await env.CACHE.put(rateLimitKey, String(count + 1), { expirationTtl: 86400 });
  }
```

再找到 `writeCache` 函数定义之后（约 842 行），在主路径开始前，找到 OCR 主逻辑最后会调用 `writeCache(raw)` 并 `return` 的地方。在每条 `return` 之前（含成功的 JSON 返回），在 `writeCache` 调用之后加代理商扣减。

具体做法：在 `writeCache` 函数下方新增一个辅助函数：
```javascript
  // 辅助：OCR 成功后扣代理商配额（写在 writeCache 定义之后）
  async function deductAgent() {
    if (!agentId || !agentData) return;
    agentData.used += 1;
    await env.ORDERS.put(`agent:${agentId}`, JSON.stringify(agentData));
    console.log(`[OCR] agent ${agentId} used=${agentData.used}/${agentData.quota}`);
  }
```

然后找到函数内所有 OCR 成功返回的地方（textin+haiku 成功、sonnet vision 成功），在 `writeCache(raw)` 之后、`return jsonResp(...)` 之前，各加一行：
```javascript
    await deductAgent();
```

> **注意：** handleOCR 函数内有多个成功返回路径（textin+haiku 主路径 + sonnet 降级路径）。每条成功路径都需要加 `await deductAgent()`。用全局搜索 `await writeCache` 定位所有写缓存位置，在其后加 `await deductAgent()`。

- [ ] **Step 2：提交**

```bash
git add worker.js
git commit -m "feat(M4): agent quota check and deduction in handleOCR"
```

---

### Task 9：创建第一个代理商 + 部署验证

- [ ] **Step 1：部署 Worker**

```bash
npx wrangler@4 deploy
```

- [ ] **Step 2：创建代理商 KV 记录（XY001 已有，这里新建一个独立配额记录）**

```bash
npx wrangler@4 kv:key put --binding=ORDERS "agent:XY001" '{"name":"夏阳","quota":500,"used":0,"created_at":"2026-04-16"}'
```

- [ ] **Step 3：验证配额机制**

浏览器打开 `https://dzhun.com.cn?agent=XY001`，上传征信 → 正常识别。

查看用量：
```bash
npx wrangler@4 kv:key get --binding=ORDERS "agent:XY001"
```
应看到 `"used": 1`（或因缓存命中仍为 0）。

- [ ] **Step 4：测试额度耗尽**

临时把 quota 改为 0 测试是否弹出额度提示：
```bash
npx wrangler@4 kv:key put --binding=ORDERS "agent:XY001_test" '{"name":"测试","quota":0,"used":0,"created_at":"2026-04-16"}'
```
用 `?agent=XY001_test` 访问，OCR 应返回"代理商额度已用完"。测完删除：
```bash
npx wrangler@4 kv:key delete --binding=ORDERS "agent:XY001_test"
```

---

## M3：ECS PDF 下载服务

### Task 10：ECS 安装依赖，搭建 PDF 服务

**Files:**
- Create: `/opt/pdf-service/package.json`
- Create: `/opt/pdf-service/server.js`

SSH 进 ECS：`ssh root@8.136.1.233`

- [ ] **Step 1：安装 Node.js 18 和 Chromium**

```bash
# 安装 Node 18（如果没有）
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
dnf install -y nodejs

# 安装系统 Chromium（避免 puppeteer 自动下载被墙）
dnf install -y chromium

# 确认 chromium 路径
which chromium-browser || which chromium
# 通常是 /usr/bin/chromium-browser 或 /usr/bin/chromium
```

- [ ] **Step 2：创建目录和 package.json**

```bash
mkdir -p /opt/pdf-service
```

创建 `/opt/pdf-service/package.json`：
```json
{
  "name": "pdf-service",
  "version": "1.0.0",
  "main": "server.js",
  "dependencies": {
    "puppeteer-core": "^22.0.0"
  }
}
```

- [ ] **Step 3：安装依赖**

```bash
cd /opt/pdf-service && npm install
```

- [ ] **Step 4：创建 `/opt/pdf-service/server.js`**

```javascript
const http = require('http');
const puppeteer = require('puppeteer-core');

const PORT    = 3001;
const SECRET  = process.env.PDF_SECRET;
const CHROME  = process.env.CHROME_PATH || '/usr/bin/chromium-browser';

if (!SECRET) { console.error('PDF_SECRET env var required'); process.exit(1); }

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/render') {
    res.writeHead(404); res.end('not found'); return;
  }
  if (req.headers['x-pdf-secret'] !== SECRET) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    try {
      const { html, filename } = JSON.parse(body);
      const browser = await puppeteer.launch({
        executablePath: CHROME,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        headless: true,
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });
      await browser.close();

      const safeFilename = encodeURIComponent(filename || '贷准报告');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${safeFilename}.pdf`,
        'Content-Length': pdf.length,
      });
      res.end(pdf);
    } catch (e) {
      console.error('[pdf-service] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pdf-service] listening on 127.0.0.1:${PORT}`);
});
```

- [ ] **Step 5：测试本地启动**

```bash
PDF_SECRET=testSecret123 node /opt/pdf-service/server.js &
# 测试接口（另开终端或用 & 挂后台后）
curl -s -X POST http://127.0.0.1:3001/render \
  -H "x-pdf-secret: testSecret123" \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body><h1>测试</h1></body></html>","filename":"test"}' \
  -o /tmp/test.pdf
ls -la /tmp/test.pdf  # 应有几KB的PDF
kill %1  # 停掉测试进程
```

- [ ] **Step 6：用 pm2 管理进程**

```bash
npm install -g pm2
cd /opt/pdf-service

# 创建 ecosystem 配置
cat > /opt/pdf-service/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'pdf-service',
    script: 'server.js',
    cwd: '/opt/pdf-service',
    env: {
      PDF_SECRET: 'CHANGE_ME_STRONG_SECRET',
      CHROME_PATH: '/usr/bin/chromium-browser',
    }
  }]
};
EOF

# 启动（先把 CHANGE_ME_STRONG_SECRET 改成真实密钥，比如 32 位随机字符串）
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 按提示运行那条 systemctl 命令，实现开机自启
```

- [ ] **Step 7：验证 pm2 运行正常**

```bash
pm2 status
# 看到 pdf-service 状态为 online
curl -s -X POST http://127.0.0.1:3001/render \
  -H "x-pdf-secret: CHANGE_ME_STRONG_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body><p>ok</p></body></html>","filename":"ok"}' \
  -o /tmp/ok.pdf && echo "PDF OK, size: $(wc -c < /tmp/ok.pdf) bytes"
```

---

### Task 11：Nginx 反向代理 /pdf-render

**Files:**
- Modify: ECS Nginx 配置（通常在 `/etc/nginx/conf.d/dzhun.conf` 或 `/etc/nginx/nginx.conf`）

- [ ] **Step 1：找到当前 Nginx 配置**

```bash
nginx -T 2>/dev/null | grep "server_name\|location\|include" | head -30
# 或
ls /etc/nginx/conf.d/
```

- [ ] **Step 2：在 dzhun.com.cn 的 server 块内加 location**

在 `server { ... }` 块（监听 443，server_name dzhun.com.cn 那个）内，已有 location / 等，追加：

```nginx
    location /pdf-render {
        # 只允许携带正确 secret header 的请求（额外防护在 Node 服务层）
        proxy_pass         http://127.0.0.1:3001/render;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-PDF-Secret $http_x_pdf_secret;
        proxy_read_timeout 30s;
        client_max_body_size 5m;
    }
```

- [ ] **Step 3：重载 Nginx**

```bash
nginx -t && systemctl reload nginx
```

- [ ] **Step 4：从外网测试 Nginx 代理**

在本地机器运行（把 SECRET 替换为真实值）：
```bash
curl -s -X POST https://dzhun.com.cn/pdf-render \
  -H "x-pdf-secret: CHANGE_ME_STRONG_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body><p>nginx proxy ok</p></body></html>","filename":"ngtest"}' \
  -o /tmp/ng.pdf && echo "Nginx proxy OK: $(wc -c < /tmp/ng.pdf) bytes"
```

---

### Task 12：Worker 新增 /pdf 路由

**Files:**
- Modify: `worker.js`（新增 `handlePdf` 函数 + 路由注册 + `buildPdfHtml` 函数）

- [ ] **Step 1：注册 Worker secret**

在本地：
```bash
echo "CHANGE_ME_STRONG_SECRET" | npx wrangler@4 secret put PDF_SERVICE_SECRET
```

- [ ] **Step 2：注册路由**

找到 worker.js 路由分发区（约 729-735 行）：
```javascript
    if (normPath === '/pdf')               return handlePdf(request, env);
```
加在 `/report` 那行之后。

- [ ] **Step 3：新增 buildPdfHtml 函数**

在 worker.js 末尾（`export default` 之前）追加：

```javascript
// ── buildPdfHtml：将报告数据渲染为 Puppeteer 可用的 HTML ──
function buildPdfHtml(data, v2) {
  const name  = data.person_name  || '--';
  const idNo  = (data.id_number   || '').replace(/^(.{6}).+(.{4})$/, '$1********$2');
  const rDate = data.report_date  || '--';
  const score = v2?.score         || '--';
  const level = v2?.level         || '--';
  const genTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 查询记录（近6月）
  const refMs = new Date(rDate).getTime();
  const qRows = (data.query_records || [])
    .filter(q => (refMs - new Date(q.date).getTime()) / 86400000 <= 183)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(q => `<tr><td>${q.institution || '--'}</td><td>${q.type}</td><td>${q.date}</td></tr>`)
    .join('') || '<tr><td colspan="3" style="color:#999;text-align:center">无近半年查询记录</td></tr>';

  // 贷款列表
  const loanRows = (data.loans || []).filter(l => l.status !== '结清' && l.status !== '已结清')
    .map(l => `<tr><td>${l.name || '--'}</td><td>${(l.balance || 0).toLocaleString()}</td><td>${l.status || '--'}</td></tr>`)
    .join('') || '<tr><td colspan="3" style="color:#999;text-align:center">无未结清贷款</td></tr>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: "PingFang SC","Microsoft YaHei",sans-serif; color: #1a1a2e; margin: 0; padding: 0; font-size: 13px; }
  h1 { font-size: 20px; color: #1a1a2e; margin: 0 0 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 20px; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 14px; font-weight: 600; color: #1a1a2e; border-left: 3px solid #4169e1; padding-left: 8px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f0f4ff; color: #444; font-weight: 500; padding: 7px 8px; text-align: left; }
  td { padding: 7px 8px; border-bottom: 1px solid #eee; }
  .score-box { display: inline-block; background: #f0f4ff; border-radius: 8px; padding: 12px 24px; text-align: center; margin-bottom: 16px; }
  .score-num { font-size: 36px; font-weight: 700; color: #4169e1; }
  .score-lbl { font-size: 12px; color: #666; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #eee; color: #999; font-size: 11px; text-align: center; }
</style>
</head>
<body>
<h1>贷准 · 智能贷款评估报告</h1>
<div class="sub">姓名：${name} &nbsp;|&nbsp; 证件号：${idNo} &nbsp;|&nbsp; 报告日期：${rDate}</div>

<div class="section">
  <div class="section-title">综合评分</div>
  <div class="score-box">
    <div class="score-num">${score}</div>
    <div class="score-lbl">评级：${level}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">近半年查询记录</div>
  <table><thead><tr><th>查询机构</th><th>查询类型</th><th>查询日期</th></tr></thead>
  <tbody>${qRows}</tbody></table>
</div>

<div class="section">
  <div class="section-title">当前未结清贷款</div>
  <table><thead><tr><th>机构</th><th>余额（元）</th><th>状态</th></tr></thead>
  <tbody>${loanRows}</tbody></table>
</div>

<div class="footer">由 dzhun.com.cn 生成 · ${genTime} · 仅供参考，以银行实际审批为准</div>
</body>
</html>`;
}
```

- [ ] **Step 4：新增 handlePdf 函数**

在 `buildPdfHtml` 函数之前追加：

```javascript
// ═══════════════════════════════════════════
// /pdf — 生成 PDF 报告（仅付费用户）
// ═══════════════════════════════════════════
async function handlePdf(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }

  const { ocrData, v2Score, agentId } = body;
  if (!ocrData) return jsonResp({ error: '缺少报告数据' }, 400, request);

  // 鉴权：付费用户 token 或代理商 agentId
  const isPaid = !!body.payToken;
  if (!isPaid && !agentId) {
    return jsonResp({ error: '请先完成付费后再下载' }, 402, request);
  }
  if (agentId) {
    const raw = await env.ORDERS.get(`agent:${agentId}`);
    if (!raw) return jsonResp({ error: '代理商账号不存在' }, 403, request);
  }
  if (isPaid) {
    // 复用现有 pay token 校验
    const tokenData = await env.ORDERS.get(`pay:${body.payToken}`);
    if (!tokenData) return jsonResp({ error: '付费凭证无效或已过期' }, 402, request);
  }

  const pdfServiceUrl = 'https://dzhun.com.cn/pdf-render';
  const secret = env.PDF_SERVICE_SECRET;
  if (!secret) return jsonResp({ error: 'PDF服务未配置' }, 500, request);

  const name  = ocrData.person_name || '用户';
  const rDate = (ocrData.report_date || '').replace(/-/g, '');
  const filename = `贷准报告_${name}_${rDate}`;
  const html  = buildPdfHtml(ocrData, v2Score);

  try {
    const resp = await fetch(pdfServiceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pdf-secret': secret },
      body: JSON.stringify({ html, filename }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[PDF] service error:', err);
      return jsonResp({ error: 'PDF生成失败，请稍后重试' }, 500, request);
    }
    const pdf = await resp.arrayBuffer();
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.pdf`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[PDF] fetch error:', e.message);
    return jsonResp({ error: 'PDF服务连接失败，请稍后重试' }, 500, request);
  }
}
```

- [ ] **Step 5：提交**

```bash
git add worker.js
git commit -m "feat(M3): /pdf route + buildPdfHtml + handlePdf"
```

---

### Task 13：前端下载按钮和逻辑

**Files:**
- Modify: `app.js`（新增 `downloadPdfReport` 函数，在结果页底部渲染下载按钮）
- Modify: `style.css`（下载按钮样式）
- Modify: `index.html`（版本号更新）

- [ ] **Step 1：style.css 新增下载按钮样式**

在 style.css 末尾追加：
```css
/* ── PDF 下载按钮 ── */
.pdf-dl-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px; background: var(--raised); border: 1px solid var(--border2); border-radius: 12px; color: var(--accentB); font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 16px; }
.pdf-dl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pdf-dl-btn svg { flex-shrink: 0; }
```

- [ ] **Step 2：app.js 新增 downloadPdfReport 函数**

在 app.js 末尾（DOMContentLoaded 之前）追加：

```javascript
async function downloadPdfReport() {
  const btn = document.getElementById('pdfDlBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = btn.innerHTML.replace('下载报告 PDF', '生成中...'); }

  const payToken = getPayToken();
  const agentId  = window._currentAgent?.id || null;

  try {
    const resp = await fetch(PROXY_URL + '/api/v1/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ocrData:  window._recognizedData,
        v2Score:  window._v2Result,  // 由 startMatching 中 window._v2Result = _v2Engine.compute() 赋值
        payToken: payToken || undefined,
        agentId:  agentId  || undefined,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'PDF生成失败' }));
      alert(err.error || 'PDF生成失败，请稍后重试');
      return;
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const name = window._recognizedData?.person_name || '用户';
    const date = (window._recognizedData?.report_date || '').replace(/-/g, '');
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `贷准报告_${name}_${date}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('下载失败，请检查网络后重试');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>下载报告 PDF';
    }
  }
}
```

- [ ] **Step 3：在 startMatching 渲染结果后显示下载按钮**

找到 app.js 中渲染产品匹配结果的末尾区域，寻找付费状态检查后渲染 PDF 按钮的合适位置。搜索 `isPaid` 相关产品渲染逻辑（约 2499 行 `const isPaid = !!_tok;`），在付费成功情况下的渲染末尾加入下载按钮。

具体找到产品卡片渲染容器（有 `matchResult` 或类似 id 的容器），在其之后注入按钮：

```javascript
// 在渲染产品列表的函数末尾，isPaid 为 true 时添加
if (isPaid || window._currentAgent) {
  const dlWrap = document.getElementById('pdfDlWrap');
  if (dlWrap) {
    dlWrap.style.display = 'block';
    dlWrap.innerHTML = `<button class="pdf-dl-btn" id="pdfDlBtn" onclick="downloadPdfReport()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>下载报告 PDF</button>`;
  }
}
```

- [ ] **Step 4：index.html 新增 pdfDlWrap 容器**

在产品匹配结果容器之后（搜索结果页最后一个主卡之后），添加：
```html
        <!-- PDF 下载区域 -->
        <div id="pdfDlWrap" style="display:none"></div>
```

同时更新所有已改文件的 `?v=` 版本号 +1。

- [ ] **Step 5：reset 函数隐藏 pdfDlWrap**

找到 reset 逻辑（约 3333 行），在清空列表里加 `'pdfDlWrap'`：
```javascript
  ['csWrap','brWrap','qdWrap','pdfDlWrap'].forEach(id => {
```

- [ ] **Step 6：提交**

```bash
git add app.js style.css index.html
git commit -m "feat(M3): PDF download button with blob download"
```

---

### Task 14：部署 M3 全链路验证

- [ ] **Step 1：部署 Worker**

```bash
npx wrangler@4 deploy
```

- [ ] **Step 2：部署前端**

```bash
scp index.html style.css app.js root@8.136.1.233:/usr/share/nginx/html/
```

- [ ] **Step 3：端到端验证**

1. 打开 https://dzhun.com.cn，上传征信，完成付费流程
2. 付费成功后，结果页底部出现"下载报告 PDF"按钮
3. 点击，等待几秒，浏览器弹出下载 `贷准报告_姓名_YYYYMMDD.pdf`
4. 打开 PDF，确认内容：姓名、评分、查询记录表、贷款表格、页脚水印均正常

- [ ] **Step 4：代理商渠道验证**

用 `?agent=XY001` 访问，完成 OCR 后（不需付费）也能看到下载按钮，点击正常下载。

---

## 部署后运维备忘

**代理商充值（命令行）：**
```bash
# 查看用量
npx wrangler@4 kv:key get --binding=ORDERS "agent:XY001"

# 充值（把 quota 改大）
npx wrangler@4 kv:key put --binding=ORDERS "agent:XY001" '{"name":"夏阳","quota":1000,"used":237,"created_at":"2026-04-16"}'
```

**PDF 服务运维：**
```bash
ssh root@8.136.1.233
pm2 status       # 查看 pdf-service 状态
pm2 logs pdf-service --lines 50  # 查看最近日志
pm2 restart pdf-service          # 重启服务
```
