/**
 * Tiered approval policy - SKETCH, not wired into the extension or scripts.
 * Off-chain only: the Keeta network enforces the multisig quorum, not tiers.
 * See TIERED_APPROVALS.md. Amounts are integer USDC base units (BigInt).
 */

export const USDC_DECIMALS = 6n;
const usdc = (n) => BigInt(n) * 10n ** USDC_DECIMALS;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_POLICY = Object.freeze({
  thresholdUsdc: usdc(300),
  rolling24hLimitUsdc: usdc(600),
  perDestination24hLimitUsdc: usdc(300),
  approvalTtlMs: DAY_MS,
  signWindowMs: 5 * 60 * 1000,
  ops: Object.freeze({
    'loan-funding': { auto: true, dest: 'borrower' },
    'liquidation-payout': { auto: true, dest: 'borrower-or-keelend' },
    'refund': { auto: true, dest: 'source' },
    'sweep': { auto: false, dest: 'keelend' }
  })
});

/**
 * @param {object} p  { op, loanId, to, amount (BigInt, USDC base units), reason }
 * @param {object} ctx { loan: {borrower, source, expectedAmount}, keelendAccounts:Set,
 *                       ledger: [{at, to, amount}], inFlight:Set<string>, now:number }
 * @returns {{decision:'auto'|'queue'|'deny', reason:string}}
 */
export function decide(p, ctx, policy = DEFAULT_POLICY) {
  const rule = policy.ops[p.op];
  if (!rule) return { decision: 'deny', reason: 'unknown op' };
  if (typeof p.amount !== 'bigint' || p.amount <= 0n) return { decision: 'deny', reason: 'bad amount' };
  if (ctx.inFlight.has(`${p.op}:${p.loanId}`)) return { decision: 'deny', reason: 'already sent, queued or stuck' };

  const loan = ctx.loan || {};
  const toBorrower = p.to === loan.borrower;
  const toKeelend = ctx.keelendAccounts.has(p.to);
  const destOk = {
    'borrower': toBorrower,
    'borrower-or-keelend': toBorrower || toKeelend,
    'source': p.to === loan.source,
    'keelend': toKeelend
  }[rule.dest];
  if (!destOk) return { decision: 'deny', reason: 'destination not allowed for op' };
  if (p.op === 'loan-funding' && p.amount !== loan.expectedAmount) {
    return { decision: 'deny', reason: 'amount does not match loan record' };
  }

  if (!rule.auto) return { decision: 'queue', reason: `${p.op} always needs a human` };
  if (p.amount >= policy.thresholdUsdc) return { decision: 'queue', reason: 'at or above threshold' };

  // Fail closed if the ledger is missing.
  if (!Array.isArray(ctx.ledger)) return { decision: 'queue', reason: 'ledger unavailable' };
  const since = ctx.now - DAY_MS;
  let total = 0n, toDest = 0n;
  for (const e of ctx.ledger) {
    if (e.at <= since) continue;
    total += e.amount;
    if (e.to === p.to) toDest += e.amount;
  }
  if (total + p.amount > policy.rolling24hLimitUsdc) return { decision: 'queue', reason: '24h limit would be exceeded' };
  if (toDest + p.amount > policy.perDestination24hLimitUsdc) return { decision: 'queue', reason: '24h destination limit would be exceeded' };
  return { decision: 'auto', reason: 'below threshold and limits' };
}

/** Queue item lifecycle. Expired or rejected items go to 'held' and are never resent automatically. */
export function nextState(item, event, now, policy = DEFAULT_POLICY) {
  if (item.state === 'awaiting-approval') {
    if (event === 'reject') return 'held';
    if (now - item.queuedAt > policy.approvalTtlMs) return 'held';
    if (event === 'approve') return 'signing'; // build a FRESH block now
  }
  if (item.state === 'signing') {
    if (event === 'published') return 'sent';
    if (event === 'window-missed') return 'awaiting-approval'; // needs a new click
    if (event === 'unknown') return 'stuck-send'; // look up by hash; never resend
  }
  return item.state;
}
