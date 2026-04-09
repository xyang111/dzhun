// ── 本地兜底匹配（AI失败时使用，逻辑与产品库完全同步）──
function localFallbackMatch(data, v2Score = 0) {
  // 逾期与不良记录状态解析
  const hasOverdue   = (data.overdue_current||0)>0;
  const ovNotes      = (data.overdue_history_notes||'').toLowerCase();
  const badNotes     = (data.bad_record_notes||'').toLowerCase();
  const hasLian3     = ovNotes.includes('连三')||ovNotes.includes('连续3')||ovNotes.includes('连续三');
  const hasLei6      = ovNotes.includes('累六')||ovNotes.includes('累计6');
  const hasSeriousOv = hasLian3||hasLei6||ovNotes.includes('m2')||ovNotes.includes('60天');
  // summary_overdue_accounts>0 辅助判断历史逾期（防止AI漏写notes但表格有值）
  const hasOvHist    = (data.has_overdue_history||false)
                    || (data.summary_overdue_accounts||0) > 0;
  // 呆账/担保代还等严重不良（优先读OCR字段，兜底读文字）
  const hasBadRecord = (data.has_bad_record===true)
    ||badNotes.includes('呆账')||badNotes.includes('代偿')||badNotes.includes('担保代还')
    ||badNotes.includes('资产处置')||badNotes.includes('止付')||badNotes.includes('冻结')
    ||ovNotes.includes('呆账')||ovNotes.includes('代偿')||ovNotes.includes('担保代还');
  const q           = calcQueryCounts(data.query_records || []);
  const q1          = q.q_1m || 0;
  const q3          = q.q_3m || 0;
  const q6          = q.q_6m || 0;
  const onlineCount = (data.loans||[]).filter(l=>l.type==='online').length; // 笔数（评分用）
  const _onlineL = (data.loans||[]).filter(l=>l.type==='online');
  const onlineInstCnt = [...new Set(_onlineL.map(l=>l.name.split('-')[0]))].length; // 机构数（准入用）
  const onlinePenalty = onlineInstCnt >= 5 ? -20 : (onlineInstCnt === 3 || onlineInstCnt === 4) ? -10 : 0;
  // 年龄（从征信身份证算）
  const _age = calcAgeFromId(window._personIdNo || '');

  // 读取用户填写的补充信息
  const userInfo     = (() => { try { return collectInfoData(); } catch(e) { return {}; } })();
  const income       = userInfo.income || 0;
  const provident    = userInfo.provident || 0;          // 公积金月缴额
  const hasSocial    = userInfo.social && userInfo.social.includes('有');
  const socialMonths = (() => {
    if (!hasSocial) return 0;
    const m = (userInfo.social || '').match(/(\d+)月/);
    return m ? parseInt(m[1]) : 6; // 有社保但未填月数，保守按6月
  })();
  const eduVal = userInfo.edu || '';
  const eduRank = { '': 0, '高中及以下': 1, '函授/自考': 2, '全日制大专': 3, '全日制本科及以上': 4 };
  const userEduRank  = eduRank[eduVal] || 0;
  const minEduRank   = { none:0, high:1, other_degree:2, college:3, bachelor:4, master:5 };
  const workVal      = userInfo.work || '';
  const userWorkType = WORK_TYPE_MAP[workVal] || 'private';

  // 负债率（提前计算，供一票否决使用）
  const _loansForDebt = getActiveLoans(data);
  const _cardsForDebt = getActiveCards(data);
  const _tmForDebt = calcTotalMonthly(_loansForDebt, _cardsForDebt);
  const debtRatio = income > 0 && _tmForDebt > 0 ? Math.round(_tmForDebt / income * 100) : 0;

  const products = [];
  const _isWhiteJobFb = ['gov','institution','state'].includes(userWorkType);

  // 产品分层：V2.0评分决定推荐产品类型（≥650银行优先；400-649混合；<400消费金融为主）
  const _tier = v2Score >= 650 ? 'bank' : v2Score >= 400 ? 'mixed' : 'finance';

  BANK_PRODUCTS.forEach(p => {
    // ── 一票否决：征信硬性条件 ──
    if (hasOverdue)    return;           // 当前逾期 → 排除所有产品
    if (hasSeriousOv)  return;           // 连三/累六/M2/超60天 → 排除所有产品
    if (hasBadRecord)  return;           // 呆账/担保代还等不良 → 排除所有产品
    if (onlineInstCnt > 12) return;      // 网贷机构>12家 → 排除所有产品
    if (onlineInstCnt > 8 && p.type === 'bank') return; // 网贷机构>8家 → 排除全部银行产品
    if (p.overdue === 'mild' && hasOvHist) return;  // mild产品：有历史逾期 → 排除
    if (q3 > p.maxQ3) return;
    if (p.maxQ1 != null && q1 > p.maxQ1) return;
    if (p.maxQ6 !== null && q6 > p.maxQ6) return;

    // ── 一票否决：年龄 ──
    if (_age && p.minAge && _age < p.minAge) return;
    if (_age && p.maxAge && _age > p.maxAge) return;

    // ── 一票否决：负债率（有收入才判断）──
    if (p.maxDebt && income > 0 && debtRatio > p.maxDebt) return;

    // ── 一票否决：收入不足 ──
    if (p.minIncome && income > 0 && income < p.minIncome) return;

    // ── 一票否决：社保不足 ──
    // 需要社保/公积金 但两者都没有 → 排除
    const hasProvident = provident > 0;
    if (p.social && !hasSocial && !hasProvident) return;
    // 有具体月数要求时，额外检查
    if (p.social && p.minSocialMonths && hasSocial && socialMonths < p.minSocialMonths) return;

    // ── 一票否决：公积金不足（只在用户明确填写了公积金金额时生效）──
    if (p.minProvident && userInfo.provident !== null && provident < p.minProvident) return;

    // ── 一票否决：学历不足 ──
    if (p.minEdu && p.minEdu !== 'none') {
      const reqRank = minEduRank[p.minEdu] || 0;
      if (userEduRank > 0 && userEduRank < reqRank) return;
    }

    // ── 一票否决：职业类型不符 ──
    if (p.workTypes && p.workTypes.length > 0) {
      if (!p.workTypes.includes(userWorkType)) return;
    }

    // ── 通过率计算：V2.0 Sigmoid + B级置信折扣 ──
    const _v2Level = v2Score >= 800 ? 'A' : v2Score >= 650 ? 'B' : v2Score >= 500 ? 'C' : 'D';
    let _rawProb = 100 / (1 + Math.exp(-(p.k || 0.025) * (v2Score - (p.hurdle || 500))));
    if (_v2Level === 'B') {
      let _disc = 1;
      _disc -= hasOvHist          ? 0.12 : 0;   // 有历史逾期
      _disc -= q3 > 5             ? 0.14 : q3 > 3 ? 0.08 : 0;  // 查询偏多
      _disc -= onlineInstCnt > 3  ? 0.07 : 0;   // 网贷机构偏多
      _disc -= debtRatio > 55     ? 0.06 : 0;   // 负债率偏高
      _disc = Math.max(0.65, _disc);
      _rawProb *= _disc;
    }
    const probPct = Math.max(5, Math.min(95, Math.round(_rawProb)));
    const prob = p.type === 'finance'
      ? (probPct >= 60 ? '高' : probPct >= 45 ? '中' : probPct >= 30 ? '低' : '不推荐')
      : (probPct >= 70 ? '高' : probPct >= 50 ? '中' : probPct >= 35 ? '低' : '不推荐');

    // ── 精细化推荐理由生成（达到AI输出质量）──
    // reason: 产品卡片显示的简短理由（1句，含具体数字）
    // reason_detail: 点击展开的详细理由（2-3个维度）

    // 找出该产品最大的加分项（作为主推理由）
    const _reasonParts = [];

    // 查询维度（最影响银行判断）
    if (p.maxQ3 === 99) {
      _reasonParts.push({ weight: 3, text: '查询次数不限，消金产品首选' });
    } else if (q3 === 0) {
      _reasonParts.push({ weight: 10, text: `查询记录干净，${p.bank}最高通过概率` });
    } else {
      const remain = p.maxQ3 - q3;
      if (remain >= 3)      _reasonParts.push({ weight: 8,  text: `查询${q3}次，还有${remain}次余量（上限${p.maxQ3}次）` });
      else if (remain >= 1) _reasonParts.push({ weight: 5,  text: `查询${q3}次，余量${remain}次，仍在${p.bank}准入内` });
      else                  _reasonParts.push({ weight: 2,  text: `查询${q3}次，刚好在${p.bank}上限${p.maxQ3}次内` });
    }

    // 公积金维度
    if (provident >= 2000)      _reasonParts.push({ weight: 9, text: `公积金${provident}元/月，超过优质门槛，利率可申请最低档` });
    else if (provident >= 1000) _reasonParts.push({ weight: 7, text: `公积金${provident}元/月，满足${p.bank}稳定就业要求` });
    else if (provident >= 500)  _reasonParts.push({ weight: 4, text: `公积金${provident}元/月` });

    // 社保维度
    if (hasSocial && socialMonths >= 24)      _reasonParts.push({ weight: 8, text: `社保已缴${socialMonths}个月，远超门槛，加分明显` });
    else if (hasSocial && socialMonths >= 12) _reasonParts.push({ weight: 6, text: `社保${socialMonths}个月，满足${p.bank}稳定就业要求` });
    else if (hasSocial && socialMonths >= 6)  _reasonParts.push({ weight: 3, text: `社保${socialMonths}个月，刚好满足门槛` });

    // 职业维度
    if (['gov','institution','state'].includes(userWorkType))
      _reasonParts.push({ weight: 9, text: `${userInfo.work || '优质单位'}背景，${p.bank}白名单职业，通过率大幅提升` });
    else if (userWorkType === 'listed')
      _reasonParts.push({ weight: 6, text: `上市公司/500强背景，银行认可度高` });

    // 负债率维度
    if (debtRatio > 0 && p.maxDebt) {
      const drMargin = p.maxDebt - debtRatio;
      if (drMargin >= 30)      _reasonParts.push({ weight: 5, text: `负债率${debtRatio}%，距上限${p.maxDebt}%还有${drMargin}%空间，额度可申请较高` });
      else if (drMargin >= 15) _reasonParts.push({ weight: 3, text: `负债率${debtRatio}%，在${p.bank}安全线以内` });
    }

    // 资产维度
    const _assV = userInfo.assets || '';
    if (_assV.includes('房产')) _reasonParts.push({ weight: 5, text: '名下有房产，银行综合评估加分' });

    // 无逾期加分
    if (!hasOverdue && !hasOvHist) _reasonParts.push({ weight: 4, text: '征信无逾期记录，还款意愿评分满分' });

    // 按weight排序，取最高分作为主理由
    _reasonParts.sort((a, b) => b.weight - a.weight);
    const reason       = _reasonParts[0]?.text || p.conditions.split('；')[0];
    const reasonDetail = _reasonParts.slice(0, 3).map(r => r.text).join('；') || p.conditions.split('；')[0];

    products.push({
      id: p.id, hurdle: p.hurdle, maxQ3: p.maxQ3, maxQ1: p.maxQ1,
      bank: p.bank, product: p.product, rate: p.rate,
      emoji: p.emoji, prob, probPct,
      amount: p.amount, tags: p.tags, type: p.type,
      reason: reason,              // 主理由（按权重最高的维度）
      reason_detail: reasonDetail, // 详细理由（前3个维度）
    });
  });

  // 排序：高>中>低>不推荐，同档内按probPct降序
  const _probOrder = {'高':4,'中':3,'低':2,'不推荐':1};
  const sorted = products.sort((a,b) => {
    const tierDiff = (_probOrder[b.prob]||0) - (_probOrder[a.prob]||0);
    return tierDiff !== 0 ? tierDiff : b.probPct - a.probPct;
  });

  const keyRisk = hasOverdue
    ? '存在当前逾期，所有产品均无法申请，请先结清'
    : hasSeriousOv
    ? '存在连三累六/M2级严重逾期，所有产品均无法申请，需征信修复'
    : hasBadRecord
    ? '存在呆账/担保代还等严重不良记录，所有产品均无法申请，需先处理'
    : onlineInstCnt > 12
    ? `网贷机构${onlineInstCnt}家，超12家上限，所有产品均无法申请`
    : onlineInstCnt > 8
    ? `网贷机构${onlineInstCnt}家，超8家上限，银行类产品全部排除，仅可申请消费金融`
    : q3 > 10 ? `近3月查询${q3}次严重超标，银行产品基本无法通过`
    : q3 > 5  ? `近3月查询${q3}次偏多，已超多数银行准入红线`
    : q1 > 5  ? `近1月查询${q1}次偏多，已超多数银行近1月查询红线`
    : onlineInstCnt >= 5 ? `网贷机构${onlineInstCnt}家，已超银行准入红线（≤4家）`
    : (onlineInstCnt === 3 || onlineInstCnt === 4) ? `网贷机构${onlineInstCnt}家，轻度警示（银行准入建议≤2家）`
    : debtRatio > 80 ? `负债率${debtRatio}%严重超标，多数银行无法通过负债率审核`
    : (!hasSocial && !provident) ? '无社保且无公积金，多数银行产品需要其中之一'
    : '';

  // ── 本地兜底：生成 advice 三模块 ──
  const advStrengths = [];
  const advIssues    = [];
  const advSuggestions = [];

  // 优点
  if (!hasOverdue && !hasOvHist)
    advStrengths.push({ point: '无逾期记录', impact: '银行判定还款意愿强，是核心加分项' });
  if (provident >= 1000)
    advStrengths.push({ point: `公积金${provident}元/月`, impact: '证明稳定就业，大幅提升银行信用贷通过率' });
  if (hasSocial && socialMonths >= 12)
    advStrengths.push({ point: `社保已缴${socialMonths}个月`, impact: '满足大多数银行稳定就业门槛' });
  if (['gov','institution','state'].includes(userWorkType))
    advStrengths.push({ point: '政府/事业/国企单位', impact: '银行最高评级职业类型，额度和利率均有优势' });
  if (userEduRank >= 4)
    advStrengths.push({ point: '本科及以上学历', impact: '符合部分银行学历门槛加分项' });
  const hukouV2 = userInfo.hukou || '';
  if (hukouV2.includes('厦门'))
    advStrengths.push({ point: '厦门本地户籍', impact: '本地银行优先审批，降低准入门槛' });
  if ((userInfo.assets||'').includes('房产'))
    advStrengths.push({ point: '名下有房产', impact: '证明资产实力，银行判定还款能力更强' });

  // 问题
  if (q3 > 10)
    advIssues.push({ point: `近3月征信查询${q3}次严重超标`, impact: '超过大多数银行≤6次准入红线，直接拒贷' });
  else if (q3 > 5)
    advIssues.push({ point: `近3月征信查询${q3}次偏多`, impact: '已超多数银行准入门槛，通过率大幅下降' });
  if (onlineInstCnt >= 5)
    advIssues.push({ point: `网贷机构${onlineInstCnt}家超标`, impact: '已超银行准入红线（≤4家），银行判定多头借贷，风险评级大幅降低' });
  else if (onlineInstCnt === 3 || onlineInstCnt === 4)
    advIssues.push({ point: `网贷机构${onlineInstCnt}家轻度警示`, impact: '网贷机构数偏多，部分银行可能拒贷，建议降至2家以内' });
  if (!hasSocial && !provident)
    advIssues.push({ point: '无社保且无公积金', impact: '多数银行信用贷要求至少其中一项，直接影响准入' });
  else if (hasSocial && socialMonths < 6)
    advIssues.push({ point: `社保仅缴${socialMonths}个月`, impact: '不足6个月，无法满足大多数银行稳定就业要求' });
  if (hasOverdue)
    advIssues.push({ point: '存在当前逾期', impact: '银行绝对红线，所有产品均无法申请，请立即结清' });
  if (!hasOverdue && hasSeriousOv)
    advIssues.push({ point: '存在连三累六/M2级严重逾期记录', impact: '所有产品均无法申请，需征信修复（通常需等待2年以上）' });
  if (hasBadRecord)
    advIssues.push({ point: '存在呆账/担保代还等严重不良', impact: '所有产品均无法申请，必须先联系金融机构协商处理不良记录' });
  if (!hasOverdue && !hasSeriousOv && !hasBadRecord && onlineInstCnt > 8)
    advIssues.push({ point: `网贷机构${onlineInstCnt}家超过8家上限`, impact: onlineInstCnt > 12 ? '所有产品均无法申请，需大量结清后再评估' : '银行类产品已全部排除，建议结清至8家以下再申请银行产品' });
  if (income > 0 && income < 5000)
    advIssues.push({ point: `月收入${income}元偏低`, impact: '低于多数银行最低收入门槛，额度和通过率均受限' });

  // 信用卡使用率
  const _advCardUtil = (() => {
    const cards2 = getActiveCards(_recognizedData);
    const lim = cards2.reduce((s, c) => s + (c.limit || 0), 0);
    const used = cards2.reduce((s, c) => s + (c.used || 0), 0);
    return lim > 0 ? Math.round(used / lim * 100) : 0;
  })();
  if (_advCardUtil > 70)
    advIssues.push({ point: `信用卡使用率${_advCardUtil}%超标`, impact: '信用卡使用率超过70%，银行审批将直接扣分，影响贷款通过率' });
  else if (_advCardUtil > 50)
    advIssues.push({ point: `信用卡使用率${_advCardUtil}%偏高`, impact: '信用卡使用率超过50%，建议降低至50%以下以提升审批通过率' });

  // 改善建议
  if (q3 > 5)
    advSuggestions.push({ action: '停止一切网贷/信用卡申请3个月', goal: '让查询记录自然冷却', time: '3个月', effect: '查询降至6次以下后，股份制银行基本可申' });
  if (onlineInstCnt >= 5)
    advSuggestions.push({ action: `结清${onlineInstCnt-2}家网贷并注销账户`, goal: '将网贷机构数降至2家以内', time: '1-2个月', effect: '消金和股份制银行准入条件达标' });
  else if (onlineInstCnt === 3 || onlineInstCnt === 4)
    advSuggestions.push({ action: `结清${onlineInstCnt-2}家网贷并注销账户`, goal: '将网贷机构数降至2家以内', time: '1-2个月', effect: '消除轻度警示，显著提升银行审批通过率' });
  if (!hasSocial && !provident)
    advSuggestions.push({ action: '入职并开始缴纳社保', goal: '积累稳定就业记录', time: '持续6个月+', effect: '满足绝大多数银行信用贷社保门槛' });
  else if (hasSocial && socialMonths < 12)
    advSuggestions.push({ action: `继续缴纳社保至12个月`, goal: '满足股份制银行最优等级门槛', time: `${12-socialMonths}个月`, effect: '可申请招行/浦发/平安等主流产品' });
  if (_advCardUtil > 50)
    advSuggestions.push({ action: '降低信用卡使用率至50%以下', goal: '提升银行审批通过率', time: '1-3个月', effect: `当前使用率${_advCardUtil}%，还款部分信用卡余额，将使用率降至50%以下后银行审批评分将明显提升` });

  if (advSuggestions.length === 0)
    advSuggestions.push({ action: '维持当前良好征信状态，择期申请最优产品', goal: '保持查询记录低水平', time: '持续', effect: '长期保持银行高评级客户资质' });

  // risk_level 前端计算（与prompt判定标准完全对齐）
  let riskLevel = '健康';
  const _cards3 = (_recognizedData?.cards||[]).filter(c=>c.status!=='销户');
  const _cLim3 = _cards3.reduce((s,c)=>s+(c.limit||0),0);
  const _cUse3 = _cards3.reduce((s,c)=>s+(c.used||0),0);
  const _cUtil3 = _cLim3 > 0 ? Math.round(_cUse3/_cLim3*100) : 0;
  const _loans3 = (data.loans||[]).filter(l=>l.status!=='结清'&&l.status!=='已结清');
  const _tm3 = calcTotalMonthly(_loans3, _cards3);
  const _dr3 = (userInfo.income||0) > 0 ? Math.round(_tm3/(userInfo.income)*100) : 0;

  if (hasOverdue || hasSeriousOv || hasBadRecord || q3 > 12 || onlineInstCnt > 12 || _cUtil3 > 100 || _dr3 > 80) {
    riskLevel = '高风险';
  } else if (q3 >= 7 || onlineInstCnt >= 3 || _cUtil3 > 80 || _dr3 > 60 || (!hasSocial && !provident)) {
    riskLevel = '中度风险';
  } else if (q3 >= 4 || onlineInstCnt >= 1 || _cUtil3 > 70 || _dr3 > 50 || (hasSocial && socialMonths < 6)) {
    riskLevel = '轻微瑕疵';
  }

  // 分层标签
  const _tierLabel = _tier === 'bank'    ? '银行优先'
                   : _tier === 'mixed'   ? '银行+消金混合'
                   : '消费金融为主';
  const _highCount = sorted.filter(p => p.prob === '高').length;
  const _noRecCount = sorted.filter(p => p.prob === '不推荐').length;

  // ── 本地兜底时也输出client_type，和AI结果结构统一 ──
  const _fbClientType = hasSeriousOv || hasBadRecord || onlineInstCnt > 8 ? 'C'
    : (_isWhiteJobFb || (q3 <= 3 && income >= 10000 && !hasOvHist)) ? 'A'
    : (q3 > 3 || onlineInstCnt >= 3 || debtRatio > 60) ? 'B'
    : 'A';

  // 本地计算通过率（供合并后显示）
  const _localCurRate  = _highCount >= 2 ? 78 : sorted.length >= 2 ? 65 : sorted.length === 1 ? 55 : 30;
  const _localOptRate  = Math.min(92, _localCurRate + 18);

  return {
    _source: 'local',
    summary: sorted.length > 0
      ? `V2.0评分 ${v2Score} 分（${_tierLabel}），匹配到 ${sorted.length} 款产品，其中高概率 ${_highCount} 款`
      : `V2.0评分 ${v2Score} 分，当前资质暂无可匹配产品，建议优化征信后再申请`,
    count: sorted.length,
    key_risk: keyRisk,
    risk_level: riskLevel,
    cs_score: v2Score,
    cs_tier: _tier,
    client_type: _fbClientType,
    current_rate: _localCurRate,
    optimized_rate: _localOptRate,
    current_products: sorted.length,
    optimized_products: Math.min(sorted.length + 3, 8),
    products: sorted,
    advice: {
      strengths:   advStrengths.slice(0, 4),
      issues:      advIssues.slice(0, 4),
      suggestions: advSuggestions.slice(0, 4),
    },
  };
}

// State
let _fileBlocks = [];       // array of API content blocks (image or document)
let _recognizedData = null; // {loans, cards, queries, summary}
window._pageSessionId = Math.random().toString(36).slice(2, 16) + Date.now().toString(36);

function _trackEvent(event, props) {
  try {
    fetch(PROXY_URL + '/api/v1/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        sessionId: window._pageSessionId,
        agentId:   window._currentAgent?.id || null,
        props:     props || null,
      }),
    }).catch(() => {});
  } catch (e) { /* silent */ }
}


// ═══════════════════════════════════════════
// 征信评分系统
// ═══════════════════════════════════════════

