  const APP = {
    name: '全平台自动投递助手',
    version: '0.4.0',
    dbName: 'MultiPlatformJobDB',
    dbVersion: 2,
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
    // 每日投递配额计数：{ date: 'YYYY-MM-DD', count: n }，跨运行累计、换天自动重置。
    dailyQuotaKey: '__multi_platform_job_daily_quota__',
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
    // 面板显隐判断：默认与"允许显示页面"一致，子类可覆盖以在特定页面隐藏面板。
    // 与 isAllowedDisplayPage 分开，是因为有些页面（如 BOSS 消息界面）脚本仍需运行，只是不显示面板。
    isPanelDisplayPage(url) { return this.isAllowedDisplayPage(url); }

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

    // 消息界面（/web/geek/chat）不显示助手面板：脚本仍在后台跑完发消息与返回列表，
    // 只是不再在右侧挂"BOSS直聘助手"标签；回到岗位列表页自动恢复显示。
    isPanelDisplayPage(url) {
      try {
        const u = new URL(url || location.href, location.href);
        if (u.origin !== 'https://www.zhipin.com') return false;
        if (this.isChatPage(u.href)) return false;
        return this.isAllowedDisplayPage(u.href);
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
    blockedCities: '', // 禁止城市列表：留空=不启用；命中任一城市直接跳过，优先级高于允许列表。
    // 薪资筛选：按岗位薪资区间与所填月薪区间取交集，不重叠才跳过；薪资不明时保留。
    salaryFilterEnabled: false,
    salaryMinK: 0,
    salaryMaxK: 0,
    // 匹配方式：contain=岗位区间需完全落在设定范围内；overlap=有重叠即保留。
    salaryMatchMode: 'contain',
    waitTimeout: 5,
    chatOpenRetries: 2,
    maxCount: 0,
    // 每日投递配额：0=不限制；达到后当天停止自动投递（跨运行生效，次日自动重置）。
    dailySendLimit: 0,
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
