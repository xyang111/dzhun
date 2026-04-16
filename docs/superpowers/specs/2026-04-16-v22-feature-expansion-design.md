# 贷准 v2.2 功能扩展设计文档

**日期**：2026-04-16  
**状态**：已审批，待实施  

---

## 概述

本次扩展包含四个独立模块，可并行开发：

| 模块 | 改动范围 | 复杂度 |
|------|----------|--------|
| M1：查询记录折叠展示 | 纯前端 app.js | 低 |
| M2：OCR 文件大小限制 | 纯前端 app.js | 低 |
| M3：ECS PDF 下载服务 | ECS 新服务 + Worker + 前端 | 高 |
| M4：代理商 URL Token 系统 | Worker KV + 前端 | 中 |

---

## M1：近半年查询记录折叠展示

### 目标
在评分报告中展示征信报告里近半年的有效查询记录明细，帮助用户了解哪些机构查询了自己的信用。

### 数据来源
OCR 结果中已有 `query_records` 数组，每条包含：
- `date`：查询日期（YYYY-MM-DD）
- `type`：查询类型（贷款审批/信用卡审批/担保资格审查/保前审查/融资租赁审批）
- `institution`：机构名称

### 实现细节

**过滤规则**：保留距报告日期（`report_date`）≤ 183 天的记录。

**UI 结构**：
```
[近半年查询次数：X次] [查看明细 ▼]
┌────────────────────────────────────┐
│ 机构名称        查询类型   查询日期  │
│ 招商银行        信用卡审批 2025-12  │
│ 平安消费金融    贷款审批   2025-11  │
│ ...                                │
└────────────────────────────────────┘
```

- 默认折叠，点击展开/收起
- 按日期倒序排列
- 记录为空时不显示折叠块

**改动文件**：`app.js`（在查询次数展示逻辑附近新增折叠 DOM 和事件绑定）

---

## M2：OCR 文件大小/数量前端限制

### 目标
在上传阶段拦截过大或过多的文件，避免 Textin 按页计费导致不必要的成本。

### 限制规则

| 场景 | 限制 | 提示文案 |
|------|------|----------|
| 图片（单张或多张） | 最多 12 张，每张 ≤ 3MB | "图片超出限制，请上传不超过12张、每张不超过3MB的征信截图" |
| PDF | 文件大小 ≤ 3MB | "PDF超过3MB，请上传简版征信（通常不超过3MB）" |

### 实现细节

在 `app.js` 中，文件选择后、组装 `fileBlocks` 前执行校验：
1. 遍历 `files` 数组，检查 `file.size`（单位 bytes，3MB = 3 * 1024 * 1024）
2. 检查图片数量 `files.length <= 12`
3. 校验失败时 UI 提示，清空文件选择，**不发请求**

**改动文件**：`app.js`（上传处理函数内）

---

## M3：ECS PDF 下载服务

### 目标
用户付费后可下载包含完整报告内容的 PDF 文件。

### 架构

```
用户点击"下载报告" 
→ 前端 POST /api/v1/pdf（携带报告数据 JSON）
→ Worker 拼装 HTML，POST http://8.136.1.233:3001/render
→ ECS Node.js + Puppeteer 渲染 HTML → 返回 PDF binary
→ Worker 将 PDF 流式返回前端
→ 前端触发浏览器下载
```

### ECS 服务（`/opt/pdf-service/`）

**技术栈**：
- Node.js 18+
- `puppeteer-core`（不自动下载 Chromium）
- 系统 Chromium：`dnf install chromium -y`（Alibaba Cloud Linux 3，解决中国服务器问题）
- `pm2` 进程管理

**接口**：
```
POST http://localhost:3001/render
Headers: X-PDF-Secret: <secret>
Body: { html: "<html>...</html>", filename: "贷准报告_张三_20260416" }
Response: Content-Type: application/pdf，binary stream
```

**鉴权**：固定 header `X-PDF-Secret`，值存入 Worker secret（`wrangler secret put PDF_SERVICE_SECRET`）。不匹配直接返回 403。

**端口**：3001，仅监听 `127.0.0.1`（Nginx 反向代理暴露为 `https://dzhun.com.cn/pdf-render`，加 Nginx basic auth，或直接用 ECS 内网 IP 从 Worker 调用）

