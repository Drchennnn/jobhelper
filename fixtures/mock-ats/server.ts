import http from 'node:http';

export type MockSubmitMode = 'success' | 'timeout' | 'error';

export interface MockSubmissionRecord {
  receiptId: string;
  jobId: string;
  fields: Record<string, string>;
  uploadedFileName?: string;
  submittedAt: string;
}

export interface MockAtsServerHandle {
  readonly baseUrl: string;
  readonly port: number;
  reset(): void;
  setSubmitMode(mode: MockSubmitMode): void;
  getState(): {
    loggedIn: boolean;
    submitMode: MockSubmitMode;
    drafts: Record<string, Record<string, string>>;
    submissions: MockSubmissionRecord[];
  };
  close(): Promise<void>;
}

const JOB_TITLES: Record<string, { company: string; title: string }> = {
  'job-001': { company: 'MockCorp 科技', title: '前端开发工程师（2027校招）' },
  'job-002': { company: 'MockCorp 科技', title: 'AI 应用工程师（2027校招）' },
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLoginHtml(nextUrl: string, errorMsg?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>MockCorp 招聘登录</title>
<style>body{font-family:sans-serif;max-width:460px;margin:40px auto;padding:20px;background:#f8fafc}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}
label{display:block;margin-top:12px;font-size:13px;font-weight:600}
input{width:100%;padding:8px;margin-top:4px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box}
button{margin-top:16px;width:100%;padding:10px;background:#4f46e5;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin-top:8px}</style></head>
<body>
<div class="card">
  <h1>MockCorp 候选人登录</h1>
  <p style="font-size:13px;color:#64748b">测试账号：任意手机号/邮箱，测试密码：<code>123456</code>，测试图形验证码：<code>8848</code></p>
  ${errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ''}
  <form method="POST" action="/api/login">
    <input type="hidden" name="next" value="${escapeHtml(nextUrl)}" />
    <label for="account">手机号 / 邮箱</label>
    <input id="account" name="account" type="text" placeholder="请输入手机号或邮箱" required />
    <label for="password">登录密码</label>
    <input id="password" name="password" type="password" placeholder="请输入密码" required />
    <label for="captcha">图形验证码（请输入 8848）</label>
    <input id="captcha" name="captcha" type="text" placeholder="请输入图形验证码" required />
    <button type="submit">登录进入网申</button>
  </form>
</div>
</body></html>`;
}

function renderApplyHtml(
  jobId: string,
  draft: Record<string, string>,
  submitMode: MockSubmitMode,
): string {
  const job = JOB_TITLES[jobId] ?? { company: 'MockCorp 科技', title: `岗位 ${jobId}` };
  const val = (k: string) => escapeHtml(draft[k] ?? '');
  const sel = (k: string, opt: string) => (draft[k] === opt ? 'selected' : '');

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(job.company)} - ${escapeHtml(job.title)}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:24px auto;padding:20px;background:#f8fafc}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}
label{display:block;margin-top:14px;font-size:13px;font-weight:600;color:#1e293b}
input,select,textarea{width:100%;padding:8px;margin-top:4px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box;font-size:14px}
.actions{display:flex;gap:12px;margin-top:20px}
button{padding:10px 18px;border-radius:8px;font-weight:600;cursor:pointer;border:0}
.draft{background:#e2e8f0;color:#0f172a}.submit{background:#059669;color:#fff}
.status{margin-top:12px;font-size:13px;color:#0369a1}</style></head>
<body>
<div class="card">
  <h1>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</h1>
  <p style="font-size:12px;color:#64748b">JobHelper Gate 1 可重置测试网申表（当前提交回执模式：<code>${submitMode}</code>）</p>
  <form id="applyForm">
    <input type="hidden" name="jobId" value="${escapeHtml(jobId)}" />
    <label for="fullName">姓名 *</label>
    <input id="fullName" name="fullName" type="text" value="${val('fullName')}" placeholder="请输入真实姓名" required />

    <label for="phone">手机号 *</label>
    <input id="phone" name="phone" type="tel" value="${val('phone')}" placeholder="请输入手机号" required />

    <label for="email">邮箱 *</label>
    <input id="email" name="email" type="email" value="${val('email')}" placeholder="请输入邮箱" required />

    <label for="degree">最高学历 *</label>
    <select id="degree" name="degree" required>
      <option value="">请选择学历</option>
      <option value="bachelor" ${sel('degree', 'bachelor')}>本科</option>
      <option value="master" ${sel('degree', 'master')}>硕士</option>
      <option value="phd" ${sel('degree', 'phd')}>博士</option>
    </select>

    <label for="city">期望工作城市 *</label>
    <select id="city" name="city" required>
      <option value="">请选择城市</option>
      <option value="上海" ${sel('city', '上海')}>上海</option>
      <option value="北京" ${sel('city', '北京')}>北京</option>
      <option value="深圳" ${sel('city', '深圳')}>深圳</option>
      <option value="杭州" ${sel('city', '杭州')}>杭州</option>
    </select>

    <label for="experience">实习与项目经历</label>
    <textarea id="experience" name="experience" rows="4" placeholder="请概述主要实习或项目经历">${val('experience')}</textarea>

    <label for="relocate">是否接受短期出差 *（用于测试缺失事实提问卡）</label>
    <input id="relocate" name="relocate" type="text" value="${val('relocate')}" placeholder="例如：接受 / 不接受" required />

    <label for="resumeFile">附件简历（PDF）</label>
    <input id="resumeFile" name="resumeFile" type="file" accept=".pdf" />
    <div id="uploadedName" style="font-size:12px;color:#475569;margin-top:4px">${val('uploadedFileName') ? `已选附件：${val('uploadedFileName')}` : ''}</div>

    <div class="actions">
      <button type="button" id="saveDraftBtn" class="draft">保存草稿</button>
      <button type="submit" id="submitApplyBtn" class="submit">提交申请</button>
    </div>
    <div id="statusMsg" class="status"></div>
  </form>
</div>
<script>
  const form = document.getElementById('applyForm');
  const statusEl = document.getElementById('statusMsg');
  const fileInput = document.getElementById('resumeFile');
  const uploadedEl = document.getElementById('uploadedName');
  let selectedFileName = ${JSON.stringify(draft.uploadedFileName ?? '')};

  fileInput.addEventListener('change', () => {
    selectedFileName = fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '';
    uploadedEl.textContent = selectedFileName ? ('已选附件：' + selectedFileName) : '';
  });

  function collectPayload() {
    const fd = new FormData(form);
    const fields = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') fields[k] = v;
    }
    if (selectedFileName) fields.uploadedFileName = selectedFileName;
    return fields;
  }

  document.getElementById('saveDraftBtn').addEventListener('click', async () => {
    const res = await fetch('/api/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collectPayload()),
    });
    statusEl.textContent = res.ok ? '草稿已保存' : '草稿保存失败';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.textContent = '正在提交申请…';
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectPayload()),
      });
      if (!res.ok) {
        statusEl.textContent = '提交响应异常（HTTP ' + res.status + '），请勿重复提交，先核验申请记录。';
        return;
      }
      const data = await res.json();
      window.location.href = '/receipt/' + encodeURIComponent(data.receiptId);
    } catch {
      statusEl.textContent = '网络超时，未能获取官网回执，请先核验状态。';
    }
  });
</script>
</body></html>`;
}

function renderReceiptHtml(record: MockSubmissionRecord): string {
  const job = JOB_TITLES[record.jobId] ?? { company: 'MockCorp 科技', title: record.jobId };
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>投递成功回执 - ${escapeHtml(record.receiptId)}</title>
<style>body{font-family:sans-serif;max-width:560px;margin:40px auto;padding:20px;background:#f0fdf4}
.card{background:#fff;border:1px solid #bbf7d0;border-radius:12px;padding:24px}</style></head>
<body>
<div class="card">
  <h1>投递成功！已收到您的申请</h1>
  <p>公司：<strong>${escapeHtml(job.company)}</strong></p>
  <p>岗位：<strong>${escapeHtml(job.title)}</strong></p>
  <p>申请回执编号：<code>${escapeHtml(record.receiptId)}</code></p>
  <p>候选人：${escapeHtml(record.fields.fullName ?? '')}</p>
  <p>附件：${escapeHtml(record.uploadedFileName ?? '无')}</p>
</div>
</body></html>`;
}

export async function startMockAtsServer(options?: {
  port?: number;
  host?: string;
  requireLogin?: boolean;
}): Promise<MockAtsServerHandle> {
  const host = options?.host ?? '127.0.0.1';
  const requireLogin = options?.requireLogin ?? true;

  let loggedIn = !requireLogin;
  let submitMode: MockSubmitMode = 'success';
  let drafts: Record<string, Record<string, string>> = {};
  let submissions: MockSubmissionRecord[] = [];
  let seq = 0;

  const reset = () => {
    loggedIn = !requireLogin;
    submitMode = 'success';
    drafts = {};
    submissions = [];
    seq = 0;
  };

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', `http://${host}`);
    const pathname = parsed.pathname;

    if (pathname === '/reset' && (req.method === 'POST' || req.method === 'GET')) {
      reset();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reset: true }));
      return;
    }

    if (pathname === '/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        submitMode?: MockSubmitMode;
        loggedIn?: boolean;
      };
      if (body.submitMode) submitMode = body.submitMode;
      if (typeof body.loggedIn === 'boolean') loggedIn = body.loggedIn;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, submitMode, loggedIn }));
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ loggedIn, submitMode, drafts, submissions }));
      return;
    }

    if (pathname === '/login' && req.method === 'GET') {
      const next = parsed.searchParams.get('next') ?? '/apply/job-001';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginHtml(next));
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const next = params.get('next') ?? '/apply/job-001';
      const password = params.get('password') ?? '';
      const captcha = params.get('captcha') ?? '';
      if (password === '123456' && captcha === '8848') {
        loggedIn = true;
        res.writeHead(302, {
          location: next,
          'set-cookie': 'mock_ats_session=valid; Path=/; HttpOnly',
        });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderLoginHtml(next, '密码（123456）或图形验证码（8848）不正确'));
      return;
    }

    const applyMatch = /^\/apply\/([^/]+)$/.exec(pathname);
    if (applyMatch && req.method === 'GET') {
      const jobId = decodeURIComponent(applyMatch[1]!);
      const hasCookie = (req.headers.cookie ?? '').includes('mock_ats_session=valid');
      if (!loggedIn && !hasCookie) {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(pathname)}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderApplyHtml(jobId, drafts[jobId] ?? {}, submitMode));
      return;
    }

    if (pathname === '/api/draft' && req.method === 'POST') {
      const fields = JSON.parse((await readBody(req)) || '{}') as Record<string, string>;
      const jobId = fields.jobId ?? 'job-001';
      drafts[jobId] = { ...(drafts[jobId] ?? {}), ...fields };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobId }));
      return;
    }

    if (pathname === '/api/submit' && req.method === 'POST') {
      const modeOverride = parsed.searchParams.get('mode') as MockSubmitMode | null;
      const effectiveMode = modeOverride ?? submitMode;
      const fields = JSON.parse((await readBody(req)) || '{}') as Record<string, string>;
      const jobId = fields.jobId ?? 'job-001';

      if (effectiveMode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Simulated ATS server error' }));
        return;
      }

      const receiptId = `APP-2026-${String(++seq).padStart(4, '0')}`;
      const record: MockSubmissionRecord = {
        receiptId,
        jobId,
        fields,
        uploadedFileName: fields.uploadedFileName,
        submittedAt: new Date().toISOString(),
      };
      submissions.push(record);

      if (effectiveMode === 'timeout') {
        // Server recorded submission, but returns 504 timeout without receipt -> must stop in verifying/unknown!
        res.writeHead(504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway Timeout (receipt unavailable)' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, receiptId }));
      return;
    }

    const receiptMatch = /^\/receipt\/([^/]+)$/.exec(pathname);
    if (receiptMatch && req.method === 'GET') {
      const rid = decodeURIComponent(receiptMatch[1]!);
      const found = submissions.find((s) => s.receiptId === rid);
      if (!found) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Receipt not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderReceiptHtml(found));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Mock ATS route not found');
  });

  await new Promise<void>((resolve) => server.listen(options?.port ?? 0, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind Mock ATS server');
  }

  return {
    port: addr.port,
    baseUrl: `http://${host}:${addr.port}`,
    reset,
    setSubmitMode: (m) => {
      submitMode = m;
    },
    getState: () => ({
      loggedIn,
      submitMode,
      drafts: structuredClone(drafts),
      submissions: structuredClone(submissions),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
