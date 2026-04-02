# 贷准 · AI征信匹配平台 — 项目说明

## 项目概述
厦门本地AI贷款匹配平台，用户上传人行简版征信报告，AI自动识别负债情况，匹配可申请的银行/消费金融产品。
域名：dzhun.com.cn | 公司：厦门贷准科技有限公司

## 当前状态（2026-04）
- 网站正常运行，ICP备案已通过（闽ICP备2026009746号）
- 支付宝 WAP支付：✅ 正常
- 微信 JSAPI支付：⏳ 预开通中（已配置网页授权域名和JS接口安全域名）
- 微信 H5支付：✅ 已开通（仅限微信外部浏览器）

## 文件结构
- `index.html`  — HTML骨架（718行），引用 style.css / config.js / app.js
- `style.css`   — 全部CSS样式（873行）
- `config.js`   — 配置层：PROXY_URL / AGENTS / BANK_PRODUCTS（须在 app.js 之前加载）
- `app.js`      — 全部业务逻辑，47个函数（2621行）
- `qr.jpg`      — 默认客服微信二维码（直客渠道）
- `qr_agent_1.jpg` — 代理商 XY001 微信二维码
- `worker.js`   — Cloudflare Worker后端（API代理+支付+报告推送）
- `wrangler.toml` — Worker部署配置

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
- 存储：Cloudflare KV — ORDERS（支付订单/token）、CACHE（OCR结果缓存24h）
- 邮件：Resend（report@dzhun.com.cn → 651047968@qq.com）

## 核心业务流程
1. 用户上传简版征信截图（JPG/PNG，支持多张）
2. OCR提取：调用Claude Vision识别账户/查询记录（免费）
3. 用户填写补充信息（收入/社保/公积金/学历/户籍/资产）
4. 产品匹配：付费9.9元后调用Claude分析，返回匹配产品+建议
5. 结果推送：自动发送报告到运营邮箱，代理商渠道额外推企业微信

## 核心架构：双引擎
- 产品匹配主引擎：`localFallbackMatch`（本地规则，产品筛选+通过率计算）
- AI只负责文字类字段：分析建议/problems/optimization/advice
- AI失败时直接用本地引擎结果，产品完整显示

## Worker环境变量（Cloudflare Dashboard配置）
- ANTHROPIC_API_KEY / RESEND_API_KEY
- WECHAT_APPID / WECHAT_MCH_ID / WECHAT_SERIAL / WECHAT_PRIV_KEY / WECHAT_API_V3_KEY
- ALIPAY_APP_ID / ALIPAY_PRIV_KEY / ALIPAY_PUB_KEY

## Worker 路由一览
- `GET  /products`            — 返回产品库（前端启动时拉取）
- `POST /ocr`                 — OCR识别，前端传 fileBlocks+cacheKey
- `POST /match`               — 产品匹配分析，需付费token
- `POST /pay/create`          — 创建支付订单
- `GET  /pay/status/:id`      — 查询订单状态
- `POST /pay/notify/wechat`   — 微信支付回调
- `POST /pay/notify/alipay`   — 支付宝回调
- `POST /report`              — 发送邮件报告

## 关键函数说明
- `startAnalysis()`      — OCR识别，免费，支持多图
- `startMatching()`      — 产品匹配，需付费token
- `loadProducts()`       — 页面启动时从 /products 拉取产品库
- `calcQueryCounts()`    — 查询次数统计（报告日期为基准，自然月）
- `calcBlastRisk()`      — 爆查风险指数计算
- `calcLoanMonthly()`    — 单笔贷款月供估算（见下方逻辑说明）
- `calcTotalMonthly()`   — 总月供 = 贷款月供合计 + 信用卡已用额度×2%
- `localFallbackMatch()` — 本地规则引擎主匹配
- `autoSendReport()`     — 匹配完成后自动推送报告

## 月供估算逻辑（calcLoanMonthly）
简版征信不含利率和还款方式，通过以下规则推算：

| 类型 | 判断依据 | 计算方式 |
|---|---|---|
| 房贷 | loan_category=mortgage | 余额×0.55% |
| 车贷 | loan_category=car | 余额×3.04% |
| 银行循环贷 | is_revolving=true | 先息后本，余额×0.375%（4.5%年化） |
| 银行非循环贷（先息后本） | elapsed>=1月 且 B/L>97% | 余额×0.375% |
| 银行非循环贷（等额本息） | elapsed>=1月 且 B/L<=97% | PMT(4.5%年化, 剩余期数=B/L×36) |
| 消费金融/网贷循环贷 | is_revolving=true + finance类 | 等额本息，同下 |
| 消费金融 | finance类 | PMT(18%年化, 剩余期数=36-elapsed) |
| 网贷 | online类 | PMT(18%年化, 剩余期数=12-elapsed) |

**关键逻辑：**
- 银行循环贷余额下降是主动还款，不代表有固定还款计划，一律按先息后本
- B/L=余额/授信额度，<97%说明本金已减少，判定为等额本息
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
- URL参数：?agent=XY001
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
