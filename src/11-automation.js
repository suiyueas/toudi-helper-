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
      // 暂停（改参数、弹窗提醒等）后重新启动：同一筛选列表直接从暂停处续扫，不再回顶部重扫。
      const resumePlan = this.buildPausedResumePlan(RunState.load(), listUrl);
      // 一轮运行锁定同一个筛选 URL；未续扫时先回扫顶部，再用岗位标识从上到下累计处理虚拟列表。
      RunState.save(Object.assign({
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
        resumedFromPause: false,
      }, resumePlan));

      runtime.stopRequested = false;
      if (resumePlan) {
        logDebugEvent('scan_resume_from_pause', {
          processedCount: resumePlan.processedKeys.length,
          cursorIndex: resumePlan.cursorIndex,
          listScrollTop: resumePlan.listScrollTop,
          pauseReason: resumePlan.pauseReason,
        });
        // 暂停期间页面可能被滚回顶部或刷新过，先把列表拉回暂停时的位置再继续向下扫。
        await restoreJobListPosition(RunState.load());
      }
      this.runListLoop(resumePlan ? `resume：从暂停处继续（已处理 ${resumePlan.processedKeys.length} 个岗位）` : 'start');
    },

    // 暂停现场能否续扫：仅限同一筛选列表的 paused 状态，且确实扫过岗位。
    // 不满足任一条件返回 null，start() 保持原来的“回顶部从头扫”行为。
    buildPausedResumePlan(previous, currentListUrl) {
      if (!previous || previous.phase !== 'paused') return null;
      if (!Array.isArray(previous.processedKeys) || !previous.processedKeys.length) return null;
      if (!previous.listUrl || !isSameJobListFilterContext(currentListUrl, previous.listUrl, previous.listFilterSignature)) return null;

      const processedKeys = previous.processedKeys.filter(Boolean);
      // 暂停发生在沟通中途时，把未完成的岗位也记为已处理，避免续跑后重复打招呼。
      const pendingKey = normalizeText(previous.pendingJobKey);
      if (pendingKey && !processedKeys.includes(pendingKey)) processedKeys.push(pendingKey);

      return {
        cursorIndex: Math.max(Number(previous.cursorIndex || 0), processedKeys.length),
        processedKeys,
        // 续扫保持向下扫描，跳过 scanJobListToTop 的回顶过程。
        scanPhase: 'scanning_down',
        scanNoProgressCount: 0,
        scanDiscoveredCount: Math.max(Number(previous.scanDiscoveredCount || 0), processedKeys.length),
        listScrollTop: Math.max(0, Number(previous.listScrollTop || 0)),
        listAnchorKey: String(previous.listAnchorKey || ''),
        // 刷新续跑次数跨暂停累计，避免每暂停一次就把刷新额度重置。
        listRefreshCount: Number(previous.listRefreshCount || 0),
        resumedFromPause: true,
        pauseReason: String(previous.pauseReason || '已暂停'),
      };
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

          // 每日配额独立于单次运行上限：跨运行累计，用尽即停（次日自动重置）。
          if (DailyQuota.reached(config.dailySendLimit)) {
            this.stop(`已达到今日投递上限：${DailyQuota.count()}/${config.dailySendLimit}，明天会自动重置`);
            break;
          }

          let processed;
          try {
            processed = await this.processNextCard(state);
          } catch (error) {
            // 最外层兜底：即使卡片流程遗漏了异常，也只跳过当前循环，不将整轮置为 fatal。
            this.noteCardFailure('scan_step');
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
            this.noteCardFailure('blacklist_record');
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
          const outcome = await this.communicateWithCard(card, job, cursorIndex, domInfo);
          this.noteCardSuccess();
          return outcome;
        } catch (error) {
          // 单张岗位卡片失败不得终止整轮投递；记录现场后标记本轮已处理并继续下一张。
          const message = String((error && error.message) || error);
          this.noteCardFailure('card_flow');
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

    // 共享评分闸门：BOSS 与智联两条链路共用（原先各写一份，改一处极易漏另一处）。
    // 评分 → 打分日志 → 不通过则记录拒绝原因并推进游标返回 null，通过则返回 scoreResult。
    async runScoreGate(job, cardDomInfo, card, scanKey) {
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
      // 评分结果挂到 job 上：后续 clicked/sent 落库时一并写入，导出可复盘分数与理由。
      job.scoreResult = {
        score: scoreResult.score,
        posScore: scoreResult.posScore,
        negDeduction: scoreResult.negDeduction,
        grade: scoreResult.grade,
        allowed: scoreResult.allowed,
        reasons: (scoreResult.reasons || []).slice(0, 20),
        positiveMatches: scoreResult.positiveMatches || [],
        negativeMatches: scoreResult.negativeMatches || [],
        titleNegativeMatches: scoreResult.titleNegativeMatches || [],
        coreHit: scoreResult.coreHit,
        scoredAt: nowIso(),
      };
      if (!scoreResult.allowed) {
        const reason = describeScoreRejection(scoreResult);
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
        // 被拒岗位也落库（不带 raw 大字段，避免详情 HTML 撑爆库），导出时可复盘"为什么没投"。
        try {
          await Database.saveJobRecord(
            Object.assign({}, job, { rawJob: null, rawDetail: null, rawHtmlDetail: null, rawCompanyDetail: null }),
            {
              status: 'skipped_score',
              skippedAt: nowIso(),
              skipReason: 'score_filter',
              scoreRejectReason: reason,
              pageUrl: location.href,
            },
          );
        } catch (error) {
          logDebugEvent('score_reject_record_failed', { error: String((error && error.message) || error) }, 'warn');
        }
        const state = Object.assign({}, RunState.load() || {}, { pendingJobKey: scanKey });
        RunState.patch(buildProcessedJobPatch(state, job, cardDomInfo, Object.assign(captureJobListPosition(job), { pendingJobKey: '' })));
        scrollAheadByJobKey(scanKey);
        return null;
      }
      return scoreResult;
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
        blockedCities: cityDecision.blockedCities,
        matched: cityDecision.matched,
      });
      if (!cityDecision.matched) {
        logDebugEvent('delivery_match_rejected', { scanKey, jobName: job.jobName || '', company: job.company || '', reason: cityDecision.blocked ? '城市在禁止列表' : '城市不在允许列表', city: cityDecision.target, allowedCities: cityDecision.allowed, blockedCities: cityDecision.blockedCities }, 'warn');
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
      const scoreResult = await this.runScoreGate(job, cardDomInfo, card, scanKey);
      if (!scoreResult) return 'processed';
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
        blockedCities: cityDecision.blockedCities,
        matched: cityDecision.matched,
      });
      if (!cityDecision.matched) {
        logDebugEvent('delivery_match_rejected', {
          scanKey,
          jobName: job.jobName || '',
          company: job.company || '',
          reason: cityDecision.blocked ? '城市在禁止列表' : '城市不在允许列表',
          city: cityDecision.target,
          allowedCities: cityDecision.allowed,
          blockedCities: cityDecision.blockedCities,
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

      const scoreResult = await this.runScoreGate(job, cardDomInfo, card, scanKey);
      if (!scoreResult) return 'processed';

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
      if (contacted) DailyQuota.increment();
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
          DailyQuota.increment();
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
        DailyQuota.increment();

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
    // 连续失败计数：单张卡片/扫描步骤抛错时累加，供退避逻辑读取。
    noteCardFailure(stage) {
      runtime.consecutiveFailures = Number(runtime.consecutiveFailures || 0) + 1;
      const count = runtime.consecutiveFailures;
      if (count >= 3) {
        const backoffSeconds = this.failureBackoffSeconds(count);
        UI.setStatus(`连续失败 ${count} 次，下一次等待将延长至约 ${backoffSeconds} 秒`, 'warn');
        logDebugEvent('delivery_consecutive_failures', { count, stage, backoffSeconds }, 'warn');
      }
    },

    // 成功处理一张卡片即清零，退避只针对"连续"失败。
    noteCardSuccess() {
      if (runtime.consecutiveFailures) {
        logDebugEvent('delivery_failure_streak_reset', { previous: runtime.consecutiveFailures });
      }
      runtime.consecutiveFailures = 0;
    },

    // 指数退避：3 次起 30s，之后 60s、120s，上限 300s。
    failureBackoffSeconds(count) {
      const exponent = Math.max(0, count - 3);
      return Math.min(300, 30 * (2 ** exponent));
    },

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
        // 连续失败 >=3 次时在随机间隔上叠加指数退避，降低被平台风控的概率。
        const failureCount = Number(runtime.consecutiveFailures || 0);
        if (failureCount >= 3) {
          delaySeconds += this.failureBackoffSeconds(failureCount);
        }
        nextRunAt = Date.now() + delaySeconds * 1000;
        RunState.patch({ nextRunAt, nextDelaySeconds: delaySeconds });
      }

      logDebugEvent('delivery_random_switch_delay', {
        delaySeconds,
        minSeconds: config.delayMin,
        maxSeconds: config.delayMax,
        consecutiveFailures: Number(runtime.consecutiveFailures || 0),
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
        const rows = await Database.getAllCached('jobRecords');
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
            评分: row.scoreResult ? Number(row.scoreResult.score) : '',
            正面分: row.scoreResult ? Number(row.scoreResult.posScore || 0) : '',
            负面扣分: row.scoreResult ? Number(row.scoreResult.negDeduction || 0) : '',
            评分等级: row.scoreResult ? String(row.scoreResult.grade || '') : '',
            评分理由: row.scoreResult ? (row.scoreResult.reasons || []).join('；') : '',
            拒绝原因: row.scoreRejectReason || '',
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

  // 把评分不通过的原因翻译成人话；BOSS/智联共用，保持两个平台的拒绝文案一致。
