import { startMockAtsServer } from './server.js';

const port = Number(process.env.MOCK_ATS_PORT ?? 4100);
const server = await startMockAtsServer({ port, requireLogin: true });

console.log(`Mock ATS server running at ${server.baseUrl}`);
console.log(`  Job 1: ${server.baseUrl}/apply/job-001`);
console.log(`  Job 2: ${server.baseUrl}/apply/job-002`);
console.log(`  Reset: ${server.baseUrl}/reset`);
console.log(`  State: ${server.baseUrl}/api/state`);
