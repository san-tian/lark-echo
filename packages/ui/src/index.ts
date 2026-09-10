/**
 * Web 配置台的 SSR 壳 + 客户端脚本（DESIGN §4.4）。
 * 无前端框架、无构建步骤：一张页面 + 原生 JS，每 2 秒轮询 /api/state。
 *
 * 优化：差量更新 —— 只有数据变了的区块才写 innerHTML，避免打断输入和滚动。
 */

export interface PageOptions {
  csrf: string;
  nonce: string;
}

const CSS = `
:root{--bg:#0a0c11;--bg-soft:#0e1118;--panel:#12151d;--panel-2:#191d27;--line:#232936;--line-soft:#1a202a;--fg:#e9ecf3;--dim:#98a1b3;--dim-2:#5d6675;--accent:#6c8cff;--accent-2:#8aa6ff;--accent-soft:rgba(108,140,255,.12);--ok:#34d399;--warn:#f5a623;--bad:#f87171;--radius:14px;--shadow:0 10px 30px -18px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.02);--ring:0 0 0 3px rgba(108,140,255,.35);--bg-grad:radial-gradient(1100px 500px at 15% -10%,rgba(108,140,255,.10),transparent 60%),radial-gradient(900px 420px at 100% 0%,rgba(52,211,153,.06),transparent 55%)}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);background-image:var(--bg-grad);background-attachment:fixed;color:var(--fg);font:13px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,12,17,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:50}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),#7c5cff);display:grid;place-items:center;font-size:16px;color:#fff;box-shadow:0 4px 14px -4px rgba(108,140,255,.6);flex-shrink:0}
h1{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{font-size:11px;color:var(--dim);margin-top:1px}
#daemon{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.status-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid var(--line);background:var(--panel-2)}
.status-pill.up{color:var(--ok);border-color:rgba(52,211,153,.28);background:rgba(52,211,153,.08)}
.status-pill.down{color:var(--bad);border-color:rgba(248,113,113,.28);background:rgba(248,113,113,.08)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.status-pill.up .dot{animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 6px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.pill{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;font-size:12px;color:var(--dim);border:1px solid var(--line);background:var(--panel-2)}
main{padding:22px 24px 80px;display:grid;gap:18px;max-width:1240px;margin:0 auto}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow);min-width:0}
h2{font-size:12px;margin:0 0 14px;color:var(--dim);font-weight:600;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:8px}
h2::before{content:"";width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--accent),#7c5cff);flex-shrink:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
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
label{color:var(--dim);font-size:12px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
input,select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,140,255,.15)}
input[readonly]{color:var(--dim)}
input[type=number]{width:88px}
input[type=radio],input[type=checkbox]{accent-color:var(--accent)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.form-grid{display:grid;gap:12px}
.empty{color:var(--dim-2);padding:18px 0;text-align:center;font-size:12px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--dim);background:var(--panel-2)}
.badge.ok{color:var(--ok);border-color:rgba(52,211,153,.25);background:rgba(52,211,153,.08)}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px;background:var(--bg-soft)}
legend{color:var(--dim);font-size:11px;font-weight:600;padding:0 6px;letter-spacing:.03em}
.toasts{position:fixed;top:72px;right:20px;z-index:120;display:grid;gap:8px;max-width:340px;pointer-events:none}
.toast{padding:10px 14px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--panel-2);border:1px solid var(--line);box-shadow:0 8px 24px -10px rgba(0,0,0,.7);animation:slidein .2s ease;pointer-events:auto}
.toast.ok{border-color:rgba(52,211,153,.35);color:var(--ok)}
.toast.error{border-color:rgba(248,113,113,.35);color:var(--bad)}
.toast.info{color:var(--fg)}
.toast.out{opacity:0;transform:translateY(-4px);transition:all .3s}
@keyframes slidein{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.busy-pill{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:120;padding:6px 14px;border-radius:999px;background:var(--panel-2);border:1px solid var(--accent);color:var(--accent-2);font-size:12px;display:none;align-items:center;gap:8px;box-shadow:0 8px 24px -10px rgba(0,0,0,.7)}
body.busy .busy-pill{display:inline-flex}
.spinner{width:12px;height:12px;border:2px solid rgba(108,140,255,.3);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
dialog{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);color:var(--fg);padding:0;box-shadow:0 20px 50px -20px rgba(0,0,0,.8);max-width:440px}
dialog::backdrop{background:rgba(0,0,0,.6);backdrop-filter:blur(3px)}
dialog header{padding:16px 20px;border-bottom:1px solid var(--line);font-weight:600}
dialog .content{padding:18px 20px;line-height:1.6}
dialog footer{padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end}
@media (max-width:640px){header{flex-direction:column;align-items:flex-start;gap:10px}#daemon{width:100%}.row{flex-direction:column;align-items:stretch}.row>*{width:100%}main{padding:16px 14px 60px}input,select{min-width:0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

// 客户端脚本：原生 JS，按区块做差量更新避免打断输入
const CLIENT_JS = `
var CSRF = document.body.dataset.csrf;
var state = null;
var busy = false;
var fsPath = '';
var cwd = '';
var agent = 'pi';
var lastRendered = {}; // 区块签名缓存：只重绘变了的区块
var modelsCache = {}; // {agent: Promise<models>} 避免重复 fetch

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

