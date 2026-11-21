# Fixed-SHA trial install

Candidate: 发布回执中的完整 40 位 SHA（v3.3.0, Draft PR #15）

```bash
export SHA="<完整 40 位候选 SHA>"
git clone https://github.com/bojing951-hash/ai-workbench.git
cd ai-workbench
git checkout "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"

npm install --ignore-scripts --no-audit --no-fund
npm test
node scripts/install-acceptance-e2e.mjs

# verify the fixed SHA and result
node -e "const e=require('./demo/evidence/install-acceptance/run.json'); if(e.candidateSha!==process.env.SHA||e.installExitCode!==0||!e.acceptedSha) process.exit(1); console.log(e.candidateSha,e.acceptedSha)"

# start the workbench
npm start
```

Acceptance evidence from CI: `freeze-evidence-<sha>` artifact, see the Push/PR
CI links in the delivery report.
