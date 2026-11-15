// ==UserScript==
// @name         全平台自动投递助手（多平台版）
// @namespace    public.job.helper.multiplatform
// @version      0.4.0 (多平台版)
// @description  多平台自动投递助手：支持BOSS直聘、智联招聘，关键词评分筛选、自动投递/沟通、数据导出。
// @match        https://www.zhipin.com/
// @match        https://www.zhipin.com/web/geek/jobs*
// @match        https://www.zhipin.com/web/geek/chat*
// @match        https://www.zhaopin.com/
// @match        https://www.zhaopin.com/sou/*
// @match        https://www.zhaopin.com/jobdetail/*
// @match        https://www.zhaopin.com/jobs*
// @match        https://www.zhaopin.com/job/*
// @match        https://sou.zhaopin.com/*
// @match        https://jobs.zhaopin.com/*
// @match        https://we.51job.com/*
// @match        https://search.51job.com/*
// @match        https://www.liepin.com/
// @match        https://www.liepin.com/zhaopin/*
// @match        https://www.liepin.com/chat/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/*
 * 项目说明：
 * - 这是运行在 Tampermonkey / 篡改猴中的 BOSS 直聘自动打招呼脚本。
 * - 面板在岗位列表页 `/web/geek/jobs` 的全部子路由和聊天页 `/web/geek/chat` 显示。
 * - 主流程：岗位列表选择岗位 -> 点击沟通按钮 -> 进入聊天页 -> 发送常用语或自定义文本 -> 返回岗位列表继续。
 * - 支持随机时间间隔、聊天/列表等待上限、已沟通跳过、岗位沟通记录导出与清理。
 * - 列表耗尽后可自动刷新页面续跑；沟通次数提醒弹窗会自动点击确定，硬限制则暂停。
 * - 岗位记录存储在浏览器 IndexedDB，运行状态存储在 localStorage，用于跨页面跳转后恢复自动化。
 *
 * 维护定位：
 * - RunState：跨页面状态机的持久化，记录 list/chat/returning 阶段。
 * - JobRepository：接口岗位、详情页数据、DOM 卡片的归一化和匹配。
 * - Database / ContactedIndex：IndexedDB 存储和已沟通快速索引。
 * - UI：右侧控制面板、表单同步、状态提示、已沟通虚拟列表。
 * - FastReplyService / GreetingService：常用语、自定义文本、自定义接口和发送校验。
 * - Automation：自动点击岗位、进入聊天页、发送消息、返回列表的主流程。
 * - Exporter / RecordCleaner：岗位记录导出和清理。
 * - 文件后半部分：BOSS 页面 DOM 选择器、HTML 详情解析、点击/输入模拟、通用工具函数。
 *
 * 项目持久记忆（维护摘要）：
 * - 投递主链路：Automation.runListLoop -> processNextCard -> communicateWithCard -> 聊天页发送 -> returning。
 * - 岗位信息来源：岗位列表接口/卡片 DOM/岗位详情接口与详情 HTML；匹配文本合并岗位名、公司、城市、描述和标签。
 * - 投递筛选顺序：本轮去重 -> 城市允许列表 -> 公司筛选/黑名单 -> 用户配置的正向词与反向词；正向至少命中一个且反向零命中才允许投递。
 * - 本轮去重：RunState.processedKeys 只服务当前运行批次；启动新批次会重置，页面刷新时清理，不使用历史 IndexedDB 记录阻断新批次。
 * - 投递节奏：岗位扫描保持快速；点击详情和返回列表后的岗位切换使用 delayMin/delayMax 随机等待。
 * - 弹窗约定：点击立即沟通后优先处理“留在此页”，再等待聊天页输入框并发送问候语。
 * - 默认投递流程：BOSS 内置问候语由平台自动发送；只有开启 useCustomGreeting 才由脚本进入聊天页发送自定义内容。
 * - 参考实现：投递状态机、岗位详情兼容解析、聊天发送确认沿用“参考项目/boss-auto-greeting-main”。
 */
(function () {
  'use strict';

  // 全局常量：集中维护脚本版本、存储 key、默认问候语等。
  // 注意：BOSS 特定的 API 模式已移至 BossAdapter 中
