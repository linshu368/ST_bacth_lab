import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { z } from 'zod';
import { datasetProvenanceSchema } from '../server/datasets';
import { prepareSourceImport } from './import-source';

const metadataSchema = z.object({
  schema_version: z.literal(1), name: z.string().trim().min(1).max(120),
  idempotency_key: z.string().uuid(), provenance: datasetProvenanceSchema,
}).strict();
const definitions = [
  { kind: 'history', directory: 'history', pattern: /^page-\d+\.jsonl$/, csv: 'chat_history_rows.csv' },
  { kind: 'sessions', directory: 'relations', pattern: /^sessions-\d+\.jsonl$/, csv: 'chat_sessions_rows.csv' },
  { kind: 'characters', directory: 'relations', pattern: /^characters-\d+\.jsonl$/, csv: 'characters_rows.csv' },
] as const;

async function* sourceRows(files: string[]): AsyncGenerator<Record<string, unknown>> {
  for (const file of files) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error(`${path.basename(file)} 第 ${lineNumber} 行不是有效 JSON`); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} 第 ${lineNumber} 行不是记录对象`);
        yield value as Record<string, unknown>;
      }
    } finally { lines.close(); stream.destroy(); }
  }
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export async function convertJsonlSource(sourceDirectory: string, outputDirectory: string, metadataPath: string, options: { charactersDirectory?: string } = {}): Promise<{ manifestPath: string; files: { kind: string; rows: number; size: number; sha256: string }[] }> {
  const metadata = metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
  await mkdir(outputDirectory, { recursive: true });
  const files: { kind: string; path: string }[] = [];
  for (const definition of definitions) {
    const overriddenCharacters = definition.kind === 'characters' && options.charactersDirectory;
    const directory = overriddenCharacters ? path.resolve(overriddenCharacters) : path.join(sourceDirectory, definition.directory);
    const pattern = overriddenCharacters ? /^(?:characters-|page-)\d+\.jsonl$/ : definition.pattern;
    const pages = (await readdir(directory)).filter(name => pattern.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).map(name => path.join(directory, name));
    if (!pages.length) throw new Error(`${definition.kind} 缺少完整的 JSONL 导出分页`);
    const fields = new Set<string>();
    const ids = new Set<string>();
    let count = 0;
    for await (const row of sourceRows(pages)) {
      for (const key of Object.keys(row)) fields.add(key);
      if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error(`${definition.kind} 导出记录存在缺失或重复 id`);
      ids.add(row.id); count++;
    }
    if (count !== metadata.provenance.row_counts[definition.kind]) throw new Error(`${definition.kind} 导出未完整：预期 ${metadata.provenance.row_counts[definition.kind]} 行，实际 ${count} 行`);
    const headers = [...fields].sort();
    const destination = path.join(outputDirectory, definition.csv);
    async function* csvLines() {
      yield Papa.unparse([headers], { newline: '\r\n' }) + '\r\n';
      for await (const row of sourceRows(pages)) {
        yield Papa.unparse([headers.map(field => csvValue(row[field]))], { newline: '\r\n' }) + '\r\n';
      }
    }
    await pipeline(csvLines(), createWriteStream(`${destination}.tmp`, { encoding: 'utf8', mode: 0o600 }));
    await rename(`${destination}.tmp`, destination);
    files.push({ kind: definition.kind, path: definition.csv });
  }
  const manifestPath = path.join(outputDirectory, 'manifest.json');
  // Publish the manifest only after all three complete files are present.
  await writeFile(`${manifestPath}.tmp`, JSON.stringify({ ...metadata, files }, null, 2) + '\n', { mode: 0o600 });
  await rename(`${manifestPath}.tmp`, manifestPath);
  const verified = await prepareSourceImport(manifestPath);
  const verifiedFiles = verified.files.map(file => ({ kind: file.kind, path: path.basename(file.path), size: file.size, sha256: file.sha256 }));
  await writeFile(`${manifestPath}.tmp`, JSON.stringify({ ...metadata, files: verifiedFiles }, null, 2) + '\n', { mode: 0o600 });
  await rename(`${manifestPath}.tmp`, manifestPath);
  return { manifestPath: path.resolve(manifestPath), files: verified.files.map(({ kind, rows, size, sha256 }) => ({ kind, rows, size, sha256 })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readArg = (name: string) => { const position = args.indexOf(name); return position < 0 ? undefined : args[position + 1]; };
  const source = readArg('--source-dir');
  const output = readArg('--output-dir');
  const metadata = readArg('--metadata');
  const charactersDirectory = readArg('--characters-dir');
  if (!source || !output || !metadata) {
    console.error('用法：npx tsx script/jsonl-to-source.ts --source-dir <JSONL目录> --output-dir <CSV目录> --metadata <来源元数据.json> [--characters-dir <角色JSONL目录>]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await convertJsonlSource(source, output, metadata, { charactersDirectory }))); }
    catch { console.error('JSONL 转换未完成，请核对三个表的分页、行数及来源清单。'); process.exitCode = 1; }
  }
}
