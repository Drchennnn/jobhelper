import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MainToWorkerMessage,
  ViewportRect,
  WorkerToMainMessage,
} from '@jobhelper/contracts';
import type {
  ManagedWebContentsView,
  WebContentsViewFactory,
} from '@jobhelper/browser-bridge';
import { SafeStorageCredentialStore } from '@jobhelper/model-router';
import {
  createDesktopMainKernel,
  registerDesktopIpcHandlers,
  runTaskTurnInKernel,
  type DesktopMainKernel,
  type WorkerChildTransport,
} from './index.js';
import { MAIN_EVENT_CHANNEL } from '../preload/index.js';
import { SharedAgentWorkerHost } from '../worker/index.js';

/**
 * Real Electron Main Process Entrypoint.
 * Launches BrowserWindow + WebContentsView recruitment panes + Windows DPAPI safeStorage + full kernel.
 */
async function bootstrapElectron(): Promise<void> {
  const electron = await import('electron');
  const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, session } = electron;

  await app.whenReady();

  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, 'jobhelper.db');
  const materialsRootDir = path.join(userDataDir, 'materials');
  const artifactsRootDir = path.join(userDataDir, 'artifacts');
  const credsPath = path.join(userDataDir, 'credentials.enc.json');
  const preloadPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'preload',
    'electron-preload.cjs',
  );

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: 'JobHelper — 本地 BYOK 网申助手',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const viewFactory: WebContentsViewFactory = {
    createView: ({ partition, initialBounds, onWindowOpen }) => {
      const view = new WebContentsView({
        webPreferences: {
          session: session.fromPartition(partition),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      mainWindow.contentView.addChildView(view);
      view.setBounds(initialBounds);
      view.setVisible(false);

      view.webContents.setWindowOpenHandler(({ url }) => {
        onWindowOpen?.(url);
        return { action: 'deny' };
      });

      const managed: ManagedWebContentsView = {
        webContents: {
          isDestroyed: () => view.webContents.isDestroyed(),
          getURL: () => view.webContents.getURL(),
          getTitle: () => view.webContents.getTitle(),
          getUserAgent: () => view.webContents.getUserAgent(),
          getZoomFactor: () => view.webContents.getZoomFactor(),
          loadURL: async (url) => {
            await view.webContents.loadURL(url);
          },
          executeJavaScript: <T = unknown>(code: string) =>
            view.webContents.executeJavaScript(code) as Promise<T>,
          capturePagePngBase64: async () => {
            const image = await view.webContents.capturePage();
            const size = image.getSize();
            const dpr = Number(await view.webContents.executeJavaScript('devicePixelRatio')) || 1;
            const normalized = image.resize({
              width: Math.max(1, Math.round(size.width / dpr)),
              height: Math.max(1, Math.round(size.height / dpr)),
            });
            const normSize = normalized.getSize();
            return {
              base64: normalized.toPNG().toString('base64'),
              width: normSize.width,
              height: normSize.height,
            };
          },
          debugger: {
            isAttached: () => view.webContents.debugger.isAttached(),
            attach: (v) => view.webContents.debugger.attach(v),
            detach: () => view.webContents.debugger.detach(),
            sendCommand: (m, p, s) =>
              view.webContents.debugger.sendCommand(m, p, s) as Promise<Record<string, unknown>>,
            on: (e, fn) => {
              view.webContents.debugger.on(e as never, fn as never);
            },
            removeListener: (e, fn) => {
              view.webContents.debugger.removeListener(e as never, fn as never);
            },
          },
          on: (e, fn) => {
            view.webContents.on(e as never, fn as never);
          },
          removeListener: (e, fn) => {
            view.webContents.removeListener(e as never, fn as never);
          },
        },
        setBounds: (bounds: ViewportRect) => view.setBounds(bounds),
        getBounds: () => view.getBounds(),
        setVisible: (visible: boolean) => view.setVisible(visible),
        getVisible: () => view.getVisible(),
        destroy: () => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.contentView.removeChildView(view);
          }
          if (!view.webContents.isDestroyed()) {
            view.webContents.close();
          }
        },
      };
      return managed;
    },
  };

  let kernel!: DesktopMainKernel;
  const spawnInProcessWorker = (): WorkerChildTransport => {
    const msgHandlers: Array<(m: WorkerToMainMessage) => void> = [];
    const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
    const host = new SharedAgentWorkerHost({
      emit: (msg) => {
        for (const h of msgHandlers) h(msg);
      },
      onRunStart: async ({ taskId, runId, epoch }) => runTaskTurnInKernel(kernel, taskId, runId, epoch),
    });
    setImmediate(() => host.signalReady());
    return {
      send: (msg: MainToWorkerMessage) => {
        void host.handleMainMessage(msg);
      },
      onMessage: (h) => msgHandlers.push(h),
      onExit: (h) => exitHandlers.push(h),
      kill: () => {},
    };
  };

  const devUrl = process.env.JOBHELPER_WORKBENCH_URL;
  kernel = createDesktopMainKernel({
    dbPath,
    materialsRootDir,
    artifactsRootDir,
    credentials: new SafeStorageCredentialStore(credsPath, safeStorage),
    viewFactory,
    spawnWorker: spawnInProcessWorker,
    workbenchOrigin: devUrl ? new URL(devUrl).origin : undefined,
    enableLocalMcpServer: true,
    onEmitRendererEvent: (event) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(MAIN_EVENT_CHANNEL, event);
      }
    },
  });

  registerDesktopIpcHandlers(ipcMain, kernel.ipcRouter);
  kernel.start();

  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    const distHtml = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'workbench',
      'dist',
      'index.html',
    );
    await mainWindow.loadFile(distHtml);
  }

  app.on('before-quit', () => {
    void kernel.shutdown();
  });
}

void bootstrapElectron();
