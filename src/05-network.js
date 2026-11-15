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
