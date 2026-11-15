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
