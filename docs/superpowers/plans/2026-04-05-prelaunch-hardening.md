# 贷准上线前加固计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复上线前审查发现的所有真实 bug 和安全漏洞，确保支付流程闭环、代码无死码、安全头到位。

**Architecture:** 前端4文件（index.html/style.css/config.js/app.js）+ Cloudflare Worker（worker.js）。修改完毕后运行 `./deploy.sh` 一键部署。

**Tech Stack:** Vanilla JS, Cloudflare Worker, KV, D1, 支付宝/微信支付

---

## 文件改动地图

| 文件 | 改动 |
|------|------|
| `worker.js` | 移除 HTTP/IP 白名单；新增安全响应头 |
| `app.js` | 支付轮询加超时；calcBlastRisk 补充新查询类型；删除敏感 console.log |
| `index.html` | 移除 fonts.loli.net 外部字体 CDN |

---

### Task 1: 移除 CORS 白名单中的 HTTP 和 IP（安全加固）

**Files:**
- Modify: `worker.js:9-16`

**Context:** 当前 `ALLOWED_ORIGINS` 包含 `http://dzhun.com.cn`、`http://www.dzhun.com.cn`、`http://8.136.1.233`、`https://8.136.1.233`。生产环境全站 HTTPS，HTTP 和 IP 地址应移除，防止降级攻击和 IP 暴露。

- [ ] **Step 1: 编辑 worker.js，收紧 ALLOWED_ORIGINS**

将 `worker.js` 第 9-16 行：
```js
var ALLOWED_ORIGINS = [
  "https://dzhun.com.cn",
  "https://www.dzhun.com.cn",
  "http://dzhun.com.cn",
  "http://www.dzhun.com.cn",
  "http://8.136.1.233",
  "https://8.136.1.233",
];
```
改为：
```js
var ALLOWED_ORIGINS = [
  "https://dzhun.com.cn",
  "https://www.dzhun.com.cn",
];
```

- [ ] **Step 2: 验证改动**

```bash
grep -n "ALLOWED_ORIGINS" /Users/yang/Desktop/贷准/worker.js | head -10
```
预期：只看到 2 个 https 域名，无 http 和 IP。

- [ ] **Step 3: Commit**

```bash
cd /Users/yang/Desktop/贷准
git add worker.js
git commit -m "security: remove http and IP from CORS whitelist"
```

---

### Task 2: 给 Worker API 响应加安全头

**Files:**
- Modify: `worker.js`（`jsonResp` 函数和 `corsHeaders` 函数）

**Context:** 当前所有 API 响应无 `X-Content-Type-Options`、`X-Frame-Options` 等安全头。找到 `function corsHeaders` 和 `function jsonResp`，注入这些头。

- [ ] **Step 1: 读取 corsHeaders 当前实现**

```bash
grep -n "function corsHeaders\|function jsonResp" /Users/yang/Desktop/贷准/worker.js
```
记录行号。

- [ ] **Step 2: 在 corsHeaders 函数返回值中补充安全头**

找到 `function corsHeaders(request)` 的 return 语句，在其中加入：
```js
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'X-Content-Type-Options':       'nosniff',
    'X-Frame-Options':              'DENY',
    'Referrer-Policy':              'strict-origin-when-cross-origin',
  };
}
```

- [ ] **Step 3: 验证**

