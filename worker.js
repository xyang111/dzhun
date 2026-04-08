// ═══════════════════════════════════════════════════════════════
//  贷准 · Cloudflare Worker v2.1
//  OCR优化：① 查询类型扩展至6类（含保前审查/融资租赁审批）
//           ② 信用卡余额字段修复（额度0时取余额）
//           ③ 循环授信余额0但未结清账户不再被跳过
//           ④ 互联网银行改为反向规则，无需维护白名单
//           ⑤ Markdown清洗新增贷后管理行过滤等5条规则
//           ⑥ 查询统计维度统一为近1月/3月/6月/1年
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
// ② OCR 解析 Prompt — 双版本
//   PROMPT_OCR        原版（Claude Vision降级路径使用，图片输入需详细说明）
//   PROMPT_OCR_TEXT   精简版（Textin文本路径使用，无需图片识别说明）
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
1. 贷款账户：只提取当前未结清账户（含余额为0但在有效期内的循环授信账户——余额为0≠已结清，报告中明确写「已结清」才能跳过）。已结清账户跳过，但若有历史逾期需记入 overdue_history_notes。
2. 信用卡账户：只提取人民币账户且未销户的贷记卡（含尚未激活的卡）。外币账户跳过不提取。已销户账户跳过不提取。
   ⚠️ 信用卡 used 字段规则：取「已使用额度」或「余额」中数值较大的那个。若信用额度为0但存在余额或未出账大额专项分期余额，used 必须填写实际余额数值，绝不能填0。
3. 查询记录：严格逐条核对查询原因列，以下6类才能写入 query_records，type 字段必须原文照抄：
   ✅ 「贷款审批」「信用卡审批」「担保资格审查」「资信审查」「保前审查」「融资租赁审批」
   ❌ 其余所有查询原因一律跳过，禁止写入，包括：
      贷后管理、本人查询、贷前管理、保险资格审查、特约商户资格审查、司法调查、异议申请、其他
   ⚠️ 极易混淆警告：「贷后管理」在报告中出现频率极高，与「贷款审批」字形相近，必须逐条核对原文，绝不能把「贷后管理」误写为「贷款审批」。
   ⚠️ 自查：识别完所有记录后，逐条检查 query_records，凡 type 不属于上述6类之一的，立即删除。

【多张图片处理】
如果上传了多张图片，必须逐张检查所有页面，将所有页面的查询记录合并后一起输出，不得遗漏任何一张图片中的查询记录。

【账户名称标准化】
name 字段格式统一为「银行简称-账户类型」：
- 银行简称：去掉「股份有限公司」「有限公司」「分行」「支行」「中心」「营业部」等后缀，保留核心品牌名
- 账户类型：贷款填「消费贷/住房贷/车贷/其他贷」，信用卡填「贷记卡」

【账户类型判断（严格执行）】

▌ type = "bank"（传统银行贷款）
以下机构归为银行类（type="bank"）：
- 国有六大行：工商银行、农业银行、中国银行、建设银行、交通银行、邮储银行
- 股份制银行：招商、兴业、平安、中信、浦发、光大、华夏、民生、浙商、广发、渤海、恒丰、浙江网商（不含）
- 政策性银行：国家开发银行、农业发展银行、进出口银行
- 城市商业银行：以城市命名的银行或含「城商」「城市商业」字样（如北京银行、南京银行、杭州银行、兰州银行、海峡银行、青岛银行、梅州客商银行等）
  ⚠️ 注意：下列机构虽含地名但属于互联网助贷银行，必须归入 online_bank，不得归入城商行：长安银行、三湘银行、蓝海银行、振兴银行、苏商银行、锡商银行、中关村银行
- 农村金融机构：含「农商」「农信」「农村商业」「农村合作」「村镇银行」「农村信用」字样的机构

▌ type = "online"（互联网助贷/网贷）—— 判断规则（反向规则，不需要穷举名单）：
① 凡不属于上述传统银行类的含「银行」字样机构，一律归入 online_subtype="online_bank"
   （典型例子：众邦银行、通商银行、蓝海银行、三湘银行、苏宁银行、富民银行、亿联银行、振兴银行、苏商银行、新网银行、锡商银行、中关村银行、长安银行、微众银行、网商银行、百信银行、裕民银行、华通银行等）
   ⚠️ 判断优先级：①规则中列出的 online_bank 示例名单 > ②城市命名规则。凡在示例名单中出现的机构，一律按 online_bank 处理，不再按城商行归类。
② online_subtype = "consumer_finance"：机构名含「消费金融」字样，或以下机构：招联、马上、中邮、捷信、哈银消金、盛银消金、北银消金、小米消费金融、中原消费、锦程消费、兴业消费、幸福消费、中信消费
③ online_subtype = "microloan"：机构名含「小额贷款」「小贷」字样

▌ type = "credit"（信用卡账户）

【贷款细分类型（loan_category）】
- "mortgage"：名称含「住房/房贷/按揭/公积金贷款/购房/住房公积金」
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
    {"date": "2025-10-02", "type": "担保资格审查"},
    {"date": "2025-09-22", "type": "保前审查"}
  ],
  "overdue_current": 0,
  "overdue_history_notes": "无",
  "has_overdue_history": false,
  "has_bad_record": false,
  "bad_record_notes": "无",
  "ocr_warnings": [],
  "notes": "识别到X笔未结清贷款，Y张未销户人民币信用卡"
}`;

// ── 精简版Prompt：专为Textin文本路径设计，去掉图片识别说明，减少token消耗 ──
const PROMPT_OCR_TEXT = `从以下人行征信报告文字中提取结构化数据，直接输出JSON，不含其他文字。

