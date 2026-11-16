  const UI = {
    // 创建侧边面板 DOM、注入样式、初始化表单和虚拟列表。
    mount() {
      injectNewStyle();

      // 获取当前平台名称
      const platformName = currentPlatform?.name || '未检测';
      const platformIcon = currentPlatform?.id === 'boss' ? '💼' :
                           currentPlatform?.id === 'zhilian' ? '📋' :
                           currentPlatform?.id === '51job' ? '👔' :
                           currentPlatform?.id === 'liepin' ? '🔍' : '⚡';

      const root = document.createElement('div');
      root.id = 'zhipin-auto-greeting-root';
      root.dataset.version = APP.version;
      root.innerHTML = `
        <button class="za-toggle" type="button" title="显示/隐藏 ${platformName}助手">
          <span class="za-toggle-icon">${platformIcon}</span>
          <span class="za-toggle-text">${platformName}助手</span>
        </button>
        <aside class="za-window" aria-label="${platformName}自动沟通控制台">
          <header class="za-titlebar" data-ui-role="draggableHeader">
            <div class="za-title">
              <span class="za-logo">${platformIcon}</span>
              <div class="za-title-text">
                <strong>${platformName}助手</strong>
                <span class="za-subtitle">v${APP.version}</span>
              </div>
            </div>
            <div class="za-window-controls">
              <div class="za-tool-group" title="透明度">
                <button class="za-icon-btn za-tool-btn" type="button" data-action="decreaseOpacity" title="降低透明度 (Ctrl+↓)">−</button>
                <span class="za-opacity-indicator" data-role="opacityIndicator">100%</span>
                <button class="za-icon-btn za-tool-btn" type="button" data-action="increaseOpacity" title="提高透明度 (Ctrl+↑)">+</button>
              </div>
              <button class="za-icon-btn" type="button" data-action="toggleFeaturePanel" aria-expanded="false" title="板块管理">☰</button>
              <button class="za-icon-btn" type="button" data-action="toggleLogWindow" data-role="logToggle" title="打开日志页">▤</button>
              <button class="za-icon-btn" type="button" data-action="minimizeWindow" title="最小化">▾</button>
              <button class="za-icon-btn" type="button" data-action="toggle" title="收起">×</button>
            </div>
          </header>

          <div class="za-feature-panel" data-role="featurePanel" hidden>
            <div class="za-feature-panel-head">
              <strong>板块管理</strong>
              <button class="za-icon-btn" type="button" data-action="closeFeaturePanel" title="关闭板块管理" aria-label="关闭板块管理">×</button>
            </div>
            <div class="za-feature-list" data-role="featureBlockList"></div>
          </div>

          <div class="za-main">
            <nav class="za-sidebar" role="tablist">
              <button class="za-nav-item za-tab za-tab-active" type="button" role="tab" aria-selected="true" data-tab-target="tabDelivery" title="投递">
                <span class="za-nav-icon">📋</span>
                <span class="za-nav-label">投递</span>
              </button>
              <button class="za-nav-item za-tab" type="button" role="tab" aria-selected="false" data-tab-target="tabData" title="数据">
                <span class="za-nav-icon">📊</span>
                <span class="za-nav-label">数据</span>
              </button>
              <button class="za-nav-item za-tab" type="button" role="tab" aria-selected="false" data-tab-target="tabLog" title="日志">
                <span class="za-nav-icon">📝</span>
                <span class="za-nav-label">日志</span>
                <span class="za-nav-badge" data-role="logBadge" hidden></span>
              </button>
            </nav>

            <div class="za-content">
              <!-- 投递 Tab -->
              <div class="za-pane za-pane-active" data-tab-name="tabDelivery">
                <div class="za-status" data-role="status">等待启动</div>

                <!-- 平台信息 -->
                <section class="za-section" data-feature-section="platformInfo">
                  <h3>当前平台</h3>
                  <div class="za-platform-info">
                    <div class="za-platform-current">
                      <span class="za-platform-icon">${platformIcon}</span>
                      <span class="za-platform-name">${platformName}</span>
                      <span class="za-platform-badge">已连接</span>
                    </div>
                    <p class="za-hint">支持的平台：BOSS直聘、智联招聘、前程无忧、猎聘</p>
                  </div>
                </section>

                <section class="za-section" data-feature-section="greeting">
                  <h3>打招呼配置</h3>
                  <label class="za-check"><input data-field="useCustomGreeting" type="checkbox"> 使用自定义打招呼（默认使用 BOSS 内置问候语）</label>
                  <label class="za-check"><input data-field="bossAutoApply" type="checkbox"> BOSS 沟通前主动投递简历（未勾选则仅打招呼不投简历）</label>
                  <div class="za-radio-row">
                    <label><input type="radio" name="za-greeting-mode" value="fastReply"> 常用语</label>
                    <label><input type="radio" name="za-greeting-mode" value="customText"> 自定义文本</label>
                  </div>

                  <div class="za-mode-block" data-mode-block="fastReply">
                    <input data-field="fastReplyIndex" type="hidden">
                    <div class="za-fast-reply-control">
                      <button class="za-fast-reply-trigger" type="button" data-action="toggleFastReplyPicker" aria-expanded="false" aria-haspopup="dialog">
                        <span data-role="fastReplyTriggerText">选择常用语</span>
                        <span class="za-fast-reply-arrow">▾</span>
                      </button>
                      <button type="button" data-action="refreshFastReplies">刷新</button>
                    </div>
                    <div class="za-fast-reply-preview" data-role="fastReplyPreview"></div>
                    <p class="za-hint" data-role="fastReplyHint">关闭“使用自定义打招呼”时，以上内容不参与投递，使用 BOSS 页面内置问候语。</p>
                  </div>

                  <div class="za-fast-reply-backdrop" data-role="fastReplyBackdrop" hidden>
                    <div class="za-fast-reply-dialog" role="dialog" aria-modal="true" aria-label="选择常用语">
                      <div class="za-fast-reply-head">
                        <div>
                          <strong>选择常用语</strong>
                          <span data-role="fastReplyCount">0 条</span>
                        </div>
                        <button class="za-icon-btn" type="button" data-action="closeFastReplyPicker" title="关闭">×</button>
                      </div>
                      <div class="za-fast-reply-search">
                        <input data-role="fastReplySearch" type="search" autocomplete="off" spellcheck="false" placeholder="搜索常用语内容">
                        <button type="button" data-action="clearFastReplySearch">清空</button>
                      </div>
                      <div class="za-fast-reply-list" data-role="fastReplyList"></div>
                    </div>
                  </div>

                  <div class="za-mode-block" data-mode-block="customText">
                    <div class="za-segment" aria-label="自定义文本来源">
                      <label><input type="radio" name="za-text-source" value="text"> 手动输入</label>
                      <label><input type="radio" name="za-text-source" value="api"> 接口返回</label>
                    </div>

                    <div class="za-source-block" data-text-source-block="text">
                      <label class="za-label">问候文本</label>
                      <textarea data-field="customText" rows="4" placeholder="支持 {jobName}、{company}、{salary}、{bossName} 等占位符"></textarea>
                    </div>

                    <div class="za-source-block za-api-panel" data-text-source-block="api">
                      <div class="za-api-endpoint">
                        <label>接口地址
                          <input data-field="customApiUrl" type="url" placeholder="https://example.com/greeting?job={jobName}">
                        </label>
                        <label class="za-api-method">方法
                          <select data-field="customApiMethod">
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="PATCH">PATCH</option>
                          </select>
                        </label>
                      </div>
                      <label>URL 参数
                        <textarea data-field="customApiParams" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;scene=boss&#10;job={jobName}'></textarea>
                      </label>
                      <label>请求头
                        <textarea data-field="customApiHeaders" rows="3" placeholder='JSON 对象或每行 key=value，例如：&#10;Authorization=Bearer xxx&#10;X-Source=zhipin'></textarea>
                      </label>
                      <label>请求体
                        <textarea data-field="customApiBody" rows="4" placeholder='POST/PUT/PATCH 可用；留空时发送默认岗位 JSON。支持 {jobName}、{company} 等占位符。'></textarea>
                      </label>
                      <label>返回文本路径
                        <input data-field="customApiResponsePath" type="text" placeholder="例如 data.text；留空则自动识别 message/text/content">
                      </label>
                      <p class="za-hint">参数、请求头和请求体都支持 JSON 对象，也支持每行 key=value。</p>
                    </div>
                  </div>
                </section>

                <section class="za-section" data-feature-section="strategy">
                  <h3>运行策略</h3>
                  <p class="za-hint">岗位去重仅在本轮投递中生效；「跳过历史已沟通岗位」则读取本地历史记录，跨批次、刷新后依然生效。</p>
                  <label class="za-check"><input data-field="collectGreetedJobs" type="checkbox"> 收集已打招呼岗位信息</label>
                  <label class="za-check"><input data-field="skipContacted" type="checkbox"> 跳过历史已沟通岗位（跨批次）</label>
                  <label class="za-check"><input data-field="ignoreListRefresh" type="checkbox"> 无视列表刷新</label>
                  <label class="za-check"><input data-field="autoRefreshOnExhausted" type="checkbox"> 列表耗尽后自动刷新</label>
                  <div class="za-grid-2">
                    <label>岗位切换最小间隔(秒)<input data-field="delayMin" type="number" min="1" step="1"></label>
                    <label>岗位切换最大间隔(秒)<input data-field="delayMax" type="number" min="1" step="1"></label>
                    <label>等待上限(秒)<input data-field="waitTimeout" type="number" min="2" step="1"></label>
                    <label>聊天重试次数<input data-field="chatOpenRetries" type="number" min="0" step="1"></label>
                    <label>最大沟通数<input data-field="maxCount" type="number" min="0" step="1"></label>
                    <label>每日投递上限<input data-field="dailySendLimit" type="number" min="0" step="1" placeholder="0=不限"></label>
                    <label>列表刷新上限<input data-field="maxListRefresh" type="number" min="0" step="1" title="当前列表耗尽后最多整页刷新次数，0 表示不限制"></label>
                  </div>
                  <p class="za-hint">最大沟通数=单次运行上限；每日投递上限=跨运行按自然日累计，用尽后当天停止，次日自动重置（0 均为不限制）。连续处理失败 3 次起会在随机间隔上叠加指数退避（30s→60s→120s，上限 300s），成功一次即恢复。</p>
                </section>

                <section class="za-section" data-feature-section="cityFilter">
                  <h3>城市筛选</h3>
                  <label>允许城市列表（命中任意城市即可）
                    <input data-field="allowedCities" type="text" placeholder="留空不限制城市；例如：北京,上海,深圳">
                  </label>
                  <label>禁止城市列表（命中任一城市则不投递）
                    <input data-field="blockedCities" type="text" placeholder="留空不启用；例如：北京,廊坊,燕郊">
                  </label>
                  <p class="za-hint">两个列表都支持逗号、中文逗号或换行分隔，条目支持普通包含匹配、=城市 精确匹配、/正则/ 匹配。允许列表留空=不限制城市；禁止列表命中时直接跳过该岗位，且优先级高于允许列表（例如允许"北京"但禁止"燕郊"时，燕郊岗位会被跳过）。</p>
                </section>

                <section class="za-section" data-feature-section="companyFilter">
                  <h3>公司筛选</h3>
                  <div class="za-inline">
                    <select data-field="companyFilterMode">
                      <option value="exact">全量匹配</option>
                      <option value="partial">部分匹配</option>
                      <option value="regex">正则匹配</option>
                    </select>
                    <input data-field="companyFilterValue" type="text" autocomplete="off" spellcheck="false" placeholder="留空则不过滤">
                  </div>
                </section>

                <section class="za-section" data-feature-section="companyBlacklist">
                  <h3>公司黑名单</h3>
                  <div class="za-inline">
                    <select data-field="companyBlacklistMode">
                      <option value="exact">全量匹配</option>
                      <option value="partial">部分匹配</option>
                      <option value="regex">正则匹配</option>
                    </select>
                    <input data-field="companyBlacklistValue" type="text" autocomplete="off" spellcheck="false" placeholder="输入公司黑名单">
                    <button type="button" data-action="addCompanyBlacklistRule">添加</button>
                  </div>
                  <div class="za-multi-dropdown" data-role="companyBlacklistDropdown">
                    <button class="za-multi-trigger" type="button" data-action="toggleCompanyBlacklistDropdown" aria-expanded="false">
                      <span data-role="companyBlacklistDropdownText">查看已添加黑名单</span>
                      <span class="za-multi-arrow">⌄</span>
                    </button>
                    <div class="za-multi-menu" data-role="companyBlacklistOptionMenu" hidden></div>
                  </div>
                  <div class="za-inline za-blacklist-actions" data-role="companyBlacklistActions">
                    <button type="button" data-action="removeCompanyBlacklistRule">删除选中</button>
                    <button type="button" class="za-danger-soft" data-action="clearCompanyBlacklistRules">全部删除</button>
                  </div>
                  <p class="za-hint">任意黑名单命中都会在沟通前跳过该公司。</p>
                </section>

                <section class="za-section" data-feature-section="appliedCompany">
                  <h3>已投递公司去重</h3>
                  <label class="za-check-line">
                    <input data-field="skipAppliedCompany" type="checkbox">
                    <span>跳过历史已投递过简历的公司</span>
                  </label>
                  <label class="za-check-line">
                    <input data-field="bossGreetingCountsAsApplied" type="checkbox">
                    <span>BOSS 沟通成功也计入（BOSS 需 HR 回复后才能发简历）</span>
                  </label>
                  <div class="za-inline">
                    <span class="za-muted-text" data-role="appliedCompanyCount"></span>
                    <button type="button" class="za-danger-soft" data-action="clearAppliedCompanies">清空名单</button>
                  </div>
                  <p class="za-hint">独立持久化，清理投递记录不会清除本名单。投递/沟通成功后自动记录公司名；想重新投某公司时点「清空名单」。</p>
                </section>

                <section class="za-section" data-feature-section="bossActive">
                  <h3>Boss活跃度筛选</h3>
                  <div class="za-selected-area" data-role="bossActiveSelectedList"></div>
                  <div class="za-multi-dropdown" data-role="bossActiveDropdown">
                    <button class="za-multi-trigger" type="button" data-action="toggleBossActiveDropdown" aria-expanded="false">
                      <span data-role="bossActiveDropdownText">选择 Boss 活跃度</span>
                      <span class="za-multi-arrow">⌄</span>
                    </button>
                    <div class="za-multi-menu" data-role="bossActiveOptionMenu" hidden></div>
                  </div>
                  <div class="za-inline za-boss-active-add">
                    <input data-role="bossActiveCustomInput" data-lock-field="bossActiveCustomInput" type="text" autocomplete="off" spellcheck="false" placeholder="添加自定义活跃度">
                    <button type="button" data-action="addBossActiveOption">添加</button>
                  </div>
                  <div class="za-option-chips" data-role="bossActiveCustomList"></div>
                  <p class="za-hint">不选择代表不过滤；内置选项固定，自定义选项可删除。</p>
                </section>

                <section class="za-section" data-feature-section="salaryFilter">
                  <h3>薪资筛选</h3>
                  <label class="za-check"><input data-field="salaryFilterEnabled" type="checkbox"> 启用薪资区间筛选</label>
                  <div class="za-grid-2">
                    <label>最低月薪（K）<input data-field="salaryMinK" type="number" min="0" step="0.5" placeholder="如 10"></label>
                    <label>最高月薪（K）<input data-field="salaryMaxK" type="number" min="0" step="0.5" placeholder="0 表示不限"></label>
                  </div>
                  <label>薪资匹配方式
                    <select data-field="salaryMatchMode">
                      <option value="contain">严格：岗位薪资区间需完全落在设定范围内</option>
                      <option value="overlap">宽松：与设定区间有重叠即保留</option>
                    </select>
                  </label>
                  <p class="za-salary-state" data-role="salaryFilterState">当前未启用</p>
                  <p class="za-hint">严格模式下最高填 10K 时，7000-12000 元会跳过；宽松模式则保留（有重叠）。未填的一端视为不限，“面议/保密”无法解析时保留；上下限都填 0 视为不启用。支持 8-12K、1.5-2万、20-30万/年、200元/天 等写法，13薪等未折算。</p>
                </section>

                <section class="za-section" data-feature-section="score">
                  <h3>评分筛选</h3>
                  <label class="za-check"><input data-field="scoreEnabled" type="checkbox"> 启用关键词评分</label>
                  <label class="za-check"><input data-field="scoreHighlight" type="checkbox"> 高亮岗位卡片</label>
                  <label class="za-check"><input data-field="scoreAutoSkipLow" type="checkbox"> 自动跳过低分岗位沟通</label>
                  <label class="za-check"><input data-field="scoreTitleNegativeReject" type="checkbox"> 岗位名含负面词直接跳过</label>
                  <label>正面关键词（逗号分隔）
                    <textarea data-field="scorePositive" rows="3" placeholder="命中加分，例如：Linux,Docker,运维"></textarea>
                  </label>
                  <label>负面关键词（逗号分隔）
                    <textarea data-field="scoreNegative" rows="3" placeholder="命中大幅扣分，例如：销售,直播,风电"></textarea>
                  </label>
                  <div class="za-grid-2">
                    <label>正面权重<input data-field="scorePositiveWeight" type="number" min="1" step="1"></label>
                    <label>负面权重<input data-field="scoreNegativeWeight" type="number" min="1" step="1"></label>
                  </div>
                  <div class="za-grid-2">
                    <label>岗位名加权<input data-field="scoreTitleBonus" type="number" min="0" step="1"></label>
                    <label>技能加权<input data-field="scoreSkillBonus" type="number" min="0" step="1"></label>
                  </div>
                  <div class="za-grid-2">
                    <label>负面·岗位名扣分<input data-field="scoreNegativeTitleBonus" type="number" min="0" step="1"></label>
                    <label style="align-items:flex-start">核心词必中
                      <textarea data-field="coreTerms" rows="2" placeholder="岗位需命中其一才投，留空不启用。如：Java,Spring,后端"></textarea>
                    </label>
                  </div>
                  <div class="za-grid-2">
                    <label>高分阈值<input data-field="scoreGoodThreshold" type="number" min="0" step="1"></label>
                    <label>中分阈值<input data-field="scoreMidThreshold" type="number" min="0" step="1"></label>
                  </div>
                  <div class="za-score-result" data-role="scoreResultList"></div>
                  <p class="za-hint">过滤规则：核心词必中优先（启用后岗位需命中其一才投）；岗位名直接含负面词则硬否决（不看分数，开启"岗位名含负面词直接跳过"时生效）；good/mid 通过；low 分且有正面词命中也通过；low 分无命中或有负面词命中则跳过。计分按长词优先去重（如 Java 与 Java后端 对同一段文字只计一次，不再叠分）；岗位名和技能命中额外加分；负面词在岗位名命中时按"负面·岗位名扣分"再额外扣。否定前缀（如"不招运维"）自动忽略。多词技能用空格分隔（如 Spring Boot）。</p>
                </section>

                <section class="za-section" data-feature-section="model">
                  <h3>模型配置</h3>
                  <label class="za-check"><input data-field="modelEnabled" type="checkbox"> 启用模型</label>
                  <label class="za-check"><input data-field="modelScoreEnabled" type="checkbox"> 模型语义评分（可选）</label>
                  <label>API 地址
                    <input data-field="modelBaseUrl" type="url" placeholder="https://api.openai.com/v1/chat/completions">
                  </label>
                  <label>API Key
                    <input data-field="modelApiKey" type="password" placeholder="sk-..." autocomplete="off">
                  </label>
                  <label>模型名称
                    <input data-field="modelName" type="text" placeholder="gpt-4o-mini">
                  </label>
                  <div class="za-inline">
                    <button type="button" data-action="testModel">测试模型</button>
                  </div>
                  <p class="za-hint">模型为可选能力：启用后评分会附加语义分（-10~+20）。API Key 仅保存在浏览器 localStorage，不会上传到其他位置。</p>
                </section>

                <section class="za-section za-list-section" data-feature-section="greetedList">
                  <h3>已沟通列表 <span class="za-list-count" data-role="greetedCount">0</span>
                    <button type="button" class="za-list-refresh" data-action="refreshGreeted" title="从本地记录重新读取">刷新</button>
                  </h3>
                  <div class="za-list-viewport" data-role="listViewport">
                    <div class="za-list-spacer" data-role="listSpacer"></div>
                    <div class="za-list-items" data-role="listItems"></div>
                  </div>
                </section>
              </div>

              <!-- 数据 Tab -->
              <div class="za-pane" data-tab-name="tabData" hidden>
                <section class="za-section">
                  <h3>数据概览</h3>
                  <div class="za-stat-grid">
                    <div class="za-stat-card">
                      <span class="za-stat-label">今日投递</span>
                      <strong class="za-stat-value za-stat-accent" data-role="dataStatToday">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">累计投递</span>
                      <strong class="za-stat-value" data-role="dataStatTotal">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">已跳过</span>
                      <strong class="za-stat-value" data-role="dataStatSkipped">0</strong>
                    </div>
                    <div class="za-stat-card">
                      <span class="za-stat-label">记录总数</span>
                      <strong class="za-stat-value" data-role="dataStatCount">0</strong>
                    </div>
                  </div>
                  <div class="za-trend" data-role="dataTrend"></div>
                  <p class="za-hint" data-role="dataStatsMeta">统计自本机岗位记录，启动投递后这里会显示数据</p>
                </section>

                <section class="za-section za-data-list-section">
                  <h3>最近记录</h3>
                  <div class="za-data-filters">
                    <input type="search" data-role="recordSearch" placeholder="搜索岗位或公司" autocomplete="off" spellcheck="false">
                    <select data-role="recordStatus">
                      <option value="">全部状态</option>
                      <option value="sent">已投递</option>
                      <option value="clicked">已点击</option>
                      <option value="skipped">已跳过</option>
                    </select>
                  </div>
                  <div class="za-record-list" data-role="recordList">
                    <div class="za-record-empty">暂无岗位记录</div>
                  </div>
                  <p class="za-hint" data-role="recordListMeta">启动投递后，这里会显示最近的岗位记录</p>
                </section>

                <section class="za-section" data-feature-section="export">
                  <h3>数据导出</h3>
                  <div class="za-inline">
                    <select data-field="exportType">
                      <option value="json">JSON</option>
                      <option value="xlsx">Excel</option>
                    </select>
                    <button type="button" data-action="export">导出岗位记录</button>
                  </div>
                </section>

                <section class="za-section" data-feature-section="cleanup">
                  <h3>数据清理</h3>
                  <label class="za-cleanup-time">删除此时间前的记录
                    <input data-field="clearBeforeTime" type="datetime-local">
                  </label>
                  <div class="za-inline">
                    <button type="button" data-action="clearRecordsByTime">按时间删除</button>
                    <button type="button" class="za-danger-soft" data-action="clearAllRecords">删除所有记录</button>
                  </div>
                  <p class="za-hint">按时间删除会使用发送时间，未发送记录使用点击或更新时间。</p>
                </section>
              </div>

              <!-- 日志 Tab -->
              <div class="za-pane" data-tab-name="tabLog" hidden>
                <section class="za-section">
                  <h3>本次运行</h3>
                  <div class="za-run-summary" data-role="runSummary">
                    <div class="za-run-summary-head">
                      <span class="za-run-summary-title" data-role="runSummaryTitle">尚未开始</span>
                      <span class="za-run-summary-state" data-role="runSummaryState">未开始</span>
                    </div>
                    <div class="za-run-summary-grid">
                      <div><span>时长</span><strong data-role="runDuration">--</strong></div>
                      <div><span>成功</span><strong data-role="runSuccess">0</strong></div>
                      <div><span>失败/异常</span><strong data-role="runFailed">0</strong></div>
                      <div><span>跳过</span><strong data-role="runSkipped">0</strong></div>
                    </div>
                    <p class="za-run-summary-reason" data-role="runReason">启动投递后，这里会显示本次运行结果</p>
                  </div>
                </section>

                <section class="za-section">
                  <h3>诊断日志</h3>

                  <div class="za-log-summary">
                    <div class="za-log-summary-main">
                      <span class="za-log-dot" data-role="debugLogDot"></span>
                      <div class="za-log-summary-text">
                        <div class="za-log-state" data-role="debugLogState">未开启</div>
                        <div class="za-log-meta" data-role="debugLogStatus">已保存 0 条事件</div>
                      </div>
                    </div>
                    <label class="za-switch" title="开启后把诊断事件保存到本机，便于导出排查">
                      <input data-role="debugLogEnabled" type="checkbox">
                      <span class="za-switch-track"></span>
                      <span class="za-switch-label">记录</span>
                    </label>
                  </div>

                  <div class="za-log-actions">
                    <button type="button" class="za-primary" data-action="copyDebugLogs">复制日志</button>
                    <button type="button" data-action="exportDebugLogs">导出</button>
                    <button type="button" class="za-danger-soft" data-action="clearDebugLogs">清除</button>
                  </div>
                  <p class="za-log-feedback" data-role="logFeedback" hidden></p>

                  <div class="za-log-filters">
                    <select data-role="logLevelFilter" title="按日志级别筛选">
                      <option value="">全部级别</option>
                      <option value="info">信息</option>
                      <option value="warn">警告</option>
                      <option value="error">错误</option>
                    </select>
                    <input data-role="logSearch" type="search" placeholder="搜索岗位 / 公司 / 事件" autocomplete="off" spellcheck="false">
                    <label class="za-log-autoscroll" title="新日志出现时自动滚动到底部">
                      <input data-role="logAutoScroll" type="checkbox" checked> 自动滚动
                    </label>
                  </div>

                  <div class="za-log-preview">
                    <div class="za-log-preview-head">
                      <span title="仅在投递运行期间记录，每次启动会清空上一轮">实时日志 · 运行时</span>
                      <span class="za-log-preview-tools">
                        <button type="button" class="za-log-format" data-action="toggleLogFormat" data-role="logFormatToggle">机器格式</button>
                        <span class="za-log-preview-count" data-role="logPanelCount">0</span>
                      </span>
                    </div>
                    <div class="za-log-preview-body" data-role="logPanelBody">
                      <div class="za-log-empty">运行后这里会实时显示事件</div>
                    </div>
                  </div>

                  <p class="za-hint">实时日志只在投递运行期间记录，每次启动会清空上一轮并最多保留 500 条；平时浏览岗位不产生日志。打开「记录」后事件才会保存到本机并支持导出，不会上传。级别和关键词筛选只影响当前显示与复制，不会删除记录。</p>
                </section>
              </div>
            </div>
          </div>

          <footer class="za-footer">
            <button type="button" class="za-primary" data-action="start">▶ 启动</button>
            <button type="button" class="za-danger" data-action="stop">■ 停止</button>
          </footer>

          <div class="za-resize-handle" data-ui-role="resizeHandle" title="拖拽调整窗口大小"></div>
        </aside>
      `;

      document.body.appendChild(root);
      runtime.ui = {
        root,
        panel: root.querySelector('.za-window'),
        window: root.querySelector('.za-window'),
        toggle: root.querySelector('.za-toggle'),
        status: root.querySelector('[data-role="status"]'),
        opacityIndicator: root.querySelector('[data-role="opacityIndicator"]'),
        resizeHandle: root.querySelector('[data-ui-role="resizeHandle"]'),
        featurePanel: root.querySelector('[data-role="featurePanel"]'),
        featureButton: root.querySelector('[data-action="toggleFeaturePanel"]'),
        featureBlockList: root.querySelector('[data-role="featureBlockList"]'),
        fastReplyInput: root.querySelector('[data-field="fastReplyIndex"]'),
        fastReplyTrigger: root.querySelector('[data-action="toggleFastReplyPicker"]'),
        fastReplyTriggerText: root.querySelector('[data-role="fastReplyTriggerText"]'),
        fastReplyPreview: root.querySelector('[data-role="fastReplyPreview"]'),
        fastReplyHint: root.querySelector('[data-role="fastReplyHint"]'),
        fastReplyBackdrop: root.querySelector('[data-role="fastReplyBackdrop"]'),
        fastReplyCount: root.querySelector('[data-role="fastReplyCount"]'),
        fastReplySearch: root.querySelector('[data-role="fastReplySearch"]'),
        fastReplyList: root.querySelector('[data-role="fastReplyList"]'),
        bossActiveDropdown: root.querySelector('[data-role="bossActiveDropdown"]'),
        bossActiveDropdownText: root.querySelector('[data-role="bossActiveDropdownText"]'),
        bossActiveSelectedList: root.querySelector('[data-role="bossActiveSelectedList"]'),
        bossActiveOptionMenu: root.querySelector('[data-role="bossActiveOptionMenu"]'),
        bossActiveCustomInput: root.querySelector('[data-role="bossActiveCustomInput"]'),
        bossActiveCustomList: root.querySelector('[data-role="bossActiveCustomList"]'),
        companyBlacklistDropdown: root.querySelector('[data-role="companyBlacklistDropdown"]'),
        companyBlacklistDropdownText: root.querySelector('[data-role="companyBlacklistDropdownText"]'),
        companyBlacklistOptionMenu: root.querySelector('[data-role="companyBlacklistOptionMenu"]'),
        companyBlacklistRemoveButton: root.querySelector('[data-action="removeCompanyBlacklistRule"]'),
        companyBlacklistClearButton: root.querySelector('[data-action="clearCompanyBlacklistRules"]'),
        companyBlacklistSelectedIds: new Set(),
        appliedCompanyCount: root.querySelector('[data-role="appliedCompanyCount"]'),
        debugLogEnabled: root.querySelector('[data-role="debugLogEnabled"]'),
        debugLogStatus: root.querySelector('[data-role="debugLogStatus"]'),
        debugLogState: root.querySelector('[data-role="debugLogState"]'),
        debugLogDot: root.querySelector('[data-role="debugLogDot"]'),
        logPanelBody: root.querySelector('[data-role="logPanelBody"]'),
        logPanelCount: root.querySelector('[data-role="logPanelCount"]'),
        logFormatToggle: root.querySelector('[data-role="logFormatToggle"]'),
        logBadge: root.querySelector('[data-role="logBadge"]'),
        logFeedback: root.querySelector('[data-role="logFeedback"]'),
        listViewport: root.querySelector('[data-role="listViewport"]'),
        listSpacer: root.querySelector('[data-role="listSpacer"]'),
        listItems: root.querySelector('[data-role="listItems"]'),
        greetedCount: root.querySelector('[data-role="greetedCount"]'),
        salaryFilterState: root.querySelector('[data-role="salaryFilterState"]'),
        greetedRows: [],
        rowHeight: 48,
        scoreResultList: root.querySelector('[data-role="scoreResultList"]'),
        logToggle: root.querySelector('[data-role="logToggle"]'),
        recordSearch: root.querySelector('[data-role="recordSearch"]'),
        recordStatus: root.querySelector('[data-role="recordStatus"]'),
        recordList: root.querySelector('[data-role="recordList"]'),
        recordListMeta: root.querySelector('[data-role="recordListMeta"]'),
        dataStatToday: root.querySelector('[data-role="dataStatToday"]'),
        dataStatTotal: root.querySelector('[data-role="dataStatTotal"]'),
        dataStatSkipped: root.querySelector('[data-role="dataStatSkipped"]'),
        dataStatCount: root.querySelector('[data-role="dataStatCount"]'),
        dataTrend: root.querySelector('[data-role="dataTrend"]'),
        dataStatsMeta: root.querySelector('[data-role="dataStatsMeta"]'),
        logLevelFilter: root.querySelector('[data-role="logLevelFilter"]'),
        logSearch: root.querySelector('[data-role="logSearch"]'),
        logAutoScroll: root.querySelector('[data-role="logAutoScroll"]'),
      };

      LogWindow.attachPanel(runtime.ui.logPanelBody, runtime.ui.logPanelCount, runtime.ui.logFormatToggle);
      LogWindow.attachRunSummary({
        title: root.querySelector('[data-role="runSummaryTitle"]'),
        state: root.querySelector('[data-role="runSummaryState"]'),
        duration: root.querySelector('[data-role="runDuration"]'),
        success: root.querySelector('[data-role="runSuccess"]'),
        failed: root.querySelector('[data-role="runFailed"]'),
        skipped: root.querySelector('[data-role="runSkipped"]'),
        reason: root.querySelector('[data-role="runReason"]'),
      });

      this.prepareConfigFields();
      this.renderFeatureBlockControls();
      this.bindEvents();
      this.applyConfigToForm();
      this.renderDebugLogControls();
      this.renderFastReplyOptions();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
      this.setFeaturePanelOpen(config.featurePanelOpen);
      this.setPanelOpen(config.panelOpen);
      this.scheduleConfigReapply();
      this.refreshGreetedList();
      this.refreshDataOverview();

      // 常用语是 BOSS 专属接口，仅在 BOSS 平台自动拉取，避免智联等平台请求 BOSS 接口报 404。
      if (currentPlatform?.id === 'boss' && (!config.fastReplies || !config.fastReplies.length)) {
        setTimeout(() => FastReplyService.refresh(false), 500);
      }
    },

    // 给脚本自己的配置控件设置独立字段名，并关闭浏览器自动填充/历史恢复。
    prepareConfigFields() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-field]').forEach((field) => {
        const key = field.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        field.setAttribute('autocomplete', 'off');
        field.setAttribute('autocorrect', 'off');
        field.setAttribute('autocapitalize', 'off');
        if (field.matches('input, textarea')) field.setAttribute('spellcheck', 'false');
        if (field.matches('input, textarea, select') && !field.name) {
          field.name = `zhipin-auto-${key}`;
        }
      });
    },

    // 部分浏览器会在 DOM 插入后异步恢复旧表单值；用户未触碰前用配置值覆盖回去。
    scheduleConfigReapply() {
      [0, 120, 600].forEach((delay) => {
        setTimeout(() => {
          if (!runtime.ui || runtime.configFormTouched) return;
          this.applyConfigToForm();
          this.renderFastReplyOptions();
          this.updateAppliedCompanyCount();
        }, delay);
      });
    },

    // 绑定面板按钮和表单事件；按钮只分发到对应 Service/Automation。
    bindEvents() {
      const root = runtime.ui.root;

      ['pointerdown', 'keydown', 'paste', 'drop'].forEach((eventName) => {
        root.addEventListener(eventName, (event) => this.noteConfigFieldInteraction(event), true);
      });

      root.addEventListener('click', (event) => {
        // Tab 切换
        const tabBtn = event.target && event.target.closest && event.target.closest('[data-tab-target]');
        if (tabBtn && tabBtn.dataset && tabBtn.dataset.tabTarget) {
          const targetName = tabBtn.dataset.tabTarget;
          this.switchTab(targetName);
          return;
        }

        const eventTarget = event.target && event.target.nodeType === 1
          ? event.target
          : event.target && event.target.parentElement;

        if (eventTarget && eventTarget.dataset && eventTarget.dataset.role === 'fastReplyBackdrop') {
          this.setFastReplyPickerOpen(false);
          return;
        }

        const target = eventTarget && eventTarget.closest('[data-action], .za-toggle');
        if (!target) return;

        const action = target.dataset.action || 'toggle';
        if (action === 'toggleFeaturePanel') {
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFeaturePanelOpen(!this.isFeaturePanelOpen());
          return;
        }
        if (action === 'closeFeaturePanel') {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (action === 'refreshGreeted') {
          this.refreshGreetedList({ scrollTop: true });
          this.setStatus('已刷新已沟通列表', 'info');
          return;
        }
        if (action === 'toggleFeatureBlock') {
          this.toggleFeatureBlock(target.dataset.featureId);
          return;
        }
        if (action === 'toggleFastReplyPicker') {
          this.setFeaturePanelOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setFastReplyPickerOpen(!this.isFastReplyPickerOpen());
          return;
        }
        if (action === 'closeFastReplyPicker') {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (action === 'selectFastReply') {
          this.selectFastReply(target.dataset.index);
          return;
        }
        if (action === 'clearFastReplySearch') {
          this.setFastReplySearch('');
          return;
        }
        if (action === 'toggleBossActiveDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setCompanyBlacklistDropdownOpen(false);
          this.setBossActiveDropdownOpen(!this.isBossActiveDropdownOpen());
          return;
        }
        if (action === 'toggleCompanyBlacklistDropdown') {
          this.setFeaturePanelOpen(false);
          this.setFastReplyPickerOpen(false);
          this.setBossActiveDropdownOpen(false);
          this.setCompanyBlacklistDropdownOpen(!this.isCompanyBlacklistDropdownOpen());
          return;
        }
        if (action !== 'stop') this.unlockStatus();
        if (action === 'toggle') this.setPanelOpen(!config.panelOpen);
        if (action === 'minimizeWindow') this.minimizeWindow();
        if (action === 'increaseOpacity') this.setOpacity(Math.min(1, (runtime.uiOpacity ?? 1) + 0.1));
        if (action === 'decreaseOpacity') this.setOpacity(Math.max(0.3, (runtime.uiOpacity ?? 1) - 0.1));
        if (action === 'refreshFastReplies') FastReplyService.refresh(true);
        if (action === 'start') Automation.start();
        if (action === 'stop') Automation.stop('已停止', { manual: true });
        if (action === 'export') Exporter.exportRecords();
        if (action === 'exportDebugLogs') DebugLogService.exportLogs();
        if (action === 'clearRecordsByTime') RecordCleaner.clearByTime();
        if (action === 'clearAllRecords') RecordCleaner.clearAll();
        if (action === 'clearDebugLogs') DebugLogService.clearLogs();
        if (action === 'testModel') ScoreService.testModel();
        if (action === 'toggleLogWindow') this.openLogTab();
        if (action === 'copyDebugLogs') LogWindow.copyLogs();
        if (action === 'toggleLogFormat') LogWindow.toggleFormat();
        if (action === 'addCompanyBlacklistRule') this.addCompanyBlacklistRule();
        if (action === 'removeCompanyBlacklistRule') this.removeCompanyBlacklistRule(target.dataset.id);
        if (action === 'clearCompanyBlacklistRules') this.clearCompanyBlacklistRules();
        if (action === 'clearAppliedCompanies') this.clearAppliedCompanies();
        if (action === 'addBossActiveOption') this.addBossActiveCustomOption();
        if (action === 'deleteBossActiveOption') this.deleteBossActiveCustomOption(target.dataset.value);
        if (action === 'removeBossActiveSelection') this.removeBossActiveSelection(target.dataset.value);
        if (action !== 'toggleBossActiveDropdown' && !target.closest('[data-role="bossActiveDropdown"]')) {
          this.setBossActiveDropdownOpen(false);
        }
        if (
          action !== 'toggleCompanyBlacklistDropdown' &&
          !target.closest('[data-role="companyBlacklistDropdown"]') &&
          !target.closest('[data-role="companyBlacklistActions"]')
        ) {
          this.setCompanyBlacklistDropdownOpen(false);
        }
      });

      root.addEventListener('input', (event) => {
        const inputRole = event.target && event.target.dataset && event.target.dataset.role;
        if (inputRole === 'fastReplySearch') {
          this.renderFastReplyPickerList();
          return;
        }
        if (inputRole === 'recordSearch') {
          this.renderRecordList(runtime.dataOverviewRows || []);
          return;
        }
        if (inputRole === 'logSearch') {
          LogWindow.setFilter({ keyword: event.target.value });
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        this.saveFormToConfig({ event });
        this.syncSalaryFilterState(event);
      });
      root.addEventListener('change', (event) => {
        const changeRole = event.target && event.target.dataset && event.target.dataset.role;
        if (changeRole === 'debugLogEnabled') {
          DebugLogService.setEnabled(event.target.checked);
          return;
        }
        if (changeRole === 'recordStatus') {
          this.renderRecordList(runtime.dataOverviewRows || []);
          return;
        }
        if (changeRole === 'logLevelFilter') {
          LogWindow.setFilter({ level: event.target.value });
          return;
        }
        if (changeRole === 'logAutoScroll') {
          LogWindow.setFilter({ autoScroll: event.target.checked });
          return;
        }
        if (this.shouldIgnoreConfigFieldEvent(event)) return;
        this.noteCompanyFilterEdit(event);
        if (event.target && event.target.dataset && event.target.dataset.role === 'companyBlacklistRuleOption') {
          this.setCompanyBlacklistRuleSelected(event.target.value, event.target.checked, true);
          return;
        }
        if (event.target && event.target.dataset && event.target.dataset.role === 'bossActiveOption') {
          this.setBossActiveOptionSelected(event.target.value, event.target.checked, true);
          return;
        }
        this.saveFormToConfig({ event });
        this.applyModeVisibility();
        this.syncSalaryFilterState(event);
      });

      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.isFeaturePanelOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFeaturePanelOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isFastReplyPickerOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isCompanyBlacklistDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (event.key === 'Escape' && this.isBossActiveDropdownOpen()) {
          event.preventDefault();
          event.stopPropagation();
          this.setBossActiveDropdownOpen(false);
          return;
        }

        if (event.key === 'Enter' && event.target && event.target.dataset && event.target.dataset.role === 'fastReplySearch') {
          const firstOption = runtime.ui.fastReplyList && runtime.ui.fastReplyList.querySelector('[data-action="selectFastReply"]');
          if (firstOption) {
            event.preventDefault();
            this.selectFastReply(firstOption.dataset.index);
          }
          return;
        }

        if (event.key !== 'Enter') return;
        if (event.target && event.target.dataset && event.target.dataset.field === 'companyBlacklistValue') {
          event.preventDefault();
          this.addCompanyBlacklistRule();
          return;
        }
        if (!event.target || !event.target.dataset || event.target.dataset.role !== 'bossActiveCustomInput') return;
        event.preventDefault();
        this.addBossActiveCustomOption();
      });

      // 节流滚动渲染：requestAnimationFrame 确保每帧最多渲染一次
      let _virtualListRaf = null;
      runtime.ui.listViewport.addEventListener('scroll', () => {
        if (_virtualListRaf) return;
        _virtualListRaf = requestAnimationFrame(() => {
          _virtualListRaf = null;
          this.renderVirtualList();
        });
      });

      pageWindow.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (this.isFeaturePanelOpen()) {
          this.setFeaturePanelOpen(false);
          return;
        }
        if (this.isFastReplyPickerOpen()) {
          this.setFastReplyPickerOpen(false);
          return;
        }
        if (this.isCompanyBlacklistDropdownOpen()) {
          this.setCompanyBlacklistDropdownOpen(false);
          return;
        }
        if (this.isBossActiveDropdownOpen()) {
          this.setBossActiveDropdownOpen(false);
          return;
        }
        Automation.stop('已停止', { manual: true });
      });

      pageWindow.addEventListener('click', (event) => {
        if (!runtime.ui || !runtime.ui.root || this.isEventFromUiRoot(event)) return;
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      });

      // ============== 面板可拖拽 ==============
      this.initDraggable(root);
      // ============== 面板可调整大小 ==============
      this.initResizable(root);
      // ============== 透明度初始化 + 快捷键 ==============
      this.initOpacityAndShortcuts(root);
      // ============== Tab 初始化 ==============
      const savedTab = localStorage.getItem('__zhipin_ui_tab__') || 'tabDelivery';
      this.switchTab(savedTab, true);
    },

    // 切换 Tab
    switchTab(targetName, silent) {
      const ui = runtime.ui;
      if (!ui || !ui.root) return;
      // 兼容历史保存的 Tab 名（如已下线的复聊页）：目标面板不存在时回退到投递页。
      const paneExists = Array.from(ui.root.querySelectorAll('.za-pane'))
        .some((pane) => pane.dataset.tabName === targetName);
      if (!paneExists) targetName = 'tabDelivery';
      // 清除旧激活
      ui.root.querySelectorAll('.za-tab').forEach((btn) => {
        const isActive = btn.dataset.tabTarget === targetName;
        btn.classList.toggle('za-tab-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
      });
      ui.root.querySelectorAll('.za-pane').forEach((content) => {
        const isActive = content.dataset.tabName === targetName;
        content.classList.toggle('za-pane-active', isActive);
        if (isActive) {
          content.removeAttribute('hidden');
        } else {
          content.setAttribute('hidden', '');
        }
      });
      // 切到日志页时补渲染一次内存中的实时日志并清空未读角标。
      if (targetName === 'tabLog') {
        LogWindow.renderPanelPreview();
        LogWindow.updateRunSummary();
        LogWindow.clearBadge();
      }
      if (targetName === 'tabData') {
        this.refreshDataOverview();
      }
      if (targetName === 'tabDelivery') {
        this.refreshGreetedList();
      }
      // 激活投递 Tab 时，显示启动/停止按钮；其他 Tab 隐藏底部启动按钮
      const footer = ui.root.querySelector('.za-footer');
      if (footer) {
        if (targetName === 'tabDelivery') {
          footer.style.display = '';
          const startBtn = footer.querySelector('[data-action="start"]');
          const stopBtn = footer.querySelector('[data-action="stop"]');
          if (startBtn) startBtn.style.display = '';
          if (stopBtn) stopBtn.style.display = '';
        } else {
          footer.style.display = 'none';
        }
      }
      if (!silent) {
        try { localStorage.setItem('__zhipin_ui_tab__', targetName); } catch (_) {}
      }
    },

    // 最小化窗口（隐藏内容，只显示标题栏）
    minimizeWindow() {
      const ui = runtime.ui;
      if (!ui || !ui.window) return;
      ui.window.classList.toggle('za-window-minimized');
    },

    // 初始化透明度和快捷键
    initOpacityAndShortcuts(root) {
      let savedOpacity = 1;
      try {
        const v = parseFloat(localStorage.getItem('__zhipin_ui_opacity__'));
        if (!isNaN(v) && v >= 0.3 && v <= 1) savedOpacity = v;
      } catch (_) {}
      this.setOpacity(savedOpacity, true);

      // 快捷键：Ctrl+↑ 提高透明度，Ctrl+↓ 降低透明度
      const pageWindow = getAccessibleDocuments()[0] && getAccessibleDocuments()[0].defaultView || window;
      pageWindow.addEventListener('keydown', (event) => {
        if (!event.ctrlKey) return;
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          this.setOpacity(Math.min(1, (runtime.uiOpacity ?? 1) + 0.1));
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          this.setOpacity(Math.max(0.3, (runtime.uiOpacity ?? 1) - 0.1));
        }
      });
    },

    // 设置面板透明度
    setOpacity(value, skipSave) {
      runtime.uiOpacity = Number(value) || 1;
      if (runtime.ui && runtime.ui.panel) {
        runtime.ui.panel.style.setProperty('opacity', String(runtime.uiOpacity));
      }
      if (runtime.ui && runtime.ui.toggle) {
        runtime.ui.toggle.style.setProperty('opacity', String(Math.min(1, runtime.uiOpacity + 0.2)));
      }
      if (runtime.ui && runtime.ui.opacityIndicator) {
        runtime.ui.opacityIndicator.textContent = Math.round(runtime.uiOpacity * 100) + '%';
      }
      if (!skipSave) {
        try { localStorage.setItem('__zhipin_ui_opacity__', String(runtime.uiOpacity)); } catch (_) {}
      }
    },

    // 初始化拖拽（头部拖拽面板）- 使用 pointer 事件 + pointerCapture，确保拖拽稳定
    initDraggable(root) {
      const header = root.querySelector('[data-ui-role="draggableHeader"]');
      const panel = root.querySelector('.za-window');
      if (!header || !panel) return;

      let dragState = null;
      // 恢复上次位置
      try {
        const savedPos = localStorage.getItem('__zhipin_ui_pos__');
        if (savedPos) {
          const pos = JSON.parse(savedPos);
          if (typeof pos.left === 'number' && typeof pos.top === 'number') {
            panel.style.left = pos.left + 'px';
            panel.style.top = pos.top + 'px';
            panel.style.right = 'auto';
          }
        }
      } catch (_) {}

      const onDown = (event) => {
        // 只拦截实际的按钮和输入元素，不拦截容器（如 .za-title、.za-title-text 等）
        if (event.target.closest('button, input, textarea, select')) return;
        const rect = panel.getBoundingClientRect();
        dragState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          panelLeft: rect.left,
          panelTop: rect.top,
          panelWidth: rect.width,
          moved: false,
        };
        // pointerCapture 确保拖拽过程中所有 pointer 事件都派发给 header，即使鼠标移出 header
        try { header.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
      };

      const onMove = (event) => {
        if (!dragState) return;
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        let newLeft = dragState.panelLeft + dx;
        let newTop = dragState.panelTop + dy;
        // 边界限制：防止完全拖出屏幕（至少保留 80px 可见）
        const minLeft = -dragState.panelWidth + 80;
        const maxLeft = winW - 80;
        const minTop = 0;
        const maxTop = winH - 40;
        newLeft = Math.min(maxLeft, Math.max(minLeft, newLeft));
        newTop = Math.min(maxTop, Math.max(minTop, newTop));
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
      };

      const onUp = (event) => {
        if (!dragState) return;
        if (dragState.moved) {
          try {
            const rect = panel.getBoundingClientRect();
            localStorage.setItem('__zhipin_ui_pos__', JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
          } catch (_) {}
        }
        try { header.releasePointerCapture(dragState.pointerId); } catch (_) {}
        dragState = null;
      };

      header.addEventListener('pointerdown', onDown);
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    },

    // 初始化窗口调整大小（右下角拖拽）
    initResizable(root) {
      const handle = root.querySelector('[data-ui-role="resizeHandle"]');
      const panel = root.querySelector('.za-window');
      if (!handle || !panel) return;

      let resizeState = null;

      // 恢复上次大小
      try {
        const savedSize = localStorage.getItem('__zhipin_ui_size__');
        if (savedSize) {
          const size = JSON.parse(savedSize);
          if (size.width && size.height) {
            panel.style.width = size.width + 'px';
            panel.style.height = size.height + 'px';
          }
        }
      } catch (_) {}

      const onDown = (event) => {
        const rect = panel.getBoundingClientRect();
        resizeState = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startW: rect.width,
          startH: rect.height,
        };
        try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
        event.stopPropagation();
      };

      const onMove = (event) => {
        if (!resizeState) return;
        const dx = event.clientX - resizeState.startX;
        const dy = event.clientY - resizeState.startY;
        const minW = 320;
        const minH = 240;
        const maxW = Math.max(minW, window.innerWidth - 20);
        const maxH = Math.max(minH, window.innerHeight - 20);
        const newW = Math.min(maxW, Math.max(minW, resizeState.startW + dx));
        const newH = Math.min(maxH, Math.max(minH, resizeState.startH + dy));
        panel.style.width = newW + 'px';
        panel.style.height = newH + 'px';
      };

      const onUp = (event) => {
        if (!resizeState) return;
        try {
          const rect = panel.getBoundingClientRect();
          localStorage.setItem('__zhipin_ui_size__', JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) }));
        } catch (_) {}
        try { handle.releasePointerCapture(resizeState.pointerId); } catch (_) {}
        resizeState = null;
      };

      handle.addEventListener('pointerdown', onDown);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },

    // 记录用户真实触碰过配置控件，用于区分浏览器自动填充事件。
    noteConfigFieldInteraction(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return;
      field.dataset.userTouched = 'true';
      runtime.configFormTouched = true;
    },

    // 拦截浏览器自动恢复的旧表单值，避免覆盖 localStorage 中的真实配置。
    shouldIgnoreConfigFieldEvent(event) {
      const field = this.getConfigFieldFromTarget(event && event.target);
      if (!field) return false;

      const key = field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return true;

      const hasUserSignal = field.dataset.userTouched === 'true' || document.activeElement === field || event.isTrusted === false;
      if (hasUserSignal) return false;

      this.restoreConfigFieldValue(field);
      logDebugEvent('ignored_config_autofill_event', {
        field: key,
        value: summarizeLongText(this.readConfigFieldValue(field)),
      }, 'warn');
      return true;
    },

    // 从任意事件目标向上查找脚本配置字段，并排除面板外元素。
    getConfigFieldFromTarget(target) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !target || !target.closest) return null;
      const field = target.closest('[data-field]');
      return field && root.contains(field) ? field : null;
    },

    // 判断事件是否起源于脚本 UI。composedPath 可覆盖点击后 DOM 被重绘移除的场景。
    isEventFromUiRoot(event) {
      const root = runtime.ui && runtime.ui.root;
      if (!root || !event) return false;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      if (path && path.includes(root)) return true;
      return Boolean(event.target && root.contains(event.target));
    },

    // 判断事件目标是否是问候模式/文本来源的单选项。
    isModeInput(target) {
      return Boolean(target && target.matches && target.matches('input[name="za-greeting-mode"], input[name="za-text-source"]'));
    },

    // 读取配置字段的 JS 值，统一处理 checkbox 和 number。
    readConfigFieldValue(field) {
      if (!field) return '';
      if (field.type === 'checkbox') return Boolean(field.checked);
      // 数字框留空保留为 ''，让读取方能区分"清空（用默认值）"和"显式填 0"。
      if (field.type === 'number') return field.value === '' ? '' : Number(field.value);
      return field.value;
    },

    // 将配置值写回表单字段，避免各处重复处理 checkbox/空值。
    setConfigFieldValue(field, value) {
      if (!field) return;
      if (field.type === 'checkbox') {
        field.checked = Boolean(value);
      } else {
        field.value = value == null ? '' : value;
      }
    },

    // 自动填充事件被忽略时，把字段恢复到当前配置值。
    restoreConfigFieldValue(field) {
      const key = field && field.dataset && field.dataset.field;
      if (!CONFIG_FIELD_KEY_SET.has(key)) return;
      this.setConfigFieldValue(field, config[key]);
    },

    // 判断板块管理选择区是否展开。
    isFeaturePanelOpen() {
      return Boolean(runtime.ui && runtime.ui.featurePanel && !runtime.ui.featurePanel.hidden);
    },

    // 展开/收起板块管理选择区；展开状态持久化，方便刷新后保持用户的工作上下文。
    setFeaturePanelOpen(open) {
      if (!runtime.ui || !runtime.ui.featurePanel) return;
      saveConfig({ featurePanelOpen: Boolean(open) });
      runtime.ui.featurePanel.hidden = !config.featurePanelOpen;
      runtime.ui.root.classList.toggle('za-feature-open', config.featurePanelOpen);
      if (runtime.ui.featureButton) {
        runtime.ui.featureButton.setAttribute('aria-expanded', config.featurePanelOpen ? 'true' : 'false');
      }
    },

    // 根据板块元数据渲染开关按钮；新增板块只需要补 FEATURE_BLOCK_DEFINITIONS。
    renderFeatureBlockControls() {
      if (!runtime.ui || !runtime.ui.featureBlockList) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.featureBlockList.innerHTML = FEATURE_BLOCK_DEFINITIONS.map((item) => {
        const enabled = blocks[item.id];
        const enabledClass = enabled ? ' za-enabled' : '';
        const readonlyClass = item.readonly ? ' za-readonly' : '';
        const stateText = item.readonly ? '固定' : enabled ? '开启' : '关闭';
        const disabled = item.readonly ? ' disabled' : '';
        const title = item.readonly
          ? `${item.title}固定开启`
          : `${enabled ? '关闭' : '开启'}${item.title}`;
        return `
          <button type="button" class="za-feature-switch${enabledClass}${readonlyClass}" data-action="toggleFeatureBlock" data-feature-id="${escapeHtml(item.id)}" aria-pressed="${enabled ? 'true' : 'false'}" title="${escapeHtml(title)}"${disabled}>
            <span>${escapeHtml(item.title)}</span>
            <span class="za-feature-state">${escapeHtml(stateText)}</span>
          </button>
        `;
      }).join('');
    },

    // 切换单个板块的显示状态，只读板块不允许关闭。
    toggleFeatureBlock(featureId) {
      const id = normalizeText(featureId);
      if (!FEATURE_BLOCK_ID_SET.has(id)) return;

      const definition = FEATURE_BLOCK_DEFINITIONS.find((item) => item.id === id);
      if (!definition || definition.readonly) return;

      const nextBlocks = normalizeFeatureBlocks(config.featureBlocks);
      nextBlocks[id] = !nextBlocks[id];
      saveConfig({ featureBlocks: nextBlocks });
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
    },

    // 把板块管理开关应用到实际 section；隐藏只影响面板展示，不清空已有配置。
    applyFeatureBlockVisibility() {
      if (!runtime.ui || !runtime.ui.root) return;

      const blocks = normalizeFeatureBlocks(config.featureBlocks);
      runtime.ui.root.querySelectorAll('[data-feature-section]').forEach((section) => {
        const id = section.dataset.featureSection;
        section.hidden = !blocks[id];
      });

      if (!blocks.companyBlacklist) this.setCompanyBlacklistDropdownOpen(false);
      if (!blocks.bossActive) this.setBossActiveDropdownOpen(false);
    },

    // 展开/收起面板并持久化到配置。
    setPanelOpen(open) {
      if (!open) {
        this.setFeaturePanelOpen(false);
        this.setFastReplyPickerOpen(false);
      }
      saveConfig({ panelOpen: Boolean(open) });
      runtime.ui.root.classList.toggle('za-open', config.panelOpen);
    },

    // 标题栏 📋 入口：打开面板并切到日志页，滚动到实时日志区域。
    openLogTab() {
      this.setPanelOpen(true);
      this.switchTab('tabLog');
      const body = runtime.ui && runtime.ui.logPanelBody;
      if (body && body.scrollIntoView) {
        try { body.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      }
    },

    // 日志页内的操作反馈（顶部状态条在「投递」页，切到日志页后看不到）。
    setLogStatus(text, type) {
      const el = runtime.ui && runtime.ui.logFeedback;
      if (!el) return;
      if (this._logFeedbackTimer) clearTimeout(this._logFeedbackTimer);
      el.textContent = text || '';
      el.dataset.type = type || 'info';
      el.hidden = !text;
      if (!text) return;
      this._logFeedbackTimer = setTimeout(() => {
        el.hidden = true;
        el.textContent = '';
      }, 2600);
    },

    // 将配置写回表单控件，页面刷新或首次挂载时调用。
    applyConfigToForm() {
      const root = runtime.ui.root;
      this.clearAutoSyncedCompanyFilter();

      root.querySelectorAll('input[name="za-greeting-mode"]').forEach((input) => {
        input.checked = input.value === config.greetingMode;
      });
      root.querySelectorAll('input[name="za-text-source"]').forEach((input) => {
        input.checked = input.value === config.textSource;
      });

      for (const field of root.querySelectorAll('[data-field]')) {
        const key = field.dataset.field;
        if (key === 'fastReplyIndex') continue;
        this.setConfigFieldValue(field, config[key]);
      }

      this.applyModeVisibility();
      this.renderFeatureBlockControls();
      this.applyFeatureBlockVisibility();
      this.renderDebugLogControls();
      this.renderCompanyBlacklistRules();
      this.renderBossActiveFilterOptions();
      this.renderSalaryFilterState();
    },

    // 薪资区间填写正数后自动勾选启用，避免只填了数值却忘记开开关。
    syncSalaryFilterState(event) {
      if (!runtime.ui || !runtime.ui.root) return;
      const field = event && event.target && event.target.dataset && event.target.dataset.field;
      if ((field === 'salaryMinK' || field === 'salaryMaxK')
        && Number(event.target.value) > 0
        && !config.salaryFilterEnabled) {
        saveConfig({ salaryFilterEnabled: true });
        const checkbox = runtime.ui.root.querySelector('[data-field="salaryFilterEnabled"]');
        if (checkbox) checkbox.checked = true;
      }
      this.renderSalaryFilterState();
    },

    // 显示薪资筛选的实时状态，能直接看出是否生效、生效区间与匹配方式。
    renderSalaryFilterState() {
      const el = runtime.ui && runtime.ui.salaryFilterState;
      if (!el) return;
      el.classList.remove('za-on', 'za-warn');
      if (!config.salaryFilterEnabled) {
        const minK = Math.max(0, Number(config.salaryMinK) || 0);
        const maxK = Math.max(0, Number(config.salaryMaxK) || 0);
        if (minK > 0 || maxK > 0) {
          el.textContent = '当前未启用：已填区间，请勾选上方“启用薪资区间筛选”';
          el.classList.add('za-warn');
        } else {
          el.textContent = '当前未启用';
        }
        return;
      }
      const required = getSalaryFilterRange();
      if (!required.active) {
        el.textContent = '已勾选启用，但上下限都是 0，暂不生效';
        return;
      }
      const min = required.minK > 0 ? `${formatSalaryK(required.minK)}K` : '';
      const max = required.maxK > 0 ? `${formatSalaryK(required.maxK)}K` : '';
      const mode = config.salaryMatchMode === 'overlap' ? '宽松' : '严格';
      const rangeText = min && max ? `${min}-${max}` : (min ? `${min} 以上` : `${max} 以下`);
      el.textContent = `当前生效（${mode}）：${rangeText}`;
      el.classList.add('za-on');
    },

    // 调试日志不属于运行配置，单独同步本地开关和日志条数。
    renderDebugLogControls() {
      if (!runtime.ui) return;
      const enabled = isDebugEnabled();
      if (runtime.ui.debugLogEnabled) {
        runtime.ui.debugLogEnabled.checked = enabled;
      }
      if (runtime.ui.debugLogStatus) {
        const count = loadStoredDebugEvents().length;
        runtime.ui.debugLogStatus.textContent = `已保存 ${count} 条事件`;
      }
      if (runtime.ui.debugLogState) {
        runtime.ui.debugLogState.textContent = enabled ? '记录中' : '未开启';
      }
      if (runtime.ui.debugLogDot) {
        runtime.ui.debugLogDot.dataset.on = enabled ? '1' : '0';
      }
    },

    // 从表单读取配置并保存；运行中会跳过被锁定的字段。
    saveFormToConfig(options) {
      const root = runtime.ui.root;
      const next = {};
      const eventTarget = options && options.event && options.event.target;
      const eventField = this.getConfigFieldFromTarget(eventTarget);
      const selectedMode = root.querySelector('input[name="za-greeting-mode"]:checked');
      if (selectedMode) next.greetingMode = selectedMode.value;
      const selectedTextSource = root.querySelector('input[name="za-text-source"]:checked');
      if (selectedTextSource) next.textSource = selectedTextSource.value;

      if (eventTarget && !eventField && !this.isModeInput(eventTarget)) {
        return;
      }

      if (eventField) {
        const key = eventField.dataset.field;
        if (!CONFIG_FIELD_KEY_SET.has(key)) return;
        if (key === 'companyFilterValue' && !this.shouldSaveCompanyFilterValue(eventField, eventTarget)) {
          delete next.companyFilterValue;
        } else {
          next[key] = this.readConfigFieldValue(eventField);
        }
      } else if (!eventTarget) {
        // 无事件来源时只刷新模式开关，不把浏览器可能恢复的隐藏字段值写回配置。
        const changedKeys = Object.keys(next).filter((key) => next[key] !== config[key]);
        if (!changedKeys.length) return;
      }

      if (Object.prototype.hasOwnProperty.call(next, 'fastReplyIndex')) {
        next.fastReplyIndex = Number(next.fastReplyIndex || 0);
      }
      saveConfig(next);
    },

    // 标记公司过滤输入框是否被用户手动编辑，避免被搜索词自动覆盖。
    noteCompanyFilterEdit(event) {
      const target = event && event.target;
      if (target && target.dataset && target.dataset.field === 'companyFilterValue') {
        runtime.companyFilterEdited = true;
        target.dataset.userEdited = 'true';
      }
    },

    // 判断公司过滤值是否应该写入配置，区分自动同步和用户输入。
    shouldSaveCompanyFilterValue(field, eventTarget) {
      if (!field) return false;
      if (runtime.companyFilterEdited || field.dataset.userEdited === 'true') return true;
      if (eventTarget === field) return true;
      return normalizeText(field.value) !== normalizeText(getCurrentSearchQuery());
    },

    // 用户切换过滤模式时，如果过滤值只是自动同步的搜索词，则清空。
    clearAutoSyncedCompanyFilter() {
      const query = normalizeText(getCurrentSearchQuery());
      if (!query || !config.companyFilterValue) return;
      if (normalizeText(config.companyFilterValue) !== query) return;

      saveConfig({ companyFilterValue: '' });
    },

    // 根据问候语模式/自定义文本来源，显示或隐藏对应配置块。
    applyModeVisibility() {
      const root = runtime.ui.root;
      root.querySelectorAll('[data-mode-block]').forEach((block) => {
        block.hidden = block.dataset.modeBlock !== config.greetingMode;
      });

      root.querySelectorAll('[data-text-source-block]').forEach((block) => {
        block.hidden = block.dataset.textSourceBlock !== config.textSource;
      });
      if (config.greetingMode !== 'fastReply') this.setFastReplyPickerOpen(false);
    },

    // 渲染常用语选择入口和预览；弹层列表用普通 DOM 承载长文本，避免原生 select 撑宽面板。
    renderFastReplyOptions() {
      if (!runtime.ui) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const selected = replies[selectedIndex];
      const selectedText = replies.length
        ? normalizeMessageText((selected && selected.text) || `常用语 ${selectedIndex + 1}`)
        : APP.defaultGreetingText;

      if (runtime.ui.fastReplyInput) {
        runtime.ui.fastReplyInput.value = String(selectedIndex);
      }
      if (runtime.ui.fastReplyTriggerText) {
        runtime.ui.fastReplyTriggerText.textContent = replies.length
          ? `已选 常用语 ${selectedIndex + 1}`
          : '未获取常用语';
      }
      if (runtime.ui.fastReplyTrigger) {
        const running = runtime.ui.root.classList.contains('za-running');
        runtime.ui.fastReplyTrigger.disabled = running || !replies.length;
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', this.isFastReplyPickerOpen() ? 'true' : 'false');
      }
      if (runtime.ui.fastReplyPreview) {
        runtime.ui.fastReplyPreview.textContent = selectedText;
        runtime.ui.fastReplyPreview.dataset.empty = replies.length ? 'false' : 'true';
      }

      runtime.ui.fastReplyHint.textContent = replies.length
        ? `已获取 ${replies.length} 条常用语；发送时会把所选文本直接注入聊天框。`
        : '获取常用语失败或未刷新时，会把默认问候语直接注入聊天框。';
      this.renderFastReplyPickerList();
    },

    // 计算常用语安全索引，防止刷新后缓存数量变化造成越界。
    getSafeFastReplyIndex(replies) {
      const total = Array.isArray(replies) ? replies.length : 0;
      if (!total) return 0;

      const index = Number(config.fastReplyIndex || 0);
      if (!Number.isFinite(index)) return 0;
      return Math.min(Math.max(Math.floor(index), 0), total - 1);
    },

    // 渲染常用语弹层列表，并按搜索词过滤候选项。
    renderFastReplyPickerList() {
      if (!runtime.ui || !runtime.ui.fastReplyList) return;

      const replies = config.fastReplies || [];
      const selectedIndex = this.getSafeFastReplyIndex(replies);
      const keyword = normalizeText(runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value).toLowerCase();
      const matchedReplies = replies
        .map((item, index) => ({
          index,
          text: normalizeMessageText((item && item.text) || `常用语 ${index + 1}`),
        }))
        .filter((item) => !keyword || item.text.toLowerCase().includes(keyword));

      if (runtime.ui.fastReplyCount) {
        runtime.ui.fastReplyCount.textContent = keyword
          ? `${matchedReplies.length}/${replies.length} 条`
          : `${replies.length} 条`;
      }

      runtime.ui.fastReplyList.innerHTML = matchedReplies.length
        ? matchedReplies.map((item) => {
            const selectedClass = item.index === selectedIndex ? ' za-selected' : '';
            const selectedLabel = item.index === selectedIndex ? '<span class="za-fast-reply-selected-mark">当前选中</span>' : '';
            return `
              <button type="button" class="za-fast-reply-option${selectedClass}" data-action="selectFastReply" data-index="${item.index}" aria-pressed="${item.index === selectedIndex ? 'true' : 'false'}">
                <span class="za-fast-reply-option-meta">常用语 ${item.index + 1}${selectedLabel}</span>
                <span class="za-fast-reply-option-text">${escapeHtml(item.text)}</span>
              </button>
            `;
          }).join('')
        : `<div class="za-fast-reply-empty">${replies.length ? '没有匹配的常用语' : '暂无常用语，请先刷新'}</div>`;
    },

    // 判断常用语选择弹层是否打开。
    isFastReplyPickerOpen() {
      return Boolean(runtime.ui && runtime.ui.fastReplyBackdrop && !runtime.ui.fastReplyBackdrop.hidden);
    },

    // 打开/关闭常用语选择弹层，并在关闭时清空搜索框。
    setFastReplyPickerOpen(open) {
      if (!runtime.ui || !runtime.ui.fastReplyBackdrop) return;

      const replies = config.fastReplies || [];
      const trigger = runtime.ui.fastReplyTrigger;
      const shouldOpen = Boolean(open && replies.length && !(trigger && trigger.disabled));
      runtime.ui.fastReplyBackdrop.hidden = !shouldOpen;
      runtime.ui.root.classList.toggle('za-fast-reply-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

      if (shouldOpen) {
        this.renderFastReplyPickerList();
        setTimeout(() => {
          if (this.isFastReplyPickerOpen() && runtime.ui.fastReplySearch) runtime.ui.fastReplySearch.focus();
        }, 0);
        return;
      }

      if (runtime.ui.fastReplySearch && runtime.ui.fastReplySearch.value) {
        runtime.ui.fastReplySearch.value = '';
        this.renderFastReplyPickerList();
      }
    },

    // 更新常用语搜索词并重新渲染弹层列表。
    setFastReplySearch(value) {
      if (!runtime.ui || !runtime.ui.fastReplySearch) return;
      runtime.ui.fastReplySearch.value = value || '';
      this.renderFastReplyPickerList();
      runtime.ui.fastReplySearch.focus();
    },

    // 选择某条常用语并持久化索引。
    selectFastReply(index) {
      const replies = config.fastReplies || [];
      const nextIndex = Number(index);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= replies.length) return;

      saveConfig({ fastReplyIndex: nextIndex });
      this.renderFastReplyOptions();
      this.setFastReplyPickerOpen(false);
    },

    // 渲染公司黑名单下拉多选，每条规则展示匹配模式，便于区分全量/部分/正则。
    renderCompanyBlacklistRules() {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu) return;

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = this.getCompanyBlacklistSelectedIds(rules);
      const running = runtime.ui.root.classList.contains('za-running');
      runtime.ui.companyBlacklistOptionMenu.innerHTML = rules.length
        ? rules.map((rule) => {
            const checked = selectedIds.has(rule.id) ? ' checked' : '';
            const disabled = running ? ' disabled' : '';
            return `
              <div class="za-multi-option za-blacklist-option">
                <label class="za-blacklist-option-label">
                  <input data-role="companyBlacklistRuleOption" type="checkbox" value="${escapeHtml(rule.id)}"${checked}${disabled}>
                  <span title="${escapeHtml(rule.value)}">[${escapeHtml(getCompanyMatchModeLabel(rule.mode))}] ${escapeHtml(rule.value)}</span>
                </label>
                <button class="za-blacklist-delete" type="button" data-action="removeCompanyBlacklistRule" data-id="${escapeHtml(rule.id)}" title="删除该黑名单"${disabled}>×</button>
              </div>
            `;
          }).join('')
        : '<div class="za-empty-text">暂无公司黑名单</div>';

      if (runtime.ui.companyBlacklistDropdownText) {
        runtime.ui.companyBlacklistDropdownText.textContent = rules.length
          ? selectedIds.size
            ? `已选 ${selectedIds.size}/${rules.length} 条`
            : `已添加 ${rules.length} 条`
          : '暂无公司黑名单';
      }

      const trigger = runtime.ui.companyBlacklistDropdown &&
        runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      if (trigger) {
        trigger.disabled = running || !rules.length;
        trigger.setAttribute('aria-expanded', this.isCompanyBlacklistDropdownOpen() ? 'true' : 'false');
      }
      runtime.ui.companyBlacklistOptionMenu.querySelectorAll('input[data-role="companyBlacklistRuleOption"]').forEach((input) => {
        input.disabled = running;
      });
      if (runtime.ui.companyBlacklistRemoveButton) {
        runtime.ui.companyBlacklistRemoveButton.disabled = running || !selectedIds.size;
      }
      if (runtime.ui.companyBlacklistClearButton) {
        runtime.ui.companyBlacklistClearButton.disabled = running || !rules.length;
      }
      if (!rules.length) this.setCompanyBlacklistDropdownOpen(false);
    },

    // 获取当前用于删除的黑名单勾选项，并清掉已不存在的规则 ID。
    getCompanyBlacklistSelectedIds(rules) {
      const availableIds = new Set((rules || normalizeCompanyBlacklistRules(config.companyBlacklistRules)).map((rule) => rule.id));
      const selectedIds = runtime.ui.companyBlacklistSelectedIds instanceof Set
        ? runtime.ui.companyBlacklistSelectedIds
        : new Set();
      Array.from(selectedIds).forEach((id) => {
        if (!availableIds.has(id)) selectedIds.delete(id);
      });
      runtime.ui.companyBlacklistSelectedIds = selectedIds;
      return selectedIds;
    },

    // 判断公司黑名单下拉是否打开。
    isCompanyBlacklistDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.companyBlacklistOptionMenu && !runtime.ui.companyBlacklistOptionMenu.hidden);
    },

    // 打开/关闭公司黑名单下拉，并同步 aria 状态。
    setCompanyBlacklistDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.companyBlacklistOptionMenu || !runtime.ui.companyBlacklistDropdown) return;
      const trigger = runtime.ui.companyBlacklistDropdown.querySelector('[data-action="toggleCompanyBlacklistDropdown"]');
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const shouldOpen = Boolean(open && rules.length && !(trigger && trigger.disabled));
      runtime.ui.companyBlacklistOptionMenu.hidden = !shouldOpen;
      runtime.ui.companyBlacklistDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个黑名单规则，仅影响“删除选中”的临时选择状态。
    setCompanyBlacklistRuleSelected(id, selected, keepDropdownOpen) {
      const key = normalizeText(id);
      if (!key || !runtime.ui) return;

      const selectedIds = this.getCompanyBlacklistSelectedIds();
      if (selected) {
        selectedIds.add(key);
      } else {
        selectedIds.delete(key);
      }
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 添加公司黑名单规则，保存前校验正则并按“模式+文本”去重。
    addCompanyBlacklistRule() {
      const root = runtime.ui && runtime.ui.root;
      if (!root) return;

      const modeField = root.querySelector('[data-field="companyBlacklistMode"]');
      const valueField = root.querySelector('[data-field="companyBlacklistValue"]');
      const mode = getCompanyMatchMode(modeField && modeField.value);
      const value = normalizeText(valueField && valueField.value);
      if (!value) {
        UI.setStatus('请输入公司黑名单文本', 'warn');
        return;
      }
      if (mode === 'regex') {
        try {
          new RegExp(value);
        } catch (error) {
          UI.setStatus(`公司黑名单正则无效：${error.message}`, 'error');
          return;
        }
      }

      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const exists = rules.some((rule) => rule.mode === mode && rule.value === value);
      if (exists) {
        UI.setStatus('该公司黑名单已存在', 'warn');
        if (valueField) valueField.value = '';
        saveConfig({ companyBlacklistMode: mode, companyBlacklistValue: '' });
        return;
      }

      const key = `${mode}:${value}`;
      const nextRule = {
        id: `black_${hashString(`${key}:${Date.now()}`)}`,
        mode,
        value,
      };
      saveConfig({
        companyBlacklistMode: mode,
        companyBlacklistValue: '',
        companyBlacklistRules: rules.concat(nextRule),
      });
      if (valueField) valueField.value = '';
      this.renderCompanyBlacklistRules();
      UI.setStatus(`已添加公司黑名单：${getCompanyMatchModeLabel(mode)} / ${value}`, 'ok');
    },

    // 删除当前勾选的公司黑名单规则，支持一次删除多条。
    removeCompanyBlacklistRule(id) {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      const selectedIds = id
        ? new Set([normalizeText(id)].filter(Boolean))
        : new Set(this.getCompanyBlacklistSelectedIds(rules));
      if (!selectedIds.size) {
        UI.setStatus('请选择要移除的公司黑名单', 'warn');
        return;
      }

      const nextRules = rules.filter((rule) => !selectedIds.has(rule.id));
      if (nextRules.length === rules.length) return;

      if (id) {
        this.getCompanyBlacklistSelectedIds(rules).delete(normalizeText(id));
      } else {
        runtime.ui.companyBlacklistSelectedIds = new Set();
      }
      saveConfig({ companyBlacklistRules: nextRules });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(Boolean(nextRules.length));
      UI.setStatus(`已删除 ${rules.length - nextRules.length} 条公司黑名单`, 'ok');
    },

    // 删除全部公司黑名单规则。
    async clearCompanyBlacklistRules() {
      const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
      if (!rules.length) {
        UI.setStatus('暂无公司黑名单可删除', 'warn');
        return;
      }

      let confirmed = false;
      try {
        confirmed = await askConfirm(`将删除全部 ${rules.length} 条公司黑名单，此操作不可恢复。`, {
          title: '清空公司黑名单',
          confirmText: '确认清空',
        });
      } catch (error) {
        UI.setStatus(error.message || '无法打开确认弹窗', 'error');
        return;
      }
      if (!confirmed) return;

      runtime.ui.companyBlacklistSelectedIds = new Set();
      saveConfig({ companyBlacklistRules: [] });
      this.renderCompanyBlacklistRules();
      this.setCompanyBlacklistDropdownOpen(false);
      UI.setStatus('已删除全部公司黑名单', 'ok');
    },

    // 刷新已投递公司去重名单计数显示。
    async updateAppliedCompanyCount() {
      if (!runtime.ui || !runtime.ui.appliedCompanyCount) return;
      try {
        await AppliedCompanyIndex.ensureReady();
        const size = AppliedCompanyIndex.size();
        runtime.ui.appliedCompanyCount.textContent = `当前名单 ${size} 家公司`;
      } catch (_) {}
    },

    // 清空已投递公司去重名单（持久化、需二次确认）。
    async clearAppliedCompanies() {
      await AppliedCompanyIndex.ensureReady();
      const count = AppliedCompanyIndex.size();
      if (!count) {
        UI.setStatus('已投递公司名单为空，无需清空', 'warn');
        return;
      }
      let confirmed = false;
      try {
        confirmed = await askConfirm(`将清空已投递公司去重名单（共 ${count} 家公司）。清空后这些公司将可重新投递。此操作不可恢复。`, {
          title: '清空已投递公司名单',
          confirmText: '确认清空',
        });
      } catch (error) {
        UI.setStatus(error.message || '无法打开确认弹窗', 'error');
        return;
      }
      if (!confirmed) return;
      AppliedCompanyIndex.clear();
      UI.setStatus(`已清空 ${count} 家已投递公司去重名单`, 'ok');
      logDebugEvent('clear_applied_companies', { count, at: nowIso() }, 'info');
    },

    // 渲染 Boss 活跃度下拉多选、已选标签和自定义选项标签。
    renderBossActiveFilterOptions() {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu) return;

      const selectedKeys = new Set(getSelectedBossActiveKeys());
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const options = getBossActiveFilterOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveOptionMenu.innerHTML = options.map((item) => {
        const checked = selectedKeys.has(normalizeBossActiveText(item)) ? ' checked' : '';
        return `
          <label class="za-multi-option">
            <input data-role="bossActiveOption" type="checkbox" value="${escapeHtml(item)}"${checked}>
            <span>${escapeHtml(item)}</span>
          </label>
        `;
      }).join('');

      runtime.ui.bossActiveDropdownText.textContent = selectedOptions.length
        ? `已选 ${selectedOptions.length} 项`
        : '选择 Boss 活跃度';
      runtime.ui.bossActiveSelectedList.innerHTML = selectedOptions.length
        ? selectedOptions.map((item) => `
          <span class="za-selected-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="removeBossActiveSelection" data-value="${escapeHtml(item)}" title="移除该活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">未选择，默认不过滤 Boss 活跃度</span>';

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      runtime.ui.bossActiveCustomList.innerHTML = customOptions.length
        ? customOptions.map((item) => `
          <span class="za-option-chip">
            <span>${escapeHtml(item)}</span>
            <button type="button" data-action="deleteBossActiveOption" data-value="${escapeHtml(item)}" title="删除自定义活跃度">×</button>
          </span>
        `).join('')
        : '<span class="za-empty-text">暂无自定义选项</span>';
    },

    // 判断 Boss 活跃度下拉是否打开。
    isBossActiveDropdownOpen() {
      return Boolean(runtime.ui && runtime.ui.bossActiveOptionMenu && !runtime.ui.bossActiveOptionMenu.hidden);
    },

    // 打开/关闭 Boss 活跃度下拉，并同步 aria 状态。
    setBossActiveDropdownOpen(open) {
      if (!runtime.ui || !runtime.ui.bossActiveOptionMenu || !runtime.ui.bossActiveDropdown) return;
      const trigger = runtime.ui.bossActiveDropdown.querySelector('[data-action="toggleBossActiveDropdown"]');
      const shouldOpen = Boolean(open && !(trigger && trigger.disabled));
      runtime.ui.bossActiveOptionMenu.hidden = !shouldOpen;
      runtime.ui.bossActiveDropdown.classList.toggle('za-open', shouldOpen);
      if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    },

    // 勾选或取消某个 Boss 活跃度选项，并保存到配置。
    setBossActiveOptionSelected(value, selected, keepDropdownOpen) {
      const key = normalizeBossActiveText(value);
      if (!key) return;

      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues);
      const exists = selectedOptions.some((item) => normalizeBossActiveText(item) === key);
      let nextOptions = selectedOptions;
      if (selected && !exists) {
        nextOptions = selectedOptions.concat(getBossActiveOptionLabel(value));
      } else if (!selected) {
        nextOptions = selectedOptions.filter((item) => normalizeBossActiveText(item) !== key);
      }

      saveConfig({ bossActiveFilterValues: nextOptions });
      this.renderBossActiveFilterOptions();
      this.setBossActiveDropdownOpen(Boolean(keepDropdownOpen));
    },

    // 从已选列表中移除某个 Boss 活跃度。
    removeBossActiveSelection(value) {
      this.setBossActiveOptionSelected(value, false);
    },

    // 添加自定义 Boss 活跃度选项，去重后写入配置。
    addBossActiveCustomOption() {
      if (!runtime.ui || !runtime.ui.bossActiveCustomInput) return;
      const input = runtime.ui.bossActiveCustomInput;
      const text = getBossActiveOptionLabel(input.value);
      const key = normalizeBossActiveText(text);
      if (!key) {
        UI.setStatus('请输入 Boss 活跃度文本', 'warn');
        return;
      }
      if (BOSS_ACTIVE_BUILTIN_KEYS.has(key)) {
        UI.setStatus('该活跃度已是内置选项', 'warn');
        input.value = '';
        return;
      }

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions);
      if (customOptions.some((item) => normalizeBossActiveText(item) === key)) {
        UI.setStatus('该自定义活跃度已存在', 'warn');
        input.value = '';
        return;
      }

      saveConfig({ bossActiveCustomOptions: customOptions.concat(text) });
      input.value = '';
      this.renderBossActiveFilterOptions();
      UI.setStatus(`已添加自定义活跃度：${text}`, 'ok');
    },

    // 删除自定义 Boss 活跃度，并同步清理已选过滤值。
    deleteBossActiveCustomOption(value) {
      const key = normalizeBossActiveText(value);
      if (!key || BOSS_ACTIVE_BUILTIN_KEYS.has(key)) return;

      const customOptions = normalizeBossActiveOptions(config.bossActiveCustomOptions)
        .filter((item) => normalizeBossActiveText(item) !== key);
      const selectedOptions = normalizeBossActiveOptions(config.bossActiveFilterValues)
        .filter((item) => normalizeBossActiveText(item) !== key);
      saveConfig({
        bossActiveCustomOptions: customOptions,
        bossActiveFilterValues: selectedOptions,
      });
      this.renderBossActiveFilterOptions();
    },

    // 更新面板状态条；被 lockStatus 锁定时，普通状态不会覆盖关键错误/暂停提示。
    setStatus(message, type, options) {
      if (!runtime.ui) return;
      if (runtime.statusLock && !(options && options.force)) return;
      runtime.ui.status.textContent = message || '';
      runtime.ui.status.dataset.type = type || 'info';
    },

    // 锁定状态提示，通常用于 fatal/pause，避免后续异步任务覆盖真正停机原因。
    lockStatus(message, type) {
      runtime.statusLock = {
        message: message || '',
        type: type || 'info',
        lockedAt: Date.now(),
      };
      this.setStatus(runtime.statusLock.message, runtime.statusLock.type, { force: true });
    },

    // 手动操作或重新启动前解除状态锁。
    unlockStatus() {
      runtime.statusLock = null;
    },

    // 数据页：从 IndexedDB 读取岗位记录，刷新统计卡、趋势和最近记录。
    async refreshDataOverview() {
      const ui = runtime.ui;
      if (!ui || !ui.recordList) return;
      try {
        await Database.open();
        const rows = await Database.getAllCached('jobRecords').catch(() => []);
        runtime.dataOverviewRows = rows;
        this.renderDataStats(rows);
        this.renderRecordList(rows);
      } catch (error) {
        if (ui.recordList) {
          ui.recordList.innerHTML = `<div class="za-record-empty">岗位记录读取失败：${escapeHtml(String(error && error.message || error))}</div>`;
        }
        if (ui.recordListMeta) ui.recordListMeta.textContent = '读取数据失败，切换页签后可重试';
      }
    },

    // 发送成功后延迟刷新数据页，避免频繁读库；仅在数据页可见时刷新。
    scheduleDataOverviewRefresh() {
      const ui = runtime.ui;
      if (!ui || !ui.root) return;
      const pane = ui.root.querySelector('.za-pane[data-tab-name="tabData"]');
      if (!pane || pane.hasAttribute('hidden')) return;
      if (runtime.dataOverviewTimer) clearTimeout(runtime.dataOverviewTimer);
      runtime.dataOverviewTimer = setTimeout(() => {
        runtime.dataOverviewTimer = null;
        this.refreshDataOverview();
      }, 1200);
    },

    getDayKey(date) {
      const value = date instanceof Date ? date : new Date(date);
      if (Number.isNaN(value.getTime())) return '';
      const month = String(value.getMonth() + 1).padStart(2, '0');
      const day = String(value.getDate()).padStart(2, '0');
      return `${value.getFullYear()}-${month}-${day}`;
    },

    // 统计卡：今日投递、累计投递、跳过数、记录总数 + 最近 7 日趋势。
    renderDataStats(rows) {
      const ui = runtime.ui;
      if (!ui || !ui.dataStatToday) return;
      const list = Array.isArray(rows) ? rows : [];
      const todayKey = this.getDayKey(new Date());
      let today = 0;
      let total = 0;
      let skipped = 0;
      let lastUpdated = '';
      const trendMap = new Map();

      list.forEach((record) => {
        if (!record) return;
        const status = String(record.status || '');
        if (status === 'sent') {
          total += 1;
          const timeText = record.sentAt || record.updatedAt || record.createdAt || '';
          const date = timeText ? new Date(timeText) : null;
          if (date && !Number.isNaN(date.getTime())) {
            const key = this.getDayKey(date);
            trendMap.set(key, (trendMap.get(key) || 0) + 1);
            if (key === todayKey) today += 1;
          }
        }
        if (/^skipped/.test(status)) skipped += 1;
        const stamp = record.sentAt || record.updatedAt || record.clickedAt || record.createdAt || '';
        if (stamp && String(stamp) > String(lastUpdated)) lastUpdated = stamp;
      });

      ui.dataStatToday.textContent = String(today);
      if (ui.dataStatTotal) ui.dataStatTotal.textContent = String(total);
      if (ui.dataStatSkipped) ui.dataStatSkipped.textContent = String(skipped);
      if (ui.dataStatCount) ui.dataStatCount.textContent = String(list.length);
      if (ui.dataTrend) this.renderDataTrend(ui.dataTrend, trendMap);
      if (ui.dataStatsMeta) {
        ui.dataStatsMeta.textContent = list.length
          ? `共 ${list.length} 条记录，最近更新 ${formatRelativeTime(lastUpdated) || '未知'}；统计仅保存在本机`
          : '统计自本机岗位记录，启动投递后这里会显示数据';
      }
    },

    renderDataTrend(container, trendMap) {
      const days = [];
      const now = new Date();
      for (let i = 6; i >= 0; i -= 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = this.getDayKey(date);
        days.push({ date, key, count: trendMap.get(key) || 0 });
      }
      const max = Math.max(1, ...days.map((item) => item.count));
      container.innerHTML = days.map((item, index) => {
        const height = item.count ? Math.max(12, Math.round(item.count / max * 100)) : 0;
        const label = index === days.length - 1 ? '今天' : `${item.date.getMonth() + 1}/${item.date.getDate()}`;
        return `<div class="za-trend-item"><span class="za-trend-count">${item.count || ''}</span><div class="za-trend-bar-wrap"><span class="za-trend-bar" data-zero="${item.count ? '0' : '1'}" style="height:${height}%"></span></div><span class="za-trend-day">${label}</span></div>`;
      }).join('');
    },

    // 最近记录：关键词 + 状态筛选，最多展示 30 条。
    renderRecordList(rows) {
      const ui = runtime.ui;
      if (!ui || !ui.recordList) return;
      const list = Array.isArray(rows) ? rows : [];
      const keyword = String(ui.recordSearch && ui.recordSearch.value || '').trim().toLowerCase();
      const statusFilter = String(ui.recordStatus && ui.recordStatus.value || '');
      const filtered = list.filter((record) => {
        if (!record) return false;
        const status = String(record.status || '');
        if (statusFilter === 'skipped') {
          if (!/^skipped/.test(status)) return false;
        } else if (statusFilter && status !== statusFilter) {
          return false;
        }
        if (!keyword) return true;
        return `${record.jobName || ''} ${record.company || ''}`.toLowerCase().includes(keyword);
      }).sort((a, b) => {
        const left = String(b.sentAt || b.updatedAt || b.clickedAt || b.createdAt || '');
        const right = String(a.sentAt || a.updatedAt || a.clickedAt || a.createdAt || '');
        return left.localeCompare(right);
      });

      const limit = 30;
      const visible = filtered.slice(0, limit);
      if (!visible.length) {
        ui.recordList.innerHTML = `<div class="za-record-empty">${list.length ? '没有符合筛选条件的记录' : '暂无岗位记录，启动投递后会显示在这里'}</div>`;
      } else {
        ui.recordList.innerHTML = visible.map((record) => {
          const meta = getRecordStatusMeta(record);
          const timeText = record.sentAt || record.updatedAt || record.clickedAt || record.createdAt || '';
          const title = record.jobName || record.positionName || '未命名岗位';
          const extras = [record.company || record.companyFullName || '', record.salary || '', formatRelativeTime(timeText)]
            .filter(Boolean)
            .map((item) => `<span>${escapeHtml(String(item))}</span>`)
            .join('');
          return `<div class="za-record-row"><div class="za-record-main"><span class="za-record-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="${meta.cls}">${meta.label}</span></div><div class="za-record-meta">${extras}</div></div>`;
        }).join('');
      }
      if (ui.recordListMeta) {
        ui.recordListMeta.textContent = filtered.length
          ? (filtered.length > limit ? `显示最近 ${limit} 条，共 ${filtered.length} 条匹配` : `共 ${filtered.length} 条匹配记录`)
          : (list.length ? '没有符合筛选条件的记录' : '启动投递后，这里会显示最近的岗位记录');
      }
    },

    // 切换运行态：禁用启动按钮、启用停止按钮，并锁定会影响流程的配置项。
    setRunning(running) {
      if (!runtime.ui) return;
      const wasRunning = runtime.ui.root.classList.contains('za-running');
      runtime.ui.root.classList.toggle('za-running', Boolean(running));
      if (running && !wasRunning) LogWindow.startSession('自动投递');
      if (!running && wasRunning) {
        runtime.logGraceUntil = Date.now() + 5000;
        const endReason = runtime.statusLock
          ? (runtime.statusLock.message || '投递已停止')
          : (runtime.stopRequested ? '已手动停止投递' : '投递流程已结束');
        LogWindow.endSession(endReason);
      }
      const start = runtime.ui.root.querySelector('[data-action="start"]');
      const stop = runtime.ui.root.querySelector('[data-action="stop"]');
      if (start) start.disabled = Boolean(running);
      if (stop) stop.disabled = !running;
      this.setRuntimeConfigLocked(Boolean(running));
    },

    // 运行中锁定配置，防止正在循环时更改等待时间、问候语来源等关键参数。
    setRuntimeConfigLocked(locked) {
      const root = runtime.ui.root;
      if (locked) {
        this.setFastReplyPickerOpen(false);
        this.setCompanyBlacklistDropdownOpen(false);
        this.setBossActiveDropdownOpen(false);
      }

      root.querySelectorAll('[data-field]').forEach((field) => {
        if (isRuntimeLockExemptField(field.dataset.field)) return;
        field.disabled = locked;
      });

      root.querySelectorAll('input[name="za-greeting-mode"], input[name="za-text-source"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-lock-field], [data-role="companyBlacklistRuleOption"], [data-role="bossActiveOption"], [data-action="toggleCompanyBlacklistDropdown"], [data-action="toggleBossActiveDropdown"], [data-action="removeBossActiveSelection"]').forEach((field) => {
        field.disabled = locked;
      });

      const refreshFastReplies = root.querySelector('[data-action="refreshFastReplies"]');
      if (refreshFastReplies) refreshFastReplies.disabled = locked;

      if (runtime.ui.fastReplyTrigger) {
        runtime.ui.fastReplyTrigger.disabled = Boolean(locked || !(config.fastReplies || []).length);
        runtime.ui.fastReplyTrigger.setAttribute('aria-expanded', 'false');
      }
      root.querySelectorAll('[data-role="fastReplySearch"], [data-action="clearFastReplySearch"]').forEach((field) => {
        field.disabled = locked;
      });

      root.querySelectorAll('[data-action="addCompanyBlacklistRule"], [data-action="removeCompanyBlacklistRule"], [data-action="clearCompanyBlacklistRules"], [data-action="addBossActiveOption"], [data-action="deleteBossActiveOption"]').forEach((button) => {
        button.disabled = locked;
      });
      this.renderCompanyBlacklistRules();
    },

    // 从 IndexedDB 读取已沟通记录并刷新虚拟列表。
    async refreshGreetedList(options) {
      if (runtime.ui && runtime.ui.listItems && !(runtime.ui.greetedRows || []).length) {
        runtime.ui.listItems.innerHTML = '<div class="za-list-empty">正在读取本地记录…</div>';
        runtime.ui.listSpacer.style.height = '0px';
      }
      try {
        await Database.open();
        const rows = await loadGreetedRows();
        runtime.ui.greetedRows = rows;
        if (options && options.scrollTop && runtime.ui.listViewport) {
          runtime.ui.listViewport.scrollTop = 0;
        }
        this.renderVirtualList();
      } catch (error) {
        console.warn('[ZhipinAuto] 读取已沟通列表失败', error);
        if (runtime.ui && runtime.ui.listItems) {
          runtime.ui.listItems.innerHTML = `<div class="za-list-empty">已沟通列表读取失败：${escapeHtml(String(error && error.message || error))}</div>`;
          runtime.ui.listSpacer.style.height = '0px';
          if (runtime.ui.greetedCount) runtime.ui.greetedCount.textContent = '0';
        }
      }
    },

    // 发送成功后把最新记录插入/更新到 UI 列表，不必全量重读 IndexedDB。
    upsertGreetedRecord(record) {
      if (!runtime.ui || !isContactedRecord(record)) return;

      const rows = runtime.ui.greetedRows || [];
      const index = rows.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        rows[index] = Object.assign({}, rows[index], record);
      } else {
        rows.unshift(record);
      }

      runtime.ui.greetedRows = sortGreetedRows(rows);
      if (runtime.ui.listViewport) runtime.ui.listViewport.scrollTop = 0;
      this.renderVirtualList();
      this.scheduleDataOverviewRefresh();
    },

    // 虚拟列表渲染：只生成当前视口附近的行，避免记录很多时拖慢页面。
    renderVirtualList() {
      if (!runtime.ui || !runtime.ui.listViewport || !runtime.ui.listItems) return;

      const viewport = runtime.ui.listViewport;
      const rows = runtime.ui.greetedRows || [];
      if (runtime.ui.greetedCount) runtime.ui.greetedCount.textContent = String(rows.length);
      if (!rows.length) {
        runtime.ui.listSpacer.style.height = '0px';
        runtime.ui.listItems.innerHTML =
          '<div class="za-list-empty">' +
            '<div class="za-list-empty-icon">&#128172;</div>' +
            '<div>暂无已沟通岗位</div>' +
            '<div class="za-list-empty-hint">启动自动沟通后，已发送的岗位将显示在此处</div>' +
          '</div>';
        return;
      }
      try {
        const rowHeight = runtime.ui.rowHeight;
        // 记录变少时 scrollTop 可能停留在旧位置，先按新总数夹紧，避免渲染出屏幕外的空白。
        const maxScrollTop = Math.max(0, rows.length * rowHeight - viewport.clientHeight);
        if (viewport.scrollTop > maxScrollTop) viewport.scrollTop = maxScrollTop;
        const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 2);
        const visibleCount = Math.ceil(viewport.clientHeight / rowHeight) + 5;
        const end = Math.min(rows.length, start + visibleCount);

        runtime.ui.listSpacer.style.height = `${rows.length * rowHeight}px`;
        runtime.ui.listItems.innerHTML = rows.slice(start, end).map((row, offset) => {
          const top = (start + offset) * rowHeight;
        const salary = getDisplaySalary(row) || '-';
        const company = getDisplayCompany(row) || '';
        const city = normalizeText(row.cityName || row.city || '');
        const time = formatRelativeTime(row.sentAt || row.clickedAt || row.updatedAt);
        const status = row.status || 'sent';
        const statusClass = status === 'sent' ? 'za-list-status-sent' : 'za-list-status-skipped';
        const statusLabel = status === 'sent' ? '已发' : '已跳过';
        return `
          <div class="za-list-row" style="transform: translateY(${top}px)" data-job-id="${escapeHtml(String(row.id || ''))}">
            <div class="za-list-row-main">
              <span class="za-list-row-title" title="${escapeHtml(row.jobName || '未知岗位')}">${escapeHtml(row.jobName || '未知岗位')}</span>
              <span class="za-list-row-salary">${escapeHtml(salary)}</span>
            </div>
            <div class="za-list-row-sub">
              <span class="za-list-row-company" title="${escapeHtml(company)}">${escapeHtml(company || '未知公司')}${city ? ' · ' + escapeHtml(city) : ''}</span>
              <span class="za-list-row-meta">
                <span class="za-list-status ${statusClass}">${statusLabel}</span>
                <span class="za-list-row-time" title="${escapeHtml(row.sentAt || row.clickedAt || '')}">${escapeHtml(time)}</span>
              </span>
            </div>
          </div>
        `;
        }).join('');
      } catch (error) {
        console.warn('[ZhipinAuto] 已沟通列表渲染失败', error);
        runtime.ui.listSpacer.style.height = '0px';
        runtime.ui.listItems.innerHTML = `<div class="za-list-empty">列表渲染失败：${escapeHtml(String(error && error.message || error))}</div>`;
      }
    },
  };

  // 读取已沟通列表：优先使用 jobRecords 中的已沟通记录，再兼容 greetedJobs 旧投影。
  async function loadGreetedRows() {
    const [jobRows, greetedRows] = await Promise.all([
      Database.getAllCached('jobRecords').catch(() => []),
      Database.getAllCached('greetedJobs').catch(() => []),
    ]);
    const byId = new Map();

    // 不再只认 status === 'sent'：跳过重复沟通、已点击但带发送时间等记录同样属于“已沟通”。
    jobRows.filter((record) => record && isContactedRecord(record)).forEach((record) => {
      byId.set(record.id, record);
    });
    greetedRows.filter(Boolean).forEach((record) => {
      byId.set(record.id, Object.assign({}, byId.get(record.id) || {}, record));
    });

    return sortGreetedRows(Array.from(byId.values()));
  }

  // 已沟通列表按沟通时间倒序展示，时间缺失时再按更新时间/创建时间兜底。
  function sortGreetedRows(rows) {
    return Array.from(rows || []).sort((a, b) => {
      const left = String(b.sentAt || b.updatedAt || b.clickedAt || '');
      const right = String(a.sentAt || a.updatedAt || a.clickedAt || '');
      return left.localeCompare(right);
    });
  }

  // 常用语接口：读取 BOSS 聊天侧的常用语列表。
  // 获取失败时不阻塞自动化流程，后续会退回默认问候语文本。
