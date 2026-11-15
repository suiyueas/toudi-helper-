// 源文件拆分清单：按顺序拼接即为完整用户脚本。
// 每个 part 的 anchor 必须是文件中唯一的整行，split/build 都依赖它定位。
// 修改模块请编辑 src/ 下对应文件，然后运行 node tools/build.js 重新生成脚本。
'use strict';

module.exports = {
  outputFile: 'toudi-helper-.user.js',
  parts: [
    { file: 'src/00-header.js', anchor: '// ==UserScript==' },
    { file: 'src/01-app.js', anchor: '  const APP = {' },
    { file: 'src/02-runtime.js', anchor: '  const runtime = {' },
    { file: 'src/03-boot-config.js', anchor: '  function bootWhenReady() {' },
    { file: 'src/04-runstate-debug.js', anchor: '  const RunState = {' },
    { file: 'src/05-network.js', anchor: '  function installNetworkInterceptors() {' },
    { file: 'src/06-repository.js', anchor: '  const JobRepository = {' },
    { file: 'src/07-database.js', anchor: '  const Database = {' },
    { file: 'src/08-logwindow.js', anchor: '  const LogWindow = {' },
    { file: 'src/09-ui.js', anchor: '  const UI = {' },
    { file: 'src/10-services.js', anchor: '  const FastReplyService = {' },
    { file: 'src/11-automation.js', anchor: '  const Automation = {' },
    { file: 'src/12-score.js', anchor: '  function describeScoreRejection(scoreResult) {' },
    { file: 'src/13-utils.js', anchor: '  function getAccessibleDocuments() {' },
    { file: 'src/14-dom.js', anchor: '  function getJobCards() {' },
  ],
};
