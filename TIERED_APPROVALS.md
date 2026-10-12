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

## Lock length: KYC and repayment score

The 24h lock for spends over $100 is the **base**. KYC and a borrower's repayment score adjust it. This is a borrower feature: repaying on time unlocks faster (and later cheaper) loans, which gives people a reason to come back.

### Repayment score (off-chain, can start tracking now)

- Stored in KeeLend's own records, keyed by **borrower address**. A **new address starts at 0**. The score follows the address, not the person.
- Earned per loan **repaid on time** (from on-chain repayments, cross-checked with KeeLend's records). Points are weighted by repaid amount and loan age, so many tiny, short loans can't build a score that unlocks one big loan:
  `points = min(repaidUsdc / 10, 10) × min(daysOpen / 7, 1)`, capped at 10 per loan.
- A late payment downgrades the score by one tier. A **liquidation or default resets it to 0** and sets `pastDefault = true`, which extends the lock (see below).
- Every score change is appended to the **trust log**, with the loan id, outcome, points and the score before and after, so anyone can check it.
- Tracking can start before anything ships. Suggested record, one per closed loan:

```json
{ "borrower": "keeta_...", "loanId": "...", "openedAt": "ISO", "closedAt": "ISO",
  "principalUsdc": "5.00", "repaidUsdc": "5.03", "outcome": "on-time|late|liquidated|default",
  "repayBlocks": ["<hash>"], "trustLogRef": "<entry id>", "points": 0.36 }
```

Derived per address: `{ score, tier, pastDefault, loansRepaid, updatedAt }`.

Score tiers (defaults): `new` < 1 · `bronze` ≥ 1 · `silver` ≥ 5 · `gold` ≥ 15.

### Lock-length formula (defaults, all configurable)

```
if amount <= instantMax:                lock = 0
lock = baseLock (24h)
if kyc:                                 lock ×= 0.5
tier multiplier: gold 0.25 · silver 0.5 · bronze 0.75 · new 1.0
if pastDefault or (tier == new and !kyc): lock = max(lock, extendedLock (48h))
lock = clamp(lock, lockFloor (1h), extendedLock (48h))
```

Examples: unverified new address gets 48h. KYC'd new address gets 12h. KYC'd gold gets 3h. Unverified silver gets 12h. A past default gets 48h. The 1h floor applies to every spend over $100 unless the owner sets `lockFloorMs` to 0.

### Safeguards (honest)

- The lock mainly protects against a **compromised bot or compromised keys**, not against borrowers failing to repay. A shorter lock gives you less time to catch a theft. That's the trade-off.
- Score and KYC **change only the lock length**. They never bypass the per-transaction cap, the 24h and per-destination budgets, the rate limit, the allowlist, the amount-matches-loan check, the duplicate check or the circuit breaker.
- An attacker who controls the bot could also edit the off-chain score. Use the score stored by the **cosigner** (rebuilt from the trust log and on-chain repayments), never a score the keeper supplies.
- KYC is checked as the keeper does today. Until issuer names are pinned, the KYC discount should stay off (`kycMultiplier: 1`).

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

## Schedule (rough timeframes)

A reminder of the expected order and effort. These are estimates, not commitments.

| Step | Rough time |
|---|---|
| Spec and doc updates | A day or two |
| VPS provisioning and key setup (cosigner host, separate from the keeper) | An afternoon |
| Keeper bot wiring to the multisig | Two to three days, if the testnet behaves |
| Discord outreach to Keeta Inc | Same day it's sent |
| **Total for a working testnet version** | **About a week end to end** |

- Reputation tracking can start now, in parallel, since it needs no new infrastructure: begin recording closed-loan outcomes in KeeLend's records.
- VPS deployment comes only after this doc lands (owner's decision).
- Mainnet use comes after the testnet version has run cleanly; no date is set.
