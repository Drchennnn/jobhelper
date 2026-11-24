import type { MainToRendererEvent, RendererToMainIpc } from '@jobhelper/contracts';

export interface JobHelperPreloadApi extends RendererToMainIpc {
  onMainEvent?: (listener: (event: MainToRendererEvent) => void) => () => void;
}

export interface ElectronIpcRendererLike {
  invoke(channel: string, arg?: unknown): Promise<unknown>;
  on?(channel: string, listener: (_event: unknown, payload: MainToRendererEvent) => void): void;
  removeListener?(
    channel: string,
    listener: (_event: unknown, payload: MainToRendererEvent) => void,
  ): void;
}

export const MAIN_EVENT_CHANNEL = 'jobhelper:event';

/**
 * Builds the strictly typed `window.jobHelper` bridge exposed via Electron contextBridge.
 * Exposes zero Node APIs and zero plaintext model credentials.
 */
export function createJobHelperPreloadApi(ipcRenderer: ElectronIpcRendererLike): JobHelperPreloadApi {
  const invoke = <K extends keyof RendererToMainIpc>(channel: K) => {
    return ((arg?: unknown) =>
      ipcRenderer.invoke(channel, arg)) as RendererToMainIpc[K];
  };

  return {
    'tasks:list': invoke('tasks:list'),
    'tasks:getCoordinator': invoke('tasks:getCoordinator'),
    'tasks:getProjection': invoke('tasks:getProjection'),
    'tasks:startApplication': invoke('tasks:startApplication'),
    'tasks:sendMessage': invoke('tasks:sendMessage'),
    'tasks:takeover': invoke('tasks:takeover'),
    'tasks:resumeCheck': invoke('tasks:resumeCheck'),
    'tasks:close': invoke('tasks:close'),
    'tasks:answerQuestion': invoke('tasks:answerQuestion'),
    'tasks:resolveConfirmation': invoke('tasks:resolveConfirmation'),
    'tasks:events': invoke('tasks:events'),
    'browser:syncSurface': invoke('browser:syncSurface'),
    'browser:navigate': invoke('browser:navigate'),
    'browser:detachWindow': invoke('browser:detachWindow'),
    'profiles:list': invoke('profiles:list'),
    'profiles:get': invoke('profiles:get'),
    'profiles:create': invoke('profiles:create'),
    'profiles:updateContent': invoke('profiles:updateContent'),
    'profiles:setDefault': invoke('profiles:setDefault'),
    'profiles:setDefaultResume': invoke('profiles:setDefaultResume'),
    'materials:list': invoke('materials:list'),
    'materials:importBuffer': invoke('materials:importBuffer'),
    'facts:list': invoke('facts:list'),
    'facts:remember': invoke('facts:remember'),
    'positions:list': invoke('positions:list'),
    'positions:add': invoke('positions:add'),
    'positions:updateProgress': invoke('positions:updateProgress'),
    'providers:list': invoke('providers:list'),
    'providers:save': invoke('providers:save'),
    'providers:delete': invoke('providers:delete'),
    'providers:probe': invoke('providers:probe'),
    'settings:get': invoke('settings:get'),
    'settings:update': invoke('settings:update'),
    'skills:list': invoke('skills:list'),
    'skills:load': invoke('skills:load'),
    'skills:listDrafts': invoke('skills:listDrafts'),
    'skills:reviewDraft': invoke('skills:reviewDraft'),
    onMainEvent: (listener) => {
      if (!ipcRenderer.on || !ipcRenderer.removeListener) return () => {};
      const wrapped = (_evt: unknown, payload: MainToRendererEvent) => listener(payload);
      ipcRenderer.on(MAIN_EVENT_CHANNEL, wrapped);
      return () => ipcRenderer.removeListener?.(MAIN_EVENT_CHANNEL, wrapped);
    },
  };
}
