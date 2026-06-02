// 代理商/转介绍参数会话级持久化 + 内部链接自动追加
// URL 出现 ?agent= 或 ?ref= → 写入 sessionStorage → 后续页面所有内部链接自动带参
// sessionStorage 在浏览器 tab 关闭时清空，避免跨会话归因漂移
(function () {
  var qs = new URLSearchParams(location.search);
  var agent = qs.get('agent') || sessionStorage.getItem('dzhun_agent') || '';
  var ref = qs.get('ref') || sessionStorage.getItem('dzhun_ref') || '';
  if (agent) { try { sessionStorage.setItem('dzhun_agent', agent); } catch (_) {} }
  if (ref)   { try { sessionStorage.setItem('dzhun_ref', ref); } catch (_) {} }
  if (!agent && !ref) return;

  var parts = [];
  if (agent) parts.push('agent=' + encodeURIComponent(agent));
  if (ref)   parts.push('ref='   + encodeURIComponent(ref));
  var fullQs = '?' + parts.join('&');

  function rewrite(href) {
    if (!href) return href;
    if (href.charAt(0) !== '/') return href;       // 仅内部绝对路径
    if (href.indexOf('?') >= 0) return href;       // 已有 query，跳过
    if (href.charAt(0) === '#') return href;       // 纯 hash
    var hashPos = href.indexOf('#');
    if (hashPos > 0) return href.slice(0, hashPos) + fullQs + href.slice(hashPos);
    return href + fullQs;
  }

  function init() {
    document.querySelectorAll('a[href^="/"]').forEach(function (el) {
      var h = el.getAttribute('href');
      var nh = rewrite(h);
      if (nh !== h) el.setAttribute('href', nh);
    });
    document.querySelectorAll('[onclick]').forEach(function (el) {
      var oc = el.getAttribute('onclick') || '';
      var newOc = oc.replace(
        /(window\.location\.href\s*=\s*['"])(\/[^'"#?]*)(['"])/g,
        function (m, p1, p2, p3) { return p1 + rewrite(p2) + p3; }
      );
      if (newOc !== oc) el.setAttribute('onclick', newOc);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
