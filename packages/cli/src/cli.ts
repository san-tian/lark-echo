#!/usr/bin/env node
/**
 * 可执行入口 —— 唯一有副作用（process.exit）的文件。
 * 逻辑都在 index.ts，那边保持纯 import 安全，测试才能直接调 run()。
 */
import { main } from './index.ts';

void main();
