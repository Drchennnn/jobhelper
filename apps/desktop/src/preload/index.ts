import type { RendererToMainIpc } from '@jobhelper/contracts';

export type JobHelperPreloadApi = RendererToMainIpc;

export interface ElectronIpcRendererLike {
  invoke(channel: string, arg?: unknown): Promise<unknown>;
}

/**
 * Builds the strictly typed `window.jobHelper` bridge exposed via Electron contextBridge.
 * Exposes zero Node APIs and zero plaintext model credentials.
 */
export function createJobHelperPreloadApi(ipcRenderer: ElectronIpcRendererLike): JobHelperPreloadApi {
  return {
    'tasks:list': () => ipcRenderer.invoke('tasks:list') as ReturnType<RendererToMainIpc['tasks:list']>,
    'tasks:startApplication': (input) =>
      ipcRenderer.invoke('tasks:startApplication', input) as ReturnType<
        RendererToMainIpc['tasks:startApplication']
      >,
    'tasks:sendMessage': (input) =>
      ipcRenderer.invoke('tasks:sendMessage', input) as ReturnType<
        RendererToMainIpc['tasks:sendMessage']
      >,
    'tasks:takeover': (input) =>
      ipcRenderer.invoke('tasks:takeover', input) as ReturnType<RendererToMainIpc['tasks:takeover']>,
    'tasks:resumeCheck': (input) =>
      ipcRenderer.invoke('tasks:resumeCheck', input) as ReturnType<
        RendererToMainIpc['tasks:resumeCheck']
      >,
    'tasks:close': (input) =>
      ipcRenderer.invoke('tasks:close', input) as ReturnType<RendererToMainIpc['tasks:close']>,
    'tasks:answerQuestion': (input) =>
      ipcRenderer.invoke('tasks:answerQuestion', input) as ReturnType<
        RendererToMainIpc['tasks:answerQuestion']
      >,
    'tasks:resolveConfirmation': (input) =>
      ipcRenderer.invoke('tasks:resolveConfirmation', input) as ReturnType<
        RendererToMainIpc['tasks:resolveConfirmation']
      >,
    'tasks:events': (input) =>
      ipcRenderer.invoke('tasks:events', input) as ReturnType<RendererToMainIpc['tasks:events']>,
    'browser:syncSurface': (input) =>
      ipcRenderer.invoke('browser:syncSurface', input) as ReturnType<
        RendererToMainIpc['browser:syncSurface']
      >,
    'browser:navigate': (input) =>
      ipcRenderer.invoke('browser:navigate', input) as ReturnType<
        RendererToMainIpc['browser:navigate']
      >,
    'browser:detachWindow': (input) =>
      ipcRenderer.invoke('browser:detachWindow', input) as ReturnType<
        RendererToMainIpc['browser:detachWindow']
      >,
    'providers:probe': (input) =>
      ipcRenderer.invoke('providers:probe', input) as ReturnType<
        RendererToMainIpc['providers:probe']
      >,
  };
}
