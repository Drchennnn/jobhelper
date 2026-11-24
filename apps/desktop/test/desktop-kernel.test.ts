import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MainToWorkerMessage, ProfileContent, WorkerToMainMessage } from '@jobhelper/contracts';
import type { ManagedWebContentsView, WebContentsViewFactory } from '@jobhelper/browser-bridge';
import { InMemoryCredentialStore } from '@jobhelper/model-router';
import {
  createDesktopMainKernel,
  registerDesktopIpcHandlers,
  type WorkerChildTransport,
} from '../src/main/index.js';
import { createJobHelperPreloadApi } from '../src/preload/index.js';
import { SharedAgentWorkerHost } from '../src/worker/index.js';

const TEST_PROFILE: ProfileContent = {
  basic: { fullName: '王测试', email: 'wang@example.com' },
  education: [],
  internships: [],
  projects: [],
  skills: ['TypeScript'],
};

function createStubViewFactory(): WebContentsViewFactory {
  let seq = 0;
  return {
    createView: ({ initialBounds }) => {
      const id = `view-${++seq}`;
      let url = '';
      let bounds = { ...initialBounds };
      let visible = false;
      let destroyed = false;
      const emitter = new EventEmitter();
      const dbgEmitter = new EventEmitter();
      const view: ManagedWebContentsView = {
        webContents: {
          isDestroyed: () => destroyed,
          getURL: () => url,
          getTitle: () => 'Mock ATS',
          getUserAgent: () => 'JobHelper/0.1',
          getZoomFactor: () => 1,
          loadURL: async (next) => {
            url = next;
            emitter.emit('did-navigate');
            emitter.emit('did-stop-loading');
          },
          executeJavaScript: async () => undefined as never,
          capturePagePngBase64: async () => ({ base64: 'iVBORw0KGgo=', width: 800, height: 600 }),
          debugger: {
            isAttached: () => true,
            attach: () => {},
            detach: () => {},
            sendCommand: async () => ({ targetInfo: { targetId: id } }),
            on: (e, fn) => {
              dbgEmitter.on(e, fn);
            },
            removeListener: (e, fn) => {
              dbgEmitter.removeListener(e, fn);
            },
          },
          on: (e, fn) => {
            emitter.on(e, fn);
          },
          removeListener: (e, fn) => {
            emitter.removeListener(e, fn);
          },
        },
        setBounds: (b) => {
          bounds = { ...b };
        },
        getBounds: () => ({ ...bounds }),
        setVisible: (v) => {
          visible = v;
        },
        getVisible: () => visible,
        destroy: () => {
          destroyed = true;
        },
      };
      return view;
    },
  };
}

describe('@jobhelper/desktop M2 Main Kernel, Preload Bridge & Worker Crash Recovery', () => {
  it('wires preload IPC -> Main Kernel -> Worker RPC, auto-stops on manual navigation, and recovers cleanly from worker crash & restart', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-desktop-'));
    const dbPath = path.join(tmpDir, 'desktop.db');
    const materialsDir = path.join(tmpDir, 'materials');

    let crashTrigger: ((code: number | null, signal: string | null) => void) | null = null;
    let workerHost!: SharedAgentWorkerHost;
    let issuedCdpEndpoint: string | null = null;

    const createTransport = (): WorkerChildTransport => {
      const toMainHandlers: Array<(m: WorkerToMainMessage) => void> = [];
      const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];

      workerHost = new SharedAgentWorkerHost({
        emit: (msg) => {
          for (const h of toMainHandlers) h(msg);
        },
        onRunStart: async ({ callMainRpc, signal }) => {
          const res = (await callMainRpc('cdp_connect')) as { wsEndpoint: string };
          issuedCdpEndpoint = res.wsEndpoint;
          // Hold run open until aborted (takeover/crash)
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { endReason: 'stopped_by_user' };
        },
      });

      crashTrigger = (code, signal) => {
        for (const h of exitHandlers) h(code, signal);
      };

      return {
        send: (msg: MainToWorkerMessage) => {
          void workerHost.handleMainMessage(msg);
        },
        onMessage: (h) => toMainHandlers.push(h),
        onExit: (h) => exitHandlers.push(h),
        kill: () => {},
      };
    };

    const kernel = createDesktopMainKernel({
      dbPath,
      materialsRootDir: materialsDir,
      credentials: new InMemoryCredentialStore(),
      viewFactory: createStubViewFactory(),
      spawnWorker: createTransport,
      stopAckTimeoutMs: 500,
    });

    // Wire in-memory Electron ipcMain <-> ipcRenderer bridge via Preload
    const handlers = new Map<string, (_e: unknown, arg: unknown) => Promise<unknown>>();
    registerDesktopIpcHandlers(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      kernel.ipcRouter,
    );
    const preloadApi = createJobHelperPreloadApi({
      invoke: async (ch, arg) => {
        const fn = handlers.get(ch);
        if (!fn) throw new Error(`Missing IPC handler: ${ch}`);
        return fn({}, arg);
      },
    });

    try {
      kernel.start();
      workerHost.signalReady();
      kernel.profiles.createProfile({ name: '默认简历', content: TEST_PROFILE });

      // 1. Start application via Preload IPC & dispatch run via scheduler
      const { taskId, reused } = await preloadApi['tasks:startApplication']({
        applyUrl: 'https://ats.example.com/job/99',
      });
      expect(reused).toBe(false);

      await kernel.scheduler.drain();
      await new Promise((r) => setTimeout(r, 20));
      expect(issuedCdpEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);
      expect(kernel.leases.has(taskId)).toBe(true);

      // 2. Manual browser:navigate stops active agent BEFORE loading new page
      const tabs = kernel.tabs.listTabs(taskId);
      await preloadApi['browser:navigate']({
        taskId,
        tabId: tabs[0]!.id,
        url: 'https://ats.example.com/login',
      });
      expect(kernel.leases.has(taskId)).toBe(false);
      expect(kernel.storage.tasks.getById(taskId)?.executionState).toBe('paused');

      // 3. Resume & simulate unexpected Worker crash -> revokes leases & marks task error (no replay)
      await preloadApi['tasks:resumeCheck']({ taskId });
      await kernel.scheduler.drain();
      await new Promise((r) => setTimeout(r, 20));
      expect(kernel.leases.has(taskId)).toBe(true);

      crashTrigger!(137, 'SIGKILL');
      expect(kernel.leases.has(taskId)).toBe(false);
      expect(kernel.storage.tasks.getById(taskId)?.executionState).toBe('error');

      // 4. Simulate full desktop app restart while another task is running -> recovers to interrupted
      const job2 = await preloadApi['tasks:startApplication']({
        applyUrl: 'https://ats.example.com/job/100',
      });
      kernel.taskService.transitionState({
        taskId: job2.taskId,
        next: { executionState: 'running' },
        reason: 'simulate_in_flight_before_kill',
        actor: 'system',
      });
      await kernel.shutdown();

      // Reopen kernel on same SQLite file
      const kernel2 = createDesktopMainKernel({
        dbPath,
        materialsRootDir: materialsDir,
        credentials: new InMemoryCredentialStore(),
        viewFactory: createStubViewFactory(),
        spawnWorker: createTransport,
      });
      try {
        const { recoveredTaskIds } = kernel2.start();
        expect(recoveredTaskIds).toContain(job2.taskId);
        expect(kernel2.storage.tasks.getById(job2.taskId)?.executionState).toBe('interrupted');
        expect(kernel2.storage.tasks.getById(job2.taskId)?.outcome).toBe('not_submitted');
      } finally {
        await kernel2.shutdown();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
