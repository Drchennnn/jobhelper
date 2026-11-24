import type {
  ModelCapabilities,
  ModelProviderConfig,
  ModelUsage,
  ProviderId,
} from '@jobhelper/contracts';
import type { ModelRouter, ModelToolSchema } from './router.js';

export interface BenchmarkPricing {
  currency?: 'CNY' | 'USD';
  inputPer1MTokens: number;
  outputPer1MTokens: number;
  cachedInputPer1MTokens?: number;
}

export interface BenchmarkProviderEntry {
  provider: ModelProviderConfig;
  pricing?: BenchmarkPricing;
}

export interface BenchmarkScenarioResult {
  scenario: 'probe' | 'tool_call_form_fill';
  ok: boolean;
  latencyMs: number;
  toolCallAccurate?: boolean;
  usage?: ModelUsage;
  error?: string;
}

export interface ProviderBenchmarkResult {
  providerId: ProviderId;
  name: string;
  providerType: ModelProviderConfig['providerType'];
  modelId: string;
  capabilities?: ModelCapabilities;
  scenarios: BenchmarkScenarioResult[];
  totalLatencyMs: number;
  totalUsage: ModelUsage;
  estimatedCost?: { amount: number; currency: 'CNY' | 'USD' };
}

export interface BenchmarkMatrixReport {
  generatedAt: string;
  results: ProviderBenchmarkResult[];
  markdown: string;
}

const BENCHMARK_ACT_TOOL: ModelToolSchema = {
  name: 'act',
  description: 'Execute a safe form action on the job application page.',
  inputSchema: {
    type: 'object',
    required: ['action', 'ref', 'value'],
    properties: {
      action: { type: 'string', enum: ['fill', 'select', 'choose_option', 'click'] },
      ref: { type: 'string' },
      value: { type: 'string' },
    },
  },
};

function mergeUsage(a: ModelUsage, b?: ModelUsage): ModelUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    reasoningTokens:
      a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
        ? (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
        : undefined,
    cachedInputTokens:
      a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
        ? (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)
        : undefined,
  };
}

function estimateCost(
  usage: ModelUsage,
  pricing?: BenchmarkPricing,
): { amount: number; currency: 'CNY' | 'USD' } | undefined {
  if (!pricing) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const nonCachedInput = Math.max(0, usage.inputTokens - cached);
  const inputCost = (nonCachedInput / 1_000_000) * pricing.inputPer1MTokens;
  const cachedCost =
    (cached / 1_000_000) * (pricing.cachedInputPer1MTokens ?? pricing.inputPer1MTokens);
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1MTokens;
  return {
    amount: Number((inputCost + cachedCost + outputCost).toFixed(6)),
    currency: pricing.currency ?? 'CNY',
  };
}

export function formatBenchmarkMarkdown(
  results: readonly ProviderBenchmarkResult[],
  generatedAt: string,
): string {
  const lines: string[] = [
    '# JobHelper BYOK 模型兼容与性能成本基准报告',
    '',
    `生成时间：\`${generatedAt}\``,
    '',
    '| 服务商 | 协议 | 模型 | 流式 | Tool Calling | 视觉 | 填表工具准确 | 总耗时 (ms) | Token (入/出/思考) | 估算成本 |',
    '| --- | --- | --- | :---: | :---: | :---: | :---: | ---: | --- | ---: |',
  ];

  for (const r of results) {
    const cap = r.capabilities;
    const formScenario = r.scenarios.find((s) => s.scenario === 'tool_call_form_fill');
    const yn = (v?: boolean) => (v === true ? '✅' : v === false ? '❌' : '—');
    const tokens = `${r.totalUsage.inputTokens} / ${r.totalUsage.outputTokens}${
      r.totalUsage.reasoningTokens !== undefined ? ` / ${r.totalUsage.reasoningTokens}` : ''
    }`;
    const cost = r.estimatedCost
      ? `${r.estimatedCost.currency === 'CNY' ? '¥' : '$'}${r.estimatedCost.amount.toFixed(6)}`
      : '—';
    lines.push(
      `| ${r.name} | \`${r.providerType}\` | \`${r.modelId}\` | ${yn(cap?.streaming)} | ${yn(cap?.toolCalling)} | ${yn(cap?.vision)} | ${yn(formScenario?.toolCallAccurate)} | ${r.totalLatencyMs} | ${tokens} | ${cost} |`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Runs a standardized capability + structured tool-calling benchmark across one or more BYOK providers.
 */
export async function runByokBenchmarkMatrix(
  router: ModelRouter,
  entries: readonly BenchmarkProviderEntry[],
  options?: { timeoutMs?: number },
): Promise<BenchmarkMatrixReport> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const generatedAt = new Date().toISOString();
  const results: ProviderBenchmarkResult[] = [];

  for (const entry of entries) {
    const { provider, pricing } = entry;
    const scenarios: BenchmarkScenarioResult[] = [];
    let capabilities: ModelCapabilities | undefined;
    let totalUsage: ModelUsage = { inputTokens: 0, outputTokens: 0 };

    // 1. Capability probe
    const probeStart = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        capabilities = await router.probe(provider.id, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      scenarios.push({
        scenario: 'probe',
        ok: true,
        latencyMs: Date.now() - probeStart,
      });
    } catch (err) {
      scenarios.push({
        scenario: 'probe',
        ok: false,
        latencyMs: Date.now() - probeStart,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Single-step structured tool-calling accuracy benchmark
    const formStart = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await router.generate({
          provider,
          signal: controller.signal,
          tools: [BENCHMARK_ACT_TOOL],
          messages: [
            {
              role: 'system',
              content:
                'You are a job application form-filling assistant. Call the `act` tool accurately using the given element ref.',
            },
            {
              role: 'user',
              content:
                'Page observation: textbox "姓名" (ref="tab-1:e1_1"), textbox "邮箱" (ref="tab-1:e1_2"). Fill 姓名 with "林星河" by calling `act`.',
            },
          ],
        });
        totalUsage = mergeUsage(totalUsage, res.usage);

        const accurate = res.toolCalls.some((call) => {
          if (call.name !== 'act') return false;
          try {
            const parsed = JSON.parse(call.argumentsJson) as Record<string, unknown>;
            return (
              parsed.action === 'fill' &&
              parsed.ref === 'tab-1:e1_1' &&
              parsed.value === '林星河'
            );
          } catch {
            return false;
          }
        });

        scenarios.push({
          scenario: 'tool_call_form_fill',
          ok: true,
          latencyMs: Date.now() - formStart,
          toolCallAccurate: accurate,
          usage: res.usage,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      scenarios.push({
        scenario: 'tool_call_form_fill',
        ok: false,
        latencyMs: Date.now() - formStart,
        toolCallAccurate: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const totalLatencyMs = scenarios.reduce((sum, s) => sum + s.latencyMs, 0);
    results.push({
      providerId: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      modelId: provider.modelId,
      capabilities,
      scenarios,
      totalLatencyMs,
      totalUsage,
      estimatedCost: estimateCost(totalUsage, pricing),
    });
  }

  return {
    generatedAt,
    results,
    markdown: formatBenchmarkMarkdown(results, generatedAt),
  };
}
