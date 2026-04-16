# 死代码清理与逻辑修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清除约 150 行死代码、修复 ageScore 评分 bug、修复 restartAll DOM 报错、修复贷款月供合计显示 "--" 的问题。

**Architecture:** 所有改动都在 `/Users/yang/Desktop/贷准/` 的前端文件（app.js, index.html）和 Worker 文件（worker.js）中。改动相互独立，每个 Task 都可单独提交。最后运行 `./deploy.sh` 一键上线。

**Tech Stack:** Vanilla JS, Cloudflare Worker

---

## 文件改动地图

| 文件 | Task |
|------|------|
| `app.js` | Task 1（ageScore bug）、Task 2（restartAll DOM）、Task 3（死函数删除）、Task 5（月供合计）、Task 6（负值保护）|
| `worker.js` | Task 4（handleClaude 旧路由） |

---

### Task 1: 修复 ageScore 评分 bug（`||` → `&&`）

**Files:**
- Modify: `/Users/yang/Desktop/贷准/app.js:833`

**背景：** `ScoreEngine.extractFeatures` 中 ageScore 的第二个条件 `age>=25||age<=50` 对任何正整数都为 true（25岁以上OR50岁以下覆盖所有人），导致 0.65 兜底分永远触发不到，实际上 35岁以下或50岁以上的用户都错误地拿到 0.8 分。应为 `&&`。

- [ ] **Step 1: 找到当前行**

```bash
grep -n "ageScore\|age>=25\|age<=50" /Users/yang/Desktop/贷准/app.js
```
预期看到第 833 行包含 `(age>=25||age<=50)?0.8:0.65`

- [ ] **Step 2: 用 Edit 工具精确替换**

old_string（第 833 行完整内容）：
```js
    const ageScore = (() => { if(!age)return 0.5; return(age>=28&&age<=45)?1.0:(age>=25||age<=50)?0.8:0.65; })();
```

new_string：
```js
    const ageScore = (() => { if(!age)return 0.5; return(age>=28&&age<=45)?1.0:(age>=25&&age<=50)?0.8:0.65; })();
```

- [ ] **Step 3: 验证**

```bash
grep -n "ageScore" /Users/yang/Desktop/贷准/app.js
```
预期：只有 `&&` 没有 `||`。

- [ ] **Step 4: Commit**

```bash
cd /Users/yang/Desktop/贷准
git add app.js
git commit -m "fix: ageScore || should be && (ages outside 25-50 now correctly score 0.65)"
```

---

### Task 2: 修复 restartAll() 中不存在的 DOM ID

**Files:**
- Modify: `/Users/yang/Desktop/贷准/app.js`（restartAll 函数，约第 3171-3270 行）

**背景：** `restartAll()` 引用了两个不存在的 DOM ID：
1. `'ml1','ml2','ml3','ml4'`（旧版加载步骤 ID，当前 HTML 中不存在）—— 第 3200 行的 `el.classList.remove()` 会在 null 上抛 `TypeError`
2. `'upload-section'`（第 3269 行）—— HTML 中该元素 ID 是 `uploadCard`

`rematch()` 函数（第 3272 行）的 ml1-ml4 引用有 `if(el)` 保护，不需要改。

- [ ] **Step 1: 确认当前代码**

读取 app.js 第 3196-3210 行和第 3265-3272 行，确认两处问题。

- [ ] **Step 2: 修复 ml1-ml4 的 null 崩溃**

找到：
```js
  ['ml1','ml2','ml3','ml4'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
  });
  document.getElementById('matchingLoading').style.display = 'block';
  document.getElementById('ml1').classList.add('active'); // re-activate first step
```

改为（加 null 保护）：
```js
  ['ml1','ml2','ml3','ml4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
  document.getElementById('matchingLoading').style.display = 'block';
  const _ml1 = document.getElementById('ml1');
  if (_ml1) _ml1.classList.add('active');
```

- [ ] **Step 3: 修复 upload-section → uploadCard**

找到：
```js
  document.getElementById('upload-section').scrollIntoView({ behavior:'smooth' });
```

改为：
```js
  document.getElementById('uploadCard').scrollIntoView({ behavior:'smooth' });
```

