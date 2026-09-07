import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const appRoot = fileURLToPath(new URL('..', import.meta.url));
export async function releaseIdentity(root = appRoot) {
  const release = JSON.parse(await readFile(join(root, 'ui-release.json'), 'utf8'));
  const hash = createHash('sha256');
  async function visit(relative) {
    for (const entry of (await readdir(join(root, relative), {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) { if (relative === 'src' || relative.startsWith('src/')) await visit(relative + '/' + entry.name); }
      else if (entry.isFile() && !entry.name.includes('.test.') && !entry.name.startsWith('test_') && !entry.name.startsWith('e2e-')) {
        const name = relative + '/' + entry.name; hash.update(name).update(await readFile(join(root,name)));
      }
    }
  }
  for (const name of ['ui-release.json','harness-ui.json','server.mjs','package.json','package-lock.json','vite.config.ts']) hash.update(name).update(await readFile(join(root,name)));
  await visit('src'); await visit('scripts'); await visit('public');
  return {...release, sourceDigest:hash.digest('hex')};
}
export async function buildStatus(dist, expected) {
  try {
    const built = JSON.parse(await readFile(join(dist,'ui-build.json'),'utf8'));
    if (built.sourceDigest !== expected.sourceDigest || built.designVersion !== expected.designVersion) return {...built,status:'stale'};
    if (!built.assets || !Object.keys(built.assets).length) return {...built,status:'incomplete'};
    for (const [name, digest] of Object.entries({'index.html':built.indexDigest,...built.assets})) {
      if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+)$/.test(name) || createHash('sha256').update(await readFile(join(dist,name))).digest('hex') !== digest) return {...built,status:'corrupt'};
    }
    return {...built,status:'current'};
  }
  catch { return {status:'missing', designVersion:expected.designVersion}; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await releaseIdentity(process.argv[2] || appRoot)));
