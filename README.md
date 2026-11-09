# DSH Desktop Notifications

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面版加系统通知的插件：
任务跑完、需要审批、需要你补充信息时，在 Windows 通知中心弹出提醒；点通知能把隐藏到托盘的窗口唤回来。

> 一个 DSH 的 Cordis 插件（bundle），Host 侧 + 浏览器侧各一个模块，不改动 `app.asar`。

## 功能

| 触发 | 标题 | 内容 |
| --- | --- | --- |
| 会话的一轮任务结束 | 任务完成 | 「会话标题」已完成 |
| 工具请求审批 | 需要审批 | 工具 `<名称>` 请求执行，等待你的确认 |
| 任务请求补充信息 | 需要你的回答 | 任务正在等待你补充信息 |
| 等待确认执行计划 | 需要确认计划 | — |

- **只在你不在看的时候提醒**：窗口最小化到托盘、被遮挡或未聚焦才发通知；窗口在前台时不打扰。
- **点通知唤回窗口**：隐藏到托盘的窗口无法由页面自己唤出，插件通过 Host 侧重新拉起一次应用，
  利用桌面壳的单实例机制执行 `window.show(); window.focus()`，同时切到对应会话。
- **审批可用 Enter 通过**：卡片出现时若焦点不在任何输入框，插件会把焦点移进审批卡片，
  让 Enter（允许）/ Esc（拒绝）直接生效。
- 跳过子代理会话、空会话；同一事件只发一条，不堆叠。

## 安装

这个包是一个 DSH bundle（`package.json` 里的 `dsh.bundle` 与 `dsh.client`）。
把目录放到任意稳定位置，然后在 DSH 里用插件管理器安装：

```
plugin_manager install_bundle <本目录的绝对路径>
```

或直接写进 profile 的 `package.json`：

```json
{
  "dependencies": { "@local/desktop-notify": "link:/path/to/desktop-notify" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/desktop-notify"] } }
}
```

安装后重启一次 DSH 桌面端即可生效。卸载：`plugin_manager remove_bundle @local/desktop-notify`。

包名保留 `@local/` 前缀，方便作为本地链接包使用；发布到 npm 前请改成自己的 scope。

## 实现要点

包里有**两半**。

### 浏览器侧 `client.js`

订阅 `ctx.uiSession.sessionStatus`（`Map<sessionId, { running, pendingInteraction, completionUnread }>`）：

- **不走** `approval/request` / `user-questions/request` 瀑布事件：这两个事件由审批/提问插件消费，
  它们回答完不会调用 `next()`，后注册的监听永远不会执行；
- 文案按 `navigator.language` 选中/英，不依赖 `ctx.locale` 的绑定函数
  （在被 plain-JS 打包的插件里调用它曾静默失败）；
- 通过 `document.visibilityState` / `document.hasFocus()` 判断前台，前台时静默；
- 检测到待审批且焦点为空时，把焦点移入 `[data-approval-scroll]`，恢复 Enter/Esc 快捷键。

### Host 侧 `index.js`

- 隐藏到托盘的 `BrowserWindow` 无法由页面 `window.focus()` 唤出；
- 桌面壳是单实例的，第二次启动时第一个实例会执行 `window.show(); window.focus()`；
- 因此在 `127.0.0.1:47913` 监听 `/reveal`，浏览器侧点击通知时 POST 一下，
  Host 以去掉 `ELECTRON_RUN_AS_NODE` 的环境重新拉起应用，窗口即回到前台。

插件不注册任何 UI，也不写入会话日志。

## 已知限制

- Windows 的「专注助手 / 勿扰模式」以及 设置 → 系统 → 通知 里该应用的「显示通知横幅」被关闭时，
  通知只进通知中心、不弹横幅（用 `Win+N` 可以确认是否送达）。应用在系统里的名字是
  `electron.app.DeepSeek Harness`（Electron 未显式设置 AppUserModelID）。
- 子代理会话和空会话不会通知；应用完全退出后没有通知（插件跑在页面里）。
- `uiSession.sessionStatus`、`sessions.list` 是 DSH 内部接口，大版本升级时可能需要同步调整。
- 修改 `client.js` 后页面不会自动热更新：需要在插件列表里关闭再打开，或卸载重装 bundle，
  最稳妥的是重启应用。

## 调试

页面里暴露了一个支持用的钩子：

```js
__DSH_DESKTOP_NOTIFY__.probe('标题', '正文')   // 立刻弹一条测试通知
__DSH_DESKTOP_NOTIFY__.permission()            // 当前通知权限
```

## License

MIT
