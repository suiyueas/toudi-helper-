  function getAccessibleDocuments() {
    const docs = [document];
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const inner = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (inner && inner !== document && inner.body && typeof inner.querySelectorAll === 'function') {
          docs.push(inner);
        }
      } catch (_) {
        // 跨域 iframe 无法访问，跳过。
      }
    }
    return docs;
  }

  // 懒加载 SheetJS，并放到隔离 sandbox 中执行，避免污染 BOSS 页面全局变量。
  async function loadSheetJs() {
    if (runtime.xlsx) return runtime.xlsx;

    UI.setStatus('正在加载 Excel 导出模块...', 'info');
    const code = await fetchText(APP.sheetJsUrl).catch((error) => {
      console.warn('[ZhipinAuto] 页面 fetch 加载 SheetJS 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(APP.sheetJsUrl);
    });
    const sandbox = {};
    const loader = new Function('sandbox', `
      const window = sandbox;
      const self = sandbox;
      const global = sandbox;
      const globalThis = sandbox;
      ${code}
      return sandbox.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
    `);
    const XLSX = loader(sandbox);
    if (!XLSX || !XLSX.utils) throw new Error('SheetJS 加载失败');
    runtime.xlsx = XLSX;
    return XLSX;
  }

  // 普通跨域文本请求，主要用于拉取 SheetJS CDN 脚本。
  async function fetchText(url) {
    const response = await fetch(url, {
      cache: 'force-cache',
      credentials: 'omit',
      mode: 'cors',
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  // 抓取同源岗位/公司 HTML；页面 fetch 失败时用 GM_xmlhttpRequest 兜底。
  async function fetchJobHtml(url) {
    try {
      const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'include',
        mode: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      console.warn('[ZhipinAuto] 页面 fetch 加载岗位 HTML 失败，降级使用 GM_xmlhttpRequest', error);
      return gmGetText(url);
    }
  }

  // Tampermonkey 网络兜底，用于跨域 CDN 或同源 fetch 被页面策略影响时。
  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('网络请求失败'));
        },
        ontimeout() {
          reject(new Error('网络请求超时'));
        },
      });
    });
  }

  // 给侧栏配置留两个入口：严格 JSON 对象，或者更适合手填的每行 key=value。
  function parseKeyValueConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} 必须是 JSON 对象`);
      }
      return parsed;
    } catch (jsonError) {
      const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const output = {};

      for (const line of lines) {
        const match = line.match(/^([^:=\s][^:=]*)\s*[:=]\s*([\s\S]*)$/);
        if (!match) {
          throw new Error(`${label} 格式错误，请填写 JSON 对象或每行 key=value`);
        }
        output[match[1].trim()] = match[2].trim();
      }

      return output;
    }
  }

  // 校验 key=value/JSON 配置是否能解析，启动前用于提前提示用户。
  function isParsableKeyValueConfig(text) {
    try {
      parseKeyValueConfig(text, '配置');
      return true;
    } catch (_) {
      return false;
    }
  }

  // 判断自定义接口 responsePath 是否像合法路径，避免把大段配置误填到路径框。
  function isLikelyResponsePath(path) {
    const value = String(path || '').trim();
    if (!value) return true;
    if (value.length > 120 || /[\s=:：,，。！？!？]/.test(value)) return false;
    return /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\.\d+)|(?:\[\d+\]))*$/.test(value);
  }

  // 请求体配置支持 JSON 或 key=value，最终在发送前做岗位字段插值。
  function parseRequestBodyConfig(text, label) {
    const source = String(text || '').trim();
    if (!source) return {};

    try {
      return JSON.parse(source);
    } catch (_) {
      if (/^[^:=\s][^:=]*\s*[:=]/m.test(source)) {
        return parseKeyValueConfig(source, label);
      }
      return source;
    }
  }

  // 对对象/数组/字符串递归执行 {field} 模板替换，用于自定义接口参数和请求体。
  function interpolateStructuredValue(value, job) {
    if (typeof value === 'string') return interpolateText(value, job);
    if (Array.isArray(value)) return value.map((item) => interpolateStructuredValue(item, job));
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce((output, key) => {
        output[key] = interpolateStructuredValue(value[key], job);
        return output;
      }, {});
    }
    return value;
  }

  // GET/HEAD 自定义接口把配置参数拼到 URL 查询串中。
  function appendQueryParams(url, params) {
    const target = new URL(url, location.href);
    Object.keys(params || {}).forEach((key) => {
      const value = params[key];
      if (value == null || value === '') return;

      if (Array.isArray(value)) {
        value.forEach((item) => target.searchParams.append(key, String(item)));
      } else {
        target.searchParams.set(key, String(value));
      }
    });
    return target.href;
  }

  // 请求头配置归一化，过滤空 key，避免 fetch 抛无意义错误。
  function normalizeHeaderMap(headers) {
    return Object.keys(headers || {}).reduce((output, key) => {
      const value = headers[key];
      if (value != null && value !== '') output[key] = String(value);
      return output;
    }, {});
  }

  // 从自定义接口 JSON 中按 a.b.0.c 形式取值，用于 responsePath 配置。
  function getValueByPath(source, path) {
    const keys = String(path || '')
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((key) => key.trim())
      .filter(Boolean);

    return keys.reduce((target, key) => (target == null ? undefined : target[key]), source);
  }

  // 请求外部接口生成问候语。接口可用岗位数据、当前页面地址和时间做上下文。
  async function requestExternalText(url, method, payload) {
    const requestMethod = String(method || 'GET').toUpperCase();
    const headers = normalizeHeaderMap(interpolateStructuredValue(parseKeyValueConfig(config.customApiHeaders, '请求头'), payload.job || {}));
    const params = interpolateStructuredValue(parseKeyValueConfig(config.customApiParams, 'URL 参数'), payload.job || {});
    const requestUrl = appendQueryParams(interpolateText(url, payload.job || {}), params);
    const requestBody = buildCustomApiBody(requestMethod, payload, headers);

    const responseText = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: requestMethod,
        url: requestUrl,
        headers: Object.keys(headers).length ? headers : undefined,
        data: requestBody,
        timeout: 30000,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText || '');
          } else {
            reject(new Error(`接口返回 HTTP ${response.status}`));
          }
        },
        onerror() {
          reject(new Error('自定义文本接口请求失败'));
        },
        ontimeout() {
          reject(new Error('自定义文本接口超时'));
        },
      });
    });

    try {
      const json = JSON.parse(responseText);
      return extractMessageFromJson(json, config.customApiResponsePath);
    } catch (_) {
      return responseText;
    }
  }

  // 根据请求方法和 Content-Type 构造请求体；GET/HEAD 不带 body。
  function buildCustomApiBody(method, payload, headers) {
    if (method === 'GET' || method === 'HEAD') return undefined;

    const bodySource = String(config.customApiBody || '').trim();
    const hasContentType = Object.keys(headers || {}).some((key) => key.toLowerCase() === 'content-type');

    if (!bodySource) {
      if (!hasContentType) headers['Content-Type'] = 'application/json';
      return JSON.stringify(payload);
    }

    const parsed = parseRequestBodyConfig(bodySource, '请求体');
    const value = interpolateStructuredValue(parsed, payload.job || {});
    if (typeof value === 'string') return value;

    if (!hasContentType) headers['Content-Type'] = 'application/json';
    return JSON.stringify(value);
  }

  // 从外部接口响应中提取最终问候语文本，支持显式路径和常见字段名兜底。
  function extractMessageFromJson(json, responsePath) {
    if (responsePath) {
      const selected = getValueByPath(json, responsePath);
      if (selected == null || selected === '') {
        throw new Error(`接口返回中未找到路径：${responsePath}`);
      }
      return typeof selected === 'string' ? selected : JSON.stringify(selected);
    }

    const directPaths = [
      ['message'],
      ['text'],
      ['content'],
      ['data', 'message'],
      ['data', 'text'],
      ['data', 'content'],
      ['data', 'greeting'],
    ];

    for (const path of directPaths) {
      const value = path.reduce((target, key) => target && target[key], json);
      if (typeof value === 'string' && value.trim()) return value;
    }

    let first = '';
    walkObject(json, (value) => {
      if (!first && typeof value === 'string' && value.trim().length >= 2) {
        first = value;
      }
    });
    return first;
  }

  // 岗位列表页左侧卡片选择器，自动化遍历岗位从这里开始。
  // 使用平台适配器的选择器
