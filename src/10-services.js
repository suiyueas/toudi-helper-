  const FastReplyService = {
    // 调用 BOSS 常用语接口并写入配置，UI 下拉框随之刷新。
    async refresh(showStatus) {
      // 平台护盾：常用语是 BOSS 专属接口，非 BOSS 平台不请求，避免智联等平台报 404。
      if (currentPlatform?.id !== 'boss') {
        if (showStatus) {
          UI.setStatus('当前平台无需拉取常用语，将使用自定义文本', 'info');
        }
        return;
      }

      if (showStatus) UI.setStatus('正在获取常用语...', 'info');

      try {
        const url = `${APP.fastReplyUrl}?_=${Date.now()}`;
        const response = await fetch(url, {
          credentials: 'include',
          headers: { accept: 'application/json, text/plain, */*' },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const replies = this.extractReplies(payload);
        if (!replies.length) throw new Error('接口中没有识别到常用语');

        saveConfig({
          fastReplies: replies,
          fastReplyIndex: Math.min(config.fastReplyIndex || 0, replies.length - 1),
        });
        UI.renderFastReplyOptions();
        UI.setStatus(`常用语获取成功：${replies.length} 条`, 'ok');
      } catch (error) {
        saveConfig({ fastReplies: [] });
        UI.renderFastReplyOptions();
        UI.setStatus(`获取常用语失败，将使用默认问候语文本：${error.message}`, 'warn');
      }
    },

    // 从不稳定的接口结构中递归提取文本，去重后作为可选常用语。
    extractReplies(payload) {
      const replies = [];
      const seen = new Set();
      const textKeys = ['content', 'text', 'replyContent', 'sentence', 'sentenceContent', 'message', 'word'];

      walkObject(payload, (value) => {
        if (typeof value === 'string') return;

        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              addReply(item);
              continue;
            }

            if (!item || typeof item !== 'object') continue;
            for (const key of textKeys) {
              if (typeof item[key] === 'string') {
                addReply(item[key], item.id || item.fastReplyId || item.replyId);
                break;
              }
            }
          }
        }
      });

      function addReply(text, id) {
        const normalized = normalizeText(text);
        if (!normalized || normalized.length > 500 || seen.has(normalized)) return;
        seen.add(normalized);
        replies.push({ id: id || hashString(normalized), text: normalized });
      }

      return replies.slice(0, 100);
    },
  };

  // 发送服务：常用语、自定义文本、自定义接口返回文本都会先解析为最终文案，
  // 再统一注入聊天输入框并触发发送，发送后会校验聊天记录中是否出现新消息。
  const GreetingService = {
    // 根据当前配置解析最终问候语，并走统一发送流程。
    async sendCurrent(job) {
      const resolved = config.greetingMode === 'fastReply'
        ? await this.resolveFastReplyText(job)
        : {
            messageType: 'customText',
            text: await this.resolveCustomText(job),
          };

      return this.sendText(resolved.text, job, resolved.messageType);
    },

    // 常用语模式：优先使用已缓存常用语，缺失时刷新接口，最后退回默认问候语。
    async resolveFastReplyText(job) {
      if (config.greetingMode === 'fastReply') {
        const selected = (config.fastReplies || [])[config.fastReplyIndex || 0];

        if (selected && selected.text) {
          return {
            messageType: 'fastReplyText',
            text: interpolateText(selected.text, job),
          };
        }

        // 只有 BOSS 平台才尝试刷新常用语接口，智联等平台直接跳过，避免发无效请求。
        if (currentPlatform?.id === 'boss') {
          try {
            await FastReplyService.refresh(false);
          } catch (_) {}
        }

        const refreshed = (config.fastReplies || [])[config.fastReplyIndex || 0] || (config.fastReplies || [])[0];
        return {
          messageType: 'fastReplyText',
          text: interpolateText((refreshed && refreshed.text) || config.customText || APP.defaultGreetingText, job),
        };
      }

      return {
        messageType: 'customText',
        text: await this.resolveCustomText(job),
      };
    },

    // 自定义模式：可以直接使用文本模板，也可以请求外部 API 生成文本。
    async resolveCustomText(job) {
      if (config.textSource !== 'api') {
        return interpolateText(config.customText, job);
      }

      if (!config.customApiUrl) throw new Error('自定义文本接口为空');

      const payload = {
        job: flattenJob(job),
        location: location.href,
        time: nowIso(),
      };
      const text = await requestExternalText(config.customApiUrl, config.customApiMethod, payload);
      return interpolateText(text, job);
    },

    // 等待聊天页可用、写入消息、触发发送，并确认聊天记录中出现新消息。
    async sendText(text, job, messageType) {
      const finalText = normalizeMessageText(text);
      if (!finalText) throw new Error('问候语文本为空');

      await waitForChatReady(job);
      const beforeSend = await sendChatTextByEnter(finalText);
      await waitForMessageSent(finalText, beforeSend);

      return {
        messageType: messageType || 'customText',
        messagePreview: finalText.slice(0, 120),
      };
    },
  };

  // 自动化状态机：list -> chat -> returning -> list。
  // list：遍历岗位卡片并点击沟通；chat：在聊天页发送问候；returning：发送后回到岗位列表。
  // BOSS 的沟通按钮会触发页面跳转，状态必须写入 localStorage，脚本重载后才能继续。
