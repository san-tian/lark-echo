/**
 * Web 配置台的 SSR 壳 + 客户端脚本（DESIGN §4.4）。
 * 无前端框架、无构建步骤：一张页面 + 原生 JS，每 2 秒轮询 /api/state。
 */

export interface PageOptions {
  csrf: string;
  nonce: string;
}

const CSS = `
:root{--bg:#0a0c11;--bg-soft:#0e1118;--panel:#12151d;--panel-2:#191d27;--line:#232936;--line-soft:#1a202a;--fg:#e9ecf3;--dim:#98a1b3;--dim-2:#5d6675;--accent:#6c8cff;--accent-2:#8aa6ff;--accent-soft:rgba(108,140,255,.12);--ok:#34d399;--warn:#f5a623;--bad:#f87171;--radius:14px;--shadow:0 10px 30px -18px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.02);--bg-grad:radial-gradient(1100px 500px at 15% -10%,rgba(108,140,255,.10),transparent 60%),radial-gradient(900px 420px at 100% 0%,rgba(52,211,153,.06),transparent 55%)}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);background-image:var(--bg-grad);background-attachment:fixed;color:var(--fg);font:13px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,12,17,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:50}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),#7c5cff);display:grid;place-items:center;font-size:16px;color:#fff;box-shadow:0 4px 14px -4px rgba(108,140,255,.6)}
h1{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{font-size:11px;color:var(--dim);margin-top:1px}
#daemon{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.status-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid var(--line);background:var(--panel-2)}
.status-pill.up{color:var(--ok);border-color:rgba(52,211,153,.28);background:rgba(52,211,153,.08)}
.status-pill.down{color:var(--bad);border-color:rgba(248,113,113,.28);background:rgba(248,113,113,.08)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.status-pill.up .dot{animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 6px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.pill{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;font-size:12px;color:var(--dim);border:1px solid var(--line);background:var(--panel-2)}
main{padding:22px 24px 80px;display:grid;gap:18px;max-width:1240px;margin:0 auto}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}
h2{font-size:12px;margin:0 0 14px;color:var(--dim);font-weight:600;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:8px}
h2::before{content:"";width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--accent),#7c5cff)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
.stat-num{font-size:24px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat-label{font-size:11px;color:var(--dim);margin-top:2px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
th{color:var(--dim);font-weight:550;font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:var(--panel-2)}
tbody tr{transition:background .12s}
tbody tr:hover{background:rgba(108,140,255,.04)}
tbody tr:last-child td{border-bottom:none}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
b{color:var(--accent-2);font-weight:600}
.dim{color:var(--dim)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
.warn{color:var(--warn)}
button{background:var(--panel-2);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
button:hover{border-color:var(--accent);color:var(--accent-2);background:var(--accent-soft)}
button:active{transform:translateY(1px)}
button.primary{background:linear-gradient(135deg,var(--accent),#7c5cff);border-color:transparent;color:#fff;box-shadow:0 4px 14px -6px rgba(108,140,255,.7)}
button.primary:hover{color:#fff;filter:brightness(1.08)}
button.danger:hover{border-color:var(--bad);color:var(--bad);background:rgba(248,113,113,.08)}
button:disabled{opacity:.4;cursor:default;transform:none}
input,select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,140,255,.15)}
input[readonly]{color:var(--dim)}
input[type=number]{width:88px}
input[type=radio],input[type=checkbox]{accent-color:var(--accent)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.row>label{color:var(--dim);font-size:12px}
.empty{color:var(--dim-2);padding:18px 0;text-align:center;font-size:12px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--dim);background:var(--panel-2)}
.badge.ok{color:var(--ok);border-color:rgba(52,211,153,.25);background:rgba(52,211,153,.08)}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px;background:var(--bg-soft)}
legend{color:var(--dim);font-size:11px;font-weight:600;padding:0 6px;letter-spacing:.03em}
.toasts{position:fixed;top:72px;right:20px;z-index:120;display:grid;gap:8px;max-width:340px}
.toast{padding:10px 14px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--panel-2);border:1px solid var(--line);box-shadow:0 8px 24px -10px rgba(0,0,0,.7);animation:slidein .2s ease}
.toast.ok{border-color:rgba(52,211,153,.35);color:var(--ok)}
.toast.error{border-color:rgba(248,113,113,.35);color:var(--bad)}
.toast.info{color:var(--fg)}
.toast.out{opacity:0;transform:translateY(-4px);transition:all .3s}
@keyframes slidein{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.busy-pill{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:120;padding:6px 14px;border-radius:999px;background:var(--panel-2);border:1px solid var(--accent);color:var(--accent-2);font-size:12px;display:none;align-items:center;gap:8px;box-shadow:0 8px 24px -10px rgba(0,0,0,.7)}
body.busy .busy-pill{display:inline-flex}
.spinner{width:12px;height:12px;border:2px solid rgba(108,140,255,.3);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:640px){header{flex-direction:column;align-items:flex-start}#daemon{justify-content:flex-start}main{padding:16px 14px 60px}}
`;

