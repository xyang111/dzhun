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
   institution填写查询机构名称（如"招商银行"），识别不清填""。

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
    {"date": "2025-11-20", "type": "贷款审批", "institution": "招商银行"},
    {"date": "2025-10-15", "type": "信用卡审批", "institution": "建设银行"},
    {"date": "2025-10-02", "type": "担保资格审查", "institution": "工商银行"},
    {"date": "2025-09-22", "type": "保前审查", "institution": "平安银行"}
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
6. 查询记录：只取以下6类（原文照抄type）：贷款审批、信用卡审批、担保资格审查、资信审查、保前审查、融资租赁审批。其余全部跳过。⚠️"贷后管理"≠"贷款审批"，绝对不能混淆。institution填写查询机构名称（如"招商银行"），识别不清填""。
7. 历史逾期：has_overdue_history（信息概要逾期账户数>0→true），overdue_history_notes记录详情
8. overdue_current：当前逾期笔数

输出格式（严格JSON，无其他文字）：
{"person_name":"","id_number":"","report_date":"","summary_overdue_accounts":0,"summary_overdue_90days":0,"loans":[{"name":"","type":"","online_subtype":null,"loan_category":"","issued_date":"","due_date":null,"is_revolving":false,"credit_limit":0,"balance":0,"monthly":null,"status":""}],"cards":[{"name":"","limit":0,"used":0,"status":""}],"query_records":[{"date":"","type":"","institution":""}],"overdue_current":0,"overdue_history_notes":"无","has_overdue_history":false,"has_bad_record":false,"bad_record_notes":"无","ocr_warnings":[],"notes":""}`;

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
        if (dm) query_records.push({ date: toDate(dm[1], dm[2], dm[3]), type: tds[3], institution: tds[2] || '' });
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
  // 注：身份证号在征信报告中永远被遮蔽，不作为置信度信号
  // 基础字段 0.70 → 调整为 0.45（姓名）+ 0.20（日期，可选）
  let conf = 0;
  if (person_name) conf += 0.45;
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

  // 方向可达性映射（必须与前端 app.js renderMatchResult 里的 _dirAccess 保持一致）
  // 这是 single source of truth 注入 prompt，让 AI 严格按方向状态推荐顺序
  const dirAccess = {
    A: { big:'当前可尝试',     joint:'当前可尝试', city:'当前可尝试', cf:'不推荐 · 自损资质' },
    B: { big:'优化后可申请',   joint:'当前可尝试', city:'当前可尝试', cf:'谨慎选择'         },
    C: { big:'6 个月后',        joint:'3 个月后',    city:'当前可尝试', cf:'当前可尝试'       },
    D: { big:'9 个月后',        joint:'6 个月后',    city:'3 个月后',    cf:'当前保底方案'     },
  }[level] || { big:'--', joint:'--', city:'--', cf:'--' };

  const dirAccessText = `- 国有大行 / 优质银行：${dirAccess.big}
- 股份制银行信用贷：${dirAccess.joint}
- 城商行 / 区域银行：${dirAccess.city}
- 消费金融产品：${dirAccess.cf}`;

  const levelInstruction = {
    A: `客户是 A 级（${score}分，PREMIUM ACCESS）。客户已进入银行优质准入区间。你的核心任务：
① key_risk：写"利率档损失提示"——如果不通过白名单通道、不优化申请顺序，可能落入次优利率档，格式如"走错通道，利率档可能下调 1-2 级，长期成本被放大"。不写具体百分比。
② optimization：1-2步。第一步必须体现"先对接白名单通道"${whitelistWork ? `（该客户${workVal}，属白名单职业，明确指出）` : '（根据资质判断是否适用）'}；第二步给"利率档锁定"或"提额方向"。unlock 字段写"锁定最低利率档"或"额度上限上调"等定性描述，不出现具体百分比/万元。
③ advice.strengths：列出让他进入A级的2个具体征信指标，精确到数字（查询次数、负债率等）。advice.issues：写"如果不做白名单对接/通道优化，可能少拿的利率档差或额度上限"。advice.suggestions：按申请顺序给1-2步框架，强调顺序和通道需要顾问协助。`,
    B: `客户是 B 级（${score}分，OPTIMIZATION GAP）。⚠️ 注意：B 级客户**国有大行尚未达到当前可申请状态**（需优化后才能进），但**股份制银行 / 城商行已可直接申请**。

⚠️ 严格禁止以下 C/D 级建议混入 B 级输出：
  - 禁止建议申请消费金融/网贷作为过渡（客户已可进入主流银行区间）
  - 禁止建议"暂停所有申请"或"停止点击链接"
  - 禁止出现"先用高利率过渡"或任何具体百分比相关建议
  - 禁止建议"等待征信修复后再申请"——B级客户现在就可以申请股份制/城商行

⚠️ 严格禁止违反方向可达性映射：
  - 禁止把"国有大行"作为第 1 步推荐方向（B 级映射状态是"优化后可申请"）
  - 第 1 步必须是"股份制银行"或"城商行"（这两个是"当前可尝试"状态）
  - "国有大行"只能放在第 2-3 步，并明确写"完成 X 优化后可进入"

