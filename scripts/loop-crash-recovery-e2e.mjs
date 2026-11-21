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
import { openStore } from '../src/db.js';

const NODE = process.execPath;
const REPO = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); }); }
async function waitHealth(port, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* retry */ } await sleep(200); } return false; }
async function api(port, token, method, p, body) { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-workbench-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let data = null; try { data = await res.json(); } catch { /* ignore */ } return { status: res.status, data }; }
async function waitFor(fn, ms = 60_000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (err) { last = err; } await sleep(200); } throw new Error('timeout: ' + String(last)); }

const root=fs.mkdtempSync(path.join(os.tmpdir(),'wbh-chain-'));
const repo=path.join(root,'product'),productTest='node --test tests/product.test.cjs', clause='The formatter produces the exact uppercase READY response';
const bare=path.join(root,'github.com','fixture','repo.git'); fs.mkdirSync(path.dirname(bare),{recursive:true}); spawnSync('git',['init','--bare','-q',bare]);
const remoteBranchSha=(b)=>{const r=spawnSync('git',['rev-parse',`refs/heads/${b}`],{cwd:bare,encoding:'utf8'});return (r.stdout||'').trim();};
const doGit=(args,cwd=repo)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
fs.mkdirSync(path.join(repo,'tests'),{recursive:true});
fs.writeFileSync(path.join(repo,'tests/product.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('formatter returns a word',()=>assert.match(require('../format.cjs')(), /^[a-zA-Z]+$/));\n");
fs.writeFileSync(path.join(repo,'TEST_PLAN.json'),JSON.stringify({acceptance:[clause]}));
doGit(['init','-b','main','-q']);doGit(['config','user.name','fixture']);doGit(['config','user.email','fixture@example.invalid']);doGit(['add','-A']);doGit(['commit','-qm','contract']);
const baseline=doGit(['rev-parse','HEAD']);const contract=doGit(['rev-parse','HEAD:TEST_PLAN.json']);
doGit(['remote','add','origin',bare]);doGit(['push','-q','origin','main']);
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

let prCreates = 0; let prIdentity = null; let draftExists = false; let ciGate = true; let ciStartedResolve = null; let releaseCi = null; const ciStarted = new Promise((r) => { ciStartedResolve = r; });
const ghApi = http.createServer(async (req, res) => {
  let bodyText=''; for await (const c of req) bodyText+=c;
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/repos/fixture/repo') return send(200, { default_branch: 'main' });
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'GET') { if (!draftExists) return send(200, []); const branch = new URL(req.url,'http://x').searchParams.get('head')||''; const ref = branch.includes(':')?branch.slice(branch.indexOf(':')+1):branch; const sha = spawnSync('git',['rev-parse',`refs/heads/${ref}`],{cwd:bare,encoding:'utf8'}).stdout.trim(); return send(200, [{ number: 21, html_url: 'https://example.invalid/pr/21', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref, sha, repo: { full_name: 'fixture/repo' } } }]); }
  if (u.pathname === '/repos/fixture/repo/pulls' && req.method === 'POST') { prCreates += 1; const body = bodyText ? JSON.parse(bodyText) : {}; draftExists = true; prIdentity = { number: 21, html_url: 'https://example.invalid/pr/21', state: 'open', draft: true, base: { ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { ref: body.head || '', sha: remoteBranchSha(body.head), repo: { full_name: 'fixture/repo' } } }; return send(201, prIdentity); }
  if (u.pathname === '/repos/fixture/repo/pulls/21' && req.method === 'GET') return send(200, prIdentity);
  if (u.pathname === '/repos/fixture/repo/actions/runs') { ciStartedResolve(); const sha = u.searchParams.get('head_sha') || ''; if (ciGate) await new Promise((r) => { releaseCi = r; }); return send(200, { workflow_runs: [{ id: 21, name: 'ci', status: 'completed', conclusion: 'success', head_sha: sha, html_url: 'https://example.invalid/ci/21' }] }); }
  return send(404, { message: 'not found' });
});
await new Promise((r) => ghApi.listen(0, '127.0.0.1', r));

const port=await freePort(),token='test-token-supervisor-0001';
const env={PATH:process.env.PATH,HOME:root,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:path.join(root,'data'),WORKBENCH_PROJECTS_DIR:path.join(root,'projects'),WORKBENCH_API_TOKEN:token,WORKBENCH_HOST:'127.0.0.1',WORKBENCH_PORT:String(port),DEFAULT_AGENT:'custom',CUSTOM_AGENT_BIN:agent,CUSTOM_AGENT_ARGS:'',AUDIT_PROVIDER:'openai',OPENAI_API_KEY:'dummy-local',OPENAI_BASE_URL:'http://127.0.0.1:'+mock.address().port+'/v1',OPENAI_AUDIT_MODEL:'fixture-audit',AUDIT_REQUIRE_INDEPENDENT:'false',GITHUB_PUSH:'true',GITHUB_TOKEN:'fixture-token',GITHUB_API_BASE:'http://127.0.0.1:'+ghApi.address().port,GITHUB_CREATE_PR:'true',POLICY_AUTO_PUSH:'true',CI_POLL_ATTEMPTS:'1',CI_POLL_INTERVAL_MS:'10',GITHUB_AUTO_CREATE_REPO:'false',MAX_TOTAL_TOKENS:'10000000',MAX_COST_CNY:'100',MAX_TOKENS_PER_TASK:'600000'};
const logp=path.join(root,'sup.log'),out=fs.openSync(logp,'a');const sup=spawn(NODE,[path.join(REPO,'supervisor/workbench-supervisor.mjs'),'--root',root,'--port',String(port),'--max-restarts','2'],{cwd:root,env,stdio:['ignore',out,out]});
try{
 assert.ok(await waitHealth(port),fs.readFileSync(logp,'utf8'));
 const reg=await api(port,token,'POST','/api/projects',{name:'Host-only audit fixture',repo,defaultBranch:'main',testCommand:productTest,agentKind:'custom',auditProvider:'openai',ciRequired:true,supervisorManaged:true,remotePushAuthorized:true,protectTests:true,contractFiles:['TEST_PLAN.json'],testPlan:{acceptance:[clause]},testIsolation:'none',publish:true});
 assert.equal(reg.status,201,JSON.stringify(reg));const projectId=reg.data.data.id;
 const result=await api(port,token,'POST','/api/projects/'+projectId+'/loops',{goal:clause,mode:'queue',maxRounds:4,queue:[{title:'Implement the word formatter',description:'Create the formatter.',agent:'custom',acceptance:['The formatter returns a word'],testCommand:productTest}]});
 assert.equal(result.status,201,JSON.stringify(result));const loopId=result.data.data.id;
 // 等待第一次 CI 轮询（此时 Draft 动作已 done、CI action 尚未写入）后 SIGKILL。
 await ciStarted;
 const dbPath=path.join(root,'data/workbench.db');
 const st0=openStore(dbPath);
 const runs0=st0.listRuns().filter(r=>r.project_id===projectId);
 const finalRun0=runs0.find(r=>r.result_json?.productAcceptance==='PASS')||runs0[0];
 const actions0=finalRun0?st0.listActions(finalRun0.id):[];
 const attemptsBefore=finalRun0?finalRun0.id&&(st0.listTasks({runId:finalRun0.id}).reduce((n,t)=>n+st0.listAttempts(t.id).length,0)):0;
 const auditsBefore=finalRun0?st0.listTasks({runId:finalRun0.id}).reduce((n,t)=>n+st0.listAudits(t.id).length,0):0;
 assert.ok(actions0.some(a=>a.type==='github-pr'&&a.status==='done'),'Draft action must be done before crash');
 assert.ok(!actions0.some(a=>a.type==='github-ci'),'CI action must be absent before crash');
 st0.close();
 let childA=0; try { childA=Number(JSON.parse(fs.readFileSync(path.join(root,'data/supervisor/state.json'),'utf8')).childPid||0); } catch { /* ignore */ }
 try { sup.kill('SIGKILL'); } catch { /* ignore */ } if (childA) { try { process.kill(childA,'SIGKILL'); } catch { /* ignore */ } }
 await sleep(800);
 ciGate = false; if (releaseCi) releaseCi();
 // 真实重启 B，恢复窗口：认领原 Draft + 续建 CI action。
 const portB=await freePort();
 const supB=spawn(NODE,[path.join(REPO,'supervisor/workbench-supervisor.mjs'),'--root',root,'--port',String(portB),'--max-restarts','2'],{cwd:root,env:{...env,WORKBENCH_PORT:String(portB)},stdio:['ignore',fs.openSync(path.join(root,'supB.log'),'a'),fs.openSync(path.join(root,'supB.log'),'a')]});
 try {
   assert.ok(await waitHealth(portB,120000),fs.readFileSync(path.join(root,'supB.log'),'utf8'));
   const end=Date.now()+120000; let runNow=null;
   while(Date.now()<end){const st=await api(portB,token,'GET',`/api/runs/${finalRun0.id}`);runNow=st.data?.data;if(runNow?.verification_status==='CI_PASSED')break;await sleep(400);}
   assert.equal(runNow?.verification_status,'CI_PASSED',JSON.stringify(runNow?.stop_reason||runNow));
   const loopNow=(await api(portB,token,'GET',`/api/loops/${loopId}`)).data.data;
   assert.ok(['completed','running'].includes(loopNow.status),loopNow.status);
   const acc=await api(portB,token,'POST',`/api/runs/${finalRun0.id}/accept`,{});
   assert.equal(acc.status,200,JSON.stringify(acc));
   const st1=openStore(dbPath);
   const runs1=st1.listRuns().filter(r=>r.project_id===projectId);
   const attemptsAfter=finalRun0.id?st1.listTasks({runId:finalRun0.id}).reduce((n,t)=>n+st1.listAttempts(t.id).length,0):0;
   const auditsAfter=finalRun0.id?st1.listTasks({runId:finalRun0.id}).reduce((n,t)=>n+st1.listAudits(t.id).length,0):0;
   const actions1=st1.listActions(finalRun0.id);
   st1.close();
   assert.equal(runs1.length,runs0.length,'recovery must not create new Runs');
   assert.equal(attemptsAfter,attemptsBefore,'recovery must not rerun coding');
   assert.equal(auditsAfter,auditsBefore,'recovery must not rerun product audit');
   assert.equal(prCreates,1,'exactly one Draft');
   assert.ok(actions1.some(a=>a.type==='github-ci'),'CI action must be persisted');
   const candidateSha=process.env.CANDIDATE_SHA||spawnSync('git',['rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8'}).stdout.trim();
   const evidenceDir=path.resolve(process.env.LOOP_CRASH_EVIDENCE_DIR||'demo/evidence/loop-crash-recovery');
   fs.mkdirSync(evidenceDir,{recursive:true});
   fs.writeFileSync(path.join(evidenceDir,'run.json'),JSON.stringify({kind:'loop-crash-recovery',candidateSha,projectId,loopId,runId:finalRun0.id,prCreates,draftActionDone:true,ciActionAbsentBeforeCrash:true,attemptsBefore,attemptsAfter,auditsBefore,auditsAfter,runsBefore:runs0.length,runsAfter:runs1.length,verificationStatus:runNow.verification_status,loopStatus:loopNow.status,acceptedStatus:acc.data.data.status,acceptedSha:acc.data.data.result_json?.acceptedSha,at:new Date().toISOString()},null,2));
   console.log(JSON.stringify({ok:true,evidence:path.relative(REPO,path.join(evidenceDir,'run.json')),prCreates,attemptsBefore,attemptsAfter,auditsBefore,auditsAfter,acceptedSha:acc.data.data.result_json?.acceptedSha}));
 } finally { try{supB.kill('SIGKILL');}catch{}; try{const s2=JSON.parse(fs.readFileSync(path.join(root,'data/supervisor/state.json'),'utf8'));if(s2.childPid)process.kill(s2.childPid,'SIGKILL');}catch{} }
}finally { try{sup.kill('SIGTERM')}catch{};await sleep(400);try{const s=JSON.parse(fs.readFileSync(path.join(root,'data/supervisor/state.json'),'utf8'));if(s.childPid>0)process.kill(s.childPid,'SIGTERM')}catch{};mock.close(); ghApi.close();}