// 客户端脚本：刻意不用模板字符串，避免转义问题
const CLIENT_JS = `
var CSRF = document.body.dataset.csrf;
var state = null;
var busy = false;
var fsPath = '';
var cwd = '';
var agent = 'pi';

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; });
  });
}
function getJSON(path) { return fetch(path).then(function (r) { return r.json(); }); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function secs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }
function when(ms) { return new Date(ms).toLocaleTimeString(); }
function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
function stat(label, n) { return '<div class="stat"><div class="stat-num">' + n + '</div><div class="stat-label">' + esc(label) + '</div></div>'; }
function toast(msg, kind) {
  var box = document.getElementById('toasts');
  if (!box) return;
  var t = document.createElement('div');
  t.className = 'toast ' + (kind || 'info');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, 3200);
}
function setOptions(sel, items, keep) {
  var cur = keep ? sel.value : '';
  sel.innerHTML = items.join('');
  if (cur) sel.value = cur;
}
function modelValue(m) { return (m.provider ? m.provider + '/' : '') + m.id; }
function renderChatSelect() {
  var chatSel = document.getElementById('f-chat');
  if (!chatSel || !state) return;
  var cur = chatSel.value;
  var q = (document.getElementById('f-chat-search').value || '').toLowerCase();
  var chats = state.chats.filter(function (c) {
    return !q || (c.name || '').toLowerCase().indexOf(q) >= 0 || c.chatId.toLowerCase().indexOf(q) >= 0;
  });
  chatSel.innerHTML = '<option value="">' + (q ? '没有匹配的群' : '选择群…') + '</option>' +
    chats.map(function (c) { return opt(c.chatId, c.name + ' · ' + c.chatId); }).join('');
  if (cur) chatSel.value = cur;
}

/* ------------------------------ 表单数据源 ------------------------------ */

function loadDirs(path) {
  return getJSON('/api/fs' + (path ? '?path=' + encodeURIComponent(path) : '')).then(function (d) {
    fsPath = d.path;
    cwd = d.path;
    document.getElementById('f-cwd').value = d.path;
    var items = [];
    if (d.parent) items.push(opt(d.parent, '.. 上一级'));
    d.dirs.forEach(function (x) { items.push(opt(x.path, x.name + '/')); });
    var sel = document.getElementById('f-dir');
    sel.innerHTML = items.join('') || '<option value="">（没有子目录）</option>';
    return loadSessions();
  });
}

function loadSessions() {
  return getJSON('/api/sessions?agent=' + agent + '&cwd=' + encodeURIComponent(cwd)).then(function (list) {
    var items = [opt('', '新建会话')];
    list.forEach(function (s) {
      items.push(opt(s.sessionId, s.sessionId + '  ·  ' + new Date(s.mtime).toLocaleString()));
    });
    setOptions(document.getElementById('f-session'), items);
  });
}

function loadModelsFor(a, selId) {
  return getJSON('/api/models?agent=' + a).then(function (list) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    var items = [opt('', '（agent 默认）')];
    list.forEach(function (m) { items.push(opt(modelValue(m), modelValue(m))); });
    sel.innerHTML = items.join('');
    if (list.length === 0) sel.innerHTML = '<option value="">（该 agent 未提供模型列表，可直接填）</option>';
  });
}

function loadMembers(chatId) {
  if (!chatId) return Promise.resolve();
  return getJSON('/api/members?chatId=' + encodeURIComponent(chatId)).then(function (list) {
    var items = list.map(function (m) { return opt(m.id, m.name + '  ·  ' + m.id.slice(0, 10) + '…'); });
    if (items.length === 0) items = ['<option value="">（拿不到成员，请确认群里有成员）</option>'];
    setOptions(document.getElementById('f-me'), items, true);
  });
}

/* -------------------------------- 渲染 -------------------------------- */

function render() {
  if (!state) return;
  var up = !!state.daemon.pid;
  document.getElementById('daemon').innerHTML =
    '<span class="status-pill ' + (up ? 'up' : 'down') + '"><span class="dot"></span>' +
    (up ? '运行中 · pid ' + state.daemon.pid : '未运行') + '</span>' +
    '<span class="pill">渠道 ' + esc(state.daemon.channel) + '</span>' +
    '<span class="pill">更新于 ' + when(state.now) + '</span>';

  document.getElementById('stats').innerHTML =
    stat('绑定', state.bindings.length) +
    stat('运行会话', state.sessions.length) +
    stat('机器人所在群', state.chats.length) +
    stat('待发出站', state.queue.pendingOutbound.length);

  var bindRows = state.bindings.map(function (b) {
    return '<tr><td class="mono">' + esc(b.chatId) + '</td>' +
      '<td>' + esc(b.name || '') + '</td>' +
      '<td class="mono">' + esc(b.sessionId) + '</td>' +
      '<td>' + esc(b.agent) + '</td>' +
      '<td class="mono">' + esc(b.model || '-') + '</td>' +
      '<td class="mono">' + (b.ownerOpenId === '*' ? '<span class="badge">群里所有人</span>' : esc(b.ownerOpenId)) + '</td>' +
      '<td><button class="danger" data-act="unbind" data-chat="' + esc(b.chatId) + '">解绑</button></td></tr>';
  }).join('');
  document.getElementById('bindings').innerHTML = state.bindings.length
    ? '<div class="tablewrap"><table><thead><tr><th>群</th><th>名称</th><th>会话</th><th>agent</th><th>模型</th><th>owner</th><th></th></tr></thead><tbody>' + bindRows + '</tbody></table></div>'
    : '<div class="empty">还没有绑定。用下面的表单把某个群接到一条会话上。</div>';

  var codeRows = state.codes.map(function (c) {
    return '<tr><td class="mono" style="font-size:16px;letter-spacing:2px">' + esc(c.code) + '</td>' +
      '<td class="mono">' + esc(c.sessionId) + '</td>' +
      '<td>' + secs(c.expiresAt - state.now) + '</td>' +
      '<td><button data-act="code-del" data-code="' + esc(c.code) + '">作废</button></td></tr>';
  }).join('');
  document.getElementById('codes').innerHTML = state.codes.length
    ? '<div class="tablewrap"><table><thead><tr><th>码</th><th>会话</th><th>剩余</th><th></th></tr></thead><tbody>' + codeRows + '</tbody></table></div>'
    : '<div class="empty">没有有效的绑定码。在群里发 <code>/bind &lt;码&gt;</code> 即可绑定。</div>';

  // 会话与模型
  var defaults = state.defaultModels || {};
  document.getElementById('defaults').innerHTML = ['pi', 'claude', 'codex'].map(function (a) {
    return '<div class="row"><label style="width:70px">' + a + ' 默认</label>' +
      '<select id="def-' + a + '" style="min-width:280px"></select>' +
      '<button data-act="default-model-set" data-agent="' + a + '">保存</button>' +
      '<span class="dim">' + esc(defaults[a] || '未设置') + '</span></div>';
  }).join('');
  ['pi', 'claude', 'codex'].forEach(function (a) {
    var sel = document.getElementById('def-' + a);
    if (!sel) return;
    loadModelsFor(a, 'def-' + a).then(function () { if (defaults[a]) sel.value = defaults[a]; });
  });

  // 设置
  var st = state.settings || {};
  document.getElementById('settings').innerHTML = [
    '<fieldset><legend>历史回填（bootstrapHistory）</legend>',
    '<div class="row">',
      '<label>开关</label>',
      '<select id="set-bootstrap.enabled">',
        opt('true', '开', st.bootstrapEnabled !== false),
        opt('false', '关', st.bootstrapEnabled === false),
      '</select>',
      '<label>条数</label>',
      '<input id="set-bootstrap.max_messages" type="number" min="1" max="200" value="' + esc(st.bootstrapMaxMessages ?? 50) + '">',
      '<label>天数</label>',
      '<input id="set-bootstrap.max_age_days" type="number" min="1" max="90" value="' + esc(st.bootstrapMaxAgeDays ?? 7) + '">',
    '</div>',
    '<div class="dim">每个群只回填一次；改这里后新绑定的群生效。</div>',
    '</fieldset>',
    '<fieldset><legend>旁观消息窗口（pendingWindow）</legend>',
    '<div class="row">',
      '<label>条数</label>',
      '<input id="set-pending_window.max_messages" type="number" min="1" max="200" value="' + esc(st.pendingWindowMax ?? 50) + '">',
    '</div>',
    '<div class="dim">群里没人 @ 机器人时，积累给下一条消息做上下文的最大条数。</div>',
    '</fieldset>',
    '<fieldset><legend>Codex 沙箱</legend>',
    '<div class="row">',
      '<label>沙箱模式</label>',
      '<select id="set-codex.sandbox_mode">',
        opt('', '跟随 codex config.toml', !st.codexSandboxMode),
        opt('read-only', 'read-only（只读）', st.codexSandboxMode === 'read-only'),
        opt('workspace-write', 'workspace-write（可写工作区）', st.codexSandboxMode === 'workspace-write'),
        opt('danger-full-access', 'danger-full-access（完全访问）', st.codexSandboxMode === 'danger-full-access'),
      '</select>',
    '</div>',
    '<div class="dim">下一轮 codex 调用生效。</div>',
    '</fieldset>',
    '<div class="row" style="margin:0">',
      '<button class="primary" data-act="setting-save">保存设置</button>',
      '<span class="dim">历史回填/窗口立即生效；沙箱下一轮生效</span>',
    '</div>'
  ].join('');

  var sessRows = state.sessions.map(function (s) {
    var models = (state.models && state.models[s.sessionId]) || [];
    var opts = models.map(function (m) {
      var v = modelValue(m);
      return '<option value="' + esc(v) + '"' + (s.model === v ? ' selected' : '') + '>' + esc(v) + '</option>';
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
      '<td><button class="danger" data-act="release" data-session="' + esc(s.sessionId) + '">停止</button></td></tr>';
  }).join('');
  document.getElementById('sessions').innerHTML = state.sessions.length
    ? '<div class="tablewrap"><table><thead><tr><th>会话</th><th>agent</th><th>cwd</th><th>状态</th><th>模型</th><th></th></tr></thead><tbody>' + sessRows + '</tbody></table></div>'
    : '<div class="empty">没有运行中的会话（发消息或绑定后会自动启动）。</div>';

  var chatRows = state.chats.map(function (c) {
    return '<tr><td class="mono">' + esc(c.chatId) + '</td><td>' + esc(c.name) + '</td>' +
      '<td>' + (c.sessionId ? '<span class="badge ok">已绑定 ' + esc(c.sessionId) + '</span>' : '<span class="dim">未绑定</span>') + '</td></tr>';
  }).join('');
  document.getElementById('chats').innerHTML = state.chats.length
    ? '<div class="tablewrap"><table><thead><tr><th>群 ID</th><th>名称</th><th>状态</th></tr></thead><tbody>' + chatRows + '</tbody></table></div>'
    : '<div class="empty">机器人不在任何群里，或还没刷新。</div>';

  // 群下拉（带搜索过滤）
  renderChatSelect();

  // 队列
  var outRows = state.queue.pendingOutbound.map(function (m) {
    return '<tr><td>' + esc(m.chatId) + '</td><td>' + esc(m.text.slice(0, 60)) + '</td>' +
      '<td>' + m.attempts + '</td><td>' + when(m.createdAt) + '</td>' +
      '<td><button class="danger" data-act="out-del" data-id="' + m.id + '">丢弃</button></td></tr>';
  }).join('');
  document.getElementById('queue').innerHTML =
    '<div class="row">待处理入站 <b>' + state.queue.pendingInbound + '</b>' +
    ' · 待发送出站 <b>' + state.queue.pendingOutbound.length + '</b>' +
    ' <button data-act="out-flush">立即重试</button></div>' +
    (state.queue.pendingOutbound.length
      ? '<div class="tablewrap"><table><thead><tr><th>群</th><th>内容</th><th>尝试</th><th>时间</th><th></th></tr></thead><tbody>' + outRows + '</tbody></table></div>'
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

function act(fn, okMsg) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  fn().then(function () { if (okMsg) toast(okMsg, 'ok'); return refresh(); })
    .catch(function (e) { toast(e.message || String(e), 'error'); })
    .then(function () { busy = false; document.body.classList.remove('busy'); });
}

/* -------------------------------- 交互 -------------------------------- */

document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var a = el.dataset.act;
  if (a === 'unbind') {
    if (!confirm('解绑这个群？之后群消息不再进入会话。')) return;
    act(function () { return api('POST', '/api/unbind', { chatId: el.dataset.chat }); }, '已解绑');
  } else if (a === 'code-del') {
    if (!confirm('作废这个绑定码？')) return;
    act(function () { return api('POST', '/api/code/delete', { code: el.dataset.code }); }, '已作废');
  } else if (a === 'release') {
    if (!confirm('停止这个会话？下次触发会自动重启。')) return;
    act(function () { return api('POST', '/api/session/release', { sessionId: el.dataset.session }); }, '已停止');
  } else if (a === 'out-flush') act(function () { return api('POST', '/api/outbound/flush', {}); }, '已重试');
  else if (a === 'out-del') {
    if (!confirm('丢弃这条待发消息？')) return;
    act(function () { return api('POST', '/api/outbound/discard', { id: Number(el.dataset.id) }); }, '已丢弃');
  } else if (a === 'doctor-refresh') act(function () { return api('POST', '/api/doctor/refresh', {}); });
  else if (a === 'chats-refresh') act(function () { return api('POST', '/api/chats/refresh', {}); }, '群列表已刷新');
  else if (a === 'fs-up') act(function () { return loadDirs(fsPath.replace(/\\/[^/]+$/, '') || '/'); });
  else if (a === 'model-set') {
    var input = document.querySelector('[data-model-input="' + el.dataset.session + '"]');
    act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: input.value.trim() }); }, '模型已更新');
  } else if (a === 'default-model-set') {
    var sel = document.getElementById('def-' + el.dataset.agent);
    act(function () { return api('POST', '/api/default-model', { agent: el.dataset.agent, model: sel.value }); }, '默认模型已保存');
  } else if (a === 'setting-save') {
    act(function () {
      var keys = [
        'bootstrap.enabled', 'bootstrap.max_messages', 'bootstrap.max_age_days',
        'pending_window.max_messages', 'codex.sandbox_mode'
      ];
      var chain = Promise.resolve();
      keys.forEach(function (k) {
        var inp = document.getElementById('set-' + k);
        if (!inp) return;
        chain = chain.then(function () { return api('POST', '/api/settings', { key: k, value: inp.value }); });
      });
      return chain;
    }, '设置已保存');
  } else if (a === 'bind') {
    act(function () {
      var chatId = document.getElementById('f-chat').value;
      if (!chatId) throw new Error('请先选择群');
      var picked = document.getElementById('f-session').value;
      var typed = document.getElementById('f-session-new').value.trim();
      var sessionId = picked || typed || ('le-' + Date.now().toString(36));
      var mode = document.querySelector('input[name="owner-mode"]:checked').value;
      var ownerOpenId = mode === 'all' ? '*' : document.getElementById('f-me').value;
      if (mode === 'me' && !ownerOpenId) throw new Error('请选择「仅我」对应的成员');
      var model = document.getElementById('f-model').value;
      return api('POST', '/api/bind', {
        chatId: chatId,
        sessionId: sessionId,
        agent: agent,
        cwd: cwd,
        ownerOpenId: ownerOpenId
      }).then(function () {
        if (model) return api('POST', '/api/model', { sessionId: sessionId, model: model });
        return null;
      });
    }, '已绑定');
  } else if (a === 'code-issue') {
    act(function () {
      var picked = document.getElementById('f-session').value;
      var typed = document.getElementById('f-session-new').value.trim();
      return api('POST', '/api/code', {
        sessionId: picked || typed || ('le-' + Date.now().toString(36)),
        agent: agent,
        cwd: cwd
      });
    }, '已签发绑定码');
  }
});

document.addEventListener('change', function (ev) {
  var el = ev.target;
  if (el.id === 'f-dir') { act(function () { return loadDirs(el.value); }); }
  else if (el.id === 'f-agent') { agent = el.value; act(function () { return Promise.all([loadSessions(), loadModelsFor(agent, 'f-model')]); }); }
  else if (el.id === 'f-chat') { act(function () { return loadMembers(el.value); }); }
  else if (el.getAttribute('data-act') === 'model') {
    act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: el.value }); }, '模型已更新');
  }
});

/* -------------------------------- 轮询与输入 -------------------------------- */
var pollTimer = null;
function startPoll() { if (pollTimer) return; pollTimer = setInterval(refresh, 2000); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('focusin', function (ev) {
  if (ev.target.closest && ev.target.closest('input,select,textarea')) stopPoll();
});
document.addEventListener('focusout', function (ev) {
  if (ev.target.closest && ev.target.closest('input,select,textarea')) startPoll();
});
document.addEventListener('input', function (ev) {
  if (ev.target.id === 'f-chat-search') renderChatSelect();
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && ev.target.id === 'f-cwd') {
    act(function () { return loadDirs(ev.target.value.trim()); });
  }
});

/* -------------------------------- 启动 -------------------------------- */
refresh();
loadDirs('');
loadModelsFor('pi', 'f-model');
startPoll();
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
<div id="toasts" class="toasts"></div>
<div class="busy-pill"><span class="spinner"></span>处理中…</div>
<header>
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <h1>Lark Echo</h1>
      <div class="sub">飞书 ⇄ Agent 网关 · 配置台</div>
    </div>
  </div>
  <div id="daemon"></div>
</header>
<main>
  <div id="stats" class="stats"></div>

  <section>
    <h2>新建绑定</h2>
    <div class="row">
      <label>群</label>
      <input id="f-chat-search" placeholder="搜索群名或 ID…" style="min-width:160px">
      <select id="f-chat" style="min-width:240px"><option value="">选择群…</option></select>
      <button data-act="chats-refresh">刷新群</button>
      <label>agent</label>
      <select id="f-agent">
        <option value="pi">pi</option>
        <option value="claude">Claude Code</option>
        <option value="codex">Codex CLI</option>
      </select>
    </div>
    <div class="row">
      <label>目录</label>
      <select id="f-dir" style="min-width:220px"></select>
      <input id="f-cwd" class="mono" style="min-width:320px" placeholder="输入路径回车跳转">
      <button data-act="fs-up">上一级</button>
    </div>
    <div class="row">
      <label>会话</label>
      <select id="f-session" style="min-width:320px"></select>
      <input id="f-session-new" placeholder="或输入新会话名（留空自动生成）" style="min-width:220px">
    </div>
    <div class="row">
      <label>模型</label>
      <select id="f-model" style="min-width:280px"></select>
    </div>
    <fieldset>
      <legend>谁可以驱动这条会话</legend>
      <div class="row" style="margin:0">
        <label><input type="radio" name="owner-mode" value="me" checked> 仅我</label>
        <select id="f-me" style="min-width:260px"><option value="">先选群，再选成员</option></select>
        <label style="margin-left:16px"><input type="radio" name="owner-mode" value="all"> 群里所有人</label>
      </div>
    </fieldset>
    <div class="row" style="margin:0">
      <button class="primary" data-act="bind">绑定</button>
      <button data-act="code-issue">签发绑定码（群内 /bind &lt;码&gt;）</button>
    </div>
  </section>

  <section>
    <h2>绑定</h2>
    <div id="bindings"></div>
  </section>

  <section>
    <h2>绑定码</h2>
    <div id="codes"></div>
  </section>

  <section>
    <h2>渠道默认模型</h2>
    <div id="defaults"></div>
    <div class="dim">新建会话时若未单独指定，就用这里的默认模型。</div>
  </section>

  <section>
    <h2>设置</h2>
    <div id="settings"></div>
  </section>

  <section>
    <h2>运行中的会话</h2>
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
