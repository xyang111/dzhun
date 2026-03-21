/**
 * 贷准 · Cloudflare Worker
 *
 * 路由：
 *   POST /               → Anthropic API 代理（OCR 免费，匹配需 pay token）
 *   POST /report         → Resend 发送邮件报告
 *   POST /pay/create     → 创建支付订单（微信/支付宝）
 *   GET  /pay/status/:id → 轮询订单状态
 *   POST /pay/notify/wechat  → 微信支付回调
 *   POST /pay/notify/alipay  → 支付宝回调
 *
 * 环境变量（Worker → Settings → Variables，均加密）：
 *   ANTHROPIC_API_KEY   — Anthropic sk-ant-xxx
 *   RESEND_API_KEY      — Resend re_xxx
 *   WECHAT_APPID        — 微信 H5 APPID（公众号/开放平台）
 *   WECHAT_MCH_ID       — 微信商户号
 *   WECHAT_SERIAL       — 微信 API 证书序列号
 *   WECHAT_PRIV_KEY     — 微信商户 RSA 私钥 PEM（完整内容含 -----BEGIN/END-----）
 *   WECHAT_API_V3_KEY   — 微信 APIv3 密钥（32字节，用于解密回调）
 *   ALIPAY_APP_ID       — 支付宝 AppID
 *   ALIPAY_PRIV_KEY     — 支付宝应用 RSA2 私钥 PEM
 *   ALIPAY_PUB_KEY      — 支付宝公钥 PEM（用于验证回调签名）
 *
 * KV 绑定（wrangler.toml 中配置）：
 *   ORDERS              — 存储订单状态和 pay token
 */

const REPORT_TO_EMAIL = '651047968@qq.com';
const REPORT_FROM     = 'report@dzhun.com.cn';
const ALLOWED_ORIGINS = ['https://dzhun.com.cn', 'https://www.dzhun.com.cn'];
const PRODUCT_PRICE   = 990;   // ¥9.90 单位：分

export default {
  async fetch(request, env) {

    // ── CORS 预检 ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 支付回调（来自微信/支付宝服务器，跳过 Origin 校验）──
    if (path === '/pay/notify/wechat') return handleWechatNotify(request, env);
    if (path === '/pay/notify/alipay') return handleAlipayNotify(request, env);

    // ── Origin 校验 ──
    const origin  = request.headers.get('Origin')  || '';
    const referer = request.headers.get('Referer') || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin === o || referer.startsWith(o));
    if (!allowed) return jsonResp({ error: 'Forbidden' }, 403, request);

    // ── GET：支付状态轮询 ──
    if (request.method === 'GET' && path.startsWith('/pay/status/')) {
      return handlePayStatus(request, env, path);
    }

    // ── 测试专用：模拟支付确认（仅在未配置真实商户号时有效）──
    if (request.method === 'GET' && path.startsWith('/pay/dev-confirm/')) {
      const isMock = !env.WECHAT_APPID || env.WECHAT_APPID.startsWith('TODO');
      if (!isMock) return jsonResp({ error: '仅测试环境可用' }, 403, request);
      const orderId = path.replace('/pay/dev-confirm/', '').split('?')[0];
      await markOrderPaid(env, orderId);
      return jsonResp({ ok: true }, 200, request);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });
    }

    if (path === '/pay/create') return handlePayCreate(request, env);
    if (path === '/report')    return handleReport(request, env);

    // ── 默认：Claude API 代理 ──
    return handleClaude(request, env);
  }
};

// ══════════════════════════════════════════════
// 支付 — 创建订单
// ══════════════════════════════════════════════

async function handlePayCreate(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ error: '请求格式错误' }, 400, request);
  }

  const { channel, amount } = body;
  if (amount !== PRODUCT_PRICE) {
    return jsonResp({ error: '金额异常' }, 400, request);
  }
  if (channel !== 'wechat' && channel !== 'alipay') {
    return jsonResp({ error: '不支持的支付方式' }, 400, request);
  }

  const orderId = 'DZ' + Date.now() + randomHex(6);

  // 写入 KV，1 小时过期（未支付订单）
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify({
    status: 'pending', channel, amount, createdAt: Date.now()
  }), { expirationTtl: 3600 });

  if (channel === 'wechat') return handleWechatCreate(request, env, orderId);
  return handleAlipayCreate(request, env, orderId);
}

