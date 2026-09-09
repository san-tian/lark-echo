/**
 * Web 配置台的 SSR 壳 + 客户端脚本（DESIGN §4.4）。
 * 无前端框架、无构建步骤：一张页面 + 原生 JS，每 2 秒轮询 /api/state。
 */

export interface PageOptions {
  csrf: string;
  nonce: string;
}

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3fb950;--bad:#f85149;--accent:#4493f8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:baseline;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{font-size:15px;margin:0;font-weight:600}
h2{font-size:13px;margin:0 0 10px;color:var(--dim);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
main{padding:18px 20px 60px;display:grid;gap:18px;max-width:1200px}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--dim);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:none}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--fg)}
.dim{color:var(--dim)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
button{background:#1f2430;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.45;cursor:default}
input,select{background:#0d1016;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font-size:12px;min-width:120px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.empty{color:var(--dim);padding:6px 0}
.badge{display:inline-block;padding:1px 6px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--dim)}
`;

// 客户端脚本：刻意不用模板字符串，避免转义问题
const CLIENT_JS = `
var CSRF = document.body.dataset.csrf;
var state = null;
var busy = false;

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function secs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }
function when(ms) { return new Date(ms).toLocaleTimeString(); }

function fillChats() {
  var sel = document.getElementById('f-chat');
  if (!sel || !state) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">选择群…</option>' + state.chats.map(function (c) {
    return '<option value="' + esc(c.chatId) + '">' + esc(c.name) + ' · ' + esc(c.chatId) + '</option>';
  }).join('');
  sel.value = cur;
}