function calcCreditScore(data, ui) {
  if (!data || typeof data !== 'object') data = {};
  const loans = getActiveLoans(data);
  const cards = getActiveCards(data);
  const q     = calcQueryCounts(data.query_records||[]);
  const q3    = q.q_3m||0;
  const onlineInst = [...new Set(loans.filter(l=>l.type==='online').map(l=>l.name.split('-')[0]))].length;
  const cLimit = cards.reduce((s,c)=>s+(c.limit||0),0);
  const cUsed  = cards.reduce((s,c)=>s+(c.used||0),0);
  const cUtil  = cLimit>0?Math.round(cUsed/cLimit*100):0;
  const income = ui&&ui.income?ui.income:0;
  const monthly = calcTotalMonthly(loans,cards);
  const dr = income>0?Math.round(monthly/income*100):0;
  const hasOv     = (data.overdue_current||0)>0;
  const ovNotes   = (data.overdue_history_notes||'').toLowerCase();
  const hasLian3  = ovNotes.includes('连三')||ovNotes.includes('连续3')||ovNotes.includes('连续三');
  const hasLei6   = ovNotes.includes('累六')||ovNotes.includes('累计6');
  const hasOvHist = data.has_overdue_history||false;
  const isBasic   = !ui||!ui.income;

  const dims = [];
  // 当前逾期 25%
  let d1 = hasOv?0:100;
  dims.push({name:'当前逾期',s:d1,w:.25,c:d1>=80?'#4ade80':'#f87171'});
  // 历史逾期 15%
  let d2 = hasLian3||hasLei6?0:hasOvHist?45:100;
  dims.push({name:'历史逾期',s:d2,w:.15,c:d2>=80?'#4ade80':d2>=50?'#fbbf24':'#f87171'});
  // 查询次数 20%
  let d3 = q3===0?100:q3<=3?85:q3<=6?62:q3<=9?32:8;
  dims.push({name:'查询次数',s:d3,w:.20,c:d3>=70?'#4ade80':d3>=45?'#fbbf24':'#f87171'});
  // 网贷机构 15%
  let d4 = onlineInst===0?100:onlineInst<=2?78:onlineInst<=4?40:8;
  dims.push({name:'网贷情况',s:d4,w:.15,c:d4>=70?'#4ade80':d4>=45?'#fbbf24':'#f87171'});
  // 信用卡使用率 10%
  let d5 = cUtil<=50?100:cUtil<=70?72:cUtil<=90?40:12;
  dims.push({name:'信用卡率',s:d5,w:.10,c:d5>=70?'#4ade80':d5>=45?'#fbbf24':'#f87171'});
  // 负债率 10%（无收入用中性值50）
  let d6 = income>0?(dr<=30?100:dr<=50?80:dr<=65?58:dr<=80?28:6):50;
  dims.push({name:'负债率',s:d6,w:.10,c:d6>=70?'#4ade80':d6>=45?'#fbbf24':'#f87171'});

  if (!isBasic&&ui) {
    const hasSocial = (ui.social||'').includes('有');
    const pvd = ui.provident||0;
    let d7 = pvd>=1000?100:pvd>=500?75:hasSocial?60:28;
    dims.push({name:'社保公积金',s:d7,w:.08,c:d7>=70?'#4ade80':d7>=45?'#fbbf24':'#f87171'});
    const hk = ui.hukou||'';
    let d8 = hk.includes('厦门')?100:hk.includes('福建')?72:hk&&hk!=='未填写'?42:50;
    dims.push({name:'户籍',s:d8,w:.06,c:d8>=70?'#4ade80':d8>=45?'#fbbf24':'#f87171'});
    const ast = ui.assets||'';
    let d9 = ast.includes('房产')?100:ast.includes('车辆')?65:28;
    dims.push({name:'资产情况',s:d9,w:.06,c:d9>=70?'#4ade80':d9>=45?'#fbbf24':'#f87171'});
    const wtMap={'政府机关/公务员':100,'事业单位':100,'国有企业/央企':85,'上市公司/500强':72,'私营企业':55,'个体工商户':42,'自由职业':38};
    let d10 = wtMap[ui.work||'']||50;
    dims.push({name:'单位性质',s:d10,w:.06,c:d10>=70?'#4ade80':d10>=45?'#fbbf24':'#f87171'});
  }

  const totalW = dims.reduce((s,d)=>s+d.w,0);
  const raw    = dims.reduce((s,d)=>s+d.s*d.w,0)/totalW;
  const score  = Math.round(Math.max(0,Math.min(100,raw)));
  let level,cls,hint;
  if(score>=85){level='优质';cls='cs-lv-exc';hint='征信状态优质，银行产品基本无障碍，利率可申请最低档';}
  else if(score>=70){level='良好';cls='cs-lv-gd';hint='征信状态良好，银行及消费金融均可申请，通过率较高';}
  else if(score>=55){level='一般';cls='cs-lv-ok';hint='存在扣分项，部分银行受限，消费金融可正常申请';}
  else if(score>=40){level='较弱';cls='cs-lv-wk';hint='存在明显风控问题，建议优化后再申请，否则通过率低';}
  else{level='高风险';cls='cs-lv-bad';hint='已触碰银行风控红线，建议先养征信3-6个月再申请';}
  return {score,level,cls,hint,dims,isBasic};
}

function renderCreditScore(data,ui) {
  const el = document.getElementById('csWrap');
  if(!el) return;
  el.style.display='block';
  const r = calcCreditScore(data,ui);
  const C = 207;
  const offset = C-(r.score/100)*C;
  const fill = document.getElementById('csGaugeFill');
  if(fill){
    const col = r.score>=85?'#4ade80':r.score>=70?'#60a5fa':r.score>=55?'#fbbf24':r.score>=40?'#fb923c':'#f87171';
    fill.style.stroke=col;
    fill.style.strokeDashoffset=C;
    setTimeout(()=>{fill.style.strokeDashoffset=offset;},80);
  }
  const sv=document.getElementById('csScoreVal');if(sv)sv.textContent=r.score;
  const lv=document.getElementById('csLevel');
  if(lv){lv.className='cs-level '+r.cls;lv.textContent=r.level;}
  const ht=document.getElementById('csHint');if(ht)ht.textContent=r.hint;
  const ul=document.getElementById('csUnlock');if(ul)ul.style.display=r.isBasic?'flex':'none';
  const grid=document.getElementById('csDims');
  if(grid){
    grid.innerHTML=r.dims.map(d=>`<div class="cs-dim"><div class="cs-dim-name">${d.name}</div><div class="cs-dim-row"><div class="cs-dim-bar"><div class="cs-dim-fill" style="width:${d.s}%;background:${d.c}"></div></div><div class="cs-dim-val" style="color:${d.c}">${d.s}</div></div></div>`).join('');
  }
}

function calcBlastRisk(qRecords,baseDate) {
  if (!Array.isArray(qRecords)) qRecords = [];
  // 使用报告日期作为基准（与calcQueryCounts保持一致）
  const base = baseDate ? new Date(baseDate) : new Date();
  base.setHours(0,0,0,0);
  // 月份计算（与calcQueryCounts完全一致，避免30天vs1个月的误差）
  const monthsAgo = m => { const d=new Date(base); d.setMonth(d.getMonth()-m); return d; };
  const daysAgo   = d => { const t=new Date(base); t.setDate(t.getDate()-d); return t; };
  const APPLY_TYPES = new Set(['贷款审批','信用卡审批','担保资格审查','资信审查','保前审查','融资租赁审批']);
  const filt = (qRecords||[]).filter(q=> APPLY_TYPES.has(q.type));
  const q7   = filt.filter(q=>new Date(q.date)>=daysAgo(7)).length;
  const q30  = filt.filter(q=>new Date(q.date)>=monthsAgo(1)).length;  // 1个月（不是30天）
  const q90  = filt.filter(q=>new Date(q.date)>=monthsAgo(3)).length;  // 3个月（不是90天）
  const conc = q90>0?Math.round(q30/q90*100):0;
  let risk=100;
  // 近7天：>=2次才开始扣分（1次属正常行为）
  risk-=Math.max(0,q7-1)*15;
  // 近30天：超过3次每次扣8分
  risk-=Math.max(0,q30-3)*8;
  // 近3月总量：超过6次每次扣4分（修复：此前q90完全不参与评分）
  risk-=Math.max(0,q90-6)*4;
  // 集中度扣分需满足：3个月总量>=3次，否则样本太小无统计意义
  if(conc>60 && q90>=3)risk-=10;
  risk=Math.max(0,Math.min(100,Math.round(risk)));
  let badge,cls,tip;
  if(risk>=80){badge='正常';cls='br-safe';tip='查询频率正常，可正常申请各类产品。';}
  else if(risk>=60){badge='偏高';cls='br-warn';tip='近期查询偏多，建议暂停查询2-3周后再申请，当前申请银行类产品通过率下降约20-30%。';}
  else if(risk>=30){badge='爆查';cls='br-danger';tip='近期查询次数过多！建议停止所有查询1个月，银行类产品当前基本无法通过。';}
  else{badge='严重';cls='br-critical';tip='查询严重超标，银行系统会直接判定为"资金紧张"，建议停止查询3个月后再评估。';}
  return{risk,badge,cls,tip,q7,q30,q90,conc};
}

function renderBlastRisk(data) {
  const el=document.getElementById('brWrap');if(!el)return;
  el.style.display='block';
  const r=calcBlastRisk(data.query_records||[],data.report_date||null);
  const bd=document.getElementById('brBadge');
  if(bd){bd.className='br-badge '+r.cls;bd.textContent=r.badge;}
  const q7e=document.getElementById('brQ7');if(q7e)q7e.textContent=r.q7+'次';
  const q30e=document.getElementById('brQ30');if(q30e)q30e.textContent=r.q30+'次';
  const q90e=document.getElementById('brQ90');if(q90e)q90e.textContent=r.q90+'次';
  const ce=document.getElementById('brConc');if(ce)ce.textContent=r.q90>=3?r.conc+'%':'--';
  const te=document.getElementById('brTip');if(te)te.textContent=r.tip;
  // 填充风险进度条
  const riskScoreEl = document.getElementById('brRiskScore');
  if (riskScoreEl) {
    riskScoreEl.textContent = r.risk + ' / 100';
    riskScoreEl.style.color = r.risk >= 70 ? 'var(--success)' : r.risk >= 40 ? 'var(--warn)' : 'var(--danger)';
  }
  const riskBarEl = document.getElementById('brRiskBar');
  if (riskBarEl) {
    riskBarEl.style.width = r.risk + '%';
    riskBarEl.style.background = r.risk >= 70 ? 'var(--success)' : r.risk >= 40 ? 'var(--warn)' : 'var(--danger)';
  }
  // Q7 bar（上限5次）
  const q7Bar = document.getElementById('brQ7Bar');
  if (q7Bar) { q7Bar.style.width = Math.min(r.q7/5*100,100)+'%'; q7Bar.style.background = r.q7<=1?'var(--success)':r.q7<=3?'var(--warn)':'var(--danger)'; }
  if (q7e) { q7e.style.color = r.q7<=1?'var(--success)':r.q7<=3?'var(--warn)':'var(--danger)'; }
  // Q30 bar（上限10次）
  const q30Bar = document.getElementById('brQ30Bar');
  if (q30Bar) { q30Bar.style.width = Math.min(r.q30/10*100,100)+'%'; q30Bar.style.background = r.q30<=3?'var(--success)':r.q30<=6?'var(--warn)':'var(--danger)'; }
  if (q30e) { q30e.style.color = r.q30<=3?'var(--success)':r.q30<=6?'var(--warn)':'var(--danger)'; }
  // Q90 bar（上限20次）
  const q90Bar = document.getElementById('brQ90Bar');
  if (q90Bar) { q90Bar.style.width = Math.min(r.q90/20*100,100)+'%'; q90Bar.style.background = r.q90<=6?'var(--success)':r.q90<=12?'var(--warn)':'var(--danger)'; }
  if (q90e) { q90e.style.color = r.q90<=6?'var(--success)':r.q90<=12?'var(--warn)':'var(--danger)'; }
  // Conc bar
  const concBar = document.getElementById('brConcBar');
  if (concBar && r.conc > 0) { concBar.style.width = Math.min(r.conc,100)+'%'; concBar.style.background = r.conc<=40?'var(--success)':r.conc<=70?'var(--warn)':'var(--danger)'; }
  if (ce) { ce.style.color = r.conc<=40?'var(--success)':r.conc<=70?'var(--warn)':'var(--danger)'; }
}

// ═══════════════════════════════════════════
// 月供估算（银行风控规则）
// 规则：房贷×0.0055 / 车贷×0.0304 / 银行信用贷×0.0314（超2年×0.04）
//       消金/网贷×0.04（超2年×0.05） / 信用卡已用×0.02
// ═══════════════════════════════════════════
function calcLoanMonthly(loan) {
  const bal = loan.balance || 0;
  if (bal <= 0) return 0;
  // online_bank（互联网助贷银行）归入消费金融类处理
  const cat = loan.online_subtype === 'online_bank'
    ? 'finance'
    : loan.loan_category || (loan.type === 'online' ? 'finance' : 'credit');

  // 房贷/车贷保持系数法（期限长，反推意义不大）
  if (cat === 'mortgage') return Math.round(bal * 0.0055);
  if (cat === 'car')      return Math.round(bal * 0.0304);

  const baseDate = _recognizedData?.report_date
    ? new Date(_recognizedData.report_date)
    : new Date();
  const issued = loan.issued_date ? new Date(loan.issued_date) : null;
  const elapsed = issued
    ? Math.floor((baseDate - issued) / (1000 * 60 * 60 * 24 * 30.44))
    : null;
  // due_date精确剩余期数（非循环贷才有意义）
  const dueRemaining = (!loan.is_revolving && loan.due_date)
    ? Math.max(Math.round((new Date(loan.due_date) - baseDate) / (1000 * 60 * 60 * 24 * 30.44)), 1)
    : null;
  const limit = loan.credit_limit || loan.limit || bal;
  const blRatio = limit > 0 ? bal / limit : 1;

  // ── 消费金融 / 网贷（等额本息）──────────────────────────────
  if (cat === 'finance') {
    const r = 0.015; // 18%年化
    if (dueRemaining !== null) {
      // 有到期日：精确剩余期数
      return Math.round(bal * r / (1 - Math.pow(1 + r, -dueRemaining)));
    }
    if (elapsed !== null && elapsed >= 1) {
      // 无到期日：网贷默认12期，消费金融默认36期
      const totalPeriods = (loan.type === 'online' && loan.online_subtype !== 'online_bank') ? 12 : 36;
      const remaining = Math.max(totalPeriods - elapsed, 1);
      return Math.round(bal * r / (1 - Math.pow(1 + r, -remaining)));
    }
    return Math.round(bal * r / (1 - Math.pow(1 + r, -36)));
  }

  // ── 银行信用贷（credit）──────────────────────────────────────
  if (loan.is_revolving) return Math.round(bal * (0.045 / 12));

  const r = 0.045 / 12;
  if (elapsed !== null && elapsed >= 2) {
    if (blRatio > 0.97) {
      // 先息后本：2个月以上余额仍未减少，确认只付利息
      // elapsed<2时不能判断（新开贷款首期可能尚未到账）
      return Math.round(bal * (0.045 / 12));
    }
    // 等额本息：通过余额/额度/时间三参数反推实际期限，比 blRatio×36 更精准
    // 公式：(1+r)^T = (ratio - (1+r)^n) / (ratio - 1)
    const k = Math.pow(1 + r, elapsed);
    const A = (blRatio - k) / (blRatio - 1);
    if (A > 1) {
      const T = Math.log(A) / Math.log(1 + r);
      const remaining = Math.max(Math.round(T - elapsed), 1);
      return Math.round(bal * r / (1 - Math.pow(1 + r, -remaining)));
    }
    // 反推失败（已还大半）：用剩余余额直接估算
    const remaining = Math.max(Math.round(blRatio * 12), 1);
    return Math.round(bal * r / (1 - Math.pow(1 + r, -remaining)));
  }
  if (dueRemaining !== null) {
    return Math.round(bal * r / (1 - Math.pow(1 + r, -dueRemaining)));
  }
  // 新开贷款（elapsed<2）或无日期：按36期等额本息估算
  return Math.round(bal * r / (1 - Math.pow(1 + r, -36)));
}

function calcTotalMonthly(loans, cards) {
  const loanPart = loans.reduce((s, l) => s + calcLoanMonthly(l), 0);
  // 银行审批口径：信用卡按【已用额度×2%】折算月供（银行实际通用口径）
  const cardPart = cards.reduce((s, c) => s + Math.round(Math.max(0, c.used || 0) * 0.02), 0);
  return loanPart + cardPart;
}

// ═══════════════════════════════════════════
// 贷准风控 2.0 — ScoreEngine
// ═══════════════════════════════════════════
class ScoreEngine {
  constructor(ocrData, userInfo) {
    this.ocr  = ocrData  || {};
    this.ui   = userInfo || {};
    this.base = ocrData?.report_date ? new Date(ocrData.report_date) : new Date();
  }

  _mths(dateStr) {
    if (!dateStr) return null;
    return Math.max(0, Math.floor((this.base - new Date(dateStr)) / (1000 * 60 * 60 * 24 * 30.44)));
  }
  _mm(v, min, max, inv = false) {
    if (v === null || v === undefined) return 0.5;
    const n = (Math.max(min, Math.min(max, v)) - min) / (max - min);
    return inv ? 1 - n : n;
  }
  _tf(mths) { return Math.exp(-0.05 * (mths || 0)); }
  _sigmoid(score, hurdle, k) {
    return Math.round(100 / (1 + Math.exp(-k * (score - hurdle))));
  }

  extractFeatures() {
    const { ocr, ui, base } = this;
    const loans = (ocr.loans || []).filter(l => l.status !== '结清' && l.status !== '已结清');
    const cards = (ocr.cards || []).filter(c => c.status !== '销户' && c.status !== '已销户');
    const q   = calcQueryCounts(ocr.query_records || [], ocr.report_date);
    const q1m = q.q_1m || 0;
    const q3m = q.q_3m || 0;
    const q6m = q.q_6m || 0;

    const income  = ui.income || 0;
    const pvdRates = { gov:0.12, institution:0.12, state:0.11, listed:0.09, private:0.06, self:0.05, freelance:0.05 };
    const wKey = (() => {
      const w = ui.work || '';
      if (w.includes('公务员') || w.includes('政府')) return 'gov';
      if (w.includes('事业'))  return 'institution';
      if (w.includes('国有') || w.includes('央企')) return 'state';
      if (w.includes('上市') || w.includes('500强')) return 'listed';
      if (w.includes('个体')) return 'self';
      if (w.includes('自由')) return 'freelance';
      return 'private';
    })();
    const pvdTotal   = ui.provident || 0;
    const pvdIndiv   = pvdTotal / 2;
    const pvdRate    = pvdRates[wKey];
    const inferIncome = pvdIndiv > 0 ? Math.round(pvdIndiv / pvdRate) : income;
    // 非对称信任：HPF反推低于申报 ≠ 低报信号（民企最低基数缴纳极其普遍）
    // pvdMinBase: 双边合计 < 600 元/月，基本可确定是最低基数
    const pvdMinBase  = pvdTotal > 0 && pvdTotal < 600;
    // HPF反推显著高于申报（> 15%）：才是强信号（可能低报收入）
    const hpfHigher   = income > 0 && inferIncome > income * 1.15;
    const incDiff     = income > 0 && inferIncome > 0
      ? Math.abs(inferIncome - income) / Math.max(inferIncome, income) : 0;
    const trustScore  = pvdTotal === 0
      ? 50                                                                         // 无公积金：中性
      : pvdMinBase && !hpfHigher
        ? (incDiff < 0.3 ? 100 : 75)                                               // 最低基数：HPF信号弱，轻度折扣
        : hpfHigher
          ? (incDiff < 0.15 ? 100 : incDiff < 0.4 ? 60 : 20)                      // HPF反推高于申报：可疑
          : (incDiff < 0.2 ? 100 : incDiff < 0.4 ? 80 : incDiff < 0.8 ? 55 : 35); // 正常区间（HPF低于申报）：非对称软化
    const effIncome  = income > 0
      ? (trustScore >= 75 ? income : trustScore >= 40 ? Math.round(income * 0.8) : Math.round(income * 0.6)) : 0;

    const monthly    = calcTotalMonthly(loans, cards);
    const fixedExp   = ui.fixed_expense != null ? ui.fixed_expense : Math.round((income || 0) * 0.3);
    const disposable = Math.max(0, effIncome - fixedExp - monthly);

    const cLimit  = cards.reduce((s, c) => s + (c.limit || 0), 0);
    const cUsed   = cards.reduce((s, c) => s + (c.used  || 0), 0);
    const cardUtil = cLimit > 0 ? cUsed / cLimit : 0;

    const curOv   = (ocr.overdue_current || 0) > 0;
    const badRec  = ocr.has_bad_record || false;
    const ovNotes = (ocr.overdue_history_notes || '').toLowerCase();
    const lian3   = ovNotes.includes('连三') || ovNotes.includes('连续3');
    const lei6    = ovNotes.includes('累六') || ovNotes.includes('累计6');
    const ovCount = (() => { const m = ovNotes.match(/(\d+)笔/); return m ? parseInt(m[1]) : (ocr.has_overdue_history ? 1 : 0); })();
    const ov90d   = ocr.summary_overdue_90days || 0;
    const sumOv   = ocr.summary_overdue_accounts || 0;

    const allAcc  = [...loans, ...cards];
    const dates   = allAcc.map(a => a.issued_date).filter(Boolean).map(d => new Date(d));
    const earliest = dates.length ? new Date(Math.min(...dates)) : null;
    const accAge  = earliest ? this._mths(earliest.toISOString().split('T')[0]) : 0;
    const accHealth = allAcc.length > 0 ? (allAcc.length - sumOv) / allAcc.length : 1;
    const recent6mLoans = loans.filter(l => { const m = this._mths(l.issued_date); return m !== null && m <= 6; }).length;

    const onlineL = loans.filter(l => l.type === 'online');
    const onlineI = [...new Set(onlineL.map(l => l.name.split('-')[0]))].length;
    const cfI     = [...new Set(onlineL.filter(l => l.online_subtype === 'consumer_finance').map(l => l.name.split('-')[0]))].length;
    const cfConc  = onlineI > 0 ? cfI / onlineI : 0;
    const bankLR  = loans.length > 0 ? loans.filter(l => l.type === 'bank').length / loans.length : 0;
    const entropy = typeof calcInstitutionEntropy === 'function' ? calcInstitutionEntropy(loans) : 0;

    const latestOvMths = (() => {
      if (!ocr.has_overdue_history) return 999;
      const m = ovNotes.match(/(\d{4})年/);
      if (m) return Math.max(0, (base.getFullYear() - parseInt(m[1])) * 12);
      return 12;
    })();

    const loanMthls = loans.map(l => calcLoanMonthly(l)).filter(v => v > 0);
    const monthlyCV = (() => {
      if (loanMthls.length < 2) return 0;
      const mean = loanMthls.reduce((a, b) => a + b, 0) / loanMthls.length;
      const sd   = Math.sqrt(loanMthls.reduce((s, v) => s + (v - mean) ** 2, 0) / loanMthls.length);
      return mean > 0 ? sd / mean : 0;
    })();

    const age      = calcAgeFromId(window._personIdNo || ocr.id_number || '');
    const creditStartAge = (age && earliest) ? Math.max(18, Math.round(age - accAge / 12)) : null;
    const recent6mBal  = loans.filter(l => { const m = this._mths(l.issued_date); return m !== null && m <= 6; }).reduce((s, l) => s + (l.balance || 0), 0);
    const totalLoanBal = loans.reduce((s, l) => s + (l.balance || 0), 0);
    const netDebtTrend6m = totalLoanBal > 0 ? recent6mBal / totalLoanBal : 0;
    const cardLimits = cards.map(c => c.limit || 0).filter(v => v > 0);
    const cardTrend  = cardLimits.length > 1 ? Math.max(...cardLimits) / Math.min(...cardLimits) : 1;
    const dti      = effIncome > 0 ? monthly / effIncome : 1;
    const q30dConc = q3m > 0 ? q1m / q3m : 0;
    const socialMths = (() => {
      const s = ui.social || '';
      if (!s.includes('有')) return 0;
      const m = s.match(/已缴(\d+)月/); return m ? parseInt(m[1]) : 1;
    })();
    const wkScore  = { gov:1.0, institution:1.0, state:0.85, listed:0.72, private:0.55, self:0.42, freelance:0.38 }[wKey] || 0.5;
    const eduScore = (() => { const e = ui.edu||''; return e.includes('本科')?1.0:e.includes('大专')?0.75:e.includes('函授')?0.6:0.45; })();
    const hkScore  = (() => { const h = ui.hukou||''; return h.includes('厦门')?1.0:h.includes('福建')?0.72:h&&h!=='未填写'?0.42:0.5; })();
    const ageScore = (() => { if(!age)return 0.5; return(age>=28&&age<=45)?1.0:(age>=25&&age<=50)?0.8:0.65; })();
    const astStr   = ui.assets || '';
    const astScore = astStr.includes('房产')?1.0:astStr.includes('车辆')?0.65:astStr.includes('营业')?0.55:0.2;

    return {
      q1m, q3m, q6m, q30dConc,
      curOv, badRec, lian3, lei6, ovCount, ov90d, sumOv,
      accAge, accHealth, recent6mLoans, bankLR, cfConc,
      latestOvMths, entropy, cardUtil, monthlyCV,
      cardTrend, onlineI, dti, disposable, fixedExp,
      income, effIncome, monthly, trustScore, inferIncome,
      pvdTotal, pvdRate, pvdIndiv, socialMths,
      wkScore, eduScore, hkScore, ageScore, astScore,
      cLimit, cUsed, age, loans, cards,
      creditStartAge, netDebtTrend6m,
    };
  }