你的核心任务是"申请顺序优化"：让客户感受到不找顾问、不优化申请顺序的代价。
① key_risk：用"现在直接申请，可能因申请顺序错误浪费查询次数；按正确顺序申请并优化后，资质可进入更优利率档"句式，不写具体万元/百分比。
② optimization：聚焦"申请顺序"和"利率档优化"。1-3步，time 字段用相对时间（"立即""1个月后"），禁止绝对年月。第 1 步必须是股份制或城商行（"当前可尝试"），第 2-3 步可以引导到国有大行（"优化后可申请"）。unlock 字段定性，不含具体百分比/万元。
③ advice.issues：必须写"申请顺序不对"的代价（多消耗 X 次查询、利率档下调）。advice.suggestions：给精确申请顺序框架（用"股份制银行 → 城商行 → 优化后冲国有大行"等方向序列，禁止出现具体银行名），强调"顾问协助锁定最低利率档"。`,
    C: `客户是 C 级（${score}分，RECOVERY PATH）。客户当前处于城商行 / 消金过渡区间。你的核心任务是"恢复时间轴"：
① key_risk：用"当前只能走消金过渡方向，3 个月后可进入股份制银行区间，6 个月后可进入国有大行区间"句式，不写具体年化利率。
② optimization：2-3步时间轴，time 字段必须用相对时间（"立即""3个月后""6个月后"），禁止绝对年月。当前可用方向是第一步（写方向类型，禁止具体产品/银行名）；第二步写3个月后解锁的方向（从xai issues里找修复时间最短的）；第三步写6个月后的目标方向。unlock 字段写方向变化如"进入股份制银行区间"。
③ advice.strengths：从征信指标里找让他进入C级而非D级的具体优势（无逾期、社保稳定、有公积金等），给客户建立信心。advice.issues：用利率档成本量化（"走过渡方向比等3个月直接进入主流银行区间多承担 1-2 档利率"，不写具体百分比）。advice.suggestions：给具体方向路径，强调"申请顺序影响3个月后的资格"。`,
    D: `客户是 D 级（${score}分，REHABILITATION PLAN）。银行通道暂时关闭。禁止做损失量化，客户已经知道情况不好，不需要再强化焦虑。你的核心任务是给控制感和路线图：
① key_risk：直接说明导致D级的主因（从xai issues第一条，精确描述），一句话，语气是解释不是判决。
② optimization：严格按时间轴三步，time 字段用相对时间（"立即""3个月后""6个月后"），禁止绝对年月——第一步"立即执行"（具体做什么），第二步"3个月后"（第一个里程碑，解锁什么方向），第三步"6个月后"（回到C级/B级的节点）。每步的 unlock 写"进入城商行区间"或"进入股份制银行区间"这类方向里程碑，禁止具体银行/产品名。
③ advice.strengths：找任何可以建立信心的点（哪怕是"无历史逾期"或"公积金在缴"）。advice.issues：解释原因，不指责。advice.suggestions：第一步最重要的单一行动，给足执行细节，让客户知道"做这件事就是在向前走"。`,
  }[level] || '';

  const todayStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });

  return `你是贷准AI信贷顾问。以下是一位真实客户的完整征信分析数据，请根据客户等级生成方向级建议。

【今日日期】${todayStr}（所有时间节点必须从今天起算，严禁输出历史日期或征信报告日期）

【写作规则 — 强制执行】
1. 口语化，关键判断量化（不说"偏高"，说"高了 2 次"）
2. 严禁出现以下内容（违反任何一条都视为生成失败）：
   ① 任何具体银行名称（如招商/建设/工商/平安/浦发/中信/厦门银行等，全部禁止）
   ② 任何具体产品名称（如闪电贷/E秒贷/信秒贷/借呗/微粒贷等，全部禁止）
   ③ 任何具体年化利率百分比数字（如 3.6% / 18% / 24% / APR X%）—— 利率必须用定性描述（"低""主流""偏高""高"或"利率档：第 N 档"）
   ④ 任何具体万元金额（如 30 万、50 万、10-20 万、100 万）—— 额度只能用定性描述（"主流额度""更高额度上限""小额过渡""中额主流"）。例外：客户实际填写的月收入、征信里实际的负债余额可以原样引用，但禁止凭空给出"申请后能拿到 X 万"这类具体预测金额
   ⑤ "建议直接去银行柜台申请""自行前往XX银行"等绕过顾问的表述
3. 谈方向时只用以下五个方向类型：国有大行 / 股份制银行 / 城商行 / 消费金融 / 网贷
4. 本地规则引擎已完成方向判断（见下方"方向可达性映射"），你必须严格遵守该映射推荐申请顺序，不得自己重新判断哪个方向先申
5. 只输出前端实际渲染的 3 个字段：key_risk、optimization、advice
6. time 字段必须用相对时间（"立即""1个月后""3个月后""6个月后"），严禁输出"XXXX年X月"等绝对日期

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【V2.0评分】${score}分 · ${level}级（A=800+优质准入 | B=650-799优化空间 | C=500-649恢复路径 | D=500以下修复计划）
【四域得分】${dsText}

