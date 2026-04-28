# 更新记录

## 2026-04-28

### Feature
- **转介绍归因 Phase 0**：`?ref=R001` 参数捕获 + 持久化到 localStorage，OCR/留资/报告流程透传 `ref_id`，企微通知模板新增"推荐人"行（无 ref 时不显示，直客通知保持原样）。代理商在企微群直接看到每条线索由哪个推荐人扫码带来，不上 D1、不做后台、不做奖励，先验证"老客户愿不愿意转发"假设。
- **代理商切换**：测试代理商 `XY001`（夏阳）→ 生产代理商 `AHX`（安惠信）。AGENTS / AGENT_WEBHOOKS / KV `agent:AHX` 全部硬切，不保留 alias（旧 XY001 链接无真实推荐人和有效用量，已确认可断）。

### 改动文件
- `config.js`：AGENTS 主键 XY001 → AHX，name 安惠信
- `app.js`：`initContactPhone` 加 ref 捕获；`autoSendReport` body 加 `ref_id`
- `worker.js`：`handleReport` 提取 `ref_id` 并下传；`sendWechatPdf` 签名加 `refId`，markdown 模板加推荐人行；AGENT_WEBHOOKS 主键 AHX
- `index.html` / `admin.html` / `贷准_贷款中介推广讲解文档.html` / `CLAUDE.md`：示例 URL 和文档里的 XY001 全部改为 AHX
- `deploy.sh`：补漏，sed 和 scp 同时覆盖 index.html + checkup.html
- KV：`agent:AHX` 已写入（remote），`agent:XY001` 待清理

## 2026-04-01

### Bug Fix
- **产品分类错误**：`products.push()` 缺少 `type` 字段，导致工商银行/农业银行等全部被误判为消费金融，申请路径步骤3显示"工商银行等消费金融"。加入 `type: p.type` 修复。
- **额度显示错误**：负债过高时 `curAmt='当前负债较高'` 被嵌入"约 __ 万"模板，显示为"约 当前负债较高 万"。改用 `_isAmtNum()` 判断后动态渲染。
- **客服二维码加载失败**：微信OAuth跳转后相对路径 `qr.jpg` 解析偏移，改为绝对URL `https://dzhun.com.cn/qr.jpg`。

### 代码清理（详见 SIMPLIFY_LOG.md）
- 提取全局 `WORK_TYPE_MAP`，消除3处重复定义
- 提取 `getActiveLoans()` / `getActiveCards()`，消除9处重复filter
- 删除死代码 `const stepTimer = null`
- 优化 `mlSteps.forEach` 中的双次 getElementById 调用

### 验证（wrangler tail 实测）
- 支付流程：KV-first 命中，confirm 轮询在微信回调后立即返回 token
- AI 调用：`POST /match` 在支付完成后约8秒触发，正常返回
