window.__ModuleLoader__.load({
  id: '@local/desktop-notify',
  factory(require) {
    /** Copy is chosen from the browser language, which avoids depending on the locale service. */
    const chinese = (() => {
      try {
        return String(navigator.language ?? '').toLowerCase().startsWith('zh');
      } catch (_error) {
        return false;
      }
    })();
    const text = chinese ? {
      doneTitle: '任务完成',
      doneBody: (session) => `「${session}」已完成`,
      approvalTitle: '需要审批',
      approvalBody: (tool) => `工具 ${tool} 请求执行，等待你的确认`,
      questionTitle: '需要你的回答',
      questionBody: '任务正在等待你补充信息',
      planTitle: '需要确认计划',
      planBody: '任务正在等待你确认执行计划',
      sessionFallback: '当前会话',
    } : {
      doneTitle: 'Task finished',
      doneBody: (session) => `“${session}” is done`,
      approvalTitle: 'Approval needed',
      approvalBody: (tool) => `${tool} requests permission to run`,
      questionTitle: 'Your answer is needed',
      questionBody: 'The task is waiting for your input',
      planTitle: 'Plan needs review',
      planBody: 'The task is waiting for you to approve its plan',
      sessionFallback: 'Current session',
    };

    /** Loopback endpoint of the Host half that relaunches the shell and reveals the window. */
    const REVEAL_URL = 'http://127.0.0.1:47913/reveal';
    /** Ask the Host half to bring the window back; the tray icon stays the last resort. */
    const revealWindow = () => {
      try {
        void fetch(REVEAL_URL, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
        return;
      } catch (_error) {
        // Fall through to the beacon form, which some documents allow where fetch is blocked.
      }
      try {
        navigator.sendBeacon?.(REVEAL_URL);
      } catch (_error) {
        // Nothing else can reveal a hidden window from inside the page.
      }
    };

    /** Human-readable tool label for approval copy. */
    const toolLabel = (tool) => (typeof tool === 'string' && tool !== '' ? tool : 'tool');
    /**
     * Notify only while the user cannot see the page: a hidden/minimized window reports
     * `hidden`, and a window that lost OS focus reports `hasFocus() === false`.
     */
    const inBackground = () => {
      try {
        return document.visibilityState !== 'visible' || document.hasFocus() === false;
      } catch (_error) {
        return true;
      }
    };

    return {
      inject: ['sessions', 'uiSession'],

      apply(ctx) {
        if (typeof Notification === 'undefined') return;
        /** Ask once; Electron's permission handler normally answers `granted` already. */
        if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});

        /** Live notifications per tag, so a repeat replaces the previous toast instead of stacking. */
        const live = new Map();
        const show = (tag, title, body, sessionId) => {
          if (Notification.permission !== 'granted') return;
          try {
            const previous = live.get(tag);
            if (previous !== undefined) {
              live.delete(tag);
              previous.close();
            }
            const notification = new Notification(title, { body, tag, silent: false });
            live.set(tag, notification);
            notification.onclose = () => {
              if (live.get(tag) === notification) live.delete(tag);
            };
            notification.onerror = () => {
              if (live.get(tag) === notification) live.delete(tag);
            };
            notification.onclick = () => {
              notification.close();
              revealWindow();
              try {
                window.focus();
              } catch (_error) {
                // A hidden window cannot focus itself; the Host half reveals it instead.
              }
              if (sessionId === undefined) return;
              try {
                ctx.get('uiWorkspace')?.openSession(sessionId);
              } catch (_error) {
                // Navigation is a convenience; the toast itself already delivered the message.
              }
            };
          } catch (error) {
            console.warn('desktop-notify: could not show a notification', error);
          }
        };

        /**
         * Support hook: proves this module loaded and posts one notification on demand,
         * without waiting for a task to finish or an approval to arrive.
         */
        window.__DSH_DESKTOP_NOTIFY__ = {
          loaded: true,
          supported: () => typeof Notification !== 'undefined',
          permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
          probe: (title, body) => {
            show('diagnostic', title ?? 'DeepSeek Harness', body ?? 'Notification channel test');
            return {
              permission: Notification.permission,
              visibility: document.visibilityState,
              focused: document.hasFocus(),
            };
          },
        };

        /** Session rows provide the display title and filter out subagents and empty sessions. */
        const rowOf = (sessionId) => {
          try {
            return ctx.sessions.list.getSnapshot().byId[sessionId];
          } catch (_error) {
            return undefined;
          }
        };
        const titleOf = (sessionId) => {
          const title = rowOf(sessionId)?.displayTitle;
          return typeof title === 'string' && title !== '' ? title : text.sessionFallback;
        };
        const eligible = (sessionId) => {
          const row = rowOf(sessionId);
          if (row === undefined) return false;
          if (row.blank === true) return false;
          if (row.origin === 'subagent') return false;
          return true;
        };

        /**
         * Announce one newly appeared pending interaction.
         * @param interaction - Pending approval, question, or plan review.
         * @param sessionId - Session that raised it.
         */
        const announce = (interaction, sessionId) => {
          const key = interaction?.key ?? sessionId ?? 'request';
          if (interaction?.kind === 'approval') {
            show(`approval:${key}`, text.approvalTitle, text.approvalBody(toolLabel(interaction.toolName)), sessionId);
            return;
          }
          if (interaction?.kind === 'plan-review') {
            show(`plan:${key}`, text.planTitle, text.planBody, sessionId);
            return;
          }
          show(`question:${key}`, text.questionTitle, text.questionBody, sessionId);
        };

        /**
         * Move focus into the approval card. Its Enter/Escape handling only runs while
         * the card contains the active element, and a card that just appeared usually
         * leaves focus on the document body. Focus is taken only when nothing else is
         * focused, so a draft being typed elsewhere is never interrupted.
         */
        const focusApprovalCard = () => {
          for (const delay of [0, 250, 700, 1500, 2600]) {
            setTimeout(() => {
              try {
                if (!document.hasFocus()) return;
                const active = document.activeElement;
                if (active !== null && active !== document.body && active !== document.documentElement) return;
                const card = document.querySelector('[data-approval-scroll]');
                if (card instanceof HTMLElement) card.focus({ preventScroll: true });
              } catch (_error) {
                // Focus is an assist; the card still works with a click.
              }
            }, delay);
          }
        };

        /**
         * Watch the aggregated Session status instead of the `approval/request` and
         * `user-questions/request` waterfalls: those are consumed by the plugins that
         * answer them and never call `next()`, so a later listener never runs.
         */
        ctx.effect(() => {
          const status = ctx.uiSession.sessionStatus;
          let previous = status.getSnapshot();
          const off = status.subscribe(() => {
            const next = status.getSnapshot();
            for (const [sessionId, current] of next) {
              if (current === undefined) continue;
              const before = previous.get(sessionId);
              if (current.pendingInteraction !== undefined
                && current.pendingInteraction !== before?.pendingInteraction) {
                if (current.pendingInteraction.kind === 'approval') focusApprovalCard();
                if (inBackground()) announce(current.pendingInteraction, sessionId);
              }
              if (before?.running === true && current.running === false && inBackground() && eligible(sessionId)) {
                show(`done:${sessionId}`, text.doneTitle, text.doneBody(titleOf(sessionId)), sessionId);
              }
            }
            previous = next;
          });
          return off;
        }, 'desktop-notify: session status');
      },
    };
  },
});
