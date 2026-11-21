# Cross-process CI refresh baseline red (16639dc)

`scripts/ci-refresh-cross-process-e2e.mjs` was run in a detached worktree at
`16639dc5565723526420b3b734088f8d037d09b6` (baseline).

Two independent processes sharing the same SQLite database allocated CI refresh
sequences with the old `UPDATE ...; SELECT ...` implementation:

```
AssertionError [ERR_ASSERTION]: duplicate refresh seq in two processes: 10
10 !== 0
```

In the same run, the two process refresh responses also exposed duplicate
sequence numbers (the baseline test fails before the ordering assertions).
A direct two-process probe of `beginCiRefresh` reproduced duplicates
(for example sequences 58, 71, 354, 461, 463, 503 were each allocated twice
in 600 total allocations).

Fixed implementation uses one atomic statement:

```sql
UPDATE runs SET ci_refresh_seq=COALESCE(ci_refresh_seq,0)+1, updated_at=?
WHERE id=? RETURNING ci_refresh_seq
```

Fixed evidence: `demo/evidence/ci-refresh-cross-process/run.json`
(`atomicSeq.duplicates = 0`, 300 distinct sequences).

## Receipt consistency

The fixed test also writes the CI action receipt in the same SQLite transaction
as the Run. If the CI action row is removed before the response is released,
the whole transaction rolls back: `applied=false`,
`reason=action-receipt-write-failed`, Run stays `CI_PASSED`, and no CI action
row is recreated. Evidence: `demo/evidence/ci-refresh-cross-process/run.json`.
