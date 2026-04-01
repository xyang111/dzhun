function loadProducts() {} // 已内置，保留空函数供初始化调用兼容

// ── 动态生成 AI prompt 用的产品库文本 ──
function buildProductLibText(q3, q6, hasOverdue, onlineCount, q1) {
  // 读取用户补充信息，用于预判
  const userInfo     = (() => { try { return collectInfoData(); } catch(e) { return {}; } })();
  const income       = userInfo.income || 0;
  const provident    = userInfo.provident || 0;
  const hasSocial    = userInfo.social && userInfo.social.includes('有');
  const socialMonths = (() => {
    if (!hasSocial) return 0;
    const m = (userInfo.social || '').match(/(\d+)/);
    return m ? parseInt(m[1]) : 6; // 有社保但未填月数，保守按6月
  })();
  const eduVal  = userInfo.edu || '';
  const eduRank = { '': 0, '高中及以下': 1, '函授/自考': 2, '全日制大专': 3, '全日制本科及以上': 4 };
  const userEduRank = eduRank[eduVal] || 0;
  const minEduRank  = { none:0, high:1, other_degree:2, college:3, bachelor:4, master:5 };
  const userWorkType = WORK_TYPE_MAP[userInfo.work || ''] || 'private';

  // 负债率（用于一票否决判断）
  const debtRatioPctLib = (() => {
    if (!income) return null;
    const ls = getActiveLoans(_recognizedData);
    const cs = getActiveCards(_recognizedData);
    const tm = calcTotalMonthly(ls, cs);
    return tm > 0 ? Math.round(tm / income * 100) : 0;
  })();
  // 年龄
  const _ageLib = calcAgeFromId(window._personIdNo || '');

  // 一票否决函数（复用于过滤 + 摘要）
  // 读取不良记录（供isRejected使用）
  const _ovNlib   = (_recognizedData?.overdue_history_notes||'').toLowerCase();
  const _bdNlib   = (_recognizedData?.bad_record_notes||'').toLowerCase();
  const _seriousLib = _ovNlib.includes('连三')||_ovNlib.includes('连续3')||
                      _ovNlib.includes('累六')||_ovNlib.includes('累计6')||
                      _ovNlib.includes('m2')||_ovNlib.includes('60天');
  const _badRecLib  = (_recognizedData?.has_bad_record===true)
    ||_bdNlib.includes('呆账')||_bdNlib.includes('代偿')||_bdNlib.includes('担保代还')
    ||_ovNlib.includes('呆账')||_ovNlib.includes('代偿')||_ovNlib.includes('担保代还');
  const _ovHistLib  = _recognizedData?.has_overdue_history||false;
  const _onlineInstLib = [...new Set(
    (_recognizedData?.loans||[]).filter(l=>l.type==='online').map(l=>l.name.split('-')[0])
  )].length;
  const _hasOverLib = (_recognizedData?.overdue_current||0)>0;

  const isRejected = p => {
    const hasProvident2 = provident > 0;
    return (_hasOverLib)                                              // 当前逾期
      || (_seriousLib)                                               // 严重逾期
      || (_badRecLib)                                                // 呆账/担保代还
      || (_onlineInstLib > 12)                                       // 网贷>12家
      || (_onlineInstLib > 8 && p.type === 'bank')                   // 网贷>8家排银行
      || (p.overdue === 'mild' && _ovHistLib)                        // mild+历史逾期
      || (q3 > p.maxQ3)
      || (p.maxQ1 != null && (q1 || 0) > p.maxQ1)
      || (p.maxQ6 !== null && q6 > p.maxQ6)
      || (p.maxDebt && income > 0 && debtRatioPctLib != null && debtRatioPctLib > p.maxDebt)
      || ((_ageLib && p.minAge && _ageLib < p.minAge) || (_ageLib && p.maxAge && _ageLib > p.maxAge))
      || (p.minIncome && income > 0 && income < p.minIncome)
      || (p.social && (!hasSocial && !hasProvident2))
      || (p.social && p.minSocialMonths && hasSocial && socialMonths < p.minSocialMonths)
      || (p.minProvident && userInfo.provident !== null && provident < p.minProvident)
      || (p.minEdu && p.minEdu !== 'none' && userEduRank > 0 && userEduRank < (minEduRank[p.minEdu]||0))
      || (p.workTypes && p.workTypes.length > 0 && !p.workTypes.includes(userWorkType));
  };

  const eligible = BANK_PRODUCTS.filter(p => !isRejected(p));
  const skipped  = BANK_PRODUCTS.length - eligible.length;

  const header = `【产品库已预过滤】系统前端已剔除${skipped}款一票否决产品，以下${eligible.length}款均为本客户可申请产品，请直接评分排序，无需再做准入判断。\n`;

  const productLines = eligible.map(p => {
    const q3limit = p.maxQ3 === 99 ? '不限' : p.maxQ3 + '次';
    const q6limit = p.maxQ6 ? (' | 近6月上限：' + p.maxQ6 + '次') : '';
    const debtLmt = p.maxDebt ? p.maxDebt + '%' : '不限';
    const ovReq   = p.overdue === 'zero' ? '零逾期'
                  : p.overdue === 'mild' ? '历史轻微逾期可接受' : '宽松';
    const incReq  = p.minIncome ? (' | 最低月收入：' + p.minIncome + '元') : '';
    const socReq  = p.minSocialMonths ? (' | 社保≥' + p.minSocialMonths + '月') : (p.social ? ' | 需要社保/公积金' : '');
    const pvdReq  = p.minProvident ? (' | 公积金基数≥' + p.minProvident + '元') : '';
    const eduReq  = (p.minEdu && p.minEdu !== 'none') ? (' | 学历≥' + {college:'大专',bachelor:'本科',master:'硕士'}[p.minEdu]) : '';

    return p.emoji + p.bank + '-' + p.product + '\n'
      + '  ✅【可申请】\n'
      + '  利率：' + p.rate + ' | 最高：' + p.amount
        + ' | 近3月查询上限：' + q3limit + q6limit + '\n'
      + '  逾期要求：' + ovReq + ' | 负债率上限：' + debtLmt + incReq + socReq + pvdReq + eduReq + '\n'
      + '  准入条件：' + p.conditions + '\n'
      + '  加分项：' + p.bonus;
  }).join('\n\n');

  return header + (eligible.length > 0 ? productLines : '（无可申请产品，请在匹配结果中说明原因）');
}

