import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { basename } from 'node:path';

/**
 * Host half of the desktop notification bundle.
 *
 * The renderer cannot reveal a window that the shell hid into the tray: `window.focus()`
 * has no effect on a hidden or minimized BrowserWindow. The shell does reveal it on a
 * second launch (`second-instance` → `window.show(); window.focus()`), so the renderer
 * asks this half to relaunch the application, and the already-running instance is brought
 * to the front while the new process exits on the single-instance lock.
 *
 * The two halves talk over a loopback-only HTTP endpoint because the browser module has no
 * other channel that can reach a process-spawning capability.
 */

/** Loopback port the browser half posts to when a notification is clicked. */
const PORT = 47913;

/** Whether the current process is the packaged Electron shell rather than a Node CLI run. */
function isDesktopRuntime() {
  return process.env.ELECTRON_RUN_AS_NODE === '1' && /harness/i.test(basename(process.execPath));
}

/** Launch one more instance of the shell so the running one shows and focuses its window. */
function revealWindow() {
  if (!isDesktopRuntime()) return false;
  try {
    const env = { ...process.env };
    /** Without this the child would run as a plain Node process instead of the shell. */
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [], { detached: true, stdio: 'ignore', env });
    child.unref();
    return true;
  } catch (error) {
    console.warn('desktop-notify: could not relaunch the shell', error);
    return false;
  }
}

/**
 * Serve the one loopback command the browser half needs.
 * @param ctx - Host root context owning the listener lifetime.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const server = createServer((request, response) => {
      /** The page lives on `dsh-app://app`, so answer the cross-origin preflight politely. */
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && (request.url ?? '').split('?')[0] === '/reveal') {
        revealWindow();
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on('error', (error) => {
      console.warn('desktop-notify: reveal endpoint unavailable', error);
    });
    server.listen(PORT, '127.0.0.1');
    return () => {
      server.close();
    };
  }, 'desktop-notify: reveal endpoint');
}
