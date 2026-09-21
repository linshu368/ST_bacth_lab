import react from '@vitejs/plugin-react';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

function copyDirectory(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(target, entry);
    if (statSync(from).isDirectory()) copyDirectory(from, to);
    else copyFileSync(from, to);
  }
}

function staticWorkspaceData(): Plugin {
  const root = process.cwd();
  const allowedRoots = [resolve(root, 'data'), resolve(root, 'script')];
  const contentTypes: Record<string, string> = {
    '.csv': 'text/csv; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };

  return {
    name: 'static-workspace-data',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url?.split('?')[0] ?? '';
        if (!requestUrl.startsWith('/data/') && !requestUrl.startsWith('/script/')) {
          next();
          return;
        }
        const filePath = normalize(resolve(root, `.${decodeURIComponent(requestUrl)}`));
        const withinAllowedRoot = allowedRoots.some((allowedRoot) => {
          const rel = relative(allowedRoot, filePath);
          return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
        });
        if (!withinAllowedRoot || !existsSync(filePath) || statSync(filePath).isDirectory()) {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }
        response.setHeader('Content-Type', contentTypes[extname(filePath)] ?? 'text/plain');
        createReadStream(filePath).pipe(response);
      });
    },
    closeBundle() {
      copyDirectory(resolve(root, 'data'), resolve(root, 'dist', 'data'));
      copyDirectory(resolve(root, 'script'), resolve(root, 'dist', 'script'));
    },
  };
}

export default defineConfig({
  plugins: [react(), staticWorkspaceData()],
});