// ── 本地兜底匹配（AI失败时使用，逻辑与产品库完全同步）──
function localFallbackMatch(data) {
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
  const q1          = q.loan_1m || 0;
  const q3          = (q.loan_3m || 0) + (q.loan_3m_card || 0);
  const q6          = q.loan_6m_total || 0;
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

  // ── 方案C：用 csScore 替换固定基础分 65 ──
  // calcCreditScore 需要 data（征信）+ userInfo（补充信息）
  const _csResult   = calcCreditScore(data, userInfo);
  const _csScore    = _csResult.score; // 0-100
  // 基础分 = csScore × 0.65，范围约 0-65
  // csScore=85 → 基础分55；csScore=70 → 基础分46；csScore=40 → 基础分26
  const _baseScore  = Math.round(_csScore * 0.65);

  // 产品分层：csScore决定推荐产品类型
  // ≥80：银行优先；60-79：银行+消费金融混合；<60：消费金融为主
  const _tier = _csScore >= 80 ? 'bank' : _csScore >= 60 ? 'mixed' : 'finance';

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

    // ── 通过率计算（方案C：基础分由csScore驱动）──
    const qRatio = p.maxQ3 === 99 ? 0 : q3 / p.maxQ3;
    let score = _baseScore; // 动态基础分（csScore×0.65）

    // 查询次数评分
    if (qRatio <= 0.4)      score += 15;
    else if (qRatio <= 0.7) score += 5;
    else                    score -= 10;

    // 逾期加分
    if (!hasOverdue && !hasOvHist)                    score += 10;
    else if (hasOvHist && p.overdue === 'mild')        score += 3;

    // 网贷扣分
    score += onlinePenalty;

    // 公积金加分
    if (provident > 0) {
      if (provident >= 2000)       score += 10;
      else if (provident >= 1000)  score += 6;
      else                         score += 3;
    }

    // 社保加分
    if (hasSocial) {
      if (socialMonths >= 24)       score += 8;
      else if (socialMonths >= 12)  score += 5;
      else                          score += 2;
    }

    // 单位性质加分
    if (['gov','institution','state'].includes(userWorkType))     score += 10;
    else if (['listed'].includes(userWorkType))                    score += 6;

    // 学历加分（有加分项的产品）
    if (userEduRank >= 4) score += 5;  // 本科及以上
    else if (userEduRank >= 3) score += 2;  // 大专

    // 收入加分
    if (income >= 10000)      score += 5;
    else if (income >= 5000)  score += 2;
    else if (income > 0 && income < 5000) score -= 5;

    // 户籍加分/减分（厦门本地银行敏感）
    const hukouV = userInfo.hukou || '';
    if (hukouV.includes('厦门'))      score += 5;
    else if (hukouV.includes('福建')) score += 2;
    else if (hukouV && hukouV !== '未填写') score -= 3;

    // 资产加分
    const assetsV = userInfo.assets || '';
    if (assetsV.includes('房产'))    score += 8;
    else if (assetsV.includes('车辆')) score += 4;

    // 负债率扣分（超过上限已在一票否决中排除，这里只做接近上限的扣分）
    if (p.maxDebt && debtRatio > 0 && income > 0) {
      if (debtRatio > p.maxDebt * 0.9)       score -= 10;
      else if (debtRatio > p.maxDebt * 0.7)  score -= 5;
    }

    // 产品分层软调整（不排除，只调整分数和概率档位）
    let _scoreFinal = score;
    // 消金产品在银行优先层（_tier=bank）时，额外扣5分（软降级）
    if (_tier === 'bank' && p.type === 'online') _scoreFinal -= 5;
    // 银行产品在消金层（_tier=finance）时，csScore太低自然基础分已低，无需额外调整

    const probPct = Math.max(10, Math.min(95, Math.round(_scoreFinal)));
    // 四档概率：银行产品和消金产品使用不同门槛
    // 消金产品（type=online）准入宽松，整体门槛降15分
    const _isOnline = p.type === 'online';
    const prob = _isOnline
      ? (probPct >= 60 ? '高' : probPct >= 45 ? '中' : probPct >= 30 ? '低' : '不推荐')
      : (probPct >= 75 ? '高' : probPct >= 60 ? '中' : probPct >= 45 ? '低' : '不推荐');

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
      ? `征信综合评分 ${_csScore} 分（${_tierLabel}），匹配到 ${sorted.length} 款产品，其中高概率 ${_highCount} 款`
      : `征信综合评分 ${_csScore} 分，当前资质暂无可匹配产品，建议优化征信后再申请`,
    count: sorted.length,
    key_risk: keyRisk,
    risk_level: riskLevel,
    cs_score: _csScore,
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


// ═══════════════════════════════════════════
// 征信评分系统
// ═══════════════════════════════════════════

function calcCreditScore(data, ui) {
  if (!data || typeof data !== 'object') data = {};
  const loans = getActiveLoans(data);
  const cards = getActiveCards(data);
  const q     = calcQueryCounts(data.query_records||[]);
  const q3    = (q.loan_3m||0)+(q.loan_3m_card||0);
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
  const filt = (qRecords||[]).filter(q=>q.type==='贷款审批'||q.type==='信用卡审批');
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
  if(risk>=80){badge='🟢 正常';cls='br-safe';tip='查询频率正常，可正常申请各类产品。';}
  else if(risk>=60){badge='🟡 偏高';cls='br-warn';tip='近期查询偏多，建议暂停查询2-3周后再申请，当前申请银行类产品通过率下降约20-30%。';}
  else if(risk>=30){badge='🟠 爆查';cls='br-danger';tip='⚠️ 近期查询次数过多！建议停止所有查询1个月，银行类产品当前基本无法通过。';}
  else{badge='🔴 严重';cls='br-critical';tip='🔴 查询严重超标，银行系统会直接判定为"资金紧张"，建议停止查询3个月后再评估。';}
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
  const limit = loan.credit_limit || loan.limit || bal; // 授信额度，兜底用余额
  const blRatio = limit > 0 ? bal / limit : 1;

  // ── 消费金融 / 网贷（等额本息）──────────────────────────────
  if (cat === 'finance') {
    // 网贷默认12期，消费金融默认36期
    const totalPeriods = (loan.type === 'online' && loan.online_subtype !== 'online_bank') ? 12 : 36;
    if (elapsed !== null && elapsed >= 1) {
      const remaining = Math.max(totalPeriods - elapsed, 1);
      // PMT等额本息：月利率1.5%（18%/12），更贴近消费金融实际利率
      const r = 0.015;
      return Math.round(bal * r / (1 - Math.pow(1 + r, -remaining)));
    }
    // 发放不足1个月，按全期保守估算
    const r = 0.015;
    return Math.round(bal * r / (1 - Math.pow(1 + r, -36)));
  }

  // ── 银行信用贷（credit）──────────────────────────────────────
  // 循环贷账户：先息后本，余额减少是主动还款，不代表固定还款计划
  if (loan.is_revolving) return Math.round(bal * (0.045 / 12));

  // 非循环贷：用B/L比值区分先息后本 vs 等额本息
  if (elapsed !== null && elapsed >= 1) {
    if (blRatio > 0.97) {
      // 余额几乎未动 → 先息后本
      return Math.round(bal * (0.045 / 12));
    } else {
      // 余额在减少 → 等额本息，按剩余期数反推
      const remaining = Math.max(Math.round(blRatio * 36), 1);
      const r = 0.045 / 12;
      return Math.round(bal * r / (1 - Math.pow(1 + r, -remaining)));
    }
  }
  // 发放不足1个月，无法判断，保守按等额本息36期估算
  const r = 0.045 / 12;
  return Math.round(bal * r / (1 - Math.pow(1 + r, -36)));
}

function calcTotalMonthly(loans, cards) {
  const loanPart = loans.reduce((s, l) => s + calcLoanMonthly(l), 0);
  // 银行审批口径：信用卡按【已用额度×2%】折算月供（银行实际通用口径）
  const cardPart = cards.reduce((s, c) => s + Math.round((c.used || 0) * 0.02), 0);
  return loanPart + cardPart;
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
    document.getElementById('fileIcon').textContent = '📑';
    document.getElementById('fileName').textContent = f.name.length > 30 ? f.name.substring(0,28)+'…' : f.name;
    document.getElementById('fileSize').textContent = (f.size/1024).toFixed(0) + ' KB';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtnText').textContent = '🔬 开始AI识别分析';
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
    const totalKB = validBlocks.reduce((s, b) => s + Math.round(b.source.data.length * 0.75 / 1024), 0);
    document.getElementById('fileInfo').classList.add('show');
    document.getElementById('fileIcon').textContent = '🖼️';
    document.getElementById('fileName').textContent = validBlocks.length > 1
      ? `${validBlocks.length}张截图`
      : (files[0].name.length > 30 ? files[0].name.substring(0,28)+'…' : files[0].name);
    document.getElementById('fileSize').textContent = totalKB + ' KB（已压缩）';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtnText').textContent = '🔬 开始AI识别分析';
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
  if (window._isAnalyzing) return; // 状态锁，防重复触发
  window._isAnalyzing = true;

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
    const cacheKey = _fileBlocks.length > 0
      ? btoa(_fileBlocks[0].source.data.substring(0, 100)).substring(0, 32)
      : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(PROXY_URL + '/ocr', {
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
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    let data;
    try { data = JSON.parse(respText); } catch(e) { throw new Error('响应格式异常，请重试'); }
    if (data.error) throw new Error(data.error.message || 'API错误');

    const raw = data.raw;
    setStep(3); // rs4：汇总有效负债与查询数据
    const extracted = extractJson(raw);
    if (!extracted) throw new Error('未能识别到征信数据，请确认是人行征信报告');

    _recognizedData = extracted;

    // Finish steps animation
    steps.forEach(id => {
      document.getElementById(id).classList.remove('active');
      document.getElementById(id).classList.add('done');
    });

    setStep(4); // rs5：准备AI产品匹配（完成）
    setTimeout(() => {
      document.getElementById('readingCard').style.display = 'none';
      renderResult(extracted);
    }, 600);

  } catch(e) {
    window._isAnalyzing = false;
    clearTimeout(_t1); clearTimeout(_t2); clearTimeout(_t3);
    document.getElementById('readingCard').style.display = 'none';
    document.getElementById('uploadCard').style.display = 'block';
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('analyzeBtnText').textContent = '🔬 重新分析';

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

  let loan_1m = 0, loan_3m = 0, loan_3m_card = 0, loan_6m_total = 0;

  (queryRecords || []).forEach(r => {
    if (!r.date || !r.type) return;
    const d = new Date(r.date);
    d.setHours(0, 0, 0, 0);
    const isGuarantee  = r.type === '担保资格审查';
    const isLoan       = r.type === '贷款审批' || isGuarantee;
    const isCard       = r.type === '信用卡审批';

    if (isLoan && d >= cutoff1m) loan_1m++;
    if (isLoan && d >= cutoff3m) loan_3m++;
    if (isCard && d >= cutoff3m) loan_3m_card++;
    if ((isLoan || isCard) && d >= cutoff6m) loan_6m_total++;
  });

  return { loan_1m, loan_3m, loan_3m_card, loan_6m_total };
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

  document.getElementById('sumLoans').textContent = loans.length + ' 笔';
  document.getElementById('sumCards').textContent = cards.length + ' 张';
  document.getElementById('sumMonthly').textContent = totalMonthly > 0 ? '≈ ' + fmt(Math.round(totalMonthly)) + ' 元' : '--';
  document.getElementById('sumDebtRatio').textContent = '--';
  document.getElementById('sumDebtRatio').style.color = 'var(--gold)';
  // 渲染基础评分 + 爆查风险
  renderCreditScore(data, null);
  renderBlastRisk(data);
  document.getElementById('sumDebtHint').textContent = '填写月收入后显示';

  // Warn/notice boxes — reset first
  document.getElementById('warnBox').style.display = 'none';
  document.getElementById('warnBox').innerHTML = '';
  document.getElementById('onlineStatsBox').style.display = 'none';
  document.getElementById('onlineStatsBox').innerHTML = '';
  const warns = [];
  if (data.overdue_current > 0) {
    warns.push('🔴 存在 <strong>' + data.overdue_current + ' 笔</strong>当前逾期，银行不会放款，请立即结清');
  }
  // 不良记录警告（呆账/担保代还等）
  if (data.has_bad_record === true) {
    const _badDesc = data.bad_record_notes && data.bad_record_notes !== '无'
      ? data.bad_record_notes
      : '请检查征信详情';
    warns.push('🔴 存在严重不良记录：<strong>' + _badDesc + '</strong>。此类记录将导致所有银行产品无法申请，需优先处理');
  }

  // 历史逾期警告
  if (data.overdue_history_notes && data.overdue_history_notes !== '无') {
    warns.push('⚠️ 历史逾期记录（已结清）：' + data.overdue_history_notes + '。<strong>结清后6-12个月内</strong>部分银行仍会拒贷');
  }

  // OCR识别质量警告
  if ((data.ocr_warnings || []).length > 0) {
    data.ocr_warnings.forEach(w => {
      warns.push('⚠️ 识别提示：' + w + '，请核对上方数据是否准确，如有误请重新上传');
    });
  }

  // Query warnings — use new field names: loan_3m + loan_3m_card for 3-month total
  const q3loans = q.loan_3m || 0;
  const q3cards = q.loan_3m_card || 0;
  const q3total = q3loans + q3cards;
  const q6total = q.loan_6m_total || 0;

  if (q3total >= 5) warns.push('🔴 近3月审批查询 <strong>' + q3total + ' 次</strong>（贷款' + q3loans + '次+信用卡' + q3cards + '次），征信已花，建议暂停申请养3-6个月');
  else if (q3total >= 3) warns.push('⚠️ 近3月审批查询 <strong>' + q3total + ' 次</strong>（贷款' + q3loans + '次+信用卡' + q3cards + '次），偏多，部分银行可能拒贷');

  // 信用卡综合使用率警告
  const _cardLimitTotal = cards.reduce((s, c) => s + (c.limit || 0), 0);
  const _cardUsedTotal  = cards.reduce((s, c) => s + (c.used || 0), 0);
  const _cardUtil = _cardLimitTotal > 0 ? Math.round(_cardUsedTotal / _cardLimitTotal * 100) : 0;
  if (_cardUtil > 70) warns.push('🔴 信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，超过70%警戒线，银行审批将直接降分或拒贷');
  else if (_cardUtil > 50) warns.push('⚠️ 信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，超过50%预警线，建议降低至50%以下');
  else if (_cardUtil > 0) warns.push('✅ 信用卡综合使用率 <strong>' + _cardUtil + '%</strong>，处于安全范围');

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
      osb.style.cssText = 'display:block;border-radius:10px;padding:13px 16px;margin-bottom:12px;font-size:13px;line-height:1.8;border:1px solid rgba(192,57,43,.3);background:#fff0f0;color:var(--red)';
      osb.innerHTML = '🔴 ' + totalStr + '<br>' + breakdown + '<br><strong>已超红线，银行类贷款大概率拒贷，建议先结清网贷后再申请。</strong>';
      warns.push('🔴 网贷机构数 <strong>' + onlineInstTotal + ' 家</strong>，超出银行准入红线（≤4家），银行产品通过率大幅下调');
    } else if (onlineInstTotal === 3 || onlineInstTotal === 4) {
      osb.style.cssText = 'display:block;border-radius:10px;padding:13px 16px;margin-bottom:12px;font-size:13px;line-height:1.8;border:1px solid rgba(184,134,11,.3);background:#fff8e0;color:var(--amber)';
      osb.innerHTML = '⚠️ ' + totalStr + '<br>' + breakdown + '<br>轻度警示，申请银行贷款存在风险，建议结清至2家以内再申请。';
      warns.push('⚠️ 网贷机构数 <strong>' + onlineInstTotal + ' 家</strong>，轻度警示，部分银行可能拒贷');
    } else {
      osb.style.cssText = 'display:block;border-radius:10px;padding:13px 16px;margin-bottom:12px;font-size:13px;line-height:1.8;border:1px solid rgba(42,122,85,.25);background:var(--green-light);color:var(--green)';
      osb.innerHTML = '✅ ' + totalStr + '<br>' + breakdown + '<br>未超银行准入红线，网贷情况正常。';
    }
  } else {
    osb.style.display = 'none';
  }

  if (warns.length > 0) {
    document.getElementById('warnBox').style.display = 'block';
    document.getElementById('warnBox').innerHTML = warns.join('<br>');
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
      const colLimit   = l.credit_limit != null ? fmt(l.credit_limit) + '元' : '<span style="color:var(--gray-mid)">--</span>';
      const colBalance = l.balance != null      ? fmt(l.balance) + '元'      : '<span style="color:var(--gray-mid)">--</span>';
      const estMonthly = calcLoanMonthly(l);
      const colMonthly = estMonthly > 0
        ? fmt(estMonthly) + '元<span style="font-size:9px;color:var(--gray-mid);margin-left:3px">估算</span>'
        : '<span style="color:var(--gray-mid)">--</span>';
      const catMap = { mortgage:'🏠 房贷', car:'🚗 车贷', credit:'🏦 银行信用贷', finance:'📱 网贷' };
      let catLabel, badgeCls;
      if (l.type === 'online') {
        catLabel   = l.online_subtype === 'microloan' ? '💰 小额贷款'
                   : l.online_subtype === 'online_bank' ? '🏦 助贷银行'
                   : '📱 消费金融';
        badgeCls   = 'badge-warn';
      } else {
        catLabel = catMap[l.loan_category] || '🏦 银行贷款';
        badgeCls = 'badge-ok';
      }

      const issuedFmt = (() => {
        if (!l.issued_date) return '<span style="color:var(--gray-mid)">--</span>';
        const d = new Date(l.issued_date);
        if (isNaN(d)) return '<span style="color:var(--gray-mid)">--</span>';
        return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
      })();
      return `
        <tr>
          <td>${shortenBankName(l.name)}${isRev ? '<span style="font-size:9px;background:#e8f4ed;color:#2a7a55;padding:1px 5px;border-radius:3px;margin-left:5px">循环授信</span>' : ''}</td>
          <td><span class="badge ${badgeCls}">${catLabel}</span></td>
          <td style="text-align:right;font-weight:600">${colLimit}</td>
          <td style="text-align:right;font-weight:600">${colBalance}</td>
          <td style="text-align:right">${colMonthly}</td>
          <td style="text-align:center;font-size:12px;color:var(--text-mid)">${issuedFmt}</td>
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
      const utilColor = util == null ? 'var(--text-dark)' : util <= 30 ? 'var(--green)' : util <= 70 ? 'var(--amber)' : 'var(--red)';
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
      { label: '贷款审批 近1月', val: q.loan_1m,       ok: v => v <= 1, warn: v => v <= 2 },
      { label: '贷款审批 近3月', val: q.loan_3m,       ok: v => v <= 2, warn: v => v <= 4 },
      { label: '信用卡审批 近3月', val: q.loan_3m_card, ok: v => v <= 2, warn: v => v <= 4 },
      { label: '贷款+信用卡 近6月', val: q.loan_6m_total, ok: v => v <= 6, warn: v => v <= 12 },
    ];
    document.getElementById('queryGrid').innerHTML = items.map(item => {
      const v = item.val;
      const cls = v == null ? '' : item.ok(v) ? 'ok' : item.warn(v) ? 'warn' : 'bad';
      return `
        <div class="query-item">
          <div class="qi-label">${item.label}</div>
          <div class="qi-val ${cls}">${v != null ? v + ' 次' : '--'}</div>
        </div>
      `;
    }).join('');
  }

  // Empty state
  if (loans.length === 0 && cards.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('matchBtn').style.display = 'none';
  }

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

  document.getElementById('infoCard').style.display = 'none';
  document.getElementById('matchingCard').style.display = 'block';
  // 更新综合评分
  try { renderCreditScore(_recognizedData||{}, collectInfoData()); } catch(e){}
  document.getElementById('incomeWarnBanner').style.display = 'none'; // reset
  document.getElementById('matchingCard').scrollIntoView({ behavior:'smooth', block:'start' });

  // Animate steps
  const mlSteps = ['ml1','ml2','ml3','ml4'];
  let msi = 0;
  const mlTimer = setInterval(() => {
    if (msi < mlSteps.length) {
      if (msi > 0) {
        document.getElementById(mlSteps[msi-1]).classList.remove('active');
        document.getElementById(mlSteps[msi-1]).classList.add('done');
      }
      document.getElementById(mlSteps[msi]).classList.add('active');
      msi++;
    }
  }, 1800);

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
  // Use updated field names from recognition prompt
  const q3loans = q.loan_3m || 0;
  const q3cards = q.loan_3m_card || 0;
  const q3 = q3loans + q3cards;
  const q6 = q.loan_6m_total || 0;

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
  if (eduVal.includes('本科')) scoreItems.push('✅学历加分：全日制本科及以上');
  else if (eduVal.includes('大专')) scoreItems.push('➕学历中性：全日制大专');
  else if (eduVal) scoreItems.push('➖学历减分：' + eduVal);

  const workVal = userInfo.work || '';
  if (['政府机关/公务员','事业单位'].some(w => workVal.includes(w.split('/')[0]))) scoreItems.push('✅单位加分：' + workVal);
  else if (['国有企业','上市公司'].some(w => workVal.includes(w.split('/')[0]))) scoreItems.push('✅单位加分：' + workVal);
  else if (workVal && workVal !== '未填写') scoreItems.push('➖单位中性/减分：' + workVal);

  const pvd = userInfo.provident || 0;
  if (pvd >= 1000) scoreItems.push('✅公积金加分：' + pvd + '元/月（≥1000元，满足股份制银行优质客户准入）');
  else if (pvd >= 500) scoreItems.push('➕公积金中性：' + pvd + '元/月（500-999元）');
  else if (pvd > 0) scoreItems.push('➖公积金较低：' + pvd + '元/月（<500元）');
  else scoreItems.push('➖无公积金（优质产品准入受限）');

  if (socialMonths >= 12) scoreItems.push('✅社保加分：已缴' + socialMonths + '个月（≥12月，银行判定工作稳定）');
  else if (socialMonths >= 6) scoreItems.push('➕社保中性：已缴' + socialMonths + '个月（6-11月）');
  else if (socialMonths > 0) scoreItems.push('➖社保减分：已缴' + socialMonths + '个月（<6月，银行判定工作稳定性差）');
  else scoreItems.push('➖无社保（银行判定工作稳定性差，大额产品受限）');

  const hukouVal = userInfo.hukou || '';
  if (hukouVal.includes('厦门')) scoreItems.push('✅户籍加分：厦门本地户籍（本地银行全覆盖）');
  else if (hukouVal.includes('福建')) scoreItems.push('➕户籍中性：福建省内非厦门（多数厦门银行可做）');
  else if (hukouVal && hukouVal !== '未填写') scoreItems.push('➖户籍减分：省外户籍（部分厦门本地银行拒贷，需本地资产佐证）');

  const assetsVal = userInfo.assets || '';
  if (assetsVal.includes('房产')) scoreItems.push('✅资产加分：名下有房产（银行认可最高权重资产）');
  if (assetsVal.includes('车辆')) scoreItems.push('➕资产加分：名下有车辆');
  if (assetsVal.includes('营业执照')) scoreItems.push('➕资产：有营业执照（部分银行小微产品加分）');
  if (assetsVal.includes('暂无') || assetsVal === '未填写') scoreItems.push('➖无资产（无法提供抵押/增信）');

  const income = userInfo.income || 0;
  if (income >= 10000) scoreItems.push('✅收入加分：月收入' + income + '元（≥1万，大额产品无障碍）');
  else if (income >= 5000) scoreItems.push('➕收入中性：月收入' + income + '元（5000-9999元）');
  else if (income > 0) scoreItems.push('➖收入减分：月收入' + income + '元（<5000元，大额信用贷额度受限）');

  // Update debt ratio display in summary bar
  if (debtRatioPct != null) {
    const drEl   = document.getElementById('sumDebtRatio');
    const drHint = document.getElementById('sumDebtHint');
    drEl.textContent = debtRatioPct + '%';
    if (debtRatioPct > 70) {
      drEl.style.color = 'var(--red)';
      drHint.textContent = '⚠️ 警告：负债率过高';
    } else if (debtRatioPct >= 50) {
      drEl.style.color = 'var(--amber)';
      drHint.textContent = '⚡ 预警：接近风险线';
    } else {
      drEl.style.color = 'var(--green)';
      drHint.textContent = '✅ 安全线以内';
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
  // Step A：本地规则引擎算出候选产品（确定性，0ms）
  let _localResult;
  try { _localResult = localFallbackMatch(data); } catch(e) {
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
  mlSteps.forEach(id => {
    const el = document.getElementById(id);
    if(el){ el.classList.remove('active'); el.classList.add('done'); }
  });
  const _baseResult = Object.assign({}, _localResult, {
    current_products:   _localProds.length,
    optimized_products: Math.min(_localProds.length + 3, 8),
    client_type:        _clientType,
    products:           _localProds,
    cs_score:           _localResult.cs_score,
    cs_tier:            _localResult.cs_tier,
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
  setTimeout(() => {
    document.getElementById('matchingLoading').style.display = 'none';
    renderMatchResult(_baseResult);
    window._isMatching = false;
  }, 400);

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
    };
    // 直接调 Worker /match，不经过 callMatch（避免 402 时误删 token 或弹付费框）
    (async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 40000);
        const resp = await fetch(PROXY_URL + '/match', {
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
          if (el) { el.style.display = 'block'; document.getElementById('optimizationBody').innerHTML = aiResult.optimization.map((o,i) => `<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${_esc(o.step)}</div><div class="as-impact">${_esc(o.goal)}</div><div class="as-step-meta"><span class="as-step-tag">⏱ ${_esc(o.time)}</span><span class="as-step-tag">🎯 ${_esc(o.unlock)}</span></div></div></div>`).join(''); }
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
            if (adv.suggestions?.length > 0) document.getElementById('adviceSuggestionsBody').innerHTML = adv.suggestions.map((s,i) => `<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${_esc(s.action)}</div><div class="as-impact">${_esc(s.goal)}</div><div class="as-step-meta"><span class="as-step-tag">⏱ ${_esc(s.time)}</span><span class="as-step-tag">✨ ${_esc(s.effect)}</span></div></div></div>`).join('');
          }
        }
        if (aiResult.key_risk) {
          const banner = document.getElementById('riskLevelBanner');
          if (banner) { const desc = banner.querySelector('.rb-desc'); if (desc) desc.textContent = aiResult.key_risk; }
        }
        // AI 完成后隐藏"还有X个因素没分析完"
        const ctaEl = document.getElementById('convCta');
        if (ctaEl) ctaEl.style.display = 'none';
      } catch(e) { /* 超时或网络失败，静默忽略 */ }
    })();
  }
}

// localFallbackMatch 已移至 BANK_PRODUCTS 区块

function renderMatchResult(r) {
  if (!r) return;
  window._lastMatchResult = r;

  // ── 基础数据计算 ──
  const income  = parseFloat(document.getElementById('if-income')?.value)||0;
  const workVal = document.getElementById('if-work')?.value||'';
  const data2   = _recognizedData||{};
  const loans2  = getActiveLoans(data2);
  const cards2  = getActiveCards(data2);
  const monthly = calcTotalMonthly(loans2,cards2);
  const dr      = income>0?Math.round(monthly/income*100):0;
  const q       = calcQueryCounts(data2.query_records||[]);
  const q3      = (q.loan_3m||0)+(q.loan_3m_card||0);
  const onlineL = loans2.filter(l=>l.type==='online');
  const onlineI = [...new Set(onlineL.map(l=>l.name.split('-')[0]))].length;
  const cLimit  = cards2.reduce((s,c)=>s+(c.limit||0),0);
  const cUsed   = cards2.reduce((s,c)=>s+(c.used||0),0);
  const cUtil   = cLimit>0?Math.round(cUsed/cLimit*100):0;
  const wtMap   = {'政府机关/公务员':95,'事业单位':90,'国有企业/央企':80,'上市公司/500强':70,'私营企业':60,'个体工商户':50,'自由职业':50};
  const wt      = WORK_TYPE_MAP[workVal]||'private';
  const mult    = wtMap[workVal]||50;
  const nmDebt  = loans2.filter(l=>l.loan_category!=='mortgage'&&!l.name.includes('房')&&!l.name.includes('按揭')).reduce((s,l)=>s+(l.balance||0),0);
  let qf=1;
  if(q3>10)qf*=.5;else if(q3>6)qf*=.7;
  if(loans2.length>=5)qf*=.8;
  if(cUtil>90)qf*=.7;else if(cUtil>70)qf*=.85;
  const _isAmtNum = s => /^[\d<–\-]/.test(s);
  const estLo  = income>0?Math.max(0,(income*30-nmDebt)*qf):0;
  const estHi  = income>0?Math.max(0,Math.min(1e6,(income*mult-nmDebt)*qf)):0;
  // 优化后额度：假设查询已冷却，移除查询次数惩罚，仅保留债务/卡片惩罚
  let qfOpt=1;
  if(loans2.length>=5)qfOpt*=.8;
  if(cUtil>90)qfOpt*=.7;else if(cUtil>70)qfOpt*=.85;
  const estLoO = income>0?Math.max(0,(income*30-nmDebt)*qfOpt):0;
  const estHiO = income>0?Math.max(0,Math.min(1e6,(income*mult-nmDebt)*qfOpt)):0;
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
  const _tier    = r.cs_tier || (curRate>=80?'bank':curRate>=60?'mixed':'finance');
  const _clientT = r.client_type || (_tier==='bank'?'A':_tier==='mixed'?'B':'C');

  // 更新产品数量
  document.getElementById('matchCount').textContent = products.length;

  // ① 顶部总结区
  const topEl = document.getElementById('convTop');
  if(topEl){
    topEl.style.display='block';
    const hl = document.getElementById('convHeadline');
    const _csScoreDisp = r.cs_score || '--';
    if(hl){
      if(_clientT==='A'&&['gov','institution','state'].includes(wt))
        hl.innerHTML=`征信评分 <em>${_csScoreDisp}分</em>，白名单职业<br>可申请<em>专属利率通道</em>，额度和利率均有优势`;
      else if(_clientT==='A')
        hl.innerHTML=`征信评分 <em>${_csScoreDisp}分</em>，资质优质<br>按正确顺序申请，可拿到<em>最高额度+最低利率</em>`;
      else if(_clientT==='B')
        hl.innerHTML=`征信评分 <em>${_csScoreDisp}分</em>，有优化空间<br>做<em>2-3个调整</em>后，可申请产品明显增加`;
      else
        hl.innerHTML=`征信评分 <em>${_csScoreDisp}分</em><br>需先解决核心问题，<em>最短X个月后</em>可正常申请`;
    }
    const rc=document.getElementById('convRateCur');
    if(rc){
      rc.textContent=curRate+'%'+(_isEstimated?' ≈':'');
      rc.style.color=curRate>=70?'#4ade80':'#f87171';
      rc.title=_isEstimated?'本地估算（AI未返回精确值）':'AI计算结果';
    }
    const ro=document.getElementById('convRateOpt');if(ro)ro.textContent=optRate+'%';
    // convAmtCurRow / convAmtOptRow 固定显示通过率标签，不再覆盖
    // 无收入时隐藏compare区域，显示引导
    const compareEl=document.getElementById('convCompareWrap');
    if(compareEl) compareEl.style.display = income>0?'grid':'none';
    const noIncomeHint=document.getElementById('convNoIncomeHint');
    if(noIncomeHint) noIncomeHint.style.display = income>0?'none':'block';
    const gp=document.getElementById('convGap');
    if(gp){const rateGap=optRate-curRate;if(rateGap>0){gp.textContent='+'+rateGap+'%';gp.style.fontSize='';gp.style.color='#4ade80';}else{gp.textContent='已达最优';gp.style.fontSize='13px';gp.style.color='rgba(255,255,255,0.4)';}}
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
  if(probEl&&dp.length>0){
    probEl.style.display='block';
    document.getElementById('convProbList').innerHTML=dp.map((p,i)=>`<div class="prob-item"><div class="prob-n">${i+1}</div><div><div class="prob-name"><strong>${esc(p.name)}：${esc(p.value)}</strong></div><div class="prob-desc">→ ${esc(p.threshold)}${p.severity==='high'?' ⚠️ 影响较大':''}</div></div></div>`).join('');
  }

  // ③ 损失对比
  const lossEl=document.getElementById('convLoss');
  if(lossEl){
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
      if(nt) nt.textContent='消费金融为主';
      if(nr) nr.textContent='年利率：15%–24%';
    }
    const la=income>0?Math.max(1,Math.round(Math.min(estHi>0?estHi:3e4,1e5)/1e4)):10;
    const n=document.getElementById('convIntNow');if(n)n.textContent='10万/年利息：约'+(la*1.5).toFixed(1)+'–'+(la*2.4).toFixed(1)+'万';
    const o=document.getElementById('convIntOpt');if(o)o.textContent='10万/年利息：约'+(la*.36).toFixed(1)+'–'+(la*.6).toFixed(1)+'万';
  }

  // ④ 提升空间
  const acts=r.optimize_actions||[];
  const lActs=[];
  if(onlineI>=3) lActs.push({action:'结清'+Math.min(2,onlineI-1)+'笔网贷并注销账户',impact:'可新增'+Math.min(3,onlineI)+'家可申请银行产品'});
  if(q3>3) lActs.push({action:'停止所有贷款查询'+(q3>6?'1个月':'2-3周'),impact:'查询风险下降，银行通过率提升约'+(q3>6?'30%':'15%')});
  const da=(acts.length>0?acts:lActs).slice(0,3);
  const liftEl=document.getElementById('convLift');
  if(liftEl&&da.length>0){
    liftEl.style.display='block';
    document.getElementById('convLiftActions').innerHTML=da.map(a=>`<div class="lift-action"><div class="lift-check">✓</div><div class="lift-txt">${esc(a.action)}（${esc(a.impact)}）</div></div>`).join('');
    const cp=r.current_products||products.length;
    const op=r.optimized_products||Math.min(cp+3,8);
    const pb=document.getElementById('convLiftProdB');if(pb)pb.textContent=cp+' 款';
    const pa=document.getElementById('convLiftProdA');if(pa)pa.textContent=op+' 款';
    const ab=document.getElementById('convLiftAmtB');if(ab)ab.textContent=_isAmtNum(curAmt)?'额度 '+curAmt+' 万':curAmt;
    const aa=document.getElementById('convLiftAmtA');if(aa)aa.textContent=_isAmtNum(optAmt)?'额度 '+optAmt+' 万':optAmt;
    const lg=document.getElementById('convLiftGap');
    if(lg)lg.textContent=gapW>0?'📈 优化后可多拿约 '+gapW+' 万额度':'📈 优化后可多申请 '+(op-cp)+' 款产品';
  }

  // ⑤ 操作路径
  const pathEl=document.getElementById('convPath');
  if(pathEl){
    pathEl.style.display='block';
    const _bankProds = products.filter(p=>p.type==='bank');
    const _finProds  = products.filter(p=>p.type!=='bank');
    const _topBanks  = _bankProds.slice(0,2).map(p=>p.bank+'·'+p.product).join('、');
    const _topFin    = _finProds.slice(0,2).map(p=>p.bank).join('、');
    document.getElementById('convPathSteps').innerHTML=[
      {t:_topBanks?`<strong>第一步</strong>：先申请 ${_topBanks}（利率最低、查询最友好）`:'<strong>优先申请</strong>通过率最高、查询消耗最少的产品'},
      {t:'<strong>拿到第一笔</strong>后，再补充申请额度更高的产品（已有通过记录，后续银行审批通过率更高）'},
      {t:_topFin?`<strong>${_topFin}</strong>等消费金融，利率较高，作为最后备选，不要优先申请`:'<strong>消费金融</strong>作为最后备选，不要第一个申请'},
    ].map((s,i)=>`<div class="path-step"><div class="path-n">${i+1}</div><div class="path-txt">${s.t}</div></div>`).join('');
  }

  // ⑥ 客户标签
  const ctEl=document.getElementById('convClient');
  if(ctEl){
    ctEl.style.display='block';
    let icon,type,title,desc;
    if(_clientT==='A'||curRate>=80){icon='⭐';type='优质型';title='你的资质属于优质客户';desc='征信健康，当前可直接申请银行产品，按正确顺序申请，通过率很高';}
    else if(_clientT==='B'||curRate>=60){icon='📋';type='可优化型';title='你的情况优化空间大';desc='征信有小瑕疵，但核心数据健康，做2-3个调整后，可申请产品会明显增加';}
    else{icon='🔧';type='需养征信';title='建议先优化再申请';desc='当前资质直接申请被拒风险高，优化周期1-3个月，之后可大幅提升通过率';}
    const ci=document.getElementById('convClientIcon');if(ci)ci.textContent=icon;
    const ct=document.getElementById('convClientType');if(ct)ct.textContent=type;
    const ctit=document.getElementById('convClientTitle');if(ctit)ctit.textContent=title;
    const cd=document.getElementById('convClientDesc');if(cd)cd.textContent=desc;
  }

  // 白名单职业
  const wlEl=document.getElementById('wlTip');
  if(wlEl)wlEl.style.display=['gov','institution','state'].includes(wt)?'block':'none';

  // ⑦ 紧迫提醒
  const urgEl=document.getElementById('convUrgent');
  if(urgEl&&q3>=3){
    urgEl.style.display='block';
    const ub=document.getElementById('convUrgentBody');
    if(ub)ub.innerHTML='你现在处于<strong>关键窗口期（7–15天）</strong><br>如果这段时间继续查询或盲目申请：';
    const ur=document.getElementById('convUrgentResult');
    if(ur)ur.textContent='查询次数再增加，直接降级为「银行无法通过」。恢复周期：1–3个月。现在的行动决定3个月后的结果。';
  }

  // 预估额度
  const mrEl=document.getElementById('mrEstimate');
  if(mrEl&&income>0&&estHi>0){
    mrEl.style.display='block';
    mrEl.textContent='根据现有资质，预计可申请：'+fw(estLo)+'–'+fw(estHi)+' 万';
  }

  // ⑧ 转化区
  const hEl=document.getElementById('convHidden');
  if(hEl)hEl.textContent=Math.max(1,dp.length>2?2:1);
  const ctaSub=document.getElementById('convCtaSub');
  if(ctaSub){
    if(_tier==='bank')
      ctaSub.innerHTML='资质已达标，顾问可对接银行内部渠道<br>帮你拿到比自行申请更低的利率和更高额度';
    else
      ctaSub.innerHTML='这些因素可能影响你的最终额度和通过率<br>联系顾问获取针对你的定制方案';
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
      if (!origText) mrEl2.textContent = '✓ 已解锁 剩余' + leftMin + '分钟';
      mrEl2.style.display = 'block';
    }
  }
  if (!isPaid) {
    const _paywallMsg = products.length > 0
      ? `检测到 <strong style="color:#b45309;font-size:18px">${products.length}</strong> 家机构符合您的资质，付费后查看完整匹配结果与申请顺序`
      : '已完成征信分析，付费后查看专属优化方案';
    document.getElementById('productsGrid').innerHTML = `<div style="background:rgba(200,169,110,.1);border:1px solid rgba(200,169,110,.4);border-radius:12px;padding:22px 16px;text-align:center"><div style="font-size:14px;color:#4a3728;margin-bottom:16px;line-height:1.6">${_paywallMsg}</div><button onclick="showPayModal(()=>startMatching())" style="background:var(--gold);color:var(--navy);border:none;border-radius:8px;padding:12px 36px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">9.9元 查看完整报告</button></div>`;
    document.getElementById('matchResult').style.display='block';
    document.getElementById('matchResult').scrollIntoView({behavior:'smooth',block:'start'});
    window._isMatching = false;
    return;
  }

  const _mkCard = p => {
    const pct=p.probPct||0;
    const bc=pct>=75?'var(--green)':pct>=55?'var(--gold)':'var(--red)';
    const isNotRec=p.prob==='不推荐';
    const cardStyle=isNotRec?'opacity:0.55;filter:grayscale(30%)':'';
    const badgeCls=p.prob==='高'?'badge-ok':p.prob==='中'?'badge-warn':'badge-bad';
    const notRecTag=isNotRec?`<span class="pc-tag" style="color:#f87171;background:rgba(192,57,43,.12)">⚠️ 当前评分偏低</span>`:'';
    return `<div class="product-card" style="${cardStyle}"><div class="pc-top"><span class="pc-emoji">${esc(p.emoji)||'🏦'}</span><div class="pc-info"><div class="pc-bank">${esc(p.bank)}</div><div class="pc-product">${esc(p.product)}</div></div><div class="pc-rate">${esc(p.rate)}</div></div><div class="pc-prob"><div class="pc-prob-bar"><div class="pc-prob-fill" style="width:${pct}%;background:${bc}"></div></div><div class="pc-prob-val">${pct}%</div></div><div class="pc-tags"><span class="badge ${badgeCls}">${esc(p.prob)}概率</span>${notRecTag}${(p.tags||[]).map(t=>`<span class="pc-tag">${esc(t)}</span>`).join('')}<span class="pc-tag">${esc(p.amount)}</span></div><div class="pc-reason" onclick="var d=this.nextElementSibling;if(d&&d.classList.contains('pc-reason-detail')){d.classList.toggle('show');this.querySelector('.pc-reason-toggle')?.classList.toggle('open')}"><span class="pc-reason-text">${esc(p.reason)||''}</span>${p.reason_detail?'<span class="pc-reason-toggle">▾</span>':''}</div>${p.reason_detail?'<div class="pc-reason-detail">'+esc(p.reason_detail)+'</div>':''}</div>`;
  };
  const _tierHd = (txt,sub)=>`<div style="grid-column:1/-1;margin:12px 0 4px;padding:7px 10px;border-left:3px solid var(--gold);background:rgba(200,169,110,.06);border-radius:0 6px 6px 0"><span style="font-size:12px;font-weight:700;color:#c8a96e">${txt}</span>${sub?`<span style="font-size:11px;color:rgba(255,255,255,.4);margin-left:6px">${sub}</span>`:''}` + `</div>`;
  if(products.length===0){
    // 根据实际数据生成具体的问题诊断和修复步骤
    const _zxProblems=[];
    if((data2.overdue_current||0)>0) _zxProblems.push({icon:'🔴',text:`当前逾期 ${data2.overdue_current} 笔未结清，银行一票否决，必须立即结清`});
    if(q3>6) _zxProblems.push({icon:'🔴',text:`近3个月审批查询 ${q3} 次，超出银行安全线（≤6次），需停止申请3个月待查询自然冷却`});
    if(onlineI>4) _zxProblems.push({icon:'🟠',text:`网贷机构 ${onlineI} 家未结清，超出银行红线（≤4家），建议结清 ${onlineI-2} 家后再申请`});
    if(income>0&&dr>70) _zxProblems.push({icon:'🟠',text:`负债率 ${dr}%，超出银行安全线（≤70%），需降低负债后申请`});
    if(cUtil>90) _zxProblems.push({icon:'🟠',text:`信用卡使用率 ${cUtil}%，严重超标（≤70%），建议还款至50%以下`});
    if(_zxProblems.length===0) _zxProblems.push({icon:'🟡',text:r.key_risk||'综合征信指标偏弱，建议联系顾问获取针对性优化方案'});
    const _zxSteps=[];
    if((data2.overdue_current||0)>0) _zxSteps.push(`结清全部逾期账户（预计1-2周，结清后征信状态改善）`);
    if(q3>6) _zxSteps.push(`停止所有贷款/信用卡申请，等待3个月查询冷却`);
    if(onlineI>4) _zxSteps.push(`优先结清通过率最低的网贷账户，目标降至4家以内`);
    if(cUtil>90) _zxSteps.push(`信用卡账单日前还款，将使用率降至50%以下`);
    if(_zxSteps.length===0) _zxSteps.push(`联系贷款顾问获取针对您情况的专属优化方案`);
    const _problemsHtml=_zxProblems.map(p=>`<div style="display:flex;gap:8px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,.06)"><span style="flex-shrink:0;font-size:13px">${p.icon}</span><span style="font-size:12px;color:#7c2d12;line-height:1.6">${esc(p.text)}</span></div>`).join('');
    const _stepsHtml=_zxSteps.map((s,i)=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0"><div style="flex-shrink:0;width:20px;height:20px;border-radius:50%;background:var(--gold);color:var(--navy);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${i+1}</div><span style="font-size:12px;color:#1e293b;line-height:1.6">${esc(s)}</span></div>`).join('');
    document.getElementById('productsGrid').innerHTML=`<div style="background:#fff8f0;border-radius:14px;border:1px solid rgba(200,100,80,.25);padding:16px;margin-bottom:8px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><div style="font-size:20px">📋</div><div><div style="font-size:14px;font-weight:700;color:#92400e">你的征信诊断报告</div><div style="font-size:11px;color:#78716c;margin-top:2px">当前资质暂无可直接申请的银行产品，需优化后再申请</div></div></div><div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">问题诊断</div>${_problemsHtml}<div style="font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 4px">优化步骤</div>${_stepsHtml}<div style="margin-top:12px;padding:10px;background:rgba(200,169,110,.12);border-radius:8px;border:1px solid rgba(200,169,110,.35)"><div style="font-size:11px;color:#78716c;margin-bottom:4px">优化后预计通过率</div><div style="font-size:16px;font-weight:700;color:#16a34a">${optRate}%+</div><div style="font-size:11px;color:#78716c;margin-top:2px">完成以上步骤后可申请银行产品</div></div><button onclick="(function(){const t=document.createElement('textarea');t.value='Xmdzhun';document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);alert('微信号已复制：Xmdzhun');})()" style="display:block;width:100%;text-align:center;background:var(--gold);color:var(--navy);padding:11px;border-radius:8px;font-weight:700;font-size:13px;border:none;cursor:pointer;font-family:inherit;margin-top:12px">💬 加客服微信，获取专属执行计划</button></div>`;
    // 零产品路径：convProb 和 adviceSection 与诊断报告内容重叠，隐藏
    const _cpEl = document.getElementById('convProb'); if (_cpEl) _cpEl.style.display = 'none';
    const _asEl = document.getElementById('adviceSection'); if (_asEl) _asEl.style.display = 'none';
  } else {
    const _bigBank  = products.filter(p=>p.type==='bank'&&(p.tags||[]).includes('国有大行'));
    const _othBank  = products.filter(p=>p.type==='bank'&&!(p.tags||[]).includes('国有大行'));
    const _finProds = products.filter(p=>p.type!=='bank');
    let _gridHtml='';
    if(_bigBank.length)  _gridHtml += _tierHd('🏛 国有大行','优先申请，利率最低') + _bigBank.map(_mkCard).join('');
    if(_othBank.length)  _gridHtml += _tierHd('🏦 股份制 / 城商行','') + _othBank.map(_mkCard).join('');
    if(_finProds.length) _gridHtml += _tierHd('💳 消费金融','备选，最后申请') + _finProds.map(_mkCard).join('');
    document.getElementById('productsGrid').innerHTML=_gridHtml;
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
    if((adv.suggestions||[]).length>0) document.getElementById('adviceSuggestionsBody').innerHTML=adv.suggestions.map((s,i)=>`<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${esc(s.action)}</div><div class="as-impact">${esc(s.goal)}</div><div class="as-step-meta"><span class="as-step-tag">⏱ ${esc(s.time)}</span><span class="as-step-tag">✨ ${esc(s.effect)}</span></div></div></div>`).join('');
  }
  if((r.rejected_products||[]).length>0){document.getElementById('rejectedSection').style.display='block';document.getElementById('rejectedBody').innerHTML=r.rejected_products.map(rp=>`<div class="as-item"><div class="as-dot as-dot-amber"></div><div><div class="as-point">${esc(rp.type)}</div><div class="as-impact">${esc(rp.reason)}</div></div></div>`).join('');}
  if((r.optimization||[]).length>0){document.getElementById('optimizationSection').style.display='block';document.getElementById('optimizationBody').innerHTML=r.optimization.map((o,i)=>`<div class="as-item"><div class="as-step-num">${i+1}</div><div><div class="as-point">${esc(o.step)}</div><div class="as-impact">${esc(o.goal)}</div><div class="as-step-meta"><span class="as-step-tag">⏱ ${esc(o.time)}</span><span class="as-step-tag">🎯 ${esc(o.unlock)}</span></div></div></div>`).join('');}
  if(r.post_optimization){document.getElementById('postOptSection').style.display='block';document.getElementById('postOptBody').textContent=r.post_optimization;}
  document.getElementById('analysisReport').style.display='block';

  // 风险banner
  const riskMap={'健康':{cls:'risk-healthy',icon:'🟢',label:'征信状态：健康',desc:'整体征信良好，无明显风控风险'},'轻微瑕疵':{cls:'risk-mild',icon:'🟡',label:'征信状态：轻微瑕疵',desc:'存在轻微不足，不影响主要银行产品申请'},'中度风险':{cls:'risk-medium',icon:'🟠',label:'征信状态：中度风险',desc:'存在影响银行审批的关键问题，需优化后再申请'},'高风险':{cls:'risk-high',icon:'🔴',label:'征信状态：高风险',desc:'已触碰银行硬红线，当前申请银行产品大概率拒贷'}};
  const rl=r.risk_level||'轻微瑕疵';
  const rDef=riskMap[rl]||riskMap['轻微瑕疵'];
  const banner=document.getElementById('riskLevelBanner');
  if(banner){banner.className='risk-banner '+rDef.cls;banner.innerHTML=`<span class="rb-icon">${rDef.icon}</span><div><div class="rb-level">${rDef.label}</div><div class="rb-desc">${esc(r.key_risk)||rDef.desc}</div></div>`;}

  document.getElementById('matchResult').style.display='block';
  document.getElementById('matchResult').scrollIntoView({behavior:'smooth',block:'start'});
  window._isMatching = false; // 释放匹配状态锁
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
    document.getElementById('asset-none').querySelector('.ia-check').textContent = '☐';
    if (type === 'house') {
      document.getElementById('house-sub').style.display = _assetState.house ? 'block' : 'none';
    }
  }
  // Update all asset UI
  ['house','car','biz','none'].forEach(k => {
    const el2 = document.getElementById('asset-' + k);
    const chk = el2.querySelector('.ia-check');
    if (_assetState[k]) { el2.classList.add('selected'); chk.textContent = '✅'; }
    else { el2.classList.remove('selected'); chk.textContent = '☐'; }
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
    provident:    v('if-provident') ? parseInt(v('if-provident')) : null,
    assets:       assets.length > 0 ? assets.join(' / ') : '未填写',
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
    const totalMonthly = loans.reduce((s, l) => s + (l.monthly || 0), 0);
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
    const utilColor  = totalUtil == null ? '' : totalUtil <= 30 ? 'var(--green)' : totalUtil <= 70 ? 'var(--amber)' : 'var(--red)';
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
const REPORT_URL     = PROXY_URL + '/report';              // Worker 报告路由

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
    `  ${i+1}. ${p.emoji||'🏦'} ${p.bank} · ${p.product}`
    + `\n     利率: ${p.rate} | 最高额度: ${p.amount}`
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

【查询记录】
贷款审批近1月：${q.loan_1m} 次  |  近3月：${q.loan_3m} 次
信用卡审批近3月：${q.loan_3m_card} 次
贷款+信用卡 近6月合计：${q.loan_6m_total} 次

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
  try {
    const reportText = buildReportText();
    const name = window._personName || '未识别';
    await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '来源':     _currentAgent ? `🔗 代理商渠道 · ${_currentAgent.name}（${_currentAgent.id}）` : '⭐ 贷准官网 · AI征信匹配报告',
        '客户姓名': name,
        '提交时间': new Date().toLocaleString('zh-CN'),
        '渠道代理': _currentAgent ? `${_currentAgent.name} / ${_currentAgent.phone} / ID:${_currentAgent.id}` : '直客',
        '完整报告': reportText,
      }),
    });
    window._reportSent = true;
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
  try { return JSON.parse(text.trim()); } catch(e) {}
  const stripped = text.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, s => s.replace(/```json|```/g,'').trim()).trim();
  try { return JSON.parse(stripped); } catch(e) {}
  for (const [open, close] of [['{','}'],['[',']']]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.substring(start, end + 1)); } catch(e) {}
    }
  }
  return null;
}

