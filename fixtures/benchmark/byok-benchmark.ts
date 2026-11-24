import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IsoTimestamp, ModelProviderConfig, ProviderId } from '@jobhelper/contracts';
import {
  ByokModelRouter,
  InMemoryCredentialStore,
  runByokBenchmarkMatrix,
  type BenchmarkPricing,
} from '../../packages/model-router/dist/index.js';

interface CliProviderSpec {
  name: string;
  providerType: ModelProviderConfig['providerType'];
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
  pricing?: BenchmarkPricing;
}

async function main(): Promise<void> {
  const configPath = process.env.JOBHELPER_BENCHMARK_CONFIG;
  if (!configPath || !fs.existsSync(configPath)) {
    console.log(
      [
        'JobHelper BYOK Benchmark CLI',
        '',
        '用法：设置环境变量 JOBHELPER_BENCHMARK_CONFIG 指向本地 JSON 配置文件（严禁将真实 API Key 写入仓库）：',
        '  $env:JOBHELPER_BENCHMARK_CONFIG = "C:\\path\\to\\providers.benchmark.local.json"',
        '  npm run benchmark:byok',
        '',
        '配置文件示例（通过 apiKeyEnv 引用环境变量中的密钥）：',
        JSON.stringify(
          [
            {
              name: 'DeepSeek 主力',
              providerType: 'openai-compatible',
              baseUrl: 'https://api.deepseek.com/v1',
              modelId: 'deepseek-chat',
              apiKeyEnv: 'DEEPSEEK_API_KEY',
              pricing: { currency: 'CNY', inputPer1MTokens: 2, outputPer1MTokens: 8 },
            },
          ],
          null,
          2,
        ),
      ].join('\n'),
    );
    return;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as CliProviderSpec[];
  const creds = new InMemoryCredentialStore();
  const providerMap = new Map<ProviderId, ModelProviderConfig>();
  const now = new Date().toISOString() as IsoTimestamp;

  const entries = [];
  for (const spec of raw) {
    const apiKey = process.env[spec.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`环境变量 ${spec.apiKeyEnv} 未设置，无法评测 ${spec.name}`);
    }
    const id = crypto.randomUUID() as ProviderId;
    const credentialKey = `bench:${id}`;
    await creds.setSecret(credentialKey, apiKey);
    const config: ModelProviderConfig = {
      id,
      name: spec.name,
      providerType: spec.providerType,
      baseUrl: spec.baseUrl,
      modelId: spec.modelId,
      credentialKey,
      timeoutMs: 30_000,
      capabilities: { streaming: true, toolCalling: true, vision: false },
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    providerMap.set(id, config);
    entries.push({ provider: config, pricing: spec.pricing });
  }

  const router = new ByokModelRouter(
    {
      getById: (id) => providerMap.get(id) ?? null,
      upsert: (cfg) => {
        providerMap.set(cfg.id, cfg);
      },
    },
    creds,
  );

  const report = await runByokBenchmarkMatrix(router, entries);
  console.log(report.markdown);
}

main().catch((err) => {
  console.error('[byok-benchmark] 执行失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
