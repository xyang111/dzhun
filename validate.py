import re, sys

with open('index_work.html', 'r', encoding='utf-8') as f:
    html = f.read()

js = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)[0]
lines = js.split('\n')
errors = []

# 语法检查
for i, line in enumerate(lines):
    s = line.strip()
    if not s or s.startswith('//') or s.startswith('*'): continue
    clean = re.sub(r'\\.', '', line)
    clean = re.sub(r'`[^`]*`', '', clean)
    sq = clean.count("'"); dq = clean.count('"')
    if (sq%2==1 or dq%2==1) and '`' not in line and 'replace' not in line:
        errors.append(f"L{i+1} 语法: {line[:60]}")

# 关键功能检查
checks = [
    ("新架构_localResult", "const _localResult = localFallbackMatch"),
    ("merged合并", "const merged = Object.assign"),
    ("csScore驱动", "const _baseScore  = Math.round(_csScore * 0.65)"),
    ("8模块convTop", 'id="convTop"'),
    ("消金独立门槛", "_isOnline"),
    ("不良记录判断", "hasBadRecord"),
    ("网贷分层", "onlineInstCnt > 12"),
    ("客户类型A/B/C", "_clientType === 'C'"),
    ("OCR has_bad_record", '"has_bad_record": false'),
    ("summary_overdue辅助", "summary_overdue_accounts||0) > 0"),
]
for name, marker in checks:
    if marker not in html:
        errors.append(f"功能缺失: {name}")

if errors:
    print("❌ 验证失败:")
    for e in errors: print(f"  {e}")
    sys.exit(1)
else:
    print(f"✅ 验证通过 ({len(lines)}行, {len(html)//1024}KB)")
