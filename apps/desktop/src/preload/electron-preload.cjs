const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = [
  'tasks:list',
  'tasks:getCoordinator',
  'tasks:getProjection',
  'tasks:startApplication',
  'tasks:sendMessage',
  'tasks:takeover',
  'tasks:resumeCheck',
  'tasks:close',
  'tasks:answerQuestion',
  'tasks:resolveConfirmation',
  'tasks:events',
  'browser:syncSurface',
  'browser:navigate',
  'browser:detachWindow',
  'profiles:list',
  'profiles:get',
  'profiles:create',
  'profiles:updateContent',
  'profiles:setDefault',
  'profiles:setDefaultResume',
  'materials:list',
  'materials:importBuffer',
  'facts:list',
  'facts:remember',
  'positions:list',
  'positions:add',
  'positions:updateProgress',
  'providers:list',
  'providers:save',
  'providers:delete',
  'providers:probe',
  'settings:get',
  'settings:update',
  'skills:list',
  'skills:load',
  'skills:listDrafts',
  'skills:reviewDraft',
];

const api = {};
for (const channel of CHANNELS) {
  api[channel] = (arg) => ipcRenderer.invoke(channel, arg);
}
api.onMainEvent = (listener) => {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on('jobhelper:event', wrapped);
  return () => ipcRenderer.removeListener('jobhelper:event', wrapped);
};

contextBridge.exposeInMainWorld('jobHelper', api);
