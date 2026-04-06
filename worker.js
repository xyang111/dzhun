// ═══════════════════════════════════════════════════════════════
//  贷准 · Cloudflare Worker v2
//  新增：① OCR/分析 Prompt 内置  ② 产品库内置  ③ 缓存策略
//  保留：支付（微信/支付宝）、鉴权 token、邮件报告、Claude 代理
// ═══════════════════════════════════════════════════════════════

// Quote-aware JSON boundary finder: handles { } inside strings and escaped quotes
function _extractJsonStr(text) {
  for (const [open, close] of [['{','}'],['[',']']]) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) { try { const s = text.substring(start, i+1); JSON.parse(s); return s; } catch(e) { break; } } }
      }
    }
  }
  return null;
}

var REPORT_TO_EMAIL = "651047968@qq.com";
var REPORT_FROM     = "report@dzhun.com.cn";
var ALLOWED_ORIGINS = [
  "https://dzhun.com.cn",
  "https://www.dzhun.com.cn",
];
var PRODUCT_PRICE = 990;

// ═══════════════════════════════════════════
// ② OCR 解析 Prompt（从前端迁移，对外不可见）
// ═══════════════════════════════════════════
const PROMPT_OCR = `你是银行信贷审核员，精通人行简版征信报告。请仔细识别并提取报告中的信息。

【基本信息提取】
从征信报告封面提取：
- person_name：姓名
- id_number：身份证号码（18位）
- report_date：报告时间字段中的日期，格式 YYYY-MM-DD（如「报告时间：2025-12-03 12:45:08」→ "2025-12-03"）

【信息概要表格提取】
找到页面顶部的「信息概要」表格，提取以下数据辅助判断逾期情况：
- summary_overdue_accounts：「发生过逾期的账户数」中的贷款数，「--」或空记为 0
- summary_overdue_90days：「发生过90天以上逾期的账户数」中的贷款数，「--」或空记为 0

【严重不良记录识别】
除逾期外，还需识别以下严重不良，写入 has_bad_record 和 bad_record_notes：
- 呆账：账户状态栏出现「呆账」
- 担保代还/代偿：描述中出现「担保代还」「代偿」
- 资产处置：描述中出现「资产处置」
- 止付/冻结：账户状态为「止付」「冻结」
存在任意一条：has_bad_record=true，bad_record_notes填写具体描述（机构+类型）
全部没有：has_bad_record=false，bad_record_notes="无"

【贷款到期日提取】
- due_date：贷款合同到期日，格式 YYYY-MM-DD（如「2028年02月12日到期」→ "2028-02-12"）
- 循环授信（可循环使用）的额度有效期不是到期日，due_date 填 null
- 已知到期日时必须填写，不得省略

【账户过滤规则（严格执行）】
1. 贷款账户：只提取当前未结清账户。已结清账户跳过，但若有历史逾期需记入 overdue_history_notes。
2. 信用卡账户：只提取人民币账户且未销户的贷记卡。外币账户跳过不提取。已销户账户跳过不提取。
3. 查询记录：严格逐条核对查询原因列，规则如下——
   ✅ 以下4类才能写入 query_records，type 字段必须原文照抄：
     - 查询原因为「贷款审批」→ type 写 "贷款审批"
     - 查询原因为「担保资格审查」→ type 写 "担保资格审查"
     - 查询原因为「资信审查」→ type 写 "资信审查"
     - 查询原因为「信用卡审批」→ type 写 "信用卡审批"
   ❌ 其余所有查询原因一律跳过，禁止写入（包括但不限于）：
     贷后管理、本人查询、贷前管理、保险资格审查、特约商户资格审查、司法调查、异议申请、其他
   ⚠️ 极易混淆警告：「贷后管理」在报告中出现频率极高，与「贷款审批」字形相近，必须逐条核对原文，绝不能把「贷后管理」误写为「贷款审批」。
   ⚠️ 自查：识别完所有记录后，逐条检查 query_records，凡 type 不是「贷款审批」「担保资格审查」「资信审查」「信用卡审批」之一的，立即删除。

【多张图片处理】
如果上传了多张图片，必须逐张检查所有页面，将所有页面的查询记录合并后一起输出，不得遗漏任何一张图片中的查询记录。

【账户名称标准化】
name 字段格式统一为「银行简称-账户类型」：
- 银行简称：去掉「股份有限公司」「有限公司」「分行」「支行」「中心」「营业部」等后缀，保留核心品牌名
- 账户类型：贷款填「消费贷/住房贷/车贷/其他贷」，信用卡填「贷记卡」

【账户类型判断（严格执行）】

▌ type = "bank"（银行类贷款）
机构名称含「银行」「韩亚」「农商」「农信」「村镇银行」，均归为银行类。
⚠️ 以下机构名称虽含「银行」，但属于互联网助贷银行，必须归入 type="online"：
众邦、通商银行、蓝海银行、三湘银行、苏宁银行、富民银行、亿联银行、振兴银行、苏商银行、新网银行、锡商银行、中关村银行、长安银行、微众银行、网商银行、百信银行、裕民银行、华通银行、江南农商银行

▌ type = "online"（网贷）—— 三类：
① online_subtype = "consumer_finance"：机构名含「消费金融、招联、马上、中邮、捷信、哈银、盛银、北银、小米消费金融」
② online_subtype = "microloan"：机构名含「小额贷款、小贷、蚂蚁小贷、京东小贷、度小满小贷、美团小贷」
③ online_subtype = "online_bank"：众邦、通商银行、蓝海银行、三湘银行、苏宁银行、富民银行、亿联银行、振兴银行、苏商银行、新网银行、锡商银行、中关村银行、长安银行、微众银行、网商银行、百信银行、裕民银行、华通银行、江南农商银行

▌ type = "credit"（信用卡账户）

【贷款细分类型（loan_category）】
- "mortgage"：名称含「住房/房贷/按揭/公积金贷款/购房」
- "car"：名称含「汽车/购车/车贷/车辆/机动车」
- "credit"：type=bank 且非房贷非车贷
- "finance"：type=online 固定填 "finance"

只返回如下JSON，不含任何其他文字和markdown代码块：
{
  "person_name": "姓名",
  "id_number": "身份证号",
  "report_date": "2025-12-03",
  "summary_overdue_accounts": 0,
  "summary_overdue_90days": 0,
  "loans": [
    {
      "name": "建设银行-消费贷",
      "type": "bank",
      "online_subtype": null,
      "loan_category": "credit",
      "issued_date": "2025-02-02",
      "due_date": "2028-02-02",
      "is_revolving": false,
      "credit_limit": 6000,
      "balance": 1534,
      "monthly": null,
      "status": "正常"
    }
  ],
  "cards": [
    {
      "name": "建设银行-贷记卡",
      "limit": 5000,
      "used": 0,
      "status": "正常"
    }
  ],
  "query_records": [
    {"date": "2025-11-20", "type": "贷款审批"},
    {"date": "2025-10-15", "type": "信用卡审批"},
    {"date": "2025-10-02", "type": "担保资格审查"}
  ],
  "overdue_current": 0,
  "overdue_history_notes": "无",
  "has_overdue_history": false,
  "has_bad_record": false,
  "bad_record_notes": "无",
  "ocr_warnings": [],
  "notes": "识别到X笔未结清贷款，Y张未销户人民币信用卡"
}`;

