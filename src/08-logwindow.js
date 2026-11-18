  const LogWindow = {
    maxRecords: 500,
    maxPanelLines: 200,
    panelBodyEl: null,
    panelCountEl: null,
    formatButton: null,
    records: [],
    formatMode: 'human',
    // v3：重置一次格式偏好，把旧版本误存的"机器格式"拉回中文人易读格式。
    formatModeKey: '__zhipin_log_format_mode_v3__',
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
        delivery_builtin_greeting_completed: '内置问候已发送',
        delivery_consecutive_failures: '连续发送失败',
        delivery_paused_by_navigation: '离开列表已暂停',
        scan_resume_from_pause: '从暂停处继续',
        list_exhausted_refresh: '列表扫完自动刷新',
        list_exhausted_refresh_limit: '刷新达上限已停止',
        complete_return_start: '返回岗位列表',
        complete_return_list_visible: '岗位列表已可见',
        skip_company_blacklist: '企业黑名单跳过',
        skip_boss_active_filter: 'BOSS活跃度筛选跳过',
        zhilian_apply_start: '智联开始投递',
        zhilian_apply_done: '智联投递完成',
        zhilian_apply_button_found: '智联投递按钮已找到',
        zhilian_apply_button_clicked: '智联点击投递按钮',
        zhilian_greeting_injected: '智联招呼语已填入',
        zhilian_dialog_dismissed: '智联弹窗已关闭',
        zhilian_login_required: '智联登录失效',
        communicate_start: '进入聊天页',
        chat_button_clicked: '点击沟通按钮',
        wait_chat_ready_success: '聊天输入框就绪',
        continue_from_chat: '从聊天页返回继续',
        debug_logging_enabled: '已开启调试日志',
        clear_applied_companies: '已清空已投递公司',
        invalid_company_blacklist_rule: '黑名单规则无效',
        boss_platform_dialog_hard_limit: 'BOSS沟通次数达上限',
        model_circuit_open: 'AI评分连续失败已降级为本地评分',
        model_test_ok: 'AI评分测试通过',
      };
      // 未登记的类型兜底：按前缀翻成中文标题，避免日志里出现英文原始事件名。
      const title = labels[type] || String(type || '日志')
        .replace(/^delivery_/, '投递 ')
        .replace(/^zhilian_/, '智联 ')
        .replace(/^boss_/, 'BOSS ')
        .replace(/^chat_/, '聊天 ')
        .replace(/^job_(detail|list)_/, '岗位数据 ')
        .replace(/^skip_/, '跳过 ')
        .replace(/_/g, ' ');
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
      add('次数', source.count === undefined ? undefined : String(source.count));
      add('内容', source.messagePreview);
      const body = fields.length ? fields.join(' | ') : '已记录';
      return `[${time}] ${title}${body ? `：${body}` : ''}`;
    },
  };

