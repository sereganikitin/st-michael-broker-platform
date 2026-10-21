const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');const source=fs.readFileSync(path.join(root,'deploy-update.sh'),'utf8');
const block=source.split('# BEGIN reviewed runtime overlay guard')[1].split('# END reviewed runtime overlay guard')[0];
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
test('guard preserves fail-closed path and byte checks before hard reset',()=>{
 assert.match(block,/git diff --cached --quiet/);assert.match(block,/docker\/nginx.conf\\nops\/tg-relay.js/);assert.match(block,/\[ "\$actual" = "\$expected" \] && \[ "\$target" = "\$expected" \]/);
 assert.ok(source.indexOf('if ! verify_reviewed_runtime_overlays')<source.indexOf('git reset --hard origin/master'));
 assert.match(source,/cp --parents -- docker\/nginx.conf ops\/tg-relay.js/);
});
test('real git rejects unknown, staged and wrong-byte edits; accepts a clean tree',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stm-overlay-test-'));
 const git=(...args)=>cp.execFileSync('git',args,{cwd:dir,stdio:'pipe'});
 const run=()=>cp.spawnSync(bash,['-c','set -euo pipefail\n'+block+'\nEXPECTED_DEPLOY_SHA=$(git rev-parse HEAD)\nverify_reviewed_runtime_overlays'],{cwd:dir,stdio:'pipe'}).status;
 try{git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');fs.mkdirSync(path.join(dir,'docker'));fs.mkdirSync(path.join(dir,'ops'));fs.writeFileSync(path.join(dir,'docker/nginx.conf'),'base');fs.writeFileSync(path.join(dir,'ops/tg-relay.js'),'base');fs.writeFileSync(path.join(dir,'other'),'base');git('add','.');git('commit','-m','base');assert.equal(run(),0);
 fs.appendFileSync(path.join(dir,'other'),'edit');assert.notEqual(run(),0);git('restore','other');
 fs.appendFileSync(path.join(dir,'docker/nginx.conf'),'edit');fs.appendFileSync(path.join(dir,'ops/tg-relay.js'),'edit');assert.notEqual(run(),0);git('add','.');assert.notEqual(run(),0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('accepts only exact live overlay bytes also present in the target commit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stm-overlay-exact-'));
 const git=(...a)=>cp.execFileSync('git',a,{cwd:dir,stdio:'pipe'}).toString().trim();
 const bytes=p=>cp.execFileSync('git',['show','HEAD:'+p],{cwd:root});
 const paths=['docker/nginx.conf','ops/tg-relay.js'];
 try{git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');for(const p of paths){fs.mkdirSync(path.dirname(path.join(dir,p)),{recursive:true});fs.writeFileSync(path.join(dir,p),'old');}git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');for(const p of paths)fs.writeFileSync(path.join(dir,p),bytes(p));git('add','.');git('commit','-m','target');const target=git('rev-parse','HEAD');git('checkout','--detach',base);for(const p of paths)fs.writeFileSync(path.join(dir,p),bytes(p));const result=cp.spawnSync(bash,['-c','set -euo pipefail\n'+block+'\nEXPECTED_DEPLOY_SHA='+target+'\nverify_reviewed_runtime_overlays'],{cwd:dir,stdio:'pipe'});assert.equal(result.status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