// ═══════════════════════════════════════════
// ③ 匹配分析 Prompt 构建函数（动态，接收前端传来的用户数据）
// ═══════════════════════════════════════════
function buildMatchPrompt(payload) {
  const {
    creditData, userInfo,
    candidateSummary, rejectedSummary,
    loanDesc, cardDesc, debtRatio, cardUtil,
    q, onlineInstTotal, cfCount, mlCount, obCount,
    totalMonthly, scoreItems, socialStr, income, pvd,
    hukouVal, assetsVal, workVal, eduVal,
    v2Level, v2Score, domainScores, xaiIssues,
  } = payload;

  const q3 = (q.loan_3m || 0) + (q.loan_3m_card || 0);
  const level = v2Level || 'B';
  const score = v2Score || 0;
  const ds = domainScores || {};
  const whitelistWork = workVal && /公务员|国企|央企|事业单位|教师|医生|军人|警察|银行|教授/.test(workVal);

  const xaiText = (xaiIssues || []).length > 0
    ? (xaiIssues || []).map(i => `• ${i.tag}：${i.desc}（修复后可回收约${i.gain}分，需${i.months}个月）→ ${i.fix}`).join('\n')
    : '• 引擎未检测到主要扣分项';

  const dsText = ds.credit != null
    ? `信用行为(40%)：${Math.round(ds.credit)}分 | 稳定性(30%)：${Math.round(ds.stability)}分 | 资产偿债(25%)：${Math.round(ds.asset)}分 | 反欺诈(5%)：${Math.round(ds.fraud)}分`
    : '（四域评分未传入）';

  const levelInstruction = {
    A: `客户是 A 级（${score}分，PREMIUM ACCESS）。你的核心任务：
① key_risk：写"利率损失提示"而非风险——如果走错渠道或顺序，利率差约1%-2%，换算成真实金额损失（参考月收入/可能借款额估算，格式："走错渠道，同等资质多付约X元利息"）。
② optimization：1-2步。第一步必须体现"先对接白名单通道"${whitelistWork ? `（该客户${workVal}，属白名单职业，明确指出）` : '（根据资质判断是否适用）'}；第二步给利率谈判或提额路径。unlock字段写具体利率目标区间如"锁定3.0%-3.5%档"。
③ advice.strengths：列出让他进入A级的2个具体指标，精确到数字。advice.issues：写"如果不做白名单对接/渠道优化，可能少拿的利率差或额度上限"。advice.suggestions：按申请顺序给1-2步框架，强调顺序和渠道需要人工协助。`,
    B: `客户是 B 级（${score}分，OPTIMIZATION GAP）。你的核心任务是"损失量化"，让客户感受到不行动的代价：
① key_risk：用"现在最高X万，优化后可达Y万，差Z万额度"这个句式，Z必须是具体数字（从candidateSummary最高额度估算，优化后+30%-50%）。
② optimization：1-3步，每步必须含时间节点。重点：把"等查询冷却"换算成"等N个月后申请，通过率从X%升到Y%"；把"结清小贷"换算成"结清后额度上限多X万"。time字段精确到月份，unlock字段必须含金额或额度数字。
③ advice.issues：必须写双损失——"现在申请被拒，再冷却期又多等3个月"这类时间浪费 + 具体额度差。advice.suggestions：给出精确执行序列，强调"顺序不对多等数月"。`,
    C: `客户是 C 级（${score}分，RECOVERY PATH）。你的核心任务是"利率时间轴"，让客户感受到高利率的真实成本：
① key_risk：用"现在只能用18%年化产品，3个月后可降到X%，每借10万一年多付Y元利息"这个句式（Y = (0.18 - 目标利率) × 100000）。
② optimization：2-3步时间轴。当前可用的过渡产品是第一步（写产品类型和利率）；第二步写3个月后解锁什么（从xai issues里找修复时间最短的）；第三步写6个月后的目标。unlock字段写利率变化如"利率从18%降至8%"。
③ advice.strengths：从candidateSummary中找现在能申请的产品，给客户建立信心。advice.issues：用利息成本量化（"用高利率过渡比等3个月直接上银行多付X元"），但语气给希望不给绝望。advice.suggestions：给具体过渡路径，强调"申请顺序影响3个月后的资格"。`,
    D: `客户是 D 级（${score}分，REHABILITATION PLAN）。银行通道暂时关闭。禁止做损失量化，客户已经知道情况不好，不需要再强化焦虑。你的核心任务是给控制感和路线图：
① key_risk：直接说明导致D级的主因（从xai issues第一条，精确描述），一句话，语气是解释不是判决。
② optimization：严格按时间轴三步——第一步"立即执行"（具体做什么），第二步"第3个月"（第一个里程碑，解锁什么），第三步"第6-9个月"（回到C级/B级的节点）。每步的unlock写"解锁城商行+X款产品"或"进入股份制银行区间"这类具体里程碑。
③ advice.strengths：找任何可以建立信心的点（哪怕是"无历史逾期"或"公积金在缴"）。advice.issues：解释原因，不指责。advice.suggestions：第一步最重要的单一行动，给足执行细节，让客户知道"做这件事就是在向前走"。`,
  }[level] || '';

  return `你是贷准AI信贷顾问。以下是一位真实客户的完整征信分析数据，请根据客户等级生成个性化分析报告。

【写作规则】
- 口语化，数字精确（不说"偏高"，说"高了2次"）
- 禁止出现"建议直接去银行柜台申请"或"自行前往XX银行"等绕过客服的表述
- 本地规则引擎已完成产品筛选和通过率计算，你不需要重新做这件事
- 只输出前端实际渲染的3个字段：key_risk、optimization、advice

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【V2.0评分】${score}分 · ${level}级（A=800+优质准入 | B=650-799优化空间 | C=500-649恢复路径 | D=500以下修复计划）
【四域得分】${dsText}

【引擎诊断问题（已含修复分析）】
${xaiText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【客户补充信息】
学历：${eduVal || '未填写'} | 月收入：${income > 0 ? income + '元' : '未填写'} | 单位性质：${workVal || '未填写'}
社保：${socialStr} | 公积金：${pvd > 0 ? pvd + '元/月' : '未缴'} | 资产：${assetsVal || '无'} | 户籍：${hukouVal || '未填写'}

【征信核心数据】
贷款：${creditData.loanCount}笔（银行${creditData.bankCount}笔 | 网贷${creditData.onlineCount}笔）| 网贷机构：${onlineInstTotal}家（红线≤4家）
信用卡：${creditData.cardCount}张 | 月供估算：${totalMonthly}元 | 负债率：${debtRatio} | 卡片使用率：${cardUtil}%
当前逾期：${creditData.overdueCurrent || 0}笔 | 历史逾期：${creditData.overdueHistoryNotes || '无'}
查询：近1月${q.loan_1m || 0}次 | 近3月贷款${q.loan_3m || 0}次+信用卡${q.loan_3m_card || 0}次=合计${q3}次 | 近6月${q.loan_6m_total || 0}次

【贷款明细】
${loanDesc}
【信用卡明细】
${cardDesc}

【引擎匹配结果（已完成，勿重复计算）】
可申请产品：${candidateSummary}
排除摘要：${rejectedSummary}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【当前客户等级专属写作指令】
${levelInstruction}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

严格返回JSON，不含任何其他文字和markdown，只包含以下3个字段：
{
  "key_risk": "25字内，按等级指令写",
  "optimization": [
    {"step": "具体行动，不得为空", "goal": "量化目标（含金额/利率/额度数字）", "time": "精确时间", "unlock": "解锁内容（含具体数字）"}
  ],
  "advice": {
    "strengths": [{"point": "具体优势（含数字）", "impact": "对申贷的正面影响"}],
    "issues": [{"point": "具体问题（含数字）", "impact": "量化影响（金额/额度/时间）"}],
    "suggestions": [{"action": "具体行动", "goal": "目标", "time": "时间", "effect": "效果（含数字）"}]
  }
}
注意：optimization列1-3步；advice各子数组列1-3条；所有数字字段必须有真实数值，不得用"X""Y""N"占位。`;
}

