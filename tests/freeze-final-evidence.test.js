import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { getConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { EventBus } from '../src/bus.js';
import { Orchestrator } from '../src/orchestrator.js';

const clause = 'product.txt reads ready on the final commit.';
for (const scenario of ['matched', 'previous-tree', 'legacy-no-receipt']) {
  test('product audit binds real test evidence to its commit: ' + scenario, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-product-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
    git('init','-q','-b','main'); git('config','user.name','QA'); git('config','user.email','fixture@example.invalid');
    const file = path.join(repo,'product.txt');
    const spec = path.join(repo,'product.test.mjs');
    function writeProduct(value) {
      fs.writeFileSync(file, value);
      fs.writeFileSync(spec, [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import {readFileSync} from 'node:fs';",
        `test('file value', () => assert.equal(readFileSync('product.txt','utf8'), ${JSON.stringify(value)}));`,
      ].join('\n'));
    }
    function testReceipt(label) {
      const env = {...process.env};
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'product.test.mjs'], {cwd: repo, env, encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);
      assert.match(r.stdout,/^# pass 1$/m);
      const log = path.join(root,label + '.tap');
      fs.writeFileSync(log,r.stdout);
      return {
        commit: git('rev-parse','HEAD'), testedHash: git('rev-parse','HEAD^{tree}'),
        testCommand: 'node --test --test-reporter=tap product.test.mjs',
        testCode:r.status, testStdout:r.stdout, testStderr:r.stderr, testArtifactLog:log,
      };
    }
    writeProduct('old'); git('add','.'); git('commit','-qm','base');
    const previous = testReceipt('base');
    git('switch','-qc','plan'); writeProduct('ready'); git('commit','-qam','candidate');
    const head=git('rev-parse','HEAD'), tree=git('rev-parse','HEAD^{tree}');
    let receipt;
    if (scenario==='matched') receipt=testReceipt('candidate');
    if (scenario==='previous-tree') receipt=previous;
    if (scenario==='legacy-no-receipt') receipt={commit:head};
    git('switch','-q','main');
    const observed=path.join(root,'received.txt');
    const cli=path.join(root,'local-audit.cjs');
    fs.writeFileSync(cli, [
      '#!/usr/bin/env node', "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(observed)}, fs.readFileSync(0,'utf8'));`,
      "const actual=fs.readFileSync('product.txt','utf8');",
      `const verdict={criteria:[{criterion:${JSON.stringify(clause)},status:actual==='ready'?'pass':'fail',evidence:'product.txt:1 reads '+actual}],findings:[],summary:'Read product.txt'};`,
      "console.log(JSON.stringify({type:'final',text:JSON.stringify(verdict)}));",
    ].join('\n'), {mode:0o700});
    const originalRoot=process.env.WORKBENCH_ROOT, originalData=process.env.WORKBENCH_DATA_DIR;
    process.env.WORKBENCH_ROOT=root; process.env.WORKBENCH_DATA_DIR=path.join(root,'data');
    t.after(() => {
      if(originalRoot===undefined) delete process.env.WORKBENCH_ROOT; else process.env.WORKBENCH_ROOT=originalRoot;
      if(originalData===undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR=originalData;
    });
    const config=getConfig({agents:{dsh:{bin:cli}},audit:{provider:'dsh'},llm:{deepseek:{apiKey:''}},budget:{maxTotalTokens:1000000,maxCostCny:100}});
    const store=openStore(config.paths.dbPath);
    t.after(()=>store.close()); store.createProject({id:'p',name:'p',localPath:repo});
    const project={...store.getProject('p'),audit_provider:'dsh'};
    const o=new Orchestrator({config,store,bus:new EventBus()});
    const task={id:'t',agent_kind:'claude',head_commit:receipt.commit,result_json:receipt};
    const result=await o.productAcceptanceAudit({project,expected:[clause],planHead:head,baseCommit:previous.commit,latestTask:task});
    console.log(JSON.stringify({scenario,head,tree,receiptCommit:receipt.commit,receiptTree:receipt.testedHash || null,
      originalTestCode:receipt.testCode ?? null, observedByAuditor:fs.existsSync(observed), result:result.status}));
    assert.equal(result.ok, scenario==='matched', 'final product PASS requires its own successful test evidence');
  });
}
