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
