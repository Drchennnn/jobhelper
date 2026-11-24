import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  FolderPlus,
  KeyRound,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  ModelProviderType,
  ProviderSummaryDto,
  SkillDraftRecord,
  SkillSummaryDto,
} from '@jobhelper/contracts';
import type { JobHelperBridge } from '../lib/bridge.js';

interface SettingsPageProps {
  bridge: JobHelperBridge;
}

export function SettingsPage({ bridge }: SettingsPageProps) {
  const [providers, setProviders] = useState<ProviderSummaryDto[]>([]);
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<ModelProviderType>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);

  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [externalDirs, setExternalDirs] = useState<string[]>([]);
  const [newSkillDir, setNewSkillDir] = useState('');
  const [skillsCatalog, setSkillsCatalog] = useState<{
    catalogVersion: string;
    skills: SkillSummaryDto[];
  }>({ catalogVersion: '', skills: [] });
  const [previewSkill, setPreviewSkill] = useState<{
    name: string;
    bodyMarkdown: string;
    source: 'builtin' | 'external';
  } | null>(null);
  const [drafts, setDrafts] = useState<SkillDraftRecord[]>([]);

  const loadAll = async () => {
    const [pList, settings, sList, dList] = await Promise.all([
      bridge['providers:list'](),
      bridge['settings:get'](),
      bridge['skills:list'](),
      bridge['skills:listDrafts'](),
    ]);
    setProviders(pList);
    setMaxConcurrent(settings.maxConcurrent);
    setExternalDirs(settings.externalSkillDirs);
    setSkillsCatalog({ catalogVersion: sList.catalogVersion, skills: sList.skills });
    setDrafts(dList);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleSaveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !baseUrl.trim() || !modelId.trim()) return;
    await bridge['providers:save']({
      name: name.trim(),
      providerType,
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      apiKey: apiKey.trim() || undefined,
      isDefault: providers.length === 0,
    });
    setName('');
    setModelId('');
    setApiKey('');
    await loadAll();
  };

  const handleProbe = async (providerId: ProviderSummaryDto['config']['id']) => {
    setProbingId(providerId);
    setProbeMsg(null);
    try {
      const res = await bridge['providers:probe']({ providerId });
      if (res.ok && res.capabilities) {
        setProbeMsg(
          `探测成功：流式=${res.capabilities.streaming ? '支持' : '否'}，工具调用=${
            res.capabilities.toolCalling ? '支持' : '否'
          }，视觉读图=${res.capabilities.vision ? '支持' : '否'}`,
        );
      } else {
        setProbeMsg(`探测失败：${res.error ?? '未知错误'}`);
      }
      await loadAll();
    } finally {
      setProbingId(null);
    }
  };

  const handleMountDir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSkillDir.trim()) return;
    const next = [...new Set([...externalDirs, newSkillDir.trim()])];
    await bridge['settings:update']({ externalSkillDirs: next });
    setNewSkillDir('');
    await loadAll();
  };

  const handleRemoveDir = async (dirToRemove: string) => {
    const next = externalDirs.filter((d) => d !== dirToRemove);
    await bridge['settings:update']({ externalSkillDirs: next });
    await loadAll();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-900">BYOK 模型设置与本地 Skills 知识库</h1>
        <p className="text-xs text-slate-500">
          模型密钥由系统凭据服务（Windows DPAPI / safeStorage）加密托管，绝不落盘明文也不暴露给前端；使用外部模型服务时字段与截图会发往所选服务商。
        </p>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {/* BYOK Providers */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <KeyRound className="h-4 w-4 text-indigo-600" />
            模型服务商配置（BYOK）
          </h2>

          <form onSubmit={(e) => void handleSaveProvider(e)} className="mt-3 grid gap-2.5 sm:grid-cols-3 text-xs">
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="配置名称（如：DeepSeek 主力）"
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <select
              value={providerType}
              onChange={(e) => setProviderType(e.target.value as ModelProviderType)}
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            >
              <option value="openai-compatible">OpenAI-Compatible（含 DeepSeek / Ollama）</option>
              <option value="anthropic">Anthropic 原生协议</option>
              <option value="gemini">Google Gemini 原生协议</option>
            </select>
            <input
              type="text"
              required
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="Model ID（如：deepseek-chat / gpt-4o）"
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <input
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL（如：https://api.deepseek.com/v1）"
              className="rounded-lg border border-slate-300 px-3 py-1.5 sm:col-span-2"
            />
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API Key（直接加密写入 safeStorage，本机 Ollama 可留空）"
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
            <div className="sm:col-span-3 flex justify-end">
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-4 py-1.5 font-medium text-white hover:bg-indigo-700"
              >
                保存模型配置
              </button>
            </div>
          </form>

          {probeMsg && (
            <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
              {probeMsg}
            </div>
          )}

          <div className="mt-4 space-y-2">
            {providers.length === 0 ? (
              <div className="rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-400">
                尚未配置模型 API，请在上方添加并执行连通性与能力探测
              </div>
            ) : (
              providers.map(({ config, hasSecret }) => (
                <div
                  key={config.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{config.name}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                        {config.providerType} · {config.modelId}
                      </span>
                      {config.isDefault && (
                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                          默认
                        </span>
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          hasSecret ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {hasSecret ? '密钥已加密保存' : '未存密钥'}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">{config.baseUrl}</span>
                      <span>·</span>
                      <span>流式：{config.capabilities.streaming ? '✓' : '—'}</span>
                      <span>工具调用：{config.capabilities.toolCalling ? '✓' : '—'}</span>
                      <span>读图：{config.capabilities.vision ? '✓' : '—'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={probingId === config.id}
                      onClick={() => void handleProbe(config.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" />
                      {probingId === config.id ? '探测中…' : '测试连接与能力'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void bridge['providers:delete']({ providerId: config.id }).then(loadAll)
                      }
                      className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Concurrency Setting */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between text-xs">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">本机任务并行上限</h2>
              <p className="text-[11px] text-slate-500">
                仅用于控制本机资源与 API 并发，无任何平台套餐额度限制（范围 1–5）
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={5}
                value={maxConcurrent}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxConcurrent(val);
                  void bridge['settings:update']({ maxConcurrent: val });
                }}
              />
              <span className="w-8 text-center font-mono text-sm font-bold text-indigo-700">
                {maxConcurrent}
              </span>
            </div>
          </div>
        </section>

        {/* Option A: Built-in + User-Mounted Private External Skills */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <BookOpen className="h-4 w-4 text-indigo-600" />
                本地 Skills 知识库与外部目录挂载（方案 A）
              </h2>
              <p className="text-[11px] text-slate-500">
                内置 `skills-library/` 仅含 JobHelper 原生适配手册；你可在此按需挂载本机私有外部 Skills 目录（仅本地生效，不进入 Git 仓库）。
              </p>
            </div>
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
              目录版本：{skillsCatalog.catalogVersion || '—'} · 共 {skillsCatalog.skills.length} 份
            </span>
          </div>

          <form onSubmit={(e) => void handleMountDir(e)} className="mt-3 flex gap-2 text-xs">
            <input
              type="text"
              value={newSkillDir}
              onChange={(e) => setNewSkillDir(e.target.value)}
              placeholder="输入本机外部 Skills 目录路径（例如：D:\download\jinli-rea-analysis\skills）"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 font-mono"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3.5 py-1.5 font-medium text-white hover:bg-slate-800"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              挂载本地目录
            </button>
          </form>

          {externalDirs.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {externalDirs.map((dir) => (
                <span
                  key={dir}
                  className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 font-mono text-[11px] text-indigo-800"
                >
                  {dir}
                  <button
                    type="button"
                    onClick={() => void handleRemoveDir(dir)}
                    className="text-indigo-500 hover:text-rose-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {skillsCatalog.skills.map((s) => (
              <button
                key={`${s.source}:${s.name}`}
                type="button"
                onClick={async () => {
                  const doc = await bridge['skills:load']({ skillName: s.name });
                  setPreviewSkill(doc);
                }}
                className="rounded-lg border border-slate-200 p-3 text-left text-xs transition hover:border-indigo-300 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-slate-900">{s.name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      s.source === 'builtin'
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-amber-50 text-amber-800'
                    }`}
                  >
                    {s.source === 'builtin' ? '内置适配' : '本机挂载'}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{s.description}</p>
              </button>
            ))}
          </div>

          {previewSkill && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <div className="font-mono text-xs font-semibold text-slate-900">
                  预览：{previewSkill.name}（{previewSkill.source === 'builtin' ? '内置' : '外部挂载'}）
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewSkill(null)}
                  className="text-xs text-slate-500 hover:text-slate-800"
                >
                  收起
                </button>
              </div>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs leading-relaxed text-slate-700">
                {previewSkill.bodyMarkdown}
              </pre>
            </div>
          )}

          {drafts.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-semibold text-slate-700">本地 Skill 改进草稿审阅</h3>
              <div className="mt-2 space-y-2">
                {drafts.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 p-2.5 text-xs"
                  >
                    <div>
                      <span className="font-mono font-medium">{d.skillName}</span>
                      <span className="ml-2 text-slate-400">({d.status})</span>
                    </div>
                    {d.status === 'draft' && (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            void bridge['skills:reviewDraft']({ draftId: d.id, status: 'approved' }).then(
                              loadAll,
                            )
                          }
                          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-white"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          通过
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void bridge['skills:reviewDraft']({ draftId: d.id, status: 'rejected' }).then(
                              loadAll,
                            )
                          }
                          className="inline-flex items-center gap-1 rounded bg-rose-600 px-2 py-1 text-white"
                        >
                          <XCircle className="h-3 w-3" />
                          拒绝
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