// 前端简单限流：60秒内最多5次（防误触/恶意刷）
const _rl = { count: 0, reset: Date.now() + 60000 };
function checkRateLimit() {
  const now = Date.now();
  if (now > _rl.reset) { _rl.count = 0; _rl.reset = now + 60000; }
  if (_rl.count >= 5) return false;
  _rl.count++;
  return true;
}

async function callMatch(payToken, payload) {
  if (!checkRateLimit()) {
    throw new Error('请求过于频繁，请稍候再试（每分钟最多5次）');
  }
  if (!payToken) {
    clearPayToken();
    showPayModal(() => startMatching());
    throw new Error('PAYMENT_REQUIRED');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  const resp = await fetch(PROXY_URL + '/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ _pay_token: payToken, payload }),
  });
  clearTimeout(timeout);
  if (resp.status === 402) {
    clearPayToken();
    showPayModal(() => startMatching());
    throw new Error('PAYMENT_REQUIRED');
  }
  const respText = await resp.text();
  if (!respText || !respText.trim()) throw new Error('服务器返回空响应');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  let data; try { data = JSON.parse(respText); } catch(e) { throw new Error('响应格式异常'); }
  if (data.error) throw new Error(data.error.message || 'API错误');
  return (data.content || []).map(b => b.text || '').join('').replace(/```json[^`]*```|```/g, '').trim();
}