function confirm2(msg) {
  return new Promise(function (resolve) {
    var dialog = document.getElementById('confirm-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'confirm-dialog';
      dialog.innerHTML = '<header id="confirm-title"></header><div class="content" id="confirm-msg"></div>' +
        '<footer><button id="confirm-no">取消</button><button class="primary" id="confirm-yes">确定</button></footer>';
      document.body.appendChild(dialog);
      dialog.querySelector('#confirm-no').addEventListener('click', function () { dialog.close('no'); });
      dialog.querySelector('#confirm-yes').addEventListener('click', function () { dialog.close('yes'); });
    }
    dialog.querySelector('#confirm-title').textContent = '确认操作';
    dialog.querySelector('#confirm-msg').textContent = msg;
    dialog.showModal();
    dialog.onclose = function () { resolve(dialog.returnValue === 'yes'); };
  });
}

function patch(id, html) {
  var el = document.getElementById(id);
  if (!el) return;
  if (lastRendered[id] === html) return;
  lastRendered[id] = html;
  el.innerHTML = html;
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
  var searchEl = document.getElementById('f-chat-search');
  var q = (searchEl ? searchEl.value : '').toLowerCase();
  var chats = state.chats.filter(function (c) {
    return !q || (c.name || '').toLowerCase().indexOf(q) >= 0 || c.chatId.toLowerCase().indexOf(q) >= 0;
  });
  chatSel.innerHTML = '<option value="">' + (q ? '没有匹配的群' : '选择群…') + '</option>' +
    chats.map(function (c) { return opt(c.chatId, c.name + ' · ' + c.chatId); }).join('');
  if (cur) chatSel.value = cur;
}

function loadDirs(path) {
  return getJSON('/api/fs' + (path ? '?path=' + encodeURIComponent(path) : '')).then(function (d) {
    fsPath = d.path;
    cwd = d.path;
    var cwdInput = document.getElementById('f-cwd');
    if (cwdInput) cwdInput.value = d.path;
    var items = [];
    if (d.parent) items.push(opt(d.parent, '.. 上一级'));
    d.dirs.forEach(function (x) { items.push(opt(x.path, x.name + '/')); });
    var sel = document.getElementById('f-dir');
    if (sel) sel.innerHTML = items.join('') || '<option value="">（没有子目录）</option>';
    return loadSessions();
  });
}

function loadSessions() {
  return getJSON('/api/sessions?agent=' + agent + '&cwd=' + encodeURIComponent(cwd)).then(function (list) {
    var items = [opt('', '新建会话')];
    list.forEach(function (s) {
      items.push(opt(s.sessionId, s.sessionId + '  ·  ' + new Date(s.mtime).toLocaleString()));
    });
    var sel = document.getElementById('f-session');
    if (sel) setOptions(sel, items);
  });
}

function loadModelsFor(a) {
  if (modelsCache[a]) return modelsCache[a];
  modelsCache[a] = getJSON('/api/models?agent=' + a);
  return modelsCache[a];
}

function loadMembers(chatId) {
  if (!chatId) return Promise.resolve();
  return getJSON('/api/members?chatId=' + encodeURIComponent(chatId)).then(function (list) {
    var items = list.map(function (m) { return opt(m.id, m.name + '  ·  ' + m.id.slice(0, 10) + '…'); });
    if (items.length === 0) items = ['<option value="">（拿不到成员，请确认群里有成员）</option>'];
    var sel = document.getElementById('f-me');
    if (sel) setOptions(sel, items, true);
  });
}

