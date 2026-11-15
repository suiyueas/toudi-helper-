// 构建脚本：按 tools/parts.js 顺序把 src/ 拼回完整用户脚本，并做语法校验。
// 用法：node tools/build.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { outputFile, parts } = require('./parts');

const root = path.resolve(__dirname, '..');

const chunks = parts.map((part) => {
  const target = path.join(root, part.file);
  if (!fs.existsSync(target)) {
    throw new Error(`缺少源文件：${part.file}（先运行 node tools/split.js）`);
  }
  return fs.readFileSync(target, 'utf8');
});

// 各 part 按原样拼接（split 时已含换行边界），避免引入额外空行破坏一致性。
const bundle = chunks.join('');
const output = path.join(root, outputFile);

// 往返校验：构建结果必须与拆分前的输入逐字节一致，防止拆分破坏文件。
const expected = fs.existsSync(path.join(root, '.split-source'))
  ? fs.readFileSync(path.join(root, '.split-source'), 'utf8')
  : null;
if (expected !== null && expected !== bundle) {
  throw new Error('往返校验失败：构建结果与原始文件不一致（检查锚点或手工改动是否破坏边界）');
}

fs.writeFileSync(output, bundle, 'utf8');

execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
console.log(`已生成 ${outputFile}（${bundle.split(/\r?\n/).length} 行），语法校验通过。`);
