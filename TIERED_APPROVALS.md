# Tiered approvals v2 (design, not wired in)

Status: design sketch. Nothing in the extension or in `scripts/` uses it. Not audited. The sketch is `src/policy/tiered.mjs`.

## Honest limitations (read first)

- **Tiers are enforced by software.** Keeta enforces the 2-of-3 quorum and nothing else. The network can't tell a small spend from a large one, and it doesn't know about the lock.
- **The bot holds two keys:** the keeper key and a separate cosigner key. Together they meet the quorum without a human. Spends of $100 or less therefore have **no human protection**, and larger spends are protected only by the delay, the checks and the human's ability to cancel. The human doesn't sign.
- **The keys must be on separate infrastructure:** a different host, provider and set of credentials. If one compromise reaches both keys, it can spend anything, and every rule here is bypassed. The cosigner must run its own checks. It must not trust the keeper's word.
- **The lock is off-chain.** Representatives refuse blocks older than about 5 minutes, so nothing is pre-signed. A locked spend is just a stored *proposal*. The block is built fresh and signed by both keys only at release.
- **The third key is for recovery.** The human's paper or hardware key is kept offline. With it plus one bot key, the human can move the funds to safety.

Safer alternative: keep automated spends on a capped hot account outside the multisig, and use the multisig only for refills.

## Tiers

| Amount (USDC value) | Path |
|---|---|
| ≤ `instantMaxUsdc` (default **100**) | Released immediately: both bot keys sign once the checks pass. |
| > `instantMaxUsdc` | Locked for `lockDelayMs` (default **24h**). The checks run again during the lock and at its end. The human can cancel at any time during the lock. If everything still passes at the end, both bot keys sign. |

KTA is valued at the **lower** of spot and the 30-minute average.

## Checks (run by the cosigner, independently)

These run at proposal time, every `rescanIntervalMs` during the lock (default 15 min), and once more just before signing:

1. The destination is on the allowlist for this op: the loan's borrower, the source address for a refund, or a KeeLend account.
2. The amount matches the loan record.
3. LTV and price sanity: spot is strictly between $0.01 and $5, spot and the 30-minute average agree within 3%, and the loan's state allows this op. For example, a liquidation payout requires LTV ≥ 52%.
4. No duplicate: the same `op:loanId` isn't already sent, locked, held or stuck.
5. Budgets and rate limit (below).
6. The circuit breaker isn't tripped.

If any check fails during the lock, the proposal goes to `held` (an alert is raised and nothing is sent). A failed check also trips the breaker when it looks like tampering: a destination or amount mismatch.

## Off-chain protections (defaults)

| Setting | Default |
|---|---|
| `instantMaxUsdc` | 100 |
| `lockDelayMs` | 24h |
| `minProposalAgeMs` (delay from proposal to settlement, even for instant spends) | 60 s |
| `perTxMaxUsdc` (hard cap; above it, refuse) | 1,000 |
| `rolling24hLimitUsdc` (all releases) | 1,500 |
| `perDestination24hLimitUsdc` | 500 |
| `maxSendsPerHour` | 10 |
| Breaker: volume spike | 24h total ≥ 80% of the limit within 1h, or `maxSendsPerHour` reached |
| Breaker: failures | 3 failed checks in 1h, or any tamper-type failure |
| Breaker reset | **Manual only**, by the human |

When the breaker trips, **all** sends pause, instant ones included. Locks keep counting down, but nothing releases until the breaker is reset.

## Lifecycle

`proposed → (instant) releasing → sent`
`proposed → locked → releasing → sent`
`locked → cancelled` (by the human) · `locked → held` (failed check) · `releasing → stuck-send` (unknown outcome: look the block up by hash and never resend)

Nothing in `held`, `cancelled` or `stuck-send` is ever resent automatically. If the 5-minute signing window is missed, the spend goes back to `releasing` and gets a fresh block, while still inside the same release decision.

## What the human sees

Each locked item shows: the op, `loanId`, amount and token, destination, why it's locked, the time left, the result of the latest scan, and a **Cancel** button. Alerts fire on a failed check, a breaker trip or a stuck send.

## Not covered

- How the cosigner is deployed and how its keys are stored.
- Storing the ledger and queue so they survive restarts. These must fail closed: if either can't be read, release nothing.
- An audit.