/** 把某个 agent 的模型列表填进下拉；列表拿不到就退化成自由文本（§4.4.2） */
function fillModelSelect(selId, a, current) {
  return loadModelsFor(a).then(function (list) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    if (!list.length) {
      sel.innerHTML = '<option value="">（该 agent 未提供模型列表，可直接填）</option>';
      return;
    }
    var items = [opt('', '（agent 默认）')];
    list.forEach(function (m) { items.push(opt(modelValue(m), modelValue(m))); });
    sel.innerHTML = items.join('');
    if (current) sel.value = current;
  });
}

/* -------------------------------- 渲染 -------------------------------- */

function tableOr(empty, head, rows) {
  return rows
    ? '<div class="tablewrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="empty">' + empty + '</div>';
}

function renderHeader() {
  var up = !!state.daemon.pid;
  patch('daemon',
    '<span class="status-pill ' + (up ? 'up' : 'down') + '"><span class="dot"></span>' +
    (up ? '运行中 · pid ' + state.daemon.pid : '未运行') + '</span>' +
    '<span class="pill">渠道 ' + esc(state.daemon.channel) + '</span>' +
    '<span class="pill">更新于 ' + when(state.now) + '</span>');
}

function renderStats() {
  patch('stats',
    stat('绑定', state.bindings.length) +
    stat('运行会话', state.sessions.length) +
    stat('机器人所在群', state.chats.length) +
    stat('待发出站', state.queue.pendingOutbound.length));
}

function renderBindings() {
  var rows = state.bindings.map(function (b) {
    return '<tr><td class="mono">' + esc(b.chatId) + '</td>' +
      '<td>' + esc(b.name || '') + '</td>' +
      '<td class="mono">' + esc(b.sessionId) + '</td>' +
      '<td>' + esc(b.agent) + '</td>' +
      '<td class="mono">' + esc(b.model || '-') + '</td>' +
      '<td class="mono">' + (b.ownerOpenId === '*' ? '<span class="badge">群里所有人</span>' : esc(b.ownerOpenId)) + '</td>' +
      '<td><button class="danger" data-act="unbind" data-chat="' + esc(b.chatId) + '">解绑</button></td></tr>';
  }).join('');
  patch('bindings', tableOr('还没有绑定。用上面的表单把某个群接到一条会话上。',
    '<th>群</th><th>名称</th><th>会话</th><th>agent</th><th>模型</th><th>owner</th><th><span class="sr-only">操作</span></th>',
    rows));
}

function renderCodes() {
  var rows = state.codes.map(function (c) {
    return '<tr><td class="mono" style="font-size:16px;letter-spacing:2px">' + esc(c.code) + '</td>' +
      '<td class="mono">' + esc(c.sessionId) + '</td>' +
      '<td>' + secs(c.expiresAt - state.now) + '</td>' +
      '<td><button data-act="code-del" data-code="' + esc(c.code) + '">作废</button></td></tr>';
  }).join('');
  patch('codes', tableOr('没有有效的绑定码。在群里发 <code>/bind &lt;码&gt;</code> 即可绑定。',
    '<th>码</th><th>会话</th><th>剩余</th><th><span class="sr-only">操作</span></th>', rows));
}

function renderDefaults() {
  var defaults = state.defaultModels || {};
  var html = ['pi', 'claude', 'codex'].map(function (a) {
    return '<div class="row"><label for="def-' + a + '" style="width:80px">' + a + ' 默认</label>' +
      '<select id="def-' + a + '" style="flex:1;min-width:200px"></select>' +
      '<button data-act="default-model-set" data-agent="' + a + '">保存</button>' +
      '<span class="dim">' + esc(defaults[a] || '未设置') + '</span></div>';
  }).join('');
  patch('defaults', html);
  ['pi', 'claude', 'codex'].forEach(function (a) { fillModelSelect('def-' + a, a, defaults[a]); });
}

