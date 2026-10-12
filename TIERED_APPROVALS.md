# Tiered approvals (design, not wired in)

Status: design sketch. Nothing in the extension or in `scripts/` uses it. Not audited. The sketch is `src/policy/tiered.mjs`.

## Read this first: what the network enforces

Keeta enforces the quorum of the multisig. Nothing else. A 2-of-3 needs two of its three keys on every spend, so one bot key alone cannot sign anything.

The tiers below are enforced **off-chain**, by software deciding when to add a signature. The network can't tell a "small" spend from a "large" one.

To let the bot approve small spends by itself, the bot side has to control **two** of the three keys, for example:
- the keeper key on the VPS, and
- a separate cosigner service key on different infrastructure (a different host and provider, with its own credentials).

The result:
- Small spends get **no human protection**. Their safety depends entirely on those two automated keys staying separate. If both are on the same VPS, or one compromise reaches both, an attacker can drain the account in "small" spends up to the limits below, and the limits are only as strong as the cosigner's own code.
- Large spends need the human key (browser profile or paper key) plus one bot key.

### Recommended alternative

Keep small, automated spends on a **capped hot account outside the multisig**, owned by the keeper alone. Hold that account at a small balance (for example one or two days of expected loan volume). Use the 2-of-3 only for:
- refilling the hot account (bot builds it, human countersigns), and
- any single spend at or above the threshold.

This gives the same day-to-day automation. The worst case on a keeper compromise is the hot balance, not the whole reserve, and the multisig keeps its 2-of-3 meaning. The policy below works for either setup; with the recommended setup, "auto-approve" means "spend from the hot account".

## Policy config

| Setting | Default | Meaning |
|---|---|---|
| `thresholdUsdc` | `300` | Spends below this per transaction may be auto-approved. At or above it, they're queued for a human. |
| `rolling24hLimitUsdc` | `600` | Total auto-approved USDC in any rolling 24 hours. Anything that would exceed it is queued, even if it's small on its own. This stops one large spend being split into many small ones. |
| `perDestination24hLimitUsdc` | `300` | Same, for one destination address. |
| `ops` | see below | Which kinds of spend the policy covers, and whether each kind may be auto-approved at all. |
| `approvalTtlMs` | `24h` | How long a queued item waits for a human before it expires. |
| `signWindowMs` | `5 min` | Keeta representatives refuse blocks older than about 5 minutes. The block is built fresh when the human approves. |

KTA amounts are valued in USDC at the **lower** of spot and the 30-minute average, so a price spike can't make a large spend look small.

Covered ops:
- `loan-funding`: USDC sent to a borrower when a vault funds. Auto-approval is allowed.
- `liquidation-payout`: unpaid principal to inventory, interest plus fee to treasury, surplus USDC or unseized KTA back to the borrower. Auto-approval is allowed only to known KeeLend accounts or to the loan's own borrower.
- `refund`: an expired vault or an overpayment going back to the sender. Auto-approval is allowed only back to the address the funds came from.
- `sweep`: moving funds between KeeLend accounts, such as a hot-account refill. Never auto-approved; a human always signs.

Anything else is **denied** unless explicitly listed.

## Decision flow per loan action

1. The keeper proposes `{ op, loanId, to, token, amount, reason }`.
2. Hard checks run first. Any failure means **deny**, not queue:
   - `op` is a known op.
   - `to` is allowed for that op: the borrower on record for `loanId`, the source address for a refund, or a KeeLend account.
   - The amount matches the loan record (for example, funding equals the opened amount).
   - The same `loanId` and op isn't already sent, queued or stuck. This matches the keeper's `keelend:<loanId>` replay rule.
3. Tier check:
   - op is `sweep` → **queue**
   - amount ≥ `thresholdUsdc` → **queue**
   - auto total in the last 24h plus this amount > `rolling24hLimitUsdc` → **queue**
   - destination total in the last 24h plus this amount > `perDestination24hLimitUsdc` → **queue**
   - otherwise → **auto**
4. **Auto:** the bot signs (with its two keys, or from the hot account) and the amount is added to the rolling ledger.
5. **Queue:** the loan goes to a held state (`awaiting-approval`), and nothing is sent.

## What the human sees

Each queued item shows up in the extension's approval view, or as a pasted payload, with:
- op, `loanId`, amount and token (raw and decimal), destination,
- **reason** (for example "≥ 300 USDC threshold" or "24h limit would be exceeded"),
- the loan's LTV and price inputs at queue time,
- when it was queued and when it expires.

The extension's existing checks still apply when the human signs:
- exactly one SEND,
- exactly two listed signers, one of them this profile,
- the block account is the storage account,
- the hash is stable.

The `statedOrigin` and `reason` fields are labels only; the human must check the block fields themselves.

## Timeout, rejection and expiry

- The block is **built fresh at approval time**, not at queue time, because both signatures must land within about 5 minutes of the block time. The flow is: human clicks approve → bot builds the block → bot adds its share → human adds theirs → publish.
- If that 5-minute window is missed, the item goes back to `awaiting-approval`, which needs a new click and a new block. It is never resent automatically.
- On a human rejection, or when `approvalTtlMs` runs out, the loan goes to `held`. Nothing is ever resent automatically. Moving on from `held` needs a new human decision.
- A send whose outcome is unknown follows the keeper's existing `stuck-send` rule: look up the block by hash, and never resend.

## Not covered

- Key storage for the cosigner service, and how it is deployed.
- Making the rolling ledger survive restarts. It must be stored and must fail closed: if it can't be read, queue everything.
- An audit. This is a sketch.
