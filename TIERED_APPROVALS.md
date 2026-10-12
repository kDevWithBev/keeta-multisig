# Tiered approvals v3 (design, not wired in)

Status: design only. Nothing in the extension or in `scripts/` uses it. Not audited.
The sketch in `src/policy/tiered.mjs` follows the **older v2 design** and is now out of date. Where the two disagree, this doc wins: the sketch takes loan data from the caller, sets the KYC discount on by default and accepts plain numbers as amounts.

## Honest limitations (read first)

- **Tiers are enforced by software.** Keeta enforces the 2-of-3 quorum and nothing else. The network can't tell a small spend from a large one, and it doesn't know about locks.
- **The two bot keys meet the quorum without a human.** Signers are the keeper key (VPS), the cosigner key (separate VPS, Google Cloud KMS) and the human key (offline). The human is a **backstop**, not in the hot path. The protection comes from the cosigner refusing to sign anything that isn't a committed log entry, plus independent alerts and caps.
- **The lock is off-chain.** Representatives refuse blocks whose time is more than about 5 minutes off, so nothing is pre-signed. A locked spend is a stored proposal; the block is built fresh and signed at release.
- **If the keeper and cosigner are both compromised, every rule here can be bypassed.** The keys must be on separate hosts, providers and credentials.

Safer alternative still stands: keep automated spends on a capped hot account and use the multisig only for refills (see Open items, C2).

## Definitions

- **Spend:** any USDC (or other token) leaving a KeeLend **payout address** that is tied to a loan: loan funding, liquidation payout, refund or sweep. Every spend must match exactly one committed log entry.
- **Amounts:** integer base units as strings in the log (USDC has 6 decimals, so `"100000000"` = 100 USDC). Never floats.
- **Points:** integer **millipoints** (1 point = 1000), so score math has no floating point.
- **Release:** the cosigner and keeper both sign a freshly built block that sends the spend; the spend counts as sent once the block is published and found on-chain by hash.
- **On time:** decided by the ledger, not server clocks (see Ledger time below).

### Ledger time (what "the block is the clock" means on Keeta)

The owner's intent: the ledger is the clock, so a repayment that lands at or before the deadline is on time.

