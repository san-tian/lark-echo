import { print } from './io.ts';

export const USAGE = `anylark — 把飞书群聊接到本地 agent 会话

用法:
  anylark connect <app_id>              录入 app secret（TTY 静默输入，唯一入口）
  anylark revoke <app_id>               删除本机凭据
  anylark daemon run|start|stop|status|logs
  anylark doctor [--app <app_id>]       体检：凭据 / 权限 / 长连接
  anylark chats                         列出机器人所在的群
  anylark bind [--agent pi|claude|codex] [--session <id>] [--cwd <dir>] [--owner <open_id>|--anyone] [--chat <chat_id>]
  anylark unbind <chat_id>
  anylark bindings                      绑定总览（含模型与镜像档位）
  anylark mirror <chat_id> <off|user|user+assistant|full>
  anylark model <session_id> [<provider>/<model>]  查看/设置模型
  anylark models <session_id>           列出可切换的模型（需会话在运行）
  anylark sessions [--release <session_id>]
  anylark ui [--host <addr>] [--port N] [--auth] [--no-open] [--stop]
  anylark status

环境变量:
  ANYLARK_APP_SECRET   自动化场景替代交互输入
  ANYLARK_APP_ID       daemon 使用哪个应用（默认取本机唯一凭据）
  ANYLARK_HOME         状态目录，默认 ~/.anylark`;

export const usage = (): void => print(USAGE);