- [ ] **Step 4: 验证**

```bash
grep -n "upload-section\|el\.classList\.remove\('active'\|el\.classList" /Users/yang/Desktop/贷准/app.js | head -10
```
预期：无 `upload-section`；ml1-ml4 循环中有 `if (el)` 保护。

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "fix: restartAll null guard for ml1-ml4 and fix upload-section → uploadCard"
```

---

### Task 3: 删除 app.js 中的死函数

**Files:**
- Modify: `/Users/yang/Desktop/贷准/app.js`

**背景：** 以下函数从未被调用，是遗留代码（注释或文档有记录）：
- `loadProducts()` 第 1 行（空函数）+ 第 ~3065 行的调用 `loadProducts();`
- `buildProductLibText(...)` 第 3-95 行（已改为 Worker 端构建，前端不再需要）
- `_rl` 变量 + `checkRateLimit()` 第 2953-2961 行（只被下面两个死函数调用）
- `callMatch(...)` 第 2963-2992 行（注释已写明不经过此函数）
- `callAI(...)` 第 2994 行起（旧版 AI 调用，已迁移到 Worker）

删除顺序：先删文件头部的 buildProductLibText（行 1-95），再删文件底部的死函数组（_rl 变量 + checkRateLimit + callMatch + callAI），最后删 loadProducts 调用。

- [ ] **Step 1: 确认各函数的起止行**

```bash
grep -n "^function loadProducts\|^function buildProductLibText\|^const _rl\|^function checkRateLimit\|^async function callMatch\|^async function callAI" /Users/yang/Desktop/贷准/app.js
```
记录每个函数的起始行号。

- [ ] **Step 2: 确认 callAI 的结束行**

读取 callAI 函数起始行之后约 35 行，找到函数结束的 `}` 位置。

- [ ] **Step 3: 删除文件头的 loadProducts + buildProductLibText（第 1-95 行）**

old_string（第 1 行 到第 95 行，即从 loadProducts 到 buildProductLibText 结束，包含尾部空行）：
```js
function loadProducts() {} // 已内置，保留空函数供初始化调用兼容

