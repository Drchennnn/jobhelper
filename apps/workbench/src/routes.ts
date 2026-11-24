/**
 * Single unified navigation map for the JobHelper desktop workbench (M4).
 * Explicitly avoids dual sidebars and legacy "remote desktop" terminology.
 */
export const WORKBENCH_ROUTES = [
  { id: 'assistant', path: '/assistant', label: '助手' },
  { id: 'tasks', path: '/tasks', label: '投递任务' },
  { id: 'task-detail', path: '/tasks/:taskId', label: '任务详情' },
  { id: 'profiles', path: '/profiles', label: '档案与材料' },
  { id: 'tracker', path: '/tracker', label: '求职进度' },
  { id: 'settings', path: '/settings', label: '设置与技能' },
] as const;

export type WorkbenchRouteId = (typeof WORKBENCH_ROUTES)[number]['id'];
