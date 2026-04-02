# 更新记录

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