function renderSessions() {
  var rows = state.sessions.map(function (s) {
    var models = (state.models && state.models[s.sessionId]) || [];
    var cap = s.capabilities && s.capabilities.modelSwitch;
    var modelCell;
    if (cap === 'none' || s.driver === 'native-tui') {
      // §4.4.2 约束 1：改了没用的控件就不给（如实呈现，而不是藏起来）
      modelCell = '<span class="dim" title="该驱动下模型由 agent 自己管">' +
        esc(s.model || '由 agent 自己管理') + '（不可从此处改）</span>';
    } else if (models.length) {
      var opts = models.map(function (m) { return opt(modelValue(m), modelValue(m), modelValue(m) === s.model); }).join('');
      modelCell = '<select data-act="model" data-session="' + esc(s.sessionId) + '" aria-label="会话 ' + esc(s.sessionId) + ' 的模型">' +
        '<option value="">（agent 默认）</option>' + opts + '</select>';
    } else {
      modelCell = '<input data-model-input="' + esc(s.sessionId) + '" value="' + esc(s.model || '') + '" placeholder="provider/model" aria-label="会话 ' + esc(s.sessionId) + ' 的模型"> ' +
        '<button data-act="model-set" data-session="' + esc(s.sessionId) + '">设置</button>';
    }
    return '<tr><td class="mono">' + esc(s.sessionId) + '</td><td>' + esc(s.agent) + '</td>' +
      '<td class="mono">' + esc(s.cwd) + '</td>' +
      '<td>idle ' + secs(s.idleMs) + '</td>' +
      '<td>' + modelCell + '</td>' +
      '<td><button class="danger" data-act="release" data-session="' + esc(s.sessionId) + '">停止</button></td></tr>';
  }).join('');
  patch('sessions', tableOr('没有运行中的会话（发消息或绑定后会自动启动）。',
    '<th>会话</th><th>agent</th><th>cwd</th><th>状态</th><th>模型</th><th><span class="sr-only">操作</span></th>',
    rows));
}

function renderChats() {
  var rows = state.chats.map(function (c) {
    return '<tr><td class="mono">' + esc(c.chatId) + '</td><td>' + esc(c.name) + '</td>' +
      '<td>' + (c.sessionId ? '<span class="badge ok">已绑定 ' + esc(c.sessionId) + '</span>' : '<span class="dim">未绑定</span>') + '</td></tr>';
  }).join('');
  patch('chats', tableOr('机器人不在任何群里，或还没刷新。',
    '<th>群 ID</th><th>名称</th><th>状态</th>', rows));
}

function renderQueue() {
  var rows = state.queue.pendingOutbound.map(function (m) {
    return '<tr><td class="mono">' + esc(m.chatId) + '</td><td>' + esc(m.text.slice(0, 60)) + '</td>' +
      '<td>' + m.attempts + '</td><td>' + when(m.createdAt) + '</td>' +
      '<td><button class="danger" data-act="out-del" data-id="' + esc(m.id) + '">丢弃</button></td></tr>';
  }).join('');
  patch('queue',
    '<div class="row">待处理入站 <b>' + state.queue.pendingInbound + '</b>' +
    ' · 待发送出站 <b>' + state.queue.pendingOutbound.length + '</b>' +
    ' <button data-act="out-flush">立即重试</button></div>' +
    (state.queue.pendingOutbound.length
      ? tableOr('', '<th>群</th><th>内容</th><th>重试</th><th>创建于</th><th><span class="sr-only">操作</span></th>', rows)
      : ''));
}

function renderDoctor() {
  if (!state.doctor) {
    patch('doctor', '<div class="row"><button data-act="doctor-refresh">开始体检</button><span class="dim">尚未检查</span></div>');
    return;
  }
  var checks = state.doctor.checks || [];
  var items = checks.map(function (c) {
    return '<div>' + (c.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>') +
      ' <span class="mono">' + esc(c.id) + '</span> ' + esc(c.detail || '') +
      (!c.ok && c.hint ? '<div class="dim" style="margin-left:18px">→ ' + esc(c.hint) + '</div>' : '') + '</div>';
  }).join('');
  patch('doctor', items + '<div class="row" style="margin-top:8px"><button data-act="doctor-refresh">重新体检</button>' +
    '<span class="dim">检查于 ' + when(state.doctor.at) + '</span></div>');
}

function render() {
  if (!state) return;
  renderHeader();
  renderStats();
  renderBindings();
  renderCodes();
  renderDefaults();
  renderSettings();
  renderSessions();
  renderChats();
  renderQueue();
  renderDoctor();
  renderChatSelect();
}

function refresh() {
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) { state = s; render(); })
    .catch(function () { patch('daemon', '<span class="bad">连接断开</span>'); });
}

