// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const PROXY_URL     = 'https://api.dzhun.com.cn';
const CONTACT_PHONE = '18250760433';  // 默认联系电话（直客）
const DEFAULT_QR    = '/qr.jpg';  // 默认二维码图片路径（直客）

// ── 代理商配置表（新增代理商只需在这里添加）──
// agent_id 对应 URL 参数 ?agent=xxx
// qr: 代理商微信二维码图片URL（建议上传到CDN或同目录）
// notify: 企业微信群机器人 Webhook（没有可留空 ''）
const AGENTS = {
  'XY001': {
    name:   '夏阳',
    phone:  '18359711859',
    qr: '/qr_agent_1.jpg',
    notify: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=eeac39a4-e6f8-487d-8a3c-92f6421829b2'
  },
  // 新增代理商在这里继续添加：
  // 'XX002': {
  //   name:   '代理商名称',
  //   phone:  '手机号',
  //   qr:     '二维码图片URL或base64',
  //   notify: '企业微信群webhook地址'
  // },
};

// 当前会话的代理商信息（页面加载时自动读取URL参数）
let _currentAgent = null;

// HTML 转义工具（防止 AI 返回内容中含恶意标签）
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── 全局工具：职业类型映射（唯一数据源）──
const WORK_TYPE_MAP = {
  '政府机关/公务员':'gov','事业单位':'institution','国有企业/央企':'state',
  '上市公司/500强':'listed','私营企业':'private','个体工商户':'self','自由职业':'freelance'
};

// ── 全局工具：过滤未结清贷款/信用卡 ──
function getActiveLoans(data) {
  return (data?.loans||[]).filter(l=>l.status!=='结清'&&l.status!=='已结清');
}
function getActiveCards(data) {
  return (data?.cards||[]).filter(c=>c.status!=='销户'&&c.status!=='已销户');
}