```bash
grep -A 12 "function corsHeaders" /Users/yang/Desktop/贷准/worker.js
```
预期：返回值中包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`。

- [ ] **Step 4: Commit**

```bash
git add worker.js
git commit -m "security: add X-Content-Type-Options, X-Frame-Options, Referrer-Policy headers"
```

---

### Task 3: 支付轮询加超时（防止 interval 永久运行）

**Files:**
- Modify: `app.js:3470-3488`（`pollPayStatus` 函数）
- Modify: `app.js:3296-3300`（`_pollTimer` 变量声明区域）

**Context:** `pollPayStatus` 被 `setInterval` 每 2-3 秒调用一次，但没有最大次数限制。用户不付款时 interval 永远运行，持续消耗 Worker 配额。需要加计数器，超过 90 次（约 3 分钟）自动停止并提示用户。

- [ ] **Step 1: 在变量声明区加 `_pollCount`**

找到 `app.js` 中：
```js
let _pollTimer   = null;
let _payOrderId  = null;
let _payUrl      = null;
let _confirmed   = false;
```
改为：
```js
let _pollTimer   = null;
let _pollCount   = 0;
let _payOrderId  = null;
let _payUrl      = null;
let _confirmed   = false;
```

- [ ] **Step 2: 在每次启动轮询前重置计数器**

搜索所有 `clearInterval(_pollTimer);` 后紧跟 `_pollTimer = setInterval(pollPayStatus` 的地方（共3处），每处改为：
```js
clearInterval(_pollTimer);
_pollCount = 0;
_pollTimer = setInterval(pollPayStatus, 2000);
```
（微信支付那处是 3000ms，保持原始间隔不变）

- [ ] **Step 3: 修改 `pollPayStatus` 函数加超时逻辑**

将：
```js
async function pollPayStatus() {
  if (!_payOrderId || _confirmed) return;
  try {
    const resp = await fetch(PROXY_URL + '/api/v1/pay/status/' + _payOrderId);
    const data = await resp.json();
    if (data.status === 'paid' && data.token) {
      clearInterval(_pollTimer);
      ...
    }
  } catch(e) { /* 忽略轮询错误 */ }
}
```
改为：
```js
async function pollPayStatus() {
  if (!_payOrderId || _confirmed) return;
  _pollCount++;
  if (_pollCount > 90) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    document.getElementById('payStep2Title').textContent = '支付确认超时';
    document.getElementById('payStep2Sub') && (document.getElementById('payStep2Sub').textContent = '请关闭后重新点击「立即解锁」重试');
    return;
  }
  try {
    const resp = await fetch(PROXY_URL + '/api/v1/pay/status/' + _payOrderId);
    const data = await resp.json();
    if (data.status === 'paid' && data.token) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      ...（原有成功逻辑不变）
    }
  } catch(e) { /* 忽略轮询错误 */ }
}
```

- [ ] **Step 4: 验证改动**

```bash
grep -n "_pollCount\|_pollTimer\|pollPayStatus" /Users/yang/Desktop/贷准/app.js | head -20
```
预期：看到 `_pollCount` 在声明区、3 处 reset、`pollPayStatus` 中的超时逻辑。

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "fix: add 3-minute timeout to payment polling to prevent infinite interval"
```

---

### Task 4: 修复 calcBlastRisk 漏统 担保资格审查/资信审查

**Files:**
- Modify: `app.js:554`（`calcBlastRisk` 函数内的 filt 过滤器）

**Context:** `calcQueryCounts` 已将 `担保资格审查` 和 `资信审查` 计入贷款审批，但 `calcBlastRisk` 的 filt 过滤器只含 `贷款审批|信用卡审批`，导致两个函数不一致：查询次数显示包含这两类，但爆查风险计算却排除了它们，结果偏低。

- [ ] **Step 1: 修改 filt 过滤器**

找到 `app.js` 第 554 行：
```js
const filt = (qRecords||[]).filter(q=>q.type==='贷款审批'||q.type==='信用卡审批');
```
改为：
```js
const filt = (qRecords||[]).filter(q=>
  q.type==='贷款审批'||q.type==='信用卡审批'||
  q.type==='担保资格审查'||q.type==='资信审查'
);
```

- [ ] **Step 2: 验证**