async function callAI(messages, max_tokens = 2000) {
  if (!checkRateLimit()) {
    throw new Error('请求过于频繁，请稍候再试（每分钟最多5次）');
  }
  const payToken = getPayToken() || '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', messages, max_tokens, _pay_token: payToken }),
  });
  clearTimeout(timeout);
  // 支付凭证失效，触发重新付费
  if (resp.status === 402) {
    clearPayToken();
    showPayModal(() => startMatching());
    throw new Error('PAYMENT_REQUIRED');
  }
  const respText = await resp.text();
  if (!respText || !respText.trim()) throw new Error('服务器返回空响应');
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  let data; try { data = JSON.parse(respText); } catch(e) { throw new Error('响应格式异常'); }
  if (data.error) throw new Error(data.error.message || 'API错误');
  return (data.content || []).map(b => b.text || '').join('').replace(/```json[^`]*```|```/g, '').trim();
}

function showQrModal() {
  document.getElementById('qrOverlay').classList.add('show');
}
function hideQrModal(e) {
  if (!e || e.target === document.getElementById('qrOverlay') || e.currentTarget.classList.contains('qr-modal-close')) {
    document.getElementById('qrOverlay').classList.remove('show');
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

  // 设置二维码图片
  const qrImg = document.getElementById('qrCodeImg');
  if (qrImg) { qrImg.src = qrSrc; qrImg.style.display = 'block'; }

  // 设置二维码备用文字（图片加载失败时显示）
  const qrPhone = document.getElementById('qrPhoneNum');
  if (qrPhone) { qrPhone.textContent = phone; }

  // 空产品引导里的联系电话也同步
  window._agentPhone = phone;
}
// 微信环境检测
const _isWeChat = /micromessenger/i.test(navigator.userAgent);

// 页面加载时处理微信 OAuth
document.addEventListener('DOMContentLoaded', () => {
  initContactPhone();
  loadProducts();

  if (!_isWeChat) return;

  const _urlParams = new URLSearchParams(location.search);
  const _wxCode    = _urlParams.get('code');
  const _wxState   = _urlParams.get('state');

  if (_wxCode && _wxState === 'wxpay') {
    // OAuth 回调：换取 openid
    fetch(PROXY_URL + '/pay/wechat/oauth?code=' + _wxCode)
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
    el.classList.remove('active','done');
  });
  document.getElementById('matchingLoading').style.display = 'block';
  document.getElementById('ml1').classList.add('active'); // re-activate first step
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
    if(el){ el.classList.remove('selected'); el.querySelector('.ia-check').textContent = '☐'; }
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
  document.getElementById('upload-section').scrollIntoView({ behavior:'smooth' });
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
      const resp = await fetch(PROXY_URL + '/pay/create', {
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
            const cr = await fetch(PROXY_URL + '/pay/wechat/confirm', {
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
            fetch(PROXY_URL + '/pay/wechat/confirm', {
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
    const resp = await fetch(PROXY_URL + '/pay/create', {
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

    // 打开支付页
    const opened = window.open(_payUrl, '_blank');
    if (!opened) window.location.href = _payUrl; // 弹窗被拦截时直接跳转

    // 开始轮询
    clearInterval(_pollTimer);
    _pollTimer = setInterval(pollPayStatus, 2000);

  } catch(e) {
    alert('创建支付订单失败：' + e.message);
    document.getElementById('payStep1').style.display = 'block';
    document.getElementById('payStep2').style.display = 'none';
  }
}

async function pollPayStatus() {
  if (!_payOrderId || _confirmed) return;
  try {
    const resp = await fetch(PROXY_URL + '/pay/status/' + _payOrderId);
    const data = await resp.json();
    if (data.status === 'paid' && data.token) {
      clearInterval(_pollTimer);
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