提取规则：
1. 基本信息：person_name姓名、id_number身份证号18位、report_date报告日期YYYY-MM-DD
2. 信息概要：summary_overdue_accounts逾期账户数（--记0）、summary_overdue_90days 90天逾期账户数（--记0）
3. 不良记录：has_bad_record（含呆账/担保代还/代偿/资产处置/止付/冻结→true）、bad_record_notes具体描述
4. 贷款：只取未结清账户（含余额为0但有效期内的循环授信，余额0≠已结清，报告明确写「已结清」才跳过）。name格式"银行简称-消费贷/住房贷/车贷/其他贷"；due_date到期日YYYY-MM-DD（循环授信填null）；is_revolving循环授信填true
   type判断：国有行/股份制/城商/农商/农信/村镇银行→bank；消费金融公司或含「消费金融」字样→online(consumer_finance)；含「小贷」「小额贷款」字样→online(microloan)；其余含「银行」字样但不属于上述传统银行的→online(online_bank)。⚠️特别注意：长安银行、三湘银行、蓝海银行、振兴银行、苏商银行、锡商银行、中关村银行虽含地名，但属于online_bank，不能归为城商行。
   loan_category：住房/按揭/公积金→mortgage，汽车/车贷→car，bank非房非车→credit，online→finance
5. 信用卡：只取未销户人民币贷记卡（含未激活）。name格式"银行简称-贷记卡"
   ⚠️ used字段：取「已使用额度」与「余额」中较大的值。信用额度为0但存在余额或大额专项分期余额时，used必须填实际余额，绝不能填0。
6. 查询记录：只取以下6类（原文照抄type）：贷款审批、信用卡审批、担保资格审查、资信审查、保前审查、融资租赁审批。其余全部跳过。⚠️"贷后管理"≠"贷款审批"，绝对不能混淆。
7. 历史逾期：has_overdue_history（信息概要逾期账户数>0→true），overdue_history_notes记录详情
8. overdue_current：当前逾期笔数