What we checked in `@keetanetwork/keetanet-client` 0.18.7 (`lib/block/index.d.ts`, `lib/vote.d.ts`): Keeta is a **per-account block lattice**. Each block has `previous` (the hash of that account's prior block) and a `date`, and votes carry `validityFrom`/`validityTo`. There is **no global block number** shared across accounts, so "repayment block number ≤ deadline block number" can't be compared directly. A block's `date` is set by its builder, but representatives only accept blocks whose `date` is within about 5 minutes of their own clocks.

**Rule chosen:** a repayment is **on time if its block's network `date` ≤ the loan's deadline** (a UTC instant recorded in the loan's log entry when it is opened), **and** the block is confirmed on-chain. The roughly 5-minute tolerance the representatives allow is accepted. The anchor chain is used as a backstop: a repayment block that isn't confirmed before the **first anchor published after the deadline** is late, whatever its `date` says. The cosigner records the repayment block hash, its `date` and the on-time result in the log.

## Source of truth: the integrity log

The hash-chained integrity log is the **only** source of loan facts and payouts.

- **The cosigner writes; the keeper only reads.** The keeper reads the log and **proposes** the payouts it implies. It is a messenger, not a bookkeeper: it has no key that can write to the log, and nothing it says becomes a fact.
- **The cosigner writes loan entries only after checking the on-chain facts itself**, never from data the keeper provides:
  - the borrower's collateral deposit block to the vault (looked up by hash on-chain),
  - the collateral amount and token,
  - the borrower address (the deposit's sender),
  - the price inputs (spot and 30-minute average from its own sources, with the same sanity bounds as before),
  - repayments, from their on-chain blocks (see Ledger time).
- **The cosigner signs a payout only if it matches a committed log entry:** same op, loan id, amount, token, destination and source account, not already paid, and every check below passes. Anything else is refused and raises an alert.
- **The human signer is a backstop:** freeze (trip the breaker), force review of a pending item, cancel a locked item, or recover funds with the offline key plus one bot key. The human isn't needed for normal operation.

### Log format (supersedes the keeper's trust log)

- This log **replaces** the keeper's existing trust log (`keeper/trustlog.mjs` in keelend-ops). That log becomes **legacy and read-only**. Nothing new is written to it, and when the two disagree the hash-chained integrity log wins.
- Format: **keep the existing one.** JSON Lines; `hash = sha256(canonical(record without hash and sig))`, with canonical = sorted keys, no whitespace, integers only (RFC 8785 for the values used); `seq` with no gaps; `prevHash`; and `sig` from the log-write key. Amounts are base-unit strings and points are integer millipoints. (An earlier draft said SHA3-256; that's dropped so the logs match.)
- Entries are never edited in place. A correction is a new entry that references the one it corrects.

## Keys on the cosigner (three separate KMS keys)

| Key | Signs | Notes |
|---|---|---|
| Multisig signing key | Payout blocks | One of the 2-of-3 signers. |
| Log-write key | Integrity log entries | Never signs blocks. |
| Anchor key | Anchor blocks from a dedicated anchor account | Separate from the other two. An optional second anchor key in **another KMS region** can be used for failover. |

### Cosigner host and IAM

- **No JSON key file on the VPS.** It uses Workload Identity Federation (or the host's attached identity), with short-lived tokens.
- **Sign-only** permission (`cloudkms.signerVerifier` or narrower) on these specific key versions, and nothing else: no key admin, no export, no other projects.
- **Strict signing service.** The only code path to KMS accepts only:
  1. a block whose hash and operations match a payout already committed in the log, or
  2. an anchor block that contains the current head hash of the log.
  Everything else is rejected before KMS is called.
- **Every sign call raises an alert** (op, loan id, amount, destination, block hash). KMS Cloud Audit Logs (data access) are turned on and exported off the host, and the audit log is checked against the integrity log.
- A compromised cosigner VPS can still *use* the keys within these rules. That's why alerts, the community watcher and caps matter.

## Anchoring

- The cosigner anchors the **current head hash** of the log to Keeta on a schedule (for example hourly) using the anchor key. Anchors are **hash checkpoints**: one anchor covers every entry before it.
- **A missed or late anchor doesn't break anything.** The next anchor simply records the current head, which covers everything since the last one.
- **Anchor gap alert:** if no anchor appears within the threshold (for example 2× the schedule), an alert fires from the cosigner side and from the watchers.
- An anchor proves the log was in that state at that time. It does **not** prove the entries are true; that's what the cosigner's on-chain checks and the watchers are for.

## Alerts (independent of the keeper)

Alerts come from the cosigner and integrity-log side, and from community watchers, **never only from the keeper**, so a compromised keeper can't hide them. They fire on: every sign call, any refused signing request, a failed check, a breaker trip, a stuck send, an anchor gap, a chain break, and a spend with no matching entry.

## Tiers

| Amount | Path |
|---|---|
| ≤ `instantMaxUsdc` (default **100**) | Released after the checks pass and the 60s minimum delay. |
| > `instantMaxUsdc` | Locked (see lock length). Checks rerun during the lock and right before release. The human can cancel or force review at any time. |

KTA is valued at the **lower** of spot and the 30-minute average.

## Checks (cosigner, independently, against the log)

At proposal time, every `rescanIntervalMs` (15 min) during a lock, and just before signing:

1. A committed log entry exists for this exact op, loan, amount, token, source and destination.
2. The destination fits the op: the borrower recorded from the deposit block, the source address for a refund, or a KeeLend account.
3. Price sanity: spot strictly between $0.01 and $5, and spot within 3% of the 30-minute average; the loan state allows the op (for example, a liquidation needs LTV ≥ 52%).
4. Not already sent, locked, held or stuck.
5. Budgets and rate limit.
6. The breaker isn't tripped.

A failed check moves the item to `held`. A tamper-type failure (no entry, or an amount or destination mismatch) also trips the breaker.

## Off-chain protections (defaults)

| Setting | Default |
|---|---|
| `instantMaxUsdc` | 100 |
| `lockDelayMs` | 24h |
| `minProposalAgeMs` | 60 s |
| `perTxMaxUsdc` (refuse above) | 1,000 |
| `rolling24hLimitUsdc` | 1,500 |
| `perDestination24hLimitUsdc` | 500 |
| `maxSendsPerHour` | 10 |
| Breaker | volume spike, 3 failures in 1h, any tamper failure, chain break, anchor mismatch |
| Breaker reset | Manual only, by the human |

## Lock length: KYC and repayment score (v2 rules, under review)

These are unchanged from v2, but see Open items H1 and H2. **The KYC discount is off by default** (`kycMultiplier: 1`) until the issuer names are pinned.

```
if amount <= instantMax:                lock = 0
lock = baseLock (24h)
if kyc (only once issuers are pinned):  lock ×= 0.5
tier multiplier: gold 0.25 · silver 0.5 · bronze 0.75 · new 1.0
if pastDefault or (tier == new and !kyc): lock = max(lock, 48h)
lock = clamp(lock, floor, 48h)
```

Score (millipoints): `points = min(repaid/10 USDC, 10) × min(daysOpen/7, 1)`, computed in integers, per on-time loan. Late = drop one tier; liquidation or default = 0 and `pastDefault`. Tiers: new < 1, bronze ≥ 1, silver ≥ 5, gold ≥ 15 points. Every change is a log entry written by the cosigner from on-chain repayment facts.

## Lifecycle

`proposed → releasing → sent` · `proposed → locked → releasing → sent` · `locked → cancelled | held` · `releasing → stuck-send` (look the block up by hash; never resend). A missed 5-minute window means building a fresh block within the same release decision.

## Community watcher

Anyone can run a copy. It needs no keys.

- **Fetcher:** polls the Keeta explorer or API for USDC (and other token) transactions on the published payout addresses.
- **Reader:** pulls log entries and checks the chain (sha256, `prevHash`, `seq`, signatures by the published log-write public key) against the published anchors.
- **Comparator:** flags any spend without a committed entry, an amount or destination mismatch, an anchor gap past the threshold, and chain breaks or anchor mismatches.

KeeLend publishes this spec, the payout, vault and anchor account addresses, the log-write public key, the anchor schedule and the log itself, so watchers are independent. Borrower addresses in a public log are a privacy trade-off, so publish addresses only, with no personal data.

If Keeta adds smart contracts later, payout rules could move on-chain, and the watcher and log become an audit trail rather than the enforcement.

## Open items (from the independent review)

| ID | Item | Status |
|---|---|---|
| C1 | Loan data from the keeper | **Resolved in v3**: the cosigner verifies on-chain and writes the log. |
| C3 | Alerts and cancel on the keeper | **Resolved in v3**: alerts from the cosigner and watchers; human backstop. |
| C2 | No human limit on automated spends | Open. Add a daily auto-release cap that only the human can raise, well under 1,500, or use a capped hot account for small spends. |
| H1 | Reputation shortens a lock that protects against key compromise | Open. Keep a fixed security floor (suggested 24h for anything over $100); let the score affect loan terms only, or require the human to go below the floor. |
| H2 | One lock rule for every op | Open. Set rules per op; liquidations need a fast path with tight checks, not a 24–48h lock. |
| H3–H5 | Cosigner holds several keys; KMS credentials; two logs | **Addressed in v3** (separate keys, IAM, strict signer, one log). The cosigner is still a high-value target. |
| — | Input validation | Open. BigInt amounts only, `daysOpen ≥ 0`, finite values, config validated at startup. The sketch needs updating. |
| — | KYC discount | Off by default (doc). The sketch still defaults to 0.5. |
| — | Anti-gaming | Open. Higher thresholds, score decay, a minimum number of distinct loans, a points cap per window, and limits on reusing KYC certificates. |
| — | Breaker vs rate limit | Open. The breaker trips at the same 10/hour as the rate limit; move it above the rate limit. |
| — | Runbooks | Open. Broken chain or anchor mismatch (freeze, find the divergence, re-anchor after the human reviews) and cosigner or KMS downtime (human key plus keeper key to move funds to safety). |

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
