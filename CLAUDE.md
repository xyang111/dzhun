# 贷准 · AI征信匹配平台 — 项目说明

## 项目概述
厦门本地AI贷款匹配平台，用户上传人行简版征信报告，AI自动识别负债情况，匹配可申请的银行/消费金融产品。
域名：dzhun.com.cn | 公司：厦门贷准科技有限公司

**Stack：** HTML/JS/CSS 前端部署在阿里云 ECS（Nginx），Cloudflare Workers 做 API 代理，OCR 用 Claude Vision，Match 用 DeepSeek API，数据存储 Cloudflare KV + D1。

## Deployment Checklist
每次部署到 Cloudflare Worker 或 ECS 后必须执行：
1. 更新 `index.html` 中所有引用变更文件的 cache-busting 版本号（如 `?v=X.X`），不能沿用旧版本号
2. 确认 `config.js` 在 `app.js` 之前加载（顺序已固定，改动 index.html 时注意保持）
3. Worker 部署后验证 `api.dzhun.com.cn` 路由是否正常响应

## Debugging Protocol
排查生产问题时，按以下顺序检查，**不得在确认根因前进行多次投机性代码修复**：
1. 部署的代码是最新版本吗？（缓存/CDN 问题，检查版本号）
2. 前端和后端是否存在冲突的硬编码值？（如 frontend 的 `max_tokens` 覆盖 Worker 设置）
3. 是环境问题而非代码问题吗？（HTTPS、DNS、设备特定、微信内置浏览器）
4. Worker 改动后，同时检查前端请求参数和 Worker 处理逻辑，单侧修复不等于全链路修复

## UI/Mobile Guidelines
- 移动端是主要使用场景，UI 改动后必须在脑中过一遍手机视口
- 检查项：白底白字（文字不可见）、overflow 隐藏元素、触控目标尺寸是否足够大
- 动态 HTML 由 `app.js` 生成，CSS 类名改动必须同步检查 `app.js` 里的字符串引用

## Architecture Map

| 文件 | 用途 | 部署位置 | 注意事项 |
|------|------|---------|---------|
| `index.html` | HTML 骨架，引用所有静态资源 | 阿里云 ECS `/usr/share/nginx/html/` | 改动后必须更新 `?v=` 版本号 |
| `style.css` | 全部 CSS 样式 | 阿里云 ECS | 类名改动必须同步检查 `app.js` 字符串引用 |
| `config.js` | PROXY_URL / AGENTS / BANK_PRODUCTS | 阿里云 ECS | **必须在 `app.js` 之前加载**，最高频改动文件 |
| `app.js` | 全部业务逻辑，ScoreEngine V2.0，47个函数 | 阿里云 ECS | 含动态 HTML 生成，CSS 改动需联动检查 |
| `worker.js` | API 代理、OCR、Match、支付、D1写入 | Cloudflare Worker（`api.dzhun.com.cn`） 
| `wrangler.toml` | Worker 部署配置，KV×2 + D1 绑定 | 本地配置文件 | 绑定变量名不能随意改，与 Worker 代码耦合 |
| `qr.jpg` | 默认客服微信二维码 | 阿里云 ECS | 禁止内嵌 base64 |
| `qr_agent_1.jpg` | 代理商 AHX（安惠信）二维码 | 阿里云 ECS | 禁止内嵌 base64 |

**API 路由（Cloudflare Worker）**

| 路由 | 功能 | 调用的 AI |
|------|------|---------|
| `POST /api/v1/ocr` | 征信截图识别 | Claude Vision（`ANTHROPIC_API_KEY`） |
| `POST /api/v1/match` | 产品匹配文字分析 | DeepSeek（`DEEPSEEK_API_KEY`） |
| `POST /api/v1/score` | 写入评分记录到 D1 | 无 |
| `POST /api/v1/pay/create` | 创建支付订单 | 无 |
| `POST /api/v1/report` | 发送邮件报告 | 无 |

**关键依赖关系**
- `config.js` → `app.js`（加载顺序强依赖）
- `app.js` ScoreEngine → `worker.js` buildMatchPrompt（评分逻辑需两端同步）
- Cloudflare KV `ORDERS`：支付 token 存储 | `CACHE`：OCR 结果缓存（2小时）
- Cloudflare D1 `dzhun-scores`：评分记录，`score_records` 表，session_id 唯一索引

## 当前状态（2026-04）
- 网站正常运行，ICP备案已通过（闽ICP备2026009746号）
- 支付宝 WAP支付：✅ 正常
- 微信 JSAPI支付：✅ 正常（仅限微信内打开）
- 微信 H5支付：❌ 审核未通过，已禁用（非微信浏览器只展示支付宝按钮）