输出格式（严格JSON，无其他文字）：
{"person_name":"","id_number":"","report_date":"","summary_overdue_accounts":0,"summary_overdue_90days":0,"loans":[{"name":"","type":"","online_subtype":null,"loan_category":"","issued_date":"","due_date":null,"is_revolving":false,"credit_limit":0,"balance":0,"monthly":null,"status":""}],"cards":[{"name":"","limit":0,"used":0,"status":""}],"query_records":[{"date":"","type":""}],"overdue_current":0,"overdue_history_notes":"无","has_overdue_history":false,"has_bad_record":false,"bad_record_notes":"无","ocr_warnings":[],"notes":""}`;

// ── Markdown预处理：深度清洗Textin返回的噪音，最大化减少Claude输入token ──
// 征信报告的有效信息密度极高但版面噪音也多，这里激进清洗
function cleanMarkdown(md) {
  if (!md) return '';
  let s = md;

  // 1. 去掉所有图片（图章、签名、二维码等，对文字提取零价值）
  s = s.replace(/!\[.*?\]\(.*?\)/g, '');
  // 2. 去掉HTML标签（<br> <span> <table>等Textin偶发输出）
  s = s.replace(/<[^>]+>/g, ' ');
  // 3. 去掉Markdown链接，保留文字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 4. 去掉所有#标题标记（征信报告无章节层级，#只是噪音）
  s = s.replace(/^#{1,6}\s*/gm, '');
  // 5. 去掉分隔线（Textin用---分割页面，对数据提取无意义）
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');
  // 6. 去掉粗体/斜体标记，保留文字（**加粗** → 加粗）
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  s = s.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
  // 7. 去掉反引号代码标记
  s = s.replace(/`{1,3}[^`]*`{1,3}/g, '');
  // 8. 去掉页眉页脚常见噪音：纯数字行（页码）、纯符号行
  s = s.replace(/^\s*\d+\s*$/gm, '');
  s = s.replace(/^[|─━┼┬┴┤├╔╗╚╝═║\s]+$/gm, '');
  // 9. 去掉空的表格行（| | | 这类）
  s = s.replace(/^\|[\s|]*\|$/gm, '');
  // 10. 合并连续空行（3行以上→1行）
  s = s.replace(/\n{3,}/g, '\n\n');
  // 11. 去掉行末空格
  s = s.replace(/ +$/gm, '');
  // 12. 去掉行首多余空格（缩进对征信数据无意义）
  s = s.replace(/^ {2,}/gm, '');
  // 0A. 查询记录跨行合并（必须在所有其他规则之前执行）
  //     征信PDF中机构名过长时Textin会在中间截断换行，例如：
  //     「3  2026年02月21日  交通银行...太平洋信用」+ 换行 +「卡中心」
  //     「4  2026年02月19日  中融信担保（大连）股份有限」+ 换行 +「公司 担保资格审查」
  //     策略：上行含日期（是查询行），下行不含日期且长度≤15字 → 合并到上行
  s = s.replace(/(.*\d{4}年\d{2}月\d{2}日.*)\n([^\d\n][^\n]{0,14})(\n|$)/gm, (match, line1, line2, ending) => {
    if (line2.trim() === '') return match;
    if (!/\d{4}年/.test(line2)) return line1 + line2.trim() + ending;
    return match;
  });
  // 13. 过滤掉整行「贷后管理」查询记录（最高频噪音，直接在Markdown层拦截）
  s = s.replace(/^.*贷后管理.*$/gm, '');
  // 14. 删除「系统中没有您」类空记录行
  s = s.replace(/^.*系统中没有您.*$/gm, '');
  // 15. 删除免责声明类行（逐行匹配，避免跨行误伤）
  s = s.replace(/^.*(本报告仅供|征信中心不确保|请妥善保管|全国客户服务热线|更多咨询|请到当地信用报告|本报告中的信息是依据|仅包含可能影响您|您有权对本报告|因保管不当造成).*$/gm, '');
  // 16. 已结清相关行整行删除（三种情况，逐行匹配不跨行，不影响查询记录区域）
  //     ⚠️ 含「逾期」的行必须保留——「发生过逾期的账户明细」里的行同时含已结清+逾期，不能删
  s = s.replace(/^[^\n]*已结清账户明细[^\n]*$/gm, '');         // 小标题行（无逾期信息）
  s = s.replace(/^(?![^\n]*逾期)[^\n]*发放的[\d,]+元[^\n]*已结清[^\n]*$/gm, '');  // 普通已结清贷款（排除含逾期的行）
  // 17. 已结清循环授信行整行删除（含「授信」+「可循环使用」+「已结清」，排除含逾期的行）
  s = s.replace(/^(?![^\n]*逾期)[^\n]*授信[^\n]*可循环使用[^\n]*已结清[^\n]*$/gm, '');
  // 18. 再次合并连续空行
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ═══════════════════════════════════════════════════════════════
// 规则引擎：直接解析 Textin 原始 Markdown，零模型调用
// 征信简版报告是人行规定的固定格式，结构稳定，可当协议解析
// 置信度 ≥ 0.80 → 直接返回，跳过 Haiku（速度 <0.1s vs 20-35s）
// 置信度 < 0.80 → 自动降级到 Haiku
// ═══════════════════════════════════════════════════════════════
function parseReportByRules(md) {

  // ── 预处理 ──────────────────────────────────────────────────
  let s = md;
  s = s.replace(/<br\s*\/?>/gi, ' ');                              // <br> → 空格（查询表机构名跨行）
  s = s.replace(/<!--[\s\S]*?-->/g, '');                           // 删页码注释
  s = s.replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, '$1年$2月$3日'); // 日期去空格
  s = s.replace(/(\d{4}年\d{1,2}月\d{1,2})口/g, '$1日');           // OCR '口'→'日' 兼容

  // ── 工具函数 ─────────────────────────────────────────────────
  const parseNum = str => {
    if (!str) return null;
    const n = parseFloat(String(str).replace(/[,，\s]/g, ''));
    return isNaN(n) ? null : n;
  };
  const toDate = (y, m, d) =>
    `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const stripMd = str => (str || '').replace(/\*{1,3}/g, '').trim();

  // 机构名简化：去掉法律后缀/分支后缀
  // ⚠️ 分行/支行 regex 必须用 [^\s银] 开头，防止贪婪吃掉"银行"中的"行"
  const shortName = raw => raw
    .replace(/（原[：:][^）]+）/g, '')
    .replace(/股份有限公司|有限责任公司|有限公司|股份公司/g, '')
    .replace(/[^\s银行][\u4e00-\u9fff]{0,3}分行$/, '')   // 排除'银'和'行'，防止吃掉"银行"的"行"
    .replace(/[^\s银行][\u4e00-\u9fff]{0,3}支行$/, '')
    .replace(/信用卡中心$|消费金融中心$|中心$|营业部$/, '')
    .trim();

  // 机构分类
  const ONLINE_BANK_LIST = [
    '长安银行','三湘银行','蓝海银行','振兴银行','苏商银行','锡商银行',
    '中关村银行','众邦银行','通商银行','富民银行','亿联银行','百信银行',
    '裕民银行','华通银行','微众银行','网商银行','新网银行','苏宁银行',
  ];
  const BIG6        = /工商银行|农业银行|中国银行|建设银行|交通银行|邮储银行/;
  const JOINT_STOCK = /招商银行|兴业银行|平安银行|中信银行|浦发银行|光大银行|华夏银行|民生银行|浙商银行|广发银行|渤海银行|恒丰银行/;
  const RURAL       = /农商银行|农信|农村商业|农村合作|村镇银行|农村信用/;

  const classifyInst = (rawInst, loanTypeStr = '') => {
    const n = rawInst;
    // 消费金融公司
    if (/消费金融/.test(n)) return { type:'online', online_subtype:'consumer_finance', loan_category:'finance' };
    // 小额贷款 / 信托
    if (/小额贷款|小贷|信托/.test(n)) return { type:'online', online_subtype:'microloan', loan_category:'finance' };
    // 含"银行"的机构
    if (/银行/.test(n)) {
      if (ONLINE_BANK_LIST.some(k => n.includes(k)))
        return { type:'online', online_subtype:'online_bank', loan_category:'finance' };
      const bankCat = /住房|房贷|按揭|公积金|购房/.test(loanTypeStr) ? 'mortgage'
                    : /汽车|购车|车贷|车辆|机动车/.test(loanTypeStr) ? 'car' : 'credit';
      if (BIG6.test(n) || JOINT_STOCK.test(n) || RURAL.test(n))
        return { type:'bank', online_subtype:null, loan_category:bankCat };
      return { type:'bank', online_subtype:null, loan_category:bankCat }; // 城商行
    }
    return { type:'online', online_subtype:'consumer_finance', loan_category:'finance' };
  };

  const catLabel = c => ({ mortgage:'住房贷', car:'车贷', credit:'消费贷', finance:'消费贷' }[c] || '消费贷');

  // ── 1. 基本信息 ───────────────────────────────────────────────
  // 兼容 PDF（含**加粗**）和图片OCR（纯文字）两种 Textin 输出格式
  // 姓名只取中文字符（中国姓名2-6个汉字），避免行内其他字段干扰
  const nameM  = s.match(/姓名[：:]\s*\*{0,2}([\u4e00-\u9fff]{2,6})/);
  // 兼容三种格式：
  //   证件号码：350781...          （纯文字）
  //   **证件号码**：**350781...**  （整体加粗，Textin PDF版）
  //   证件号码：\n350781...        （号码换行）
  const idM    = s.match(/证件号码\*{0,2}[：:][^0-9\n]*(\d{17}[\dXx])/)
              || s.match(/证件号码[：:]\s*\n[^0-9\n]*(\d{17}[\dXx])/);  // 号码在下一行
  // 日期兼容：报告时间自身可能加粗（**报告时间**：2025-12-03）
  const dateM  = s.match(/报告时间\*{0,2}[：:][^\n]*?(\d{4}-\d{2}-\d{2})/)
              || (()=>{ const m = s.match(/报告时间\*{0,2}[：:][^\n]*?(\d{4})[年/](\d{1,2})[月/](\d{1,2})/);
                        return m ? [null,`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`] : null; })();
  const person_name = stripMd(nameM?.[1] ?? '');
  const id_number   = (idM?.[1] ?? '').toUpperCase();
  const report_date = Array.isArray(dateM) ? dateM[1] : '';

  // ── 2. 信息概要 HTML 表格 ─────────────────────────────────────
  let summary_overdue_accounts = 0, summary_overdue_90days = 0;
  let summaryActiveCards = -1, summaryActiveLoans = -1;

  const summaryTblM = s.match(/<table[^>]*>([\s\S]*?发生过逾期[\s\S]*?)<\/table>/);
  if (summaryTblM) {
    const toN = v => { const n = parseInt(v); return isNaN(n) ? 0 : n; };
    for (const tr of [...summaryTblM[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g,'').trim());
      const label = tds[0] || '';
      if (/未结清|未销户/.test(label)) {
        summaryActiveCards = toN(tds[1]);
        summaryActiveLoans = toN(tds[2]) + toN(tds[3]) + toN(tds[4] ?? '--'); // 含其他业务
      } else if (/发生过逾期的账户数/.test(label) && !/90/.test(label)) {
        summary_overdue_accounts = toN(tds[1]) + toN(tds[2]) + toN(tds[3]);
      } else if (/90/.test(label)) {
        summary_overdue_90days = toN(tds[1]) + toN(tds[2]) + toN(tds[3]);
      }
    }
  }

  // ── 3. 切分 section ───────────────────────────────────────────
  const getSection = (text, startRe, ...endStrs) => {
    const sm = text.match(startRe);
    if (!sm) return '';
    const rest = text.slice(sm.index + sm[0].length);
    const indices = endStrs.map(e => rest.indexOf(e)).filter(i => i >= 0);
    const idx = indices.length ? Math.min(...indices) : -1;
    return idx >= 0 ? rest.slice(0, idx) : rest;
  };
  // 兼容 PDF（## 标题）、加粗（**信用卡**）和图片OCR（纯文字标题）三种 section 格式
  const cardSection  = getSection(s, /(?:^##\s*信用卡|\*{1,2}信用卡\*{1,2}|^\s*信用卡\s*$)/m, '贷款');
  // 贷款 section 止于「其他业务」（防止其他业务条目被误解析为贷款），其他业务单独解析后并入
  const loanSection  = getSection(s, /(?:^##\s*贷款|\*{1,2}贷款\*{1,2}|^\s*贷款\s*$)/m, '其他业务', '非信贷交易记录');
  const otherSection = getSection(s, /(?:^##\s*其他业务|\*{1,2}其他业务\*{1,2}|^\s*其他业务\s*$)/m, '非信贷交易记录');
  console.log(`[OCR] sections: card=${cardSection.length} loan=${loanSection.length} other=${otherSection.length}`);

  // ── 4. 解析信用卡 ─────────────────────────────────────────────
  const cards = [];
  for (const blk of cardSection.split(/\n(?=\d+[\.．])/)) {
    const line = blk.trim();
    if (!line || !/^\d+/.test(line)) continue;
    const text = line.replace(/^\d+[\.．]\s*/, '');

    if (/\d{4}年\d{1,2}月销户/.test(text)) continue;             // 跳过已销户

    // 提取机构名：日期后、"发放的贷记卡"前
    const afterDateM = text.match(/\d{4}年\d{1,2}月\d{1,2}日([\s\S]+?)发放的贷记卡/);
    const rawInst  = afterDateM?.[1]?.trim() ?? '';
    const instShort = shortName(rawInst);

    if (/尚未激活/.test(text)) {
      cards.push({ name:`${instShort}-贷记卡`, limit:0, used:0, status:'未激活' });
      continue;
    }
    // 美元账户：只计数（与摘要表对齐），额度/已用归0，避免以USD数值虚增人民币总额
    if (/美元账户/.test(text)) {
      cards.push({ name:`${instShort}-贷记卡(美元)`, limit:0, used:0, status:'正常', currency:'USD' });
      continue;
    }
    const limitM   = text.match(/信用额度([\d,]+)/);
    const usedM    = text.match(/已使用额度([\d,]+)/);
    const balanceM = text.match(/余额([\d,]+)/);
    const limit  = parseNum(limitM?.[1])   ?? 0;
    const usedAmt = parseNum(usedM?.[1])   ?? 0;
    const bal    = parseNum(balanceM?.[1]) ?? 0;
    cards.push({ name:`${instShort}-贷记卡`, limit, used:Math.max(usedAmt, bal), status:'正常' });
  }

  // ── 5. 解析贷款 ───────────────────────────────────────────────
  const loans = [];
  const overdueHistory = [];
  let settledCount = 0;

  let inOverdueSection = false;
  for (const rawLine of loanSection.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // ⚠️ 必须先判断「从未」再判断「发生过」，否则「从未」行会匹配两个pattern
    if (line.includes('从未发生过逾期的账户明细如下')) { inOverdueSection = false; continue; }
    if (line.includes('发生过逾期的账户明细如下'))     { inOverdueSection = true;  continue; }
    if (!/^\d+[\.．]/.test(line) || !/\d{4}年/.test(line)) continue;

    const text = line.replace(/^\d+[\.．]\s*/, '');
    const isSettled   = /已结清/.test(text);
    const isRevolving = /为.{1,50}授信/.test(text);
    const overdueM    = text.match(/最近5年内有(\d+)个月处于逾期状态/);

    if (isSettled) {
      settledCount++;
      if (overdueM) {
        const instTag = text.match(/\d{4}年\d{1,2}月\d{1,2}日([\s\S]+?)(?:发放的|为)/);
        overdueHistory.push(`${shortName(instTag?.[1]?.trim() ?? '')}逾期${overdueM[1]}个月`);
      }
      continue;
    }

    // 发放日（第一个日期）
    const issM = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!issM) continue;
    const issued_date = toDate(issM[1], issM[2], issM[3]);
    const status = (inOverdueSection || overdueM) ? '逾期' : '正常';

    if (isRevolving) {
      // 循环授信：日期 → 机构名 → "为" → 类型 → "授信"
      const instM    = text.match(/\d{4}年\d{1,2}月\d{1,2}日([\s\S]+?)为/);
      const typeM    = text.match(/为([\s\S]+?)授信/);
      const limitM   = text.match(/信用额度([\d,]+)元/);
      const balanceM = text.match(/余额为([\d,]+)/);
      const rawInst  = instM?.[1]?.trim() ?? '';
      const { type, online_subtype, loan_category } = classifyInst(rawInst, typeM?.[1] ?? '');
      loans.push({
        name: `${shortName(rawInst)}-${catLabel(loan_category)}`,
        type, online_subtype, loan_category,
        issued_date, due_date: null, is_revolving: true,
        credit_limit: parseNum(limitM?.[1]) ?? 0,
        balance:      parseNum(balanceM?.[1]) ?? 0,
        monthly: null, status,
      });
    } else {
      // 定期贷款：日期 → 机构名 → "发放的" → 金额 → 类型 → 到期日 → 余额
      const instM    = text.match(/\d{4}年\d{1,2}月\d{1,2}日([\s\S]+?)发放的/);
      const clM      = text.match(/发放的([\d,]+)元/);
      const typeM    = text.match(/元（(?:人民币|美元)）([\s\S]+?)，/);
      const dueM     = text.match(/，(\d{4})年(\d{1,2})月(\d{1,2})日到期/);
      const balanceM = text.match(/余额([\d,]+)/);
      const rawInst  = instM?.[1]?.trim() ?? '';
      const { type, online_subtype, loan_category } = classifyInst(rawInst, typeM?.[1] ?? '');
      loans.push({
        name: `${shortName(rawInst)}-${catLabel(loan_category)}`,
        type, online_subtype, loan_category,
        issued_date,
        due_date: dueM ? toDate(dueM[1], dueM[2], dueM[3]) : null,
        is_revolving: false,
        credit_limit: parseNum(clM?.[1]) ?? 0,
        balance: parseNum(balanceM?.[1]) ?? 0,
        monthly: null, status,
      });
    }
  }

  // ── 5b. 解析其他业务（融资租赁等）──────────────────────────────
  // 其他业务格式："YYYY年MM月DD日[机构]办理的[金额]元...业务，YYYY年MM月DD日到期。...余额XXXX"
  for (const rawLine of otherSection.split('\n')) {
    const line = rawLine.trim();
    if (!line || !/^\d+[\.．]/.test(line) || !/\d{4}年/.test(line)) continue;
    const text = line.replace(/^\d+[\.．]\s*/, '');
    if (/已结清/.test(text)) { settledCount++; continue; }
    const issM    = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!issM) continue;
    const issued_date = toDate(issM[1], issM[2], issM[3]);
    const instM   = text.match(/\d{4}年\d{1,2}月\d{1,2}日([\s\S]+?)(?:办理的|发放的)/);
    const clM2    = text.match(/(?:办理的|发放的)([\d,]+)元/);
    const dueM    = text.match(/，(\d{4})年(\d{1,2})月(\d{1,2})日到期/);
    const balanceM= text.match(/余额([\d,]+)/);
    const rawInst = instM?.[1]?.trim() ?? '';
    loans.push({
      name: `${shortName(rawInst)}-融资租赁`,
      type: 'online', online_subtype: 'microloan', loan_category: 'finance',
      issued_date,
      due_date: dueM ? toDate(dueM[1], dueM[2], dueM[3]) : null,
      is_revolving: false,
      credit_limit: parseNum(clM2?.[1]) ?? 0,
      balance: parseNum(balanceM?.[1]) ?? 0,
      monthly: null,
      status: '正常',
    });
  }

  // ── 6. 解析查询记录 HTML 表格 ─────────────────────────────────
  // ⚠️ 查询表跨页时 Textin 会输出多个 <table>，必须用 matchAll 捕获全部
  const ALLOWED_Q = new Set(['贷款审批','信用卡审批','担保资格审查','资信审查','保前审查','融资租赁审批']);
  const query_records = [];
  const qSectionStart = s.indexOf('机构查询记录明细');
  if (qSectionStart >= 0) {
    const qSection = s.slice(qSectionStart);
    for (const tblMatch of qSection.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
      for (const tr of [...tblMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]) {
        const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map(m => m[1].replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim());
        if (tds.length < 4 || tds[1] === '查询日期') continue;
        if (!ALLOWED_Q.has(tds[3])) continue;
        const dm = tds[1].match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日口]/);
        if (dm) query_records.push({ date: toDate(dm[1], dm[2], dm[3]), type: tds[3] });
      }
    }
  }
  console.log(`[OCR] query_records: ${query_records.length}条 (${query_records.filter(q=>ALLOWED_Q.has(q.type)).map(q=>q.date).slice(0,5).join(',')}...)`);

  // ── 6b. 查询次数统计（以报告日期为基准）──────────────────────────
  const refDate = report_date || new Date().toISOString().slice(0,10);
  const msPerDay = 86400000;
  const refMs = new Date(refDate).getTime();
  const daysAgo = d => (refMs - new Date(d).getTime()) / msPerDay;
  const q_1m  = query_records.filter(q => daysAgo(q.date) <= 31).length;
  const q_3m  = query_records.filter(q => daysAgo(q.date) <= 92).length;
  const q_6m  = query_records.filter(q => daysAgo(q.date) <= 183).length;
  const q_12m = query_records.filter(q => daysAgo(q.date) <= 366).length;
  console.log(`[OCR] query counts: 1m=${q_1m} 3m=${q_3m} 6m=${q_6m} 12m=${q_12m}`);

  // ── 7. 逾期汇总 ───────────────────────────────────────────────
  const has_overdue_history     = summary_overdue_accounts > 0;
  const overdue_history_notes   = overdueHistory.length ? overdueHistory.join('；') : '无';
  const overdue_current         = loans.filter(l => l.status === '逾期').length;

  // ── 8. 置信度计算 ─────────────────────────────────────────────
  // 基础字段 0.70
  let conf = 0;
  if (person_name) conf += 0.25;
  if (/^\d{17}[\dX]$/i.test(id_number))          conf += 0.25;
  if (/^\d{4}-\d{2}-\d{2}$/.test(report_date))   conf += 0.20;
  // 贷款数校验 0.18
  if (summaryActiveLoans >= 0) {
    const d = Math.abs(loans.length - summaryActiveLoans);
    conf += d === 0 ? 0.18 : d === 1 ? 0.14 : d === 2 ? 0.08 : 0;
  } else { conf += 0.10; }
  // 信用卡数校验 0.12
  if (summaryActiveCards >= 0) {
    const d = Math.abs(cards.length - summaryActiveCards);
    conf += d === 0 ? 0.12 : d <= 2 ? 0.10 : d <= 4 ? 0.07 : 0;
  } else { conf += 0.07; }

  const result = {
    person_name, id_number, report_date,
    summary_overdue_accounts, summary_overdue_90days,
    loans, cards, query_records,
    q_1m, q_3m, q_6m, q_12m,
    overdue_current,
    overdue_history_notes,
    has_overdue_history,
    has_bad_record: false,
    bad_record_notes: '无',
    ocr_warnings: [],
    notes: `规则引擎：${loans.length}笔未结清贷款，${cards.length}张信用卡，${settledCount}笔已结清，${query_records.length}条申请类查询`,
  };

  return { result, confidence: Math.min(conf, 1) };
}

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

  // 新查询统计口径：6类申请类查询统一合并，展示4个时间维度
  const q1m  = q.q_1m  || q.loan_1m  || 0;
  const q3m  = q.q_3m  || (q.loan_3m || 0) + (q.loan_3m_card || 0);
  const q6m  = q.q_6m  || q.loan_6m_total || 0;
  const q12m = q.q_12m || 0;

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
查询（申请类合计）：近1月${q1m}次 | 近3月${q3m}次 | 近6月${q6m}次 | 近1年${q12m}次

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
    if (request.method === 'GET' && gNormPath === '/wechat/sign') {
      return handleWechatSign(request, env);
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

  const claudeKey    = env.ANTHROPIC_API_KEY;
  const textinAppId  = env.TEXTIN_APP_ID;
  const textinSecret = env.TEXTIN_SECRET;
  if (!claudeKey) return jsonResp({ error: 'Claude API key not configured' }, 500, request);

  // ── 辅助：base64 → Uint8Array（Cloudflare Worker 不能用 Buffer）──
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ── 辅助：从返回文本里提取合法JSON ──
  function extractRaw(text) {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) return t;
    const ex = _extractJsonStr(text);
    if (ex) { console.log('[OCR] extracted JSON, orig:', text.length, 'got:', ex.length); return ex; }
    console.error('[OCR] no JSON found, len:', text.length);
    return t;
  }

  // ── 辅助：把极简字段名还原为前端期望的完整字段名 ──
  function expandOCRKeys(raw) {
    try {
      const d = JSON.parse(raw);
      const expand = (obj, map) => {
        const r = {};
        for (const [k, v] of Object.entries(obj)) r[map[k] || k] = v;
        return r;
      };
      const lMap = { n:'name', t:'type', os:'online_subtype', lc:'loan_category', id:'issued_date', dd:'due_date', rv:'is_revolving', cl:'credit_limit', b:'balance', m:'monthly', s:'status' };
      const cMap = { n:'name', l:'limit', u:'used', s:'status' };
      const qMap = { d:'date', t:'type' };
      const full = {
        person_name:            d.pn   ?? d.person_name ?? '',
        id_number:              d.idn  ?? d.id_number   ?? '',
        report_date:            d.rd   ?? d.report_date ?? '',
        summary_overdue_accounts: d.soa ?? d.summary_overdue_accounts ?? 0,
        summary_overdue_90days:   d.so9 ?? d.summary_overdue_90days   ?? 0,
        loans:         (d.loans  || []).map(l => expand(l, lMap)),
        cards:         (d.cards  || []).map(c => expand(c, cMap)),
        query_records: (d.query_records || []).map(q => expand(q, qMap)),
        overdue_current:      d.oc  ?? d.overdue_current      ?? 0,
        overdue_history_notes: d.ohn ?? d.overdue_history_notes ?? '无',
        has_overdue_history:  d.hoh ?? d.has_overdue_history  ?? false,
        has_bad_record:       d.hbr ?? d.has_bad_record        ?? false,
        bad_record_notes:     d.brn ?? d.bad_record_notes      ?? '无',
        ocr_warnings:         d.w   ?? d.ocr_warnings          ?? [],
        notes:                d.notes ?? '',
      };
      return JSON.stringify(full);
    } catch (e) {
      // 解析失败则原样返回，避免双重故障
      return raw;
    }
  }

  // ── 辅助：只缓存合法JSON ──
  async function writeCache(raw) {
    if (!cacheKey || !env.CACHE) return;
    try { JSON.parse(raw); await env.CACHE.put(`ocr:${cacheKey}`, raw, { expirationTtl: 7200 }); }
    catch (_) { console.error('[OCR] invalid JSON, skip cache, len:', raw.length); }
  }

  // ════════════════════════════════════════════════════════
  // 主路径：Textin（图片→文字）+ Claude Haiku（文字→JSON）
  // 优势：Textin专业OCR快且准，Haiku处理纯文字比Sonnet Vision便宜15倍
  // ════════════════════════════════════════════════════════
  if (textinAppId && textinSecret) {
    try {
      let combinedMarkdown = '';
      let textinFailed = false;

      for (let i = 0; i < fileBlocks.length; i++) {
        const b64 = fileBlocks[i].source?.data;
        if (!b64) continue;
        const bytes = base64ToBytes(b64);
        console.log(`[Textin] block ${i+1}/${fileBlocks.length} size:`, bytes.length);

        const tr = await fetch(
          'https://api.textin.com/ai/service/v1/pdf_to_markdown?markdown_details=0&page_details=0&apply_document_tree=0',
          {
            method: 'POST',
            headers: {
              'x-ti-app-id':      textinAppId,
              'x-ti-secret-code': textinSecret,
              'Content-Type':     'application/octet-stream',
            },
            body: bytes,
          }
        );
        const td = await tr.json();
        console.log(`[Textin] block ${i+1} code:`, td.code, 'msg:', td.message);
        if (td.code !== 200) { textinFailed = true; break; }

        const pageText = td.result?.markdown || '';
        if (pageText.trim()) combinedMarkdown += (i > 0 ? '\n\n' : '') + pageText;
      }

      if (!textinFailed && combinedMarkdown.trim()) {
        // ── 规则引擎优先：零模型调用，<0.1s，置信度≥0.8直接返回 ──
        console.log('[OCR] raw md preview:', JSON.stringify(combinedMarkdown.slice(0, 1000)));
        try {
          const { result: ruleResult, confidence } = parseReportByRules(combinedMarkdown);
          console.log(`[OCR] rule engine conf:${confidence.toFixed(2)} loans:${ruleResult.loans.length} cards:${ruleResult.cards.length} name:"${ruleResult.person_name}" id:${ruleResult.id_number?'ok':'FAIL'} date:${ruleResult.report_date||'FAIL'}`);
          if (confidence >= 0.8) {
            const raw = JSON.stringify(ruleResult);
            await writeCache(raw);
            return jsonResp({ raw, _engine: 'textin+rules' }, 200, request);
          }
          console.log('[OCR] rule engine conf too low → Haiku fallback');
        } catch (e) {
          console.error('[OCR] rule engine error:', e.message, '→ Haiku fallback');
        }

        // ── 规则引擎置信度不足，降级到 Haiku ──
        const cleaned = cleanMarkdown(combinedMarkdown);
        console.log('[OCR] markdown cleaned:', combinedMarkdown.length, '→', cleaned.length, '→ Haiku');

        const prompt = `以下是征信报告的文字内容：\n\n${cleaned}\n\n${PROMPT_OCR_TEXT}`;

        const cr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'anthropic-version':'2023-06-01', 'x-api-key': claudeKey },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16384,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const cd = await cr.json();
        if (cd.error) throw new Error(cd.error.message);
        if (cd.stop_reason === 'max_tokens') {
          // 输出被截断 → 抛出异常触发降级到 Sonnet Vision，避免返回残缺JSON
          console.error('[Haiku] truncated even at 16384 tokens, cleaned len:', cleaned.length, '→ fallback to Sonnet');
          throw new Error('haiku_truncated');
        }
        console.log('[Haiku] stop_reason:', cd.stop_reason, 'tokens:', cd.usage?.output_tokens);

        const raw = extractRaw((cd.content||[]).map(b=>b.text||'').join(''));
        await writeCache(raw);
        return jsonResp({ raw, _engine: 'textin+haiku' }, 200, request);
      }

      if (!textinFailed) console.warn('[Textin] empty markdown → fallback');
    } catch (e) {
      console.error('[Textin] exception:', e.message, '→ fallback');
    }
  } else {
    console.log('[OCR] Textin not configured → Claude Vision');
  }

  // ════════════════════════════════════════════════════════
  // 降级路径：Claude Sonnet Vision（Textin失败时自动切换）
  // 用户无感知，流程正常，但速度和成本回到原始水平
  // ════════════════════════════════════════════════════════
  console.log('[OCR] using Claude Sonnet Vision fallback');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'anthropic-version':'2023-06-01', 'x-api-key': claudeKey },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        temperature: 0,
        messages: [{ role: 'user', content: [...fileBlocks, { type: 'text', text: PROMPT_OCR }] }],
      }),
    });
    const data = await resp.json();
    if (data.error) return jsonResp({ error: data.error.message }, 502, request);
    if (data.stop_reason === 'max_tokens') console.error('[Sonnet] truncated, len:', (data.content||[]).map(b=>b.text||'').join('').length);
    console.log('[Sonnet] stop_reason:', data.stop_reason, 'tokens:', data.usage?.output_tokens);
    const raw = extractRaw((data.content||[]).map(b=>b.text||'').join(''));
    await writeCache(raw);
    return jsonResp({ raw, _engine: 'claude-sonnet-vision' }, 200, request);
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

// /api/v1/wechat/sign — 生成 JS-SDK 签名，供前端 wx.config() 使用
async function handleWechatSign(request, env) {
  const url     = new URL(request.url);
  const pageUrl = url.searchParams.get('url');
  if (!pageUrl) return jsonResp({ error: 'url required' }, 400, request);

  const appid  = env.WECHAT_APPID  || '';
  const secret = env.WECHAT_SECRET || '';
  if (!appid || !secret) return jsonResp({ error: 'wechat not configured' }, 500, request);

  try {
    // 通过 ECS 代理调用微信 API（ECS 固定IP已加入微信白名单）
    const WX_PROXY = 'https://dzhun.com.cn/wx-api';

    // access_token（缓存 1.5h）
    let token = await env.CACHE.get('wx_access_token');
    if (!token) {
      const r = await fetch(
        `${WX_PROXY}/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
      );
      const d = await r.json();
      if (!d.access_token) return jsonResp({ error: 'token error: ' + d.errmsg }, 502, request);
      token = d.access_token;
      await env.CACHE.put('wx_access_token', token, { expirationTtl: 5400 });
    }

    // jsapi_ticket（缓存 1.5h）
    let ticket = await env.CACHE.get('wx_jsapi_ticket');
    if (!ticket) {
      const r = await fetch(
        `${WX_PROXY}/cgi-bin/ticket/getticket?access_token=${token}&type=jsapi`
      );
      const d = await r.json();
      if (!d.ticket) return jsonResp({ error: 'ticket error: ' + d.errmsg }, 502, request);
      ticket = d.ticket;
      await env.CACHE.put('wx_jsapi_ticket', ticket, { expirationTtl: 5400 });
    }

    // 生成签名
    const nonceStr  = Math.random().toString(36).slice(2, 18);
    const timestamp = Math.floor(Date.now() / 1000);
    const str       = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl}`;
    const buf       = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    const signature = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

    return jsonResp({ appId: appid, timestamp, nonceStr, signature }, 200, request);
  } catch (e) {
    return jsonResp({ error: 'sign error: ' + e.message }, 502, request);
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