【方向可达性映射 — 必须严格遵守】
${dirAccessText}

⚠️ optimization / advice.suggestions 必须按以下规则推荐申请顺序：
- 第 1 步只能推荐"当前可尝试"或"当前保底方案"状态的方向
- "优化后可申请"的方向只能放在第 2-3 步（先做完优化才能进）
- "N 个月后"状态的方向只能在该时间节点之后的步骤里出现（如"3 个月后"状态的方向不能在"立即"步骤推荐）
- "不推荐"或"谨慎选择"的方向严禁作为推荐目标，只能作为"避免"的反面参考
- 若多个方向都是"当前可尝试"，优先推荐利率档更优的（国有大行 > 股份制 > 城商行 > 消费金融）

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

【贷款明细（仅供分析征信结构，不得在输出中引用具体机构名）】
${loanDesc}
【信用卡明细（仅供分析使用率/账龄，不得在输出中引用具体银行名）】
${cardDesc}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【当前客户等级专属写作指令】
${levelInstruction}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

严格返回JSON，不含任何其他文字和markdown，只包含以下3个字段：
{
  "key_risk": "25字内，按等级指令写",
  "optimization": [
    {"step": "具体行动，不得为空", "goal": "量化目标（含金额/利率/额度数字）", "time": "相对时间（'立即'/'1个月后'/'3个月后'/'6个月后'，禁止年月日期）", "unlock": "解锁内容（含具体数字）"}
  ],
  "advice": {
    "strengths": [{"point": "具体优势（含数字）", "impact": "对申贷的正面影响"}],
    "issues": [{"point": "具体问题（含数字）", "impact": "量化影响（金额/额度/时间）"}],
    "suggestions": [{"action": "具体行动", "goal": "目标", "time": "相对时间（禁止绝对年月）", "effect": "效果（含数字）"}]
  }
}
注意：optimization列1-3步；advice各子数组列1-3条；所有数字字段必须有真实数值，不得用"X""Y""N"占位。`;
}

// ═══════════════════════════════════════════
// 主路由
// ═══════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
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
    if (request.method === 'GET' && gNormPath === '/products') {
      return handleProductsGet(request, env);
    }
    if (request.method === 'GET' && gNormPath === '/agent/info') {
      return handleAgentInfo(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });
    }

    // POST 路由（/api/v1/* 规范路径 + 旧路径兼容）
    const normPath = path.replace(/^\/api\/v1/, ''); // 去掉版本前缀后统一匹配
    if (normPath === '/pay/create')        return handlePayCreate(request, env);
    if (normPath === '/pay/wechat/confirm') return handleWechatConfirm(request, env);
    if (normPath === '/report')            return handleReport(request, env, ctx);
    if (normPath === '/pdf')               return handlePdf(request, env);
    if (normPath === '/ocr')               return handleOCR(request, env);
    if (normPath === '/match')             return handleMatch(request, env);
    if (normPath === '/score')             return handleScore(request, env);
    if (normPath === '/analytics')         return handleAnalytics(request, env);
    if (normPath === '/outcome')           return handleOutcome(request, env);
    if (normPath === '/score-admin')       return handleScoreAdmin(request, env);
    if (normPath === '/products')          return handleProductsPost(request, env);

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
      const qMap = { d:'date', t:'type', i:'institution' };
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

  // 辅助：OCR 成功后扣代理商配额，返回扣后剩余次数
  async function deductAgent() {
    if (!agentId || !agentData) return null;
    agentData.used += 1;
    await env.ORDERS.put(`agent:${agentId}`, JSON.stringify(agentData));
    console.log(`[OCR] agent ${agentId} used=${agentData.used}/${agentData.quota}`);
    return agentData.quota - agentData.used;
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
          if (confidence >= 0.5) {
            const raw = JSON.stringify(ruleResult);
            await writeCache(raw);
            const _rem1 = await deductAgent();
            return jsonResp({ raw, _engine: 'textin+rules', agentRemaining: _rem1 }, 200, request);
          }
          console.log('[OCR] rule engine conf too low → Haiku fallback');
        } catch (e) {
          console.error('[OCR] rule engine error:', e.message, '→ Haiku fallback');
        }

        // ── 规则引擎置信度不足，降级到 Haiku ──
        const cleaned = cleanMarkdown(combinedMarkdown);
        console.log('[OCR] markdown cleaned:', combinedMarkdown.length, '→', cleaned.length, '→ Haiku');

        try {
          const prompt = `以下是征信报告的文字内容：\n\n${cleaned}\n\n${PROMPT_OCR_TEXT}`;

          const cr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'anthropic-version':'2023-06-01', 'x-api-key': claudeKey },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 16384,
              temperature: 0,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          const cd = await cr.json();
          if (cd.error) {
            console.error('[Haiku] API error type:', cd.error.type, 'message:', cd.error.message, '→ fallback to Sonnet');
            throw new Error('haiku_api_error');
          }
          if (cd.stop_reason === 'max_tokens') {
            console.error('[Haiku] truncated even at 16384 tokens, cleaned len:', cleaned.length, '→ fallback to Sonnet');
            throw new Error('haiku_truncated');
          }
          console.log('[Haiku] stop_reason:', cd.stop_reason, 'tokens:', cd.usage?.output_tokens);

          const raw = extractRaw((cd.content||[]).map(b=>b.text||'').join(''));
          await writeCache(raw);
          const _rem2 = await deductAgent();
          return jsonResp({ raw, _engine: 'textin+haiku', agentRemaining: _rem2 }, 200, request);
        } catch (he) {
          // Haiku 失败不影响 Textin 路径计数，直接进入 Sonnet Vision
          console.error('[Haiku] exception:', he.message, '→ fallback to Sonnet Vision');
        }
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
    const _rem3 = await deductAgent();
    return jsonResp({ raw, _engine: 'claude-sonnet-vision', agentRemaining: _rem3 }, 200, request);
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

  // 付费鉴权：pay token 或 agentId 二选一
  const payToken = body._pay_token || '';
  const agentId  = body._agent_id  || '';
  delete body._pay_token;
  delete body._agent_id;

  if (!payToken && !agentId) {
    return jsonResp({ error: { message: '需要付费后才能查看匹配结果', code: 'PAYMENT_REQUIRED' } }, 402, request);
  }
  if (agentId) {
    const agentRaw = await env.ORDERS.get(`agent:${agentId}`);
    if (!agentRaw) return jsonResp({ error: { message: '代理商账号不存在', code: 'PAYMENT_REQUIRED' } }, 403, request);
    // 代理商验证通过，直接继续（无需 token 过期检查）
  } else {
    const tokenRaw = await env.ORDERS.get(`token:${payToken}`);
    if (!tokenRaw) {
      return jsonResp({ error: { message: '支付凭证无效或已过期，请重新付费', code: 'PAYMENT_REQUIRED' } }, 402, request);
    }
    const td = JSON.parse(tokenRaw);
    if (td.expiresAt < Date.now()) {
      return jsonResp({ error: { message: '支付凭证已过期（24小时内有效），请重新付费', code: 'PAYMENT_REQUIRED' } }, 402, request);
    }
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
        response_format: { type: 'json_object' },
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

// /api/v1/outcome — 代理贷款结果录入（管理员手动提交）
// ═══════════════════════════════════════════
async function handleOutcome(request, env) {
  if (!env.DB) return jsonResp({ ok: false, error: 'DB not bound' }, 503, request);
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ ok: false, error: 'Invalid JSON' }, 400, request);
  }
  const { session_id, product, result, approved_amount, reject_reason, agent_id, admin_key } = body || {};
  if (admin_key !== 'dazhun2024') return jsonResp({ ok: false, error: 'Unauthorized' }, 401, request);
  if (!result) return jsonResp({ ok: false, error: 'result required' }, 400, request);
  const validResults = ['approved', 'rejected', 'abandoned'];
  if (!validResults.includes(result)) return jsonResp({ ok: false, error: 'Invalid result' }, 400, request);
  try {
    await env.DB.prepare(`
      INSERT INTO loan_outcomes (session_id, product, result, approved_amount, reject_reason, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      session_id ? String(session_id).slice(0, 36) : null,
      product     ? String(product).slice(0, 50)       : null,
      result,
      approved_amount ? parseInt(approved_amount)      : null,
      reject_reason   ? String(reject_reason).slice(0, 100) : null,
      agent_id        ? String(agent_id).slice(0, 20)  : null,
      Date.now(),
    ).run();
    return jsonResp({ ok: true }, 200, request);
  } catch (e) {
    console.error('[handleOutcome] D1 error:', e.message);
    return jsonResp({ ok: false, error: e.message }, 500, request);
  }
}