  runScoreEngine(f) {
    if (!f) f = this.extractFeatures();
    // ── 硬规则一票否决：当前逾期（M1+）→ 强制D级，跳过所有加权计算 ──
    if (f.curOv) {
      return {
        score: 300, rawScore: 300, penalty: 700, level: 'D', forcedD: true,
        domainScores: { credit: 0, stability: 0, asset: 0, fraud: 0 },
        features: f,
      };
    }
    // ── 权重归一化校验（开发期安全网）──
    if (typeof console !== 'undefined') {
      const _domainW = 0.40+0.30+0.25+0.05;
      if (Math.abs(_domainW - 1.0) > 1e-9) console.error(`[ScoreEngine] 域权重不归一: Σ=${_domainW}`);
      const _stW = 0.25+0.25+0.15+0.12+0.08+0.08+0.05+0.02;
      if (Math.abs(_stW - 1.0) > 1e-9) console.error(`[ScoreEngine] 稳定性权重不归一: Σ=${_stW}`);
      const _asW = 0.33+0.25+0.20+0.12+0.08+0.02;
      if (Math.abs(_asW - 1.0) > 1e-9) console.error(`[ScoreEngine] 资产权重不归一: Σ=${_asW}`);
      const _frW = 0.50+0.30+0.20;
      if (Math.abs(_frW - 1.0) > 1e-9) console.error(`[ScoreEngine] 反欺诈权重不归一: Σ=${_frW}`);
    }
    const mm = this._mm.bind(this);
    const tf = this._tf.bind(this);

    let penalty = 0;
    if (f.badRec)           penalty += 100;
    if (f.curOv)            penalty += 100;
    if (f.lian3 || f.lei6)  penalty += 80;
    if (f.ov90d > 0)        penalty += 80;
    penalty += Math.max(0, f.q3m - 3) * 20;
    penalty += f.ovCount * 50;
    // 网贷机构数递增惩罚：家数越多惩罚越重，14家≠5家
    if (f.onlineI >= 5) penalty += f.onlineI >= 12 ? 95 : f.onlineI >= 9 ? 70 : f.onlineI >= 7 ? 48 : 30;
    // 负债率递增惩罚：月还款超过月收入后额外惩罚（360%应远比130%严重）
    if (f.dti > 1.0 && f.effIncome > 0) penalty += Math.min(130, Math.round((f.dti - 1.0) * 80));

    const ovTf  = tf(f.latestOvMths);
    const cbW   = 0.10*tf(1)+0.06*tf(1)+0.04*tf(1)+0.14*ovTf+0.08*ovTf+0.08+0.06+0.06+0.06+0.05+0.06*tf(1)+0.06+0.06+0.04+0.03+0.06+0.06*tf(3);
    const cbRaw =
      mm(f.q3m,0,15,true)              *0.10*tf(1) +
      mm(f.q30dConc,0,1,true)           *0.06*tf(1) +
      mm(f.q6m,0,25,true)              *0.04*tf(1) +
      (f.ovCount===0?1:mm(f.ovCount,1,10,true))*0.14*ovTf +
      (f.ov90d===0?1:mm(f.ov90d,1,5,true))    *0.08*ovTf +
      mm(f.accHealth,0,1)               *0.08 +
      mm(f.accAge,0,180)                *0.06 +
      mm(f.bankLR,0,1)                  *0.06 +
      mm(f.cfConc,0,1,true)             *0.06 +
      mm(f.entropy,0,2.3)               *0.05 +
      mm(f.recent6mLoans,0,8,true)      *0.06*tf(1) +
      mm(f.cardUtil,0,1,true)            *0.06 +
      mm(f.onlineI,0,10,true)           *0.06 +
      mm(f.monthlyCV,0,2,true)           *0.04 +
      mm(f.cardTrend,1,5)               *0.03 +
      mm(f.latestOvMths,0,60)            *0.06 +
      mm(f.recent6mLoans,0,6,true)      *0.06*tf(3);
    const cbScore = cbW > 0 ? cbRaw / cbW : 0;

    const _creditStartAgeS = (() => {
      const a = f.creditStartAge;
      if (a === null) return 0.5;
      return a < 20 ? 0.4 : a <= 28 ? 0.9 : a <= 40 ? 1.0 : a <= 50 ? 0.7 : 0.5;
    })();
    const stMod = f.trustScore>=75?1.0:f.trustScore>=40?0.8:0.6;
    const stScore = (
      f.wkScore              *0.25 +
      mm(f.socialMths,0,36)  *0.25 +
      (f.trustScore/100)     *0.15 +
      f.eduScore             *0.12 +
      f.hkScore              *0.08 +
      f.ageScore             *0.08 +
      (f.pvdTotal>0?mm(f.pvdTotal,0,3000):0.3)*0.05 +
      _creditStartAgeS       *0.02
    ) * stMod;

    const asScore =
      mm(f.dti,0,1.2,true)                              *0.33 +
      (f.effIncome>0?mm(f.disposable,0,f.effIncome):0.5)*0.25 +
      f.astScore                                         *0.20 +
      mm(f.cardUtil,0,1,true)                            *0.12 +
      mm(f.fixedExp/Math.max(f.income||1,1),0,0.8,true)  *0.08 +
      mm(f.netDebtTrend6m,0,1,true)                      *0.02;

    const frScore =
      (f.badRec?0:1) *0.50 +
      (f.curOv?0:1)  *0.30 +
      mm(f.q30dConc,0,1,true)*0.20;

    const rawScore = 1000*(cbScore*0.40+stScore*0.30+asScore*0.25+frScore*0.05); // 保留浮点，XAI用
    const score    = Math.max(300, Math.min(1000, Math.round(rawScore) - penalty));
    const level    = score>=800?'A':score>=650?'B':score>=500?'C':'D';

    return {
      score, rawScore, penalty, level,
      domainScores: {
        credit:    +(cbScore*100).toFixed(1),
        stability: +(stScore*100).toFixed(1),
        asset:     +(asScore*100).toFixed(1),
        fraud:     +(frScore*100).toFixed(1),
      },
      features: f,
    };
  }

  _cf(baseF, issueKey) {
    const f = JSON.parse(JSON.stringify(baseF));
    switch (issueKey) {
      case 'queries':  f.q3m=Math.min(f.q3m,3);f.q1m=Math.min(f.q1m,1);f.q30dConc=Math.min(f.q30dConc,0.33);break;
      case 'overdue':  f.ovCount=0;f.latestOvMths=999;f.lian3=false;f.lei6=false;break;
      case 'online':   f.onlineI=Math.min(f.onlineI,2);f.cfConc=Math.min(f.cfConc,0.5);break;
      case 'cardutil': f.cardUtil=0.49;break;
      case 'dti':      f.dti=0.4;f.disposable=f.effIncome*0.6;break;
    }
    return this.runScoreEngine(f);
  }

