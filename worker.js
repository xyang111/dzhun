// ═══════════════════════════════════════════════════════════════
//  贷准 · Cloudflare Worker v2
//  新增：① OCR/分析 Prompt 内置  ② 产品库内置  ③ 缓存策略
//  保留：支付（微信/支付宝）、鉴权 token、邮件报告、Claude 代理
// ═══════════════════════════════════════════════════════════════

var REPORT_TO_EMAIL = "651047968@qq.com";
var REPORT_FROM     = "report@dzhun.com.cn";
var ALLOWED_ORIGINS = [
  "https://dzhun.com.cn",
  "https://www.dzhun.com.cn",
];
var PRODUCT_PRICE = 990;

// ═══════════════════════════════════════════
// ① 产品库（从前端迁移，对外不可见）
// ═══════════════════════════════════════════
const BANK_PRODUCTS = [
  {
    id: 'gsyh', bank: '工商银行', product: '融e借', emoji: '🏦',
    rate: '3.0%-4.35%', amount: '最高100万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 65, minIncome: 5000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 12, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '工行代发工资或公积金≥12月；无当前逾期；近3月查询≤6次；负债率≤65%',
    bonus: '国企/事业/央企/白名单单位通过率极高；公积金基数高额度更大',
    tags: ['国有大行', '利率低', '公积金加分'], type: 'bank',
  },
  {
    id: 'nyyh', bank: '农业银行', product: '网捷贷', emoji: '🌾',
    rate: '2.85%-4.5%', amount: '最高30万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 70, minIncome: 3000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '农行账户；社保或公积金在缴；无当前逾期；近3月查询≤6次',
    bonus: '公务员/国企优先；农行代发工资利率更低；有农行按揭额度翻倍',
    tags: ['国有大行', '公积金加分', '随借随还'], type: 'bank',
  },
  {
    id: 'zgyh', bank: '中国银行', product: '随心智贷', emoji: '🏛',
    rate: '3.1%-5.22%', amount: '最高50万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 60, minIncome: 6000,
    minAge: null, maxAge: null, overdue: 'zero', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期；近3月查询≤6次；负债率≤60%；月收入≥6000',
    bonus: '名下有全款房通过率+20%；中行按揭客户优先；公积金在缴利率更低',
    tags: ['国有大行', '有房加分', '利率低'], type: 'bank',
  },
  {
    id: 'jsyh', bank: '建设银行', product: '快贷', emoji: '🏗',
    rate: '2.85%-4.8%', amount: '最高100万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 70, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '建行账户；社保或公积金在缴；无当前逾期；近3月查询≤6次',
    bonus: '建行代发工资额度大幅提升；有房贷客户额度最高；龙卡信用卡加分',
    tags: ['国有大行', '额度高', '公积金加分'], type: 'bank',
  },
  {
    id: 'jtyh', bank: '交通银行', product: '惠民贷', emoji: '🚗',
    rate: '2.8%-5.88%', amount: '最高100万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 70, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '社保或公积金≥6月；无当前逾期；近3月查询≤6次',
    bonus: '个体工商户专属通道；社保年限越长额度越高；厦门本地公积金优先',
    tags: ['个体工商户可做', '社保加分', '额度高'], type: 'bank',
  },
  {
    id: 'yzyh', bank: '邮储银行', product: '邮享贷', emoji: '📮',
    rate: '3.0%-7.2%', amount: '最高100万',
    maxQ1: null, maxQ3: 8, maxQ6: null, maxDebt: 75, minIncome: 2000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 3, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '社保≥3月；无当前逾期；近3月查询≤8次',
    bonus: '门槛最低首选；国企/事业单位公积金客户专属优惠利率',
    tags: ['门槛最低', '社保3月', '稳妥保底'], type: 'bank',
  },
  {
    id: 'zsyh', bank: '招商银行', product: '闪电贷', emoji: '💳',
    rate: '2.68%-18%', amount: '最高50万',
    maxQ1: 2, maxQ3: 4, maxQ6: null, maxDebt: 65, minIncome: 5000,
    minAge: null, maxAge: null, overdue: 'zero', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期；近1月查询≤2次；近3月查询≤4次；负债率≤65%',
    bonus: '招行代发/AUM≥2万利率更低；公积金高基数显著提额',
    tags: ['秒级审批', '全线上', '利率低'], type: 'bank',
  },
  {
    id: 'pfyh', bank: '浦发银行', product: '浦闪贷', emoji: '🌟',
    rate: '2.9%-6%', amount: '最高100万',
    maxQ1: null, maxQ3: 4, maxQ6: null, maxDebt: 65, minIncome: 8000,
    minAge: null, maxAge: null, overdue: 'zero', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期；近3月查询≤4次；负债率≤65%；月收入≥8000',
    bonus: '国企/央企员工通过率最高；公积金高基数显著提额',
    tags: ['高收入优先', '国企专属', '审批快'], type: 'bank',
  },
  {
    id: 'xyyh', bank: '兴业银行', product: '兴闪贷', emoji: '💰',
    rate: '3.0%-7.2%', amount: '最高100万',
    maxQ1: null, maxQ3: 5, maxQ6: 8, maxDebt: 70, minIncome: 3000,
    minAge: null, maxAge: null, overdue: 'mild', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期（历史≤30天已结清可接受）；近3月查询≤5次；近6月查询≤8次',
    bonus: '征信轻微瑕疵首选；线下版条件更宽松；兴业代发/按揭客户优先',
    tags: ['征信瑕疵可接受', '查询宽松', '线下可谈'], type: 'bank',
  },
  {
    id: 'payh', bank: '平安银行', product: '白领贷', emoji: '🛡',
    rate: '3.0%-7.99%', amount: '最高100万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 70, minIncome: 5000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: null, minProvident: 800, minEdu: 'none', workTypes: null,
    conditions: '公积金≥1年；无当前逾期；近3月查询≤6次',
    bonus: '个体工商户友好；平安保险/证券客户额度更高；白名单单位直接通过',
    tags: ['个体工商户可做', '公积金加分', '随借随还'], type: 'bank',
  },
  {
    id: 'zxyh', bank: '中信银行', product: '信秒贷', emoji: '🏢',
    rate: '3.28%-16.68%', amount: '最高50万',
    maxQ1: null, maxQ3: 6, maxQ6: 10, maxDebt: 70, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'mild', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期（历史单次≤30天可接受）；近3月查询≤6次；近6月查询≤10次；满足之一：中信代发/AUM/信用卡/按揭/公积金≥2年',
    bonus: '条件多选一通过率高；有按揭房直接符合；优质单位门槛更低',
    tags: ['条件多选一', '征信轻微瑕疵可做', '审批快'], type: 'bank',
  },
  {
    id: 'gdyh', bank: '光大银行', product: '光速贷', emoji: '☀️',
    rate: '2.9%-6%', amount: '最高30万',
    maxQ1: null, maxQ3: 5, maxQ6: null, maxDebt: 70, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '社保或公积金；无当前逾期；近3月查询≤5次；负债率≤70%',
    bonus: '光大信用卡持有者加分；负债稍高也可接受',
    tags: ['负债宽松', '社保加分', '利率低'], type: 'bank',
  },
  {
    id: 'hxyh', bank: '华夏银行', product: '易达金', emoji: '🌈',
    rate: '3.28%-6%', amount: '最高50万',
    maxQ1: null, maxQ3: 8, maxQ6: null, maxDebt: 75, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'zero', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期；近3月查询≤8次；负债率≤75%',
    bonus: '私企员工友好；查询偏多时的次优选择；负债稍高也可尝试',
    tags: ['私企友好', '查询宽松', '负债宽松'], type: 'bank',
  },
  {
    id: 'xmyh', bank: '厦门银行', product: 'E秒贷', emoji: '🏝',
    rate: '5.38%-7.2%', amount: '最高60万',
    maxQ1: null, maxQ3: 6, maxQ6: null, maxDebt: 65, minIncome: 4000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '无当前逾期；近1周查询≤3次；近3月查询≤6次；未结清贷款≤5家；社保或公积金≥6月',
    bonus: '厦门本地银行优先；公积金优质单位可拉白名单提额至60万',
    tags: ['厦门本地', '公积金优先', '额度高'], type: 'bank',
  },
  {
    id: 'xmns', bank: '厦门农商银行', product: '信用消费贷', emoji: '🌺',
    rate: '4.0%-6.5%', amount: '最高50万',
    maxQ1: null, maxQ3: 4, maxQ6: 6, maxDebt: 70, minIncome: 3000,
    minAge: null, maxAge: null, overdue: 'zero', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '厦门本地居民；无当前逾期；近3月查询≤4次；近6月查询≤6次；社保或公积金在缴',
    bonus: '公积金优质单位额度利率最优；线下沟通空间大；本地居民首选',
    tags: ['厦门本地', '公积金首选', '线下可谈'], type: 'bank',
  },
  {
    id: 'nbyh', bank: '南银法巴银行', product: '诚易贷', emoji: '🏦',
    rate: '7.2%-18.8%', amount: '最高30万（夫妻各自申请）',
    maxQ1: 5, maxQ3: 9, maxQ6: 15, maxDebt: null, minIncome: null,
    minAge: 22, maxAge: 56, overdue: 'mild', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '年龄22-56周岁；本地户籍：个税/公积金/社保≥6个月；外地户籍：≥12个月；近1月查询≤5次，近3月≤9次，半年≤15次；当前不能逾期，历史总逾期次数≤12次，历史无M2',
    bonus: '硕士/博士利率7.2%-9%最低；本科+公积金月缴≥2千利率9%-12%；查询要求最宽松',
    tags: ['查询宽松', '外地户籍可做', '学历利率优惠'], type: 'bank',
  },
  {
    id: 'zljr', bank: '招联消费金融', product: '好期贷', emoji: '📱',
    rate: '7.2%-24%', amount: '最高20万',
    maxQ1: null, maxQ3: 99, maxQ6: null, maxDebt: 85, minIncome: 2000,
    minAge: null, maxAge: null, overdue: 'mild', social: false,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '有稳定收入；历史逾期已还清可申请；查询次数基本不影响',
    bonus: '银行全拒后保底首选；秒批到账；持牌消费金融机构',
    tags: ['持牌机构', '查询不限', '保底首选'], type: 'finance',
  },
  {
    id: 'hxxd', bank: '海翔小贷', product: '信用贷', emoji: '🦅',
    rate: '利率面议', amount: '10-100万',
    maxQ1: null, maxQ3: 99, maxQ6: null, maxDebt: 80, minIncome: null,
    minAge: 22, maxAge: 55, overdue: 'zero', social: true,
    minSocialMonths: null, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '上班族；省内户籍或厦门房产；年龄22-55；无当前逾期；2年内展期/公积金提取不准入',
    bonus: '优质单位/高公积金/可双签均可提额；10-30万可最高40%先息',
    tags: ['本地小贷', '厦门户籍优先', '大额可做'], type: 'finance',
  },
  {
    id: 'zyxf', bank: '中邮消费金融', product: '消费贷', emoji: '📬',
    rate: '18%-23.76%', amount: '最高20万',
    maxQ1: 3, maxQ3: 9, maxQ6: null, maxDebt: null, minIncome: null,
    minAge: 20, maxAge: 55, overdue: 'mild', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '年龄20-55；本单位满6个月；负债三选一：公积金/社保/个税基数×50倍≥信贷余额；近3月信贷查询≤9次',
    bonus: '负债要求三选一非常灵活；公积金/社保/个税任一满足即可',
    tags: ['负债要求灵活', '查询宽松', '持牌消费金融'], type: 'finance',
  },
  {
    id: 'zbyh', bank: '中银消费金融', product: '消费贷', emoji: '🏛',
    rate: '14.98%-22.98%', amount: '最高20万',
    maxQ1: null, maxQ3: 7, maxQ6: null, maxDebt: null, minIncome: null,
    minAge: 20, maxAge: 55, overdue: 'mild', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'college', workTypes: null,
    conditions: '年龄20-55；上班族；大专及以上学历；3个月机构查询≤7次；无当前逾期；至少有一笔正常还款6个月以上',
    bonus: '社保基数5000+大专学历利率最低14.98%；夫妻可各自申请合计40万',
    tags: ['双系统', '社保基数关键', '大专可做'], type: 'finance',
  },
  {
    id: 'xyjr', bank: '兴业消费金融', product: '消费贷', emoji: '💼',
    rate: '8.88%-16.8%', amount: '5-20万（夫妻40万）',
    maxQ1: null, maxQ3: 10, maxQ6: null, maxDebt: null, minIncome: 5000,
    minAge: 22, maxAge: 60, overdue: 'mild', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '年龄22-60；社保6个月以上，月工资5000以上；近3月查询≤10次；无当前逾期；不接受白户',
    bonus: 'A1类irr年化8.88%最低；研究生学历直接最优利率；全款房客户20%认定额度',
    tags: ['学历利率优惠', '厦门社保6月', '全款房加分'], type: 'finance',
  },
  {
    id: 'lyh', bank: '陆易花', product: '薪产品', emoji: '🌸',
    rate: '利率面议', amount: '2-20万循环额度',
    maxQ1: 4, maxQ3: 9, maxQ6: null, maxDebt: 100, minIncome: null,
    minAge: 22, maxAge: 55, overdue: 'loose', social: true,
    minSocialMonths: 6, minProvident: null, minEdu: 'none', workTypes: null,
    conditions: '年龄22-55；上班族（不含企业法人/股东/个体）；企业缴社保≥6个月；无当前逾期200元以下可申请；近3月查询<9次',
    bonus: '循环额度最灵活；支持12/24/36期；换单位只需保证连续缴纳即可',
    tags: ['循环额度', '上班族专属', '线上操作'], type: 'finance',
  },
];

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
    candidateSummary, rejectedSummary, clientType,
    loanDesc, cardDesc, debtRatio, cardUtil,
    q, onlineInstTotal, cfCount, mlCount, obCount,
    totalMonthly, scoreItems, socialStr, income, pvd,
    hukouVal, assetsVal, workVal, eduVal,
  } = payload;

  const clientTypeLabel = clientType === 'A' ? 'A类（优质客户）'
    : clientType === 'B' ? 'B类（可优化客户）' : 'C类（需养征信客户）';

  const q3 = (q.loan_3m || 0) + (q.loan_3m_card || 0);
  const q6 = q.loan_6m_total || 0;

  return `你是银行信贷经理，帮真实客户分析贷款资质。说话风格：口语化，数字精确（不说"偏高"，说"高了2次"）。禁止出现"建议直接去银行柜台申请"或"自行前往XX银行"等绕过客服的表述。

【客户类型：${clientTypeLabel}】
${clientType === 'A' ? `A类：说明最高额度/最低利率区间；指出白名单通道存在（若适用），但强调"通道对接和利率谈判需要人工介入，系统只能给方向"；申请顺序给1-2步框架，不给完整执行步骤。` : ''}${clientType === 'B' ? `B类：说明2-3个核心问题及各自大致修复时间；指出优化后可申请的产品方向和额度区间；强调"具体操作顺序和时机判断需要客服给执行计划，顺序错了多等3个月"。` : ''}${clientType === 'C' ? `C类：说明恢复方向和大致月数；指出恢复期内存在哪类过渡空间（不展开，留给客服）；强调"恢复期有方案可用，但避坑清单和过渡产品需要客服评估后给出"。` : ''}

═══════════════════════════════════
【客户补充信息】
═══════════════════════════════════
① 学历：${eduVal || '无'}
② 月工资：${income > 0 ? income + ' 元' : '未填写'}
③ 社保缴交：${socialStr}
④ 公积金月缴：${pvd > 0 ? pvd + ' 元' : '0（未缴）'}
⑤ 资产情况：${assetsVal || '无'}
⑥ 户籍地：${hukouVal || '未填写'}
⑦ 单位性质：${workVal || '未填写'}

【补充信息加减分】
${(scoreItems || []).join('\n')}

═══════════════════════════════════
【征信核心数据】
═══════════════════════════════════
未结清贷款：${creditData.loanCount}笔（银行${creditData.bankCount}笔 | 网贷${creditData.onlineCount}笔）
网贷机构数：${onlineInstTotal}家（消金${cfCount}家+小贷${mlCount}家+助贷银行${obCount}家）→ 红线≤4家
未销户信用卡：${creditData.cardCount}张
月还款估算：${totalMonthly}元
负债率：${debtRatio}
信用卡使用率：${cardUtil}%
当前逾期：${creditData.overdueCurrent || 0}笔
历史逾期：${creditData.overdueHistoryNotes || '无'}

【查询记录】
近1月贷款审批：${q.loan_1m || 0}次 | 近3月贷款：${q.loan_3m || 0}次 | 近3月信用卡：${q.loan_3m_card || 0}次
近3月合计：${q3}次 | 近6月合计：${q6}次

【贷款明细】
${loanDesc}

【信用卡明细】
${cardDesc}

【本地规则引擎已完成产品匹配】
以下是前端规则引擎的匹配结果（100%准确，基于硬性准入规则）：
${candidateSummary}

排除原因摘要：${rejectedSummary}

你不需要再做产品筛选和通过率计算，只需要：
① 解读分析：为什么是这个结果，客户最关键的问题是什么
② 优化建议：具体怎么改善，多久能改善，改善后能申请什么
③ 个性化语言：用口语化方式解释，带具体数字

【引导规则——所有客户类型强制执行】
report末尾必须包含 wechat_cta 字段，内容根据客户类型定制：
- A类：强调白名单通道/利率谈判/提额是需要人工对接的，系统只能给方向
- B类：强调优化执行顺序是关键，顺序错了多等数月，客服给具体计划
- C类：强调恢复期过渡方案和避坑，现在加微信不是为了借款是为了不走错路

严格返回JSON，不含任何其他文字和markdown：
{
  "summary": "1-2句口语化总评，60字内",
  "key_risk": "最大风险点25字内，无则空字符串",
  "risk_level": "健康|轻微瑕疵|中度风险|高风险（高风险=逾期>0或查询>12或网贷≥5或负债>80%；中度=查询7-12或网贷3-4或负债60-80%；轻微瑕疵=查询4-6或网贷1-2；否则健康）",
  "current_rate": 65,
  "optimized_rate": 85,
  "problems": [
    {"name": "查询次数过多", "value": "近3月5次", "threshold": "银行安全区≤3次", "severity": "high"}
  ],
  "rejected_products": [
    {"type": "国有大行信用贷", "reason": "近3月查询X次超大行≤6次红线"}
  ],
  "optimization": [
    {"step": "结清X家小贷并注销", "goal": "网贷机构降至2家以内", "time": "1个月", "unlock": "达标后可申请股份制银行"}
  ],
  "post_optimization": "优化完成后，可申请招行/浦发/中信等股份制银行信用贷，预计额度XX万",
  "advice": {
    "strengths": [{"point": "无逾期+厦门户籍", "impact": "银行判定还款意愿强"}],
    "issues": [{"point": "社保仅缴3个月", "impact": "银行判定工作稳定性不足"}],
    "suggestions": [{"action": "持续缴纳社保至12个月", "goal": "满足股份制银行门槛", "time": "9个月", "effect": "可申请招行/浦发最高20万信用贷"}]
  },
  "wechat_cta": {
    "hook": "25字内，带具体利益点，根据客户类型定制（A类强调利率/通道，B类强调执行顺序，C类强调过渡方案）",
    "action": "加客服微信获取专属方案",
    "urgency": "可选时效说明，无则空字符串"
  }
}
注意：不要输出products字段；problems列2-4个必须带具体数字；optimization列1-3个步骤，step字段必填不得为空；wechat_cta.hook必须输出，不得为空`;
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
        max_tokens: 4000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [...fileBlocks, { type: 'text', text: PROMPT_OCR }],
        }],
      }),
    });

    const data = await resp.json();
    if (data.error) return jsonResp({ error: data.error.message }, 502, request);

    const raw = (data.content || []).map(b => b.text || '').join('');

    // 写入缓存（24小时）
    if (cacheKey && env.CACHE) {
      await env.CACHE.put(`ocr:${cacheKey}`, raw, { expirationTtl: 7200 }); // 2h，最小化PII留存
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

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResp({ error: 'API key not configured' }, 500, request);

  const prompt = buildMatchPrompt(body.payload || {});

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
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) return jsonResp({ error: data.error }, resp.status, request);
    return jsonResp(data, resp.status, request);

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