// /api/v1/score-admin — 管理员查询评分和结果数据
// ═══════════════════════════════════════════
async function handleScoreAdmin(request, env) {
  if (!env.DB) return jsonResp({ ok: false, error: 'DB not bound' }, 503, request);
  const url = new URL(request.url);
  const admin_key = url.searchParams.get('admin_key');
  if (admin_key !== 'dazhun2024') return jsonResp({ ok: false, error: 'Unauthorized' }, 401, request);
  const action = url.searchParams.get('action') || 'outcomes';
  try {
    if (action === 'outcomes') {
      const { results } = await env.DB.prepare(
        `SELECT session_id, product, result, approved_amount, reject_reason, agent_id, created_at
         FROM loan_outcomes ORDER BY created_at DESC LIMIT 50`
      ).all();
      return jsonResp({ results }, 200, request);
    }
    if (action === 'scores') {
      const { results } = await env.DB.prepare(
        `SELECT session_id, score, level, cb_score, st_score, as_score, fr_score, q3m, online_inst, dti, income, created_at
         FROM score_records ORDER BY created_at DESC LIMIT 50`
      ).all();
      return jsonResp({ results }, 200, request);
    }
    return jsonResp({ ok: false, error: 'Unknown action' }, 400, request);
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 500, request);
  }
}

