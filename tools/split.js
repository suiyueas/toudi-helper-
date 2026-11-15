// 一次性工具：把完整脚本按 tools/parts.js 的锚点拆进 src/。
// 之后日常维护直接改 src/，用 build.js 生成；本脚本仅在需要重新划分模块时使用。
// 用法：node tools/split.js [输入文件]（默认 outputFile）
'use strict';

const fs = require('fs');
const path = require('path');
const { outputFile, parts } = require('./parts');

const root = path.resolve(__dirname, '..');
const input = path.join(root, process.argv[2] || outputFile);

const text = fs.readFileSync(input, 'utf8');
// 保存原始快照，build.js 用它做逐字节往返校验。
fs.writeFileSync(path.join(root, '.split-source'), text, 'utf8');
// 兼容 CRLF/LF：按实际行尾切分，写回时用同一行尾拼接，保证字节级一致。
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(eol);

const positions = parts.map((part) => {
  const matched = [];
  lines.forEach((line, index) => {
    if (line === part.anchor) matched.push(index);
  });
  if (matched.length !== 1) {
    throw new Error(`锚点必须唯一，实际命中 ${matched.length} 次：${part.anchor}`);
  }
  return matched[0];
});

for (let i = 1; i < positions.length; i += 1) {
  if (positions[i] <= positions[i - 1]) {
    throw new Error(`锚点顺序错误：${parts[i].file} 未排在前一个之后`);
  }
}

parts.forEach((part, index) => {
  const start = positions[index];
  const end = index + 1 < parts.length ? positions[index + 1] : lines.length;
  const isLast = index === parts.length - 1;
  // 非末尾块补一个行尾：join('') 拼接时才能与原文件逐字节一致。
  const chunk = lines.slice(start, end).join(eol) + (isLast ? '' : eol);
  const target = path.join(root, part.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, chunk, 'utf8');
  console.log(`写入 ${part.file}（${end - start} 行）`);
});

console.log(`完成：共 ${parts.length} 个源文件。`);
