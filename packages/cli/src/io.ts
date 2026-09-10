/** 终端输出。集中在一处，方便测试时替换 sink。 */

let sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

/** 测试用：把输出接到数组里，返回还原函数 */
export function captureOutput(into: string[]): () => void {
  const prev = sink;
  sink = (line) => into.push(line);
  return () => {
    sink = prev;
  };
}

export const print = (line = ''): void => sink(line);
export const ok = (line: string): void => print(`✓ ${line}`);
export const fail = (line: string): void => print(`✗ ${line}`);

/**
 * 定宽表格：列宽按内容自适应，最后一列不补空格（免得行尾拖一串空白）。
 * @param head 表头
 * @param rows 每行的单元格，长度需与 head 一致
 */
export function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)];
}