// 代理商企业微信群机器人 Webhook（key 与 config.js 保持一致）
const AGENT_WEBHOOKS = {
  'XY001': 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=eeac39a4-e6f8-487d-8a3c-92f6421829b2',
};

async function handleReport(request, env, ctx) {
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

    // 代理商渠道：fire-and-forget 推送 PDF 到企业微信群
    const agentId  = body.agent_id;
    const pdfData  = body.pdfData;
    const webhook  = agentId && AGENT_WEBHOOKS[agentId];
    if (webhook && pdfData?.ocrData && env.PDF_SERVICE_SECRET) {
      ctx.waitUntil(sendWechatPdf(pdfData, name, time, body['渠道代理'] || agentId, webhook, env).catch(e => {
        console.error('[WeChat] sendWechatPdf 顶层错误:', e.message);
      }));
    }

    return jsonResp({ ok, ...data }, ok ? 200 : 502, request);
  } catch (e) {
    return jsonResp({ ok: false, error: e.message }, 502, request);
  }
}

async function sendWechatPdf(pdfData, clientName, submitTime, agentLabel, webhookUrl, env) {
  const key = new URL(webhookUrl).searchParams.get('key');
  if (!key) { console.error('[WeChat] invalid webhook URL, no key'); return; }

  const { ocrData, v2Score, userInfo, pdfStats } = pdfData;
  const personName = ocrData.person_name || clientName || '用户';
  const rDate      = (ocrData.report_date || '').replace(/-/g, '');
  const filename   = `贷准报告_${personName}_${rDate}.pdf`;

  // 1. 生成 PDF
  const html = buildPdfHtml(ocrData, v2Score, userInfo, pdfStats);
  const pdfResp = await fetch('https://dzhun.com.cn/pdf-render', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-pdf-secret': env.PDF_SERVICE_SECRET },
    body:    JSON.stringify({ html, filename: filename.replace('.pdf', '') }),
  });
  if (!pdfResp.ok) {
    console.error('[WeChat] PDF生成失败:', pdfResp.status);
    return;
  }
  const pdfBuffer = await pdfResp.arrayBuffer();

  // 2. 上传到企业微信媒体接口（手动构建 multipart，避免 Worker FormData 处理 ArrayBuffer 异常）
  const boundary = '----WeBound' + Math.random().toString(36).slice(2, 10);
  const CRLF = '\r\n';
  const pdfBytes = new Uint8Array(pdfBuffer);
  const preamble = new TextEncoder().encode(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"${CRLF}` +
    `Content-Type: application/pdf${CRLF}${CRLF}`
  );
  const epilogue = new TextEncoder().encode(`${CRLF}--${boundary}--${CRLF}`);
  const multipart = new Uint8Array(preamble.length + pdfBytes.length + epilogue.length);
  multipart.set(preamble, 0);
  multipart.set(pdfBytes, preamble.length);
  multipart.set(epilogue, preamble.length + pdfBytes.length);

  const uploadResp = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${key}&type=file`,
    { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: multipart }
  );
  const uploadData = await uploadResp.json();
  if (!uploadResp.ok || uploadData.errcode !== 0) {
    console.error('[WeChat] 媒体上传失败:', uploadData.errcode, uploadData.errmsg);
    return;
  }

  // 3. 先发文字摘要，再发 PDF 文件
  const scoreLabel = v2Score?.level ? `${v2Score.level}级（${v2Score.score}分）` : '--';
  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      msgtype:  'markdown',
      markdown: {
        content: `## 新客户报告\n> **姓名**：${personName}\n> **评分**：${scoreLabel}\n> **渠道**：${agentLabel}\n> **时间**：${submitTime}`,
      },
    }),
  });
  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ msgtype: 'file', file: { media_id: uploadData.media_id } }),
  });
}

// ═══════════════════════════════════════════
// /api/v1/products — 产品库读写（KV存储，与admin.html共通）
// ═══════════════════════════════════════════
async function handleProductsGet(request, env) {
  const data = await env.CACHE.get('dzhun_products');
  if (data) {
    try { return jsonResp(JSON.parse(data), 200, request); } catch(e) {}
  }
  return jsonResp([], 200, request); // 空数组 → 前端自动 fallback 到 config.js
}

async function handleProductsPost(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ error: 'Invalid JSON' }, 400, request);
  }
  const { admin_key, products } = body || {};
  if (admin_key !== 'dazhun2024') return jsonResp({ error: 'Unauthorized' }, 401, request);
  if (!Array.isArray(products)) return jsonResp({ error: 'products must be array' }, 400, request);
  await env.CACHE.put('dzhun_products', JSON.stringify(products));
  return jsonResp({ ok: true, count: products.length }, 200, request);
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

