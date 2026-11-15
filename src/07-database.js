  const Database = {
    // 打开或创建 IndexedDB。版本升级时只创建缺失的 object store 和索引。
    open() {
      if (runtime.db) return Promise.resolve(runtime.db);

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(APP.dbName, APP.dbVersion);

        request.onupgradeneeded = (event) => {
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

          // v2：已沟通判重 key 的轻量索引。只存 key 字符串，
          // 避免每次启动都全表读 jobRecords（其中 rawHtmlDetail 单条可达数 KB）。
          if (!db.objectStoreNames.contains('contactedKeys')) {
            db.createObjectStore('contactedKeys', { keyPath: 'key' });
          }

          // 迁移兜底：老版本可能写入缺字段的记录（status/平台标识/时间戳缺失），
          // 读取方一律按空值处理，这里补齐，避免后续逻辑读到半坏对象。
          if (event.oldVersion >= 1 && db.objectStoreNames.contains('jobRecords')) {
            try {
              const tx = request.transaction;
              const store = tx.objectStore('jobRecords');
              const cursorReq = store.openCursor();
              cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) return;
                const row = cursor.value || {};
                let changed = false;
                if (typeof row.status !== 'string') { row.status = String(row.status || ''); changed = true; }
                if (typeof row.platform !== 'string') { row.platform = String(row.platform || 'unknown'); changed = true; }
                if (typeof row.jobKey !== 'string') { row.jobKey = String(row.jobKey || ''); changed = true; }
                if (row.showSkills && !Array.isArray(row.showSkills)) { row.showSkills = []; changed = true; }
                if (row.companyLabels && !Array.isArray(row.companyLabels)) { row.companyLabels = []; changed = true; }
                if (changed) cursor.update(row);
                cursor.continue();
              };
            } catch (_) { /* 迁移失败不阻断打开，读取方已有空值兜底 */ }
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
      return this.withStore(storeName, 'readwrite', (store) => store.put(value))
        .then((result) => { this.invalidateCache(storeName); return result; });
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

    // 带内存缓存的全量读取：同一 store 短时间内被统计卡/列表/导出反复读取时命中缓存。
    // 任何写操作（putMany/put/clearStore/deleteWhere）都会失效对应 store 的缓存，保证不读到旧数据。
    // 返回数组副本，避免调用方原地排序/裁剪污染缓存。
    getAllCached(storeName) {
      const cache = this._cache || (this._cache = {});
      if (cache[storeName]) return Promise.resolve(cache[storeName].slice());
      return this.getAll(storeName).then((rows) => {
        cache[storeName] = rows;
        return rows.slice();
      });
    },

    invalidateCache(storeName) {
      if (!this._cache) return;
      if (storeName) delete this._cache[storeName];
      else this._cache = {};
    },

    // 批量写入（单事务），用于已沟通 key 索引回填等场景。
    putMany(storeName, values) {
      if (!values || !values.length) return Promise.resolve(0);
      return this.withStore(storeName, 'readwrite', (store) => {
        values.forEach((value) => store.put(value));
        return values.length;
      }).then((count) => { this.invalidateCache(storeName); return count; });
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

        tx.oncomplete = () => { this.invalidateCache(storeName); resolve(count); };
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
        tx.oncomplete = () => { this.invalidateCache(storeName); resolve(deleted); };
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
        // 评分结果随记录落库（runScoreGate 挂在 job 上）；后续 clicked/sent 更新不丢首次评分。
        scoreResult: job.scoreResult || (existing && existing.scoreResult) || null,
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
  // v2 起判重 key 单独存 contactedKeys store（每条只有几十字节），启动时不再全表读 jobRecords。
  const ContactedIndex = {
    // 首次使用前重建内存索引：优先读轻量 key store，为空时回退全表扫描并回填。
    async ensureReady() {
      if (runtime.contactedIndexReady) return runtime.contactedJobKeys;
      await Database.open().catch(() => null);
      const cached = await Database.getAll('contactedKeys').catch(() => []);
      if (cached.length) {
        runtime.contactedJobKeys.clear();
        cached.forEach((row) => row && row.key && runtime.contactedJobKeys.add(row.key));
        runtime.contactedIndexReady = true;
        return runtime.contactedJobKeys;
      }
      return this.rebuild();
    },

    // 全量重建：从 jobRecords 和 greetedJobs 汇总已沟通 key，并回填轻量 store。
    // 仅在首次升级（key store 为空）或按时间清理记录后调用，代价是可接受的一次性全表扫描。
    async rebuild() {
      runtime.contactedJobKeys.clear();

      const rows = await Database.getAll('jobRecords');
      rows.forEach((record) => {
        if (isContactedRecord(record)) this.add(record, { persist: false });
      });

      // greetedJobs 是 sent 记录的投影；单独读取是为了兼容旧版本只写入 greetedJobs 的情况。
      const greetedRows = await Database.getAll('greetedJobs').catch(() => []);
      greetedRows.forEach((record) => this.add(record, { persist: false }));

      await this.persistKeys();
      runtime.contactedIndexReady = true;
      return runtime.contactedJobKeys;
    },

    // 将某个岗位的所有可判重 key 加入内存 Set；persist=false 时跳过写库（批量回填场景）。
    add(job, options) {
      const persist = !options || options.persist !== false;
      const keys = getContactedKeys(job);
      const fresh = [];
      keys.forEach((key) => {
        if (!runtime.contactedJobKeys.has(key)) {
          runtime.contactedJobKeys.add(key);
          fresh.push({ key });
        }
      });
      // 增量补写轻量 store；运行中失败只影响下次启动的加载速度，内存索引仍然有效。
      if (persist && fresh.length) Database.putMany('contactedKeys', fresh).catch(() => {});
    },

    // 把当前内存索引整体写回轻量 store（重建后回填用）。
    async persistKeys() {
      try {
        await Database.clearStore('contactedKeys');
        const rows = Array.from(runtime.contactedJobKeys, (key) => ({ key }));
        await Database.putMany('contactedKeys', rows);
      } catch (_) { /* 回填失败不致命：下次启动会重新全表扫描 */ }
    },

    // 判断岗位是否已沟通过；列表循环跳过重复岗位时调用。
    has(job) {
      const keys = getContactedKeys(job);
      return keys.length > 0 && keys.some((key) => runtime.contactedJobKeys.has(key));
    },

    // 清理 IndexedDB 后同步清空内存索引与轻量 store。
    reset() {
      runtime.contactedJobKeys.clear();
      runtime.contactedIndexReady = false;
      Database.clearStore('contactedKeys').catch(() => {});
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
        const rows = await Database.getAllCached('jobRecords').catch(() => []);
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

    // 节流写入 localStorage：连续投递时 500ms 内的多次 add 合并成一次序列化+写盘，
    // 避免名单变大后每次投递都同步全量 JSON.stringify。
    persist() {
      this._persistDirty = true;
      if (this._persistTimer) return;
      this._persistTimer = setTimeout(() => this.flush(), 500);
    },

    // 立即落盘（节流窗口到期、页面隐藏或清空前调用），保证不丢最后一批写入。
    flush() {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      if (!this._persistDirty) return;
      this._persistDirty = false;
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
      // 先取消挂起的节流写入，避免清空后定时器把旧名单重新写回。
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      this._persistDirty = false;
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

  // 页面隐藏/关闭前把节流中的名单写入落盘，避免最后 500ms 内的投递记录丢失。
  window.addEventListener('pagehide', () => AppliedCompanyIndex.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') AppliedCompanyIndex.flush();
  });

  // 每日投递配额：按自然日计数存 localStorage，跨运行累计，换天自动归零。
  // 与 maxCount（单次运行上限）相互独立，两者任一达到都会停。
  const DailyQuota = {
    todayKey() {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${now.getFullYear()}-${month}-${day}`;
    },

    // 读取今日计数；存储的日期不是今天则视为 0（跨天自动重置）。
    count() {
      try {
        const raw = localStorage.getItem(APP.dailyQuotaKey);
        if (!raw) return 0;
        const data = JSON.parse(raw);
        if (!data || data.date !== this.todayKey()) return 0;
        return Math.max(0, Number(data.count) || 0);
      } catch (_) {
        return 0;
      }
    },

    // 成功沟通一次后累加。
    increment() {
      const next = this.count() + 1;
      try {
        localStorage.setItem(APP.dailyQuotaKey, JSON.stringify({ date: this.todayKey(), count: next }));
      } catch (_) { /* 存储失败不影响主流程，只是配额少算一次 */ }
      return next;
    },

    // 配额是否已用尽；limit<=0 表示不限制。
    reached(limit) {
      const max = Number(limit) || 0;
      return max > 0 && this.count() >= max;
    },

    // 面板展示用：剩余次数，不限制时返回 null。
    remaining(limit) {
      const max = Number(limit) || 0;
      if (max <= 0) return null;
      return Math.max(0, max - this.count());
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