function render() {
  if (!state) return;
  document.getElementById('daemon').innerHTML =
    'daemon <span class="' + (state.daemon.pid ? 'ok' : 'bad') + '">' +
    (state.daemon.pid ? '运行中 · pid ' + state.daemon.pid : '未运行') + '</span>' +
    ' · 渠道 ' + esc(state.daemon.channel) +
    ' <span class="dim">· 更新于 ' + when(state.now) + '</span>';

  // 绑定
  var bindRows = state.bindings.map(function (b) {
    return '<tr><td class="mono">' + esc(b.chatId) + '</td>' +
      '<td>' + esc(b.name || '') + '</td>' +
      '<td class="mono">' + esc(b.sessionId) + '</td>' +
      '<td>' + esc(b.agent) + '</td>' +
      '<td class="mono">' + esc(b.model || '-') + '</td>' +
      '<td class="mono">' + esc(b.ownerOpenId) + '</td>' +
      '<td><button data-act="unbind" data-chat="' + esc(b.chatId) + '">解绑</button></td></tr>';
  }).join('');
  document.getElementById('bindings').innerHTML = state.bindings.length
    ? '<table><thead><tr><th>群</th><th>名称</th><th>会话</th><th>agent</th><th>模型</th><th>owner</th><th></th></tr></thead><tbody>' + bindRows + '</tbody></table>'
    : '<div class="empty">还没有绑定。用下面的表单把某个群接到一条会话上。</div>';

  // 绑定码
  var codeRows = state.codes.map(function (c) {
    return '<tr><td class="mono" style="font-size:16px;letter-spacing:2px">' + esc(c.code) + '</td>' +
      '<td class="mono">' + esc(c.sessionId) + '</td>' +
      '<td>' + secs(c.expiresAt - state.now) + '</td>' +
      '<td><button data-act="code-del" data-code="' + esc(c.code) + '">作废</button></td></tr>';
  }).join('');
  document.getElementById('codes').innerHTML = state.codes.length
    ? '<table><thead><tr><th>码</th><th>会话</th><th>剩余</th><th></th></tr></thead><tbody>' + codeRows + '</tbody></table>'
    : '<div class="empty">没有有效的绑定码。在群里发 <code>/bind &lt;码&gt;</code> 即可绑定。</div>';

  // 会话与模型
  var sessRows = state.sessions.map(function (s) {
    var models = (state.models && state.models[s.sessionId]) || [];
    var opts = models.map(function (m) {
      var v = (m.provider ? m.provider + '/' : '') + m.id;
      var sel = (s.model === v) ? ' selected' : '';
      return '<option value="' + esc(v) + '"' + sel + '>' + esc(v) + '</option>';
    }).join('');
    var modelCell;
    if (s.capabilities.modelSwitch === 'none' || s.driver === 'native-tui') {
      modelCell = '<span class="dim">' + esc(s.model || '由 agent 自己管理') + '（不可从此外改）</span>';
    } else if (models.length) {
      modelCell = '<select data-act="model" data-session="' + esc(s.sessionId) + '">' +
        '<option value="">(agent 默认)</option>' + opts + '</select>';
    } else {
      modelCell = '<input data-model-input="' + esc(s.sessionId) + '" value="' + esc(s.model || '') + '" placeholder="provider/model"> ' +
        '<button data-act="model-set" data-session="' + esc(s.sessionId) + '">设置</button>';
    }
    return '<tr><td class="mono">' + esc(s.sessionId) + '</td><td>' + esc(s.agent) + '</td>' +
      '<td class="mono">' + esc(s.cwd) + '</td>' +
      '<td>idle ' + secs(s.idleMs) + '</td>' +
      '<td>' + modelCell + '</td>' +
      '<td><button data-act="release" data-session="' + esc(s.sessionId) + '">停止</button></td></tr>';
  }).join('');
  document.getElementById('sessions').innerHTML = state.sessions.length
    ? '<table><thead><tr><th>会话</th><th>agent</th><th>cwd</th><th>状态</th><th>模型</th><th></th></tr></thead><tbody>' + sessRows + '</tbody></table>'
    : '<div class="empty">没有运行中的会话（发消息或绑定后会自动启动）。</div>';

  // 群
  var chatRows = state.chats.map(function (c) {
    return '<tr><td class="mono">' + esc(c.chatId) + '</td><td>' + esc(c.name) + '</td>' +
      '<td>' + (c.sessionId ? '<span class="badge">已绑定 ' + esc(c.sessionId) + '</span>' : '<span class="dim">未绑定</span>') + '</td></tr>';
  }).join('');
  document.getElementById('chats').innerHTML = state.chats.length
    ? '<table><thead><tr><th>群 ID</th><th>名称</th><th>状态</th></tr></thead><tbody>' + chatRows + '</tbody></table>'
    : '<div class="empty">机器人不在任何群里，或还没刷新。</div>';
  fillChats();

  // 队列
  var outRows = state.queue.pendingOutbound.map(function (m) {
    return '<tr><td>' + esc(m.chatId) + '</td><td>' + esc(m.text.slice(0, 60)) + '</td>' +
      '<td>' + m.attempts + '</td><td>' + when(m.createdAt) + '</td>' +
      '<td><button data-act="out-del" data-id="' + m.id + '">丢弃</button></td></tr>';
  }).join('');
  document.getElementById('queue').innerHTML =
    '<div class="row" style="margin-bottom:8px">待处理入站 <b>' + state.queue.pendingInbound + '</b>' +
    ' · 待发送出站 <b>' + state.queue.pendingOutbound.length + '</b>' +
    ' <button data-act="out-flush">立即重试</button></div>' +
    (state.queue.pendingOutbound.length
      ? '<table><thead><tr><th>群</th><th>内容</th><th>尝试</th><th>时间</th><th></th></tr></thead><tbody>' + outRows + '</tbody></table>'
      : '<div class="empty">出站队列为空。</div>');

  // 诊断
  var checks = (state.doctor && state.doctor.checks) || [];
  document.getElementById('doctor').innerHTML = checks.length
    ? checks.map(function (c) {
        return '<div>' + (c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') +
          ' <span class="mono">' + esc(c.id) + '</span> ' + esc(c.detail || '') +
          (!c.ok && c.hint ? '<div class="dim" style="margin-left:18px">→ ' + esc(c.hint) + '</div>' : '') + '</div>';
      }).join('') + '<div class="row" style="margin-top:8px"><button data-act="doctor-refresh">重新体检</button>' +
      '<span class="dim">检查于 ' + when(state.doctor.at) + '</span></div>'
    : '<div class="row"><button data-act="doctor-refresh">开始体检</button><span class="dim">尚未检查</span></div>';
}

function refresh() {
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) { state = s; render(); })
    .catch(function () { document.getElementById('daemon').innerHTML = '<span class="bad">连接断开</span>'; });
}