function act(fn, okMsg) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  fn().then(function () { if (okMsg) toast(okMsg, 'ok'); return refresh(); })
    .catch(function (e) { toast(e.message || String(e), 'error'); })
    .then(function () { busy = false; document.body.classList.remove('busy'); });
}

function renderSettings() {
  var st = state.settings || {};
  patch('settings', [
    '<fieldset><legend>历史回填（bootstrapHistory）</legend>',
    '<div class="row">',
      '<label for="set-bootstrap.enabled">开关</label>',
      '<select id="set-bootstrap.enabled">',
        opt('true', '开', st.bootstrapEnabled !== false),
        opt('false', '关', st.bootstrapEnabled === false),
      '</select>',
      '<label for="set-bootstrap.max_messages">条数</label>',
      '<input id="set-bootstrap.max_messages" type="number" min="1" max="200" value="' + esc(st.bootstrapMaxMessages ?? 50) + '">',
      '<label for="set-bootstrap.max_age_days">天数</label>',
      '<input id="set-bootstrap.max_age_days" type="number" min="1" max="90" value="' + esc(st.bootstrapMaxAgeDays ?? 7) + '">',
    '</div>',
    '<div class="dim">每个群只回填一次；改这里后新绑定的群生效。</div>',
    '</fieldset>',
    '<fieldset><legend>旁观消息窗口（pendingWindow）</legend>',
    '<div class="row">',
      '<label for="set-pending_window.max_messages">条数</label>',
      '<input id="set-pending_window.max_messages" type="number" min="1" max="200" value="' + esc(st.pendingWindowMax ?? 50) + '">',
    '</div>',
    '<div class="dim">群里没人 @ 机器人时，积累给下一条消息做上下文的最大条数。</div>',
    '</fieldset>',
    '<fieldset><legend>Codex 沙箱</legend>',
    '<div class="row">',
      '<label for="set-codex.sandbox_mode">沙箱模式</label>',
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
  ].join(''));
}

/* -------------------------------- 交互 -------------------------------- */

document.addEventListener('click', function (ev) {
  var el = ev.target.closest('[data-act]');
  if (!el) return;
  var a = el.dataset.act;
  if (a === 'unbind') {
    confirm2('解绑这个群？之后群消息不再进入会话。').then(function (yes) {
      if (yes) act(function () { return api('POST', '/api/unbind', { chatId: el.dataset.chat }); }, '已解绑');
    });
  } else if (a === 'code-del') {
    confirm2('作废这个绑定码？').then(function (yes) {
      if (yes) act(function () { return api('POST', '/api/code/delete', { code: el.dataset.code }); }, '已作废');
    });
  } else if (a === 'release') {
    confirm2('停止这个会话？下次触发会自动重启。').then(function (yes) {
      if (yes) act(function () { return api('POST', '/api/session/release', { sessionId: el.dataset.session }); }, '已停止');
    });
  } else if (a === 'out-flush') act(function () { return api('POST', '/api/outbound/flush', {}); }, '已重试');
  else if (a === 'out-del') {
    confirm2('丢弃这条待发消息？').then(function (yes) {
      if (yes) act(function () { return api('POST', '/api/outbound/discard', { id: Number(el.dataset.id) }); }, '已丢弃');
    });
  } else if (a === 'doctor-refresh') act(function () { return api('POST', '/api/doctor/refresh', {}); });
  else if (a === 'chats-refresh') act(function () { return api('POST', '/api/chats/refresh', {}); }, '群列表已刷新');
  else if (a === 'model-set') {
    var input = document.querySelector('[data-model-input="' + el.dataset.session + '"]');
    act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: input.value.trim() }); }, '模型已更新');
  } else if (a === 'default-model-set') {
    var sel = document.getElementById('def-' + el.dataset.agent);
    act(function () { return api('POST', '/api/default-model', { agent: el.dataset.agent, model: sel.value }); }, '默认模型已保存');
  } else if (a === 'setting-save') {
    act(function () {
      var keys = ['bootstrap.enabled', 'bootstrap.max_messages', 'bootstrap.max_age_days',
        'pending_window.max_messages', 'codex.sandbox_mode'];
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
        chatId: chatId, sessionId: sessionId, agent: agent, cwd: cwd, ownerOpenId: ownerOpenId
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
        sessionId: picked || typed || ('le-' + Date.now().toString(36)), agent: agent, cwd: cwd
      });
    }, '已签发绑定码');
  }
});

