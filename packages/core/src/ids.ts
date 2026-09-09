import { randomUUID, randomInt } from 'node:crypto';

export const newId = (): string => randomUUID();

/** 全链路 trace id：event_id → turnId → 出站 msg_id（缺口 F） */
export const newTraceId = (): string => randomUUID().slice(0, 8);

export const newTurnId = (): string => randomUUID();

/** 6 位一次性绑定码（§1.2） */
export const newBindCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