## 文件结构
- `index.html`  — HTML骨架，引用 style.css / config.js / app.js
- `style.css`   — 全部CSS样式
- `config.js`   — 配置层：PROXY_URL / AGENTS / BANK_PRODUCTS（须在 app.js 之前加载）
- `app.js`      — 全部业务逻辑（含 ScoreEngine V2.0）
- `qr.jpg`      — 默认客服微信二维码（直客渠道）
- `qr_agent_1.jpg` — 代理商 AHX（安惠信）微信二维码
- `worker.js`   — Cloudflare Worker后端（API代理+支付+报告推送+D1写入）
- `wrangler.toml` — Worker部署配置（含 KV × 2 + D1 绑定）

## 部署方式
```bash
# 一键部署（Worker + 前端）
./deploy.sh

# 或手动：
npx wrangler@4 deploy
scp index.html style.css config.js app.js qr.jpg qr_agent_1.jpg root@8.136.1.233:/usr/share/nginx/html/
```

## 技术架构
- 前端：HTML+CSS+JS 拆分为4文件，部署在阿里云ECS（Nginx）
- 后端：Cloudflare Worker（api.dzhun.com.cn）
- AI：claude-sonnet-4-20250514，通过Worker代理调用
- 存储：Cloudflare KV — ORDERS（支付订单/token）、CACHE（OCR结果缓存）；D1 — dzhun-scores（score_records 评分记录）
- 邮件：Resend（report@dzhun.com.cn → 651047968@qq.com）

## 核心业务流程
1. 用户上传简版征信截图（JPG/PNG，支持多张）
2. OCR提取：调用Claude Vision识别账户/查询记录（免费）
3. 用户填写补充信息（收入/社保/公积金/学历/户籍/资产）
4. 产品匹配：付费9.9元后调用Claude分析，返回匹配产品+建议
5. 结果推送：自动发送报告到运营邮箱，代理商渠道额外推企业微信

## 核心架构：双引擎 + V2.0 评分
- **ScoreEngine V2.0**（app.js）：102维，300-1000分，4个域（信用行为40%/稳定性30%/资产偿债25%/反欺诈5%）
  - 评分结果用于 Sigmoid 通过率计算 + XAI 诊断 + 五轴雷达图展示
  - 同时异步 fire-and-forget 写入 D1（`/api/v1/score`），用于运营分析
  - 旧百分制（0-100）圆形仪表盘仍保留，仅用于 OCR 后的即时展示，不参与产品匹配
- **产品匹配主引擎**：`localFallbackMatch(data, v2Score)`（本地规则，Sigmoid 通过率用 V2.0 分数计算）
- **AI**：只负责文字类字段（分析建议/optimization/advice），失败时直接用本地引擎结果

## 评分系统说明（重要，两套并存）
| 系统 | 范围 | 用途 |
|------|------|------|
| `calcCreditScore()` 旧百分制 | 0-100 | OCR完成后即时展示的圆形仪表盘，不影响产品匹配 |
| `ScoreEngine` V2.0 | 300-1000（地板300） | 产品匹配通过率（Sigmoid）、XAI诊断、雷达图、D1存储 |

**不要混用两套分数**：产品匹配和通过率计算只用 V2.0；展示层的圆圈只用旧百分制。

## Worker环境变量（Cloudflare Dashboard配置）
- ANTHROPIC_API_KEY / RESEND_API_KEY
- WECHAT_APPID / WECHAT_MCH_ID / WECHAT_SERIAL / WECHAT_PRIV_KEY / WECHAT_API_V3_KEY
- ALIPAY_APP_ID / ALIPAY_PRIV_KEY / ALIPAY_PUB_KEY

## Worker 路由一览（/api/v1/* 为规范路径，旧路径兼容保留）
- `POST /api/v1/ocr`                  — OCR识别，前端传 fileBlocks+cacheKey
- `POST /api/v1/match`                — 产品匹配分析，需付费token
- `POST /api/v1/score`                — 写入评分记录到 D1（fire-and-forget，无需鉴权）
- `POST /api/v1/pay/create`           — 创建支付订单
- `GET  /api/v1/pay/status/:id`       — 查询订单状态
- `POST /pay/notify/wechat`           — 微信支付回调（平台固定URL，不加前缀）
- `POST /pay/notify/alipay`           — 支付宝回调（平台固定URL，不加前缀）
- `POST /api/v1/report`               — 发送邮件报告
- `GET  /api/v1/pay/wechat/oauth`     — 微信 OAuth code 换 openid
- `POST /api/v1/pay/wechat/confirm`   — 主动查询微信支付状态
- `GET  /api/v1/pay/alipay/verify-return` — 支付宝回跳验签