document.addEventListener('change', function (ev) {
  var el = ev.target;
  if (el.id === 'f-dir') { act(function () { return loadDirs(el.value); }); }
  else if (el.id === 'f-agent') { agent = el.value; act(function () { return Promise.all([loadSessions(), fillModelSelect('f-model', agent)]); }); }
  else if (el.id === 'f-chat') { act(function () { return loadMembers(el.value); }); }
  else if (el.getAttribute('data-act') === 'model') {
    act(function () { return api('POST', '/api/model', { sessionId: el.dataset.session, model: el.value }); }, '模型已更新');
  }
});

document.addEventListener('input', function (ev) {
  if (ev.target.id === 'f-chat-search') renderChatSelect();
});

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && ev.target.id === 'f-cwd') {
    act(function () { return loadDirs(ev.target.value.trim()); });
  }
});

/* -------------------------------- 轮询 -------------------------------- */
var pollTimer = null;
function startPoll() { if (pollTimer) return; pollTimer = setInterval(refresh, 2000); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('focusin', function (ev) {
  if (ev.target.matches('input,select,textarea')) stopPoll();
});
document.addEventListener('focusout', function (ev) {
  if (ev.target.matches('input,select,textarea')) setTimeout(startPoll, 100);
});

/* -------------------------------- 启动 -------------------------------- */
refresh();
loadDirs('');
fillModelSelect('f-model', 'pi');
startPoll();
`;

export function renderPage(opts: PageOptions): string {
  const { csrf, nonce } = opts;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anylark · 配置台</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body data-csrf="${csrf}">
<div id="toasts" class="toasts" role="status" aria-live="polite" aria-atomic="false"></div>
<div class="busy-pill" role="status" aria-live="polite" aria-atomic="true"><span class="spinner"></span>处理中…</div>
<header>
  <div class="brand">
    <div class="logo" aria-hidden="true">◈</div>
    <div>
      <h1>Anylark</h1>
      <div class="sub">飞书 ⇄ Agent 网关 · 配置台</div>
    </div>
  </div>
  <div id="daemon"></div>
</header>
<main>
  <div id="stats" class="stats"></div>

  <section>
    <h2>新建绑定</h2>
    <div class="form-grid">
      <div class="row">
        <label for="f-chat-search">搜索群</label>
        <input id="f-chat-search" placeholder="群名或 ID…" style="flex:1;min-width:160px">
        <label for="f-chat">选择群</label>
        <select id="f-chat" style="flex:1;min-width:200px"><option value="">选择群…</option></select>
        <button data-act="chats-refresh">刷新群</button>
      </div>
      <div class="row">
        <label for="f-agent">Agent</label>
        <select id="f-agent"><option value="pi">pi</option><option value="claude">Claude Code</option><option value="codex">Codex CLI</option></select>
      </div>
      <div class="row">
        <label for="f-dir">目录</label>
        <select id="f-dir" style="flex:1;min-width:180px"></select>
        <label for="f-cwd">路径</label>
        <input id="f-cwd" class="mono" style="flex:1;min-width:240px" placeholder="输入路径回车跳转">
      </div>
      <div class="row">
        <label for="f-session">会话</label>
        <select id="f-session" style="flex:1;min-width:280px"></select>
        <label for="f-session-new">或新建</label>
        <input id="f-session-new" placeholder="留空自动生成" style="flex:1;min-width:180px">
      </div>
      <div class="row">
        <label for="f-model">模型</label>
        <select id="f-model" style="flex:1;min-width:240px"></select>
      </div>
      <fieldset>
        <legend>谁可以驱动这条会话</legend>
        <div class="row" style="margin:0">
          <label><input type="radio" name="owner-mode" value="me" checked> 仅我</label>
          <select id="f-me" aria-label="选择群成员作为会话拥有者" style="flex:1;min-width:220px"><option value="">先选群，再选成员</option></select>
          <label style="margin-left:12px"><input type="radio" name="owner-mode" value="all"> 群里所有人</label>
        </div>
      </fieldset>
      <div class="row" style="margin:0">
        <button class="primary" data-act="bind">绑定</button>
        <button data-act="code-issue">签发绑定码（群内 /bind &lt;码&gt;）</button>
      </div>
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

