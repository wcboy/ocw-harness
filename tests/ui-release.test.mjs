import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseIdentity, buildStatus } from '../scripts/ui-release.mjs';
import {createHash} from 'node:crypto';
test('release identity changes with renderer code and rejects stale builds',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ocw-ui-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'public'));await mkdir(join(root,'src'));await mkdir(join(root,'scripts'));
 for (const name of ['harness-ui.json','server.mjs','package.json','package-lock.json','vite.config.ts']) await writeFile(join(root,name),'{}');
 await writeFile(join(root,'ui-release.json'),JSON.stringify({designVersion:'checkpoint-paths-2',adapterVersion:'ocw-console-4'}));
 await writeFile(join(root,'src/graph.ts'),'parallel paths');
 const original=await releaseIdentity(root);
 await mkdir(join(root,'assets'));await writeFile(join(root,'assets/app.js'),'graph');await writeFile(join(root,'index.html'),'index');
 const digest = value => createHash('sha256').update(value).digest('hex');
 await writeFile(join(root,'ui-build.json'),JSON.stringify({...original,indexDigest:digest('index'),assets:{'assets/app.js':digest('graph')}}));
 assert.equal((await buildStatus(root,original)).status,'current');
 await writeFile(join(root,'assets/app.js'),'old renderer');
 assert.equal((await buildStatus(root,original)).status,'corrupt');
 await writeFile(join(root,'src/graph.ts'),'old flat cards');
 assert.equal((await buildStatus(root,await releaseIdentity(root))).status,'stale');
});

test('scaffold copies the current renderer and portable entries, without task data',async t=>{
 const {execFile} = await import('node:child_process');const {promisify} = await import('node:util');const {appRoot}=await import('../scripts/ui-release.mjs');
 const root=await mkdtemp(join(tmpdir(),'ocw-scaffold-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'console');
 await promisify(execFile)('python3',[join(appRoot,'scripts/scaffold_console.py'),'--reference',appRoot,'--destination',target]);
 for (const name of ['server.mjs','src/components/OrthogonalJourney.tsx','src/graph-layout.ts','scripts/ocw_graph.py','scripts/run-bound-ui.sh','README.md','SKILL.md','RUNTIME-RELIABILITY.md','.gitignore','.github/workflows/check.yml','LICENSE','NOTICE','pyproject.toml','tests/test_ocw_runtime.py','examples/quickstart/make_plan.py','docs/plan-contract.md']) assert.equal(await readFile(join(target,name),'utf8'),await readFile(join(appRoot,name),'utf8'));
 assert.equal(JSON.parse(await readFile(join(target,'harness-ui.json'),'utf8')).frontend_dir,'dist');
 assert.equal((await releaseIdentity(target)).designVersion,'checkpoint-paths-2');
 assert.doesNotMatch(await readFile(join(target,'public/start.command'),'utf8'),/\/Users\//);
 await assert.rejects(promisify(execFile)('python3',[join(appRoot,'scripts/scaffold_console.py'),'--reference',appRoot,'--destination',target]),/FileExistsError/);
});
