import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/db.js';

// Disposable ordinary Workbench project, localhost transport only. The contracted Docker path is separate.
const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sup-planner-'));
for (const name of ['package.json','bin','src','supervisor']) fs.symlinkSync(path.join(codeRoot,name), path.join(root,name));
const repo=path.join(root,'repo'); fs.mkdirSync(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo});
git('init','-qb','main');git('-c','user.name=Audit','-c','user.email=audit@example.invalid','commit','--allow-empty','-qm','base');
fs.mkdirSync(path.join(root,'data'));
const dbpath=path.join(root,'data','workbench.db');
const store=openStore(dbpath);
store.createProject({id:'p',name:'offline ordinary fixture',localPath:repo,config:{supervisor_managed:true}});store.close();
const db=new DatabaseSync(dbpath, {readOnly:true});
const seen=[];
const local=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);seen.push({route:req.url,model:JSON.parse(Buffer.concat(chunks)).model}); /* intentionally no receipt */});
local.listen(0,'127.0.0.1');await once(local,'listening');
const portProbe=net.createServer();portProbe.listen(0,'127.0.0.1');await once(portProbe,'listening');const port=portProbe.address().port;
await new Promise(r=>portProbe.close(r));
const api='http://127.0.0.1:'+port;
const supervisor=spawn(process.execPath,[path.join(root,'supervisor/workbench-supervisor.mjs'),'--root',root,'--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,HOME:root,WORKBENCH_ROOT:root,WORKBENCH_DATA_DIR:path.join(root,'data'),PLANNER_PROVIDER:'openai',OPENAI_API_KEY:'fixture-only',OPENAI_MODEL:'loopback',OPENAI_BASE_URL:'http://127.0.0.1:'+local.address().port+'/v1',GIT_CONFIG_NOSYSTEM:'1'},stdio:'ignore'});
const supervisorFile = path.join(root,'data','supervisor','state.json');
const state=()=>JSON.parse(fs.readFileSync(supervisorFile));
const holds=()=>db.prepare('select id,request_key,status,estimated_tokens,usage_known from model_reservations order by created_at').all();
const loops=()=>db.prepare('select id,status,stop_reason from loops').all();
async function until(pred, ms=14000){const end=Date.now()+ms;while(Date.now()<end){try {const v=await pred();if(v)return v;}catch{} await delay(125);}throw new Error('fixture timed out: '+pred.toString());}
const healthy=async()=> (await fetch(api+'/api/health',{signal:AbortSignal.timeout(500)})).ok;
try {
 await until(healthy);
 const token=fs.readFileSync(path.join(root,'data','api-token'),'utf8').trim();
 const reply=await fetch(api+'/api/projects/p/loops',{method:'POST',headers:{'x-workbench-token':token,'content-type':'application/json'},body:JSON.stringify({goal:'inspect a local file',mode:'plan',maxRounds:2})});
 if(!reply.ok)throw new Error(await reply.text());
 await until(()=>seen.length===1);
 const oldPid=state().childPid;
 console.log('before',JSON.stringify({oldPid,seen:[...seen],holds:holds(),loops:loops()}));
 process.kill(oldPid,'SIGKILL');
 await until(async()=>state().childPid!==oldPid && await healthy(),22000);
 await until(()=>state().recoveries.length>0,15000);
 await delay(6000);
 const s=state();
 console.log('recovered',JSON.stringify({oldPid,nowPid:s.childPid,seen,holds:holds(),loops:loops(),reconciliations:s.recoveries.length,crashes:s.crashes.map(x=>[x.signal,x.pid])}));
} catch(err) {
 console.error('observation failure',err.message,JSON.stringify({seen,holds:holds(),loops:loops()}));
 try {console.error(fs.readFileSync(path.join(root,'data','supervisor','workbench.log'),'utf8').slice(-1300))}catch{}
 process.exitCode=1;
} finally {
 const exited=once(supervisor,'exit');supervisor.kill('SIGTERM');await exited;
 local.closeAllConnections();await new Promise(r=>local.close(r));db.close();fs.rmSync(root,{recursive:true,force:true});
}