// ═══════════════════════════════════════════
// 主路由
// ═══════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // 支付回调不做来源校验（支付平台直接回调）
    if (path === '/pay/notify/wechat') return handleWechatNotify(request, env);
    if (path === '/pay/notify/alipay') return handleAlipayNotify(request, env);

    // 来源校验（Referer / Origin）
    const origin  = request.headers.get('Origin')  || '';
    const referer = request.headers.get('Referer') || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o));
    if (!allowed) return jsonResp({ error: 'Forbidden' }, 403, request);

    // GET 路由（/api/v1/* 规范路径 + 旧路径兼容）
    const gNormPath = path.replace(/^\/api\/v1/, '');
    if (request.method === 'GET' && (gNormPath.startsWith('/pay/status/'))) {
      return handlePayStatus(request, env, gNormPath);
    }
    if (request.method === 'GET' && gNormPath === '/pay/wechat/oauth') {
      return handleWechatOAuth(request, env);
    }
    if (request.method === 'GET' && gNormPath === '/pay/alipay/verify-return') {
      return handleAlipayVerifyReturn(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });
    }

    // POST 路由（/api/v1/* 规范路径 + 旧路径兼容）
    const normPath = path.replace(/^\/api\/v1/, ''); // 去掉版本前缀后统一匹配
    if (normPath === '/pay/create')        return handlePayCreate(request, env);
    if (normPath === '/pay/wechat/confirm') return handleWechatConfirm(request, env);
    if (normPath === '/report')            return handleReport(request, env);
    if (normPath === '/ocr')               return handleOCR(request, env);
    if (normPath === '/match')             return handleMatch(request, env);
    if (normPath === '/score')             return handleScore(request, env);
    if (normPath === '/analytics')         return handleAnalytics(request, env);

    return jsonResp({ error: 'Not Found' }, 404, request);
  },
};