// ── 动态生成 AI prompt 用的产品库文本 ──
function buildProductLibText(q3, q6, hasOverdue, onlineCount, q1) {
```
（注意：需要用 Edit 工具，old_string 必须与文件内容完全一致。先 Read 第 1-96 行，复制完整内容作为 old_string，new_string 为空字符串）

- [ ] **Step 4: 删除 _rl + checkRateLimit + callMatch + callAI 死函数组**

这组代码从 `// 前端简单限流：60秒内最多5次（防误触/恶意刷）` 注释开始，到 callAI 函数结束的 `}` 为止。
先 Read 确认起始行和结束行，然后用 Edit 精确删除整段。

- [ ] **Step 5: 删除 loadProducts() 调用**

```bash
grep -n "loadProducts()" /Users/yang/Desktop/贷准/app.js
```
找到调用行（约 DOMContentLoaded 内），用 Edit 删除该行。

- [ ] **Step 6: 验证无残留引用**

```bash
grep -n "loadProducts\|buildProductLibText\|callMatch\|callAI\b\|checkRateLimit\|_rl\." /Users/yang/Desktop/贷准/app.js
```
预期：无输出。

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "chore: remove dead functions loadProducts, buildProductLibText, callMatch, callAI, checkRateLimit (~150 lines)"
```

---

### Task 4: 替换 worker.js 的 handleClaude 旧路由

**Files:**
- Modify: `/Users/yang/Desktop/贷准/worker.js`

**背景：** `handleClaude` 是旧版根路由（`PROXY_URL/` 直接调用 Claude），已被 `/api/v1/match` 和 `/api/v1/ocr` 取代。当前代码中所有主动调用都使用带路径的 API，无代码使用根路径。将 fallback 改为返回 404，然后删除 `handleClaude` 函数体以减少攻击面。

- [ ] **Step 1: 确认当前 fallback 和函数**

```bash
grep -n "handleClaude\|旧版.*路由\|\/claude" /Users/yang/Desktop/贷准/worker.js
```

- [ ] **Step 2: 替换 fallback 调用**

找到：
```js
    // 兼容旧路由：无 path 或 / 走 Claude 代理
    return handleClaude(request, env);
```

改为：
```js
    return jsonResp({ error: 'Not Found' }, 404, request);
```

- [ ] **Step 3: 删除 handleClaude 函数**

找到从 `// 旧版 /claude 路由（保留兼容，逻辑不变）` 注释到函数结束 `}` 的完整代码段，用 Edit 删除。

- [ ] **Step 4: 验证**

```bash
grep -n "handleClaude\|旧版.*claude" /Users/yang/Desktop/贷准/worker.js
```
预期：无输出。

- [ ] **Step 5: Commit**

```bash
git add worker.js
git commit -m "chore: remove legacy handleClaude route, return 404 for unknown paths"
```

---

### Task 5: 修复 renderTableFooters 贷款月供合计

**Files:**
- Modify: `/Users/yang/Desktop/贷准/app.js:2762`

**背景：** `renderTableFooters` 中贷款合计月供用 `l.monthly || 0`，但简版征信 OCR 返回的 `monthly` 字段基本都是 `null`（征信不含月供信息），导致合计行永远显示 `--`。而表格每行单独调用 `calcLoanMonthly(l)` 计算显示，合计行与明细行不一致。应改为用 `calcLoanMonthly(l)` 计算合计。

- [ ] **Step 1: 确认当前代码**

```bash
grep -n "totalMonthly\|l\.monthly\|loans-total-monthly" /Users/yang/Desktop/贷准/app.js | head -10
```

- [ ] **Step 2: 修改合计计算**

找到（约第 2762 行）：
```js
    const totalMonthly = loans.reduce((s, l) => s + (l.monthly || 0), 0);
```

改为：
```js
    const totalMonthly = loans.reduce((s, l) => s + calcLoanMonthly(l), 0);
```

- [ ] **Step 3: 验证**

```bash
grep -n "totalMonthly" /Users/yang/Desktop/贷准/app.js
```
预期：看到 `calcLoanMonthly(l)` 而非 `l.monthly`。

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "fix: renderTableFooters loan total now uses calcLoanMonthly instead of null monthly field"
```

---

### Task 6: calcTotalMonthly 信用卡 used 负值保护

**Files:**
- Modify: `/Users/yang/Desktop/贷准/app.js:700`

**背景：** `calcTotalMonthly` 中信用卡月供用 `(c.used || 0) * 0.02`，若 OCR 错误返回负数 `used`（如 `-100`），月供会变负，拉低总月供，导致负债率偏低进而影响产品准入判断。

- [ ] **Step 1: 确认当前代码**

读取 app.js 第 697-702 行。

- [ ] **Step 2: 修改**

找到：
```js
  const cardPart = cards.reduce((s, c) => s + Math.round((c.used || 0) * 0.02), 0);
```

改为：
```js
  const cardPart = cards.reduce((s, c) => s + Math.round(Math.max(0, c.used || 0) * 0.02), 0);
```

- [ ] **Step 3: 验证**

```bash
grep -n "cardPart\|Math.max.*used" /Users/yang/Desktop/贷准/app.js
```
预期：看到 `Math.max(0, c.used || 0)`。

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "fix: calcTotalMonthly guard against negative card used balance"
```

---

### Task 7: 全量部署

**Files:** 无代码改动

- [ ] **Step 1: 部署**

```bash
cd /Users/yang/Desktop/贷准
./deploy.sh 2>&1 | tail -5
```
预期：`✅ 部署完成`

- [ ] **Step 2: 验证 Worker 旧路由返回 404**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Origin: https://dzhun.com.cn" \
  -H "Content-Type: application/json" \
  -d '{"test":1}' \
  https://api.dzhun.com.cn/
```
预期：`404`

- [ ] **Step 3: 验证新路由正常**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Origin: https://dzhun.com.cn" \
  -H "Content-Type: application/json" \
  -d '{"fileBlocks":[],"cacheKey":"test"}' \
  https://api.dzhun.com.cn/api/v1/ocr
```
预期：`400` 或 `200`（有响应，不是 404/502）