  generateXAI(result, products) {
    // 硬规则触发：当前逾期强制D级，不做counterfactual计算
    if (result.forcedD) {
      const f = result.features || {};
      const ovCount = f.overdue_current || 1;
      return {
        score: 300, level: 'D',
        issues: [{
          icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
          tag: '当前逾期（一票否决）',
          desc: `征信显示当前有未结清逾期，银行系统自动拒贷`,
          cost: `所有银行信贷产品无法申请，通过率0%`,
          fix: `立即结清全部逾期账户（通常1-2周），结清后等1-3个月征信更新`,
          months: 3, gain: 500,
        }],
        passRates: [],
        features: f,
      };
    }
    const { score, level, features: f } = result;
    // gain 用未截断分数计算（避免 300 底线把所有差值压成 0）
    const _unclamp = r => r.rawScore - r.penalty;
    const _gain    = key => Math.round(_unclamp(this._cf(f, key)) - _unclamp(result));
    const issues = [];

    const _ico = {
      scan: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>`,
      net:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><line x1="12" y1="7" x2="5" y2="17"/><line x1="12" y1="7" x2="19" y2="17"/><line x1="5" y1="19" x2="19" y2="19"/></svg>`,
      card: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
      warn: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      down: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`,
    };
    if (f.q3m > 3) {
      const gain = _gain('queries');
      issues.push({ icon:_ico.scan, tag:'查询过多',
        desc:`近3月查询${f.q3m}次，超安全线${f.q3m-3}次`,
        cost:`拉低分数约${gain}分`, fix:`今天停止申请，3个月后自然降至安全线`, months:3, gain });
    }
    if (f.onlineI >= 3) {
      const gain = _gain('online');
      issues.push({ icon:_ico.net, tag:'网贷超标',
        desc:`网贷机构${f.onlineI}家，银行建议≤2家`,
        cost:`拉低分数约${gain}分`, fix:`结清${f.onlineI-2}家并注销账户`, months:2, gain });
    }
    if (f.cardUtil > 0.7) {
      const gain = _gain('cardutil');
      issues.push({ icon:_ico.card, tag:'信用卡爆额',
        desc:`信用卡使用率${Math.round(f.cardUtil*100)}%，建议控制在70%以下`,
        cost:`拉低分数约${gain}分`, fix:`还款降使用率，当月见效`, months:1, gain });
    }
    if (f.ovCount > 0 && !f.curOv) {
      const gain = _gain('overdue');
      issues.push({ icon:_ico.warn, tag:f.lian3?'连续逾期':'历史逾期',
        desc:`历史${f.ovCount}笔逾期${f.lian3?' (含连续3次)':''}`,
        cost:`拉低分数约${gain}分`, fix:`时间修复，距今越久银行容忍度越高`,
        months:Math.max(0,60-(f.latestOvMths||12)), gain });
    }
    if (f.dti > 0.5 && f.effIncome > 0) {
      const gain = _gain('dti');
      issues.push({ icon:_ico.down, tag:'负债率偏高',
        desc:`月还款占收入${Math.round(f.dti*100)}%，超银行50%上限`,
        cost:`拉低分数约${gain}分`, fix:`结清部分贷款，将负债率降至50%以下`, months:3, gain });
    }

    const passRates = (products||[]).map(p => ({
      id:p.id, bank:p.bank, product:p.product,
      rate: this._sigmoid(score, p.hurdle||600, p.k||0.025),
    })).sort((a,b)=>b.rate-a.rate);

    return { score, level, issues:issues.slice(0,4), passRates, features:f };
  }

  compute(products) {
    const f   = this.extractFeatures();
    const res = this.runScoreEngine(f);
    const xai = this.generateXAI(res, products);
    return { ...res, xai };
  }
}

// ═══════════════════════════════════════════
// FILE HANDLING
// ═══════════════════════════════════════════
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('uploadZone').classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
}

function handleFiles(files) {
  if (!files || !files.length) return;
  const arr = Array.from(files);

  // Check if any file is a PDF (use filename as primary check, MIME as fallback)
  const isPdfByName = (f) => f.name.toLowerCase().endsWith('.pdf');
  const isPdfByType = (f) => f.type && f.type.includes('pdf');
  const isPdf = (f) => isPdfByName(f) || isPdfByType(f);

  const pdfFile = arr.find(isPdf);
  if (pdfFile) {
    _processPdf(pdfFile);
    return;
  }

  // All images
  _processImages(arr.filter(f => f.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(f.name)));
}

function _processPdf(f) {
  const maxMB = 20;
  if (f.size > maxMB * 1024 * 1024) {
    alert(`文件过大（${(f.size/1024/1024).toFixed(1)}MB），请压缩至 ${maxMB}MB 以内后重试`);
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const result = ev.target.result;
    if (!result || result.indexOf(',') === -1) {
      alert('PDF 读取失败，请确认文件已完整下载到本机（iCloud 中的文件需先下载后再上传）');
      return;
    }
    const base64 = result.split(',')[1];
    if (!base64 || base64.length < 100) {
      alert('PDF 文件内容为空或损坏，请重新下载后再试');
      return;
    }
    _fileBlocks = [{ type:'document', source:{ type:'base64', media_type:'application/pdf', data: base64 } }];
    document.getElementById('fileInfo').classList.add('show');
    document.getElementById('fileIcon').innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
    document.getElementById('fileName').textContent = f.name.length > 30 ? f.name.substring(0,28)+'…' : f.name;
    document.getElementById('fileSize').textContent = (f.size/1024).toFixed(0) + ' KB';
    window._fileReady = true;
    const _cc = document.getElementById('consentCheck');
    document.getElementById('analyzeBtn').disabled = !(_cc && _cc.checked);
    document.getElementById('analyzeBtnText').textContent = '开始AI识别分析';
  };
  reader.onerror = () => {
    alert('文件读取失败，iOS 用户请确认：\n• PDF 已下载到本机（不是 iCloud 中的云文件）\n• 文件未损坏，可正常打开');
  };
  reader.readAsDataURL(f);
}

function _processImages(files) {
  if (!files.length) { alert('不支持的文件格式，请上传 PDF 或图片'); return; }
  const maxMB = 20;
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  if (totalSize > maxMB * 1024 * 1024) {
    alert(`文件总大小过大（${(totalSize/1024/1024).toFixed(1)}MB），请压缩至 ${maxMB}MB 以内后重试`);
    return;
  }

  const MAX_W = 1200, MAX_H = 1800; // 1200px对征信识别足够清晰
  let pending = files.length;
  const blocks = new Array(files.length);

  let failed = 0;
  function onOneDone() {
    if (pending > 0) return;
    const validBlocks = blocks.filter(Boolean);
    if (!validBlocks.length) {
      alert('图片读取全部失败，请重新选择后再试');
      return;
    }
    if (failed > 0) alert(`${failed}张图片读取失败，已跳过，将用剩余${validBlocks.length}张分析`);
    _fileBlocks = validBlocks;
    window._isAnalyzing = false;
    window._isMatching = false;
    const totalKB = validBlocks.reduce((s, b) => s + Math.round(b.source.data.length * 0.75 / 1024), 0);
    document.getElementById('fileInfo').classList.add('show');
    document.getElementById('fileIcon').innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    document.getElementById('fileName').textContent = validBlocks.length > 1
      ? `${validBlocks.length}张截图`
      : (files[0].name.length > 30 ? files[0].name.substring(0,28)+'…' : files[0].name);
    document.getElementById('fileSize').textContent = totalKB + ' KB（已压缩）';
    window._fileReady = true;
    const _cc2 = document.getElementById('consentCheck');
    document.getElementById('analyzeBtn').disabled = !(_cc2 && _cc2.checked);
    document.getElementById('analyzeBtnText').textContent = '开始AI识别分析';
  }

  files.forEach((f, i) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > MAX_W || h > MAX_H) {
          const r = Math.min(MAX_W / w, MAX_H / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const base64 = canvas.toDataURL('image/jpeg', 0.75).split(',')[1];
        blocks[i] = { type:'image', source:{ type:'base64', media_type:'image/jpeg', data: base64 } };
        pending--;
        onOneDone();
      };
      img.onerror = () => { failed++; pending--; onOneDone(); };
      img.src = ev.target.result;
    };
    reader.onerror = () => { failed++; pending--; onOneDone(); };
    reader.readAsDataURL(f);
  });
}

function clearFile() {
  _fileBlocks = [];
  window._isAnalyzing = false;
  window._isMatching = false;
  window._fileReady = false;
  document.getElementById('fileInfo').classList.remove('show');
  document.getElementById('fileInput').value = '';
  document.getElementById('analyzeBtn').disabled = true;
  document.getElementById('analyzeBtnText').textContent = '请先上传征信报告';
}

// ═══════════════════════════════════════════
// STEP 1: RECOGNITION
// ═══════════════════════════════════════════
async function startAnalysis() {
  if (!_fileBlocks.length) return;
  const _cc3 = document.getElementById('consentCheck');
  if (!_cc3 || !_cc3.checked) { alert('请先勾选同意《个人信息保护政策》及《征信数据分析授权协议》'); return; }
  if (window._isAnalyzing) return; // 状态锁，防重复触发
  window._isAnalyzing = true;
  // 安全兜底：60秒后强制释放锁（防止任何异常路径导致永久卡死）
  const _analyzeGuard = setTimeout(() => { window._isAnalyzing = false; }, 60000);

  // Show reading card
  document.getElementById('uploadCard').style.display = 'none';
  document.getElementById('readingCard').style.display = 'block';
  document.getElementById('resultArea').style.display = 'none';

  // 步骤动画：绑定真实进度（不用定时器假进度）
  const steps = ['rs1','rs2','rs3','rs4','rs5'];
  steps.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('active','done'); }
  });
  document.getElementById('rs1').classList.add('active');
  // 真实进度：rs1=开始识别 rs2=图片处理 rs3=AI分析 rs4=结构化 rs5=完成
  function setStep(n) {
    steps.forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (i < n) { el.classList.remove('active'); el.classList.add('done'); }
      else if (i === n) { el.classList.remove('done'); el.classList.add('active'); }
      else { el.classList.remove('active','done'); }
    });
  }
  setStep(0); // rs1激活

  // OCR期间自动推进中间步骤，避免卡在同一节点
  const _t1 = setTimeout(() => setStep(1), 800);   // rs2：提取账户
  const _t2 = setTimeout(() => setStep(2), 9000);  // rs3：过滤结清/销户
  const _t3 = setTimeout(() => setStep(3), 22000); // rs4：汇总数据

  try {
    // 用 SHA-256 对所有图片完整 base64 数据哈希，确保不同图片绝不碰撞
    const cacheKey = _fileBlocks.length > 0 ? await (async () => {
      const allData = _fileBlocks.map(b => b.source.data).join('|');
      const encoded = new TextEncoder().encode(allData);
      const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 48);
    })() : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(PROXY_URL + '/api/v1/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ fileBlocks: _fileBlocks, cacheKey }),
    });
    clearTimeout(timeout);
    clearTimeout(_t1); clearTimeout(_t2); clearTimeout(_t3);
    setStep(2); // API返回后至少到rs3

    const respText = await resp.text();
    if (!respText || !respText.trim()) throw new Error('服务器返回空响应，请压缩PDF后重试');

    let data;
    try { data = JSON.parse(respText); } catch(e) { throw new Error('响应格式异常，请重试'); }
    if (!resp.ok) throw new Error(data.error || `服务器错误 HTTP ${resp.status}`);
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message || 'API错误'));

    const raw = data.raw;
    setStep(3); // rs4：汇总有效负债与查询数据
    const extracted = extractJson(raw);
    if (!extracted) throw new Error('未能识别到征信数据，请确认是人行征信报告');

    _recognizedData = extracted;
    _trackEvent('ocr_complete', { loans: (extracted.loans||[]).length, cards: (extracted.cards||[]).length });

    // Finish steps animation
    steps.forEach(id => {
      document.getElementById(id).classList.remove('active');
      document.getElementById(id).classList.add('done');
    });

    setStep(4); // rs5：准备AI产品匹配（完成）
    // 立即释放锁（OCR数据已拿到，不需要等动画），清除安全兜底计时器
    window._isAnalyzing = false;
    clearTimeout(_analyzeGuard);
    setTimeout(() => {
      document.getElementById('readingCard').style.display = 'none';
      renderResult(extracted);
    }, 600);

  } catch(e) {
    window._isAnalyzing = false;
    clearTimeout(_analyzeGuard);
    clearTimeout(_t1); clearTimeout(_t2); clearTimeout(_t3);
    document.getElementById('readingCard').style.display = 'none';
    document.getElementById('uploadCard').style.display = 'block';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtnText').textContent = '重新分析';

    let errMsg = e.message || '';
    let userMsg = '';
    if (e.name === 'AbortError' || errMsg === 'signal is aborted without reason') {
      userMsg = '识别超时（超过120秒）\n\n可能原因：\n• PDF文件过大，建议压缩至5MB以内\n• 当前网络较慢，请稍后重试';
    } else if (errMsg === 'Failed to fetch' || errMsg === 'Load failed' || errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('NetworkError')) {
      userMsg = '网络连接失败\n\n可能原因：\n• 网络不稳定，请检查网络后重试\n• 服务暂时不可用，请稍候1-2分钟再试';
    } else if (errMsg.includes('HTTP 4') || errMsg.includes('HTTP 5')) {
      userMsg = '服务器返回错误：' + errMsg + '\n\n请稍候片刻后重试';
    } else if (errMsg.includes('未能识别') || errMsg.includes('征信数据')) {
      userMsg = '未能识别到征信数据\n\n请确认：\n• 上传的是人行个人信用报告\n• 图片/PDF 清晰可读，非加密文件';
    } else {
      userMsg = '识别失败：' + errMsg + '\n\n请稍后重试，如持续失败请联系客服';
    }
    alert(userMsg);
  }
}


// ═══════════════════════════════════════════
// QUERY COUNT CALCULATOR (frontend, exact)
// ═══════════════════════════════════════════
function calcQueryCounts(queryRecords, baseDate) {
  // 优先用征信报告日期作为基准，没有则用今天
  // baseDate 可外部传入，或自动读取已识别数据的报告日期
  const reportDateStr = baseDate || _recognizedData?.report_date;
  const base = reportDateStr ? new Date(reportDateStr) : new Date();
  base.setHours(0, 0, 0, 0);

  const monthsAgo = (m) => {
    const d = new Date(base);
    d.setMonth(d.getMonth() - m);
    return d;
  };

  const cutoff1m  = monthsAgo(1);
  const cutoff3m  = monthsAgo(3);
  const cutoff6m  = monthsAgo(6);
  const cutoff12m = monthsAgo(12);

  const APPLY_TYPES = new Set(['贷款审批','信用卡审批','担保资格审查','资信审查','保前审查','融资租赁审批']);
  let q_1m = 0, q_3m = 0, q_6m = 0, q_12m = 0;

  (queryRecords || []).forEach(r => {
    if (!r.date || !r.type) return;
    if (!APPLY_TYPES.has(r.type)) return;
    const d = new Date(r.date);
    d.setHours(0, 0, 0, 0);

    if (d >= cutoff1m)  q_1m++;
    if (d >= cutoff3m)  q_3m++;
    if (d >= cutoff6m)  q_6m++;
    if (d >= cutoff12m) q_12m++;
  });

  return { q_1m, q_3m, q_6m, q_12m };
}

// ═══════════════════════════════════════════
// RENDER RECOGNITION RESULT
// ═══════════════════════════════════════════
function fmt(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('zh-CN');
}

function shortenBankName(name) {
  if (!name) return '--';
  return name
    .replace(/中国民生银行股份有限公司/g, '民生银行')
    .replace(/上海浦东发展银行股份有限公司/g, '浦发银行')
    .replace(/中国农业银行股份有限公司/g, '农业银行')
    .replace(/中国工商银行股份有限公司/g, '工商银行')
    .replace(/中国建设银行股份有限公司/g, '建设银行')
    .replace(/中国邮政储蓄银行股份有限公司/g, '邮储银行')
    .replace(/交通银行股份有限公司/g, '交通银行')
    .replace(/招商银行股份有限公司/g, '招商银行')
    .replace(/兴业银行股份有限公司/g, '兴业银行')
    .replace(/平安银行股份有限公司/g, '平安银行')
    .replace(/中信银行股份有限公司/g, '中信银行')
    .replace(/光大银行股份有限公司/g, '光大银行')
    .replace(/华夏银行股份有限公司/g, '华夏银行')
    .replace(/广发银行股份有限公司/g, '广发银行')
    .replace(/浦发银行股份有限公司/g, '浦发银行')
    .replace(/民生银行股份有限公司/g, '民生银行')
    .replace(/北京阳光消费金融股份有限公司/g, '阳光消费金融')
    .replace(/马上消费金融股份有限公司/g, '马上消费金融')
    .replace(/招联消费金融有限公司/g, '招联消费金融')
    .replace(/股份有限公司|有限责任公司|有限公司|股份公司/g, '')
    .replace(/信用卡中心/g, '')
    .replace(/(?:厦门市|厦门|上海|北京|广州|深圳|重庆|成都|武汉|南京|杭州|西安|天津|苏州|郑州|长沙|宁波|青岛|济南|福州|合肥|福建)(?:市)?分行/g, '')
    .replace(/其他个人消费贷款/g, '个消')
    .replace(/个人消费贷款/g, '个消')
    .replace(/个人经营性贷款/g, '个经')
    .replace(/个人经营贷款/g, '个经')
    .replace(/\s+/g, '')
    .trim();
}

function renderResult(data) {
  // Filter: remove settled loans and cancelled cards
  const loans = getActiveLoans(data);
  const cards = getActiveCards(data);

  // Calculate query counts from raw records (frontend, exact date math)
  const q = calcQueryCounts(data.query_records || []);

  // Summary bar - 月供估算（银行风控规则）
  const totalMonthly = calcTotalMonthly(loans, cards);
  const hasOvHistForType = data.has_overdue_history || (data.summary_overdue_accounts||0) > 0;

  document.getElementById('sumLoans').textContent = loans.length;
  document.getElementById('sumCards').textContent = cards.length;
  document.getElementById('sumMonthly').textContent = totalMonthly > 0 ? '≈ ' + fmt(Math.round(totalMonthly)) + ' 元' : '--';
  document.getElementById('sumDebtRatio').textContent = '--';
  document.getElementById('sumDebtRatio').style.color = 'var(--accentB)';
  // 渲染基础评分 + 爆查风险
  renderCreditScore(data, null);
  renderBlastRisk(data);
  document.getElementById('sumDebtHint').textContent = '填写月收入后显示';
  // sumTotalDebt：当前负债 = 贷款余额合计 + 信用卡已用额度合计
  const totalLoanBalance = loans.reduce((s, l) => s + (l.balance || 0), 0);
  const totalCardUsed = cards.reduce((s, c) => s + (c.used || 0), 0);
  const totalDebt = totalLoanBalance + totalCardUsed;
  const sumTotalDebtEl = document.getElementById('sumTotalDebt');
  if (sumTotalDebtEl) sumTotalDebtEl.textContent = totalDebt > 0 ? fmt(Math.round(totalDebt)) + ' 元' : '--';
  // sumOnlineInst：网贷机构数（按机构去重）
  const sumOnlineInstEl = document.getElementById('sumOnlineInst');
  if (sumOnlineInstEl) {
    const _onlineL2 = loans.filter(l => l.type === 'online');
    const _onlineInstCnt2 = [...new Set(_onlineL2.map(l => l.name.split('-')[0]))].length;
    sumOnlineInstEl.textContent = _onlineInstCnt2;
    sumOnlineInstEl.style.color = _onlineInstCnt2 >= 5 ? 'var(--danger)' : _onlineInstCnt2 >= 3 ? 'var(--warn)' : 'var(--success)';
  }

  // Warn/notice boxes — reset first
  document.getElementById('warnBox').style.display = 'none';
  document.getElementById('warnBox').innerHTML = '';
  document.getElementById('onlineStatsBox').style.display = 'none';
  document.getElementById('onlineStatsBox').innerHTML = '';
  const warns = [];
  if (data.overdue_current > 0) {
    warns.push('存在 <strong>' + data.overdue_current + ' 笔</strong>当前逾期，银行不会放款，请立即结清');
  }
  // 不良记录警告（呆账/担保代还等）
  if (data.has_bad_record === true) {
    const _badDesc = data.bad_record_notes && data.bad_record_notes !== '无'
      ? data.bad_record_notes
      : '请检查征信详情';
    warns.push('存在严重不良记录：<strong>' + _badDesc + '</strong>。此类记录将导致所有银行产品无法申请，需优先处理');
  }

  // 历史逾期警告
  if (data.overdue_history_notes && data.overdue_history_notes !== '无') {
    warns.push('历史逾期记录（已结清）：' + data.overdue_history_notes + '。<strong>结清后6-12个月内</strong>部分银行仍会拒贷');
  }

  // OCR识别质量警告
  if ((data.ocr_warnings || []).length > 0) {
    data.ocr_warnings.forEach(w => {
      warns.push('识别提示：' + w + '，请核对上方数据是否准确，如有误请重新上传');
    });
  }

  // Query warnings
  const q3total = q.q_3m || 0;
  const q6total = q.q_6m || 0;

  if (q3total >= 5) warns.push('近3月申请类查询 <strong>' + q3total + ' 次</strong>，征信已花，建议暂停申请养3-6个月');
  else if (q3total >= 3) warns.push('近3月申请类查询 <strong>' + q3total + ' 次</strong>，偏多，部分银行可能拒贷');

  // 信用卡综合使用率警告
  const _cardLimitTotal = cards.reduce((s, c) => s + (c.limit || 0), 0);
  const _cardUsedTotal  = cards.reduce((s, c) => s + (c.used || 0), 0);
  const _cardUtil = _cardLimitTotal > 0 ? Math.round(_cardUsedTotal / _cardLimitTotal * 100) : 0;
  if (_cardUtil > 70) warns.push('信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，超过70%警戒线，银行审批将直接降分或拒贷');
  else if (_cardUtil > 50) warns.push('信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，超过50%预警线，建议降低至50%以下');
  else if (_cardUtil > 0) warns.push('信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，处于安全范围');

  // 网贷机构数统计（按机构去重）
  const onlineLoans = loans.filter(l => l.type === 'online');
  const onlineCount = onlineLoans.length;
  const cfInstitutions  = [...new Set(onlineLoans.filter(l => l.online_subtype === 'consumer_finance').map(l => l.name.split('-')[0]))];
  const mlInstitutions  = [...new Set(onlineLoans.filter(l => l.online_subtype === 'microloan').map(l => l.name.split('-')[0]))];
  const obInstitutions  = [...new Set(onlineLoans.filter(l => l.online_subtype === 'online_bank').map(l => l.name.split('-')[0]))];
  const allOnlineInst   = [...new Set(onlineLoans.map(l => l.name.split('-')[0]))];
  const cfCount  = cfInstitutions.length;
  const mlCount  = mlInstitutions.length;
  const obCount  = obInstitutions.length;
  const onlineInstTotal = allOnlineInst.length;
  window._onlineInstTotal = onlineInstTotal;

  // 网贷机构统计栏（独立显示，带颜色区分）
  const osb = document.getElementById('onlineStatsBox');
  if (onlineInstTotal > 0) {
    const parts = [];
    if (cfCount > 0) parts.push('消费金融 <strong>' + cfCount + ' 家</strong>（' + cfInstitutions.join('、') + '）');
    if (mlCount > 0) parts.push('小额贷款 <strong>' + mlCount + ' 家</strong>（' + mlInstitutions.join('、') + '）');
    if (obCount > 0) parts.push('助贷银行 <strong>' + obCount + ' 家</strong>（' + obInstitutions.join('、') + '）');
    const breakdown = parts.join('&nbsp;+&nbsp;');
    const totalStr  = '网贷机构合计 <strong>' + onlineInstTotal + ' 家</strong>（银行准入红线：≤4家）';
    if (onlineInstTotal >= 5) {
      osb.style.cssText = 'display:block;padding:12px 14px;margin-bottom:12px;font-size:12px;line-height:1.8;border:1px solid rgba(231,76,60,0.25);border-left:2px solid var(--danger);background:rgba(231,76,60,0.06);color:var(--plat)';
      osb.innerHTML = '<span style="color:var(--danger);font-weight:600">' + totalStr + '</span><br>' + breakdown + '<br><span style="color:var(--danger)">已超红线，银行类贷款大概率拒贷，建议先结清网贷后再申请。</span>';
    } else if (onlineInstTotal === 3 || onlineInstTotal === 4) {
      osb.style.cssText = 'display:block;padding:12px 14px;margin-bottom:12px;font-size:12px;line-height:1.8;border:1px solid rgba(217,128,0,0.25);border-left:2px solid var(--warn);background:rgba(217,128,0,0.06);color:var(--plat)';
      osb.innerHTML = '<span style="color:var(--warn);font-weight:600">' + totalStr + '</span><br>' + breakdown + '<br><span style="color:var(--warn)">轻度警示，申请银行贷款存在风险，建议结清至2家以内再申请。</span>';
    } else {
      osb.style.cssText = 'display:block;padding:12px 14px;margin-bottom:12px;font-size:12px;line-height:1.8;border:1px solid rgba(12,184,122,0.2);border-left:2px solid var(--success);background:rgba(12,184,122,0.06);color:var(--plat)';
      osb.innerHTML = '<span style="color:var(--success);font-weight:600">' + totalStr + '</span><br>' + breakdown + '<br><span style="color:var(--success)">未超银行准入红线，网贷情况正常。</span>';
    }
  } else {
    osb.style.display = 'none';
  }

  if (warns.length > 0) {
    document.getElementById('warnBox').style.display = 'block';
    document.getElementById('warnBox').innerHTML = warns.map(w => `<div class="warn-item">${w}</div>`).join('');
  }

  // Loans table — split into two visual groups: regular loans vs revolving credit
  if (loans.length > 0) {
    document.getElementById('loansSection').style.display = 'block';
    document.getElementById('loanCount').textContent = loans.length;

    // Update table header - 3 amount columns: 授信额度 / 余额 / 月还款
    document.querySelector('#loansSection thead tr').innerHTML = `
      <th>机构</th>
      <th>类型</th>
      <th style="text-align:right">授信额度</th>
      <th style="text-align:right">余额</th>
      <th style="text-align:right">月还款</th>
      <th style="text-align:center">开立日期</th>
      <th style="text-align:center">状态</th>
    `;

    document.getElementById('loansBody').innerHTML = loans.map(l => {
      const isRev = l.is_revolving;
      // 3 separate columns: 授信额度 / 余额 / 月还款
      const colLimit   = l.credit_limit != null ? fmt(l.credit_limit) + '元' : '<span style="color:var(--muted)">--</span>';
      const colBalance = l.balance != null      ? fmt(l.balance) + '元'      : '<span style="color:var(--muted)">--</span>';
      const estMonthly = calcLoanMonthly(l);
      const colMonthly = estMonthly > 0
        ? fmt(estMonthly) + '元<span style="font-size:9px;color:var(--muted);margin-left:3px">估算</span>'
        : '<span style="color:var(--muted)">--</span>';
      const catMap = { mortgage:'房贷', car:'车贷', credit:'银行信用贷', finance:'网贷' };
      let catLabel, badgeCls;
      if (l.type === 'online') {
        catLabel   = l.online_subtype === 'microloan' ? '小额贷款'
                   : l.online_subtype === 'online_bank' ? '助贷银行'
                   : '消费金融';
        badgeCls   = 'badge-warn';
      } else {
        catLabel = catMap[l.loan_category] || '银行贷款';
        badgeCls = 'badge-ok';
      }

      const issuedFmt = (() => {
        if (!l.issued_date) return '<span style="color:var(--muted)">--</span>';
        const d = new Date(l.issued_date);
        if (isNaN(d)) return '<span style="color:var(--muted)">--</span>';
        return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
      })();
      return `
        <tr>
          <td>${shortenBankName(l.name)}${isRev ? '<span style="font-size:9px;background:rgba(12,184,122,0.1);color:var(--success);padding:1px 5px;margin-left:5px">循环授信</span>' : ''}</td>
          <td><span class="badge ${badgeCls}">${catLabel}</span></td>
          <td style="text-align:right;font-weight:600">${colLimit}</td>
          <td style="text-align:right;font-weight:600">${colBalance}</td>
          <td style="text-align:right">${colMonthly}</td>
          <td style="text-align:center;font-size:12px;color:var(--silver)">${issuedFmt}</td>
          <td style="text-align:center"><span class="badge ${l.status === '正常' ? 'badge-ok' : 'badge-bad'}">${l.status || '--'}</span></td>
        </tr>
      `;
    }).join('');
  }

  // Cards table
  if (cards.length > 0) {
    document.getElementById('cardsSection').style.display = 'block';
    document.getElementById('cardCount').textContent = cards.length;
    document.getElementById('cardsBody').innerHTML = cards.map(c => {
      const util = c.limit > 0 ? Math.round((c.used || 0) / c.limit * 100) : null;
      const utilColor = util == null ? 'var(--white)' : util <= 30 ? 'var(--success)' : util <= 70 ? 'var(--warn)' : 'var(--danger)';
      return `
        <tr>
          <td>${shortenBankName(c.name)}</td>
          <td style="text-align:right">${c.limit ? fmt(c.limit) + '元' : '--'}</td>
          <td style="text-align:right">${c.used != null ? fmt(c.used) + '元' : '--'}</td>
          <td style="text-align:right;font-weight:600;color:${utilColor}">${util != null ? util + '%' : '--'}</td>
          <td style="text-align:center"><span class="badge ${c.status === '正常' ? 'badge-ok' : 'badge-bad'}">${c.status || '--'}</span></td>
        </tr>
      `;
    }).join('');
  }

  // Query section — only show if there are actual query records
  if ((data.query_records || []).length > 0) {
    document.getElementById('querySection').style.display = 'block';
    const items = [
      { label: '申请类查询 近1月', val: q.q_1m,  ok: v => v <= 1, warn: v => v <= 2 },
      { label: '申请类查询 近3月', val: q.q_3m,  ok: v => v <= 3, warn: v => v <= 6 },
      { label: '申请类查询 近6月', val: q.q_6m,  ok: v => v <= 6, warn: v => v <= 12 },
      { label: '申请类查询 近1年', val: q.q_12m, ok: v => v <= 12, warn: v => v <= 18 },
    ];
    document.getElementById('queryGrid').innerHTML = items.map(item => {
      const v = item.val;
      const state = v == null ? 'neutral' : item.ok(v) ? 'ok' : item.warn(v) ? 'warn' : 'bad';
      const clr = {ok:'var(--success)',warn:'var(--warn)',bad:'var(--danger)',neutral:'var(--muted)'}[state];
      const statusTxt = {ok:'正常',warn:'偏多',bad:'超标',neutral:'--'}[state];
      // bar: max reference is warn boundary
      const cap = item.label.includes('1年') ? 18 : item.label.includes('6月') ? 12 : item.label.includes('3月') ? 6 : 2;
      const barPct = v != null ? Math.min(100, Math.round(v / cap * 100)) : 0;
      const parts = item.label.split(' ');
      const period = parts[parts.length - 1];
      const type   = parts.slice(0, -1).join(' ');
      return `<div class="qi-card"><div class="qi-head"><span class="qi-type">${type}</span><span class="qi-period">${period}</span></div><div class="qi-num" style="color:${clr}">${v != null ? v : '--'}<span style="font-size:12px;color:var(--muted);font-weight:400;margin-left:3px">次</span></div><div class="qi-bar-track"><div class="qi-bar-fill" style="width:${barPct}%;background:${clr}"></div></div><div class="qi-status" style="color:${clr}">${statusTxt}</div></div>`;
    }).join('');
  }

  // Empty state
  if (loans.length === 0 && cards.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('matchBtn').style.display = 'none';
  }

  // 指标格数字动画
  document.querySelectorAll('#summaryBar .mval').forEach(el => {
    el.classList.remove('updated');
    void el.offsetWidth; // reflow
    el.classList.add('updated');
  });

  // Render ID info bar
  renderIdInfo(data);

  // Render table footers with totals
  renderTableFooters(loans, cards);

  document.getElementById('resultArea').style.display = 'block';
  document.getElementById('resultArea').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ═══════════════════════════════════════════
// STEP 2: PRODUCT MATCHING
// ═══════════════════════════════════════════
async function startMatching() {
  if (window._isMatching) return;
  window._isMatching = true;
  // 安全兜底：90秒后强制释放（匹配最长不超过这个时间）
  const _matchGuard = setTimeout(() => { window._isMatching = false; }, 90000);
  let mlTimer;

  document.getElementById('infoCard').style.display = 'none';
  document.getElementById('matchingCard').style.display = 'block';
  // 每次进入都重置终端动画区域（rematch 后复用）
  document.getElementById('matchingLoading').style.display = 'block';
  const _tl = document.getElementById('termLog');
  if (_tl) _tl.innerHTML = '<div class="term-scan"></div>';
  const _tc = document.getElementById('termDimCount');
  if (_tc) _tc.textContent = '0 / 102';
  const _ts = document.getElementById('termStatus');
  if (_ts) _ts.textContent = 'BOOTING...';
  const _tb = document.getElementById('termBar');
  if (_tb) { _tb.style.width = '0%'; _tb.style.background = ''; }
  // 更新综合评分
  try { renderCreditScore(_recognizedData||{}, collectInfoData()); } catch(e){}
  document.getElementById('incomeWarnBanner').style.display = 'none'; // reset
  document.getElementById('matchingCard').scrollIntoView({ behavior:'smooth', block:'start' });

  // ── 终端风格加载动画 ──
  const _TERM_DIMS = [
    { code:'QRY-01', label:'近30天查询频次分布' },
    { code:'QRY-03', label:'查询机构类型集中度' },
    { code:'QRY-07', label:'近3月爆查风险系数' },
    { code:'QRY-11', label:'查询时间衰减权重Ti' },
    { code:'CRD-02', label:'信用账户存续时长' },
    { code:'CRD-06', label:'信用卡额度使用率CVR' },
    { code:'CRD-09', label:'循环授信余额变动趋势' },
    { code:'CRD-15', label:'信用行为时间叙事维度' },
    { code:'OVD-01', label:'当前逾期一票否决核查' },
    { code:'OVD-04', label:'历史逾期时间衰减 λ=0.05' },
    { code:'OVD-08', label:'连三/累六特征检测' },
    { code:'DBT-02', label:'月还款/收入比 DTI' },
    { code:'DBT-06', label:'网贷机构暴露度' },
    { code:'DBT-11', label:'消费金融负债集中度' },
    { code:'DBT-14', label:'银行/网贷结构比' },
    { code:'STB-01', label:'社保月数代理工龄' },
    { code:'STB-05', label:'公积金缴存稳定性' },
    { code:'STB-08', label:'就业类型风险系数Wi' },
    { code:'STB-12', label:'户籍地区准入加权' },
    { code:'AST-03', label:'资产覆盖比 ACR' },
    { code:'AST-07', label:'房产 LTV 估算' },
    { code:'AST-11', label:'有效收入可信度 Tc' },
    { code:'AST-18', label:'公积金反推收入校验' },
    { code:'ENT-01', label:'机构多样性 Shannon 熵' },
    { code:'ENT-04', label:'负债结构优化空间' },
    { code:'FRD-02', label:'身份一致性核验' },
    { code:'FRD-06', label:'多头借贷风险指数' },
    { code:'PRD-01', label:'银行准入阈值匹配' },
    { code:'PRD-06', label:'Sigmoid 通过率估算' },
    { code:'V2-102', label:'动态加权综合评分' },
  ];
  const _termLog    = document.getElementById('termLog');
  const _termBar    = document.getElementById('termBar');
  const _termStatus = document.getElementById('termStatus');
  const _termCount  = document.getElementById('termDimCount');
  const _TERM_TOTAL = 102;
  const _TERM_DELAY = 210; // ms per dimension（30维×210ms≈6.3s，加预热约7s总时长）
  const _VISIBLE    = 7;  // rows visible in log window
  let _termRows = [];
  let _termIdx  = 0;
  let _termBooting = true; // 预热阶段：前700ms只显示BOOTING，不滚动行

  // 预热阶段：显示启动文字，700ms后开始正式滚动
  if (_termStatus) _termStatus.textContent = 'BOOTING...';
  const _bootLines = [
    { code:'SYS', label:'Loading risk analysis engine v2.0', delay:80  },
    { code:'SYS', label:'Parsing credit report structure...',  delay:220 },
    { code:'SYS', label:'Verifying data integrity checksum',   delay:400 },
    { code:'SYS', label:'Pipeline ready — starting scan',      delay:580 },
  ];
  _bootLines.forEach(({code, label, delay}) => {
    setTimeout(() => {
      if (!_termLog) return;
      const row = document.createElement('div');
      row.className = 'term-row ok';
      row.innerHTML = `<span class="term-code">${code}</span><span class="term-label">&nbsp;${label}</span><span class="term-state">OK</span>`;
      _termLog.appendChild(row);
    }, delay);
  });
  setTimeout(() => {
    _termBooting = false;
    if (_termStatus) _termStatus.textContent = 'INITIALIZING';
  }, 700);

  function _termTick() {
    if (!_termLog || _termBooting) return;
    if (_termIdx > 0 && _termRows.length > 0) {
      const _prev = _termRows[_termRows.length - 1];
      _prev.className = 'term-row ok';
      _prev.querySelector('.term-state').textContent = 'OK';
    }
    if (_termIdx >= _TERM_DIMS.length) return;
    const dim = _TERM_DIMS[_termIdx];
    const simCount = Math.round((_termIdx / (_TERM_DIMS.length - 1)) * (_TERM_TOTAL - 8)) + _termIdx + 1;
    if (_termCount) _termCount.textContent = Math.min(simCount, _TERM_TOTAL) + ' / ' + _TERM_TOTAL;
    if (_termBar)   _termBar.style.width   = Math.round(_termIdx / _TERM_DIMS.length * 92) + '%';
    if (_termStatus) _termStatus.textContent = 'SCANNING ' + dim.code;

    const row = document.createElement('div');
    row.className = 'term-row active';
    row.innerHTML = `<span class="term-code">${dim.code}</span><span class="term-label">&nbsp;${dim.label}</span><span class="term-state">···</span>`;
    _termLog.appendChild(row);
    _termRows.push(row);

    // 超出可见行时移除最旧的
    if (_termRows.length > _VISIBLE) {
      const old = _termRows.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    _termIdx++;
  }

  const data = _recognizedData || { loans:[], cards:[], query_records:[] };
  const loans = getActiveLoans(data);
  const cards = getActiveCards(data);
  const q = calcQueryCounts(data.query_records || []);

  const totalMonthly = calcTotalMonthly(loans, cards);

  // 月收入未填时警告（无法计算负债率，maxDebt检查全部失效）
  const _incomeCheck = (() => { try { return collectInfoData().income || 0; } catch(e) { return 0; } })();
  if (_incomeCheck === 0 && (loans.length > 0 || cards.length > 0)) {
    const _warn = document.getElementById('incomeWarnBanner');
    if (_warn) _warn.style.display = 'block';
  }

  const onlineLoansM = loans.filter(l => l.type === 'online');
  const onlineCount  = onlineLoansM.length;  // 笔数（用于原有产品评分）
  const onlineInstTotal = window._onlineInstTotal
    ?? [...new Set(onlineLoansM.map(l => l.name.split('-')[0]))].length;
  const cfCount2 = [...new Set(onlineLoansM.filter(l => l.online_subtype==='consumer_finance').map(l=>l.name.split('-')[0]))].length;
  const mlCount2 = [...new Set(onlineLoansM.filter(l => l.online_subtype==='microloan').map(l=>l.name.split('-')[0]))].length;
  const obCount2 = [...new Set(onlineLoansM.filter(l => l.online_subtype==='online_bank').map(l=>l.name.split('-')[0]))].length;
  const totalCardLimit = cards.reduce((s, c) => s + (c.limit || 0), 0);
  const totalCardUsed = cards.reduce((s, c) => s + (c.used || 0), 0);
  const cardUtil = totalCardLimit > 0 ? Math.round(totalCardUsed / totalCardLimit * 100) : 0;
  const q3 = q.q_3m || 0;
  const q6 = q.q_6m || 0;

  const loanDesc = loans.map((l, i) => {
    const limitStr   = l.credit_limit != null ? fmt(l.credit_limit)+'元' : '--';
    const balStr     = l.balance != null      ? fmt(l.balance)+'元'      : '--';
    const monthlyStr = l.monthly != null      ? fmt(l.monthly)+'元'      : '--';
    return `${i+1}. ${l.name}${l.is_revolving?' [循环授信]':''}：授信额度${limitStr}，余额${balStr}，月还款${monthlyStr}，状态：${l.status || '正常'}`;
  }).join('\n') || '无贷款账户';

  const cardDesc = cards.map((c, i) => {
    const util = c.limit > 0 ? Math.round((c.used || 0) / c.limit * 100) : null;
    return `${i+1}. ${c.name}：额度${c.limit ? fmt(c.limit)+'元' : '未知'}，已用${c.used != null ? fmt(c.used)+'元' : '未知'}${util != null ? '，使用率'+util+'%' : ''}，状态：${c.status || '正常'}`;
  }).join('\n') || '无信用卡账户';

  // Collect user-filled info
  const userInfo = collectInfoData();
  const incomeStr     = userInfo.income ? userInfo.income + '元/月' : '未填写';
  const debtRatioPct  = userInfo.income && totalMonthly > 0
    ? Math.round(totalMonthly / userInfo.income * 100)
    : null;
  const debtRatio     = debtRatioPct != null ? debtRatioPct + '%' : '未知（未填收入）';

  // 解析社保月数
  const socialMonthsMatch = (userInfo.social || '').match(/已缴(\d+)月/);
  const socialMonths = socialMonthsMatch ? parseInt(socialMonthsMatch[1]) : (userInfo.social.includes('有缴纳') ? 6 : 0);
  const socialStr = userInfo.social.includes('有缴纳')
    ? `有缴纳，已缴${socialMonths}个月`
    : (userInfo.social.includes('无缴纳') ? '无缴纳（0个月）' : '未填写');

  // 补充信息加减分评估
  const scoreItems = [];
  const eduVal = userInfo.edu || '';
  if (eduVal.includes('本科')) scoreItems.push('+ 学历加分：全日制本科及以上');
  else if (eduVal.includes('大专')) scoreItems.push('+学历中性：全日制大专');
  else if (eduVal) scoreItems.push('-学历减分：' + eduVal);

  const workVal = userInfo.work || '';
  if (['政府机关/公务员','事业单位'].some(w => workVal.includes(w.split('/')[0]))) scoreItems.push('+ 单位加分：' + workVal);
  else if (['国有企业','上市公司'].some(w => workVal.includes(w.split('/')[0]))) scoreItems.push('+ 单位加分：' + workVal);
  else if (workVal && workVal !== '未填写') scoreItems.push('-单位中性/减分：' + workVal);

  const pvd = userInfo.provident || 0;
  if (pvd >= 1000) scoreItems.push('+ 公积金加分：' + pvd + '元/月（≥1000元，满足股份制银行优质客户准入）');
  else if (pvd >= 500) scoreItems.push('+公积金中性：' + pvd + '元/月（500-999元）');
  else if (pvd > 0) scoreItems.push('-公积金较低：' + pvd + '元/月（<500元）');
  else scoreItems.push('-无公积金（优质产品准入受限）');

  if (socialMonths >= 12) scoreItems.push('+ 社保加分：已缴' + socialMonths + '个月（≥12月，银行判定工作稳定）');
  else if (socialMonths >= 6) scoreItems.push('+社保中性：已缴' + socialMonths + '个月（6-11月）');
  else if (socialMonths > 0) scoreItems.push('-社保减分：已缴' + socialMonths + '个月（<6月，银行判定工作稳定性差）');
  else scoreItems.push('-无社保（银行判定工作稳定性差，大额产品受限）');

  const hukouVal = userInfo.hukou || '';
  if (hukouVal.includes('厦门')) scoreItems.push('+ 户籍加分：厦门本地户籍（本地银行全覆盖）');
  else if (hukouVal.includes('福建')) scoreItems.push('+户籍中性：福建省内非厦门（多数厦门银行可做）');
  else if (hukouVal && hukouVal !== '未填写') scoreItems.push('-户籍减分：省外户籍（部分厦门本地银行拒贷，需本地资产佐证）');

  const assetsVal = userInfo.assets || '';
  if (assetsVal.includes('房产')) scoreItems.push('+ 资产加分：名下有房产（银行认可最高权重资产）');
  if (assetsVal.includes('车辆')) scoreItems.push('+资产加分：名下有车辆');
  if (assetsVal.includes('营业执照')) scoreItems.push('+资产：有营业执照（部分银行小微产品加分）');
  if (assetsVal.includes('暂无') || assetsVal === '未填写') scoreItems.push('-无资产（无法提供抵押/增信）');

  const income = userInfo.income || 0;
  if (income >= 10000) scoreItems.push('+ 收入加分：月收入' + income + '元（≥1万，大额产品无障碍）');
  else if (income >= 5000) scoreItems.push('+收入中性：月收入' + income + '元（5000-9999元）');
  else if (income > 0) scoreItems.push('-收入减分：月收入' + income + '元（<5000元，大额信用贷额度受限）');

  // Update debt ratio display in summary bar
  if (debtRatioPct != null) {
    const drEl   = document.getElementById('sumDebtRatio');
    const drHint = document.getElementById('sumDebtHint');
    drEl.textContent = debtRatioPct + '%';
    if (debtRatioPct > 70) {
      drEl.style.color = 'var(--danger)';
      drHint.textContent = '警告：负债率过高';
    } else if (debtRatioPct >= 50) {
      drEl.style.color = 'var(--warn)';
      drHint.textContent = '预警：接近风险线';
    } else {
      drEl.style.color = 'var(--success)';
      drHint.textContent = '安全线以内';
    }
  }

  // ── 客户类型预判断（注入Prompt）──
  const _isWhiteJob = ['政府机关/公务员','事业单位','国有企业/央企'].some(w => workVal.includes(w.split('/')[0]));
  const _hasSerious  = (data.overdue_current||0)>0 || data.has_bad_record===true ||
                       (data.overdue_history_notes||'').toLowerCase().includes('连三') ||
                       (data.overdue_history_notes||'').toLowerCase().includes('累六') ||
                       onlineInstTotal > 8;
  const hasOvHistForType = data.has_overdue_history || (data.summary_overdue_accounts||0) > 0;
  const _isOptimize  = !_hasSerious && (
    q3 > 3 || onlineInstTotal >= 3 ||
    (userInfo.income > 0 && Math.round(totalMonthly/userInfo.income*100) > 60) ||
    hasOvHistForType
  );
  // A类：优质（无逾期+查询≤3次+收入≥1万 或 白名单职业）
  // B类：可优化（有小问题但能解决）
  // C类：需养征信（有严重问题）
  const _clientType = _hasSerious ? 'C'
                    : (_isWhiteJob || (q3 <= 3 && (userInfo.income||0) >= 10000 && !(data.has_overdue_history))) ? 'A'
                    : _isOptimize ? 'B'
                    : 'A';
  const _clientTypeLabel = _clientType === 'A'
    ? 'A类（优质客户）'
    : _clientType === 'B'
    ? 'B类（可优化客户）'
    : 'C类（需养征信客户）';


  // ── 新架构：先本地算产品，再AI输出建议 ──
  // Step A：先跑 V2.0 ScoreEngine 拿到分数，再传给产品匹配引擎（单一通过率来源）
  let _v2Result = null;
  let _v2ScoreForMatch = 0;
  try {
    const _v2Engine = new ScoreEngine(_recognizedData || {}, userInfo);
    _v2Result = _v2Engine.compute(typeof BANK_PRODUCTS !== 'undefined' ? BANK_PRODUCTS : []);
    window._v2Result = _v2Result;
    _v2ScoreForMatch = _v2Result.score || 0;
    // 异步上报评分记录到 D1（fire-and-forget，失败不影响主流程）
    const _sessionId = Math.random().toString(36).slice(2, 18);
    fetch(PROXY_URL + '/api/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId:    _sessionId,
        score:        _v2Result.score,
        rawScore:     _v2Result.rawScore,
        penalty:      _v2Result.penalty,
        level:        _v2Result.level,
        domainScores: _v2Result.domainScores,
        features:     _v2Result.features,
        agentId:      window._currentAgent?.id || null,
      }),
    }).catch(() => {});
  } catch(e) { console.warn('ScoreEngine error:', e); }

  let _localResult;
  try { _localResult = localFallbackMatch(data, _v2ScoreForMatch); } catch(e) {
    clearInterval(mlTimer);
    window._isMatching = false;
    document.getElementById('matchingLoading').style.display = 'none';
    alert('本地分析出错，请刷新重试：' + e.message);
    return;
  }
  const _localResult2 = _localResult; // alias for try-catch below
  const _localProds  = _localResult.products || [];

  // Step B：构建精简摘要传给AI（只传建议相关内容，不传产品库）
  const _candidateSummary = _localProds.length > 0
    ? _localProds.map((p, i) =>
        `${i+1}. ${p.bank}·${p.product} | 通过率:${p.probPct}%(${p.prob}) | 额度:${p.amount} | 主理由:${p.reason}`
      ).join('\n')
    : '（本地规则引擎未匹配到可申请产品）';

  const _rejectedSummary = (() => {
    const all = (typeof BANK_PRODUCTS !== 'undefined' ? BANK_PRODUCTS : []);
    const passedIds = new Set(_localProds.map(p => p.bank + p.product));
    // 找到被排除的主要原因
    const reasons = [];
    if ((data.overdue_current||0) > 0) reasons.push('当前逾期：一票否决所有产品');
    if (onlineInstTotal > 8) reasons.push(`网贷机构${onlineInstTotal}家：银行类产品全部排除`);
    if (onlineInstTotal > 4) reasons.push(`网贷机构${onlineInstTotal}家：部分银行产品排除`);
    if (q3 > 6) reasons.push(`近3月查询${q3}次：超出多数银行上限`);
    if (debtRatioPct != null && debtRatioPct > 70) reasons.push(`负债率${debtRatioPct}%：超部分银行上限`);
    return reasons.length > 0 ? reasons.join('；') : '无主要排除原因';
  })();

  // ── 立刻显示本地结果，不等 AI ──
  clearInterval(mlTimer);
  const _baseResult = Object.assign({}, _localResult, {
    current_products:   _localProds.length,
    optimized_products: Math.min(_localProds.length + 3, 8),
    client_type:        _clientType,
    products:           _localProds,
    cs_score:           _v2Result ? _v2Result.score : _localResult.cs_score,
    cs_tier:            _v2Result ? (_v2Result.score >= 650 ? 'bank' : _v2Result.score >= 400 ? 'mixed' : 'finance') : _localResult.cs_tier,
    user_info_summary: [
      eduVal   ? `学历：${eduVal}` : null,
      income>0 ? `月收入：${income}元` : null,
      socialStr && socialStr !== '未填写' ? `社保：${socialStr}` : null,
      pvd>0    ? `公积金：${pvd}元/月` : null,
      assetsVal ? `资产：${assetsVal}` : null,
      hukouVal  ? `户籍：${hukouVal}` : null,
      workVal   ? `单位：${workVal}` : null,
    ].filter(Boolean),
  });
  // 等终端动画跑完再展示结果
  const _termAnimMs = _TERM_DIMS.length * _TERM_DELAY + 420;
  setTimeout(() => {
    clearInterval(mlTimer);
    // 标记最后一行完成
    if (_termRows[_termRows.length - 1]) {
      _termRows[_termRows.length - 1].className = 'term-row ok';
      _termRows[_termRows.length - 1].querySelector('.term-state').textContent = 'OK';
    }
    if (_termBar)    { _termBar.style.width = '100%'; _termBar.style.background = 'var(--success)'; }
    if (_termStatus) _termStatus.textContent = 'COMPLETE';
    if (_termCount)  _termCount.textContent  = _TERM_TOTAL + ' / ' + _TERM_TOTAL;
    setTimeout(() => {
      document.getElementById('matchingLoading').style.display = 'none';
      try {
        renderMatchResult(_baseResult);
        if (_v2Result) renderV2XAI(_v2Result);
      } catch(renderErr) {
        console.error('[renderMatchResult error]', renderErr);
      }
      window._isMatching = false;
    }, 380);
  }, _termAnimMs);

  // ── 所有同步计算完毕，启动终端动画，与 AI 请求并行运行 ──
  mlTimer = setInterval(_termTick, _TERM_DELAY);
  await new Promise(r => setTimeout(r, 50)); // 让浏览器渲染第一帧

  // ── AI 在后台补充文字建议（不阻塞结果展示）──
  const aiPayToken = getPayToken() || '';
  if (aiPayToken) {
    const _matchPayload = {
      creditData: {
        loanCount:           loans.length,
        bankCount:           loans.length - onlineCount,
        onlineCount:         onlineCount,
        cardCount:           cards.length,
        overdueCurrent:      data.overdue_current || 0,
        overdueHistoryNotes: data.overdue_history_notes || '无',
      },
      userInfo,
      loanDesc, cardDesc, debtRatio, cardUtil, q,
      onlineInstTotal,
      cfCount: cfCount2, mlCount: mlCount2, obCount: obCount2,
      totalMonthly: Math.round(totalMonthly),
      scoreItems, socialStr, income, pvd,
      hukouVal, assetsVal, workVal, eduVal,
      candidateSummary: _candidateSummary,
      rejectedSummary:  _rejectedSummary,
      clientType:       _clientType,
      v2Level:          _v2Result ? _v2Result.level : _clientType,
      v2Score:          _v2Result ? _v2Result.score  : 0,
      domainScores:     _v2Result ? _v2Result.domainScores : null,
      xaiIssues:        _v2Result ? (_v2Result.xai?.issues || []).slice(0, 4).map(i => ({
        tag: i.tag, desc: i.desc, fix: i.fix, months: i.months, gain: i.gain,
      })) : [],
    };
    // 直接调 Worker /match，不经过 callMatch（避免 402 时误删 token 或弹付费框）
    (async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 40000);
        const resp = await fetch(PROXY_URL + '/api/v1/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ _pay_token: aiPayToken, payload: _matchPayload }),
        });
        clearTimeout(t);
        if (!resp.ok) return; // 失败静默，本地结果已展示
        const respText = await resp.text();
        const respData = JSON.parse(respText);
        if (respData.error) return;
        const raw = (respData.content || []).map(b => b.text || '').join('').replace(/```json[^`]*```|```/g, '').trim();
        const aiResult = extractJson(raw);
        if (!aiResult) return;
        // 只更新 AI 文字字段对应的 DOM，不重渲染产品列表
        const _esc = s => s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
        if (aiResult.optimization?.length > 0) {
          const el = document.getElementById('optimizationSection');
          if (el) { el.style.display = 'block'; document.getElementById('optimizationBody').innerHTML = aiResult.optimization.map((o,i) => `<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${_esc(o.step)}</div><div class="as-impact">${_esc(o.goal)}</div><div class="as-step-meta"><span class="as-step-tag">${_esc(o.time)}</span><span class="as-step-tag">${_esc(o.unlock)}</span></div></div></div>`).join(''); }
        }
        if (aiResult.advice) {
          const adv = aiResult.advice;
          const el = document.getElementById('adviceSection');
          if (el) {
            el.style.display = 'block';
            if (adv.strengths?.length > 0) document.getElementById('adviceStrengthsBody').innerHTML = adv.strengths.map(s => `<div class="as-item"><div class="as-dot as-dot-green"></div><div><div class="as-point">${_esc(s.point)}</div><div class="as-impact">${_esc(s.impact)}</div></div></div>`).join('');
            const _aiIssuesSub = document.getElementById('adviceIssuesSub');
            if (adv.issues?.length > 0) {
              if(_aiIssuesSub) _aiIssuesSub.style.display = '';
              document.getElementById('adviceIssuesBody').innerHTML = adv.issues.map(s => `<div class="as-item"><div class="as-dot as-dot-red"></div><div><div class="as-point">${_esc(s.point)}</div><div class="as-impact">${_esc(s.impact)}</div></div></div>`).join('');
            }
            if (adv.suggestions?.length > 0) document.getElementById('adviceSuggestionsBody').innerHTML = adv.suggestions.map((s,i) => `<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${_esc(s.action)}</div><div class="as-impact">${_esc(s.goal)}</div><div class="as-step-meta"><span class="as-step-tag">${_esc(s.time)}</span><span class="as-step-tag">${_esc(s.effect)}</span></div></div></div>`).join('');
          }
        }
        if (aiResult.key_risk) {
          const banner = document.getElementById('riskLevelBanner');
          if (banner) { const desc = banner.querySelector('.rb-desc'); if (desc) desc.textContent = aiResult.key_risk; }
        }
        // AI 完成后隐藏"还有X个因素没分析完"提示（convHidden，不是整个CTA区）
        const _ctaHiddenEl = document.getElementById('convHidden');
        if (_ctaHiddenEl) _ctaHiddenEl.parentElement && (_ctaHiddenEl.style.display = 'none');
      } catch(e) { /* 超时或网络失败，静默忽略 */ }
    })();
  }
}

// localFallbackMatch 已移至 BANK_PRODUCTS 区块

function renderV2XAI(v2) {
  const wrap = document.getElementById('v2xaiWrap');
  if (!wrap || !v2) return;
  const xai = v2.xai || {};
  const ds  = v2.domainScores || {};
  const lvColor = { A:'#4ade80', B:'#60a5fa', C:'#fbbf24', D:'#f87171' };
  const col = lvColor[v2.level] || '#60a5fa';

  // 标题区：替换为科技感 header（CPU图标 + 评分 + 等级徽章）
  const hdEl = wrap.querySelector('.conv-sec-hd');
  if (hdEl && v2.score > 0) {
    const lvLabel = { A:'PREMIUM', B:'OPTIMIZABLE', C:'RECOVERY', D:'REHABILITATION' };
    const lvDesc  = { A:'优质准入', B:'有优化空间', C:'恢复期', D:'修复期' };
    const scoreInt = parseInt(v2.score, 10);
    const cpuIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(96,165,250,.8)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="6" height="6"/><rect x="2" y="2" width="20" height="20" rx="2"/><line x1="9" y1="2" x2="9" y2="7"/><line x1="15" y1="2" x2="15" y2="7"/><line x1="9" y1="17" x2="9" y2="22"/><line x1="15" y1="17" x2="15" y2="22"/><line x1="2" y1="9" x2="7" y2="9"/><line x1="2" y1="15" x2="7" y2="15"/><line x1="17" y1="9" x2="22" y2="9"/><line x1="17" y1="15" x2="22" y2="15"/></svg>`;
    hdEl.innerHTML = `<div class="v2hd">
      <div class="v2hd-icon">${cpuIcon}</div>
      <div class="v2hd-txt">
        <div class="v2hd-label">AI 信用评分引擎 · 102维检测
          <span class="v2hd-badge" style="background:${col}1a;color:${col};border:1px solid ${col}55">${v2.level || ''}级 · ${lvDesc[v2.level] || ''}</span>
        </div>
      </div>
      <div class="v2hd-score">
        <div class="v2hd-num" style="color:${col}">${scoreInt}</div>
      </div>
    </div>`;
    hdEl.style.marginBottom = '0';
  }

  // 五维雷达图
  const radarWrap = document.getElementById('v2RadarWrap');
  if (radarWrap) {
    const f2 = v2.features || {};
    const queryScore = f2.q3m === undefined ? 50 :
      f2.q3m === 0 ? 100 : f2.q3m <= 3 ? 85 : f2.q3m <= 6 ? 62 : f2.q3m <= 9 ? 32 : 8;
    const axes = [
      { label:'信用行为', val: Math.min(100, Math.round(ds.credit    || 0)) },
      { label:'查询安全', val: queryScore },
      { label:'资产偿债', val: Math.min(100, Math.round(ds.asset     || 0)) },
      { label:'反欺诈',   val: Math.min(100, Math.round(ds.fraud     || 0)) },
      { label:'稳定性',   val: Math.min(100, Math.round(ds.stability || 0)) },
    ];
    const N = axes.length, CX = 100, CY = 100, R = 68;
    const ang = i => Math.PI * 2 * i / N - Math.PI / 2;
    const pt  = (i, r) => ({ x: CX + r * Math.cos(ang(i)), y: CY + r * Math.sin(ang(i)) });
    const gridPaths = [20,40,60,80,100].map(pct => {
      const gp = axes.map((_,i) => pt(i, pct/100*R));
      return gp.map((p,i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+'Z';
    });
    const dataPts = axes.map((_,i) => pt(i, axes[i].val/100*R));
    const dataPath = dataPts.map((p,i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+'Z';
    const axisLines = axes.map((_,i) => { const e=pt(i,R); return `<line x1="${CX}" y1="${CY}" x2="${e.x.toFixed(1)}" y2="${e.y.toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>`; }).join('');
    const labels = axes.map((a,i) => {
      const lp = pt(i, R+16);
      const anchor = Math.abs(lp.x-CX)<8?'middle':lp.x>CX?'start':'end';
      const c = a.val>=70?'#4ade80':a.val>=45?'#fbbf24':'#f87171';
      return `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="9.5" fill="${c}" font-family="system-ui,-apple-system,sans-serif">${a.label}</text>`;
    }).join('');
    const dots = dataPts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${col}"/>`).join('');
    radarWrap.innerHTML = `<svg width="200" height="200" viewBox="0 0 200 200" style="overflow:visible">
      ${gridPaths.map(d=>`<path d="${d}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="0.8"/>`).join('')}
      ${axisLines}
      <path d="${dataPath}" fill="${col}22" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>
      ${dots}
      ${labels}
    </svg>`;
  }

  // 四域分数条（竖向，与雷达图并排）
  const domainBar = document.getElementById('v2DomainBar');
  if (domainBar) {
    const domains = [
      { name:'信用行为', val:ds.credit,    w:'40%' },
      { name:'稳定性',   val:ds.stability, w:'30%' },
      { name:'资产偿债', val:ds.asset,     w:'25%' },
      { name:'反欺诈',   val:ds.fraud,     w:'5%'  },
    ];
    domainBar.innerHTML = domains.map(d => {
      const pct = Math.min(100, Math.round(d.val || 0));
      const c = pct>=70?'#4ade80':pct>=45?'#fbbf24':'#f87171';
      return `<div style="background:var(--raised);border-radius:8px;padding:8px 10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:11px;color:var(--muted)">${d.name}</span>
          <span style="font-size:15px;font-weight:700;color:${c}">${pct}</span>
        </div>
        <div style="height:3px;background:var(--border);border-radius:2px">
          <div style="width:${pct}%;height:100%;background:${c};border-radius:2px;transition:width .6s"></div>
        </div>
      </div>`;
    }).join('');
  }

  // 风险诊断列表
  const issueList = document.getElementById('v2IssueList');
  if (issueList) {
    if ((xai.issues||[]).length === 0) {
      issueList.innerHTML = `<div style="color:var(--success);padding:10px 0;font-size:13px;letter-spacing:.02em">未发现显著风控问题</div>`;
    } else {
      issueList.innerHTML = (xai.issues||[]).map(iss => `
        <div style="background:var(--raised);border-radius:10px;padding:12px 14px;margin-bottom:10px;border-left:3px solid #f87171">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="display:flex;align-items:center;color:var(--danger);flex-shrink:0">${iss.icon}</span>
            <span style="font-size:13px;font-weight:600;color:var(--text)">${esc(iss.tag)}</span>
            <span style="font-size:11px;color:var(--danger);margin-left:auto">${esc(iss.cost)}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">${esc(iss.desc)}</div>
          <div style="font-size:12px;color:var(--accent)"><span style="font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-right:6px">FIX</span>${esc(iss.fix)}${iss.months>0?' （约'+iss.months+'个月）':''}</div>
        </div>`).join('');
    }
  }

  wrap.style.display = 'block';
}

function _deriveLevel(score) {
  if (score >= 800) return 'A';
  if (score >= 650) return 'B';
  if (score >= 500) return 'C';
  return 'D';
}

const _isAmtNum = s => /^[\d<–\-]/.test(s);

function _renderHero(level, r, cp, op, gapW, curAmt, optAmt, products) {
  const el = document.getElementById('heroContent');
  if (!el) return;
  const score = (window._v2Result && window._v2Result.score) || r.cs_score || 0;
  const scoreDisp = score > 0 ? (parseInt(score, 10) || '--') : '--';

  const _metricBox = (label, val, cls, sub) =>
    `<div class="hero-metric"><div class="hero-metric-label">${label}</div>` +
    `<div class="hero-metric-val${cls ? ' ' + cls : ''}">${val}</div>` +
    (sub ? `<div class="hero-metric-sub">${sub}</div>` : '') +
    `</div>`;

  if (level === 'A') {
    const _parseMinRate = arr => {
      if (!arr || !arr.length) return null;
      const rates = arr.map(p => parseFloat((p.rate || '').split('%')[0]) || 99).filter(v => v < 99);
      return rates.length ? Math.min(...rates) : null;
    };
    const minRateVal = _parseMinRate(products);
    const minRateDisp = minRateVal != null ? minRateVal.toFixed(2).replace(/\.?0+$/, '') + '%起' : '--';

    el.innerHTML = `<div class="hero-wrap hero-a">
      <div class="hero-eyebrow">A级 · PREMIUM ACCESS</div>
      <div class="hero-title">您已进入银行优质准入区间</div>
      <div class="hero-sub">征信状态优质 · ${cp}款产品可直接申请 · 利率可谈至最低档</div>
      <div class="hero-metrics cols-3">
        ${_metricBox('可申请最低利率', minRateDisp, '')}
        ${_metricBox('综合评分', scoreDisp, '')}
        ${_metricBox('符合产品数', cp + '款', '')}
      </div>
      <div class="hero-note" style="display:flex;align-items:flex-start;gap:8px"><span class="hero-note-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg></span><span><strong style="color:#fff">专属白名单通道：</strong>您的资质符合银行优先审批条件，最低利率需人工对接谈判</span></div>
    </div>`;
    return;
  }

  if (level === 'B') {
    const nOpt = Array.isArray(r.optimization) ? r.optimization.length : 3;
    const gainText = gapW > 0
      ? `多拿 <span style="color:#4ade80">${gapW}万</span> 额度`
      : op > cp
        ? `多申请 <span style="color:#4ade80">${op - cp}款</span> 产品`
        : `提升整体<span style="color:#4ade80">通过率</span>`;
    const subLine = op > cp
      ? `当前资质符合${cp}款产品 · 优化后可达${op}款 · 最快3个月见效`
      : `当前资质符合${cp}款产品 · 按推荐顺序申请可提升通过率`;
    // 三档显示：① 有额度提升 → 额度对比；② 无额度提升但可多解锁产品 → 产品数对比；③ 都没有 → 不显示格子
    const _metricsHtml = gapW > 0
      ? `<div class="hero-metrics cols-2">
          ${_metricBox('当前可贷额度', _isAmtNum(curAmt) ? curAmt + '万' : curAmt, '')}
          ${_metricBox('优化后可达', _isAmtNum(optAmt) ? optAmt + '万 <span style="font-size:11px">↑多' + gapW + '万</span>' : optAmt, 'gain')}
        </div>`
      : op > cp
        ? `<div class="hero-metrics cols-2">
            ${_metricBox('当前符合产品', cp + '款', '')}
            ${_metricBox('优化后可达', op + '款', 'gain')}
          </div>`
        : '';
    el.innerHTML = `<div class="hero-wrap hero-b">
      <div class="hero-eyebrow">B级 · OPTIMIZATION GAP</div>
      <div class="hero-title">做${nOpt}个优化，可以${gainText}</div>
      <div class="hero-sub">${subLine}</div>
      ${_metricsHtml}
      <div class="hero-note" style="display:flex;align-items:flex-start;gap:8px"><span class="hero-note-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg></span><span>申请顺序搞错会多等3个月 · 客服给你精准执行计划</span></div>
    </div>`;
    return;
  }

  if (level === 'C') {
    // +9款/+6款 是设计文案（代表各层次的典型解锁数量），非实时产品数
    el.innerHTML = `<div class="hero-wrap hero-c">
      <div class="hero-eyebrow">C级 · RECOVERY PATH</div>
      <div class="hero-title">当前有 <span style="color:#fbbf24">${cp}款</span> 产品可立即申请</div>
      <div class="hero-sub">3–6个月优化后，可进入主流股份制银行区间</div>
      <div class="hero-metrics cols-3">
        ${_metricBox('现在可申请', cp + '款', '', '城商行 + 消金')}
        ${_metricBox('3个月后解锁', '+9款 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px;vertical-align:middle;opacity:.7"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', 'locked', '股份制银行')}
        ${_metricBox('6个月后解锁', '+6款 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px;vertical-align:middle;opacity:.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', 'locked', '国有大行')}
      </div>
      <div class="hero-note" style="display:flex;align-items:flex-start;gap:8px"><span class="hero-note-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></span><span>过渡方案可用，但申请顺序很关键 · 顺序错了影响后续恢复</span></div>
    </div>`;
    return;
  }

  // D级
  el.innerHTML = `<div class="hero-wrap hero-d">
    <div class="hero-eyebrow">D级 · REHABILITATION PLAN</div>
    <div class="hero-title">银行通道暂时关闭</div>
    <div class="hero-sub">专属征信修复路线图已生成 · 预计 <strong style="color:#fff">9个月</strong> 后重新达到银行准入</div>
    <div class="hero-metrics cols-3">
      ${_metricBox('当前保底方案', '2款消金', '')}
      ${_metricBox('第一里程碑', '第3个月', 'milestone')}
      ${_metricBox('恢复银行准入', '第9个月', 'recovery')}
    </div>
    <div class="hero-note" style="display:flex;align-items:flex-start;gap:8px"><span class="hero-note-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span><span>恢复期全程陪伴 · 每月进度同步 · 不是一次性报告</span></div>
  </div>`;
}

function _renderRehabRoadmap(r) {
  const secEl = document.getElementById('convRehab');
  const contentEl = document.getElementById('rehabContent');
  if (!secEl || !contentEl) return;
  secEl.style.display = 'block';

  const steps = [
    {
      dotCls: 'now',
      month: '当前 · 立即执行',
      task: '停止所有贷款申请，避免查询次数增加',
      unlock: '保底可申请：消费金融保底方案（2款）',
      unlockCls: 'active',
      hasLine: true,
    },
    {
      dotCls: 'm3',
      month: '第3个月',
      task: '查询冷却完成 + 完成1笔按时还款记录',
      unlock: '解锁：城商行产品（+4款）',
      unlockCls: '',
      hasLine: true,
    },
    {
      dotCls: 'm6',
      month: '第6个月',
      task: '持续良好还款记录，网贷机构降至安全线',
      unlock: '解锁：股份制银行产品（+9款）',
      unlockCls: '',
      hasLine: true,
    },
    {
      dotCls: 'm9',
      month: '第9个月 · 目标节点',
      task: '征信状态恢复至C级，可申请主流银行',
      unlock: '解锁：国有大行产品，利率可达5%-7%',
      unlockCls: 'active',
      hasLine: false,
    },
  ];

  contentEl.innerHTML = `<div class="rehab-timeline">` +
    steps.map(s => `
      <div class="rehab-step">
        <div class="rehab-left">
          <div class="rehab-dot ${s.dotCls}"></div>
          ${s.hasLine ? '<div class="rehab-vline"></div>' : ''}
        </div>
        <div class="rehab-body">
          <div class="rehab-month">${s.month}</div>
          <div class="rehab-task">${s.task}</div>
          <div class="rehab-unlock ${s.unlockCls}">${s.unlock}</div>
        </div>
      </div>`
    ).join('') +
    `</div>`;
}

function renderMatchResult(r) {
  if (!r) return;
  window._lastMatchResult = r;

  // ── V2.0 等级驱动的差异化渲染 ──
  const v2Level = (window._v2Result && window._v2Result.level) || _deriveLevel(r.cs_score || 0);

  // ── 基础数据计算 ──
  const income  = parseFloat(document.getElementById('if-income')?.value)||0;
  const workVal = document.getElementById('if-work')?.value||'';
  const data2   = _recognizedData||{};
  const loans2  = getActiveLoans(data2);
  const cards2  = getActiveCards(data2);
  const monthly = calcTotalMonthly(loans2,cards2);
  const dr      = income>0?Math.round(monthly/income*100):0;
  const q       = calcQueryCounts(data2.query_records||[]);
  const q3      = q.q_3m||0;
  const onlineL = loans2.filter(l=>l.type==='online');
  const onlineI = [...new Set(onlineL.map(l=>l.name.split('-')[0]))].length;
  const cLimit  = cards2.reduce((s,c)=>s+(c.limit||0),0);
  const cUsed   = cards2.reduce((s,c)=>s+(c.used||0),0);
  const cUtil   = cLimit>0?Math.round(cUsed/cLimit*100):0;
  // 职业信贷倍数（月收入×N倍 = 银行实际可授信上限参考）
  // 稳定职业（事业单位/国企）单行30-80万，私营企业/个体户明显偏低
  const wtMultMap = {'政府机关/公务员':90,'事业单位':80,'国有企业/央企':65,'上市公司/500强':50,'私营企业':35,'个体工商户':25,'自由职业':20};
  const wt      = WORK_TYPE_MAP[workVal]||'private';
  const mult    = wtMultMap[workVal]||25;
  let qf=1;
  if(q3>10)qf*=.5;else if(q3>6)qf*=.7;
  if(loans2.length>=5)qf*=.8;
  if(cUtil>90)qf*=.7;else if(cUtil>70)qf*=.85;
  // V2-level floor：防止高分客户出现与评级严重矛盾的极低额度
  const _amtFloor = {A:200000,B:100000,C:0,D:0}[v2Level]||0;
  // DTI惩罚：用月供/月收入比替代直接减负债余额（稳定职业银行容忍度更高）
  const _isStable = ['政府机关/公务员','事业单位','国有企业/央企'].includes(workVal);
  const _dtiRatio = income>0?monthly/income:0;
  const _dtiPenalty = _dtiRatio>0.9?0.4:_dtiRatio>0.75?(_isStable?0.7:0.5):_dtiRatio>0.6?(_isStable?0.85:0.7):1.0;
  const estHi = income>0?Math.max(_amtFloor,Math.min(3e6,Math.round(income*mult*_dtiPenalty*qf))):0;
  const estLo = income>0?Math.round(estHi*0.45):0;
  // 优化后额度：假设查询已冷却，移除查询次数惩罚，仅保留卡片惩罚
  let qfOpt=1;
  if(loans2.length>=5)qfOpt*=.8;
  if(cUtil>90)qfOpt*=.7;else if(cUtil>70)qfOpt*=.85;
  const estHiO = income>0?Math.max(_amtFloor,Math.min(3e6,Math.round(income*mult*_dtiPenalty*qfOpt))):0;
  const estLoO = income>0?Math.round(estHiO*0.45):0;
  const fw     = v=>v<=0?'0':(v<1e4?'<1':Math.round(v/1e4)+'');
  const curAmt = income>0?(estHi>0?fw(estLo)+'–'+fw(estHi):'当前负债较高'):'填写收入后显示';
  const optAmt = income>0?(estHiO>0?fw(estLoO)+'–'+fw(estHiO):'当前负债较高'):'填写收入后显示';
  const gapW   = income>0?Math.max(0,Math.round((estHiO-estHi)/1e4)):0;
  const products = r.products||[];
  const _aiCurRate = r.current_rate;
  const curRate  = _aiCurRate||(q3<=3&&!(data2.overdue_current)?72:q3<=6?58:38);
  const optRate  = r.optimized_rate||Math.min(92,curRate+20);
  const _isEstimated = !_aiCurRate; // true=本地估算，false=AI计算
  // 提到外层作用域，所有区块（convLoss/convPath/convClient/productsGrid）共享
  // v2Level A/B 说明 ScoreEngine 评分>=650，产品层级必然是 bank，不依赖 AI 返回的 cs_tier
  const _tier    = r.cs_tier || (v2Level === 'A' || v2Level === 'B' ? 'bank' : curRate>=80?'bank':curRate>=60?'mixed':'finance');
  const _clientT = r.client_type || (_tier==='bank'?'A':_tier==='mixed'?'B':'C');

  // ── 个性化渲染所需额外变量 ──
  const q1m      = q.q_1m || 0;
  const provident = parseFloat(document.getElementById('if-provident')?.value) || 0;
  const hasSocial = document.getElementById('social-yes')?.classList.contains('active-yes') || false;
  const hasOv     = (data2.overdue_current || 0) > 0;
  const hasOvHist = (data2.loans||[]).some(l => (l.overdue_count||0) > 0);
  const v2Score   = (window._v2Result && window._v2Result.score) || 0;

  // 更新产品数量，切换header锁定提示
  document.getElementById('matchCount').textContent = products.length;
  const _lockHint = document.getElementById('matchLockHint');
  const _countWrap = document.getElementById('matchCountWrap');
  if (_lockHint) _lockHint.style.display = 'none';
  if (_countWrap) _countWrap.style.display = '';

  // 更新评分卡底部统计（当前/优化后可申请）
  const _ssEl = document.getElementById('scoreStats');
  if (_ssEl) {
    const _curCnt = document.getElementById('csCurrentCount');
    const _optCnt = document.getElementById('csOptCount');
    const _optCount = Math.max(products.length, r.optimized_products || r.optimized_products_count || 0);
    if (_curCnt) _curCnt.textContent = products.length + ' 款产品';
    if (_optCnt) _optCnt.textContent = _optCount + ' 款产品';
    _ssEl.style.display = _optCount > products.length ? 'block' : 'none';
  }

  // ① 顶部英雄区（差异化）
  const topEl = document.getElementById('convTop');
  if (topEl) {
    topEl.style.display = 'block';
    const cp = products.length;
    const op = Math.max(cp, r.optimized_products || (cp + 2));
    _renderHero(v2Level, r, cp, op, gapW, curAmt, optAmt, products);
  }

  // ② 问题拆解
  const probs = r.problems||[];
  const lProbs=[];
  if(q3>3) lProbs.push({name:'查询次数过多',value:'近3月'+q3+'次',threshold:'银行安全区≤3次',severity:'high'});
  if(onlineI>=3) lProbs.push({name:'网贷机构较多',value:onlineI+'家未结清',threshold:'银行红线≤4家',severity:onlineI>=5?'high':'medium'});
  if(income>0&&dr>65) lProbs.push({name:'负债率偏高',value:dr+'%',threshold:'银行舒适区≤65%',severity:dr>80?'high':'medium'});
  if(cUtil>70) lProbs.push({name:'信用卡使用率高',value:cUtil+'%',threshold:'银行红线≤70%',severity:'medium'});
  const dp=(probs.length>0?probs:lProbs).slice(0,4);
  const probEl=document.getElementById('convProb');
  if(probEl&&dp.length>0 && v2Level !== 'A'){
    probEl.style.display='block';
    document.getElementById('convProbList').innerHTML=dp.map((p,i)=>`<div class="prob-item"><div class="prob-n">${i+1}</div><div><div class="prob-name"><strong>${esc(p.name)}：${esc(p.value)}</strong></div><div class="prob-desc">→ ${esc(p.threshold)}${p.severity==='high'?' · 影响较大':''}</div></div></div>`).join('');
  }

  // ③ 损失对比
  const lossEl=document.getElementById('convLoss');
  if(lossEl && v2Level !== 'A' && v2Level !== 'D' && !(v2Level === 'B' && _tier === 'bank')){
    lossEl.style.display='block';
    // 银行tier客户已能申请银行产品，改为"顺序"对比；否则保持"消费金融vs银行"
    const nt=document.getElementById('convLossNowType');
    const nr=document.getElementById('convLossNowRate');
    const lossTitle=lossEl.querySelector('.conv-sec-title');
    if(_tier==='bank'){
      if(lossTitle) lossTitle.textContent='申请顺序的影响有多大';
      if(nt) nt.textContent='顺序错误：同时多家';
      if(nr) nr.textContent='查询暴增→全部被拒→被迫转消费金融';
    } else {
      if(lossTitle) lossTitle.textContent='现在直接申请，代价是什么';
      if(nt) nt.textContent=_tier==='mixed'?'银行+消金混合':'消费金融为主';
      if(nr) nr.textContent=_tier==='mixed'?'年利率：6%–18%（银行低，消金高）':'年利率：15%–24%';
    }
    const la=income>0?Math.max(1,Math.round(Math.min(estHi>0?estHi:3e4,1e5)/1e4)):10;
    const n=document.getElementById('convIntNow');if(n)n.textContent=la+'万/年利息：约'+(la*0.15).toFixed(1)+'–'+(la*0.24).toFixed(1)+'万（年化利率APR 15%–24%）';
    const o=document.getElementById('convIntOpt');if(o)o.textContent=la+'万/年利息：约'+(la*0.036).toFixed(1)+'–'+(la*0.06).toFixed(1)+'万（年化利率APR 3.6%–6.0%）';
    const dEl=document.getElementById('convIntDiff');if(dEl)dEl.textContent='约 '+(la*0.09).toFixed(1)+'–'+(la*0.204).toFixed(1)+' 万';
  }

  // ④ 提升空间
  const acts=r.optimize_actions||[];
  const lActs=[];
  if(onlineI>=3) lActs.push({action:'结清'+Math.min(2,onlineI-1)+'笔网贷并注销账户',impact:'可新增'+Math.min(3,onlineI)+'家可申请银行产品'});
  if(q3>3) lActs.push({action:'停止所有贷款查询'+(q3>6?'1个月':'2-3周'),impact:'查询风险下降，银行通过率提升约'+(q3>6?'30%':'15%')});
  const da=(acts.length>0?acts:lActs).slice(0,3);
  const liftEl=document.getElementById('convLift');
  if(liftEl&&da.length>0 && v2Level !== 'D'){
    liftEl.style.display='block';
    // B级：改为收益框架标题
    if (v2Level === 'B') {
      const _liftTitle = liftEl.querySelector('.conv-sec-title');
      if (_liftTitle) _liftTitle.textContent = '做这几步，可以多拿这些';
    }
    document.getElementById('convLiftActions').innerHTML=da.map(a=>`<div class="lift-action"><div class="lift-check"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 3"/></svg></div><div class="lift-txt">${esc(a.action)}（${esc(a.impact)}）</div></div>`).join('');
    const cp=r.current_products||products.length;
    const op=Math.max(cp, r.optimized_products || (cp + 2));
    // B级的对比数据已在 hero 区展示，convLift 只保留行动清单和 gap 文字
    const _liftCompare=liftEl.querySelector('.lift-compare');
    if(_liftCompare) _liftCompare.style.display = v2Level === 'B' ? 'none' : '';
    if(v2Level !== 'B'){
      const pb=document.getElementById('convLiftProdB');if(pb)pb.textContent=cp+' 款';
      const pa=document.getElementById('convLiftProdA');if(pa)pa.textContent=op+' 款';
      const ab=document.getElementById('convLiftAmtB');if(ab)ab.textContent=_isAmtNum(curAmt)?'额度 '+curAmt+' 万':curAmt;
      const aa=document.getElementById('convLiftAmtA');if(aa)aa.textContent=_isAmtNum(optAmt)?'额度 '+optAmt+' 万':optAmt;
    }
    const lg=document.getElementById('convLiftGap');
    const _liftDiff=op-cp;
    if(lg)lg.textContent=gapW>0?'优化后可多拿约 '+gapW+' 万额度':_liftDiff>0?'优化后可多申请 '+_liftDiff+' 款产品':'优化后通过率大幅提升';
  }

  // ⑤ 操作路径（仅付费后展示）
  const pathEl=document.getElementById('convPath');
  if(pathEl && getPayToken()){
    pathEl.style.display='block';
    const _bankProds = products.filter(p=>p.type==='bank');
    const _finProds  = products.filter(p=>p.type!=='bank');
    const _topBanks  = _bankProds.slice(0,2).map(p=>p.bank+'·'+p.product).join('、');
    const _topFin    = _finProds.slice(0,2).map(p=>p.bank).join('、');
    const _pathSteps = [
      {
        title: _topBanks ? `优先申请 ${_topBanks}` : '优先申请通过率最高的银行产品',
        desc:  '利率最低、查询消耗最友好。同类产品只选一家，避免同时查询导致爆查。'
      },
      {
        title: '拿到第一笔批款后，再逐步补充',
        desc:  '已有银行通过记录，后续申请的审批通过率显著提升。每次申请间隔建议1周以上。'
      },
      {
        title: _topFin ? `${_topFin} 等消费金融作为最后备选` : '消费金融作为最后备选',
        desc:  '年化利率 15%–24%，仅在银行产品不足时补充申请，不要第一个申请。'
      },
    ];
    document.getElementById('convPathSteps').innerHTML = _pathSteps.map((s,i) =>
      `<div class="path-step">
        <div class="path-left"><div class="path-num">0${i+1}</div>${i<_pathSteps.length-1?'<div class="path-vline"></div>':''}</div>
        <div class="path-body"><div class="path-title">${esc(s.title)}</div><div class="path-desc">${esc(s.desc)}</div></div>
      </div>`
    ).join('');
  }

  // ⑥ 客户标签（已被 hero 区替代，不再展示）
  const ctEl=document.getElementById('convClient');
  if(ctEl) ctEl.style.display='none';

  // 白名单职业
  const wlEl=document.getElementById('wlTip');
  if(wlEl)wlEl.style.display=['gov','institution','state'].includes(wt)?'block':'none';

  // ⑦ 紧迫提醒
  const urgEl=document.getElementById('convUrgent');
  if(urgEl && q3>=3 && v2Level !== 'A'){
    urgEl.style.display='block';
    const ub=document.getElementById('convUrgentBody');
    if(ub)ub.innerHTML='你现在处于<strong>关键窗口期（7–15天）</strong><br>如果这段时间继续查询或盲目申请：';
    const ur=document.getElementById('convUrgentResult');
    if(ur)ur.textContent='查询次数再增加，直接降级为「银行无法通过」。恢复周期：1–3个月。现在的行动决定3个月后的结果。';
  }

  // 预估额度
  const mrEl=document.getElementById('mrEstimate');
  if(mrEl&&income>0&&estHi>0&&v2Level!=='B'){
    mrEl.style.display='block';
    if (products.length === 0) {
      mrEl.textContent='恢复后预计可申请：'+fw(estLo)+'–'+fw(estHi)+' 万（当前无匹配产品，此为征信修复后的参考额度）';
    } else {
      mrEl.textContent='根据现有资质，预计可申请：'+fw(estLo)+'–'+fw(estHi)+' 万';
    }
  }

  // ⑧ 转化区
  const hEl=document.getElementById('convHidden');
  if(hEl)hEl.textContent=Math.max(1,dp.length>2?2:1);
  const ctaSub = document.getElementById('convCtaSub');
  if (ctaSub) {
    const _ctaCopy = {
      A: '专属白名单通道需人工对接，顾问协助谈判最低利率',
      B: '申请顺序搞错会多等3个月，顾问给你精准执行计划',
      C: '有过渡方案，但申请顺序很关键，顺序错了影响后续恢复',
      D: '恢复期全程陪伴，每月进度同步，不是一次性报告',
    };
    ctaSub.textContent = _ctaCopy[v2Level] || _ctaCopy['B'];
  }

  // 产品卡片渲染（分三层：国有大行 / 股份制+城商行 / 消费金融）
  // 付费守卫：未付费只展示摘要，产品列表不渲染
  const _tok = getPayToken();
  const isPaid = !!_tok;
  // 已付费：在额度徽章旁显示剩余有效时间
  if (isPaid) {
    const expMs = parseInt(localStorage.getItem('_payTokenExp') || '0');
    const leftMin = Math.max(0, Math.round((expMs - Date.now()) / 60000));
    const mrEl2 = document.getElementById('mrEstimate');
    if (mrEl2 && leftMin > 0) {
      const origText = mrEl2.textContent;
      // 已有额度文字则在后面加锁标；否则单独显示解锁状态
      if (!origText) mrEl2.textContent = '已解锁 剩余' + leftMin + '分钟';
      mrEl2.style.display = 'block';
    }
  }
  if (!isPaid) {
    const _ghostCard = () => `<div class="pw-ghost"><div class="pw-ghost-l"><div class="pw-ghost-name"></div><div class="pw-ghost-sub"></div></div><div class="pw-ghost-r"><div class="pw-ghost-pct"></div><div class="pw-ghost-rate"></div></div></div>`;
    const _lockOverlay = `<div class="pw-lock-overlay"><div class="pw-lock-ring"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="pw-lock-lbl">专属方案已生成，待解锁</div></div>`;
    const _countHint = products.length > 0
      ? `检测到 <span style="color:var(--accentB);font-size:17px;font-weight:700">${products.length}</span> 家机构符合您的资质`
      : '征信分析已完成';
    document.getElementById('productsGrid').innerHTML = `<div class="pw-wrap"><div class="pw-preview">${_ghostCard()}${_ghostCard()}${_ghostCard()}${_lockOverlay}<div class="pw-fade"></div></div><div class="pw-hint">${_countHint}</div><button class="pw-btn" onclick="showPayModal(()=>startMatching())">解锁方案 · 顾问一对一跟进 &nbsp; ¥9.9</button></div>`;
    document.getElementById('matchResult').style.display='block';
    document.getElementById('matchResult').scrollIntoView({behavior:'smooth',block:'start'});
    window._isMatching = false;
    return;
  }

  // ── 个性化匹配理由 ──
  const _personalReason = p => {
    const pts = [];
    if (p.maxQ3 && q3 <= Math.floor(p.maxQ3 * 0.65))
      pts.push(`近3月查询${q3}次，远低于该行${p.maxQ3}次上限，征信干净`);
    else if (p.maxQ1 && q1m <= p.maxQ1)
      pts.push(`近1月仅${q1m}次查询，符合${p.bank}最严查询要求`);
    if (['gov','institution','state'].includes(wt) && (p.bonus||'').includes('国企'))
      pts.push(`${{gov:'公务员',institution:'事业单位员工',state:'国企员工'}[wt]||'优质单位'}，${p.bank}白名单直通道`);
    if (provident >= 2000 && (p.tags||[]).includes('公积金加分'))
      pts.push(`公积金${provident}元/月，可申请最优利率通道`);
    else if ((provident >= 500 || hasSocial) && p.social && p.minSocialMonths)
      pts.push(`${provident>=500?'公积金':'社保'}在缴，满足${p.bank}稳定就业要求`);
    if (income > 0 && p.maxDebt && dr <= p.maxDebt - 20)
      pts.push(`负债率${dr}%，低于该行${p.maxDebt}%红线，额度空间充裕`);
    if (hasOvHist && !hasOv && p.overdue === 'mild')
      pts.push(`该行接受已结清历史逾期，是征信有瑕疵客户首选`);
    if (['xmyh','xmns'].includes(p.id))
      pts.push(`厦门本地银行，有线下面谈通道，可申请提额`);
    return pts.slice(0, 2).join('；');
  };

  // ── A级：产品对比标签 ──
  const _aCompBadge = (() => {
    const allRates = products.map(x => parseFloat((x.rate||'').split('%')[0])||99);
    const minRate  = Math.min(...allRates);
    const maxAmt   = products.reduce((m,x) => Math.max(m, parseInt((x.amount||'').replace(/[^0-9万]/g,'').replace('万','0000'))||0), 0);
    return p => {
      const myRate = parseFloat((p.rate||'').split('%')[0])||99;
      const myAmt  = parseInt((p.amount||'').replace(/[^0-9万]/g,'').replace('万','0000'))||0;
      if (myRate === minRate) return {txt:'利率最低', col:'var(--success)'};
      if (myAmt >= maxAmt && myAmt >= 500000) return {txt:'额度最高', col:'var(--accentB)'};
      if (['xmyh','xmns'].includes(p.id)) return {txt:'本地优先', col:'var(--cyan)'};
      if (['gov','institution','state'].includes(wt) && (p.bonus||'').includes('国企')) return {txt:'最适合你', col:'var(--warn)'};
      if (provident >= 2000 && (p.tags||[]).includes('公积金加分')) return {txt:'公积金专属', col:'var(--accentB)'};
      if (['zsyh','jsyh','jtyh'].includes(p.id)) return {txt:'审批最快', col:'var(--plat)'};
      return null;
    };
  })();

  // ── A级产品卡（无通过率条，有对比标签） ──
  const _mkCardA = p => {
    const badge  = _aCompBadge(p);
    const reason = _personalReason(p) || p.reason || '';
    const badgeHtml = badge
      ? `<span style="font-size:10px;font-weight:700;color:${badge.col};background:${badge.col}22;border:1px solid ${badge.col}55;padding:2px 8px;letter-spacing:.04em;margin-right:4px">${esc(badge.txt)}</span>`
      : '';
    return `<div class="product-card"><div class="pc-top"><div class="pc-info"><div class="pc-bank">${esc(p.bank)}</div><div class="pc-product">${esc(p.product)}</div></div><div class="pc-rate">${esc(p.rate)}</div></div><div class="pc-tags">${badgeHtml}${(p.tags||[]).map(t=>`<span class="pc-tag">${esc(t)}</span>`).join('')}<span class="pc-tag">${esc(p.amount)}</span></div>${reason?`<div class="pc-reason"><span class="pc-reason-text">${esc(reason)}</span></div>`:''}</div>`;
  };

  const _mkCard = p => {
    const pct=p.probPct||0;
    const bc=pct>=75?'var(--success)':pct>=55?'var(--accentB)':'var(--danger)';
    const isNotRec=p.prob==='不推荐';
    const cardStyle=isNotRec?'opacity:0.55;filter:grayscale(30%)':'';
    const badgeCls=p.prob==='高'?'badge-ok':p.prob==='中'?'badge-warn':'badge-bad';
    const notRecTag=isNotRec?`<span class="pc-tag" style="color:#f87171;background:rgba(192,57,43,.12)">当前评分偏低</span>`:'';
    return `<div class="product-card" style="${cardStyle}"><div class="pc-top"><div class="pc-info"><div class="pc-bank">${esc(p.bank)}</div><div class="pc-product">${esc(p.product)}</div></div><div class="pc-rate">${esc(p.rate)}</div></div><div class="pc-prob"><div class="pc-prob-bar"><div class="pc-prob-fill" style="width:${pct}%;background:${bc}"></div></div><div class="pc-prob-val">${pct}%</div></div><div class="pc-tags"><span class="badge ${badgeCls}">${esc(p.prob)}概率</span>${notRecTag}${(p.tags||[]).map(t=>`<span class="pc-tag">${esc(t)}</span>`).join('')}<span class="pc-tag">${esc(p.amount)}</span></div><div class="pc-reason" onclick="var d=this.nextElementSibling;if(d&&d.classList.contains('pc-reason-detail')){d.classList.toggle('show');this.querySelector('.pc-reason-toggle')?.classList.toggle('open')}"><span class="pc-reason-text">${esc(p.reason || _personalReason(p))||''}</span>${p.reason_detail?'<span class="pc-reason-toggle">▾</span>':''}</div>${p.reason_detail?'<div class="pc-reason-detail">'+esc(p.reason_detail)+'</div>':''}</div>`;
  };
  const _tierHd = (txt,sub)=>`<div style="grid-column:1/-1;margin:12px 0 4px;padding:7px 10px;border-left:3px solid var(--accentB);background:var(--glow)"><span style="font-size:12px;font-weight:700;color:var(--accentB)">${txt}</span>${sub?`<span style="font-size:11px;color:var(--silver);margin-left:6px">${sub}</span>`:''}` + `</div>`;

  // ── B级：边缘产品半锁定卡（有数据但降低信心，引导顾问） ──
  const _mkCardEdge = p => {
    const gaps = [];
    if (p.hurdle && v2Score < p.hurdle + 100) gaps.push(`评分提升${Math.max(0, p.hurdle + 100 - v2Score)}分`);
    if (p.maxQ3 && q3 > p.maxQ3 - 1) gaps.push(`查询降至${p.maxQ3}次以内`);
    if (p.maxQ1 && q1m > p.maxQ1 - 1) gaps.push(`近1月查询降至${p.maxQ1}次`);
    if (!gaps.length) gaps.push('优化核心征信指标');
    const bc = p.probPct >= 70 ? 'var(--warn)' : 'var(--danger)';
    return `<div class="product-card" style="opacity:0.72;cursor:pointer;border-color:rgba(217,128,0,.3)" onclick="showQrModal()"><div class="pc-top"><div class="pc-info"><div class="pc-bank">${esc(p.bank)}</div><div class="pc-product">${esc(p.product)}</div></div><div class="pc-rate">${esc(p.rate)}</div></div><div class="pc-prob"><div class="pc-prob-bar"><div class="pc-prob-fill" style="width:${p.probPct}%;background:${bc}"></div></div><div class="pc-prob-val">${p.probPct}%</div></div><div class="pc-tags">${gaps.map(g=>`<span class="pc-tag" style="color:var(--warn);border-color:rgba(217,128,0,.4)">▲ ${esc(g)}</span>`).join('')}<span class="pc-tag">${esc(p.amount)}</span></div><div class="pc-reason" style="color:var(--accentB);font-size:11px">顾问协助优化后通过率可提升 →</div></div>`;
  };
  if(products.length===0){
    // 根据实际数据生成具体的问题诊断和修复步骤
    const _zxProblems=[];
    if((data2.overdue_current||0)>0) _zxProblems.push({icon:'',text:`当前逾期 ${data2.overdue_current} 笔未结清，银行一票否决，必须立即结清`});
    if(q3>6) _zxProblems.push({icon:'',text:`近3个月审批查询 ${q3} 次，超出银行安全线（≤6次），需停止申请3个月待查询自然冷却`});
    if(onlineI>4) _zxProblems.push({icon:'',text:`网贷机构 ${onlineI} 家未结清，超出银行红线（≤4家），建议结清 ${onlineI-2} 家后再申请`});
    if(income>0&&dr>70) _zxProblems.push({icon:'',text:`负债率 ${dr}%，超出银行安全线（≤70%），需降低负债后申请`});
    if(cUtil>90) _zxProblems.push({icon:'',text:`信用卡使用率 ${cUtil}%，严重超标（≤70%），建议还款至50%以下`});
    if(_zxProblems.length===0) _zxProblems.push({icon:'',text:r.key_risk||'综合征信指标偏弱，建议联系顾问获取针对性优化方案'});
    const _zxSteps=[];
    if((data2.overdue_current||0)>0) _zxSteps.push(`结清全部逾期账户（预计1-2周，结清后征信状态改善）`);
    if(q3>6) _zxSteps.push(`停止所有贷款/信用卡申请，等待3个月查询冷却`);
    if(onlineI>4) _zxSteps.push(`优先结清通过率最低的网贷账户，目标降至4家以内`);
    if(cUtil>90) _zxSteps.push(`信用卡账单日前还款，将使用率降至50%以下`);
    if(_zxSteps.length===0) _zxSteps.push(`联系贷款顾问获取针对您情况的专属优化方案`);
    const _problemsHtml=_zxProblems.map(p=>`<div style="display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--danger);margin-top:6px;flex-shrink:0"></span><span style="font-size:12px;color:var(--plat);line-height:1.6">${esc(p.text)}</span></div>`).join('');
    const _stepsHtml=_zxSteps.map((s,i)=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0"><div style="flex-shrink:0;width:20px;height:20px;border:1px solid var(--accentB);display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:var(--accentB)">${i+1}</div><span style="font-size:12px;color:var(--plat);line-height:1.6">${esc(s)}</span></div>`).join('');
    document.getElementById('productsGrid').innerHTML=`<div style="background:var(--surface);border:1px solid var(--border);padding:16px;margin-bottom:8px"><div style="margin-bottom:12px"><div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px">DIAGNOSIS</div><div style="font-size:14px;font-weight:600;color:var(--white)">征信诊断报告</div><div style="font-size:11px;color:var(--silver);margin-top:2px">当前资质暂无可直接申请的银行产品，需优化后再申请</div></div><div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">问题诊断</div>${_problemsHtml}<div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin:12px 0 4px">优化步骤</div>${_stepsHtml}<div style="margin-top:12px;padding:10px;background:var(--glow);border:1px solid rgba(59,123,246,.25)"><div style="font-size:11px;color:var(--silver);margin-bottom:4px">优化后预计通过率</div><div style="font-size:16px;font-weight:700;color:var(--success)">${optRate}%+</div><div style="font-size:11px;color:var(--silver);margin-top:2px">完成以上步骤后可申请银行产品</div></div><button onclick="(function(){const t=document.createElement('textarea');t.value='Xmdzhun';document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);alert('微信号已复制：Xmdzhun');})()" style="display:block;width:100%;text-align:center;background:var(--accentB);color:#fff;padding:12px;font-size:13px;font-weight:600;border:none;cursor:pointer;font-family:inherit;margin-top:12px;letter-spacing:.06em">加客服微信，获取专属执行计划</button></div>`;
    // 零产品路径：convProb 和 adviceSection 与诊断报告内容重叠，隐藏
    const _cpEl = document.getElementById('convProb'); if (_cpEl) _cpEl.style.display = 'none';
    const _asEl = document.getElementById('adviceSection'); if (_asEl) _asEl.style.display = 'none';
  } else {
    const _parseRate = p => parseFloat((p.rate || '').replace('%','').replace('起','')) || 99;
    let _gridHtml = '';
    if (v2Level === 'A') {
      // A级：全部产品按利率升序，用对比标签替代通过率条
      const _sorted = [...products].sort((a, b) => _parseRate(a) - _parseRate(b));
      _gridHtml = _tierHd('全部产品', '已按利率从低到高排序，点击查看为什么适合你') + _sorted.map(_mkCardA).join('');
    } else if (v2Level === 'D') {
      // D级：只展示消费金融保底产品，不显示大量被拒产品
      const _fallback = products.filter(p => p.type !== 'bank');
      if (_fallback.length > 0) {
        _gridHtml = _tierHd('当前可申请', '银行产品暂不可申请，以下为保底方案') + _fallback.map(_mkCard).join('');
      } else {
        _gridHtml = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">当前暂无可直接申请的产品<br>请参考下方恢复路线图</div>`;
      }
    } else if (v2Level === 'B') {
      // B级：拆两层——高置信（现在可申）+ 边缘（优化后更有把握）
      const _EDGE_THRESHOLD = 80;
      const _nowProds  = products.filter(p => p.probPct >= _EDGE_THRESHOLD);
      const _edgeProds = products.filter(p => p.probPct < _EDGE_THRESHOLD);
      // 第一层：现在可申，按类型分组
      const _bigNow  = _nowProds.filter(p=>p.type==='bank'&&(p.tags||[]).includes('国有大行'));
      const _othNow  = _nowProds.filter(p=>p.type==='bank'&&!(p.tags||[]).includes('国有大行'));
      const _finNow  = _nowProds.filter(p=>p.type!=='bank');
      if(_bigNow.length)  _gridHtml += _tierHd('国有大行','优先申请，利率最低') + _bigNow.map(_mkCard).join('');
      if(_othNow.length)  _gridHtml += _tierHd('股份制 / 城商行','') + _othNow.map(_mkCard).join('');
      if(_finNow.length)  _gridHtml += _tierHd('消费金融','备选，最后申请') + _finNow.map(_mkCard).join('');
      // 第二层：优化后更有把握
      if(_edgeProds.length) {
        _gridHtml += _tierHd('优化后通过率更高', `${_edgeProds.length}款产品 · 联系顾问获取提升方案`);
        _gridHtml += _edgeProds.map(_mkCardEdge).join('');
      }
    } else {
      // C级：保持原有三层分组
      const _bigBank  = products.filter(p=>p.type==='bank'&&(p.tags||[]).includes('国有大行'));
      const _othBank  = products.filter(p=>p.type==='bank'&&!(p.tags||[]).includes('国有大行'));
      const _finProds = products.filter(p=>p.type!=='bank');
      if(_bigBank.length)  _gridHtml += _tierHd('国有大行','优先申请，利率最低') + _bigBank.map(_mkCard).join('');
      if(_othBank.length)  _gridHtml += _tierHd('股份制 / 城商行','') + _othBank.map(_mkCard).join('');
      if(_finProds.length) _gridHtml += _tierHd('消费金融','备选，最后申请') + _finProds.map(_mkCard).join('');
    }
    document.getElementById('productsGrid').innerHTML = _gridHtml;

    // ── 差距可视化：近似产品 ──
    const _matchedIds = new Set(products.map(p => p.id));
    const _gapItems = (typeof BANK_PRODUCTS !== 'undefined' ? BANK_PRODUCTS : [])
      .filter(p => !_matchedIds.has(p.id) && p.type === 'bank')
      .map(p => {
        const gaps = [];
        if (v2Score > 0 && v2Score < p.hurdle)
          gaps.push({ label:`评分差${p.hurdle - v2Score}分`, months: Math.ceil((p.hurdle-v2Score)/15) });
        if (p.maxQ3 && q3 > p.maxQ3)
          gaps.push({ label:`查询多${q3-p.maxQ3}次`, months: Math.min(3, q3-p.maxQ3+1) });
        if (p.maxQ1 && q1m > p.maxQ1)
          gaps.push({ label:`近1月查询${q1m}次超限`, months: 1 });
        if (p.maxDebt && income > 0 && dr > p.maxDebt)
          gaps.push({ label:`负债率${dr}%超${p.maxDebt}%`, months: 6 });
        if (!gaps.length) return null;
        const minMonths = Math.min(...gaps.map(g => g.months));
        const fd = new Date(); fd.setMonth(fd.getMonth() + minMonths);
        return { p, gaps: gaps.slice(0,2), minMonths, fixDateStr: `${fd.getFullYear()}年${fd.getMonth()+1}月` };
      })
      .filter(Boolean)
      .filter(g => g.gaps.length <= 2 && g.minMonths <= 6)
      .sort((a,b) => a.gaps.length - b.gaps.length || a.minMonths - b.minMonths)
      .slice(0, 3);
    const _gapEl = document.getElementById('gapSection');
    if (_gapEl) {
      if (_gapItems.length > 0 && v2Level !== 'D') {
        _gapEl.style.display = 'block';
        _gapEl.innerHTML = `<div class="gap-hd">再努力一点可解锁</div>${_gapItems.map(g=>`<div class="gap-item"><div class="gap-top"><span class="gap-bank">${esc(g.p.bank)} · ${esc(g.p.product)}</span><span class="gap-rate">${esc(g.p.rate)}</span></div><div class="gap-issues">${g.gaps.map(x=>`<span class="gap-tag">▲ ${esc(x.label)}</span>`).join('')}</div><div class="gap-fix"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accentB)" stroke-width="2" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>预计 <strong style="color:var(--white)">${esc(g.fixDateStr)}</strong> 可达标</div></div>`).join('')}`;
      } else {
        _gapEl.style.display = 'none';
      }
    }

    // 信用卡分期补充提示
    const _ccTips = document.getElementById('ccInstallTips');
    if (_ccTips) {
      _ccTips.style.display = 'block';
    }
  }

  // 旧版分析报告兼容渲染
  const adv=r.advice;
  if(adv){
    document.getElementById('adviceSection').style.display='block';
    if((adv.strengths||[]).length>0) document.getElementById('adviceStrengthsBody').innerHTML=adv.strengths.map(s=>`<div class="as-item"><div class="as-dot as-dot-green"></div><div><div class="as-point">${esc(s.point)}</div><div class="as-impact">${esc(s.impact)}</div></div></div>`).join('');
    const _issuesSub=document.getElementById('adviceIssuesSub');
    if((adv.issues||[]).length>0){
      if(_issuesSub)_issuesSub.style.display='';
      document.getElementById('adviceIssuesBody').innerHTML=adv.issues.map(s=>`<div class="as-item"><div class="as-dot as-dot-red"></div><div><div class="as-point">${esc(s.point)}</div><div class="as-impact">${esc(s.impact)}</div></div></div>`).join('');
    } else {
      if(_issuesSub)_issuesSub.style.display='none';
    }
    if((adv.suggestions||[]).length>0) document.getElementById('adviceSuggestionsBody').innerHTML=adv.suggestions.map((s,i)=>`<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${esc(s.action)}</div><div class="as-impact">${esc(s.goal)}</div><div class="as-step-meta"><span class="as-step-tag">${esc(s.time)}</span><span class="as-step-tag">${esc(s.effect)}</span></div></div></div>`).join('');
  }
  if((r.rejected_products||[]).length>0){document.getElementById('rejectedSection').style.display='block';document.getElementById('rejectedBody').innerHTML=r.rejected_products.map(rp=>`<div class="as-item"><div class="as-dot as-dot-amber"></div><div><div class="as-point">${esc(rp.type)}</div><div class="as-impact">${esc(rp.reason)}</div></div></div>`).join('');}
  if((r.optimization||[]).length>0){document.getElementById('optimizationSection').style.display='block';document.getElementById('optimizationBody').innerHTML=r.optimization.map((o,i)=>`<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${esc(o.step)}</div><div class="as-impact">${esc(o.goal)}</div><div class="as-step-meta"><span class="as-step-tag">${esc(o.time)}</span><span class="as-step-tag">${esc(o.unlock)}</span></div></div></div>`).join('');}
  if(r.post_optimization){document.getElementById('postOptSection').style.display='block';document.getElementById('postOptBody').textContent=r.post_optimization;}
  document.getElementById('analysisReport').style.display='block';

  // 风险banner
  const riskMap={'健康':{cls:'risk-healthy',icon:'',label:'征信状态：健康',desc:'整体征信良好，无明显风控风险'},'轻微瑕疵':{cls:'risk-mild',icon:'',label:'征信状态：轻微瑕疵',desc:'存在轻微不足，不影响主要银行产品申请'},'中度风险':{cls:'risk-medium',icon:'',label:'征信状态：中度风险',desc:'存在影响银行审批的关键问题，需优化后再申请'},'高风险':{cls:'risk-high',icon:'',label:'征信状态：高风险',desc:'已触碰银行硬红线，当前申请银行产品大概率拒贷'}};
  const rl=r.risk_level||'轻微瑕疵';
  const rDef=riskMap[rl]||riskMap['轻微瑕疵'];
  const banner=document.getElementById('riskLevelBanner');
  if(banner){banner.className='risk-banner '+rDef.cls;banner.innerHTML=`<div><div class="rb-level">${rDef.label}</div><div class="rb-desc">${esc(r.key_risk)||rDef.desc}</div></div>`;}

  // ── D级：显示恢复路线图 ──
  if (v2Level === 'D') _renderRehabRoadmap(r);

  document.getElementById('matchResult').style.display='block';
  document.getElementById('matchResult').scrollIntoView({behavior:'smooth',block:'start'});
  window._isMatching = false; // 释放匹配状态锁
  _trackEvent('match_result_shown', { product_count: (r.products||[]).length, level: r.level || null });
  autoSendReport();
}

// ═══════════════════════════════════════════
// INFO FORM
// ═══════════════════════════════════════════
const _assetState = { house:false, car:false, biz:false, none:false };
const _socialState = { val: null }; // 'yes' | 'no' | null

function showInfoForm() {
  document.getElementById('infoCard').style.display = 'block';
  document.getElementById('matchBtn').style.display = 'none';
  document.getElementById('infoCard').scrollIntoView({ behavior:'smooth', block:'start' });
}

function selectToggle(group, val, btn) {
  if (group === 'social') {
    _socialState.val = val;
    document.getElementById('social-yes').className = 'if-toggle' + (val==='yes' ? ' active-yes' : '');
    document.getElementById('social-no').className  = 'if-toggle' + (val==='no'  ? ' active-no'  : '');
    document.getElementById('social-months-wrap').style.display = val === 'yes' ? 'block' : 'none';
  }
}

function toggleAssetBtn(type, el) {
  if (type === 'none') {
    Object.keys(_assetState).forEach(k => _assetState[k] = false);
    _assetState.none = !document.getElementById('asset-none').classList.contains('selected');
    document.getElementById('house-sub').style.display = 'none';
  } else {
    _assetState.none = false;
    _assetState[type] = !_assetState[type];
    document.getElementById('asset-none').classList.remove('selected');
    document.getElementById('asset-none').querySelector('.ia-check').textContent = '';
    if (type === 'house') {
      document.getElementById('house-sub').style.display = _assetState.house ? 'block' : 'none';
    }
  }
  // Update all asset UI
  ['house','car','biz','none'].forEach(k => {
    const el2 = document.getElementById('asset-' + k);
    const chk = el2.querySelector('.ia-check');
    if (_assetState[k]) { el2.classList.add('selected'); chk.textContent = ''; }
    else { el2.classList.remove('selected'); chk.textContent = ''; }
  });
}

function collectInfoData() {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const sel = id => {
    const el = document.getElementById(id);
    return el && el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '';
  };
  const workMap = {
    gov:'政府机关/公务员', institution:'事业单位', state:'国有企业/央企',
    listed:'上市公司/500强', private:'私营企业', self:'个体工商户', freelance:'自由职业'
  };
  const hukouMap = { local:'厦门本地户籍', fujian:'福建省内', other:'外省户籍' };
  const eduMap = { bachelor:'全日制本科及以上', college:'全日制大专', other_degree:'函授/自考', high:'高中及以下' };
  const workVal = v('if-work');
  const hukouVal = v('if-hukou');
  const eduVal = v('if-edu');
  const assets = [];
  if (_assetState.house) {
    const hs = document.getElementById('if-house-status');
    const hsText = hs && hs.selectedIndex > 0 ? hs.options[hs.selectedIndex].text : '';
    assets.push('名下有房产' + (hsText ? '(' + hsText + ')' : ''));
  }
  if (_assetState.car)  assets.push('名下有车辆');
  if (_assetState.biz)  assets.push('名下有营业执照');
  if (_assetState.none) assets.push('暂无资产');
  return {
    income:       v('if-income') ? parseInt(v('if-income')) : null,
    work:         workMap[workVal] || workVal || '未填写',
    hukou:        hukouMap[hukouVal] || hukouVal || '未填写',
    edu:          eduMap[eduVal] || eduVal || '未填写',
    social:       _socialState.val === 'yes' ? ('有缴纳' + (v('if-social-months') ? '，已缴' + v('if-social-months') + '月' : '')) : _socialState.val === 'no' ? '无缴纳' : '未填写',
    provident:      v('if-provident') ? parseInt(v('if-provident')) : null,
    fixed_expense:  v('if-fixed-expense') ? parseInt(v('if-fixed-expense')) : null,
    assets:         assets.length > 0 ? assets.join(' / ') : '未填写',
  };
}


// ═══════════════════════════════════════════
// ID CARD INFO
// ═══════════════════════════════════════════
function calcAgeFromId(idNo) {
  if (!idNo || idNo.length !== 18) return null;
  const year  = parseInt(idNo.substring(6, 10));
  const month = parseInt(idNo.substring(10, 12));
  const day   = parseInt(idNo.substring(12, 14));
  const today = new Date();
  let age = today.getFullYear() - year;
  const m = today.getMonth() + 1 - month;
  if (m < 0 || (m === 0 && today.getDate() < day)) age--;
  return age;
}

function maskIdNo(idNo) {
  // Show first 6 and last 4, mask middle 8
  if (!idNo || idNo.length !== 18) return idNo || '--';
  return idNo.substring(0, 6) + '········' + idNo.substring(14);
}

function renderIdInfo(data) {
  const bar = document.getElementById('idInfoBar');
  if (!data.person_name && !data.id_number) return;
  bar.style.display = 'grid';
  document.getElementById('iib-name').textContent = data.person_name || '--';
  document.getElementById('iib-idno').textContent = maskIdNo(data.id_number);
  // Store full id for email report
  if (data.id_number) window._personIdNo = data.id_number;
  if (data.person_name) window._personName = data.person_name;
  const age = calcAgeFromId(data.id_number);
  document.getElementById('iib-age').textContent = age ? age + ' 岁' : '--';
  document.getElementById('iib-report-date').textContent = data.report_date || '--';
}

// ═══════════════════════════════════════════
// TABLE FOOTERS (totals)
// ═══════════════════════════════════════════
function renderTableFooters(loans, cards) {
  // Loans totals
  if (loans.length > 0) {
    const totalLimit   = loans.reduce((s, l) => s + (l.credit_limit || 0), 0);
    const totalBalance = loans.reduce((s, l) => s + (l.balance || 0), 0);
    const totalMonthly = loans.reduce((s, l) => s + calcLoanMonthly(l), 0);
    document.getElementById('loans-total-limit').innerHTML   = totalLimit   > 0 ? '<strong>' + fmt(totalLimit)   + ' 元</strong>' : '--';
    document.getElementById('loans-total-balance').innerHTML = totalBalance > 0 ? '<strong>' + fmt(totalBalance) + ' 元</strong>' : '--';
    document.getElementById('loans-total-monthly').innerHTML = totalMonthly > 0 ? '<strong>' + fmt(totalMonthly) + ' 元</strong>' : '--';
    document.getElementById('loansTfoot').style.display = '';
  }
  // Cards totals
  if (cards.length > 0) {
    const totalLimit = cards.reduce((s, c) => s + (c.limit || 0), 0);
    const totalUsed  = cards.reduce((s, c) => s + (c.used  || 0), 0);
    const totalUtil  = totalLimit > 0 ? Math.round(totalUsed / totalLimit * 100) : null;
    const utilColor  = totalUtil == null ? '' : totalUtil <= 30 ? 'var(--success)' : totalUtil <= 70 ? 'var(--warn)' : 'var(--danger)';
    document.getElementById('cards-total-limit').innerHTML = totalLimit > 0 ? '<strong>' + fmt(totalLimit) + ' 元</strong>' : '--';
    document.getElementById('cards-total-used').innerHTML  = totalUsed  > 0 ? '<strong>' + fmt(totalUsed)  + ' 元</strong>' : '--';
    document.getElementById('cards-total-util').innerHTML  = totalUtil  != null
      ? '<strong style="color:' + utilColor + '">' + totalUtil + '%</strong>' : '--';
    document.getElementById('cardsTfoot').style.display = '';
  }
}

// ═══════════════════════════════════════════
// AUTO REPORT → WORKER /report → RESEND
// ═══════════════════════════════════════════
const REPORT_URL     = PROXY_URL + '/api/v1/report';              // Worker 报告路由

function getPayToken() {
  const token = localStorage.getItem('_payToken');
  const exp   = parseInt(localStorage.getItem('_payTokenExp') || '0');
  if (!token || Date.now() > exp) {
    localStorage.removeItem('_payToken');
    localStorage.removeItem('_payTokenExp');
    return null;
  }
  return token;
}
function clearPayToken() {
  localStorage.removeItem('_payToken');
  localStorage.removeItem('_payTokenExp');
}

function buildReportText() {
  const data     = _recognizedData || {};
  const loans    = getActiveLoans(data);
  const cards    = getActiveCards(data);
  const q        = calcQueryCounts(data.query_records || []);
  const userInfo = (() => { try { return collectInfoData(); } catch(e) { return {}; } })();
  const products = window._lastMatchResult?.products || [];

  const name    = window._personName || '未识别';
  const idNo    = window._personIdNo || '未识别';
  const age     = calcAgeFromId(idNo);
  const rptDate = data.report_date || '--';

  const loanLines = loans.map((l, i) => {
    const isRev = l.is_revolving;
    const catMap = { mortgage:'房贷', car:'车贷', credit:'银行信用贷', finance:'消费金融' };
    const typeLabel = l.type === 'online'
      ? (l.online_subtype === 'microloan' ? '小额贷款' : l.online_subtype === 'online_bank' ? '助贷银行' : '消费金融')
      : (catMap[l.loan_category] || '银行贷款');
    const issuedStr = (() => {
      if (!l.issued_date) return '--';
      const d = new Date(l.issued_date);
      return isNaN(d) ? '--' : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
    })();
    const estM = calcLoanMonthly(l);
    const monthlyStr = estM > 0 ? fmt(estM)+'元(估)' : (l.monthly != null ? fmt(l.monthly)+'元' : '--');
    return `  ${i+1}. ${shortenBankName(l.name)}${isRev?' [循环授信]':''}`
      + ` | ${typeLabel}`
      + ` | 授信: ${l.credit_limit != null ? fmt(l.credit_limit)+'元' : '--'}`
      + ` | 余额: ${l.balance != null ? fmt(l.balance)+'元' : '--'}`
      + ` | 月还款: ${monthlyStr}`
      + ` | 开立: ${issuedStr}`
      + ` | 状态: ${l.status || '--'}`;
  }).join('\n') || '  无未结清贷款';

  const cardLines = cards.map((c, i) => {
    const util = c.limit > 0 ? Math.round((c.used||0)/c.limit*100) : null;
    return `  ${i+1}. ${c.name}`
      + ` | 授信: ${c.limit ? fmt(c.limit)+'元':'--'}`
      + ` | 已用: ${c.used!=null ? fmt(c.used)+'元':'--'}`
      + ` | 使用率: ${util!=null ? util+'%':'--'}`
      + ` | 状态: ${c.status||'--'}`;
  }).join('\n') || '  无未销户信用卡';

  const totalLoanBal  = loans.reduce((s,l)=>s+(l.balance||0),0);
  const totalCardLimit= cards.reduce((s,c)=>s+(c.limit||0),0);
  const totalCardUsed = cards.reduce((s,c)=>s+(c.used||0),0);
  const totalMonthly  = calcTotalMonthly(loans, cards);

  const productLines = products.map((p, i) =>
    `  ${i+1}. ${p.bank} · ${p.product}`
    + `\n     利率: ${p.rate} | 授信上限: ${p.amount}`
    + ` | 通过概率: ${p.probPct}% (${p.prob})`
    + `\n     推荐理由: ${p.reason||'--'}`
  ).join('\n') || '  暂无匹配产品';

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
贷准 AI 征信分析报告
报告时间：${new Date().toLocaleString('zh-CN')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【客户基本信息】
姓名：${name}  |  年龄：${age ? age+'岁' : '--'}
身份证：${idNo}
征信报告日期：${rptDate}

【补充信息】
月收入：${userInfo.income ? userInfo.income+'元' : '未填写'}
单位性质：${userInfo.work || '未填写'}
户籍：${userInfo.hukou || '未填写'}
学历：${userInfo.edu || '未填写'}
社保：${userInfo.social || '未填写'}
公积金月缴：${userInfo.provident != null ? userInfo.provident+'元' : '未填写'}
名下资产：${userInfo.assets || '未填写'}

━━━━━━━━━━━━━━━━
【征信概览】
未结清贷款：${loans.length} 笔  |  未销户信用卡：${cards.length} 张
贷款余额合计：${fmt(totalLoanBal)} 元
信用卡总额度：${fmt(totalCardLimit)} 元  |  已用：${fmt(totalCardUsed)} 元
月还款估算：${fmt(Math.round(totalMonthly))} 元${userInfo.income > 0 ? `  |  负债率：${Math.round(totalMonthly / userInfo.income * 100)}%（月收入 ${fmt(userInfo.income)} 元）` : ''}
历史逾期：${data.overdue_history_notes || '无'}

【查询记录（申请类6类统一口径）】
近1月：${q.q_1m} 次  |  近3月：${q.q_3m} 次  |  近6月：${q.q_6m} 次  |  近1年：${q.q_12m} 次

━━━━━━━━━━━━━━━━
【贷款账户明细（未结清 ${loans.length} 笔）】
${loanLines}

【信用卡账户明细（未销户 ${cards.length} 张）】
${cardLines}

━━━━━━━━━━━━━━━━
【AI 产品匹配结果（${products.length} 款）】
${productLines}

━━━━━━━━━━━━━━━━
由 贷准 dzhun.com.cn 生成`;
}

async function autoSendReport() {
  // Silently send full report to owner via Formspree — no UI needed
  if (window._reportSent) return; // only send once per session
  window._reportSent = true; // 立即标记，防止并发重复调用（竞态条件）
  try {
    const reportText = buildReportText();
    if (!reportText || reportText.length < 50) { // 报告内容异常时不发送
      window._reportSent = false;
      return;
    }
    const name = window._personName || '未识别';
    await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '来源':     _currentAgent ? `代理商渠道 · ${_currentAgent.name}（${_currentAgent.id}）` : '贷准官网 · AI征信匹配报告',
        '客户姓名': name,
        '提交时间': new Date().toLocaleString('zh-CN'),
        '渠道代理': _currentAgent ? `${_currentAgent.name} / ${_currentAgent.phone} / ID:${_currentAgent.id}` : '直客',
        '完整报告': reportText,
      }),
    });
    console.log('[贷准] 报告已推送');

    // 企业微信推送由 Cloudflare Worker 处理（前端直接fetch会被CORS拦截）
    // Worker 收到报告后根据 agent_id 自动推送到对应群
  } catch(e) {
    console.warn('[贷准] 报告推送失败', e);
  }
}

// ═══════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════
function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch(e) {}
  const stripped = text.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, s => s.replace(/```json|```/g,'').trim()).trim();
  try { return JSON.parse(stripped); } catch(e) {}
  // Quote-aware boundary finder: handles { } inside strings so lastIndexOf doesn't grab wrong }
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
        else if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(text.substring(start, i+1)); } catch(e) { break; } } }
      }
    }
  }
  return null;
}

function showQrModal() {
  // Body scroll lock：修复 WeChat/iOS 中 position:fixed 随页面滚动跑偏的问题
  const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  window._qrScrollY = scrollY;
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = '-' + scrollY + 'px';
  document.body.style.width = '100%';

  // 打开时才加载图片（WeChat 在 display:none 父容器里可能不加载 img src）
  const qrImg = document.getElementById('qrCodeImg');
  if (qrImg) {
    const qrSrc = (_currentAgent && _currentAgent.qr) ? _currentAgent.qr : (typeof DEFAULT_QR !== 'undefined' ? DEFAULT_QR : '/qr.jpg');
    qrImg.src = qrSrc;
    qrImg.style.display = 'block';
    qrImg.onerror = function() {
      this.style.display = 'none';
      const fb = document.getElementById('qrFallback');
      if (fb) fb.style.display = 'block';
    };
  }

  document.getElementById('qrOverlay').classList.add('show');
}
function hideQrModal(e) {
  if (!e || e.target === document.getElementById('qrOverlay') || e.currentTarget.classList.contains('qr-modal-close')) {
    document.getElementById('qrOverlay').classList.remove('show');
    // 还原 body scroll lock，滚回原位
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, window._qrScrollY || 0);
  }
}

// 初始化：读取代理商参数，替换电话和二维码
function initContactPhone() {
  // 读取URL中的agent参数
  const agentId = new URLSearchParams(location.search).get('agent');
  if (agentId && AGENTS[agentId]) {
    _currentAgent = { id: agentId, ...AGENTS[agentId] };
    console.log('[贷准] 代理商渠道:', _currentAgent.name, agentId);
  }

  const phone = _currentAgent ? _currentAgent.phone : CONTACT_PHONE;
  const qrSrc = _currentAgent ? _currentAgent.qr  : DEFAULT_QR;

  // 设置电话按钮
  const btn = document.getElementById('contactPhoneBtn');
  if (btn) { btn.href = 'tel:' + phone; }

  // 二维码图片路径存到 _currentAgent 或全局，打开弹窗时才加载（WeChat 兼容）
  if (_currentAgent) _currentAgent.qr = qrSrc;

  // 设置二维码备用文字（图片加载失败时显示）
  const qrPhone = document.getElementById('qrPhoneNum');
  if (qrPhone) { qrPhone.textContent = phone; }

  // 空产品引导里的联系电话也同步
  window._agentPhone = phone;
}
// 微信环境检测
const _isWeChat = /micromessenger/i.test(navigator.userAgent);

// 页面加载时处理支付宝回跳 & 微信 OAuth
document.addEventListener('DOMContentLoaded', () => {
  _trackEvent('page_view');
  initContactPhone();
  initAdvisorBadge();

  // 实时时钟
  (function tickClock(){
    const el = document.getElementById('hClock');
    if(!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString('zh-CN',{hour12:false});
    setTimeout(tickClock, 1000);
  })();

  // 支付宝 WAP 支付回跳检测
  const _urlParamsInit  = new URLSearchParams(location.search);
  const _fromAlipay     = _urlParamsInit.get('paid') === '1';
  const _pendingOrderId = localStorage.getItem('_alipayPendingOrderId') || _urlParamsInit.get('orderId');
  const _pendingTs      = parseInt(localStorage.getItem('_alipayPendingTs') || '0');
  const _pendingValid   = !!_pendingOrderId && (Date.now() - _pendingTs < 10 * 60 * 1000);
  const _savedData      = localStorage.getItem('_alipayPendingData');


  if (_fromAlipay || _pendingValid) {
    history.replaceState(null, '', location.pathname);

    // 先恢复征信数据（页面不显示空白）
    if (_savedData) {
      try {
        _recognizedData = JSON.parse(_savedData);
        document.getElementById('uploadCard').style.display = 'none';
        renderResult(_recognizedData);
      } catch(e) { console.warn('[alipay-return] 恢复征信数据失败', e); }
    }

    (async () => {
      let gotToken = null;

      // 优先：把回跳 URL 参数（含签名）发给 Worker 直接验证，绕开 KV 跨节点延迟
      if (_fromAlipay && _urlParamsInit.get('sign')) {
        try {
          const r = await fetch(PROXY_URL + '/api/v1/pay/alipay/verify-return?' + _urlParamsInit.toString());
          const d = await r.json();
          if (d.status === 'paid' && d.token) gotToken = d.token;
        } catch(e) { console.warn('[alipay-return] verify-return 失败:', e); }
      }

      if (gotToken) {
        // 直接拿到 token，清理并跳入匹配
        localStorage.removeItem('_alipayPendingOrderId');
        localStorage.removeItem('_alipayPendingTs');
        localStorage.removeItem('_alipayPendingData');
        _trackEvent('payment_success', { method: 'alipay_recovery' });
        localStorage.setItem('_payToken', gotToken);
        localStorage.setItem('_payTokenExp', String(Date.now() + 3600000));
        document.getElementById('payOverlay').classList.add('show');
        document.getElementById('payStep1').style.display = 'none';
        document.getElementById('payStep2').style.display = 'none';
        document.getElementById('payStep3').style.display = 'block';
        setTimeout(() => {
          document.getElementById('payOverlay').classList.remove('show');
          window._isMatching = false;
          startMatching();
        }, 1200);
      } else if (_pendingOrderId) {
        // 备用：显示弹窗并轮询
        localStorage.removeItem('_alipayPendingOrderId');
        localStorage.removeItem('_alipayPendingTs');
        localStorage.removeItem('_alipayPendingData');
        _payOrderId = _pendingOrderId;
        _confirmed  = false;
        _payCallback = () => startMatching();
        document.getElementById('payOverlay').classList.add('show');
        document.getElementById('payStep1').style.display = 'none';
        document.getElementById('payStep2').style.display = 'block';
        document.getElementById('payStep3').style.display = 'none';
        document.getElementById('payStep2Title').textContent = '正在确认支付结果…';
        document.getElementById('payLinkWrap').style.display = 'none';
        clearInterval(_pollTimer);
        _pollCount = 0;
        _pollTimer = setInterval(pollPayStatus, 2000);
      }
    })();

    return;
  }

  if (!_isWeChat) return;

  const _urlParams2 = new URLSearchParams(location.search);
  const _wxCode    = _urlParams2.get('code');
  const _wxState   = _urlParams2.get('state');

  if (_wxCode && _wxState === 'wxpay') {
    // OAuth 回调：换取 openid
    fetch(PROXY_URL + '/api/v1/pay/wechat/oauth?code=' + _wxCode)
      .then(r => r.json())
      .then(d => {
        if (d.openid) sessionStorage.setItem('_wxOpenid', d.openid);
        history.replaceState(null, '', location.origin + location.pathname);
      })
      .catch(() => {});
  } else if (!sessionStorage.getItem('_wxOpenid')) {
    // 首次进入微信：立刻静默授权拿 openid（用户无感知）
    const redirectUri = encodeURIComponent(location.href);
    location.href = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxbea6e08570fd3aaa&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=wxpay#wechat_redirect`;
  }
});

function restartAll() {
  _fileBlocks = []; _recognizedData = null;

  // Reset file input
  document.getElementById('fileInput').value = '';
  document.getElementById('fileInfo').classList.remove('show');
  document.getElementById('analyzeBtn').disabled = true;
  document.getElementById('analyzeBtnText').textContent = '请先上传征信报告';

  // Reset reading steps
  ['rs1','rs2','rs3','rs4','rs5'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
  });
  document.getElementById('rs1').classList.add('active');

  // Reset result area
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('loansSection').style.display = 'none';
  document.getElementById('cardsSection').style.display = 'none';
  document.getElementById('querySection').style.display = 'none';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('warnBox').style.display = 'none';
  document.getElementById('warnBox').innerHTML = '';
  document.getElementById('matchBtn').style.display = 'block';
  document.getElementById('infoCard').style.display = 'none';
  document.getElementById('matchingCard').style.display = 'none';

  // Reset matching
  ['ml1','ml2','ml3','ml4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
  document.getElementById('matchingLoading').style.display = 'block';
  const _ml1 = document.getElementById('ml1');
  if (_ml1) _ml1.classList.add('active'); // re-activate first step
  document.getElementById('matchResult').style.display = 'none';
  document.getElementById('productsGrid').innerHTML = '';

  // Remove any injected risk box
  const riskBox = document.querySelector('#matchResult .warn-box');
  if (riskBox) riskBox.remove();

  // Reset analysis sections
  document.getElementById('analysisReport').style.display = 'none';
  ['adviceSection','rejectedSection','optimizationSection','postOptSection']
    .forEach(id => { document.getElementById(id).style.display = 'none'; });
  ['adviceStrengthsBody','adviceIssuesBody','adviceSuggestionsBody'].forEach(id => { document.getElementById(id).innerHTML = ''; });
  window._onlineInstTotal = undefined;

  // Reset info form fields
  ['if-income','if-social-months','if-provident'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  ['if-work','if-hukou','if-edu','if-house-status'].forEach(id => {
    const el = document.getElementById(id); if(el) el.selectedIndex = 0;
  });
  _socialState.val = null;
  document.getElementById('social-yes').className = 'if-toggle';
  document.getElementById('social-no').className  = 'if-toggle';
  document.getElementById('social-months-wrap').style.display = 'none';
  document.getElementById('house-sub').style.display = 'none';
  Object.keys(_assetState).forEach(k => _assetState[k] = false);
  ['house','car','biz','none'].forEach(k => {
    const el = document.getElementById('asset-' + k);
    if(el){ el.classList.remove('selected'); el.querySelector('.ia-check').textContent = ''; }
  });

  // Reset send state
  window._reportSent = false;
  // Reset ID info bar
  document.getElementById('idInfoBar').style.display = 'none';
  document.getElementById('loansTfoot').style.display = 'none';
  document.getElementById('cardsTfoot').style.display = 'none';
  window._lastMatchResult = null;
  window._personName = null; window._personIdNo = null;

  // 重置新版结果页模块
  ['csWrap','brWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['convTop','convProb','convLoss','convLift','convPath','convClient','wlTip','convUrgent'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // 重置产品包装区
  const pw = document.getElementById('productsWrap');
  if (pw) pw.style.display = 'block';
  // 重置评分显示
  const sv = document.getElementById('csScoreVal');
  if (sv) sv.textContent = '--';
  // 重置状态锁
  window._isAnalyzing = false;
  window._isMatching  = false;

  // Show upload
  document.getElementById('readingCard').style.display = 'none';
  document.getElementById('uploadCard').style.display = 'block';
  document.getElementById('uploadCard').scrollIntoView({ behavior:'smooth' });
}

function rematch() {
  // 重置新版结果页模块
  ['convTop','convProb','convLoss','convLift','convPath','convClient','wlTip','convUrgent'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  window._isMatching = false;
  document.getElementById('matchResult').style.display = 'none';
  document.getElementById('matchingCard').style.display = 'none';
  document.getElementById('infoCard').style.display = 'block';
  ['ml1','ml2','ml3','ml4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
  const ml1 = document.getElementById('ml1');
  if (ml1) ml1.classList.add('active');
  document.getElementById('productsGrid').innerHTML = '';
  document.getElementById('analysisReport').style.display = 'none';
  window._reportSent = false;
  document.getElementById('infoCard').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ═══════════════════════════════════════════
// PAYMENT
// ═══════════════════════════════════════════

let _payCallback = null;
let _pollTimer   = null;
let _pollCount   = 0;
let _payOrderId  = null;
let _payUrl      = null;
let _confirmed   = false;

function showPayModal(callback) {
  _payCallback = callback;
  const overlay = document.getElementById('payOverlay');
  overlay.classList.add('show');
  document.getElementById('payStep1').style.display = 'block';
  document.getElementById('payStep2').style.display = 'none';
  document.getElementById('payStep3').style.display = 'none';
  // 微信支付仅在微信内可用（H5审核未通过）
  const wechatBtn = document.getElementById('payBtnWechat');
  if (wechatBtn) wechatBtn.style.display = _isWeChat ? '' : 'none';
}

function closePayModal() {
  clearInterval(_pollTimer);
  document.getElementById('payOverlay').classList.remove('show');
  window._isMatching = false; // 关闭支付弹窗时释放锁，允许重新触发匹配
}

function cancelPay() {
  clearInterval(_pollTimer);
  _payOrderId = null;
  _payUrl     = null;
  _confirmed  = false;
  document.getElementById('payStep1').style.display = 'block';
  document.getElementById('payStep2').style.display = 'none';
}

async function choosePay(channel) {
  // 微信内选择微信支付：先做 OAuth 静默授权拿 openid
  if (channel === 'wechat' && _isWeChat) {
    const openid = sessionStorage.getItem('_wxOpenid');
    if (!openid) {
      // openid 丢失，重新触发 OAuth
      const redirectUri = encodeURIComponent(location.href);
      location.href = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxbea6e08570fd3aaa&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=wxpay#wechat_redirect`;
      return;
    }
    // 已有 openid，创建 JSAPI 订单
    document.getElementById('payStep1').style.display = 'none';
    document.getElementById('payStep2').style.display = 'block';
    document.getElementById('payStep2Title').textContent = '正在创建订单…';
    document.getElementById('payLinkWrap').style.display = 'none';
    try {
      const resp = await fetch(PROXY_URL + '/api/v1/pay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'wechat', amount: 990, openid }),
      });
      const data = await resp.json();
      if (!data.orderId || !data.jsapi) throw new Error(data.error || '创建订单失败');
      _payOrderId = data.orderId;
      document.getElementById('payStep2Title').textContent = '请在微信中完成支付';

      // ── confirm 循环：唤起支付后立刻开始，不依赖 WXPay 回调 ──
      _confirmed = false;
      const _confirmOrderId = data.orderId;
      function _onPayConfirmed(token) {
        if (_confirmed) return;
        _confirmed = true;
        clearInterval(_pollTimer);
        _trackEvent('payment_success', { method: 'wechat' });
        localStorage.setItem('_payToken', token);
        localStorage.setItem('_payTokenExp', String(Date.now() + 3600000));
        document.getElementById('payStep2').style.display = 'none';
        document.getElementById('payStep3').style.display = 'block';
        setTimeout(() => {
          closePayModal();
          if (_payCallback) { _payCallback(); _payCallback = null; }
        }, 1200);
      }
      // 主动 confirm 循环（每 2s 查一次，最多 60s）
      (async () => {
        for (let i = 0; i < 30 && !_confirmed; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const cr = await fetch(PROXY_URL + '/api/v1/pay/wechat/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: _confirmOrderId }),
            });
            const cd = await cr.json();
            if (cd.status === 'paid' && cd.token) { _onPayConfirmed(cd.token); return; }
          } catch(e) {}
        }
      })();

      // 唤起微信支付
      function _invokeWxPay() {
        WeixinJSBridge.invoke('getBrandWCPayRequest', {
          appId:     data.jsapi.appId,
          timeStamp: data.jsapi.timeStamp,
          nonceStr:  data.jsapi.nonceStr,
          package:   data.jsapi.package,
          signType:  data.jsapi.signType,
          paySign:   data.jsapi.paySign,
        }, (res) => {
          if (res.err_msg === 'get_brand_wcpay_request:ok') {
            // WXPay 回调成功，立刻再查一次加速确认
            fetch(PROXY_URL + '/api/v1/pay/wechat/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: _confirmOrderId }),
            }).then(r => r.json()).then(cd => {
              if (cd.status === 'paid' && cd.token) _onPayConfirmed(cd.token);
            }).catch(() => {});
          } else if (res.err_msg !== 'get_brand_wcpay_request:cancel') {
            alert('支付失败：' + (res.err_msg || ''));
          }
        });
      }
      if (typeof WeixinJSBridge === 'undefined') {
        document.addEventListener('WeixinJSBridgeReady', _invokeWxPay, false);
      } else {
        _invokeWxPay();
      }
      // 兜底：依赖微信服务端回调
      clearInterval(_pollTimer);
      _pollCount = 0;
      _pollTimer = setInterval(pollPayStatus, 3000);
    } catch(e) {
      alert('创建支付订单失败：' + e.message);
      document.getElementById('payStep1').style.display = 'block';
      document.getElementById('payStep2').style.display = 'none';
    }
    return;
  }

  // 微信外 或 支付宝 → 原有跳转逻辑
  document.getElementById('payStep1').style.display = 'none';
  document.getElementById('payStep2').style.display = 'block';
  document.getElementById('payStep2Title').textContent = '正在创建订单…';
  document.getElementById('payLinkWrap').style.display = 'none';

  try {
    const resp = await fetch(PROXY_URL + '/api/v1/pay/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, amount: 990 }),
    });
    const data = await resp.json();
    if (!data.orderId) throw new Error(data.error || '创建订单失败');

    _payOrderId = data.orderId;
    _payUrl     = data.payUrl;

    document.getElementById('payLinkBtn').href        = _payUrl;
    document.getElementById('payLinkBtn').textContent = channel === 'wechat' ? '重新打开微信支付' : '重新打开支付宝';
    document.getElementById('payLinkWrap').style.display = 'block';
    document.getElementById('payStep2Title').textContent = '等待支付确认';

    // 打开支付页 —— 手机浏览器通常会拦截 window.open，回退到直接跳转
    // 跳走前把 orderId 和征信数据写入 localStorage（跨 tab / app 跳转仍可读）
    localStorage.setItem('_alipayPendingOrderId', _payOrderId);
    localStorage.setItem('_alipayPendingTs',      String(Date.now()));
    if (_recognizedData) localStorage.setItem('_alipayPendingData', JSON.stringify(_recognizedData));
    const opened = window.open(_payUrl, '_blank');
    if (!opened) window.location.href = _payUrl;

    // 开始轮询
    clearInterval(_pollTimer);
    _pollCount = 0;
    _pollTimer = setInterval(pollPayStatus, 2000);

  } catch(e) {
    alert('创建支付订单失败：' + e.message);
    document.getElementById('payStep1').style.display = 'block';
    document.getElementById('payStep2').style.display = 'none';
  }
}

async function pollPayStatus() {
  if (!_payOrderId || _confirmed) return;
  _pollCount++;
  if (_pollCount > 90) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    const titleEl = document.getElementById('payStep2Title');
    if (titleEl) titleEl.textContent = '支付确认超时，请重试';
    return;
  }
  try {
    const resp = await fetch(PROXY_URL + '/api/v1/pay/status/' + _payOrderId);
    const data = await resp.json();
    if (data.status === 'paid' && data.token) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      _trackEvent('payment_success', { method: 'poll' });
      localStorage.setItem('_payToken', data.token);
      localStorage.setItem('_payTokenExp', String(Date.now() + 3600000));
      document.getElementById('payStep2').style.display = 'none';
      document.getElementById('payStep3').style.display = 'block';
      setTimeout(() => {
        closePayModal();
        if (_payCallback) { _payCallback(); _payCallback = null; }
      }, 1200);
    }
  } catch(e) { /* 忽略轮询错误 */ }
}

// iOS Safari / WeChat bfcache 恢复时，DOMContentLoaded 不会重新触发
// pageshow 事件处理：① 重置状态锁（防止切屏后 _isAnalyzing/_isMatching 残留 true） ② 处理支付宝回跳
window.addEventListener('pageshow', (evt) => {
  if (!evt.persisted) return; // 不是 bfcache 恢复，忽略
  // 无论什么情况，bfcache 恢复时必须重置状态锁，否则填表单切屏后回来会永久卡住
  window._isAnalyzing = false;
  window._isMatching  = false;
  console.log('[贷准] bfcache restored → state flags reset');
  const ps = new URLSearchParams(location.search);
  if (ps.get('paid') !== '1') return;
  // 有支付宝回跳参数：调 verify-return 直接确认
  if (ps.get('sign')) {
    clearInterval(_pollTimer); // 立即停止轮询，防止轮询和 verify-return 竞态同时触发 startMatching
    (async () => {
      try {
        const r = await fetch(PROXY_URL + '/api/v1/pay/alipay/verify-return?' + ps.toString());
        const d = await r.json();
        if (d.status === 'paid' && d.token) {
          clearInterval(_pollTimer);
          _trackEvent('payment_success', { method: 'alipay_return' });
          localStorage.setItem('_payToken', d.token);
          localStorage.setItem('_payTokenExp', String(Date.now() + 3600000));
          localStorage.removeItem('_alipayPendingOrderId');
          localStorage.removeItem('_alipayPendingTs');
          localStorage.removeItem('_alipayPendingData');
          history.replaceState(null, '', location.pathname);
          document.getElementById('payStep2').style.display = 'none';
          document.getElementById('payStep3').style.display = 'block';
          setTimeout(() => {
            closePayModal();
            window._isMatching = false;
            if (_payCallback) { _payCallback(); _payCallback = null; }
            else startMatching();
          }, 1200);
        }
      } catch(e) { /* 静默失败，轮询继续 */ }
    })();
  }
});



// ── 顾问在线状态 Badge ──
function initAdvisorBadge() {
  const badge = document.getElementById('advisorBadge');
  const dot   = document.getElementById('advisorDot');
  const text  = document.getElementById('advisorBadgeText');
  if (!badge) return;
  const hour = new Date().getHours();
  const isOnline = hour >= 9 && hour < 21;
  if (isOnline) {
    badge.classList.remove('h-badge--offline');
    dot.classList.add('pulsing');
    text.textContent = '顾问在线';
  } else {
    badge.classList.add('h-badge--offline');
    dot.classList.remove('pulsing');
    text.textContent = '留言预约';
  }
}

// ── 下载指引折叠展开 ──
function toggleCreditGuide() {
  const panel = document.getElementById('creditGuidePanel');
  const arrow = document.getElementById('guideArrow');
  const open = panel.style.display === 'none';
  panel.style.display = open ? 'block' : 'none';
  arrow.style.transform = open ? 'rotate(180deg)' : '';
}

// ── 微信 JS-SDK 分享配置 ──
(async function initWechatShare() {
  if (typeof wx === 'undefined') return;
  try {
    const pageUrl = location.href.split('#')[0];
    const resp = await fetch(
      `${PROXY_URL}/api/v1/wechat/sign?url=${encodeURIComponent(pageUrl)}`
    );
    if (!resp.ok) return;
    const { appId, timestamp, nonceStr, signature } = await resp.json();

    wx.config({
      debug: false,
      appId, timestamp, nonceStr, signature,
      jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData']
    });

    wx.ready(function () {
      const shareData = {
        title:  '给征信做一次体检 — 贷准 AI',
        desc:   '102项检测维度，3分钟出报告，首次免费。',
        link:   'https://dzhun.com.cn/',
        imgUrl: 'https://dzhun.com.cn/share-cover.png'
      };
      wx.updateAppMessageShareData(shareData);
      wx.updateTimelineShareData(shareData);
    });
  } catch (e) { /* 静默失败，OG标签兜底 */ }
})();