> **注意**：Cloudflare Worker 调用 ECS 需走公网 IP，所以接口通过 Nginx 代理暴露，路径：`https://dzhun.com.cn/pdf-render`，Nginx 限制只允许来自 Cloudflare IP 的请求（或用 secret header 鉴权即可，不必限 IP）。

**pm2 配置**（`ecosystem.config.js`）：
```js
module.exports = {
  apps: [{ name: 'pdf-service', script: 'server.js', cwd: '/opt/pdf-service' }]
};
```

### Worker 端（新增路由 `/pdf`）

- 校验用户付费状态（复用现有逻辑）
- 从 request body 取报告 JSON，调用 `buildPdfHtml(data)` 拼装 HTML
- `fetch('https://dzhun.com.cn/pdf-render', { method: 'POST', headers: { 'X-PDF-Secret': env.PDF_SERVICE_SECRET }, body: JSON.stringify({ html }) })`
- 将 ECS 返回的 PDF binary 直接 pipe 给前端

### PDF 内容

1. 标题：贷准 · 智能贷款评估报告
2. 基本信息：姓名、报告日期（脱敏身份证号）
3. 综合评分 + 等级
4. 各维度得分（文字版，不依赖 canvas 图表）
5. 近半年查询记录表（同 M1 内容）
6. 可申请产品列表
7. 页脚水印：生成时间 + dzhun.com.cn

### 前端

- 付费成功后结果页底部显示"下载报告 PDF"按钮
- 点击后：按钮变 loading，`fetch('/api/v1/pdf', { body: JSON.stringify(reportData) })`
- 拿到 blob 后：`URL.createObjectURL(blob)` + `<a download>` 触发下载
- 文件名：`贷准报告_${name}_${date}.pdf`

**改动文件**：`worker.js`（新增 `/pdf` 路由 + `buildPdfHtml` 函数）、`app.js`（下载按钮逻辑）、ECS 新建 `/opt/pdf-service/`

---

## M4：代理商 URL Token 系统

### 目标
给代理商一个专属 URL，分配固定使用次数（OCR 次数），用完后由管理员通过命令行充值。

### URL 格式

```
https://dzhun.com.cn?agent=XY001
```

### 数据结构（KV ORDERS）

```
key:   "agent:XY001"
value: {
  "name": "代理商XY001",
  "quota": 500,
  "used": 0,
  "created_at": "2026-04-16"
}
```

### 计费规则

- 每次 `/ocr` 请求（非缓存命中）：`used += 1`
- Cache hit（同一文件 2 小时内重复上传）：**不扣次数**
- `used >= quota`：返回 `{ error: "代理商额度已用完，请联系贷准充值" }`，HTTP 403

### 前端逻辑

1. 页面加载时：`const agentId = new URLSearchParams(location.search).get('agent')`
2. 存入模块变量（不写 localStorage，防止 agent token 跨会话泄漏）
3. OCR 请求 body 新增 `agentId` 字段

### Worker 逻辑（`/ocr` 路由修改）

```
有 agentId？
  ├─ 是 → 读 KV agent 数据
  │        额度够？→ 放行（cache miss 时扣减，cache hit 时不扣）
  │        额度满？→ 403
  └─ 否 → 走原有付费校验（C 端用户）
```

扣减逻辑放在 OCR 成功返回、写缓存之后（确保 OCR 成功才算一次）。

### 管理操作（命令行）

**新建代理商**：
```bash
wrangler kv:key put --binding=ORDERS "agent:XY001" '{"name":"代理商XY001","quota":500,"used":0,"created_at":"2026-04-16"}'
```

**查看用量**：
```bash
wrangler kv:key get --binding=ORDERS "agent:XY001"
```

**充值（追加额度）**：读取当前值，修改 `quota` 后重新写入。

**改动文件**：`worker.js`（`/ocr` 路由扩展）、`app.js`（读取 URL 参数，传 agentId）

---

## 实施顺序建议

1. **M2**（最简单，防止成本泄漏，优先上）
2. **M1**（数据已有，纯前端）
3. **M4**（Worker + 前端，中等复杂度）
4. **M3**（涉及 ECS 新服务，最后做）