// ── 微信 H5 下单 ──
async function handleWechatCreate(request, env, orderId) {
  const appid    = env.WECHAT_APPID    || '';
  const mchid    = env.WECHAT_MCH_ID   || '';
  const serial   = env.WECHAT_SERIAL   || '';
  const privKey  = env.WECHAT_PRIV_KEY || '';

  // 未配置商户号时返回 mock URL（方便前端联调）
  if (!appid || !mchid || !privKey) {
    return jsonResp({
      orderId,
      payUrl: `https://dzhun.com.cn/?_mock_pay=1&orderId=${orderId}&channel=wechat`,
      channel: 'wechat'
    }, 200, request);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const apiPath  = '/v3/pay/transactions/h5';
  const reqBody  = JSON.stringify({
    appid,
    mchid,
    description: '贷准-AI征信匹配',
    out_trade_no: orderId,
    amount: { total: PRODUCT_PRICE, currency: 'CNY' },
    scene_info: {
      payer_client_ip: clientIp,
      h5_info: { type: 'Wap', app_name: '贷准', app_url: 'https://dzhun.com.cn' }
    },
    notify_url: 'https://api.dzhun.com.cn/pay/notify/wechat'
  });

  try {
    const authHeader = await buildWechatAuth('POST', apiPath, reqBody, privKey, mchid, serial);
    const resp = await fetch('https://api.mch.weixin.qq.com' + apiPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader,
      },
      body: reqBody,
    });
    const data = await resp.json();
    if (!data.h5_url) return jsonResp({ error: data.message || '微信下单失败' }, 502, request);
    return jsonResp({ orderId, payUrl: data.h5_url, channel: 'wechat' }, 200, request);
  } catch(e) {
    return jsonResp({ error: '微信下单异常: ' + e.message }, 502, request);
  }
}

