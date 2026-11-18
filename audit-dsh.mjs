import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';
import {getConfig} from './src/config.js';import {openStore} from './src/db.js';import {EventBus} from './src/bus.js';import {Orchestrator} from './src/orchestrator.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-dd-product-check-')), repo=path.join(root,'repo'), fixture=path.join(root,'local-auditor.cjs'), observed=path.join(root,'seen.json');
const clause='product.txt reads ready on the final commit.';
const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'}).trim();fs.mkdirSync(repo);
process.env.WORKBENCH_ROOT=root;process.env.WORKBENCH_DATA_DIR=path.join(root,'data');
git('init','-q','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
fs.writeFileSync(path.join(repo,'product.txt'),'old');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
git('checkout','-qb','plan');fs.writeFileSync(path.join(repo,'product.txt'),'ready');git('commit','-qam','candidate');const head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
fs.writeFileSync(fixture,`#!/usr/bin/env node
const fs=require("node:fs");const text=fs.readFileSync(0,"utf8"); const file=fs.readFileSync("product.txt","utf8");
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({file,text}));const status=file==="ready"?"pass":"fail";
console.log(JSON.stringify({type:"final",text:JSON.stringify({criteria:[{criterion:${JSON.stringify(clause)},status,evidence:"product.txt:1 observed file value = "+file}],findings:[],summary:"inspected files"})}));`,{mode:0o700});
const cfg=getConfig({agents:{dsh:{bin:fixture}},audit:{provider:'dsh'},llm:{deepseek:{apiKey:''}},budget:{maxTotalTokens:1000000,maxCostCny:100}});
const store=openStore(cfg.paths.dbPath);try{store.createProject({id:'p',name:'p',localPath:repo});const project={...store.getProject('p'),audit_provider:'dsh'};
const o=new Orchestrator({config:cfg,store,bus:new EventBus()});const task={id:'t',agent_kind:'claude',head_commit:head,result_json:{commit:head,testedHash:tree,testCommand:'node --test',testCode:0,testStdout:'ok',testDurationMs:10}};
let failures=0;
for(const checkout of ['plan','main']){git('checkout','-q',checkout);const res=await o.productAcceptanceAudit({project,expected:[clause],planHead:head,baseCommit:base,latestTask:task});const seen=fs.existsSync(observed)?JSON.parse(fs.readFileSync(observed)):{};const prompt=String(seen.text||'');const observedRow={checkout,pinnedFile:git('show',head+':product.txt'),fileSeen:seen.file,pass:res.ok,status:res.status,reason:res.reason,id:head,promptBindsTree:prompt.includes('tested tree hash: '+tree),promptBindsCommit:prompt.includes('final commit (如已存在): '+head),trueTree:tree,commandLine:prompt.match(/命令：[^\n]*/)?.[0],exitLine:prompt.match(/退出码：[^\n]*/)?.[0]};console.log(JSON.stringify(observedRow));
 if(seen.file!=='ready'||res.status!=='PASS'||!observedRow.promptBindsTree||!observedRow.promptBindsCommit||observedRow.exitLine!=='退出码：0') failures++;
}
if(failures){console.error('DSH audit version binding failed for '+failures+' checkout(s)');process.exitCode=1;}
}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
