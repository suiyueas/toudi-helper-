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
    // resumable=true（手动点"停止"）时保留扫描现场：processedKeys、列表位置、筛选签名都不动，
    // 重新启动可从停止处续扫；自动停止（达到上限/列表耗尽/异常）保持原行为，重启从头扫。
    stop(reason, options) {
      const state = this.save({
        active: false,
        phase: 'stopped',
        pendingJob: null,
        pendingRawJob: null,
        nextRunAt: null,
        nextDelaySeconds: null,
        stopReason: reason || '已停止',
        stopResumable: Boolean(options && options.resumable),
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

  // 结论白名单：实时日志只放行这些"结果级"事件（一个岗位通常只留 2 条：岗位通过/跳过 + 问候发送成功）。
  // 其余一律视为过程事件（扫描、接口抓取、进聊天页、按钮探测、切换等待……）默认不进日志；
  // 打开「记录」调试日志开关后过程事件也进日志页。
  // 过程前缀优先于级别判断：这些前缀下多为可重试的瞬时告警（如"卡片同步不完整""详情接口空返回"），
  // 反复刷屏但不影响投递结论，真正的投递失败会以结果事件冒出来。
  const TRACE_LOG_PREFIXES = [
    'job_detail_', 'job_list_', 'saved_records_', 'score_',
    'sync_cards_', 'job_expectation_', 'chat_page_transition',
    'zhilian_detail_', 'zhilian_greeting_inject_error', 'zhilian_greeting_resolve_failed',
  ];
  const RESULT_LOG_PREFIXES = ['skip_', 'boss_apply_'];
  const RESULT_LOG_TYPES = new Set([
    'delivery_match_accepted',
    'delivery_match_rejected',
    'delivery_message_sent',
    'delivery_send_failed',
    'delivery_builtin_greeting_completed',
    'delivery_card_failed_continue',
    'delivery_scan_step_failed_continue',
    'delivery_chat_button_missing',
    'delivery_stay_page_dialog',
    'delivery_consecutive_failures',
    'delivery_paused_by_navigation',
    'scan_resume_from_pause',
    'list_exhausted_refresh',
    'list_exhausted_refresh_limit',
    'complete_return_start',
    'complete_return_list_visible',
    'zhilian_apply_done',
    'zhilian_apply_unconfirmed',
    'boss_platform_dialog_hard_limit',
    'invalid_company_blacklist_rule',
    'model_circuit_open',
    'model_test_ok',
    'debug_logging_enabled',
    'clear_applied_companies',
  ]);
  function isTraceLogEvent(type, level) {
    const key = String(type || '');
    // 过程前缀先判：即使 warn/error 也过滤（瞬时重试告警，不构成投递结论）。
    if (TRACE_LOG_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
    // 其余警告/错误始终保留，排查问题不能丢。
    if (level === 'warn' || level === 'error') return false;
    if (/error|failed|timeout|missing/i.test(key)) return false;
    if (RESULT_LOG_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
    if (RESULT_LOG_TYPES.has(key)) return false;
    return true;
  }

  // 统一写调试事件；默认关闭，开启后才写内存/localStorage/控制台。
  function logDebugEvent(type, data, level) {
    // 实时日志记录结果级事件（不受「调试日志」开关限制），用于替代被反调试禁用的 DevTools；
    // 过程 trace 事件只有打开调试日志开关时才进实时日志。
    try {
      if (!isTraceLogEvent(type, level) || isDebugEnabled()) LogWindow.append(type, data, level);
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