// ═══════════════════════════════════════════
// /ocr — OCR 识别（带缓存）
// 前端传：{ fileBlocks: [...], cacheKey?: string }
// ═══════════════════════════════════════════
async function handleOCR(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }

  const { fileBlocks, cacheKey } = body;
  if (!fileBlocks || !fileBlocks.length) {
    return jsonResp({ error: '缺少文件内容' }, 400, request);
  }

  // 缓存查询：命中直接返回，不计入限流
  if (cacheKey && env.CACHE) {
    const cached = await env.CACHE.get(`ocr:${cacheKey}`);
    if (cached) {
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

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResp({ error: 'API key not configured' }, 500, request);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [...fileBlocks, { type: 'text', text: PROMPT_OCR }],
        }],
      }),
    });

    const data = await resp.json();
    if (data.error) return jsonResp({ error: data.error.message }, 502, request);

    // 检测截断：stop_reason=max_tokens 说明输出被截断，JSON 会不完整
    if (data.stop_reason === 'max_tokens') {
      console.error('[OCR] truncated by max_tokens, raw length:', (data.content||[]).map(b=>b.text||'').join('').length);
    }
    console.log('[OCR] stop_reason:', data.stop_reason, 'output_tokens:', data.usage?.output_tokens);

    const rawText = (data.content || []).map(b => b.text || '').join('');

    // 从 Claude 响应中提取纯 JSON（Claude 有时在 JSON 前后加说明文字）
    let raw = rawText.trim();
    if (raw.startsWith('{') || raw.startsWith('[')) {
      // 直接是 JSON，尝试直接用
    } else {
      // 含前置文字或 markdown，做 quote-aware 提取
      const extracted = _extractJsonStr(rawText);
      if (extracted) {
        raw = extracted;
        console.log('[OCR] extracted JSON from mixed response, original length:', rawText.length, 'extracted:', raw.length);
      } else {
        console.error('[OCR] could not extract JSON from response, length:', rawText.length);
      }
    }

    // 只缓存合法 JSON（防止截断的坏响应被缓存后持续返回错误）
    if (cacheKey && env.CACHE) {
      try {
        JSON.parse(raw);
        await env.CACHE.put(`ocr:${cacheKey}`, raw, { expirationTtl: 7200 });
      } catch (_) {
        console.error('[OCR] response is not valid JSON, skipping cache. length:', raw.length);
      }
    }

    return jsonResp({ raw }, 200, request);

  } catch (e) {
    return jsonResp({ error: 'OCR 调用失败: ' + e.message }, 502, request);
  }
}