**注意：`/products` 路由已删除**（P0安全修复），产品库 `BANK_PRODUCTS` 硬编码在 `config.js`。

## 关键函数说明
- `startAnalysis()`           — OCR识别，免费，支持多图
- `startMatching()`           — 产品匹配，需付费token；内部运行 ScoreEngine → localFallbackMatch → 渲染
- `ScoreEngine`（类）         — V2.0评分引擎，`.compute()` 返回 score/level/domainScores/xai/features
- `localFallbackMatch(data, v2Score)` — 本地规则引擎，产品筛选+Sigmoid通过率（使用V2.0分数）
- `renderV2XAI(v2)`           — 渲染雷达图（五轴SVG）+ 四域分数条 + XAI问题列表
- `calcQueryCounts()`         — 查询次数统计（报告日期为基准，自然月）
- `calcBlastRisk()`           — 爆查风险指数计算
- `calcLoanMonthly()`         — 单笔贷款月供估算（见下方逻辑说明）
- `calcTotalMonthly()`        — 总月供 = 贷款月供合计 + 信用卡已用额度×2%
- `autoSendReport()`          — 匹配完成后自动推送报告
- `loadProducts()`            — 已废弃（空函数，保留兼容调用）

## 月供估算逻辑（calcLoanMonthly）
简版征信不含利率和还款方式，通过以下规则推算：

| 类型 | 判断依据 | 计算方式 |
|---|---|---|
| 房贷 | loan_category=mortgage | 余额×0.55% |
| 车贷 | loan_category=car | 余额×3.04% |
| 银行循环贷 | is_revolving=true | 先息后本，余额×0.375%（4.5%年化） |
| 银行非循环贷（先息后本） | elapsed>=**2**月 且 B/L>97% | 余额×0.375% |
| 银行非循环贷（等额本息） | elapsed>=1月 且 B/L<=97% | PMT(4.5%年化, 剩余期数=B/L×36) |
| 消费金融/网贷循环贷 | is_revolving=true + finance类 | 等额本息，同下 |
| 消费金融 | finance类 | PMT(18%年化, 剩余期数=36-elapsed) |
| 网贷 | online类 | PMT(18%年化, 剩余期数=12-elapsed) |

**关键逻辑：**
- 银行循环贷余额下降是主动还款，不代表有固定还款计划，一律按先息后本
- B/L=余额/授信额度，<97%说明本金已减少，判定为等额本息
- **先息后本需 elapsed >= 2**：开立后第1个月余额尚未变化，elapsed=1时不能判定类型，会误判
- 简版征信不体现还款方式，以上为推算逻辑，月供标注"估算"

## 爆查风险指数逻辑（calcBlastRisk）
- 近7天：超过1次才开始扣分（第1次不扣）
- 近30天：超过3次每超1次扣8分
- 集中度：需3个月总量≥3次才参与计算，样本不足显示"--"

## 产品库
- 位置：`config.js` 里的 BANK_PRODUCTS 数组（22款产品）
- 覆盖：国有大行/股份制银行/城商行/消费金融/本地小贷（厦门区域）
- 修改：改 config.js 的 BANK_PRODUCTS，重新 deploy 即生效（最高频改动文件）

## 代理商系统
- URL参数：?agent=AHX
- 配置位置：`config.js` 顶部 AGENTS 对象
- 二维码：每个代理商对应独立图片文件（如 qr_agent_1.jpg），不内嵌 base64
- 效果：替换页面电话和微信二维码，报告推送给代理商企业微信群

## 注意事项
- 前端已拆分为4文件，不要再合并回单文件
- config.js 必须在 app.js 之前加载（index.html 中顺序已固定）
- 二维码图片统一用路径引用，不要内嵌 base64（会导致 config.js 膨胀到 380KB）
- 字体使用系统字体栈（PingFang SC / Hiragino / YaHei），不引入外部字体 CDN
- OCR Prompt 和 Match Prompt 均在 worker.js 里，不在前端源码中
- Worker的密钥通过 wrangler secret 设置，不写在代码里
- **ScoreEngine 前后端同步**：app.js 和 worker.js 中若有 ScoreEngine 逻辑，必须同步更新，防止分数不一致
- **不要在 localFallbackMatch 里调用 calcCreditScore()**：已清除，该函数只用于展示圆圈，不参与匹配计算

## D1 数据库
- 数据库名：`dzhun-scores`，绑定变量：`env.DB`
- 表：`score_records`（session_id 唯一索引，防重复写入）
- 查询命令：`npx wrangler@4 d1 execute dzhun-scores --remote --command "SELECT * FROM score_records ORDER BY created_at DESC LIMIT 20;"`
- 前端每次 ScoreEngine 运行后异步上报，D1 写入失败静默处理，不影响主流程
