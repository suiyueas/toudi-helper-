  function describeScoreRejection(scoreResult) {
    if (scoreResult.titleNegativeHit) return `岗位名含负面词：${(scoreResult.titleNegativeMatches || []).join('、')}`;
    if (scoreResult.negativeMatches.length) return `命中反面词：${scoreResult.negativeMatches.join('、')}`;
    if (scoreResult.grade === 'low' && scoreResult.positiveMatches.length === 0) return '未命中任何关键词';
    if (scoreResult.grade === 'low') return `分数过低：${scoreResult.score} < 阈值`;
    return '评分不通过';
  }

  const ScoreService = {
    lastResults: [],
    // 模型连续失败计数：达到 3 熔断本会话的模型评分（见 scoreEntry）。
    modelFailureStreak: 0,

    // 否定前缀：出现在关键词前表示"不要该方向"，不计入正面匹配。
    NEGATION_PREFIXES: ['不', '非', '勿', '无', '没', '免', '禁', '谢绝', '无需', '不要', '不用', '不招', '不需'],

    // 判断文本中关键词是否被否定前缀修饰（如"不招运维"中的"运维"不应命中）。
    // atIndex 允许调用方指定要检查的出现位置：长词去重后命中点可能不是第一次出现。
    isNegatedContext(normalizedText, keywordLower, atIndex) {
      const idx = atIndex === undefined ? normalizedText.indexOf(keywordLower) : atIndex;
      if (idx < 0) return false;
      const before = normalizedText.slice(Math.max(0, idx - 6), idx);
      return this.NEGATION_PREFIXES.some((prefix) => before.endsWith(prefix));
    },

    // 关键词评分：岗位名加权、技能加权、可配置权重、否定上下文检测。
    // text = 拼接后的岗位全文；jobTitle = 岗位名（用于加权）；skills = 技能列表（用于加权）。
    // 嵌套关键词按长度降序去重：长词先占位，短词只有落在未占位区间才计分，
    // 避免 "Java / Java后端 / 后端开发" 对同一段文字重复叠分把分数推高。
    scoreJob(text, jobTitle, skills) {
      const positives = expandMultiWordKeywords(parseKeywordList(config.scorePositive));
      const negatives = expandMultiWordKeywords(parseKeywordList(config.scoreNegative));
      const posWeight = readNumberConfig(config.scorePositiveWeight, 8);
      const negWeight = readNumberConfig(config.scoreNegativeWeight, 40);
      const titleBonus = readNumberConfig(config.scoreTitleBonus, 12);
      const skillBonus = readNumberConfig(config.scoreSkillBonus, 6);
      const negTitleBonus = readNumberConfig(config.scoreNegativeTitleBonus, 0);
      // 核心词必中：为空则不启用；启用时岗位全文必须命中至少一个。
      const coreWords = expandMultiWordKeywords(parseKeywordList(config.coreTerms));
      const coreEnabled = coreWords.length > 0;
      let coreHit = false;

      const normalizedText = String(text || '').toLocaleLowerCase();
      const titleLower = String(jobTitle || '').toLocaleLowerCase();
      const skillText = Array.isArray(skills) ? skills.join(' ').toLocaleLowerCase() : '';

      let score = 0;
      const reasons = [];
      const positiveMatches = [];
      const negativeMatches = [];
      // 岗位名里直接出现的负面词；scoreTitleNegativeReject 开启时用于硬否决。
      const titleNegativeMatches = [];

      // claimed 记录已被占位的文本区间；find 返回该词第一个未被占位的出现位置，全被占位则视为未命中。
      const claimedPositives = [];
      const claimedNegatives = [];
      const findFreeIndex = (wordLower, claimed) => {
        let from = 0;
        for (;;) {
          const idx = normalizedText.indexOf(wordLower, from);
          if (idx < 0) return -1;
          const end = idx + wordLower.length;
          if (!claimed.some(([start, stop]) => idx < stop && end > start)) return idx;
          from = idx + 1;
        }
      };
      const byLengthDesc = (a, b) => String(b).length - String(a).length;

      for (const word of positives.slice().sort(byLengthDesc)) {
        const wordLower = String(word).toLocaleLowerCase();
        const hitIndex = findFreeIndex(wordLower, claimedPositives);
        if (hitIndex < 0) continue;
        claimedPositives.push([hitIndex, hitIndex + wordLower.length]);

        // 否定上下文检测：文本中出现"不招运维"等否定表述时不计入正面
        if (this.isNegatedContext(normalizedText, wordLower, hitIndex)) {
          reasons.push(`否定忽略:${word}`);
          continue;
        }

        let bonus = 0;
        let location = '';
        // 岗位名命中加权（岗位名是最强信号）
        if (titleLower.includes(wordLower)) {
          bonus += titleBonus;
          location = '岗位名';
        }
        // 技能列表命中加权
        if (skillText.includes(wordLower)) {
          bonus += skillBonus;
          location = location ? `${location}+技能` : '技能';
        }
        const total = posWeight + bonus;
        score += total;
        reasons.push(`命中:${word}${location ? `(${location}+${bonus})` : `(+${posWeight})`}`);
        positiveMatches.push(word);
      }

      // 核心词必中判定：统计全部核心词在岗位全文中的命中情况。
      if (coreEnabled) {
        coreHit = coreWords.some((w) => {
          const wl = String(w).toLocaleLowerCase();
          return normalizedText.includes(wl) || titleLower.includes(wl) || skillText.includes(wl);
        });
      }

      for (const word of negatives.slice().sort(byLengthDesc)) {
        const wordLower = String(word).toLocaleLowerCase();
        const hitIndex = findFreeIndex(wordLower, claimedNegatives);
        if (hitIndex < 0) continue;
        claimedNegatives.push([hitIndex, hitIndex + wordLower.length]);

        // 负面词也做否定检测：如"非销售岗"中的"销售"不应扣分
        if (this.isNegatedContext(normalizedText, wordLower, hitIndex)) {
          reasons.push(`否定忽略:${word}`);
          continue;
        }

        // 岗位名直接含负面词：单独再查一次标题自身的否定上下文（如"非销售岗"不该硬否决）。
        if (titleLower.includes(wordLower) && !this.isNegatedContext(titleLower, wordLower)) {
          titleNegativeMatches.push(word);
        }

        let deduced = negWeight;
        // 岗位名命中负面词：额外扣分（标题含"销售/客服"几乎可断定岗位类型）。
        if (negTitleBonus && titleLower.includes(wordLower)) {
          deduced += negTitleBonus;
        }
        score -= deduced;
        reasons.push(`排除:${word}(-${deduced})`);
        negativeMatches.push(word);
      }

      return {
        score,
        reasons,
        positiveMatches,
        negativeMatches,
        titleNegativeMatches,
        titleNegativeHit: titleNegativeMatches.length > 0,
        // 核心词必中：启用后若核心词全未命中则整体判为不匹配。
        coreEnabled,
        coreHit,
        // keywordMatched 保留向后兼容，但过滤逻辑改用 grade
        keywordMatched: positiveMatches.length > 0 && negativeMatches.length === 0,
      };
    },

    // 等级：>= 高分阈值为 good，>= 中分阈值为 mid，否则 low。
    getGrade(score) {
      const good = readNumberConfig(config.scoreGoodThreshold, 35);
      const mid = readNumberConfig(config.scoreMidThreshold, 15);
      if (score >= good) return 'good';
      if (score >= mid) return 'mid';
      return 'low';
    },

    // 判断是否允许投递：核心词必中优先，其次岗位名负面硬否决，再次按分数与配置。
    shouldAllowDelivery(result) {
      // 核心词必中：启用且核心词全未命中 → 直接判不匹配，优先于分数。
      if (result.coreEnabled && !result.coreHit) return false;
      // 岗位名直接含负面词：不看分数，不给 good/mid 洗白的机会。
      if (config.scoreTitleNegativeReject && result.titleNegativeHit) return false;
      if (result.grade === 'good' || result.grade === 'mid') return true;
      // low 分：有正面词命中且无负面词时仍允许（避免误杀边缘岗位）
      if (result.positiveMatches.length > 0 && result.negativeMatches.length === 0) return true;
      // low 分 + 有负面词命中：跳过
      if (result.negativeMatches.length > 0) return false;
      // low 分 + 无任何命中：按 autoSkip 配置
      return !config.scoreAutoSkipLow;
    },

    // 综合评分入口：本地关键词分 + 可选模型语义分；高亮卡片并刷新面板列表。
    async scoreEntry(job, domInfo, card) {
      const jobTitle = (job && (job.jobName || job.title)) || '';
      const text = [
        jobTitle,
        (job && job.company) || '',
        (job && job.salary) || '',
        (domInfo && domInfo.text) || '',
      ].join(' ');
      const skills = (job && job.showSkills) || [];

      const local = this.scoreJob(text, jobTitle, skills);
      let modelDelta = 0;
      let modelScored = false;
      // 熔断：连续失败 3 次后本会话不再调模型，避免每个岗位都白等 20s 超时拖垮投递节奏。
      const modelAvailable = config.modelEnabled && config.modelScoreEnabled && this.modelFailureStreak < 3;
      if (modelAvailable) {
        try {
          modelDelta = await this.scoreJobWithModel(text);
          modelScored = true;
          this.modelFailureStreak = 0;
          this.log('model_score', { jobName: jobTitle, score: modelDelta });
        } catch (error) {
          this.modelFailureStreak = (this.modelFailureStreak || 0) + 1;
          this.log('model_score_failed', {
            error: String((error && error.message) || error),
            streak: this.modelFailureStreak,
            circuitOpen: this.modelFailureStreak >= 3,
          });
          if (this.modelFailureStreak >= 3) {
            this.log('model_circuit_open', { note: '连续失败 3 次，本会话改用纯本地评分' }, 'warn');
          }
        }
      }

      const score = local.score + modelDelta;
      const result = {
        title: jobTitle,
        company: (job && job.company) || '',
        score,
        reasons: local.reasons,
        positiveMatches: local.positiveMatches,
        negativeMatches: local.negativeMatches,
        titleNegativeMatches: local.titleNegativeMatches,
        titleNegativeHit: local.titleNegativeHit,
        keywordMatched: local.keywordMatched,
        coreEnabled: local.coreEnabled,
        coreHit: local.coreHit,
        modelDelta,
        modelScored,
        grade: this.getGrade(score),
        allowed: false,
      };
      result.allowed = this.shouldAllowDelivery(result);
      this.lastResults.push(result);
      if (this.lastResults.length > 50) this.lastResults.splice(0, this.lastResults.length - 50);

      if (config.scoreHighlight && card) this.markCard(card, result);
      this.renderResultList();
      return result;
    },

    // 在岗位卡片上打分数徽标并加边框高亮。
    markCard(card, result) {
      if (!card) return;
      card.classList.remove('za-score-good', 'za-score-mid', 'za-score-low');
      card.classList.add('za-score-' + result.grade);
      card.classList.add('za-scored');
      let badge = card.querySelector(':scope > .za-score-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'za-score-badge';
        card.appendChild(badge);
      }
      badge.textContent = String(result.score);
      badge.dataset.grade = result.grade;
    },

    // 面板「评分筛选」区块展示最近评分结果（Top N）。
    renderResultList() {
      if (!runtime.ui || !runtime.ui.scoreResultList) return;
      const list = this.lastResults.slice(-10).reverse();
      if (!list.length) {
        runtime.ui.scoreResultList.innerHTML = '<p class="za-hint">暂无评分结果：启动自动沟通后按列表岗位实时评分。</p>';
        return;
      }
      runtime.ui.scoreResultList.innerHTML = list.map((item) => (
        `<div class="za-score-row">` +
        `<span class="za-score-title" title="${escapeHtml(String(item.title || ''))}">${escapeHtml(String(item.title || '')).slice(0, 22)}</span>` +
        `<span class="za-score-grade za-score-grade-${item.grade}">${item.grade}</span>` +
        `<b class="za-score-value">${Number(item.score)}</b>` +
        (item.modelScored ? `<span class="za-score-model" title="含模型语义分">模型${item.modelDelta >= 0 ? '+' : ''}${Number(item.modelDelta)}</span>` : '') +
        (item.allowed === false ? `<span class="za-score-skip" title="${item.titleNegativeHit ? '岗位名含负面词：' + escapeHtml((item.titleNegativeMatches || []).join('、')) : '将跳过此岗位'}">${item.titleNegativeHit ? '负面词' : '跳过'}</span>` : '') +
        `</div>`
      )).join('');
    },

    // 模型语义评分：OpenAI 兼容 Chat Completions，-10 ~ +20。
    async scoreJobWithModel(text) {
      const prompt = [
        '你是岗位匹配度评分助手。判断下面的岗位描述与求职者方向「Java 后端开发（SpringBoot、SpringCloud、MySQL、Redis、消息队列、分布式、微服务、高并发）」的匹配程度。',
        '输出规则：只输出一个整数，范围 -10 到 +20。高度匹配给 15~20，部分相关给 5~14，弱相关给 -5~4，明显不相关给 -10~-6。',
        '',
        '岗位信息：',
        String(text || '').slice(0, 1500),
      ].join('\n');
      const content = await this.requestModelCompletion([
        { role: 'system', content: '你是岗位匹配度评分助手，只输出一个整数，不要输出其他内容。' },
        { role: 'user', content: prompt },
      ]);
      const match = String(content).match(/-?\d+/);
      const score = match ? Math.max(-10, Math.min(20, Number(match[0]))) : 0;
      return score;
    },

    // 直连模型接口（GM_xmlhttpRequest），返回完整响应。
    requestModel(messages) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          reject(new Error('GM_xmlhttpRequest 不可用，无法直连模型'));
          return;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (config.modelApiKey) headers.Authorization = `Bearer ${config.modelApiKey}`;
        GM_xmlhttpRequest({
          method: 'POST',
          url: String(config.modelBaseUrl || '').trim(),
          headers,
          data: JSON.stringify({
            model: String(config.modelName || '').trim(),
            messages,
            temperature: 0,
          }),
          timeout: 20000,
          onload: (response) => resolve(response),
          onerror: () => reject(new Error('模型请求失败（网络错误）')),
          ontimeout: () => reject(new Error('模型请求超时')),
        });
      });
    },

    // 调用模型并解析返回文本；失败抛错给调用方处理。
    async requestModelCompletion(messages) {
      if (!String(config.modelBaseUrl || '').trim()) throw new Error('模型 API 地址未配置');
      if (!String(config.modelName || '').trim()) throw new Error('模型名称未配置');
      const response = await this.requestModel(messages);
      let payload = null;
      try {
        payload = JSON.parse(response.responseText || '');
      } catch (_) {
        throw new Error(`模型返回非 JSON：${String(response.responseText || '').slice(0, 120)}`);
      }
      if (!response.status || response.status >= 400) {
        throw new Error((payload && (payload.error && payload.error.message || payload.message)) || `HTTP ${response.status}`);
      }
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回有效内容');
      return String(content).trim();
    },

    // 面板「测试模型」按钮：连通性测试。
    async testModel() {
      UI.setStatus('正在测试模型连接...', 'info');
      try {
        const reply = await this.requestModelCompletion([
          { role: 'user', content: '请回复：连接成功' },
        ]);
        UI.setStatus(`模型连接成功：${String(reply).slice(0, 60)}`, 'ok');
        logDebugEvent('model_test_ok', { reply: String(reply).slice(0, 120) });
      } catch (error) {
        UI.setStatus(`模型连接失败：${String((error && error.message) || error)}`, 'warn');
        logDebugEvent('model_test_failed', { error: String((error && error.message) || error) }, 'warn');
      }
    },

    log(step, data) {
      logDebugEvent(`score_${step}`, data || {});
    },
  };

  // 解析逗号/换行分隔的关键词列表（评分用）。
  function parseKeywordList(value) {
    return String(value || '').split(/[,，\n]+/).map((item) => String(item).trim()).filter(Boolean);
  }

  // 读取数值型配置：空串/非法值回退默认值，但显式 0 视为有效（阈值填 0 = 关闭该档判定）。
  function readNumberConfig(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  // 展开多词短语关键词（如 "Spring Boot"、"Spring Cloud"），按空格拆成独立词并去重，
  // 提升 Java 等大量多词技能词的召回，同时避免同一词重复叠分。
  function expandMultiWordKeywords(list) {
    const seen = new Set();
    const raw = [];
    for (const word of list) {
      const parts = String(word).split(/\s+/).filter(Boolean);
      for (const part of parts) {
        const key = part.toLocaleLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          raw.push(part);
        }
      }
    }
    return raw;
  }

  // 返回顶层 document 及所有可访问（同源）iframe 的 document（跨 frame 采集 DOM 用）。