// ═══════════════════════════════════════════
// 产品库（唯一数据源，新增/修改产品只改这里）
// ═══════════════════════════════════════════
// 字段说明：
//   id          唯一标识
//   bank        银行/机构名
//   product     产品名
//   emoji       图标
//   rate        利率范围（显示用）
//   amount      最高额度（显示用）
//   maxQ3       近3月查询上限（硬性红线，超过直接排除）
//   maxQ1       近1月查询上限（null=不限）
//   maxQ6       近6月查询上限（null=不限）
//   maxDebt     负债率上限 % （null=不限）
//   minAge      最低年龄（null=不限）
//   maxAge      最高年龄（null=不限）
//   minIncome   最低月收入 元 （null=不限）
//   overdue     'strict'=历史零逾期 | 'zero'=历史轻微可 | 'mild'=近6月无逾期可 | 'loose'=当前无逾期即可
//   social      true=需要社保/公积金 | false=不要求
//   conditions  准入条件描述（注入AI prompt用）
//   bonus       加分项描述
//   tags        产品标签（显示用）
//   type        'bank'=银行 | 'finance'=消费金融
const BANK_PRODUCTS = [
  { id:'gsyh', bank:'工商银行', product:'融e借', hurdle:710, k:0.025, emoji:'🏦', rate:'3.0%-4.35%', amount:'最高100万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:65, minIncome:5000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:12, minProvident:null, minEdu:'none', workTypes:null, conditions:'工行代发工资或公积金≥12月；无当前逾期；近3月查询≤6次；负债率≤65%', bonus:'国企/事业/央企/白名单单位通过率极高；公积金基数高额度更大', tags:['国有大行','利率低','公积金加分'], type:'bank' },
  { id:'nyyh', bank:'农业银行', product:'网捷贷', hurdle:700, k:0.025, emoji:'🌾', rate:'2.85%-4.5%', amount:'最高30万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:70, minIncome:3000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'农行账户；社保或公积金在缴；无当前逾期；近3月查询≤6次', bonus:'公务员/国企优先；农行代发工资利率更低；有农行按揭额度翻倍', tags:['国有大行','公积金加分','随借随还'], type:'bank' },
  { id:'zgyh', bank:'中国银行', product:'随心智贷', hurdle:720, k:0.025, emoji:'🏛', rate:'3.1%-5.22%', amount:'最高50万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:60, minIncome:6000, minAge:null, maxAge:null, overdue:'zero', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期；近3月查询≤6次；负债率≤60%；月收入≥6000', bonus:'名下有全款房通过率+20%；中行按揭客户优先；公积金在缴利率更低', tags:['国有大行','有房加分','利率低'], type:'bank' },
  { id:'jsyh', bank:'建设银行', product:'快贷', hurdle:700, k:0.025, emoji:'🏗', rate:'2.85%-4.8%', amount:'最高100万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:70, minIncome:4000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'建行账户；社保或公积金在缴；无当前逾期；近3月查询≤6次', bonus:'建行代发工资额度大幅提升；有房贷客户额度最高；龙卡信用卡加分', tags:['国有大行','额度高','公积金加分'], type:'bank' },
  { id:'jtyh', bank:'交通银行', product:'惠民贷', hurdle:690, k:0.025, emoji:'🚗', rate:'2.8%-5.88%', amount:'最高100万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:70, minIncome:4000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'社保或公积金≥6月；无当前逾期；近3月查询≤6次', bonus:'个体工商户专属通道；社保年限越长额度越高；厦门本地公积金优先', tags:['个体工商户可做','社保加分','额度高'], type:'bank' },
  { id:'yzyh', bank:'邮储银行', product:'邮享贷', hurdle:620, k:0.025, emoji:'📮', rate:'3.0%-7.2%', amount:'最高100万', maxQ1:null, maxQ3:8, maxQ6:null, maxDebt:75, minIncome:2000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:3, minProvident:null, minEdu:'none', workTypes:null, conditions:'社保≥3月；无当前逾期；近3月查询≤8次', bonus:'门槛最低首选；国企/事业单位公积金客户专属优惠利率', tags:['门槛最低','社保3月','稳妥保底'], type:'bank' },
  { id:'zsyh', bank:'招商银行', product:'闪电贷', hurdle:730, k:0.025, emoji:'💳', rate:'2.68%-18%', amount:'最高50万', maxQ1:2, maxQ3:4, maxQ6:null, maxDebt:65, minIncome:5000, minAge:null, maxAge:null, overdue:'zero', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期；近1月查询≤2次；近3月查询≤4次；负债率≤65%', bonus:'招行代发/AUM≥2万利率更低；公积金高基数显著提额', tags:['秒级审批','全线上','利率低'], type:'bank' },
  { id:'pfyh', bank:'浦发银行', product:'浦闪贷', hurdle:700, k:0.025, emoji:'🌟', rate:'2.9%-6%', amount:'最高100万', maxQ1:null, maxQ3:4, maxQ6:null, maxDebt:65, minIncome:8000, minAge:null, maxAge:null, overdue:'zero', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期；近3月查询≤4次；负债率≤65%；月收入≥8000', bonus:'国企/央企员工通过率最高；公积金高基数显著提额', tags:['高收入优先','国企专属','审批快'], type:'bank' },
  { id:'xyyh', bank:'兴业银行', product:'兴闪贷', hurdle:650, k:0.025, emoji:'💰', rate:'3.0%-7.2%', amount:'最高100万', maxQ1:null, maxQ3:5, maxQ6:8, maxDebt:70, minIncome:3000, minAge:null, maxAge:null, overdue:'mild', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期（历史≤30天已结清可接受）；近3月查询≤5次；近6月查询≤8次', bonus:'征信轻微瑕疵首选；线下版条件更宽松；兴业代发/按揭客户优先', tags:['征信瑕疵可接受','查询宽松','线下可谈'], type:'bank' },
  { id:'payh', bank:'平安银行', product:'白领贷', hurdle:660, k:0.025, emoji:'🛡', rate:'3.0%-7.99%', amount:'最高100万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:70, minIncome:5000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:null, minProvident:800, minEdu:'none', workTypes:null, conditions:'公积金≥1年；无当前逾期；近3月查询≤6次', bonus:'个体工商户友好；平安保险/证券客户额度更高；白名单单位直接通过', tags:['个体工商户可做','公积金加分','随借随还'], type:'bank' },
  { id:'zxyh', bank:'中信银行', product:'信秒贷', hurdle:640, k:0.025, emoji:'🏢', rate:'3.28%-16.68%', amount:'最高50万', maxQ1:null, maxQ3:6, maxQ6:10, maxDebt:70, minIncome:4000, minAge:null, maxAge:null, overdue:'mild', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期（历史单次≤30天可接受）；近3月查询≤6次；近6月查询≤10次；满足之一：中信代发/AUM/信用卡/按揭/公积金≥2年', bonus:'条件多选一通过率高；有按揭房直接符合；优质单位门槛更低', tags:['条件多选一','征信轻微瑕疵可做','审批快'], type:'bank' },
  { id:'gdyh', bank:'光大银行', product:'光速贷', hurdle:660, k:0.025, emoji:'☀️', rate:'2.9%-6%', amount:'最高30万', maxQ1:null, maxQ3:5, maxQ6:null, maxDebt:70, minIncome:4000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'社保或公积金；无当前逾期；近3月查询≤5次；负债率≤70%', bonus:'光大信用卡持有者加分；负债稍高也可接受', tags:['负债宽松','社保加分','利率低'], type:'bank' },
  { id:'hxyh', bank:'华夏银行', product:'易达金', hurdle:620, k:0.025, emoji:'🌈', rate:'3.28%-6%', amount:'最高50万', maxQ1:null, maxQ3:8, maxQ6:null, maxDebt:75, minIncome:4000, minAge:null, maxAge:null, overdue:'zero', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期；近3月查询≤8次；负债率≤75%', bonus:'私企员工友好；查询偏多时的次优选择；负债稍高也可尝试', tags:['私企友好','查询宽松','负债宽松'], type:'bank' },
  { id:'xmyh', bank:'厦门银行', product:'E秒贷', hurdle:640, k:0.025, emoji:'🏝', rate:'5.38%-7.2%', amount:'最高60万', maxQ1:null, maxQ3:6, maxQ6:null, maxDebt:65, minIncome:4000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'无当前逾期；近1周查询≤3次；近3月查询≤6次；未结清贷款≤5家；社保或公积金≥6月', bonus:'厦门本地银行优先；公积金优质单位可拉白名单提额至60万', tags:['厦门本地','公积金优先','额度高'], type:'bank' },
  { id:'xmns', bank:'厦门农商银行', product:'信用消费贷', hurdle:650, k:0.025, emoji:'🌺', rate:'4.0%-6.5%', amount:'最高50万', maxQ1:null, maxQ3:4, maxQ6:6, maxDebt:70, minIncome:3000, minAge:null, maxAge:null, overdue:'zero', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'厦门本地居民；无当前逾期；近3月查询≤4次；近6月查询≤6次；社保或公积金在缴', bonus:'公积金优质单位额度利率最优；线下沟通空间大；本地居民首选', tags:['厦门本地','公积金首选','线下可谈'], type:'bank' },
  { id:'nbyh', bank:'南银法巴银行', product:'诚易贷', hurdle:560, k:0.025, emoji:'🏦', rate:'7.2%-18.8%', amount:'最高30万（夫妻各自申请）', maxQ1:5, maxQ3:9, maxQ6:15, maxDebt:null, minIncome:null, minAge:22, maxAge:56, overdue:'mild', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'年龄22-56周岁；本地户籍：个税/公积金/社保≥6个月；外地户籍：≥12个月；近1月查询≤5次，近3月≤9次，半年≤15次；当前不能逾期，历史总逾期次数≤12次，历史无M2', bonus:'硕士/博士利率7.2%-9%最低；本科+公积金月缴≥2千利率9%-12%；查询要求最宽松', tags:['查询宽松','外地户籍可做','学历利率优惠'], type:'bank' },
  { id:'zljr', bank:'招联消费金融', product:'好期贷', hurdle:480, k:0.025, emoji:'📱', rate:'7.2%-24%', amount:'最高20万', maxQ1:null, maxQ3:99, maxQ6:null, maxDebt:85, minIncome:2000, minAge:null, maxAge:null, overdue:'mild', social:false, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'有稳定收入；历史逾期已还清可申请；查询次数基本不影响', bonus:'银行全拒后保底首选；秒批到账；持牌消费金融机构', tags:['持牌机构','查询不限','保底首选'], type:'finance' },
  { id:'hxxd', bank:'海翔小贷', product:'信用贷', hurdle:450, k:0.025, emoji:'🦅', rate:'利率面议', amount:'10-100万', maxQ1:null, maxQ3:99, maxQ6:null, maxDebt:80, minIncome:null, minAge:22, maxAge:55, overdue:'zero', social:true, minSocialMonths:null, minProvident:null, minEdu:'none', workTypes:null, conditions:'上班族；省内户籍或厦门房产；年龄22-55；无当前逾期；2年内展期/公积金提取不准入', bonus:'优质单位/高公积金/可双签均可提额；10-30万可最高40%先息', tags:['本地小贷','厦门户籍优先','大额可做'], type:'finance' },
  { id:'zyxf', bank:'中邮消费金融', product:'消费贷', hurdle:490, k:0.025, emoji:'📬', rate:'18%-23.76%', amount:'最高20万', maxQ1:3, maxQ3:9, maxQ6:null, maxDebt:null, minIncome:null, minAge:20, maxAge:55, overdue:'mild', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'年龄20-55；本单位满6个月；负债三选一：公积金/社保/个税基数×50倍≥信贷余额；近3月信贷查询≤9次', bonus:'负债要求三选一非常灵活；公积金/社保/个税任一满足即可', tags:['负债要求灵活','查询宽松','持牌消费金融'], type:'finance' },
  { id:'zbyh', bank:'中银消费金融', product:'消费贷', hurdle:500, k:0.025, emoji:'🏛', rate:'14.98%-22.98%', amount:'最高20万', maxQ1:null, maxQ3:7, maxQ6:null, maxDebt:null, minIncome:null, minAge:20, maxAge:55, overdue:'mild', social:true, minSocialMonths:6, minProvident:null, minEdu:'college', workTypes:null, conditions:'年龄20-55；上班族；大专及以上学历；3个月机构查询≤7次；无当前逾期；至少有一笔正常还款6个月以上', bonus:'社保基数5000+大专学历利率最低14.98%；夫妻可各自申请合计40万', tags:['双系统','社保基数关键','大专可做'], type:'finance' },
  { id:'xyjr', bank:'兴业消费金融', product:'消费贷', hurdle:510, k:0.025, emoji:'💼', rate:'8.88%-16.8%', amount:'5-20万（夫妻40万）', maxQ1:null, maxQ3:10, maxQ6:null, maxDebt:null, minIncome:5000, minAge:22, maxAge:60, overdue:'mild', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'年龄22-60；社保6个月以上，月工资5000以上；近3月查询≤10次；无当前逾期；不接受白户', bonus:'A1类irr年化8.88%最低；研究生学历直接最优利率；全款房客户20%认定额度', tags:['学历利率优惠','厦门社保6月','全款房加分'], type:'finance' },
  { id:'lyh', bank:'陆易花', product:'薪产品', hurdle:440, k:0.025, emoji:'🌸', rate:'利率面议', amount:'2-20万循环额度', maxQ1:4, maxQ3:9, maxQ6:null, maxDebt:100, minIncome:null, minAge:22, maxAge:55, overdue:'loose', social:true, minSocialMonths:6, minProvident:null, minEdu:'none', workTypes:null, conditions:'年龄22-55；上班族（不含企业法人/股东/个体）；企业缴社保≥6个月；无当前逾期200元以下可申请；近3月查询<9次', bonus:'循环额度最灵活；支持12/24/36期；换单位只需保证连续缴纳即可', tags:['循环额度','上班族专属','线上操作'], type:'finance' },
];

// ==========================================
// 贷准风控 2.0 - 机构类型映射字典
// 作用：用于计算贷款机构多样性（香农熵）及风控定级
// ==========================================

const INSTITUTION_TYPES = {
  STATE_BANK:       '国有大型银行',    // 最高权重，高稳定性
  COMMERCIAL_BANK:  '商业/城商行',     // 高权重，中高稳定性
  ONLINE_BANK:      '互联网助贷银行',  // 持牌但风险画像接近消金
  CONSUMER_FINANCE: '持牌消费金融',    // 中等权重，信贷意愿强
  MICRO_LOAN:       '网络小贷',        // 降分项，高风险、共债特征
  OTHER:            '其他机构'         // 兜底项
};

// 关键词匹配库（按优先级从高到低排列，命中即返回）
const INSTITUTION_MAPPING_RULES = [
  // 1. 国有大型银行（六大行）
  {
    type: 'STATE_BANK',
    keywords: ['工商银行', '农业银行', '中国银行', '建设银行', '交通银行', '邮政储蓄', '邮储银行']
  },

  // 2. 互联网助贷银行（持牌但风险画像接近消金，与 worker.js online_bank 列表保持同步）
  {
    type: 'ONLINE_BANK',
    keywords: [
      '富民银行', '苏商银行', '锡商银行', '新网银行', '众邦银行', '通商银行',
      '蓝海银行', '三湘银行', '苏宁银行', '亿联银行', '振兴银行', '中关村银行'
    ]
  },

  // 3. 股份制商业银行 + 城商行 + 农村商业银行
  {
    type: 'COMMERCIAL_BANK',
    keywords: [
      // 全国性股份制
      '招商银行', '平安银行', '浦发银行', '浦东发展银行', '中信银行', '光大银行',
      '民生银行', '兴业银行', '广发银行', '华夏银行', '浙商银行', '渤海银行', '恒丰银行',
      // 互联网银行（非助贷类）
      '微众银行', '网商银行', '百信银行',
      // 本地高频城商行
      '厦门银行', '厦门国际银行', '泉州银行', '福建海峡银行', '福建华通银行',
      '长安银行',
      // 农村金融机构
      '农村商业银行', '农商银行', '农商行', '村镇银行', '农村合作银行', '农信社'
    ]
  },

  // 4. 持牌消费金融公司
  {
    type: 'CONSUMER_FINANCE',
    keywords: [
      '招联消费金融', '马上消费金融', '捷信消费金融', '兴业消费金融',
      '中银消费金融', '中邮消费金融', '杭银消费金融', '海尔消费金融',
      '蚂蚁消费金融', '苏宁消费金融', '中原消费金融', '哈银消费金融',
      '长银消费金融', '尚诚消费金融', '金美信消费金融', '盛银消费金融',
      '宁银消费金融', '阳光消费金融', '湖北消费金融', '凯基消费金融',
      '北银消费金融', '小米消费金融', '即富消费金融', '晋商消费金融'
    ]
  },

  // 5. 网络小贷（最高频扣分项）
  {
    type: 'MICRO_LOAN',
    keywords: [
      '小额贷款', '小贷', '网络小贷',
      '财付通',                              // 微信系（微粒贷）
      '三快小额贷款', '美团',                // 美团系
      '京东盛际', '网银在线',               // 京东系
      '度小满', '百度小贷',                 // 百度系
      '奇富科技', '三六零', '360',          // 360系
      '蚂蚁商诚', '蚂蚁小微',              // 花呗/借呗
      '拍拍贷', '分期乐', '乐信', '桔子',  // 乐信系
      '众安小贷', '滴滴小贷', '字节跳动',  // 其他互联网系
      '中融小贷', '西岸小额', '中融小额'
    ]
  }
];

/**
 * 根据机构名称返回机构类型枚举值
 * @param {string} name - OCR 标准化后的机构名（如 "浦发银行-贷记卡" 或原始全称）
 * @returns {string} INSTITUTION_TYPES 中的值
 */
function getInstitutionType(name) {
  if (!name) return INSTITUTION_TYPES.OTHER;
  for (const rule of INSTITUTION_MAPPING_RULES) {
    for (const kw of rule.keywords) {
      if (name.includes(kw)) return INSTITUTION_TYPES[rule.type];
    }
  }
  return INSTITUTION_TYPES.OTHER;
}

/**
 * 计算贷款机构多样性香农熵
 * @param {Array} loans - 贷款账户数组（含 name 字段）
 * @returns {number} 熵值，0 = 全部同类；越高表示机构越多样
 */
function calcInstitutionEntropy(loans) {
  if (!loans || loans.length === 0) return 0;
  const counts = {};
  for (const loan of loans) {
    const t = getInstitutionType(loan.name);
    counts[t] = (counts[t] || 0) + 1;
  }
  const total = loans.length;
  let entropy = 0;
  for (const cnt of Object.values(counts)) {
    const p = cnt / total;
    entropy -= p * Math.log(p);
  }
  return Math.round(entropy * 1000) / 1000; // 保留3位小数
}