function act(fn) {
  if (busy) return;
  busy = true;
  fn().then(function () { return refresh(); })
    .catch(function (e) { alert(e.message); })
    .then(function () { busy = false; });
}

document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var act_ = el.dataset.act;
  if (act_ === 'unbind') act(function () { return api('POST', '/api/unbind', { chatId: el.dataset.chat }); });
  else if (act_ === 'code-del') act(function () { return api('POST', '/api/code/delete', { code: el.dataset.code }); });
  else if (act_ === 'release') act(function () { return api('POST', '/api/session/release', { sessionId: el.dataset.session }); });
  else if (act_ === 'out-flush') act(function () { return api('POST', '/api/outbound/flush', {}); });
  else if (act_ === 'out-del') act(function () { return api('POST', '/api/outbound/discard', { id: Number(el.dataset.id) }); });
  else if (act_ === 'doctor-refresh') act(function () { return api('POST', '/api/doctor/refresh', {}); });
  else if (act_ === 'chats-refresh') act(function () { return api('POST', '/api/chats/refresh', {}); });
  else if (act_ === 'model-set') {
    var input = document.querySelector('[data-model-input="' + el.dataset.session + '"]');
    act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: input.value.trim() }); });
  } else if (act_ === 'bind') {
    act(function () {
      return api('POST', '/api/bind', {
        chatId: document.getElementById('f-chat').value,
        sessionId: document.getElementById('f-session').value.trim(),
        agent: document.getElementById('f-agent').value,
        cwd: document.getElementById('f-cwd').value.trim(),
        ownerOpenId: document.getElementById('f-owner').value.trim()
      });
    });
  } else if (act_ === 'code-issue') {
    act(function () {
      return api('POST', '/api/code', {
        sessionId: document.getElementById('f-session').value.trim(),
        agent: document.getElementById('f-agent').value,
        cwd: document.getElementById('f-cwd').value.trim()
      });
    });
  }
});

document.addEventListener('change', function (ev) {
  var el = ev.target.closest('[data-act="model"]');
  if (el) act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: el.value }); });
});

refresh();
setInterval(refresh, 2000);
`;

export function renderPage(opts: PageOptions): string {
  const { csrf, nonce } = opts;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lark Echo · 配置台</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body data-csrf="${csrf}">
<header>
  <h1>Lark Echo 配置台</h1>
  <div id="daemon" class="dim"></div>
</header>
<main>
  <section>
    <h2>绑定</h2>
    <div id="bindings"></div>
    <div class="row" style="margin-top:12px">
      <select id="f-chat"><option value="">选择群…</option></select>
      <input id="f-session" placeholder="session id">
      <select id="f-agent"><option value="pi">pi</option></select>
      <input id="f-cwd" placeholder="cwd" style="min-width:200px">
      <input id="f-owner" placeholder="owner open_id">
      <button class="primary" data-act="bind">绑定</button>
      <button data-act="code-issue">签发绑定码</button>
      <button data-act="chats-refresh">刷新群列表</button>
    </div>
  </section>
  <section>
    <h2>绑定码</h2>
    <div id="codes"></div>
  </section>
  <section>
    <h2>会话与模型</h2>
    <div id="sessions"></div>
  </section>
  <section>
    <h2>机器人所在的群</h2>
    <div id="chats"></div>
  </section>
  <section>
    <h2>队列</h2>
    <div id="queue"></div>
  </section>
  <section>
    <h2>诊断</h2>
    <div id="doctor"></div>
  </section>
</main>
<script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}
