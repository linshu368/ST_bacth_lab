import { neon } from '@neondatabase/serverless';

let client: ReturnType<typeof neon> | undefined;
function database() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('共享数据库尚未配置 DATABASE_URL');
  return (client ??= neon(url));
}

export async function query<T = any>(text: string, values: any[] = []): Promise<T[]> {
  return await database().query(text, values) as T[];
}

export async function transaction(
  statements: Array<{ text: string; values?: any[] }>,
  options: { readOnly?: boolean } = {},
): Promise<any[][]> {
  const sql = database();
  return await sql.transaction(statements.map(s => sql.query(s.text, s.values ?? [])), options) as any[][];
}

export function json(value: unknown): string { return JSON.stringify(value); }
