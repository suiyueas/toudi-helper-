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
  const APP = {
    name: '全平台自动投递助手',
    version: '0.4.0',
    dbName: 'MultiPlatformJobDB',
    dbVersion: 1,
    configKey: '__multi_platform_job_config__',
    runKey: '__multi_platform_job_run_state__',
    debugEnabledKey: '__multi_platform_job_debug_enabled__',
    debugEventsKey: '__multi_platform_job_debug_events__',
    maxDebugEvents: 300,
    startJobsKey: '__multi_platform_job_start_jobs__',
    // 已投递公司去重名单（独立于 jobRecords 持久化，清理记录不会清除）。
    appliedCompanyKey: '__multi_platform_job_applied_companies__',
    // 手动点过「清空名单」的标记；置位后不再从历史记录自动补播种（与"不可恢复"语义一致）。
    appliedCompanyClearedKey: '__multi_platform_job_applied_companies_cleared__',
    // 评分与模型语义评分（可选直连 OpenAI 兼容 API）。
    defaultScorePositive: 'Java,Java开发,Java后端,后端,Spring,SpringBoot,Spring Boot,SpringCloud,Spring Cloud,MyBatis,MySQL,Redis,消息队列,RabbitMQ,Kafka,分布式,微服务,高并发,多线程,JVM,Docker,Linux',
    defaultScoreNegative: '风电,光伏,新能源,共享充电宝,新媒体,短视频,直播,销售,客服,兼职',
    // 保持向后兼容的 BOSS API 模式（已在 BossAdapter 中定义）
    jobListApiPattern: /\/wapi\/zpgeek\/(?:search\/joblist|pc\/(?:recommend|search)\/job\/list)\.json/i,
    jobDetailApiPattern: /\/wapi\/zpgeek\/job\/detail\.json/i,
    fastReplyUrl: '/wapi/zpchat/fastReply/userFastReplyList/get',
    sheetJsUrl: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    defaultGreetingText: '您好，我对这个岗位比较感兴趣，希望可以进一步沟通，谢谢。',
    storageQuotaWarnRatio: 0.9,
  };

  // ============================================================================
  // 平台适配器架构
  // ============================================================================

  // 平台适配器抽象基类
  class PlatformAdapter {
    // 平台标识（子类必须实现）
    get id() { throw new Error('Not implemented'); }
    get name() { throw new Error('Not implemented'); }
    get domain() { throw new Error('Not implemented'); }
    get matchPatterns() { return []; }

    // 页面检测（子类必须实现）
    isJobListPage(url) { return false; }
    isChatPage(url) { return false; }
    isAllowedDisplayPage(url) { return false; }

    // DOM 选择器（子类必须实现）
    get selectors() {
      return {
        jobCard: '',
        jobCardContainer: '',
        chatInput: '',
        chatList: '',
        chatItem: '',
        applyBtn: '',
        chatBtn: '',
      };
    }

    // API 模式（子类必须实现）
    get apiPatterns() {
      return {
        jobList: null,
        jobDetail: null,
      };
    }

    // 数据归一化（子类必须实现）
    normalizeJobFromApi(rawData) { return null; }
    normalizeJobFromDom(cardElement) { return null; }

    // 交互操作（子类必须实现）
    async clickJobCard(card) { return false; }
    async sendMessage(text) { return false; }
    async goToNextPage() { return false; }
    async goToPreviousPage() { return false; }
    async handleDialog() { return null; }

    // 聊天页操作（子类可选实现）
    collectChatList() { return []; }
    parseChatTime(timeText) { return null; }

    // 初始化钩子（子类可选实现）
    async onInit() {}
    async onReady() {}
  }

  // BOSS 直聘适配器
  class BossAdapter extends PlatformAdapter {
    get id() { return 'boss'; }
    get name() { return 'BOSS直聘'; }
    get domain() { return 'www.zhipin.com'; }
    get matchPatterns() {
      return [
        'https://www.zhipin.com/',
        'https://www.zhipin.com/web/geek/jobs*',
        'https://www.zhipin.com/web/geek/chat*',
      ];
    }

    isJobListPage(url) {
      try {
        const u = new URL(url);
        return u.origin === 'https://www.zhipin.com' && /^\/web\/geek\/jobs(?:\/|$)/.test(u.pathname);
      } catch { return false; }
    }

    isChatPage(url) {
      try {
        const u = new URL(url);
        return u.origin === 'https://www.zhipin.com' && /^\/web\/geek\/chat(?:\/|$)/.test(u.pathname);
      } catch { return false; }
    }

    isAllowedDisplayPage(url) {
      try {
        const u = new URL(url || location.href, location.href);
        if (u.origin !== 'https://www.zhipin.com') return false;
        const pathname = u.pathname.replace(/\/+$/, '');
        if (pathname === '/' || pathname === '/web/geek/chat') return true;
        return this.isJobListPage(u.href);
      } catch { return false; }
    }

    get selectors() {
      return {
        jobCard: 'li.job-card-box',
        jobCardContainer: '.job-list-box',
        chatInput: '#chat-input',
        chatList: '.chat-list',
        chatItem: '.friend-content',
        applyBtn: '.btn-startchat',
        chatBtn: '.btn-startchat',
      };
    }

    get apiPatterns() {
      return {
        jobList: /\/wapi\/zpgeek\/(?:search\/joblist|pc\/(?:recommend|search)\/job\/list)\.json/i,
        jobDetail: /\/wapi\/zpgeek\/job\/detail\.json/i,
        fastReply: '/wapi/zpchat/fastReply/userFastReplyList/get',
      };
    }

    normalizeJobFromApi(rawData) {
      return {
        key: rawData.encryptJobId || rawData.jobNo,
        jobName: rawData.jobName,
        company: rawData.brandName,
        salary: rawData.salaryDesc,
        city: rawData.cityName,
        district: rawData.areaDistrict,
        experience: rawData.jobExperience,
        education: rawData.jobDegree,
        skills: rawData.skills || [],
        describe: rawData.postDescription,
        jobType: rawData.jobType,
        industryField: rawData.brandIndustry,
        scale: rawData.brandScaleName,
        bossStatus: rawData.bossOnlineStatus,
        bossActive: rawData.bossActiveStatus,
        encryptJobId: rawData.encryptJobId,
        securityId: rawData.securityId,
        lid: rawData.lid,
      };
    }

    normalizeJobFromDom(card) {
      return {
        jobName: card.querySelector('.job-name')?.textContent?.trim() || '',
        company: card.querySelector('.company-name a')?.textContent?.trim() || '',
        salary: card.querySelector('.salary')?.textContent?.trim() || '',
        city: card.querySelector('.job-area')?.textContent?.trim() || '',
      };
    }

    async clickJobCard(card) {
      const anchor = card.querySelector('a[ka="search_list_item"]');
      if (anchor) {
        anchor.click();
        return true;
      }
      return false;
    }

    async sendMessage(text) {
      const chatInput = document.querySelector(this.selectors.chatInput);
      if (!chatInput) return false;

      chatInput.focus();
      chatInput.innerHTML = '';
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 300));

      const sendBtn = document.querySelector('.chat-toolbar button[type="submit"]');
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      return false;
    }

    async goToNextPage() {
      // BOSS 使用滚动加载，不需要翻页
      return false;
    }

    async goToPreviousPage() {
      return false;
    }
  }

  // 智联招聘现在有多个入口域名：主站 / 新版职位页 / 老版搜索与职位域名。
  const ZHILIAN_ORIGINS = [
    'https://www.zhaopin.com',
    'https://sou.zhaopin.com',
    'https://jobs.zhaopin.com',
  ];

  // 智联招聘适配器
  class ZhilianAdapter extends PlatformAdapter {
    get id() { return 'zhilian'; }
    get name() { return '智联招聘'; }
    get domain() { return 'www.zhaopin.com'; }
    get matchPatterns() {
      return [
        'https://www.zhaopin.com/',
        'https://www.zhaopin.com/sou/*',
        'https://www.zhaopin.com/jobdetail/*',
        'https://www.zhaopin.com/chat/*',
        // 新版职位推荐页 /jobs/?pageMode=recommend，以及老版 /job/xxx 路由。
        'https://www.zhaopin.com/jobs*',
        'https://www.zhaopin.com/job*',
        'https://sou.zhaopin.com/*',
        'https://jobs.zhaopin.com/*',
      ];
    }

    isJobListPage(url) {
      try {
        const u = new URL(url);
        if (!ZHILIAN_ORIGINS.includes(u.origin)) return false;
        // 老版职位域名本身就是职位列表/详情混合页，按列表页处理。
        if (u.origin === 'https://jobs.zhaopin.com') return true;
        return /^\/sou(?:\/|$)/.test(u.pathname) || /^\/jobs(?:\/|$)/.test(u.pathname);
      } catch { return false; }
    }

    isChatPage(url) {
      return false; // 智联招聘无直接聊天功能
    }

    isAllowedDisplayPage(url) {
      try {
        const u = new URL(url || location.href, location.href);
        if (!ZHILIAN_ORIGINS.includes(u.origin)) return false;
        const pathname = u.pathname.replace(/\/+$/, '');
        if (pathname === '/' || pathname === '') return true;
        if (this.isJobListPage(u.href)) return true;
        if (u.origin === 'https://jobs.zhaopin.com') return true;
        return /^\/jobdetail(?:\/|$)/.test(pathname) ||
          /^\/job\/\d/.test(pathname) ||
          /\.html?$/.test(pathname);
      } catch { return false; }
    }

    get selectors() {
      return {
        // 老版 /sou/ 用 .joblist-box__item，新版 /jobs/ 用 .job-list-panel .job-card。
        jobCard: '.joblist-box__item, .job-list-panel .job-card',
        jobCardContainer: '.joblist-box, .job-list-panel',
        chatInput: '',
        chatList: '',
        chatItem: '',
        applyBtn: '.job-detail-summary__apply, .collect-and-apply__btn, .joblist-box__item__jobbtn',
        chatBtn: '.job-detail-summary__prechat, .c-chat-job, .job-detail-chat__btn',
      };
    }

    get apiPatterns() {
      return {
        // 新版列表/详情接口 /c/i/search/positions、/c/i/jobs/position-detailv3；保留老版 /api/sou/search。
        jobList: /\/c\/i\/search\/positions|\/api\/sou\/search/i,
        jobDetail: /\/c\/i\/jobs\/position-detailv3|\/api\/job\/detail/i,
      };
    }

    normalizeJobFromApi(rawData) {
      return {
        key: rawData.number || rawData.jobId,
        jobName: rawData.name || rawData.jobName,
        company: rawData.companyName || rawData.company?.name || rawData.companyName,
        salary: rawData.salary60 || rawData.salary,
        city: rawData.workCity || rawData.city?.display || rawData.cityDisplay,
        district: rawData.cityDistrict || '',
        experience: rawData.workingExp || rawData.workExperience?.display || rawData.experienceDisplay,
        education: rawData.education || rawData.education?.display || rawData.educationDisplay,
        skills: (rawData.skillLabel || rawData.labels || []).map(l => l.value || l.name).filter(Boolean),
        describe: rawData.jobDesc || rawData.description,
        jobType: rawData.jobType?.display || '',
        industryField: rawData.company?.industryType?.display || '',
        scale: rawData.companySize || rawData.company?.size?.display || '',
        companyType: rawData.company?.type?.display || '',
        jobNumber: rawData.number,
        publishTime: rawData.updateDate,
      };
    }

    normalizeJobFromDom(card) {
      const readCard = (selectors) => {
        for (const selector of selectors) {
          const element = card.querySelector(selector);
          const text = normalizeText(element && (element.innerText || element.textContent));
          if (text) return text;
        }
        return '';
      };
      // 老版卡片字段在 .jobinfo__*，新版卡片字段在 .job-card__*。
      const locationEl = card.querySelector('.jobinfo__other-info-item, .job-card__location');
      const locationText = normalizeText(locationEl && (locationEl.innerText || locationEl.textContent));
      return {
        jobName: readCard(['.jobinfo__name', '.job-card__name', '.job-name']),
        company: readCard(['.companyinfo__name', '.job-card__company-name', '.company-name']),
        salary: readCard(['.jobinfo__salary', '.job-card__salary', '.job-salary']),
        city: locationText,
        experience: readCard(['.job-card__experience']),
        education: '',
      };
    }

    async clickJobCard(card) {
      const link = card.querySelector('a[href*="jobdetail"]') ||
                   card.querySelector('.job-name a') ||
                   card;
      if (link) {
        link.click();
        return true;
      }
      return false;
    }

    async clickApplyButton() {
      const selectors = this.selectors.applyBtn.split(',').map((item) => item.trim()).filter(Boolean);
      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn && isVisible(btn) && /投递/.test(normalizeText(btn.innerText || btn.textContent || ''))) {
          clickElement(btn);
          return true;
        }
      }
      return false;
    }

    async sendMessage(text) {
      // 智联招聘主要通过投递简历沟通
      return this.clickApplyButton();
    }

    async goToNextPage() {
      const nextBtn = document.querySelector('.pages li.next a') ||
                      document.querySelector('[aria-label="下一页"]');
      if (nextBtn) {
        nextBtn.click();
        return true;
      }
      return false;
    }

    async goToPreviousPage() {
      const prevBtn = document.querySelector('.pages li.prev a') ||
                      document.querySelector('[aria-label="上一页"]');
      if (prevBtn) {
        prevBtn.click();
        return true;
      }
      return false;
    }
  }

  // 平台注册中心
  class PlatformRegistry {
    constructor() {
      this.adapters = new Map();
      this.currentAdapter = null;
    }

    register(adapter) {
      this.adapters.set(adapter.id, adapter);
    }

    detect(url) {
      for (const [id, adapter] of this.adapters) {
        if (adapter.matchPatterns.some(p => this.matchPattern(p, url))) {
          return adapter;
        }
      }
      return null;
    }

    matchPattern(pattern, url) {
      if (pattern instanceof RegExp) {
        return pattern.test(url);
      }
      const regexStr = '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      return new RegExp(regexStr).test(url);
    }

    setCurrent(adapter) {
      this.currentAdapter = adapter;
    }

    getCurrent() {
      return this.currentAdapter;
    }

    getAll() {
      return Array.from(this.adapters.values());
    }
  }

  // 创建全局平台注册中心
  const platformRegistry = new PlatformRegistry();
  platformRegistry.register(new BossAdapter());
  platformRegistry.register(new ZhilianAdapter());

  // 当前平台适配器（运行时设置）
  let currentPlatform = null;

  // unsafeWindow 是篡改猴注入到页面真实环境的 window；优先用它才能拦截页面自己的 fetch/XHR/history。
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // 提前保存原始 fetch，后续主动补拉岗位详情时可绕过脚本自己的 fetch 包装。
  const nativePageFetch = typeof pageWindow.fetch === 'function'
    ? pageWindow.fetch.bind(pageWindow)
    : null;
  // BOSS 页面或防调试脚本可能改写 history，这里保留原型上的 back/go 作为返回列表的兜底能力。
  const nativeHistoryNavigation = captureNativeHistoryNavigation();
  const BOSS_ACTIVE_BUILTIN_OPTIONS = [
    '在线',
    '刚刚活跃',
    '今日活跃',
    '3日内活跃',
    '本周活跃',
    '2周内活跃',
    '5月内活跃',
    '半年前活跃',
  ];
  const BOSS_ACTIVE_BUILTIN_KEYS = new Set(BOSS_ACTIVE_BUILTIN_OPTIONS.map((item) => normalizeBossActiveText(item)));
  const FEATURE_BLOCK_DEFINITIONS = [
    { id: 'greeting', title: '打招呼配置', defaultEnabled: true, readonly: true },
    { id: 'strategy', title: '运行策略', defaultEnabled: true, readonly: true },
    { id: 'cityFilter', title: '城市筛选', defaultEnabled: true },
    { id: 'salaryFilter', title: '薪资筛选', defaultEnabled: true },
    { id: 'companyFilter', title: '公司筛选', defaultEnabled: true },
    { id: 'companyBlacklist', title: '公司黑名单', defaultEnabled: true },
    { id: 'appliedCompany', title: '已投递公司去重', defaultEnabled: true },
    { id: 'bossActive', title: 'Boss活跃度筛选', defaultEnabled: true },
    { id: 'export', title: '数据导出', defaultEnabled: true },
    { id: 'cleanup', title: '数据清理', defaultEnabled: true },
    { id: 'greetedList', title: '已沟通列表', defaultEnabled: true },
    { id: 'score', title: '评分筛选', defaultEnabled: true },
    { id: 'model', title: '模型配置', defaultEnabled: false },
  ];
  const FEATURE_BLOCK_ID_SET = new Set(FEATURE_BLOCK_DEFINITIONS.map((item) => item.id));

  // 用户可在侧栏面板中修改的配置；保存到 localStorage 后会在下次打开页面时恢复。
  const DEFAULT_CONFIG = {
    // 面板和问候语来源。
    panelOpen: true,
    featurePanelOpen: false,
    featureBlocks: createDefaultFeatureBlocks(),
    greetingMode: 'fastReply',
    useCustomGreeting: false,
    // BOSS 主动投递简历：沟通前先尝试点击详情页“投简历”按钮（不含沟通侧）。
    bossAutoApply: false,
    fastReplyIndex: 0,
    fastReplies: [],
    textSource: 'text',
    customText: APP.defaultGreetingText,
    // 自定义接口配置：可从外部接口生成问候语，支持参数/请求头/请求体模板。
    customApiUrl: '',
    customApiMethod: 'GET',
    customApiParams: '',
    customApiHeaders: '',
    customApiBody: '',
    customApiResponsePath: '',
    // 自动化策略：采集记录、返回列表后是否允许刷新、等待/重试/数量上限。
    // 跨批次跳过已沟通岗位：读取本地历史沟通记录（ContactedIndex），命中即跳过，避免换批次后重复沟通。
    skipContacted: true,
    collectGreetedJobs: true,
    ignoreListRefresh: true,
    // 当前列表扫完后是否整页刷新续跑；刷新次数上限 0 表示不限制。
    autoRefreshOnExhausted: true,
    maxListRefresh: 5,
    delayMin: 4,
    delayMax: 8,
    allowedCities: '', // 留空=不限制城市（平台搜索条件已做初步筛选）；命中列表中任一城市才投递。
    // 薪资筛选：按岗位薪资区间与所填月薪区间取交集，不重叠才跳过；薪资不明时保留。
    salaryFilterEnabled: false,
    salaryMinK: 0,
    salaryMaxK: 0,
    // 匹配方式：contain=岗位区间需完全落在设定范围内；overlap=有重叠即保留。
    salaryMatchMode: 'contain',
    waitTimeout: 5,
    chatOpenRetries: 2,
    maxCount: 0,
    // 公司过滤和数据维护选项。
    companyFilterMode: 'partial',
    companyFilterValue: '',
    companyBlacklistMode: 'partial',
    companyBlacklistValue: '',
    companyBlacklistRules: [],
    skipAppliedCompany: false, // 跳过历史已投递过简历的公司（跨批次去重）。
    // BOSS 沟通成功即计入已投递公司名单：BOSS 默认不投简历，需 HR 回复后才能发简历，
    // 因此"打招呼送达"就是一次有效投递。智联的纯打招呼记录仍不计入（智联可直接投简历）。
    bossGreetingCountsAsApplied: true,
    bossActiveFilterValues: [],
    bossActiveCustomOptions: [],
    exportType: 'json',
    clearBeforeTime: '',
    // 评分筛选：关键词正面/负面打分，可选模型语义评分；高亮卡片并可按分跳过沟通。
    scoreEnabled: true,
    scoreHighlight: true,
    scoreAutoSkipLow: false,
    scorePositive: 'Java,Java开发,Java后端,后端,后端开发,Spring,SpringBoot,Spring Boot,SpringCloud,Spring Cloud,SpringMVC,Spring MVC,MyBatis,MyBatis-Plus,MySQL,MySQL索引,索引优化,事务,Redis,消息队列,RabbitMQ,RocketMQ,Kafka,分布式,微服务,高并发,多线程,JUC,并发,接口开发,Restful,RESTful,接口,大表分表,分库分表,JVM,多线程,Git,Maven,Docker,Linux,线上故障排查,性能优化,故障排查',
    scoreNegative: '销售,客服,电话销售,主播,直播,兼职,地推,普工,操作工,手游,页游,游戏代练,销售工程师',
    scorePositiveWeight: 8,
    scoreNegativeWeight: 40,
    // 核心词必中：岗位全文至少命中其中一个才算匹配；为空表示不启用。防止方向相近但非目标的岗位误投。
    coreTerms: '',
    // 负面词在岗位名命中时额外扣分（岗位名含"销售/客服"几乎可断定岗位类型），默认0=不额外扣。
    scoreNegativeTitleBonus: 0,
    // 岗位名直接含负面词时硬否决：不看分数、不给 good/mid 洗白的机会。
    scoreTitleNegativeReject: true,
    scoreTitleBonus: 12,
    scoreSkillBonus: 6,
    scoreGoodThreshold: 35,
    scoreMidThreshold: 15,
    // 模型配置：OpenAI 兼容 API 直连（GM_xmlhttpRequest），密钥仅存 localStorage。
    modelEnabled: false,
    modelScoreEnabled: false,
    modelBaseUrl: '',
    modelApiKey: '',
    modelName: '',
  };
  const CONFIG_FIELD_KEYS = Object.keys(DEFAULT_CONFIG);
  const CONFIG_FIELD_KEY_SET = new Set(CONFIG_FIELD_KEYS);
  const STRUCTURED_CONFIG_FIELD_KEYS = new Set(['customApiParams', 'customApiHeaders']);

  // 页面级运行时缓存，只在当前页面生命周期内有效；跨页面恢复依赖 RunState(localStorage)。
  const runtime = {
    // 岗位数据池和索引：由接口/详情页/DOM 多路数据共同填充。
    jobPool: [],
    jobByKey: new Map(),
    jobBySignature: new Map(),
    jobByLooseSignature: new Map(),
    jobDetailByKey: new Map(),
    latestJobDetail: null,
    cardJobMap: new WeakMap(),
    seenApiBatches: new Set(),
    jobListContextKey: '',
    jobListLastBatchKey: '',
    jobListUpdatedAt: 0,
    jobListResponseSerial: 0,
    jobListFirstPageSerial: 0,
    latestJobListResponse: null,
    latestFirstPageJobListResponse: null,
    latestJobListRequest: null,
    // 主动补拉列表接口被平台拒绝后的冷却时间，避免每轮重试产生 405 日志。
    jobListActiveFetchRetryAfter: 0,
    // Resource Timing 兜底状态：记录真正完成的列表请求，解决 BOSS 缓存原生 fetch/XHR 后拦截器失效的问题。
    latestJobListResource: null,
    jobListResourceSerial: 0,
    jobListResourceObserver: null,
    initialPageUrl: location.href,
    latestRouteUrl: location.href,
    lastBossDialogDismissAt: 0,
    debugEvents: [],
    // 已沟通 Set 是 IndexedDB 的内存投影，用于列表循环中快速判重。
    contactedJobKeys: new Set(),
    contactedIndexReady: false,
    // 已投递公司名 Set：IndexedDB 里 resumeApplied 记录的投简历去重索引。
    appliedCompanySet: new Set(),
    appliedCompanyReady: false,
    // 自动化运行锁和停止标记，避免重复启动多个并发循环。
    automationLoopActive: false,
    resumeInProgress: false,
    stopRequested: false,
    // 实时日志采集宽限期：投递停止后短暂保留，补录暂停/报错等收尾事件。
    logGraceUntil: 0,
    statusLock: null,
    companyFilterEdited: false,
    configFormTouched: false,
    // 外部库、UI 和数据库连接缓存。
    xlsx: null,
    ui: null,
    db: null,
  };

  let config = loadConfig();

  cleanupLegacyDebugState();
  runtime.debugEvents = isDebugEnabled() ? loadStoredDebugEvents() : [];
  installDebugHelpers();
  rememberRouteUrl(location.href);
  // document-start 先拦截岗位相关接口，避免页面很早请求岗位列表时脚本拿不到接口数据。
  installNetworkInterceptors();

  // 在允许的页面挂载面板，并在刷新/跳转后尝试恢复未完成的自动化流程。
  function bootWhenReady() {
    // 检测当前平台
    if (!currentPlatform) {
      currentPlatform = platformRegistry.detect(location.href);
      if (currentPlatform) {
        console.log(`[MultiPlatform] 检测到平台: ${currentPlatform.name}`);
      }
    }

    if (runtime.ui) {
      setUiDisplayEnabled(isAllowedDisplayPage());
      return;
    }
    if (!isAllowedDisplayPage()) return;

    const mount = () => {
      if (runtime.ui || !document.body || !isAllowedDisplayPage()) return;
      // 本轮去重只跨越投递产生的页面导航；真实刷新/重载后立即失效。
      if (isDocumentReload()) {
        RunState.clear();
      }
      Database.open().catch((error) => console.warn('[ZhipinAuto] IndexedDB 初始化失败', error));
      UI.mount();
      setUiDisplayEnabled(true);
      if (isJobListUrl(location.href) || isChatPage()) Automation.resumeIfNeeded('boot');
      if (isJobListUrl(location.href) && localStorage.getItem(APP.startJobsKey) === '1') {
        localStorage.removeItem(APP.startJobsKey);
        setTimeout(() => Automation.start(), 500);
      }
    };

    if (document.body) {
      mount();
      return;
    }

    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  function isDocumentReload() {
    try {
      const entry = performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      return Boolean(entry && entry.type === 'reload');
    } catch (_) {
      return false;
    }
  }

  // 从 localStorage 恢复侧栏配置；解析失败时回退默认值，避免坏配置阻断脚本启动。
  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(APP.configKey) || '{}');
      return repairLoadedConfig(normalizeConfig(stored));
    } catch (_) {
      return normalizeConfig(DEFAULT_CONFIG);
    }
  }

  // 保存表单配置。这里会和当前配置合并，因此新增字段不需要迁移旧配置。
  function saveConfig(nextConfig) {
    config = normalizeConfig(Object.assign({}, config, nextConfig || {}));
    localStorage.setItem(APP.configKey, JSON.stringify(config));
  }

  // 归一化新增数组配置，兼容旧版本 localStorage 和手动编辑过的异常值。
  function normalizeConfig(source) {
    const raw = source || {};
    const next = {};
    CONFIG_FIELD_KEYS.forEach((key) => {
      next[key] = raw[key] === undefined ? DEFAULT_CONFIG[key] : raw[key];
    });
    next.companyFilterMode = getCompanyMatchMode(next.companyFilterMode);
    next.companyBlacklistMode = getCompanyMatchMode(next.companyBlacklistMode);
    next.companyBlacklistValue = normalizeText(next.companyBlacklistValue);
    next.companyBlacklistRules = normalizeCompanyBlacklistRules(next.companyBlacklistRules);
    next.bossActiveCustomOptions = normalizeBossActiveOptions(next.bossActiveCustomOptions)
      .filter((item) => !BOSS_ACTIVE_BUILTIN_KEYS.has(normalizeBossActiveText(item)));

    const availableKeys = new Set(getBossActiveFilterOptions(next.bossActiveCustomOptions)
      .map((item) => normalizeBossActiveText(item)));
    next.bossActiveFilterValues = normalizeBossActiveOptions(next.bossActiveFilterValues)
      .filter((item) => availableKeys.has(normalizeBossActiveText(item)));
    next.featurePanelOpen = Boolean(next.featurePanelOpen);
    next.featureBlocks = normalizeFeatureBlocks(next.featureBlocks);

    return next;
  }

  // 板块管理显示状态集中归一；只读板块始终开启，避免核心流程被隐藏到无法启动。
  function normalizeFeatureBlocks(source) {
    const raw = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return FEATURE_BLOCK_DEFINITIONS.reduce((output, item) => {
      const defaultEnabled = item.readonly ? true : item.defaultEnabled !== false;
      output[item.id] = item.readonly
        ? true
        : raw[item.id] === undefined
          ? defaultEnabled
          : Boolean(raw[item.id]);
      return output;
    }, {});
  }

  // 默认值需要返回新对象，避免后续合并配置时共享同一份引用。
  function createDefaultFeatureBlocks() {
    return FEATURE_BLOCK_DEFINITIONS.reduce((output, item) => {
      output[item.id] = item.defaultEnabled !== false;
      return output;
    }, {});
  }

  // 公司匹配模式统一归一，避免旧配置或手动编辑的异常值影响过滤。
  function getCompanyMatchMode(mode) {
    return /^(?:exact|partial|regex)$/.test(String(mode || '')) ? String(mode) : 'partial';
  }

  // 黑名单列表中展示给用户看的匹配模式标签。
  function getCompanyMatchModeLabel(mode) {
    if (mode === 'exact') return '全量';
    if (mode === 'regex') return '正则';
    return '部分';
  }

  // 公司黑名单规则支持数组对象，也兼容用户手动写入的换行/逗号文本。
  function normalizeCompanyBlacklistRules(values) {
    const list = Array.isArray(values)
      ? values
      : String(values || '').split(/[\n,，]+/).map((value) => ({ mode: 'partial', value }));
    const seen = new Set();
    const output = [];

    list.forEach((item) => {
      const isObjectItem = item && typeof item === 'object';
      const mode = getCompanyMatchMode(isObjectItem ? item.mode : 'partial');
      const value = normalizeText(isObjectItem ? item.value : item);
      if (!value) return;

      const key = `${mode}:${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push({
        id: normalizeText(isObjectItem && item.id) || `black_${hashString(key)}`,
        mode,
        value,
      });
    });

    return output;
  }

  // 加载旧配置时清掉明显由浏览器自动填充/历史恢复写入的残留值。
  function repairLoadedConfig(source) {
    const next = Object.assign({}, source || {});
    STRUCTURED_CONFIG_FIELD_KEYS.forEach((key) => {
      if (!next[key] || isParsableKeyValueConfig(next[key])) return;
      next[key] = '';
    });
    if (next.customApiResponsePath && !isLikelyResponsePath(next.customApiResponsePath)) {
      next.customApiResponsePath = '';
    }
    return next;
  }

  // Boss 活跃度选项用清洗后的文本作为持久化值，避免 DOM 残留符号影响匹配。
  function normalizeBossActiveOptions(values) {
    const list = Array.isArray(values)
      ? values
      : String(values || '').split(/[\n,，、]+/);
    const seen = new Set();
    const output = [];

    list.forEach((item) => {
      const text = getBossActiveOptionLabel(item);
      const key = normalizeBossActiveText(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      output.push(text);
    });

    return output;
  }

  // 合并内置和自定义 Boss 活跃度选项，供下拉多选渲染使用。
  function getBossActiveFilterOptions(customOptions) {
    return BOSS_ACTIVE_BUILTIN_OPTIONS.concat(normalizeBossActiveOptions(customOptions || []));
  }

  // 将用户输入或 DOM 文本归一到展示标签；内置项保持原有中文文案。
  function getBossActiveOptionLabel(value) {
    const key = normalizeBossActiveText(value);
    if (!key) return '';
    return BOSS_ACTIVE_BUILTIN_OPTIONS.find((item) => normalizeBossActiveText(item) === key) || key;
  }

  // 当前配置中已选 Boss 活跃度的匹配 key，用于过滤岗位。
  function getSelectedBossActiveKeys() {
    return normalizeBossActiveOptions(config.bossActiveFilterValues)
      .map((item) => normalizeBossActiveText(item))
      .filter(Boolean);
  }

  // 判断用户是否启用了 Boss 活跃度过滤。
  function hasBossActiveFilter() {
    return getSelectedBossActiveKeys().length > 0;
  }

  // Tampermonkey 的 @match 负责第一层路由限制；这里再处理单页应用 history 跳转后的显示/隐藏。
  // 使用平台适配器进行页面检测
  function isAllowedDisplayPage(href) {
    // 如果已检测到平台，使用适配器检测
    if (currentPlatform) {
      return currentPlatform.isAllowedDisplayPage(href);
    }
    // 未检测到平台时，尝试所有已注册的适配器
    const detected = platformRegistry.detect(href || location.href);
    if (detected) {
      currentPlatform = detected;
      return detected.isAllowedDisplayPage(href);
    }
    return false;
  }

  // 岗位页采用前缀判断，兼容 BOSS 后续增加的 jobs 子路由、查询参数和 hash 路由。
  // 使用平台适配器进行页面检测
  function isJobListUrl(href) {
    if (currentPlatform) {
      return currentPlatform.isJobListPage(href);
    }
    const detected = platformRegistry.detect(href || location.href);
    if (detected) {
      currentPlatform = detected;
      return detected.isJobListPage(href);
    }
    return false;
  }

  // 生成岗位筛选上下文签名；分页、追踪和随机参数不会影响“是否仍是同一筛选页”的判断。
  function makeJobListFilterSignature(href) {
    try {
      const url = new URL(href || location.href, location.href);
      if (!isJobListUrl(url.href)) return '';
      const params = Array.from(url.searchParams.entries())
        .filter(([name]) => !isVolatileJobListParam(name))
        .sort(([leftName, leftValue], [rightName, rightValue]) => {
          const nameResult = leftName.localeCompare(rightName);
          return nameResult || leftValue.localeCompare(rightValue);
        })
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join('&');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      return `${url.origin}${pathname}?${params}${url.hash || ''}`;
    } catch (_) {
      return '';
    }
  }

  function isSameJobListFilterContext(href, expectedUrl, expectedSignature) {
    const expected = expectedSignature || makeJobListFilterSignature(expectedUrl);
    const current = makeJobListFilterSignature(href);
    return Boolean(expected && current && expected === current);
  }

  // BOSS 会在聊天页加载后清掉 URL 查询参数；document-start 和 history 阶段先保留原始路由。
  function rememberRouteUrl(href) {
    try {
      if (!href) return;
      const url = new URL(href, location.href);
      if (!isAllowedDisplayPage(url.href)) return;
      runtime.latestRouteUrl = url.href;
    } catch (_) {}
  }

  // 只控制脚本面板显隐，不销毁 UI；SPA 路由切回来时可复用已有节点和状态。
  function setUiDisplayEnabled(enabled) {
    if (!runtime.ui || !runtime.ui.root) return;
    runtime.ui.root.style.display = enabled ? '' : 'none';
  }

  // 路由变化后的统一入口：允许页面挂载/恢复，不允许页面隐藏面板。
  function syncAllowedPageUi() {
    const allowed = isAllowedDisplayPage();
    setUiDisplayEnabled(allowed);
    if (allowed) bootWhenReady();
    return allowed;
  }

  // BOSS 页面是 SPA，岗位列表和聊天页切换时不一定重新加载脚本，所以要监听 history 路由变化。
  function installAllowedPageRouteWatcher() {
    const history = pageWindow.history;
    if (history && !history.__zhipinAutoGreetingRouteWatcherPatched) {
      ['pushState', 'replaceState'].forEach((method) => {
        const raw = history[method];
        if (typeof raw !== 'function') return;

        const wrapped = function routeAwareHistoryMethod() {
          rememberRouteUrl(arguments[2]);
          const result = raw.apply(this, arguments);
          setTimeout(syncAllowedPageUi, 0);
          return result;
        };

        maskNative(wrapped, raw);
        history[method] = wrapped;
      });

      try {
        Object.defineProperty(history, '__zhipinAutoGreetingRouteWatcherPatched', {
          configurable: true,
          value: true,
        });
      } catch (_) {
        history.__zhipinAutoGreetingRouteWatcherPatched = true;
      }
    }

    pageWindow.addEventListener('popstate', () => setTimeout(syncAllowedPageUi, 0));
    pageWindow.addEventListener('hashchange', () => setTimeout(syncAllowedPageUi, 0));
  }

  // 当前搜索词会作为公司过滤输入框的默认值，但用户手动编辑后不再自动覆盖。
  function getCurrentSearchQuery() {
    try {
      return normalizeText(new URL(location.href).searchParams.get('query'));
    } catch (_) {
      return '';
    }
  }

  // 运行中锁定大部分配置，导出格式/清理时间不参与自动化流程，允许继续修改。
  function isRuntimeLockExemptField(fieldName) {
    return /^(?:exportType|clearBeforeTime)$/.test(String(fieldName || ''));
  }

  // 清理早期版本遗留的 debug key，避免旧数据影响当前诊断状态。
  function cleanupLegacyDebugState() {
    localStorage.removeItem('__zhipin_auto_greeting_debug__');
  }

  // 调试事件需要跨 SPA 跳转和聊天页跳转保留，否则第一条新日志会覆盖上一页的诊断上下文。
  function loadStoredDebugEvents() {
    try {
      const events = JSON.parse(localStorage.getItem(APP.debugEventsKey) || '[]');
      return Array.isArray(events) ? events.slice(-APP.maxDebugEvents) : [];
    } catch (_) {
      return [];
    }
  }

  // 默认关闭结构化诊断日志；排查偶发问题时可通过 helper 或 localStorage 开启。
  function isDebugEnabled() {
    try {
      return localStorage.getItem(APP.debugEnabledKey) === '1' ||
        pageWindow.__ZHIPIN_AUTO_GREETING_DEBUG__ === true;
    } catch (_) {
      return false;
    }
  }

  // 暴露调试工具，排查时可在 DevTools 控制台开启、导出或清理结构化日志。
  function installDebugHelpers() {
    try {
      pageWindow.__zhipinAutoGreetingDebug = {
        version: APP.version,
        enabledKey: APP.debugEnabledKey,
        key: APP.debugEventsKey,
        enabled() {
          return isDebugEnabled();
        },
        enable() {
          localStorage.setItem(APP.debugEnabledKey, '1');
          runtime.debugEvents = loadStoredDebugEvents();
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        disable() {
          localStorage.removeItem(APP.debugEnabledKey);
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        dump() {
          return loadStoredDebugEvents();
        },
        text() {
          return JSON.stringify(loadStoredDebugEvents(), null, 2);
        },
        clear() {
          runtime.debugEvents = [];
          localStorage.removeItem(APP.debugEventsKey);
          if (runtime.ui) UI.renderDebugLogControls();
          return true;
        },
        copy() {
          const text = JSON.stringify(loadStoredDebugEvents(), null, 2);
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(() => text.length);
          }
          console.log(text);
          return text.length;
        },
      };
    } catch (_) {}
  }

  // 跨页面自动化状态：记录当前阶段、已处理岗位标识、待发送岗位、固定列表地址和下一次运行时间。
  const RunState = {
    // 内存缓存，避免反复 JSON.parse localStorage；save/patch/clear 时自动失效。
    _cached: undefined,
    _cacheKey: undefined,
    // 从 localStorage 读取运行状态，异常 JSON 直接视为空状态。
    load() {
      const raw = localStorage.getItem(APP.runKey);
      if (raw === this._cacheKey && this._cached !== undefined) return this._cached;
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        this._cached = parsed;
        this._cacheKey = raw;
        return parsed;
      } catch (_) {
        this._cached = null;
        this._cacheKey = raw;
        return null;
      }
    },
    // 持久化完整/局部运行状态，并自动合并最近更新时间。
    save(nextState) {
      const previous = this.load() || {};
      const merged = Object.assign({}, previous, nextState, { updatedAt: Date.now() });
      const serialized = JSON.stringify(merged);
      localStorage.setItem(APP.runKey, serialized);
      // 直接写入缓存，避免下次 load 重复解析
      this._cached = merged;
      this._cacheKey = serialized;
      return merged;
    },
    // 语义化别名：在流程中只更新少量字段时调用。
    patch(nextState) {
      return this.save(nextState);
    },
    // 停止自动化并保留停止原因，便于刷新后不再恢复。
    stop(reason) {
      const state = this.save({
        active: false,
        phase: 'stopped',
        pendingJob: null,
        pendingRawJob: null,
        nextRunAt: null,
        nextDelaySeconds: null,
        stopReason: reason || '已停止',
      });
      return state;
    },
    // 暂停自动化但保留现场，给用户确认后可以重新启动。
    pause(reason) {
      const state = this.save({
        active: false,
        phase: 'paused',
        nextRunAt: null,
        nextDelaySeconds: null,
        pauseReason: reason || '已暂停',
      });
      return state;
    },
    // 清掉跨页面状态，通常用于用户手动结束或重新开始前。
    clear() {
      localStorage.removeItem(APP.runKey);
      this._cached = null;
      this._cacheKey = undefined;
    },
  };

  // debugEvents 批量写入：累积事件后通过 debounce 合并写 localStorage，避免高频事件频繁序列化。
  let _debugFlushTimer = null;
  const DEBUG_FLUSH_DELAY_MS = 500;

  function flushDebugEvents() {
    _debugFlushTimer = null;
    try {
      localStorage.setItem(APP.debugEventsKey, JSON.stringify(runtime.debugEvents));
      if (runtime.ui) UI.renderDebugLogControls();
    } catch (_) {}
  }

  function scheduleDebugFlush() {
    if (_debugFlushTimer) return;
    _debugFlushTimer = setTimeout(flushDebugEvents, DEBUG_FLUSH_DELAY_MS);
  }

  // 统一写调试事件；默认关闭，开启后才写内存/localStorage/控制台。
  function logDebugEvent(type, data, level) {
    // 实时日志始终记录（不受「调试日志」开关限制），用于替代被反调试禁用的 DevTools。
    try {
      LogWindow.append(type, data, level);
    } catch (_) {}
    try {
      if (!isDebugEnabled()) return;

      const event = {
        time: nowIso(),
        type,
        href: location.href,
        data: safeDebugValue(data, 0),
      };

      runtime.debugEvents.push(event);
      runtime.debugEvents = runtime.debugEvents.slice(-APP.maxDebugEvents);
      // 批量写入：延迟 500ms 合并多次写入，减少 localStorage 序列化开销
      scheduleDebugFlush();

      const method = level || (/error|timeout|unknown|missing|failed/i.test(type) ? 'warn' : 'info');
      const logger = console[method] || console.log;
      logger.call(console, `[ZhipinAuto][${type}]`, event);
    } catch (_) {}
  }

  // 调试日志会存入 localStorage，因此对大对象、HTML 文本和循环嵌套做裁剪。
  function safeDebugValue(value, depth) {
    const currentDepth = Number(depth || 0);
    if (value == null) return value;
    if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}...` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (currentDepth >= 4) return '[depth-limit]';
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeDebugValue(item, currentDepth + 1));
    if (typeof value !== 'object') return String(value);

    const output = {};
    Object.keys(value).slice(0, 50).forEach((key) => {
      if (/^(rawHtmlDetail|rawCompanyDetail|postDescription|companyIntroduce|businessScope)$/i.test(key)) {
        output[key] = summarizeLongText(value[key]);
        return;
      }
      if (/^(rawJob|rawDetail)$/i.test(key)) {
        output[key] = summarizeRawJob(value[key]);
        return;
      }
      output[key] = safeDebugValue(value[key], currentDepth + 1);
    });
    return output;
  }

  // 从原始接口岗位中抽取少量字段用于日志，避免把完整响应塞进 debug 事件。
  function summarizeRawJob(rawJob) {
    if (!rawJob || typeof rawJob !== 'object') return rawJob || null;
    return {
      jobName: pickFirstString(rawJob, ['jobName', 'jobTitle', 'positionName', 'name', 'title']),
      brandName: pickFirstString(rawJob, ['brandName', 'companyName', 'encryptBrandName', 'company']),
      salaryDesc: pickReadableSalary(rawJob, ['salaryDesc', 'salary', 'salaryName']),
      bossName: pickFirstString(rawJob, ['bossName', 'bossNickName', 'boss']),
      bossTitle: pickFirstString(rawJob, ['bossTitle', 'postDescription']),
      encryptJobId: pickFirstString(rawJob, ['encryptJobId', 'encryptId', 'jobId', 'job_id']),
      securityId: pickFirstString(rawJob, ['securityId']),
      lid: pickFirstString(rawJob, ['lid']),
      cityName: pickFirstString(rawJob, ['cityName', 'city']),
    };
  }

  // 将内部岗位对象裁剪成可读摘要，主要用于定位岗位匹配和详情合并问题。
  function summarizeJobForDebug(job) {
    if (!job) return null;
    return {
      jobKey: job.jobKey,
      id: job.id,
      jobName: job.jobName,
      company: job.company,
      salary: job.salary,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      bossActiveTimeDesc: getDisplayBossActiveTime(job),
      bossOnline: Boolean(job.bossOnline),
      encryptJobId: job.encryptJobId,
      securityId: job.securityId,
      lid: job.lid,
      source: job.source,
      sourceUrl: job.sourceUrl,
      detailSource: job.detailSource,
      detailSourceUrl: job.detailSourceUrl,
      domOnly: Boolean(job.domOnly),
      rawJob: summarizeRawJob(job.rawJob),
    };
  }

  // 说明等待详情阶段是否需要主动补拉接口，避免只有 true/false 看不出原因。
  function getJobDetailFetchDecision(job, detail, options) {
    const detailSalary = getReadableSalary(detail && detail.salary);
    const jobSalary = getDisplaySalary(job);
    const forceApiFetch = Boolean(options && options.forceApiFetch);

    if (!detail) {
      return {
        shouldFetch: true,
        reason: 'missing_detail',
        forceApiFetch,
        hasRawDetail: false,
        detailSalary,
        jobSalary,
      };
    }

    if (!forceApiFetch) {
      return {
        shouldFetch: false,
        reason: 'force_api_fetch_disabled',
        forceApiFetch,
        hasRawDetail: Boolean(detail.rawDetail),
        detailSalary,
        jobSalary,
      };
    }

    if (!detail.rawDetail) {
      return {
        shouldFetch: true,
        reason: 'missing_raw_detail',
        forceApiFetch,
        hasRawDetail: false,
        detailSalary,
        jobSalary,
      };
    }

    if (!detailSalary && !jobSalary) {
      return {
        shouldFetch: true,
        reason: 'missing_salary',
        forceApiFetch,
        hasRawDetail: true,
        detailSalary,
        jobSalary,
      };
    }

    return {
      shouldFetch: false,
      reason: 'detail_sufficient',
      forceApiFetch,
      hasRawDetail: true,
      detailSalary,
      jobSalary,
    };
  }

  // DOM 卡片摘要：用于排查“接口岗位”和“页面卡片”是否匹配错位。
  function summarizeDomInfoForDebug(domInfo) {
    if (!domInfo) return null;
    return {
      jobName: domInfo.jobName,
      company: domInfo.company,
      salary: domInfo.salary,
      city: domInfo.city,
      keys: domInfo.keys,
      signature: domInfo.signature,
      looseSignature: domInfo.looseSignature,
      text: summarizeLongText(domInfo.text),
    };
  }

  // 长文本字段只保留前 300 字，防止岗位描述/公司介绍撑爆 debug 事件。
  function summarizeLongText(value) {
    const text = normalizeTextPreserveLines(value);
    if (!text) return '';
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  }

  // 聚合列表侧的核心状态，所有列表匹配异常日志都会带上这份快照。
  function getDebugListState() {
    return {
      poolSize: runtime.jobPool.length,
      contextKey: runtime.jobListContextKey,
      lastBatchKey: runtime.jobListLastBatchKey,
      responseSerial: runtime.jobListResponseSerial,
      firstPageSerial: runtime.jobListFirstPageSerial,
      latestJobListResponse: runtime.latestJobListResponse,
      latestFirstPageJobListResponse: runtime.latestFirstPageJobListResponse,
      latestJobListRequest: summarizeJobListRequest(runtime.latestJobListRequest),
      latestJobListResource: runtime.latestJobListResource,
      jobListResourceSerial: runtime.jobListResourceSerial,
      visibleCardCount: getJobCards().length,
    };
  }

  // 捕获岗位列表/详情接口响应，用接口数据补强 DOM 卡片信息，提升岗位匹配和记录质量。
  // 使用平台适配器的 API 模式进行拦截
  function installNetworkInterceptors() {
    // 检测当前平台
    if (!currentPlatform) {
      currentPlatform = platformRegistry.detect(location.href);
    }

    // ResourceObserver 独立于 fetch/XHR 包装器，必须同时安装才能覆盖页面预缓存原生方法的情况。
    installJobListResourceObserver();
    const rawFetch = pageWindow.fetch;

    if (typeof rawFetch === 'function' && !rawFetch.__zhipinAutoGreetingPatched) {
      const wrappedFetch = function fetch(input, init) {
        const url = normalizeRequestUrl(input);
        const requestMeta = createFetchRequestMeta(input, init, url);
        rememberTrackedJobRequest(url, requestMeta);
        const result = rawFetch.apply(this, arguments);

        if (isTrackedJobApi(url)) {
          Promise.resolve(result)
            .then((response) => {
              try {
                response.clone().text().then((text) => ingestTrackedJobResponse(url, text, 'fetch', requestMeta));
              } catch (error) {
                console.warn('[ZhipinAuto] fetch 岗位响应读取失败', error);
              }
            })
            .catch(() => {});
        }

        return result;
      };

      maskNative(wrappedFetch, rawFetch);
      wrappedFetch.__zhipinAutoGreetingPatched = true;
      pageWindow.fetch = wrappedFetch;
    }

    const XHR = pageWindow.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__zhipinAutoGreetingPatched) {
      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;
      const rawSetRequestHeader = XHR.prototype.setRequestHeader;

      XHR.prototype.open = function open(method, url) {
        this.__zhipinAutoGreetingUrl = normalizeRequestUrl(url);
        this.__zhipinAutoGreetingMethod = normalizeText(method || 'GET').toUpperCase() || 'GET';
        this.__zhipinAutoGreetingHeaders = {};
        return rawOpen.apply(this, arguments);
      };
      maskNative(XHR.prototype.open, rawOpen);

      if (typeof rawSetRequestHeader === 'function') {
        XHR.prototype.setRequestHeader = function setRequestHeader(name, value) {
          try {
            const key = normalizeText(name);
            if (key) {
              this.__zhipinAutoGreetingHeaders = this.__zhipinAutoGreetingHeaders || {};
              this.__zhipinAutoGreetingHeaders[key] = normalizeText(value);
            }
          } catch (_) {}
          return rawSetRequestHeader.apply(this, arguments);
        };
        maskNative(XHR.prototype.setRequestHeader, rawSetRequestHeader);
      }

      XHR.prototype.send = function send() {
        const url = this.__zhipinAutoGreetingUrl || '';
        const requestMeta = createXhrRequestMeta(this, arguments[0], url);
        rememberTrackedJobRequest(url, requestMeta);

        if (isTrackedJobApi(url)) {
          this.addEventListener('loadend', () => {
            try {
              let text = '';
              if (!this.responseType || this.responseType === 'text') {
                text = this.responseText || '';
              } else if (this.responseType === 'json') {
                text = JSON.stringify(this.response || {});
              }
              ingestTrackedJobResponse(url, text, 'xhr', requestMeta);
            } catch (error) {
              console.warn('[ZhipinAuto] XHR 岗位响应读取失败', error);
            }
          });
        }

        return rawSend.apply(this, arguments);
      };
      maskNative(XHR.prototype.send, rawSend);
      XHR.prototype.__zhipinAutoGreetingPatched = true;
    }
  }

  // 把 fetch/XMLHttpRequest 输入统一成绝对 URL，后面用正则判断是否是岗位接口。
  function normalizeRequestUrl(input) {
    try {
      if (!input) return '';
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input.url) return new URL(input.url, location.href).href;
      return String(input);
    } catch (_) {
      return String(input || '');
    }
  }

  // 把 fetch 的 Request/init 合并为可记录、可重放的统一请求元数据。
  function createFetchRequestMeta(input, init, url) {
    const request = input && typeof input === 'object' ? input : {};
    const requestInit = init || {};
    return {
      url,
      method: normalizeText(requestInit.method || request.method || 'GET').toUpperCase() || 'GET',
      headers: mergeHeadersToObject(request.headers, requestInit.headers),
      body: requestInit.body,
      source: 'fetch',
    };
  }

  // 从 XHR 实例上读取 open/setRequestHeader 阶段保存的信息，生成统一请求元数据。
  function createXhrRequestMeta(xhr, body, url) {
    return {
      url,
      method: normalizeText(xhr && xhr.__zhipinAutoGreetingMethod || 'GET').toUpperCase() || 'GET',
      headers: Object.assign({}, xhr && xhr.__zhipinAutoGreetingHeaders || {}),
      body,
      source: 'xhr',
    };
  }

  // 只保存岗位列表接口的最近发起记录；详情接口不参与求职期望列表恢复判断。
  function rememberTrackedJobRequest(url, requestMeta) {
    if (!APP.jobListApiPattern.test(url) || !requestMeta) return;
    runtime.latestJobListRequest = Object.assign({}, requestMeta, { capturedAt: Date.now() });
  }

  // BOSS 可能缓存脚本注入前的 fetch/XHR，导致包装器抓不到请求；Resource Timing 用于记录接口确已完成。
  function installJobListResourceObserver() {
    try {
      if (typeof performance !== 'undefined' && typeof performance.setResourceTimingBufferSize === 'function') {
        performance.setResourceTimingBufferSize(2000);
      }
      if (runtime.jobListResourceObserver || typeof PerformanceObserver !== 'function') return;

      const observer = new PerformanceObserver((entryList) => {
        entryList.getEntries().forEach((entry) => {
          if (!entry || !APP.jobListApiPattern.test(entry.name)) return;
          noteCompletedJobListResource(entry.name, getResourceEntryCompletedAt(entry), 'performance-observer');
        });
      });
      observer.observe({ type: 'resource', buffered: true });
      runtime.jobListResourceObserver = observer;
    } catch (error) {
      logDebugEvent('job_list_resource_observer_failed', {
        message: error && error.message || String(error),
      }, 'warn');
    }
  }

  // PerformanceEntry 使用相对 timeOrigin 的毫秒值，这里换算成可与 Date.now() 比较的绝对时间。
  function getResourceEntryCompletedAt(entry) {
    const timeOrigin = Number(performance && performance.timeOrigin || Date.now());
    const responseEnd = Number(entry && entry.responseEnd || entry && entry.startTime || 0);
    return Math.round(timeOrigin + responseEnd);
  }

  // 按完成时间更新“最后完成的列表请求”，避免较早请求的延迟观察回调覆盖较新的结果。
  function noteCompletedJobListResource(url, completedAt, source) {
    if (!APP.jobListApiPattern.test(url)) return null;
    const capturedAt = Number(completedAt || Date.now());
    const previous = runtime.latestJobListResource;
    if (previous && Number(previous.capturedAt || 0) > capturedAt) return previous;

    const record = {
      url,
      source: source || 'resource',
      capturedAt,
      pageNumber: getJobListPageNumber(url),
      contextKey: makeJobListContextKey(url),
      serial: runtime.jobListResourceSerial + 1,
    };
    runtime.jobListResourceSerial = record.serial;
    runtime.latestJobListResource = record;
    logDebugEvent('job_list_resource_completed', record);
    return record;
  }

  // 合并 Request 与 init 中可能重复的请求头，后传入者覆盖同名项。
  function mergeHeadersToObject() {
    const output = {};
    Array.from(arguments).forEach((headers) => {
      headersToObject(headers).forEach(([key, value]) => {
        if (key) output[key] = value;
      });
    });
    return output;
  }

  // 兼容 Headers、键值数组和普通对象三种浏览器请求头形态。
  function headersToObject(headers) {
    if (!headers) return [];
    try {
      if (typeof headers.forEach === 'function') {
        const rows = [];
        headers.forEach((value, key) => rows.push([normalizeText(key), normalizeText(value)]));
        return rows;
      }
      if (Array.isArray(headers)) {
        return headers.map((row) => [normalizeText(row && row[0]), normalizeText(row && row[1])]);
      }
      if (typeof headers === 'object') {
        return Object.keys(headers).map((key) => [normalizeText(key), normalizeText(headers[key])]);
      }
    } catch (_) {}
    return [];
  }

  // 调试日志只保存请求摘要，不直接展开请求体，避免日志过大或泄露完整业务数据。
  function summarizeJobListRequest(requestMeta) {
    if (!requestMeta) return null;
    return {
      url: requestMeta.url,
      method: requestMeta.method || 'GET',
      hasBody: requestMeta.body !== undefined && requestMeta.body !== null,
      bodyType: getBodyType(requestMeta.body),
      replayable: isReplayableJobListRequest(requestMeta),
      source: requestMeta.source,
    };
  }

  // 获取请求体的可读类型名称，用于判断一次列表请求是否具备重放条件。
  function getBodyType(body) {
    if (body === undefined || body === null) return '';
    try {
      const rawType = Object.prototype.toString.call(body).match(/\[object ([^\]]+)\]/);
      return rawType && rawType[1] || typeof body;
    } catch (_) {
      return typeof body;
    }
  }

  // 选择安全的列表重放来源：已完成请求优先，其次才是最近发起记录和 performance 缓冲区。
  function getLatestReplayableJobListRequest() {
    // 优先重放最近一次“已完成”的请求。并发切换标签时，最近发出的请求可能仍未完成，
    // 如果直接取它就可能把刚恢复好的求职期望再次覆盖成推荐。
    const completed = getLatestCompletedJobListRecord();
    if (isReplayableJobListRequest(completed)) return completed;
    if (isReplayableJobListRequest(runtime.latestJobListRequest)) return runtime.latestJobListRequest;

    const latestUrl = findLatestJobListApiUrl();
    const fallback = latestUrl ? {
      url: latestUrl,
      method: 'GET',
      headers: {},
      body: undefined,
      source: 'performance',
    } : null;
    return isReplayableJobListRequest(fallback) ? fallback : null;
  }

  // 只有携带有效筛选参数（或非 GET 请求体）的请求才允许重放，避免误拉无上下文的推荐列表。
  function isReplayableJobListRequest(requestMeta) {
    if (!requestMeta || !requestMeta.url) return false;

    const method = normalizeText(requestMeta.method || 'GET').toUpperCase();
    if (method && method !== 'GET' && method !== 'HEAD') {
      return requestMeta.body !== undefined && requestMeta.body !== null || hasMeaningfulJobListUrlParams(requestMeta.url);
    }

    return hasMeaningfulJobListUrlParams(requestMeta.url);
  }

  // 排除时间戳、页码等波动字段后，确认 URL 中仍存在城市/求职期望等业务筛选参数。
  function hasMeaningfulJobListUrlParams(url) {
    try {
      const target = new URL(url, location.href);
      let meaningful = false;
      target.searchParams.forEach((value, key) => {
        if (!isVolatileJobListParam(key) && normalizeText(value)) meaningful = true;
      });
      return meaningful;
    } catch (_) {
      return false;
    }
  }

  // 根据捕获元数据还原 fetch 配置；GET/HEAD 不携带 body，避免浏览器直接抛出异常。
  function buildJobListFetchInit(requestMeta) {
    const method = normalizeText(requestMeta && requestMeta.method || 'GET').toUpperCase() || 'GET';
    const headers = Object.assign({ Accept: 'application/json, text/plain, */*' }, requestMeta && requestMeta.headers || {});
    const init = {
      method,
      credentials: 'include',
      headers,
    };

    if (method !== 'GET' && method !== 'HEAD' && requestMeta && requestMeta.body !== undefined && requestMeta.body !== null) {
      init.body = requestMeta.body;
    }
    return init;
  }

  // 保持包装函数的 toString 接近原始实现，降低页面检测 monkey patch 的概率。
  function maskNative(wrapper, original) {
    try {
      Object.defineProperty(wrapper, 'toString', {
        configurable: true,
        value() {
          return Function.prototype.toString.call(original);
        },
      });
    } catch (_) {}
  }

  // 保存 History 原型方法，返回列表时优先调用原生实现，减少被页面覆写影响。
  function captureNativeHistoryNavigation() {
    const history = pageWindow.history;
    const prototype = pageWindow.History && pageWindow.History.prototype;
    const nativeBack = prototype && prototype.back;
    const nativeGo = prototype && prototype.go;

    return {
      back() {
        if (typeof nativeBack === 'function') {
          nativeBack.call(history);
          return;
        }
        if (history && typeof history.back === 'function') history.back();
      },
      go(delta) {
        if (typeof nativeGo === 'function') {
          nativeGo.call(history, delta);
          return;
        }
        if (history && typeof history.go === 'function') history.go(delta);
      },
    };
  }

  // 本脚本只关心岗位列表和岗位详情接口，其它请求不解析也不触碰。
  // 使用平台适配器的 API 模式进行检测
  function isTrackedJobApi(url) {
    // 如果已检测到平台，使用适配器的 API 模式
    if (currentPlatform && currentPlatform.apiPatterns) {
      const { jobList, jobDetail } = currentPlatform.apiPatterns;
      if (jobList && jobList.test(url)) return true;
      if (jobDetail && jobDetail.test(url)) return true;
    }
    // 回退到原有模式（兼容 BOSS）
    return APP.jobListApiPattern.test(url) || APP.jobDetailApiPattern.test(url);
  }

  // 网络拦截入口：根据 URL 分发到列表或详情解析流程。
  // 使用平台适配器的 API 模式进行分发
  function ingestTrackedJobResponse(url, text, source, requestMeta) {
    // 如果已检测到平台，使用适配器的 API 模式
    if (currentPlatform && currentPlatform.apiPatterns) {
      const { jobList, jobDetail } = currentPlatform.apiPatterns;
      if (jobList && jobList.test(url)) {
        ingestJobListResponse(url, text, source, requestMeta);
        return;
      }
      if (jobDetail && jobDetail.test(url)) {
        ingestJobDetailResponse(url, text, source);
        return;
      }
    }
    // 回退到原有模式（兼容 BOSS）
    if (APP.jobListApiPattern.test(url)) {
      ingestJobListResponse(url, text, source, requestMeta);
      return;
    }
    if (APP.jobDetailApiPattern.test(url)) {
      ingestJobDetailResponse(url, text, source);
    }
  }

  // 对同一批岗位生成批次指纹，避免同一响应被 fetch/XHR 或缓存重复处理。
  function makeJobListBatchKey(jobs) {
    const key = (jobs || [])
      .slice(0, 8)
      .map((job) => pickFirstString(job, ['encryptJobId', 'jobId', 'securityId', 'lid', 'jobName', 'brandName']))
      .filter(Boolean)
      .join('|');

    if (key) return key;
    return `count:${(jobs || []).length}:${hashString(JSON.stringify(jobs || []).slice(0, 1200))}`;
  }

  // 去掉页码、时间戳、随机数等波动参数，得到“这次搜索条件”的稳定上下文 key。
  function makeJobListContextKey(url) {
    try {
      const target = new URL(url, location.href);
      const params = [];
      target.searchParams.forEach((value, key) => {
        if (isVolatileJobListParam(key)) return;
        params.push([key, normalizeText(value)]);
      });
      params.sort((left, right) => {
        const keyCompared = left[0].localeCompare(right[0]);
        return keyCompared || left[1].localeCompare(right[1]);
      });
      const search = params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return `${target.origin}${target.pathname}?${search}`;
    } catch (_) {
      return `unknown:${normalizeText(url).split(/[?#]/)[0]}`;
    }
  }

  // BOSS 不同接口可能用 page/offset 等不同分页字段，这里统一解析为页码。
  function getJobListPageNumber(url) {
    try {
      const target = new URL(url, location.href);
      const pageKeys = ['page', 'pageNo', 'pageNum', 'pageIndex', 'current', 'currentPage'];
      for (const key of pageKeys) {
        const page = Number(target.searchParams.get(key));
        if (Number.isFinite(page) && page > 0) return page;
      }

      const offset = Number(target.searchParams.get('offset') || target.searchParams.get('start') || target.searchParams.get('startIndex'));
      const limit = Number(target.searchParams.get('limit') || target.searchParams.get('pageSize'));
      if (Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0) {
        return Math.floor(offset / limit) + 1;
      }
    } catch (_) {}

    return 1;
  }

  // 这些参数会随请求变化，不应参与搜索上下文判断。
  function isVolatileJobListParam(name) {
    return /^(?:_|t|ts|time|timestamp|callback|cb|r|random|ka|lid|securityId|sessionId|sid|traceId|page|pageNo|pageNum|pageIndex|current|currentPage|pageSize|limit|offset|start|startIndex)$/i.test(String(name || ''));
  }

  // 处理岗位列表响应：解析岗位数组、重置/追加当前列表数据池、并尝试重绑 DOM 卡片。
  function ingestJobListResponse(url, text, source, requestMeta) {
    if (!text) return;

    try {
      const payload = JSON.parse(text);
      const jobs = JobRepository.extractJobList(payload);
      if (!jobs.length) return;

      const contextKey = makeJobListContextKey(url);
      const pageNumber = getJobListPageNumber(url);
      const batchKey = makeJobListBatchKey(jobs);
      const scopedBatchKey = `${contextKey}::${batchKey}`;
      const shouldReplaceScope = JobRepository.shouldReplaceJobListScope(contextKey, pageNumber);

      JobRepository.noteJobListResponse({
        url,
        source,
        contextKey,
        pageNumber,
        batchKey,
        jobCount: jobs.length,
      });
      logDebugEvent('job_list_response', {
        url,
        source,
        pageNumber,
        contextKey,
        batchKey,
        scopedBatchKey,
        shouldReplaceScope,
        jobCount: jobs.length,
        firstJobs: jobs.slice(0, 5).map(summarizeRawJob),
        request: summarizeJobListRequest(requestMeta),
        listState: getDebugListState(),
      });

      if (runtime.seenApiBatches.has(scopedBatchKey) && !shouldReplaceScope) return;

      if (shouldReplaceScope) {
        JobRepository.resetJobListScope(contextKey);
      } else if (!runtime.jobListContextKey) {
        runtime.jobListContextKey = contextKey;
      }

      runtime.seenApiBatches.add(scopedBatchKey);
      runtime.jobListLastBatchKey = batchKey;
      runtime.jobListUpdatedAt = Date.now();

      jobs.forEach((rawJob, index) => {
        const job = JobRepository.normalizeJob(rawJob, runtime.jobPool.length + index, {
          source,
          sourceUrl: url,
        });

        JobRepository.rememberListJob(job);
      });

      // 接口通常比 DOM 后到；捕获到接口数据后立即重绑卡片，优先使用接口里的明文薪资。
      if (getJobCards().length) {
        JobRepository.syncCards();
      }

      UI.setStatus(`已捕获当前列表 ${runtime.jobPool.length} 条岗位接口数据`, 'ok');
    } catch (error) {
      console.warn('[ZhipinAuto] 岗位接口解析失败', error);
    }
  }

  // 处理岗位详情响应：保存最新详情并合并到列表池；HTML/工商信息由当前岗位按需补抓。
  function ingestJobDetailResponse(url, text, source) {
    if (!text) return;

    try {
      const payload = JSON.parse(text);
      const detail = JobRepository.normalizeJobDetail(payload, {
        source,
        sourceUrl: url,
      });
      if (!detail) {
        logDebugEvent('job_detail_response_empty', {
          source,
          url,
          code: payload && payload.code,
          message: normalizeText(payload && payload.message),
          payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
        }, 'warn');
        return;
      }

      JobRepository.rememberJobDetail(detail);
      const matched = JobRepository.applyDetailToPool(detail);
      logDebugEvent('job_detail_response_ingested', {
        source,
        url,
        detail: summarizeJobForDebug(detail),
        matched: summarizeJobForDebug(matched),
        listState: getDebugListState(),
      });
      if (matched && getJobCards().length) {
        JobRepository.syncCards();
      }

      if (detail.salary) {
        UI.setStatus(`已捕获岗位详情：${detail.jobName || '未知岗位'} / ${detail.salary}`, 'ok');
      }

      // HTML/工商信息只在当前岗位需要保存或发送前按需补抓。
      // 连续按活跃度跳过时如果为每个详情响应都并发补抓，会把后续真正沟通岗位的补全请求排队到超时。
    } catch (error) {
      console.warn('[ZhipinAuto] 岗位详情接口解析失败', error);
    }
  }

  // 后到的详情数据会反向补全已保存记录，避免早期 clicked/sent 记录字段不完整。
  function syncSavedRecordsWithJob(job, source) {
    if (!job) return;
    Database.enrichSavedRecords(job).then((updated) => {
      if (!updated) return;
      logDebugEvent('saved_records_enriched', {
        source,
        updated,
        job: summarizeJobForDebug(job),
      });
      if (runtime.ui) UI.refreshGreetedList();
    }).catch((error) => {
      logDebugEvent('saved_records_enrich_failed', {
        source,
        message: error && error.message || String(error),
        job: summarizeJobForDebug(job),
      }, 'warn');
    });
  }

  // 岗位仓库：负责从接口响应中提取岗位，并把左侧 DOM 卡片绑定到对应接口数据。
  // BOSS 列表卡片上的字段不完整，接口/详情页数据会在这里归一化后合并到同一份岗位对象。
  const JobRepository = {
    // 记录每一次岗位列表响应，用于判断列表是否刷新、是否回到第一页。
    noteJobListResponse(info) {
      const record = Object.assign({}, info || {}, {
        serial: runtime.jobListResponseSerial + 1,
        capturedAt: Date.now(),
      });

      runtime.jobListResponseSerial = record.serial;
      runtime.latestJobListResponse = record;

      if (Number(record.pageNumber || 1) <= 1) {
        runtime.jobListFirstPageSerial += 1;
        runtime.latestFirstPageJobListResponse = Object.assign({}, record, {
          firstPageSerial: runtime.jobListFirstPageSerial,
        });
      }

      return record;
    },

    // 搜索条件变化或重新请求第一页时，旧的岗位池不再可信，需要整体替换。
    shouldReplaceJobListScope(contextKey, pageNumber) {
      if (!runtime.jobListContextKey) return true;
      if (contextKey && contextKey !== runtime.jobListContextKey) return true;
      return Number(pageNumber || 1) <= 1;
    },

    // 清空当前列表池和索引，通常发生在搜索条件变化、第一页刷新或接口数据错位时。
    resetJobListScope(contextKey) {
      logDebugEvent('job_list_scope_reset', {
        nextContextKey: contextKey || '',
        previous: getDebugListState(),
      });
      runtime.jobPool = [];
      runtime.jobByKey = new Map();
      runtime.jobBySignature = new Map();
      runtime.jobByLooseSignature = new Map();
      runtime.jobDetailByKey = new Map();
      runtime.latestJobDetail = null;
      runtime.cardJobMap = new WeakMap();
      runtime.seenApiBatches.clear();
      runtime.jobListContextKey = contextKey || '';
      runtime.jobListLastBatchKey = '';
      runtime.jobListUpdatedAt = 0;
    },

    // 将列表接口中的岗位放入池中，并维护各种强/弱索引。
    rememberListJob(job) {
      runtime.jobPool.push(job);
      this.addJobToIndexes(job);
    },

    // 建立岗位多维索引：强 ID、岗位+公司+薪资签名、岗位+公司弱签名。
    addJobToIndexes(job) {
      if (!job) return;

      runtime.jobByKey.set(job.jobKey, job);

      if (isMeaningfulCompositeKey(job.signature)) {
        if (!runtime.jobBySignature.has(job.signature)) {
          runtime.jobBySignature.set(job.signature, []);
        }
        runtime.jobBySignature.get(job.signature).push(job);
      }

      if (isMeaningfulCompositeKey(job.looseSignature)) {
        if (!runtime.jobByLooseSignature.has(job.looseSignature)) {
          runtime.jobByLooseSignature.set(job.looseSignature, []);
        }
        runtime.jobByLooseSignature.get(job.looseSignature).push(job);
      }
    },

    // 在批量合并详情后重建索引，避免旧签名还指向旧对象。
    rebuildJobIndexes() {
      runtime.jobByKey = new Map();
      runtime.jobBySignature = new Map();
      runtime.jobByLooseSignature = new Map();
      runtime.jobPool.forEach((job) => this.addJobToIndexes(job));
    },

    // 从不同平台的列表响应中找到真正的岗位数组；直接字段优先，兜底递归扫描。
    extractJobList(payload) {
      const directCandidates = [
        payload && payload.zpData && payload.zpData.jobList,
        payload && payload.zpData && payload.zpData.data && payload.zpData.data.jobList,
        payload && payload.data && payload.data.jobList,
        payload && payload.jobList,
        // 智联 /c/i/search/positions 响应结构为 { code, data: { list, count } }。
        payload && payload.data && payload.data.list,
        payload && payload.list,
      ];

      for (const candidate of directCandidates) {
        if (Array.isArray(candidate) && candidate.length) return candidate;
      }

      const found = [];
      walkObject(payload, (value) => {
        if (found.length) return;
        if (!Array.isArray(value) || !value.length) return;
        const score = value.slice(0, 5).reduce((total, item) => {
          if (!item || typeof item !== 'object') return total;
          return total + [
            'jobName',
            'brandName',
            'salaryDesc',
            'encryptJobId',
            'bossName',
            'securityId',
          ].filter((key) => key in item).length;
        }, 0);

        if (score >= 3) found.push(value);
      });

      return found[0] || [];
    },

    // 将列表接口岗位归一化为脚本内部字段，后续 UI、存储、发送模板都依赖这份结构。
    normalizeJob(rawJob, orderIndex, meta) {
      const jobName = pickFirstString(rawJob, ['jobName', 'jobTitle', 'positionName', 'name', 'title']);
      const company = pickFirstString(rawJob, ['brandName', 'companyName', 'encryptBrandName', 'company']);
      const salary = pickReadableSalary(rawJob, ['salaryDesc', 'salary60', 'salary', 'salaryName']);
      const bossName = pickFirstString(rawJob, ['bossName', 'bossNickName', 'boss']);
      const bossTitle = pickFirstString(rawJob, ['bossTitle', 'postDescription']);
      const rawBossActiveTimeDesc = pickFirstString(rawJob, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc', 'lastActiveTimeDesc']);
      const bossOnline = Boolean(rawJob.bossOnline) || normalizeBossActiveText(rawBossActiveTimeDesc) === '在线';
      const bossActiveTimeDesc = bossOnline ? '在线' : getBossActiveOptionLabel(rawBossActiveTimeDesc);
      const encryptJobId = pickFirstString(rawJob, ['encryptJobId', 'jobId', 'job_id']);
      const securityId = pickFirstString(rawJob, ['securityId']);
      const lid = pickFirstString(rawJob, ['lid']);
      const brandId = pickFirstString(rawJob, ['encryptBrandId', 'brandId']);
      const city = pickFirstString(rawJob, ['cityName', 'city', 'workCity']);
      const experience = pickFirstString(rawJob, ['jobExperience', 'experienceName', 'experience', 'workingExp']);
      const degree = pickFirstString(rawJob, ['jobDegree', 'degreeName', 'degree', 'education']);

      // 智联列表接口用 number 作为岗位唯一标识；其它平台没有该字段，取值顺序保持不变。
      const strongKey = encryptJobId || pickFirstString(rawJob, ['jobId']) ||
        (currentPlatform && currentPlatform.id === 'zhilian' ? pickFirstString(rawJob, ['number']) : '');
      const fallbackKey = [jobName, company, salary, bossName, lid, securityId].filter(Boolean).join('|');
      const jobKey = strongKey || `sig_${hashString(fallbackKey || JSON.stringify(rawJob).slice(0, 300))}`;

      return {
        id: `job_${hashString(jobKey)}`,
        jobKey,
        signature: makeSignature(jobName, company, salary),
        looseSignature: makeLooseSignature(jobName, company),
        orderIndex,
        jobName,
        salary,
        company,
        bossName,
        bossTitle,
        bossActiveTimeDesc,
        bossOnline,
        bossAvatar: pickFirstString(rawJob, ['bossAvatar']),
        bossCertificated: Boolean(rawJob.bossCert || rawJob.bossCertificated),
        city,
        experience,
        degree,
        companyLogo: pickFirstString(rawJob, ['brandLogo', 'companyLogo']),
        companyStage: pickFirstString(rawJob, ['brandStageName', 'stageName', 'companyStage']),
        companyScale: pickFirstString(rawJob, ['brandScaleName', 'scaleName', 'companyScale']),
        companyIndustry: pickFirstString(rawJob, ['brandIndustry', 'industryName', 'companyIndustry']),
        companyLabels: normalizeStringArray(rawJob.welfareList || rawJob.companyLabels),
        encryptJobId,
        securityId,
        lid,
        brandId,
        source: meta.source,
        sourceUrl: meta.sourceUrl,
        rawJob,
        capturedAt: nowIso(),
      };
    },

    // 将岗位详情接口归一化；详情页比列表多 Boss 活跃状态、地址、技能、公司介绍等字段。
    normalizeJobDetail(payload, meta) {
      const data = payload && (payload.zpData || payload.data || payload);
      if (!data || typeof data !== 'object') return null;

      // 智联 /c/i/jobs/position-detailv3 返回扁平结构，没有 jobInfo 包装层，回退到 data 自身。
      const jobInfo = data.jobInfo || data.job || data;
      const bossInfo = data.bossInfo || {};
      const brandInfo = data.brandComInfo || data.brandInfo || data.companyInfo || {};

      const jobName = pickFirstString(jobInfo, ['jobName', 'jobTitle', 'name', 'title', 'positionName']);
      const positionName = pickFirstString(jobInfo, ['positionName']);
      const company = pickFirstString(brandInfo, ['brandName', 'customerBrandName', 'companyName']) ||
        pickFirstString(bossInfo, ['brandName']) ||
        pickFirstString(data, ['companyDisplayName', 'companyName', 'brandName']);
      const salary = pickReadableSalary(jobInfo, ['salaryDesc', 'salary60', 'salary', 'salaryName']) ||
        pickReadableSalary(data, ['salaryDesc', 'salary60', 'salary', 'salaryName']);
      const bossName = pickFirstString(bossInfo, ['name', 'bossName', 'bossNickName']);
      const bossTitle = pickFirstString(bossInfo, ['title', 'bossTitle']);
      const bossActiveTimeDesc = pickFirstString(bossInfo, [
        'activeTimeDesc',
        'bossActiveTimeDesc',
        'bossActiveDesc',
        'lastActiveTimeDesc',
        'onlineDesc',
      ]) || pickFirstString(data, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc']);
      const bossOnline = Boolean(bossInfo.bossOnline) || normalizeBossActiveText(bossActiveTimeDesc) === '在线';
      const encryptJobId = pickFirstString(jobInfo, ['encryptId', 'encryptJobId', 'jobId', 'job_id']);
      const securityId = pickFirstString(data, ['securityId']) || pickFirstString(jobInfo, ['securityId']);
      const lid = pickFirstString(data, ['lid']) || pickFirstString(jobInfo, ['lid']);
      const city = pickFirstString(jobInfo, ['locationName', 'cityName', 'city']);
      const experience = pickFirstString(jobInfo, ['experienceName', 'jobExperience', 'experience']);
      const degree = pickFirstString(jobInfo, ['degreeName', 'jobDegree', 'degree']);
      const address = pickFirstString(jobInfo, ['address']);
      const postDescription = normalizeTextPreserveLines(jobInfo.postDescription);
      const companyIntroduce = normalizeTextPreserveLines(brandInfo.introduce);
      const companyLabels = normalizeStringArray(brandInfo.labels);
      const showSkills = normalizeStringArray(jobInfo.showSkills);
      const longitude = Number(jobInfo.longitude || 0) || null;
      const latitude = Number(jobInfo.latitude || 0) || null;
      const fallbackKey = [jobName, company, salary, bossName, lid, securityId].filter(Boolean).join('|');
      const jobKey = encryptJobId || pickFirstString(jobInfo, ['jobId']) || `sig_${hashString(fallbackKey || JSON.stringify(data).slice(0, 300))}`;

      const detail = {
        id: `job_${hashString(jobKey)}`,
        jobKey,
        signature: makeSignature(jobName, company, salary),
        looseSignature: makeLooseSignature(jobName, company),
        jobName,
        positionName,
        salary,
        company,
        bossName,
        bossTitle,
        bossActiveTimeDesc: bossOnline ? '在线' : getBossActiveOptionLabel(bossActiveTimeDesc),
        bossOnline,
        bossAvatar: pickFirstString(bossInfo, ['large', 'tiny']),
        bossCertificated: Boolean(bossInfo.certificated),
        city,
        experience,
        degree,
        encryptJobId,
        securityId,
        lid,
        address,
        longitude,
        latitude,
        staticMapUrl: pickFirstString(jobInfo, ['pcStaticMapUrl', 'staticMapUrl']),
        encryptAddressId: pickFirstString(jobInfo, ['encryptAddressId']),
        postDescription,
        recruitmentCountDesc: pickFirstString(jobInfo, ['recruitmentCountDesc']),
        positionCode: pickFirstString(jobInfo, ['position']),
        jobType: pickFirstString(jobInfo, ['jobType']),
        jobStatusDesc: pickFirstString(jobInfo, ['jobStatusDesc']),
        showSkills,
        companyLogo: pickFirstString(brandInfo, ['logo']),
        companyStage: pickFirstString(brandInfo, ['stageName', 'customerBrandStageName']),
        companyScale: pickFirstString(brandInfo, ['scaleName']),
        companyIndustry: pickFirstString(brandInfo, ['industryName']),
        companyIntroduce,
        companyLabels,
        brandId: pickFirstString(brandInfo, ['encryptBrandId']),
        rawDetail: data,
        detailSource: meta.source,
        detailSourceUrl: meta.sourceUrl,
        detailCapturedAt: nowIso(),
      };

      if (!detail.jobName && !detail.company && !detail.salary) return null;
      return detail;
    },

    // 缓存最新详情，并按多种 key 建索引，供聊天页恢复 pendingJob 或列表页合并使用。
    rememberJobDetail(detail) {
      getJobDetailKeys(detail).forEach((key) => runtime.jobDetailByKey.set(key, detail));
      if (detail.signature) runtime.jobDetailByKey.set(`signature:${detail.signature}`, detail);
      if (detail.looseSignature) runtime.jobDetailByKey.set(`loose:${detail.looseSignature}`, detail);
      runtime.latestJobDetail = detail;
      syncSavedRecordsWithJob(detail, detail.detailSource || detail.source || 'detail');
    },

    // 根据强 ID、签名或弱签名查找某个岗位对应的最新详情。
    getDetailForJob(job, options) {
      const reliableKeys = getReliableJobIdentityKeys(job);
      for (const key of reliableKeys) {
        const matched = runtime.jobDetailByKey.get(key);
        if (matched) return matched;
      }

      // 当前岗位带有 encryptJobId/securityId/lid 时，不再退回到岗位名+公司弱匹配。
      // 连续切换详情时，弱匹配容易命中上一张相似岗位的半成品详情。
      if (reliableKeys.length && !(options && options.allowWeakWithReliableKey)) return null;

      const signature = job && (job.signature || makeSignature(job.jobName, job.company, job.salary));
      const looseSignature = job && (job.looseSignature || makeLooseSignature(job.jobName, job.company));
      const signatureDetail = runtime.jobDetailByKey.get(`signature:${signature}`);
      if (signatureDetail && isWeakDetailCompatible(job, signatureDetail)) return signatureDetail;

      const looseDetail = runtime.jobDetailByKey.get(`loose:${looseSignature}`);
      if (looseDetail && isWeakDetailCompatible(job, looseDetail)) return looseDetail;

      return null;
    },

    // 判断是否需要主动补拉详情接口，避免复用缺薪资/缺 rawDetail 的半成品详情。
    shouldFetchJobDetail(job, detail, options) {
      return getJobDetailFetchDecision(job, detail, options).shouldFetch;
    },

    // 点击岗位卡片后等待详情接口/HTML 数据到达；超时则主动补抓接口。
    async waitForJobDetail(job, timeout, resourceStartedAt, options) {
      const detailOptions = options || {};
      const includeHtml = detailOptions.includeHtml !== false;
      const totalTimeout = Math.max(800, Number(timeout || 2200));
      const startedAt = Date.now();
      let detail = this.getDetailForJob(job);
      logDebugEvent('job_detail_wait_start', {
        job: summarizeJobForDebug(job),
        cachedDetail: summarizeJobForDebug(detail),
        timeout: totalTimeout,
        resourceStartedAt,
        options: detailOptions,
      });

      if (!detail) {
        try {
          detail = await waitFor(
            () => this.getDetailForJob(job),
            Math.min(1800, totalTimeout),
            '岗位详情接口',
            { pollInterval: 120 },
          );
          logDebugEvent('job_detail_wait_initial_hit', {
            job: summarizeJobForDebug(job),
            detail: summarizeJobForDebug(detail),
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          logDebugEvent('job_detail_wait_initial_timeout', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            elapsedMs: Date.now() - startedAt,
          }, 'warn');
        }
      }

      const fetchDecision = getJobDetailFetchDecision(job, detail, detailOptions);
      logDebugEvent('job_detail_fetch_decision', {
        job: summarizeJobForDebug(job),
        detail: summarizeJobForDebug(detail),
        decision: fetchDecision,
        resourceStartedAt,
        elapsedMs: Date.now() - startedAt,
      }, fetchDecision.shouldFetch ? 'warn' : 'info');

      // BOSS 页面会缓存原始 XHR 方法，导致后续切换岗位时响应偶尔绕过拦截器。
      // 此时用岗位列表中的 securityId/lid（或刚发生的详情资源 URL）主动补取一次。
      if (fetchDecision.shouldFetch) {
        detail = await this.fetchJobDetail(job, resourceStartedAt).catch((error) => {
          logDebugEvent('job_detail_active_fetch_failed', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            resourceStartedAt,
          }, 'warn');
          console.warn('[ZhipinAuto] 主动获取岗位详情失败', error);
          return detail || null;
        });
      }

      if (!detail && Date.now() - startedAt < totalTimeout) {
        try {
          detail = await waitFor(
            () => this.getDetailForJob(job),
            Math.min(1500, Math.max(300, totalTimeout - (Date.now() - startedAt))),
            '岗位详情接口',
            { pollInterval: 120 },
          );
          logDebugEvent('job_detail_wait_late_hit', {
            job: summarizeJobForDebug(job),
            detail: summarizeJobForDebug(detail),
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          logDebugEvent('job_detail_wait_late_timeout', {
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
            elapsedMs: Date.now() - startedAt,
          }, 'warn');
        }
      }

      if (!includeHtml || !detail || detail.htmlCapturedAt) {
        logDebugEvent(detail ? 'job_detail_wait_finish' : 'job_detail_wait_missing', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(detail),
          includeHtml,
          elapsedMs: Date.now() - startedAt,
        }, detail ? 'info' : 'warn');
        return detail;
      }

      if (!detail.htmlFetchPending) {
        this.enrichDetailWithHtml(detail).catch((error) => {
          logDebugEvent('job_detail_html_enrich_failed', {
            detail: summarizeJobForDebug(detail),
            message: error && error.message || String(error),
          }, 'warn');
          console.warn('[ZhipinAuto] 岗位 HTML 详情解析失败', error);
        });
      }

      const remaining = Math.max(0, totalTimeout - (Date.now() - startedAt));
      if (remaining <= 100) return detail;

      try {
        const htmlDetail = await waitFor(() => {
          const latest = this.getDetailForJob(job);
          return latest && latest.htmlCapturedAt ? latest : null;
        }, Math.min(remaining, 1800), '岗位 HTML 详情', { pollInterval: 120 });
        logDebugEvent('job_detail_html_wait_hit', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(htmlDetail),
          elapsedMs: Date.now() - startedAt,
        });
        return htmlDetail;
      } catch (error) {
        const fallbackDetail = this.getDetailForJob(job) || detail;
        logDebugEvent('job_detail_html_wait_timeout', {
          job: summarizeJobForDebug(job),
          detail: summarizeJobForDebug(fallbackDetail),
          message: error && error.message || String(error),
          elapsedMs: Date.now() - startedAt,
        }, 'warn');
        return fallbackDetail;
      }
    },

    // 主动请求岗位详情接口，用于 XHR 被页面缓存绕过或拦截器没拿到响应时的兜底。
    async fetchJobDetail(job, resourceStartedAt) {
      const fetcher = nativePageFetch || (typeof pageWindow.fetch === 'function' && pageWindow.fetch.bind(pageWindow));
      if (!fetcher) {
        logDebugEvent('job_detail_active_fetch_unavailable', {
          reason: 'missing_fetcher',
          job: summarizeJobForDebug(job),
        }, 'warn');
        return null;
      }
      const directUrl = buildJobDetailApiUrl(job);
      const latestUrl = findLatestJobDetailApiUrl(resourceStartedAt);
      const requestTargets = [];
      if (directUrl) requestTargets.push({ url: directUrl, direct: true });
      if (latestUrl && latestUrl !== directUrl) requestTargets.push({ url: latestUrl, direct: false });
      if (!requestTargets.length) {
        logDebugEvent('job_detail_active_fetch_unavailable', {
          reason: 'missing_request_targets',
          job: summarizeJobForDebug(job),
          requestIdentity: getJobDetailRequestIdentity(job),
          directUrl,
          latestUrl,
          resourceStartedAt,
        }, 'warn');
        return null;
      }

      const expectedJobId = normalizeText(job && job.encryptJobId);
      let lastError = null;
      logDebugEvent('job_detail_active_fetch_targets', {
        job: summarizeJobForDebug(job),
        requestIdentity: getJobDetailRequestIdentity(job),
        directUrl,
        latestUrl,
        resourceStartedAt,
        targets: requestTargets,
      });

      for (const target of requestTargets) {
        try {
          logDebugEvent('job_detail_active_fetch_request', {
            job: summarizeJobForDebug(job),
            target,
            expectedJobId,
          });
          const response = await fetcher(target.url, {
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*' },
          });
          logDebugEvent('job_detail_active_fetch_response', {
            target,
            status: response.status,
            ok: response.ok,
            redirected: response.redirected,
            responseUrl: response.url,
          }, response.ok ? 'info' : 'warn');
          if (!response.ok) throw new Error(`岗位详情请求失败：HTTP ${response.status}`);

          const payload = await response.json();
          logDebugEvent('job_detail_active_fetch_payload', {
            target,
            code: payload && payload.code,
            message: normalizeText(payload && payload.message),
            payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
            hasData: Boolean(payload && (payload.zpData || payload.data)),
          }, Number(payload && payload.code) === 0 ? 'info' : 'warn');
          if (Number(payload && payload.code) !== 0) {
            throw new Error(`岗位详情请求失败：${normalizeText(payload && payload.message) || '未知错误'}`);
          }

          const detail = this.normalizeJobDetail(payload, {
            source: 'active-fetch',
            sourceUrl: target.url,
          });
          if (!detail) throw new Error('岗位详情响应为空');
          if (expectedJobId && detail.encryptJobId && detail.encryptJobId !== expectedJobId) {
            logDebugEvent('job_detail_active_fetch_expected_id_mismatch', {
              target,
              expectedJobId,
              detail: summarizeJobForDebug(detail),
            }, 'warn');
            throw new Error(`岗位详情不匹配：期望 ${expectedJobId}，实际 ${detail.encryptJobId}`);
          }
          const compatibility = getFetchedDetailCompatibilityReport(job, detail, { allowWeakWithReliableKey: target.direct });
          if (!compatibility.compatible) {
            logDebugEvent('job_detail_active_fetch_incompatible', {
              target,
              job: summarizeJobForDebug(job),
              detail: summarizeJobForDebug(detail),
              compatibility,
            }, 'warn');
            throw new Error(`岗位详情不匹配：${compatibility.reason || '响应内容不像当前岗位'}`);
          }

          this.rememberJobDetail(detail);
          const matched = this.applyDetailToPool(detail);
          logDebugEvent('job_detail_active_fetch_success', {
            target,
            detail: summarizeJobForDebug(detail),
            matched: summarizeJobForDebug(matched),
            compatibility,
          });
          return detail;
        } catch (error) {
          lastError = error;
          logDebugEvent('job_detail_active_fetch_target_failed', {
            target,
            job: summarizeJobForDebug(job),
            message: error && error.message || String(error),
          }, 'warn');
        }
      }

      throw lastError || new Error('岗位详情请求失败');
    },

    // 详情接口字段不完整时，额外抓岗位详情 HTML 和公司主页 HTML 补公司工商信息。
    async enrichDetailWithHtml(detail) {
      if (!detail || detail.htmlCapturedAt || detail.htmlFetchPending) return detail;

      const jobUrl = buildJobHtmlDetailUrl(detail);
      const companyUrl = buildCompanyHtmlUrl(detail);
      if (!jobUrl && !companyUrl) return detail;

      detail.htmlFetchPending = true;
      this.rememberJobDetail(detail);

      let merged = detail;
      let captured = false;
      let lastError = null;

      if (jobUrl) {
        try {
          const html = await fetchJobHtml(jobUrl);
          const htmlDetail = parseJobHtmlDetail(html, jobUrl);
          merged = mergeJobInfo(merged, htmlDetail);
          merged.htmlDetailUrl = jobUrl;
          merged.rawHtmlDetail = htmlDetail.rawHtmlDetail || null;
          captured = true;
        } catch (error) {
          lastError = error;
          console.warn('[ZhipinAuto] 岗位 HTML 详情解析失败', error);
        }
      }

      // 公司主页中的工商信息更完整，放在岗位详情之后合并以获得最高优先级。
      if (companyUrl) {
        try {
          const companyHtml = await fetchJobHtml(companyUrl);
          const companyDetail = parseCompanyBusinessHtml(companyHtml, companyUrl);
          merged = mergeJobInfo(merged, companyDetail);
          merged.companyDetailUrl = companyUrl;
          merged.companyDetailCapturedAt = nowIso();
          merged.rawCompanyDetail = companyDetail.rawCompanyDetail || null;
          captured = true;
        } catch (error) {
          lastError = error;
          console.warn('[ZhipinAuto] 公司工商信息解析失败', error);
        }
      }

      if (!captured) {
        detail.htmlFetchPending = false;
        this.rememberJobDetail(detail);
        throw lastError || new Error('岗位与公司 HTML 详情均获取失败');
      }

      merged.htmlFetchPending = false;
      merged.htmlCapturedAt = nowIso();
      this.rememberJobDetail(merged);
      this.applyDetailToPool(merged);

      if (merged.company || merged.salary) {
        UI.setStatus(`已补全岗位及公司详情：${merged.jobName || '未知岗位'} / ${merged.company || ''}`, 'ok');
      }

      return merged;
    },

    // 将详情合并回列表池中的对应岗位，保证后续存储和发送模板拿到最新字段。
    applyDetailToPool(detail) {
      let matched = null;
      const detailReliableKeys = new Set(getReliableJobIdentityKeys(detail));

      runtime.jobPool = runtime.jobPool.map((job) => {
        const jobReliableKeys = getReliableJobIdentityKeys(job);
        const keyMatched = jobReliableKeys.some((key) => detailReliableKeys.has(key));
        const allowCompositeFallback = !detailReliableKeys.size || !jobReliableKeys.length;
        const signatureMatched = allowCompositeFallback && detail.signature && detail.signature === job.signature;
        const looseMatched = allowCompositeFallback && detail.looseSignature && detail.looseSignature === job.looseSignature;

        if (!keyMatched && !signatureMatched && !looseMatched) return job;

        matched = mergeJobInfo(job, detail);
        return matched;
      });

      if (matched) this.rebuildJobIndexes();
      return matched;
    },

    // 把当前可见 DOM 卡片和接口岗位绑定到 WeakMap，自动化点击时从卡片反查岗位。
    syncCards() {
      const cards = getJobCards();
      const usedJobKeys = new Set();
      const allowIndexFallback = this.canUseIndexedFallback(cards);
      const incompleteSamples = [];
      let incompleteCount = 0;

      cards.forEach((card, index) => {
        const domInfo = extractCardInfo(card);
        let job = this.findApiJobForCard(domInfo, index, usedJobKeys, { allowIndexFallback });
        const matchedFromApi = Boolean(job);

        job = job
          ? this.mergeDomInfo(job, domInfo)
          : this.normalizeDomOnlyJob(card, index);

        usedJobKeys.add(job.jobKey);
        runtime.cardJobMap.set(card, job);
        card.dataset.zhipinAutoJobKey = job.jobKey;

        if (!matchedFromApi || !job.jobName || !job.company) {
          incompleteCount += 1;
          if (incompleteSamples.length < 6) {
            incompleteSamples.push({
              index,
              matchedFromApi,
              domInfo: summarizeDomInfoForDebug(domInfo),
              job: summarizeJobForDebug(job),
            });
          }
        }
      });

      if (incompleteCount) {
        logDebugEvent('sync_cards_incomplete_summary', {
          cardCount: cards.length,
          incompleteCount,
          allowIndexFallback,
          samples: incompleteSamples,
          listState: getDebugListState(),
        }, 'warn');
      }

      return cards;
    },

    // 判断是否可以按列表顺序匹配 DOM 和接口数据；只有前几个样本足够相似才允许。
    canUseIndexedFallback(cards) {
      if (!runtime.jobPool.length || !cards.length) return false;

      const sampleCount = Math.min(cards.length, runtime.jobPool.length, 5);
      let comparable = 0;
      let matched = 0;

      for (let index = 0; index < sampleCount; index += 1) {
        const result = this.cardLooksLikeJob(extractCardInfo(cards[index]), runtime.jobPool[index]);
        if (!result.comparable) continue;
        comparable += 1;
        if (result.matched) matched += 1;
      }

      if (comparable < 2) return false;
      return matched >= Math.ceil(comparable * 0.6);
    },

    // 样本比对函数：用岗位名/公司/薪资判断 DOM 卡片和接口岗位是否像同一条记录。
    cardLooksLikeJob(domInfo, job) {
      if (!domInfo || !job) return { comparable: false, matched: false };

      const domKeys = new Set((domInfo.keys || []).map(normalizeText).filter(Boolean));
      const jobKeys = getJobStrongIdentityKeys(job);
      if (domKeys.size && jobKeys.length) {
        return {
          comparable: true,
          matched: jobKeys.some((key) => domKeys.has(key)),
        };
      }

      const domLooseSignature = domInfo.looseSignature;
      const jobLooseSignature = job.looseSignature || makeLooseSignature(job.jobName, job.company);
      if (isMeaningfulCompositeKey(domLooseSignature) && isMeaningfulCompositeKey(jobLooseSignature)) {
        return {
          comparable: true,
          matched: domLooseSignature === jobLooseSignature,
        };
      }

      const domSignature = domInfo.signature;
      const jobSignature = job.signature || makeSignature(job.jobName, job.company, job.salary);
      if (isMeaningfulCompositeKey(domSignature) && isMeaningfulCompositeKey(jobSignature)) {
        return {
          comparable: true,
          matched: domSignature === jobSignature,
        };
      }

      return { comparable: false, matched: false };
    },

    // 当前接口池是否能服务当前可见卡片；如果搜索/刷新导致错位，会触发重置。
    isJobPoolUsableForCards(cards) {
      const visibleCards = cards || getJobCards();
      if (!visibleCards.length) return true;
      if (this.canUseIndexedFallback(visibleCards)) return true;

      const samples = visibleCards.slice(0, 5);
      return samples.some((card, index) => {
        const matched = this.findApiJobForCard(
          extractCardInfo(card),
          index,
          new Set(),
          { allowIndexFallback: false },
        );
        return Boolean(matched);
      });
    },

    // 列表自动化启动前等待接口数据；等不到时尝试主动补拉最近的岗位列表接口。
    async waitForApiData(timeout) {
      if (runtime.jobPool.length) {
        if (this.isJobPoolUsableForCards()) return true;

        this.resetJobListScope('');
      }

      try {
        await waitFor(
          () => runtime.jobPool.length > 0,
          timeout || 1800,
          '岗位接口数据',
          { pollInterval: 120 },
        );
        if (this.isJobPoolUsableForCards()) return true;
        this.resetJobListScope('');
      } catch (_) {}

      // 接口被平台拒绝（如 HTTP 405）时，短时间内不再重复补拉，避免每轮刷日志和请求。
      if (Date.now() < Number(runtime.jobListActiveFetchRetryAfter || 0)) return false;

      const fetched = await this.fetchLatestJobList().catch((error) => {
        const message = error && error.message || String(error);
        const rejected = /HTTP\s*(?:403|405)/i.test(message);
        if (rejected) runtime.jobListActiveFetchRetryAfter = Date.now() + 120000;
        logDebugEvent('job_list_active_fetch_failed', {
          message,
          latestUrl: findLatestJobListApiUrl(),
          hint: rejected ? '接口拒绝直连，已暂停补拉 2 分钟；岗位仍按页面卡片继续处理' : '',
        }, 'warn');
        console.warn('[ZhipinAuto] 主动获取岗位列表失败', error);
        return false;
      });
      if (fetched && this.isJobPoolUsableForCards()) return true;

      return false;
    },

    // 主动补抓岗位列表：恢复求职期望时可指定已确认 URL，其它场景则从最近完成记录中安全选择。
    async fetchLatestJobList(requestOverride) {
      const fetcher = nativePageFetch || (typeof pageWindow.fetch === 'function' && pageWindow.fetch.bind(pageWindow));
      // 字符串覆盖值按 GET 请求处理；对象覆盖值可保留原方法、请求头和请求体。
      const override = typeof requestOverride === 'string'
        ? { url: requestOverride, method: 'GET', headers: {}, source: 'explicit-replay' }
        : requestOverride;
      const request = isReplayableJobListRequest(override) ? override : getLatestReplayableJobListRequest();
      if (!request || !fetcher) {
        logDebugEvent('job_list_active_fetch_skipped', {
          reason: !fetcher ? 'missing_fetcher' : 'missing_replayable_request',
          latestUrl: findLatestJobListApiUrl(),
          latestRequest: summarizeJobListRequest(runtime.latestJobListRequest),
        }, 'warn');
        return false;
      }

      logDebugEvent('job_list_active_fetch_request', {
        request: summarizeJobListRequest(request),
      });
      const response = await fetcher(request.url, buildJobListFetchInit(request));
      if (!response.ok) throw new Error(`岗位列表请求失败：HTTP ${response.status}`);

      const payload = await response.json();
      if (Number(payload && payload.code) !== 0) {
        throw new Error(`岗位列表请求失败：${normalizeText(payload && payload.message) || '未知错误'}`);
      }

      ingestJobListResponse(request.url, JSON.stringify(payload), 'active-fetch', request);
      return runtime.jobPool.length > 0;
    },

    // DOM 卡片匹配接口岗位的核心逻辑：强 key -> 完整签名 -> 弱签名 -> 顺序兜底。
    findApiJobForCard(domInfo, index, usedJobKeys, options) {
      // 优先用 jobByKey Map 做 O(1) 查找，避免遍历整个 jobPool
      for (const key of domInfo.keys) {
        if (!key) continue;
        const candidate = runtime.jobByKey.get(key);
        if (candidate && !usedJobKeys.has(candidate.jobKey)) return candidate;
      }

      // 次选：遍历 jobPool 匹配 encryptJobId/securityId/lid/rawJob.jobId
      for (const key of domInfo.keys) {
        if (!key) continue;
        for (const item of runtime.jobPool) {
          if (usedJobKeys.has(item.jobKey)) continue;
          if (
            item.encryptJobId === key ||
            item.securityId === key ||
            item.lid === key ||
            String(item.rawJob && item.rawJob.jobId || '') === key
          ) {
            return item;
          }
        }
      }

      if (isMeaningfulCompositeKey(domInfo.signature)) {
        const signatureMatches = runtime.jobBySignature.get(domInfo.signature) || [];
        const matched = signatureMatches.find((item) => !usedJobKeys.has(item.jobKey));
        if (matched) return matched;
      }

      if (isMeaningfulCompositeKey(domInfo.looseSignature)) {
        // DOM 中薪资可能是字体加密字符，所以这里增加"岗位名 + 公司"的弱签名匹配。
        const looseMatches = runtime.jobByLooseSignature.get(domInfo.looseSignature) || [];
        const matched = looseMatches.find((item) => !usedJobKeys.has(item.jobKey));
        if (matched) return matched;
      }

      if (!options || !options.allowIndexFallback) return null;

      const indexed = runtime.jobPool[index];
      if (indexed && !usedJobKeys.has(indexed.jobKey)) return indexed;
      return null;
    },

    // DOM 中可读字段作为补充，但薪资如果是 BOSS 私有字体字符，会优先保留接口明文。
    mergeDomInfo(job, domInfo) {
      const merged = Object.assign({}, job);
      const domSalary = getReadableSalary(domInfo.salary);

      if (!merged.jobName && domInfo.jobName) merged.jobName = domInfo.jobName;
      if (!merged.company && domInfo.company) merged.company = domInfo.company;
      if (!merged.city && domInfo.city) merged.city = domInfo.city;
      if ((!merged.salary || isEncryptedSalary(merged.salary)) && domSalary) merged.salary = domSalary;

      merged.signature = makeSignature(merged.jobName, merged.company, merged.salary);
      merged.looseSignature = makeLooseSignature(merged.jobName, merged.company);
      return merged;
    },

    // 当接口数据暂时不可用时，用 DOM 卡片构造临时岗位，保证流程仍可定位和记录。
    normalizeDomOnlyJob(card, index) {
      const domInfo = extractCardInfo(card);
      const fallback = {
        jobName: domInfo.jobName,
        brandName: domInfo.company,
        salaryDesc: domInfo.salary,
        encryptJobId: domInfo.keys[0] || '',
        cityName: domInfo.city,
      };
      const job = this.normalizeJob(fallback, index, {
        source: 'dom',
        sourceUrl: location.href,
      });
      job.domOnly = true;
      return job;
    },
  };

  // IndexedDB 只保存结构化岗位记录：
  // - jobRecords：点击、跳过、发送等完整岗位记录。
  // - greetedJobs：已沟通索引，启动时用于快速跳过重复岗位。
  // UI 的虚拟列表、导出、按时间清理都从这里读取。
  const Database = {
    // 打开或创建 IndexedDB。版本升级时只创建缺失的 object store 和索引。
    open() {
      if (runtime.db) return Promise.resolve(runtime.db);

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(APP.dbName, APP.dbVersion);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains('jobRecords')) {
            const store = db.createObjectStore('jobRecords', { keyPath: 'id' });
            store.createIndex('jobKey', 'jobKey', { unique: false });
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('company', 'company', { unique: false });
            store.createIndex('jobName', 'jobName', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
            store.createIndex('sentAt', 'sentAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('greetedJobs')) {
            const store = db.createObjectStore('greetedJobs', { keyPath: 'id' });
            store.createIndex('jobKey', 'jobKey', { unique: false });
            store.createIndex('company', 'company', { unique: false });
            store.createIndex('jobName', 'jobName', { unique: false });
            store.createIndex('sentAt', 'sentAt', { unique: false });
          }

          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };

        request.onsuccess = () => {
          runtime.db = request.result;
          resolve(runtime.db);
        };

        // 其他标签页占用旧版本连接时，浏览器会触发 blocked 而不是 error；这里显式失败并提示，
        // 避免列表一直停在“正在读取本地记录…”的空白状态。
        request.onblocked = () => {
          reject(new Error('本地数据库被其他标签页占用，请关闭其他招聘页面标签后重试'));
        };

        request.onerror = () => reject(request.error);
      });
    },

    // IndexedDB 事务包装器，所有基础读写都从这里统一处理成功/失败。
    withStore(storeName, mode, callback) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;

        try {
          result = callback(store);
        } catch (error) {
          reject(error);
          return;
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 写入单条记录，供岗位记录和已沟通投影共用。
    put(storeName, value) {
      return this.withStore(storeName, 'readwrite', (store) => store.put(value));
    },

    // 通过主键读取单条记录。
    get(storeName, id) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      }));
    },

    // 读取整个 store，导出、清理前统计、虚拟列表刷新都会调用。
    getAll(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }));
    },

    // 统计 store 条数，用于清理后校验和提示。
    count(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).count();
        request.onsuccess = () => resolve(Number(request.result || 0));
        request.onerror = () => reject(request.error);
      }));
    },

    // 清空指定 store，并返回删除前数量。
    clearStore(storeName) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        let count = 0;

        const countRequest = store.count();
        countRequest.onsuccess = () => {
          count = Number(countRequest.result || 0);
          store.clear();
        };
        countRequest.onerror = () => reject(countRequest.error);

        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 游标遍历删除符合条件的记录，用于“按沟通时间清理”。
    deleteWhere(storeName, predicate) {
      return this.open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        let deleted = 0;
        let predicateError = null;

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          let shouldDelete = false;

          try {
            shouldDelete = Boolean(predicate(cursor.value));
          } catch (error) {
            predicateError = error;
            tx.abort();
            return;
          }

          if (!shouldDelete) {
            cursor.continue();
            return;
          }

          const deleteRequest = cursor.delete();
          deleteRequest.onsuccess = () => {
            deleted += 1;
            cursor.continue();
          };
          deleteRequest.onerror = () => {
            predicateError = deleteRequest.error;
            tx.abort();
          };
        };

        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(deleted);
        tx.onerror = () => reject(predicateError || tx.error);
        tx.onabort = () => reject(predicateError || tx.error || new Error('IndexedDB transaction aborted'));
      }));
    },

    // 写入前检查浏览器存储配额，接近上限时提前阻止继续采集。
    async ensureStorageAvailable() {
      const estimate = await getStorageEstimate();
      if (!estimate || !estimate.quota) return;

      const ratio = estimate.usage / estimate.quota;
      if (ratio >= APP.storageQuotaWarnRatio) {
        throw createStorageQuotaError(estimate);
      }
    },

    // 保存岗位沟通记录。patch 用来区分 clicked/sent/skipped 等不同阶段。
    async saveJobRecord(job, patch) {
      await this.ensureStorageAvailable();

      const time = nowIso();
      const id = job.id || `job_${hashString(job.jobKey || `${job.jobName}|${job.company}`)}`;
      const existing = await this.get('jobRecords', id).catch(() => null);
      const record = Object.assign({
        companyFullName: '',
        legalRepresentative: '',
        establishedDate: '',
        companyType: '',
        manageState: '',
        registeredCapital: '',
        registeredAddress: '',
        businessTerm: '',
        businessRegion: '',
        unifiedSocialCreditCode: '',
        approvalDate: '',
        formerName: '',
        registrationAuthority: '',
        businessIndustry: '',
        businessScope: '',
        businessInfo: {},
      }, existing || {}, compactObject(flattenJob(job)), patch || {}, {
        id,
        jobKey: job.jobKey,
        // 添加平台标识，用于区分不同平台的数据
        platform: currentPlatform?.id || 'unknown',
        platformName: currentPlatform?.name || '未知平台',
        rawJob: job.rawJob || (existing && existing.rawJob) || null,
        rawDetail: job.rawDetail || (existing && existing.rawDetail) || null,
        rawHtmlDetail: job.rawHtmlDetail || (existing && existing.rawHtmlDetail) || null,
        rawCompanyDetail: job.rawCompanyDetail || (existing && existing.rawCompanyDetail) || null,
        updatedAt: time,
      });

      record.createdAt = record.createdAt || time;
      try {
        await this.put('jobRecords', record);

        if (isContactedRecord(record)) {
          ContactedIndex.add(record);
        }

        if (record.status === 'sent' && config.collectGreetedJobs) {
          const greetedRecord = Object.assign({}, record);
          delete greetedRecord.rawJob;
          delete greetedRecord.rawDetail;
          delete greetedRecord.rawHtmlDetail;
          delete greetedRecord.rawCompanyDetail;
          await this.put('greetedJobs', greetedRecord);
        }
      } catch (error) {
        if (isStorageQuotaError(error)) {
          throw createStorageQuotaError(await getStorageEstimate(), error);
        }
        throw error;
      }

      return record;
    },

    // 详情后到时，按岗位 ID 回填 jobRecords/greetedJobs 中已存在的记录。
    async enrichSavedRecords(job) {
      if (!job) return 0;
      await this.ensureStorageAvailable();

      const flat = compactObject(flattenJob(job));
      const ids = Array.from(new Set([
        flat.id,
        job.id,
        job.jobKey ? `job_${hashString(job.jobKey)}` : '',
      ].map(normalizeText).filter(Boolean)));
      if (!ids.length) return 0;

      const now = nowIso();
      let updated = 0;
      for (const storeName of ['jobRecords', 'greetedJobs']) {
        for (const id of ids) {
          const existing = await this.get(storeName, id).catch(() => null);
          if (!existing) continue;

          const next = Object.assign({}, existing, flat, {
            id: existing.id,
            jobKey: existing.jobKey || job.jobKey,
            updatedAt: now,
          });

          if (storeName === 'jobRecords') {
            next.rawJob = job.rawJob || existing.rawJob || null;
            next.rawDetail = job.rawDetail || existing.rawDetail || null;
            next.rawHtmlDetail = job.rawHtmlDetail || existing.rawHtmlDetail || null;
            next.rawCompanyDetail = job.rawCompanyDetail || existing.rawCompanyDetail || null;
          }

          await this.put(storeName, next);
          updated += 1;
        }
      }

      return updated;
    },
  };

  // 已沟通索引：用 Set 存岗位强 ID，避免每个岗位都扫 IndexedDB 或依赖页面按钮文本。
  // 页面上的“继续沟通”文案只能作为兜底判断，本地记录才是跨刷新、跨会话的主要依据。
  const ContactedIndex = {
    // 首次使用前从 IndexedDB 重建内存索引。
    async ensureReady() {
      if (runtime.contactedIndexReady) return runtime.contactedJobKeys;
      return this.rebuild();
    },

    // 从 jobRecords 和 greetedJobs 两个 store 汇总已沟通 key。
    async rebuild() {
      runtime.contactedJobKeys.clear();

      const rows = await Database.getAll('jobRecords');
      rows.forEach((record) => {
        if (isContactedRecord(record)) this.add(record);
      });

      // greetedJobs 是 sent 记录的投影；单独读取是为了兼容旧版本只写入 greetedJobs 的情况。
      const greetedRows = await Database.getAll('greetedJobs').catch(() => []);
      greetedRows.forEach((record) => this.add(record));

      runtime.contactedIndexReady = true;
      return runtime.contactedJobKeys;
    },

    // 将某个岗位的所有可判重 key 加入内存 Set。
    add(job) {
      getContactedKeys(job).forEach((key) => runtime.contactedJobKeys.add(key));
    },

    // 判断岗位是否已沟通过；列表循环跳过重复岗位时调用。
    has(job) {
      const keys = getContactedKeys(job);
      return keys.length > 0 && keys.some((key) => runtime.contactedJobKeys.has(key));
    },

    // 清理 IndexedDB 后同步清空内存索引。
    reset() {
      runtime.contactedJobKeys.clear();
      runtime.contactedIndexReady = false;
    },
  };

  // 已投递公司去重名单：独立存储在 localStorage，与 jobRecords 解耦。
  // 投递简历成功时追加公司名；清理岗位记录不会清除本名单（可在面板手动清空）。
  const AppliedCompanyIndex = {
    // 从 localStorage 加载内存 Set；名单为空且未手动清空时，从本平台历史 jobRecords 补播种。
    // 补播种条件不再只看"key 是否存在"：早期版本首次运行时若库内还没有已投递记录，
    // 会把空数组 [] 落盘并永久固化（BOSS 侧常见，表现为"当前名单 0 家公司"）。
    // 数据仍按域名隔离：zhipin.com / zhaopin.com 各自读写各自的名单和 jobRecords。
    async ensureReady() {
      if (runtime.appliedCompanyReady) return runtime.appliedCompanySet;
      const raw = localStorage.getItem(APP.appliedCompanyKey);
      const cleared = localStorage.getItem(APP.appliedCompanyClearedKey) === '1';
      runtime.appliedCompanySet.clear();
      if (raw) {
        try {
          const names = JSON.parse(raw);
          if (Array.isArray(names)) names.forEach((n) => n && runtime.appliedCompanySet.add(String(n)));
        } catch (_) {}
      }
      // 名单为空（无存储 / 历史写入的 []）→ 从 jobRecords 幂等补播种一次，按公司名去重合并。
      if (!cleared && runtime.appliedCompanySet.size === 0) {
        const rows = await Database.getAll('jobRecords').catch(() => []);
        rows.forEach((record) => {
          if (shouldCountAppliedRecord(record)) this.collect(record);
        });
      }
      runtime.appliedCompanyReady = true;
      this.persist();
      return runtime.appliedCompanySet;
    },

    // 只把公司名收集进内存 Set；批量播种时用，避免每条记录都写一次 localStorage。
    collect(record) {
      (getCompanyMatchCandidates(record || {}, record && record.company)).forEach((name) => {
        if (!name) return;
        runtime.appliedCompanySet.add(name);
      });
    },

    // 把公司名追加进内存 Set 并持久化（投递成功时的唯一入口）。
    add(record) {
      this.collect(record);
      this.persist();
    },

    // 写入 localStorage。
    persist() {
      try {
        localStorage.setItem(APP.appliedCompanyKey, JSON.stringify(Array.from(runtime.appliedCompanySet)));
      } catch (e) {
        logDebugEvent('applied_company_persist_failed', { error: String((e && e.message) || e) }, 'warn');
      }
    },

    // 判断当前岗位是否命中任一已投递公司。
    has(job) {
      if (!job) return false;
      const candidates = getCompanyMatchCandidates(job, job.company);
      return candidates.some((name) => name && runtime.appliedCompanySet.has(name));
    },

    // 清空名单（面板手动触发）：置"已手动清空"标记，之后不再从历史记录自动回补。
    clear() {
      runtime.appliedCompanySet.clear();
      try { localStorage.removeItem(APP.appliedCompanyKey); } catch (_) {}
      try { localStorage.setItem(APP.appliedCompanyClearedKey, '1'); } catch (_) {}
      runtime.appliedCompanyReady = true;
    },

    // 返回名单大小，用于面板展示。
    size() {
      return runtime.appliedCompanySet.size;
    },

    reset() {
      // reset 仅表示“重建内存态”，不再清空持久化名单；这里保留空实现以兼容调用点。
    },
  };

  // 判断记录是否代表"成功投递了简历"（智联 grant 状态 + BOSS 主动投递）。
  function isAppliedResumeRecord(record) {
    if (!record) return false;
    if (record.resumeApplied === true) return true;
    const t = String(record.messageType || '');
    return /resumeApplied|resumeWithGreeting|bossResumeApplied/.test(t);
  }

  // 判断记录是否应计入"已投递公司"去重名单（播种和聊天页记录写入共用同一口径）：
  // 1) 真的投出简历（智联投递成功 / BOSS 开启 bossAutoApply 后投递成功）；
  // 2) BOSS 沟通成功即计入（bossGreetingCountsAsApplied，BOSS 默认不投简历、需 HR 回复后
  //    才能发简历，所以"招呼语送达"就是一次有效投递）——只认 BOSS 平台的 sent 记录，
  //    智联的纯打招呼记录不计入。
  function shouldCountAppliedRecord(record) {
    if (!record) return false;
    if (isAppliedResumeRecord(record)) return true;
    if (!config.bossGreetingCountsAsApplied) return false;
    if (record.countedAsApplied === true) return true; // 写入时已按当时的开关固化
    if (String(record.status || '') !== 'sent') return false;
    const t = String(record.messageType || '');
    const isBossRecord = record.platform === 'boss' ||
      /^boss/i.test(t) ||
      /zhipin\.com/i.test(String(record.pageUrl || ''));
    return isBossRecord;
  }

  // 侧栏 UI：只负责配置收集、状态展示、记录列表渲染和按钮事件分发。
  // 自动选择岗位、发送消息、返回列表等业务动作放在 Service/Automation 中，避免 UI 直接驱动复杂流程。
  // 实时调试日志：内存环形记录 + 侧栏「日志」页渲染（BOSS 页面禁用 DevTools，用面板替代控制台）。
  // 开启「记录」后事件才会另存到 localStorage 供导出；面板始终显示最近事件。
  const LogWindow = {
    maxRecords: 500,
    maxPanelLines: 200,
    panelBodyEl: null,
    panelCountEl: null,
    formatButton: null,
    records: [],
    formatMode: 'human',
    formatModeKey: '__zhipin_log_format_mode_v2__',
    // 页面筛选只影响显示和复制，不改变已采集的记录。
    filter: { level: '', keyword: '', autoScroll: true },
    summaryEls: null,
    // 本次运行摘要：每次启动重置，停止后保留，清空日志不会清掉摘要。
    session: {
      active: false,
      startedAt: 0,
      endedAt: 0,
      label: '本次运行',
      state: 'idle',
      reason: '',
      success: 0,
      failed: 0,
      skipped: 0,
      failureTypes: {},
      lastFailure: '',
      failureKeys: new Set(),
    },
    _durationTimer: null,

    // 从 localStorage 恢复日志格式偏好。
    initFormatMode() {
      try {
        const savedMode = localStorage.getItem(this.formatModeKey);
        if (savedMode === 'human' || savedMode === 'machine') this.formatMode = savedMode;
      } catch (_) {}
    },

    updateFormatButton() {
      const button = this.formatButton;
      if (!button) return;
      button.textContent = this.formatMode === 'machine' ? '人易读' : '机器格式';
      button.title = this.formatMode === 'machine' ? '切换到人易读格式' : '切换到机器格式（原始数据）';
    },

    // 复制当前筛选后的日志：始终用机器格式，避免切换成易读格式后丢失排查信息。
    copyLogs() {
      const rows = this.getFilteredRecords();
      const text = rows.map((item) => item.line).join('\n');
      if (!text) {
        UI.setLogStatus(this.hasActiveFilter() ? '当前筛选没有可复制的日志' : '暂无日志可复制', 'warn');
        return;
      }
      const suffix = this.hasActiveFilter() ? '（筛选后）' : '';
      const done = () => UI.setLogStatus(`已复制 ${rows.length} 条日志${suffix}到剪贴板`, 'ok');
      const fallback = () => {
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
          done();
        } catch (error) {
          UI.setLogStatus(`复制日志失败：${error.message || error}`, 'error');
        }
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
      } catch (_) {
        fallback();
      }
    },

    // 运行日志：仅在投递运行时采集；停止后保留 5 秒宽限，补录暂停/报错等收尾事件。
    isCaptureActive() {
      const root = runtime.ui && runtime.ui.root;
      if (root && root.classList.contains('za-running')) return true;
      return Number(runtime.logGraceUntil || 0) > Date.now();
    },

    // 每次启动任务时清空上一轮日志，并重置本次运行摘要。
    startSession(label) {
      this.records = [];
      this.clearBadge();
      if (this._durationTimer) {
        clearInterval(this._durationTimer);
        this._durationTimer = null;
      }
      this.session = {
        active: true,
        startedAt: Date.now(),
        endedAt: 0,
        label: label || '自动投递',
        state: 'running',
        reason: '',
        success: 0,
        failed: 0,
        skipped: 0,
        failureTypes: {},
        lastFailure: '',
        failureKeys: new Set(),
      };
      this._durationTimer = setInterval(() => this.updateRunSummary(), 1000);
      this.renderPanelPreview();
      this.updateRunSummary();
    },

    // 结束本次运行摘要；日志仍可继续保留，供事后查看。
    endSession(reason) {
      if (!this.session) return;
      if (!this.session.active) {
        if (reason) this.session.reason = reason;
        this.updateRunSummary();
        return;
      }
      this.session.active = false;
      this.session.endedAt = Date.now();
      this.session.state = /停止|暂停|失败|错误|中断|离开|无效|失效/.test(String(reason || ''))
        ? 'stopped'
        : 'done';
      this.session.reason = reason || '本次运行已结束';
      if (this._durationTimer) {
        clearInterval(this._durationTimer);
        this._durationTimer = null;
      }
      this.updateRunSummary();
    },

    // 追加一条日志：写入内存环形记录，并在日志页可见时实时渲染。
    // 只在投递运行期间采集，空闲浏览页面时的事件直接丢弃，避免日志页堆满无关记录。
    append(type, data, level) {
      try {
        if (!this.isCaptureActive()) return;
        const line = this.formatLine(type, data, level);
        if (!line) return;
        const record = { type, data, level, line, time: new Date() };
        this.records.push(record);
        if (this.records.length > this.maxRecords) {
          this.records.splice(0, this.records.length - this.maxRecords);
        }
        const kind = this.classifyRecord(record);
        if (kind && this.session) {
          let countIt = true;
          if (kind === 'failed' || kind === 'skipped') {
            const outcomeKey = this.getFailureKey(record);
            const bucketName = kind === 'failed' ? 'failureKeys' : 'skipKeys';
            if (!this.session[bucketName]) this.session[bucketName] = new Set();
            if (outcomeKey) {
              if (this.session[bucketName].has(outcomeKey)) {
                countIt = false;
              } else {
                this.session[bucketName].add(outcomeKey);
              }
            }
          }
          if (countIt) {
            this.session[kind] += 1;
            if (kind === 'failed') {
              const failureType = String(record.type || '');
              if (failureType) {
                this.session.failureTypes[failureType] = (this.session.failureTypes[failureType] || 0) + 1;
                this.session.lastFailure = failureType;
              }
            }
          }
        }
        this.updateRunSummary();
        if (this.panelBodyEl && runtime.ui && runtime.ui.root
          && runtime.ui.root.classList.contains('za-open')
          && this.panelBodyEl.offsetParent !== null) {
          this.appendPanelLine(record);
        } else {
          this.bumpBadge();
        }
      } catch (_) {}
    },

    // 未查看日志时在侧边栏「日志」上累计未读条数。
    bumpBadge() {
      const badge = runtime.ui && runtime.ui.logBadge;
      if (!badge) return;
      const next = Number(badge.dataset.count || 0) + 1;
      badge.dataset.count = String(next);
      badge.textContent = next > 99 ? '99+' : String(next);
      badge.hidden = false;
    },

    clearBadge() {
      const badge = runtime.ui && runtime.ui.logBadge;
      if (!badge) return;
      badge.dataset.count = '0';
      badge.textContent = '';
      badge.hidden = true;
    },

    // 生成一条日志行；人易读格式下不可展示的事件返回 null。
    createLineRow(record) {
      const line = this.formatMode === 'human'
        ? this.formatHumanLine(record.type, record.data, record.level, record.time)
        : record.line;
      if (!line) return null;
      const row = document.createElement('div');
      const type = String(record.type || '');
      const statusClass = /failed|error|missing|timeout/i.test(type) ? ' za-log-error'
        : /rejected|skip|not_match/i.test(type) ? ' za-log-skip'
          : /accepted|sent|completed|success/i.test(type) ? ' za-log-success' : '';
      row.className = `za-log-line${statusClass}${record.level === 'warn' ? ' za-log-warn' : ''}`;
      row.textContent = line;
      return row;
    },

    // 面板「日志」页绑定实时日志容器。
    attachPanel(bodyEl, countEl, formatButton) {
      this.panelBodyEl = bodyEl || null;
      this.panelCountEl = countEl || null;
      this.formatButton = formatButton || null;
      this.initFormatMode();
      this.updateFormatButton();
      this.renderPanelPreview();
    },

    // 绑定日志页顶部「本次运行」摘要元素。
    attachRunSummary(els) {
      this.summaryEls = els || null;
      this.updateRunSummary();
    },

    // 刷新运行摘要：定时器只负责刷新时长，计数由 append 实时累加。
    updateRunSummary() {
      const els = this.summaryEls;
      if (!els) return;
      const session = this.session || {};
      const started = Number(session.startedAt || 0);
      const endAt = session.active ? Date.now() : Number(session.endedAt || 0);
      const duration = started ? Math.max(0, endAt - started) : 0;

      if (els.title) els.title.textContent = started ? (session.label || '本次运行') : '尚未开始';
      if (els.state) {
        const state = !started ? 'idle' : session.active ? 'running' : (session.state === 'stopped' ? 'stopped' : 'done');
        els.state.dataset.state = state;
        els.state.textContent = !started
          ? '未开始'
          : session.active
            ? '运行中'
            : (session.state === 'stopped' ? '已停止' : '已完成');
      }
      if (els.duration) els.duration.textContent = started ? this.formatDuration(duration) : '--';
      if (els.success) els.success.textContent = String(session.success || 0);
      const failureText = this.getFailureSummary();
      if (els.failed) {
        els.failed.textContent = String(session.failed || 0);
        els.failed.title = failureText ? `失败明细：${failureText}` : '本次运行失败或岗位处理异常次数';
      }
      if (els.skipped) els.skipped.textContent = String(session.skipped || 0);
      if (els.reason) {
        const success = Number(session.success || 0);
        const skipped = Number(session.skipped || 0);
        const progress = `成功 ${success} · 跳过 ${skipped}`;
        els.reason.textContent = !started
          ? '启动投递后，这里会显示本次运行结果'
          : session.active
            ? (failureText
              ? `运行中：${progress}；异常 ${session.failed || 0} 次（${failureText}）`
              : `运行中：${progress}`)
            : (failureText
              ? `${session.reason || '本次运行已结束'}（${progress}；异常 ${session.failed || 0} 次：${failureText}）`
              : `${session.reason || '本次运行已结束'}（${progress}）`);
      }
    },

    // 失败明细：按事件类型聚合，便于直接看出是沟通按钮、发送还是岗位处理异常。
    getFailureSummary() {
      const types = this.session && this.session.failureTypes ? this.session.failureTypes : {};
      const entries = Object.keys(types)
        .filter((type) => Number(types[type]) > 0)
        .sort((a, b) => Number(types[b]) - Number(types[a]));
      return entries
        .slice(0, 2)
        .map((type) => `${this.getFailureLabel(type)} ×${types[type]}`)
        .join('、');
    },

    // 同一岗位/联系人只计一次失败，避免「沟通按钮未找到」和外层「岗位处理异常」重复计数。
    getFailureKey(record) {
      const data = record && record.data && typeof record.data === 'object' ? record.data : {};
      const job = data.job && typeof data.job === 'object' ? data.job : {};
      const jobName = data.jobName || job.jobName || data.detailJobName || '';
      const company = data.company || job.company || '';
      if (jobName || company) return `job:${jobName}|${company}`;
      if (data.name) return `contact:${data.name}`;
      if (data.jobKey) return `jobkey:${data.jobKey}`;
      return '';
    },

    getFailureLabel(type) {
      const labels = {
        delivery_chat_button_missing: '沟通按钮未找到',
        delivery_send_failed: '问候发送失败',
        delivery_card_failed_continue: '岗位处理异常',
        delivery_scan_step_failed_continue: '扫描异常',
        chat_input_timeout: '聊天输入框超时',
        zhilian_apply_button_missing: '智联投递按钮未找到',
        zhilian_apply_unconfirmed: '智联投递未确认',
        zhilian_greeting_input_missing: '智联招呼输入框未找到',
        zhilian_login_required: '智联登录失效',
        send_current_error: '当前岗位发送异常',
      };
      return labels[type] || String(type || '未知原因').replace(/^(delivery|zhilian)_/, '').replace(/_/g, ' ');
    },

    formatDuration(ms) {
      const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      if (total < 60) return `${total}秒`;
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return `${minutes}分${total % 60}秒`;
      const hours = Math.floor(minutes / 60);
      return `${hours}时${minutes % 60}分`;
    },

    // 将事件归类到运行摘要；只统计真正的发送成功、失败和跳过，避免匹配/轮次事件被误计。
    classifyRecord(record) {
      const type = String(record && record.type || '');
      if (!type) return '';
      if (record.level === 'error') return 'failed';
      if (/^(?:delivery_message_sent|zhilian_greeting_injected|delivery_builtin_greeting_completed|boss_apply_done|model_test_ok)$/.test(type)) {
        return 'success';
      }
      // 智联：只有确认投递成功（applied !== false）才计成功，未确认走失败提示，避免虚增。
      if (type === 'zhilian_apply_done') {
        const data = record.data && typeof record.data === 'object' ? record.data : {};
        return data.applied === false ? '' : 'success';
      }
      if (/^delivery_match_rejected$/.test(type) || /^skip_/.test(type)) {
        return 'skipped';
      }
      if (/^(?:delivery_send_failed|delivery_card_failed_continue|delivery_scan_step_failed_continue|delivery_chat_button_missing|send_current_error|zhilian_greeting_input_missing|zhilian_apply_button_missing|zhilian_apply_unconfirmed|zhilian_login_required|chat_input_timeout)$/.test(type)) {
        return 'failed';
      }
      return '';
    },

    // 日志筛选：级别 + 关键词；输入变化时重绘，不改动原始记录。
    setFilter(patch) {
      this.filter = Object.assign({ level: '', keyword: '', autoScroll: true }, this.filter, patch || {});
      this.renderPanelPreview();
    },

    hasActiveFilter() {
      return Boolean(this.filter.level || String(this.filter.keyword || '').trim());
    },

    matchesFilter(record) {
      const level = this.filter.level;
      const type = String(record && record.type || '');
      const isError = Boolean(record && (record.level === 'error'
        || /failed|error|timeout|missing|hidden|rejected/i.test(type)));
      const isWarn = Boolean(record && record.level === 'warn' && !isError);
      if (level === 'error' && !isError) return false;
      if (level === 'warn' && !isWarn) return false;
      if (level === 'info' && (isError || isWarn)) return false;
      const keyword = String(this.filter.keyword || '').trim().toLowerCase();
      if (keyword) {
        const text = `${type} ${record && record.line || ''}`.toLowerCase();
        if (!text.includes(keyword)) return false;
      }
      return true;
    },

    getFilteredRecords() {
      return this.records.filter((record) => this.matchesFilter(record));
    },

    buildEmptyRow(text) {
      const row = document.createElement('div');
      row.className = 'za-log-empty';
      row.textContent = text || '启动投递后，这里会显示本次运行的日志';
      return row;
    },

    // 全量重绘面板预览；用于切换 Tab、清空日志、切换日志格式、筛选日志。
    renderPanelPreview() {
      const body = this.panelBodyEl;
      if (!body) return;
      body.innerHTML = '';
      const records = this.getFilteredRecords().slice(-this.maxPanelLines);
      const fragment = document.createDocumentFragment();
      records.forEach((record) => {
        const row = this.createLineRow(record);
        if (row) fragment.appendChild(row);
      });
      if (!fragment.childNodes.length) {
        fragment.appendChild(this.buildEmptyRow(this.records.length
          ? (this.hasActiveFilter() ? '没有符合筛选条件的日志' : '暂无可显示的事件，可切换到机器格式查看')
          : '启动投递后，这里会显示本次运行的日志'));
      }
      body.appendChild(fragment);
      if (this.filter.autoScroll) body.scrollTop = body.scrollHeight;
      this.updatePanelCount();
    },

    // 单条追加，避免每条日志都全量重绘。
    appendPanelLine(record) {
      const body = this.panelBodyEl;
      if (!body) return;
      const row = this.createLineRow(record);
      if (!row) return;
      if (!this.matchesFilter(record)) {
        this.updatePanelCount();
        return;
      }
      const empty = body.querySelector('.za-log-empty');
      if (empty) empty.remove();
      body.appendChild(row);
      while (body.childElementCount > this.maxPanelLines) body.removeChild(body.firstElementChild);
      if (this.filter.autoScroll) body.scrollTop = body.scrollHeight;
      this.updatePanelCount();
    },

    updatePanelCount() {
      if (!this.panelCountEl) return;
      const visible = this.getFilteredRecords().length;
      const total = this.records.length;
      this.panelCountEl.textContent = visible === total
        ? String(Math.min(total, this.maxPanelLines))
        : `${Math.min(visible, this.maxPanelLines)}/${total}`;
      this.panelCountEl.title = this.hasActiveFilter()
        ? `筛选后 ${visible} 条，共 ${total} 条`
        : `共 ${total} 条`;
    },

    clear() {
      this.records = [];
      this.renderPanelPreview();
      UI.setLogStatus('实时日志已清空', 'info');
    },

    toggleFormat() {
      this.formatMode = this.formatMode === 'machine' ? 'human' : 'machine';
      try { localStorage.setItem(this.formatModeKey, this.formatMode); } catch (_) {}
      this.updateFormatButton();
      this.renderPanelPreview();
    },

    // 机器格式：保留原有时间 + 事件类型 + 单行数据摘要。
    formatLine(type, data, level) {
      let detail = '';
      try {
        if (/^delivery_/.test(String(type)) && data && typeof data === 'object') {
          const job = [data.jobName, data.company].filter(Boolean).join(' / ') || '未知岗位';
          const score = data.score === undefined ? '' : ` 匹配度=${data.score}分${data.grade ? `(${data.grade})` : ''}`;
          const reason = data.reason ? ` 原因=${data.reason}` : '';
          const keywords = Array.isArray(data.reasons) && data.reasons.length ? ` 命中=${data.reasons.join('、')}` : '';
          const message = data.messagePreview ? ` 内容=${String(data.messagePreview).slice(0, 80)}` : '';
          detail = `${job}${score}${reason}${keywords}${message}`;
        } else {
          detail = JSON.stringify(data);
        }
        if (detail && detail.length > 500) detail = `${detail.slice(0, 500)}…`;
      } catch (_) {
        detail = String(data);
      }
      const time = new Date().toTimeString().slice(0, 8);
      return `[${time}] [${type}] ${detail || ''}`;
    },

    // 人易读格式：按事件类型规整标题和字段，底层原始记录不变。
    formatHumanLine(type, data, level, recordedAt) {
      const time = recordedAt instanceof Date ? recordedAt.toTimeString().slice(0, 8) : new Date().toTimeString().slice(0, 8);
      const labels = {
        delivery_match_candidate: '岗位候选',
        delivery_city_match: '城市判断',
        delivery_salary_match: '薪资判断',
        delivery_match_score: '关键词判断',
        delivery_match_accepted: '岗位通过',
        delivery_match_rejected: '岗位跳过',
        delivery_chat_button_missing: '沟通按钮未找到',
        delivery_stay_page_dialog: '留在此页弹窗',
        delivery_message_sent: '问候发送成功',
        delivery_send_failed: '问候发送失败',
        delivery_random_switch_delay: '岗位切换等待',
        delivery_card_failed_continue: '岗位处理异常',
        delivery_scan_step_failed_continue: '扫描异常',
      };
      const visibleTypes = new Set(Object.keys(labels));
      if (!visibleTypes.has(String(type))) return '';
      const title = labels[type] || String(type || '日志').replace(/^(delivery|score)_/, '').replace(/_/g, ' ');
      const source = data && typeof data === 'object' ? data : {};
      const job = source.job || source.pendingJob || {};
      const fields = [];
      const add = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        if (Array.isArray(value)) { if (value.length) fields.push(`${label}：${value.join('、')}`); return; }
        const text = String(value).replace(/[\r\n]+/g, ' ').trim();
        if (text) fields.push(`${label}：${text.slice(0, 120)}`);
      };
      add('岗位', source.jobName || job.jobName || source.detailJobName);
      add('公司', source.company || job.company);
      add('薪资', source.salary || job.salary);
      add('解析', source.parsedRange);
      add('城市', source.city || job.city);
      add('按钮', source.buttonText || source.chatButtonText);
      add('匹配度', source.score === undefined ? undefined : `${source.score}分${source.grade ? `（${source.grade}）` : ''}`);
      add('正面词', source.positiveMatches);
      add('反面词', source.negativeMatches);
      add('命中', source.reasons);
      add('原因', source.reason);
      add('状态', source.status);
      add('等待', source.delaySeconds === undefined ? undefined : `${source.delaySeconds}秒`);
      add('错误', source.error || source.message);
      add('内容', source.messagePreview);
      const body = fields.length ? fields.join(' | ') : '已记录';
      return `[${time}] ${title}${body ? `：${body}` : ''}`;
    },
  };

  const UI = {
    // 创建侧边面板 DOM、注入样式、初始化表单和虚拟列表。
    mount() {
      injectNewStyle();

      // 获取当前平台名称
      const platformName = currentPlatform?.name || '未检测';
      const platformIcon = currentPlatform?.id === 'boss' ? '💼' :
                           currentPlatform?.id === 'zhilian' ? '📋' :
                           currentPlatform?.id === '51job' ? '👔' :
                           currentPlatform?.id === 'liepin' ? '🔍' : '⚡';

      const root = document.createElement('div');
      root.id = 'zhipin-auto-greeting-root';
      root.dataset.version = APP.version;
      root.innerHTML = `
        <button class="za-toggle" type="button" title="显示/隐藏 ${platformName}助手">
          <span class="za-toggle-icon">${platformIcon}</span>
          <span class="za-toggle-text">${platformName}助手</span>
        </button>
        <aside class="za-window" aria-label="${platformName}自动沟通控制台">
          <header class="za-titlebar" data-ui-role="draggableHeader">
            <div class="za-title">
              <span class="za-logo">${platformIcon}</span>
              <div class="za-title-text">
                <strong>${platformName}助手</strong>
                <span class="za-subtitle">v${APP.version}</span>
              </div>
            </div>
            <div class="za-window-controls">
              <div class="za-tool-group" title="透明度">
                <button class="za-icon-btn za-tool-btn" type="button" data-action="decreaseOpacity" title="降低透明度 (Ctrl+↓)">−</button>
                <span class="za-opacity-indicator" data-role="opacityIndicator">100%</span>
                <button class="za-icon-btn za-tool-btn" type="button" data-action="increaseOpacity" title="提高透明度 (Ctrl+↑)">+</button>
              </div>
              <button class="za-icon-btn" type="button" data-action="toggleFeaturePanel" aria-expanded="false" title="板块管理">☰</button>
              <button class="za-icon-btn" type="button" data-action="toggleLogWindow" data-role="logToggle" title="打开日志页">▤</button>
              <button class="za-icon-btn" type="button" data-action="minimizeWindow" title="最小化">▾</button>
              <button class="za-icon-btn" type="button" data-action="toggle" title="收起">×</button>
            </div>
          </header>

          <div class="za-feature-panel" data-role="featurePanel" hidden>
            <div class="za-feature-panel-head">
              <strong>板块管理</strong>
              <button class="za-icon-btn" type="button" data-action="closeFeaturePanel" title="关闭板块管理" aria-label="关闭板块管理">×</button>
            </div>
            <div class="za-feature-list" data-role="featureBlockList"></div>
          </div>

          <div class="za-main">
            <nav class="za-sidebar" role="tablist">
              <button class="za-nav-item za-tab za-tab-active" type="button" role="tab" aria-selected="true" data-tab-target="tabDelivery" title="投递">
                <span class="za-nav-icon">📋</span>
                <span class="za-nav-label">投递</span>
              </button>
              <button class="za-nav-item za-tab" type="button" role="tab" aria-selected="false" data-tab-target="tabData" title="数据">
                <span class="za-nav-icon">📊</span>
                <span class="za-nav-label">数据</span>
              </button>
              <button class="za-nav-item za-tab" type="button" role="tab" aria-selected="false" data-tab-target="tabLog" title="日志">
                <span class="za-nav-icon">📝</span>
                <span class="za-nav-label">日志</span>
                <span class="za-nav-badge" data-role="logBadge" hidden></span>
              </button>
            </nav>

            <div class="za-content">
              <!-- 投递 Tab -->
              <div class="za-pane za-pane-active" data-tab-name="tabDelivery">
                <div class="za-status" data-role="status">等待启动</div>

                <!-- 平台信息 -->
                <section class="za-section" data-feature-section="platformInfo">
                  <h3>当前平台</h3>
                  <div class="za-platform-info">
                    <div class="za-platform-current">
                      <span class="za-platform-icon">${platformIcon}</span>
                      <span class="za-platform-name">${platformName}</span>
                      <span class="za-platform-badge">已连接</span>
                    </div>
                    <p class="za-hint">支持的平台：BOSS直聘、智联招聘、前程无忧、猎聘</p>
                  </div>
                </section>

                <section class="za-section" data-feature-section="greeting">
                  <h3>打招呼配置</h3>
                  <label class="za-check"><input data-field="useCustomGreeting" type="checkbox"> 使用自定义打招呼（默认使用 BOSS 内置问候语）</label>
                  <label class="za-check"><input data-field="bossAutoApply" type="checkbox"> BOSS 沟通前主动投递简历（未勾选则仅打招呼不投简历）</label>
                  <div class="za-radio-row">
                    <label><input type="radio" name="za-greeting-mode" value="fastReply"> 常用语</label>
                    <label><input type="radio" name="za-greeting-mode" value="customText"> 自定义文本</label>
                  </div>

                  <div class="za-mode-block" data-mode-block="fastReply">
                    <input data-field="fastReplyIndex" type="hidden">
                    <div class="za-fast-reply-control">
                      <button class="za-fast-reply-trigger" type="button" data-action="toggleFastReplyPicker" aria-expanded="false" aria-haspopup="dialog">
                        <span data-role="fastReplyTriggerText">选择常用语</span>
                        <span class="za-fast-reply-arrow">▾</span>
                      </button>
                      <button type="button" data-action="refreshFastReplies">刷新</button>
                    </div>
                    <div class="za-fast-reply-preview" data-role="fastReplyPreview"></div>
                    <p class="za-hint" data-role="fastReplyHint">关闭“使用自定义打招呼”时，以上内容不参与投递，使用 BOSS 页面内置问候语。</p>
                  </div>

                  <div class="za-fast-reply-backdrop" data-role="fastReplyBackdrop" hidden>
                    <div class="za-fast-reply-dialog" role="dialog" aria-modal="true" aria-label="选择常用语">
                      <div class="za-fast-reply-head">
                        <div>
                          <strong>选择常用语</strong>
                          <span data-role="fastReplyCount">0 条</span>
                        </div>
                        <button class="za-icon-btn" type="button" data-action="closeFastReplyPicker" title="关闭">×</button>
                      </div>
                      <div class="za-fast-reply-search">
                        <input data-role="fastReplySearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索常用语内容">
                        <button type="button" data-action="clearFastReplySearch">清空</button>
                      </div>
                      <div class="za-fast-reply-list" data-role="fastReplyList"></div>
                    </div>
                  </div>

                  <div class="za-mode-block" data-mode-block="customText">
                    <div class="za-segment" aria-label="自定义文本来源">
                      <label><input type="radio" name="za-text-source" value="text"> 手动输入</label>
                      <label><input type="radio" name="za-text-source" value="api"> 接口返回</label>
                    </div>

                    <div class="za-source-block" data-text-source-block="text">
                      <label class="za-label">问候文本</label>
                      <textarea data-field="customText" rows="4" placeholder="支持 {jobName}、{company}、{salary}、{bossName} 等占位符"></textarea>
                    </div>

                    <div class="za-source-block za-api-panel" data-text-source-block="api">
                      <div class="za-api-endpoint">
                        <label>接口地址
                          <input data-field="customApiUrl" type="url" placeholder="https://example.com/greeting?job={jobName}">
                        </label>
                        <label class="za-api-method">方法
                          <select data-field="customApiMethod">
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="PATCH">PATCH</option>
                          </select>
                        </label>
                      </div>
                      <label>URL 参数
                        <textarea data-field="customApiParams" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;scene=boss&#10;job={jobName}'></textarea>
                      </label>
                      <label>请求头
                        <textarea data-field="customApiHeaders" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;Authorization=Bearer xxx&#10;X-Source=zhipin'></textarea>
                      </label>
                      <label>请求体
                        <textarea data-field="customApiBody" rows="4" placeholder='POST/PUT/PATCH 可用；留空时发送默认岗位 JSON。支持 {jobName}、{company} 等占位符。'></textarea>
                      </label>
                      <label>返回文本路径
                        <input data-field="customApiResponsePath" type="text" placeholder="例如 data.text；留空则自动识别 message/text/content">
                      </label>
                      <p class="za-hint">参数、请求头和请求体都支持 JSON 对象，也支持每行 key=value。</p>
                    </div>
                  </div>
                </section>

                <section class="za-section" data-feature-section="strategy">
                  <h3>运行策略</h3>
                  <p class="za-hint">岗位去重仅在本轮投递中生效；「跳过历史已沟通岗位」则读取本地历史记录，跨批次、刷新后依然生效。</p>
                  <label class="za-check"><input data-field="collectGreetedJobs" type="checkbox"> 收集已打招呼岗位信息</label>
                  <label class="za-check"><input data-field="skipContacted" type="checkbox"> 跳过历史已沟通岗位（跨批次）</label>
                  <label class="za-check"><input data-field="ignoreListRefresh" type="checkbox"> 无视列表刷新</label>
                  <label class="za-check"><input data-field="autoRefreshOnExhausted" type="checkbox"> 列表耗尽后自动刷新</label>
                  <div class="za-grid-2">
                    <label>岗位切换最小间隔(秒)<input data-field="delayMin" type="number" min="1" step="1"></label>
                    <label>岗位切换最大间隔(秒)<input data-field="delayMax" type="number" min="1" step="1"></label>
                    <label>等待上限(秒)<input data-field="waitTimeout" type="number" min="2" step="1"></label>
                    <label>聊天重试次数<input data-field="chatOpenRetries" type="number" min="0" step="1"></label>
                    <label>最大沟通数<input data-field="maxCount" type="number" min="0" step="1"></label>
                    <label>列表刷新上限<input data-field="maxListRefresh" type="number" min="0" step="1" title="当前列表耗尽后最多整页刷新次数，0 表示不限制"></label>
                  </div>
                </section>

                <section class="za-section" data-feature-section="cityFilter">
                  <h3>城市筛选</h3>
                  <label>允许城市列表（命中任意城市即可）
                    <input data-field="allowedCities" type="text" placeholder="留空不限制城市；例如：北京,上海,深圳">
                  </label>
                  <p class="za-hint">支持逗号、中文逗号或换行分隔；留空表示不限制城市，未命中时跳过岗位。</p>
                </section>

                <section class="za-section" data-feature-section="companyFilter">
                  <h3>公司筛选</h3>
                  <div class="za-inline">
                    <select data-field="companyFilterMode">
                      <option value="exact">全量匹配</option>
                      <option value="partial">部分匹配</option>
                      <option value="regex">正则匹配</option>
                    </select>
                    <input data-field="companyFilterValue" type="text" autocomplete="off" spellcheck="false" placeholder="留空则不过滤">
                  </div>
                </section>

                <section class="za-section" data-feature-section="companyBlacklist">
                  <h3>公司黑名单</h3>
                  <div class="za-inline">
                    <select data-field="companyBlacklistMode">
                      <option value="exact">全量匹配</option>
                      <option value="partial">部分匹配</option>
                      <option value="regex">正则匹配</option>
                    </select>
                    <input data-field="companyBlacklistValue" type="text" autocomplete="off" spellcheck="false" placeholder="输入公司黑名单">
                    <button type="button" data-action="addCompanyBlacklistRule">添加</button>
                  </div>
                  <div class="za-multi-dropdown" data-role="companyBlacklistDropdown">
                    <button class="za-multi-trigger" type="button" data-action="toggleCompanyBlacklistDropdown" aria-expanded="false">
                      <span data-role="companyBlacklistDropdownText">查看已添加黑名单</span>
                      <span class="za-multi-arrow">⌄</span>
                    </button>
                    <div class="za-multi-menu" data-role="companyBlacklistOptionMenu" hidden></div>
                  </div>
                  <div class="za-inline za-blacklist-actions" data-role="companyBlacklistActions">
                    <button type="button" data-action="removeCompanyBlacklistRule">删除选中</button>
                    <button type="button" class="za-danger-soft" data-action="clearCompanyBlacklistRules">全部删除</button>
                  </div>
                  <p class="za-hint">任意黑名单命中都会在沟通前跳过该公司。</p>
                </section>

                <section class="za-section" data-feature-section="appliedCompany">
                  <h3>已投递公司去重</h3>
                  <label class="za-check-line">
                    <input data-field="skipAppliedCompany" type="checkbox">
                    <span>跳过历史已投递过简历的公司</span>
                  </label>
                  <label class="za-check-line">
                    <input data-field="bossGreetingCountsAsApplied" type="checkbox">
                    <span>BOSS 沟通成功也计入（BOSS 需 HR 回复后才能发简历）</span>
                  </label>
                  <div class="za-inline">
                    <span class="za-muted-text" data-role="appliedCompanyCount"></span>
                    <button type="button" class="za-danger-soft" data-action="clearAppliedCompanies">清空名单</button>
                  </div>
                  <p class="za-hint">独立持久化，清理投递记录不会清除本名单。投递/沟通成功后自动记录公司名；想重新投某公司时点「清空名单」。</p>
                </section>

                <section class="za-section" data-feature-section="bossActive">
                  <h3>Boss活跃度筛选</h3>
                  <div class="za-selected-area" data-role="bossActiveSelectedList"></div>
                  <div class="za-multi-dropdown" data-role="bossActiveDropdown">
                    <button class="za-multi-trigger" type="button" data-action="toggleBossActiveDropdown" aria-expanded="false">
                      <span data-role="bossActiveDropdownText">选择 Boss 活跃度</span>
                      <span class="za-multi-arrow">⌄</span>
                    </button>
                    <div class="za-multi-menu" data-role="bossActiveOptionMenu" hidden></div>
                  </div>
                  <div class="za-inline za-boss-active-add">
                    <input data-role="bossActiveCustomInput" data-lock-field="bossActiveCustomInput" type="text" autocomplete="off" spellcheck="false" placeholder="添加自定义活跃度">
                    <button type="button" data-action="addBossActiveOption">添加</button>
                  </div>
                  <div class="za-option-chips" data-role="bossActiveCustomList"></div>
                  <p class="za-hint">不选择代表不过滤；内置选项固定，自定义选项可删除。</p>
                </section>

                <section class="za-section" data-feature-section="salaryFilter">
                  <h3>薪资筛选</h3>
                  <label class="za-check"><input data-field="salaryFilterEnabled" type="checkbox"> 启用薪资区间筛选</label>
                  <div class="za-grid-2">
                    <label>最低月薪（K）<input data-field="salaryMinK" type="number" min="0" step="0.5" placeholder="如 10"></label>
                    <label>最高月薪（K）<input data-field="salaryMaxK" type="number" min="0" step="0.5" placeholder="0 表示不限"></label>
                  </div>
                  <label>薪资匹配方式
                    <select data-field="salaryMatchMode">
                      <option value="contain">严格：岗位薪资区间需完全落在设定范围内</option>
                      <option value="overlap">宽松：与设定区间有重叠即保留</option>
                    </select>
                  </label>
                  <p class="za-salary-state" data-role="salaryFilterState">当前未启用</p>
                  <p class="za-hint">严格模式下最高填 10K 时，7000-12000 元会跳过；宽松模式则保留（有重叠）。未填的一端视为不限，“面议/保密”无法解析时保留；上下限都填 0 视为不启用。支持 8-12K、1.5-2万、20-30万/年、200元/天 等写法，13薪等未折算。</p>
                </section>

                <section class="za-section" data-feature-section="score">
                  <h3>评分筛选</h3>
                  <label class="za-check"><input data-field="scoreEnabled" type="checkbox"> 启用关键词评分</label>
                  <label class="za-check"><input data-field="scoreHighlight" type="checkbox"> 高亮岗位卡片</label>
                  <label class="za-check"><input data-field="scoreAutoSkipLow" type="checkbox"> 自动跳过低分岗位沟通</label>
                  <label class="za-check"><input data-field="scoreTitleNegativeReject" type="checkbox"> 岗位名含负面词直接跳过</label>
                  <label>正面关键词（逗号分隔）
                    <textarea data-field="scorePositive" rows="3" placeholder="命中加分，例如：Linux,Docker,运维"></textarea>
                  </label>
                  <label>负面关键词（逗号分隔）
                    <textarea data-field="scoreNegative" rows="3" placeholder="命中大幅扣分，例如：销售,直播,风电"></textarea>
                  </label>
                  <div class="za-grid-2">
                    <label>正面权重<input data-field="scorePositiveWeight" type="number" min="1" step="1"></label>
                    <label>负面权重<input data-field="scoreNegativeWeight" type="number" min="1" step="1"></label>
                  </div>
                  <div class="za-grid-2">
                    <label>岗位名加权<input data-field="scoreTitleBonus" type="number" min="0" step="1"></label>
                    <label>技能加权<input data-field="scoreSkillBonus" type="number" min="0" step="1"></label>
                  </div>
                  <div class="za-grid-2">
                    <label>负面·岗位名扣分<input data-field="scoreNegativeTitleBonus" type="number" min="0" step="1"></label>
                    <label style="align-items:flex-start">核心词必中
                      <textarea data-field="coreTerms" rows="2" placeholder="岗位需命中其一才投，留空不启用。如：Java,Spring,后端"></textarea>
                    </label>
                  </div>
                  <div class="za-grid-2">
                    <label>高分阈值<input data-field="scoreGoodThreshold" type="number" min="0" step="1"></label>
                    <label>中分阈值<input data-field="scoreMidThreshold" type="number" min="0" step="1"></label>
                  </div>
                  <div class="za-score-result" data-role="scoreResultList"></div>
                  <p class="za-hint">过滤规则：核心词必中优先（启用后岗位需命中其一才投）；岗位名直接含负面词则硬否决（不看分数，开启"岗位名含负面词直接跳过"时生效）；good/mid 通过；low 分且有正面词命中也通过；low 分无命中或有负面词命中则跳过。计分按长词优先去重（如 Java 与 Java后端 对同一段文字只计一次，不再叠分）；岗位名和技能命中额外加分；负面词在岗位名命中时按"负面·岗位名扣分"再额外扣。否定前缀（如"不招运维"）自动忽略。多词技能用空格分隔（如 Spring Boot）。</p>
                </section>

                <section class="za-section" data-feature-section="model">
                  <h3>模型配置</h3>
                  <label class="za-check"><input data-field="modelEnabled" type="checkbox"> 启用模型</label>
                  <label class="za-check"><input data-field="modelScoreEnabled" type="checkbox"> 模型语义评分（可选）</label>
                  <label>API 地址
                    <input data-field="modelBaseUrl" type="url" placeholder="https://api.openai.com/v1/chat/completions">
                  </label>
                  <label>API Key
                    <input data-field="modelApiKey" type="password" placeholder="sk-..." autocomplete="off">
                  </label>
                  <label>模型名称
                    <input data-field="modelName" type="text" placeholder="gpt-4o-mini">
                  </label>
                  <div class="za-inline">
                    <button type="button" data-action="testModel">测试模型</button>
                  </div>
                  <p class="za-hint">模型为可选能力：启用后评分会附加语义分（-10~+20）。API Key 仅保存在浏览器 localStorage，不会上传到其他位置。</p>
                </section>

                <section class="za-section za-list-section" data-feature-section="greetedList">
                  <h3>已沟通列表 <span class="za-list-count" data-role="greetedCount">0</span>
                    <button type="button" class="za-list-refresh" data-action="refreshGreeted" title="从本地记录重新读取">刷新</button>
                  </h3>
                  <div class="za-list-viewport" data-role="listViewport">
                    <div class="za-list-spacer" data-role="listSpacer"></div>
                    <div class="za-list-items" data-role="listItems"></div>
                  </div>
                </section>
              </div>

              <!-- 数据 Tab -->
              <div class="za-pane" data-tab-name="tabData" hidden>
                <section class="za-section">
                  <h3>数据概览</h3>
                  <div class="za-stat-grid">
                    <div class="za-stat-card">
                      <span class="za-stat-label">今日投递</span>
                      <strong class="za-stat-value za-stat-accent" data-role="dataStatToday">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">累计投递</span>
                      <strong class="za-stat-value" data-role="dataStatTotal">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">已跳过</span>
                      <strong class="za-stat-value" data-role="dataStatSkipped">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">记录总数</span>
                      <strong class="za-stat-value" data-role="dataStatCount">0</strong>
                    </div>
                  </div>
                  <div class="za-trend" data-role="dataTrend"></div>
                  <p class="za-hint" data-role="dataStatsMeta">统计自本机岗位记录，启动投递后这里会显示数据</p>
                </section>

                <section class="za-section za-data-list-section">
                  <h3>最近记录</h3>
                  <div class="za-data-filters">
                    <input type="search" data-role="recordSearch" placeholder="搜索岗位或公司" autocomplete="off" spellcheck="false">
                    <select data-role="recordStatus">
                      <option value="">全部状态</option>
                      <option value="sent">已投递</option>
                      <option value="clicked">已点击</option>
                      <option value="skipped">已跳过</option>
                    </select>
                  </div>
                  <div class="za-record-list" data-role="recordList">
                    <div class="za-record-empty">暂无岗位记录</div>
                  </div>
                  <p class="za-hint" data-role="recordListMeta">启动投递后，这里会显示最近的岗位记录</p>
                </section>

                <section class="za-section" data-feature-section="export">
                  <h3>数据导出</h3>
                  <div class="za-inline">
                    <select data-field="exportType">
                      <option value="json">JSON</option>
                      <option value="xlsx">Excel</option>
                    </select>
                    <button type="button" data-action="export">导出岗位记录</button>
                  </div>
                </section>

                <section class="za-section" data-feature-section="cleanup">
                  <h3>数据清理</h3>
                  <label class="za-cleanup-time">删除此时间前的记录
                    <input data-field="clearBeforeTime" type="datetime-local">
                  </label>
                  <div class="za-inline">
                    <button type="button" data-action="clearRecordsByTime">按时间删除</button>
                    <button type="button" class="za-danger-soft" data-action="clearAllRecords">删除所有记录</button>
                  </div>
                  <p class="za-hint">按时间删除会使用发送时间，未发送记录使用点击或更新时间。</p>
                </section>
              </div>

              <!-- 日志 Tab -->
              <div class="za-pane" data-tab-name="tabLog" hidden>
                <section class="za-section">
                  <h3>本次运行</h3>
                  <div class="za-run-summary" data-role="runSummary">
                    <div class="za-run-summary-head">
                      <span class="za-run-summary-title" data-role="runSummaryTitle">尚未开始</span>
                      <span class="za-run-summary-state" data-role="runSummaryState">未开始</span>
                    </div>
                    <div class="za-run-summary-grid">
                      <div><span>时长</span><strong data-role="runDuration">--</strong></div>
                      <div><span>成功</span><strong data-role="runSuccess">0</strong></div>
                      <div><span>失败/异常</span><strong data-role="runFailed">0</strong></div>
                      <div><span>跳过</span><strong data-role="runSkipped">0</strong></div>
                    </div>
                    <p class="za-run-summary-reason" data-role="runReason">启动投递后，这里会显示本次运行结果</p>
                  </div>
                </section>

                <section class="za-section">
                  <h3>诊断日志</h3>

                  <div class="za-log-summary">
                    <div class="za-log-summary-main">
                      <span class="za-log-dot" data-role="debugLogDot"></span>
                      <div class="za-log-summary-text">
                        <div class="za-log-state" data-role="debugLogState">未开启</div>
                        <div class="za-log-meta" data-role="debugLogStatus">已保存 0 条事件</div>
                      </div>
                    </div>
                    <label class="za-switch" title="开启后把诊断事件保存到本机，便于导出排查">
                      <input data-role="debugLogEnabled" type="checkbox">
                      <span class="za-switch-track"></span>
                      <span class="za-switch-label">记录</span>
                    </label>
                  </div>

                  <div class="za-log-actions">
                    <button type="button" class="za-primary" data-action="copyDebugLogs">复制日志</button>
                    <button type="button" data-action="exportDebugLogs">导出</button>
                    <button type="button" class="za-danger-soft" data-action="clearDebugLogs">清除</button>
                  </div>
                  <p class="za-log-feedback" data-role="logFeedback" hidden></p>

                  <div class="za-log-filters">
                    <select data-role="logLevelFilter" title="按日志级别筛选">
                      <option value="">全部级别</option>
                      <option value="info">信息</option>
                      <option value="warn">警告</option>
                      <option value="error">错误</option>
                    </select>
                    <input data-role="logSearch" type="search" placeholder="搜索岗位 / 公司 / 事件" autocomplete="off" spellcheck="false">
                    <label class="za-log-autoscroll" title="新日志出现时自动滚动到底部">
                      <input data-role="logAutoScroll" type="checkbox" checked> 自动滚动
                    </label>
                  </div>

                  <div class="za-log-preview">
                    <div class="za-log-preview-head">
                      <span title="仅在投递运行期间记录，每次启动会清空上一轮">实时日志 · 运行时</span>
                      <span class="za-log-preview-tools">
                        <button type="button" class="za-log-format" data-action="toggleLogFormat" data-role="logFormatToggle">机器格式</button>
                        <span class="za-log-preview-count" data-role="logPanelCount">0</span>
                      </span>
                    </div>
                    <div class="za-log-preview-body" data-role="logPanelBody">
                      <div class="za-log-empty">运行后这里会实时显示事件</div>
                    </div>
                  </div>

                  <p class="za-hint">实时日志只在投递运行期间记录，每次启动会清空上一轮并最多保留 500 条；平时浏览岗位不产生日志。打开「记录」后事件才会保存到本机并支持导出，不会上传。级别和关键词筛选只影响当前显示与复制，不会删除记录。</p>
                </section>
              </div>
            </div>
          </div>

          <footer class="za-footer">
            <button type="button" class="za-primary" data-action="start">▶ 启动</button>
            <button type="button" class="za-danger" data-action="stop">■ 停止</button>
          </footer>

          <div class="za-resize-handle" data-ui-role="resizeHandle" title="拖拽调整窗口大小"></div>
        </aside>
      `;

      document.body.appendChild(root);
      runtime.ui = {
        root,
        panel: root.querySelector('.za-window'),
        window: root.querySelector('.za-window'),
        toggle: root.querySelector('.za-toggle'),
        status: root.querySelector('[data-role="status"]'),
        opacityIndicator: root.querySelector('[data-role="opacityIndicator"]'),
        resizeHandle: root.querySelector('[data-ui-role="resizeHandle"]'),
        featurePanel: root.querySelector('[data-role="featurePanel"]'),
        featureButton: root.querySelector('[data-action="toggleFeaturePanel"]'),
        featureBlockList: root.querySelector('[data-role="featureBlockList"]'),
        fastReplyInput: root.querySelector('[data-field="fastReplyIndex"]'),
        fastReplyTrigger: root.querySelector('[data-action="toggleFastReplyPicker"]'),
        fastReplyTriggerText: root.querySelector('[data-role="fastReplyTriggerText"]'),
        fastReplyPreview: root.querySelector('[data-role="fastReplyPreview"]'),
        fastReplyHint: root.querySelector('[data-role="fastReplyHint"]'),
        fastReplyBackdrop: root.querySelector('[data-role="fastReplyBackdrop"]'),
        fastReplyCount: root.querySelector('[data-role="fastReplyCount"]'),
        fastReplySearch: root.querySelector('[data-role="fastReplySearch"]'),
        fastReplyList: root.querySelector('[data-role="fastReplyList"]'),
        bossActiveDropdown: root.querySelector('[data-role="bossActiveDropdown"]'),
        bossActiveDropdownText: root.querySelector('[data-role="bossActiveDropdownText"]'),
        bossActiveSelectedList: root.querySelector('[data-role="bossActiveSelectedList"]'),
        bossActiveOptionMenu: root.querySelector('[data-role="bossActiveOptionMenu"]'),
        bossActiveCustomInput: root.querySelector('[data-role="bossActiveCustomInput"]'),
        bossActiveCustomList: root.querySelector('[data-role="bossActiveCustomList"]'),
        companyBlacklistDropdown: root.querySelector('[data-role="companyBlacklistDropdown"]'),
        companyBlacklistDropdownText: root.querySelector('[data-role="companyBlacklistDropdownText"]'),
        companyBlacklistOptionMenu: root.querySelector('[data-role="companyBlacklistOptionMenu"]'),
        companyBlacklistRemoveButton: root.querySelector('[data-action="removeCompanyBlacklistRule"]'),
        companyBlacklistClearButton: root.querySelector('[data-action="clearCompanyBlacklistRules"]'),
        companyBlacklistSelectedIds: new Set(),
        appliedCompanyCount: root.querySelector('[data-role="appliedCompanyCount"]'),
        debugLogEnabled: root.querySelector('[data-role="debugLogEnabled"]'),
        debugLogStatus: root.querySelector('[data-role="debugLogStatus"]'),
        debugLogState: root.querySelector('[data-role="debugLogState"]'),
        debugLogDot: root.querySelector('[data-role="debugLogDot"]'),
        logPanelBody: root.querySelector('[data-role="logPanelBody"]'),
        logPanelCount: root.querySelector('[data-role="logPanelCount"]'),
        logFormatToggle: root.querySelector('[data-role="logFormatToggle"]'),
        logBadge: root.querySelector('[data-role="logBadge"]'),
        logFeedback: root.querySelector('[data-role="logFeedback"]'),
        listViewport: root.querySelector('[data-role="listViewport"]'),
        listSpacer: root.querySelector('[data-role="listSpacer"]'),
        listItems: root.querySelector('[data-role="listItems"]'),
        greetedCount: root.querySelector('[data-role="greetedCount"]'),
        salaryFilterState: root.querySelector('[data-role="salaryFilterState"]'),
        greetedRows: [],
        rowHeight: 48,
        scoreResultList: root.querySelector('[data-role="scoreResultList"]'),
        logToggle: root.querySelector('[data-role="logToggle"]'),
        recordSearch: root.querySelector('[data-role="recordSearch"]'),
        recordStatus: root.querySelector('[data-role="recordStatus"]'),
        recordList: root.querySelector('[data-role="recordList"]'),
        recordListMeta: root.querySelector('[data-role="recordListMeta"]'),
        dataStatToday: root.querySelector('[data-role="dataStatToday"]'),
        dataStatTotal: root.querySelector('[data-role="dataStatTotal"]'),
        dataStatSkipped: root.querySelector('[data-role="dataStatSkipped"]'),
        dataStatCount: root.querySelector('[data-role="dataStatCount"]'),
        dataTrend: root.querySelector('[data-role="dataTrend"]'),
        dataStatsMeta: root.querySelector('[data-role="dataStatsMeta"]'),
        logLevelFilter: root.querySelector('[data-role="logLevelFilter"]'),
        logSearch: root.querySelector('[data-role="logSearch"]'),
        logAutoScroll: root.querySelector('[data-role="logAutoScroll"]'),
      };

      LogWindow.attachPanel(runtime.ui.logPanelBody, runtime.ui.logPanelCount, runtime.ui.logFormatToggle);
      LogWindow.attachRunSummary({
        title: root.querySelector('[data-role="runSummaryTitle"]'),
        state: root.querySelector('[data-role="runSummaryState"]'),
        duration: root.querySelector('[data-role="runDuration"]'),
        success: root.querySelector('[data-role="runSuccess"]'),
        failed: root.querySelector('[data-role="runFailed"]'),
        skipped: root.querySelector('[data-role="runSkipped"]'),
        reason: root.querySelector('[data-role="runReason"]'),
      });

      this.prepareConfigFields();
      this.renderFeatureBlockControls();
      this.bindEvents();
      this.applyConfigToForm();
      this.renderDebugLogControls();
      this.renderFastReplyOptions();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
      this.setFeaturePanelOpen(config.featurePanelOpen);
      this.setPanelOpen(config.panelOpen);
      this.scheduleConfigReapply();
      this.refreshGreetedList();
      this.refreshDataOverview();

      // 常用语是 BOSS 专属接口，仅在 BOSS 平台自动拉取，避免智联等平台请求 BOSS 接口报 404。
      if (currentPlatform?.id === 'boss' && (!config.fastReplies || !config.fastReplies.length)) {
        setTimeout(() => FastReplyService.refresh(false), 500);
      }
    },

    // 给脚本自己的配置控件设置独立字段名，并关闭浏览器自动填充/历史恢复。
    prepareConfigFields() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-field]').forEach((field) => {
        const key = field.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        field.setAttribute('autocomplete', 'off');
        field.setAttribute('autocorrect', 'off');
        field.setAttribute('autocapitalize', 'off');
        if (field.matches('input, textarea')) field.setAttribute('spellcheck', 'false');
        if (field.matches('input, textarea, select') && !field.name) {
          field.name = `zhipin-auto-${key}`;
        }
      });
    },

    // 部分浏览器会在 DOM 插入后异步恢复旧表单值；用户未触碰前用配置值覆盖回去。
    scheduleConfigReapply() {
      [0, 120, 600].forEach((delay) => {
        setTimeout(() => {
          if (!runtime.ui || runtime.configFormTouched) return;
          this.applyConfigToForm();
          this.renderFastReplyOptions();
          this.updateAppliedCompanyCount();
        }, delay);
      });
    },

    // 绑定面板按钮和表单事件；按钮只分发到对应 Service/Automation。
    bindEvents() {
      const root = runtime.ui.root;

      ['pointerdown', 'keydown', 'paste', 'drop'].forEach((eventName) => {
        root.addEventListener(eventName, (event) => this.noteConfigFieldInteraction(event), true);
      });

      root.addEventListener('click', (event) => {
        // Tab 切换
        const tabBtn = event.target && event.target.closest && event.target.closest('[data-tab-target]');
        if (tabBtn && tabBtn.dataset && tabBtn.dataset.tabTarget) {
          const targetName = tabBtn.dataset.tabTarget;
          this.switchTab(targetName);
          return;
        }

        const eventTarget = event.target && event.target.nodeType === 1
          ? event.target
          : event.target && event.target.parentElement;

        if (eventTarget && eventTarget.dataset && eventTarget.dataset.role === 'fastReplyBackdrop') {
          this.setFastReplyPickerOpen(false);
          return;
        }

        const target = eventTarget && eventTarget.closest('[data-action], .za-toggle');
        if (!target) return;

        const action = target.dataset.action || 'toggle';
        if (action === 'toggleFeaturePanel') {
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFeaturePanelOpen(!this.isFeaturePanelOpen());
          return;
        }
        if (action === 'closeFeaturePanel') {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (action === 'refreshGreeted') {
          this.refreshGreetedList({ scrollTop: true });
          this.setStatus('已刷新已沟通列表', 'info');
          return;
        }
        if (action === 'toggleFeatureBlock') {
          this.toggleFeatureBlock(target.dataset.featureId);
          return;
        }
        if (action === 'toggleFastReplyPicker') {
          this.setFeaturePanelOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFastReplyPickerOpen(!this.isFastReplyPickerOpen());
          return;
        }
        if (action === 'closeFastReplyPicker') {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (action === 'selectFastReply') {
          this.selectFastReply(target.dataset.index);
          return;
        }
        if (action === 'clearFastReplySearch') {
          this.setFastReplySearch('');
          return;
        }
        if (action === 'toggleBossActiveDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setBossActiveDropdownOpen(!this.isBossActiveDropdownOpen());
          return;
        }
        if (action === 'toggleCompanyBlacklistDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(!this.isCompanyBlacklistDropdownOpen());
          return;
        }
        if (action !== 'stop') this.unlockStatus();
        if (action === 'toggle') this.setPanelOpen(!config.panelOpen);
        if (action === 'minimizeWindow') this.minimizeWindow();
        if (action === 'increaseOpacity') this.setOpacity(Math.min(1, (runtime.uiOpacity ?? 1) + 0.1));
        if (action === 'decreaseOpacity') this.setOpacity(Math.max(0.3, (runtime.uiOpacity ?? 1) - 0.1));
        if (action === 'refreshFastReplies') FastReplyService.refresh(true);
        if (action === 'start') Automation.start();
        if (action === 'stop') Automation.stop('已停止', { manual: true });
        if (action === 'export') Exporter.exportRecords();
        if (action === 'exportDebugLogs') DebugLogService.exportLogs();
        if (action === 'clearRecordsByTime') RecordCleaner.clearByTime();
        if (action === 'clearAllRecords') RecordCleaner.clearAll();
        if (action === 'clearDebugLogs') DebugLogService.clearLogs();
        if (action === 'testModel') ScoreService.testModel();
        if (action === 'toggleLogWindow') this.openLogTab();
        if (action === 'copyDebugLogs') LogWindow.copyLogs();
        if (action === 'toggleLogFormat') LogWindow.toggleFormat();
        if (action === 'addCompanyBlacklistRule') this.addCompanyBlacklistRule();
        if (action === 'removeCompanyBlacklistRule') this.removeCompanyBlacklistRule(target.dataset.id);
        if (action === 'clearCompanyBlacklistRules') this.clearCompanyBlacklistRules();
        if (action === 'clearAppliedCompanies') this.clearAppliedCompanies();
        if (action === 'addBossActiveOption') this.addBossActiveCustomOption();
        if (action === 'deleteBossActiveOption') this.deleteBossActiveCustomOption(target.dataset.value);
        if (action === 'removeBossActiveSelection') this.removeBossActiveSelection(target.dataset.value);
        if (action !== 'toggleBossActiveDropdown' && !target.closest('[data-role="bossActiveDropdown"]')) {
          this.setBossActiveDropdownOpen(false);
        }
        if (
          action !== 'toggleCompanyBlacklistDropdown' &&
          !target.closest('[data-role="companyBlacklistDropdown"]') &&
          !target.closest('[data-role="companyBlacklistActions"]')
        ) {
          this.setCompanyBlacklistDropdownOpen(false);
        }
      });

      root.addEventListener('input', (event) => {
        const inputRole = event.target && event.target.dataset && event.target.dataset.role;
        if (inputRole === 'fastReplySearch') {
          this.renderFastReplyPickerList();
          return;
        }
        if (inputRole === 'recordSearch') {
          this.renderRecordList(runtime.dataOverviewRows || []);
          return;
        }
        if (inputRole === 'logSearch') {
          LogWindow.setFilter({ keyword: event.target.value });
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        this.saveFormToConfig({ event });
        this.syncSalaryFilterState(event);
      });
      root.addEventListener('change', (event) => {
        const changeRole = event.target && event.target.dataset && event.target.dataset.role;
        if (changeRole === 'debugLogEnabled') {
          DebugLogService.setEnabled(event.target.checked);
          return;
        }
        if (changeRole === 'recordStatus') {
          this.renderRecordList(runtime.dataOverviewRows || []);
          return;
        }
        if (changeRole === 'logLevelFilter') {
          LogWindow.setFilter({ level: event.target.value });
          return;
        }
        if (changeRole === 'logAutoScroll') {
          LogWindow.setFilter({ autoScroll: event.target.checked });
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        if (event.target && event.target.dataset && event.target.dataset.role === 'companyBlacklistRuleOption') {
          this.setCompanyBlacklistRuleSelected(event.target.value, event.target.checked, true);
          return;
        }
        if (event.target && event.target.dataset && event.target.dataset.role === 'bossActiveOption') {
          this.setBossActiveOptionSelected(event.target.value, event.target.checked, true);
          return;
        }
        this.saveFormToConfig({ event });
        this.applyModeVisibility();
        this.syncSalaryFilterState(event);
      });

      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.isFeaturePanelOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFeaturePanelOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isFastReplyPickerOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isCompanyBlacklistDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isBossActiveDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setBossActiveDropdownOpen(false);
          return;
        }

        if (event.key === 'Enter' && event.target && event.target.dataset && event.target.dataset.role === 'fastReplySearch') {
          const firstOption = runtime.ui.fastReplyList && runtime.ui.fastReplyList.querySelector('[data-action="selectFastReply"]');
          if (firstOption) {
            event.preventDefault();
            this.selectFastReply(firstOption.dataset.index);
          }
          return;
        }

        if (event.key !== 'Enter') return;
        if (event.target && event.target.dataset && event.target.dataset.field === 'companyBlacklistValue') {
          event.preventDefault();
          this.addCompanyBlacklistRule();
          return;
        }
        if (!event.target || !event.target.dataset || event.target.dataset.role !== 'bossActiveCustomInput') return;
        event.preventDefault();
        this.addBossActiveCustomOption();
      });

      // 节流滚动渲染：requestAnimationFrame 确保每帧最多渲染一次
      let _virtualListRaf = null;
      runtime.ui.listViewport.addEventListener('scroll', () => {
        if (_virtualListRaf) return;
        _virtualListRaf = requestAnimationFrame(() => {
          _virtualListRaf = null;
          this.renderVirtualList();
        });
      });

      pageWindow.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (this.isFeaturePanelOpen()) {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (this.isFastReplyPickerOpen()) {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (this.isCompanyBlacklistDropdownOpen()) {
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (this.isBossActiveDropdownOpen()) {
          this.setBossActiveDropdownOpen(false);
          return;
        }
        Automation.stop('已停止', { manual: true });
      });

      pageWindow.addEventListener('click', (event) => {
        if (!runtime.ui || !runtime.ui.root || this.isEventFromUiRoot(event)) return;
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      });

      // ============== 面板可拖拽 ==============
      this.initDraggable(root);
      // ============== 面板可调整大小 ==============
      this.initResizable(root);
      // ============== 透明度初始化 + 快捷键 ==============
      this.initOpacityAndShortcuts(root);
      // ============== Tab 初始化 ==============
      const savedTab = localStorage.getItem('__zhipin_ui_tab__') || 'tabDelivery';
      this.switchTab(savedTab, true);
    },

    // 切换 Tab
    switchTab(targetName, silent) {
      const ui = runtime.ui;
      if (!ui || !ui.root) return;
      // 兼容历史保存的 Tab 名（如已下线的复聊页）：目标面板不存在时回退到投递页。
      const paneExists = Array.from(ui.root.querySelectorAll('.za-pane'))
        .some((pane) => pane.dataset.tabName === targetName);
      if (!paneExists) targetName = 'tabDelivery';
      // 清除旧激活
      ui.root.querySelectorAll('.za-tab').forEach((btn) => {
        const isActive = btn.dataset.tabTarget === targetName;
        btn.classList.toggle('za-tab-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
      });
      ui.root.querySelectorAll('.za-pane').forEach((content) => {
        const isActive = content.dataset.tabName === targetName;
        content.classList.toggle('za-pane-active', isActive);
        if (isActive) {
          content.removeAttribute('hidden');
        } else {
          content.setAttribute('hidden', '');
        }
      });
      // 切到日志页时补渲染一次内存中的实时日志并清空未读角标。
      if (targetName === 'tabLog') {
        LogWindow.renderPanelPreview();
        LogWindow.updateRunSummary();
        LogWindow.clearBadge();
      }
      if (targetName === 'tabData') {
        this.refreshDataOverview();
      }
      if (targetName === 'tabDelivery') {
        this.refreshGreetedList();
      }
      // 激活投递 Tab 时，显示启动/停止按钮；其他 Tab 隐藏底部启动按钮
      const footer = ui.root.querySelector('.za-footer');
      if (footer) {
        if (targetName === 'tabDelivery') {
          footer.style.display = '';
          const startBtn = footer.querySelector('[data-action="start"]');
          const stopBtn = footer.querySelector('[data-action="stop"]');
          if (startBtn) startBtn.style.display = '';
          if (stopBtn) stopBtn.style.display = '';
        } else {
          footer.style.display = 'none';
        }
      }
      if (!silent) {
        try { localStorage.setItem('__zhipin_ui_tab__', targetName); } catch (_) {}
      }
    },

    // 最小化窗口（隐藏内容，只显示标题栏）
    minimizeWindow() {
      const ui = runtime.ui;
      if (!ui || !ui.window) return;
      ui.window.classList.toggle('za-window-minimized');
    },

    // 初始化透明度和快捷键
    initOpacityAndShortcuts(root) {
      let savedOpacity = 1;
      try {
        const v = parseFloat(localStorage.getItem('__zhipin_ui_opacity__'));
        if (!isNaN(v) && v >= 0.3 && v <= 1) savedOpacity = v;
      } catch (_) {}
      this.setOpacity(savedOpacity, true);

      // 快捷键：Ctrl+↑ 提高透明度，Ctrl+↓ 降低透明度
      const pageWindow = getAccessibleDocuments()[0] && getAccessibleDocuments()[0].defaultView || window;
      pageWindow.addEventListener('keydown', (event) => {
        if (!event.ctrlKey) return;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          this.setOpacity(Math.min(1, (runtime.uiOpacity ?? 1) + 0.1));
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          this.setOpacity(Math.max(0.3, (runtime.uiOpacity ?? 1) - 0.1));
        }
      });
    },

    // 设置面板透明度
    setOpacity(value, skipSave) {
      runtime.uiOpacity = Number(value) || 1;
      if (runtime.ui && runtime.ui.panel) {
        runtime.ui.panel.style.setProperty('opacity', String(runtime.uiOpacity));
      }
      if (runtime.ui && runtime.ui.toggle) {
        runtime.ui.toggle.style.setProperty('opacity', String(Math.min(1, runtime.uiOpacity + 0.2)));
      }
      if (runtime.ui && runtime.ui.opacityIndicator) {
        runtime.ui.opacityIndicator.textContent = Math.round(runtime.uiOpacity * 100) + '%';
      }
      if (!skipSave) {
        try { localStorage.setItem('__zhipin_ui_opacity__', String(runtime.uiOpacity)); } catch (_) {}
      }
    },

    // 初始化拖拽（头部拖拽面板）- 使用 pointer 事件 + pointerCapture，确保拖拽稳定
    initDraggable(root) {
      const header = root.querySelector('[data-ui-role="draggableHeader"]');
      const panel = root.querySelector('.za-window');
      if (!header || !panel) return;

      let dragState = null;
      // 恢复上次位置
      try {
        const savedPos = localStorage.getItem('__zhipin_ui_pos__');
        if (savedPos) {
          const pos = JSON.parse(savedPos);
          if (typeof pos.left === 'number' && typeof pos.top === 'number') {
            panel.style.left = pos.left + 'px';
            panel.style.top = pos.top + 'px';
            panel.style.right = 'auto';
          }
        }
      } catch (_) {}

      const onDown = (event) => {
        // 只拦截实际的按钮和输入元素，不拦截容器（如 .za-title、.za-title-text 等）
        if (event.target.closest('button, input, textarea, select')) return;
        const rect = panel.getBoundingClientRect();
        dragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          panelLeft: rect.left,
          panelTop: rect.top,
          panelWidth: rect.width,
          moved: false,
        };
        // pointerCapture 确保拖拽过程中所有 pointer 事件都派发给 header，即使鼠标移出 header
        try { header.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
      };

      const onMove = (event) => {
        if (!dragState) return;
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        let newLeft = dragState.panelLeft + dx;
        let newTop = dragState.panelTop + dy;
        // 边界限制：防止完全拖出屏幕（至少保留 80px 可见）
        const minLeft = -dragState.panelWidth + 80;
        const maxLeft = winW - 80;
        const minTop = 0;
        const maxTop = winH - 40;
        newLeft = Math.min(maxLeft, Math.max(minLeft, newLeft));
        newTop = Math.min(maxTop, Math.max(minTop, newTop));
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
      };

      const onUp = (event) => {
        if (!dragState) return;
        if (dragState.moved) {
          try {
            const rect = panel.getBoundingClientRect();
            localStorage.setItem('__zhipin_ui_pos__', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
          } catch (_) {}
        }
        try { header.releasePointerCapture(dragState.pointerId); } catch (_) {}
        dragState = null;
      };

      header.addEventListener('pointerdown', onDown);
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    },

    // 初始化窗口调整大小（右下角拖拽）
    initResizable(root) {
      const handle = root.querySelector('[data-ui-role="resizeHandle"]');
      const panel = root.querySelector('.za-window');
      if (!handle || !panel) return;

      let resizeState = null;

      // 恢复上次大小
      try {
        const savedSize = localStorage.getItem('__zhipin_ui_size__');
        if (savedSize) {
          const size = JSON.parse(savedSize);
          if (size.width && size.height) {
            panel.style.width = size.width + 'px';
            panel.style.height = size.height + 'px';
          }
        }
      } catch (_) {}

      const onDown = (event) => {
        const rect = panel.getBoundingClientRect();
        resizeState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startW: rect.width,
          startH: rect.height,
        };
        try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
        event.stopPropagation();
      };

      const onMove = (event) => {
        if (!resizeState) return;
        const dx = event.clientX - resizeState.startX;
        const dy = event.clientY - resizeState.startY;
        const minW = 320;
        const minH = 240;
        const maxW = Math.max(minW, window.innerWidth - 20);
        const maxH = Math.max(minH, window.innerHeight - 20);
        const newW = Math.min(maxW, Math.max(minW, resizeState.startW + dx));
        const newH = Math.min(maxH, Math.max(minH, resizeState.startH + dy));
        panel.style.width = newW + 'px';
        panel.style.height = newH + 'px';
      };

      const onUp = (event) => {
        if (!resizeState) return;
        try {
          const rect = panel.getBoundingClientRect();
          localStorage.setItem('__zhipin_ui_size__', JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) }));
        } catch (_) {}
        try { handle.releasePointerCapture(resizeState.pointerId); } catch (_) {}
        resizeState = null;
      };

      handle.addEventListener('pointerdown', onDown);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },

    // 记录用户真实触碰过配置控件，用于区分浏览器自动填充事件。
    noteConfigFieldInteraction(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return;
      field.dataset.userTouched = 'true';
      runtime.configFormTouched = true;
    },

    // 拦截浏览器自动恢复的旧表单值，避免覆盖 localStorage 中的真实配置。
    shouldIgnoreConfigFieldEvent(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return false;

      const key = field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return true;

      const hasUserSignal = field.dataset.userTouched === 'true' || document.activeElement === field || event.isTrusted === false;
      if (hasUserSignal) return false;

      this.restoreConfigFieldValue(field);
      logDebugEvent('ignored_config_autofill_event', {
        field: key,
        value: summarizeLongText(this.readConfigFieldValue(field)),
      }, 'warn');
      return true;
    },

    // 从任意事件目标向上查找脚本配置字段，并排除面板外元素。
    getConfigFieldFromTarget(target) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !target || !target.closest) return null;
      const field = target.closest('[data-field]');
      return field && root.contains(field) ? field : null;
    },

    // 判断事件是否起源于脚本 UI。composedPath 可覆盖点击后 DOM 被重绘移除的场景。
    isEventFromUiRoot(event) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !event) return false;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      if (path && path.includes(root)) return true;
      return Boolean(event.target && root.contains(event.target));
    },

    // 判断事件目标是否是问候模式/文本来源的单选项。
    isModeInput(target) {
      return Boolean(target && target.matches && target.matches('input[name="za-greeting-mode"], input[name="za-text-source"]'));
    },

    // 读取配置字段的 JS 值，统一处理 checkbox 和 number。
    readConfigFieldValue(field) {
      if (!field) return '';
      if (field.type === 'checkbox') return Boolean(field.checked);
      // 数字框留空保留为 ''，让读取方能区分"清空（用默认值）"和"显式填 0"。
      if (field.type === 'number') return field.value === '' ? '' : Number(field.value);
      return field.value;
    },

    // 将配置值写回表单字段，避免各处重复处理 checkbox/空值。
    setConfigFieldValue(field, value) {
      if (!field) return;
      if (field.type === 'checkbox') {
        field.checked = Boolean(value);
      } else {
        field.value = value == null ? '' : value;
      }
    },

    // 自动填充事件被忽略时，把字段恢复到当前配置值。
    restoreConfigFieldValue(field) {
      const key = field && field.dataset && field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return;
      this.setConfigFieldValue(field, config[key]);
    },

    // 判断板块管理选择区是否展开。
    isFeaturePanelOpen() {
      return Boolean(runtime.ui && runtime.ui.featurePanel && !runtime.ui.featurePanel.hidden);
    },

    // 展开/收起板块管理选择区；展开状态持久化，方便刷新后保持用户的工作上下文。
    setFeaturePanelOpen(open) {
      if (!runtime.ui || !runtime.ui.featurePanel) return;
      saveConfig({ featurePanelOpen: Boolean(open) });
      runtime.ui.featurePanel.hidden = !config.featurePanelOpen;
      runtime.ui.root.classList.toggle('za-feature-open', config.featurePanelOpen);
      if (runtime.ui.featureButton) {
        runtime.ui.featureButton.setAttribute('aria-expanded', config.featurePanelOpen ? 'true' : 'false');
      }
    },

    // 根据板块元数据渲染开关按钮；新增板块只需要补 FEATURE_BLOCK_DEFINITIONS。
    renderFeatureBlockControls() {
      if (!runtime.ui || !runtime.ui.featureBlockList) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.featureBlockList.innerHTML = FEATURE_BLOCK_DEFINITIONS.map((item) => {
        const enabled = blocks[item.id];
        const enabledClass = enabled ? ' za-enabled' : '';
        const readonlyClass = item.readonly ? ' za-readonly' : '';
        const stateText = item.readonly ? '固定' : enabled ? '开启' : '关闭';
        const disabled = item.readonly ? ' disabled' : '';
        const title = item.readonly
          ? `${item.title}固定开启`
          : `${enabled ? '关闭' : '开启'}${item.title}`;
        return `
          <button type="button" class="za-feature-switch${enabledClass}${readonlyClass}" data-action="toggleFeatureBlock" data-feature-id="${escapeHtml(item.id)}" aria-pressed="${enabled ? 'true' : 'false'}" title="${escapeHtml(title)}"${disabled}>
            <span>${escapeHtml(item.title)}</span>
            <span class="za-feature-state">${escapeHtml(stateText)}</span>
          </button>
        `;
      }).join('');
    },

    // 切换单个板块的显示状态，只读板块不允许关闭。
    toggleFeatureBlock(featureId) {
      const id = normalizeText(featureId);
      if (!FEATURE_BLOCK_ID_SET.has(id)) return;

      const definition = FEATURE_BLOCK_DEFINITIONS.find((item) => item.id === id);
      if (!definition || definition.readonly) return;

      const nextBlocks = normalizeFeatureBlocks(config.featureBlocks);
      nextBlocks[id] = !nextBlocks[id];
      saveConfig({ featureBlocks: nextBlocks });
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
    },

    // 把板块管理开关应用到实际 section；隐藏只影响面板展示，不清空已有配置。
    applyFeatureBlockVisibility() {
      if (!runtime.ui || !runtime.ui.root) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.root.querySelectorAll('[data-feature-section]').forEach((section) => {
        const id = section.dataset.featureSection;
        section.hidden = !blocks[id];
      });

      if (!blocks.companyBlacklist) this.setCompanyBlacklistDropdownOpen(false);
      if (!blocks.bossActive) this.setBossActiveDropdownOpen(false);
    },

    // 展开/收起面板并持久化到配置。
    setPanelOpen(open) {
      if (!open) {
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
      }
      saveConfig({ panelOpen: Boolean(open) });
      runtime.ui.root.classList.toggle('za-open', config.panelOpen);
    },

    // 标题栏 📋 入口：打开面板并切到日志页，滚动到实时日志区域。
    openLogTab() {
      this.setPanelOpen(true);
      this.switchTab('tabLog');
      const body = runtime.ui && runtime.ui.logPanelBody;
      if (body && body.scrollIntoView) {
        try { body.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      }
    },

    // 日志页内的操作反馈（顶部状态条在「投递」页，切到日志页后看不到）。
    setLogStatus(text, type) {
      const el = runtime.ui && runtime.ui.logFeedback;
      if (!el) return;
      if (this._logFeedbackTimer) clearTimeout(this._logFeedbackTimer);
      el.textContent = text || '';
      el.dataset.type = type || 'info';
      el.hidden = !text;
      if (!text) return;
      this._logFeedbackTimer = setTimeout(() => {
        el.hidden = true;
        el.textContent = '';
      }, 2600);
    },

    // 将配置写回表单控件，页面刷新或首次挂载时调用。
    applyConfigToForm() {
      const root = runtime.ui.root;
      this.clearAutoSyncedCompanyFilter();

      root.querySelectorAll('input[name="za-greeting-mode"]').forEach((input) => {
        input.checked = input.value === config.greetingMode;
      });
      root.querySelectorAll('input[name="za-text-source"]').forEach((input) => {
        input.checked = input.value === config.textSource;
      });

      for (const field of root.querySelectorAll('[data-field]')) {
        const key = field.dataset.field;
        if (key === 'fastReplyIndex') continue;
        this.setConfigFieldValue(field, config[key]);
      }

      this.applyModeVisibility();
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
      this.renderDebugLogControls();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
      this.renderSalaryFilterState();
    },

    // 薪资区间填写正数后自动勾选启用，避免只填了数值却忘记开开关。
    syncSalaryFilterState(event) {
      if (!runtime.ui || !runtime.ui.root) return;
      const field = event && event.target && event.target.dataset && event.target.dataset.field;
      if ((field === 'salaryMinK' || field === 'salaryMaxK')
        && Number(event.target.value) > 0
        && !config.salaryFilterEnabled) {
        saveConfig({ salaryFilterEnabled: true });
        const checkbox = runtime.ui.root.querySelector('[data-field="salaryFilterEnabled"]');
        if (checkbox) checkbox.checked = true;
      }
      this.renderSalaryFilterState();
    },

    // 显示薪资筛选的实时状态，能直接看出是否生效、生效区间与匹配方式。
    renderSalaryFilterState() {
      const el = runtime.ui && runtime.ui.salaryFilterState;
      if (!el) return;
      el.classList.remove('za-on', 'za-warn');
      if (!config.salaryFilterEnabled) {
        const minK = Math.max(0, Number(config.salaryMinK) || 0);
        const maxK = Math.max(0, Number(config.salaryMaxK) || 0);
        if (minK > 0 || maxK > 0) {
          el.textContent = '当前未启用：已填区间，请勾选上方“启用薪资区间筛选”';
          el.classList.add('za-warn');
        } else {
          el.textContent = '当前未启用';
        }
        return;
      }
      const required = getSalaryFilterRange();
      if (!required.active) {
        el.textContent = '已勾选启用，但上下限都是 0，暂不生效';
        return;
      }
      const min = required.minK > 0 ? `${formatSalaryK(required.minK)}K` : '';
      const max = required.maxK > 0 ? `${formatSalaryK(required.maxK)}K` : '';
      const mode = config.salaryMatchMode === 'overlap' ? '宽松' : '严格';
      const rangeText = min && max ? `${min}-${max}` : (min ? `${min} 以上` : `${max} 以下`);
      el.textContent = `当前生效（${mode}）：${rangeText}`;
      el.classList.add('za-on');
    },

    // 调试日志不属于运行配置，单独同步本地开关和日志条数。
    renderDebugLogControls() {
      if (!runtime.ui) return;
      const enabled = isDebugEnabled();
      if (runtime.ui.debugLogEnabled) {
        runtime.ui.debugLogEnabled.checked = enabled;
      }
      if (runtime.ui.debugLogStatus) {
        const count = loadStoredDebugEvents().length;
        runtime.ui.debugLogStatus.textContent = `已保存 ${count} 条事件`;
      }
      if (runtime.ui.debugLogState) {
        runtime.ui.debugLogState.textContent = enabled ? '记录中' : '未开启';
      }
      if (runtime.ui.debugLogDot) {
        runtime.ui.debugLogDot.dataset.on = enabled ? '1' : '0';
      }
    },

    // 从表单读取配置并保存；运行中会跳过被锁定的字段。
    saveFormToConfig(options) {
      const root = runtime.ui.root;
      const next = {};
      const eventTarget = options && options.event && options.event.target;
      const eventField = this.getConfigFieldFromTarget(eventTarget);
      const selectedMode = root.querySelector('input[name="za-greeting-mode"]:checked');
      if (selectedMode) next.greetingMode = selectedMode.value;
      const selectedTextSource = root.querySelector('input[name="za-text-source"]:checked');
      if (selectedTextSource) next.textSource = selectedTextSource.value;

      if (eventTarget && !eventField && !this.isModeInput(eventTarget)) {
        return;
      }

      if (eventField) {
        const key = eventField.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        if (key === 'companyFilterValue' && !this.shouldSaveCompanyFilterValue(eventField, eventTarget)) {
          delete next.companyFilterValue;
        } else {
          next[key] = this.readConfigFieldValue(eventField);
        }
      } else if (!eventTarget) {
        // 无事件来源时只刷新模式开关，不把浏览器可能恢复的隐藏字段值写回配置。
        const changedKeys = Object.keys(next).filter((key) => next[key] !== config[key]);
        if (!changedKeys.length) return;
      }

      if (Object.prototype.hasOwnProperty.call(next, 'fastReplyIndex')) {
        next.fastReplyIndex = Number(next.fastReplyIndex || 0);
      }
      saveConfig(next);
    },

    // 标记公司过滤输入框是否被用户手动编辑，避免被搜索词自动覆盖。
    noteCompanyFilterEdit(event) {
      const target = event && event.target;
      if (target && target.dataset && target.dataset.field === 'companyFilterValue') {
        runtime.companyFilterEdited = true;
        target.dataset.userEdited = 'true';
      }
    },

    // 判断公司过滤值是否应该写入配置，区分自动同步和用户输入。
    shouldSaveCompanyFilterValue(field, eventTarget) {
      if (!field) return false;
      if (runtime.companyFilterEdited || field.dataset.userEdited === 'true') return true;
      if (eventTarget === field) return true;
      return normalizeText(field.value) !== normalizeText(getCurrentSearchQuery());
    },

    // 用户切换过滤模式时，如果过滤值只是自动同步的搜索词，则清空。
    clearAutoSyncedCompanyFilter() {
      const query = normalizeText(getCurrentSearchQuery());
      if (!query || !config.companyFilterValue) return;
      if (normalizeText(config.companyFilterValue) !== query) return;

      saveConfig({ companyFilterValue: '' });
    },

    // 根据问候语模式/自定义文本来源，显示或隐藏对应配置块。
    applyModeVisibility() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-mode-block]').forEach((block) => {
        block.hidden = block.dataset.modeBlock !== config.greetingMode;
      });

      root.querySelectorAll('[data-text-source-block]').forEach((block) => {
        block.hidden = block.dataset.textSourceBlock !== config.textSource;
      });
      if (config.greetingMode !== 'fastReply') this.setFastReplyPickerOpen(false);
    },

    // 渲染常用语选择入口和预览；弹层列表用普通 DOM 承载长文本，避免原生 select 撑宽面板。
    renderFastReplyOptions() {
      if (!runtime.ui) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const selected = replies[selectedIndex];
      const selectedText = replies.length
        ? normalizeMessageText((selected && selected.text) || `常用语 ${selectedIndex + 1}`)
        : APP.defaultGreetingText;

      if (runtime.ui.fastReplyInput) {
        runtime.ui.fastReplyInput.value = String(selectedIndex);
      }
      if (runtime.ui.fastReplyTriggerText) {
        runtime.ui.fastReplyTriggerText.textContent = replies.length
          ? `已选 常用语 ${selectedIndex + 1}`
          : '未获取常用语';
      }
      if (runtime.ui.fastReplyTrigger) {
        const running = runtime.ui.root.classList.contains('za-running');
        runtime.ui.fastReplyTrigger.disabled = running || !replies.length;
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', this.isFastReplyPickerOpen() ? 'true' : 'false');
      }
      if (runtime.ui.fastReplyPreview) {
        runtime.ui.fastReplyPreview.textContent = selectedText;
        runtime.ui.fastReplyPreview.dataset.empty = replies.length ? 'false' : 'true';
      }

      runtime.ui.fastReplyHint.textContent = replies.length
        ? `已获取 ${replies.length} 条常用语；发送时会把所选文本直接注入聊天框。`
        : '获取常用语失败或未刷新时，会把默认问候语直接注入聊天框。';
      this.renderFastReplyPickerList();
    },

    // 计算常用语安全索引，防止刷新后缓存数量变化造成越界。
    getSafeFastReplyIndex(replies) {
      const total = Array.isArray(replies) ? replies.length : 0;
      if (!total) return 0;

      const index = Number(config.fastReplyIndex || 0);
      if (!Number.isFinite(index)) return 0;
      return Math.min(Math.max(Math.floor(index), 0), total - 1);
    },

    // 渲染常用语弹层列表，并按搜索词过滤候选项。
    renderFastReplyPickerList() {
      if (!runtime.ui || !runtime.ui.fastReplyList) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const keyword = normalizeText(runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value).toLowerCase();
      const matchedReplies = replies
        .map((item, index) => ({
          index,
          text: normalizeMessageText((item && item.text) || `常用语 ${index + 1}`),
        }))
        .filter((item) => !keyword || item.text.toLowerCase().includes(keyword));

      if (runtime.ui.fastReplyCount) {
        runtime.ui.fastReplyCount.textContent = keyword
          ? `${matchedReplies.length}/${replies.length} 条`
          : `${replies.length} 条`;
      }

      runtime.ui.fastReplyList.innerHTML = matchedReplies.length
        ? matchedReplies.map((item) => {
            const selectedClass = item.index === selectedIndex ? ' za-selected' : '';
            const selectedLabel = item.index === selectedIndex ? '<span class="za-fast-reply-selected-mark">当前选中</span>' : '';
            return `
              <button type="button" class="za-fast-reply-option${selectedClass}" data-action="selectFastReply" data-index="${item.index}" aria-pressed="${item.index === selectedIndex ? 'true' : 'false'}">
                <span class="za-fast-reply-option-meta">常用语 ${item.index + 1}${selectedLabel}</span>
                <span class="za-fast-reply-option-text">${escapeHtml(item.text)}</span>
              </button>
            `;
          }).join('')
        : `<div class="za-fast-reply-empty">${replies.length ? '没有匹配的常用语' : '暂无常用语，请先刷新'}</div>`;
    },

    // 判断常用语选择弹层是否打开。
    isFastReplyPickerOpen() {
      return Boolean(runtime.ui && runtime.ui.fastReplyBackdrop && !runtime.ui.fastReplyBackdrop.hidden);
    },

    // 打开/关闭常用语选择弹层，并在关闭时清空搜索框。
    setFastReplyPickerOpen(open) {
      if (!runtime.ui || !runtime.ui.fastReplyBackdrop) return;

      const replies = config.fastReplies || [];
      const trigger = runtime.ui.fastReplyTrigger;
      const shouldOpen = Boolean(open && replies.length && !(trigger && trigger.disabled));
      runtime.ui.fastReplyBackdrop.hidden = !shouldOpen;
      runtime.ui.root.classList.toggle('za-fast-reply-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

      if (shouldOpen) {
        this.renderFastReplyPickerList();
        setTimeout(() => {
          if (this.isFastReplyPickerOpen() && runtime.ui.fastReplySearch) runtime.ui.fastReplySearch.focus();
        }, 0);
        return;
      }

      if (runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value) {
        runtime.ui.fastReplySearch.value = '';
        this.renderFastReplyPickerList();
      }
    },

    // 更新常用语搜索词并重新渲染弹层列表。
    setFastReplySearch(value) {
      if (!runtime.ui || !runtime.ui.fastReplySearch) return;
      runtime.ui.fastReplySearch.value = value || '';
      this.renderFastReplyPickerList();
      runtime.ui.fastReplySearch.focus();
    },

    // 选择某条常用语并持久化索引。
    selectFastReply(index) {
      const replies = config.fastReplies || [];
      const nextIndex = Number(index);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= replies.length) return;

      saveConfig({ fastReplyIndex: nextIndex });
      this.renderFastReplyOptions();
      this.setFastReplyPickerOpen(false);
    },

    // 渲染公司黑名单下拉多选，每条规则展示匹配模式，便于区分全量/部分/正则。
    renderCompanyBlacklistRules() {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu) return;

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = this.getCompanyBlacklistSelectedIds(rules);
      const running = runtime.ui.root.classList.contains('za-running');
      runtime.ui.companyBlacklistOptionMenu.innerHTML = rules.length
        ? rules.map((rule) => {
            const checked = selectedIds.has(rule.id) ? ' checked' : '';
            const disabled = running ? ' disabled' : '';
            return `
              <div class="za-multi-option za-blacklist-option">
                <label class="za-blacklist-option-label">
                  <input data-role="companyBlacklistRuleOption" type="checkbox" value="${escapeHtml(rule.id)}"${checked}${disabled}>
                  <span title="${escapeHtml(rule.value)}">[${escapeHtml(getCompanyMatchModeLabel(rule.mode))}] ${escapeHtml(rule.value)}</span>
                </label>
                <button class="za-blacklist-delete" type="button" data-action="removeCompanyBlacklistRule" data-id="${escapeHtml(rule.id)}" title="删除该黑名单"${disabled}>×</button>
              </div>
            `;
          }).join('')
        : '<div class="za-empty-text">暂无公司黑名单</div>';

      if (runtime.ui.companyBlacklistDropdownText) {
        runtime.ui.companyBlacklistDropdownText.textContent = rules.length
          ? selectedIds.size
            ? `已选 ${selectedIds.size}/${rules.length} 条`
            : `已添加 ${rules.length} 条`
          : '暂无公司黑名单';
      }

      const trigger = runtime.ui.companyBlacklistDropdown &&
        runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      if (trigger) {
        trigger.disabled = running || !rules.length;
        trigger.setAttribute('aria-expanded', this.isCompanyBlacklistDropdownOpen() ? 'true' : 'false');
      }
      runtime.ui.companyBlacklistOptionMenu.querySelectorAll('input[data-role="companyBlacklistRuleOption"]').forEach((input) => {
        input.disabled = running;
      });
      if (runtime.ui.companyBlacklistRemoveButton) {
        runtime.ui.companyBlacklistRemoveButton.disabled = running || !selectedIds.size;
      }
      if (runtime.ui.companyBlacklistClearButton) {
        runtime.ui.companyBlacklistClearButton.disabled = running || !rules.length;
      }
      if (!rules.length) this.setCompanyBlacklistDropdownOpen(false);
    },

    // 获取当前用于删除的黑名单勾选项，并清掉已不存在的规则 ID。
    getCompanyBlacklistSelectedIds(rules) {
      const availableIds = new Set((rules || normalizeCompanyBlacklistRules(config.companyBlacklistRules)).map((rule) => rule.id));
      const selectedIds = runtime.ui.companyBlacklistSelectedIds instanceof Set
        ? runtime.ui.companyBlacklistSelectedIds
        : new Set();
      Array.from(selectedIds).forEach((id) => {
        if (!availableIds.has(id)) selectedIds.delete(id);
      });
      runtime.ui.companyBlacklistSelectedIds = selectedIds;
      return selectedIds;
    },

    // 判断公司黑名单下拉是否打开。
    isCompanyBlacklistDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.companyBlacklistOptionMenu && !runtime.ui.companyBlacklistOptionMenu.hidden);
    },

    // 打开/关闭公司黑名单下拉，并同步 aria 状态。
    setCompanyBlacklistDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu || !runtime.ui.companyBlacklistDropdown) return;
      const trigger = runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const shouldOpen = Boolean(open && rules.length && !(trigger && trigger.disabled));
      runtime.ui.companyBlacklistOptionMenu.hidden = !shouldOpen;
      runtime.ui.companyBlacklistDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个黑名单规则，仅影响“删除选中”的临时选择状态。
    setCompanyBlacklistRuleSelected(id, selected, keepDropdownOpen) {
      const key = normalizeText(id);
      if (!key || !runtime.ui) return;

      const selectedIds = this.getCompanyBlacklistSelectedIds();
      if (selected) {
        selectedIds.add(key);
      } else {
        selectedIds.delete(key);
      }
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 添加公司黑名单规则，保存前校验正则并按“模式+文本”去重。
    addCompanyBlacklistRule() {
      const root = runtime.ui && runtime.ui.root;
      if (!root) return;

      const modeField = root.querySelector('[data-field="companyBlacklistMode"]');
      const valueField = root.querySelector('[data-field="companyBlacklistValue"]');
      const mode = getCompanyMatchMode(modeField && modeField.value);
      const value = normalizeText(valueField && valueField.value);
      if (!value) {
        UI.setStatus('请输入公司黑名单文本', 'warn');
        return;
      }
      if (mode === 'regex') {
        try {
          new RegExp(value);
        } catch (error) {
          UI.setStatus(`公司黑名单正则无效：${error.message}`, 'error');
          return;
        }
      }

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const exists = rules.some((rule) => rule.mode === mode && rule.value === value);
      if (exists) {
        UI.setStatus('该公司黑名单已存在', 'warn');
        if (valueField) valueField.value = '';
        saveConfig({ companyBlacklistMode: mode, companyBlacklistValue: '' });
        return;
      }

      const key = `${mode}:${value}`;
      const nextRule = {
        id: `black_${hashString(`${key}:${Date.now()}`)}`,
        mode,
        value,
      };
      saveConfig({
        companyBlacklistMode: mode,
        companyBlacklistValue: '',
        companyBlacklistRules: rules.concat(nextRule),
      });
      if (valueField) valueField.value = '';
      this.renderCompanyBlacklistRules();
      UI.setStatus(`已添加公司黑名单：${getCompanyMatchModeLabel(mode)} / ${value}`, 'ok');
    },

    // 删除当前勾选的公司黑名单规则，支持一次删除多条。
    removeCompanyBlacklistRule(id) {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = id
        ? new Set([normalizeText(id)].filter(Boolean))
        : new Set(this.getCompanyBlacklistSelectedIds(rules));
      if (!selectedIds.size) {
        UI.setStatus('请选择要移除的公司黑名单', 'warn');
        return;
      }

      const nextRules = rules.filter((rule) => !selectedIds.has(rule.id));
      if (nextRules.length === rules.length) return;

      if (id) {
        this.getCompanyBlacklistSelectedIds(rules).delete(normalizeText(id));
      } else {
        runtime.ui.companyBlacklistSelectedIds = new Set();
      }
      saveConfig({ companyBlacklistRules: nextRules });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(nextRules.length));
      UI.setStatus(`已删除 ${rules.length - nextRules.length} 条公司黑名单`, 'ok');
    },

    // 删除全部公司黑名单规则。
    async clearCompanyBlacklistRules() {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      if (!rules.length) {
        UI.setStatus('暂无公司黑名单可删除', 'warn');
        return;
      }

      let confirmed = false;
      try {
        confirmed = await askConfirm(`将删除全部 ${rules.length} 条公司黑名单，此操作不可恢复。`, {
          title: '清空公司黑名单',
          confirmText: '确认清空',
        });
      } catch (error) {
        UI.setStatus(error.message || '无法打开确认弹窗', 'error');
        return;
      }
      if (!confirmed) return;

      runtime.ui.companyBlacklistSelectedIds = new Set();
      saveConfig({ companyBlacklistRules: [] });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(false);
      UI.setStatus('已删除全部公司黑名单', 'ok');
    },

    // 刷新已投递公司去重名单计数显示。
    async updateAppliedCompanyCount() {
      if (!runtime.ui || !runtime.ui.appliedCompanyCount) return;
      try {
        await AppliedCompanyIndex.ensureReady();
        const size = AppliedCompanyIndex.size();
        runtime.ui.appliedCompanyCount.textContent = `当前名单 ${size} 家公司`;
      } catch (_) {}
    },

    // 清空已投递公司去重名单（持久化、需二次确认）。
    async clearAppliedCompanies() {
      await AppliedCompanyIndex.ensureReady();
      const count = AppliedCompanyIndex.size();
      if (!count) {
        UI.setStatus('已投递公司名单为空，无需清空', 'warn');
        return;
      }
      let confirmed = false;
      try {
        confirmed = await askConfirm(`将清空已投递公司去重名单（共 ${count} 家公司）。清空后这些公司将可重新投递。此操作不可恢复。`, {
          title: '清空已投递公司名单',
          confirmText: '确认清空',
        });
      } catch (error) {
        UI.setStatus(error.message || '无法打开确认弹窗', 'error');
        return;
      }
      if (!confirmed) return;
      AppliedCompanyIndex.clear();
      UI.setStatus(`已清空 ${count} 家已投递公司去重名单`, 'ok');
      logDebugEvent('clear_applied_companies', { count, at: nowIso() }, 'info');
    },

    // 渲染 Boss 活跃度下拉多选、已选标签和自定义选项标签。
    renderBossActiveFilterOptions() {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu) return;

      const selectedKeys = new Set(getSelectedBossActiveKeys());
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const options = getBossActiveFilterOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveOptionMenu.innerHTML = options.map((item) => {
        const checked = selectedKeys.has(normalizeBossActiveText(item)) ? ' checked' : '';
        return `
          <label class="za-multi-option">
            <input data-role="bossActiveOption" type="checkbox" value="${escapeHtml(item)}"${checked}>
            <span>${escapeHtml(item)}</span>
          </label>
        `;
      }).join('');

      runtime.ui.bossActiveDropdownText.textContent = selectedOptions.length
        ? `已选 ${selectedOptions.length} 项`
        : '选择 Boss 活跃度';
      runtime.ui.bossActiveSelectedList.innerHTML = selectedOptions.length
        ? selectedOptions.map((item) => `
          <span class="za-selected-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="removeBossActiveSelection" data-value="${escapeHtml(item)}" title="移除该活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">未选择，默认不过滤 Boss 活跃度</span>';

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveCustomList.innerHTML = customOptions.length
        ? customOptions.map((item) => `
          <span class="za-option-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="deleteBossActiveOption" data-value="${escapeHtml(item)}" title="删除自定义活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">暂无自定义选项</span>';
    },

    // 判断 Boss 活跃度下拉是否打开。
    isBossActiveDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.bossActiveOptionMenu && !runtime.ui.bossActiveOptionMenu.hidden);
    },

    // 打开/关闭 Boss 活跃度下拉，并同步 aria 状态。
    setBossActiveDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu || !runtime.ui.bossActiveDropdown) return;
      const trigger = runtime.ui.bossActiveDropdown.querySelector('[data-action="toggleBossActiveDropdown"]');
      const shouldOpen = Boolean(open && !(trigger && trigger.disabled));
      runtime.ui.bossActiveOptionMenu.hidden = !shouldOpen;
      runtime.ui.bossActiveDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个 Boss 活跃度选项，并保存到配置。
    setBossActiveOptionSelected(value, selected, keepDropdownOpen) {
      const key = normalizeBossActiveText(value);
      if (!key) return;

      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const exists = selectedOptions.some((item) => normalizeBossActiveText(item) === key);
      let nextOptions = selectedOptions;
      if (selected && !exists) {
        nextOptions = selectedOptions.concat(getBossActiveOptionLabel(value));
      } else if (!selected) {
        nextOptions = selectedOptions.filter((item) => normalizeBossActiveText(item) !== key);
      }

      saveConfig({ bossActiveFilterValues: nextOptions });
      this.renderBossActiveFilterOptions();
      this.setBossActiveDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 从已选列表中移除某个 Boss 活跃度。
    removeBossActiveSelection(value) {
      this.setBossActiveOptionSelected(value, false);
    },

    // 添加自定义 Boss 活跃度选项，去重后写入配置。
    addBossActiveCustomOption() {
      if (!runtime.ui || !runtime.ui.bossActiveCustomInput) return;
      const input = runtime.ui.bossActiveCustomInput;
      const text = getBossActiveOptionLabel(input.value);
      const key = normalizeBossActiveText(text);
      if (!key) {
        UI.setStatus('请输入 Boss 活跃度文本', 'warn');
        return;
      }
      if (BOSS_ACTIVE_BUILTIN_KEYS.has(key)) {
        UI.setStatus('该活跃度已是内置选项', 'warn');
        input.value = '';
        return;
      }

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      if (customOptions.some((item) => normalizeBossActiveText(item) === key)) {
        UI.setStatus('该自定义活跃度已存在', 'warn');
        input.value = '';
        return;
      }

      saveConfig({ bossActiveCustomOptions: customOptions.concat(text) });
      input.value = '';
      this.renderBossActiveFilterOptions();
      UI.setStatus(`已添加自定义活跃度：${text}`, 'ok');
    },

    // 删除自定义 Boss 活跃度，并同步清理已选过滤值。
    deleteBossActiveCustomOption(value) {
      const key = normalizeBossActiveText(value);
      if (!key || BOSS_ACTIVE_BUILTIN_KEYS.has(key)) return;

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions)
        .filter((item) => normalizeBossActiveText(item) !== key);
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues)
        .filter((item) => normalizeBossActiveText(item) !== key);
      saveConfig({
        bossActiveCustomOptions: customOptions,
        bossActiveFilterValues: selectedOptions,
      });
      this.renderBossActiveFilterOptions();
    },

    // 更新面板状态条；被 lockStatus 锁定时，普通状态不会覆盖关键错误/暂停提示。
    setStatus(message, type, options) {
      if (!runtime.ui) return;
      if (runtime.statusLock && !(options && options.force)) return;
      runtime.ui.status.textContent = message || '';
      runtime.ui.status.dataset.type = type || 'info';
    },

    // 锁定状态提示，通常用于 fatal/pause，避免后续异步任务覆盖真正停机原因。
    lockStatus(message, type) {
      runtime.statusLock = {
        message: message || '',
        type: type || 'info',
        lockedAt: Date.now(),
      };
      this.setStatus(runtime.statusLock.message, runtime.statusLock.type, { force: true });
    },

    // 手动操作或重新启动前解除状态锁。
    unlockStatus() {
      runtime.statusLock = null;
    },

    // 数据页：从 IndexedDB 读取岗位记录，刷新统计卡、趋势和最近记录。
    async refreshDataOverview() {
      const ui = runtime.ui;
      if (!ui || !ui.recordList) return;
      try {
        await Database.open();
        const rows = await Database.getAll('jobRecords').catch(() => []);
        runtime.dataOverviewRows = rows;
        this.renderDataStats(rows);
        this.renderRecordList(rows);
      } catch (error) {
        if (ui.recordList) {
          ui.recordList.innerHTML = `<div class="za-record-empty">岗位记录读取失败：${escapeHtml(String(error && error.message || error))}</div>`;
        }
        if (ui.recordListMeta) ui.recordListMeta.textContent = '读取数据失败，切换页签后可重试';
      }
    },

    // 发送成功后延迟刷新数据页，避免频繁读库；仅在数据页可见时刷新。
    scheduleDataOverviewRefresh() {
      const ui = runtime.ui;
      if (!ui || !ui.root) return;
      const pane = ui.root.querySelector('.za-pane[data-tab-name="tabData"]');
      if (!pane || pane.hasAttribute('hidden')) return;
      if (runtime.dataOverviewTimer) clearTimeout(runtime.dataOverviewTimer);
      runtime.dataOverviewTimer = setTimeout(() => {
        runtime.dataOverviewTimer = null;
        this.refreshDataOverview();
      }, 1200);
    },

    getDayKey(date) {
      const value = date instanceof Date ? date : new Date(date);
      if (Number.isNaN(value.getTime())) return '';
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${value.getFullYear()}-${month}-${day}`;
    },

    // 统计卡：今日投递、累计投递、跳过数、记录总数 + 最近 7 日趋势。
    renderDataStats(rows) {
      const ui = runtime.ui;
      if (!ui || !ui.dataStatToday) return;
      const list = Array.isArray(rows) ? rows : [];
      const todayKey = this.getDayKey(new Date());
      let today = 0;
      let total = 0;
      let skipped = 0;
      let lastUpdated = '';
      const trendMap = new Map();

      list.forEach((record) => {
        if (!record) return;
        const status = String(record.status || '');
        if (status === 'sent') {
          total += 1;
          const timeText = record.sentAt || record.updatedAt || record.createdAt || '';
          const date = timeText ? new Date(timeText) : null;
          if (date && !Number.isNaN(date.getTime())) {
            const key = this.getDayKey(date);
            trendMap.set(key, (trendMap.get(key) || 0) + 1);
            if (key === todayKey) today += 1;
          }
        }
        if (/^skipped/.test(status)) skipped += 1;
        const stamp = record.sentAt || record.updatedAt || record.clickedAt || record.createdAt || '';
        if (stamp && String(stamp) > String(lastUpdated)) lastUpdated = stamp;
      });

      ui.dataStatToday.textContent = String(today);
      if (ui.dataStatTotal) ui.dataStatTotal.textContent = String(total);
      if (ui.dataStatSkipped) ui.dataStatSkipped.textContent = String(skipped);
      if (ui.dataStatCount) ui.dataStatCount.textContent = String(list.length);
      if (ui.dataTrend) this.renderDataTrend(ui.dataTrend, trendMap);
      if (ui.dataStatsMeta) {
        ui.dataStatsMeta.textContent = list.length
          ? `共 ${list.length} 条记录，最近更新 ${formatRelativeTime(lastUpdated) || '未知'}；统计仅保存在本机`
          : '统计自本机岗位记录，启动投递后这里会显示数据';
      }
    },

    renderDataTrend(container, trendMap) {
      const days = [];
      const now = new Date();
      for (let i = 6; i >= 0; i -= 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = this.getDayKey(date);
        days.push({ date, key, count: trendMap.get(key) || 0 });
      }
      const max = Math.max(1, ...days.map((item) => item.count));
      container.innerHTML = days.map((item, index) => {
        const height = item.count ? Math.max(12, Math.round(item.count / max * 100)) : 0;
        const label = index === days.length - 1 ? '今天' : `${item.date.getMonth() + 1}/${item.date.getDate()}`;
        return `<div class="za-trend-item"><span class="za-trend-count">${item.count || ''}</span><div class="za-trend-bar-wrap"><span class="za-trend-bar" data-zero="${item.count ? '0' : '1'}" style="height:${height}%"></span></div><span class="za-trend-day">${label}</span></div>`;
      }).join('');
    },

    // 最近记录：关键词 + 状态筛选，最多展示 30 条。
    renderRecordList(rows) {
      const ui = runtime.ui;
      if (!ui || !ui.recordList) return;
      const list = Array.isArray(rows) ? rows : [];
      const keyword = String(ui.recordSearch && ui.recordSearch.value || '').trim().toLowerCase();
      const statusFilter = String(ui.recordStatus && ui.recordStatus.value || '');
      const filtered = list.filter((record) => {
        if (!record) return false;
        const status = String(record.status || '');
        if (statusFilter === 'skipped') {
          if (!/^skipped/.test(status)) return false;
        } else if (statusFilter && status !== statusFilter) {
          return false;
        }
        if (!keyword) return true;
        return `${record.jobName || ''} ${record.company || ''}`.toLowerCase().includes(keyword);
      }).sort((a, b) => {
        const left = String(b.sentAt || b.updatedAt || b.clickedAt || b.createdAt || '');
        const right = String(a.sentAt || a.updatedAt || a.clickedAt || a.createdAt || '');
        return left.localeCompare(right);
      });

      const limit = 30;
      const visible = filtered.slice(0, limit);
      if (!visible.length) {
        ui.recordList.innerHTML = `<div class="za-record-empty">${list.length ? '没有符合筛选条件的记录' : '暂无岗位记录，启动投递后会显示在这里'}</div>`;
      } else {
        ui.recordList.innerHTML = visible.map((record) => {
          const meta = getRecordStatusMeta(record);
          const timeText = record.sentAt || record.updatedAt || record.clickedAt || record.createdAt || '';
          const title = record.jobName || record.positionName || '未命名岗位';
          const extras = [record.company || record.companyFullName || '', record.salary || '', formatRelativeTime(timeText)]
            .filter(Boolean)
            .map((item) => `<span>${escapeHtml(String(item))}</span>`)
            .join('');
          return `<div class="za-record-row"><div class="za-record-main"><span class="za-record-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="${meta.cls}">${meta.label}</span></div><div class="za-record-meta">${extras}</div></div>`;
        }).join('');
      }
      if (ui.recordListMeta) {
        ui.recordListMeta.textContent = filtered.length
          ? (filtered.length > limit ? `显示最近 ${limit} 条，共 ${filtered.length} 条匹配` : `共 ${filtered.length} 条匹配记录`)
          : (list.length ? '没有符合筛选条件的记录' : '启动投递后，这里会显示最近的岗位记录');
      }
    },

    // 切换运行态：禁用启动按钮、启用停止按钮，并锁定会影响流程的配置项。
    setRunning(running) {
      if (!runtime.ui) return;
      const wasRunning = runtime.ui.root.classList.contains('za-running');
      runtime.ui.root.classList.toggle('za-running', Boolean(running));
      if (running && !wasRunning) LogWindow.startSession('自动投递');
      if (!running && wasRunning) {
        runtime.logGraceUntil = Date.now() + 5000;
        const endReason = runtime.statusLock
          ? (runtime.statusLock.message || '投递已停止')
          : (runtime.stopRequested ? '已手动停止投递' : '投递流程已结束');
        LogWindow.endSession(endReason);
      }
      const start = runtime.ui.root.querySelector('[data-action="start"]');
      const stop = runtime.ui.root.querySelector('[data-action="stop"]');
      if (start) start.disabled = Boolean(running);
      if (stop) stop.disabled = !running;
      this.setRuntimeConfigLocked(Boolean(running));
    },

    // 运行中锁定配置，防止正在循环时更改等待时间、问候语来源等关键参数。
    setRuntimeConfigLocked(locked) {
      const root = runtime.ui.root;
      if (locked) {
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      }

      root.querySelectorAll('[data-field]').forEach((field) => {
        if (isRuntimeLockExemptField(field.dataset.field)) return;
        field.disabled = locked;
      });

      root.querySelectorAll('input[name="za-greeting-mode"], input[name="za-text-source"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-lock-field], [data-role="companyBlacklistRuleOption"], [data-role="bossActiveOption"], [data-action="toggleCompanyBlacklistDropdown"], [data-action="toggleBossActiveDropdown"], [data-action="removeBossActiveSelection"]').forEach((field) => {
        field.disabled = locked;
      });

      const refreshFastReplies = root.querySelector('[data-action="refreshFastReplies"]');
      if (refreshFastReplies) refreshFastReplies.disabled = locked;

      if (runtime.ui.fastReplyTrigger) {
        runtime.ui.fastReplyTrigger.disabled = Boolean(locked || !(config.fastReplies || []).length);
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', 'false');
      }
      root.querySelectorAll('[data-role="fastReplySearch"], [data-action="clearFastReplySearch"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-action="addCompanyBlacklistRule"], [data-action="removeCompanyBlacklistRule"], [data-action="clearCompanyBlacklistRules"], [data-action="addBossActiveOption"], [data-action="deleteBossActiveOption"]').forEach((button) => {
        button.disabled = locked;
      });
      this.renderCompanyBlacklistRules();
    },

    // 从 IndexedDB 读取已沟通记录并刷新虚拟列表。
    async refreshGreetedList(options) {
      if (runtime.ui && runtime.ui.listItems && !(runtime.ui.greetedRows || []).length) {
        runtime.ui.listItems.innerHTML = '<div class="za-list-empty">正在读取本地记录…</div>';
        runtime.ui.listSpacer.style.height = '0px';
      }
      try {
        await Database.open();
        const rows = await loadGreetedRows();
        runtime.ui.greetedRows = rows;
        if (options && options.scrollTop && runtime.ui.listViewport) {
          runtime.ui.listViewport.scrollTop = 0;
        }
        this.renderVirtualList();
      } catch (error) {
        console.warn('[ZhipinAuto] 读取已沟通列表失败', error);
        if (runtime.ui && runtime.ui.listItems) {
          runtime.ui.listItems.innerHTML = `<div class="za-list-empty">已沟通列表读取失败：${escapeHtml(String(error && error.message || error))}</div>`;
          runtime.ui.listSpacer.style.height = '0px';
          if (runtime.ui.greetedCount) runtime.ui.greetedCount.textContent = '0';
        }
      }
    },

    // 发送成功后把最新记录插入/更新到 UI 列表，不必全量重读 IndexedDB。
    upsertGreetedRecord(record) {
      if (!runtime.ui || !isContactedRecord(record)) return;

      const rows = runtime.ui.greetedRows || [];
      const index = rows.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        rows[index] = Object.assign({}, rows[index], record);
      } else {
        rows.unshift(record);
      }

      runtime.ui.greetedRows = sortGreetedRows(rows);
      if (runtime.ui.listViewport) runtime.ui.listViewport.scrollTop = 0;
      this.renderVirtualList();
      this.scheduleDataOverviewRefresh();
    },

    // 虚拟列表渲染：只生成当前视口附近的行，避免记录很多时拖慢页面。
    renderVirtualList() {
      if (!runtime.ui || !runtime.ui.listViewport || !runtime.ui.listItems) return;

      const viewport = runtime.ui.listViewport;
      const rows = runtime.ui.greetedRows || [];
      if (runtime.ui.greetedCount) runtime.ui.greetedCount.textContent = String(rows.length);
      if (!rows.length) {
        runtime.ui.listSpacer.style.height = '0px';
        runtime.ui.listItems.innerHTML =
          '<div class="za-list-empty">' +
            '<div class="za-list-empty-icon">&#128172;</div>' +
            '<div>暂无已沟通岗位</div>' +
            '<div class="za-list-empty-hint">启动自动沟通后，已发送的岗位将显示在此处</div>' +
          '</div>';
        return;
      }
      try {
        const rowHeight = runtime.ui.rowHeight;
        // 记录变少时 scrollTop 可能停留在旧位置，先按新总数夹紧，避免渲染出屏幕外的空白。
        const maxScrollTop = Math.max(0, rows.length * rowHeight - viewport.clientHeight);
        if (viewport.scrollTop > maxScrollTop) viewport.scrollTop = maxScrollTop;
        const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2);
        const visibleCount = Math.ceil(viewport.clientHeight / rowHeight) + 5;
        const end = Math.min(rows.length, start + visibleCount);

        runtime.ui.listSpacer.style.height = `${rows.length * rowHeight}px`;
        runtime.ui.listItems.innerHTML = rows.slice(start, end).map((row, offset) => {
          const top = (start + offset) * rowHeight;
        const salary = getDisplaySalary(row) || '-';
        const company = getDisplayCompany(row) || '';
        const city = normalizeText(row.cityName || row.city || '');
        const time = formatRelativeTime(row.sentAt || row.clickedAt || row.updatedAt);
        const status = row.status || 'sent';
        const statusClass = status === 'sent' ? 'za-list-status-sent' : 'za-list-status-skipped';
        const statusLabel = status === 'sent' ? '已发' : '已跳过';
        return `
          <div class="za-list-row" style="transform: translateY(${top}px)" data-job-id="${escapeHtml(String(row.id || ''))}">
            <div class="za-list-row-main">
              <span class="za-list-row-title" title="${escapeHtml(row.jobName || '未知岗位')}">${escapeHtml(row.jobName || '未知岗位')}</span>
              <span class="za-list-row-salary">${escapeHtml(salary)}</span>
            </div>
            <div class="za-list-row-sub">
              <span class="za-list-row-company" title="${escapeHtml(company)}">${escapeHtml(company || '未知公司')}${city ? ' · ' + escapeHtml(city) : ''}</span>
              <span class="za-list-row-meta">
                <span class="za-list-status ${statusClass}">${statusLabel}</span>
                <span class="za-list-row-time" title="${escapeHtml(row.sentAt || row.clickedAt || '')}">${escapeHtml(time)}</span>
              </span>
            </div>
          </div>
        `;
        }).join('');
      } catch (error) {
        console.warn('[ZhipinAuto] 已沟通列表渲染失败', error);
        runtime.ui.listSpacer.style.height = '0px';
        runtime.ui.listItems.innerHTML = `<div class="za-list-empty">列表渲染失败：${escapeHtml(String(error && error.message || error))}</div>`;
      }
    },
  };

  // 读取已沟通列表：优先使用 jobRecords 中的已沟通记录，再兼容 greetedJobs 旧投影。
  async function loadGreetedRows() {
    const [jobRows, greetedRows] = await Promise.all([
      Database.getAll('jobRecords').catch(() => []),
      Database.getAll('greetedJobs').catch(() => []),
    ]);
    const byId = new Map();

    // 不再只认 status === 'sent'：跳过重复沟通、已点击但带发送时间等记录同样属于“已沟通”。
    jobRows.filter((record) => record && isContactedRecord(record)).forEach((record) => {
      byId.set(record.id, record);
    });
    greetedRows.filter(Boolean).forEach((record) => {
      byId.set(record.id, Object.assign({}, byId.get(record.id) || {}, record));
    });

    return sortGreetedRows(Array.from(byId.values()));
  }

  // 已沟通列表按沟通时间倒序展示，时间缺失时再按更新时间/创建时间兜底。
  function sortGreetedRows(rows) {
    return Array.from(rows || []).sort((a, b) => {
      const left = String(b.sentAt || b.updatedAt || b.clickedAt || '');
      const right = String(a.sentAt || a.updatedAt || a.clickedAt || '');
      return left.localeCompare(right);
    });
  }

  // 常用语接口：读取 BOSS 聊天侧的常用语列表。
  // 获取失败时不阻塞自动化流程，后续会退回默认问候语文本。
  const FastReplyService = {
    // 调用 BOSS 常用语接口并写入配置，UI 下拉框随之刷新。
    async refresh(showStatus) {
      // 平台护盾：常用语是 BOSS 专属接口，非 BOSS 平台不请求，避免智联等平台报 404。
      if (currentPlatform?.id !== 'boss') {
        if (showStatus) {
          UI.setStatus('当前平台无需拉取常用语，将使用自定义文本', 'info');
        }
        return;
      }

      if (showStatus) UI.setStatus('正在获取常用语...', 'info');

      try {
        const url = `${APP.fastReplyUrl}?_=${Date.now()}`;
        const response = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const replies = this.extractReplies(payload);
        if (!replies.length) throw new Error('接口中没有识别到常用语');

        saveConfig({
          fastReplies: replies,
          fastReplyIndex: Math.min(config.fastReplyIndex || 0, replies.length - 1),
        });
        UI.renderFastReplyOptions();
        UI.setStatus(`常用语获取成功：${replies.length} 条`, 'ok');
      } catch (error) {
        saveConfig({ fastReplies: [] });
        UI.renderFastReplyOptions();
        UI.setStatus(`获取常用语失败，将使用默认问候语文本：${error.message}`, 'warn');
      }
    },

    // 从不稳定的接口结构中递归提取文本，去重后作为可选常用语。
    extractReplies(payload) {
      const replies = [];
      const seen = new Set();
      const textKeys = ['content', 'text', 'replyContent', 'sentence', 'sentenceContent', 'message', 'word'];

      walkObject(payload, (value) => {
        if (typeof value === 'string') return;

        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              addReply(item);
              continue;
            }

            if (!item || typeof item !== 'object') continue;
            for (const key of textKeys) {
              if (typeof item[key] === 'string') {
                addReply(item[key], item.id || item.fastReplyId || item.replyId);
                break;
              }
            }
          }
        }
      });

      function addReply(text, id) {
        const normalized = normalizeText(text);
        if (!normalized || normalized.length > 500 || seen.has(normalized)) return;
        seen.add(normalized);
        replies.push({ id: id || hashString(normalized), text: normalized });
      }

      return replies.slice(0, 100);
    },
  };

  // 发送服务：常用语、自定义文本、自定义接口返回文本都会先解析为最终文案，
  // 再统一注入聊天输入框并触发发送，发送后会校验聊天记录中是否出现新消息。
  const GreetingService = {
    // 根据当前配置解析最终问候语，并走统一发送流程。
    async sendCurrent(job) {
      const resolved = config.greetingMode === 'fastReply'
        ? await this.resolveFastReplyText(job)
        : {
            messageType: 'customText',
            text: await this.resolveCustomText(job),
          };

      return this.sendText(resolved.text, job, resolved.messageType);
    },

    // 常用语模式：优先使用已缓存常用语，缺失时刷新接口，最后退回默认问候语。
    async resolveFastReplyText(job) {
      if (config.greetingMode === 'fastReply') {
        const selected = (config.fastReplies || [])[config.fastReplyIndex || 0];

        if (selected && selected.text) {
          return {
            messageType: 'fastReplyText',
            text: interpolateText(selected.text, job),
          };
        }

        // 只有 BOSS 平台才尝试刷新常用语接口，智联等平台直接跳过，避免发无效请求。
        if (currentPlatform?.id === 'boss') {
          try {
            await FastReplyService.refresh(false);
          } catch (_) {}
        }

        const refreshed = (config.fastReplies || [])[config.fastReplyIndex || 0] || (config.fastReplies || [])[0];
        return {
          messageType: 'fastReplyText',
          text: interpolateText((refreshed && refreshed.text) || config.customText || APP.defaultGreetingText, job),
        };
      }

      return {
        messageType: 'customText',
        text: await this.resolveCustomText(job),
      };
    },

    // 自定义模式：可以直接使用文本模板，也可以请求外部 API 生成文本。
    async resolveCustomText(job) {
      if (config.textSource !== 'api') {
        return interpolateText(config.customText, job);
      }

      if (!config.customApiUrl) throw new Error('自定义文本接口为空');

      const payload = {
        job: flattenJob(job),
        location: location.href,
        time: nowIso(),
      };
      const text = await requestExternalText(config.customApiUrl, config.customApiMethod, payload);
      return interpolateText(text, job);
    },

    // 等待聊天页可用、写入消息、触发发送，并确认聊天记录中出现新消息。
    async sendText(text, job, messageType) {
      const finalText = normalizeMessageText(text);
      if (!finalText) throw new Error('问候语文本为空');

      await waitForChatReady(job);
      const beforeSend = await sendChatTextByEnter(finalText);
      await waitForMessageSent(finalText, beforeSend);

      return {
        messageType: messageType || 'customText',
        messagePreview: finalText.slice(0, 120),
      };
    },
  };

  // 自动化状态机：list -> chat -> returning -> list。
  // list：遍历岗位卡片并点击沟通；chat：在聊天页发送问候；returning：发送后回到岗位列表。
  // BOSS 的沟通按钮会触发页面跳转，状态必须写入 localStorage，脚本重载后才能继续。
  const Automation = {
    // 手动点击“开始”后的入口：校验配置、初始化存储和索引，然后进入列表循环。
    async start() {
      if (runtime.automationLoopActive) return;

      UI.unlockStatus();
      UI.saveFormToConfig();
      const validation = validateConfig();
      if (validation) {
        this.fatal(validation);
        return;
      }

      // 主页只承载控制面板；用户点击启动后再进入岗位列表，沿用投递状态机。
      if (!isJobListUrl(location.href)) {
        localStorage.setItem(APP.startJobsKey, '1');
        // 根据平台跳转到对应的岗位列表页
        if (currentPlatform) {
          if (currentPlatform.id === 'boss') {
            pageWindow.location.assign('/web/geek/jobs');
          } else if (currentPlatform.id === 'zhilian') {
            pageWindow.location.assign('/sou/');
          } else if (currentPlatform.id === '51job') {
            pageWindow.location.assign('/search.php');
          } else if (currentPlatform.id === 'liepin') {
            pageWindow.location.assign('/zhaopin/');
          } else {
            pageWindow.location.assign('/web/geek/jobs');
          }
        } else {
          pageWindow.location.assign('/web/geek/jobs');
        }
        return;
      }

      UI.setRunning(true);
      UI.setStatus('正在准备自动沟通...', 'info');

      try {
        await Database.open();
        await Database.ensureStorageAvailable();
        await ContactedIndex.ensureReady();
        await AppliedCompanyIndex.ensureReady();
        JobRepository.syncCards();
      } catch (error) {
        this.fatal(error.message || String(error));
        return;
      }

      const startIndex = findSelectedCardIndex();
      const listUrl = getRestorableListUrl(location.href) || location.href;
      const listPosition = captureJobListPosition();
      // 同时冻结 active 标签和接口参数；仅保存列表 URL 无法区分“推荐”和具体求职期望。
      const listExpectationContext = captureActiveJobExpectationContext();
      // 一轮运行锁定同一个筛选 URL；先回扫顶部，再用岗位标识从上到下累计处理虚拟列表。
      RunState.save({
        active: true,
        phase: 'list',
        cursorIndex: Math.max(0, startIndex),
        sentCount: 0,
        processedKeys: [],
        scanPhase: 'seeking_top',
        scanNoProgressCount: 0,
        scanDiscoveredCount: 0,
        pendingJob: null,
        pendingJobKey: '',
        nextRunAt: null,
        nextDelaySeconds: null,
        pendingRawJob: null,
        chatButtonText: '',
        listUrl,
        listFilterSignature: makeJobListFilterSignature(listUrl),
        // BOSS 不会把“推荐/求职期望”标签写入 URL；单独冻结当前标签，返回列表后必须先恢复它。
        listExpectationContext,
        listScrollTop: listPosition.listScrollTop,
        listAnchorKey: listPosition.listAnchorKey,
        intentionalListRestoreAt: null,
        returnAttempts: 0,
        returnStartedAt: null,
        stopReason: '',
        pauseReason: '',
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: 0,
        listRefreshCount: 0,
        startedAt: nowIso(),
      });

      runtime.stopRequested = false;
      this.runListLoop('start');
    },

    // 停止自动化：写入 RunState，并解锁 UI。
    stop(reason, options) {
      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      RunState.stop(reason || '已停止');
      UI.setRunning(false);
      // 停止后按数据库真实记录回填一次，避免运行中漏掉的 upsert 让列表停在旧状态。
      UI.refreshGreetedList({ scrollTop: true });
      if (options && options.manual) {
        UI.lockStatus('已停止', 'warn');
      } else {
        UI.unlockStatus();
        UI.setStatus(reason || '已停止', 'warn');
      }
    },

    // 暂停自动化：保留当前状态给用户判断，但不再自动继续。
    pause(reason) {
      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      UI.unlockStatus();
      RunState.pause(reason || '已暂停');
      UI.setRunning(false);
      UI.setStatus(reason || '已暂停', 'warn');
    },

    // 页面加载、pageshow 或路由切换时调用，根据 RunState 恢复 list/chat/returning 阶段。
    async resumeIfNeeded(reason) {
      let state = RunState.load();
      if (!state || !state.active || runtime.automationLoopActive || runtime.resumeInProgress) return;
      runtime.resumeInProgress = true;

      try {
        // 先抢占恢复锁，再异步初始化；防止 boot/pageshow 同时穿过 automationLoopActive 检查。
        await Database.open();
        await Database.ensureStorageAvailable();
        await ContactedIndex.ensureReady();
        await AppliedCompanyIndex.ensureReady();
        state = RunState.load();
        if (!state || !state.active) return;

        runtime.stopRequested = false;
        UI.setRunning(true);

        if (state.phase === 'returning') {
          runtime.automationLoopActive = true;
          UI.setStatus('正在恢复返回岗位列表...', 'info');
          await this.completeReturnToList(state, reason || 'returning');
          return;
        }

        if ((state.phase === 'chat' || isChatPage()) && state.pendingJob) {
          this.continueFromChat(reason);
          return;
        }

        if (state.phase === 'chat' && !state.pendingJob) {
          this.fatal('运行状态缺少待沟通岗位，请重新启动脚本');
          return;
        }

        this.runListLoop(reason);
      } catch (error) {
        runtime.automationLoopActive = false;
        this.fatal(error.message || String(error));
      } finally {
        runtime.resumeInProgress = false;
      }
    },

    // 列表页主循环：按稳定岗位标识处理卡片，直到停止、达到上限或列表结束。
    async runListLoop(reason) {
      if (runtime.automationLoopActive) return;

      runtime.automationLoopActive = true;
      UI.setRunning(true);
      UI.setStatus(`自动沟通运行中：${reason || 'list'}`, 'info');

      try {
        // 列表页先等 DOM 卡片和接口数据都就绪，DOM 负责点击，接口数据负责准确记录岗位字段。
        const listCardSelector = currentPlatform?.selectors?.jobCard || 'li.job-card-box';
        await waitForElement(listCardSelector, getWaitTimeout(), '岗位列表');
        // 每次进入/恢复列表循环都复核冻结的求职期望，不能只依赖启动时的 active 类。
        await ensureFrozenJobExpectationContext(RunState.load(), 'list-loop');
        await JobRepository.waitForApiData(1800);
        JobRepository.syncCards();

        while (!runtime.stopRequested) {
          const state = RunState.load();
          if (!state || !state.active) break;

          if (Number(config.maxCount) > 0 && Number(state.sentCount || 0) >= Number(config.maxCount)) {
            this.stop(`已达到最大沟通数：${config.maxCount}`);
            break;
          }

          let processed;
          try {
            processed = await this.processNextCard(state);
          } catch (error) {
            // 最外层兜底：即使卡片流程遗漏了异常，也只跳过当前循环，不将整轮置为 fatal。
            logDebugEvent('delivery_scan_step_failed_continue', {
              reason: '岗位扫描步骤异常，继续后续岗位',
              error: String((error && error.message) || error),
              cursorIndex: Number(state.cursorIndex || 0),
            }, 'warn');
            RunState.patch({
              cursorIndex: Number(state.cursorIndex || 0) + 1,
              scanNoProgressCount: 0,
            });
            await this.waitBeforeNextCommunication();
            continue;
          }
          if (processed === 'navigating') return;
          if (processed === 'done') {
            // 当前虚拟列表扫完后可整页刷新续跑；达到刷新上限或关闭开关时才真正停止。
            const refreshed = await this.refreshListAfterExhausted();
            if (refreshed) return;
            this.stop('没有更多符合条件的岗位');
            break;
          }

          if (processed === 'processed') {
            // 无论岗位通过、拒绝还是当前卡片失败，都按随机区间等待后再点击下一张。
            await this.waitBeforeNextCommunication();
          }
        }
      } catch (error) {
        this.fatal(error.message || String(error));
      } finally {
        runtime.automationLoopActive = false;
        const state = RunState.load();
        UI.setRunning(Boolean(state && state.active && !runtime.stopRequested));
      }
    },

    // 处理下一个未扫描岗位：岗位标识负责去重，滚动窗口只负责提供当前可点击的 DOM 卡片。
    async processNextCard(state) {
      let currentState = state || RunState.load() || {};
      if (!runtime.jobPool.length) {
        await JobRepository.waitForApiData(1200);
      }

      if (currentState.scanPhase !== 'scanning_down') {
        UI.setStatus('正在向上恢复岗位列表顶部...', 'info');
        await scanJobListToTop();
        currentState = RunState.patch({
          scanPhase: 'scanning_down',
          scanNoProgressCount: 0,
          cursorIndex: 0,
          listScrollTop: 0,
        });
      }

      while (!runtime.stopRequested) {
        currentState = RunState.load() || currentState;
        const processedKeys = getProcessedJobKeySet(currentState);
        const entries = getVisibleJobScanEntries();
        const discoveredKeys = new Set(entries.map((entry) => entry.key).filter(Boolean));
        const nextEntry = entries.find((entry) => entry.key && !processedKeys.has(entry.key));

        RunState.patch({
          scanDiscoveredCount: Math.max(
            Number(currentState.scanDiscoveredCount || 0),
            processedKeys.size + Array.from(discoveredKeys).filter((key) => !processedKeys.has(key)).length,
          ),
        });

        if (!nextEntry) {
          const loaded = await scrollAndWaitForMore(discoveredKeys);
          const latestState = RunState.load() || currentState;
          const noProgressCount = loaded ? 0 : Number(latestState.scanNoProgressCount || 0) + 1;
          RunState.patch(Object.assign({ scanNoProgressCount: noProgressCount }, captureJobListPosition()));
          if (!loaded && noProgressCount >= 3) return 'done';
          continue;
        }

        const { card, job, domInfo, key } = nextEntry;
        const cursorIndex = Math.max(Number(currentState.cursorIndex || 0), processedKeys.size);
        logDebugEvent('process_card', {
          cursorIndex,
          scanKey: key,
          processedCount: processedKeys.size,
          job: summarizeJobForDebug(job),
          domInfo: summarizeDomInfoForDebug(domInfo),
          listState: getDebugListState(),
        });
        logDebugEvent('delivery_match_candidate', {
          scanKey: key,
          jobName: job.jobName || domInfo.jobName || '',
          company: job.company || domInfo.company || '',
          salary: job.salary || domInfo.salary || '',
          city: job.city || domInfo.city || '',
          cardText: String(domInfo.text || '').slice(0, 240),
          reason: '岗位出现在当前扫描窗口，等待匹配规则判断',
        });

        // 公司筛选、黑名单和已沟通跳过都在点击沟通前完成，减少无意义的详情页/聊天页跳转。
        if (!companyMatches(job.company || domInfo.company)) {
          logDebugEvent('delivery_match_rejected', {
            scanKey: key,
            jobName: job.jobName || domInfo.jobName || '',
            company: job.company || domInfo.company || '',
            reason: '公司筛选不匹配',
            filterMode: config.companyFilterMode,
            filterValue: config.companyFilterValue,
          }, 'warn');
          RunState.patch(buildProcessedJobPatch(currentState, job, domInfo, captureJobListPosition(job)));
          continue;
        }

        // 跨批次已投递公司去重：开启后跳过历史已成功投递过简历的公司。
        if (config.skipAppliedCompany && AppliedCompanyIndex.has(job)) {
          const matchedCompany = getDisplayCompany(job) || domInfo.company || '未知公司';
          logDebugEvent('delivery_match_rejected', {
            scanKey: key,
            jobName: job.jobName || domInfo.jobName || '',
            company: job.company || domInfo.company || '',
            reason: '命中历史已投递公司（去重）',
          }, 'warn');
          try {
            await Database.saveJobRecord(job, {
              status: 'skipped_applied_company',
              listIndex: cursorIndex,
              skippedAt: nowIso(),
              skipReason: 'applied_company_duplicate',
              appliedCompanyMatched: matchedCompany,
              pageUrl: location.href,
            });
          } catch (_) {}
          UI.setStatus(`已投递过该公司，跳过：${matchedCompany}`, 'warn');
          RunState.patch(buildProcessedJobPatch(currentState, job, domInfo, captureJobListPosition(job)));
          continue;
        }

        // 跨批次跳过已沟通岗位：命中本地历史沟通记录（含本轮外的批次）时跳过。
        // 不写 jobRecord，避免把已有的 sent 状态覆盖成 skipped；仅记日志并推进游标。
        if (config.skipContacted && ContactedIndex.has(job)) {
          logDebugEvent('delivery_match_rejected', {
            scanKey: key,
            jobName: job.jobName || domInfo.jobName || '',
            company: job.company || domInfo.company || '',
            reason: '历史已沟通（跨批次去重）',
          }, 'warn');
          UI.setStatus(`历史已沟通过，跳过：${job.jobName || domInfo.jobName || '未知岗位'}`, 'warn');
          RunState.patch(buildProcessedJobPatch(currentState, job, domInfo, captureJobListPosition(job)));
          continue;
        }

        const blacklistDecision = findCompanyBlacklistMatch(job, domInfo.company);
        if (blacklistDecision) {
          try {
            await this.skipCompanyBlacklist(job, cursorIndex, blacklistDecision, domInfo);
            return 'processed';
          } catch (error) {
            const message = String((error && error.message) || error);
            logDebugEvent('delivery_card_failed_continue', {
              cursorIndex,
              scanKey: key,
              jobName: job.jobName || domInfo.jobName || '',
              company: job.company || domInfo.company || '',
              reason: '黑名单记录流程失败，已跳过并继续后续岗位',
              error: message,
            }, 'warn');
            RunState.patch(buildProcessedJobPatch(RunState.load() || currentState, job, domInfo, captureJobListPosition(job)));
            scrollAheadByJobKey(key);
            return 'processed';
          }
        }

        try {
          return await this.communicateWithCard(card, job, cursorIndex, domInfo);
        } catch (error) {
          // 单张岗位卡片失败不得终止整轮投递；记录现场后标记本轮已处理并继续下一张。
          const message = String((error && error.message) || error);
          logDebugEvent('delivery_card_failed_continue', {
            cursorIndex,
            scanKey: key,
            jobName: job.jobName || domInfo.jobName || '',
            company: job.company || domInfo.company || '',
            reason: '当前岗位流程失败，已跳过并继续后续岗位',
            error: message,
          }, 'warn');
          UI.setStatus(`岗位处理失败，继续下一岗位：${job.jobName || '未知岗位'}`, 'warn');
          const latest = RunState.load() || currentState;
          RunState.patch(buildProcessedJobPatch(latest, job, domInfo, captureJobListPosition(job)));
          scrollAheadByJobKey(key);
          return 'processed';
        }
      }

      return 'done';
    },

    // 公司黑名单命中时记录跳过原因并推进游标；该状态不会加入已沟通判重集合。
    async skipCompanyBlacklist(job, cursorIndex, decision, domInfo) {
      const rule = decision && decision.rule || {};
      const matchedCompany = normalizeText(decision && decision.company) || getDisplayCompany(job) || '未知公司';
      const modeLabel = getCompanyMatchModeLabel(rule.mode);
      UI.setStatus(`公司黑名单命中，跳过：${matchedCompany}`, 'warn');
      logDebugEvent('delivery_match_rejected', {
        jobName: job && job.jobName || '',
        company: getDisplayCompany(job) || matchedCompany,
        reason: '命中公司黑名单',
        blacklistMode: rule.mode,
        blacklistValue: rule.value,
      }, 'warn');
      logDebugEvent('skip_company_blacklist', {
        cursorIndex,
        matchedCompany,
        rule: {
          mode: rule.mode,
          modeLabel,
          value: rule.value,
        },
        job: summarizeJobForDebug(job),
      }, 'warn');
      await Database.saveJobRecord(job, {
        status: 'skipped_blacklist',
        listIndex: cursorIndex,
        skippedAt: nowIso(),
        skipReason: 'company_blacklist',
        blacklistMode: rule.mode,
        blacklistModeLabel: modeLabel,
        blacklistValue: rule.value,
        blacklistMatchedCompany: matchedCompany,
        pageUrl: location.href,
      });
      const state = RunState.load() || {};
      const scanKey = getJobScanKey(job, domInfo);
      RunState.patch(buildProcessedJobPatch(
        Object.assign({}, state, { pendingJobKey: scanKey || state.pendingJobKey || '' }),
        job,
        domInfo,
        Object.assign(captureJobListPosition(job), { pendingJobKey: '' }),
      ));
      scrollAheadByJobKey(scanKey);
      return 'processed';
    },

    // 单个岗位的沟通流程：选中卡片、补详情、保存 clicked、点击沟通按钮。
    async communicateWithCard(card, job, cursorIndex, initialDomInfo) {
      const cardDomInfo = initialDomInfo || extractCardInfo(card);
      const scanKey = getJobScanKey(job, cardDomInfo);
      UI.setStatus(`选择岗位：${job.jobName || '未知岗位'} / ${job.company || '未知公司'}`, 'info');
      logDebugEvent('communicate_start', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        domInfo: summarizeDomInfoForDebug(cardDomInfo),
        runState: RunState.load(),
        listState: getDebugListState(),
      });

      // 智联招聘通过“投递简历”完成沟通，没有 BOSS 的聊天页状态机，走独立投递分支后直接返回列表继续。
      if (!currentPlatform) currentPlatform = platformRegistry.detect(location.href);
      if (currentPlatform && currentPlatform.id === 'zhilian') {
        return this.applyWithCardZhilian(card, job, cursorIndex, cardDomInfo, scanKey);
      }

      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      // 先点岗位卡片让右侧详情刷新；投递路径不等待完整详情接口，优先捕捉“立即沟通”。
      clickElement(card);

      const apiDetail = await JobRepository.waitForJobDetail(
        job,
        Math.min(900, getWaitTimeout() * 1000),
        detailResourceStartedAt,
        { includeHtml: false, forceApiFetch: true },
      ).catch(() => null);
      if (apiDetail) job = mergeJobInfo(job, apiDetail);
      // 只要页面出现可见的“立即沟通/继续沟通”即可继续，不因详情标题或接口字段缺失而卡死。
      const chatButton = await waitFor(() => findChatButton(job) || findChatButton(null), Math.min(2500, getWaitTimeout() * 1000), '立即沟通按钮', {
        observerRoot: getJobDetailObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        pollInterval: 80,
      }).catch((error) => {
        logDebugEvent('delivery_chat_button_missing', {
          cursorIndex,
          jobName: job.jobName || cardDomInfo.jobName || '',
          company: job.company || cardDomInfo.company || '',
          reason: '岗位卡片已捕捉，但详情区域未找到可见的立即沟通/继续沟通按钮',
          error: String((error && error.message) || error),
          candidateCount: document.querySelectorAll('[class*="op-btn-chat"]').length,
        }, 'warn');
        throw error;
      });
      const domDetail = extractDetailInfo() || {};
      const buttonText = normalizeText(chatButton.innerText || chatButton.textContent || '');
      logDebugEvent('chat_button_found', {
        cursorIndex,
        buttonText,
        buttonHref: chatButton.getAttribute('href'),
        buttonKa: chatButton.getAttribute('ka'),
        detailJobName: domDetail.jobName,
        job: summarizeJobForDebug(job),
      });
      job = mergeJobInfo(job, domDetail);
      if (apiDetail && !getDisplayBossActiveTime(job) && domDetail.bossActiveTimeDesc) {
        job = mergeJobInfo(job, {
          bossActiveTimeDesc: domDetail.bossActiveTimeDesc,
          bossOnline: domDetail.bossOnline,
        });
      }
      job = await enrichBossActiveInfoForFilter(job);
      const cityDecision = cityMatches(job.city || cardDomInfo.city || '');
      logDebugEvent('delivery_city_match', {
        scanKey,
        jobName: job.jobName || '',
        city: cityDecision.target,
        allowedCities: cityDecision.allowed,
        matched: cityDecision.matched,
      });
      if (!cityDecision.matched) {
        logDebugEvent('delivery_match_rejected', { scanKey, jobName: job.jobName || '', company: job.company || '', reason: '城市不在允许列表', city: cityDecision.target, allowedCities: cityDecision.allowed }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }
      const salaryDecision = salaryMatches(job, cardDomInfo);
      if (salaryDecision.active) {
        logDebugEvent('delivery_salary_match', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          salary: salaryDecision.salaryText,
          parsedRange: salaryDecision.range
            ? `${salaryDecision.range.minK}-${salaryDecision.range.maxK}K`
            : '未识别',
          requiredMinK: salaryDecision.minK,
          requiredMaxK: salaryDecision.maxK,
          matched: salaryDecision.matched,
        });
      }
      if (!salaryDecision.matched) {
        UI.setStatus(`薪资不在所选区间，跳过：${salaryDecision.salaryText || '未知薪资'}`, 'warn');
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason: salaryDecision.reason || '薪资不在所选区间',
          salary: salaryDecision.salaryText,
          salaryRangeK: salaryDecision.range
            ? `${salaryDecision.range.minK}-${salaryDecision.range.maxK}`
            : '',
          requiredMinK: salaryDecision.minK,
          requiredMaxK: salaryDecision.maxK,
        }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }
      const scoreResult = await ScoreService.scoreEntry(job, Object.assign({}, cardDomInfo, { text: [cardDomInfo.text, job.postDescription, ...(job.showSkills || [])].filter(Boolean).join(' ') }), card);
      logDebugEvent('delivery_match_score', { scanKey, jobName: job.jobName || '', company: job.company || '', score: scoreResult.score, grade: scoreResult.grade, allowed: scoreResult.allowed, reasons: scoreResult.reasons, positiveMatches: scoreResult.positiveMatches, negativeMatches: scoreResult.negativeMatches });
      if (!scoreResult.allowed) {
        let reason;
        if (scoreResult.titleNegativeHit) reason = `岗位名含负面词：${(scoreResult.titleNegativeMatches || []).join('、')}`;
        else if (scoreResult.negativeMatches.length) reason = `命中反面词：${scoreResult.negativeMatches.join('、')}`;
        else if (scoreResult.grade === 'low' && scoreResult.positiveMatches.length === 0) reason = '未命中任何关键词';
        else if (scoreResult.grade === 'low') reason = `分数过低：${scoreResult.score} < 阈值`;
        else reason = '评分不通过';
        logDebugEvent('delivery_match_rejected', { scanKey, jobName: job.jobName || '', company: job.company || '', reason, score: scoreResult.score, grade: scoreResult.grade, positiveMatches: scoreResult.positiveMatches, negativeMatches: scoreResult.negativeMatches, titleNegativeMatches: scoreResult.titleNegativeMatches || [] }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }
      logDebugEvent('delivery_match_accepted', { scanKey, jobName: job.jobName || '', company: job.company || '', city: cityDecision.target, score: scoreResult.score, grade: scoreResult.grade, reason: '城市与评分均通过，准备点击立即沟通' });
      logDebugEvent('job_detail_merged_before_chat', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        apiDetail: summarizeJobForDebug(apiDetail),
        domDetail: summarizeJobForDebug(domDetail),
      });

      const blacklistDecision = findCompanyBlacklistMatch(job);
      if (blacklistDecision) {
        return this.skipCompanyBlacklist(job, cursorIndex, blacklistDecision, cardDomInfo);
      }

      const activeDecision = bossActiveMatches(job);
      if (!activeDecision.matched) {
        const activeText = activeDecision.activeText || '未识别';
        UI.setStatus(`Boss活跃度不匹配，跳过：${activeText}`, 'warn');
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason: 'Boss 活跃度不匹配',
          activeText,
          selectedText: activeDecision.selectedText,
        }, 'warn');
        logDebugEvent('skip_boss_active_filter', {
          cursorIndex,
          activeText,
          selectedText: activeDecision.selectedText,
          job: summarizeJobForDebug(job),
        }, 'warn');
        await Database.saveJobRecord(job, {
          status: 'skipped_boss_active',
          listIndex: cursorIndex,
          skippedAt: nowIso(),
          skipReason: 'boss_active_filter',
          bossActiveFilterValues: normalizeBossActiveOptions(config.bossActiveFilterValues),
          pageUrl: location.href,
        });
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(
          captureJobListPosition(job),
          { pendingJobKey: '' },
        )));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      const fullDetail = null;
      logDebugEvent('job_detail_completed_before_chat', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        fullDetail: summarizeJobForDebug(fullDetail),
      });

      await Database.saveJobRecord(job, {
        status: 'clicked',
        listIndex: cursorIndex,
        clickedAt: nowIso(),
        pageUrl: location.href,
      });

      // “继续沟通”也允许进入聊天页；本轮去重由 RunState.processedKeys 控制。

      // 点击沟通前保存岗位和列表现场；本轮固定的 listUrl 不得被详情或聊天路由覆盖。
      const currentListState = RunState.load() || {};
      const listPosition = captureJobListPosition(job);
      const fixedListUrl = currentListState.listUrl || getRestorableListUrl(location.href) || location.href;
      RunState.patch({
        active: true,
        phase: 'chat',
        cursorIndex,
        pendingJob: flattenJob(job),
        pendingJobKey: scanKey,
        pendingRawJob: job.rawJob || null,
        chatButtonText: buttonText,
        listUrl: fixedListUrl,
        listFilterSignature: currentListState.listFilterSignature || makeJobListFilterSignature(fixedListUrl),
        listScrollTop: listPosition.listScrollTop,
        listAnchorKey: listPosition.listAnchorKey || scanKey,
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: 0,
      });

      // 完整文档导航会把当前列表页放入 BFCache；先监听 pagehide，避免返回后旧超时器误停新流程。
      this.watchChatPageTransition(job);

      // BOSS 主动投递简历：开启 bossAutoApply 时，沟通前先尝试投递简历再进入聊天。
      // 全程防御式，投递失败不阻断与 HR 的沟通。
      if (config.bossAutoApply && currentPlatform && currentPlatform.id === 'boss') {
        const applyResult = await tryBossDeliverResume(job);
        logDebugEvent('boss_apply_done', {
          jobName: job.jobName || '',
          applied: applyResult.applied,
          reason: applyResult.reason || '',
          company: job.company || '',
        }, applyResult.applied ? 'info' : 'warn');
        if (applyResult.applied) {
          UI.setStatus(`BOSS 已投递简历：${job.jobName || ''}`, 'ok');
          // 把投递结果挂到 RunState.pendingJob，随状态机带到聊天页，用于同步到已沟通记录。
          const runState = RunState.load() || {};
          const pending = Object.assign({}, runState.pendingJob || flattenJob(job), { bossApplied: true });
          RunState.patch({ pendingJob: pending });
        }
      }

      clickElement(chatButton);
      logDebugEvent('chat_button_clicked', {
        cursorIndex,
        job: summarizeJobForDebug(job),
        chatButtonText: buttonText,
        listUrl: fixedListUrl,
      });
      UI.setStatus('已进入聊天页，等待发送...', 'info');

      return 'navigating';
    },

    // 智联招聘投递流程：筛选 → 选中卡片 → 定位“立即投递” → 处理打招呼/确认弹窗 → 记录并留在列表页。
    // 智联没有聊天页，投递完成后必须自行标记本轮已处理，不能走 navigating → 聊天页状态机。
    async applyWithCardZhilian(card, job, cursorIndex, cardDomInfo, scanKey) {
      UI.setStatus(`智联投递：${job.jobName || '未知岗位'} / ${job.company || '未知公司'}`, 'info');
      logDebugEvent('zhilian_apply_start', {
        cursorIndex,
        scanKey,
        job: summarizeJobForDebug(job),
        domInfo: summarizeDomInfoForDebug(cardDomInfo),
        href: location.href,
      });

      // 智联登录校验：未登录时 /jobs/ 无卡片、/sou/ 有 SSR 卡片但无真实投递能力，
      // 提前识别并暂停，避免把所有岗位"静默跳过"造成困惑。
      if (detectZhilianLoggedOut()) {
        const msg = '检测到智联账号未登录，请先登录后再投递';
        UI.setStatus(msg, 'error');
        logDebugEvent('zhilian_login_required', {
          href: location.href,
          cardText: summarizeLongText(cardDomInfo.text),
          jobName: job.jobName || '',
          company: job.company || '',
        }, 'warn');
        const state = RunState.load() || {};
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, captureJobListPosition(job)));
        this.pause(msg);
        return 'processed';
      }

      // 与 BOSS 保持同一套筛选顺序：城市允许列表 → 关键词评分 → 公司黑名单。
      // 智联没有 Boss 活跃度字段，因此不走 bossActiveMatches。
      const cityDecision = cityMatches(job.city || cardDomInfo.city || '');
      logDebugEvent('delivery_city_match', {
        scanKey,
        jobName: job.jobName || '',
        city: cityDecision.target,
        allowedCities: cityDecision.allowed,
        matched: cityDecision.matched,
      });
      if (!cityDecision.matched) {
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason: '城市不在允许列表',
          city: cityDecision.target,
          allowedCities: cityDecision.allowed,
        }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      const salaryDecision = salaryMatches(job, cardDomInfo);
      if (salaryDecision.active) {
        logDebugEvent('delivery_salary_match', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          salary: salaryDecision.salaryText,
          parsedRange: salaryDecision.range
            ? `${salaryDecision.range.minK}-${salaryDecision.range.maxK}K`
            : '未识别',
          requiredMinK: salaryDecision.minK,
          requiredMaxK: salaryDecision.maxK,
          matched: salaryDecision.matched,
        });
      }
      if (!salaryDecision.matched) {
        UI.setStatus(`薪资不在所选区间，跳过：${salaryDecision.salaryText || '未知薪资'}`, 'warn');
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason: salaryDecision.reason || '薪资不在所选区间',
          salary: salaryDecision.salaryText,
          salaryRangeK: salaryDecision.range
            ? `${salaryDecision.range.minK}-${salaryDecision.range.maxK}`
            : '',
          requiredMinK: salaryDecision.minK,
          requiredMaxK: salaryDecision.maxK,
        }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      const scoreResult = await ScoreService.scoreEntry(
        job,
        Object.assign({}, cardDomInfo, {
          text: [cardDomInfo.text, job.postDescription, ...(job.showSkills || [])].filter(Boolean).join(' '),
        }),
        card,
      );
      logDebugEvent('delivery_match_score', {
        scanKey,
        jobName: job.jobName || '',
        company: job.company || '',
        score: scoreResult.score,
        grade: scoreResult.grade,
        allowed: scoreResult.allowed,
        reasons: scoreResult.reasons,
        positiveMatches: scoreResult.positiveMatches,
        negativeMatches: scoreResult.negativeMatches,
      });
      if (!scoreResult.allowed) {
        let reason;
        if (scoreResult.titleNegativeHit) reason = `岗位名含负面词：${(scoreResult.titleNegativeMatches || []).join('、')}`;
        else if (scoreResult.negativeMatches.length) reason = `命中反面词：${scoreResult.negativeMatches.join('、')}`;
        else if (scoreResult.grade === 'low' && scoreResult.positiveMatches.length === 0) reason = '未命中任何关键词';
        else if (scoreResult.grade === 'low') reason = `分数过低：${scoreResult.score} < 阈值`;
        else reason = '评分不通过';
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason,
          score: scoreResult.score,
          grade: scoreResult.grade,
          positiveMatches: scoreResult.positiveMatches,
          negativeMatches: scoreResult.negativeMatches,
          titleNegativeMatches: scoreResult.titleNegativeMatches || [],
        }, 'warn');
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      const blacklistDecision = findCompanyBlacklistMatch(job, cardDomInfo.company);
      if (blacklistDecision) {
        return this.skipCompanyBlacklist(job, cursorIndex, blacklistDecision, cardDomInfo);
      }

      logDebugEvent('delivery_match_accepted', {
        scanKey,
        jobName: job.jobName || '',
        company: job.company || '',
        city: cityDecision.target,
        score: scoreResult.score,
        grade: scoreResult.grade,
        reason: '城市与评分均通过，准备点击智联投递',
      });

      // 老版 /sou/ 卡片自带投递按钮，先在卡片内找，避免点击卡片跳到新标签页；
      // 新版 /jobs/ 卡片没有按钮，需要点卡片让右栏详情渲染出“立即投递”。
      const expectedName = normalizeText(job.jobName || cardDomInfo.jobName);
      let picked = findZhilianApplyButtonIn(card, expectedName);
      if (!picked && document.querySelector('.job-detail-panel, .job-detail-summary__actions, .job-detail-box, .job-detail-container')) {
        card.scrollIntoView({ block: 'center', inline: 'nearest' });
        clickElement(card);
        // 岗位名缺失时无法比对详情是否已切到当前岗位，直接跳过等待去找按钮。
        if (expectedName) {
          await waitFor(() => {
            const panel = document.querySelector('.job-detail-panel, .job-detail-summary, .job-detail-box, .job-detail-container');
            const text = normalizeText(panel && (panel.innerText || panel.textContent));
            return text && text.includes(expectedName) ? true : null;
          }, 4000, '智联职位详情', {
            observerRoot: getJobDetailObserverRoot(),
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden'],
            pollInterval: 80,
          }).catch((error) => {
            logDebugEvent('zhilian_detail_wait_timeout', {
              jobName: expectedName,
              error: String((error && error.message) || error),
            }, 'warn');
            return null;
          });
        }
        picked = await waitFor(() => findZhilianApplyButton(expectedName), 5000, '智联投递按钮', {
          observerRoot: getJobDetailObserverRoot(),
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
          pollInterval: 80,
        }).catch((error) => {
          logDebugEvent('zhilian_apply_button_missing', {
            cursorIndex,
            jobName: job.jobName || cardDomInfo.jobName || '',
            company: job.company || cardDomInfo.company || '',
            error: String((error && error.message) || error),
          }, 'warn');
          return null;
        });
      }

      if (!picked) {
        logDebugEvent('zhilian_apply_button_missing', {
          cursorIndex,
          jobName: job.jobName || cardDomInfo.jobName || '',
          company: job.company || cardDomInfo.company || '',
          cardText: summarizeLongText(cardDomInfo.text),
          href: location.href,
        }, 'warn');
        const state = RunState.load() || {};
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, captureJobListPosition(job)));
        UI.setStatus(`未找到智联投递按钮，跳过：${job.jobName || '未知岗位'}`, 'warn');
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      const buttonText = normalizeText(picked.element.innerText || picked.element.textContent || '');
      logDebugEvent('zhilian_apply_button_found', {
        cursorIndex,
        kind: picked.kind,
        buttonText,
        job: summarizeJobForDebug(job),
      });

      // 已投递过：只补记录，不再点击，避免重复投递。
      if (picked.kind === 'already') {
        const record = await Database.saveJobRecord(job, {
          status: 'sent',
          sentAt: nowIso(),
          messageType: 'resumeApplied',
          messagePreview: '该职位此前已投递',
          listIndex: cursorIndex,
          pageUrl: location.href,
        });
        UI.upsertGreetedRecord(record);
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        UI.setStatus(`该职位已投递过，跳过：${job.jobName || ''}`, 'info');
        scrollAheadByJobKey(scanKey);
        return 'processed';
      }

      await Database.saveJobRecord(job, {
        status: 'clicked',
        listIndex: cursorIndex,
        clickedAt: nowIso(),
        pageUrl: location.href,
      });

      // 记录点击前已有的浮层快照；点击后只认“新增或文案变化”的浮层，避免误点页面原有的筛选/登录浮层。
      const overlaySnapshot = new Map();
      getZhilianOverlayRoots().forEach((root) => overlaySnapshot.set(root, root.textContent || ''));
      const freshOverlayRoots = () => getZhilianOverlayRoots()
        .filter((root) => overlaySnapshot.get(root) !== (root.textContent || ''));

      clickElement(picked.element);
      logDebugEvent('zhilian_apply_button_clicked', {
        cursorIndex,
        kind: picked.kind,
        buttonText,
        job: summarizeJobForDebug(job),
      });
      await sleep(700);

      // 投递后可能出现三类结果：打招呼语弹窗（留在此页）、二次确认弹窗（选择简历/确认投递）、按钮直接变“已投递”。
      // 轮询中若用户点击停止则立即返回，避免长超时期间流程仍继续。
      const outcome = await waitFor(() => {
        if (runtime.stopRequested) return { type: 'stopped' };
        const fresh = freshOverlayRoots();
        const stay = findZhilianStayButton(fresh);
        if (stay) return { type: 'greeting', button: stay };
        const confirm = findZhilianConfirmButton(fresh);
        if (confirm) return { type: 'confirm', button: confirm };
        if (findZhilianAppliedIndicator()) return { type: 'applied' };
        return null;
      }, 3500, '智联投递结果', {
        observerRoot: getPageObserverRoot(),
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
        pollInterval: 100,
      }).catch(() => null);

      let resumeApplied = false;
      let greetingSent = false;
      let greetingInjected = false;
      if (outcome && outcome.type === 'confirm') {
        // 方案一：确认投递前，若用户开启了自定义打招呼，则把面板配置的问候语
        // 直接注入智联“打招呼/附言”输入框，统一 BOSS 与智联的配置来源。
        // 注意：新版“请选择要投递的简历”弹窗没有附言框，注入不会生效，
        // 问候语仍由智联默认文案发出，日志里会留下 zhilian_greeting_input_missing。
        if (config.useCustomGreeting) {
          try {
            const greeting = config.greetingMode === 'fastReply'
              ? (await GreetingService.resolveFastReplyText(job)).text
              : await GreetingService.resolveCustomText(job);
            const greetingInput = findZhilianGreetingInput(freshOverlayRoots());
            if (greetingInput && injectZhilianGreeting(greetingInput, greeting)) {
              greetingInjected = true;
              await sleep(200);
              // 注入后重新捕获确认按钮，交由点击；若输入框在注入后引起了弹窗布局变化，
              // 这里重查一次以保证确认按钮没有被遗漏。
              const recheck = findZhilianConfirmButton(freshOverlayRoots());
              if (recheck) outcome.button = recheck;
              logDebugEvent('zhilian_greeting_injected', {
                jobName: job.jobName || '',
                company: job.company || '',
                preview: greeting.slice(0, 60),
              });
            } else {
              // 新版“选简历”弹窗没有附言框，问候语由智联账号里的默认打招呼语负责。
              // 每轮只提示一次，避免每条岗位都刷一条警告把日志页刷满。
              if (!runtime.zhilianGreetingHintShown) {
                runtime.zhilianGreetingHintShown = true;
                logDebugEvent('zhilian_greeting_input_missing', {
                  jobName: job.jobName || '',
                  company: job.company || '',
                  message: '投递弹窗没有附言输入框，问候语使用智联账号默认打招呼语',
                }, 'info');
              }
            }
          } catch (error) {
            logDebugEvent('zhilian_greeting_resolve_failed', {
              jobName: job.jobName || '',
              company: job.company || '',
              message: String((error && error.message) || error),
            }, 'warn');
          }
        }
        clickElement(outcome.button);
        await sleep(600);
        // 提交后要么弹“已向对方发送简历和打招呼语/留在此页”，要么按钮直接变“已投递”。
        const afterConfirm = await waitFor(() => {
          if (runtime.stopRequested) return { type: 'stopped' };
          const stay = findZhilianStayButton(freshOverlayRoots());
          if (stay) return { type: 'stay', button: stay };
          if (findZhilianAppliedIndicator()) return { type: 'applied' };
          return null;
        }, 2500, '智联投递提交确认').catch(() => null);
        if (afterConfirm && afterConfirm.type === 'stay') clickElement(afterConfirm.button);
        resumeApplied = true;
        // 智联投递时会附带平台默认问候语（成功弹窗文案：已向对方发送简历和打招呼语）。
        greetingSent = true;
      } else if (outcome && outcome.type === 'greeting') {
        // “已向对方发送打招呼语/留在此页”：由“先聊聊”触发，平台已经发出默认问候语，
        // 简历并没有提交。点“留在此页”留在列表，避免跳到跨域的 i.zhaopin.com/im 打断自动化。
        clickElement(outcome.button);
        await sleep(400);
        greetingSent = true;
        resumeApplied = Boolean(await waitFor(
          () => findZhilianAppliedIndicator(),
          1200,
          '智联投递状态',
        ).catch(() => false));
      } else if (outcome && outcome.type === 'applied') {
        resumeApplied = true;
        greetingSent = true;
      } else if (outcome && outcome.type === 'stopped') {
        return 'processed';
      } else {
        // 超时：可能是“选择简历”弹窗里没有可用简历（按钮禁用）或接口慢。
        // 关掉残留弹窗，避免它盖住列表导致后续卡片点不到。
        const leftoverDialog = findZhilianDialogClose(freshOverlayRoots()) || findZhilianDialogClose();
        if (leftoverDialog) {
          clickElement(leftoverDialog);
          await sleep(200);
          logDebugEvent('zhilian_dialog_dismissed', {
            jobName: job.jobName || '',
            company: job.company || '',
          }, 'warn');
        }
      }

      // 兜底再关一次可能残留的弹窗，保证后续卡片扫描不被浮层挡住。
      const leftoverStay = findZhilianStayButton();
      if (leftoverStay) clickElement(leftoverStay);

      const contacted = resumeApplied || greetingSent;
      const record = await Database.saveJobRecord(job, resumeApplied ? {
        status: 'sent',
        sentAt: nowIso(),
        messageType: greetingInjected ? 'resumeWithGreeting' : 'resumeApplied',
        messagePreview: greetingInjected ? '已投递简历并附自定义问候语' : '已投递简历',
        listIndex: cursorIndex,
        pageUrl: location.href,
      } : greetingSent ? {
        status: 'sent',
        sentAt: nowIso(),
        messageType: 'chatGreeting',
        messagePreview: '已发送平台默认招呼语，未投递简历',
        listIndex: cursorIndex,
        pageUrl: location.href,
      } : {
        status: 'clicked',
        listIndex: cursorIndex,
        clickedAt: nowIso(),
        pageUrl: location.href,
        applyOutcome: 'unconfirmed',
      });
      if (contacted) UI.upsertGreetedRecord(record);
      if (resumeApplied) AppliedCompanyIndex.add(record || job);

      logDebugEvent(contacted ? 'zhilian_apply_done' : 'zhilian_apply_unconfirmed', {
        cursorIndex,
        applied: resumeApplied,
        greetingSent,
        greetingInjected,
        outcome: (outcome && outcome.type) || 'timeout',
        job: summarizeJobForDebug(job),
        jobName: job.jobName || '',
        company: job.company || '',
      }, contacted ? 'info' : 'warn');

      const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
      RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), {
        pendingJobKey: '',
        sentCount: Number(state.sentCount || 0) + (contacted ? 1 : 0),
      })));
      if (resumeApplied) {
        UI.setStatus(
          greetingInjected
            ? `智联投递成功（已附自定义问候语）：${job.jobName || ''}`
            : `智联投递成功：${job.jobName || ''}`,
          'ok',
        );
      } else if (greetingSent) {
        UI.setStatus(`智联已发送平台默认招呼语（未投递简历）：${job.jobName || ''}`, 'info');
      } else {
        UI.setStatus(`智联投递结果未确认：${job.jobName || ''}`, 'warn');
      }
      scrollAheadByJobKey(scanKey);
      return 'processed';
    },

    // 同时覆盖 SPA 跳转和完整文档导航；pagehide 会在 BFCache 冻结计时器前完成清理。
    // 点击沟通后若出现沟通次数提醒弹窗，会先点确定，避免一直等到聊天页超时。
    watchChatPageTransition(job) {
      waitFor(() => {
        const dialog = inspectBossPlatformDialog({ dismissSoft: true });
        if (dialog && dialog.kind === 'hard_limit') {
          throw createPauseError(formatBossDialogPauseMessage(dialog));
        }
        return isChatPage() ? 'same-page' : null;
      }, getWaitTimeout(), '聊天页跳转', {
        observerRoot: getPageObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
        pollInterval: 200,
        resolveOnPageHide: true,
        pageHideResult: 'pagehide',
      }).then((transition) => {
        logDebugEvent('chat_page_transition_observed', {
          transition,
          href: location.href,
          job: summarizeJobForDebug(job),
          runState: RunState.load(),
        });
        if (transition !== 'same-page' || !isChatPage()) return;

        const latestState = RunState.load();
        if (latestState && latestState.active && latestState.phase === 'chat' && latestState.pendingJob) {
          setTimeout(() => {
            runtime.automationLoopActive = false;
            this.continueFromChat('same-page');
          }, 0);
        }
      }).catch((error) => {
        const latestState = RunState.load();
        if (error && error.zhipinAutoPause) {
          runtime.automationLoopActive = false;
          this.pause(error.message || '已暂停');
          return;
        }

        // 超时前再尝试关闭一次软提醒弹窗；关闭后若仍停留在列表页，交给聊天重试机制。
        const dialog = inspectBossPlatformDialog({ dismissSoft: true });
        logDebugEvent('chat_page_transition_timeout', {
          message: error && error.message || String(error),
          href: location.href,
          job: summarizeJobForDebug(job),
          runState: latestState,
          dialog: dialog && {
            kind: dialog.kind,
            text: summarizeLongText(dialog.text),
          },
        }, 'warn');

        if (dialog && dialog.kind === 'hard_limit') {
          runtime.automationLoopActive = false;
          this.pause(formatBossDialogPauseMessage(dialog));
          return;
        }

        // 点击未触发导航时交给现有的聊天渲染/重新点击机制处理，不再直接 fatal 停机。
        if (latestState && latestState.active && latestState.phase === 'chat' && latestState.pendingJob && isJobListRoute()) {
          setTimeout(() => {
            runtime.automationLoopActive = false;
            this.continueFromChat('chat-transition-timeout');
          }, 0);
        }
      });
    },

    // 聊天页续跑：从 RunState 恢复 pendingJob，发送问候语，写 sent 记录，再进入 returning。
    async continueFromChat(reason) {
      if (runtime.automationLoopActive) return;
      runtime.automationLoopActive = true;
      UI.setRunning(true);

      try {
        // 聊天页可能是新路由加载后的全新脚本实例，只能依赖 RunState 找回待发送岗位。
        const state = RunState.load();
        if (!state || !state.active) {
          runtime.automationLoopActive = false;
          UI.setRunning(false);
          logDebugEvent('continue_from_chat_ignored', { reason, state, cause: 'inactive' });
          return;
        }

        if (state.phase !== 'chat' || !state.pendingJob) {
          runtime.automationLoopActive = false;
          UI.setRunning(Boolean(state.active && !runtime.stopRequested));
          logDebugEvent('continue_from_chat_ignored', {
            reason,
            state,
            cause: 'not_chat_or_missing_pending_job',
          }, 'warn');
          return;
        }

        let pendingJob = revivePendingJob(state);
        if (!config.useCustomGreeting) {
          // 默认路径：BOSS 已在点击“立即沟通”时自动发送内置问候语；这里只处理“留在此页”并完成记录。
          await waitFor(() => {
            const dialog = inspectBossPlatformDialog({ dismissSoft: true });
            if (dialog && dialog.kind === 'hard_limit') throw createPauseError(formatBossDialogPauseMessage(dialog));
            return !findBossPlatformDialog() || dialog && dialog.kind === 'stay_page' ? true : null;
          }, Math.min(5000, getWaitTimeout() * 1000), '留在此页弹窗');
          logDebugEvent('delivery_builtin_greeting_completed', {
            jobName: pendingJob.jobName || '',
            company: pendingJob.company || '',
            reason: '使用 BOSS 内置问候语，已处理留在此页弹窗',
          });
          const sentRecord = await Database.saveJobRecord(pendingJob, {
            status: 'sent',
            sentAt: nowIso(),
            messageType: pendingJob.bossApplied ? 'bossResumeApplied' : 'bossBuiltinGreeting',
            messagePreview: pendingJob.bossApplied ? 'BOSS 已投递简历（内置问候语）' : 'BOSS 内置问候语',
            resumeApplied: Boolean(pendingJob.bossApplied),
            // 是否计入已投递公司名单：投简历必计；否则按开关把"BOSS 打招呼成功"也计入。
            countedAsApplied: Boolean(pendingJob.bossApplied) || config.bossGreetingCountsAsApplied,
            chatButtonText: state.chatButtonText,
            pageUrl: location.href,
          });
          UI.upsertGreetedRecord(sentRecord);
          if (shouldCountAppliedRecord(sentRecord)) AppliedCompanyIndex.add(sentRecord || pendingJob);
          RunState.patch(buildProcessedJobPatch(state, pendingJob, null, {
            phase: 'returning',
            sentCount: Number(state.sentCount || 0) + 1,
            pendingJob: null,
            pendingJobKey: '',
            pendingRawJob: null,
            returnAttempts: 0,
            returnStartedAt: Date.now(),
            chatOpenRetryCount: 0,
            nextRunAt: null,
            nextDelaySeconds: null,
          }));
          await this.completeReturnToList(RunState.load(), reason || 'builtin-greeting');
          return;
        }
        const latestDetail = await JobRepository.waitForJobDetail(
          pendingJob,
          Math.min(8000, Math.max(4500, getWaitTimeout() * 1000)),
          0,
          { includeHtml: true, forceApiFetch: true },
        )
          .catch(() => JobRepository.getDetailForJob(pendingJob));
        if (latestDetail) {
          pendingJob = mergeJobInfo(pendingJob, latestDetail);
        }
        logDebugEvent('continue_from_chat', {
          reason,
          pendingJob: summarizeJobForDebug(pendingJob),
          runState: state,
          listState: getDebugListState(),
        });
        UI.setStatus(`聊天页发送中：${pendingJob.jobName || '未知岗位'}`, 'info');

        // 进入聊天发送前先消掉可能残留的沟通提醒弹窗，避免输入框等待被挡住。
        const dialog = inspectBossPlatformDialog({ dismissSoft: true });
        if (dialog && dialog.kind === 'hard_limit') {
          throw createPauseError(formatBossDialogPauseMessage(dialog));
        }

        const sendResult = await this.sendCurrentWithChatOpenRetries(pendingJob, state);
        logDebugEvent('delivery_message_sent', {
          jobName: pendingJob.jobName || '',
          company: pendingJob.company || '',
          messageType: sendResult.messageType,
          messagePreview: sendResult.messagePreview,
          reason: '已进入聊天页并确认问候语发送成功',
        });
        // 只有发送确认通过后才写入 sent，并同步更新已沟通列表。
        const sentRecord = await Database.saveJobRecord(pendingJob, {
          status: 'sent',
          sentAt: nowIso(),
          messageType: pendingJob.bossApplied ? 'bossResumeApplied' : sendResult.messageType,
          messagePreview: pendingJob.bossApplied
            ? `已投递简历：${sendResult.messagePreview || ''}`
            : sendResult.messagePreview,
          resumeApplied: Boolean(pendingJob.bossApplied),
          // 是否计入已投递公司名单：投简历必计；否则按开关把"BOSS 打招呼成功"也计入。
          countedAsApplied: Boolean(pendingJob.bossApplied) || config.bossGreetingCountsAsApplied,
          chatButtonText: state.chatButtonText,
          pageUrl: location.href,
        });
        UI.upsertGreetedRecord(sentRecord);
        if (shouldCountAppliedRecord(sentRecord)) AppliedCompanyIndex.add(sentRecord || pendingJob);

        const nextDelaySeconds = randomDelaySeconds(config.delayMin, config.delayMax);
        RunState.patch(buildProcessedJobPatch(state, pendingJob, null, {
          phase: 'returning',
          sentCount: Number(state.sentCount || 0) + 1,
          pendingJob: null,
          pendingJobKey: '',
          pendingRawJob: null,
          returnAttempts: 0,
          returnStartedAt: Date.now(),
          chatOpenRetryCount: 0,
          nextRunAt: Date.now() + nextDelaySeconds * 1000,
          nextDelaySeconds,
        }));

        await UI.refreshGreetedList({ scrollTop: true });
        UI.setStatus('发送完成，正在返回岗位列表...', 'ok');
        await this.completeReturnToList(RunState.load(), reason || 'chat');
      } catch (error) {
        runtime.automationLoopActive = false;
        logDebugEvent('delivery_send_failed', {
          jobName: pendingJob && pendingJob.jobName || '',
          company: pendingJob && pendingJob.company || '',
          reason: '聊天页发送或发送确认失败',
          error: String((error && error.message) || error),
        }, 'warn');
        if (error && error.zhipinAutoPause) {
          this.pause(error.message || '已暂停');
        } else {
          this.fatal(error.message || String(error));
        }
      }
    },

    // 发送时如果聊天输入框渲染超时，可返回列表重新点击同一岗位进行有限重试。
    async sendCurrentWithChatOpenRetries(pendingJob, initialState) {
      const maxRetries = getChatOpenRetryLimit();
      let attempts = Math.max(0, Number(initialState && initialState.chatOpenRetryCount || 0));

      while (true) {
        try {
          return await GreetingService.sendCurrent(pendingJob);
        } catch (error) {
          logDebugEvent('send_current_error', {
            message: error && error.message || String(error),
            isChatRenderTimeout: isChatRenderTimeoutError(error),
            attempts,
            maxRetries,
            pendingJob: summarizeJobForDebug(pendingJob),
            runState: RunState.load(),
            listState: getDebugListState(),
          }, 'warn');

          if (!isChatRenderTimeoutError(error) || attempts >= maxRetries) {
            // 最后一次聊天超时时再尝试关闭软提醒；硬限制转暂停而不是 fatal。
            const dialog = inspectBossPlatformDialog({ dismissSoft: true });
            if (dialog && dialog.kind === 'hard_limit') {
              throw createPauseError(formatBossDialogPauseMessage(dialog));
            }
            throw error;
          }

          // 聊天页偶发不渲染输入框时，回岗位列表重新点击同一个沟通按钮，而不是直接跳过该岗位。
          attempts += 1;
          const latestState = RunState.load() || initialState || {};
          RunState.patch({ chatOpenRetryCount: attempts });
          await this.retryOpenChatForPendingJob(latestState, pendingJob, attempts, maxRetries);
        }
      }
    },

    // 聊天页打不开时的重试：回到列表，重新定位原岗位卡片并再次点击沟通。
    async retryOpenChatForPendingJob(state, pendingJob, attempt, maxRetries) {
      UI.setStatus(`聊天界面渲染超时，正在重新点击沟通 ${attempt}/${maxRetries}`, 'warn');
      logDebugEvent('chat_open_retry_start', {
        attempt,
        maxRetries,
        pendingJob: summarizeJobForDebug(pendingJob),
        runState: state,
        listState: getDebugListState(),
      }, 'warn');

      await navigateToJobList(state);
      await waitForVisibleJobList(Math.max(3000, getWaitTimeout() * 1000));
      await ensureFrozenJobExpectationContext(state, 'chat-open-retry');
      await restoreJobListPosition(state);
      await JobRepository.waitForApiData(Math.min(1800, getWaitTimeout() * 1000));
      const cards = JobRepository.syncCards();
      const card = findJobCardForRetry(pendingJob, cards, Number(state && state.cursorIndex || 0));

      if (!card) {
        logDebugEvent('chat_open_retry_card_missing', {
          attempt,
          pendingJob: summarizeJobForDebug(pendingJob),
          cursorIndex: Number(state && state.cursorIndex || 0),
          visibleCards: cards.slice(0, 8).map((item) => summarizeDomInfoForDebug(extractCardInfo(item))),
          listState: getDebugListState(),
        }, 'warn');
        throw new Error('聊天界面渲染 等待超时');
      }

      logDebugEvent('chat_open_retry_card_found', {
        attempt,
        pendingJob: summarizeJobForDebug(pendingJob),
        domInfo: summarizeDomInfoForDebug(extractCardInfo(card)),
      });

      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      clickElement(card);

      const apiDetail = await JobRepository.waitForJobDetail(
        pendingJob,
        Math.min(8000, Math.max(4500, getWaitTimeout() * 1000)),
        detailResourceStartedAt,
        { includeHtml: true, forceApiFetch: true },
      );
      let refreshedJob = mergeJobInfo(pendingJob, apiDetail);
      // 重试同样执行详情/按钮一致性校验，不能因为是第二次点击就复用可能过期的 DOM。
      const detailReady = await waitForJobCommunicationDetail(refreshedJob, getWaitTimeout() * 1000);
      const chatButton = detailReady.chatButton;
      const buttonText = normalizeText(chatButton.innerText || chatButton.textContent || '');
      refreshedJob = mergeJobInfo(refreshedJob, detailReady.detail);
      logDebugEvent('chat_open_retry_button_found', {
        attempt,
        buttonText,
        buttonHref: chatButton.getAttribute('href'),
        buttonKa: chatButton.getAttribute('ka'),
        detailJobName: detailReady.detail.jobName,
        pendingJob: summarizeJobForDebug(pendingJob),
      });

      RunState.patch({
        active: true,
        phase: 'chat',
        cursorIndex: Number(state && state.cursorIndex || 0),
        pendingJob: flattenJob(refreshedJob),
        pendingRawJob: refreshedJob.rawJob || pendingJob.rawJob || null,
        pendingJobKey: state && state.pendingJobKey || getJobScanKey(refreshedJob),
        chatButtonText: buttonText,
        listUrl: state && state.listUrl || getRestorableListUrl(location.href) || location.href,
        listFilterSignature: state && state.listFilterSignature || makeJobListFilterSignature(state && state.listUrl || location.href),
        listSnapshot: createJobListSnapshot(),
        chatOpenRetryCount: attempt,
      });

      clickElement(chatButton);
      logDebugEvent('chat_open_retry_clicked', {
        attempt,
        refreshedJob: summarizeJobForDebug(refreshedJob),
        chatButtonText: buttonText,
        listUrl: state && state.listUrl || location.href,
      });
    },

    // 发送完成后先尝试历史返回；只有筛选上下文完全一致才算成功，否则恢复固定的原列表 URL。
    async completeReturnToList(state, reason) {
      const currentState = state || RunState.load() || {};
      const attempts = Number(currentState.returnAttempts || 0);
      const returnStartedAt = Number(currentState.returnStartedAt || Date.now());
      logDebugEvent('complete_return_start', {
        reason,
        attempts,
        returnStartedAt,
        hasVisibleJobCards: hasVisibleJobCards(),
        isJobListRoute: isJobListRoute(),
        isChatPage: isChatPage(),
        listUrl: currentState.listUrl,
        listFilterSignature: currentState.listFilterSignature,
        ignoreListRefresh: Boolean(config.ignoreListRefresh),
        state: currentState,
      });

      RunState.patch({ phase: 'returning', returnAttempts: attempts + 1, returnStartedAt });
      const navigationResult = await navigateToJobList(currentState);
      // 短暂观察返回后是否发生第一页刷新，供后续扫描游标和刷新策略判断。
      await waitForReturnedJobListRefresh(returnStartedAt);
      // 恢复滚动位置之前先恢复求职期望，避免在“推荐”列表上按旧岗位锚点继续扫描。
      const expectationResult = await ensureFrozenJobExpectationContext(currentState, 'returning');
      await restoreJobListPosition(RunState.load() || currentState);
      logDebugEvent('complete_return_list_visible', {
        reason,
        attempts: attempts + 1,
        navigationResult,
        expectationResult,
        listState: getDebugListState(),
        snapshot: createJobListSnapshot(),
      });

      const latestState = RunState.load() || currentState;
      const refreshDecision = this.detectReturnedListRefresh(currentState, returnStartedAt);
      const intentionalRestore = Boolean(
        navigationResult && navigationResult.exactRestored ||
        Number(latestState.intentionalListRestoreAt || 0) >= returnStartedAt,
      );
      logDebugEvent('return_refresh_decision', {
        refreshDecision,
        intentionalRestore,
        ignoreListRefresh: Boolean(config.ignoreListRefresh),
        navigationResult,
        expectationResult,
      }, refreshDecision.refreshed ? 'warn' : 'info');
      let cursorIndex = Number(latestState.cursorIndex || currentState.cursorIndex || 0);

      // 主动恢复求职期望产生的刷新是受控行为；其它列表刷新仍交给“无视列表刷新”开关决定。
      if (refreshDecision.refreshed && !expectationResult.restored) {
        if (!config.ignoreListRefresh) {
          this.pause('岗位列表已刷新，脚本已暂停；请确认当前列表后重新启动');
          return;
        }

        cursorIndex = 0;
        const beforeRenderSignature = getVisibleJobListRenderSignature();
        const beforeResponseSerial = Number(runtime.jobListResponseSerial || 0);
        scrollJobListToTop();
        await waitForJobListRenderChange(beforeRenderSignature, beforeResponseSerial, 600);
        JobRepository.syncCards();
        UI.setStatus('检测到岗位列表刷新，已保留已处理岗位并从顶部继续', 'warn');
      } else if (expectationResult.restored) {
        UI.setStatus(`已恢复求职期望：${expectationResult.label || '原选择'}`, 'ok');
      } else if (intentionalRestore) {
        UI.setStatus('已恢复原岗位筛选页面和扫描进度', 'ok');
      }

      RunState.patch({
        phase: 'list',
        cursorIndex,
        returnAttempts: 0,
        returnStartedAt: null,
        intentionalListRestoreAt: null,
        listSnapshot: createJobListSnapshot(),
      });

      runtime.automationLoopActive = false;
      await UI.refreshGreetedList({ scrollTop: true });
      // 扫描本身保持快速；仅在完成一次投递并返回列表后，按配置随机等待再切换岗位。
      await this.waitBeforeNextCommunication();
      this.runListLoop(`returned:${reason || 'chat'}`);
    },

    // 判断返回列表后是否发生了第一页刷新或搜索上下文变化，避免游标指向错误岗位。
    detectReturnedListRefresh(state, returnStartedAt) {
      const previous = state && state.listSnapshot || {};
      const current = createJobListSnapshot();
      const latestFirstPage = runtime.latestFirstPageJobListResponse || {};
      const firstPageAfterReturn = Boolean(
        latestFirstPage.capturedAt &&
        Number(latestFirstPage.capturedAt) >= Number(returnStartedAt || 0),
      );
      const contextChanged = Boolean(
        previous.contextKey &&
        current.contextKey &&
        previous.contextKey !== current.contextKey,
      );

      return {
        refreshed: firstPageAfterReturn || contextChanged,
        firstPageAfterReturn,
        contextChanged,
        previous,
        current,
      };
    },

    // 两次沟通之间的随机等待，也负责检查最大沟通数上限。
    async waitBeforeNextCommunication() {
      const state = RunState.load() || {};
      const maxCount = Number(config.maxCount || 0);
      if (maxCount > 0 && Number(state.sentCount || 0) >= maxCount) {
        RunState.patch({ nextRunAt: null, nextDelaySeconds: null });
        return;
      }

      let nextRunAt = Number(state.nextRunAt || 0);
      let delaySeconds = Number(state.nextDelaySeconds || 0);
      if (!nextRunAt || nextRunAt <= Date.now()) {
        delaySeconds = randomDelaySeconds(config.delayMin, config.delayMax);
        nextRunAt = Date.now() + delaySeconds * 1000;
        RunState.patch({ nextRunAt, nextDelaySeconds: delaySeconds });
      }

      logDebugEvent('delivery_random_switch_delay', {
        delaySeconds,
        minSeconds: config.delayMin,
        maxSeconds: config.delayMax,
        reason: '完成一次投递后，返回列表前往下一个岗位',
      });

      const completed = await waitWithStatusCountdown(nextRunAt, (remainingSeconds) => `已返回岗位列表，等待 ${remainingSeconds} 秒后继续沟通...`);
      if (!completed) return;

      RunState.patch({ nextRunAt: null, nextDelaySeconds: null });
    },

    // 当前列表无可沟通岗位时整页刷新续跑；依赖 RunState.active 在刷新后由 resumeIfNeeded 接上。
    async refreshListAfterExhausted() {
      if (!config.autoRefreshOnExhausted) return false;

      const state = RunState.load() || {};
      const refreshCount = Math.max(0, Number(state.listRefreshCount || 0));
      const maxRefresh = Math.max(0, Number(config.maxListRefresh || 0));
      if (maxRefresh > 0 && refreshCount >= maxRefresh) {
        UI.setStatus(`已达到列表刷新上限：${maxRefresh}`, 'warn');
        logDebugEvent('list_exhausted_refresh_limit', { refreshCount, maxRefresh }, 'warn');
        return false;
      }

      const nextCount = refreshCount + 1;
      const limitLabel = maxRefresh > 0 ? `${nextCount}/${maxRefresh}` : String(nextCount);
      UI.setStatus(`当前列表已处理完，正在刷新页面继续（${limitLabel}）...`, 'warn');
      logDebugEvent('list_exhausted_refresh', {
        refreshCount: nextCount,
        maxRefresh,
        processedCount: Array.isArray(state.processedKeys) ? state.processedKeys.length : 0,
        listUrl: state.listUrl,
      });

      // 清空本轮扫描进度，保留筛选 URL / 求职期望 / sentCount；已沟通去重仍靠 ContactedIndex。
      RunState.patch({
        active: true,
        phase: 'list',
        listRefreshCount: nextCount,
        processedKeys: [],
        scanPhase: 'seeking_top',
        scanNoProgressCount: 0,
        scanDiscoveredCount: 0,
        cursorIndex: 0,
        pendingJob: null,
        pendingJobKey: '',
        pendingRawJob: null,
        chatButtonText: '',
        chatOpenRetryCount: 0,
        returnAttempts: 0,
        returnStartedAt: null,
        nextRunAt: null,
        nextDelaySeconds: null,
        listSnapshot: createJobListSnapshot(),
        stopReason: '',
        pauseReason: '',
      });

      runtime.stopRequested = false;
      await sleep(600);
      location.reload();
      return true;
    },

    // 统一停机入口：写停止状态、解锁 UI，并锁定错误提示。
    fatal(message) {
      if (runtime.statusLock) {
        runtime.stopRequested = true;
        runtime.automationLoopActive = false;
        RunState.stop(runtime.statusLock.message || '已停止');
        UI.setRunning(false);
        UI.setStatus(runtime.statusLock.message || '已停止', runtime.statusLock.type || 'warn', { force: true });
        return;
      }

      runtime.stopRequested = true;
      runtime.automationLoopActive = false;
      UI.unlockStatus();
      RunState.stop(message);
      UI.setRunning(false);
      UI.setStatus(message, 'error');
      setTimeout(() => alert(`[${APP.name}] ${message}`), 0);
    },
  };

  // 导出器：JSON/Excel 都在前端生成，下载时强制补扩展名，避免保存成无后缀 blob。
  const Exporter = {
    // 读取 jobRecords，转换为适合人工查看的字段名，再按配置导出 JSON 或 Excel。
    async exportRecords() {
      UI.saveFormToConfig();
      UI.setStatus('正在读取岗位记录...', 'info');
      const exportExtension = config.exportType === 'xlsx' ? 'xlsx' : 'json';
      const outputFileName = ensureFileExtension(
        `zhipin-job-records-${dateFileName()}`,
        exportExtension,
      );
      // 必须在用户点击事件尚有激活状态时调用，否则浏览器会拒绝文件选择器。
      const saveHandlePromise = requestSaveFileHandle(outputFileName, exportExtension);

      try {
        const rows = await Database.getAll('jobRecords');
        const normalizedRows = rows
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .map((row) => ({
            岗位名称: row.jobName || '',
            薪资: getDisplaySalary(row) || '',
            公司: getDisplayCompany(row) || '',
            完整公司名: row.companyFullName || '',
            公司简称: row.companyShortName || '',
            Boss: getDisplayText(row.bossName),
            Boss职位: getDisplayText(row.bossTitle),
            Boss活跃状态: row.bossActiveTimeDesc || '',
            城市: row.city || '',
            经验: row.experience || '',
            学历: row.degree || '',
            职位分类: row.positionName || '',
            工作地址: row.workAddress || row.address || '',
            经度: row.longitude || '',
            纬度: row.latitude || '',
            岗位描述: row.postDescription || '',
            技能标签: (row.showSkills || []).join('、'),
            招聘人数: row.recruitmentCountDesc || '',
            岗位状态: row.jobStatusDesc || '',
            公司阶段: row.companyStage || '',
            公司规模: row.companyScale || '',
            公司行业: row.companyIndustry || '',
            公司福利: (row.companyLabels || []).join('、'),
            公司简介: row.companyIntroduce || '',
            工商信息: row.businessInfo && Object.keys(row.businessInfo).length
              ? JSON.stringify(row.businessInfo)
              : '',
            法定代表人: row.legalRepresentative || '',
            成立日期: row.establishedDate || '',
            企业类型: row.companyType || '',
            经营状态: row.manageState || '',
            注册资本: row.registeredCapital || '',
            注册地址: row.registeredAddress || '',
            营业期限: row.businessTerm || '',
            所属地区: row.businessRegion || '',
            统一社会信用代码: row.unifiedSocialCreditCode || '',
            核准日期: row.approvalDate || '',
            曾用名: row.formerName || '',
            登记机关: row.registrationAuthority || '',
            工商所属行业: row.businessIndustry || '',
            经营范围: row.businessScope || '',
            消息预览: row.messagePreview || '',
            点击时间: row.clickedAt || '',
            发送时间: row.sentAt || '',
            更新时间: row.updatedAt || '',
          }));

        if (config.exportType === 'xlsx') {
          await this.exportXlsx(normalizedRows, outputFileName, saveHandlePromise);
          return;
        }

        const fileName = await downloadBlob(
          `\uFEFF${JSON.stringify(normalizedRows, null, 2)}`,
          outputFileName,
          'application/json;charset=utf-8',
          'json',
          saveHandlePromise,
        );
        UI.setStatus(`导出完成：${rows.length} 条记录，文件 ${fileName}`, 'ok');
      } catch (error) {
        if (error && error.zhipinAutoExportCancelled) {
          UI.setStatus('已取消导出', 'info');
          return;
        }
        Automation.fatal(`导出失败：${error.message}`);
      }
    },

    // Excel 导出懒加载 SheetJS，避免正常自动沟通流程额外加载大型库。
    async exportXlsx(rows, outputFileName, saveHandlePromise) {
      const XLSX = await loadSheetJs();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, '岗位记录');
      const data = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const fileName = await downloadBlob(
        data,
        outputFileName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xlsx',
        saveHandlePromise,
      );
      UI.setStatus(`Excel 导出完成：${rows.length} 条记录，文件 ${fileName}`, 'ok');
    },
  };

  // 调试日志用于排查偶发页面/接口问题，默认写入 localStorage 的短期环形缓冲。
  const DebugLogService = {
    setEnabled(enabled) {
      const shouldEnable = Boolean(enabled);
      try {
        if (shouldEnable) {
          localStorage.setItem(APP.debugEnabledKey, '1');
          runtime.debugEvents = loadStoredDebugEvents();
          logDebugEvent('debug_logging_enabled', { source: 'ui' });
          flushDebugEvents();
          UI.setStatus('已开启诊断日志', 'ok');
        } else {
          localStorage.removeItem(APP.debugEnabledKey);
          UI.setStatus('已关闭诊断日志', 'info');
        }
      } catch (error) {
        UI.setStatus(`切换诊断日志失败：${error.message || error}`, 'warn');
      }
      UI.renderDebugLogControls();
    },

    async exportLogs() {
      // 先刷新待写入的事件，确保导出最新数据
      flushDebugEvents();
      const events = loadStoredDebugEvents();
      if (!events.length) {
        UI.setStatus('暂无诊断日志可导出', 'warn');
        UI.setLogStatus('暂无诊断日志可导出，先开启「记录调试事件」再运行任务', 'warn');
        UI.renderDebugLogControls();
        return;
      }

      const outputFileName = ensureFileExtension(`zhipin-debug-logs-${dateFileName()}`, 'json');
      const saveHandlePromise = requestSaveFileHandle(outputFileName, 'json');
      const payload = {
        app: APP.name,
        version: APP.version,
        exportedAt: nowIso(),
        href: location.href,
        debugEnabled: isDebugEnabled(),
        eventCount: events.length,
        events,
      };

      try {
        const fileName = await downloadBlob(
          `\uFEFF${JSON.stringify(payload, null, 2)}`,
          outputFileName,
          'application/json;charset=utf-8',
          'json',
          saveHandlePromise,
        );
        UI.setStatus(`诊断日志导出完成：${events.length} 条，文件 ${fileName}`, 'ok');
        UI.setLogStatus(`已导出 ${events.length} 条诊断日志`, 'ok');
      } catch (error) {
        if (error && error.zhipinAutoExportCancelled) {
          UI.setStatus('已取消导出诊断日志', 'info');
          UI.setLogStatus('已取消导出诊断日志', 'info');
          return;
        }
        UI.setStatus(`导出诊断日志失败：${error.message || error}`, 'warn');
        UI.setLogStatus(`导出失败：${error.message || error}`, 'error');
      }
    },

    async clearLogs() {
      try {
        const count = loadStoredDebugEvents().length;
        const realtimeCount = LogWindow.records.length;
        if (!count && !realtimeCount) {
          UI.setStatus('暂无诊断日志可清除', 'info');
          UI.setLogStatus('暂无日志可清除', 'info');
          UI.renderDebugLogControls();
          return;
        }
        const scope = count ? `将清除 ${count} 条已保存事件` : '将清空当前实时日志';
        if (!(await askConfirm(`${scope}，此操作不可恢复。`, {
          title: '清除诊断日志',
          confirmText: '确认清除',
        }))) return;

        // 先清定时器，再清 localStorage、内存事件和面板里的实时日志。
        if (_debugFlushTimer) { clearTimeout(_debugFlushTimer); _debugFlushTimer = null; }
        runtime.debugEvents = [];
        localStorage.removeItem(APP.debugEventsKey);
        LogWindow.clear();
        UI.renderDebugLogControls();
        UI.setStatus(count ? `已清除 ${count} 条诊断日志` : '已清空实时日志', 'ok');
        UI.setLogStatus(count ? `已清除 ${count} 条诊断日志` : '已清空实时日志', 'ok');
      } catch (error) {
        UI.setStatus(`清除诊断日志失败：${error.message || error}`, 'warn');
        UI.setLogStatus(`清除失败：${error.message || error}`, 'error');
      }
    },
  };

  // 数据清理：只清理脚本写入 IndexedDB 的岗位记录，不动用户登录态和页面缓存。
  const RecordCleaner = {
    // 清空全部岗位记录和已沟通投影，适合重新开始一轮采集前使用。
    async clearAll() {
      try {
        if (!(await askConfirm('将删除全部岗位记录与已沟通列表。此操作不可恢复，确定要继续吗？', {
          title: '删除所有记录',
          confirmText: '全部删除',
        }))) return;

        UI.setStatus('正在删除所有岗位记录...', 'info');
        const jobCount = await Database.clearStore('jobRecords');
        const greetedCount = await Database.clearStore('greetedJobs');
        const remainingJobs = await Database.count('jobRecords');
        const remainingGreeted = await Database.count('greetedJobs');
        if (remainingJobs || remainingGreeted) {
          throw new Error(`删除后仍剩余 ${remainingJobs} 条岗位记录、${remainingGreeted} 条已沟通记录`);
        }

        ContactedIndex.reset();
        // 注：清理岗位记录不清空“已投递公司去重名单”（独立持久化，需在面板手动清空）。
        await UI.refreshGreetedList();
        runtime.ui.greetedRows = [];
        UI.renderVirtualList();
        UI.refreshDataOverview();
        UI.setStatus(`已删除 ${jobCount} 条岗位记录、${greetedCount} 条已沟通记录`, 'ok');
      } catch (error) {
        Automation.fatal(`清理数据失败：${error.message || error}`);
      }
    },

    // 按沟通时间删除旧记录，保留最近沟通过的岗位。
    async clearByTime() {
      try {
        UI.saveFormToConfig();
        const cutoff = parseDateTimeLocal(config.clearBeforeTime);
        if (!cutoff) {
          UI.setStatus('请选择要删除的截止沟通时间', 'warn');
          return;
        }

        const label = formatLocalDateTime(cutoff);
        if (!(await askConfirm(`将删除 ${label} 之前的岗位记录与已沟通记录。此操作不可恢复，确定要继续吗？`, {
          title: '按时间删除记录',
          confirmText: '确认删除',
        }))) return;

        UI.setStatus(`正在删除 ${label} 之前的记录...`, 'info');
        const shouldDelete = (record) => {
          const time = getRecordCommunicationTime(record);
          return time && Date.parse(time) <= cutoff.getTime();
        };
        const jobCount = await Database.deleteWhere('jobRecords', shouldDelete);
        const greetedCount = await Database.deleteWhere('greetedJobs', shouldDelete);
        await ContactedIndex.rebuild();
        await UI.refreshGreetedList();
        UI.refreshDataOverview();
        UI.setStatus(`已删除 ${jobCount} 条岗位记录、${greetedCount} 条已沟通记录`, 'ok');
      } catch (error) {
        Automation.fatal(`按时间清理失败：${error.message || error}`);
      }
    },
  };

  // 评分筛选服务：自动沟通前对岗位做关键词评分（可选附加模型语义分），
  // 在卡片上高亮并显示分数，低分岗位可按配置跳过沟通。
  const ScoreService = {
    lastResults: [],

    // 否定前缀：出现在关键词前表示"不要该方向"，不计入正面匹配。
    NEGATION_PREFIXES: ['不', '非', '勿', '无', '没', '免', '禁', '谢绝', '无需', '不要', '不用', '不招', '不需'],

    // 判断文本中关键词是否被否定前缀修饰（如"不招运维"中的"运维"不应命中）。
    // atIndex 允许调用方指定要检查的出现位置：长词去重后命中点可能不是第一次出现。
    isNegatedContext(normalizedText, keywordLower, atIndex) {
      const idx = atIndex === undefined ? normalizedText.indexOf(keywordLower) : atIndex;
      if (idx < 0) return false;
      const before = normalizedText.slice(Math.max(0, idx - 6), idx);
      return this.NEGATION_PREFIXES.some((prefix) => before.endsWith(prefix));
    },

    // 关键词评分：岗位名加权、技能加权、可配置权重、否定上下文检测。
    // text = 拼接后的岗位全文；jobTitle = 岗位名（用于加权）；skills = 技能列表（用于加权）。
    // 嵌套关键词按长度降序去重：长词先占位，短词只有落在未占位区间才计分，
    // 避免 "Java / Java后端 / 后端开发" 对同一段文字重复叠分把分数推高。
    scoreJob(text, jobTitle, skills) {
      const positives = expandMultiWordKeywords(parseKeywordList(config.scorePositive));
      const negatives = expandMultiWordKeywords(parseKeywordList(config.scoreNegative));
      const posWeight = readNumberConfig(config.scorePositiveWeight, 8);
      const negWeight = readNumberConfig(config.scoreNegativeWeight, 40);
      const titleBonus = readNumberConfig(config.scoreTitleBonus, 12);
      const skillBonus = readNumberConfig(config.scoreSkillBonus, 6);
      const negTitleBonus = readNumberConfig(config.scoreNegativeTitleBonus, 0);
      // 核心词必中：为空则不启用；启用时岗位全文必须命中至少一个。
      const coreWords = expandMultiWordKeywords(parseKeywordList(config.coreTerms));
      const coreEnabled = coreWords.length > 0;
      let coreHit = false;

      const normalizedText = String(text || '').toLocaleLowerCase();
      const titleLower = String(jobTitle || '').toLocaleLowerCase();
      const skillText = Array.isArray(skills) ? skills.join(' ').toLocaleLowerCase() : '';

      let score = 0;
      const reasons = [];
      const positiveMatches = [];
      const negativeMatches = [];
      // 岗位名里直接出现的负面词；scoreTitleNegativeReject 开启时用于硬否决。
      const titleNegativeMatches = [];

      // claimed 记录已被占位的文本区间；find 返回该词第一个未被占位的出现位置，全被占位则视为未命中。
      const claimedPositives = [];
      const claimedNegatives = [];
      const findFreeIndex = (wordLower, claimed) => {
        let from = 0;
        for (;;) {
          const idx = normalizedText.indexOf(wordLower, from);
          if (idx < 0) return -1;
          const end = idx + wordLower.length;
          if (!claimed.some(([start, stop]) => idx < stop && end > start)) return idx;
          from = idx + 1;
        }
      };
      const byLengthDesc = (a, b) => String(b).length - String(a).length;

      for (const word of positives.slice().sort(byLengthDesc)) {
        const wordLower = String(word).toLocaleLowerCase();
        const hitIndex = findFreeIndex(wordLower, claimedPositives);
        if (hitIndex < 0) continue;
        claimedPositives.push([hitIndex, hitIndex + wordLower.length]);

        // 否定上下文检测：文本中出现"不招运维"等否定表述时不计入正面
        if (this.isNegatedContext(normalizedText, wordLower, hitIndex)) {
          reasons.push(`否定忽略:${word}`);
          continue;
        }

        let bonus = 0;
        let location = '';
        // 岗位名命中加权（岗位名是最强信号）
        if (titleLower.includes(wordLower)) {
          bonus += titleBonus;
          location = '岗位名';
        }
        // 技能列表命中加权
        if (skillText.includes(wordLower)) {
          bonus += skillBonus;
          location = location ? `${location}+技能` : '技能';
        }
        const total = posWeight + bonus;
        score += total;
        reasons.push(`命中:${word}${location ? `(${location}+${bonus})` : `(+${posWeight})`}`);
        positiveMatches.push(word);
      }

      // 核心词必中判定：统计全部核心词在岗位全文中的命中情况。
      if (coreEnabled) {
        coreHit = coreWords.some((w) => {
          const wl = String(w).toLocaleLowerCase();
          return normalizedText.includes(wl) || titleLower.includes(wl) || skillText.includes(wl);
        });
      }

      for (const word of negatives.slice().sort(byLengthDesc)) {
        const wordLower = String(word).toLocaleLowerCase();
        const hitIndex = findFreeIndex(wordLower, claimedNegatives);
        if (hitIndex < 0) continue;
        claimedNegatives.push([hitIndex, hitIndex + wordLower.length]);

        // 负面词也做否定检测：如"非销售岗"中的"销售"不应扣分
        if (this.isNegatedContext(normalizedText, wordLower, hitIndex)) {
          reasons.push(`否定忽略:${word}`);
          continue;
        }

        // 岗位名直接含负面词：单独再查一次标题自身的否定上下文（如"非销售岗"不该硬否决）。
        if (titleLower.includes(wordLower) && !this.isNegatedContext(titleLower, wordLower)) {
          titleNegativeMatches.push(word);
        }

        let deduced = negWeight;
        // 岗位名命中负面词：额外扣分（标题含"销售/客服"几乎可断定岗位类型）。
        if (negTitleBonus && titleLower.includes(wordLower)) {
          deduced += negTitleBonus;
        }
        score -= deduced;
        reasons.push(`排除:${word}(-${deduced})`);
        negativeMatches.push(word);
      }

      return {
        score,
        reasons,
        positiveMatches,
        negativeMatches,
        titleNegativeMatches,
        titleNegativeHit: titleNegativeMatches.length > 0,
        // 核心词必中：启用后若核心词全未命中则整体判为不匹配。
        coreEnabled,
        coreHit,
        // keywordMatched 保留向后兼容，但过滤逻辑改用 grade
        keywordMatched: positiveMatches.length > 0 && negativeMatches.length === 0,
      };
    },

    // 等级：>= 高分阈值为 good，>= 中分阈值为 mid，否则 low。
    getGrade(score) {
      const good = readNumberConfig(config.scoreGoodThreshold, 35);
      const mid = readNumberConfig(config.scoreMidThreshold, 15);
      if (score >= good) return 'good';
      if (score >= mid) return 'mid';
      return 'low';
    },

    // 判断是否允许投递：核心词必中优先，其次岗位名负面硬否决，再次按分数与配置。
    shouldAllowDelivery(result) {
      // 核心词必中：启用且核心词全未命中 → 直接判不匹配，优先于分数。
      if (result.coreEnabled && !result.coreHit) return false;
      // 岗位名直接含负面词：不看分数，不给 good/mid 洗白的机会。
      if (config.scoreTitleNegativeReject && result.titleNegativeHit) return false;
      if (result.grade === 'good' || result.grade === 'mid') return true;
      // low 分：有正面词命中且无负面词时仍允许（避免误杀边缘岗位）
      if (result.positiveMatches.length > 0 && result.negativeMatches.length === 0) return true;
      // low 分 + 有负面词命中：跳过
      if (result.negativeMatches.length > 0) return false;
      // low 分 + 无任何命中：按 autoSkip 配置
      return !config.scoreAutoSkipLow;
    },

    // 综合评分入口：本地关键词分 + 可选模型语义分；高亮卡片并刷新面板列表。
    async scoreEntry(job, domInfo, card) {
      const jobTitle = (job && (job.jobName || job.title)) || '';
      const text = [
        jobTitle,
        (job && job.company) || '',
        (job && job.salary) || '',
        (domInfo && domInfo.text) || '',
      ].join(' ');
      const skills = (job && job.showSkills) || [];

      const local = this.scoreJob(text, jobTitle, skills);
      let modelDelta = 0;
      let modelScored = false;
      if (config.modelEnabled && config.modelScoreEnabled) {
        try {
          modelDelta = await this.scoreJobWithModel(text);
          modelScored = true;
          this.log('model_score', { jobName: jobTitle, score: modelDelta });
        } catch (error) {
          this.log('model_score_failed', { error: String((error && error.message) || error) });
        }
      }

      const score = local.score + modelDelta;
      const result = {
        title: jobTitle,
        company: (job && job.company) || '',
        score,
        reasons: local.reasons,
        positiveMatches: local.positiveMatches,
        negativeMatches: local.negativeMatches,
        titleNegativeMatches: local.titleNegativeMatches,
        titleNegativeHit: local.titleNegativeHit,
        keywordMatched: local.keywordMatched,
        coreEnabled: local.coreEnabled,
        coreHit: local.coreHit,
        modelDelta,
        modelScored,
        grade: this.getGrade(score),
        allowed: false,
      };
      result.allowed = this.shouldAllowDelivery(result);
      this.lastResults.push(result);
      if (this.lastResults.length > 50) this.lastResults.splice(0, this.lastResults.length - 50);

      if (config.scoreHighlight && card) this.markCard(card, result);
      this.renderResultList();
      return result;
    },

    // 在岗位卡片上打分数徽标并加边框高亮。
    markCard(card, result) {
      if (!card) return;
      card.classList.remove('za-score-good', 'za-score-mid', 'za-score-low');
      card.classList.add('za-score-' + result.grade);
      card.classList.add('za-scored');
      let badge = card.querySelector(':scope > .za-score-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'za-score-badge';
        card.appendChild(badge);
      }
      badge.textContent = String(result.score);
      badge.dataset.grade = result.grade;
    },

    // 面板「评分筛选」区块展示最近评分结果（Top N）。
    renderResultList() {
      if (!runtime.ui || !runtime.ui.scoreResultList) return;
      const list = this.lastResults.slice(-10).reverse();
      if (!list.length) {
        runtime.ui.scoreResultList.innerHTML = '<p class="za-hint">暂无评分结果：启动自动沟通后按列表岗位实时评分。</p>';
        return;
      }
      runtime.ui.scoreResultList.innerHTML = list.map((item) => (
        `<div class="za-score-row">` +
        `<span class="za-score-title" title="${escapeHtml(String(item.title || ''))}">${escapeHtml(String(item.title || '')).slice(0, 22)}</span>` +
        `<span class="za-score-grade za-score-grade-${item.grade}">${item.grade}</span>` +
        `<b class="za-score-value">${Number(item.score)}</b>` +
        (item.modelScored ? `<span class="za-score-model" title="含模型语义分">模型${item.modelDelta >= 0 ? '+' : ''}${Number(item.modelDelta)}</span>` : '') +
        (item.allowed === false ? `<span class="za-score-skip" title="${item.titleNegativeHit ? '岗位名含负面词：' + escapeHtml((item.titleNegativeMatches || []).join('、')) : '将跳过此岗位'}">${item.titleNegativeHit ? '负面词' : '跳过'}</span>` : '') +
        `</div>`
      )).join('');
    },

    // 模型语义评分：OpenAI 兼容 Chat Completions，-10 ~ +20。
    async scoreJobWithModel(text) {
      const prompt = [
        '你是岗位匹配度评分助手。判断下面的岗位描述与求职者方向「Java 后端开发（SpringBoot、SpringCloud、MySQL、Redis、消息队列、分布式、微服务、高并发）」的匹配程度。',
        '输出规则：只输出一个整数，范围 -10 到 +20。高度匹配给 15~20，部分相关给 5~14，弱相关给 -5~4，明显不相关给 -10~-6。',
        '',
        '岗位信息：',
        String(text || '').slice(0, 1500),
      ].join('\n');
      const content = await this.requestModelCompletion([
        { role: 'system', content: '你是岗位匹配度评分助手，只输出一个整数，不要输出其他内容。' },
        { role: 'user', content: prompt },
      ]);
      const match = String(content).match(/-?\d+/);
      const score = match ? Math.max(-10, Math.min(20, Number(match[0]))) : 0;
      return score;
    },

    // 直连模型接口（GM_xmlhttpRequest），返回完整响应。
    requestModel(messages) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          reject(new Error('GM_xmlhttpRequest 不可用，无法直连模型'));
          return;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (config.modelApiKey) headers.Authorization = `Bearer ${config.modelApiKey}`;
        GM_xmlhttpRequest({
          method: 'POST',
          url: String(config.modelBaseUrl || '').trim(),
          headers,
          data: JSON.stringify({
            model: String(config.modelName || '').trim(),
            messages,
            temperature: 0,
          }),
          timeout: 20000,
          onload: (response) => resolve(response),
          onerror: () => reject(new Error('模型请求失败（网络错误）')),
          ontimeout: () => reject(new Error('模型请求超时')),
        });
      });
    },

    // 调用模型并解析返回文本；失败抛错给调用方处理。
    async requestModelCompletion(messages) {
      if (!String(config.modelBaseUrl || '').trim()) throw new Error('模型 API 地址未配置');
      if (!String(config.modelName || '').trim()) throw new Error('模型名称未配置');
      const response = await this.requestModel(messages);
      let payload = null;
      try {
        payload = JSON.parse(response.responseText || '');
      } catch (_) {
        throw new Error(`模型返回非 JSON：${String(response.responseText || '').slice(0, 120)}`);
      }
      if (!response.status || response.status >= 400) {
        throw new Error((payload && (payload.error && payload.error.message || payload.message)) || `HTTP ${response.status}`);
      }
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回有效内容');
      return String(content).trim();
    },

    // 面板「测试模型」按钮：连通性测试。
    async testModel() {
      UI.setStatus('正在测试模型连接...', 'info');
      try {
        const reply = await this.requestModelCompletion([
          { role: 'user', content: '请回复：连接成功' },
        ]);
        UI.setStatus(`模型连接成功：${String(reply).slice(0, 60)}`, 'ok');
        logDebugEvent('model_test_ok', { reply: String(reply).slice(0, 120) });
      } catch (error) {
        UI.setStatus(`模型连接失败：${String((error && error.message) || error)}`, 'warn');
        logDebugEvent('model_test_failed', { error: String((error && error.message) || error) }, 'warn');
      }
    },

    log(step, data) {
      logDebugEvent(`score_${step}`, data || {});
    },
  };

  // 解析逗号/换行分隔的关键词列表（评分用）。
  function parseKeywordList(value) {
    return String(value || '').split(/[,，\n]+/).map((item) => String(item).trim()).filter(Boolean);
  }

  // 读取数值型配置：空串/非法值回退默认值，但显式 0 视为有效（阈值填 0 = 关闭该档判定）。
  function readNumberConfig(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  // 展开多词短语关键词（如 "Spring Boot"、"Spring Cloud"），按空格拆成独立词并去重，
  // 提升 Java 等大量多词技能词的召回，同时避免同一词重复叠分。
  function expandMultiWordKeywords(list) {
    const seen = new Set();
    const raw = [];
    for (const word of list) {
      const parts = String(word).split(/\s+/).filter(Boolean);
      for (const part of parts) {
        const key = part.toLocaleLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          raw.push(part);
        }
      }
    }
    return raw;
  }

  // 返回顶层 document 及所有可访问（同源）iframe 的 document（跨 frame 采集 DOM 用）。
  function getAccessibleDocuments() {
    const docs = [document];
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const inner = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (inner && inner !== document && inner.body && typeof inner.querySelectorAll === 'function') {
          docs.push(inner);
        }
      } catch (_) {
        // 跨域 iframe 无法访问，跳过。
      }
    }
    return docs;
  }

  // 懒加载 SheetJS，并放到隔离 sandbox 中执行，避免污染 BOSS 页面全局变量。
  async function loadSheetJs() {
    if (runtime.xlsx) return runtime.xlsx;

    UI.setStatus('正在加载 Excel 导出模块...', 'info');
    const code = await fetchText(APP.sheetJsUrl).catch((error) => {
      console.warn('[ZhipinAuto] 页面 fetch 加载 SheetJS 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(APP.sheetJsUrl);
    });
    const sandbox = {};
    const loader = new Function('sandbox', `
      const window = sandbox;
      const self = sandbox;
      const global = sandbox;
      const globalThis = sandbox;
      ${code}
      return sandbox.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    `);
    const XLSX = loader(sandbox);
    if (!XLSX || !XLSX.utils) throw new Error('SheetJS 加载失败');
    runtime.xlsx = XLSX;
    return XLSX;
  }

  // 普通跨域文本请求，主要用于拉取 SheetJS CDN 脚本。
  async function fetchText(url) {
    const response = await fetch(url, {
      cache: 'force-cache',
      credentials: 'omit',
      mode: 'cors',
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  // 抓取同源岗位/公司 HTML；页面 fetch 失败时用 GM_xmlhttpRequest 兜底。
  async function fetchJobHtml(url) {
    try {
      const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'include',
        mode: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 fetch 加载岗位 HTML 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(url);
    }
  }

  // Tampermonkey 网络兜底，用于跨域 CDN 或同源 fetch 被页面策略影响时。
  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('网络请求失败'));
        },
        ontimeout() {
          reject(new Error('网络请求超时'));
        },
      });
    });
  }

  // 给侧栏配置留两个入口：严格 JSON 对象，或者更适合手填的每行 key=value。
  function parseKeyValueConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} 必须是 JSON 对象`);
      }
      return parsed;
    } catch (jsonError) {
      const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const output = {};

      for (const line of lines) {
        const match = line.match(/^([^:=\s][^:=]*)\s*[:=]\s*([\s\S]*)$/);
        if (!match) {
          throw new Error(`${label} 格式错误，请填写 JSON 对象或每行 key=value`);
        }
        output[match[1].trim()] = match[2].trim();
      }

      return output;
    }
  }

  // 校验 key=value/JSON 配置是否能解析，启动前用于提前提示用户。
  function isParsableKeyValueConfig(text) {
    try {
      parseKeyValueConfig(text, '配置');
      return true;
    } catch (_) {
      return false;
    }
  }

  // 判断自定义接口 responsePath 是否像合法路径，避免把大段配置误填到路径框。
  function isLikelyResponsePath(path) {
    const value = String(path || '').trim();
    if (!value) return true;
    if (value.length > 120 || /[\s=:：,，。！？!？]/.test(value)) return false;
    return /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\.\d+)|(?:\[\d+\]))*$/.test(value);
  }

  // 请求体配置支持 JSON 或 key=value，最终在发送前做岗位字段插值。
  function parseRequestBodyConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      return JSON.parse(source);
    } catch (_) {
      if (/^[^:=\s][^:=]*\s*[:=]/m.test(source)) {
        return parseKeyValueConfig(source, label);
      }
      return source;
    }
  }

  // 对对象/数组/字符串递归执行 {field} 模板替换，用于自定义接口参数和请求体。
  function interpolateStructuredValue(value, job) {
    if (typeof value === 'string') return interpolateText(value, job);
    if (Array.isArray(value)) return value.map((item) => interpolateStructuredValue(item, job));
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce((output, key) => {
        output[key] = interpolateStructuredValue(value[key], job);
        return output;
      }, {});
    }
    return value;
  }

  // GET/HEAD 自定义接口把配置参数拼到 URL 查询串中。
  function appendQueryParams(url, params) {
    const target = new URL(url, location.href);
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value == null || value === '') return;

      if (Array.isArray(value)) {
        value.forEach((item) => target.searchParams.append(key, String(item)));
      } else {
        target.searchParams.set(key, String(value));
      }
    });
    return target.href;
  }

  // 请求头配置归一化，过滤空 key，避免 fetch 抛无意义错误。
  function normalizeHeaderMap(headers) {
    return Object.keys(headers || {}).reduce((output, key) => {
      const value = headers[key];
      if (value != null && value !== '') output[key] = String(value);
      return output;
    }, {});
  }

  // 从自定义接口 JSON 中按 a.b.0.c 形式取值，用于 responsePath 配置。
  function getValueByPath(source, path) {
    const keys = String(path || '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((key) => key.trim())
      .filter(Boolean);

    return keys.reduce((target, key) => (target == null ? undefined : target[key]), source);
  }

  // 请求外部接口生成问候语。接口可用岗位数据、当前页面地址和时间做上下文。
  async function requestExternalText(url, method, payload) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const headers = normalizeHeaderMap(interpolateStructuredValue(parseKeyValueConfig(config.customApiHeaders, '请求头'), payload.job || {}));
    const params = interpolateStructuredValue(parseKeyValueConfig(config.customApiParams, 'URL 参数'), payload.job || {});
    const requestUrl = appendQueryParams(interpolateText(url, payload.job || {}), params);
    const requestBody = buildCustomApiBody(requestMethod, payload, headers);

    const responseText = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: requestMethod,
        url: requestUrl,
        headers: Object.keys(headers).length ? headers : undefined,
        data: requestBody,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || '');
          } else {
            reject(new Error(`接口返回 HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('自定义文本接口请求失败'));
        },
        ontimeout() {
          reject(new Error('自定义文本接口超时'));
        },
      });
    });

    try {
      const json = JSON.parse(responseText);
      return extractMessageFromJson(json, config.customApiResponsePath);
    } catch (_) {
      return responseText;
    }
  }

  // 根据请求方法和 Content-Type 构造请求体；GET/HEAD 不带 body。
  function buildCustomApiBody(method, payload, headers) {
    if (method === 'GET' || method === 'HEAD') return undefined;

    const bodySource = String(config.customApiBody || '').trim();
    const hasContentType = Object.keys(headers || {}).some((key) => key.toLowerCase() === 'content-type');

    if (!bodySource) {
      if (!hasContentType) headers['Content-Type'] = 'application/json';
      return JSON.stringify(payload);
    }

    const parsed = parseRequestBodyConfig(bodySource, '请求体');
    const value = interpolateStructuredValue(parsed, payload.job || {});
    if (typeof value === 'string') return value;

    if (!hasContentType) headers['Content-Type'] = 'application/json';
    return JSON.stringify(value);
  }

  // 从外部接口响应中提取最终问候语文本，支持显式路径和常见字段名兜底。
  function extractMessageFromJson(json, responsePath) {
    if (responsePath) {
      const selected = getValueByPath(json, responsePath);
      if (selected == null || selected === '') {
        throw new Error(`接口返回中未找到路径：${responsePath}`);
      }
      return typeof selected === 'string' ? selected : JSON.stringify(selected);
    }

    const directPaths = [
      ['message'],
      ['text'],
      ['content'],
      ['data', 'message'],
      ['data', 'text'],
      ['data', 'content'],
      ['data', 'greeting'],
    ];

    for (const path of directPaths) {
      const value = path.reduce((target, key) => target && target[key], json);
      if (typeof value === 'string' && value.trim()) return value;
    }

    let first = '';
    walkObject(json, (value) => {
      if (!first && typeof value === 'string' && value.trim().length >= 2) {
        first = value;
      }
    });
    return first;
  }

  // 岗位列表页左侧卡片选择器，自动化遍历岗位从这里开始。
  // 使用平台适配器的选择器
  function getJobCards() {
    // 获取当前平台的卡片选择器
    const selector = currentPlatform?.selectors?.jobCard || 'li.job-card-box';
    // 直接用 querySelectorAll 获取所有卡片，内联快速可见性检查避免 isVisible 的 getComputedStyle 开销
    const all = document.querySelectorAll(selector);
    const visible = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.offsetWidth > 0 || el.offsetHeight > 0) visible.push(el);
    }
    return visible;
  }

  // 虚拟列表会反复销毁和创建卡片节点，因此扫描进度必须依赖稳定岗位标识而不是 DOM 下标。
  function getJobScanKey(job, domInfo) {
    const reliableKeys = getReliableJobIdentityKeys(job);
    if (reliableKeys.length) return `id:${reliableKeys[0]}`;

    const domKey = domInfo && (domInfo.keys || []).map(normalizeText).find(Boolean);
    if (domKey) return `dom:${domKey}`;

    const looseSignature = job && (job.looseSignature || makeLooseSignature(job.jobName, job.company)) ||
      domInfo && domInfo.looseSignature;
    if (isMeaningfulCompositeKey(looseSignature)) return `loose:${looseSignature}`;

    const signature = job && (job.signature || makeSignature(job.jobName, job.company, job.salary)) ||
      domInfo && domInfo.signature;
    return isMeaningfulCompositeKey(signature) ? `signature:${signature}` : '';
  }

  function getCardScanEntry(card, index) {
    const domInfo = extractCardInfo(card);
    const job = runtime.cardJobMap.get(card) || JobRepository.normalizeDomOnlyJob(card, index);
    return {
      card,
      domInfo,
      job,
      key: getJobScanKey(job, domInfo),
    };
  }

  function getVisibleJobScanEntries() {
    return JobRepository.syncCards().map((card, index) => getCardScanEntry(card, index));
  }

  function getProcessedJobKeySet(state) {
    return new Set(Array.isArray(state && state.processedKeys) ? state.processedKeys.filter(Boolean) : []);
  }

  function buildProcessedJobPatch(state, job, domInfo, extra) {
    const processedKeys = getProcessedJobKeySet(state);
    const key = getJobScanKey(job, domInfo);
    const pendingKey = normalizeText(state && state.pendingJobKey);
    if (pendingKey) processedKeys.add(pendingKey);
    if (key) processedKeys.add(key);
    return Object.assign({
      processedKeys: Array.from(processedKeys),
      cursorIndex: Math.max(Number(state && state.cursorIndex || 0) + 1, processedKeys.size),
      scanDiscoveredCount: Math.max(Number(state && state.scanDiscoveredCount || 0), processedKeys.size),
      scanNoProgressCount: 0,
    }, extra || {});
  }

  // 保存真实左栏滚动容器的位置和当前卡片锚点，聊天返回或完整恢复 URL 后可以继续扫描。
  function captureJobListPosition(preferredJob) {
    const cards = getJobCards();
    const preferredKey = getJobScanKey(preferredJob);
    const anchor = cards.find((card, index) => {
      if (!preferredKey) return false;
      return getCardScanEntry(card, index).key === preferredKey;
    }) || cards.find((card) => /active|selected|cur|current/.test(String(card.className || ''))) || cards[0];
    const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
    const anchorIndex = anchor ? cards.indexOf(anchor) : -1;
    const anchorEntry = anchorIndex >= 0 ? getCardScanEntry(anchor, anchorIndex) : null;
    return {
      listScrollTop: Math.max(0, Number(scroller && scroller.scrollTop || 0)),
      listAnchorKey: anchorEntry && anchorEntry.key || preferredKey || '',
    };
  }

  async function restoreJobListPosition(state) {
    if (!state || !isJobListRoute()) return false;
    await waitForVisibleJobList(Math.max(3000, getWaitTimeout() * 1000));
    JobRepository.syncCards();

    const targetTop = Math.max(0, Number(state.listScrollTop || 0));
    const anchorKey = normalizeText(state.listAnchorKey);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const entries = getVisibleJobScanEntries();
      const anchored = anchorKey && entries.find((item) => item.key === anchorKey);
      if (anchored) {
        anchored.card.scrollIntoView({ block: 'center', inline: 'nearest' });
        return true;
      }

      const anchor = entries.length ? entries[0].card : document.querySelector('li.job-card-box') || getJobCards()[0];
      const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
      if (!scroller || targetTop <= 0) break;
      const beforeTop = Number(scroller.scrollTop || 0);
      const beforeRenderSignature = getVisibleJobListRenderSignature();
      const beforeResponseSerial = Number(runtime.jobListResponseSerial || 0);
      scroller.scrollTop = targetTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForJobListRenderChange(beforeRenderSignature, beforeResponseSerial, 700);
      JobRepository.syncCards();
      if (Number(scroller.scrollTop || 0) >= targetTop - 2 || Number(scroller.scrollTop || 0) <= beforeTop) break;
    }
    return Boolean(targetTop > 0);
  }

  // 保留旧游标字段用于日志和记录兼容；实际扫描进度由 processedKeys 决定。
  function findSelectedCardIndex() {
    const cards = getJobCards();
    const selected = cards.findIndex((card) => {
      const className = String(card.className || '');
      return /active|selected|cur|current/.test(className);
    });
    return selected >= 0 ? selected : 0;
  }

  // 从 DOM 卡片提取岗位名、公司、薪资、城市和可用于匹配的 key。
  // 使用单个复合选择器减少 DOM 查询次数。
  const JOB_NAME_SELECTOR = 'a.job-name, .job-name a, .job-name, a[class*="job-name"], .job-title a, .job-title, [class*="job-name"], .job-card__name, .jobinfo__name';
  const SALARY_SELECTOR = '.job-salary, .salary, [class*="salary"]';
  const COMPANY_SELECTOR = '.boss-name, .company-name, .company-text, .job-card__company-name, .companyinfo__name';
  const CITY_SELECTOR = '.company-location, [class*="location"], .job-card__location, .jobinfo__other-info-item';
  const DATA_ATTR_SELECTOR = 'a, [data-jobid], [data-job-id], [data-id], [data-lid], [data-securityid], [data-security-id]';
  const DATA_ATTRS = ['data-jobid', 'data-job-id', 'data-id', 'data-lid', 'data-securityid', 'data-security-id'];
  // BOSS 用 /job_detail/，智联用 /jobdetail/，老版智联职位链接以 .htm 结尾。
  const HREF_JOB_DETAIL_RE = /\/job_?detail\/([A-Za-z0-9_~-]+)(?:\.html|\.htm)?/i;
  const HREF_JOB_ID_RE = /(?:jobId=|encryptJobId=|securityId=)([A-Za-z0-9_~-]+)/g;

  function extractCardInfo(card) {
    const text = normalizeText(card.innerText || card.textContent || '');
    const salaryEl = card.querySelector(SALARY_SELECTOR);
    const salary = normalizeText((salaryEl && salaryEl.textContent) || '');
    const jobNameEl = card.querySelector(JOB_NAME_SELECTOR);
    const rawJobName = jobNameEl ? normalizeText((jobNameEl.innerText || jobNameEl.textContent)) : '';
    const jobName = cleanDomJobName(rawJobName, salary);
    const companyEl = card.querySelector(COMPANY_SELECTOR);
    const company = normalizeText((companyEl && companyEl.textContent) || '');
    const cityEl = card.querySelector(CITY_SELECTOR);
    const city = normalizeText((cityEl && cityEl.textContent) || '');
    const keys = [];

    const elements = Array.from(card.querySelectorAll(DATA_ATTR_SELECTOR));
    elements.unshift(card);
    for (const element of elements) {
      for (let i = 0; i < DATA_ATTRS.length; i++) {
        const value = element.getAttribute && element.getAttribute(DATA_ATTRS[i]);
        if (value) keys.push(value);
      }

      const href = element.getAttribute && element.getAttribute('href');
      if (href) {
        const detailMatch = HREF_JOB_DETAIL_RE.exec(href);
        if (detailMatch && detailMatch[1]) keys.push(detailMatch[1]);

        let match;
        HREF_JOB_ID_RE.lastIndex = 0;
        while ((match = HREF_JOB_ID_RE.exec(href)) !== null) {
          const value = match.split(/[=/]/).pop();
          if (value) keys.push(value);
        }
      }
    }

    const fallbackLines = text.split(/\s+/).filter(Boolean);
    const fallbackName = fallbackLines[0] || '';
    const finalName = jobName || fallbackName;
    return {
      text,
      jobName: finalName,
      salary,
      company,
      city,
      keys: Array.from(new Set(keys.map(String))),
      signature: makeSignature(finalName, company, salary),
      looseSignature: makeLooseSignature(finalName, company),
    };
  }

  // 按选择器列表读取第一个非空文本，用来兼容 BOSS 多版 DOM 结构。
  function readFirstElementText(root, selectors) {
    for (const selector of selectors || []) {
      const element = root && root.querySelector && root.querySelector(selector);
      const text = normalizeText(element && (element.innerText || element.textContent));
      if (text) return text;
    }
    return '';
  }

  // DOM 中岗位名有时会拼接薪资，这里剥离薪资后再做签名匹配。
  function cleanDomJobName(jobName, salary) {
    let text = normalizeText(jobName);
    const salaryText = normalizeText(salary);
    if (salaryText) text = normalizeText(text.replace(salaryText, ''));
    text = text.replace(/[\uE000-\uF8FF][\uE000-\uF8FF\d.,+\-~Kk万年月薪\/·]*$/g, '');
    return normalizeText(text);
  }

  // 从详情 DOM/HTML 中读取 Boss 活跃度；在线标签和普通活跃时间位于不同节点。
  function extractBossActiveInfoFromRoot(root, hiddenClasses, options) {
    const container = root && root.querySelector
      ? (root.querySelector('.job-detail-body') || root)
      : null;
    if (!container) return {};

    const visibleOnly = !(options && options.visibleOnly === false);
    const onlineElement = findBossActiveElement(container, '.boss-online-tag', visibleOnly);
    if (onlineElement) {
      return {
        bossActiveTimeDesc: cleanBossActiveElementText(onlineElement, hiddenClasses) || '在线',
        bossOnline: true,
      };
    }

    const activeElement = findBossActiveElement(container, '.boss-active-time', visibleOnly);
    const activeText = cleanBossActiveElementText(activeElement, hiddenClasses);
    if (!activeText) return {};

    return {
      bossActiveTimeDesc: activeText,
      bossOnline: normalizeBossActiveText(activeText) === '在线',
    };
  }

  // 在指定根节点中查找活跃度元素，可按调用场景选择是否要求可见。
  function findBossActiveElement(root, selector, visibleOnly) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .find((element) => !visibleOnly || isVisible(element));
  }

  // 清洗活跃度节点文本，移除图标/隐藏节点后归一成可匹配标签。
  function cleanBossActiveElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, i, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    const text = hiddenClasses
      ? cleanElementText(clone, hiddenClasses)
      : normalizeText(clone.textContent || clone.innerText || element.getAttribute('title') || element.getAttribute('aria-label') || '');
    return getBossActiveOptionLabel(text);
  }

  // 从右侧岗位详情 DOM 读取可见信息，作为详情接口缺失时的补充。
  function extractDetailInfo() {
    const root = Array.from(document.querySelectorAll('.job-detail-box'))
      .find((element) => isVisible(element));
    if (!root) return {};

    const detail = {};
    const jobName = normalizeText((root.querySelector('.job-detail-header .job-name') || {}).textContent || '');
    const salary = getReadableSalary((root.querySelector('.job-detail-header .job-salary') || {}).textContent || '');
    if (jobName) detail.jobName = jobName;
    if (salary) detail.salary = salary;

    const bossRoot = root.querySelector('.job-boss-info');
    if (bossRoot) {
      const nameElement = bossRoot.querySelector('h2.name');
      if (nameElement) {
        const clone = nameElement.cloneNode(true);
        clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
        detail.bossName = normalizeText(clone.textContent || '');
      }

      const attr = normalizeText((bossRoot.querySelector('.boss-info-attr') || {}).textContent || '');
      const parts = attr.split('·').map(normalizeText).filter(Boolean);
      if (parts[0]) detail.company = parts[0];
      if (parts.length > 1) detail.bossTitle = parts[parts.length - 1];
    }

    const bossActiveInfo = extractBossActiveInfoFromRoot(root);
    if (bossActiveInfo.bossActiveTimeDesc) detail.bossActiveTimeDesc = bossActiveInfo.bossActiveTimeDesc;
    if (bossActiveInfo.bossOnline) detail.bossOnline = true;

    const tags = Array.from(root.querySelectorAll('.job-detail-header .tag-list li'))
      .map((element) => normalizeText(element.textContent || ''))
      .filter(Boolean);
    if (tags[0]) detail.city = tags[0];
    if (tags[1]) detail.experience = tags[1];
    if (tags[2]) detail.degree = tags[2];

    const address = normalizeText((root.querySelector('.job-address-desc') || {}).textContent || '');
    if (address) detail.address = address;

    return detail;
  }

  // 根据岗位 key 组装详情接口 URL，用于主动补拉详情。
  function getJobDetailRequestIdentity(job) {
    const rawJob = job && job.rawJob || {};
    const rawDetail = job && job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const identity = {
      encryptJobId: normalizeText(job && (
        job.encryptJobId ||
        rawJob.encryptJobId ||
        rawJob.encryptId ||
        rawJob.jobId ||
        rawJob.job_id ||
        rawJobInfo.encryptJobId ||
        rawJobInfo.encryptId ||
        rawJobInfo.jobId ||
        rawJobInfo.job_id
      )),
      securityId: normalizeText(job && (job.securityId || rawJob.securityId || rawDetail.securityId || rawJobInfo.securityId)),
      lid: normalizeText(job && (job.lid || rawJob.lid || rawDetail.lid || rawJobInfo.lid)),
    };

    getRouteJobDetailIdentities().some((routeIdentity) => {
      if (!isRouteIdentityCompatible(identity, routeIdentity)) return false;
      if (!identity.encryptJobId && routeIdentity.encryptJobId) identity.encryptJobId = routeIdentity.encryptJobId;
      if (!identity.securityId && routeIdentity.securityId) identity.securityId = routeIdentity.securityId;
      if (!identity.lid && routeIdentity.lid) identity.lid = routeIdentity.lid;
      return Boolean(identity.securityId && identity.lid);
    });

    return identity;
  }

  function buildJobDetailApiUrl(job) {
    const identity = getJobDetailRequestIdentity(job);
    const securityId = identity.securityId;
    const lid = identity.lid;
    if (!securityId || !lid) return '';

    const url = new URL('/wapi/zpgeek/job/detail.json', location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('lid', lid);
    url.searchParams.set('_', String(Date.now()));
    return url.href;
  }

  function getRouteJobDetailIdentities() {
    return [
      runtime.latestRouteUrl,
      runtime.initialPageUrl,
      location.href,
    ]
      .map(parseJobDetailIdentityFromUrl)
      .filter(Boolean);
  }

  function parseJobDetailIdentityFromUrl(href) {
    try {
      if (!href) return null;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;

      const pathname = url.pathname.replace(/\/+$/, '');
      const detailMatch = pathname.match(/\/job_detail\/([A-Za-z0-9_~-]+)(?:\.html)?$/);
      const encryptJobId = normalizeText(
        url.searchParams.get('jobId') ||
        url.searchParams.get('encryptJobId') ||
        url.searchParams.get('encryptId') ||
        (detailMatch && detailMatch[1])
      );
      const securityId = normalizeText(url.searchParams.get('securityId'));
      const lid = normalizeText(url.searchParams.get('lid'));
      if (!encryptJobId && !securityId && !lid) return null;

      return { encryptJobId, securityId, lid, href: url.href };
    } catch (_) {
      return null;
    }
  }

  function isRouteIdentityCompatible(jobIdentity, routeIdentity) {
    if (!routeIdentity) return false;
    const jobId = normalizeText(jobIdentity && jobIdentity.encryptJobId);
    const routeJobId = normalizeText(routeIdentity.encryptJobId);
    if (jobId && routeJobId && jobId !== routeJobId) return false;
    return true;
  }

  // 从 performance 资源记录里找最近一次列表接口，主动补抓时使用。
  function findLatestJobListApiUrl() {
    const resource = findLatestJobListApiResource();
    return resource && resource.url || '';
  }

  // 返回最近列表资源的 URL 和完成时间；对象形式便于与 fetch/XHR 捕获记录按时间统一排序。
  function findLatestJobListApiResource() {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;

    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobListApiPattern.test(entry.name))
      .sort((a, b) => b.startTime - a.startTime);
    if (!entries.length) return null;
    return {
      url: entries[0].name,
      capturedAt: getResourceEntryCompletedAt(entries[0]),
      source: 'performance-buffer',
    };
  }

  // 从 performance 资源记录里找点击岗位后出现的详情接口。
  function findLatestJobDetailApiUrl(resourceStartedAt) {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return '';

    const minimumStart = Math.max(0, Number(resourceStartedAt || 0) - 100);
    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobDetailApiPattern.test(entry.name) && entry.startTime >= minimumStart)
      .sort((a, b) => b.startTime - a.startTime);
    return entries.length ? entries[0].name : '';
  }

  // 根据详情字段拼出岗位 HTML 页面地址，用于补抓描述和公司信息。
  function buildJobHtmlDetailUrl(detail) {
    const encryptJobId = normalizeText(detail && detail.encryptJobId);
    const securityId = normalizeText(detail && detail.securityId);
    if (!encryptJobId || !securityId) return '';

    const url = new URL(`/job_detail/${encodeURIComponent(encryptJobId)}.html`, location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('ka', `company_more_job_${encryptJobId}`);
    return url.href;
  }

  // 根据详情字段拼出公司主页地址，用于补抓工商信息。
  function buildCompanyHtmlUrl(detail) {
    const rawDetail = detail && detail.rawDetail || {};
    const brandInfo = rawDetail.brandComInfo || rawDetail.brandInfo || rawDetail.companyInfo || {};
    const brandId = normalizeText(detail && detail.brandId) ||
      normalizeText(detail && detail.rawJob && detail.rawJob.encryptBrandId) ||
      normalizeText(brandInfo.encryptBrandId);
    if (!brandId) return '';

    return new URL(`/gongsi/${encodeURIComponent(brandId)}.html`, location.origin).href;
  }

  // 解析岗位详情 HTML，提取接口没有给全的岗位描述、地址、公司链接等。
  function parseJobHtmlDetail(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const jobInfo = extractInlineJobInfo(html);
    const bossInfo = parseBossHtmlInfo(doc, hiddenClasses);
    const sideCompany = parseSideCompanyInfo(doc, hiddenClasses);
    const mapElement = doc.querySelector('.company-address .job-location-map, .job-location-map');
    const mapPoint = parseMapPoint(mapElement && mapElement.getAttribute('data-lat'));
    const companyFullName = businessInfo['公司名称'] || businessInfo['企业名称'] || '';
    const companyShortName = normalizeText(jobInfo.company) ||
      firstTextFromSelectors(doc, [
        '.sider-company .company-info a[title]',
        '.sider-company .company-info a:last-child',
        '.smallbanner .detail-op .info',
      ], hiddenClasses);

    const postDescriptionElement = doc.querySelector('.job-detail .job-keyword-list + .job-sec-text') ||
      Array.from(doc.querySelectorAll('.job-detail > .job-detail-section .job-sec-text'))
        .find((element) => /岗位|职责|任职|要求|经验|开发|工作/.test(cleanElementText(element, hiddenClasses)));
    const companyIntroduceElement = doc.querySelector('.job-detail-company .company-info-box .job-sec-text');
    const addressElement = doc.querySelector('.company-address .location-address') ||
      doc.querySelector('.job-location .location-address');
    const htmlSalary = firstTextFromSelectors(doc, [
      '.job-primary .salary',
      '.smallbanner .salary',
      '.smallbanner .badge',
      '.job-banner .salary',
      'span.salary',
    ], hiddenClasses);

    const detail = {
      jobName: textFromSelector(doc, '.job-primary .name h1, .smallbanner .job-title', hiddenClasses) ||
        normalizeText(jobInfo.job_name),
      salary: getReadableSalary(htmlSalary || jobInfo.job_salary),
      company: companyFullName || companyShortName,
      companyShortName,
      companyFullName,
      city: textFromSelector(doc, '.job-primary .text-city', hiddenClasses),
      experience: textFromSelector(doc, '.job-primary .text-experiece, .job-primary .text-experience', hiddenClasses),
      degree: textFromSelector(doc, '.job-primary .text-degree', hiddenClasses),
      showSkills: textsFromSelector(doc, '.job-keyword-list li', hiddenClasses),
      companyLabels: textsFromSelector(doc, '.job-primary .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)
        .concat(textsFromSelector(doc, '.smallbanner .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)),
      postDescription: cleanElementText(postDescriptionElement, hiddenClasses),
      bossName: bossInfo.bossName,
      bossTitle: bossInfo.bossTitle,
      bossActiveTimeDesc: bossInfo.bossActiveTimeDesc,
      bossOnline: bossInfo.bossOnline,
      address: cleanElementText(addressElement, hiddenClasses),
      workAddress: cleanElementText(addressElement, hiddenClasses),
      longitude: mapPoint && mapPoint.longitude,
      latitude: mapPoint && mapPoint.latitude,
      encryptAddressId: mapElement && normalizeText(mapElement.getAttribute('data-addressid')),
      companyIntroduce: cleanElementText(companyIntroduceElement, hiddenClasses),
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立日期'] || businessInfo['成立时间'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资金'] || businessInfo['注册资本'] || '',
      companyStage: sideCompany.companyStage,
      companyScale: sideCompany.companyScale,
      companyIndustry: sideCompany.companyIndustry,
      htmlDetailUrl: sourceUrl,
      htmlCapturedAt: nowIso(),
      rawHtmlDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    };

    detail.companyLabels = Array.from(new Set(detail.companyLabels.filter(Boolean)));
    detail.showSkills = Array.from(new Set(detail.showSkills.filter(Boolean)));
    return compactObject(detail);
  }

  // 解析公司主页 HTML 中的工商信息，最终会合并进岗位记录并导出。
  function parseCompanyBusinessHtml(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const companyFullName = businessInfo['企业名称'] || businessInfo['公司名称'] || '';

    return compactObject({
      company: companyFullName,
      companyFullName,
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立时间'] || businessInfo['成立日期'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资本'] || businessInfo['注册资金'] || '',
      registeredAddress: businessInfo['注册地址'] || '',
      businessTerm: businessInfo['营业期限'] || '',
      businessRegion: businessInfo['所属地区'] || '',
      unifiedSocialCreditCode: businessInfo['统一社会信用代码'] || '',
      approvalDate: businessInfo['核准日期'] || '',
      formerName: businessInfo['曾用名'] || '',
      registrationAuthority: businessInfo['登记机关'] || '',
      businessIndustry: businessInfo['所属行业'] || '',
      businessScope: businessInfo['经营范围'] || '',
      companyDetailUrl: sourceUrl,
      companyDetailCapturedAt: nowIso(),
      rawCompanyDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    });
  }

  // 从页面内联 JSON/脚本片段中兜底提取岗位信息。
  function extractInlineJobInfo(html) {
    const match = String(html || '').match(/var\s+_jobInfo\s*=\s*(\{[\s\S]*?\});/);
    if (!match) return {};

    try {
      const source = match[1]
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      return JSON.parse(source);
    } catch (_) {
      return {};
    }
  }

  // BOSS HTML 里可能有隐藏节点；先收集隐藏 class，后续提取文本时跳过。
  function getHtmlHiddenClassNames(doc) {
    const hidden = new Set();
    const styles = Array.from(doc.querySelectorAll('style'))
      .map((style) => style.textContent || '')
      .join('\n');
    const pattern = /\.([A-Za-z_-][\w-]*)\s*\{([^}]*)\}/g;
    let match = pattern.exec(styles);

    while (match) {
      const body = match[2];
      if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|width\s*:\s*0\.?1?px|height\s*:\s*0\.?1?px/i.test(body)) {
        hidden.add(match[1]);
      }
      match = pattern.exec(styles);
    }

    return hidden;
  }

  // 读取单个选择器文本，并过滤隐藏节点内容。
  function textFromSelector(root, selector, hiddenClasses) {
    return cleanElementText(root && root.querySelector(selector), hiddenClasses);
  }

  // 多选择器兜底读取第一个非空文本。
  function firstTextFromSelectors(root, selectors, hiddenClasses) {
    for (const selector of selectors) {
      const candidates = Array.from(root ? root.querySelectorAll(selector) : []);
      for (const candidate of candidates) {
        const text = cleanElementText(candidate, hiddenClasses);
        if (text) return text.replace(/\s*查看所有职位.*/g, '').trim();
      }
    }
    return '';
  }

  // 读取同类节点的文本列表，例如技能标签、福利标签。
  function textsFromSelector(root, selector, hiddenClasses) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .map((element) => cleanElementText(element, hiddenClasses))
      .filter(Boolean);
  }

  // 克隆节点后移除隐藏子节点，避免把页面埋点/SEO 文本误采进记录。
  function cleanElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    clone.querySelectorAll('*').forEach((item) => {
      const style = String(item.getAttribute('style') || '');
      const hiddenByStyle = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
      const hiddenByClass = Array.from(item.classList || []).some((className) => hiddenClasses && hiddenClasses.has(className));
      if (hiddenByStyle || hiddenByClass || item.hidden) item.remove();
    });
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return normalizeTextPreserveLines(clone.textContent || '');
  }

  // 从公司页中识别“法人/注册资本/经营范围”等工商字段。
  function extractBusinessInfo(doc, hiddenClasses) {
    const output = {};
    doc.querySelectorAll([
      '.business-info-box .level-list li',
      '.company-business .business-detail li',
    ].join(',')).forEach((item) => {
      const labelElement = item.querySelector('.t, span');
      const label = cleanElementText(labelElement, hiddenClasses).replace(/[：:]$/, '');
      if (!label) return;

      const clone = item.cloneNode(true);
      const clonedLabel = clone.querySelector('.t, span');
      if (clonedLabel) clonedLabel.remove();
      const value = cleanElementText(clone, hiddenClasses);
      if (value) output[label] = value;
    });
    return output;
  }

  // 从岗位 HTML 中解析 Boss 姓名、职位、活跃状态等聊天前有用字段。
  function parseBossHtmlInfo(doc, hiddenClasses) {
    const nameElement = doc.querySelector('.job-boss-info h2.name');
    let bossName = '';
    if (nameElement) {
      const clone = nameElement.cloneNode(true);
      clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
      bossName = cleanElementText(clone, hiddenClasses);
    }

    const attr = textFromSelector(doc, '.job-boss-info .boss-info-attr', hiddenClasses);
    const parts = attr.split('·').map(normalizeText).filter(Boolean);
    const bossActiveInfo = extractBossActiveInfoFromRoot(doc, hiddenClasses, { visibleOnly: false });
    return {
      bossName,
      bossTitle: parts.length > 1 ? parts[parts.length - 1] : '',
      bossActiveTimeDesc: bossActiveInfo.bossActiveTimeDesc,
      bossOnline: Boolean(bossActiveInfo.bossOnline),
    };
  }

  // 从岗位详情侧栏读取公司简称、阶段、规模等补充信息。
  function parseSideCompanyInfo(doc, hiddenClasses) {
    const side = doc.querySelector('.sider-company');
    const rows = Array.from(side ? side.querySelectorAll('p') : [])
      .map((row) => cleanElementText(row, hiddenClasses))
      .filter((text) => text && text !== '公司基本信息');

    return {
      companyStage: rows[0] || '',
      companyScale: rows[1] || '',
      companyIndustry: rows[2] || '',
    };
  }

  // 解析地图坐标字符串，导出时拆成经纬度字段。
  function parseMapPoint(value) {
    const parts = String(value || '').split(',').map((item) => Number(item));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return {
      longitude: parts[0],
      latitude: parts[1],
    };
  }

  // 读取 HTML meta 内容，作为标题/描述等兜底来源。
  function getMetaContent(doc, name) {
    const element = doc.querySelector(`meta[name="${name}"]`);
    return normalizeText(element && element.getAttribute('content'));
  }

  // 合并岗位信息：后到的详情字段覆盖空值或更低质量字段，保留原始 raw 数据。
  function mergeJobInfo(job, detail) {
    if (!detail || !Object.keys(detail).length) return job;

    const merged = Object.assign({}, job);
    const readableDetailSalary = getReadableSalary(detail.salary);

    for (const key of ['jobName', 'company', 'bossName', 'bossTitle', 'city', 'experience', 'degree']) {
      if (detail[key] && (!merged[key] || merged.domOnly)) {
        merged[key] = detail[key];
      }
    }

    if (detail.company && merged.company !== detail.company) {
      merged.company = detail.company;
    }
    if (detail.bossName) merged.bossName = detail.bossName;
    if (detail.bossTitle) merged.bossTitle = detail.bossTitle;
    if (detail.jobName && (!merged.jobName || merged.domOnly)) merged.jobName = detail.jobName;
    if (readableDetailSalary) {
      merged.salary = readableDetailSalary;
    }

    [
      'positionName',
      'bossActiveTimeDesc',
      'bossOnline',
      'bossAvatar',
      'bossCertificated',
      'address',
      'longitude',
      'latitude',
      'staticMapUrl',
      'encryptAddressId',
      'postDescription',
      'recruitmentCountDesc',
      'positionCode',
      'jobType',
      'jobStatusDesc',
      'showSkills',
      'companyLogo',
      'companyFullName',
      'companyShortName',
      'companyStage',
      'companyScale',
      'companyIndustry',
      'companyIntroduce',
      'companyLabels',
      'businessInfo',
      'legalRepresentative',
      'establishedDate',
      'companyType',
      'manageState',
      'registeredCapital',
      'registeredAddress',
      'businessTerm',
      'businessRegion',
      'unifiedSocialCreditCode',
      'approvalDate',
      'formerName',
      'registrationAuthority',
      'businessIndustry',
      'businessScope',
      'brandId',
      'detailSource',
      'detailSourceUrl',
      'detailCapturedAt',
      'workAddress',
      'htmlDetailUrl',
      'htmlCapturedAt',
      'companyDetailUrl',
      'companyDetailCapturedAt',
    ].forEach((key) => {
      if (detail[key] !== undefined && detail[key] !== null && detail[key] !== '') {
        merged[key] = Array.isArray(detail[key])
          ? detail[key].slice()
          : (typeof detail[key] === 'object' ? Object.assign({}, detail[key]) : detail[key]);
      }
    });

    if (detail.encryptJobId) merged.encryptJobId = detail.encryptJobId;
    if (detail.securityId) merged.securityId = detail.securityId;
    if (detail.lid) merged.lid = detail.lid;
    if (detail.rawDetail) merged.rawDetail = detail.rawDetail;
    if (detail.rawHtmlDetail) merged.rawHtmlDetail = detail.rawHtmlDetail;
    if (detail.rawCompanyDetail) merged.rawCompanyDetail = detail.rawCompanyDetail;

    merged.signature = makeSignature(merged.jobName, merged.company, merged.salary);
    merged.looseSignature = makeLooseSignature(merged.jobName, merged.company);
    merged.rawJob = Object.assign({}, merged.rawJob || {}, {
      jobName: merged.jobName,
      brandName: merged.company,
      salaryDesc: merged.salary,
      bossName: merged.bossName,
      bossTitle: merged.bossTitle,
      positionName: merged.positionName,
      address: merged.address,
      postDescription: merged.postDescription,
      showSkills: merged.showSkills,
      brandComInfo: {
        stageName: merged.companyStage,
        scaleName: merged.companyScale,
        industryName: merged.companyIndustry,
        introduce: merged.companyIntroduce,
        labels: merged.companyLabels,
      },
    });

    return merged;
  }

  // 岗位卡片切换后，必须确认右侧详情标题和沟通按钮都属于目标岗位，避免误点上一条残留详情。
  function getJobCommunicationDetailReady(job) {
    const detail = extractDetailInfo();
    if (!detail || !detail.jobName || !areComparableTextsCompatible(job && job.jobName, detail.jobName)) return null;
    const chatButton = findChatButton(job);
    if (!chatButton) return null;
    return { detail, chatButton };
  }

  // 要求“详情标题 + 公司 + 按钮身份”持续稳定一段时间，吸收 SPA 中旧详情响应晚到造成的瞬时回写。
  function waitForJobCommunicationDetail(job, timeout, settleMs) {
    const stableDuration = Math.max(0, Number(settleMs === undefined ? 300 : settleMs));
    let stableSince = 0;
    let stableIdentity = '';
    return waitFor(
      () => {
        const ready = getJobCommunicationDetailReady(job);
        if (!ready) {
          stableSince = 0;
          stableIdentity = '';
          return null;
        }

        // 任一可识别字段发生变化都重新计时，只有整个详情组合稳定后才允许沟通。
        const identity = [
          normalizeText(ready.detail && ready.detail.jobName),
          normalizeText(ready.detail && ready.detail.company),
          normalizeText(ready.chatButton && ready.chatButton.getAttribute('ka')),
          normalizeText(ready.chatButton && ready.chatButton.getAttribute('href')),
        ].join('|');
        if (identity !== stableIdentity) {
          stableIdentity = identity;
          stableSince = Date.now();
        }
        return Date.now() - stableSince >= stableDuration ? ready : null;
      },
      Math.max(2000, Number(timeout || getWaitTimeout() * 1000)),
      '当前岗位详情与沟通按钮',
      {
        observerRoot: getJobDetailObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'href', 'ka', 'style', 'hidden'],
        // 稳定窗口结束时 DOM 可能不再变化，需要低频复核时间条件。
        pollInterval: 120,
      },
    );
  }

  // 智联登录检测：未登录时 /jobs/ 无真实卡片、/sou/ 有 SSR 卡片但无投递能力。
  // 命中"需要登录"的语义文案即判定未登录，避免把所有岗位"静默跳过"造成困惑。
  // 刻意不用"登录/手机号登录"这类宽松词，防止误伤已登录状态下 footer/底部的通用登录链接。
  function detectZhilianLoggedOut() {
    try {
      const body = document.body;
      const text = normalizeText(body && (body.innerText || body.textContent) || '');
      return /请登录|登录后查看|未登录|登录后才能|扫码登录后|登录后方可/.test(text);
    } catch (_) {
      return false;
    }
  }

  // 智联招聘投递按钮候选：新版 /jobs/ 详情右栏和老版 /sou/ 列表卡片各有一套结构。
  const ZHILIAN_APPLY_SELECTOR = [
    '.job-detail-summary__apply',    // 新版详情右栏“立即投递/已投递”
    '.job-detail-summary__prechat',  // 新版详情右栏“先聊聊/继续沟通”
    '.job-detail-chat__btn',         // 新版沟通浮层“立即沟通”
    '.collect-and-apply__btn',       // 老版列表卡片“立即投递”
    '.joblist-box__item__jobbtn',    // 老版列表卡片按钮容器
    '.btninfo .btn',
    '.c-chat-job',                   // 老版列表卡片“立即沟通”
  ].join(', ');

  // 按文案把智联按钮归类：apply=可投递，chat=只能沟通，already=已投递过。
  function classifyZhilianApplyButton(element) {
    const text = normalizeText(element.innerText || element.textContent || '');
    if (!text) return null;
    if (/已投递|继续沟通/.test(text)) return 'already';
    if (/投递|投个简历/.test(text)) return 'apply';
    if (/立即沟通|先聊聊/.test(text)) return 'chat';
    return null;
  }

  // 按钮所属岗位块（老版卡片或新版共享详情面板），用于校验期望岗位名是否命中。
  function getZhilianButtonJobBlock(element) {
    return element.closest(
      '.joblist-box__item, .job-detail-summary, .job-detail-panel, .job-detail-box, .job-list-panel .job-card'
    ) || element;
  }

  // 在指定容器内找智联投递按钮：优先“投递”，其次“沟通”，最后才是“已投递”。
  // expectedName 为期望岗位名：非空时只接受所属岗位块包含该名称的按钮，
  // 避免新版 /jobs/ 共享详情面板在岗位切换滞后时点到上一岗位遗留的按钮。
  function findZhilianApplyButtonIn(root, expectedName) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const normalizedExpected = expectedName ? normalizeText(expectedName) : '';
    const classified = Array.from(root.querySelectorAll(ZHILIAN_APPLY_SELECTOR))
      .filter((element) => !isOwnUiElement(element) && isVisible(element))
      .map((element) => ({ element, kind: classifyZhilianApplyButton(element) }))
      .filter((item) => item.kind);

    if (normalizedExpected) {
      const scoped = classified.filter((item) => {
        const block = getZhilianButtonJobBlock(item.element);
        const text = normalizeText(block && (block.innerText || block.textContent));
        return text.includes(normalizedExpected);
      });
      if (scoped.length) {
        return scoped.find((item) => item.kind === 'apply') ||
          scoped.find((item) => item.kind === 'chat') ||
          scoped.find((item) => item.kind === 'already') ||
          null;
      }
      // 岗位块均不含期望岗位名时，视为未就绪/已切走，返回 null 交给上层等待或跳过。
      return null;
    }
    return classified.find((item) => item.kind === 'apply') ||
      classified.find((item) => item.kind === 'chat') ||
      classified.find((item) => item.kind === 'already') ||
      null;
  }

  // 整页查找，用于新版 /jobs/ 右侧共享详情面板。
  function findZhilianApplyButton(expectedName) {
    return findZhilianApplyButtonIn(document, expectedName);
  }

  // 智联弹窗可能挂在 body 下，也可能带 dialog/modal 语义；优先语义节点，避免扫描整页容器。
  function getZhilianOverlayRoots() {
    const semantic = Array.from(document.querySelectorAll(
      '[role="dialog"], .dialog, .modal, .popup, [class*="dialog"], [class*="modal"], [class*="popup"]'
    )).filter((element) => !isOwnUiElement(element) && isVisible(element));
    if (semantic.length) return semantic;

    return Array.from(document.body ? document.body.children : [])
      .filter((element) => {
        if (isOwnUiElement(element) || !isVisible(element)) return false;
        const style = getComputedStyle(element);
        const zIndex = Number(style.zIndex || 0);
        return (style.position === 'fixed' || style.position === 'absolute') && zIndex >= 10;
      });
  }

  // 投递成功后智联会弹“已向对方发送简历和打招呼语”，点“留在此页”留下列表继续自动化。
  // roots 允许调用方传入“点击后新增/变化的浮层”，避免误中点击前就存在的筛选浮层。
  function findZhilianStayButton(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      // 用 textContent 做长度判断，比 innerText 便宜，避免对整页容器触发布局。
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (!/留在此页/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const stay = buttons.find((button) => /^留在此页$/.test(
        normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || ''),
      ));
      if (stay) return stay;
    }
    return null;
  }

  // 二次确认弹窗（选择简历/确认投递）的确认按钮，不会误点“取消/关闭”。
  function findZhilianConfirmButton(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (/留在此页/.test(rawText)) continue; // 打招呼语弹窗交给 findZhilianStayButton
      if (!/简历|投递|确认/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button) && !button.disabled);
      const hit = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        if (!label || label.length > 10) return false;
        // 先排除取消/关闭类动作，避免误点弹窗右上角的 ×、“留在此页”“更换简历”。
        if (/取消|关闭|暂不|先不|放弃|返回|更换|收起|稍后|留在/.test(label)) return false;
        // 新版智联“请选择要投递的简历”弹窗的确认按钮文案是“投递简历”，
        // 旧正则只认“确认/确定/投递”，会漏掉它导致一直卡在选简历弹窗。
        return /^(确认|确定|投递|投递简历|确认投递|确认投递简历|立即投递|继续投递|选择并投递|发送简历|确认发送)$/.test(label)
          || /投递简历|简历投递/.test(label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 选简历弹窗右上角的关闭按钮；仅在确认超时（无可投简历/按钮禁用）时用于清理残留浮层，
  // 避免弹窗盖住列表导致后续卡片点不到。
  function findZhilianDialogClose(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (!/简历|投递|确认/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], [aria-label]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const hit = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^(×|✕|✖|关闭|取消|暂不投递|暂不)$/.test(label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 判断投递是否已完成：按钮变成“已投递”，或页面出现“投递成功”提示。
  // 方案一：在智联投递弹窗中定位“打招呼语/附言”输入框，用于直接注入自定义问候语。
  // 优先匹配带“打招呼/附言/多说一句/留言”占位符或 aria-label 的文本输入控件。
  function findZhilianGreetingInput(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      const inputs = Array.from(
        root.querySelectorAll('textarea, input[type="text"], input[type="input"], [contenteditable="true"]')
      ).filter((element) => !isOwnUiElement(element) && isVisible(element));
      const hit = inputs.find((element) => {
        const placeholder = normalizeText(element.getAttribute && (element.getAttribute('placeholder') || '') || '');
        const label = normalizeText(element.getAttribute && (element.getAttribute('aria-label') || '') || '');
        return /打招呼|附言|多说一句|留言|给[?n]?HR/.test(placeholder + ' ' + label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 方案一：把自定义问候语写入智联“打招呼/附言”输入框。contenteditable 走富文本写入，
  // textarea/input 走原生 value setter + 派发 input/change 事件，保证页面框架能收到输入。
  function injectZhilianGreeting(input, text) {
    if (!input || !text) return false;
    try {
      if (input.isContentEditable) {
        setEditableText(input, text);
      } else {
        const prototype = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        if (setter) {
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.value = text;
        }
      }
    } catch (error) {
      logDebugEvent('zhilian_greeting_inject_error', {
        message: String((error && error.message) || error),
      }, 'warn');
      return false;
    }
    const current = normalizeText(input.value != null ? String(input.value) : (getEditableText(input) || ''));
    return current === normalizeText(text);
  }

  // 判断投递是否已完成：按钮变成“已投递”，或页面出现“投递成功”提示。
  function findZhilianAppliedIndicator() {
    const applyButtons = Array.from(document.querySelectorAll('.job-detail-summary__apply, .collect-and-apply__btn'))
      .filter((element) => !isOwnUiElement(element) && isVisible(element));
    if (applyButtons.some((button) => /已投递/.test(normalizeText(button.innerText || button.textContent || '')))) {
      return true;
    }
    // 提示条只可能是短文案，限制长度避免误中包含岗位列表的大型容器。
    return Array.from(document.querySelectorAll('[class*="toast"], [class*="notice"], [class*="tip"]'))
      .filter((element) => !isOwnUiElement(element) && isVisible(element))
      .some((element) => {
        const text = normalizeText(element.innerText || element.textContent || '');
        return text.length <= 120 && /投递成功/.test(text);
      });
  }

  // 在岗位详情页查找“立即沟通/继续沟通”按钮，点击它会进入聊天页。
  function findChatButton(job) {
    const candidates = Array.from(document.querySelectorAll(
      'a.op-btn.op-btn-chat, button.op-btn.op-btn-chat, .op-btn.op-btn-chat, [class*="op-btn-chat"]'
    ))
      .filter((element) => isVisible(element) && /立即沟通|继续沟通/.test(normalizeText(element.innerText || element.textContent || '')));
    const encryptJobId = normalizeText(job && job.encryptJobId);
    if (!encryptJobId) return candidates[0] || null;

    return candidates.find((element) => {
      const identityText = [
        element.getAttribute('ka'),
        element.getAttribute('href'),
        element.getAttribute('data-jobid'),
        element.getAttribute('data-job-id'),
      ].filter(Boolean).join('|');
      return identityText.includes(encryptJobId);
    }) || null;
  }

  // 在岗位详情页查找 BOSS“投简历”按钮（主动投递简历用）。
  // 排除“已投递/继续沟通/立即沟通”，只匹配可投的投递/投简历按钮，避免误点沟通入口。
  function findBossDeliverResumeButton() {
    return Array.from(document.querySelectorAll(
      'a[class*="op-btn"], button[class*="op-btn"], a[class*="btn"], button[class*="btn"]'
    ))
      .filter((element) => isVisible(element) && !isOwnUiElement(element))
      .find((element) => {
        const text = normalizeText(element.innerText || element.textContent || '');
        if (/已投递|继续沟通|立即沟通|沟通|收藏/.test(text)) return false;
        return /^投(个)?简历$/.test(text) || /投递简历|投递/.test(text);
      }) || null;
  }

  // 查找投简历可能弹出的确认按钮（“确认/确定/确认投递”），用于收尾弹窗。
  function findBossApplyConfirmButton() {
    return Array.from(document.querySelectorAll('button, a, [role="button"], [class*="btn"]'))
      .filter((element) => isVisible(element) && !isOwnUiElement(element) && !element.disabled)
      .find((element) => {
        const label = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
        return /确认投递|确认投递简历|确认|确定/.test(label);
      }) || null;
  }

  // BOSS 投递简历主流程：找到投简历按钮 → 点击 → 处理可能的确认弹窗 → 返回是否投递。
  // 全部防御式：找不到按钮/超时/失败一律不抛异常，仅返回状态，不影响后续沟通。
  async function tryBossDeliverResume(job) {
    const button = await waitFor(() => findBossDeliverResumeButton(), 2500, 'BOSS 投简历按钮')
      .catch(() => null);
    if (!button) {
      logDebugEvent('boss_apply_no_button', { jobName: job.jobName || '' }, 'warn');
      return { applied: false, reason: 'no_button' };
    }

    clickElement(button);
    logDebugEvent('boss_apply_button_clicked', { jobName: job.jobName || '' });

    const outcome = await waitFor(() => {
      if (runtime.stopRequested) return 'stopped';
      // 投递成功后按钮文案变为“已投递”，或原按钮消失。
      const current = findBossDeliverResumeButton();
      if (!current || /已投递/.test(normalizeText(current.innerText || current.textContent || ''))) return 'applied';
      // 出现确认弹窗则先确认。
      if (findBossApplyConfirmButton()) return 'confirm';
      return null;
    }, 4000, 'BOSS 投简历结果', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 100,
    }).catch(() => null);

    if (outcome === 'confirm') {
      const confirmButton = findBossApplyConfirmButton();
      if (confirmButton) clickElement(confirmButton);
      await sleep(600);
      return { applied: true };
    }
    if (outcome === 'applied') return { applied: true };

    logDebugEvent('boss_apply_unconfirmed', {
      jobName: job.jobName || '',
      outcome: outcome || 'timeout',
    }, 'warn');
    return { applied: false, reason: 'unconfirmed' };
  }

  // 聊天页常用语按钮定位，当前发送流程主要使用文本注入，这里保留给兼容判断。
  function findCommonPhraseButton() {
    const selectors = [
      'div[aria-label="常用语"]',
      '[aria-label="常用语"]',
      '.btn-dict',
      '[class*="btn-dict"]',
    ];

    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((item) => !isOwnUiElement(item) && isVisible(item));
      if (element) return element;
    }

    return Array.from(document.querySelectorAll('button, div, span, a'))
      .find((element) => !isOwnUiElement(element) && isVisible(element) && /常用语/.test(normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '')));
  }

  // 定位聊天输入框。BOSS 可能使用 contenteditable div，也可能包在不同容器里。
  function findChatInput(doc) {
    const root = doc || null;
    // 合并两个实现的选择器：先 BOSS 专属 chat-input，再聊天/消息容器内输入框，最后兜底。
    const selectors = [
      '#chat-input.chat-input[contenteditable="true"]',
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      '[class*="chat"] textarea',
      '[class*="chat"] [contenteditable="true"]',
      '[class*="message"] textarea',
      '[class*="message"] [contenteditable="true"]',
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="沟通"]',
      '[contenteditable="true"][data-placeholder*="消息"]',
      '[contenteditable="true"][aria-label*="消息"]',
      'textarea',
      '[contenteditable="true"]',
    ];

    // doc 未指定时遍历顶层与同源 iframe，避免聊天窗口渲染在 iframe 中时定位不到。
    const docs = root ? [root] : getAccessibleDocuments();
    for (const currentDoc of docs) {
      for (const selector of selectors) {
        const elements = Array.from(currentDoc.querySelectorAll(selector))
          .filter((item) => !isOwnUiElement(item) && isVisible(item));
        if (!elements.length) continue;
        // 优先带聊天语义占位符的输入框，避免误中普通 textarea。
        const semantic = elements.find((item) => /请输入|聊|消息|沟通|打招呼|回复/.test(
          item.getAttribute && (item.getAttribute('placeholder') || item.getAttribute('data-placeholder') || item.getAttribute('aria-label') || '')
        ));
        return semantic || elements[elements.length - 1];
      }
    }

    return null;
  }

  // 定位聊天页发送按钮；Enter 发送失败时会作为兜底点击。
  function findSendButton() {
    const selectors = [
      'button.btn-send',
      '.chat-op button',
      '.chat-op [class*="send"]',
      'button[class*="send"]',
    ];

    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find((element) => {
        const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
        const className = String(element.className || '');
        return !isOwnUiElement(element) &&
          isVisible(element) &&
          !element.disabled &&
          !/(disabled|unable)/i.test(className) &&
          (/发送/.test(text) || /send/i.test(className));
      });
      if (found) return found;
    }

    return Array.from(document.querySelectorAll('button, a, div, span')).find((element) => {
      const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      const className = String(element.className || '');
      return !isOwnUiElement(element) &&
        isVisible(element) &&
        !element.disabled &&
        !/(disabled|unable)/i.test(className) &&
        text === '发送';
    });
  }

  // 判断节点是否属于脚本自身 UI（控制面板）。
  function isOwnUiElement(element) {
    if (!element || !element.closest) return false;
    return Boolean(element.closest('#zhipin-auto-greeting-root'));
  }

  // 判断聊天页左侧会话列表是否渲染完成。
  function hasConversationList() {
    return Array.from(document.querySelectorAll('.user-list-content li, .user-list li, .chat-user li'))
      .some((element) => isVisible(element) && normalizeText(element.innerText || element.textContent || '').length > 4);
  }

  // 在聊天页左侧会话列表中确认当前会话是否对应 pendingJob。
  function findSelectedConversationForJob(job) {
    if (!job) return null;

    const bossName = normalizeText(job.bossName);
    const company = normalizeText(job.company);
    const jobName = normalizeText(job.jobName);
    const selectors = [
      '.user-list-content li.selected',
      '.user-list-content li.active',
      '.user-list-content li.cur',
      '.user-list li.selected',
      '.user-list li.active',
      '.user-list li.cur',
      '.chat-user li.selected',
      '.chat-user li.active',
      '.chat-user li.cur',
      '.friend-content.selected',
      '.friend-content.active',
      '.friend-content.cur',
      '.friend-content-warp.selected',
      '.friend-content-warp.active',
      '.friend-content-warp.cur',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);
    let best = null;

    for (const element of candidates) {
      const text = normalizeText(element.innerText || element.textContent || '');
      if (!text || text.length < 2) continue;

      let score = 0;
      if (bossName && text.includes(bossName)) score += 4;
      if (company && text.includes(company)) score += 4;
      if (jobName && text.includes(jobName)) score += 2;
      if (/正在与Boss|沟通/.test(text)) score += 1;

      if (!best || score > best.score) {
        best = { element, score, text };
      }
    }

    if (!best || best.score < 4) return null;
    return best;
  }

  // 构造“需要人工处理”的暂停错误，区别于真正脚本异常。
  function createPauseError(message) {
    const error = new Error(message);
    error.zhipinAutoPause = true;
    return error;
  }

  // 识别 BOSS 沟通相关平台弹窗（温馨提示 / 次数用尽等），排除脚本自己的确认框。
  function findBossPlatformDialog() {
    const selectorRoots = Array.from(document.querySelectorAll([
      '[role="dialog"]',
      '.dialog-wrap',
      '.boss-dialog',
      '.common-dialog',
      '.dialog-container',
      '.dialog-layer',
      '.boss-popup',
      '.confirm-dialog',
      '.ui-dialog',
    ].join(','))).filter((element) => !isOwnUiElement(element) && isVisible(element));

    // 部分弹窗没有稳定 class，退回扫描看起来像浮层的节点，避免误伤整页容器。
    const overlayRoots = Array.from(document.querySelectorAll('body > div, .dialog, .popup, .modal'))
      .filter((element) => {
        if (isOwnUiElement(element) || !isVisible(element)) return false;
        if (selectorRoots.includes(element)) return false;
        const style = getComputedStyle(element);
        const position = style.position;
        const zIndex = Number(style.zIndex || 0);
        return (position === 'fixed' || position === 'absolute') && (zIndex >= 10 || style.backgroundColor !== 'rgba(0, 0, 0, 0)');
      });

    const roots = selectorRoots.concat(overlayRoots);
    let best = null;
    for (const root of roots) {
      const text = normalizeText(root.innerText || root.textContent || '');
      if (!text || text.length < 6 || text.length > 500) continue;

      const stayPage = /留在此页/.test(text) && /离开|继续/.test(text);
      const softReminder = /温馨提示/.test(text) && /沟通/.test(text)
        || /还剩\s*\d+\s*次沟通/.test(text)
        || /您今天已与\s*\d+\s*位/.test(text)
        || /沟通机会/.test(text) && /今天已与|还剩/.test(text);
      const hardLimit = /今日沟通(?:次数)?已(?:用完|达上限)|沟通次数(?:已)?(?:用完|达上限)|无法继续沟通|今日无法再沟通|已达(?:到)?沟通上限/.test(text);
      if (!softReminder && !hardLimit && !stayPage) continue;

      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const stayButton = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^留在此页$/.test(label);
      });
      const confirmButton = stayButton || buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^(确定|知道了|我知道了|继续|关闭|留在此页)$/.test(label);
      }) || buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /确定|知道了|我知道了/.test(label) && !/取消|开通|升级|购买|查看权益/.test(label);
      });

      const score = (hardLimit ? 4 : 0) + (stayPage ? 3 : 0) + (softReminder ? 2 : 0) + (confirmButton ? 1 : 0) + Math.min(text.length, 80) / 80;
      if (!best || score > best.score) {
        best = {
          root,
          text,
          kind: hardLimit ? 'hard_limit' : stayPage ? 'stay_page' : 'soft_reminder',
          confirmButton: confirmButton || null,
          score,
        };
      }
    }

    return best;
  }

  // 生成沟通上限暂停文案，避免把整段弹窗原文塞进状态栏。
  function formatBossDialogPauseMessage(dialog) {
    const text = normalizeText(dialog && dialog.text || '');
    const short = text.length > 60 ? `${text.slice(0, 60)}...` : text;
    return short ? `沟通受限，已暂停：${short}` : '沟通次数已达上限，已暂停';
  }

  // 检查并处理平台弹窗：软提醒可点击确定；硬限制只返回结果，由调用方 pause。
  function inspectBossPlatformDialog(options) {
    const settings = options || {};
    const dialog = findBossPlatformDialog();
    if (!dialog) return null;

    if (dialog.kind === 'stay_page' && dialog.confirmButton) {
      logDebugEvent('delivery_stay_page_dialog', {
        kind: dialog.kind,
        text: summarizeLongText(dialog.text),
        buttonText: normalizeText(dialog.confirmButton.innerText || dialog.confirmButton.textContent || ''),
        action: '留在此页',
      }, 'warn');
      clickElement(dialog.confirmButton);
      runtime.lastBossDialogDismissAt = Date.now();
    } else if (dialog.kind === 'soft_reminder' && settings.dismissSoft && dialog.confirmButton) {
      const lastAt = Number(runtime.lastBossDialogDismissAt || 0);
      if (Date.now() - lastAt > 900) {
        UI.setStatus('检测到沟通提醒弹窗，正在点击确定...', 'warn');
        logDebugEvent('boss_platform_dialog_dismiss', {
          kind: dialog.kind,
          text: summarizeLongText(dialog.text),
          buttonText: normalizeText(dialog.confirmButton.innerText || dialog.confirmButton.textContent || ''),
        });
        clickElement(dialog.confirmButton);
        runtime.lastBossDialogDismissAt = Date.now();
      }
    } else if (dialog.kind === 'hard_limit') {
      logDebugEvent('boss_platform_dialog_hard_limit', {
        kind: dialog.kind,
        text: summarizeLongText(dialog.text),
      }, 'warn');
    }

    return dialog;
  }

  // 聊天页输入框长期不出现时，允许走重新点击沟通的重试路径。
  function isChatRenderTimeoutError(error) {
    return Boolean(error && /聊天界面渲染\s*等待超时/.test(String(error.message || error)));
  }

  // 等待聊天页关键区域就绪：输入框、会话列表、当前会话匹配。
  // 等待过程中若出现沟通次数提醒弹窗，先点确定；硬限制则暂停。
  function waitForChatReady(job) {
    logDebugEvent('wait_chat_ready_start', {
      job: summarizeJobForDebug(job),
      timeoutSeconds: getWaitTimeout(),
      chatWaitTimeoutSeconds: getChatWaitTimeout(),
      hasChatInput: Boolean(findChatInput()),
      isChatPage: isChatPage(),
      runState: RunState.load(),
    });
    return waitFor(() => {
      const dialog = inspectBossPlatformDialog({ dismissSoft: true });
      if (dialog && dialog.kind === 'hard_limit') {
        throw createPauseError(formatBossDialogPauseMessage(dialog));
      }

      if (!/\/chat\b|\/web\/geek\/chat/.test(location.pathname + location.hash) && !document.querySelector('.chat-input')) {
        return null;
      }

      if (document.readyState === 'loading') return null;

      const readyTarget = findChatInput();
      if (readyTarget) {
        logDebugEvent('wait_chat_ready_success', {
          job: summarizeJobForDebug(job),
          inputText: summarizeLongText(getEditableText(readyTarget)),
          href: location.href,
        });
        return readyTarget;
      }

      return null;
    }, getWaitTimeout(), '聊天界面渲染', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'contenteditable'],
      // history 路由变化本身不一定产生 DOM mutation，低频轮询仅用于这一兜底。
      pollInterval: 200,
    });
  }

  // 向聊天输入框写入文本并按 Enter，返回发送前快照供后续确认。
  async function sendChatTextByEnter(messageText) {
    const input = await waitFor(() => findChatInput(), getChatWaitTimeout(), '聊天输入框', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'contenteditable'],
    });
    const snapshot = getSendVerificationSnapshot(messageText);

    // BOSS 聊天框是 contenteditable div。这里只负责写入草稿并触发 Enter，是否真的发出由后续聊天记录确认决定。
    setEditableText(input, messageText);
    await waitFor(() => inputContainsText(findChatInput(), messageText), 3000, '聊天输入框写入文本', {
      observerRoot: input.parentElement || input,
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden', 'value'],
      // textarea.value 属于属性状态，不保证产生 MutationRecord。
      pollInterval: 120,
    });

    pressEnter(findChatInput() || input);

    // 如果 Enter 没有触发发送，观察聊天区域到短超时，再最多点击一次页面自己的发送按钮。
    const sentByEnter = await waitFor(() => {
      const current = getSendVerificationSnapshot(messageText);
      return isMessageActuallySent(snapshot, current) ? true : null;
    }, 800, 'Enter 发送结果', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 120,
    }).then(() => true).catch(() => false);
    if (!sentByEnter && inputContainsText(findChatInput(), messageText)) {
      const sendButton = findSendButton();
      if (sendButton) clickNative(sendButton);
    }

    return snapshot;
  }

  // 等待输入框清空且聊天记录中新出现目标文本，确认消息确实发送。
  async function waitForMessageSent(messageText, beforeSend) {
    const snapshot = beforeSend || getSendVerificationSnapshot(messageText);

    await waitFor(() => {
      const input = findChatInput();
      const inputCleared = !normalizeText(getEditableText(input));
      const current = getSendVerificationSnapshot(messageText);

      if (inputCleared && isMessageActuallySent(snapshot, current)) {
        return true;
      }
      return null;
    }, getChatWaitTimeout(), '消息发送确认', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 120,
    });
  }

  // 生成发送校验快照：目标 token 当前出现次数和“确认发送”次数。
  function getSendVerificationSnapshot(messageText) {
    const token = getMessageVerifyToken(messageText);
    const currentText = getCurrentConversationText();
    return {
      token,
      currentCount: countTextToken(currentText, token),
      currentConfirmedCount: countConfirmedToken(currentText, token),
    };
  }

  // 对比发送前后快照，判断消息是否新增到聊天内容区域。
  function isMessageActuallySent(before, after) {
    if (!before || !after) return false;

    // 只以右侧聊天内容区域为准；左侧会话预览、输入框草稿、脚本 UI 文本都不能作为成功依据。
    return after.currentCount > before.currentCount ||
      after.currentConfirmedCount > before.currentConfirmedCount;
  }

  // 只读取聊天内容区域文本，排除输入框草稿、左侧会话预览和脚本 UI。
  function getCurrentConversationText() {
    const roots = Array.from(document.querySelectorAll([
      '.chat-record',
      '.chat-message-list',
      '.chat-message',
      '.chat-conversation',
    ].join(','))).filter((element) => !isOwnUiElement(element) && isVisible(element));

    return normalizeText(roots.map(cloneConversationText).join(' '));
  }

  // 克隆聊天区域后删除输入框/按钮/脚本 UI，再提取用于发送确认的纯文本。
  function cloneConversationText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      '#chat-input',
      '.chat-input',
      'textarea',
      'input',
      '[contenteditable="true"]',
      '#zhipin-auto-greeting-root',
      '.chat-editor',
      '.editor-container',
      '.chat-op',
      '.message-controls',
      '.user-list-content',
      '.user-list',
      '.friend-list',
      '.chat-user',
      '.chat-user-list',
    ].join(',')).forEach((item) => item.remove());
    return normalizeText(clone.innerText || clone.textContent || '');
  }

  // 发送确认只使用消息前 60 个字符作为 token，减少长文本换行/裁剪带来的误差。
  function getMessageVerifyToken(messageText) {
    return normalizeText(messageText).slice(0, 24);
  }

  // 统计 token 在聊天文本中出现次数。
  function countTextToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 更严格的 token 统计：排除输入框附近文本后，用于减少误判。
  function countConfirmedToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      const nearby = source.slice(Math.max(0, index - 80), Math.min(source.length, index + target.length + 80));
      if (/送达|已读|已发送/.test(nearby)) count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 判断草稿是否还留在输入框中，用于决定是否需要兜底点击发送按钮。
  function inputContainsText(input, expectedText) {
    const token = getMessageVerifyToken(expectedText);
    return token && normalizeText(getEditableText(input)).includes(token);
  }

  // 从最近一次列表请求提取“推荐/求职期望”相关参数。BOSS 不把这些参数同步到页面 URL。
  function parseJobExpectationRequestContext(url) {
    const context = {
      encryptExpectId: '',
      mixExpectType: '',
      expectInfo: '',
      jobType: '',
    };

    try {
      const target = new URL(url || '', location.href);
      Object.keys(context).forEach((key) => {
        context[key] = normalizeText(target.searchParams.get(key));
      });
    } catch (_) {}

    return context;
  }

  // 汇总“已发起/已解析/Resource Timing”三路记录，返回时间上最新的一次列表活动。
  function getLatestJobListRequestRecord() {
    const bufferedResource = findLatestJobListApiResource();
    const candidates = [
      runtime.latestJobListRequest,
      runtime.latestFirstPageJobListResponse,
      runtime.latestJobListResource,
      bufferedResource,
    ].filter((item) => item && item.url);
    candidates.sort((left, right) => Number(right.capturedAt || 0) - Number(left.capturedAt || 0));
    return candidates[0] || null;
  }

  // 只在已完成的响应和资源中选择，避免把尚未返回的推荐请求误当成当前最终列表。
  function getLatestCompletedJobListRecord() {
    const bufferedResource = findLatestJobListApiResource();
    const candidates = [
      runtime.latestFirstPageJobListResponse,
      runtime.latestJobListResource,
      bufferedResource,
    ].filter((item) => item && item.url);
    candidates.sort((left, right) => Number(right.capturedAt || 0) - Number(left.capturedAt || 0));
    return candidates[0] || null;
  }

  // 获取最近列表活动的 URL，供求职期望参数解析和异常日志使用。
  function getLatestJobListRequestUrl() {
    const record = getLatestJobListRequestRecord();
    return normalizeText(record && record.url);
  }

  // 冻结当前激活的求职期望。标签状态只存在于 BOSS 的 Vue 组件内，刷新/重挂载后会默认回到“推荐”。
  function captureActiveJobExpectationContext() {
    const root = document.querySelector('.c-expect-select');
    if (!root) return null;

    const active = root.querySelector([
      'a.synthesis.active',
      'a.expect-item.active',
      '.part-time-expect.active',
      '.temp-expect.active',
    ].join(','));
    const component = root.__vue__ || null;
    const requestContext = parseJobExpectationRequestContext(getLatestJobListRequestUrl());
    let mode = normalizeText(component && component.currentJobTab);

    if (!mode && active) {
      if (active.matches('a.synthesis')) mode = 'select';
      else if (active.matches('.part-time-expect')) mode = 'partTime';
      else if (active.matches('.temp-expect')) mode = 'temp-expect';
      else if (active.matches('a.expect-item')) mode = 'expect';
    }
    if (!mode) return null;

    let encryptExpectId = requestContext.encryptExpectId;
    if (mode === 'expect') {
      encryptExpectId = normalizeText(component && component.encryptExpectId) || encryptExpectId;
    } else if (mode === 'select') {
      encryptExpectId = normalizeText(component && component.mixEncryptExpectId) || encryptExpectId;
    } else if (mode === 'partTime') {
      encryptExpectId = normalizeText(component && component.partTimeExpect) || encryptExpectId;
    }

    return {
      mode,
      label: normalizeText(active && (active.innerText || active.textContent)),
      encryptExpectId,
      mixExpectType: normalizeText(component && component.mixExpectType) || requestContext.mixExpectType,
      expectInfo: requestContext.expectInfo,
      jobType: requestContext.jobType,
      capturedAt: Date.now(),
    };
  }

  // 比对标签层状态：mode、encryptExpectId 和可见文案共同一致才视为仍选中原求职期望。
  function isJobExpectationUiMatched(current, expected) {
    if (!expected || !expected.mode) return true;
    if (!current || current.mode !== expected.mode) return false;
    if (expected.encryptExpectId && current.encryptExpectId !== expected.encryptExpectId) return false;
    if (expected.label && current.label && current.label !== expected.label) return false;
    return true;
  }

  // 比对接口层状态；不同标签模式使用 BOSS 实际提交的不同参数作为身份标识。
  function isJobExpectationRequestMatched(url, expected) {
    if (!expected || !expected.mode) return true;
    if (!url) return false;
    const current = parseJobExpectationRequestContext(url);

    if (expected.mode === 'expect') {
      return Boolean(expected.encryptExpectId && current.encryptExpectId === expected.encryptExpectId);
    }
    if (expected.mode === 'partTime') {
      return Boolean(
        expected.encryptExpectId &&
        current.encryptExpectId === expected.encryptExpectId &&
        Number(current.jobType || expected.jobType || 0) === 1903,
      );
    }
    if (expected.mode === 'temp-expect') {
      return Boolean(expected.expectInfo && current.expectInfo === expected.expectInfo);
    }
    if (expected.mode === 'select') {
      return current.encryptExpectId === normalizeText(expected.encryptExpectId) &&
        current.mixExpectType === normalizeText(expected.mixExpectType) &&
        current.expectInfo === normalizeText(expected.expectInfo) &&
        current.jobType === normalizeText(expected.jobType);
    }
    return true;
  }

  // 找到冻结期望对应的可点击标签；优先文案匹配，再按 Vue expectList 中 encryptId 的索引兜底。
  function findFrozenJobExpectationElement(expected) {
    const root = document.querySelector('.c-expect-select');
    if (!root || !expected) return null;
    if (expected.mode === 'select') return root.querySelector('a.synthesis');
    if (expected.mode === 'partTime') return root.querySelector('.part-time-expect');

    const candidates = Array.from(root.querySelectorAll('a.expect-item'));
    const expectedLabel = normalizeText(expected.label);
    const textMatched = candidates.find((element) => (
      normalizeText(element.innerText || element.textContent) === expectedLabel
    ));
    if (textMatched) return textMatched;

    // 文案被页面截断或调整时，利用组件的期望列表按 encryptId 找到相同索引作为兜底。
    try {
      const component = root.__vue__;
      const expectList = component && Array.isArray(component.expectList) ? component.expectList : [];
      const index = expectList.findIndex((item) => (
        normalizeText(item && item.encryptId) === normalizeText(expected.encryptExpectId)
      ));
      if (index >= 0 && candidates[index]) return candidates[index];
    } catch (_) {}
    return null;
  }

  // 生成一次无副作用的恢复就绪快照，集中记录标签、最新完成请求、卡片和详情状态。
  function getJobExpectationReadyState(expected) {
    const current = captureActiveJobExpectationContext();
    const completedRequest = getLatestCompletedJobListRecord();
    const detail = extractDetailInfo();
    const chatButton = findChatButton(null);
    return {
      current,
      completedRequest,
      uiMatched: isJobExpectationUiMatched(current, expected),
      requestMatched: isJobExpectationRequestMatched(completedRequest && completedRequest.url, expected),
      cardsReady: hasVisibleJobCards(),
      detailReady: Boolean(detail && detail.jobName && chatButton),
      detailJobName: normalizeText(detail && detail.jobName),
    };
  }

  // 等待目标期望的标签与列表真正稳定；支持完成时间门槛、静默窗口和无 Resource Timing 时的 UI 兜底。
  async function waitForJobExpectationReady(expected, options) {
    const settings = options || {};
    const requiredCompletedAt = Number(settings.requiredCompletedAt || 0);
    const settleMs = Math.max(0, Number(settings.settleMs || 0));
    const allowStableUiFallback = Boolean(settings.allowStableUiFallback);
    const timeout = Math.max(1200, Number(settings.timeout || getWaitTimeout() * 1000));
    let stableSince = 0;
    let sawListReset = Boolean(settings.sawListReset);

    return waitFor(() => {
      const ready = getJobExpectationReadyState(expected);
      if (!ready.cardsReady) sawListReset = true;
      if (!ready.uiMatched || !ready.cardsReady) {
        stableSince = 0;
        return null;
      }

      // settleMs 是响应静默窗口：如果期间又完成了推荐请求，最新记录会变化并重新进入判断。
      const completedAt = Number(ready.completedRequest && ready.completedRequest.capturedAt || 0);
      const requestSettled = !settleMs || Date.now() - completedAt >= settleMs;
      if (ready.requestMatched && (!requiredCompletedAt || completedAt >= requiredCompletedAt) && requestSettled) {
        return Object.assign(ready, { confirmation: 'completed-request', sawListReset });
      }

      // 只有完全缺少本轮完成记录时才用 UI 稳定态兜底；若本轮最后完成的是推荐请求，绝不能绕过。
      const hasRelevantCompletedRequest = Boolean(
        completedAt && (!requiredCompletedAt || completedAt >= requiredCompletedAt),
      );
      if (
        allowStableUiFallback &&
        (!requiredCompletedAt || sawListReset) &&
        (!hasRelevantCompletedRequest || ready.requestMatched)
      ) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 900) {
          return Object.assign(ready, { confirmation: 'stable-ui', sawListReset });
        }
      } else {
        stableSince = 0;
      }
      return null;
    }, timeout, '求职期望列表与详情', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      // 该条件同时依赖接口完成时间和静默窗口，DOM 不变化时也要复核。
      pollInterval: 120,
    });
  }

  // 目标列表稳定后，把可见选中卡片与右侧详情再对齐一次，阻断旧“推荐”详情的晚到响应。
  async function synchronizeVisibleJobDetailAfterExpectationRestore(expected, timeout) {
    const entries = getVisibleJobScanEntries();
    const selected = entries.find((entry) => /active|selected|cur|current/.test(String(entry.card.className || '')));
    const entry = selected || entries[0];
    if (!entry || !entry.job || !entry.job.jobName) {
      throw new Error('求职期望已恢复，但没有可同步的岗位卡片');
    }

    let job = entry.job;
    let ready = getJobCommunicationDetailReady(job);
    let clicked = false;
    if (!ready) {
      // 当前详情仍属于旧列表时主动点击目标卡片，并用接口数据补齐强身份后再校验按钮。
      clicked = true;
      entry.card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      clickElement(entry.card);

      const apiDetail = await JobRepository.waitForJobDetail(
        job,
        Math.min(4200, Math.max(2600, Number(timeout || getWaitTimeout() * 1000))),
        detailResourceStartedAt,
        { includeHtml: false, forceApiFetch: true },
      );
      if (apiDetail) job = mergeJobInfo(job, apiDetail);
    }

    // 恢复场景使用更长的 650ms 稳定窗口，专门覆盖推荐详情比目标列表更晚返回的竞态。
    ready = await waitForJobCommunicationDetail(
      job,
      Math.max(3000, Number(timeout || getWaitTimeout() * 1000)),
      650,
    );
    const result = {
      clicked,
      cardJobName: normalizeText(job.jobName),
      detailJobName: normalizeText(ready.detail && ready.detail.jobName),
      buttonKa: normalizeText(ready.chatButton && ready.chatButton.getAttribute('ka')),
    };
    logDebugEvent('job_expectation_detail_synchronized', { expected, result });
    return result;
  }

  // 返回列表或页面恢复时先核验求职期望；若 BOSS 重置为推荐，恢复正确列表后才允许继续扫描。
  async function ensureFrozenJobExpectationContext(state, reason) {
    const expected = state && state.listExpectationContext;
    if (!expected || !expected.mode) return { required: false, restored: false, matched: true, label: '' };

    await waitForElement('.c-expect-select', Math.max(3000, getWaitTimeout() * 1000), '求职期望标签');
    let current = captureActiveJobExpectationContext();
    const uiMatched = isJobExpectationUiMatched(current, expected);

    // 已经激活正确标签时绝不能重复点击：BOSS 会忽略激活项点击，也不会重新发列表请求。
    if (uiMatched) {
      try {
        // 正常返回只做短稳定检查，不额外点击标签，以免制造一次无响应的等待。
        const ready = await waitForJobExpectationReady(expected, {
          allowStableUiFallback: true,
          settleMs: 350,
          timeout: Math.min(2600, Math.max(1600, getWaitTimeout() * 350)),
        });
        const result = {
          required: true,
          restored: false,
          matched: true,
          label: expected.label || current && current.label || '',
          confirmation: ready.confirmation,
          requestUrl: normalizeText(ready.completedRequest && ready.completedRequest.url),
          detailJobName: ready.detailJobName,
        };
        logDebugEvent('job_expectation_already_ready', { reason, expected, result });
        return result;
      } catch (error) {
        logDebugEvent('job_expectation_active_not_ready', {
          reason,
          expected,
          current,
          ready: getJobExpectationReadyState(expected),
          message: error && error.message || String(error),
        }, 'warn');
        throw new Error(`求职期望已选中，但岗位列表或详情未就绪：${expected.label || expected.mode}`);
      }
    }

    const requestUrl = getLatestJobListRequestUrl();
    const target = findFrozenJobExpectationElement(expected);
    if (!target || !isVisible(target)) {
      logDebugEvent('job_expectation_restore_target_missing', {
        reason,
        expected,
        current,
        requestUrl,
      }, 'error');
      throw new Error(`无法恢复求职期望：${expected.label || expected.encryptExpectId || expected.mode}`);
    }

    const restoreStartedAt = Date.now();
    const sawListResetInitially = !hasVisibleJobCards();
    UI.setStatus(`检测到 BOSS 已切换标签，正在恢复：${expected.label || '原求职期望'}`, 'warn');
    logDebugEvent('job_expectation_restore_start', {
      reason,
      expected,
      current,
      requestUrl,
      restoreStartedAt,
    }, 'warn');

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    clickElement(target);
    // 点击恢复后只接受本次点击之后完成、且参数属于目标期望的列表请求；800ms 用于吸收并发晚到响应。
    const ready = await waitForJobExpectationReady(expected, {
      requiredCompletedAt: restoreStartedAt,
      allowStableUiFallback: true,
      sawListReset: sawListResetInitially,
      settleMs: 800,
      timeout: Math.max(10000, getWaitTimeout() * 1400),
    });

    // 用已经确认属于目标求职期望的 URL 主动补抓一次，避免接口池仍残留“推荐”岗位。
    if (ready.requestMatched && ready.completedRequest && ready.completedRequest.url) {
      const fetched = await JobRepository.fetchLatestJobList(ready.completedRequest).catch((error) => {
        logDebugEvent('job_expectation_list_replay_failed', {
          expected,
          requestUrl: ready.completedRequest.url,
          message: error && error.message || String(error),
        }, 'warn');
        return false;
      });
      if (!fetched) throw new Error(`求职期望列表补抓失败：${expected.label || expected.mode}`);
    }

    current = ready.current;
    JobRepository.syncCards();
    // 接口池恢复正确后继续对齐右侧详情，只有卡片/详情/按钮一致才算完整恢复成功。
    const detailSync = await synchronizeVisibleJobDetailAfterExpectationRestore(
      expected,
      Math.max(4500, getWaitTimeout() * 1000),
    );
    const result = {
      required: true,
      restored: true,
      matched: true,
      label: expected.label || current && current.label || '',
      confirmation: ready.confirmation,
      requestUrl: normalizeText(ready.completedRequest && ready.completedRequest.url),
      detailJobName: detailSync.detailJobName || ready.detailJobName,
      detailSync,
    };
    logDebugEvent('job_expectation_restore_success', {
      reason,
      expected,
      result,
      listState: getDebugListState(),
    });
    return result;
  }

  // 从聊天页返回岗位列表。历史返回只有在筛选上下文一致时才成功，否则恢复本轮冻结的完整 URL。
  async function navigateToJobList(stateOrUrl) {
    const suppliedState = stateOrUrl && typeof stateOrUrl === 'object' ? stateOrUrl : null;
    const state = suppliedState || RunState.load() || {};
    const listUrl = suppliedState ? suppliedState.listUrl : stateOrUrl || state.listUrl;
    const timeout = Math.max(config.ignoreListRefresh ? 15000 : 8000, getWaitTimeout() * 1000);
    const targetListUrl = getRestorableListUrl(listUrl);
    const expectedSignature = state.listFilterSignature || makeJobListFilterSignature(targetListUrl);
    const intentionalRestoreAt = Number(state.intentionalListRestoreAt || 0);

    const currentContextMatches = () => Boolean(
      targetListUrl && isSameJobListFilterContext(location.href, targetListUrl, expectedSignature),
    );

    if (isJobListRoute() && currentContextMatches()) {
      await waitForVisibleJobList(timeout);
      return {
        exactRestored: intentionalRestoreAt > 0,
        usedHistory: false,
        href: location.href,
      };
    }

    if (isChatPage()) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        UI.setStatus(attempt === 0
          ? '发送完成，正在通过浏览器历史返回原筛选页...'
          : '尚未恢复原筛选页，再次执行浏览器历史返回...', 'info');
        const beforeHref = location.href;
        triggerBrowserHistoryBack(attempt);
        try {
          await waitForHistoryReturnOrJobList(beforeHref, Math.min(timeout, 5000 + attempt * 2000));
          if (isJobListRoute() && currentContextMatches()) {
            await waitForVisibleJobList(timeout);
            return { exactRestored: false, usedHistory: true, href: location.href };
          }
          if (isJobListRoute()) break;
        } catch (_) {}
      }
    }

    if (targetListUrl) {
      UI.setStatus('返回页面的筛选条件已变化，正在恢复原岗位筛选页...', 'warn');
      RunState.patch({
        phase: 'returning',
        intentionalListRestoreAt: Date.now(),
        listUrl: targetListUrl,
        listFilterSignature: expectedSignature || makeJobListFilterSignature(targetListUrl),
      });
      pageWindow.location.assign(targetListUrl);
      await waitFor(
        () => isJobListRoute() && currentContextMatches() && hasVisibleJobCards(),
        timeout,
        '原岗位筛选页恢复',
        {
          observerRoot: getPageObserverRoot(),
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
          pollInterval: 200,
        },
      );
      return { exactRestored: true, usedHistory: false, href: location.href };
    }

    throw new Error('缺少可恢复的岗位筛选地址，请手动返回原搜索结果页后重新启动');
  }

  // 交替使用 back/go(-1)，应对页面 history 包装导致某一种方式失效。
  function triggerBrowserHistoryBack(attempt) {
    try {
      if (attempt % 2 === 0) {
        nativeHistoryNavigation.back();
      } else {
        nativeHistoryNavigation.go(-1);
      }
      return;
    } catch (error) {
      console.warn('[ZhipinAuto] 原生 history 返回失败，降级使用页面 history', error);
    }

    try {
      if (attempt % 2 === 0) {
        pageWindow.history.back();
      } else {
        pageWindow.history.go(-1);
      }
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 history 返回失败', error);
    }
  }

  // 等待 URL 变化或岗位卡片出现，确认浏览器历史返回已经生效。
  function waitForHistoryReturnOrJobList(previousHref, timeout) {
    return waitFor(() => {
      if (hasVisibleJobCards()) return true;
      if (location.href !== previousHref && isJobListRoute()) return true;
      return null;
    }, timeout, '岗位列表恢复', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 200,
    });
  }

  // 生成可恢复的列表 URL，只作为极端兜底，不作为正常返回路径。
  function getRestorableListUrl(listUrl) {
    const source = normalizeText(listUrl);
    if (!source) return '';

    try {
      const url = new URL(source, location.href);
      if (url.origin !== location.origin || !isJobListUrl(url.href)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  // 判断当前是否处于岗位列表路由。
  function isJobListRoute() {
    return isJobListUrl(location.href);
  }

  // 判断岗位列表是否真的渲染出可见卡片。
  function hasVisibleJobCards() {
    return getJobCards().length > 0;
  }

  // 等待岗位列表卡片出现，返回阶段和启动恢复都会使用。
  function waitForVisibleJobList(timeout) {
    return waitFor(() => {
      return getJobCards()[0] || null;
    }, timeout, '岗位列表', {
      // 完整导航/BFCache 返回时列表容器会被整体替换，必须监听稳定的 #wrap 应用根节点。
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 200,
    });
  }

  // 判断当前是否处于聊天路由。
  // 使用平台适配器进行页面检测
  function isChatPage() {
    // 如果已检测到平台，使用适配器检测
    if (currentPlatform) {
      return currentPlatform.isChatPage(location.href);
    }
    // 未检测到平台时，尝试所有已注册的适配器
    const detected = platformRegistry.detect(location.href);
    if (detected) {
      currentPlatform = detected;
      return detected.isChatPage(location.href);
    }
    // 回退到原有逻辑（兼容）
    return Boolean(
      hasVisibleChatInputShell() ||
      findCommonPhraseButton() ||
      /\/web\/geek\/chat|\/chat/.test(location.pathname + location.hash),
    );
  }

  // 粗略判断聊天输入区域是否可见，用于区分聊天页未渲染和已进入聊天页。
  function hasVisibleChatInputShell() {
    return Array.from(document.querySelectorAll([
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
    ].join(','))).some((element) => !isOwnUiElement(element) && isVisible(element));
  }

  // 重试打开聊天时重新定位原岗位卡片，优先按岗位匹配，最后用旧游标兜底。
  function findJobCardForRetry(job, cards, fallbackIndex) {
    const candidates = cards && cards.length ? cards : getJobCards();
    for (const card of candidates) {
      if (isRetryCardMatch(card, job)) return card;
    }

    const fallback = candidates[Math.max(0, Number(fallbackIndex || 0))];
    return fallback && isRetryCardMatch(fallback, job) ? fallback : null;
  }

  // 判断重试时某张卡片是否像 pendingJob。
  function isRetryCardMatch(card, job) {
    if (!card || !job) return false;

    const domInfo = extractCardInfo(card);
    const match = JobRepository.cardLooksLikeJob(domInfo, job);
    if (match.comparable) return match.matched;

    const text = domInfo.text || normalizeText(card.innerText || card.textContent || '');
    const jobName = normalizeText(job.jobName);
    const company = normalizeText(job.company);
    const bossName = normalizeText(job.bossName);

    if (jobName && company) return text.includes(jobName) && text.includes(company);
    if (jobName && bossName) return text.includes(jobName) && text.includes(bossName);
    return Boolean(jobName && text.includes(jobName));
  }

  // 记录返回前列表快照，返回后用于判断列表是否刷新或上下文是否变化。
  function createJobListSnapshot() {
    const cards = getJobCards();
    const cardHeadItems = cards
      .slice(0, 8)
      .map((card) => makeCardSnapshotKey(extractCardInfo(card)))
      .filter(Boolean);
    const firstPage = runtime.latestFirstPageJobListResponse || {};

    return {
      href: location.href,
      contextKey: runtime.jobListContextKey || firstPage.contextKey || '',
      batchKey: runtime.jobListLastBatchKey || '',
      firstPageBatchKey: firstPage.batchKey || '',
      responseSerial: runtime.jobListResponseSerial || 0,
      firstPageSerial: runtime.jobListFirstPageSerial || 0,
      cardCount: cards.length,
      cardHeadKey: cardHeadItems.length ? hashString(cardHeadItems.join('||')) : '',
      capturedAt: Date.now(),
    };
  }

  // 生成当前可见卡片的简短签名，用于列表刷新检测。
  function makeCardSnapshotKey(domInfo) {
    if (!domInfo) return '';
    const key = (domInfo.keys || []).map(normalizeText).filter(Boolean)[0];
    if (key) return `key:${key}`;
    if (isMeaningfulCompositeKey(domInfo.looseSignature)) return `loose:${domInfo.looseSignature}`;
    if (isMeaningfulCompositeKey(domInfo.signature)) return `signature:${domInfo.signature}`;
    return '';
  }

  // 生成当前虚拟列表渲染签名，滚动后据此等待卡片真正换批，而不是固定 sleep。
  function getVisibleJobListRenderSignature() {
    return getVisibleJobScanEntries()
      .map((entry) => entry.key || makeCardSnapshotKey(entry.domInfo))
      .filter(Boolean)
      .join('||');
  }

  // 等待虚拟列表 DOM/接口批次变化；超时仅表示列表可能复用了同一批节点，调用方继续做状态兜底检查。
  async function waitForJobListRenderChange(previousSignature, previousResponseSerial, timeout) {
    try {
      await waitFor(() => {
        const currentSignature = getVisibleJobListRenderSignature();
        if (currentSignature && currentSignature !== previousSignature) return true;
        if (Number(runtime.jobListResponseSerial || 0) > Number(previousResponseSerial || 0)) return true;
        return null;
      }, Math.max(300, Number(timeout || 700)), '岗位列表渲染更新', {
        observerRoot: getJobListObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
        pollInterval: 120,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // 返回列表后短暂观察是否出现第一页接口响应，用于判断列表被刷新。
  async function waitForReturnedJobListRefresh(returnStartedAt) {
    const timeout = Math.min(Math.max(700, getWaitTimeout() * 250), 1800);

    try {
      await waitFor(() => {
        const latestFirstPage = runtime.latestFirstPageJobListResponse || {};
        if (latestFirstPage.capturedAt && Number(latestFirstPage.capturedAt) >= Number(returnStartedAt || 0)) {
          return latestFirstPage;
        }
        return null;
      }, timeout, '岗位列表刷新检测', { pollInterval: 120 });
    } catch (_) {}
  }

  // 启动扫描时先回到真实左栏顶部，确保从页面中部启动也不会遗漏上方岗位。
  async function scanJobListToTop() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cards = JobRepository.syncCards();
      const anchor = cards[0] || document.querySelector('li.job-card-box') || getJobCards()[0];
      const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
      if (!scroller) return false;
      const beforeTop = Number(scroller.scrollTop || 0);
      if (beforeTop <= 1) return true;
      const beforeRenderSignature = getVisibleJobListRenderSignature();
      const beforeResponseSerial = Number(runtime.jobListResponseSerial || 0);

      if (anchor) anchor.scrollIntoView({ block: 'start', inline: 'nearest' });
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      try {
        pageWindow.scrollTo(0, 0);
      } catch (_) {}
      await waitForJobListRenderChange(beforeRenderSignature, beforeResponseSerial, 700);
      JobRepository.syncCards();
      if (Number(scroller.scrollTop || 0) <= 1) return true;
    }
    return false;
  }

  // 虚拟列表的 DOM 数量通常固定，改为等待新岗位标识、接口批次或真实滚动进展。
  async function scrollAndWaitForMore(previousKeys) {
    const entries = getVisibleJobScanEntries();
    const cards = entries.map((entry) => entry.card);
    const lastCard = cards[cards.length - 1];
    const scroller = findScrollParent(lastCard) || document.scrollingElement || document.documentElement;
    if (!scroller) return false;

    const knownKeys = previousKeys instanceof Set
      ? previousKeys
      : new Set(Array.from(previousKeys || []).filter(Boolean));
    const beforeTop = Number(scroller.scrollTop || 0);
    const beforeSerial = Number(runtime.jobListResponseSerial || 0);
    const beforeBatchKey = runtime.jobListLastBatchKey || '';

    if (lastCard) lastCard.scrollIntoView({ block: 'end', inline: 'nearest' });
    scroller.scrollTop += Math.max(Number(scroller.clientHeight || 0) * 0.8, 500);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    const hasProgress = () => {
      const currentKeys = getVisibleJobScanEntries().map((entry) => entry.key).filter(Boolean);
      if (currentKeys.some((key) => !knownKeys.has(key))) return true;
      if (Number(runtime.jobListResponseSerial || 0) > beforeSerial) return true;
      if ((runtime.jobListLastBatchKey || '') !== beforeBatchKey) return true;
      return Number(scroller.scrollTop || 0) > beforeTop + 2;
    };

    try {
      await waitFor(hasProgress, Math.min(getWaitTimeout(), 6000), '加载更多岗位', {
        observerRoot: getJobListObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
        // 接口批次和 scrollTop 变化不一定对应 DOM MutationRecord。
        pollInterval: 120,
      });
      return true;
    } catch (_) {
      return hasProgress();
    }
  }

  // 跳过岗位后按稳定标识寻找下一张卡片，不再依赖会随虚拟滚动变化的数组游标。
  function scrollAheadByJobKey(currentKey) {
    const entries = getVisibleJobScanEntries();
    const currentIndex = entries.findIndex((entry) => entry.key === currentKey);
    const nextEntry = currentIndex >= 0 ? entries[currentIndex + 1] : null;
    if (nextEntry) {
      nextEntry.card.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }

    const anchor = entries.length ? entries[entries.length - 1].card : null;
    const scroller = findScrollParent(anchor);
    if (scroller) {
      scroller.scrollTop += 400;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }

  // 列表刷新后从顶部重新开始时使用。
  function scrollJobListToTop() {
    const cards = getJobCards();
    const anchor = cards[0] || document.querySelector('li.job-card-box') || getJobCards()[0];
    const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;

    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    try {
      pageWindow.scrollTo(0, 0);
    } catch (_) {
      window.scrollTo(0, 0);
    }
  }

  // 查找真实滚动容器；BOSS 列表不一定滚动 document。
  // 使用 WeakMap 缓存结果，避免同一元素重复遍历 DOM 树和调用 getComputedStyle。
  const _scrollParentCache = new WeakMap();
  function findScrollParent(element) {
    if (!element) return document.scrollingElement || document.documentElement;
    if (_scrollParentCache.has(element)) return _scrollParentCache.get(element);
    let current = element.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
        _scrollParentCache.set(element, current);
        return current;
      }
      current = current.parentElement;
    }
    const fallback = document.scrollingElement || document.documentElement;
    _scrollParentCache.set(element, fallback);
    return fallback;
  }

  // 岗位列表更新频繁，DOM 等待优先监听列表自身，找不到时才退回页面应用根节点。
  function getJobListObserverRoot() {
    const list = document.querySelector('.job-list-box, .search-job-result, .job-list-container, .job-list-panel, .joblist-box');
    const card = document.querySelector('li.job-card-box') || getJobCards()[0];
    return list && list.parentElement ||
      card && card.parentElement ||
      getPageObserverRoot();
  }

  // 监听右侧详情的稳定父容器，既能捕获内容更新，也能覆盖详情盒子被整体替换的情况。
  function getJobDetailObserverRoot() {
    const detail = Array.from(document.querySelectorAll('.job-detail-box')).find(isVisible) ||
      document.querySelector('.job-detail-container, .job-detail-wrapper, .job-detail-panel, .job-detail-summary');
    return detail && detail.parentElement || detail || getPageObserverRoot();
  }

  // 聊天输入框和消息列表位于同一聊天区域；若尚未渲染则监听稳定的应用根节点。
  function getChatObserverRoot() {
    const input = findChatInput();
    const conversation = Array.from(document.querySelectorAll('.chat-record, .chat-message-list, .chat-message, .chat-conversation'))
      .find((element) => !isOwnUiElement(element) && isVisible(element));
    const commonRoot = findCommonElementAncestor(input, conversation);
    return commonRoot && commonRoot !== document.body && commonRoot !== document.documentElement
      ? commonRoot
      : input && input.closest('.chat-container, .chat-wrapper, .chat-box, .chat-content, .chat-main') ||
      document.querySelector('.chat-container, .chat-wrapper, .chat-box, .chat-content, .chat-main') ||
      getPageObserverRoot();
  }

  // 找到两个聊天节点的最近公共父元素，使一次 observer 同时覆盖输入框和消息列表。
  function findCommonElementAncestor(first, second) {
    if (!first || !second) return null;
    const ancestors = new Set();
    let current = first;
    while (current) {
      ancestors.add(current);
      current = current.parentElement;
    }
    current = second;
    while (current) {
      if (ancestors.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // 页面级 SPA 切换才使用应用根节点，避免默认监听整个 documentElement。
  function getPageObserverRoot() {
    return document.querySelector('#wrap, #app, .app-main') || document.body || document.documentElement;
  }

  // 根据目标类型选择尽量小且稳定的观察根节点。
  function getElementObserverRoot(selector) {
    if (/job-card-box/.test(selector)) return getJobListObserverRoot();
    if (/job-detail|op-btn-chat/.test(selector)) return getJobDetailObserverRoot();
    if (/chat-input|contenteditable/.test(selector)) return getChatObserverRoot();
    if (/c-expect-select/.test(selector)) {
      const expectation = document.querySelector('.c-expect-select');
      return expectation && expectation.parentElement || getPageObserverRoot();
    }
    return getPageObserverRoot();
  }

  // 等待某个可见元素出现；纯 DOM 场景只由 MutationObserver 驱动，并由超时定时器兜底。
  function waitForElement(selector, timeout, label, options) {
    const settings = options || {};
    return waitFor(() => {
      const element = document.querySelector(selector);
      return element && isVisible(element) ? element : null;
    }, timeout, label || selector, {
      observerRoot: settings.observerRoot || getElementObserverRoot(selector),
      childList: true,
      subtree: settings.subtree !== false,
      attributes: settings.attributes !== false,
      attributeFilter: settings.attributeFilter || ['class', 'style', 'hidden'],
    });
  }

  // 通用条件等待器：DOM 变化和非 DOM 状态按需启用，结束时统一释放 observer/timer。
  function waitFor(predicate, timeout, label, options) {
    const rawTimeout = Number(timeout);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(1, rawTimeout > 100 ? rawTimeout : rawTimeout * 1000)
      : getWaitTimeout() * 1000;
    const settings = options || {};
    const observerRoot = settings.observerRoot && settings.observerRoot.nodeType
      ? settings.observerRoot
      : null;
    const pollInterval = Math.max(0, Number(settings.pollInterval || 0));

    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;
      let pollTimer = null;
      let timeoutTimer = null;
      let pageHideHandler = null;

      const cleanup = () => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (pageHideHandler) {
          pageWindow.removeEventListener('pagehide', pageHideHandler);
          pageHideHandler = null;
        }
      };

      const finish = (error, result) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      const check = () => {
        if (done) return;
        try {
          const result = predicate();
          if (result) finish(null, result);
        } catch (error) {
          if (error && error.zhipinAutoPause) finish(error);
        }
      };

      // 先同步检查一次，已存在的元素不会创建无意义的 observer。
      check();
      if (done) return;

      if (settings.resolveOnPageHide) {
        pageHideHandler = () => finish(null, settings.pageHideResult || true);
        pageWindow.addEventListener('pagehide', pageHideHandler, { once: true });
      }

      if (observerRoot && typeof MutationObserver === 'function') {
        observer = new MutationObserver(check);
        const observerOptions = {
          childList: settings.childList !== false,
          subtree: settings.subtree !== false,
          attributes: Boolean(settings.attributes),
          characterData: Boolean(settings.characterData),
        };
        if (observerOptions.attributes && Array.isArray(settings.attributeFilter) && settings.attributeFilter.length) {
          observerOptions.attributeFilter = settings.attributeFilter;
        }
        observer.observe(observerRoot, observerOptions);
        // 补一次检查，覆盖首次检查与 observer.observe 之间发生的变化。
        check();
      }

      if (!done && pollInterval > 0) {
        pollTimer = setInterval(check, pollInterval);
      }

      if (!done) {
        timeoutTimer = setTimeout(() => {
          finish(new Error(`${label || '目标元素'} 等待超时`));
        }, timeoutMs);
      }
    });
  }

  // 模拟用户点击，按真实坐标派发 pointer/mouse/click 事件。
  function clickElement(element) {
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.min(Math.max(rect.width / 2, 4), Math.max(rect.width - 4, 4));
    const clientY = rect.top + Math.min(Math.max(rect.height / 2, 4), Math.max(rect.height - 4, 4));
    const target = document.elementFromPoint(clientX, clientY) || element;
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: pageWindow,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: 1,
    };

    // BOSS 的部分列表项依赖真实坐标下的 pointer/mouse 事件，单纯 element.click() 不会触发。
    dispatchPointer(target, 'pointerover', mouseInit);
    target.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    dispatchPointer(target, 'pointerdown', mouseInit);
    target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    dispatchPointer(target, 'pointerup', Object.assign({}, mouseInit, { buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, mouseInit, { buttons: 0 })));
    target.dispatchEvent(new MouseEvent('click', Object.assign({}, mouseInit, { buttons: 0 })));

    if (target !== element) {
      try {
        element.click();
      } catch (_) {}
    }
  }

  // PointerEvent 不可用时降级为 MouseEvent。
  function dispatchPointer(target, type, init) {
    if (typeof PointerEvent !== 'function') return;

    try {
      target.dispatchEvent(new PointerEvent(type, Object.assign({
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }, init)));
    } catch (_) {}
  }

  // 写入 input/textarea/contenteditable，并派发 beforeinput/input/change 让 BOSS 内部状态同步。
  function setEditableText(container, text) {
    const target = container.matches('textarea,input,[contenteditable="true"]')
      ? container
      : container.querySelector('textarea,input,[contenteditable="true"]') || container;

    target.focus();
    if (typeof target.click === 'function') {
      try {
        target.click();
      } catch (_) {}
    }

    if ('value' in target) {
      setNativeValue(target, text);
      target.dispatchEvent(createInputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }));
      target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      target.dispatchEvent(createDomEvent('change', { bubbles: true }));
      return;
    }

    // BOSS 的聊天框是 contenteditable div，直接写入文本后再派发 input，让站点同步内部状态。
    target.textContent = '';
    target.textContent = text;
    placeCaretAtEnd(target);

    target.dispatchEvent(createInputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
    target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // 使用原生 value setter，避免 React/Vue 受控输入框读不到手动赋值。
  function setNativeValue(target, text) {
    const proto = target.tagName === 'TEXTAREA'
      ? pageWindow.HTMLTextAreaElement && pageWindow.HTMLTextAreaElement.prototype
      : pageWindow.HTMLInputElement && pageWindow.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(target, text);
    } else {
      target.value = text;
    }
  }

  // 把光标放到可编辑区域末尾，确保 Enter 发送的是完整文本。
  function placeCaretAtEnd(target) {
    try {
      const selection = pageWindow.getSelection && pageWindow.getSelection();
      const range = pageWindow.document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (_) {}
  }

  // 统一读取输入框或 contenteditable 的当前文本。
  function getEditableText(element) {
    if (!element) return '';
    if ('value' in element) return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }

  // 调用元素原生 click，绕过页面可能包装过的实例方法。
  function clickNative(element) {
    if (!element) return;
    try {
      element.focus && element.focus();
      const nativeClick = pageWindow.HTMLElement && pageWindow.HTMLElement.prototype.click;
      if (nativeClick) {
        nativeClick.call(element);
      } else {
        element.click();
      }
    } catch (_) {
      clickElement(element);
    }
  }

  // 创建 InputEvent，旧环境不支持时退回普通 Event。
  function createInputEvent(type, init) {
    const Ctor = pageWindow.InputEvent || InputEvent;
    try {
      return new Ctor(type, init);
    } catch (_) {
      return createDomEvent(type, init);
    }
  }

  // 普通 DOM 事件构造兜底。
  function createDomEvent(type, init) {
    const Ctor = pageWindow.Event || Event;
    return new Ctor(type, init || {});
  }

  // 在输入框上派发 Enter 键事件，触发页面自己的发送逻辑。
  function pressEnter(target) {
    const eventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      view: pageWindow,
    };
    const Ctor = pageWindow.KeyboardEvent || KeyboardEvent;
    target.focus && target.focus();
    target.dispatchEvent(new Ctor('keydown', eventInit));
    target.dispatchEvent(new Ctor('keypress', eventInit));
    target.dispatchEvent(new Ctor('keyup', eventInit));
  }

  // 公司名按模式匹配，供公司筛选和黑名单共用。
  function companyTextMatches(targetText, mode, valueText) {
    const target = normalizeText(targetText);
    const value = normalizeText(valueText);
    if (!target || !value) return false;

    const matchMode = getCompanyMatchMode(mode);
    if (matchMode === 'exact') return target === value;
    if (matchMode === 'regex') return new RegExp(value).test(target);
    return target.includes(value);
  }

  // 公司筛选逻辑，支持精确、包含、正则三种模式。
  function companyMatches(company) {
    const value = normalizeText(config.companyFilterValue);
    if (!value) return true;
    return companyTextMatches(company, config.companyFilterMode, value);
  }

  // 城市允许列表：命中任意城市即可；留空表示不限制城市（平台搜索条件已完成初步筛选）。
  // 支持三种格式：普通文本（包含匹配）、正则（以 /开头/结尾）、精确匹配（以 = 开头）。
  function getAllowedCities() {
    return String(config.allowedCities || '').split(/[\n,，、]+/).map(normalizeText).filter(Boolean);
  }

  function cityMatches(city) {
    const allowed = getAllowedCities();
    const target = normalizeText(city);
    // 列表为空 = 用户未启用城市筛选，直接放行。
    if (!allowed.length) return { matched: true, allowed, target, unrestricted: true };
    // 启用了筛选但岗位城市读不出来时，保守跳过。
    if (!target) return { matched: false, allowed, target };

    const matched = allowed.some((item) => {
      if (!item) return false;
      // 精确匹配：=北京
      if (item.startsWith('=')) return target === item.slice(1);
      // 正则匹配：/北京|上海/
      if (item.startsWith('/') && item.endsWith('/') && item.length > 2) {
        try { return new RegExp(item.slice(1, -1)).test(target); } catch (_) { return false; }
      }
      // 默认包含匹配
      return target.includes(item);
    });
    return { matched, allowed, target };
  }

  // 解析岗位薪资文本为月薪区间（单位：K）。
  // 支持 5000-8000元、7-9K、6千-1万、1.5-2万、20-30万/年、150-200元/天 等写法；
  // 无法识别、加密字体或“面议”时返回 null，调用方视为薪资不明并保留岗位。
  function parseSalaryRange(text) {
    const display = normalizeText(text);
    if (!display || isEncryptedSalary(display)) return null;
    if (/(?:面议|面谈|保密|薪资不限)/.test(display)) return null;

    // 去掉“·13薪 / ×14薪 / 15薪”这类发薪月数，避免被当成薪资数字。
    const cleaned = display
      .replace(/(?:[·・xX×*]\s*)?\d+(?:\.\d+)?\s*薪/g, ' ')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.')
      .replace(/[－—–~～至到]/g, '-')
      .replace(/,/g, '');

    const tokens = [];
    const pattern = /(\d+(?:\.\d+)?)\s*([kK千万]|元)?/g;
    let match;
    while ((match = pattern.exec(cleaned))) {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const unit = match[2] === 'k' || match[2] === 'K' || match[2] === '千'
        ? 'k'
        : match[2] === '万'
          ? 'wan'
          : match[2] === '元'
            ? 'yuan'
            : '';
      tokens.push({ value, unit });
    }
    if (!tokens.length) return null;

    const period = /年/.test(cleaned) ? 'year' : (/天/.test(cleaned) ? 'day' : 'month');
    const knownUnit = tokens.map((item) => item.unit).find(Boolean) || '';
    const fallbackUnit = Math.max.apply(null, tokens.map((item) => item.value)) >= 1000 ? 'yuan' : 'k';

    const toMonthlyK = (token) => {
      const unit = token.unit || knownUnit || fallbackUnit;
      const monthly = unit === 'wan'
        ? token.value * 10
        : unit === 'yuan'
          ? token.value / 1000
          : token.value;
      if (period === 'year') return monthly / 12;
      if (period === 'day') return monthly * 22;
      return monthly;
    };

    // 薪资区间通常只有两个数字；多出来的（如“双休”“3年经验”）一并忽略。
    const values = tokens.slice(0, 2)
      .map(toMonthlyK)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return null;

    const roundK = (value) => Math.round(value * 10) / 10;
    return {
      minK: roundK(Math.min.apply(null, values)),
      maxK: roundK(Math.max.apply(null, values)),
      text: display,
      period,
    };
  }

  // 薪资区间显示：整数不带小数，避免日志里出现 8.0K。
  function formatSalaryK(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // 读取薪资筛选要求（月薪 K）；区间上下限都为 0 时视为未启用。
  function getSalaryFilterRange() {
    let minK = Math.max(0, Number(config.salaryMinK) || 0);
    let maxK = Math.max(0, Number(config.salaryMaxK) || 0);
    // 上下限填反时自动纠正，避免配置错误导致所有岗位都被跳过。
    if (minK > 0 && maxK > 0 && minK > maxK) {
      const swapped = minK;
      minK = maxK;
      maxK = swapped;
    }
    return { minK, maxK, active: Boolean(config.salaryFilterEnabled) && (minK > 0 || maxK > 0) };
  }

  // 从卡片整段文本中兜底提取薪资片段：接口和卡片薪资字段都缺失时仍能参与筛选。
  function extractSalaryTextFromText(text) {
    const source = normalizeText(text);
    if (!source) return '';
    const range = source.match(/\d+(?:\.\d+)?\s*(?:[-~至到—])\s*\d+(?:\.\d+)?\s*(?:元|千|[kK]|万)(?:\s*\/\s*(?:月|年|天))?/);
    if (range) return range[0];
    const single = source.match(/\d+(?:\.\d+)?\s*(?:元|千|[kK]|万)(?:\s*\/\s*(?:月|年|天))?/);
    return single ? single[0] : '';
  }

  // 从岗位字段、DOM 薪资、卡片文本三处依次取第一个可解析的薪资。
  function resolveSalaryText(job, domInfo) {
    const candidates = [
      getDisplaySalary(job),
      getReadableSalary(domInfo && domInfo.salary),
      extractSalaryTextFromText(domInfo && domInfo.text),
    ];
    let firstText = '';
    for (const candidate of candidates) {
      const text = normalizeText(candidate);
      if (!text) continue;
      if (!firstText) firstText = text;
      const range = parseSalaryRange(text);
      if (range) return { salaryText: text, range };
    }
    return { salaryText: firstText, range: null };
  }

  // 判断岗位薪资是否符合要求：严格模式要求岗位区间落在设定范围内，宽松模式有重叠即可。
  function salaryMatches(job, domInfo) {
    const required = getSalaryFilterRange();
    if (!required.active) {
      return Object.assign({ matched: true, active: false, salaryText: '', range: null }, required);
    }

    const resolved = resolveSalaryText(job, domInfo);
    const salaryText = resolved.salaryText;
    const range = resolved.range;
    if (!range) {
      return Object.assign({ matched: true, active: true, unknown: true, salaryText, range: null }, required);
    }

    const rangeText = `${formatSalaryK(range.minK)}-${formatSalaryK(range.maxK)}K`;
    const reject = (reason) => Object.assign({
      matched: false,
      active: true,
      salaryText,
      range,
      reason,
    }, required);

    if (config.salaryMatchMode === 'overlap') {
      // 宽松：两个区间只要有交集就保留。
      if (required.maxK > 0 && range.minK > required.maxK) {
        return reject(`岗位薪资 ${rangeText} 高于上限 ${formatSalaryK(required.maxK)}K`);
      }
      if (required.minK > 0 && range.maxK < required.minK) {
        return reject(`岗位薪资 ${rangeText} 低于下限 ${formatSalaryK(required.minK)}K`);
      }
      return Object.assign({ matched: true, active: true, salaryText, range }, required);
    }

    // 严格：岗位薪资区间必须完全落在设定范围内；未填的一端视为不限。
    if (required.minK > 0 && range.minK < required.minK) {
      return reject(`岗位薪资 ${rangeText} 低于下限 ${formatSalaryK(required.minK)}K`);
    }
    if (required.maxK > 0 && range.maxK > required.maxK) {
      return reject(`岗位薪资 ${rangeText} 高于上限 ${formatSalaryK(required.maxK)}K`);
    }
    return Object.assign({ matched: true, active: true, salaryText, range }, required);
  }

  // 收集岗位上可用于黑名单匹配的公司名，详情补全后会包含全称/简称。
  function getCompanyMatchCandidates(job, fallbackCompany) {
    const values = [
      job && job.company,
      job && job.companyFullName,
      job && job.companyShortName,
      fallbackCompany,
    ];
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 任意一条公司黑名单规则命中即跳过，返回命中的规则和公司文本。
  function findCompanyBlacklistMatch(job, fallbackCompany) {
    const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
    if (!rules.length) return null;

    const candidates = getCompanyMatchCandidates(job, fallbackCompany);
    for (const rule of rules) {
      for (const company of candidates) {
        try {
          if (companyTextMatches(company, rule.mode, rule.value)) {
            return { rule, company };
          }
        } catch (error) {
          logDebugEvent('invalid_company_blacklist_rule', {
            rule,
            error: error.message || String(error),
          }, 'warn');
        }
      }
    }
    return null;
  }

  // 根据当前配置判断岗位 Boss 活跃度是否命中，并返回可用于日志/UI 的判定信息。
  function bossActiveMatches(job) {
    const selectedKeys = getSelectedBossActiveKeys();
    const activeText = getDisplayBossActiveTime(job);
    const activeKey = normalizeBossActiveText(activeText);
    if (!selectedKeys.length) {
      return { matched: true, activeText, selectedText: '' };
    }

    return {
      matched: Boolean(activeKey && selectedKeys.some((key) => activeKey === key || activeKey.includes(key))),
      activeText,
      selectedText: normalizeBossActiveOptions(config.bossActiveFilterValues).join('、'),
    };
  }

  // 活跃度字段缺失时，从右侧详情 DOM 轻量补充；这里只补活跃度，不触发完整工商抓取。
  async function enrichBossActiveInfoForFilter(job) {
    if (!hasBossActiveFilter() || getDisplayBossActiveTime(job)) return job;

    try {
      const domDetail = await waitFor(() => {
        const detail = extractDetailInfo();
        return detail && detail.bossActiveTimeDesc ? detail : null;
      }, Math.min(1800, getWaitTimeout() * 1000), 'Boss活跃度', {
        observerRoot: getJobDetailObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
      return mergeJobInfo(job, {
        bossActiveTimeDesc: domDetail.bossActiveTimeDesc,
        bossOnline: domDetail.bossOnline,
      });
    } catch (_) {
      return job;
    }
  }

  // 启动前校验配置，发现问题时返回可直接显示给用户的错误文案。
  function validateConfig() {
    const min = Number(config.delayMin);
    const max = Number(config.delayMax);
    const wait = Number(config.waitTimeout);

    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < 1) {
      return '时间间隔必须是大于 0 的数字';
    }

    if (min > max) return '最小间隔不能大于最大间隔';
    if (!Number.isFinite(wait) || wait < 2) return '等待上限不能小于 2 秒';

    const maxListRefresh = Number(config.maxListRefresh);
    if (!Number.isFinite(maxListRefresh) || maxListRefresh < 0) {
      return '列表刷新上限不能小于 0';
    }

    if (config.companyFilterMode === 'regex' && config.companyFilterValue) {
      try {
        new RegExp(config.companyFilterValue);
      } catch (error) {
        return `公司正则无效：${error.message}`;
      }
    }

    for (const rule of normalizeCompanyBlacklistRules(config.companyBlacklistRules)) {
      if (rule.mode !== 'regex') continue;
      try {
        new RegExp(rule.value);
      } catch (error) {
        return `公司黑名单正则无效：${rule.value} / ${error.message}`;
      }
    }

    if (config.greetingMode === 'customText' && config.textSource === 'text' && !normalizeMessageText(config.customText)) {
      return '自定义文本不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api' && !config.customApiUrl) {
      return '自定义文本接口不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api') {
      try {
        parseKeyValueConfig(config.customApiParams, 'URL 参数');
        parseKeyValueConfig(config.customApiHeaders, '请求头');
        parseRequestBodyConfig(config.customApiBody, '请求体');
      } catch (error) {
        return error.message || String(error);
      }
    }

    return '';
  }

  // 列表/详情等待上限，配置单位是秒，这里转换为毫秒前做最小值保护。
  function getWaitTimeout() {
    return Math.max(2, Number(config.waitTimeout || DEFAULT_CONFIG.waitTimeout));
  }

  // 聊天页打开重试次数，负数或异常值按 0 处理。
  function getChatOpenRetryLimit() {
    return Math.max(0, Math.floor(Number(config.chatOpenRetries ?? DEFAULT_CONFIG.chatOpenRetries) || 0));
  }

  // 聊天页等待时间比列表更长，给路由和会话渲染留余量。
  function getChatWaitTimeout() {
    return Math.max(15, getWaitTimeout());
  }

  // 生成两次沟通之间的随机等待毫秒数。
  function randomDelayMs(minSeconds, maxSeconds) {
    return randomDelaySeconds(minSeconds, maxSeconds) * 1000;
  }

  // 随机等待秒数，UI 状态里直接展示这个值。
  function randomDelaySeconds(minSeconds, maxSeconds) {
    const min = Math.max(1, Math.ceil(Number(minSeconds || DEFAULT_CONFIG.delayMin)));
    const max = Math.max(min, Math.floor(Number(maxSeconds || DEFAULT_CONFIG.delayMax)));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // 从 localStorage 中的 RunState 恢复 pendingJob，并补齐运行所需的派生字段。
  function revivePendingJob(state) {
    const pending = Object.assign({}, state.pendingJob || {});
    pending.rawJob = state.pendingRawJob || pending.rawJob || null;
    pending.id = pending.id || `job_${hashString(pending.jobKey || `${pending.jobName}|${pending.company}`)}`;
    pending.signature = pending.signature || makeSignature(pending.jobName, pending.company, pending.salary);
    return pending;
  }

  // 将岗位对象拍平成 IndexedDB/导出友好的结构，避免保存复杂引用和原型对象。
  function flattenJob(job) {
    return {
      id: job.id,
      jobKey: job.jobKey,
      signature: job.signature,
      orderIndex: job.orderIndex,
      jobName: job.jobName,
      salary: getDisplaySalary(job),
      company: job.company,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      bossActiveTimeDesc: getDisplayBossActiveTime(job),
      bossOnline: job.bossOnline,
      bossAvatar: job.bossAvatar,
      bossCertificated: job.bossCertificated,
      city: job.city,
      experience: job.experience,
      degree: job.degree,
      positionName: job.positionName,
      address: job.address,
      workAddress: job.workAddress,
      longitude: job.longitude,
      latitude: job.latitude,
      staticMapUrl: job.staticMapUrl,
      encryptAddressId: job.encryptAddressId,
      postDescription: job.postDescription,
      recruitmentCountDesc: job.recruitmentCountDesc,
      positionCode: job.positionCode,
      jobType: job.jobType,
      jobStatusDesc: job.jobStatusDesc,
      showSkills: Array.isArray(job.showSkills) ? job.showSkills.slice() : [],
      companyLogo: job.companyLogo,
      companyFullName: job.companyFullName,
      companyShortName: job.companyShortName,
      companyStage: job.companyStage,
      companyScale: job.companyScale,
      companyIndustry: job.companyIndustry,
      companyIntroduce: job.companyIntroduce,
      companyLabels: Array.isArray(job.companyLabels) ? job.companyLabels.slice() : [],
      businessInfo: job.businessInfo && typeof job.businessInfo === 'object' ? Object.assign({}, job.businessInfo) : null,
      legalRepresentative: job.legalRepresentative,
      establishedDate: job.establishedDate,
      companyType: job.companyType,
      manageState: job.manageState,
      registeredCapital: job.registeredCapital,
      registeredAddress: job.registeredAddress,
      businessTerm: job.businessTerm,
      businessRegion: job.businessRegion,
      unifiedSocialCreditCode: job.unifiedSocialCreditCode,
      approvalDate: job.approvalDate,
      formerName: job.formerName,
      registrationAuthority: job.registrationAuthority,
      businessIndustry: job.businessIndustry,
      businessScope: job.businessScope,
      brandId: job.brandId,
      encryptJobId: job.encryptJobId,
      securityId: job.securityId,
      lid: job.lid,
      source: job.source,
      sourceUrl: job.sourceUrl,
      detailSource: job.detailSource,
      detailSourceUrl: job.detailSourceUrl,
      detailCapturedAt: job.detailCapturedAt,
      htmlDetailUrl: job.htmlDetailUrl,
      htmlCapturedAt: job.htmlCapturedAt,
      companyDetailUrl: job.companyDetailUrl,
      companyDetailCapturedAt: job.companyDetailCapturedAt,
      domOnly: Boolean(job.domOnly),
    };
  }

  // 判断一条记录是否应视为“已沟通”，包括发送成功和本地/页面跳过。
  function isContactedRecord(record) {
    return Boolean(record && (
      record.status === 'sent' ||
      record.status === 'skipped_contacted' ||
      record.status === 'skipped_local_contacted' ||
      record.sentAt
    ));
  }

  // 数据页记录状态文案：投递 / 招呼 / 点击 / 跳过。
  function getRecordStatusMeta(record) {
    const status = String(record && record.status || '');
    const messageType = String(record && record.messageType || '');
    if (status === 'sent' || record && record.sentAt) {
      return {
        label: messageType === 'chatGreeting' ? '已招呼' : '已投递',
        cls: 'za-record-chip za-record-chip-sent',
      };
    }
    if (status === 'clicked') {
      return { label: '已点击', cls: 'za-record-chip za-record-chip-click' };
    }
    if (status === 'skipped_contacted' || status === 'skipped_local_contacted') {
      return { label: '重复跳过', cls: 'za-record-chip za-record-chip-skip' };
    }
    if (/^skipped/.test(status)) {
      return { label: '已跳过', cls: 'za-record-chip za-record-chip-skip' };
    }
    return { label: '已记录', cls: 'za-record-chip' };
  }

  // 为岗位生成一组稳定判重 key，优先使用加密岗位 ID、securityId、lid 等强标识。
  function getContactedKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const hasStableJobKey = job.jobKey && !isSyntheticJobKey(job.jobKey);
    const strongPairs = [
      ['jobKey', hasStableJobKey ? job.jobKey : ''],
      ['encryptJobId', job.encryptJobId],
      ['securityId', job.securityId],
      ['lid', job.lid],
      ['id', hasStableJobKey ? job.id : ''],
      ['rawJobId', rawJob.jobId],
      ['rawJobId', rawJob.job_id],
      ['rawEncryptJobId', rawJob.encryptJobId],
      ['rawSecurityId', rawJob.securityId],
      ['rawLid', rawJob.lid],
    ];

    const strongKeys = strongPairs
      .map(([type, value]) => makeContactedKey(type, value))
      .filter(Boolean);

    if (strongKeys.length) return Array.from(new Set(strongKeys));

    const looseSignature = job.looseSignature || makeLooseSignature(job.jobName, job.company);
    const fallbackKey = makeContactedKey('looseSignature', looseSignature);
    return fallbackKey ? [fallbackKey] : [];
  }

  // 给不同来源的判重值加前缀，避免不同字段值碰巧相同。
  function makeContactedKey(type, value) {
    const text = normalizeText(value);
    if (!text) return '';
    return `${type}:${text}`;
  }

  // synthetic key 是脚本用 DOM 字段拼出来的弱 key，不可当强身份使用。
  function isSyntheticJobKey(value) {
    return /^sig_/.test(normalizeText(value));
  }

  // 删除空值字段，避免保存记录时用空字符串覆盖后到的有效详情。
  function compactObject(source) {
    const output = {};
    Object.keys(source || {}).forEach((key) => {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        output[key] = source[key];
      }
    });
    return output;
  }

  // 文本模板插值，例如 {jobName}、{company}、{bossName}。
  function interpolateText(template, job) {
    const source = String(template || '');
    const data = flattenJob(job || {});
    return source.replace(/\{(\w+)\}/g, (match, key) => {
      if (data[key] == null) return match;
      return String(data[key]);
    });
  }

  // 从一组候选字段中读取第一个非空字符串/数字。
  function pickFirstString(target, keys) {
    if (!target) return '';
    for (const key of keys) {
      const value = target[key];
      if (typeof value === 'string' && value.trim()) return normalizeText(value);
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  // 将接口中的标签数组归一化为字符串数组。
  function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => normalizeText(item && typeof item === 'object' ? item.name || item.text || item.label : item))
      .filter(Boolean);
  }

  // 清理文本但保留换行，用于岗位描述、经营范围等长文本。
  function normalizeTextPreserveLines(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 读取薪资字段，并过滤 BOSS 私有字体加密后的不可读薪资。
  function pickReadableSalary(target, keys) {
    // 接口 salaryDesc 是首选；如果取到的是私有区字符，继续尝试其它薪资字段。
    const first = pickFirstString(target, keys);
    if (!isEncryptedSalary(first)) return first;

    for (const key of keys) {
      const value = getReadableSalary(target && target[key]);
      if (value) return value;
    }
    return '';
  }

  // 生成岗位详情匹配 key，允许列表岗位和详情岗位互相找到。
  function getJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const values = [
      job.jobKey,
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.encryptId,
      job.rawDetail && job.rawDetail.securityId,
      job.rawDetail && job.rawDetail.lid,
    ];

    if (job.signature) values.push(`signature:${job.signature}`);
    if (job.looseSignature) values.push(`loose:${job.looseSignature}`);
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 可靠身份只包含真实接口 ID，不包含 DOM 拼出来的 sig_ 弱 key。
  function getReliableJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const rawDetail = job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [];
    const jobKey = normalizeText(job.jobKey);
    if (jobKey && !isSyntheticJobKey(jobKey)) values.push(jobKey);

    [
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ].forEach((value) => values.push(value));

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 弱签名只能用于没有可靠 ID 的兜底匹配，并且文本字段不能明显冲突。
  function isWeakDetailCompatible(job, detail) {
    return getWeakDetailCompatibilityReport(job, detail).compatible;
  }

  function getWeakDetailCompatibilityReport(job, detail) {
    if (!job || !detail) {
      return { compatible: false, reason: 'missing_job_or_detail' };
    }

    if (!areComparableTextsCompatible(job.jobName, detail.jobName)) {
      return {
        compatible: false,
        reason: 'job_name_mismatch',
        jobName: job.jobName,
        detailJobName: detail.jobName,
      };
    }
    if (!areComparableTextsCompatible(job.company, detail.company)) {
      return {
        compatible: false,
        reason: 'company_mismatch',
        company: job.company,
        detailCompany: detail.company,
      };
    }

    const jobSalary = getReadableSalary(job.salary);
    const detailSalary = getReadableSalary(detail.salary);
    if (jobSalary && detailSalary && jobSalary !== detailSalary) {
      return {
        compatible: false,
        reason: 'salary_mismatch',
        jobSalary,
        detailSalary,
      };
    }

    return {
      compatible: true,
      reason: 'weak_text_match',
      jobSalary,
      detailSalary,
    };
  }

  // 主动补拉详情后的安全校验：优先要求可靠 ID 命中，必要时才退回文本兼容判断。
  function isFetchedDetailCompatibleWithJob(job, detail, options) {
    return getFetchedDetailCompatibilityReport(job, detail, options).compatible;
  }

  function getFetchedDetailCompatibilityReport(job, detail, options) {
    const jobKeys = getReliableJobIdentityKeys(job);
    const detailKeyList = getReliableJobIdentityKeys(detail);
    const detailKeys = new Set(detailKeyList);
    const commonKeys = jobKeys.filter((key) => detailKeys.has(key));
    const allowWeakWithReliableKey = Boolean(options && options.allowWeakWithReliableKey);
    const weakReport = getWeakDetailCompatibilityReport(job, detail);

    if (jobKeys.length && detailKeyList.length) {
      if (commonKeys.length) {
        return Object.assign({}, weakReport, {
          compatible: true,
          reason: 'reliable_key_match',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
      if (!allowWeakWithReliableKey) {
        return Object.assign({}, weakReport, {
          compatible: false,
          reason: 'reliable_key_mismatch',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
    }

    return Object.assign({}, weakReport, {
      jobKeys,
      detailKeys: detailKeyList,
      commonKeys,
      allowWeakWithReliableKey,
    });
  }

  // 比较岗位名/公司名等文本字段；一边缺失时不阻断补全。
  function areComparableTextsCompatible(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return true;
    return a === b || a.includes(b) || b.includes(a);
  }

  // 只返回强身份 key，用于列表和详情之间高可信合并。
  function getJobStrongIdentityKeys(job) {
    return getReliableJobIdentityKeys(job);
  }

  // 详情对象入库索引用 key，和 getJobIdentityKeys 保持兼容。
  function getJobDetailKeys(detail) {
    if (!detail) return [];

    const rawDetail = detail.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [
      detail.jobKey,
      detail.encryptJobId,
      detail.securityId,
      detail.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ];

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // UI/导出展示薪资时优先使用明文薪资，避免展示私有字体字符。
  function getDisplaySalary(job) {
    return getReadableSalary(job && job.salary) ||
      getReadableSalary(job && job.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salary) ||
      '';
  }

  // 相对时间显示：几分钟前、几小时前、几天前。
  function formatRelativeTime(dateString) {
    if (!dateString) return '';
    const ts = new Date(dateString).getTime();
    if (Number.isNaN(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}个月前`;
    return `${Math.floor(months / 12)}年前`;
  }

  // Boss 活跃时间可能来自接口、HTML 或原始字段，这里统一展示取值。
  function getDisplayBossActiveTime(job) {
    if (!job) return '';
    if (job.bossOnline) return '在线';
    const rawActiveText =
      pickFirstString(job.rawDetail && job.rawDetail.bossInfo, [
        'activeTimeDesc',
        'bossActiveTimeDesc',
        'bossActiveDesc',
        'lastActiveTimeDesc',
        'onlineDesc',
      ]) ||
      pickFirstString(job.rawDetail, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc']) ||
      pickFirstString(job.rawJob, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc', 'lastActiveTimeDesc']);
    return getBossActiveOptionLabel(job.bossActiveTimeDesc) ||
      getBossActiveOptionLabel(rawActiveText) ||
      '';
  }

  // 公司展示优先完整公司名，再退回简称/列表公司名。
  function getDisplayCompany(job) {
    return getDisplayText(job && job.company);
  }

  // 统一清理导出/UI 文本。
  function getDisplayText(value) {
    const text = normalizeText(value);
    return text && !isEncryptedSalary(text) ? text : '';
  }

  // 判断薪资是否可读；私有区字符返回空。
  function getReadableSalary(value) {
    const text = normalizeText(value);
    if (!text || isEncryptedSalary(text)) return '';
    return text;
  }

  // BOSS 私有字体薪资一般落在 Unicode 私有区，不能用于记录和匹配。
  function isEncryptedSalary(text) {
    // BOSS 部分 DOM 会用私有区字体映射展示薪资，如 “-K”；接口 salaryDesc 通常是明文。
    return /[\uE000-\uF8FF]/.test(String(text || ''));
  }

  // 有深度限制的对象遍历，用于从未知接口结构中找岗位/常用语字段。
  function walkObject(value, visitor, depth) {
    const currentDepth = depth || 0;
    if (currentDepth > 8 || value == null) return;
    visitor(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walkObject(item, visitor, currentDepth + 1));
      return;
    }

    if (typeof value === 'object') {
      Object.keys(value).forEach((key) => walkObject(value[key], visitor, currentDepth + 1));
    }
  }

  // 完整签名：岗位名 + 公司 + 薪资，匹配精度较高。
  function makeSignature(jobName, company, salary) {
    return [jobName, company, salary].map(normalizeText).join('|');
  }

  // 弱签名：岗位名 + 公司，薪资不可读或缺失时使用。
  function makeLooseSignature(jobName, company) {
    return [jobName, company].map(normalizeText).join('|');
  }

  // 过滤只有分隔符的空签名。
  function isMeaningfulCompositeKey(value) {
    const text = normalizeText(value);
    return Boolean(text && text.replace(/[|:]/g, ''));
  }

  // 单行文本归一化。
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // Boss 活跃度匹配专用归一化：去掉 DOM/伪元素残留、标点和分隔符。
  function normalizeBossActiveText(text) {
    return normalizeText(text)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/::?(?:before|after)/gi, '')
      .replace(/[^\u3400-\u9FFFA-Za-z0-9]/g, '')
      .replace(/^(?:BOSS|Boss|boss|HR|hr)+/, '')
      .trim();
  }

  // 发送消息归一化：保留换行，只去掉首尾空白。
  function normalizeMessageText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  // 把用户输入转义为安全的正则字面量。
  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 判断元素是否可见，避免点击/等待隐藏节点。
  // 快速路径：offsetWidth/offsetHeight 为 0 时无需 getComputedStyle（display:none 或不在 DOM）。
  function isVisible(element) {
    if (!element) return false;
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    if (w === 0 && h === 0) return false;
    // 维度正常时，getComputedStyle 只检查 visibility（display:none 已被上面的 0 尺寸覆盖）
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Promise 版延时。
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 带状态栏刷新的一秒倒计时等待，用于自动沟通间隔提示。
  async function waitWithStatusCountdown(nextRunAt, createMessage) {
    while (!runtime.stopRequested) {
      const state = RunState.load();
      if (!state || !state.active) return false;

      const remainingMs = Math.max(0, Number(nextRunAt || 0) - Date.now());
      if (remainingMs <= 0) break;

      const remainingSeconds = Math.ceil(remainingMs / 1000);
      UI.setStatus(createMessage(remainingSeconds), 'info');
      await sleep(Math.min(1000, remainingMs));
    }
    return !runtime.stopRequested;
  }

  // 统一使用 ISO 时间写入记录，便于排序和导出。
  function nowIso() {
    return new Date().toISOString();
  }

  // 解析面板里的本地时间输入。
  function parseDateTimeLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 面板状态展示用的本地时间格式。
  function formatLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 一条记录的沟通时间优先级，用于排序和按时间清理。
  function getRecordCommunicationTime(record) {
    return record && (record.sentAt || record.clickedAt || record.updatedAt || record.createdAt || '');
  }

  // 查询浏览器当前 origin 的存储使用量和配额。
  async function getStorageEstimate() {
    try {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      const estimate = await navigator.storage.estimate();
      return {
        usage: Number(estimate.usage || 0),
        quota: Number(estimate.quota || 0),
      };
    } catch (_) {
      return null;
    }
  }

  // 构造用户可读的存储空间不足错误。
  function createStorageQuotaError(estimate, cause) {
    const usage = estimate && Number(estimate.usage || 0);
    const quota = estimate && Number(estimate.quota || 0);
    const ratio = quota ? Math.round((usage / quota) * 100) : 0;
    const detail = quota
      ? `当前已使用 ${formatBytes(usage)} / ${formatBytes(quota)}（约 ${ratio}%）。`
      : '';
    const error = new Error(`浏览器本地存储空间已接近上限，${detail}请先导出并删除部分岗位记录后再继续。`);
    error.cause = cause || null;
    error.zhipinStorageQuota = true;
    return error;
  }

  // 兼容不同浏览器的 IndexedDB 配额错误名称和消息。
  function isStorageQuotaError(error) {
    const name = String(error && error.name || '');
    const message = String(error && error.message || '');
    return /QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED/i.test(name) ||
      /quota|storage|空间|配额/i.test(message);
  }

  // 存储配额提示里的字节格式化。
  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
  }

  // 清理数据前的确认入口：优先使用脚本内弹窗，没有 UI 时退回浏览器 confirm。
  function askConfirm(message, options) {
    if (runtime.ui && runtime.ui.root) {
      return showConfirmDialog(message, options);
    }

    const confirmFn = window.confirm || pageWindow.confirm;
    if (typeof confirmFn !== 'function') {
      return Promise.reject(new Error('当前浏览器环境不支持确认弹窗'));
    }

    return Promise.resolve(confirmFn.call(window, message));
  }

  // 脚本内确认弹窗，避免页面样式或浏览器拦截影响确认流程。
  // 追加到 document.body 而非 runtime.ui.root，确保 z-index 层级高于脚本面板和 BOSS 页面。
  let cancelActiveConfirm = null;
  function showConfirmDialog(message, options) {
    const opts = options || {};
    const title = opts.title || '确认操作';
    const confirmText = opts.confirmText || '确认删除';
    const cancelText = opts.cancelText || '取消';
    const tone = opts.tone === 'normal' ? 'normal' : 'danger';

    return new Promise((resolve) => {
      // 关闭已有弹窗（连同它的键盘监听），避免新旧弹窗同时响应按键
      if (typeof cancelActiveConfirm === 'function') {
        const cancelPrevious = cancelActiveConfirm;
        cancelActiveConfirm = null;
        cancelPrevious();
      }
      const existing = document.body.querySelector('.za-confirm-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.className = 'za-confirm-backdrop';
      backdrop.dataset.tone = tone;
      backdrop.innerHTML = `
        <div class="za-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="za-confirm-title" aria-describedby="za-confirm-message">
          <div class="za-confirm-icon-wrap" aria-hidden="true">
            <svg class="za-confirm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <h2 class="za-confirm-title" id="za-confirm-title">${escapeHtml(title)}</h2>
          <p class="za-confirm-message" id="za-confirm-message">${escapeHtml(message)}</p>
          <div class="za-confirm-actions">
            <button type="button" class="za-confirm-btn-cancel" data-confirm="cancel">${escapeHtml(cancelText)}</button>
            <button type="button" class="za-confirm-btn-danger" data-confirm="ok">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;

      let settled = false;
      const cleanup = (value) => {
        if (settled) return;
        settled = true;
        if (cancelActiveConfirm === cancelSelf) cancelActiveConfirm = null;
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.classList.add('za-confirm-fadeout');
        setTimeout(() => {
          backdrop.remove();
          resolve(value);
        }, 160);
      };
      const cancelSelf = () => cleanup(false);
      cancelActiveConfirm = cancelSelf;

      const findButton = (action) => backdrop.querySelector(`[data-confirm="${action}"]`);

      backdrop.addEventListener('click', (event) => {
        const action = event.target && event.target.dataset && event.target.dataset.confirm;
        if (action === 'ok') cleanup(true);
        if (action === 'cancel' || event.target === backdrop) cleanup(false);
      });

      // 捕获阶段监听，避免 BOSS 页面的快捷键拦截 Esc / Enter。
      function onKeydown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          cleanup(false);
          return;
        }
        if (event.key === 'Enter') {
          const active = document.activeElement;
          if (active === findButton('ok')) {
            event.stopPropagation();
            event.preventDefault();
            cleanup(true);
          }
          return;
        }
        if (event.key !== 'Tab') return;
        // 焦点锁在弹窗内，避免 Tab 跑到 BOSS 页面控件上。
        const focusables = [findButton('cancel'), findButton('ok')].filter(Boolean);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!backdrop.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }

      // 追加到 document.body 确保最高层级
      document.body.appendChild(backdrop);
      document.addEventListener('keydown', onKeydown, true);
      // 聚焦取消按钮，防止误触回车确认删除
      const cancelButton = findButton('cancel');
      if (cancelButton) cancelButton.focus();
    });
  }

  // 导出文件名中的时间戳。
  function dateFileName() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  // FNV-1a 风格哈希，用于合成稳定短 id。
  function hashString(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  // UI innerHTML 中插入文本前必须转义，避免记录内容破坏面板 DOM。
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 优先使用系统“另存为”选择器；不可用时由 downloadBlob 降级成浏览器下载。
  function requestSaveFileHandle(fileName, extension) {
    const picker = pageWindow && pageWindow.showSaveFilePicker;
    if (typeof picker !== 'function') return null;

    const ext = String(extension || '').replace(/^\./, '').toLowerCase();
    const mimeType = ext === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/json';
    const description = ext === 'xlsx' ? 'Excel 工作簿' : 'JSON 数据';

    try {
      return Promise.resolve(picker.call(pageWindow, {
        suggestedName: ensureFileExtension(fileName, ext),
        excludeAcceptAllOption: true,
        types: [{
          description,
          accept: { [mimeType]: [`.${ext}`] },
        }],
      }));
    } catch (error) {
      console.warn('[ZhipinAuto] 系统另存为不可用，降级为浏览器下载', error);
      return null;
    }
  }

  // 写入用户选择的文件句柄，失败或不支持时创建 blob URL 触发下载。
  async function downloadBlob(content, fileName, type, extension, saveHandlePromise) {
    const safeFileName = ensureFileExtension(fileName, extension);
    const blob = createBlob(content, type);

    if (saveHandlePromise) {
      let handle = null;
      try {
        handle = await saveHandlePromise;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          const cancelled = new Error('用户取消导出');
          cancelled.zhipinAutoExportCancelled = true;
          throw cancelled;
        }
        console.warn('[ZhipinAuto] 系统另存为失败，降级为浏览器下载', error);
      }

      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return ensureFileExtension(handle.name || safeFileName, extension);
      }
    }

    const url = URL.createObjectURL(blob);

    try {
      triggerAnchorDownload(url, safeFileName);
      return safeFileName;
    } catch (error) {
      throw new Error(`浏览器下载失败：${error.message || error}`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
  }

  // 兼容字符串、ArrayBuffer 和已经构造好的 Blob。
  function createBlob(content, type) {
    if (content instanceof Blob) return content;
    return new Blob([content], { type });
  }

  // 清理非法文件名字符，并保证导出文件有正确扩展名。
  function ensureFileExtension(fileName, extension) {
    const normalized = String(fileName || `zhipin-job-records-${dateFileName()}`).replace(/[\\/:*?"<>|]+/g, '-');
    const ext = String(extension || '').replace(/^\./, '');
    if (!ext || new RegExp(`\\.${escapeRegExp(ext)}$`, 'i').test(normalized)) return normalized;
    return `${normalized}.${ext}`;
  }

  // 浏览器下载兜底：临时创建隐藏 a 标签并触发原生 click。
  function triggerAnchorDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.setAttribute('download', fileName);
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);

    const nativeClick = pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype.click;
    if (nativeClick) {
      nativeClick.call(link);
    } else {
      link.click();
    }

    link.remove();
  }

  // 注入全新现代化样式（覆盖旧样式）
  function injectNewStyle() {
    if (document.getElementById('zhipin-auto-greeting-new-style')) return;
    const style = document.createElement('style');
    style.id = 'zhipin-auto-greeting-new-style';
    style.textContent = `
      #zhipin-auto-greeting-root {
        --za-bg: #ffffff;
        --za-bg-soft: #f8fafc;
        --za-bg-deep: #f1f5f9;
        --za-border: #e2e8f0;
        --za-border-strong: #cbd5e1;
        --za-text: #0f172a;
        --za-muted: #64748b;
        --za-primary: #d97706;
        --za-primary-deep: #b45309;
        --za-primary-soft: #fffbeb;
        --za-primary-border: #fde68a;
        --za-accent: #2563eb;
        --za-accent-soft: #eff6ff;
        --za-danger: #dc2626;
        --za-danger-soft: #fef2f2;
        --za-success: #059669;
        --za-success-soft: #ecfdf5;
        --za-warn: #d97706;
        --za-warn-soft: #fffbeb;
        --za-shadow-sm: 0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04);
        --za-shadow-md: 0 4px 12px rgba(15, 23, 42, 0.10), 0 2px 4px rgba(15, 23, 42, 0.06);
        --za-shadow-lg: 0 20px 48px rgba(15, 23, 42, 0.18), 0 8px 16px rgba(15, 23, 42, 0.08);
        --za-radius: 12px;
        --za-radius-sm: 8px;
        --za-radius-lg: 16px;
        color: var(--za-text);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        position: fixed;
        z-index: 2147483000;
        top: 20px;
        right: 20px;
      }
      #zhipin-auto-greeting-root * {
        box-sizing: border-box;
      }
      #zhipin-auto-greeting-root [hidden] {
        display: none !important;
      }
      #zhipin-auto-greeting-root * {
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 transparent;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-track {
        background: transparent;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-thumb {
        background: #d5dce6;
        border: 2px solid transparent;
        border-radius: 999px;
        background-clip: content-box;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-thumb:hover {
        background: #b7c2d0;
        border: 2px solid transparent;
        background-clip: content-box;
      }

      /* 浮动开关按钮（收起状态） */
      #zhipin-auto-greeting-root .za-toggle {
        position: fixed;
        right: 0;
        top: 45%;
        width: 38px;
        min-height: 76px;
        border: 1px solid #1e293b;
        border-right: 0;
        border-left: 3px solid var(--za-primary);
        border-radius: 8px 0 0 8px;
        background: #0f172a;
        color: #fbbf24;
        cursor: pointer;
        writing-mode: vertical-rl;
        letter-spacing: 0.1em;
        box-shadow: var(--za-shadow-md);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 8px 0;
        font-size: 12px;
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-toggle-icon {
        font-size: 14px;
        writing-mode: horizontal-tb;
      }
      #zhipin-auto-greeting-root .za-toggle-text {
        writing-mode: vertical-rl;
      }

      /* 主窗口容器 */
      #zhipin-auto-greeting-root .za-window {
        position: fixed;
        right: 20px;
        top: 20px;
        width: 460px;
        height: 600px;
        min-width: 360px;
        min-height: 320px;
        max-width: calc(100vw - 40px);
        max-height: calc(100vh - 40px);
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        transform: translateX(0);
        transition: transform 200ms ease, opacity 200ms ease;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root.za-open .za-window {
        transform: translateX(0);
      }
      #zhipin-auto-greeting-root.za-open .za-toggle {
        display: none;
      }
      #zhipin-auto-greeting-root:not(.za-open) .za-window {
        transform: translateX(120%);
        pointer-events: none;
      }
      #zhipin-auto-greeting-root .za-window-minimized .za-main,
      #zhipin-auto-greeting-root .za-window-minimized .za-footer,
      #zhipin-auto-greeting-root .za-window-minimized .za-resize-handle {
        display: none !important;
      }
      #zhipin-auto-greeting-root .za-window-minimized {
        height: auto !important;
        min-height: 0 !important;
        resize: none;
      }

      /* 标题栏（可拖拽） */
      #zhipin-auto-greeting-root .za-titlebar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 8px 8px 12px;
        background: #0f172a;
        color: #fff;
        cursor: move;
        user-select: none;
        touch-action: none;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      }
      #zhipin-auto-greeting-root .za-title {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-logo {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        background: linear-gradient(135deg, #f59e0b, #d97706);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 2px 6px rgba(217, 119, 6, 0.35);
        font-size: 15px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-title-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-title-text strong {
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.25;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-subtitle {
        margin-top: 2px;
        font-size: 10.5px;
        line-height: 1;
        color: rgba(255, 255, 255, 0.45);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-window-controls {
        display: flex;
        align-items: center;
        gap: 2px;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-tool-group {
        display: inline-flex;
        align-items: center;
        gap: 0;
        margin-right: 4px;
        padding: 1px 3px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.06);
        font-size: 10.5px;
        color: rgba(255, 255, 255, 0.72);
      }
      #zhipin-auto-greeting-root .za-tool-btn {
        width: 19px !important;
        height: 19px !important;
        font-size: 12px !important;
        line-height: 1 !important;
        padding: 0 !important;
        border-radius: 5px !important;
        background: transparent !important;
        border: 0 !important;
        color: rgba(255, 255, 255, 0.75) !important;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-tool-btn:hover {
        background: rgba(255, 255, 255, 0.12) !important;
        color: #fff !important;
      }
      #zhipin-auto-greeting-root .za-opacity-indicator {
        min-width: 30px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-icon-btn {
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: rgba(255, 255, 255, 0.62);
        font-size: 13px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease, color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-icon-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      #zhipin-auto-greeting-root .za-icon-btn:active {
        background: rgba(255, 255, 255, 0.16);
      }

      /* 板块管理浮层 */
      #zhipin-auto-greeting-root .za-feature-panel {
        position: absolute;
        top: 50px;
        right: 10px;
        z-index: 10;
        width: 260px;
        max-height: 70%;
        overflow-y: auto;
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        padding: 12px;
      }
      #zhipin-auto-greeting-root .za-feature-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head .za-icon-btn {
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head .za-icon-btn:hover {
        background: var(--za-bg-soft);
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-feature-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      /* 主体区：左侧导航 + 右侧内容 */
      #zhipin-auto-greeting-root .za-main {
        flex: 1 1 auto;
        display: flex;
        min-height: 0;
        overflow: hidden;
      }

      /* 左侧导航栏 */
      #zhipin-auto-greeting-root .za-sidebar {
        flex: 0 0 auto;
        width: 66px;
        background: #0b1220;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 6px;
        border-right: 1px solid rgba(255, 255, 255, 0.05);
      }
      #zhipin-auto-greeting-root .za-nav-item {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 8px 4px;
        background: transparent;
        border: 0;
        border-radius: 9px;
        color: rgba(255, 255, 255, 0.42);
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;
        font-size: 10.5px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-nav-item:hover {
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.86);
      }
      #zhipin-auto-greeting-root .za-nav-item.za-tab-active {
        background: rgba(217, 119, 6, 0.18);
        color: #fbbf24;
        box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.16);
      }
      #zhipin-auto-greeting-root .za-nav-item.za-tab-active::before {
        content: "";
        position: absolute;
        left: 0;
        top: 28%;
        height: 44%;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: #f59e0b;
      }
      #zhipin-auto-greeting-root .za-nav-icon {
        font-size: 17px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-nav-label {
        font-size: 10px;
        letter-spacing: 0.02em;
      }
      #zhipin-auto-greeting-root .za-nav-badge {
        position: absolute;
        top: 3px;
        right: 5px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-size: 9px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 0 0 2px #0b1220;
      }

      /* 右侧内容区 */
      #zhipin-auto-greeting-root .za-content {
        flex: 1 1 auto;
        min-width: 0;
        overflow-y: auto;
        background: var(--za-bg);
      }
      #zhipin-auto-greeting-root .za-pane {
        display: none;
        flex-direction: column;
        padding-bottom: 6px;
      }
      #zhipin-auto-greeting-root .za-pane-active {
        display: flex;
      }

      /* 状态提示条 */
      #zhipin-auto-greeting-root .za-status {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        margin: 10px 12px 0;
        padding: 7px 10px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 11.5px;
        line-height: 1.45;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-status::before {
        content: "";
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        margin-top: 6px;
        border-radius: 50%;
        background: #94a3b8;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"] {
        background: var(--za-success-soft);
        border-color: #a7f3d0;
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"]::before {
        background: var(--za-success);
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"] {
        background: var(--za-warn-soft);
        border-color: var(--za-primary-border);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"]::before {
        background: var(--za-warn);
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"] {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"]::before {
        background: var(--za-danger);
      }

      /* 配置区块 */
      #zhipin-auto-greeting-root .za-section {
        padding: 12px 12px 2px;
      }
      #zhipin-auto-greeting-root h3 {
        margin: 0 0 9px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.25;
        color: #334155;
        padding-left: 7px;
        border-left: 3px solid var(--za-primary);
        letter-spacing: 0.02em;
      }
      #zhipin-auto-greeting-root label {
        display: block;
        color: var(--za-text);
        margin-bottom: 7px;
        font-size: 11.5px;
      }
      #zhipin-auto-greeting-root .za-check {
        display: flex !important;
        align-items: flex-start;
        gap: 8px;
        margin: 0 0 6px;
        padding: 7px 9px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: var(--za-bg-soft);
        font-size: 11.5px;
        line-height: 1.45;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-check:hover {
        border-color: var(--za-border-strong);
        background: #fff;
      }
      #zhipin-auto-greeting-root .za-check:has(input:checked) {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
      }
      #zhipin-auto-greeting-root .za-check input {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        margin: 1px 0 0;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-label {
        font-weight: 600;
        margin-bottom: 5px;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-hint {
        margin: 3px 0 9px;
        color: var(--za-muted);
        font-size: 10.5px;
        line-height: 1.55;
      }
      #zhipin-auto-greeting-root .za-salary-state {
        margin: 2px 0 6px;
        color: var(--za-muted);
        font-size: 10.5px;
        line-height: 1.5;
      }
      #zhipin-auto-greeting-root .za-salary-state.za-on {
        color: var(--za-primary);
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-salary-state.za-warn {
        color: var(--za-primary);
        font-weight: 600;
      }

      /* 输入控件 */
      #zhipin-auto-greeting-root input[type="text"],
      #zhipin-auto-greeting-root input[type="url"],
      #zhipin-auto-greeting-root input[type="password"],
      #zhipin-auto-greeting-root input[type="number"],
      #zhipin-auto-greeting-root input[type="datetime-local"],
      #zhipin-auto-greeting-root input[type="search"],
      #zhipin-auto-greeting-root select,
      #zhipin-auto-greeting-root textarea {
        width: 100%;
        padding: 6px 9px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        color: var(--za-text);
        font: inherit;
        font-size: 12px;
        line-height: 1.5;
        transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      #zhipin-auto-greeting-root input[type="text"]:hover,
      #zhipin-auto-greeting-root input[type="url"]:hover,
      #zhipin-auto-greeting-root input[type="number"]:hover,
      #zhipin-auto-greeting-root input[type="datetime-local"]:hover,
      #zhipin-auto-greeting-root input[type="search"]:hover,
      #zhipin-auto-greeting-root select:hover,
      #zhipin-auto-greeting-root textarea:hover {
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root input:focus,
      #zhipin-auto-greeting-root select:focus,
      #zhipin-auto-greeting-root textarea:focus {
        outline: 0;
        border-color: var(--za-primary);
        background: #fff;
        box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.14);
      }
      #zhipin-auto-greeting-root textarea {
        resize: vertical;
        min-height: 84px;
        padding: 8px 9px;
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.65;
      }
      #zhipin-auto-greeting-root input[type="checkbox"],
      #zhipin-auto-greeting-root input[type="radio"] {
        accent-color: var(--za-primary);
        cursor: pointer;
      }

      /* 按钮样式 */
      #zhipin-auto-greeting-root button {
        min-height: 30px;
        padding: 0 12px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        color: var(--za-text);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease;
      }
      #zhipin-auto-greeting-root button:hover {
        background: var(--za-bg-soft);
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root button:active {
        transform: translateY(1px);
      }
      #zhipin-auto-greeting-root button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      #zhipin-auto-greeting-root button.za-primary {
        background: var(--za-primary);
        border-color: var(--za-primary);
        color: #fff;
      }
      #zhipin-auto-greeting-root button.za-primary:hover {
        background: var(--za-primary-deep);
        border-color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root button.za-danger {
        background: var(--za-bg);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root button.za-danger:hover:not(:disabled) {
        background: var(--za-danger-soft);
        border-color: #fca5a5;
      }
      #zhipin-auto-greeting-root button.za-danger-soft {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root button.za-danger-soft:hover {
        background: #fee2e2;
      }

      /* 行内布局 */
      #zhipin-auto-greeting-root .za-inline {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      #zhipin-auto-greeting-root .za-inline > input,
      #zhipin-auto-greeting-root .za-inline > select {
        flex: 1 1 auto;
        min-width: 80px;
      }
      #zhipin-auto-greeting-root .za-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-grid-2 label {
        margin-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-radio-row,
      #zhipin-auto-greeting-root .za-segment {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-radio-row label,
      #zhipin-auto-greeting-root .za-segment label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 6px 11px;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        background: var(--za-bg);
        font-size: 11.5px;
        cursor: pointer;
        transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-radio-row label:hover,
      #zhipin-auto-greeting-root .za-segment label:hover {
        border-color: var(--za-border-strong);
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-radio-row label:has(input:checked),
      #zhipin-auto-greeting-root .za-segment label:has(input:checked) {
        border-color: var(--za-primary);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        font-weight: 600;
        box-shadow: 0 0 0 2px rgba(217, 119, 6, 0.1);
      }
      #zhipin-auto-greeting-root .za-radio-row input,
      #zhipin-auto-greeting-root .za-segment input {
        margin: 0;
      }

      /* 常用语选择器 */
      #zhipin-auto-greeting-root .za-mode-block {
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-control {
        display: flex;
        gap: 6px;
        margin-bottom: 6px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger {
        flex: 1 1 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview {
        padding: 8px 10px;
        background: var(--za-bg-soft);
        border-radius: var(--za-radius-sm);
        font-size: 12px;
        color: var(--za-text);
        min-height: 32px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.4);
        z-index: 2147483100;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #zhipin-auto-greeting-root .za-fast-reply-dialog {
        width: 380px;
        max-width: calc(100vw - 40px);
        max-height: 60vh;
        background: var(--za-bg);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root .za-fast-reply-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-search {
        display: flex;
        gap: 6px;
        padding: 8px 14px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-list {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 6px 0;
      }

      /* 多选下拉 */
      #zhipin-auto-greeting-root .za-multi-dropdown {
        position: relative;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-multi-trigger {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-multi-menu {
        position: absolute;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        max-height: 200px;
        overflow-y: auto;
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        box-shadow: var(--za-shadow-md);
        z-index: 5;
      }

      /* 已沟通列表 */
      #zhipin-auto-greeting-root .za-list-section {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 200px;
      }
      #zhipin-auto-greeting-root .za-list-viewport {
        flex: 1 1 auto;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        position: relative;
        max-height: 280px;
      }

      /* 已沟通列表：固定可视高度，避免 flex 收缩成空白块 */
      #zhipin-auto-greeting-root .za-list-viewport {
        height: 260px;
      }
      #zhipin-auto-greeting-root .za-list-spacer {
        width: 1px;
      }
      #zhipin-auto-greeting-root .za-list-items {
        position: absolute;
        inset: 0 0 auto 0;
      }
      #zhipin-auto-greeting-root .za-list-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 48px;
        padding: 6px 10px;
        border-bottom: 1px solid #eef2f6;
        overflow: hidden;
        cursor: default;
        transition: background 0.15s;
      }
      #zhipin-auto-greeting-root .za-list-row:hover {
        background: #f0f5ff;
      }
      #zhipin-auto-greeting-root .za-list-row-main {
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1.4;
      }
      #zhipin-auto-greeting-root .za-list-row-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 500;
        color: #1a1a1a;
      }
      #zhipin-auto-greeting-root .za-list-row-salary {
        flex: 0 0 auto;
        font-size: 12px;
        color: #ff6633;
        font-weight: 500;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-row-sub {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        line-height: 1.4;
        margin-top: 2px;
      }
      #zhipin-auto-greeting-root .za-list-row-company {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-list-row-meta {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--za-muted);
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-status {
        display: inline-block;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 16px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-list-status-sent {
        background: #e6f7e6;
        color: #389e0d;
      }
      #zhipin-auto-greeting-root .za-list-status-skipped {
        background: #fff7e6;
        color: #d48806;
      }
      #zhipin-auto-greeting-root .za-list-row-time {
        color: #bfbfbf;
      }
      /* 已沟通列表：空状态与标题计数（新版样式自带，旧样式块未注入） */
      #zhipin-auto-greeting-root .za-list-section h3 {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-list-count {
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid var(--za-border);
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        line-height: 16px;
      }
      #zhipin-auto-greeting-root .za-list-refresh {
        margin-left: auto;
        padding: 2px 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-list-refresh:hover {
        color: var(--za-primary);
        border-color: var(--za-primary-border);
      }
      #zhipin-auto-greeting-root .za-list-empty { padding: 32px 8px; color: var(--za-muted); text-align: center; font-size: 12px; }
      #zhipin-auto-greeting-root .za-list-empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
      #zhipin-auto-greeting-root .za-list-empty-hint { font-size: 11px; color: #bfbfbf; margin-top: 4px; }


      /* 底部操作栏 */
      #zhipin-auto-greeting-root .za-footer {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid var(--za-border);
        background: var(--za-bg);
        box-shadow: 0 -2px 8px rgba(15, 23, 42, 0.03);
      }
      #zhipin-auto-greeting-root .za-footer button {
        flex: 1 1 0;
        min-height: 34px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-footer button.za-primary {
        box-shadow: 0 1px 2px rgba(180, 83, 9, 0.25);
      }
      #zhipin-auto-greeting-root .za-footer button.za-danger {
        background: var(--za-bg);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-footer button.za-danger:hover:not(:disabled) {
        background: var(--za-danger-soft);
        border-color: #fca5a5;
      }

      /* 调整大小手柄 */
      #zhipin-auto-greeting-root .za-resize-handle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        background: linear-gradient(135deg, transparent 0%, transparent 50%, var(--za-border) 50%, var(--za-border) 60%, transparent 60%, transparent 70%, var(--za-border) 70%, var(--za-border) 80%, transparent 80%);
        z-index: 10;
      }
      #zhipin-auto-greeting-root .za-resize-handle:hover {
        background: linear-gradient(135deg, transparent 0%, transparent 50%, var(--za-primary) 50%, var(--za-primary) 60%, transparent 60%, transparent 70%, var(--za-primary) 70%, var(--za-primary) 80%, transparent 80%);
      }

      /* 评分结果 */
      #zhipin-auto-greeting-root .za-score-result {
        margin-top: 8px;
      }

      /* 选项 chips */
      #zhipin-auto-greeting-root .za-option-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-selected-area {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }

      /* ---------- 日志页（面板内） ---------- */
      #zhipin-auto-greeting-root .za-log-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        background: var(--za-bg);
        margin-bottom: 10px;
        box-shadow: var(--za-shadow-sm);
      }
      #zhipin-auto-greeting-root .za-log-summary-main {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-summary-text {
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #98a2b3;
        box-shadow: 0 0 0 3px rgba(152, 162, 179, 0.18);
        transition: background 150ms ease, box-shadow 150ms ease;
      }
      #zhipin-auto-greeting-root .za-log-dot[data-on="1"] {
        background: #12b76a;
        box-shadow: 0 0 0 3px rgba(18, 183, 106, 0.18);
      }
      #zhipin-auto-greeting-root .za-log-state {
        font-size: 12px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-log-meta {
        margin-top: 1px;
        font-size: 11px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-switch {
        display: flex !important;
        align-items: center;
        gap: 6px;
        margin: 0;
        cursor: pointer;
        user-select: none;
        flex: 0 0 auto;
      }
      #zhipin-auto-greeting-root .za-switch input {
        position: absolute;
        width: 1px;
        height: 1px;
        min-height: 0;
        margin: 0;
        padding: 0;
        border: 0;
        opacity: 0;
        pointer-events: none;
      }
      #zhipin-auto-greeting-root .za-switch-track {
        position: relative;
        flex: 0 0 auto;
        width: 34px;
        height: 20px;
        border-radius: 999px;
        background: #d7dde7;
        transition: background 150ms ease;
      }
      #zhipin-auto-greeting-root .za-switch-track::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
        transition: transform 150ms ease;
      }
      #zhipin-auto-greeting-root .za-switch input:checked + .za-switch-track {
        background: var(--za-primary);
      }
      #zhipin-auto-greeting-root .za-switch input:checked + .za-switch-track::after {
        transform: translateX(14px);
      }
      #zhipin-auto-greeting-root .za-switch input:focus-visible + .za-switch-track {
        outline: 2px solid rgba(217, 119, 6, 0.45);
        outline-offset: 2px;
      }
      #zhipin-auto-greeting-root .za-switch-label {
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-log-actions {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-log-actions button {
        flex: 1 1 0;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-feedback {
        margin: 0 0 8px;
        padding: 6px 10px;
        border: 1px solid var(--za-primary-border);
        border-radius: 6px;
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        font-size: 11px;
        line-height: 1.5;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="ok"] {
        background: var(--za-success-soft);
        border-color: #6ee7a8;
        color: var(--za-success);
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="warn"] {
        background: var(--za-warn-soft);
        border-color: var(--za-primary-border);
        color: var(--za-warn);
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="error"] {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-log-preview {
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        overflow: hidden;
        margin-bottom: 8px;
        background: #fff;
      }
      #zhipin-auto-greeting-root .za-log-preview-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 12px;
        background: var(--za-bg-deep);
        border-bottom: 1px solid var(--za-border);
        font-size: 11px;
        font-weight: 600;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-log-preview-count {
        min-width: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--za-border-strong);
        color: var(--za-muted);
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-log-preview-tools {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-log-format {
        min-height: 20px;
        height: 20px;
        padding: 0 8px;
        border: 1px solid var(--za-border-strong);
        border-radius: 999px;
        background: var(--za-bg);
        color: var(--za-muted);
        font-size: 10px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition: background 150ms ease, border-color 150ms ease;
      }
      #zhipin-auto-greeting-root .za-log-format:hover {
        background: var(--za-bg-soft);
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root .za-log-preview-body {
        max-height: 260px;
        overflow-y: auto;
        padding: 8px 10px;
        background: #0c1222;
        color: #94a3b8;
        font: 11px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.12) transparent;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar {
        width: 4px;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar-track {
        background: transparent;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 999px;
      }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-line {
        padding: 1px 0;
        word-break: break-all;
        white-space: pre-wrap;
      }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-success { color: #4ade80; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-skip { color: #facc15; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-error { color: #f87171; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-warn { color: #fb923c; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-info { color: #7dd3fc; }
      #zhipin-auto-greeting-root .za-log-empty {
        padding: 14px 4px;
        color: #475569;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 11px;
      }

      /* ---------- 确认弹窗 ----------
         弹窗挂在 document.body 上（不在 #zhipin-auto-greeting-root 内），
         因此这里必须使用全局选择器，不能加面板根节点前缀。 */
      .za-confirm-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483600;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.55);
        -webkit-backdrop-filter: blur(2px);
        backdrop-filter: blur(2px);
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2937;
        text-align: left;
        animation: za-confirm-fadein 0.18s ease-out;
      }
      .za-confirm-backdrop *,
      .za-confirm-backdrop *::before,
      .za-confirm-backdrop *::after {
        box-sizing: border-box;
      }
      .za-confirm-backdrop.za-confirm-fadeout {
        animation: za-confirm-fadeout 0.16s ease-in forwards;
      }
      @keyframes za-confirm-fadein {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes za-confirm-fadeout {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      @keyframes za-confirm-slidein {
        from { opacity: 0; transform: translateY(10px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .za-confirm-dialog {
        width: min(420px, 100%);
        max-height: calc(100vh - 48px);
        overflow-y: auto;
        margin: 0;
        padding: 28px 28px 22px;
        border: none;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15, 23, 42, 0.06);
        text-align: center;
        animation: za-confirm-slidein 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .za-confirm-icon-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        margin: 0 auto 16px;
        border-radius: 50%;
        background: #fef2f2;
        color: #dc2626;
        box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.12);
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-icon-wrap {
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        box-shadow: inset 0 0 0 1px rgba(217, 119, 6, 0.14);
      }
      .za-confirm-icon {
        width: 26px;
        height: 26px;
        flex: 0 0 auto;
      }
      .za-confirm-backdrop .za-confirm-title {
        margin: 0 0 8px;
        padding: 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.4;
        color: #111827;
        letter-spacing: 0.01em;
      }
      .za-confirm-backdrop .za-confirm-message {
        margin: 0;
        padding: 0;
        font-size: 13.5px;
        line-height: 1.65;
        color: #4b5563;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .za-confirm-backdrop .za-confirm-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        width: 100%;
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid #eef0f4;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel,
      .za-confirm-backdrop .za-confirm-btn-danger {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        min-width: 0;
        height: 40px;
        margin: 0;
        padding: 0 16px;
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel {
        border: 1px solid #d7dde7;
        background: #fff;
        color: #374151;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:hover {
        background: #f5f7fa;
        border-color: #bfc8d6;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:active {
        background: #eef1f6;
      }
      .za-confirm-backdrop .za-confirm-btn-danger {
        border: 1px solid #dc2626;
        background: #dc2626;
        color: #fff;
      }
      .za-confirm-backdrop .za-confirm-btn-danger:hover {
        background: #b91c1c;
        border-color: #b91c1c;
      }
      .za-confirm-backdrop .za-confirm-btn-danger:active {
        transform: translateY(1px);
        background: #991b1b;
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-btn-danger {
        border-color: var(--za-primary);
        background: var(--za-primary);
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-btn-danger:hover {
        border-color: var(--za-primary-deep);
        background: var(--za-primary-deep);
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:focus-visible,
      .za-confirm-backdrop .za-confirm-btn-danger:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.35);
      }
      @media (max-width: 480px) {
        .za-confirm-backdrop {
          padding: 16px;
        }
        .za-confirm-dialog {
          padding: 22px 18px 18px;
          border-radius: 14px;
        }
        .za-confirm-backdrop .za-confirm-actions {
          grid-template-columns: 1fr;
          gap: 8px;
        }
      }

      /* 数据页：统计卡与 7 日趋势 */
      #zhipin-auto-greeting-root .za-stat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-stat-card {
        padding: 9px 11px;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-stat-label {
        display: block;
        font-size: 10.5px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-stat-value {
        display: block;
        margin-top: 2px;
        font-size: 20px;
        font-weight: 700;
        line-height: 1.15;
        color: var(--za-text);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-stat-value.za-stat-accent {
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-trend {
        display: flex;
        align-items: flex-end;
        gap: 5px;
        height: 64px;
        margin: 10px 0 2px;
        padding: 0 2px;
      }
      #zhipin-auto-greeting-root .za-trend-item {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      #zhipin-auto-greeting-root .za-trend-count {
        font-size: 9.5px;
        font-weight: 600;
        line-height: 1;
        color: var(--za-muted);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-trend-bar-wrap {
        width: 100%;
        height: 44px;
        display: flex;
        align-items: flex-end;
      }
      #zhipin-auto-greeting-root .za-trend-bar {
        width: 100%;
        min-height: 3px;
        border-radius: 4px 4px 2px 2px;
        background: linear-gradient(180deg, #f59e0b, #d97706);
      }
      #zhipin-auto-greeting-root .za-trend-bar[data-zero="1"] {
        background: var(--za-bg-deep);
      }
      #zhipin-auto-greeting-root .za-trend-day {
        font-size: 9px;
        line-height: 1;
        color: var(--za-muted);
        white-space: nowrap;
      }

      /* 数据页：最近记录 */
      #zhipin-auto-greeting-root .za-data-filters {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-data-filters input[type="search"] {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-data-filters select {
        flex: 0 0 104px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-record-list {
        max-height: 252px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg);
      }
      #zhipin-auto-greeting-root .za-record-row {
        padding: 8px 10px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-record-row:last-child {
        border-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-record-main {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-record-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-record-chip {
        flex: 0 0 auto;
        padding: 0 6px;
        border: 1px solid var(--za-border);
        border-radius: 999px;
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 9.5px;
        line-height: 1.7;
      }
      #zhipin-auto-greeting-root .za-record-chip-sent {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-record-chip-click {
        border-color: #a7f3d0;
        background: var(--za-success-soft);
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-record-chip-skip {
        border-color: var(--za-border);
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-record-meta {
        display: flex;
        gap: 8px;
        margin-top: 3px;
        font-size: 10px;
        color: var(--za-muted);
        white-space: nowrap;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root .za-record-meta span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-record-empty {
        padding: 20px 10px;
        text-align: center;
        font-size: 11px;
        color: var(--za-muted);
      }

      /* 日志页：本次运行摘要 */
      #zhipin-auto-greeting-root .za-run-summary {
        padding: 10px 11px;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-run-summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-run-summary-title {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-run-summary-state {
        flex: 0 0 auto;
        padding: 1px 7px;
        border: 1px solid transparent;
        border-radius: 999px;
        background: var(--za-bg-deep);
        color: var(--za-muted);
        font-size: 9.5px;
        line-height: 1.7;
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="running"] {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="done"] {
        border-color: #a7f3d0;
        background: var(--za-success-soft);
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="stopped"] {
        border-color: #fecaca;
        background: var(--za-danger-soft);
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-run-summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 9px;
      }
      #zhipin-auto-greeting-root .za-run-summary-grid > div {
        padding: 6px 4px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-run-summary-grid span {
        display: block;
        font-size: 9.5px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-run-summary-grid strong {
        display: block;
        margin-top: 2px;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.2;
        color: var(--za-text);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-run-summary-reason {
        margin: 8px 0 0;
        font-size: 10px;
        line-height: 1.5;
        color: var(--za-muted);
      }

      /* 日志页：筛选条 */
      #zhipin-auto-greeting-root .za-log-filters {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-log-filters select {
        flex: 0 0 92px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-filters input[type="search"] {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-autoscroll {
        display: inline-flex !important;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
        margin: 0;
        font-size: 10px;
        color: var(--za-muted);
        white-space: nowrap;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-log-autoscroll input {
        width: 12px;
        height: 12px;
        margin: 0;
      }

    `;
    document.documentElement.appendChild(style);
  }

  // 注入侧栏样式；全部限定在 #zhipin-auto-greeting-root 下，避免影响 BOSS 页面。
  function injectStyle() {
    if (document.getElementById('zhipin-auto-greeting-style')) return;

    const style = document.createElement('style');
    style.id = 'zhipin-auto-greeting-style';
    style.textContent = `
      #zhipin-auto-greeting-root {
        --za-width: 430px;
        --za-bg: #ffffff;
        --za-border: #d7dde7;
        --za-text: #1f2937;
        --za-muted: #667085;
        --za-primary: #00a6a7;
        --za-danger: #d92d20;
        color: var(--za-text);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        position: fixed;
        z-index: 2147483000;
        inset: 0 0 auto auto;
      }
      #zhipin-auto-greeting-root * {
        box-sizing: border-box;
      }
      #zhipin-auto-greeting-root [hidden] {
        display: none !important;
      }
      #zhipin-auto-greeting-root .za-toggle {
        position: fixed;
        right: 0;
        top: 45%;
        width: 42px;
        min-height: 88px;
        border: 1px solid var(--za-border);
        border-right: 0;
        border-radius: 8px 0 0 8px;
        background: var(--za-primary);
        color: #fff;
        cursor: pointer;
        writing-mode: vertical-rl;
        letter-spacing: 0;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
      }
      #zhipin-auto-greeting-root .za-panel {
        position: fixed;
        right: 0;
        top: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        background: var(--za-bg);
        border-left: 1px solid var(--za-border);
        box-shadow: -12px 0 28px rgba(15, 23, 42, 0.16);
        transform: translateX(100%);
        transition: transform 180ms ease;
        display: flex;
        flex-direction: column;
      }
      #zhipin-auto-greeting-root.za-open .za-panel {
        transform: translateX(0);
      }
      #zhipin-auto-greeting-root.za-open .za-toggle {
        display: none;
      }
      #zhipin-auto-greeting-root .za-header,
      #zhipin-auto-greeting-root .za-footer {
        flex: 0 0 auto;
        padding: 12px 14px;
        border-bottom: 1px solid var(--za-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      #zhipin-auto-greeting-root .za-header {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--za-bg);
        box-shadow: 0 1px 0 rgba(215, 221, 231, 0.85);
        cursor: move;
        user-select: none;
      }
      #zhipin-auto-greeting-root .za-header-title {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-header-title strong,
      #zhipin-auto-greeting-root .za-header-title span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-header-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-tool-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #f7f8fa;
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-tool-btn {
        width: 22px !important;
        height: 22px !important;
        font-size: 14px !important;
        line-height: 1 !important;
        padding: 0 !important;
        border-radius: 4px !important;
      }
      #zhipin-auto-greeting-root .za-opacity-indicator {
        min-width: 34px;
        text-align: center;
        color: var(--za-muted);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-tabs {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
        padding: 10px 14px 0;
        border-bottom: 1px solid var(--za-border);
        background: var(--za-bg);
        z-index: 2;
      }
      #zhipin-auto-greeting-root .za-tab {
        flex: 1 1 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 10px;
        background: transparent;
        border: 1px solid transparent;
        border-bottom-width: 2px;
        border-bottom-color: transparent;
        border-radius: 6px 6px 0 0;
        color: var(--za-muted);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 120ms ease;
      }
      #zhipin-auto-greeting-root .za-tab:hover {
        background: #f5f7fa;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-tab-active {
        color: var(--za-primary);
        border-bottom-color: var(--za-primary);
        background: #ecfeff;
      }
      #zhipin-auto-greeting-root .za-tab-icon {
        font-size: 15px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-tab-content {
        display: none;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }
      #zhipin-auto-greeting-root .za-tab-content-active {
        display: block;
        display: flex;
        flex-direction: column;
      }
      #zhipin-auto-greeting-root .za-footer {
        border-top: 1px solid var(--za-border);
        border-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-subtitle {
        display: block;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 86px;
        padding: 0 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel {
        position: fixed;
        top: 58px;
        right: 14px;
        z-index: 4;
        width: calc(var(--za-width) - 28px);
        max-width: calc(100vw - 52px);
        padding: 10px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel-close {
        width: 26px;
        min-height: 26px;
        padding: 0;
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-switch {
        width: 100%;
        min-width: 0;
        height: auto;
        min-height: 38px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-feature-switch > span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled {
        border-color: #b7e4e5;
        background: #ecfeff;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-readonly {
        border-style: dashed;
      }
      #zhipin-auto-greeting-root .za-feature-state {
        flex: 0 0 auto;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled .za-feature-state {
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-status {
        flex: 0 0 auto;
        position: sticky;
        top: 73px;
        z-index: 2;
        margin: 12px 14px 0;
        padding: 9px 10px;
        border: 1px solid #d7dde7;
        border-radius: 6px;
        background: #eef2f6;
        box-shadow: 0 0 0 14px var(--za-bg), 0 10px 18px rgba(15, 23, 42, 0.08);
        color: #344054;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"] {
        background: #ecfdf3;
        border-color: #abefc6;
        color: #027a48;
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"] {
        background: #fffaeb;
        border-color: #fedf89;
        color: #b54708;
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"] {
        background: #fef3f2;
        border-color: #fecdca;
        color: #b42318;
      }
      #zhipin-auto-greeting-root .za-section {
        padding: 12px 14px 0;
      }
      #zhipin-auto-greeting-root .za-status + .za-section {
        padding-top: 20px;
      }
      #zhipin-auto-greeting-root .za-panel {
        overflow-y: auto;
      }
      #zhipin-auto-greeting-root h3 {
        margin: 0 0 8px;
        font-size: 13px;
        font-weight: 700;
      }
      #zhipin-auto-greeting-root label {
        display: block;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root input,
      #zhipin-auto-greeting-root select,
      #zhipin-auto-greeting-root textarea {
        width: 100%;
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 6px 8px;
        background: #fff;
        color: var(--za-text);
        font: inherit;
      }
      #zhipin-auto-greeting-root textarea {
        resize: vertical;
        min-height: 76px;
      }
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus,
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus-visible,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus-visible {
        outline: none;
        box-shadow: none;
        border-color: var(--za-border);
      }
      #zhipin-auto-greeting-root button {
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 0 10px;
        background: #fff;
        color: var(--za-text);
        cursor: pointer;
        font: inherit;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #zhipin-auto-greeting-root input:disabled,
      #zhipin-auto-greeting-root select:disabled,
      #zhipin-auto-greeting-root textarea:disabled {
        cursor: not-allowed;
        opacity: 0.72;
        background: #f3f4f6;
      }
      #zhipin-auto-greeting-root .za-primary {
        background: var(--za-primary);
        border-color: var(--za-primary);
        color: #fff;
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-danger {
        background: #fff;
        border-color: #fecdca;
        color: var(--za-danger);
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-default {
        background: #fff;
        border-color: #d0d5dd;
        color: #475467;
        flex: 0 0 auto;
        padding: 6px 10px;
      }
      #zhipin-auto-greeting-root .za-danger-soft {
        border-color: #fecdca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-cleanup-time {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-radio-row,
      #zhipin-auto-greeting-root .za-inline {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-segment {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 10px;
        padding: 3px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-segment label {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-segment label:has(input:checked) {
        background: #fff;
        border: 1px solid #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-source-block {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel {
        display: grid;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel label {
        margin: 0;
      }
      #zhipin-auto-greeting-root .za-api-panel textarea {
        min-height: 68px;
      }
      #zhipin-auto-greeting-root .za-api-endpoint {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 92px;
        gap: 8px;
        align-items: end;
      }
      #zhipin-auto-greeting-root .za-api-method {
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-fast-reply-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger {
        width: 100%;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-fast-reply-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root.za-fast-reply-open .za-fast-reply-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview {
        max-height: 118px;
        margin-bottom: 8px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 8px;
        background: #fbfcfd;
        color: #344054;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview[data-empty="true"] {
        color: var(--za-muted);
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-backdrop {
        position: fixed;
        z-index: 2147483002;
        top: 0;
        right: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 82px 14px 14px;
        background: rgba(15, 23, 42, 0.18);
      }
      #zhipin-auto-greeting-root .za-fast-reply-dialog {
        width: 100%;
        max-height: calc(100vh - 104px);
        min-height: 240px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head strong,
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        display: block;
      }
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-search {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #eef2f6;
      }
      #zhipin-auto-greeting-root .za-fast-reply-list {
        flex: 1 1 auto;
        min-height: 0;
        max-height: min(68vh, 520px);
        overflow-y: auto;
        padding: 6px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option {
        width: 100%;
        height: auto;
        min-height: 0;
        display: block;
        margin: 0 0 6px;
        padding: 8px 10px;
        border-color: transparent;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option:hover {
        border-color: #e4e7ec;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option.za-selected {
        border-color: #b7e4e5;
        background: #ecfeff;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-selected-mark {
        flex: 0 0 auto;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-text {
        display: block;
        color: var(--za-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-empty {
        padding: 22px 10px;
        color: var(--za-muted);
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-selected-area {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 34px;
        margin-bottom: 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 5px;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-multi-dropdown {
        position: relative;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-multi-trigger {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-multi-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-multi-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-multi-dropdown.za-open .za-multi-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-multi-menu {
        position: absolute;
        z-index: 2;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 4px;
        background: #fff;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      }
      #zhipin-auto-greeting-root .za-multi-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        padding: 4px 6px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-multi-option:hover {
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-multi-option span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-blacklist-option {
        justify-content: space-between;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-blacklist-option-label {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete {
        flex: 0 0 24px;
        width: 24px;
        min-height: 24px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete:hover {
        color: #b91c1c;
        background: #fee2e2;
      }
      #zhipin-auto-greeting-root .za-boss-active-add {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-blacklist-actions {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-option-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 24px;
        margin: 2px 0 4px;
      }
      #zhipin-auto-greeting-root .za-selected-chip,
      #zhipin-auto-greeting-root .za-option-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        min-height: 24px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 2px 3px 2px 8px;
        background: #f8fafc;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-selected-chip {
        background: #ecfeff;
        border-color: #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-selected-chip > span,
      #zhipin-auto-greeting-root .za-option-chip > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-selected-chip button,
      #zhipin-auto-greeting-root .za-option-chip button {
        width: 22px;
        min-height: 22px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-empty-text {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-radio-row label,
      #zhipin-auto-greeting-root .za-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root input[type="checkbox"],
      #zhipin-auto-greeting-root input[type="radio"] {
        width: 16px;
        min-height: 16px;
      }
      #zhipin-auto-greeting-root .za-inline > * {
        flex: 1 1 auto;
      }
      #zhipin-auto-greeting-root .za-inline > button {
        flex: 0 0 auto;
      }
      #zhipin-auto-greeting-root .za-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-label,
      #zhipin-auto-greeting-root .za-hint {
        color: var(--za-muted);
        font-size: 12px;
        margin: 6px 0;
      }
      #zhipin-auto-greeting-root .za-muted-text {
        color: var(--za-muted);
        font-size: 12px;
        line-height: 30px;
      }
      #zhipin-auto-greeting-root .za-list-section {
        padding-bottom: 24px;
      }
      #zhipin-auto-greeting-root .za-list-viewport {
        position: relative;
        height: 260px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        overflow-y: auto;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-list-spacer {
        width: 1px;
      }
      #zhipin-auto-greeting-root .za-list-items {
        position: absolute;
        inset: 0 0 auto 0;
      }
      #zhipin-auto-greeting-root .za-list-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 48px;
        padding: 6px 10px;
        border-bottom: 1px solid #eef2f6;
        overflow: hidden;
        cursor: default;
        transition: background 0.15s;
      }
      #zhipin-auto-greeting-root .za-list-row:hover {
        background: #f0f5ff;
      }
      #zhipin-auto-greeting-root .za-list-row-main {
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1.4;
      }
      #zhipin-auto-greeting-root .za-list-row-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 500;
        color: #1a1a1a;
      }
      #zhipin-auto-greeting-root .za-list-row-salary {
        flex: 0 0 auto;
        font-size: 12px;
        color: #ff6633;
        font-weight: 500;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-row-sub {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        line-height: 1.4;
        margin-top: 2px;
      }
      #zhipin-auto-greeting-root .za-list-row-company {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-list-row-meta {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--za-muted);
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-status {
        display: inline-block;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 16px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-list-status-sent {
        background: #e6f7e6;
        color: #389e0d;
      }
      #zhipin-auto-greeting-root .za-list-status-skipped {
        background: #fff7e6;
        color: #d48806;
      }
      #zhipin-auto-greeting-root .za-list-row-time {
        color: #bfbfbf;
      }
      /* 确认弹窗样式统一在 injectNewStyle 中定义（弹窗挂在 body 上，需全局选择器）。 */
      /* 评分筛选：BOSS 岗位卡片高亮与分数徽标（页面级，不带面板前缀） */
      .za-scored {
        position: relative;
      }
      .za-score-good {
        outline: 2px solid var(--za-success);
        outline-offset: -2px;
      }
      .za-score-mid {
        outline: 2px solid var(--za-warn);
        outline-offset: -2px;
      }
      .za-score-low {
        outline: 2px solid var(--za-danger);
        outline-offset: -2px;
      }
      .za-score-badge {
        position: absolute;
        top: 4px;
        right: 4px;
        z-index: 999;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        border-radius: 11px;
        background: linear-gradient(135deg, #059669, #047857);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 22px;
        text-align: center;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(5, 150, 105, 0.35);
      }
      .za-score-badge[data-grade="mid"] {
        background: linear-gradient(135deg, #d97706, #b45309);
        box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35);
      }
      .za-score-badge[data-grade="low"] {
        background: linear-gradient(135deg, #dc2626, #b91c1c);
        box-shadow: 0 2px 6px rgba(220, 38, 38, 0.35);
      }
      /* 评分筛选：面板内最近评分结果列表 */
      #zhipin-auto-greeting-root .za-score-result {
        max-height: 180px;
        overflow-y: auto;
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-score-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        border-bottom: 1px dashed var(--za-border);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-score-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-score-grade {
        flex: 0 0 auto;
        font-size: 11px;
        padding: 0 4px;
        border-radius: 3px;
      }
      #zhipin-auto-greeting-root .za-score-grade-good {
        color: #16a34a;
        background: #ecfdf5;
      }
      #zhipin-auto-greeting-root .za-score-grade-mid {
        color: #b45309;
        background: #fffbeb;
      }
      #zhipin-auto-greeting-root .za-score-grade-low {
        color: #b91c1c;
        background: #fef2f2;
      }
      #zhipin-auto-greeting-root .za-score-value {
        flex: 0 0 auto;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-score-model {
        flex: 0 0 auto;
        color: var(--za-muted);
        font-size: 11px;
      }
      /* 日志行样式：日志页预览沿用同一份行结构 */
      .za-log-line {
        padding: 1px 0;
        word-break: break-all;
        white-space: pre-wrap;
        color: #9fb0c4;
      }
      .za-log-warn {
        color: #ffb84d;
      }
      .za-log-success { color: #8be28b; }
      .za-log-skip { color: #d6c27a; }
      .za-log-error { color: #ff8585; }
      #zhipin-auto-greeting-root .za-list-section h3 {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-list-count {
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid var(--za-border);
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        line-height: 16px;
      }
      #zhipin-auto-greeting-root .za-list-refresh {
        margin-left: auto;
        padding: 2px 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-list-refresh:hover {
        color: var(--za-primary);
        border-color: var(--za-primary-border);
      }
      #zhipin-auto-greeting-root .za-list-empty { padding: 32px 8px; color: var(--za-muted); text-align: center; font-size: 12px; }
      #zhipin-auto-greeting-root .za-list-empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
      #zhipin-auto-greeting-root .za-list-empty-hint { font-size: 11px; color: #bfbfbf; margin-top: 4px; }
    `;

    document.documentElement.appendChild(style);
  }

  installAllowedPageRouteWatcher();

  // 所有模块都完成初始化后再挂载 UI，避免 document-start 下 body 已存在时触发 const TDZ。
  setTimeout(syncAllowedPageUi, 0);

  pageWindow.addEventListener('pageshow', () => {
    const wasMounted = Boolean(runtime.ui);
    const allowed = syncAllowedPageUi();
    // 恢复流程内部会按页面阶段等待对应 DOM，无需在 pageshow 后再盲等固定时间。
    if (wasMounted && allowed && isAllowedDisplayPage()) Automation.resumeIfNeeded('pageshow');
  });
})();