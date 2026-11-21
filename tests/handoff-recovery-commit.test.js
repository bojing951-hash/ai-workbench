// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startServer } from '../src/server.js';

// Real REST endpoint, store and Git. The fixture seeds an audited COMMITTING task.
// The worker dispatch boundary is intercepted so an incorrect requeue cannot spend money.
for (const scenario of ['normal', 'commit hook rejects', 'worktree changed']) {
  test('REST resume from committing: ' + scenario, {timeout: 20_000}, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-accept-commit-'));
    const oldEnv = {};
    const localEnv = {WORKBENCH_ROOT:root, WORKBENCH_DATA_DIR:path.join(root,'data'), WORKBENCH_PROJECTS_DIR:path.join(root,'projects'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:os.devNull};
    for (const [k, v] of Object.entries(localEnv)) { oldEnv[k] = process.env[k]; process.env[k] = v; }
    t.after(() => {
      for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(root, {recursive:true, force:true});
    });
    const config = getConfig({server:{host:'127.0.0.1',port:0}, github:{token:'',push:false,createPr:false}, budget:{maxTotalTokens:3000000,maxCostCny:30,minReserveTokens:0}});
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    const planBranch = 'wb/plan--pre';
    const taskBranch = 'wb/rpre/t1';
    function git(cwd, ...args) {
      const r = spawnSync('git', args, {cwd, encoding:'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    }
    fs.mkdirSync(repo); git(repo,'init','-q','-b','main');
    git(repo,'config','user.name','Fixture'); git(repo,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(repo,'README.md'),'base\n'); git(repo,'add','.'); git(repo,'commit','-qm','base');
    const base = git(repo,'rev-parse','HEAD');
    git(repo,'worktree','add','-qb',taskBranch,wt); git(repo,'branch',planBranch,base);
    fs.writeFileSync(path.join(wt,'result.txt'),'verified\n');
    git(wt,'add','.'); const testedHash = git(wt,'write-tree');
    const store = openStore(config.paths.dbPath);
    let server;
    try {
      store.createProject({id:'p-pre',name:'fixture',localPath:repo,defaultBranch:'main'});
      store.createRun({id:'r-pre',projectId:'p-pre',planId:'pl-pre',goal:'fixture',mode:'single',status:'interrupted'});
      store.createPlan({id:'pl-pre',projectId:'p-pre',runId:'r-pre',goal:'fixture',title:'fixture',tasks:[]});
      store.createTasks([{id:'t-pre',projectId:'p-pre',planId:'pl-pre',runId:'r-pre',seq:1,title:'fixture',acceptance:['A'],status:'committing'}]);
      store.createAudit({id:'aud-pre',runId:'r-pre',taskId:'t-pre',provider:'mock',model:'mock',verdict:'pass',score:100,verificationStatus:'PASS',criteria:[]});
      store.updateTask('t-pre',{attempt:3,branch:taskBranch,worktree_path:wt,base_commit:base,
        verification_json:{baseCommit:base,testedHash,planBranch,auditId:'aud-pre',auditStatus:'PASS'}});
      if (scenario === 'commit hook rejects') {
        fs.writeFileSync(path.join(repo,'.git','hooks','pre-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
      }
      if (scenario === 'worktree changed') fs.writeFileSync(path.join(wt,'result.txt'),'unsaved edits\n');
      let paidCalls = 0;
      const forbidden = async () => { paidCalls++; throw new Error('unexpected model invocation'); };
      const o = new Orchestrator({config,store,bus:new EventBus(),deps:{runAgent:forbidden,runAudit:forbidden}});
      o.kick = () => {}; // inspect persistent state before any asynchronous redispatch
      server = await startServer({config,store,orchestrator:o,logger:{log(){}}});
      const token = fs.readFileSync(path.join(config.paths.dataDir,'api-token'),'utf8').trim();
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/runs/r-pre/resume',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({retryFailed:false})});
      const response = await res.text();
      assert.ok(res.status < 500, response);
      assert.equal(paidCalls, 0);
      const task = store.getTask('t-pre');
      const commits = Number(git(wt,'rev-list','--count',base+'..HEAD'));
      if (scenario === 'normal') {
        assert.equal(res.status,200,response); assert.equal(task.status,'passed'); assert.equal(commits,1);
        assert.equal(git(wt,'rev-parse','HEAD^{tree}'),testedHash);
        assert.equal(git(repo,'rev-parse',planBranch),task.head_commit);
        assert.equal(task.head_commit,git(wt,'rev-parse','HEAD'));
      } else {
        assert.equal(commits,0);
        assert.equal(git(repo,'rev-parse',planBranch),base);
        if (scenario === 'worktree changed') {
          assert.equal(fs.readFileSync(path.join(wt,'result.txt'),'utf8'),'unsaved edits\n');
          assert.equal(task.status,'blocked','diverged from audited tree, must block');
        } else {
          assert.ok(['committing','blocked'].includes(task.status),'commit hook rejection must retain recovery state; got ' + task.status);
        }
      }
      assert.equal(task.attempt,3,'resume must retain original attempt');
    } finally {
      if (server) await new Promise(done => server.close(done));
      store.close();
    }
  });
}