// ═══════════════════════════════════════════
// /match — 产品匹配分析（付费鉴权）
// 前端传：{ _pay_token, payload: { creditData, userInfo, ... } }
// ═══════════════════════════════════════════
async function handleMatch(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }

  // 付费鉴权
  const payToken = body._pay_token || '';
  delete body._pay_token;
  if (!payToken) {
    return jsonResp({ error: { message: '需要付费后才能查看匹配结果', code: 'PAYMENT_REQUIRED' } }, 402, request);
  }
  const tokenRaw = await env.ORDERS.get(`token:${payToken}`);
  if (!tokenRaw) {
    return jsonResp({ error: { message: '支付凭证无效或已过期，请重新付费', code: 'PAYMENT_REQUIRED' } }, 402, request);
  }
  const td = JSON.parse(tokenRaw);
  if (td.expiresAt < Date.now()) {
    return jsonResp({ error: { message: '支付凭证已过期（24小时内有效），请重新付费', code: 'PAYMENT_REQUIRED' } }, 402, request);
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return jsonResp({ error: 'API key not configured' }, 500, request);

  const prompt = buildMatchPrompt(body.payload || {});

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) return jsonResp({ error: data.error }, resp.status, request);

    // 将 DeepSeek（OpenAI 格式）标准化为前端期望的 Anthropic 格式
    const text = data.choices?.[0]?.message?.content || '';
    return jsonResp({ content: [{ type: 'text', text }] }, 200, request);

  } catch (e) {
    return jsonResp({ error: { message: 'Upstream error: ' + e.message } }, 502, request);
  }
}

// ═══════════════════════════════════════════
// 以下为原有代码，完整保留
// ═══════════════════════════════════════════

async function handlePayCreate(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }
  const { channel, amount, openid } = body;
  if (amount !== PRODUCT_PRICE) return jsonResp({ error: '金额异常' }, 400, request);
  if (channel !== 'wechat' && channel !== 'alipay') return jsonResp({ error: '不支持的支付方式' }, 400, request);
  const orderId = 'DZ' + Date.now() + randomHex(6);
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify({
    status: 'pending', channel, amount, createdAt: Date.now()
  }), { expirationTtl: 3600 });
  if (channel === 'wechat') return handleWechatCreate(request, env, orderId, openid);
  return handleAlipayCreate(request, env, orderId);
}

async function handleWechatCreate(request, env, orderId, openid) {
  const appid   = env.WECHAT_APPID    || '';
  const mchid   = env.WECHAT_MCH_ID   || '';
  const serial  = env.WECHAT_SERIAL   || '';
  const privKey = env.WECHAT_PRIV_KEY || '';
  if (!appid || !mchid || !privKey) {
    return jsonResp({
      orderId, channel: 'wechat',
      payUrl: `https://dzhun.com.cn/?_mock_pay=1&orderId=${orderId}&channel=wechat`,
    }, 200, request);
  }

  // 微信内（有 openid）→ JSAPI 支付
  if (openid) {
    const apiPath = '/v3/pay/transactions/jsapi';
    const reqBody = JSON.stringify({
      appid, mchid,
      description: '贷准-AI征信匹配',
      out_trade_no: orderId,
      amount: { total: PRODUCT_PRICE, currency: 'CNY' },
      payer: { openid },
      notify_url: 'https://api.dzhun.com.cn/pay/notify/wechat',
    });
    try {
      const authHeader = await buildWechatAuth('POST', apiPath, reqBody, privKey, mchid, serial);
      const resp = await fetch('https://api.mch.weixin.qq.com' + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'dzhun/1.0', 'Authorization': authHeader },
        body: reqBody,
      });
      const data = await resp.json();
      if (!data.prepay_id) return jsonResp({ error: `[${data.code}] ${data.message}` || '微信下单失败' }, 502, request);
      // 计算 wx.chooseWXPay 所需签名
      const ts    = Math.floor(Date.now() / 1000).toString();
      const nonce = randomHex(16);
      const pkg   = `prepay_id=${data.prepay_id}`;
      const signStr = `${appid}\n${ts}\n${nonce}\n${pkg}\n`;
      const key   = await crypto.subtle.importKey('pkcs8', pemToBuffer(privKey),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      const sig   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signStr));
      const paySign = btoa(String.fromCharCode(...new Uint8Array(sig)));
      return jsonResp({
        orderId, channel: 'wechat',
        jsapi: { appId: appid, timeStamp: ts, nonceStr: nonce, package: pkg, signType: 'RSA', paySign },
      }, 200, request);
    } catch (e) {
      return jsonResp({ error: '微信JSAPI下单异常: ' + e.message }, 502, request);
    }
  }

  // 微信外 → H5 支付
  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const apiPath  = '/v3/pay/transactions/h5';
  const reqBody  = JSON.stringify({
    appid, mchid,
    description: '贷准-AI征信匹配',
    out_trade_no: orderId,
    amount: { total: PRODUCT_PRICE, currency: 'CNY' },
    scene_info: {
      payer_client_ip: clientIp,
      h5_info: { type: 'Wap', app_name: '贷准', app_url: 'https://dzhun.com.cn' },
    },
    notify_url: 'https://api.dzhun.com.cn/pay/notify/wechat',
  });
  try {
    const authHeader = await buildWechatAuth('POST', apiPath, reqBody, privKey, mchid, serial);
    const resp = await fetch('https://api.mch.weixin.qq.com' + apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'dzhun/1.0', 'Authorization': authHeader },
      body: reqBody,
    });
    const data = await resp.json();
    if (!data.h5_url) return jsonResp({ error: `[${data.code}] ${data.message}` || '微信下单失败' }, 502, request);
    return jsonResp({ orderId, payUrl: data.h5_url, channel: 'wechat' }, 200, request);
  } catch (e) {
    return jsonResp({ error: '微信H5下单异常: ' + e.message }, 502, request);
  }
}

