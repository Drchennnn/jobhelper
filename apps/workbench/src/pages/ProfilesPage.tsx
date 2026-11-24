import React, { useEffect, useState } from 'react';
import { Check, FileText, Plus, Save, Star, Upload } from 'lucide-react';
import type {
  MaterialRecord,
  ProfileContent,
  ProfileId,
  ProfileRecord,
  ProfileVersionSnapshot,
  UserFactRecord,
} from '@jobhelper/contracts';
import type { JobHelperBridge } from '../lib/bridge.js';

interface ProfilesPageProps {
  bridge: JobHelperBridge;
  profiles: ProfileRecord[];
  defaultProfileId: ProfileId | null;
  materials: MaterialRecord[];
  onRefresh: () => Promise<void>;
}

const EMPTY_CONTENT: ProfileContent = {
  basic: { fullName: '', phone: '', email: '', city: '' },
  education: [],
  internships: [],
  projects: [],
  skills: [],
};

export function ProfilesPage({
  bridge,
  profiles,
  defaultProfileId,
  materials,
  onRefresh,
}: ProfilesPageProps) {
  const [selectedId, setSelectedId] = useState<ProfileId | null>(
    defaultProfileId ?? profiles[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<{
    profile: ProfileRecord;
    snapshot: ProfileVersionSnapshot;
    versions: ProfileVersionSnapshot[];
  } | null>(null);
  const [draft, setDraft] = useState<ProfileContent>(EMPTY_CONTENT);
  const [skillsText, setSkillsText] = useState('');
  const [newProfileName, setNewProfileName] = useState('');
  const [facts, setFacts] = useState<UserFactRecord[]>([]);
  const [factKey, setFactKey] = useState('');
  const [factValue, setFactValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const loadDetail = async (id: ProfileId | null) => {
    if (!id) {
      setDetail(null);
      return;
    }
    const res = await bridge['profiles:get']({ profileId: id });
    setDetail(res);
    if (res) {
      setDraft(res.snapshot.content);
      setSkillsText(res.snapshot.content.skills.join(', '));
    }
    setFacts(await bridge['facts:list']({ profileId: id }));
  };

  useEffect(() => {
    if (!selectedId && profiles[0]) {
      setSelectedId(defaultProfileId ?? profiles[0].id);
    }
  }, [profiles, defaultProfileId, selectedId]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [selectedId]);

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) return;
    const created = await bridge['profiles:create']({
      name: newProfileName.trim(),
      content: { ...EMPTY_CONTENT, basic: { ...EMPTY_CONTENT.basic, fullName: '待填写姓名' } },
      setAsDefault: profiles.length === 0,
    });
    setNewProfileName('');
    await onRefresh();
    setSelectedId(created.profile.id);
    setNotice(`已创建新档案「${created.profile.name}」（版本 v1）`);
  };

  const handleSaveSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    const nextContent: ProfileContent = {
      ...draft,
      skills: skillsText
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const res = await bridge['profiles:updateContent']({
      profileId: selectedId,
      content: nextContent,
    });
    await onRefresh();
    await loadDetail(selectedId);
    setNotice(`已保存不可变快照 v${res.snapshot.versionNumber}（不影响已有投递任务）`);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const base64Data = btoa(binary);
    await bridge['materials:importBuffer']({
      profileId: selectedId ?? undefined,
      kind: file.name.toLowerCase().endsWith('.pdf') ? 'resume_pdf' : 'other',
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      base64Data,
    });
    e.target.value = '';
    await onRefresh();
    setNotice(`已导入受管材料：${file.name}（上传简历不会覆盖结构化档案）`);
  };

  const handleAddFact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factKey.trim() || !factValue.trim()) return;
    await bridge['facts:remember']({
      scope: selectedId ? 'profile' : 'global',
      profileId: selectedId ?? undefined,
      key: factKey.trim(),
      value: factValue.trim(),
    });
    setFactKey('');
    setFactValue('');
    await loadDetail(selectedId);
  };

  return (
    <div className="flex h-full overflow-hidden bg-slate-50">
      {/* Left: Profile List */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">多版本个人档案</h2>
        <p className="mt-0.5 text-[11px] text-slate-500">
          切换全局默认档案只影响新任务，既有任务保持锁定快照
        </p>

        <div className="mt-3 flex-1 space-y-1.5 overflow-y-auto">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                selectedId === p.id
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span className="truncate font-medium">{p.name}</span>
              {p.id === defaultProfileId && (
                <span className="ml-2 shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                  默认
                </span>
              )}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleCreateProfile(e)} className="mt-3 flex gap-1.5 border-t border-slate-100 pt-3">
          <input
            type="text"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            placeholder="新建档案名称…"
            className="flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
          />
          <button
            type="submit"
            className="inline-flex items-center rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </form>
      </aside>

      {/* Right: Structured Editor, Materials, Facts */}
      <section className="flex-1 space-y-5 overflow-y-auto p-6">
        {notice && (
          <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-emerald-600">
              关闭
            </button>
          </div>
        )}

        {detail ? (
          <form
            onSubmit={(e) => void handleSaveSnapshot(e)}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h1 className="text-base font-semibold text-slate-900">{detail.profile.name}</h1>
                <div className="text-xs text-slate-500">
                  当前不可变快照：v{detail.snapshot.versionNumber} · 共 {detail.versions.length} 个历史版本
                </div>
              </div>
              <div className="flex items-center gap-2">
                {detail.profile.id !== defaultProfileId && (
                  <button
                    type="button"
                    onClick={() =>
                      void bridge['profiles:setDefault']({ profileId: detail.profile.id }).then(onRefresh)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Star className="h-3.5 w-3.5" />
                    设为全局默认
                  </button>
                )}
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  <Save className="h-3.5 w-3.5" />
                  保存新快照
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
              <label className="block">
                <span className="font-medium text-slate-700">姓名</span>
                <input
                  type="text"
                  value={draft.basic.fullName}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, basic: { ...d.basic, fullName: e.target.value } }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block">
                <span className="font-medium text-slate-700">手机号</span>
                <input
                  type="text"
                  value={draft.basic.phone ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, basic: { ...d.basic, phone: e.target.value } }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block">
                <span className="font-medium text-slate-700">邮箱</span>
                <input
                  type="email"
                  value={draft.basic.email ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, basic: { ...d.basic, email: e.target.value } }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block">
                <span className="font-medium text-slate-700">所在/期望城市</span>
                <input
                  type="text"
                  value={draft.basic.city ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, basic: { ...d.basic, city: e.target.value } }))
                  }
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="font-medium text-slate-700">核心技能（逗号分隔）</span>
                <input
                  type="text"
                  value={skillsText}
                  onChange={(e) => setSkillsText(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="font-medium text-slate-700">自我评价 / 简介</span>
                <textarea
                  rows={3}
                  value={draft.selfEvaluation ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, selfEvaluation: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5"
                />
              </label>
            </div>
          </form>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
            请先在左侧选择或创建一份个人档案
          </div>
        )}

        {/* Materials & Attachments */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">简历 PDF 与附件材料库</h2>
              <p className="text-[11px] text-slate-500">
                本地受管存储并计算 SHA-256 校验；按任务显式授权上传
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="h-3.5 w-3.5" />
              导入附件
              <input type="file" onChange={(e) => void handleFileUpload(e)} className="hidden" />
            </label>
          </div>

          <div className="mt-3 space-y-2">
            {materials.length === 0 ? (
              <div className="rounded-lg bg-slate-50 p-3 text-center text-xs text-slate-400">
                尚未导入 PDF 简历或证书附件
              </div>
            ) : (
              materials.map((m) => {
                const isDefaultResume = detail?.profile.defaultResumeMaterialId === m.id;
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-indigo-500" />
                      <div>
                        <div className="font-medium text-slate-800">{m.fileName}</div>
                        <div className="text-[10px] text-slate-400">
                          {m.kind} · {(m.sizeBytes / 1024).toFixed(1)} KB
                        </div>
                      </div>
                    </div>
                    {detail && (
                      <button
                        type="button"
                        onClick={() =>
                          void bridge['profiles:setDefaultResume']({
                            profileId: detail.profile.id,
                            materialId: isDefaultResume ? undefined : m.id,
                          })
                            .then(onRefresh)
                            .then(() => loadDetail(detail.profile.id))
                        }
                        className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ${
                          isDefaultResume
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {isDefaultResume && <Check className="h-3 w-3" />}
                        {isDefaultResume ? '默认投递简历' : '设为默认简历'}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* User Facts */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="text-sm font-semibold text-slate-900">个人补充事实记忆</h2>
          <p className="text-[11px] text-slate-500">
            仅记录你明确确认过的补充信息（如到岗时间、出差意愿、期望薪资），避免重复提问
          </p>
          <form onSubmit={(e) => void handleAddFact(e)} className="mt-3 flex gap-2 text-xs">
            <input
              type="text"
              value={factKey}
              onChange={(e) => setFactKey(e.target.value)}
              placeholder="条目（如：最早到岗时间）"
              className="w-48 rounded-lg border border-slate-300 px-2.5 py-1.5"
            />
            <input
              type="text"
              value={factValue}
              onChange={(e) => setFactValue(e.target.value)}
              placeholder="真实值（如：2026-12）"
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5"
            />
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-800"
            >
              保存事实
            </button>
          </form>
          <div className="mt-3 space-y-1.5">
            {facts.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs"
              >
                <span className="font-medium text-slate-700">{f.key}</span>
                <span className="text-slate-900">{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