// ═══════════════════════════════════════════
// /agent/info — 查询代理商配额（页面加载时调用）
// ═══════════════════════════════════════════
async function handleAgentInfo(request, env) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get('agent');
  if (!agentId) return jsonResp({ error: '缺少 agent 参数' }, 400, request);
  const raw = await env.ORDERS.get(`agent:${agentId}`);
  if (!raw) return jsonResp({ error: '代理商不存在' }, 404, request);
  const d = JSON.parse(raw);
  return jsonResp({ name: d.name, quota: d.quota, used: d.used, remaining: d.quota - d.used }, 200, request);
}

// ═══════════════════════════════════════════
// /pdf — 生成 PDF 报告（付费用户或代理商）
// ═══════════════════════════════════════════
async function handlePdf(request, env) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }

  const { ocrData, v2Score, userInfo, pdfStats, agentId, payToken } = body;
  if (!ocrData) return jsonResp({ error: '缺少报告数据' }, 400, request);

  // 鉴权：付费 token 或代理商 agentId 二选一即可
  if (!payToken && !agentId) {
    return jsonResp({ error: '请先完成付费后再下载' }, 402, request);
  }
  if (agentId) {
    const raw = await env.ORDERS.get(`agent:${agentId}`);
    if (!raw) return jsonResp({ error: '代理商账号不存在' }, 403, request);
  }
  if (payToken) {
    const tokenData = await env.ORDERS.get(`pay:${payToken}`);
    if (!tokenData) return jsonResp({ error: '付费凭证无效或已过期' }, 402, request);
  }

  const secret = env.PDF_SERVICE_SECRET;
  if (!secret) return jsonResp({ error: 'PDF服务未配置' }, 500, request);

  const name     = ocrData.person_name || '用户';
  const rDate    = (ocrData.report_date || '').replace(/-/g, '');
  const filename = `贷准报告_${name}_${rDate}`;
  const html     = buildPdfHtml(ocrData, v2Score, userInfo, pdfStats);

  try {
    const resp = await fetch('https://dzhun.com.cn/pdf-render', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-pdf-secret': secret },
      body:    JSON.stringify({ html, filename }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[PDF] service error:', resp.status, err);
      return jsonResp({ error: 'PDF生成失败，请稍后重试' }, 500, request);
    }
    const pdf = await resp.arrayBuffer();
    return new Response(pdf, {
      status:  200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.pdf`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[PDF] fetch error:', e.message);
    return jsonResp({ error: 'PDF服务连接失败，请稍后重试' }, 500, request);
  }
}

// ── buildPdfHtml：将报告数据渲染为可供 Puppeteer 使用的 HTML ──
function buildPdfHtml(data, v2, userInfo, pdfStats) {
  const name    = data.person_name || '--';
  const idNo    = (data.id_number  || '').replace(/^(.{6}).+(.{4})$/, '$1········$2');
  const rDate   = data.report_date || '--';
  const score   = v2?.score  ?? '--';
  const level   = v2?.level  ?? '--';
  const genTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const fmtNum  = n => (n == null ? '--' : Number(n).toLocaleString());

  // ── 查询次数统计 ──
  const APPLY_TYPES = new Set(['贷款审批','信用卡审批','担保资格审查','资信审查','保前审查','融资租赁审批']);
  const refMs = rDate !== '--' ? new Date(rDate).getTime() : Date.now();
  const monthsAgo = (m) => { const d = new Date(refMs); d.setMonth(d.getMonth() - m); return d; };
  const qRecs = (data.query_records || []).filter(q => q.date && APPLY_TYPES.has(q.type));
  const q1m  = qRecs.filter(q => new Date(q.date) >= monthsAgo(1)).length;
  const q3m  = qRecs.filter(q => new Date(q.date) >= monthsAgo(3)).length;
  const q6m  = qRecs.filter(q => new Date(q.date) >= monthsAgo(6)).length;
  const q12m = qRecs.filter(q => new Date(q.date) >= monthsAgo(12)).length;

  // ── 近半年查询明细 ──
  const qRows = qRecs
    .filter(q => (refMs - new Date(q.date).getTime()) / 86400000 <= 183)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(q => `<tr><td>${q.institution || '--'}</td><td>${q.type}</td><td>${q.date}</td></tr>`)
    .join('') || '<tr><td colspan="3" style="color:#999;text-align:center">无近半年申请类查询记录</td></tr>';

  // ── 贷款明细（未结清在前，结清灰色在后）──
  const allLoans = data.loans || [];
  const isSettled = l => l.status === '结清' || l.status === '已结清';
  const activeLoans  = allLoans.filter(l => !isSettled(l));
  const settledLoans = allLoans.filter(l =>  isSettled(l));
  const catLabel = l => {
    const cm = { mortgage:'房贷', car:'车贷', credit:'银行信用贷', finance:'消费金融' };
    if (l.type === 'online') return l.online_subtype === 'microloan' ? '小额贷款' : l.online_subtype === 'online_bank' ? '助贷银行' : '消费金融';
    return cm[l.loan_category] || '银行贷款';
  };
  const loanRows = [...activeLoans, ...settledLoans].map(l => {
    const grey    = isSettled(l) ? 'color:#aaa' : '';
    const monthly = l.estMonthly > 0 ? fmtNum(Math.round(l.estMonthly)) + '元' : '--';
    return `<tr style="${grey}">
      <td>${l.name || '--'}${l.is_revolving ? ' <span style="font-size:10px;color:#0cb87a">[循环]</span>' : ''}</td>
      <td>${catLabel(l)}</td>
      <td style="text-align:right">${l.credit_limit ? fmtNum(l.credit_limit) + '元' : '--'}</td>
      <td style="text-align:right">${l.balance != null ? fmtNum(l.balance) + '元' : '--'}</td>
      <td style="text-align:right">${monthly}<span style="font-size:9px;color:#aaa"> 估</span></td>
      <td style="text-align:center">${l.issued_date || '--'}</td>
      <td style="text-align:center">${l.due_date || (l.is_revolving ? '循环' : '--')}</td>
      <td>${l.status || '--'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="color:#999;text-align:center">无贷款记录</td></tr>';

  // ── 信用卡明细 ──
  const cards = data.cards || [];
  const activeCards = cards.filter(c => c.status !== '销户' && c.status !== '已销户');
  const cardRows = cards.map(c => {
    const util    = c.limit > 0 ? Math.round((c.used || 0) / c.limit * 100) : null;
    const settled = c.status === '销户' || c.status === '已销户';
    return `<tr style="${settled ? 'color:#aaa' : ''}">
      <td>${c.name || '--'}</td>
      <td style="text-align:right">${c.limit ? fmtNum(c.limit) + '元' : '--'}</td>
      <td style="text-align:right">${c.used != null ? fmtNum(c.used) + '元' : '--'}</td>
      <td style="text-align:right">${util != null ? util + '%' : '--'}</td>
      <td>${c.status || '--'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="color:#999;text-align:center">无信用卡记录</td></tr>';

  // ── 各维度评分（key: credit/stability/asset/fraud）──
  let domainHtml = '';
  if (v2?.domainScores) {
    const d = v2.domainScores;
    const domains = [
      { name: '信用行为', key: 'credit',    weight: '40%' },
      { name: '稳定性',   key: 'stability', weight: '30%' },
      { name: '资产偿债', key: 'asset',     weight: '25%' },
      { name: '反欺诈',   key: 'fraud',     weight: '5%'  },
    ];
    domainHtml = `
<div class="section">
  <div class="section-title">各维度评分</div>
  <table><thead><tr><th>维度</th><th>权重</th><th>得分（满分100）</th></tr></thead>
  <tbody>${domains.map(dm => {
    const val = d[dm.key];
    const score = val != null ? Math.round(val) : null;
    const color = score == null ? '' : score >= 70 ? 'color:#22a55e' : score >= 45 ? 'color:#e6963a' : 'color:#e05a5a';
    return `<tr><td>${dm.name}</td><td style="color:#888">${dm.weight}</td><td style="font-weight:600;${color}">${score != null ? score : '--'}</td></tr>`;
  }).join('')}</tbody></table>
</div>`;
  }

  // ── 负债概览汇总 ──
  let summaryHtml = '';
  if (pdfStats) {
    const st = pdfStats;
    const drColor = st.debtRatio == null ? '' : st.debtRatio <= 40 ? 'color:#22a55e' : st.debtRatio <= 60 ? 'color:#e6963a' : 'color:#e05a5a';
    const onlineColor = st.onlineInstCount >= 5 ? 'color:#e05a5a' : st.onlineInstCount >= 3 ? 'color:#e6963a' : 'color:#22a55e';
    summaryHtml = `
<div class="section">
  <div class="section-title">负债概览</div>
  <div class="stat-grid">
    <div class="stat-item"><div class="stat-val">${st.totalDebt > 0 ? fmtNum(Math.round(st.totalDebt)) + '元' : '--'}</div><div class="stat-lbl">当前总负债</div></div>
    <div class="stat-item"><div class="stat-val">${st.totalMonthly > 0 ? fmtNum(Math.round(st.totalMonthly)) + '元' : '--'}</div><div class="stat-lbl">月还款估算</div></div>
    <div class="stat-item"><div class="stat-val" style="${drColor}">${st.debtRatio != null ? st.debtRatio + '%' : '--'}</div><div class="stat-lbl">月还款负债率</div></div>
    <div class="stat-item"><div class="stat-val">${st.activeLoansCount ?? '--'}</div><div class="stat-lbl">未结清贷款</div></div>
    <div class="stat-item"><div class="stat-val">${st.activeCardsCount ?? '--'}</div><div class="stat-lbl">未销户信用卡</div></div>
    <div class="stat-item"><div class="stat-val" style="${onlineColor}">${st.onlineInstCount ?? '--'}</div><div class="stat-lbl">网贷机构数</div></div>
    <div class="stat-item"><div class="stat-val">${st.age ? st.age + '岁' : '--'}</div><div class="stat-lbl">年龄</div></div>
  </div>
</div>`;
  }

  // ── 申请人补充信息 ──
  let userInfoHtml = '';
  if (userInfo && typeof userInfo === 'object') {
    const infoRows = [
      ['月收入',   userInfo.income     ? fmtNum(userInfo.income) + ' 元' : '未填写'],
      ['工作性质', userInfo.work       || '未填写'],
      ['社保情况', userInfo.social     || '未填写'],
      ['公积金月缴', userInfo.provident ? fmtNum(userInfo.provident) + ' 元/月' : '未填写'],
      ['学历',     userInfo.edu        || '未填写'],
      ['户籍',     userInfo.hukou      || '未填写'],
      ['固定支出', userInfo.fixed_expense ? fmtNum(userInfo.fixed_expense) + ' 元/月' : '未填写'],
      ['名下资产', userInfo.assets     || '未填写'],
    ];
    userInfoHtml = `
<div class="section">
  <div class="section-title">申请人补充信息</div>
  <table><tbody>
    ${infoRows.map(([k, v]) => `<tr><td style="color:#666;width:32%">${k}</td><td>${v}</td></tr>`).join('')}
  </tbody></table>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: "WenQuanYi Micro Hei","PingFang SC","Microsoft YaHei",sans-serif; color: #1a1a2e; margin: 0; padding: 24px 28px; font-size: 13px; }
  h1 { font-size: 20px; color: #1a1a2e; margin: 0 0 4px; }
  .sub { color: #666; font-size: 12px; margin-bottom: 20px; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 14px; font-weight: 600; color: #1a1a2e; border-left: 3px solid #4169e1; padding-left: 8px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f0f4ff; color: #444; font-weight: 500; padding: 6px 8px; text-align: left; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  .score-box { display: inline-block; background: #f0f4ff; border-radius: 8px; padding: 12px 24px; text-align: center; margin-bottom: 8px; }
  .score-num { font-size: 36px; font-weight: 700; color: #4169e1; }
  .score-lbl { font-size: 12px; color: #666; margin-top: 4px; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .stat-item { background: #f5f7ff; border-radius: 6px; padding: 10px; text-align: center; }
  .stat-val { font-size: 18px; font-weight: 700; color: #1a1a2e; }
  .stat-lbl { font-size: 11px; color: #888; margin-top: 3px; }
  .q-counts { display: flex; gap: 14px; margin-bottom: 10px; }
  .q-count-item { flex: 1; background: #f5f7ff; border-radius: 6px; padding: 10px; text-align: center; }
  .q-count-num { font-size: 22px; font-weight: 700; color: #4169e1; }
  .q-count-lbl { font-size: 11px; color: #666; margin-top: 2px; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #eee; color: #999; font-size: 11px; text-align: center; }
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

${summaryHtml}

${domainHtml}

${userInfoHtml}

<div class="section">
  <div class="section-title">征信查询次数统计（申请类）</div>
  <div class="q-counts">
    <div class="q-count-item"><div class="q-count-num">${q1m}</div><div class="q-count-lbl">近1个月</div></div>
    <div class="q-count-item"><div class="q-count-num">${q3m}</div><div class="q-count-lbl">近3个月</div></div>
    <div class="q-count-item"><div class="q-count-num">${q6m}</div><div class="q-count-lbl">近6个月</div></div>
    <div class="q-count-item"><div class="q-count-num">${q12m}</div><div class="q-count-lbl">近12个月</div></div>
  </div>
</div>

<div class="section">
  <div class="section-title">近半年查询记录明细</div>
  <table><thead><tr><th>查询机构</th><th>查询类型</th><th>查询日期</th></tr></thead>
  <tbody>${qRows}</tbody></table>
</div>

<div class="section">
  <div class="section-title">贷款明细（共 ${allLoans.length} 条 / 未结清 ${activeLoans.length} 条）</div>
  <table><thead><tr><th>机构</th><th>类型</th><th style="text-align:right">授信额度</th><th style="text-align:right">当前余额</th><th style="text-align:right">预估月还款</th><th style="text-align:center">发放日期</th><th style="text-align:center">到期日期</th><th>状态</th></tr></thead>
  <tbody>${loanRows}</tbody></table>
</div>

<div class="section">
  <div class="section-title">信用卡明细（共 ${cards.length} 张 / 未销户 ${activeCards.length} 张）</div>
  <table><thead><tr><th>发卡行</th><th style="text-align:right">授信额度</th><th style="text-align:right">已用额度</th><th style="text-align:right">使用率</th><th>状态</th></tr></thead>
  <tbody>${cardRows}</tbody></table>
</div>

<div class="footer">由 dzhun.com.cn 生成 · ${genTime} · 仅供参考，以银行实际审批为准</div>
</body>
</html>`;
}
