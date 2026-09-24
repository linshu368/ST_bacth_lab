import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { query } from '../server/db';
try { loadEnvFile('.env.local'); } catch { /* CI supplies variables directly. */ }
const schema = await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');
for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await query(statement);
console.log('共享数据库结构已就绪。');
