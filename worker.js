/**
 * 贷准 API Proxy — Cloudflare Worker
 *
 * 部署步骤：
 * 1. Cloudflare Dashboard → Workers & Pages → Create Worker
 * 2. 粘贴此文件内容，点击 Deploy
 * 3. 进入 Worker → Settings → Variables，添加环境变量：
 *    ANTHROPIC_API_KEY = sk-ant-xxxxxxxx（你的真实密钥）
 * 4. 在 Workers → Routes 里将 api.dzhun.com.cn/* 绑定到此 Worker
 *
 * 安全机制：
 * - Referer / Origin 校验：只接受来自 dzhun.com.cn 的请求
 * - API 密钥保存在 Worker 环境变量中，不暴露给前端
 * - 支持 /v1/messages（AI 分析）和 /report（邮件报告）两条路由
 */

const ALLOWED_ORIGINS = ['https://dzhun.com.cn', 'https://www.dzhun.com.cn'];
const ANTHROPIC_API   = 'https://api.anthropic.com';

export default {
  async fetch(request, env) {
    // ── CORS 预检 ──
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Referer / Origin 校验 ──
    const origin   = request.headers.get('Origin')  || '';
    const referer  = request.headers.get('Referer') || '';
    const allowed  = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o));

    if (!allowed) {
      return corsResponse(JSON.stringify({ error: 'Forbidden' }), 403);
    }

    const url = new URL(request.url);

    // ── 路由：/report（邮件转发，原样透传，不涉及 Anthropic） ──
    if (url.pathname === '/report') {
      // 如果你用 Worker 转发报告邮件，在这里处理；
      // 目前仅返回占位响应，不影响现有 EmailJS 逻辑。
      return corsResponse(JSON.stringify({ ok: true }), 200);
    }

    // ── 路由：/v1/messages（转发给 Anthropic） ──
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return corsResponse(JSON.stringify({ error: 'API key not configured' }), 500);
    }

    // 重写目标 URL
    const targetUrl = ANTHROPIC_API + url.pathname + url.search;

    // 复制原始请求头，替换鉴权信息
    const headers = new Headers(request.headers);
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', headers.get('anthropic-version') || '2023-06-01');
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');

    const upstream = await fetch(targetUrl, {
      method:  request.method,
      headers: headers,
      body:    request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });

    // 将 Anthropic 响应返回，附加 CORS 头
    const respHeaders = new Headers(upstream.headers);
    addCorsHeaders(respHeaders, origin);
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: respHeaders,
    });
  },
};

// ── 工具函数 ──

function addCorsHeaders(headers, origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  headers.set('Access-Control-Allow-Origin', allow);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');
  headers.set('Vary', 'Origin');
}

function corsResponse(body, status) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  addCorsHeaders(headers, ALLOWED_ORIGINS[0]);
  return new Response(body, { status, headers });
}
