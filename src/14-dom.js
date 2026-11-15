  function getJobCards() {
    // 获取当前平台的卡片选择器
    const selector = currentPlatform?.selectors?.jobCard || 'li.job-card-box';
    // 直接用 querySelectorAll 获取所有卡片，内联快速可见性检查避免 isVisible 的 getComputedStyle 开销
    const all = document.querySelectorAll(selector);
    const visible = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.offsetWidth > 0 || el.offsetHeight > 0) visible.push(el);
    }
    return visible;
  }

  // 虚拟列表会反复销毁和创建卡片节点，因此扫描进度必须依赖稳定岗位标识而不是 DOM 下标。
  function getJobScanKey(job, domInfo) {
    const reliableKeys = getReliableJobIdentityKeys(job);
    if (reliableKeys.length) return `id:${reliableKeys[0]}`;

    const domKey = domInfo && (domInfo.keys || []).map(normalizeText).find(Boolean);
    if (domKey) return `dom:${domKey}`;

    const looseSignature = job && (job.looseSignature || makeLooseSignature(job.jobName, job.company)) ||
      domInfo && domInfo.looseSignature;
    if (isMeaningfulCompositeKey(looseSignature)) return `loose:${looseSignature}`;

    const signature = job && (job.signature || makeSignature(job.jobName, job.company, job.salary)) ||
      domInfo && domInfo.signature;
    return isMeaningfulCompositeKey(signature) ? `signature:${signature}` : '';
  }

  function getCardScanEntry(card, index) {
    const domInfo = extractCardInfo(card);
    const job = runtime.cardJobMap.get(card) || JobRepository.normalizeDomOnlyJob(card, index);
    return {
      card,
      domInfo,
      job,
      key: getJobScanKey(job, domInfo),
    };
  }

  function getVisibleJobScanEntries() {
    return JobRepository.syncCards().map((card, index) => getCardScanEntry(card, index));
  }

  function getProcessedJobKeySet(state) {
    return new Set(Array.isArray(state && state.processedKeys) ? state.processedKeys.filter(Boolean) : []);
  }

  function buildProcessedJobPatch(state, job, domInfo, extra) {
    const processedKeys = getProcessedJobKeySet(state);
    const key = getJobScanKey(job, domInfo);
    const pendingKey = normalizeText(state && state.pendingJobKey);
    if (pendingKey) processedKeys.add(pendingKey);
    if (key) processedKeys.add(key);
    return Object.assign({
      processedKeys: Array.from(processedKeys),
      cursorIndex: Math.max(Number(state && state.cursorIndex || 0) + 1, processedKeys.size),
      scanDiscoveredCount: Math.max(Number(state && state.scanDiscoveredCount || 0), processedKeys.size),
      scanNoProgressCount: 0,
    }, extra || {});
  }

  // 保存真实左栏滚动容器的位置和当前卡片锚点，聊天返回或完整恢复 URL 后可以继续扫描。
  function captureJobListPosition(preferredJob) {
    const cards = getJobCards();
    const preferredKey = getJobScanKey(preferredJob);
    const anchor = cards.find((card, index) => {
      if (!preferredKey) return false;
      return getCardScanEntry(card, index).key === preferredKey;
    }) || cards.find((card) => /active|selected|cur|current/.test(String(card.className || ''))) || cards[0];
    const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
    const anchorIndex = anchor ? cards.indexOf(anchor) : -1;
    const anchorEntry = anchorIndex >= 0 ? getCardScanEntry(anchor, anchorIndex) : null;
    return {
      listScrollTop: Math.max(0, Number(scroller && scroller.scrollTop || 0)),
      listAnchorKey: anchorEntry && anchorEntry.key || preferredKey || '',
    };
  }

  async function restoreJobListPosition(state) {
    if (!state || !isJobListRoute()) return false;
    await waitForVisibleJobList(Math.max(3000, getWaitTimeout() * 1000));
    JobRepository.syncCards();

    const targetTop = Math.max(0, Number(state.listScrollTop || 0));
    const anchorKey = normalizeText(state.listAnchorKey);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const entries = getVisibleJobScanEntries();
      const anchored = anchorKey && entries.find((item) => item.key === anchorKey);
      if (anchored) {
        anchored.card.scrollIntoView({ block: 'center', inline: 'nearest' });
        return true;
      }

      const anchor = entries.length ? entries[0].card : document.querySelector('li.job-card-box') || getJobCards()[0];
      const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
      if (!scroller || targetTop <= 0) break;
      const beforeTop = Number(scroller.scrollTop || 0);
      const beforeRenderSignature = getVisibleJobListRenderSignature();
      const beforeResponseSerial = Number(runtime.jobListResponseSerial || 0);
      scroller.scrollTop = targetTop;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForJobListRenderChange(beforeRenderSignature, beforeResponseSerial, 700);
      JobRepository.syncCards();
      if (Number(scroller.scrollTop || 0) >= targetTop - 2 || Number(scroller.scrollTop || 0) <= beforeTop) break;
    }
    return Boolean(targetTop > 0);
  }

  // 保留旧游标字段用于日志和记录兼容；实际扫描进度由 processedKeys 决定。
  function findSelectedCardIndex() {
    const cards = getJobCards();
    const selected = cards.findIndex((card) => {
      const className = String(card.className || '');
      return /active|selected|cur|current/.test(className);
    });
    return selected >= 0 ? selected : 0;
  }

  // 从 DOM 卡片提取岗位名、公司、薪资、城市和可用于匹配的 key。
  // 使用单个复合选择器减少 DOM 查询次数。
  const JOB_NAME_SELECTOR = 'a.job-name, .job-name a, .job-name, a[class*="job-name"], .job-title a, .job-title, [class*="job-name"], .job-card__name, .jobinfo__name';
  const SALARY_SELECTOR = '.job-salary, .salary, [class*="salary"]';
  const COMPANY_SELECTOR = '.boss-name, .company-name, .company-text, .job-card__company-name, .companyinfo__name';
  const CITY_SELECTOR = '.company-location, [class*="location"], .job-card__location, .jobinfo__other-info-item';
  const DATA_ATTR_SELECTOR = 'a, [data-jobid], [data-job-id], [data-id], [data-lid], [data-securityid], [data-security-id]';
  const DATA_ATTRS = ['data-jobid', 'data-job-id', 'data-id', 'data-lid', 'data-securityid', 'data-security-id'];
  // BOSS 用 /job_detail/，智联用 /jobdetail/，老版智联职位链接以 .htm 结尾。
  const HREF_JOB_DETAIL_RE = /\/job_?detail\/([A-Za-z0-9_~-]+)(?:\.html|\.htm)?/i;
  const HREF_JOB_ID_RE = /(?:jobId=|encryptJobId=|securityId=)([A-Za-z0-9_~-]+)/g;

  function extractCardInfo(card) {
    const text = normalizeText(card.innerText || card.textContent || '');
    const salaryEl = card.querySelector(SALARY_SELECTOR);
    const salary = normalizeText((salaryEl && salaryEl.textContent) || '');
    const jobNameEl = card.querySelector(JOB_NAME_SELECTOR);
    const rawJobName = jobNameEl ? normalizeText((jobNameEl.innerText || jobNameEl.textContent)) : '';
    const jobName = cleanDomJobName(rawJobName, salary);
    const companyEl = card.querySelector(COMPANY_SELECTOR);
    const company = normalizeText((companyEl && companyEl.textContent) || '');
    const cityEl = card.querySelector(CITY_SELECTOR);
    const city = normalizeText((cityEl && cityEl.textContent) || '');
    const keys = [];

    const elements = Array.from(card.querySelectorAll(DATA_ATTR_SELECTOR));
    elements.unshift(card);
    for (const element of elements) {
      for (let i = 0; i < DATA_ATTRS.length; i++) {
        const value = element.getAttribute && element.getAttribute(DATA_ATTRS[i]);
        if (value) keys.push(value);
      }

      const href = element.getAttribute && element.getAttribute('href');
      if (href) {
        const detailMatch = HREF_JOB_DETAIL_RE.exec(href);
        if (detailMatch && detailMatch[1]) keys.push(detailMatch[1]);

        let match;
        HREF_JOB_ID_RE.lastIndex = 0;
        while ((match = HREF_JOB_ID_RE.exec(href)) !== null) {
          const value = match.split(/[=/]/).pop();
          if (value) keys.push(value);
        }
      }
    }

    const fallbackLines = text.split(/\s+/).filter(Boolean);
    const fallbackName = fallbackLines[0] || '';
    const finalName = jobName || fallbackName;
    return {
      text,
      jobName: finalName,
      salary,
      company,
      city,
      keys: Array.from(new Set(keys.map(String))),
      signature: makeSignature(finalName, company, salary),
      looseSignature: makeLooseSignature(finalName, company),
    };
  }

  // 按选择器列表读取第一个非空文本，用来兼容 BOSS 多版 DOM 结构。
  function readFirstElementText(root, selectors) {
    for (const selector of selectors || []) {
      const element = root && root.querySelector && root.querySelector(selector);
      const text = normalizeText(element && (element.innerText || element.textContent));
      if (text) return text;
    }
    return '';
  }

  // DOM 中岗位名有时会拼接薪资，这里剥离薪资后再做签名匹配。
  function cleanDomJobName(jobName, salary) {
    let text = normalizeText(jobName);
    const salaryText = normalizeText(salary);
    if (salaryText) text = normalizeText(text.replace(salaryText, ''));
    text = text.replace(/[\uE000-\uF8FF][\uE000-\uF8FF\d.,+\-~Kk万年月薪\/·]*$/g, '');
    return normalizeText(text);
  }

  // 从详情 DOM/HTML 中读取 Boss 活跃度；在线标签和普通活跃时间位于不同节点。
  function extractBossActiveInfoFromRoot(root, hiddenClasses, options) {
    const container = root && root.querySelector
      ? (root.querySelector('.job-detail-body') || root)
      : null;
    if (!container) return {};

    const visibleOnly = !(options && options.visibleOnly === false);
    const onlineElement = findBossActiveElement(container, '.boss-online-tag', visibleOnly);
    if (onlineElement) {
      return {
        bossActiveTimeDesc: cleanBossActiveElementText(onlineElement, hiddenClasses) || '在线',
        bossOnline: true,
      };
    }

    const activeElement = findBossActiveElement(container, '.boss-active-time', visibleOnly);
    const activeText = cleanBossActiveElementText(activeElement, hiddenClasses);
    if (!activeText) return {};

    return {
      bossActiveTimeDesc: activeText,
      bossOnline: normalizeBossActiveText(activeText) === '在线',
    };
  }

  // 在指定根节点中查找活跃度元素，可按调用场景选择是否要求可见。
  function findBossActiveElement(root, selector, visibleOnly) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .find((element) => !visibleOnly || isVisible(element));
  }

  // 清洗活跃度节点文本，移除图标/隐藏节点后归一成可匹配标签。
  function cleanBossActiveElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, i, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    const text = hiddenClasses
      ? cleanElementText(clone, hiddenClasses)
      : normalizeText(clone.textContent || clone.innerText || element.getAttribute('title') || element.getAttribute('aria-label') || '');
    return getBossActiveOptionLabel(text);
  }

  // 从右侧岗位详情 DOM 读取可见信息，作为详情接口缺失时的补充。
  function extractDetailInfo() {
    const root = Array.from(document.querySelectorAll('.job-detail-box'))
      .find((element) => isVisible(element));
    if (!root) return {};

    const detail = {};
    const jobName = normalizeText((root.querySelector('.job-detail-header .job-name') || {}).textContent || '');
    const salary = getReadableSalary((root.querySelector('.job-detail-header .job-salary') || {}).textContent || '');
    if (jobName) detail.jobName = jobName;
    if (salary) detail.salary = salary;

    const bossRoot = root.querySelector('.job-boss-info');
    if (bossRoot) {
      const nameElement = bossRoot.querySelector('h2.name');
      if (nameElement) {
        const clone = nameElement.cloneNode(true);
        clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
        detail.bossName = normalizeText(clone.textContent || '');
      }

      const attr = normalizeText((bossRoot.querySelector('.boss-info-attr') || {}).textContent || '');
      const parts = attr.split('·').map(normalizeText).filter(Boolean);
      if (parts[0]) detail.company = parts[0];
      if (parts.length > 1) detail.bossTitle = parts[parts.length - 1];
    }

    const bossActiveInfo = extractBossActiveInfoFromRoot(root);
    if (bossActiveInfo.bossActiveTimeDesc) detail.bossActiveTimeDesc = bossActiveInfo.bossActiveTimeDesc;
    if (bossActiveInfo.bossOnline) detail.bossOnline = true;

    const tags = Array.from(root.querySelectorAll('.job-detail-header .tag-list li'))
      .map((element) => normalizeText(element.textContent || ''))
      .filter(Boolean);
    if (tags[0]) detail.city = tags[0];
    if (tags[1]) detail.experience = tags[1];
    if (tags[2]) detail.degree = tags[2];

    const address = normalizeText((root.querySelector('.job-address-desc') || {}).textContent || '');
    if (address) detail.address = address;

    return detail;
  }

  // 根据岗位 key 组装详情接口 URL，用于主动补拉详情。
  function getJobDetailRequestIdentity(job) {
    const rawJob = job && job.rawJob || {};
    const rawDetail = job && job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const identity = {
      encryptJobId: normalizeText(job && (
        job.encryptJobId ||
        rawJob.encryptJobId ||
        rawJob.encryptId ||
        rawJob.jobId ||
        rawJob.job_id ||
        rawJobInfo.encryptJobId ||
        rawJobInfo.encryptId ||
        rawJobInfo.jobId ||
        rawJobInfo.job_id
      )),
      securityId: normalizeText(job && (job.securityId || rawJob.securityId || rawDetail.securityId || rawJobInfo.securityId)),
      lid: normalizeText(job && (job.lid || rawJob.lid || rawDetail.lid || rawJobInfo.lid)),
    };

    getRouteJobDetailIdentities().some((routeIdentity) => {
      if (!isRouteIdentityCompatible(identity, routeIdentity)) return false;
      if (!identity.encryptJobId && routeIdentity.encryptJobId) identity.encryptJobId = routeIdentity.encryptJobId;
      if (!identity.securityId && routeIdentity.securityId) identity.securityId = routeIdentity.securityId;
      if (!identity.lid && routeIdentity.lid) identity.lid = routeIdentity.lid;
      return Boolean(identity.securityId && identity.lid);
    });

    return identity;
  }

  function buildJobDetailApiUrl(job) {
    const identity = getJobDetailRequestIdentity(job);
    const securityId = identity.securityId;
    const lid = identity.lid;
    if (!securityId || !lid) return '';

    const url = new URL('/wapi/zpgeek/job/detail.json', location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('lid', lid);
    url.searchParams.set('_', String(Date.now()));
    return url.href;
  }

  function getRouteJobDetailIdentities() {
    return [
      runtime.latestRouteUrl,
      runtime.initialPageUrl,
      location.href,
    ]
      .map(parseJobDetailIdentityFromUrl)
      .filter(Boolean);
  }

  function parseJobDetailIdentityFromUrl(href) {
    try {
      if (!href) return null;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;

      const pathname = url.pathname.replace(/\/+$/, '');
      const detailMatch = pathname.match(/\/job_detail\/([A-Za-z0-9_~-]+)(?:\.html)?$/);
      const encryptJobId = normalizeText(
        url.searchParams.get('jobId') ||
        url.searchParams.get('encryptJobId') ||
        url.searchParams.get('encryptId') ||
        (detailMatch && detailMatch[1])
      );
      const securityId = normalizeText(url.searchParams.get('securityId'));
      const lid = normalizeText(url.searchParams.get('lid'));
      if (!encryptJobId && !securityId && !lid) return null;

      return { encryptJobId, securityId, lid, href: url.href };
    } catch (_) {
      return null;
    }
  }

  function isRouteIdentityCompatible(jobIdentity, routeIdentity) {
    if (!routeIdentity) return false;
    const jobId = normalizeText(jobIdentity && jobIdentity.encryptJobId);
    const routeJobId = normalizeText(routeIdentity.encryptJobId);
    if (jobId && routeJobId && jobId !== routeJobId) return false;
    return true;
  }

  // 从 performance 资源记录里找最近一次列表接口，主动补抓时使用。
  function findLatestJobListApiUrl() {
    const resource = findLatestJobListApiResource();
    return resource && resource.url || '';
  }

  // 返回最近列表资源的 URL 和完成时间；对象形式便于与 fetch/XHR 捕获记录按时间统一排序。
  function findLatestJobListApiResource() {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;

    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobListApiPattern.test(entry.name))
      .sort((a, b) => b.startTime - a.startTime);
    if (!entries.length) return null;
    return {
      url: entries[0].name,
      capturedAt: getResourceEntryCompletedAt(entries[0]),
      source: 'performance-buffer',
    };
  }

  // 从 performance 资源记录里找点击岗位后出现的详情接口。
  function findLatestJobDetailApiUrl(resourceStartedAt) {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return '';

    const minimumStart = Math.max(0, Number(resourceStartedAt || 0) - 100);
    const entries = performance.getEntriesByType('resource')
      .filter((entry) => APP.jobDetailApiPattern.test(entry.name) && entry.startTime >= minimumStart)
      .sort((a, b) => b.startTime - a.startTime);
    return entries.length ? entries[0].name : '';
  }

  // 根据详情字段拼出岗位 HTML 页面地址，用于补抓描述和公司信息。
  function buildJobHtmlDetailUrl(detail) {
    const encryptJobId = normalizeText(detail && detail.encryptJobId);
    const securityId = normalizeText(detail && detail.securityId);
    if (!encryptJobId || !securityId) return '';

    const url = new URL(`/job_detail/${encodeURIComponent(encryptJobId)}.html`, location.origin);
    url.searchParams.set('securityId', securityId);
    url.searchParams.set('ka', `company_more_job_${encryptJobId}`);
    return url.href;
  }

  // 根据详情字段拼出公司主页地址，用于补抓工商信息。
  function buildCompanyHtmlUrl(detail) {
    const rawDetail = detail && detail.rawDetail || {};
    const brandInfo = rawDetail.brandComInfo || rawDetail.brandInfo || rawDetail.companyInfo || {};
    const brandId = normalizeText(detail && detail.brandId) ||
      normalizeText(detail && detail.rawJob && detail.rawJob.encryptBrandId) ||
      normalizeText(brandInfo.encryptBrandId);
    if (!brandId) return '';

    return new URL(`/gongsi/${encodeURIComponent(brandId)}.html`, location.origin).href;
  }

  // 解析岗位详情 HTML，提取接口没有给全的岗位描述、地址、公司链接等。
  function parseJobHtmlDetail(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const jobInfo = extractInlineJobInfo(html);
    const bossInfo = parseBossHtmlInfo(doc, hiddenClasses);
    const sideCompany = parseSideCompanyInfo(doc, hiddenClasses);
    const mapElement = doc.querySelector('.company-address .job-location-map, .job-location-map');
    const mapPoint = parseMapPoint(mapElement && mapElement.getAttribute('data-lat'));
    const companyFullName = businessInfo['公司名称'] || businessInfo['企业名称'] || '';
    const companyShortName = normalizeText(jobInfo.company) ||
      firstTextFromSelectors(doc, [
        '.sider-company .company-info a[title]',
        '.sider-company .company-info a:last-child',
        '.smallbanner .detail-op .info',
      ], hiddenClasses);

    const postDescriptionElement = doc.querySelector('.job-detail .job-keyword-list + .job-sec-text') ||
      Array.from(doc.querySelectorAll('.job-detail > .job-detail-section .job-sec-text'))
        .find((element) => /岗位|职责|任职|要求|经验|开发|工作/.test(cleanElementText(element, hiddenClasses)));
    const companyIntroduceElement = doc.querySelector('.job-detail-company .company-info-box .job-sec-text');
    const addressElement = doc.querySelector('.company-address .location-address') ||
      doc.querySelector('.job-location .location-address');
    const htmlSalary = firstTextFromSelectors(doc, [
      '.job-primary .salary',
      '.smallbanner .salary',
      '.smallbanner .badge',
      '.job-banner .salary',
      'span.salary',
    ], hiddenClasses);

    const detail = {
      jobName: textFromSelector(doc, '.job-primary .name h1, .smallbanner .job-title', hiddenClasses) ||
        normalizeText(jobInfo.job_name),
      salary: getReadableSalary(htmlSalary || jobInfo.job_salary),
      company: companyFullName || companyShortName,
      companyShortName,
      companyFullName,
      city: textFromSelector(doc, '.job-primary .text-city', hiddenClasses),
      experience: textFromSelector(doc, '.job-primary .text-experiece, .job-primary .text-experience', hiddenClasses),
      degree: textFromSelector(doc, '.job-primary .text-degree', hiddenClasses),
      showSkills: textsFromSelector(doc, '.job-keyword-list li', hiddenClasses),
      companyLabels: textsFromSelector(doc, '.job-primary .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)
        .concat(textsFromSelector(doc, '.smallbanner .tag-container-new > .job-tags:not(.tag-all) span', hiddenClasses)),
      postDescription: cleanElementText(postDescriptionElement, hiddenClasses),
      bossName: bossInfo.bossName,
      bossTitle: bossInfo.bossTitle,
      bossActiveTimeDesc: bossInfo.bossActiveTimeDesc,
      bossOnline: bossInfo.bossOnline,
      address: cleanElementText(addressElement, hiddenClasses),
      workAddress: cleanElementText(addressElement, hiddenClasses),
      longitude: mapPoint && mapPoint.longitude,
      latitude: mapPoint && mapPoint.latitude,
      encryptAddressId: mapElement && normalizeText(mapElement.getAttribute('data-addressid')),
      companyIntroduce: cleanElementText(companyIntroduceElement, hiddenClasses),
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立日期'] || businessInfo['成立时间'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资金'] || businessInfo['注册资本'] || '',
      companyStage: sideCompany.companyStage,
      companyScale: sideCompany.companyScale,
      companyIndustry: sideCompany.companyIndustry,
      htmlDetailUrl: sourceUrl,
      htmlCapturedAt: nowIso(),
      rawHtmlDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    };

    detail.companyLabels = Array.from(new Set(detail.companyLabels.filter(Boolean)));
    detail.showSkills = Array.from(new Set(detail.showSkills.filter(Boolean)));
    return compactObject(detail);
  }

  // 解析公司主页 HTML 中的工商信息，最终会合并进岗位记录并导出。
  function parseCompanyBusinessHtml(html, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html || ''), 'text/html');
    const hiddenClasses = getHtmlHiddenClassNames(doc);
    const businessInfo = extractBusinessInfo(doc, hiddenClasses);
    const companyFullName = businessInfo['企业名称'] || businessInfo['公司名称'] || '';

    return compactObject({
      company: companyFullName,
      companyFullName,
      businessInfo,
      legalRepresentative: businessInfo['法定代表人'] || businessInfo['法人'] || '',
      establishedDate: businessInfo['成立时间'] || businessInfo['成立日期'] || '',
      companyType: businessInfo['企业类型'] || businessInfo['公司类型'] || '',
      manageState: businessInfo['经营状态'] || businessInfo['登记状态'] || '',
      registeredCapital: businessInfo['注册资本'] || businessInfo['注册资金'] || '',
      registeredAddress: businessInfo['注册地址'] || '',
      businessTerm: businessInfo['营业期限'] || '',
      businessRegion: businessInfo['所属地区'] || '',
      unifiedSocialCreditCode: businessInfo['统一社会信用代码'] || '',
      approvalDate: businessInfo['核准日期'] || '',
      formerName: businessInfo['曾用名'] || '',
      registrationAuthority: businessInfo['登记机关'] || '',
      businessIndustry: businessInfo['所属行业'] || '',
      businessScope: businessInfo['经营范围'] || '',
      companyDetailUrl: sourceUrl,
      companyDetailCapturedAt: nowIso(),
      rawCompanyDetail: {
        title: normalizeText((doc.querySelector('title') || {}).textContent || ''),
        metaDescription: getMetaContent(doc, 'description'),
      },
    });
  }

  // 从页面内联 JSON/脚本片段中兜底提取岗位信息。
  function extractInlineJobInfo(html) {
    const match = String(html || '').match(/var\s+_jobInfo\s*=\s*(\{[\s\S]*?\});/);
    if (!match) return {};

    try {
      const source = match[1]
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      return JSON.parse(source);
    } catch (_) {
      return {};
    }
  }

  // BOSS HTML 里可能有隐藏节点；先收集隐藏 class，后续提取文本时跳过。
  function getHtmlHiddenClassNames(doc) {
    const hidden = new Set();
    const styles = Array.from(doc.querySelectorAll('style'))
      .map((style) => style.textContent || '')
      .join('\n');
    const pattern = /\.([A-Za-z_-][\w-]*)\s*\{([^}]*)\}/g;
    let match = pattern.exec(styles);

    while (match) {
      const body = match[2];
      if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|width\s*:\s*0\.?1?px|height\s*:\s*0\.?1?px/i.test(body)) {
        hidden.add(match[1]);
      }
      match = pattern.exec(styles);
    }

    return hidden;
  }

  // 读取单个选择器文本，并过滤隐藏节点内容。
  function textFromSelector(root, selector, hiddenClasses) {
    return cleanElementText(root && root.querySelector(selector), hiddenClasses);
  }

  // 多选择器兜底读取第一个非空文本。
  function firstTextFromSelectors(root, selectors, hiddenClasses) {
    for (const selector of selectors) {
      const candidates = Array.from(root ? root.querySelectorAll(selector) : []);
      for (const candidate of candidates) {
        const text = cleanElementText(candidate, hiddenClasses);
        if (text) return text.replace(/\s*查看所有职位.*/g, '').trim();
      }
    }
    return '';
  }

  // 读取同类节点的文本列表，例如技能标签、福利标签。
  function textsFromSelector(root, selector, hiddenClasses) {
    return Array.from(root ? root.querySelectorAll(selector) : [])
      .map((element) => cleanElementText(element, hiddenClasses))
      .filter(Boolean);
  }

  // 克隆节点后移除隐藏子节点，避免把页面埋点/SEO 文本误采进记录。
  function cleanElementText(element, hiddenClasses) {
    if (!element) return '';

    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, svg, #zhipin-auto-greeting-root').forEach((item) => item.remove());
    clone.querySelectorAll('*').forEach((item) => {
      const style = String(item.getAttribute('style') || '');
      const hiddenByStyle = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
      const hiddenByClass = Array.from(item.classList || []).some((className) => hiddenClasses && hiddenClasses.has(className));
      if (hiddenByStyle || hiddenByClass || item.hidden) item.remove();
    });
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return normalizeTextPreserveLines(clone.textContent || '');
  }

  // 从公司页中识别“法人/注册资本/经营范围”等工商字段。
  function extractBusinessInfo(doc, hiddenClasses) {
    const output = {};
    doc.querySelectorAll([
      '.business-info-box .level-list li',
      '.company-business .business-detail li',
    ].join(',')).forEach((item) => {
      const labelElement = item.querySelector('.t, span');
      const label = cleanElementText(labelElement, hiddenClasses).replace(/[：:]$/, '');
      if (!label) return;

      const clone = item.cloneNode(true);
      const clonedLabel = clone.querySelector('.t, span');
      if (clonedLabel) clonedLabel.remove();
      const value = cleanElementText(clone, hiddenClasses);
      if (value) output[label] = value;
    });
    return output;
  }

  // 从岗位 HTML 中解析 Boss 姓名、职位、活跃状态等聊天前有用字段。
  function parseBossHtmlInfo(doc, hiddenClasses) {
    const nameElement = doc.querySelector('.job-boss-info h2.name');
    let bossName = '';
    if (nameElement) {
      const clone = nameElement.cloneNode(true);
      clone.querySelectorAll('i, .boss-online-tag, .boss-active-time').forEach((item) => item.remove());
      bossName = cleanElementText(clone, hiddenClasses);
    }

    const attr = textFromSelector(doc, '.job-boss-info .boss-info-attr', hiddenClasses);
    const parts = attr.split('·').map(normalizeText).filter(Boolean);
    const bossActiveInfo = extractBossActiveInfoFromRoot(doc, hiddenClasses, { visibleOnly: false });
    return {
      bossName,
      bossTitle: parts.length > 1 ? parts[parts.length - 1] : '',
      bossActiveTimeDesc: bossActiveInfo.bossActiveTimeDesc,
      bossOnline: Boolean(bossActiveInfo.bossOnline),
    };
  }

  // 从岗位详情侧栏读取公司简称、阶段、规模等补充信息。
  function parseSideCompanyInfo(doc, hiddenClasses) {
    const side = doc.querySelector('.sider-company');
    const rows = Array.from(side ? side.querySelectorAll('p') : [])
      .map((row) => cleanElementText(row, hiddenClasses))
      .filter((text) => text && text !== '公司基本信息');

    return {
      companyStage: rows[0] || '',
      companyScale: rows[1] || '',
      companyIndustry: rows[2] || '',
    };
  }

  // 解析地图坐标字符串，导出时拆成经纬度字段。
  function parseMapPoint(value) {
    const parts = String(value || '').split(',').map((item) => Number(item));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return {
      longitude: parts[0],
      latitude: parts[1],
    };
  }

  // 读取 HTML meta 内容，作为标题/描述等兜底来源。
  function getMetaContent(doc, name) {
    const element = doc.querySelector(`meta[name="${name}"]`);
    return normalizeText(element && element.getAttribute('content'));
  }

  // 合并岗位信息：后到的详情字段覆盖空值或更低质量字段，保留原始 raw 数据。
  function mergeJobInfo(job, detail) {
    if (!detail || !Object.keys(detail).length) return job;

    const merged = Object.assign({}, job);
    const readableDetailSalary = getReadableSalary(detail.salary);

    for (const key of ['jobName', 'company', 'bossName', 'bossTitle', 'city', 'experience', 'degree']) {
      if (detail[key] && (!merged[key] || merged.domOnly)) {
        merged[key] = detail[key];
      }
    }

    if (detail.company && merged.company !== detail.company) {
      merged.company = detail.company;
    }
    if (detail.bossName) merged.bossName = detail.bossName;
    if (detail.bossTitle) merged.bossTitle = detail.bossTitle;
    if (detail.jobName && (!merged.jobName || merged.domOnly)) merged.jobName = detail.jobName;
    if (readableDetailSalary) {
      merged.salary = readableDetailSalary;
    }

    [
      'positionName',
      'bossActiveTimeDesc',
      'bossOnline',
      'bossAvatar',
      'bossCertificated',
      'address',
      'longitude',
      'latitude',
      'staticMapUrl',
      'encryptAddressId',
      'postDescription',
      'recruitmentCountDesc',
      'positionCode',
      'jobType',
      'jobStatusDesc',
      'showSkills',
      'companyLogo',
      'companyFullName',
      'companyShortName',
      'companyStage',
      'companyScale',
      'companyIndustry',
      'companyIntroduce',
      'companyLabels',
      'businessInfo',
      'legalRepresentative',
      'establishedDate',
      'companyType',
      'manageState',
      'registeredCapital',
      'registeredAddress',
      'businessTerm',
      'businessRegion',
      'unifiedSocialCreditCode',
      'approvalDate',
      'formerName',
      'registrationAuthority',
      'businessIndustry',
      'businessScope',
      'brandId',
      'detailSource',
      'detailSourceUrl',
      'detailCapturedAt',
      'workAddress',
      'htmlDetailUrl',
      'htmlCapturedAt',
      'companyDetailUrl',
      'companyDetailCapturedAt',
    ].forEach((key) => {
      if (detail[key] !== undefined && detail[key] !== null && detail[key] !== '') {
        merged[key] = Array.isArray(detail[key])
          ? detail[key].slice()
          : (typeof detail[key] === 'object' ? Object.assign({}, detail[key]) : detail[key]);
      }
    });

    if (detail.encryptJobId) merged.encryptJobId = detail.encryptJobId;
    if (detail.securityId) merged.securityId = detail.securityId;
    if (detail.lid) merged.lid = detail.lid;
    if (detail.rawDetail) merged.rawDetail = detail.rawDetail;
    if (detail.rawHtmlDetail) merged.rawHtmlDetail = detail.rawHtmlDetail;
    if (detail.rawCompanyDetail) merged.rawCompanyDetail = detail.rawCompanyDetail;

    merged.signature = makeSignature(merged.jobName, merged.company, merged.salary);
    merged.looseSignature = makeLooseSignature(merged.jobName, merged.company);
    merged.rawJob = Object.assign({}, merged.rawJob || {}, {
      jobName: merged.jobName,
      brandName: merged.company,
      salaryDesc: merged.salary,
      bossName: merged.bossName,
      bossTitle: merged.bossTitle,
      positionName: merged.positionName,
      address: merged.address,
      postDescription: merged.postDescription,
      showSkills: merged.showSkills,
      brandComInfo: {
        stageName: merged.companyStage,
        scaleName: merged.companyScale,
        industryName: merged.companyIndustry,
        introduce: merged.companyIntroduce,
        labels: merged.companyLabels,
      },
    });

    return merged;
  }

  // 岗位卡片切换后，必须确认右侧详情标题和沟通按钮都属于目标岗位，避免误点上一条残留详情。
  function getJobCommunicationDetailReady(job) {
    const detail = extractDetailInfo();
    if (!detail || !detail.jobName || !areComparableTextsCompatible(job && job.jobName, detail.jobName)) return null;
    const chatButton = findChatButton(job);
    if (!chatButton) return null;
    return { detail, chatButton };
  }

  // 要求“详情标题 + 公司 + 按钮身份”持续稳定一段时间，吸收 SPA 中旧详情响应晚到造成的瞬时回写。
  function waitForJobCommunicationDetail(job, timeout, settleMs) {
    const stableDuration = Math.max(0, Number(settleMs === undefined ? 300 : settleMs));
    let stableSince = 0;
    let stableIdentity = '';
    return waitFor(
      () => {
        const ready = getJobCommunicationDetailReady(job);
        if (!ready) {
          stableSince = 0;
          stableIdentity = '';
          return null;
        }

        // 任一可识别字段发生变化都重新计时，只有整个详情组合稳定后才允许沟通。
        const identity = [
          normalizeText(ready.detail && ready.detail.jobName),
          normalizeText(ready.detail && ready.detail.company),
          normalizeText(ready.chatButton && ready.chatButton.getAttribute('ka')),
          normalizeText(ready.chatButton && ready.chatButton.getAttribute('href')),
        ].join('|');
        if (identity !== stableIdentity) {
          stableIdentity = identity;
          stableSince = Date.now();
        }
        return Date.now() - stableSince >= stableDuration ? ready : null;
      },
      Math.max(2000, Number(timeout || getWaitTimeout() * 1000)),
      '当前岗位详情与沟通按钮',
      {
        observerRoot: getJobDetailObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'href', 'ka', 'style', 'hidden'],
        // 稳定窗口结束时 DOM 可能不再变化，需要低频复核时间条件。
        pollInterval: 120,
      },
    );
  }

  // 智联登录检测：未登录时 /jobs/ 无真实卡片、/sou/ 有 SSR 卡片但无投递能力。
  // 命中"需要登录"的语义文案即判定未登录，避免把所有岗位"静默跳过"造成困惑。
  // 刻意不用"登录/手机号登录"这类宽松词，防止误伤已登录状态下 footer/底部的通用登录链接。
  function detectZhilianLoggedOut() {
    try {
      const body = document.body;
      const text = normalizeText(body && (body.innerText || body.textContent) || '');
      return /请登录|登录后查看|未登录|登录后才能|扫码登录后|登录后方可/.test(text);
    } catch (_) {
      return false;
    }
  }

  // 智联招聘投递按钮候选：新版 /jobs/ 详情右栏和老版 /sou/ 列表卡片各有一套结构。
  const ZHILIAN_APPLY_SELECTOR = [
    '.job-detail-summary__apply',    // 新版详情右栏“立即投递/已投递”
    '.job-detail-summary__prechat',  // 新版详情右栏“先聊聊/继续沟通”
    '.job-detail-chat__btn',         // 新版沟通浮层“立即沟通”
    '.collect-and-apply__btn',       // 老版列表卡片“立即投递”
    '.joblist-box__item__jobbtn',    // 老版列表卡片按钮容器
    '.btninfo .btn',
    '.c-chat-job',                   // 老版列表卡片“立即沟通”
  ].join(', ');

  // 按文案把智联按钮归类：apply=可投递，chat=只能沟通，already=已投递过。
  function classifyZhilianApplyButton(element) {
    const text = normalizeText(element.innerText || element.textContent || '');
    if (!text) return null;
    if (/已投递|继续沟通/.test(text)) return 'already';
    if (/投递|投个简历/.test(text)) return 'apply';
    if (/立即沟通|先聊聊/.test(text)) return 'chat';
    return null;
  }

  // 按钮所属岗位块（老版卡片或新版共享详情面板），用于校验期望岗位名是否命中。
  function getZhilianButtonJobBlock(element) {
    return element.closest(
      '.joblist-box__item, .job-detail-summary, .job-detail-panel, .job-detail-box, .job-list-panel .job-card'
    ) || element;
  }

  // 在指定容器内找智联投递按钮：优先“投递”，其次“沟通”，最后才是“已投递”。
  // expectedName 为期望岗位名：非空时只接受所属岗位块包含该名称的按钮，
  // 避免新版 /jobs/ 共享详情面板在岗位切换滞后时点到上一岗位遗留的按钮。
  function findZhilianApplyButtonIn(root, expectedName) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const normalizedExpected = expectedName ? normalizeText(expectedName) : '';
    const classified = Array.from(root.querySelectorAll(ZHILIAN_APPLY_SELECTOR))
      .filter((element) => !isOwnUiElement(element) && isVisible(element))
      .map((element) => ({ element, kind: classifyZhilianApplyButton(element) }))
      .filter((item) => item.kind);

    if (normalizedExpected) {
      const scoped = classified.filter((item) => {
        const block = getZhilianButtonJobBlock(item.element);
        const text = normalizeText(block && (block.innerText || block.textContent));
        return text.includes(normalizedExpected);
      });
      if (scoped.length) {
        return scoped.find((item) => item.kind === 'apply') ||
          scoped.find((item) => item.kind === 'chat') ||
          scoped.find((item) => item.kind === 'already') ||
          null;
      }
      // 岗位块均不含期望岗位名时，视为未就绪/已切走，返回 null 交给上层等待或跳过。
      return null;
    }
    return classified.find((item) => item.kind === 'apply') ||
      classified.find((item) => item.kind === 'chat') ||
      classified.find((item) => item.kind === 'already') ||
      null;
  }

  // 整页查找，用于新版 /jobs/ 右侧共享详情面板。
  function findZhilianApplyButton(expectedName) {
    return findZhilianApplyButtonIn(document, expectedName);
  }

  // 智联弹窗可能挂在 body 下，也可能带 dialog/modal 语义；优先语义节点，避免扫描整页容器。
  function getZhilianOverlayRoots() {
    const semantic = Array.from(document.querySelectorAll(
      '[role="dialog"], .dialog, .modal, .popup, [class*="dialog"], [class*="modal"], [class*="popup"]'
    )).filter((element) => !isOwnUiElement(element) && isVisible(element));
    if (semantic.length) return semantic;

    return Array.from(document.body ? document.body.children : [])
      .filter((element) => {
        if (isOwnUiElement(element) || !isVisible(element)) return false;
        const style = getComputedStyle(element);
        const zIndex = Number(style.zIndex || 0);
        return (style.position === 'fixed' || style.position === 'absolute') && zIndex >= 10;
      });
  }

  // 投递成功后智联会弹“已向对方发送简历和打招呼语”，点“留在此页”留下列表继续自动化。
  // roots 允许调用方传入“点击后新增/变化的浮层”，避免误中点击前就存在的筛选浮层。
  function findZhilianStayButton(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      // 用 textContent 做长度判断，比 innerText 便宜，避免对整页容器触发布局。
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (!/留在此页/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const stay = buttons.find((button) => /^留在此页$/.test(
        normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || ''),
      ));
      if (stay) return stay;
    }
    return null;
  }

  // 二次确认弹窗（选择简历/确认投递）的确认按钮，不会误点“取消/关闭”。
  function findZhilianConfirmButton(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (/留在此页/.test(rawText)) continue; // 打招呼语弹窗交给 findZhilianStayButton
      if (!/简历|投递|确认/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button) && !button.disabled);
      const hit = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        if (!label || label.length > 10) return false;
        // 先排除取消/关闭类动作，避免误点弹窗右上角的 ×、“留在此页”“更换简历”。
        if (/取消|关闭|暂不|先不|放弃|返回|更换|收起|稍后|留在/.test(label)) return false;
        // 新版智联“请选择要投递的简历”弹窗的确认按钮文案是“投递简历”，
        // 旧正则只认“确认/确定/投递”，会漏掉它导致一直卡在选简历弹窗。
        return /^(确认|确定|投递|投递简历|确认投递|确认投递简历|立即投递|继续投递|选择并投递|发送简历|确认发送)$/.test(label)
          || /投递简历|简历投递/.test(label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 选简历弹窗右上角的关闭按钮；仅在确认超时（无可投简历/按钮禁用）时用于清理残留浮层，
  // 避免弹窗盖住列表导致后续卡片点不到。
  function findZhilianDialogClose(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      if (!/简历|投递|确认/.test(rawText)) continue;
      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], [aria-label]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const hit = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^(×|✕|✖|关闭|取消|暂不投递|暂不)$/.test(label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 判断投递是否已完成：按钮变成“已投递”，或页面出现“投递成功”提示。
  // 方案一：在智联投递弹窗中定位“打招呼语/附言”输入框，用于直接注入自定义问候语。
  // 优先匹配带“打招呼/附言/多说一句/留言”占位符或 aria-label 的文本输入控件。
  function findZhilianGreetingInput(roots) {
    for (const root of roots || getZhilianOverlayRoots()) {
      const rawText = root.textContent || '';
      if (!rawText || rawText.length > 800) continue;
      const inputs = Array.from(
        root.querySelectorAll('textarea, input[type="text"], input[type="input"], [contenteditable="true"]')
      ).filter((element) => !isOwnUiElement(element) && isVisible(element));
      const hit = inputs.find((element) => {
        const placeholder = normalizeText(element.getAttribute && (element.getAttribute('placeholder') || '') || '');
        const label = normalizeText(element.getAttribute && (element.getAttribute('aria-label') || '') || '');
        return /打招呼|附言|多说一句|留言|给[?n]?HR/.test(placeholder + ' ' + label);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 方案一：把自定义问候语写入智联“打招呼/附言”输入框。contenteditable 走富文本写入，
  // textarea/input 走原生 value setter + 派发 input/change 事件，保证页面框架能收到输入。
  function injectZhilianGreeting(input, text) {
    if (!input || !text) return false;
    try {
      if (input.isContentEditable) {
        setEditableText(input, text);
      } else {
        const prototype = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        if (setter) {
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.value = text;
        }
      }
    } catch (error) {
      logDebugEvent('zhilian_greeting_inject_error', {
        message: String((error && error.message) || error),
      }, 'warn');
      return false;
    }
    const current = normalizeText(input.value != null ? String(input.value) : (getEditableText(input) || ''));
    return current === normalizeText(text);
  }

  // 判断投递是否已完成：按钮变成“已投递”，或页面出现“投递成功”提示。
  function findZhilianAppliedIndicator() {
    const applyButtons = Array.from(document.querySelectorAll('.job-detail-summary__apply, .collect-and-apply__btn'))
      .filter((element) => !isOwnUiElement(element) && isVisible(element));
    if (applyButtons.some((button) => /已投递/.test(normalizeText(button.innerText || button.textContent || '')))) {
      return true;
    }
    // 提示条只可能是短文案，限制长度避免误中包含岗位列表的大型容器。
    return Array.from(document.querySelectorAll('[class*="toast"], [class*="notice"], [class*="tip"]'))
      .filter((element) => !isOwnUiElement(element) && isVisible(element))
      .some((element) => {
        const text = normalizeText(element.innerText || element.textContent || '');
        return text.length <= 120 && /投递成功/.test(text);
      });
  }

  // 在岗位详情页查找“立即沟通/继续沟通”按钮，点击它会进入聊天页。
  function findChatButton(job) {
    const candidates = Array.from(document.querySelectorAll(
      'a.op-btn.op-btn-chat, button.op-btn.op-btn-chat, .op-btn.op-btn-chat, [class*="op-btn-chat"]'
    ))
      .filter((element) => isVisible(element) && /立即沟通|继续沟通/.test(normalizeText(element.innerText || element.textContent || '')));
    const encryptJobId = normalizeText(job && job.encryptJobId);
    if (!encryptJobId) return candidates[0] || null;

    return candidates.find((element) => {
      const identityText = [
        element.getAttribute('ka'),
        element.getAttribute('href'),
        element.getAttribute('data-jobid'),
        element.getAttribute('data-job-id'),
      ].filter(Boolean).join('|');
      return identityText.includes(encryptJobId);
    }) || null;
  }

  // 在岗位详情页查找 BOSS“投简历”按钮（主动投递简历用）。
  // 排除“已投递/继续沟通/立即沟通”，只匹配可投的投递/投简历按钮，避免误点沟通入口。
  function findBossDeliverResumeButton() {
    return Array.from(document.querySelectorAll(
      'a[class*="op-btn"], button[class*="op-btn"], a[class*="btn"], button[class*="btn"]'
    ))
      .filter((element) => isVisible(element) && !isOwnUiElement(element))
      .find((element) => {
        const text = normalizeText(element.innerText || element.textContent || '');
        if (/已投递|继续沟通|立即沟通|沟通|收藏/.test(text)) return false;
        return /^投(个)?简历$/.test(text) || /投递简历|投递/.test(text);
      }) || null;
  }

  // 查找投简历可能弹出的确认按钮（“确认/确定/确认投递”），用于收尾弹窗。
  function findBossApplyConfirmButton() {
    return Array.from(document.querySelectorAll('button, a, [role="button"], [class*="btn"]'))
      .filter((element) => isVisible(element) && !isOwnUiElement(element) && !element.disabled)
      .find((element) => {
        const label = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
        return /确认投递|确认投递简历|确认|确定/.test(label);
      }) || null;
  }

  // BOSS 投递简历主流程：找到投简历按钮 → 点击 → 处理可能的确认弹窗 → 返回是否投递。
  // 全部防御式：找不到按钮/超时/失败一律不抛异常，仅返回状态，不影响后续沟通。
  async function tryBossDeliverResume(job) {
    const button = await waitFor(() => findBossDeliverResumeButton(), 2500, 'BOSS 投简历按钮')
      .catch(() => null);
    if (!button) {
      logDebugEvent('boss_apply_no_button', { jobName: job.jobName || '' }, 'warn');
      return { applied: false, reason: 'no_button' };
    }

    clickElement(button);
    logDebugEvent('boss_apply_button_clicked', { jobName: job.jobName || '' });

    const outcome = await waitFor(() => {
      if (runtime.stopRequested) return 'stopped';
      // 投递成功后按钮文案变为“已投递”，或原按钮消失。
      const current = findBossDeliverResumeButton();
      if (!current || /已投递/.test(normalizeText(current.innerText || current.textContent || ''))) return 'applied';
      // 出现确认弹窗则先确认。
      if (findBossApplyConfirmButton()) return 'confirm';
      return null;
    }, 4000, 'BOSS 投简历结果', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 100,
    }).catch(() => null);

    if (outcome === 'confirm') {
      const confirmButton = findBossApplyConfirmButton();
      if (confirmButton) clickElement(confirmButton);
      await sleep(600);
      return { applied: true };
    }
    if (outcome === 'applied') return { applied: true };

    logDebugEvent('boss_apply_unconfirmed', {
      jobName: job.jobName || '',
      outcome: outcome || 'timeout',
    }, 'warn');
    return { applied: false, reason: 'unconfirmed' };
  }

  // 聊天页常用语按钮定位，当前发送流程主要使用文本注入，这里保留给兼容判断。
  function findCommonPhraseButton() {
    const selectors = [
      'div[aria-label="常用语"]',
      '[aria-label="常用语"]',
      '.btn-dict',
      '[class*="btn-dict"]',
    ];

    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((item) => !isOwnUiElement(item) && isVisible(item));
      if (element) return element;
    }

    return Array.from(document.querySelectorAll('button, div, span, a'))
      .find((element) => !isOwnUiElement(element) && isVisible(element) && /常用语/.test(normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '')));
  }

  // 定位聊天输入框。BOSS 可能使用 contenteditable div，也可能包在不同容器里。
  function findChatInput(doc) {
    const root = doc || null;
    // 合并两个实现的选择器：先 BOSS 专属 chat-input，再聊天/消息容器内输入框，最后兜底。
    const selectors = [
      '#chat-input.chat-input[contenteditable="true"]',
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
      '[class*="chat-input"]',
      '[class*="chat"] textarea',
      '[class*="chat"] [contenteditable="true"]',
      '[class*="message"] textarea',
      '[class*="message"] [contenteditable="true"]',
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="沟通"]',
      '[contenteditable="true"][data-placeholder*="消息"]',
      '[contenteditable="true"][aria-label*="消息"]',
      'textarea',
      '[contenteditable="true"]',
    ];

    // doc 未指定时遍历顶层与同源 iframe，避免聊天窗口渲染在 iframe 中时定位不到。
    const docs = root ? [root] : getAccessibleDocuments();
    for (const currentDoc of docs) {
      for (const selector of selectors) {
        const elements = Array.from(currentDoc.querySelectorAll(selector))
          .filter((item) => !isOwnUiElement(item) && isVisible(item));
        if (!elements.length) continue;
        // 优先带聊天语义占位符的输入框，避免误中普通 textarea。
        const semantic = elements.find((item) => /请输入|聊|消息|沟通|打招呼|回复/.test(
          item.getAttribute && (item.getAttribute('placeholder') || item.getAttribute('data-placeholder') || item.getAttribute('aria-label') || '')
        ));
        return semantic || elements[elements.length - 1];
      }
    }

    return null;
  }

  // 定位聊天页发送按钮；Enter 发送失败时会作为兜底点击。
  function findSendButton() {
    const selectors = [
      'button.btn-send',
      '.chat-op button',
      '.chat-op [class*="send"]',
      'button[class*="send"]',
    ];

    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find((element) => {
        const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
        const className = String(element.className || '');
        return !isOwnUiElement(element) &&
          isVisible(element) &&
          !element.disabled &&
          !/(disabled|unable)/i.test(className) &&
          (/发送/.test(text) || /send/i.test(className));
      });
      if (found) return found;
    }

    return Array.from(document.querySelectorAll('button, a, div, span')).find((element) => {
      const text = normalizeText(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      const className = String(element.className || '');
      return !isOwnUiElement(element) &&
        isVisible(element) &&
        !element.disabled &&
        !/(disabled|unable)/i.test(className) &&
        text === '发送';
    });
  }

  // 判断节点是否属于脚本自身 UI（控制面板）。
  function isOwnUiElement(element) {
    if (!element || !element.closest) return false;
    return Boolean(element.closest('#zhipin-auto-greeting-root'));
  }

  // 判断聊天页左侧会话列表是否渲染完成。
  function hasConversationList() {
    return Array.from(document.querySelectorAll('.user-list-content li, .user-list li, .chat-user li'))
      .some((element) => isVisible(element) && normalizeText(element.innerText || element.textContent || '').length > 4);
  }

  // 在聊天页左侧会话列表中确认当前会话是否对应 pendingJob。
  function findSelectedConversationForJob(job) {
    if (!job) return null;

    const bossName = normalizeText(job.bossName);
    const company = normalizeText(job.company);
    const jobName = normalizeText(job.jobName);
    const selectors = [
      '.user-list-content li.selected',
      '.user-list-content li.active',
      '.user-list-content li.cur',
      '.user-list li.selected',
      '.user-list li.active',
      '.user-list li.cur',
      '.chat-user li.selected',
      '.chat-user li.active',
      '.chat-user li.cur',
      '.friend-content.selected',
      '.friend-content.active',
      '.friend-content.cur',
      '.friend-content-warp.selected',
      '.friend-content-warp.active',
      '.friend-content-warp.cur',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);
    let best = null;

    for (const element of candidates) {
      const text = normalizeText(element.innerText || element.textContent || '');
      if (!text || text.length < 2) continue;

      let score = 0;
      if (bossName && text.includes(bossName)) score += 4;
      if (company && text.includes(company)) score += 4;
      if (jobName && text.includes(jobName)) score += 2;
      if (/正在与Boss|沟通/.test(text)) score += 1;

      if (!best || score > best.score) {
        best = { element, score, text };
      }
    }

    if (!best || best.score < 4) return null;
    return best;
  }

  // 构造“需要人工处理”的暂停错误，区别于真正脚本异常。
  function createPauseError(message) {
    const error = new Error(message);
    error.zhipinAutoPause = true;
    return error;
  }

  // 识别 BOSS 沟通相关平台弹窗（温馨提示 / 次数用尽等），排除脚本自己的确认框。
  function findBossPlatformDialog() {
    const selectorRoots = Array.from(document.querySelectorAll([
      '[role="dialog"]',
      '.dialog-wrap',
      '.boss-dialog',
      '.common-dialog',
      '.dialog-container',
      '.dialog-layer',
      '.boss-popup',
      '.confirm-dialog',
      '.ui-dialog',
    ].join(','))).filter((element) => !isOwnUiElement(element) && isVisible(element));

    // 部分弹窗没有稳定 class，退回扫描看起来像浮层的节点，避免误伤整页容器。
    const overlayRoots = Array.from(document.querySelectorAll('body > div, .dialog, .popup, .modal'))
      .filter((element) => {
        if (isOwnUiElement(element) || !isVisible(element)) return false;
        if (selectorRoots.includes(element)) return false;
        const style = getComputedStyle(element);
        const position = style.position;
        const zIndex = Number(style.zIndex || 0);
        return (position === 'fixed' || position === 'absolute') && (zIndex >= 10 || style.backgroundColor !== 'rgba(0, 0, 0, 0)');
      });

    const roots = selectorRoots.concat(overlayRoots);
    let best = null;
    for (const root of roots) {
      const text = normalizeText(root.innerText || root.textContent || '');
      if (!text || text.length < 6 || text.length > 500) continue;

      const stayPage = /留在此页/.test(text) && /离开|继续/.test(text);
      const softReminder = /温馨提示/.test(text) && /沟通/.test(text)
        || /还剩\s*\d+\s*次沟通/.test(text)
        || /您今天已与\s*\d+\s*位/.test(text)
        || /沟通机会/.test(text) && /今天已与|还剩/.test(text);
      const hardLimit = /今日沟通(?:次数)?已(?:用完|达上限)|沟通次数(?:已)?(?:用完|达上限)|无法继续沟通|今日无法再沟通|已达(?:到)?沟通上限/.test(text);
      if (!softReminder && !hardLimit && !stayPage) continue;

      const buttons = Array.from(root.querySelectorAll('button, a, [role="button"], .btn, [class*="btn"]'))
        .filter((button) => !isOwnUiElement(button) && isVisible(button));
      const stayButton = buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^留在此页$/.test(label);
      });
      const confirmButton = stayButton || buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /^(确定|知道了|我知道了|继续|关闭|留在此页)$/.test(label);
      }) || buttons.find((button) => {
        const label = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        return /确定|知道了|我知道了/.test(label) && !/取消|开通|升级|购买|查看权益/.test(label);
      });

      const score = (hardLimit ? 4 : 0) + (stayPage ? 3 : 0) + (softReminder ? 2 : 0) + (confirmButton ? 1 : 0) + Math.min(text.length, 80) / 80;
      if (!best || score > best.score) {
        best = {
          root,
          text,
          kind: hardLimit ? 'hard_limit' : stayPage ? 'stay_page' : 'soft_reminder',
          confirmButton: confirmButton || null,
          score,
        };
      }
    }

    return best;
  }

  // 生成沟通上限暂停文案，避免把整段弹窗原文塞进状态栏。
  function formatBossDialogPauseMessage(dialog) {
    const text = normalizeText(dialog && dialog.text || '');
    const short = text.length > 60 ? `${text.slice(0, 60)}...` : text;
    return short ? `沟通受限，已暂停：${short}` : '沟通次数已达上限，已暂停';
  }

  // 检查并处理平台弹窗：软提醒可点击确定；硬限制只返回结果，由调用方 pause。
  function inspectBossPlatformDialog(options) {
    const settings = options || {};
    const dialog = findBossPlatformDialog();
    if (!dialog) return null;

    if (dialog.kind === 'stay_page' && dialog.confirmButton) {
      logDebugEvent('delivery_stay_page_dialog', {
        kind: dialog.kind,
        text: summarizeLongText(dialog.text),
        buttonText: normalizeText(dialog.confirmButton.innerText || dialog.confirmButton.textContent || ''),
        action: '留在此页',
      }, 'warn');
      clickElement(dialog.confirmButton);
      runtime.lastBossDialogDismissAt = Date.now();
    } else if (dialog.kind === 'soft_reminder' && settings.dismissSoft && dialog.confirmButton) {
      const lastAt = Number(runtime.lastBossDialogDismissAt || 0);
      if (Date.now() - lastAt > 900) {
        UI.setStatus('检测到沟通提醒弹窗，正在点击确定...', 'warn');
        logDebugEvent('boss_platform_dialog_dismiss', {
          kind: dialog.kind,
          text: summarizeLongText(dialog.text),
          buttonText: normalizeText(dialog.confirmButton.innerText || dialog.confirmButton.textContent || ''),
        });
        clickElement(dialog.confirmButton);
        runtime.lastBossDialogDismissAt = Date.now();
      }
    } else if (dialog.kind === 'hard_limit') {
      logDebugEvent('boss_platform_dialog_hard_limit', {
        kind: dialog.kind,
        text: summarizeLongText(dialog.text),
      }, 'warn');
    }

    return dialog;
  }

  // 聊天页输入框长期不出现时，允许走重新点击沟通的重试路径。
  function isChatRenderTimeoutError(error) {
    return Boolean(error && /聊天界面渲染\s*等待超时/.test(String(error.message || error)));
  }

  // 等待聊天页关键区域就绪：输入框、会话列表、当前会话匹配。
  // 等待过程中若出现沟通次数提醒弹窗，先点确定；硬限制则暂停。
  function waitForChatReady(job) {
    logDebugEvent('wait_chat_ready_start', {
      job: summarizeJobForDebug(job),
      timeoutSeconds: getWaitTimeout(),
      chatWaitTimeoutSeconds: getChatWaitTimeout(),
      hasChatInput: Boolean(findChatInput()),
      isChatPage: isChatPage(),
      runState: RunState.load(),
    });
    return waitFor(() => {
      const dialog = inspectBossPlatformDialog({ dismissSoft: true });
      if (dialog && dialog.kind === 'hard_limit') {
        throw createPauseError(formatBossDialogPauseMessage(dialog));
      }

      if (!/\/chat\b|\/web\/geek\/chat/.test(location.pathname + location.hash) && !document.querySelector('.chat-input')) {
        return null;
      }

      if (document.readyState === 'loading') return null;

      const readyTarget = findChatInput();
      if (readyTarget) {
        logDebugEvent('wait_chat_ready_success', {
          job: summarizeJobForDebug(job),
          inputText: summarizeLongText(getEditableText(readyTarget)),
          href: location.href,
        });
        return readyTarget;
      }

      return null;
    }, getWaitTimeout(), '聊天界面渲染', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'contenteditable'],
      // history 路由变化本身不一定产生 DOM mutation，低频轮询仅用于这一兜底。
      pollInterval: 200,
    });
  }

  // 向聊天输入框写入文本并按 Enter，返回发送前快照供后续确认。
  async function sendChatTextByEnter(messageText) {
    const input = await waitFor(() => findChatInput(), getChatWaitTimeout(), '聊天输入框', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'contenteditable'],
    });
    const snapshot = getSendVerificationSnapshot(messageText);

    // BOSS 聊天框是 contenteditable div。这里只负责写入草稿并触发 Enter，是否真的发出由后续聊天记录确认决定。
    setEditableText(input, messageText);
    await waitFor(() => inputContainsText(findChatInput(), messageText), 3000, '聊天输入框写入文本', {
      observerRoot: input.parentElement || input,
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden', 'value'],
      // textarea.value 属于属性状态，不保证产生 MutationRecord。
      pollInterval: 120,
    });

    pressEnter(findChatInput() || input);

    // 如果 Enter 没有触发发送，观察聊天区域到短超时，再最多点击一次页面自己的发送按钮。
    const sentByEnter = await waitFor(() => {
      const current = getSendVerificationSnapshot(messageText);
      return isMessageActuallySent(snapshot, current) ? true : null;
    }, 800, 'Enter 发送结果', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 120,
    }).then(() => true).catch(() => false);
    if (!sentByEnter && inputContainsText(findChatInput(), messageText)) {
      const sendButton = findSendButton();
      if (sendButton) clickNative(sendButton);
    }

    return snapshot;
  }

  // 等待输入框清空且聊天记录中新出现目标文本，确认消息确实发送。
  async function waitForMessageSent(messageText, beforeSend) {
    const snapshot = beforeSend || getSendVerificationSnapshot(messageText);

    await waitFor(() => {
      const input = findChatInput();
      const inputCleared = !normalizeText(getEditableText(input));
      const current = getSendVerificationSnapshot(messageText);

      if (inputCleared && isMessageActuallySent(snapshot, current)) {
        return true;
      }
      return null;
    }, getChatWaitTimeout(), '消息发送确认', {
      observerRoot: getChatObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 120,
    });
  }

  // 生成发送校验快照：目标 token 当前出现次数和“确认发送”次数。
  function getSendVerificationSnapshot(messageText) {
    const token = getMessageVerifyToken(messageText);
    const currentText = getCurrentConversationText();
    return {
      token,
      currentCount: countTextToken(currentText, token),
      currentConfirmedCount: countConfirmedToken(currentText, token),
    };
  }

  // 对比发送前后快照，判断消息是否新增到聊天内容区域。
  function isMessageActuallySent(before, after) {
    if (!before || !after) return false;

    // 只以右侧聊天内容区域为准；左侧会话预览、输入框草稿、脚本 UI 文本都不能作为成功依据。
    return after.currentCount > before.currentCount ||
      after.currentConfirmedCount > before.currentConfirmedCount;
  }

  // 只读取聊天内容区域文本，排除输入框草稿、左侧会话预览和脚本 UI。
  function getCurrentConversationText() {
    const roots = Array.from(document.querySelectorAll([
      '.chat-record',
      '.chat-message-list',
      '.chat-message',
      '.chat-conversation',
    ].join(','))).filter((element) => !isOwnUiElement(element) && isVisible(element));

    return normalizeText(roots.map(cloneConversationText).join(' '));
  }

  // 克隆聊天区域后删除输入框/按钮/脚本 UI，再提取用于发送确认的纯文本。
  function cloneConversationText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      '#chat-input',
      '.chat-input',
      'textarea',
      'input',
      '[contenteditable="true"]',
      '#zhipin-auto-greeting-root',
      '.chat-editor',
      '.editor-container',
      '.chat-op',
      '.message-controls',
      '.user-list-content',
      '.user-list',
      '.friend-list',
      '.chat-user',
      '.chat-user-list',
    ].join(',')).forEach((item) => item.remove());
    return normalizeText(clone.innerText || clone.textContent || '');
  }

  // 发送确认只使用消息前 60 个字符作为 token，减少长文本换行/裁剪带来的误差。
  function getMessageVerifyToken(messageText) {
    return normalizeText(messageText).slice(0, 24);
  }

  // 统计 token 在聊天文本中出现次数。
  function countTextToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 更严格的 token 统计：排除输入框附近文本后，用于减少误判。
  function countConfirmedToken(text, token) {
    const source = normalizeText(text);
    const target = normalizeText(token);
    if (!source || !target) return 0;

    let count = 0;
    let index = source.indexOf(target);
    while (index >= 0) {
      const nearby = source.slice(Math.max(0, index - 80), Math.min(source.length, index + target.length + 80));
      if (/送达|已读|已发送/.test(nearby)) count += 1;
      index = source.indexOf(target, index + target.length);
    }
    return count;
  }

  // 判断草稿是否还留在输入框中，用于决定是否需要兜底点击发送按钮。
  function inputContainsText(input, expectedText) {
    const token = getMessageVerifyToken(expectedText);
    return token && normalizeText(getEditableText(input)).includes(token);
  }

  // 从最近一次列表请求提取“推荐/求职期望”相关参数。BOSS 不把这些参数同步到页面 URL。
  function parseJobExpectationRequestContext(url) {
    const context = {
      encryptExpectId: '',
      mixExpectType: '',
      expectInfo: '',
      jobType: '',
    };

    try {
      const target = new URL(url || '', location.href);
      Object.keys(context).forEach((key) => {
        context[key] = normalizeText(target.searchParams.get(key));
      });
    } catch (_) {}

    return context;
  }

  // 汇总“已发起/已解析/Resource Timing”三路记录，返回时间上最新的一次列表活动。
  function getLatestJobListRequestRecord() {
    const bufferedResource = findLatestJobListApiResource();
    const candidates = [
      runtime.latestJobListRequest,
      runtime.latestFirstPageJobListResponse,
      runtime.latestJobListResource,
      bufferedResource,
    ].filter((item) => item && item.url);
    candidates.sort((left, right) => Number(right.capturedAt || 0) - Number(left.capturedAt || 0));
    return candidates[0] || null;
  }

  // 只在已完成的响应和资源中选择，避免把尚未返回的推荐请求误当成当前最终列表。
  function getLatestCompletedJobListRecord() {
    const bufferedResource = findLatestJobListApiResource();
    const candidates = [
      runtime.latestFirstPageJobListResponse,
      runtime.latestJobListResource,
      bufferedResource,
    ].filter((item) => item && item.url);
    candidates.sort((left, right) => Number(right.capturedAt || 0) - Number(left.capturedAt || 0));
    return candidates[0] || null;
  }

  // 获取最近列表活动的 URL，供求职期望参数解析和异常日志使用。
  function getLatestJobListRequestUrl() {
    const record = getLatestJobListRequestRecord();
    return normalizeText(record && record.url);
  }

  // 冻结当前激活的求职期望。标签状态只存在于 BOSS 的 Vue 组件内，刷新/重挂载后会默认回到“推荐”。
  function captureActiveJobExpectationContext() {
    const root = document.querySelector('.c-expect-select');
    if (!root) return null;

    const active = root.querySelector([
      'a.synthesis.active',
      'a.expect-item.active',
      '.part-time-expect.active',
      '.temp-expect.active',
    ].join(','));
    const component = root.__vue__ || null;
    const requestContext = parseJobExpectationRequestContext(getLatestJobListRequestUrl());
    let mode = normalizeText(component && component.currentJobTab);

    if (!mode && active) {
      if (active.matches('a.synthesis')) mode = 'select';
      else if (active.matches('.part-time-expect')) mode = 'partTime';
      else if (active.matches('.temp-expect')) mode = 'temp-expect';
      else if (active.matches('a.expect-item')) mode = 'expect';
    }
    if (!mode) return null;

    let encryptExpectId = requestContext.encryptExpectId;
    if (mode === 'expect') {
      encryptExpectId = normalizeText(component && component.encryptExpectId) || encryptExpectId;
    } else if (mode === 'select') {
      encryptExpectId = normalizeText(component && component.mixEncryptExpectId) || encryptExpectId;
    } else if (mode === 'partTime') {
      encryptExpectId = normalizeText(component && component.partTimeExpect) || encryptExpectId;
    }

    return {
      mode,
      label: normalizeText(active && (active.innerText || active.textContent)),
      encryptExpectId,
      mixExpectType: normalizeText(component && component.mixExpectType) || requestContext.mixExpectType,
      expectInfo: requestContext.expectInfo,
      jobType: requestContext.jobType,
      capturedAt: Date.now(),
    };
  }

  // 比对标签层状态：mode、encryptExpectId 和可见文案共同一致才视为仍选中原求职期望。
  function isJobExpectationUiMatched(current, expected) {
    if (!expected || !expected.mode) return true;
    if (!current || current.mode !== expected.mode) return false;
    if (expected.encryptExpectId && current.encryptExpectId !== expected.encryptExpectId) return false;
    if (expected.label && current.label && current.label !== expected.label) return false;
    return true;
  }

  // 比对接口层状态；不同标签模式使用 BOSS 实际提交的不同参数作为身份标识。
  function isJobExpectationRequestMatched(url, expected) {
    if (!expected || !expected.mode) return true;
    if (!url) return false;
    const current = parseJobExpectationRequestContext(url);

    if (expected.mode === 'expect') {
      return Boolean(expected.encryptExpectId && current.encryptExpectId === expected.encryptExpectId);
    }
    if (expected.mode === 'partTime') {
      return Boolean(
        expected.encryptExpectId &&
        current.encryptExpectId === expected.encryptExpectId &&
        Number(current.jobType || expected.jobType || 0) === 1903,
      );
    }
    if (expected.mode === 'temp-expect') {
      return Boolean(expected.expectInfo && current.expectInfo === expected.expectInfo);
    }
    if (expected.mode === 'select') {
      return current.encryptExpectId === normalizeText(expected.encryptExpectId) &&
        current.mixExpectType === normalizeText(expected.mixExpectType) &&
        current.expectInfo === normalizeText(expected.expectInfo) &&
        current.jobType === normalizeText(expected.jobType);
    }
    return true;
  }

  // 找到冻结期望对应的可点击标签；优先文案匹配，再按 Vue expectList 中 encryptId 的索引兜底。
  function findFrozenJobExpectationElement(expected) {
    const root = document.querySelector('.c-expect-select');
    if (!root || !expected) return null;
    if (expected.mode === 'select') return root.querySelector('a.synthesis');
    if (expected.mode === 'partTime') return root.querySelector('.part-time-expect');

    const candidates = Array.from(root.querySelectorAll('a.expect-item'));
    const expectedLabel = normalizeText(expected.label);
    const textMatched = candidates.find((element) => (
      normalizeText(element.innerText || element.textContent) === expectedLabel
    ));
    if (textMatched) return textMatched;

    // 文案被页面截断或调整时，利用组件的期望列表按 encryptId 找到相同索引作为兜底。
    try {
      const component = root.__vue__;
      const expectList = component && Array.isArray(component.expectList) ? component.expectList : [];
      const index = expectList.findIndex((item) => (
        normalizeText(item && item.encryptId) === normalizeText(expected.encryptExpectId)
      ));
      if (index >= 0 && candidates[index]) return candidates[index];
    } catch (_) {}
    return null;
  }

  // 生成一次无副作用的恢复就绪快照，集中记录标签、最新完成请求、卡片和详情状态。
  function getJobExpectationReadyState(expected) {
    const current = captureActiveJobExpectationContext();
    const completedRequest = getLatestCompletedJobListRecord();
    const detail = extractDetailInfo();
    const chatButton = findChatButton(null);
    return {
      current,
      completedRequest,
      uiMatched: isJobExpectationUiMatched(current, expected),
      requestMatched: isJobExpectationRequestMatched(completedRequest && completedRequest.url, expected),
      cardsReady: hasVisibleJobCards(),
      detailReady: Boolean(detail && detail.jobName && chatButton),
      detailJobName: normalizeText(detail && detail.jobName),
    };
  }

  // 等待目标期望的标签与列表真正稳定；支持完成时间门槛、静默窗口和无 Resource Timing 时的 UI 兜底。
  async function waitForJobExpectationReady(expected, options) {
    const settings = options || {};
    const requiredCompletedAt = Number(settings.requiredCompletedAt || 0);
    const settleMs = Math.max(0, Number(settings.settleMs || 0));
    const allowStableUiFallback = Boolean(settings.allowStableUiFallback);
    const timeout = Math.max(1200, Number(settings.timeout || getWaitTimeout() * 1000));
    let stableSince = 0;
    let sawListReset = Boolean(settings.sawListReset);

    return waitFor(() => {
      const ready = getJobExpectationReadyState(expected);
      if (!ready.cardsReady) sawListReset = true;
      if (!ready.uiMatched || !ready.cardsReady) {
        stableSince = 0;
        return null;
      }

      // settleMs 是响应静默窗口：如果期间又完成了推荐请求，最新记录会变化并重新进入判断。
      const completedAt = Number(ready.completedRequest && ready.completedRequest.capturedAt || 0);
      const requestSettled = !settleMs || Date.now() - completedAt >= settleMs;
      if (ready.requestMatched && (!requiredCompletedAt || completedAt >= requiredCompletedAt) && requestSettled) {
        return Object.assign(ready, { confirmation: 'completed-request', sawListReset });
      }

      // 只有完全缺少本轮完成记录时才用 UI 稳定态兜底；若本轮最后完成的是推荐请求，绝不能绕过。
      const hasRelevantCompletedRequest = Boolean(
        completedAt && (!requiredCompletedAt || completedAt >= requiredCompletedAt),
      );
      if (
        allowStableUiFallback &&
        (!requiredCompletedAt || sawListReset) &&
        (!hasRelevantCompletedRequest || ready.requestMatched)
      ) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 900) {
          return Object.assign(ready, { confirmation: 'stable-ui', sawListReset });
        }
      } else {
        stableSince = 0;
      }
      return null;
    }, timeout, '求职期望列表与详情', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden'],
      // 该条件同时依赖接口完成时间和静默窗口，DOM 不变化时也要复核。
      pollInterval: 120,
    });
  }

  // 目标列表稳定后，把可见选中卡片与右侧详情再对齐一次，阻断旧“推荐”详情的晚到响应。
  async function synchronizeVisibleJobDetailAfterExpectationRestore(expected, timeout) {
    const entries = getVisibleJobScanEntries();
    const selected = entries.find((entry) => /active|selected|cur|current/.test(String(entry.card.className || '')));
    const entry = selected || entries[0];
    if (!entry || !entry.job || !entry.job.jobName) {
      throw new Error('求职期望已恢复，但没有可同步的岗位卡片');
    }

    let job = entry.job;
    let ready = getJobCommunicationDetailReady(job);
    let clicked = false;
    if (!ready) {
      // 当前详情仍属于旧列表时主动点击目标卡片，并用接口数据补齐强身份后再校验按钮。
      clicked = true;
      entry.card.scrollIntoView({ block: 'center', inline: 'nearest' });
      const detailResourceStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      clickElement(entry.card);

      const apiDetail = await JobRepository.waitForJobDetail(
        job,
        Math.min(4200, Math.max(2600, Number(timeout || getWaitTimeout() * 1000))),
        detailResourceStartedAt,
        { includeHtml: false, forceApiFetch: true },
      );
      if (apiDetail) job = mergeJobInfo(job, apiDetail);
    }

    // 恢复场景使用更长的 650ms 稳定窗口，专门覆盖推荐详情比目标列表更晚返回的竞态。
    ready = await waitForJobCommunicationDetail(
      job,
      Math.max(3000, Number(timeout || getWaitTimeout() * 1000)),
      650,
    );
    const result = {
      clicked,
      cardJobName: normalizeText(job.jobName),
      detailJobName: normalizeText(ready.detail && ready.detail.jobName),
      buttonKa: normalizeText(ready.chatButton && ready.chatButton.getAttribute('ka')),
    };
    logDebugEvent('job_expectation_detail_synchronized', { expected, result });
    return result;
  }

  // 返回列表或页面恢复时先核验求职期望；若 BOSS 重置为推荐，恢复正确列表后才允许继续扫描。
  async function ensureFrozenJobExpectationContext(state, reason) {
    const expected = state && state.listExpectationContext;
    if (!expected || !expected.mode) return { required: false, restored: false, matched: true, label: '' };

    await waitForElement('.c-expect-select', Math.max(3000, getWaitTimeout() * 1000), '求职期望标签');
    let current = captureActiveJobExpectationContext();
    const uiMatched = isJobExpectationUiMatched(current, expected);

    // 已经激活正确标签时绝不能重复点击：BOSS 会忽略激活项点击，也不会重新发列表请求。
    if (uiMatched) {
      try {
        // 正常返回只做短稳定检查，不额外点击标签，以免制造一次无响应的等待。
        const ready = await waitForJobExpectationReady(expected, {
          allowStableUiFallback: true,
          settleMs: 350,
          timeout: Math.min(2600, Math.max(1600, getWaitTimeout() * 350)),
        });
        const result = {
          required: true,
          restored: false,
          matched: true,
          label: expected.label || current && current.label || '',
          confirmation: ready.confirmation,
          requestUrl: normalizeText(ready.completedRequest && ready.completedRequest.url),
          detailJobName: ready.detailJobName,
        };
        logDebugEvent('job_expectation_already_ready', { reason, expected, result });
        return result;
      } catch (error) {
        logDebugEvent('job_expectation_active_not_ready', {
          reason,
          expected,
          current,
          ready: getJobExpectationReadyState(expected),
          message: error && error.message || String(error),
        }, 'warn');
        throw new Error(`求职期望已选中，但岗位列表或详情未就绪：${expected.label || expected.mode}`);
      }
    }

    const requestUrl = getLatestJobListRequestUrl();
    const target = findFrozenJobExpectationElement(expected);
    if (!target || !isVisible(target)) {
      logDebugEvent('job_expectation_restore_target_missing', {
        reason,
        expected,
        current,
        requestUrl,
      }, 'error');
      throw new Error(`无法恢复求职期望：${expected.label || expected.encryptExpectId || expected.mode}`);
    }

    const restoreStartedAt = Date.now();
    const sawListResetInitially = !hasVisibleJobCards();
    UI.setStatus(`检测到 BOSS 已切换标签，正在恢复：${expected.label || '原求职期望'}`, 'warn');
    logDebugEvent('job_expectation_restore_start', {
      reason,
      expected,
      current,
      requestUrl,
      restoreStartedAt,
    }, 'warn');

    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    clickElement(target);
    // 点击恢复后只接受本次点击之后完成、且参数属于目标期望的列表请求；800ms 用于吸收并发晚到响应。
    const ready = await waitForJobExpectationReady(expected, {
      requiredCompletedAt: restoreStartedAt,
      allowStableUiFallback: true,
      sawListReset: sawListResetInitially,
      settleMs: 800,
      timeout: Math.max(10000, getWaitTimeout() * 1400),
    });

    // 用已经确认属于目标求职期望的 URL 主动补抓一次，避免接口池仍残留“推荐”岗位。
    if (ready.requestMatched && ready.completedRequest && ready.completedRequest.url) {
      const fetched = await JobRepository.fetchLatestJobList(ready.completedRequest).catch((error) => {
        logDebugEvent('job_expectation_list_replay_failed', {
          expected,
          requestUrl: ready.completedRequest.url,
          message: error && error.message || String(error),
        }, 'warn');
        return false;
      });
      if (!fetched) throw new Error(`求职期望列表补抓失败：${expected.label || expected.mode}`);
    }

    current = ready.current;
    JobRepository.syncCards();
    // 接口池恢复正确后继续对齐右侧详情，只有卡片/详情/按钮一致才算完整恢复成功。
    const detailSync = await synchronizeVisibleJobDetailAfterExpectationRestore(
      expected,
      Math.max(4500, getWaitTimeout() * 1000),
    );
    const result = {
      required: true,
      restored: true,
      matched: true,
      label: expected.label || current && current.label || '',
      confirmation: ready.confirmation,
      requestUrl: normalizeText(ready.completedRequest && ready.completedRequest.url),
      detailJobName: detailSync.detailJobName || ready.detailJobName,
      detailSync,
    };
    logDebugEvent('job_expectation_restore_success', {
      reason,
      expected,
      result,
      listState: getDebugListState(),
    });
    return result;
  }

  // 从聊天页返回岗位列表。历史返回只有在筛选上下文一致时才成功，否则恢复本轮冻结的完整 URL。
  async function navigateToJobList(stateOrUrl) {
    const suppliedState = stateOrUrl && typeof stateOrUrl === 'object' ? stateOrUrl : null;
    const state = suppliedState || RunState.load() || {};
    const listUrl = suppliedState ? suppliedState.listUrl : stateOrUrl || state.listUrl;
    const timeout = Math.max(config.ignoreListRefresh ? 15000 : 8000, getWaitTimeout() * 1000);
    const targetListUrl = getRestorableListUrl(listUrl);
    const expectedSignature = state.listFilterSignature || makeJobListFilterSignature(targetListUrl);
    const intentionalRestoreAt = Number(state.intentionalListRestoreAt || 0);

    const currentContextMatches = () => Boolean(
      targetListUrl && isSameJobListFilterContext(location.href, targetListUrl, expectedSignature),
    );

    if (isJobListRoute() && currentContextMatches()) {
      await waitForVisibleJobList(timeout);
      return {
        exactRestored: intentionalRestoreAt > 0,
        usedHistory: false,
        href: location.href,
      };
    }

    if (isChatPage()) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        UI.setStatus(attempt === 0
          ? '发送完成，正在通过浏览器历史返回原筛选页...'
          : '尚未恢复原筛选页，再次执行浏览器历史返回...', 'info');
        const beforeHref = location.href;
        triggerBrowserHistoryBack(attempt);
        try {
          await waitForHistoryReturnOrJobList(beforeHref, Math.min(timeout, 5000 + attempt * 2000));
          if (isJobListRoute() && currentContextMatches()) {
            await waitForVisibleJobList(timeout);
            return { exactRestored: false, usedHistory: true, href: location.href };
          }
          if (isJobListRoute()) break;
        } catch (_) {}
      }
    }

    if (targetListUrl) {
      UI.setStatus('返回页面的筛选条件已变化，正在恢复原岗位筛选页...', 'warn');
      RunState.patch({
        phase: 'returning',
        intentionalListRestoreAt: Date.now(),
        listUrl: targetListUrl,
        listFilterSignature: expectedSignature || makeJobListFilterSignature(targetListUrl),
      });
      pageWindow.location.assign(targetListUrl);
      await waitFor(
        () => isJobListRoute() && currentContextMatches() && hasVisibleJobCards(),
        timeout,
        '原岗位筛选页恢复',
        {
          observerRoot: getPageObserverRoot(),
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
          pollInterval: 200,
        },
      );
      return { exactRestored: true, usedHistory: false, href: location.href };
    }

    throw new Error('缺少可恢复的岗位筛选地址，请手动返回原搜索结果页后重新启动');
  }

  // 交替使用 back/go(-1)，应对页面 history 包装导致某一种方式失效。
  function triggerBrowserHistoryBack(attempt) {
    try {
      if (attempt % 2 === 0) {
        nativeHistoryNavigation.back();
      } else {
        nativeHistoryNavigation.go(-1);
      }
      return;
    } catch (error) {
      console.warn('[ZhipinAuto] 原生 history 返回失败，降级使用页面 history', error);
    }

    try {
      if (attempt % 2 === 0) {
        pageWindow.history.back();
      } else {
        pageWindow.history.go(-1);
      }
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 history 返回失败', error);
    }
  }

  // 等待 URL 变化或岗位卡片出现，确认浏览器历史返回已经生效。
  function waitForHistoryReturnOrJobList(previousHref, timeout) {
    return waitFor(() => {
      if (hasVisibleJobCards()) return true;
      if (location.href !== previousHref && isJobListRoute()) return true;
      return null;
    }, timeout, '岗位列表恢复', {
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 200,
    });
  }

  // 生成可恢复的列表 URL，只作为极端兜底，不作为正常返回路径。
  function getRestorableListUrl(listUrl) {
    const source = normalizeText(listUrl);
    if (!source) return '';

    try {
      const url = new URL(source, location.href);
      if (url.origin !== location.origin || !isJobListUrl(url.href)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  // 判断当前是否处于岗位列表路由。
  function isJobListRoute() {
    return isJobListUrl(location.href);
  }

  // 判断岗位列表是否真的渲染出可见卡片。
  function hasVisibleJobCards() {
    return getJobCards().length > 0;
  }

  // 等待岗位列表卡片出现，返回阶段和启动恢复都会使用。
  function waitForVisibleJobList(timeout) {
    return waitFor(() => {
      return getJobCards()[0] || null;
    }, timeout, '岗位列表', {
      // 完整导航/BFCache 返回时列表容器会被整体替换，必须监听稳定的 #wrap 应用根节点。
      observerRoot: getPageObserverRoot(),
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
      pollInterval: 200,
    });
  }

  // 判断当前是否处于聊天路由。
  // 使用平台适配器进行页面检测
  function isChatPage() {
    // 如果已检测到平台，使用适配器检测
    if (currentPlatform) {
      return currentPlatform.isChatPage(location.href);
    }
    // 未检测到平台时，尝试所有已注册的适配器
    const detected = platformRegistry.detect(location.href);
    if (detected) {
      currentPlatform = detected;
      return detected.isChatPage(location.href);
    }
    // 回退到原有逻辑（兼容）
    return Boolean(
      hasVisibleChatInputShell() ||
      findCommonPhraseButton() ||
      /\/web\/geek\/chat|\/chat/.test(location.pathname + location.hash),
    );
  }

  // 粗略判断聊天输入区域是否可见，用于区分聊天页未渲染和已进入聊天页。
  function hasVisibleChatInputShell() {
    return Array.from(document.querySelectorAll([
      '#chat-input.chat-input',
      '.chat-input[contenteditable="true"]',
      '[contenteditable="true"].chat-input',
      '.chat-input',
    ].join(','))).some((element) => !isOwnUiElement(element) && isVisible(element));
  }

  // 重试打开聊天时重新定位原岗位卡片，优先按岗位匹配，最后用旧游标兜底。
  function findJobCardForRetry(job, cards, fallbackIndex) {
    const candidates = cards && cards.length ? cards : getJobCards();
    for (const card of candidates) {
      if (isRetryCardMatch(card, job)) return card;
    }

    const fallback = candidates[Math.max(0, Number(fallbackIndex || 0))];
    return fallback && isRetryCardMatch(fallback, job) ? fallback : null;
  }

  // 判断重试时某张卡片是否像 pendingJob。
  function isRetryCardMatch(card, job) {
    if (!card || !job) return false;

    const domInfo = extractCardInfo(card);
    const match = JobRepository.cardLooksLikeJob(domInfo, job);
    if (match.comparable) return match.matched;

    const text = domInfo.text || normalizeText(card.innerText || card.textContent || '');
    const jobName = normalizeText(job.jobName);
    const company = normalizeText(job.company);
    const bossName = normalizeText(job.bossName);

    if (jobName && company) return text.includes(jobName) && text.includes(company);
    if (jobName && bossName) return text.includes(jobName) && text.includes(bossName);
    return Boolean(jobName && text.includes(jobName));
  }

  // 记录返回前列表快照，返回后用于判断列表是否刷新或上下文是否变化。
  function createJobListSnapshot() {
    const cards = getJobCards();
    const cardHeadItems = cards
      .slice(0, 8)
      .map((card) => makeCardSnapshotKey(extractCardInfo(card)))
      .filter(Boolean);
    const firstPage = runtime.latestFirstPageJobListResponse || {};

    return {
      href: location.href,
      contextKey: runtime.jobListContextKey || firstPage.contextKey || '',
      batchKey: runtime.jobListLastBatchKey || '',
      firstPageBatchKey: firstPage.batchKey || '',
      responseSerial: runtime.jobListResponseSerial || 0,
      firstPageSerial: runtime.jobListFirstPageSerial || 0,
      cardCount: cards.length,
      cardHeadKey: cardHeadItems.length ? hashString(cardHeadItems.join('||')) : '',
      capturedAt: Date.now(),
    };
  }

  // 生成当前可见卡片的简短签名，用于列表刷新检测。
  function makeCardSnapshotKey(domInfo) {
    if (!domInfo) return '';
    const key = (domInfo.keys || []).map(normalizeText).filter(Boolean)[0];
    if (key) return `key:${key}`;
    if (isMeaningfulCompositeKey(domInfo.looseSignature)) return `loose:${domInfo.looseSignature}`;
    if (isMeaningfulCompositeKey(domInfo.signature)) return `signature:${domInfo.signature}`;
    return '';
  }

  // 生成当前虚拟列表渲染签名，滚动后据此等待卡片真正换批，而不是固定 sleep。
  function getVisibleJobListRenderSignature() {
    return getVisibleJobScanEntries()
      .map((entry) => entry.key || makeCardSnapshotKey(entry.domInfo))
      .filter(Boolean)
      .join('||');
  }

  // 等待虚拟列表 DOM/接口批次变化；超时仅表示列表可能复用了同一批节点，调用方继续做状态兜底检查。
  async function waitForJobListRenderChange(previousSignature, previousResponseSerial, timeout) {
    try {
      await waitFor(() => {
        const currentSignature = getVisibleJobListRenderSignature();
        if (currentSignature && currentSignature !== previousSignature) return true;
        if (Number(runtime.jobListResponseSerial || 0) > Number(previousResponseSerial || 0)) return true;
        return null;
      }, Math.max(300, Number(timeout || 700)), '岗位列表渲染更新', {
        observerRoot: getJobListObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
        pollInterval: 120,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  // 返回列表后短暂观察是否出现第一页接口响应，用于判断列表被刷新。
  async function waitForReturnedJobListRefresh(returnStartedAt) {
    const timeout = Math.min(Math.max(700, getWaitTimeout() * 250), 1800);

    try {
      await waitFor(() => {
        const latestFirstPage = runtime.latestFirstPageJobListResponse || {};
        if (latestFirstPage.capturedAt && Number(latestFirstPage.capturedAt) >= Number(returnStartedAt || 0)) {
          return latestFirstPage;
        }
        return null;
      }, timeout, '岗位列表刷新检测', { pollInterval: 120 });
    } catch (_) {}
  }

  // 启动扫描时先回到真实左栏顶部，确保从页面中部启动也不会遗漏上方岗位。
  async function scanJobListToTop() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cards = JobRepository.syncCards();
      const anchor = cards[0] || document.querySelector('li.job-card-box') || getJobCards()[0];
      const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;
      if (!scroller) return false;
      const beforeTop = Number(scroller.scrollTop || 0);
      if (beforeTop <= 1) return true;
      const beforeRenderSignature = getVisibleJobListRenderSignature();
      const beforeResponseSerial = Number(runtime.jobListResponseSerial || 0);

      if (anchor) anchor.scrollIntoView({ block: 'start', inline: 'nearest' });
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      try {
        pageWindow.scrollTo(0, 0);
      } catch (_) {}
      await waitForJobListRenderChange(beforeRenderSignature, beforeResponseSerial, 700);
      JobRepository.syncCards();
      if (Number(scroller.scrollTop || 0) <= 1) return true;
    }
    return false;
  }

  // 虚拟列表的 DOM 数量通常固定，改为等待新岗位标识、接口批次或真实滚动进展。
  async function scrollAndWaitForMore(previousKeys) {
    const entries = getVisibleJobScanEntries();
    const cards = entries.map((entry) => entry.card);
    const lastCard = cards[cards.length - 1];
    const scroller = findScrollParent(lastCard) || document.scrollingElement || document.documentElement;
    if (!scroller) return false;

    const knownKeys = previousKeys instanceof Set
      ? previousKeys
      : new Set(Array.from(previousKeys || []).filter(Boolean));
    const beforeTop = Number(scroller.scrollTop || 0);
    const beforeSerial = Number(runtime.jobListResponseSerial || 0);
    const beforeBatchKey = runtime.jobListLastBatchKey || '';

    if (lastCard) lastCard.scrollIntoView({ block: 'end', inline: 'nearest' });
    scroller.scrollTop += Math.max(Number(scroller.clientHeight || 0) * 0.8, 500);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    const hasProgress = () => {
      const currentKeys = getVisibleJobScanEntries().map((entry) => entry.key).filter(Boolean);
      if (currentKeys.some((key) => !knownKeys.has(key))) return true;
      if (Number(runtime.jobListResponseSerial || 0) > beforeSerial) return true;
      if ((runtime.jobListLastBatchKey || '') !== beforeBatchKey) return true;
      return Number(scroller.scrollTop || 0) > beforeTop + 2;
    };

    try {
      await waitFor(hasProgress, Math.min(getWaitTimeout(), 6000), '加载更多岗位', {
        observerRoot: getJobListObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
        // 接口批次和 scrollTop 变化不一定对应 DOM MutationRecord。
        pollInterval: 120,
      });
      return true;
    } catch (_) {
      return hasProgress();
    }
  }

  // 跳过岗位后按稳定标识寻找下一张卡片，不再依赖会随虚拟滚动变化的数组游标。
  function scrollAheadByJobKey(currentKey) {
    const entries = getVisibleJobScanEntries();
    const currentIndex = entries.findIndex((entry) => entry.key === currentKey);
    const nextEntry = currentIndex >= 0 ? entries[currentIndex + 1] : null;
    if (nextEntry) {
      nextEntry.card.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }

    const anchor = entries.length ? entries[entries.length - 1].card : null;
    const scroller = findScrollParent(anchor);
    if (scroller) {
      scroller.scrollTop += 400;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }

  // 列表刷新后从顶部重新开始时使用。
  function scrollJobListToTop() {
    const cards = getJobCards();
    const anchor = cards[0] || document.querySelector('li.job-card-box') || getJobCards()[0];
    const scroller = findScrollParent(anchor) || document.scrollingElement || document.documentElement;

    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    try {
      pageWindow.scrollTo(0, 0);
    } catch (_) {
      window.scrollTo(0, 0);
    }
  }

  // 查找真实滚动容器；BOSS 列表不一定滚动 document。
  // 使用 WeakMap 缓存结果，避免同一元素重复遍历 DOM 树和调用 getComputedStyle。
  const _scrollParentCache = new WeakMap();
  function findScrollParent(element) {
    if (!element) return document.scrollingElement || document.documentElement;
    if (_scrollParentCache.has(element)) return _scrollParentCache.get(element);
    let current = element.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
        _scrollParentCache.set(element, current);
        return current;
      }
      current = current.parentElement;
    }
    const fallback = document.scrollingElement || document.documentElement;
    _scrollParentCache.set(element, fallback);
    return fallback;
  }

  // 岗位列表更新频繁，DOM 等待优先监听列表自身，找不到时才退回页面应用根节点。
  function getJobListObserverRoot() {
    const list = document.querySelector('.job-list-box, .search-job-result, .job-list-container, .job-list-panel, .joblist-box');
    const card = document.querySelector('li.job-card-box') || getJobCards()[0];
    return list && list.parentElement ||
      card && card.parentElement ||
      getPageObserverRoot();
  }

  // 监听右侧详情的稳定父容器，既能捕获内容更新，也能覆盖详情盒子被整体替换的情况。
  function getJobDetailObserverRoot() {
    const detail = Array.from(document.querySelectorAll('.job-detail-box')).find(isVisible) ||
      document.querySelector('.job-detail-container, .job-detail-wrapper, .job-detail-panel, .job-detail-summary');
    return detail && detail.parentElement || detail || getPageObserverRoot();
  }

  // 聊天输入框和消息列表位于同一聊天区域；若尚未渲染则监听稳定的应用根节点。
  function getChatObserverRoot() {
    const input = findChatInput();
    const conversation = Array.from(document.querySelectorAll('.chat-record, .chat-message-list, .chat-message, .chat-conversation'))
      .find((element) => !isOwnUiElement(element) && isVisible(element));
    const commonRoot = findCommonElementAncestor(input, conversation);
    return commonRoot && commonRoot !== document.body && commonRoot !== document.documentElement
      ? commonRoot
      : input && input.closest('.chat-container, .chat-wrapper, .chat-box, .chat-content, .chat-main') ||
      document.querySelector('.chat-container, .chat-wrapper, .chat-box, .chat-content, .chat-main') ||
      getPageObserverRoot();
  }

  // 找到两个聊天节点的最近公共父元素，使一次 observer 同时覆盖输入框和消息列表。
  function findCommonElementAncestor(first, second) {
    if (!first || !second) return null;
    const ancestors = new Set();
    let current = first;
    while (current) {
      ancestors.add(current);
      current = current.parentElement;
    }
    current = second;
    while (current) {
      if (ancestors.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // 页面级 SPA 切换才使用应用根节点，避免默认监听整个 documentElement。
  function getPageObserverRoot() {
    return document.querySelector('#wrap, #app, .app-main') || document.body || document.documentElement;
  }

  // 根据目标类型选择尽量小且稳定的观察根节点。
  function getElementObserverRoot(selector) {
    if (/job-card-box/.test(selector)) return getJobListObserverRoot();
    if (/job-detail|op-btn-chat/.test(selector)) return getJobDetailObserverRoot();
    if (/chat-input|contenteditable/.test(selector)) return getChatObserverRoot();
    if (/c-expect-select/.test(selector)) {
      const expectation = document.querySelector('.c-expect-select');
      return expectation && expectation.parentElement || getPageObserverRoot();
    }
    return getPageObserverRoot();
  }

  // 等待某个可见元素出现；纯 DOM 场景只由 MutationObserver 驱动，并由超时定时器兜底。
  function waitForElement(selector, timeout, label, options) {
    const settings = options || {};
    return waitFor(() => {
      const element = document.querySelector(selector);
      return element && isVisible(element) ? element : null;
    }, timeout, label || selector, {
      observerRoot: settings.observerRoot || getElementObserverRoot(selector),
      childList: true,
      subtree: settings.subtree !== false,
      attributes: settings.attributes !== false,
      attributeFilter: settings.attributeFilter || ['class', 'style', 'hidden'],
    });
  }

  // 通用条件等待器：DOM 变化和非 DOM 状态按需启用，结束时统一释放 observer/timer。
  function waitFor(predicate, timeout, label, options) {
    const rawTimeout = Number(timeout);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(1, rawTimeout > 100 ? rawTimeout : rawTimeout * 1000)
      : getWaitTimeout() * 1000;
    const settings = options || {};
    const observerRoot = settings.observerRoot && settings.observerRoot.nodeType
      ? settings.observerRoot
      : null;
    const pollInterval = Math.max(0, Number(settings.pollInterval || 0));

    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;
      let pollTimer = null;
      let timeoutTimer = null;
      let pageHideHandler = null;

      const cleanup = () => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (pageHideHandler) {
          pageWindow.removeEventListener('pagehide', pageHideHandler);
          pageHideHandler = null;
        }
      };

      const finish = (error, result) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      const check = () => {
        if (done) return;
        try {
          const result = predicate();
          if (result) finish(null, result);
        } catch (error) {
          if (error && error.zhipinAutoPause) finish(error);
        }
      };

      // 先同步检查一次，已存在的元素不会创建无意义的 observer。
      check();
      if (done) return;

      if (settings.resolveOnPageHide) {
        pageHideHandler = () => finish(null, settings.pageHideResult || true);
        pageWindow.addEventListener('pagehide', pageHideHandler, { once: true });
      }

      if (observerRoot && typeof MutationObserver === 'function') {
        observer = new MutationObserver(check);
        const observerOptions = {
          childList: settings.childList !== false,
          subtree: settings.subtree !== false,
          attributes: Boolean(settings.attributes),
          characterData: Boolean(settings.characterData),
        };
        if (observerOptions.attributes && Array.isArray(settings.attributeFilter) && settings.attributeFilter.length) {
          observerOptions.attributeFilter = settings.attributeFilter;
        }
        observer.observe(observerRoot, observerOptions);
        // 补一次检查，覆盖首次检查与 observer.observe 之间发生的变化。
        check();
      }

      if (!done && pollInterval > 0) {
        pollTimer = setInterval(check, pollInterval);
      }

      if (!done) {
        timeoutTimer = setTimeout(() => {
          finish(new Error(`${label || '目标元素'} 等待超时`));
        }, timeoutMs);
      }
    });
  }

  // 模拟用户点击，按真实坐标派发 pointer/mouse/click 事件。
  function clickElement(element) {
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + Math.min(Math.max(rect.width / 2, 4), Math.max(rect.width - 4, 4));
    const clientY = rect.top + Math.min(Math.max(rect.height / 2, 4), Math.max(rect.height - 4, 4));
    const target = document.elementFromPoint(clientX, clientY) || element;
    const mouseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: pageWindow,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: 1,
    };

    // BOSS 的部分列表项依赖真实坐标下的 pointer/mouse 事件，单纯 element.click() 不会触发。
    dispatchPointer(target, 'pointerover', mouseInit);
    target.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    dispatchPointer(target, 'pointerdown', mouseInit);
    target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    dispatchPointer(target, 'pointerup', Object.assign({}, mouseInit, { buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, mouseInit, { buttons: 0 })));
    target.dispatchEvent(new MouseEvent('click', Object.assign({}, mouseInit, { buttons: 0 })));

    if (target !== element) {
      try {
        element.click();
      } catch (_) {}
    }
  }

  // PointerEvent 不可用时降级为 MouseEvent。
  function dispatchPointer(target, type, init) {
    if (typeof PointerEvent !== 'function') return;

    try {
      target.dispatchEvent(new PointerEvent(type, Object.assign({
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }, init)));
    } catch (_) {}
  }

  // 写入 input/textarea/contenteditable，并派发 beforeinput/input/change 让 BOSS 内部状态同步。
  function setEditableText(container, text) {
    const target = container.matches('textarea,input,[contenteditable="true"]')
      ? container
      : container.querySelector('textarea,input,[contenteditable="true"]') || container;

    target.focus();
    if (typeof target.click === 'function') {
      try {
        target.click();
      } catch (_) {}
    }

    if ('value' in target) {
      setNativeValue(target, text);
      target.dispatchEvent(createInputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }));
      target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      target.dispatchEvent(createDomEvent('change', { bubbles: true }));
      return;
    }

    // BOSS 的聊天框是 contenteditable div，直接写入文本后再派发 input，让站点同步内部状态。
    target.textContent = '';
    target.textContent = text;
    placeCaretAtEnd(target);

    target.dispatchEvent(createInputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
    target.dispatchEvent(createInputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // 使用原生 value setter，避免 React/Vue 受控输入框读不到手动赋值。
  function setNativeValue(target, text) {
    const proto = target.tagName === 'TEXTAREA'
      ? pageWindow.HTMLTextAreaElement && pageWindow.HTMLTextAreaElement.prototype
      : pageWindow.HTMLInputElement && pageWindow.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(target, text);
    } else {
      target.value = text;
    }
  }

  // 把光标放到可编辑区域末尾，确保 Enter 发送的是完整文本。
  function placeCaretAtEnd(target) {
    try {
      const selection = pageWindow.getSelection && pageWindow.getSelection();
      const range = pageWindow.document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch (_) {}
  }

  // 统一读取输入框或 contenteditable 的当前文本。
  function getEditableText(element) {
    if (!element) return '';
    if ('value' in element) return String(element.value || '');
    return String(element.innerText || element.textContent || '');
  }

  // 调用元素原生 click，绕过页面可能包装过的实例方法。
  function clickNative(element) {
    if (!element) return;
    try {
      element.focus && element.focus();
      const nativeClick = pageWindow.HTMLElement && pageWindow.HTMLElement.prototype.click;
      if (nativeClick) {
        nativeClick.call(element);
      } else {
        element.click();
      }
    } catch (_) {
      clickElement(element);
    }
  }

  // 创建 InputEvent，旧环境不支持时退回普通 Event。
  function createInputEvent(type, init) {
    const Ctor = pageWindow.InputEvent || InputEvent;
    try {
      return new Ctor(type, init);
    } catch (_) {
      return createDomEvent(type, init);
    }
  }

  // 普通 DOM 事件构造兜底。
  function createDomEvent(type, init) {
    const Ctor = pageWindow.Event || Event;
    return new Ctor(type, init || {});
  }

  // 在输入框上派发 Enter 键事件，触发页面自己的发送逻辑。
  function pressEnter(target) {
    const eventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      view: pageWindow,
    };
    const Ctor = pageWindow.KeyboardEvent || KeyboardEvent;
    target.focus && target.focus();
    target.dispatchEvent(new Ctor('keydown', eventInit));
    target.dispatchEvent(new Ctor('keypress', eventInit));
    target.dispatchEvent(new Ctor('keyup', eventInit));
  }

  // 公司名按模式匹配，供公司筛选和黑名单共用。
  function companyTextMatches(targetText, mode, valueText) {
    const target = normalizeText(targetText);
    const value = normalizeText(valueText);
    if (!target || !value) return false;

    const matchMode = getCompanyMatchMode(mode);
    if (matchMode === 'exact') return target === value;
    if (matchMode === 'regex') return new RegExp(value).test(target);
    return target.includes(value);
  }

  // 公司筛选逻辑，支持精确、包含、正则三种模式。
  function companyMatches(company) {
    const value = normalizeText(config.companyFilterValue);
    if (!value) return true;
    return companyTextMatches(company, config.companyFilterMode, value);
  }

  // 城市允许列表：命中任意城市即可；留空表示不限制城市（平台搜索条件已完成初步筛选）。
  // 支持三种格式：普通文本（包含匹配）、正则（以 /开头/结尾）、精确匹配（以 = 开头）。
  function getAllowedCities() {
    return String(config.allowedCities || '').split(/[\n,，、]+/).map(normalizeText).filter(Boolean);
  }

  function cityMatches(city) {
    const allowed = getAllowedCities();
    const target = normalizeText(city);
    // 列表为空 = 用户未启用城市筛选，直接放行。
    if (!allowed.length) return { matched: true, allowed, target, unrestricted: true };
    // 启用了筛选但岗位城市读不出来时，保守跳过。
    if (!target) return { matched: false, allowed, target };

    const matched = allowed.some((item) => {
      if (!item) return false;
      // 精确匹配：=北京
      if (item.startsWith('=')) return target === item.slice(1);
      // 正则匹配：/北京|上海/
      if (item.startsWith('/') && item.endsWith('/') && item.length > 2) {
        try { return new RegExp(item.slice(1, -1)).test(target); } catch (_) { return false; }
      }
      // 默认包含匹配
      return target.includes(item);
    });
    return { matched, allowed, target };
  }

  // 解析岗位薪资文本为月薪区间（单位：K）。
  // 支持 5000-8000元、7-9K、6千-1万、1.5-2万、20-30万/年、150-200元/天 等写法；
  // 无法识别、加密字体或“面议”时返回 null，调用方视为薪资不明并保留岗位。
  function parseSalaryRange(text) {
    const display = normalizeText(text);
    if (!display || isEncryptedSalary(display)) return null;
    if (/(?:面议|面谈|保密|薪资不限)/.test(display)) return null;

    // 去掉“·13薪 / ×14薪 / 15薪”这类发薪月数，避免被当成薪资数字。
    const cleaned = display
      .replace(/(?:[·・xX×*]\s*)?\d+(?:\.\d+)?\s*薪/g, ' ')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[．。]/g, '.')
      .replace(/[－—–~～至到]/g, '-')
      .replace(/,/g, '');

    const tokens = [];
    const pattern = /(\d+(?:\.\d+)?)\s*([kK千万]|元)?/g;
    let match;
    while ((match = pattern.exec(cleaned))) {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const unit = match[2] === 'k' || match[2] === 'K' || match[2] === '千'
        ? 'k'
        : match[2] === '万'
          ? 'wan'
          : match[2] === '元'
            ? 'yuan'
            : '';
      tokens.push({ value, unit });
    }
    if (!tokens.length) return null;

    const period = /年/.test(cleaned) ? 'year' : (/天/.test(cleaned) ? 'day' : 'month');
    const knownUnit = tokens.map((item) => item.unit).find(Boolean) || '';
    const fallbackUnit = Math.max.apply(null, tokens.map((item) => item.value)) >= 1000 ? 'yuan' : 'k';

    const toMonthlyK = (token) => {
      const unit = token.unit || knownUnit || fallbackUnit;
      const monthly = unit === 'wan'
        ? token.value * 10
        : unit === 'yuan'
          ? token.value / 1000
          : token.value;
      if (period === 'year') return monthly / 12;
      if (period === 'day') return monthly * 22;
      return monthly;
    };

    // 薪资区间通常只有两个数字；多出来的（如“双休”“3年经验”）一并忽略。
    const values = tokens.slice(0, 2)
      .map(toMonthlyK)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return null;

    const roundK = (value) => Math.round(value * 10) / 10;
    return {
      minK: roundK(Math.min.apply(null, values)),
      maxK: roundK(Math.max.apply(null, values)),
      text: display,
      period,
    };
  }

  // 薪资区间显示：整数不带小数，避免日志里出现 8.0K。
  function formatSalaryK(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // 读取薪资筛选要求（月薪 K）；区间上下限都为 0 时视为未启用。
  function getSalaryFilterRange() {
    let minK = Math.max(0, Number(config.salaryMinK) || 0);
    let maxK = Math.max(0, Number(config.salaryMaxK) || 0);
    // 上下限填反时自动纠正，避免配置错误导致所有岗位都被跳过。
    if (minK > 0 && maxK > 0 && minK > maxK) {
      const swapped = minK;
      minK = maxK;
      maxK = swapped;
    }
    return { minK, maxK, active: Boolean(config.salaryFilterEnabled) && (minK > 0 || maxK > 0) };
  }

  // 从卡片整段文本中兜底提取薪资片段：接口和卡片薪资字段都缺失时仍能参与筛选。
  function extractSalaryTextFromText(text) {
    const source = normalizeText(text);
    if (!source) return '';
    const range = source.match(/\d+(?:\.\d+)?\s*(?:[-~至到—])\s*\d+(?:\.\d+)?\s*(?:元|千|[kK]|万)(?:\s*\/\s*(?:月|年|天))?/);
    if (range) return range[0];
    const single = source.match(/\d+(?:\.\d+)?\s*(?:元|千|[kK]|万)(?:\s*\/\s*(?:月|年|天))?/);
    return single ? single[0] : '';
  }

  // 从岗位字段、DOM 薪资、卡片文本三处依次取第一个可解析的薪资。
  function resolveSalaryText(job, domInfo) {
    const candidates = [
      getDisplaySalary(job),
      getReadableSalary(domInfo && domInfo.salary),
      extractSalaryTextFromText(domInfo && domInfo.text),
    ];
    let firstText = '';
    for (const candidate of candidates) {
      const text = normalizeText(candidate);
      if (!text) continue;
      if (!firstText) firstText = text;
      const range = parseSalaryRange(text);
      if (range) return { salaryText: text, range };
    }
    return { salaryText: firstText, range: null };
  }

  // 判断岗位薪资是否符合要求：严格模式要求岗位区间落在设定范围内，宽松模式有重叠即可。
  function salaryMatches(job, domInfo) {
    const required = getSalaryFilterRange();
    if (!required.active) {
      return Object.assign({ matched: true, active: false, salaryText: '', range: null }, required);
    }

    const resolved = resolveSalaryText(job, domInfo);
    const salaryText = resolved.salaryText;
    const range = resolved.range;
    if (!range) {
      return Object.assign({ matched: true, active: true, unknown: true, salaryText, range: null }, required);
    }

    const rangeText = `${formatSalaryK(range.minK)}-${formatSalaryK(range.maxK)}K`;
    const reject = (reason) => Object.assign({
      matched: false,
      active: true,
      salaryText,
      range,
      reason,
    }, required);

    if (config.salaryMatchMode === 'overlap') {
      // 宽松：两个区间只要有交集就保留。
      if (required.maxK > 0 && range.minK > required.maxK) {
        return reject(`岗位薪资 ${rangeText} 高于上限 ${formatSalaryK(required.maxK)}K`);
      }
      if (required.minK > 0 && range.maxK < required.minK) {
        return reject(`岗位薪资 ${rangeText} 低于下限 ${formatSalaryK(required.minK)}K`);
      }
      return Object.assign({ matched: true, active: true, salaryText, range }, required);
    }

    // 严格：岗位薪资区间必须完全落在设定范围内；未填的一端视为不限。
    if (required.minK > 0 && range.minK < required.minK) {
      return reject(`岗位薪资 ${rangeText} 低于下限 ${formatSalaryK(required.minK)}K`);
    }
    if (required.maxK > 0 && range.maxK > required.maxK) {
      return reject(`岗位薪资 ${rangeText} 高于上限 ${formatSalaryK(required.maxK)}K`);
    }
    return Object.assign({ matched: true, active: true, salaryText, range }, required);
  }

  // 收集岗位上可用于黑名单匹配的公司名，详情补全后会包含全称/简称。
  function getCompanyMatchCandidates(job, fallbackCompany) {
    const values = [
      job && job.company,
      job && job.companyFullName,
      job && job.companyShortName,
      fallbackCompany,
    ];
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 任意一条公司黑名单规则命中即跳过，返回命中的规则和公司文本。
  function findCompanyBlacklistMatch(job, fallbackCompany) {
    const rules = normalizeCompanyBlacklistRules(config.companyBlacklistRules);
    if (!rules.length) return null;

    const candidates = getCompanyMatchCandidates(job, fallbackCompany);
    for (const rule of rules) {
      for (const company of candidates) {
        try {
          if (companyTextMatches(company, rule.mode, rule.value)) {
            return { rule, company };
          }
        } catch (error) {
          logDebugEvent('invalid_company_blacklist_rule', {
            rule,
            error: error.message || String(error),
          }, 'warn');
        }
      }
    }
    return null;
  }

  // 根据当前配置判断岗位 Boss 活跃度是否命中，并返回可用于日志/UI 的判定信息。
  function bossActiveMatches(job) {
    const selectedKeys = getSelectedBossActiveKeys();
    const activeText = getDisplayBossActiveTime(job);
    const activeKey = normalizeBossActiveText(activeText);
    if (!selectedKeys.length) {
      return { matched: true, activeText, selectedText: '' };
    }

    return {
      matched: Boolean(activeKey && selectedKeys.some((key) => activeKey === key || activeKey.includes(key))),
      activeText,
      selectedText: normalizeBossActiveOptions(config.bossActiveFilterValues).join('、'),
    };
  }

  // 活跃度字段缺失时，从右侧详情 DOM 轻量补充；这里只补活跃度，不触发完整工商抓取。
  async function enrichBossActiveInfoForFilter(job) {
    if (!hasBossActiveFilter() || getDisplayBossActiveTime(job)) return job;

    try {
      const domDetail = await waitFor(() => {
        const detail = extractDetailInfo();
        return detail && detail.bossActiveTimeDesc ? detail : null;
      }, Math.min(1800, getWaitTimeout() * 1000), 'Boss活跃度', {
        observerRoot: getJobDetailObserverRoot(),
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
      return mergeJobInfo(job, {
        bossActiveTimeDesc: domDetail.bossActiveTimeDesc,
        bossOnline: domDetail.bossOnline,
      });
    } catch (_) {
      return job;
    }
  }

  // 启动前校验配置，发现问题时返回可直接显示给用户的错误文案。
  function validateConfig() {
    const min = Number(config.delayMin);
    const max = Number(config.delayMax);
    const wait = Number(config.waitTimeout);

    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < 1) {
      return '时间间隔必须是大于 0 的数字';
    }

    if (min > max) return '最小间隔不能大于最大间隔';
    if (!Number.isFinite(wait) || wait < 2) return '等待上限不能小于 2 秒';

    const maxListRefresh = Number(config.maxListRefresh);
    if (!Number.isFinite(maxListRefresh) || maxListRefresh < 0) {
      return '列表刷新上限不能小于 0';
    }

    if (config.companyFilterMode === 'regex' && config.companyFilterValue) {
      try {
        new RegExp(config.companyFilterValue);
      } catch (error) {
        return `公司正则无效：${error.message}`;
      }
    }

    for (const rule of normalizeCompanyBlacklistRules(config.companyBlacklistRules)) {
      if (rule.mode !== 'regex') continue;
      try {
        new RegExp(rule.value);
      } catch (error) {
        return `公司黑名单正则无效：${rule.value} / ${error.message}`;
      }
    }

    if (config.greetingMode === 'customText' && config.textSource === 'text' && !normalizeMessageText(config.customText)) {
      return '自定义文本不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api' && !config.customApiUrl) {
      return '自定义文本接口不能为空';
    }

    if (config.greetingMode === 'customText' && config.textSource === 'api') {
      try {
        parseKeyValueConfig(config.customApiParams, 'URL 参数');
        parseKeyValueConfig(config.customApiHeaders, '请求头');
        parseRequestBodyConfig(config.customApiBody, '请求体');
      } catch (error) {
        return error.message || String(error);
      }
    }

    return '';
  }

  // 列表/详情等待上限，配置单位是秒，这里转换为毫秒前做最小值保护。
  function getWaitTimeout() {
    return Math.max(2, Number(config.waitTimeout || DEFAULT_CONFIG.waitTimeout));
  }

  // 聊天页打开重试次数，负数或异常值按 0 处理。
  function getChatOpenRetryLimit() {
    return Math.max(0, Math.floor(Number(config.chatOpenRetries ?? DEFAULT_CONFIG.chatOpenRetries) || 0));
  }

  // 聊天页等待时间比列表更长，给路由和会话渲染留余量。
  function getChatWaitTimeout() {
    return Math.max(15, getWaitTimeout());
  }

  // 生成两次沟通之间的随机等待毫秒数。
  function randomDelayMs(minSeconds, maxSeconds) {
    return randomDelaySeconds(minSeconds, maxSeconds) * 1000;
  }

  // 随机等待秒数，UI 状态里直接展示这个值。
  function randomDelaySeconds(minSeconds, maxSeconds) {
    const min = Math.max(1, Math.ceil(Number(minSeconds || DEFAULT_CONFIG.delayMin)));
    const max = Math.max(min, Math.floor(Number(maxSeconds || DEFAULT_CONFIG.delayMax)));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // 从 localStorage 中的 RunState 恢复 pendingJob，并补齐运行所需的派生字段。
  function revivePendingJob(state) {
    const pending = Object.assign({}, state.pendingJob || {});
    pending.rawJob = state.pendingRawJob || pending.rawJob || null;
    pending.id = pending.id || `job_${hashString(pending.jobKey || `${pending.jobName}|${pending.company}`)}`;
    pending.signature = pending.signature || makeSignature(pending.jobName, pending.company, pending.salary);
    return pending;
  }

  // 将岗位对象拍平成 IndexedDB/导出友好的结构，避免保存复杂引用和原型对象。
  function flattenJob(job) {
    return {
      id: job.id,
      jobKey: job.jobKey,
      signature: job.signature,
      orderIndex: job.orderIndex,
      jobName: job.jobName,
      salary: getDisplaySalary(job),
      company: job.company,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      bossActiveTimeDesc: getDisplayBossActiveTime(job),
      bossOnline: job.bossOnline,
      bossAvatar: job.bossAvatar,
      bossCertificated: job.bossCertificated,
      city: job.city,
      experience: job.experience,
      degree: job.degree,
      positionName: job.positionName,
      address: job.address,
      workAddress: job.workAddress,
      longitude: job.longitude,
      latitude: job.latitude,
      staticMapUrl: job.staticMapUrl,
      encryptAddressId: job.encryptAddressId,
      postDescription: job.postDescription,
      recruitmentCountDesc: job.recruitmentCountDesc,
      positionCode: job.positionCode,
      jobType: job.jobType,
      jobStatusDesc: job.jobStatusDesc,
      showSkills: Array.isArray(job.showSkills) ? job.showSkills.slice() : [],
      companyLogo: job.companyLogo,
      companyFullName: job.companyFullName,
      companyShortName: job.companyShortName,
      companyStage: job.companyStage,
      companyScale: job.companyScale,
      companyIndustry: job.companyIndustry,
      companyIntroduce: job.companyIntroduce,
      companyLabels: Array.isArray(job.companyLabels) ? job.companyLabels.slice() : [],
      businessInfo: job.businessInfo && typeof job.businessInfo === 'object' ? Object.assign({}, job.businessInfo) : null,
      legalRepresentative: job.legalRepresentative,
      establishedDate: job.establishedDate,
      companyType: job.companyType,
      manageState: job.manageState,
      registeredCapital: job.registeredCapital,
      registeredAddress: job.registeredAddress,
      businessTerm: job.businessTerm,
      businessRegion: job.businessRegion,
      unifiedSocialCreditCode: job.unifiedSocialCreditCode,
      approvalDate: job.approvalDate,
      formerName: job.formerName,
      registrationAuthority: job.registrationAuthority,
      businessIndustry: job.businessIndustry,
      businessScope: job.businessScope,
      brandId: job.brandId,
      encryptJobId: job.encryptJobId,
      securityId: job.securityId,
      lid: job.lid,
      source: job.source,
      sourceUrl: job.sourceUrl,
      detailSource: job.detailSource,
      detailSourceUrl: job.detailSourceUrl,
      detailCapturedAt: job.detailCapturedAt,
      htmlDetailUrl: job.htmlDetailUrl,
      htmlCapturedAt: job.htmlCapturedAt,
      companyDetailUrl: job.companyDetailUrl,
      companyDetailCapturedAt: job.companyDetailCapturedAt,
      domOnly: Boolean(job.domOnly),
    };
  }

  // 判断一条记录是否应视为“已沟通”，包括发送成功和本地/页面跳过。
  function isContactedRecord(record) {
    return Boolean(record && (
      record.status === 'sent' ||
      record.status === 'skipped_contacted' ||
      record.status === 'skipped_local_contacted' ||
      record.sentAt
    ));
  }

  // 数据页记录状态文案：投递 / 招呼 / 点击 / 跳过。
  function getRecordStatusMeta(record) {
    const status = String(record && record.status || '');
    const messageType = String(record && record.messageType || '');
    if (status === 'sent' || record && record.sentAt) {
      return {
        label: messageType === 'chatGreeting' ? '已招呼' : '已投递',
        cls: 'za-record-chip za-record-chip-sent',
      };
    }
    if (status === 'clicked') {
      return { label: '已点击', cls: 'za-record-chip za-record-chip-click' };
    }
    if (status === 'skipped_contacted' || status === 'skipped_local_contacted') {
      return { label: '重复跳过', cls: 'za-record-chip za-record-chip-skip' };
    }
    if (status === 'skipped_score') {
      return { label: '评分跳过', cls: 'za-record-chip za-record-chip-skip' };
    }
    if (/^skipped/.test(status)) {
      return { label: '已跳过', cls: 'za-record-chip za-record-chip-skip' };
    }
    return { label: '已记录', cls: 'za-record-chip' };
  }

  // 为岗位生成一组稳定判重 key，优先使用加密岗位 ID、securityId、lid 等强标识。
  function getContactedKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const hasStableJobKey = job.jobKey && !isSyntheticJobKey(job.jobKey);
    const strongPairs = [
      ['jobKey', hasStableJobKey ? job.jobKey : ''],
      ['encryptJobId', job.encryptJobId],
      ['securityId', job.securityId],
      ['lid', job.lid],
      ['id', hasStableJobKey ? job.id : ''],
      ['rawJobId', rawJob.jobId],
      ['rawJobId', rawJob.job_id],
      ['rawEncryptJobId', rawJob.encryptJobId],
      ['rawSecurityId', rawJob.securityId],
      ['rawLid', rawJob.lid],
    ];

    const strongKeys = strongPairs
      .map(([type, value]) => makeContactedKey(type, value))
      .filter(Boolean);

    if (strongKeys.length) return Array.from(new Set(strongKeys));

    const looseSignature = job.looseSignature || makeLooseSignature(job.jobName, job.company);
    const fallbackKey = makeContactedKey('looseSignature', looseSignature);
    return fallbackKey ? [fallbackKey] : [];
  }

  // 给不同来源的判重值加前缀，避免不同字段值碰巧相同。
  function makeContactedKey(type, value) {
    const text = normalizeText(value);
    if (!text) return '';
    return `${type}:${text}`;
  }

  // synthetic key 是脚本用 DOM 字段拼出来的弱 key，不可当强身份使用。
  function isSyntheticJobKey(value) {
    return /^sig_/.test(normalizeText(value));
  }

  // 删除空值字段，避免保存记录时用空字符串覆盖后到的有效详情。
  function compactObject(source) {
    const output = {};
    Object.keys(source || {}).forEach((key) => {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
        output[key] = source[key];
      }
    });
    return output;
  }

  // 文本模板插值，例如 {jobName}、{company}、{bossName}。
  function interpolateText(template, job) {
    const source = String(template || '');
    const data = flattenJob(job || {});
    return source.replace(/\{(\w+)\}/g, (match, key) => {
      if (data[key] == null) return match;
      return String(data[key]);
    });
  }

  // 从一组候选字段中读取第一个非空字符串/数字。
  function pickFirstString(target, keys) {
    if (!target) return '';
    for (const key of keys) {
      const value = target[key];
      if (typeof value === 'string' && value.trim()) return normalizeText(value);
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  // 将接口中的标签数组归一化为字符串数组。
  function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => normalizeText(item && typeof item === 'object' ? item.name || item.text || item.label : item))
      .filter(Boolean);
  }

  // 清理文本但保留换行，用于岗位描述、经营范围等长文本。
  function normalizeTextPreserveLines(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 读取薪资字段，并过滤 BOSS 私有字体加密后的不可读薪资。
  function pickReadableSalary(target, keys) {
    // 接口 salaryDesc 是首选；如果取到的是私有区字符，继续尝试其它薪资字段。
    const first = pickFirstString(target, keys);
    if (!isEncryptedSalary(first)) return first;

    for (const key of keys) {
      const value = getReadableSalary(target && target[key]);
      if (value) return value;
    }
    return '';
  }

  // 生成岗位详情匹配 key，允许列表岗位和详情岗位互相找到。
  function getJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const values = [
      job.jobKey,
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.encryptId,
      job.rawDetail && job.rawDetail.securityId,
      job.rawDetail && job.rawDetail.lid,
    ];

    if (job.signature) values.push(`signature:${job.signature}`);
    if (job.looseSignature) values.push(`loose:${job.looseSignature}`);
    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 可靠身份只包含真实接口 ID，不包含 DOM 拼出来的 sig_ 弱 key。
  function getReliableJobIdentityKeys(job) {
    if (!job) return [];

    const rawJob = job.rawJob || {};
    const rawDetail = job.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [];
    const jobKey = normalizeText(job.jobKey);
    if (jobKey && !isSyntheticJobKey(jobKey)) values.push(jobKey);

    [
      job.encryptJobId,
      job.securityId,
      job.lid,
      rawJob.encryptId,
      rawJob.encryptJobId,
      rawJob.jobId,
      rawJob.job_id,
      rawJob.securityId,
      rawJob.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ].forEach((value) => values.push(value));

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // 弱签名只能用于没有可靠 ID 的兜底匹配，并且文本字段不能明显冲突。
  function isWeakDetailCompatible(job, detail) {
    return getWeakDetailCompatibilityReport(job, detail).compatible;
  }

  function getWeakDetailCompatibilityReport(job, detail) {
    if (!job || !detail) {
      return { compatible: false, reason: 'missing_job_or_detail' };
    }

    if (!areComparableTextsCompatible(job.jobName, detail.jobName)) {
      return {
        compatible: false,
        reason: 'job_name_mismatch',
        jobName: job.jobName,
        detailJobName: detail.jobName,
      };
    }
    if (!areComparableTextsCompatible(job.company, detail.company)) {
      return {
        compatible: false,
        reason: 'company_mismatch',
        company: job.company,
        detailCompany: detail.company,
      };
    }

    const jobSalary = getReadableSalary(job.salary);
    const detailSalary = getReadableSalary(detail.salary);
    if (jobSalary && detailSalary && jobSalary !== detailSalary) {
      return {
        compatible: false,
        reason: 'salary_mismatch',
        jobSalary,
        detailSalary,
      };
    }

    return {
      compatible: true,
      reason: 'weak_text_match',
      jobSalary,
      detailSalary,
    };
  }

  // 主动补拉详情后的安全校验：优先要求可靠 ID 命中，必要时才退回文本兼容判断。
  function isFetchedDetailCompatibleWithJob(job, detail, options) {
    return getFetchedDetailCompatibilityReport(job, detail, options).compatible;
  }

  function getFetchedDetailCompatibilityReport(job, detail, options) {
    const jobKeys = getReliableJobIdentityKeys(job);
    const detailKeyList = getReliableJobIdentityKeys(detail);
    const detailKeys = new Set(detailKeyList);
    const commonKeys = jobKeys.filter((key) => detailKeys.has(key));
    const allowWeakWithReliableKey = Boolean(options && options.allowWeakWithReliableKey);
    const weakReport = getWeakDetailCompatibilityReport(job, detail);

    if (jobKeys.length && detailKeyList.length) {
      if (commonKeys.length) {
        return Object.assign({}, weakReport, {
          compatible: true,
          reason: 'reliable_key_match',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
      if (!allowWeakWithReliableKey) {
        return Object.assign({}, weakReport, {
          compatible: false,
          reason: 'reliable_key_mismatch',
          jobKeys,
          detailKeys: detailKeyList,
          commonKeys,
          allowWeakWithReliableKey,
        });
      }
    }

    return Object.assign({}, weakReport, {
      jobKeys,
      detailKeys: detailKeyList,
      commonKeys,
      allowWeakWithReliableKey,
    });
  }

  // 比较岗位名/公司名等文本字段；一边缺失时不阻断补全。
  function areComparableTextsCompatible(left, right) {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return true;
    return a === b || a.includes(b) || b.includes(a);
  }

  // 只返回强身份 key，用于列表和详情之间高可信合并。
  function getJobStrongIdentityKeys(job) {
    return getReliableJobIdentityKeys(job);
  }

  // 详情对象入库索引用 key，和 getJobIdentityKeys 保持兼容。
  function getJobDetailKeys(detail) {
    if (!detail) return [];

    const rawDetail = detail.rawDetail || {};
    const rawJobInfo = rawDetail.jobInfo || {};
    const values = [
      detail.jobKey,
      detail.encryptJobId,
      detail.securityId,
      detail.lid,
      rawJobInfo.encryptId,
      rawJobInfo.encryptJobId,
      rawJobInfo.jobId,
      rawJobInfo.job_id,
      rawDetail.securityId,
      rawDetail.lid,
    ];

    return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
  }

  // UI/导出展示薪资时优先使用明文薪资，避免展示私有字体字符。
  function getDisplaySalary(job) {
    return getReadableSalary(job && job.salary) ||
      getReadableSalary(job && job.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.jobInfo && job.rawDetail.jobInfo.salaryDesc) ||
      getReadableSalary(job && job.rawDetail && job.rawDetail.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salaryDesc) ||
      getReadableSalary(job && job.rawJob && job.rawJob.salary) ||
      '';
  }

  // 相对时间显示：几分钟前、几小时前、几天前。
  function formatRelativeTime(dateString) {
    if (!dateString) return '';
    const ts = new Date(dateString).getTime();
    if (Number.isNaN(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}个月前`;
    return `${Math.floor(months / 12)}年前`;
  }

  // Boss 活跃时间可能来自接口、HTML 或原始字段，这里统一展示取值。
  function getDisplayBossActiveTime(job) {
    if (!job) return '';
    if (job.bossOnline) return '在线';
    const rawActiveText =
      pickFirstString(job.rawDetail && job.rawDetail.bossInfo, [
        'activeTimeDesc',
        'bossActiveTimeDesc',
        'bossActiveDesc',
        'lastActiveTimeDesc',
        'onlineDesc',
      ]) ||
      pickFirstString(job.rawDetail, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc']) ||
      pickFirstString(job.rawJob, ['activeTimeDesc', 'bossActiveTimeDesc', 'bossActiveDesc', 'lastActiveTimeDesc']);
    return getBossActiveOptionLabel(job.bossActiveTimeDesc) ||
      getBossActiveOptionLabel(rawActiveText) ||
      '';
  }

  // 公司展示优先完整公司名，再退回简称/列表公司名。
  function getDisplayCompany(job) {
    return getDisplayText(job && job.company);
  }

  // 统一清理导出/UI 文本。
  function getDisplayText(value) {
    const text = normalizeText(value);
    return text && !isEncryptedSalary(text) ? text : '';
  }

  // 判断薪资是否可读；私有区字符返回空。
  function getReadableSalary(value) {
    const text = normalizeText(value);
    if (!text || isEncryptedSalary(text)) return '';
    return text;
  }

  // BOSS 私有字体薪资一般落在 Unicode 私有区，不能用于记录和匹配。
  function isEncryptedSalary(text) {
    // BOSS 部分 DOM 会用私有区字体映射展示薪资，如 “-K”；接口 salaryDesc 通常是明文。
    return /[\uE000-\uF8FF]/.test(String(text || ''));
  }

  // 有深度限制的对象遍历，用于从未知接口结构中找岗位/常用语字段。
  function walkObject(value, visitor, depth) {
    const currentDepth = depth || 0;
    if (currentDepth > 8 || value == null) return;
    visitor(value);

    if (Array.isArray(value)) {
      value.forEach((item) => walkObject(item, visitor, currentDepth + 1));
      return;
    }

    if (typeof value === 'object') {
      Object.keys(value).forEach((key) => walkObject(value[key], visitor, currentDepth + 1));
    }
  }

  // 完整签名：岗位名 + 公司 + 薪资，匹配精度较高。
  function makeSignature(jobName, company, salary) {
    return [jobName, company, salary].map(normalizeText).join('|');
  }

  // 弱签名：岗位名 + 公司，薪资不可读或缺失时使用。
  function makeLooseSignature(jobName, company) {
    return [jobName, company].map(normalizeText).join('|');
  }

  // 过滤只有分隔符的空签名。
  function isMeaningfulCompositeKey(value) {
    const text = normalizeText(value);
    return Boolean(text && text.replace(/[|:]/g, ''));
  }

  // 单行文本归一化。
  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // Boss 活跃度匹配专用归一化：去掉 DOM/伪元素残留、标点和分隔符。
  function normalizeBossActiveText(text) {
    return normalizeText(text)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/::?(?:before|after)/gi, '')
      .replace(/[^\u3400-\u9FFFA-Za-z0-9]/g, '')
      .replace(/^(?:BOSS|Boss|boss|HR|hr)+/, '')
      .trim();
  }

  // 发送消息归一化：保留换行，只去掉首尾空白。
  function normalizeMessageText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  // 把用户输入转义为安全的正则字面量。
  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 判断元素是否可见，避免点击/等待隐藏节点。
  // 快速路径：offsetWidth/offsetHeight 为 0 时无需 getComputedStyle（display:none 或不在 DOM）。
  function isVisible(element) {
    if (!element) return false;
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    if (w === 0 && h === 0) return false;
    // 维度正常时，getComputedStyle 只检查 visibility（display:none 已被上面的 0 尺寸覆盖）
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Promise 版延时。
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 带状态栏刷新的一秒倒计时等待，用于自动沟通间隔提示。
  async function waitWithStatusCountdown(nextRunAt, createMessage) {
    while (!runtime.stopRequested) {
      const state = RunState.load();
      if (!state || !state.active) return false;

      const remainingMs = Math.max(0, Number(nextRunAt || 0) - Date.now());
      if (remainingMs <= 0) break;

      const remainingSeconds = Math.ceil(remainingMs / 1000);
      UI.setStatus(createMessage(remainingSeconds), 'info');
      await sleep(Math.min(1000, remainingMs));
    }
    return !runtime.stopRequested;
  }

  // 统一使用 ISO 时间写入记录，便于排序和导出。
  function nowIso() {
    return new Date().toISOString();
  }

  // 解析面板里的本地时间输入。
  function parseDateTimeLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // 面板状态展示用的本地时间格式。
  function formatLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 一条记录的沟通时间优先级，用于排序和按时间清理。
  function getRecordCommunicationTime(record) {
    return record && (record.sentAt || record.clickedAt || record.updatedAt || record.createdAt || '');
  }

  // 查询浏览器当前 origin 的存储使用量和配额。
  async function getStorageEstimate() {
    try {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      const estimate = await navigator.storage.estimate();
      return {
        usage: Number(estimate.usage || 0),
        quota: Number(estimate.quota || 0),
      };
    } catch (_) {
      return null;
    }
  }

  // 构造用户可读的存储空间不足错误。
  function createStorageQuotaError(estimate, cause) {
    const usage = estimate && Number(estimate.usage || 0);
    const quota = estimate && Number(estimate.quota || 0);
    const ratio = quota ? Math.round((usage / quota) * 100) : 0;
    const detail = quota
      ? `当前已使用 ${formatBytes(usage)} / ${formatBytes(quota)}（约 ${ratio}%）。`
      : '';
    const error = new Error(`浏览器本地存储空间已接近上限，${detail}请先导出并删除部分岗位记录后再继续。`);
    error.cause = cause || null;
    error.zhipinStorageQuota = true;
    return error;
  }

  // 兼容不同浏览器的 IndexedDB 配额错误名称和消息。
  function isStorageQuotaError(error) {
    const name = String(error && error.name || '');
    const message = String(error && error.message || '');
    return /QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED/i.test(name) ||
      /quota|storage|空间|配额/i.test(message);
  }

  // 存储配额提示里的字节格式化。
  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
  }

  // 清理数据前的确认入口：优先使用脚本内弹窗，没有 UI 时退回浏览器 confirm。
  function askConfirm(message, options) {
    if (runtime.ui && runtime.ui.root) {
      return showConfirmDialog(message, options);
    }

    const confirmFn = window.confirm || pageWindow.confirm;
    if (typeof confirmFn !== 'function') {
      return Promise.reject(new Error('当前浏览器环境不支持确认弹窗'));
    }

    return Promise.resolve(confirmFn.call(window, message));
  }

  // 脚本内确认弹窗，避免页面样式或浏览器拦截影响确认流程。
  // 追加到 document.body 而非 runtime.ui.root，确保 z-index 层级高于脚本面板和 BOSS 页面。
  let cancelActiveConfirm = null;
  function showConfirmDialog(message, options) {
    const opts = options || {};
    const title = opts.title || '确认操作';
    const confirmText = opts.confirmText || '确认删除';
    const cancelText = opts.cancelText || '取消';
    const tone = opts.tone === 'normal' ? 'normal' : 'danger';

    return new Promise((resolve) => {
      // 关闭已有弹窗（连同它的键盘监听），避免新旧弹窗同时响应按键
      if (typeof cancelActiveConfirm === 'function') {
        const cancelPrevious = cancelActiveConfirm;
        cancelActiveConfirm = null;
        cancelPrevious();
      }
      const existing = document.body.querySelector('.za-confirm-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.className = 'za-confirm-backdrop';
      backdrop.dataset.tone = tone;
      backdrop.innerHTML = `
        <div class="za-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="za-confirm-title" aria-describedby="za-confirm-message">
          <div class="za-confirm-icon-wrap" aria-hidden="true">
            <svg class="za-confirm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <h2 class="za-confirm-title" id="za-confirm-title">${escapeHtml(title)}</h2>
          <p class="za-confirm-message" id="za-confirm-message">${escapeHtml(message)}</p>
          <div class="za-confirm-actions">
            <button type="button" class="za-confirm-btn-cancel" data-confirm="cancel">${escapeHtml(cancelText)}</button>
            <button type="button" class="za-confirm-btn-danger" data-confirm="ok">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;

      let settled = false;
      const cleanup = (value) => {
        if (settled) return;
        settled = true;
        if (cancelActiveConfirm === cancelSelf) cancelActiveConfirm = null;
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.classList.add('za-confirm-fadeout');
        setTimeout(() => {
          backdrop.remove();
          resolve(value);
        }, 160);
      };
      const cancelSelf = () => cleanup(false);
      cancelActiveConfirm = cancelSelf;

      const findButton = (action) => backdrop.querySelector(`[data-confirm="${action}"]`);

      backdrop.addEventListener('click', (event) => {
        const action = event.target && event.target.dataset && event.target.dataset.confirm;
        if (action === 'ok') cleanup(true);
        if (action === 'cancel' || event.target === backdrop) cleanup(false);
      });

      // 捕获阶段监听，避免 BOSS 页面的快捷键拦截 Esc / Enter。
      function onKeydown(event) {
        if (event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          cleanup(false);
          return;
        }
        if (event.key === 'Enter') {
          const active = document.activeElement;
          if (active === findButton('ok')) {
            event.stopPropagation();
            event.preventDefault();
            cleanup(true);
          }
          return;
        }
        if (event.key !== 'Tab') return;
        // 焦点锁在弹窗内，避免 Tab 跑到 BOSS 页面控件上。
        const focusables = [findButton('cancel'), findButton('ok')].filter(Boolean);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!backdrop.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }

      // 追加到 document.body 确保最高层级
      document.body.appendChild(backdrop);
      document.addEventListener('keydown', onKeydown, true);
      // 聚焦取消按钮，防止误触回车确认删除
      const cancelButton = findButton('cancel');
      if (cancelButton) cancelButton.focus();
    });
  }

  // 导出文件名中的时间戳。
  function dateFileName() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  // FNV-1a 风格哈希，用于合成稳定短 id。
  function hashString(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  // UI innerHTML 中插入文本前必须转义，避免记录内容破坏面板 DOM。
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 优先使用系统“另存为”选择器；不可用时由 downloadBlob 降级成浏览器下载。
  function requestSaveFileHandle(fileName, extension) {
    const picker = pageWindow && pageWindow.showSaveFilePicker;
    if (typeof picker !== 'function') return null;

    const ext = String(extension || '').replace(/^\./, '').toLowerCase();
    const mimeType = ext === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/json';
    const description = ext === 'xlsx' ? 'Excel 工作簿' : 'JSON 数据';

    try {
      return Promise.resolve(picker.call(pageWindow, {
        suggestedName: ensureFileExtension(fileName, ext),
        excludeAcceptAllOption: true,
        types: [{
          description,
          accept: { [mimeType]: [`.${ext}`] },
        }],
      }));
    } catch (error) {
      console.warn('[ZhipinAuto] 系统另存为不可用，降级为浏览器下载', error);
      return null;
    }
  }

  // 写入用户选择的文件句柄，失败或不支持时创建 blob URL 触发下载。
  async function downloadBlob(content, fileName, type, extension, saveHandlePromise) {
    const safeFileName = ensureFileExtension(fileName, extension);
    const blob = createBlob(content, type);

    if (saveHandlePromise) {
      let handle = null;
      try {
        handle = await saveHandlePromise;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          const cancelled = new Error('用户取消导出');
          cancelled.zhipinAutoExportCancelled = true;
          throw cancelled;
        }
        console.warn('[ZhipinAuto] 系统另存为失败，降级为浏览器下载', error);
      }

      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return ensureFileExtension(handle.name || safeFileName, extension);
      }
    }

    const url = URL.createObjectURL(blob);

    try {
      triggerAnchorDownload(url, safeFileName);
      return safeFileName;
    } catch (error) {
      throw new Error(`浏览器下载失败：${error.message || error}`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
  }

  // 兼容字符串、ArrayBuffer 和已经构造好的 Blob。
  function createBlob(content, type) {
    if (content instanceof Blob) return content;
    return new Blob([content], { type });
  }

  // 清理非法文件名字符，并保证导出文件有正确扩展名。
  function ensureFileExtension(fileName, extension) {
    const normalized = String(fileName || `zhipin-job-records-${dateFileName()}`).replace(/[\\/:*?"<>|]+/g, '-');
    const ext = String(extension || '').replace(/^\./, '');
    if (!ext || new RegExp(`\\.${escapeRegExp(ext)}$`, 'i').test(normalized)) return normalized;
    return `${normalized}.${ext}`;
  }

  // 浏览器下载兜底：临时创建隐藏 a 标签并触发原生 click。
  function triggerAnchorDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.setAttribute('download', fileName);
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);

    const nativeClick = pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype.click;
    if (nativeClick) {
      nativeClick.call(link);
    } else {
      link.click();
    }

    link.remove();
  }

  // 注入全新现代化样式（覆盖旧样式）
  function injectNewStyle() {
    if (document.getElementById('zhipin-auto-greeting-new-style')) return;
    const style = document.createElement('style');
    style.id = 'zhipin-auto-greeting-new-style';
    style.textContent = `
      #zhipin-auto-greeting-root {
        --za-bg: #ffffff;
        --za-bg-soft: #f8fafc;
        --za-bg-deep: #f1f5f9;
        --za-border: #e2e8f0;
        --za-border-strong: #cbd5e1;
        --za-text: #0f172a;
        --za-muted: #64748b;
        --za-primary: #d97706;
        --za-primary-deep: #b45309;
        --za-primary-soft: #fffbeb;
        --za-primary-border: #fde68a;
        --za-accent: #2563eb;
        --za-accent-soft: #eff6ff;
        --za-danger: #dc2626;
        --za-danger-soft: #fef2f2;
        --za-success: #059669;
        --za-success-soft: #ecfdf5;
        --za-warn: #d97706;
        --za-warn-soft: #fffbeb;
        --za-shadow-sm: 0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04);
        --za-shadow-md: 0 4px 12px rgba(15, 23, 42, 0.10), 0 2px 4px rgba(15, 23, 42, 0.06);
        --za-shadow-lg: 0 20px 48px rgba(15, 23, 42, 0.18), 0 8px 16px rgba(15, 23, 42, 0.08);
        --za-radius: 12px;
        --za-radius-sm: 8px;
        --za-radius-lg: 16px;
        color: var(--za-text);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        position: fixed;
        z-index: 2147483000;
        top: 20px;
        right: 20px;
      }
      #zhipin-auto-greeting-root * {
        box-sizing: border-box;
      }
      #zhipin-auto-greeting-root [hidden] {
        display: none !important;
      }
      #zhipin-auto-greeting-root * {
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 transparent;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-track {
        background: transparent;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-thumb {
        background: #d5dce6;
        border: 2px solid transparent;
        border-radius: 999px;
        background-clip: content-box;
      }
      #zhipin-auto-greeting-root *::-webkit-scrollbar-thumb:hover {
        background: #b7c2d0;
        border: 2px solid transparent;
        background-clip: content-box;
      }

      /* 浮动开关按钮（收起状态） */
      #zhipin-auto-greeting-root .za-toggle {
        position: fixed;
        right: 0;
        top: 45%;
        width: 38px;
        min-height: 76px;
        border: 1px solid #1e293b;
        border-right: 0;
        border-left: 3px solid var(--za-primary);
        border-radius: 8px 0 0 8px;
        background: #0f172a;
        color: #fbbf24;
        cursor: pointer;
        writing-mode: vertical-rl;
        letter-spacing: 0.1em;
        box-shadow: var(--za-shadow-md);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 8px 0;
        font-size: 12px;
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-toggle-icon {
        font-size: 14px;
        writing-mode: horizontal-tb;
      }
      #zhipin-auto-greeting-root .za-toggle-text {
        writing-mode: vertical-rl;
      }

      /* 主窗口容器 */
      #zhipin-auto-greeting-root .za-window {
        position: fixed;
        right: 20px;
        top: 20px;
        width: 460px;
        height: 600px;
        min-width: 360px;
        min-height: 320px;
        max-width: calc(100vw - 40px);
        max-height: calc(100vh - 40px);
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        transform: translateX(0);
        transition: transform 200ms ease, opacity 200ms ease;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root.za-open .za-window {
        transform: translateX(0);
      }
      #zhipin-auto-greeting-root.za-open .za-toggle {
        display: none;
      }
      #zhipin-auto-greeting-root:not(.za-open) .za-window {
        transform: translateX(120%);
        pointer-events: none;
      }
      #zhipin-auto-greeting-root .za-window-minimized .za-main,
      #zhipin-auto-greeting-root .za-window-minimized .za-footer,
      #zhipin-auto-greeting-root .za-window-minimized .za-resize-handle {
        display: none !important;
      }
      #zhipin-auto-greeting-root .za-window-minimized {
        height: auto !important;
        min-height: 0 !important;
        resize: none;
      }

      /* 标题栏（可拖拽） */
      #zhipin-auto-greeting-root .za-titlebar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 8px 8px 12px;
        background: #0f172a;
        color: #fff;
        cursor: move;
        user-select: none;
        touch-action: none;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      }
      #zhipin-auto-greeting-root .za-title {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-logo {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        background: linear-gradient(135deg, #f59e0b, #d97706);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 2px 6px rgba(217, 119, 6, 0.35);
        font-size: 15px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-title-text {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-title-text strong {
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.25;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-subtitle {
        margin-top: 2px;
        font-size: 10.5px;
        line-height: 1;
        color: rgba(255, 255, 255, 0.45);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-window-controls {
        display: flex;
        align-items: center;
        gap: 2px;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-tool-group {
        display: inline-flex;
        align-items: center;
        gap: 0;
        margin-right: 4px;
        padding: 1px 3px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.06);
        font-size: 10.5px;
        color: rgba(255, 255, 255, 0.72);
      }
      #zhipin-auto-greeting-root .za-tool-btn {
        width: 19px !important;
        height: 19px !important;
        font-size: 12px !important;
        line-height: 1 !important;
        padding: 0 !important;
        border-radius: 5px !important;
        background: transparent !important;
        border: 0 !important;
        color: rgba(255, 255, 255, 0.75) !important;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-tool-btn:hover {
        background: rgba(255, 255, 255, 0.12) !important;
        color: #fff !important;
      }
      #zhipin-auto-greeting-root .za-opacity-indicator {
        min-width: 30px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-icon-btn {
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: rgba(255, 255, 255, 0.62);
        font-size: 13px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease, color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-icon-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      #zhipin-auto-greeting-root .za-icon-btn:active {
        background: rgba(255, 255, 255, 0.16);
      }

      /* 板块管理浮层 */
      #zhipin-auto-greeting-root .za-feature-panel {
        position: absolute;
        top: 50px;
        right: 10px;
        z-index: 10;
        width: 260px;
        max-height: 70%;
        overflow-y: auto;
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        padding: 12px;
      }
      #zhipin-auto-greeting-root .za-feature-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head .za-icon-btn {
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head .za-icon-btn:hover {
        background: var(--za-bg-soft);
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-feature-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      /* 主体区：左侧导航 + 右侧内容 */
      #zhipin-auto-greeting-root .za-main {
        flex: 1 1 auto;
        display: flex;
        min-height: 0;
        overflow: hidden;
      }

      /* 左侧导航栏 */
      #zhipin-auto-greeting-root .za-sidebar {
        flex: 0 0 auto;
        width: 66px;
        background: #0b1220;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 6px;
        border-right: 1px solid rgba(255, 255, 255, 0.05);
      }
      #zhipin-auto-greeting-root .za-nav-item {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 8px 4px;
        background: transparent;
        border: 0;
        border-radius: 9px;
        color: rgba(255, 255, 255, 0.42);
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;
        font-size: 10.5px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-nav-item:hover {
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.86);
      }
      #zhipin-auto-greeting-root .za-nav-item.za-tab-active {
        background: rgba(217, 119, 6, 0.18);
        color: #fbbf24;
        box-shadow: inset 0 0 0 1px rgba(251, 191, 36, 0.16);
      }
      #zhipin-auto-greeting-root .za-nav-item.za-tab-active::before {
        content: "";
        position: absolute;
        left: 0;
        top: 28%;
        height: 44%;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: #f59e0b;
      }
      #zhipin-auto-greeting-root .za-nav-icon {
        font-size: 17px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-nav-label {
        font-size: 10px;
        letter-spacing: 0.02em;
      }
      #zhipin-auto-greeting-root .za-nav-badge {
        position: absolute;
        top: 3px;
        right: 5px;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-size: 9px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
        box-shadow: 0 0 0 2px #0b1220;
      }

      /* 右侧内容区 */
      #zhipin-auto-greeting-root .za-content {
        flex: 1 1 auto;
        min-width: 0;
        overflow-y: auto;
        background: var(--za-bg);
      }
      #zhipin-auto-greeting-root .za-pane {
        display: none;
        flex-direction: column;
        padding-bottom: 6px;
      }
      #zhipin-auto-greeting-root .za-pane-active {
        display: flex;
      }

      /* 状态提示条 */
      #zhipin-auto-greeting-root .za-status {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        margin: 10px 12px 0;
        padding: 7px 10px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 11.5px;
        line-height: 1.45;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-status::before {
        content: "";
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        margin-top: 6px;
        border-radius: 50%;
        background: #94a3b8;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"] {
        background: var(--za-success-soft);
        border-color: #a7f3d0;
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"]::before {
        background: var(--za-success);
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"] {
        background: var(--za-warn-soft);
        border-color: var(--za-primary-border);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"]::before {
        background: var(--za-warn);
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"] {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"]::before {
        background: var(--za-danger);
      }

      /* 配置区块 */
      #zhipin-auto-greeting-root .za-section {
        padding: 12px 12px 2px;
      }
      #zhipin-auto-greeting-root h3 {
        margin: 0 0 9px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.25;
        color: #334155;
        padding-left: 7px;
        border-left: 3px solid var(--za-primary);
        letter-spacing: 0.02em;
      }
      #zhipin-auto-greeting-root label {
        display: block;
        color: var(--za-text);
        margin-bottom: 7px;
        font-size: 11.5px;
      }
      #zhipin-auto-greeting-root .za-check {
        display: flex !important;
        align-items: flex-start;
        gap: 8px;
        margin: 0 0 6px;
        padding: 7px 9px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: var(--za-bg-soft);
        font-size: 11.5px;
        line-height: 1.45;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-check:hover {
        border-color: var(--za-border-strong);
        background: #fff;
      }
      #zhipin-auto-greeting-root .za-check:has(input:checked) {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
      }
      #zhipin-auto-greeting-root .za-check input {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        margin: 1px 0 0;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-label {
        font-weight: 600;
        margin-bottom: 5px;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-hint {
        margin: 3px 0 9px;
        color: var(--za-muted);
        font-size: 10.5px;
        line-height: 1.55;
      }
      #zhipin-auto-greeting-root .za-salary-state {
        margin: 2px 0 6px;
        color: var(--za-muted);
        font-size: 10.5px;
        line-height: 1.5;
      }
      #zhipin-auto-greeting-root .za-salary-state.za-on {
        color: var(--za-primary);
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-salary-state.za-warn {
        color: var(--za-primary);
        font-weight: 600;
      }

      /* 输入控件 */
      #zhipin-auto-greeting-root input[type="text"],
      #zhipin-auto-greeting-root input[type="url"],
      #zhipin-auto-greeting-root input[type="password"],
      #zhipin-auto-greeting-root input[type="number"],
      #zhipin-auto-greeting-root input[type="datetime-local"],
      #zhipin-auto-greeting-root input[type="search"],
      #zhipin-auto-greeting-root select,
      #zhipin-auto-greeting-root textarea {
        width: 100%;
        padding: 6px 9px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        color: var(--za-text);
        font: inherit;
        font-size: 12px;
        line-height: 1.5;
        transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      #zhipin-auto-greeting-root input[type="text"]:hover,
      #zhipin-auto-greeting-root input[type="url"]:hover,
      #zhipin-auto-greeting-root input[type="number"]:hover,
      #zhipin-auto-greeting-root input[type="datetime-local"]:hover,
      #zhipin-auto-greeting-root input[type="search"]:hover,
      #zhipin-auto-greeting-root select:hover,
      #zhipin-auto-greeting-root textarea:hover {
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root input:focus,
      #zhipin-auto-greeting-root select:focus,
      #zhipin-auto-greeting-root textarea:focus {
        outline: 0;
        border-color: var(--za-primary);
        background: #fff;
        box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.14);
      }
      #zhipin-auto-greeting-root textarea {
        resize: vertical;
        min-height: 84px;
        padding: 8px 9px;
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.65;
      }
      #zhipin-auto-greeting-root input[type="checkbox"],
      #zhipin-auto-greeting-root input[type="radio"] {
        accent-color: var(--za-primary);
        cursor: pointer;
      }

      /* 按钮样式 */
      #zhipin-auto-greeting-root button {
        min-height: 30px;
        padding: 0 12px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        color: var(--za-text);
        font: inherit;
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease;
      }
      #zhipin-auto-greeting-root button:hover {
        background: var(--za-bg-soft);
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root button:active {
        transform: translateY(1px);
      }
      #zhipin-auto-greeting-root button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      #zhipin-auto-greeting-root button.za-primary {
        background: var(--za-primary);
        border-color: var(--za-primary);
        color: #fff;
      }
      #zhipin-auto-greeting-root button.za-primary:hover {
        background: var(--za-primary-deep);
        border-color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root button.za-danger {
        background: var(--za-bg);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root button.za-danger:hover:not(:disabled) {
        background: var(--za-danger-soft);
        border-color: #fca5a5;
      }
      #zhipin-auto-greeting-root button.za-danger-soft {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root button.za-danger-soft:hover {
        background: #fee2e2;
      }

      /* 行内布局 */
      #zhipin-auto-greeting-root .za-inline {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      #zhipin-auto-greeting-root .za-inline > input,
      #zhipin-auto-greeting-root .za-inline > select {
        flex: 1 1 auto;
        min-width: 80px;
      }
      #zhipin-auto-greeting-root .za-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-grid-2 label {
        margin-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-radio-row,
      #zhipin-auto-greeting-root .za-segment {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-radio-row label,
      #zhipin-auto-greeting-root .za-segment label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 6px 11px;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        background: var(--za-bg);
        font-size: 11.5px;
        cursor: pointer;
        transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
      }
      #zhipin-auto-greeting-root .za-radio-row label:hover,
      #zhipin-auto-greeting-root .za-segment label:hover {
        border-color: var(--za-border-strong);
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-radio-row label:has(input:checked),
      #zhipin-auto-greeting-root .za-segment label:has(input:checked) {
        border-color: var(--za-primary);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        font-weight: 600;
        box-shadow: 0 0 0 2px rgba(217, 119, 6, 0.1);
      }
      #zhipin-auto-greeting-root .za-radio-row input,
      #zhipin-auto-greeting-root .za-segment input {
        margin: 0;
      }

      /* 常用语选择器 */
      #zhipin-auto-greeting-root .za-mode-block {
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-control {
        display: flex;
        gap: 6px;
        margin-bottom: 6px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger {
        flex: 1 1 auto;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview {
        padding: 8px 10px;
        background: var(--za-bg-soft);
        border-radius: var(--za-radius-sm);
        font-size: 12px;
        color: var(--za-text);
        min-height: 32px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.4);
        z-index: 2147483100;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #zhipin-auto-greeting-root .za-fast-reply-dialog {
        width: 380px;
        max-width: calc(100vw - 40px);
        max-height: 60vh;
        background: var(--za-bg);
        border-radius: var(--za-radius);
        box-shadow: var(--za-shadow-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root .za-fast-reply-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-search {
        display: flex;
        gap: 6px;
        padding: 8px 14px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-list {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 6px 0;
      }

      /* 多选下拉 */
      #zhipin-auto-greeting-root .za-multi-dropdown {
        position: relative;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-multi-trigger {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-multi-menu {
        position: absolute;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        max-height: 200px;
        overflow-y: auto;
        background: var(--za-bg);
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        box-shadow: var(--za-shadow-md);
        z-index: 5;
      }

      /* 已沟通列表 */
      #zhipin-auto-greeting-root .za-list-section {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        min-height: 200px;
      }
      #zhipin-auto-greeting-root .za-list-viewport {
        flex: 1 1 auto;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius-sm);
        position: relative;
        max-height: 280px;
      }

      /* 已沟通列表：固定可视高度，避免 flex 收缩成空白块 */
      #zhipin-auto-greeting-root .za-list-viewport {
        height: 260px;
      }
      #zhipin-auto-greeting-root .za-list-spacer {
        width: 1px;
      }
      #zhipin-auto-greeting-root .za-list-items {
        position: absolute;
        inset: 0 0 auto 0;
      }
      #zhipin-auto-greeting-root .za-list-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 48px;
        padding: 6px 10px;
        border-bottom: 1px solid #eef2f6;
        overflow: hidden;
        cursor: default;
        transition: background 0.15s;
      }
      #zhipin-auto-greeting-root .za-list-row:hover {
        background: #f0f5ff;
      }
      #zhipin-auto-greeting-root .za-list-row-main {
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1.4;
      }
      #zhipin-auto-greeting-root .za-list-row-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 500;
        color: #1a1a1a;
      }
      #zhipin-auto-greeting-root .za-list-row-salary {
        flex: 0 0 auto;
        font-size: 12px;
        color: #ff6633;
        font-weight: 500;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-row-sub {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        line-height: 1.4;
        margin-top: 2px;
      }
      #zhipin-auto-greeting-root .za-list-row-company {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-list-row-meta {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--za-muted);
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-status {
        display: inline-block;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 16px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-list-status-sent {
        background: #e6f7e6;
        color: #389e0d;
      }
      #zhipin-auto-greeting-root .za-list-status-skipped {
        background: #fff7e6;
        color: #d48806;
      }
      #zhipin-auto-greeting-root .za-list-row-time {
        color: #bfbfbf;
      }
      /* 已沟通列表：空状态与标题计数（新版样式自带，旧样式块未注入） */
      #zhipin-auto-greeting-root .za-list-section h3 {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-list-count {
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid var(--za-border);
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        line-height: 16px;
      }
      #zhipin-auto-greeting-root .za-list-refresh {
        margin-left: auto;
        padding: 2px 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-list-refresh:hover {
        color: var(--za-primary);
        border-color: var(--za-primary-border);
      }
      #zhipin-auto-greeting-root .za-list-empty { padding: 32px 8px; color: var(--za-muted); text-align: center; font-size: 12px; }
      #zhipin-auto-greeting-root .za-list-empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
      #zhipin-auto-greeting-root .za-list-empty-hint { font-size: 11px; color: #bfbfbf; margin-top: 4px; }


      /* 底部操作栏 */
      #zhipin-auto-greeting-root .za-footer {
        flex: 0 0 auto;
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid var(--za-border);
        background: var(--za-bg);
        box-shadow: 0 -2px 8px rgba(15, 23, 42, 0.03);
      }
      #zhipin-auto-greeting-root .za-footer button {
        flex: 1 1 0;
        min-height: 34px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 600;
      }
      #zhipin-auto-greeting-root .za-footer button.za-primary {
        box-shadow: 0 1px 2px rgba(180, 83, 9, 0.25);
      }
      #zhipin-auto-greeting-root .za-footer button.za-danger {
        background: var(--za-bg);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-footer button.za-danger:hover:not(:disabled) {
        background: var(--za-danger-soft);
        border-color: #fca5a5;
      }

      /* 调整大小手柄 */
      #zhipin-auto-greeting-root .za-resize-handle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        background: linear-gradient(135deg, transparent 0%, transparent 50%, var(--za-border) 50%, var(--za-border) 60%, transparent 60%, transparent 70%, var(--za-border) 70%, var(--za-border) 80%, transparent 80%);
        z-index: 10;
      }
      #zhipin-auto-greeting-root .za-resize-handle:hover {
        background: linear-gradient(135deg, transparent 0%, transparent 50%, var(--za-primary) 50%, var(--za-primary) 60%, transparent 60%, transparent 70%, var(--za-primary) 70%, var(--za-primary) 80%, transparent 80%);
      }

      /* 评分结果 */
      #zhipin-auto-greeting-root .za-score-result {
        margin-top: 8px;
      }

      /* 选项 chips */
      #zhipin-auto-greeting-root .za-option-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-selected-area {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }

      /* ---------- 日志页（面板内） ---------- */
      #zhipin-auto-greeting-root .za-log-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px;
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        background: var(--za-bg);
        margin-bottom: 10px;
        box-shadow: var(--za-shadow-sm);
      }
      #zhipin-auto-greeting-root .za-log-summary-main {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-summary-text {
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #98a2b3;
        box-shadow: 0 0 0 3px rgba(152, 162, 179, 0.18);
        transition: background 150ms ease, box-shadow 150ms ease;
      }
      #zhipin-auto-greeting-root .za-log-dot[data-on="1"] {
        background: #12b76a;
        box-shadow: 0 0 0 3px rgba(18, 183, 106, 0.18);
      }
      #zhipin-auto-greeting-root .za-log-state {
        font-size: 12px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-log-meta {
        margin-top: 1px;
        font-size: 11px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-switch {
        display: flex !important;
        align-items: center;
        gap: 6px;
        margin: 0;
        cursor: pointer;
        user-select: none;
        flex: 0 0 auto;
      }
      #zhipin-auto-greeting-root .za-switch input {
        position: absolute;
        width: 1px;
        height: 1px;
        min-height: 0;
        margin: 0;
        padding: 0;
        border: 0;
        opacity: 0;
        pointer-events: none;
      }
      #zhipin-auto-greeting-root .za-switch-track {
        position: relative;
        flex: 0 0 auto;
        width: 34px;
        height: 20px;
        border-radius: 999px;
        background: #d7dde7;
        transition: background 150ms ease;
      }
      #zhipin-auto-greeting-root .za-switch-track::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
        transition: transform 150ms ease;
      }
      #zhipin-auto-greeting-root .za-switch input:checked + .za-switch-track {
        background: var(--za-primary);
      }
      #zhipin-auto-greeting-root .za-switch input:checked + .za-switch-track::after {
        transform: translateX(14px);
      }
      #zhipin-auto-greeting-root .za-switch input:focus-visible + .za-switch-track {
        outline: 2px solid rgba(217, 119, 6, 0.45);
        outline-offset: 2px;
      }
      #zhipin-auto-greeting-root .za-switch-label {
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-log-actions {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }
      #zhipin-auto-greeting-root .za-log-actions button {
        flex: 1 1 0;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-feedback {
        margin: 0 0 8px;
        padding: 6px 10px;
        border: 1px solid var(--za-primary-border);
        border-radius: 6px;
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        font-size: 11px;
        line-height: 1.5;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="ok"] {
        background: var(--za-success-soft);
        border-color: #6ee7a8;
        color: var(--za-success);
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="warn"] {
        background: var(--za-warn-soft);
        border-color: var(--za-primary-border);
        color: var(--za-warn);
      }
      #zhipin-auto-greeting-root .za-log-feedback[data-type="error"] {
        background: var(--za-danger-soft);
        border-color: #fecaca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-log-preview {
        border: 1px solid var(--za-border);
        border-radius: var(--za-radius);
        overflow: hidden;
        margin-bottom: 8px;
        background: #fff;
      }
      #zhipin-auto-greeting-root .za-log-preview-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 12px;
        background: var(--za-bg-deep);
        border-bottom: 1px solid var(--za-border);
        font-size: 11px;
        font-weight: 600;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-log-preview-count {
        min-width: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--za-border-strong);
        color: var(--za-muted);
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-log-preview-tools {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-log-format {
        min-height: 20px;
        height: 20px;
        padding: 0 8px;
        border: 1px solid var(--za-border-strong);
        border-radius: 999px;
        background: var(--za-bg);
        color: var(--za-muted);
        font-size: 10px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition: background 150ms ease, border-color 150ms ease;
      }
      #zhipin-auto-greeting-root .za-log-format:hover {
        background: var(--za-bg-soft);
        border-color: var(--za-border-strong);
      }
      #zhipin-auto-greeting-root .za-log-preview-body {
        max-height: 260px;
        overflow-y: auto;
        padding: 8px 10px;
        background: #0c1222;
        color: #94a3b8;
        font: 11px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.12) transparent;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar {
        width: 4px;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar-track {
        background: transparent;
      }
      #zhipin-auto-greeting-root .za-log-preview-body::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.12);
        border-radius: 999px;
      }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-line {
        padding: 1px 0;
        word-break: break-all;
        white-space: pre-wrap;
      }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-success { color: #4ade80; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-skip { color: #facc15; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-error { color: #f87171; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-warn { color: #fb923c; }
      #zhipin-auto-greeting-root .za-log-preview-body .za-log-info { color: #7dd3fc; }
      #zhipin-auto-greeting-root .za-log-empty {
        padding: 14px 4px;
        color: #475569;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 11px;
      }

      /* ---------- 确认弹窗 ----------
         弹窗挂在 document.body 上（不在 #zhipin-auto-greeting-root 内），
         因此这里必须使用全局选择器，不能加面板根节点前缀。 */
      .za-confirm-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483600;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.55);
        -webkit-backdrop-filter: blur(2px);
        backdrop-filter: blur(2px);
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2937;
        text-align: left;
        animation: za-confirm-fadein 0.18s ease-out;
      }
      .za-confirm-backdrop *,
      .za-confirm-backdrop *::before,
      .za-confirm-backdrop *::after {
        box-sizing: border-box;
      }
      .za-confirm-backdrop.za-confirm-fadeout {
        animation: za-confirm-fadeout 0.16s ease-in forwards;
      }
      @keyframes za-confirm-fadein {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes za-confirm-fadeout {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      @keyframes za-confirm-slidein {
        from { opacity: 0; transform: translateY(10px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .za-confirm-dialog {
        width: min(420px, 100%);
        max-height: calc(100vh - 48px);
        overflow-y: auto;
        margin: 0;
        padding: 28px 28px 22px;
        border: none;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15, 23, 42, 0.06);
        text-align: center;
        animation: za-confirm-slidein 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .za-confirm-icon-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        margin: 0 auto 16px;
        border-radius: 50%;
        background: #fef2f2;
        color: #dc2626;
        box-shadow: inset 0 0 0 1px rgba(220, 38, 38, 0.12);
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-icon-wrap {
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
        box-shadow: inset 0 0 0 1px rgba(217, 119, 6, 0.14);
      }
      .za-confirm-icon {
        width: 26px;
        height: 26px;
        flex: 0 0 auto;
      }
      .za-confirm-backdrop .za-confirm-title {
        margin: 0 0 8px;
        padding: 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.4;
        color: #111827;
        letter-spacing: 0.01em;
      }
      .za-confirm-backdrop .za-confirm-message {
        margin: 0;
        padding: 0;
        font-size: 13.5px;
        line-height: 1.65;
        color: #4b5563;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .za-confirm-backdrop .za-confirm-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        width: 100%;
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid #eef0f4;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel,
      .za-confirm-backdrop .za-confirm-btn-danger {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        min-width: 0;
        height: 40px;
        margin: 0;
        padding: 0 16px;
        border-radius: 8px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel {
        border: 1px solid #d7dde7;
        background: #fff;
        color: #374151;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:hover {
        background: #f5f7fa;
        border-color: #bfc8d6;
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:active {
        background: #eef1f6;
      }
      .za-confirm-backdrop .za-confirm-btn-danger {
        border: 1px solid #dc2626;
        background: #dc2626;
        color: #fff;
      }
      .za-confirm-backdrop .za-confirm-btn-danger:hover {
        background: #b91c1c;
        border-color: #b91c1c;
      }
      .za-confirm-backdrop .za-confirm-btn-danger:active {
        transform: translateY(1px);
        background: #991b1b;
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-btn-danger {
        border-color: var(--za-primary);
        background: var(--za-primary);
      }
      .za-confirm-backdrop[data-tone="normal"] .za-confirm-btn-danger:hover {
        border-color: var(--za-primary-deep);
        background: var(--za-primary-deep);
      }
      .za-confirm-backdrop .za-confirm-btn-cancel:focus-visible,
      .za-confirm-backdrop .za-confirm-btn-danger:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.35);
      }
      @media (max-width: 480px) {
        .za-confirm-backdrop {
          padding: 16px;
        }
        .za-confirm-dialog {
          padding: 22px 18px 18px;
          border-radius: 14px;
        }
        .za-confirm-backdrop .za-confirm-actions {
          grid-template-columns: 1fr;
          gap: 8px;
        }
      }

      /* 数据页：统计卡与 7 日趋势 */
      #zhipin-auto-greeting-root .za-stat-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-stat-card {
        padding: 9px 11px;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-stat-label {
        display: block;
        font-size: 10.5px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-stat-value {
        display: block;
        margin-top: 2px;
        font-size: 20px;
        font-weight: 700;
        line-height: 1.15;
        color: var(--za-text);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-stat-value.za-stat-accent {
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-trend {
        display: flex;
        align-items: flex-end;
        gap: 5px;
        height: 64px;
        margin: 10px 0 2px;
        padding: 0 2px;
      }
      #zhipin-auto-greeting-root .za-trend-item {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      #zhipin-auto-greeting-root .za-trend-count {
        font-size: 9.5px;
        font-weight: 600;
        line-height: 1;
        color: var(--za-muted);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-trend-bar-wrap {
        width: 100%;
        height: 44px;
        display: flex;
        align-items: flex-end;
      }
      #zhipin-auto-greeting-root .za-trend-bar {
        width: 100%;
        min-height: 3px;
        border-radius: 4px 4px 2px 2px;
        background: linear-gradient(180deg, #f59e0b, #d97706);
      }
      #zhipin-auto-greeting-root .za-trend-bar[data-zero="1"] {
        background: var(--za-bg-deep);
      }
      #zhipin-auto-greeting-root .za-trend-day {
        font-size: 9px;
        line-height: 1;
        color: var(--za-muted);
        white-space: nowrap;
      }

      /* 数据页：最近记录 */
      #zhipin-auto-greeting-root .za-data-filters {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-data-filters input[type="search"] {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-data-filters select {
        flex: 0 0 104px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-record-list {
        max-height: 252px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg);
      }
      #zhipin-auto-greeting-root .za-record-row {
        padding: 8px 10px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-record-row:last-child {
        border-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-record-main {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-record-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-record-chip {
        flex: 0 0 auto;
        padding: 0 6px;
        border: 1px solid var(--za-border);
        border-radius: 999px;
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 9.5px;
        line-height: 1.7;
      }
      #zhipin-auto-greeting-root .za-record-chip-sent {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-record-chip-click {
        border-color: #a7f3d0;
        background: var(--za-success-soft);
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-record-chip-skip {
        border-color: var(--za-border);
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-record-meta {
        display: flex;
        gap: 8px;
        margin-top: 3px;
        font-size: 10px;
        color: var(--za-muted);
        white-space: nowrap;
        overflow: hidden;
      }
      #zhipin-auto-greeting-root .za-record-meta span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-record-empty {
        padding: 20px 10px;
        text-align: center;
        font-size: 11px;
        color: var(--za-muted);
      }

      /* 日志页：本次运行摘要 */
      #zhipin-auto-greeting-root .za-run-summary {
        padding: 10px 11px;
        border: 1px solid var(--za-border);
        border-radius: 9px;
        background: var(--za-bg-soft);
      }
      #zhipin-auto-greeting-root .za-run-summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-run-summary-title {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-run-summary-state {
        flex: 0 0 auto;
        padding: 1px 7px;
        border: 1px solid transparent;
        border-radius: 999px;
        background: var(--za-bg-deep);
        color: var(--za-muted);
        font-size: 9.5px;
        line-height: 1.7;
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="running"] {
        border-color: var(--za-primary-border);
        background: var(--za-primary-soft);
        color: var(--za-primary-deep);
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="done"] {
        border-color: #a7f3d0;
        background: var(--za-success-soft);
        color: #047857;
      }
      #zhipin-auto-greeting-root .za-run-summary-state[data-state="stopped"] {
        border-color: #fecaca;
        background: var(--za-danger-soft);
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-run-summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 9px;
      }
      #zhipin-auto-greeting-root .za-run-summary-grid > div {
        padding: 6px 4px;
        border: 1px solid var(--za-border);
        border-radius: 7px;
        background: var(--za-bg);
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-run-summary-grid span {
        display: block;
        font-size: 9.5px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-run-summary-grid strong {
        display: block;
        margin-top: 2px;
        font-size: 15px;
        font-weight: 700;
        line-height: 1.2;
        color: var(--za-text);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-run-summary-reason {
        margin: 8px 0 0;
        font-size: 10px;
        line-height: 1.5;
        color: var(--za-muted);
      }

      /* 日志页：筛选条 */
      #zhipin-auto-greeting-root .za-log-filters {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-log-filters select {
        flex: 0 0 92px;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-filters input[type="search"] {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-log-autoscroll {
        display: inline-flex !important;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
        margin: 0;
        font-size: 10px;
        color: var(--za-muted);
        white-space: nowrap;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-log-autoscroll input {
        width: 12px;
        height: 12px;
        margin: 0;
      }

    `;
    document.documentElement.appendChild(style);
  }

  // 注入侧栏样式；全部限定在 #zhipin-auto-greeting-root 下，避免影响 BOSS 页面。
  function injectStyle() {
    if (document.getElementById('zhipin-auto-greeting-style')) return;

    const style = document.createElement('style');
    style.id = 'zhipin-auto-greeting-style';
    style.textContent = `
      #zhipin-auto-greeting-root {
        --za-width: 430px;
        --za-bg: #ffffff;
        --za-border: #d7dde7;
        --za-text: #1f2937;
        --za-muted: #667085;
        --za-primary: #00a6a7;
        --za-danger: #d92d20;
        color: var(--za-text);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        position: fixed;
        z-index: 2147483000;
        inset: 0 0 auto auto;
      }
      #zhipin-auto-greeting-root * {
        box-sizing: border-box;
      }
      #zhipin-auto-greeting-root [hidden] {
        display: none !important;
      }
      #zhipin-auto-greeting-root .za-toggle {
        position: fixed;
        right: 0;
        top: 45%;
        width: 42px;
        min-height: 88px;
        border: 1px solid var(--za-border);
        border-right: 0;
        border-radius: 8px 0 0 8px;
        background: var(--za-primary);
        color: #fff;
        cursor: pointer;
        writing-mode: vertical-rl;
        letter-spacing: 0;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
      }
      #zhipin-auto-greeting-root .za-panel {
        position: fixed;
        right: 0;
        top: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        background: var(--za-bg);
        border-left: 1px solid var(--za-border);
        box-shadow: -12px 0 28px rgba(15, 23, 42, 0.16);
        transform: translateX(100%);
        transition: transform 180ms ease;
        display: flex;
        flex-direction: column;
      }
      #zhipin-auto-greeting-root.za-open .za-panel {
        transform: translateX(0);
      }
      #zhipin-auto-greeting-root.za-open .za-toggle {
        display: none;
      }
      #zhipin-auto-greeting-root .za-header,
      #zhipin-auto-greeting-root .za-footer {
        flex: 0 0 auto;
        padding: 12px 14px;
        border-bottom: 1px solid var(--za-border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      #zhipin-auto-greeting-root .za-header {
        position: sticky;
        top: 0;
        z-index: 3;
        background: var(--za-bg);
        box-shadow: 0 1px 0 rgba(215, 221, 231, 0.85);
        cursor: move;
        user-select: none;
      }
      #zhipin-auto-greeting-root .za-header-title {
        flex: 1 1 auto;
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-header-title strong,
      #zhipin-auto-greeting-root .za-header-title span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-header-actions {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-tool-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #f7f8fa;
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-tool-btn {
        width: 22px !important;
        height: 22px !important;
        font-size: 14px !important;
        line-height: 1 !important;
        padding: 0 !important;
        border-radius: 4px !important;
      }
      #zhipin-auto-greeting-root .za-opacity-indicator {
        min-width: 34px;
        text-align: center;
        color: var(--za-muted);
        font-variant-numeric: tabular-nums;
      }
      #zhipin-auto-greeting-root .za-tabs {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
        padding: 10px 14px 0;
        border-bottom: 1px solid var(--za-border);
        background: var(--za-bg);
        z-index: 2;
      }
      #zhipin-auto-greeting-root .za-tab {
        flex: 1 1 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 10px;
        background: transparent;
        border: 1px solid transparent;
        border-bottom-width: 2px;
        border-bottom-color: transparent;
        border-radius: 6px 6px 0 0;
        color: var(--za-muted);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 120ms ease;
      }
      #zhipin-auto-greeting-root .za-tab:hover {
        background: #f5f7fa;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-tab-active {
        color: var(--za-primary);
        border-bottom-color: var(--za-primary);
        background: #ecfeff;
      }
      #zhipin-auto-greeting-root .za-tab-icon {
        font-size: 15px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-tab-content {
        display: none;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
      }
      #zhipin-auto-greeting-root .za-tab-content-active {
        display: block;
        display: flex;
        flex-direction: column;
      }
      #zhipin-auto-greeting-root .za-footer {
        border-top: 1px solid var(--za-border);
        border-bottom: 0;
      }
      #zhipin-auto-greeting-root .za-subtitle {
        display: block;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 86px;
        padding: 0 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel {
        position: fixed;
        top: 58px;
        right: 14px;
        z-index: 4;
        width: calc(var(--za-width) - 28px);
        max-width: calc(100vw - 52px);
        padding: 10px;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
      }
      #zhipin-auto-greeting-root .za-feature-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-panel-close {
        width: 26px;
        min-height: 26px;
        padding: 0;
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 18px;
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-feature-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-feature-switch {
        width: 100%;
        min-width: 0;
        height: auto;
        min-height: 38px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-feature-switch > span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled {
        border-color: #b7e4e5;
        background: #ecfeff;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-readonly {
        border-style: dashed;
      }
      #zhipin-auto-greeting-root .za-feature-state {
        flex: 0 0 auto;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-feature-switch.za-enabled .za-feature-state {
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-status {
        flex: 0 0 auto;
        position: sticky;
        top: 73px;
        z-index: 2;
        margin: 12px 14px 0;
        padding: 9px 10px;
        border: 1px solid #d7dde7;
        border-radius: 6px;
        background: #eef2f6;
        box-shadow: 0 0 0 14px var(--za-bg), 0 10px 18px rgba(15, 23, 42, 0.08);
        color: #344054;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-status[data-type="ok"] {
        background: #ecfdf3;
        border-color: #abefc6;
        color: #027a48;
      }
      #zhipin-auto-greeting-root .za-status[data-type="warn"] {
        background: #fffaeb;
        border-color: #fedf89;
        color: #b54708;
      }
      #zhipin-auto-greeting-root .za-status[data-type="error"] {
        background: #fef3f2;
        border-color: #fecdca;
        color: #b42318;
      }
      #zhipin-auto-greeting-root .za-section {
        padding: 12px 14px 0;
      }
      #zhipin-auto-greeting-root .za-status + .za-section {
        padding-top: 20px;
      }
      #zhipin-auto-greeting-root .za-panel {
        overflow-y: auto;
      }
      #zhipin-auto-greeting-root h3 {
        margin: 0 0 8px;
        font-size: 13px;
        font-weight: 700;
      }
      #zhipin-auto-greeting-root label {
        display: block;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root input,
      #zhipin-auto-greeting-root select,
      #zhipin-auto-greeting-root textarea {
        width: 100%;
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 6px 8px;
        background: #fff;
        color: var(--za-text);
        font: inherit;
      }
      #zhipin-auto-greeting-root textarea {
        resize: vertical;
        min-height: 76px;
      }
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus,
      #zhipin-auto-greeting-root select[data-field="companyFilterMode"]:focus-visible,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus,
      #zhipin-auto-greeting-root select[data-field="exportType"]:focus-visible {
        outline: none;
        box-shadow: none;
        border-color: var(--za-border);
      }
      #zhipin-auto-greeting-root button {
        min-height: 32px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 0 10px;
        background: #fff;
        color: var(--za-text);
        cursor: pointer;
        font: inherit;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #zhipin-auto-greeting-root input:disabled,
      #zhipin-auto-greeting-root select:disabled,
      #zhipin-auto-greeting-root textarea:disabled {
        cursor: not-allowed;
        opacity: 0.72;
        background: #f3f4f6;
      }
      #zhipin-auto-greeting-root .za-primary {
        background: var(--za-primary);
        border-color: var(--za-primary);
        color: #fff;
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-danger {
        background: #fff;
        border-color: #fecdca;
        color: var(--za-danger);
        flex: 1;
      }
      #zhipin-auto-greeting-root .za-default {
        background: #fff;
        border-color: #d0d5dd;
        color: #475467;
        flex: 0 0 auto;
        padding: 6px 10px;
      }
      #zhipin-auto-greeting-root .za-danger-soft {
        border-color: #fecdca;
        color: var(--za-danger);
      }
      #zhipin-auto-greeting-root .za-cleanup-time {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-radio-row,
      #zhipin-auto-greeting-root .za-inline {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-segment {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 10px;
        padding: 3px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-segment label {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-segment label:has(input:checked) {
        background: #fff;
        border: 1px solid #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-source-block {
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel {
        display: grid;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-api-panel label {
        margin: 0;
      }
      #zhipin-auto-greeting-root .za-api-panel textarea {
        min-height: 68px;
      }
      #zhipin-auto-greeting-root .za-api-endpoint {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 92px;
        gap: 8px;
        align-items: end;
      }
      #zhipin-auto-greeting-root .za-api-method {
        min-width: 0;
      }
      #zhipin-auto-greeting-root .za-fast-reply-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger {
        width: 100%;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-fast-reply-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-fast-reply-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root.za-fast-reply-open .za-fast-reply-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview {
        max-height: 118px;
        margin-bottom: 8px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 8px;
        background: #fbfcfd;
        color: #344054;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-preview[data-empty="true"] {
        color: var(--za-muted);
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-backdrop {
        position: fixed;
        z-index: 2147483002;
        top: 0;
        right: 0;
        width: var(--za-width);
        max-width: calc(100vw - 24px);
        height: 100vh;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 82px 14px 14px;
        background: rgba(15, 23, 42, 0.18);
      }
      #zhipin-auto-greeting-root .za-fast-reply-dialog {
        width: 100%;
        max-height: calc(100vh - 104px);
        min-height: 240px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--za-border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid var(--za-border);
      }
      #zhipin-auto-greeting-root .za-fast-reply-head strong,
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        display: block;
      }
      #zhipin-auto-greeting-root .za-fast-reply-head span {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-search {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #eef2f6;
      }
      #zhipin-auto-greeting-root .za-fast-reply-list {
        flex: 1 1 auto;
        min-height: 0;
        max-height: min(68vh, 520px);
        overflow-y: auto;
        padding: 6px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option {
        width: 100%;
        height: auto;
        min-height: 0;
        display: block;
        margin: 0 0 6px;
        padding: 8px 10px;
        border-color: transparent;
        background: #fff;
        text-align: left;
        white-space: normal;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option:hover {
        border-color: #e4e7ec;
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option.za-selected {
        border-color: #b7e4e5;
        background: #ecfeff;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-fast-reply-selected-mark {
        flex: 0 0 auto;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-fast-reply-option-text {
        display: block;
        color: var(--za-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #zhipin-auto-greeting-root .za-fast-reply-empty {
        padding: 22px 10px;
        color: var(--za-muted);
        text-align: center;
      }
      #zhipin-auto-greeting-root .za-selected-area {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 34px;
        margin-bottom: 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 5px;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-multi-dropdown {
        position: relative;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root .za-multi-trigger {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
      }
      #zhipin-auto-greeting-root .za-multi-trigger span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #zhipin-auto-greeting-root .za-multi-arrow {
        flex: 0 0 auto;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-multi-dropdown.za-open .za-multi-arrow {
        transform: rotate(180deg);
      }
      #zhipin-auto-greeting-root .za-multi-menu {
        position: absolute;
        z-index: 2;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 4px;
        background: #fff;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      }
      #zhipin-auto-greeting-root .za-multi-option {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        margin: 0;
        border-radius: 4px;
        padding: 4px 6px;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-multi-option:hover {
        background: #f8fafc;
      }
      #zhipin-auto-greeting-root .za-multi-option span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-blacklist-option {
        justify-content: space-between;
        cursor: default;
      }
      #zhipin-auto-greeting-root .za-blacklist-option-label {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete {
        flex: 0 0 24px;
        width: 24px;
        min-height: 24px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-blacklist-delete:hover {
        color: #b91c1c;
        background: #fee2e2;
      }
      #zhipin-auto-greeting-root .za-boss-active-add {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-blacklist-actions {
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-option-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 24px;
        margin: 2px 0 4px;
      }
      #zhipin-auto-greeting-root .za-selected-chip,
      #zhipin-auto-greeting-root .za-option-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        min-height: 24px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        padding: 2px 3px 2px 8px;
        background: #f8fafc;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-selected-chip {
        background: #ecfeff;
        border-color: #b7e4e5;
        color: #007f80;
      }
      #zhipin-auto-greeting-root .za-selected-chip > span,
      #zhipin-auto-greeting-root .za-option-chip > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-selected-chip button,
      #zhipin-auto-greeting-root .za-option-chip button {
        width: 22px;
        min-height: 22px;
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--za-muted);
        line-height: 1;
      }
      #zhipin-auto-greeting-root .za-empty-text {
        color: var(--za-muted);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-radio-row label,
      #zhipin-auto-greeting-root .za-check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      #zhipin-auto-greeting-root input[type="checkbox"],
      #zhipin-auto-greeting-root input[type="radio"] {
        width: 16px;
        min-height: 16px;
      }
      #zhipin-auto-greeting-root .za-inline > * {
        flex: 1 1 auto;
      }
      #zhipin-auto-greeting-root .za-inline > button {
        flex: 0 0 auto;
      }
      #zhipin-auto-greeting-root .za-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #zhipin-auto-greeting-root .za-label,
      #zhipin-auto-greeting-root .za-hint {
        color: var(--za-muted);
        font-size: 12px;
        margin: 6px 0;
      }
      #zhipin-auto-greeting-root .za-muted-text {
        color: var(--za-muted);
        font-size: 12px;
        line-height: 30px;
      }
      #zhipin-auto-greeting-root .za-list-section {
        padding-bottom: 24px;
      }
      #zhipin-auto-greeting-root .za-list-viewport {
        position: relative;
        height: 260px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        overflow-y: auto;
        background: #fbfcfd;
      }
      #zhipin-auto-greeting-root .za-list-spacer {
        width: 1px;
      }
      #zhipin-auto-greeting-root .za-list-items {
        position: absolute;
        inset: 0 0 auto 0;
      }
      #zhipin-auto-greeting-root .za-list-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 48px;
        padding: 6px 10px;
        border-bottom: 1px solid #eef2f6;
        overflow: hidden;
        cursor: default;
        transition: background 0.15s;
      }
      #zhipin-auto-greeting-root .za-list-row:hover {
        background: #f0f5ff;
      }
      #zhipin-auto-greeting-root .za-list-row-main {
        display: flex;
        align-items: baseline;
        gap: 6px;
        line-height: 1.4;
      }
      #zhipin-auto-greeting-root .za-list-row-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 500;
        color: #1a1a1a;
      }
      #zhipin-auto-greeting-root .za-list-row-salary {
        flex: 0 0 auto;
        font-size: 12px;
        color: #ff6633;
        font-weight: 500;
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-row-sub {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        line-height: 1.4;
        margin-top: 2px;
      }
      #zhipin-auto-greeting-root .za-list-row-company {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--za-muted);
      }
      #zhipin-auto-greeting-root .za-list-row-meta {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--za-muted);
        white-space: nowrap;
      }
      #zhipin-auto-greeting-root .za-list-status {
        display: inline-block;
        padding: 0 4px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 16px;
        font-weight: 500;
      }
      #zhipin-auto-greeting-root .za-list-status-sent {
        background: #e6f7e6;
        color: #389e0d;
      }
      #zhipin-auto-greeting-root .za-list-status-skipped {
        background: #fff7e6;
        color: #d48806;
      }
      #zhipin-auto-greeting-root .za-list-row-time {
        color: #bfbfbf;
      }
      /* 确认弹窗样式统一在 injectNewStyle 中定义（弹窗挂在 body 上，需全局选择器）。 */
      /* 评分筛选：BOSS 岗位卡片高亮与分数徽标（页面级，不带面板前缀） */
      .za-scored {
        position: relative;
      }
      .za-score-good {
        outline: 2px solid var(--za-success);
        outline-offset: -2px;
      }
      .za-score-mid {
        outline: 2px solid var(--za-warn);
        outline-offset: -2px;
      }
      .za-score-low {
        outline: 2px solid var(--za-danger);
        outline-offset: -2px;
      }
      .za-score-badge {
        position: absolute;
        top: 4px;
        right: 4px;
        z-index: 999;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        border-radius: 11px;
        background: linear-gradient(135deg, #059669, #047857);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 22px;
        text-align: center;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(5, 150, 105, 0.35);
      }
      .za-score-badge[data-grade="mid"] {
        background: linear-gradient(135deg, #d97706, #b45309);
        box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35);
      }
      .za-score-badge[data-grade="low"] {
        background: linear-gradient(135deg, #dc2626, #b91c1c);
        box-shadow: 0 2px 6px rgba(220, 38, 38, 0.35);
      }
      /* 评分筛选：面板内最近评分结果列表 */
      #zhipin-auto-greeting-root .za-score-result {
        max-height: 180px;
        overflow-y: auto;
        margin-top: 8px;
      }
      #zhipin-auto-greeting-root .za-score-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        border-bottom: 1px dashed var(--za-border);
        font-size: 12px;
      }
      #zhipin-auto-greeting-root .za-score-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-score-grade {
        flex: 0 0 auto;
        font-size: 11px;
        padding: 0 4px;
        border-radius: 3px;
      }
      #zhipin-auto-greeting-root .za-score-grade-good {
        color: #16a34a;
        background: #ecfdf5;
      }
      #zhipin-auto-greeting-root .za-score-grade-mid {
        color: #b45309;
        background: #fffbeb;
      }
      #zhipin-auto-greeting-root .za-score-grade-low {
        color: #b91c1c;
        background: #fef2f2;
      }
      #zhipin-auto-greeting-root .za-score-value {
        flex: 0 0 auto;
        color: var(--za-text);
      }
      #zhipin-auto-greeting-root .za-score-model {
        flex: 0 0 auto;
        color: var(--za-muted);
        font-size: 11px;
      }
      /* 日志行样式：日志页预览沿用同一份行结构 */
      .za-log-line {
        padding: 1px 0;
        word-break: break-all;
        white-space: pre-wrap;
        color: #9fb0c4;
      }
      .za-log-warn {
        color: #ffb84d;
      }
      .za-log-success { color: #8be28b; }
      .za-log-skip { color: #d6c27a; }
      .za-log-error { color: #ff8585; }
      #zhipin-auto-greeting-root .za-list-section h3 {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #zhipin-auto-greeting-root .za-list-count {
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid var(--za-border);
        background: var(--za-bg-soft);
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        line-height: 16px;
      }
      #zhipin-auto-greeting-root .za-list-refresh {
        margin-left: auto;
        padding: 2px 8px;
        border: 1px solid var(--za-border);
        border-radius: 6px;
        background: #fff;
        color: var(--za-muted);
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
      }
      #zhipin-auto-greeting-root .za-list-refresh:hover {
        color: var(--za-primary);
        border-color: var(--za-primary-border);
      }
      #zhipin-auto-greeting-root .za-list-empty { padding: 32px 8px; color: var(--za-muted); text-align: center; font-size: 12px; }
      #zhipin-auto-greeting-root .za-list-empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
      #zhipin-auto-greeting-root .za-list-empty-hint { font-size: 11px; color: #bfbfbf; margin-top: 4px; }
    `;

    document.documentElement.appendChild(style);
  }

  installAllowedPageRouteWatcher();

  // 所有模块都完成初始化后再挂载 UI，避免 document-start 下 body 已存在时触发 const TDZ。
  setTimeout(syncAllowedPageUi, 0);

  pageWindow.addEventListener('pageshow', () => {
    const wasMounted = Boolean(runtime.ui);
    const allowed = syncAllowedPageUi();
    // 恢复流程内部会按页面阶段等待对应 DOM，无需在 pageshow 后再盲等固定时间。
    if (wasMounted && allowed && isAllowedDisplayPage()) Automation.resumeIfNeeded('pageshow');
  });
})();