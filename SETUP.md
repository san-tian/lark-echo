# 配置指南

目标是**尽量少的步骤**：把下面这段提示词复制给你的 agent（Claude Code / Codex / pi 都行），它会带你走完；
你只需要做 **3 件必须由人做的事**。

---

## 第一步：把这段提示词复制给 agent

```
帮我在这台机器上配置 lark-echo —— 一个把飞书群聊接到本地 agent 会话的网关。
仓库：https://github.com/san-tian/lark-echo

请按顺序做，每一步都先告诉我你要做什么、做完告诉我结果：

1. 安装：
   git clone https://github.com/san-tian/lark-echo.git ~/lark-echo
   cd ~/lark-echo && npm install --include=dev
   cd packages/cli && npm link          # 让 lark-echo 进入全局 PATH
   验证：lark-echo --help

2. 看这台机器有没有 tailscale（`tailscale ip -4`）。有的话记下 tailnet 地址，
   后面控制台会默认监听它，我就能从别的设备打开。

3. 让我去飞书开放平台建一个自建应用（下面是「人工步骤 1」）。建好后我会把 app_id 给你。

4. 拿到 app_id 后，叫我**自己**在终端运行 `lark-echo connect <app_id>` 并输入 App Secret。
   不要让我把 secret 发给你，也不要把它写进任何命令、文件或日志。

5. 跑 `lark-echo daemon start`，然后 `lark-echo doctor`。
   如果 doctor 报缺权限，读它返回的原始错误 msg，告诉我具体该在开放平台开哪个权限，不要猜。

6. 跑 `lark-echo ui --no-open`，把打印出来的地址给我。
   然后帮我把机器人所在的群绑定到一条会话上（用控制台，或 `lark-echo bind --owner <选我自己>`）。

7. 让我在群里 @机器人 发一句话，确认能收到回复。收不到就读 daemon 日志排查。

硬性要求：
- App Secret 只能由我在终端亲自输入。不要让我贴进对话。
- 报权限错误时，按飞书返回的 msg 指路，不要照抄猜测的权限名。
- 不要替我操作飞书网页。
```

---

## 你只需要做的 3 件事

### 1. 建一个飞书自建应用（约 2 分钟）

1. 打开 <https://open.feishu.cn/app> → **创建企业自建应用**（名字随便，比如 `Lark Echo`）
2. 左侧 **添加应用能力** → 添加 **机器人**
3. 左侧 **权限管理** → 搜索并勾选这 4 个：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:chat:readonly`
   - `im:resource`
4. 左侧 **事件与回调** → 订阅方式选 **长连接**（不需要公网地址）→ 添加事件 **接收消息 `im.message.receive_v1`**
5. 左侧 **版本管理与发布** → 创建版本 → 申请发布
6. 回到 **凭证与基础信息**，复制 **App ID** 和 **App Secret**

### 2. 把机器人拉进目标群

在飞书里打开目标群 → 设置 → 群机器人 → 添加机器人 → 选你刚建的应用。

### 3. 在终端里输入 App Secret

agent 会叫你跑这条命令，你自己输入 secret（不回显、不进 shell 历史）：

```bash
lark-echo connect cli_xxxxxxxx
App Secret: ********        # 粘贴后回车，屏幕上不会有任何显示
```

看到 `✓ 凭据校验通过` 就说明成了。

---

## 完事之后

```bash
lark-echo ui            # 打开控制台，在里面选群 / 选目录 / 选会话 / 选模型，点「绑定」
```

绑定后，在群里 @机器人 说话，它就会用你选的那条 agent 会话回答，工具调用过程留在你的本地会话里。

---

## 手动版（不用 agent）

```bash
git clone https://github.com/san-tian/lark-echo.git ~/lark-echo
cd ~/lark-echo && npm install --include=dev
cd packages/cli && npm link

lark-echo connect cli_xxxxxxxx     # 输入 App Secret
lark-echo daemon start
lark-echo doctor                   # 应该全绿
lark-echo ui                       # 在浏览器里绑定，或：
lark-echo bind --owner <你的 open_id>
```

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `lark-echo: command not found` | 没跑 `npm link`，或当前终端没加载 `~/.bashrc`（`lark-echo --help` 在登录 shell 里试） |
| 群里 @机器人 没反应 | 1) 群没绑定 → `lark-echo bindings`；2) 没 @ 到 → 检查是不是只回复了消息而不是 @；3) `lark-echo daemon logs` 看有没有 inbound |
| 机器人回了「本群未绑定任何会话」 | 这个群还没绑，去控制台绑一下 |
| 机器人回了「暂不支持话题群」 | 飞书话题群暂不支持，换普通群 |
| `doctor` 报缺权限 | 按它给的原始错误 msg 去开放平台补对应权限，然后**重新发布版本** |
| 控制台打不开 | 默认监听 tailnet 地址；没有 tailscale 时才是 `127.0.0.1`。用 `lark-echo ui --host 127.0.0.1` 强制本机 |
| 想给控制台加鉴权 | `lark-echo ui --auth`（会带一个一次性 token 的 URL） |

## 安全须知

- **App Secret 只存在于本机** `~/.lark-echo/feishu/<app_id>.json`（权限 0600），不会进会话、不会进日志。
- 控制台默认**无鉴权**，因为它监听的是你自己的 tailnet 地址（或本机）。**不要**用 `--host 0.0.0.0` 暴露到公网/局域网。
- 群里触发 agent 时，agent 以你本地会话的权限执行 —— 它会跑 shell。默认只有**绑定者**能触发；绑定表单里的「群里所有人」请谨慎使用。
