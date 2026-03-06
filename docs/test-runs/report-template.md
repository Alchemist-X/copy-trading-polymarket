# Test Run Report Template

## Summary

- Date: `YYYY-MM-DD`
- Topic: `TBD`
- Branch / commit: `TBD`
- Wallet profile: `dry-run` / `testwallet` / `live-small-funds`

## Change Scope

- `TBD`

## Commands Run

```bash
npm run typecheck
npm run smoke:commands
npm run smoke:logs
# add any extra commands below
```

## UI Screenshots

| State | Screenshot Path | Expected | Actual |
|------|------|------|------|
| `A-initializing` | `TBD` | `TBD` | `TBD` |
| `B-activity-idle` | `TBD` | `TBD` | `TBD` |
| `C-live-events` | `TBD` | `TBD` | `TBD` |
| `D-monitor-tab` | `TBD` | `TBD` | `TBD` |
| `E-edit-mode` | `TBD` | `TBD` | `TBD` |
| `F-paused` | `TBD` | `TBD` | `TBD` |
| `G-dry-run` | `TBD` | `TBD` | `TBD` |
| `H-auto-redeem` | `TBD` | `TBD` | `TBD` |

## Dry-Run Results

- Startup: `TBD`
- Detection path: `TBD`
- Logging path: `TBD`
- Dashboard path: `TBD`

## Live E2E Results

Only fill this section when the change is release-gated.

| Scenario | Result | Evidence |
|------|------|------|
| `BUY -> detect -> copy success` | `TBD` | `TBD` |
| Intentional `SKIP` case | `TBD` | `TBD` |
| `pause` / `resume` / `edit` | `TBD` | `TBD` |
| `status` / `history` / `logs` consistency | `TBD` | `TBD` |
| Auto-redeem | `TBD` | `TBD` |

## Evidence

- History snapshot: `TBD`
- Engine log window: `TBD`
- Command logs: `TBD`
- Error logs: `TBD`
- Copy tx hashes: `TBD`
- Redeem tx hashes: `TBD`

## Known Issues / Gaps

- `TBD`

## Sign-Off

- Ready to merge: `yes/no`
- Follow-up needed: `TBD`
