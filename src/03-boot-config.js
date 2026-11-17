  function bootWhenReady() {
    // 检测当前平台
    if (!currentPlatform) {
      currentPlatform = platformRegistry.detect(location.href);
      if (currentPlatform) {
        console.log(`[MultiPlatform] 检测到平台: ${currentPlatform.name}`);
      }
    }

    if (runtime.ui) {
      setUiDisplayEnabled(isPanelDisplayPage());
      return;
    }
    if (!isAllowedDisplayPage()) return;

    const mount = () => {
      if (runtime.ui || !document.body || !isAllowedDisplayPage()) return;
      // 本轮去重只跨越投递产生的页面导航；真实刷新/重载后不再自动续跑。
      // 但 paused 现场保留（已处理岗位、列表位置、暂停原因），用户手动启动时可从暂停处继续。
      if (isDocumentReload()) {
        const stale = RunState.load();
        const keepPaused = stale && stale.phase === 'paused';
        RunState.clear();
        if (keepPaused) {
          RunState.save(Object.assign({}, stale, {
            active: false,
            phase: 'paused',
            nextRunAt: null,
            nextDelaySeconds: null,
          }));
        }
      }
      Database.open().catch((error) => console.warn('[ZhipinAuto] IndexedDB 初始化失败', error));
      UI.mount();
      // 挂载后按面板显示规则决定是否露出；BOSS 消息界面挂载但保持隐藏（自动化仍可用）。
      setUiDisplayEnabled(isPanelDisplayPage());
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

  // 面板是否该显示：与"脚本能否运行"分开判断。
  // BOSS 消息界面仍要跑脚本（发消息、返回列表），但不显示助手面板。
  function isPanelDisplayPage(href) {
    if (currentPlatform && typeof currentPlatform.isPanelDisplayPage === 'function') {
      return currentPlatform.isPanelDisplayPage(href);
    }
    const detected = platformRegistry.detect(href || location.href);
    if (detected && typeof detected.isPanelDisplayPage === 'function') {
      currentPlatform = detected;
      return detected.isPanelDisplayPage(href);
    }
    return isAllowedDisplayPage(href);
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

  // 路由变化后的统一入口：脚本可运行的页面负责挂载/恢复，面板只在允许显示的页面露出。
  function syncAllowedPageUi() {
    const runnable = isAllowedDisplayPage();
    setUiDisplayEnabled(isPanelDisplayPage());
    if (runnable) bootWhenReady();
    // 扫描因手动离开列表页挂起（active 仍在、循环已退出）：回到岗位列表页自动接上，
    // 不用用户再点一次启动。
    if (runnable && isJobListUrl(location.href)) {
      const state = RunState.load();
      if (state && state.active && state.phase === 'list'
        && !runtime.automationLoopActive && !runtime.resumeInProgress) {
        Automation.resumeIfNeeded('route-back-to-list');
      }
    }
    return runnable;
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
