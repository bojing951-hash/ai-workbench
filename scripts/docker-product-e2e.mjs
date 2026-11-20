// SPDX-License-Identifier: Apache-2.0
/**
 * REST + Supervisor + Git + SQLite; real host product test; local formatter/coder and HTTP auditor.
 * No container, provider credentials, or remote Git operations. Run from candidate repo root.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const NODE = process.execPath;
const REPO = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
async function waitFor(fn, ms = 60_000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (err) { last = err; } await sleep(200); } throw new Error('timeout: ' + String(last)); }

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR || 'demo/evidence/offline-e2e');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wbh-chain-'));
const repo=path.join(root,'product'),productTest='node --test tests/product.test.cjs', clause='The formatter produces the exact uppercase READY response';
const doGit=(args,cwd=repo)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
fs.mkdirSync(path.join(repo,'tests'),{recursive:true});
fs.writeFileSync(path.join(repo,'tests/product.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('formatter returns a word',()=>assert.match(require('../format.cjs')(), /^[a-zA-Z]+$/));\n");
fs.writeFileSync(path.join(repo,'TEST_PLAN.json'),JSON.stringify({acceptance:[clause]}));
doGit(['init','-b','main','-q']);doGit(['config','user.name','fixture']);doGit(['config','user.email','fixture@example.invalid']);doGit(['add','-A']);doGit(['commit','-qm','contract']);
const baseline=doGit(['rev-parse','HEAD']);const contract=doGit(['rev-parse','HEAD:TEST_PLAN.json']);
for(const f of ['src','bin','web','package.json'])fs.symlinkSync(path.join(REPO,f),path.join(root,f));
const agent=path.join(root,'zero-coder');
const first="module.exports = () => 'ready';",fixed="module.exports = () => 'READY';";
fs.writeFileSync(agent, '#!/bin/sh\nset -eu\nif test -f format.cjs; then\n printf "%s\\n" "'+fixed+'" > format.cjs\nelse\n printf "%s\\n" "'+first+'" > format.cjs\nfi\nprintf "%s\\n" \'{"result":"fixture edited formatter","session_id":"fixture","usage":{"input_tokens":2,"output_tokens":2},"cost_cny":0}\'\n',{mode:0o755});
const auditLog=[];
const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await (const c of req) chunks.push(c);
  const body=JSON.parse(Buffer.concat(chunks)),user=body.messages.find(x=>x.role==='user')?.content||'';
  const title=user.match(/## 任务\n([^\n]+)/u)?.[1]||'';
  const list=user.match(/## 验收标准（必须逐条原样返回）\n([\s\S]*?)\n\n/u)?.[1]||'';
  const criteria=list.split('\n').map(x=>x.replace(/^\d+\. /,'')).filter(Boolean);
  const good=title==='Product acceptance'||criteria.includes(clause)?user.includes('+'+fixed):user.includes('+'+first)||user.includes('+'+fixed);
  auditLog.push({title,criteria,good,seen:first && user.includes('+'+first)?'lower':user.includes('+'+fixed)?'upper':'unknown'});
  const result={score:good?100:5,criteria:criteria.map(criterion=>({criterion,status:good?'pass':'fail',evidence:good?'format.cjs:1 exports the formatter, and tests/product.test.cjs calls it and verifies it returns a word.':'Observed lowercase ready instead of required uppercase string at format.cjs:1.'})),findings:good?[]:[{severity:'high',description:'lowercase response'}],required_fixes:good?[]:['Change response from ready to READY'],summary:good?'PASS':'FAIL'};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(result)}}],usage:{prompt_tokens:10,completion_tokens:10}}));
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const port=await freePort(),token='test-token-supervisor-0001';
const image='ai-workbench-e2e:fixture';
if (spawnSync('docker',['image','inspect',image],{env:{...process.env,DOCKER_CONFIG:process.env.DOCKER_CONFIG||path.join(os.homedir(),'.docker')}}).status!==0) {
  const b=spawnSync('docker',['build','-q','-t',image,'tests/fixtures/docker-e2e'],{encoding:'utf8',env:{...process.env,DOCKER_CONFIG:process.env.DOCKER_CONFIG||path.join(os.homedir(),'.docker'),DOCKER_BUILDKIT:'0'}});
  if(b.status!==0) throw new Error('docker build failed: '+String(b.stderr||b.stdout).slice(-1000));
}
const env={PATH:process.env.PATH,HOME:root,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:path.join(root,'data'),WORKBENCH_PROJECTS_DIR:path.join(root,'projects'),WORKBENCH_API_TOKEN:token,WORKBENCH_HOST:'127.0.0.1',WORKBENCH_PORT:String(port),DEFAULT_AGENT:'custom',CUSTOM_AGENT_BIN:agent,CUSTOM_AGENT_ARGS:'',AUDIT_PROVIDER:'openai',OPENAI_API_KEY:'dummy-local',OPENAI_BASE_URL:'http://127.0.0.1:'+mock.address().port+'/v1',OPENAI_AUDIT_MODEL:'fixture-audit',AUDIT_REQUIRE_INDEPENDENT:'false',GITHUB_PUSH:'false',DOCKER_CONFIG:"/Users/cast/.docker",CONTAINER_IMAGE:'ai-workbench-e2e:fixture',CLAUDE_BIN:'/usr/bin/true',CLAUDE_API_KEY:'dummy-local',CLAUDE_BASE_URL:'http://127.0.0.1:9',GITHUB_CREATE_PR:'false',GITHUB_AUTO_CREATE_REPO:'false',MAX_TOTAL_TOKENS:'10000000',MAX_COST_CNY:'100',MAX_TOKENS_PER_TASK:'600000'};
const logp=path.join(root,'sup.log'),out=fs.openSync(logp,'a');const sup=spawn(NODE,[path.join(REPO,'supervisor/workbench-supervisor.mjs'),'--root',root,'--port',String(port),'--max-restarts','2'],{cwd:root,env,stdio:['ignore',out,out]});
try{
 assert.ok(await waitHealth(port),fs.readFileSync(logp,'utf8'));
 const reg=await api(port,token,'POST','/api/projects',{name:'Host-only audit fixture',repo,defaultBranch:'main',testCommand:productTest,agentKind:'claude',agentIsolation:'docker',testIsolation:'docker',auditProvider:'openai',ciRequired:false,supervisorManaged:true,protectTests:true,contractFiles:['TEST_PLAN.json'],testPlan:{acceptance:[clause]},testIsolation:'docker',publish:false});
 assert.equal(reg.status,201,JSON.stringify(reg));const projectId=reg.data.data.id;
 const result=await api(port,token,'POST','/api/projects/'+projectId+'/loops',{goal:clause,mode:'queue',maxRounds:4,queue:[{title:'Implement the word formatter',description:'Create the formatter.',agent:'custom',acceptance:['The formatter returns a word'],testCommand:productTest}]});
 assert.equal(result.status,201,JSON.stringify(result));const loopId=result.data.data.id;
 const until=Date.now()+95000;
 let snap;while(Date.now()<until){snap=(await api(port,token,'GET','/api/loops/'+loopId)).data.data;if(['paused','blocked','completed','cancelled'].includes(snap.status))break;await sleep(350)}
 const runData=(await api(port,token,'GET','/api/state')).data.data.runs.filter(x=>x.project_id===projectId);
 const detailed=[];for(const r of runData){const v=(await api(port,token,'GET','/api/runs/'+r.id)).data.data;detailed.push({id:r.id,status:v.status,stopReason:v.stop_reason,planHead:v.result_json?.planHead,productVerdict:v.result_json?.productAcceptance,productAudit:v.result_json?.productAcceptanceAuditId,tasks:(v.tasks||[]).map(t=>({id:t.id,title:t.title,status:t.status,reason:t.blocked_reason,head:t.head_commit,testCode:t.result_json?.testCode,receiptExists:!!t.result_json?.testArtifactLog&&fs.existsSync(t.result_json.testArtifactLog)}))})}
 const head=doGit(['rev-parse','HEAD']);
 console.log(JSON.stringify({root,loopId,projectId,status:snap.status,stopReason:snap.stop_reason,repairCount:snap.product_repair_count,round:snap.round,auditLog,runs:detailed,baseline,head,contractAtFinal:doGit(['rev-parse','HEAD:TEST_PLAN.json']),contract},null,2));
 const firstProductAudit=auditLog.filter(x=>x.title==='Product acceptance');
 assert.deepEqual(firstProductAudit.map(x=>x.good),[false,true],'must reject initial lowercase, then pass uppercase on the repaired commit');
 assert.equal(snap.status,'completed',snap.stop_reason);
 assert.equal(snap.product_repair_count,1,'exactly one automatic product repair must run');
 assert.equal(detailed.length,2);
 const initial=detailed.find(r=>r.tasks[0]?.title==='Implement the word formatter');
 const final=detailed.find(r=>r.productVerdict==='PASS');
 assert.ok(initial?.planHead && final?.planHead && initial.planHead!==final.planHead);
 assert.equal(final.status,'awaiting_acceptance');assert.ok(final.productAudit);
 assert.equal(final.planHead,head);assert.equal(doGit(['rev-parse',head+':TEST_PLAN.json']),contract);
 doGit(['merge-base','--is-ancestor',initial.planHead,head]);assert.equal(doGit(['show',initial.planHead+':format.cjs']),first);assert.equal(doGit(['show',head+':format.cjs']),fixed);
 for(const run of detailed) assert.equal(run.tasks[0].testCode,0,'the real product test must pass for each committed attempt');
  // ── 冻结证据: 原始日志/容器命令/bundle/干净克隆验证 ──
  const productRepo=repo;
  const bundlePath=path.join(EVIDENCE_DIR,'product.bundle');
  doGit(['bundle','create',bundlePath,'--all'],productRepo);
  const clonePath=path.join(root,'clean-clone');
  doGit(['clone','-q',bundlePath,clonePath]);
  const initialCode=spawnSync('git',['show',initial.planHead+':format.cjs'],{cwd:clonePath,encoding:'utf8'}).stdout.trim();
  const finalCode=spawnSync('git',['show',final.planHead+':format.cjs'],{cwd:clonePath,encoding:'utf8'}).stdout.trim();
  assert.equal(initialCode,first); assert.equal(finalCode,fixed);
  doGit(['checkout','-q',initial.planHead],clonePath);
  const initialBehavior=spawnSync(NODE,['-e',`const f=require(${JSON.stringify(path.join(clonePath,'format.cjs'))});if(f()!=='READY')process.exit(1)`],{encoding:'utf8'});
  assert.notEqual(initialBehavior.status,0,'clean clone initial behavior must fail product assertion');
  doGit(['checkout','-q',final.planHead],clonePath);
  const finalBehavior=spawnSync(NODE,['-e',`const f=require(${JSON.stringify(path.join(clonePath,'format.cjs'))});if(f()!=='READY')process.exit(1)`],{encoding:'utf8'});
  assert.equal(finalBehavior.status,0,'clean clone final behavior must pass product assertion');
  const logFiles=[];
  for (const f of fs.readdirSync(path.join(root,'data/logs'),{recursive:true})) {
    const src=path.join(root,'data/logs',f);
    if (fs.statSync(src).isFile()) { const dst=path.join(EVIDENCE_DIR,'logs',f); fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.copyFileSync(src,dst); logFiles.push(path.relative(EVIDENCE_DIR,dst)); }
  }
  const dockerCommands=[];
  for (const rel of logFiles.filter(x=>x.includes('-claude.log')||x.includes('-test.log'))) {
    const firstLines=fs.readFileSync(path.join(EVIDENCE_DIR,rel),'utf8').split('\n').slice(0,4).join('\n');
    dockerCommands.push({log:rel, command:firstLines});
  }
  const candidateSha=doGit(['rev-parse','HEAD'],REPO);
  const bundleSha=crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
  const evidence={candidateSha,productSha:final.planHead,initialSha:initial.planHead,projectId,loopId,contractHash:contract,status:'awaiting_acceptance',runIds:[initial.id,final.id],initialFailure:auditLog.filter(x=>x.title==='Product acceptance')[0]?.good===false,finalAudit:'PASS',repairCount:snap.product_repair_count,containerImage:image,dockerCommands,bundle:{path:path.relative(REPO,bundlePath),sha256:bundleSha},cleanClone:{initialBehavior:'FAIL_AS_EXPECTED',finalBehavior:'PASS',initialCode,finalCode},logs:logFiles,at:new Date().toISOString()};
  fs.writeFileSync(path.join(EVIDENCE_DIR,'run.json'),JSON.stringify(evidence,null,2));
  fs.writeFileSync(path.join(EVIDENCE_DIR,'report.json'),JSON.stringify({...evidence,auditLog},null,2));
  fs.writeFileSync(path.join(EVIDENCE_DIR,'verify-bundle.sh'),`#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\ntmp=$(mktemp -d)\ngit clone -q product.bundle "$tmp/clean"\ncd "$tmp/clean"\ngit checkout -q ${final.planHead}\nnode -e "const f=require('./format.cjs'); if(f()!=='READY') process.exit(1)"\necho FINAL_PASS\n`,{mode:0o755});
  console.log(JSON.stringify({ok:true,evidence:path.relative(REPO,path.join(EVIDENCE_DIR,'run.json')),productSha:final.planHead,runIds:[initial.id,final.id],candidateSha,bundleSha,cleanClone:{initial:'FAIL_AS_EXPECTED',final:'PASS'}}));
}finally { try{sup.kill('SIGTERM')}catch{};await sleep(400);try{const s=JSON.parse(fs.readFileSync(path.join(root,'data/supervisor/state.json'),'utf8'));if(s.childPid>0)process.kill(s.childPid,'SIGTERM')}catch{};mock.close();}
