/**
 * 贷准 · Cloudflare Worker — Anthropic API 代理 + Resend 报告推送
 *
 * 环境变量（在 Worker → Settings → Variables 中配置，均选 Encrypt）：
 *   ANTHROPIC_API_KEY  — Anthropic sk-ant-xxx 密钥
 *   RESEND_API_KEY     — Resend re_xxx 密钥（旧 key 已泄露，请在 Resend 后台重新生成）
 */

const REPORT_TO_EMAIL = '651047968@qq.com';
const REPORT_FROM     = 'report@dzhun.com.cn';
const ALLOWED_ORIGINS = ['https://dzhun.com.cn', 'https://www.dzhun.com.cn'];

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // ── CORS 预检 ──
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });
  }

  // ── Origin / Referer 校验 ──
  const origin  = request.headers.get('Origin')  || '';
  const referer = request.headers.get('Referer') || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o));
  if (!allowed) {
    return jsonResp({ error: 'Forbidden' }, 403, request);
  }

  const url = new URL(request.url);

  // ── 路由：/report → Resend 发邮件 ──
  if (url.pathname === '/report') {
    let body;
    try { body = await request.json(); } catch(e) {
      return jsonResp({ ok: false, error: 'Invalid JSON' }, 400, request);
    }

    const name    = body['客户姓名'] || '未知客户';
    const time    = body['提交时间'] || new Date().toLocaleString('zh-CN');
    const report  = body['完整报告'] || '（无内容）';
    const subject = `贷准报告 · ${name} · ${time}`;

    const resendKey = RESEND_API_KEY;
    if (!resendKey) return jsonResp({ ok: false, error: 'Resend key not configured' }, 500, request);

    try {
      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: REPORT_FROM, to: REPORT_TO_EMAIL, subject, text: report }),
      });

      const data = await resendResp.json();
      const ok   = resendResp.status === 200 || resendResp.status === 201;
      return jsonResp({ ok, ...data }, ok ? 200 : 502, request);

    } catch(e) {
      return jsonResp({ ok: false, error: e.message }, 502, request);
    }
  }

  // ── 默认路由：转发 Claude API ──
  const apiKey = ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResp({ error: { message: 'API key not configured.' } }, 500, request);

  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ error: { message: 'Invalid JSON: ' + e.message } }, 400, request);
  }

  body.model = 'claude-sonnet-4-20250514';
  if (!body.max_tokens || body.max_tokens > 8000) body.max_tokens = 8000;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    return jsonResp(data, resp.status, request);

  } catch(e) {
    return jsonResp({ error: { message: 'Upstream error: ' + e.message } }, 502, request);
  }
}

// ── 工具函数 ──

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary': 'Origin',
  };
}

function jsonResp(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  });
}
