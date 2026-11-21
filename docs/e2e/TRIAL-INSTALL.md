# Fixed-SHA trial install

Candidate: `__FINAL_SHA__` (v3.3.0, Draft PR #15)

```bash
git clone https://github.com/bojing951-hash/ai-workbench.git
cd ai-workbench
git checkout __FINAL_SHA__
test "$(git rev-parse HEAD)" = "__FINAL_SHA__"

npm ci
npm test
node scripts/install-acceptance-e2e.mjs

# verify the fixed SHA and result
node -e "const e=require('./demo/evidence/install-acceptance/run.json'); if(e.candidateSha!=='__FINAL_SHA__'||e.installExitCode!==0||!e.acceptedSha) process.exit(1); console.log(e.candidateSha,e.acceptedSha)"

# start the workbench
npm start
```

Acceptance evidence from CI: `freeze-evidence-<sha>` artifact, see the Push/PR
CI links in the delivery report.
