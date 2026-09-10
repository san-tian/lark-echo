import { print } from './io.ts';

export const USAGE = `instead — 把飞书群聊接到本地 agent 会话

用法:
  instead connect <app_id>              录入 app secret（TTY 静默输入，唯一入口）
  instead revoke <app_id>               删除本机凭据
  instead daemon run|start|stop|status|logs
  instead doctor [--app <app_id>]       体检：凭据 / 权限 / 长连接
  instead chats                         列出机器人所在的群
  instead bind [--agent pi|claude|codex] [--session <id>] [--cwd <dir>] [--owner <open_id>|--anyone] [--chat <chat_id>]
  instead unbind <chat_id>
  instead bindings                      绑定总览（含模型与镜像档位）
  instead mirror <chat_id> <off|user|user+assistant|full>
  instead model <session_id> [<provider>/<model>]  查看/设置模型
  instead models <session_id>           列出可切换的模型（需会话在运行）
  instead sessions [--release <session_id>]
  instead ui [--host <addr>] [--port N] [--auth] [--no-open] [--stop]
  instead status

环境变量:
  INSTEAD_APP_SECRET   自动化场景替代交互输入
  INSTEAD_APP_ID       daemon 使用哪个应用（默认取本机唯一凭据）
  INSTEAD_HOME         状态目录，默认 ~/.instead`;

export const usage = (): void => print(USAGE);
