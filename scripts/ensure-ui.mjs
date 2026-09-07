/** Build in isolation, preserve old assets, and publish the index last. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, mkdir, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appRoot, releaseIdentity, buildStatus } from './ui-release.mjs';
const expected = await releaseIdentity();
const config = JSON.parse(await readFile(join(appRoot,'harness-ui.json'),'utf8'));
const destination = resolve(process.env.OCW_BUILD_DIR || join(appRoot, config.frontend_dir || 'dist'));
const current = await buildStatus(destination,expected);
if (current.status !== 'current') {
  const temp = await mkdtemp(join(tmpdir(),'ocw-ui-build-'));
  try {
    await new Promise((yes,no) => {
      const child=spawn(process.platform === 'win32' ? 'npm.cmd':'npm',['run','build'],{cwd:appRoot,env:{...process.env,OCW_BUILD_DIR:temp},stdio:'inherit'});
      child.on('error',no);child.on('exit',code => code === 0 ? yes():no(Error('UI build failed')));
    });
    if ((await releaseIdentity()).sourceDigest !== expected.sourceDigest || (await buildStatus(temp,expected)).status !== 'current') throw Error('Source changed while building; retry with a stable source');
    await mkdir(destination,{recursive:true});
    async function copy(relative='') {
      for (const entry of await readdir(join(temp,relative),{withFileTypes:true})) {
        const name=join(relative,entry.name);
        if (entry.isDirectory()) {await mkdir(join(destination,name),{recursive:true});await copy(name);}
        else if (name !== 'index.html' && name !== 'ui-build.json') await copyFile(join(temp,name),join(destination,name));
      }
    }
    await copy();
    // Unique staging names permit concurrent identical publishers without races.
    for (const name of ['ui-build.json','index.html']) {
      const next=join(destination,`.${name}.${process.pid}`);
      await writeFile(next,await readFile(join(temp,name)));
      await rename(next,join(destination,name));
    }
  } finally {await rm(temp,{recursive:true,force:true});}
}
console.log(JSON.stringify({status:'current',destination,...expected}));