// 主动查询微信订单状态，不依赖回调，支付成功立刻标记
async function handleWechatConfirm(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ error: '参数错误' }, 400, request);
  }
  const { orderId } = body;
  if (!orderId) return jsonResp({ error: '缺少orderId' }, 400, request);

  const appid   = env.WECHAT_APPID    || '';
  const mchid   = env.WECHAT_MCH_ID   || '';
  const serial  = env.WECHAT_SERIAL   || '';
  const privKey = env.WECHAT_PRIV_KEY || '';
  if (!mchid || !privKey) return jsonResp({ error: '微信支付未配置' }, 500, request);

  try {
    // 先查 KV：微信回调可能已经标记为 paid（比主动查询快）
    const localRaw = await env.ORDERS.get(`order:${orderId}`);
    if (localRaw) {
      const localOrder = JSON.parse(localRaw);
      if (localOrder.status === 'paid' && localOrder.token) {
        console.log(`[confirm] KV already paid, token=${localOrder.token}`);
        return jsonResp({ status: 'paid', token: localOrder.token }, 200, request);
      }
    }

    // KV 未标记 → 主动查询微信
    const apiPath = `/v3/pay/transactions/out-trade-no/${orderId}?mchid=${mchid}`;
    const authHeader = await buildWechatAuth('GET', apiPath, '', privKey, mchid, serial);
    const resp = await fetch('https://api.mch.weixin.qq.com' + apiPath, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'dzhun/1.0', 'Authorization': authHeader },
    });
    const data = await resp.json();
    console.log(`[confirm] wx trade_state=${data.trade_state} orderId=${orderId}`);
    if (data.trade_state !== 'SUCCESS') {
      return jsonResp({ status: data.trade_state || 'pending' }, 200, request);
    }
    // 微信返回成功，标记订单并取 token
    await markOrderPaid(env, orderId);
    const raw = await env.ORDERS.get(`order:${orderId}`);
    const order = raw ? JSON.parse(raw) : {};
    return jsonResp({ status: 'paid', token: order.token }, 200, request);
  } catch(e) {
    console.error(`[confirm] error: ${e.message}`);
    return jsonResp({ error: '查询失败: ' + e.message }, 502, request);
  }
}

async function handleWechatOAuth(request, env) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  if (!code) return jsonResp({ error: 'missing code' }, 400, request);
  const appid  = env.WECHAT_APPID   || '';
  const secret = env.WECHAT_SECRET  || '';
  try {
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appid}&secret=${secret}&code=${code}&grant_type=authorization_code`;
    const resp = await fetch(tokenUrl);
    const data = await resp.json();
    if (!data.openid) return jsonResp({ error: data.errmsg || 'OAuth失败' }, 502, request);
    return jsonResp({ openid: data.openid }, 200, request);
  } catch (e) {
    return jsonResp({ error: 'OAuth异常: ' + e.message }, 502, request);
  }
}

async function handleAlipayCreate(request, env, orderId) {
  const appId   = env.ALIPAY_APP_ID   || '';
  const privKey = env.ALIPAY_PRIV_KEY || '';
  if (!appId || !privKey) {
    return jsonResp({
      orderId, channel: 'alipay',
      payUrl: `https://dzhun.com.cn/?_mock_pay=1&orderId=${orderId}&channel=alipay`,
    }, 200, request);
  }
  const now = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  const pad = n => String(n).padStart(2, '0');
  const ts  = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const bizContent = JSON.stringify({
    out_trade_no: orderId, total_amount: '9.90',
    subject: '贷准-AI征信匹配', product_code: 'QUICK_WAP_WAY',
  });
  const params = {
    app_id: appId, method: 'alipay.trade.wap.pay',
    charset: 'utf-8', sign_type: 'RSA2', timestamp: ts, version: '1.0',
    notify_url: 'https://api.dzhun.com.cn/pay/notify/alipay',
    return_url: `https://dzhun.com.cn/?paid=1&orderId=${orderId}`, biz_content: bizContent,
  };
  try {
    params.sign = await signAlipay(params, privKey);
    const query  = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const payUrl = 'https://openapi.alipay.com/gateway.do?' + query;
    return jsonResp({ orderId, payUrl, channel: 'alipay' }, 200, request);
  } catch (e) {
    return jsonResp({ error: '支付宝下单异常: ' + e.message }, 502, request);
  }
}

