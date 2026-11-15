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
    // 连续岗位处理失败计数：达到阈值后在等待环节叠加指数退避，成功一次即清零。
    consecutiveFailures: 0,
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