```bash
grep -n "filt\s*=" /Users/yang/Desktop/贷准/app.js | head -5
```
预期：看到4个类型的过滤条件。

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "fix: calcBlastRisk now includes 担保资格审查 and 资信审查 consistent with calcQueryCounts"
```

---

### Task 5: 删除生产环境敏感 console.log

**Files:**
- Modify: `app.js:3081`（支付宝回跳 console.log）

**Context:** `console.log('[alipay-return] fromAlipay=', ..., 'pendingOrderId=', _pendingOrderId, ...)` 将订单 ID 明文输出到浏览器控制台，任何人打开 DevTools 即可看到。

- [ ] **Step 1: 删除敏感 console.log**

找到 `app.js` 中：
```js
console.log('[alipay-return] fromAlipay=', _fromAlipay, 'pendingOrderId=', _pendingOrderId, 'pendingValid=', _pendingValid, 'url=', location.search);
```
和：
```js
console.log('[alipay-return] verify-return:', d);
```
两行全部删除。

保留无敏感信息的：
```js
console.log('[贷准] 报告已推送');
console.log('[贷准] 代理商渠道:', _currentAgent.name, agentId);
```

- [ ] **Step 2: 验证**

```bash
grep -n "console.log.*alipay\|console.log.*orderId\|console.log.*pending" /Users/yang/Desktop/贷准/app.js
```
预期：无输出。

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "security: remove console.log that exposed orderId and payment params"
```

---

### Task 6: 移除 fonts.loli.net 外部字体 CDN

**Files:**
- Modify: `index.html:7`

**Context:** `fonts.loli.net` 是 Google Fonts 中国代理，部分网络环境可能超时 3-5 秒，导致页面渲染延迟。`onerror="this.remove()"` 虽有降级，但 `<link rel="stylesheet">` 加载超时会阻塞渲染。项目 style.css 已有系统字体栈兜底（PingFang SC / Hiragino / YaHei），字体 CDN 不是必须的。

- [ ] **Step 1: 删除 fonts.loli.net link 标签**

找到 `index.html` 第 7 行：
```html
<link href="https://fonts.loli.net/css2?family=Syne:wght@600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" onerror="this.remove()">
```
整行删除。

- [ ] **Step 2: 确认 style.css 中已有字体栈兜底**

```bash
grep -n "font-family\|PingFang\|Hiragino\|YaHei\|Syne\|JetBrains" /Users/yang/Desktop/贷准/style.css | head -10
```
预期：看到系统字体栈定义，`Syne` 和 `JetBrains Mono` 若有引用改为 fallback 字体（如 `system-ui` 或 `monospace`）。

- [ ] **Step 3: 如果 style.css 中 font-family 直接引用了 Syne/JetBrains，替换为 fallback**

```bash
grep -n "Syne\|JetBrains" /Users/yang/Desktop/贷准/style.css
```
若有结果，将：
- `'Syne'` 改为 `'PingFang SC', system-ui`
- `'JetBrains Mono'` 改为 `'SF Mono', 'Consolas', monospace`

- [ ] **Step 4: Commit**

```bash
git add index.html style.css
git commit -m "perf: remove fonts.loli.net CDN dependency, use system font stack"
```

---

### Task 7: 全量部署并验证

**Files:**
- 无代码改动

- [ ] **Step 1: 运行完整部署脚本**

```bash
cd /Users/yang/Desktop/贷准
./deploy.sh 2>&1
```
预期：看到 `✅ 部署完成`，无 error 行。

- [ ] **Step 2: 验证 Worker CORS 头**

```bash
curl -s -I -X OPTIONS \
  -H "Origin: https://dzhun.com.cn" \
  -H "Access-Control-Request-Method: POST" \
  https://api.dzhun.com.cn/api/v1/pay/status/test 2>&1 | grep -i "access-control\|x-frame\|x-content"
```
预期输出包含：
```
access-control-allow-origin: https://dzhun.com.cn
x-content-type-options: nosniff
x-frame-options: DENY
```

- [ ] **Step 3: 验证 HTTP 源被拒绝**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Origin: http://dzhun.com.cn" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://api.dzhun.com.cn/api/v1/ocr
```
预期：返回 `403`。

- [ ] **Step 4: Commit（如有最终调整）**

```bash
git add -A && git commit -m "chore: prelaunch hardening complete" || echo "nothing to commit"
```