async function handlePayStatus(request, env, path) {
  const orderId = path.replace('/pay/status/', '').split('?')[0];
  if (!orderId) return jsonResp({ error: '订单ID缺失' }, 400, request);
  const raw = await env.ORDERS.get(`order:${orderId}`);
  if (!raw) return jsonResp({ status: 'expired' }, 200, request);
  const order = JSON.parse(raw);
  if (order.status === 'paid') return jsonResp({ status: 'paid', token: order.token }, 200, request);

  // KV 尚未同步 paid 状态时，直接查支付宝权威结果（绕过跨节点一致性延迟）
  if (order.channel === 'alipay') {
    try {
      const tradeStatus = await queryAlipayTrade(env, orderId);
      if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
        await markOrderPaid(env, orderId);
        const updatedRaw = await env.ORDERS.get(`order:${orderId}`);
        if (updatedRaw) {
          const updated = JSON.parse(updatedRaw);
          if (updated.status === 'paid') return jsonResp({ status: 'paid', token: updated.token }, 200, request);
        }
      }
    } catch(e) { /* 查询失败时回退到本地状态 */ }
  }
  return jsonResp({ status: order.status }, 200, request);
}

async function queryAlipayTrade(env, orderId) {
  const appId   = env.ALIPAY_APP_ID;
  const privKey = env.ALIPAY_PRIV_KEY;
  if (!appId || !privKey) return null;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const params = {
    app_id: appId, method: 'alipay.trade.query',
    charset: 'utf-8', sign_type: 'RSA2', timestamp: ts, version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: orderId }),
  };
  params.sign = await signAlipay(params, privKey);
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const resp = await fetch('https://openapi.alipay.com/gateway.do?' + query);
  const data = await resp.json();
  return data?.alipay_trade_query_response?.trade_status ?? null;
}

