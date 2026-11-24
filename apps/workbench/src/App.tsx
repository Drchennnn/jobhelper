import React, { useEffect, useState } from 'react';
import type {
  MaterialRecord,
  ProfileId,
  ProfileRecord,
  TaskId,
  TaskRecord,
} from '@jobhelper/contracts';
import { Layout } from './components/Layout.js';
import { getJobHelperBridge, type JobHelperBridge } from './lib/bridge.js';
import { AssistantPage } from './pages/AssistantPage.js';
import { ProfilesPage } from './pages/ProfilesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { TrackerPage } from './pages/TrackerPage.js';
import type { WorkbenchRouteId } from './routes.js';

export function App({ bridge: customBridge }: { bridge?: JobHelperBridge } = {}) {
  const bridge = customBridge ?? getJobHelperBridge();
  const [route, setRoute] = useState<WorkbenchRouteId>('assistant');
  const [activeTaskId, setActiveTaskId] = useState<TaskId | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<ProfileId | null>(null);
  const [materials, setMaterials] = useState<MaterialRecord[]>([]);
  const [streams, setStreams] = useState<Record<string, { text: string; reasoning: string }>>({});

  const refreshAll = async () => {
    const [tList, pRes, mList] = await Promise.all([
      bridge['tasks:list'](),
      bridge['profiles:list'](),
      bridge['materials:list'](),
    ]);
    setTasks(tList);
    setProfiles(pRes.profiles);
    setDefaultProfileId(pRes.defaultProfileId);
    setMaterials(mList);
  };

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!bridge.onMainEvent) return;
    return bridge.onMainEvent((ev) => {
      if (ev.type === 'tasks_changed') {
        void refreshAll();
      } else if (ev.type === 'stream_delta' && ev.delta) {
        const { taskId, textDelta, reasoningDelta, done } = ev.delta;
        setStreams((prev) => {
          if (done) {
            const copy = { ...prev };
            delete copy[taskId];
            return copy;
          }
          const cur = prev[taskId] ?? { text: '', reasoning: '' };
          return {
            ...prev,
            [taskId]: {
              text: cur.text + textDelta,
              reasoning: cur.reasoning + reasoningDelta,
            },
          };
        });
      }
    });
  }, [bridge]);

  const waitingUserCount = tasks.filter(
    (t) =>
      t.kind === 'application' &&
      ['waiting_user', 'paused', 'interrupted', 'error'].includes(t.executionState),
  ).length;

  const openTaskDetail = (taskId: TaskId) => {
    setActiveTaskId(taskId);
    setRoute('task-detail');
  };

  return (
    <Layout
      activeRoute={route}
      waitingUserCount={waitingUserCount}
      isElectron={bridge.isElectron}
      onNavigate={(next) => {
        setRoute(next);
        if (next !== 'task-detail') setActiveTaskId(null);
      }}
    >
      {route === 'assistant' && (
        <AssistantPage
          bridge={bridge}
          tasks={tasks}
          profiles={profiles}
          defaultProfileId={defaultProfileId}
          onRefresh={refreshAll}
          onOpenTask={openTaskDetail}
        />
      )}
      {route === 'tasks' && (
        <TasksPage
          bridge={bridge}
          tasks={tasks}
          profiles={profiles}
          defaultProfileId={defaultProfileId}
          materials={materials}
          onRefresh={refreshAll}
          onOpenTask={openTaskDetail}
        />
      )}
      {route === 'task-detail' && activeTaskId && (
        <TaskDetailPage
          bridge={bridge}
          taskId={activeTaskId}
          streamingText={streams[activeTaskId]?.text}
          streamingReasoning={streams[activeTaskId]?.reasoning}
          onBack={() => setRoute('tasks')}
          onRefreshTasks={refreshAll}
        />
      )}
      {route === 'profiles' && (
        <ProfilesPage
          bridge={bridge}
          profiles={profiles}
          defaultProfileId={defaultProfileId}
          materials={materials}
          onRefresh={refreshAll}
        />
      )}
      {route === 'tracker' && (
        <TrackerPage
          bridge={bridge}
          onRefreshTasks={refreshAll}
          onOpenTask={openTaskDetail}
        />
      )}
      {route === 'settings' && <SettingsPage bridge={bridge} />}
    </Layout>
  );
}