// ── 支付宝 H5 下单 ──
async function handleAlipayCreate(request, env, orderId) {
  const appId   = env.ALIPAY_APP_ID   || '';
  const privKey = env.ALIPAY_PRIV_KEY || '';

  if (!appId || !privKey) {
    return jsonResp({
      orderId,
      payUrl: `https://dzhun.com.cn/?_mock_pay=1&orderId=${orderId}&channel=alipay`,
      channel: 'alipay'
    }, 200, request);
  }

  // 使用上海时区格式化时间戳
  const now = new Date();
  const ts  = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                 .replace(/\//g, '-').replace(/上午|下午/, '').trim();

  const bizContent = JSON.stringify({
    out_trade_no: orderId,
    total_amount: '9.90',
    subject: '贷准-AI征信匹配',
    product_code: 'QUICK_WAP_WAY',
  });

  const params = {
    app_id:      appId,
    method:      'alipay.trade.wap.pay',
    charset:     'utf-8',
    sign_type:   'RSA2',
    timestamp:   ts,
    version:     '1.0',
    notify_url:  'https://api.dzhun.com.cn/pay/notify/alipay',
    return_url:  'https://dzhun.com.cn/?paid=1',
    biz_content: bizContent,
  };

  try {
    params.sign = await signAlipay(params, privKey);
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const payUrl = 'https://openapi.alipay.com/gateway.do?' + query;
    return jsonResp({ orderId, payUrl, channel: 'alipay' }, 200, request);
  } catch(e) {
    return jsonResp({ error: '支付宝下单异常: ' + e.message }, 502, request);
  }
}

// ══════════════════════════════════════════════
// 支付 — 状态轮询
// ══════════════════════════════════════════════

async function handlePayStatus(request, env, path) {
  const orderId = path.replace('/pay/status/', '').split('?')[0];
  if (!orderId) return jsonResp({ error: '订单ID缺失' }, 400, request);

  const raw = await env.ORDERS.get(`order:${orderId}`);
  if (!raw) return jsonResp({ status: 'expired' }, 200, request);

  const order = JSON.parse(raw);
  if (order.status !== 'paid') {
    return jsonResp({ status: order.status }, 200, request);
  }
  // 已支付：返回 token 给前端
  return jsonResp({ status: 'paid', token: order.token }, 200, request);
}

// ══════════════════════════════════════════════
// 支付 — 回调处理
// ══════════════════════════════════════════════

// 微信支付回调
async function handleWechatNotify(request, env) {
  try {
    const body = await request.json();
    const { resource } = body;

    const apiV3Key = env.WECHAT_API_V3_KEY || '';

    let orderId;
    if (!apiV3Key) {
      // 未配置 v3 key：从明文中直接取（仅用于沙盒/mock）
      orderId = body.out_trade_no || '';
    } else {
      const plaintext = await decryptWechatResource(
        resource.ciphertext,
        resource.nonce,
        resource.associated_data,
        apiV3Key
      );
      const orderInfo = JSON.parse(plaintext);
      if (orderInfo.trade_state !== 'SUCCESS') {
        return new Response(JSON.stringify({ code: 'SUCCESS' }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
      orderId = orderInfo.out_trade_no;
    }

    if (orderId) await markOrderPaid(env, orderId);

    return new Response(JSON.stringify({ code: 'SUCCESS' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ code: 'FAIL', message: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 支付宝回调
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
  } catch(e) {
    return new Response('fail', { status: 200 });
  }
}

// 统一标记订单已支付，生成 pay token 写入 KV
async function markOrderPaid(env, orderId) {
  const raw = await env.ORDERS.get(`order:${orderId}`);
  if (!raw) return;

  const order = JSON.parse(raw);
  if (order.status === 'paid') return; // 幂等，已处理过

  const token = randomHex(32);
  order.status = 'paid';
  order.paidAt = Date.now();
  order.token  = token;

  // 订单记录保留 24 小时
  await env.ORDERS.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 86400 });
  // token 有效期 24 小时
  await env.ORDERS.put(`token:${token}`, JSON.stringify({ expiresAt: Date.now() + 86400000 }), { expirationTtl: 86400 });
}

// ══════════════════════════════════════════════
// 报告邮件
// ══════════════════════════════════════════════

async function handleReport(request, env) {
  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ ok: false, error: 'Invalid JSON' }, 400, request);
  }

  const name    = body['客户姓名'] || '未知客户';
  const time    = body['提交时间'] || new Date().toLocaleString('zh-CN');
  const report  = body['完整报告'] || '（无内容）';
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
  } catch(e) {
    return jsonResp({ ok: false, error: e.message }, 502, request);
  }
}

// ══════════════════════════════════════════════
// Claude API 代理（含支付门控）
// ══════════════════════════════════════════════

async function handleClaude(request, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResp({ error: { message: 'API key not configured.' } }, 500, request);

  let body;
  try { body = await request.json(); } catch(e) {
    return jsonResp({ error: { message: 'Invalid JSON: ' + e.message } }, 400, request);
  }

  // 判断是 OCR 请求（含图片/文档，免费）还是匹配请求（纯文本，需付费）
  const hasFile = (body.messages || []).some(m =>
    Array.isArray(m.content) &&
    m.content.some(c => c.type === 'image' || c.type === 'document')
  );

  if (!hasFile) {
    // 匹配请求 → 验证 pay token
    const payToken = body._pay_token || '';
    delete body._pay_token;

    if (!payToken) {
      return jsonResp({
        error: { message: '需要付费后才能查看匹配结果', code: 'PAYMENT_REQUIRED' }
      }, 402, request);
    }

    const tokenRaw = await env.ORDERS.get(`token:${payToken}`);
    if (!tokenRaw) {
      return jsonResp({
        error: { message: '支付凭证无效或已过期，请重新付费', code: 'PAYMENT_REQUIRED' }
      }, 402, request);
    }
    const td = JSON.parse(tokenRaw);
    if (td.expiresAt < Date.now()) {
      return jsonResp({
        error: { message: '支付凭证已过期（24小时内有效），请重新付费', code: 'PAYMENT_REQUIRED' }
      }, 402, request);
    }
  } else {
    delete body._pay_token;
  }

  // 强制模型与 token 上限
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

// ══════════════════════════════════════════════
// 加密工具
// ══════════════════════════════════════════════

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

// 微信 APIv3 Authorization 头
async function buildWechatAuth(method, urlPath, body, privKeyPem, mchid, serial) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = randomHex(16);
  const msg   = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(privKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${serial}",signature="${sigB64}"`;
}

// 微信回调 AES-GCM 解密
async function decryptWechatResource(ciphertext, nonce, associatedData, apiV3Key) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(apiV3Key),
    { name: 'AES-GCM' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new TextEncoder().encode(nonce),
      additionalData: new TextEncoder().encode(associatedData)
    },
    key, b64ToBuffer(ciphertext)
  );
  return new TextDecoder().decode(plain);
}

// 支付宝 RSA2 签名
async function signAlipay(params, privKeyPem) {
  const signStr = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] != null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(privKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signStr));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// 支付宝回调验签
async function verifyAlipay(params, pubKeyPem) {
  const sign = params.sign;
  if (!sign) return false;

  const signStr = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] != null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  try {
    const key = await crypto.subtle.importKey(
      'spki', pemToBuffer(pubKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key,
      b64ToBuffer(sign), new TextEncoder().encode(signStr)
    );
  } catch(e) {
    return false;
  }
}

// ══════════════════════════════════════════════
// HTTP 工具
// ══════════════════════════════════════════════

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
