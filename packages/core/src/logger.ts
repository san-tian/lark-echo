export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  traceId?: string;
  chatId?: string;
  sessionId?: string;
  turnId?: string;
  eventId?: string;
  [key: string]: unknown;
}

type Sink = (line: string) => void;

const defaultSink: Sink = (line) => process.stderr.write(line + '\n');

let sink: Sink = defaultSink;

/** 测试用：替换日志出口 */
export function setLogSink(next: Sink | null): void {
  sink = next ?? defaultSink;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function emit(level: LogLevel, base: LogFields, msg: string, fields?: LogFields): void {
  const record = { ts: new Date().toISOString(), level, msg, ...base, ...fields };
  sink(JSON.stringify(record));
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', base, msg, fields),
    info: (msg, fields) => emit('info', base, msg, fields),
    warn: (msg, fields) => emit('warn', base, msg, fields),
    error: (msg, fields) => emit('error', base, msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const rootLogger = createLogger({ svc: 'lark-echo' });