async function handleWechatNotify(request, env) {
  try {
    const body      = await request.json();
    const { resource } = body;
    const apiV3Key  = env.WECHAT_API_V3_KEY || '';
    let orderId;
    if (!apiV3Key) {
      orderId = body.out_trade_no || '';
    } else {
      const plaintext = await decryptWechatResource(
        resource.ciphertext, resource.nonce, resource.associated_data, apiV3Key
      );
      const orderInfo = JSON.parse(plaintext);
      if (orderInfo.trade_state !== 'SUCCESS') {
        return new Response(JSON.stringify({ code: 'SUCCESS' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      orderId = orderInfo.out_trade_no;
    }
    if (orderId) await markOrderPaid(env, orderId);
    return new Response(JSON.stringify({ code: 'SUCCESS' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: 'FAIL', message: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleAlipayVerifyReturn(request, env) {
  try {
    const url    = new URL(request.url);
    const params = {};
    for (const [k, v] of url.searchParams) params[k] = v;

    const orderId = params.out_trade_no;
    if (!orderId) return jsonResp({ error: '缺少订单号' }, 400, request);

    // 验证支付宝签名（排除自定义参数 paid/orderId，仅对支付宝原始字段验签）
    const alipayPubKey = env.ALIPAY_PUB_KEY || '';
    if (alipayPubKey) {
      const alipayParams = Object.fromEntries(
        Object.entries(params).filter(([k]) => k !== 'paid' && k !== 'orderId')
      );
      const ok = await verifyAlipay(alipayParams, alipayPubKey);
      if (!ok) return jsonResp({ error: '签名验证失败' }, 400, request);
    }

    // 回跳 URL 里没有 trade_status，但有 trade_no 即代表付款成功
    // 在当前节点直接标记 paid（同节点写入，读取无延迟）
    if (params.trade_no) {
      await markOrderPaid(env, orderId);
    }

    const raw = await env.ORDERS.get(`order:${orderId}`);
    if (!raw) return jsonResp({ error: '订单不存在' }, 404, request);
    const order = JSON.parse(raw);
    if (order.status !== 'paid') return jsonResp({ status: order.status }, 200, request);
    return jsonResp({ status: 'paid', token: order.token }, 200, request);
  } catch(e) {
    return jsonResp({ error: e.message }, 500, request);
  }
}

async function handleAlipayNotify(request, env) {
  try {
    const formData = await request.formData();
    const params   = {};
    for (const [k, v] of formData.entries()) params[k] = v;
    const alipayPubKey = env.ALIPAY_PUB_KEY || '';
    if (alipayPubKey) {
      const ok = await verifyAlipay(params, alipayPubKey);
      if (!ok) return new Response('fail', { status: 200 });
    }
    if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
      await markOrderPaid(env, params.out_trade_no);
    }
    return new Response('success', { status: 200 });
  } catch (e) {
    return new Response('fail', { status: 200 });
  }
}

async function markOrderPaid(env, orderId) {
  const raw = await env.ORDERS.get(`order:${orderId}`);
  if (!raw) return;
  const order = JSON.parse(raw);
  if (order.status === 'paid') return;
  const token = randomHex(32);
  // 先写 token key，再把订单标记为 paid，避免客户端拿到 token 时 token key 尚未写入
  await env.ORDERS.put(`token:${token}`, JSON.stringify({ expiresAt: Date.now() + 3600000 }), { expirationTtl: 3600 });
  order.status = 'paid';
  order.paidAt = Date.now();
  order.token  = token;
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 86400 });
}

// ═══════════════════════════════════════════
// /api/v1/score — 评分记录存 D1（运营分析用，前端异步 fire-and-forget）
// ═══════════════════════════════════════════
async function handleScore(request, env) {
  if (!env.DB) return jsonResp({ ok: false, error: 'DB not bound' }, 503, request);
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }
  const { sessionId, score, rawScore, penalty, level, domainScores, features, agentId } = body || {};
  if (!sessionId || !score || !level) return jsonResp({ error: '缺少必要字段' }, 400, request);

  const ds = domainScores || {};
  const f  = features    || {};
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO score_records
        (created_at, session_id, score, raw_score, penalty, level,
         cb_score, st_score, as_score, fr_score,
         q3m, online_inst, dti, card_util,
         has_overdue, has_bad_rec, income, work_type, agent_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      Date.now(), sessionId,
      Math.round(score), +(rawScore||0), Math.round(penalty||0), level,
      +(ds.credit||0).toFixed(1), +(ds.stability||0).toFixed(1),
      +(ds.asset||0).toFixed(1),  +(ds.fraud||0).toFixed(1),
      f.q3m ?? null, f.onlineI ?? null,
      f.dti  != null ? +f.dti.toFixed(3) : null,
      f.cardUtil != null ? +f.cardUtil.toFixed(3) : null,
      f.curOv  ? 1 : 0,
      f.badRec ? 1 : 0,
      f.income ?? null,
      f.workType ?? null,
      agentId ?? null,
    ).run();
  } catch (e) {
    // 静默失败：不影响前端主流程
    console.error('[handleScore] D1 write error:', e.message);
  }
  return jsonResp({ ok: true }, 200, request);
}

// /api/v1/analytics — 行为事件埋点（fire-and-forget，无需鉴权）
// ═══════════════════════════════════════════
async function handleAnalytics(request, env) {
  if (!env.DB) return jsonResp({ ok: true }, 200, request);
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ ok: true }, 200, request);
  }
  const { event, sessionId, agentId, props } = body || {};
  if (!event) return jsonResp({ ok: true }, 200, request);
  try {
    await env.DB.prepare(`
      INSERT INTO page_events (created_at, event, session_id, agent_id, props)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      Date.now(),
      String(event).slice(0, 50),
      sessionId ? String(sessionId).slice(0, 36) : null,
      agentId   ? String(agentId).slice(0, 20)   : null,
      props     ? JSON.stringify(props).slice(0, 500) : null,
    ).run();
  } catch (e) {
    console.error('[analytics] D1 error:', e.message);
  }
  return jsonResp({ ok: true }, 200, request);
}

async function handleReport(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ ok: false, error: 'Invalid JSON' }, 400, request);
  }
  const name    = body['客户姓名'] || '未知客户';
  const time    = body['提交时间'] || new Date().toLocaleString('zh-CN');
  const report  = (body['完整报告'] || '（无内容）').replace(/(\d{6})\d{8}(\d{4})/g, '$1********$2');
  const subject = `贷准报告 · ${name} · ${time}`;
  const resendKey = env.RESEND_API_KEY;
  if (!resendKey) return jsonResp({ ok: false, error: 'Resend key not configured' }, 500, request);
  try {
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REPORT_FROM, to: REPORT_TO_EMAIL, subject, text: report }),
    });
    const data = await resendResp.json();
    const ok   = resendResp.status === 200 || resendResp.status === 201;
    return jsonResp({ ok, ...data }, ok ? 200 : 502, request);
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 502, request);
  }
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function buildWechatAuth(method, urlPath, body, privKeyPem, mchid, serial) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = randomHex(16);
  const msg   = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const key   = await crypto.subtle.importKey('pkcs8', pemToBuffer(privKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${serial}",signature="${sigB64}"`;
}

async function decryptWechatResource(ciphertext, nonce, associatedData, apiV3Key) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiV3Key),
    { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new TextEncoder().encode(nonce), additionalData: new TextEncoder().encode(associatedData) },
    key, b64ToBuffer(ciphertext)
  );
  return new TextDecoder().decode(plain);
}

async function signAlipay(params, privKeyPem) {
  const signStr = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null && params[k] !== '')
    .sort().map(k => `${k}=${params[k]}`).join('&');
  const key = await crypto.subtle.importKey('pkcs8', pemToBuffer(privKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signStr));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyAlipay(params, pubKeyPem) {
  const sign = params.sign;
  if (!sign) return false;
  const signStr = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] != null && params[k] !== '')
    .sort().map(k => `${k}=${params[k]}`).join('&');
  try {
    const key = await crypto.subtle.importKey('spki', pemToBuffer(pubKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBuffer(sign), new TextEncoder().encode(signStr));
  } catch (e) { return false; }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function jsonResp(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}
