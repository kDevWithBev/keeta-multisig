/**
 * Tiered approval policy v2 - SKETCH, not wired into the extension or scripts.
 * Off-chain only. The network enforces the 2-of-3 quorum, not tiers or locks.
 * Nothing is pre-signed: blocks are built and signed by both bot keys at release
 * (Keeta refuses blocks older than ~5 min). See TIERED_APPROVALS.md.
 * Amounts are integer USDC base units (BigInt).
 */

export const USDC_DECIMALS = 6n;
const usdc = (n) => BigInt(n) * 10n ** USDC_DECIMALS;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const DEFAULT_POLICY = Object.freeze({
  instantMaxUsdc: usdc(100),
  lockDelayMs: DAY,
  rescanIntervalMs: 15 * MIN,
  minProposalAgeMs: MIN,
  perTxMaxUsdc: usdc(1000),
  rolling24hLimitUsdc: usdc(1500),
  perDestination24hLimitUsdc: usdc(500),
  maxSendsPerHour: 10,
  breaker: Object.freeze({ spikeFraction1h: 0.8, maxFailures1h: 3 }),
  ops: Object.freeze({
    'loan-funding': 'borrower',
    'liquidation-payout': 'borrower-or-keelend',
    'refund': 'source',
    'sweep': 'keelend'
  })
});

/** Checks run at proposal, every rescan during the lock, and right before signing. */
export function runChecks(p, ctx, policy = DEFAULT_POLICY) {
  const fail = (reason, tamper = false) => ({ ok: false, reason, tamper });
  if (ctx.breaker?.tripped) return fail('circuit breaker tripped');
  const dest = policy.ops[p.op];
  if (!dest) return fail('unknown op', true);
  if (typeof p.amount !== 'bigint' || p.amount <= 0n) return fail('bad amount', true);
  if (p.amount > policy.perTxMaxUsdc) return fail('above per-tx cap');

  const loan = ctx.loan || {};
  const keelend = ctx.allowlist.has(p.to);
  const ok = {
    'borrower': p.to === loan.borrower,
    'borrower-or-keelend': p.to === loan.borrower || keelend,
    'source': p.to === loan.source,
    'keelend': keelend
  }[dest];
  if (!ok) return fail('destination not on allowlist for op', true);
  if (loan.expectedAmount !== undefined && p.amount !== loan.expectedAmount) {
    return fail('amount does not match loan record', true);
  }

  const { spot, twap } = ctx.price || {};
  if (!(spot > 0.01 && spot < 5) || !(twap > 0) || Math.abs(spot - twap) / twap > 0.03) {
    return fail('price sanity failed');
  }
  if (p.op === 'liquidation-payout' && !(loan.ltv >= 0.52)) return fail('loan not liquidatable');

  if (ctx.otherActive.has(`${p.op}:${p.loanId}`)) return fail('duplicate send', true);

  if (!Array.isArray(ctx.ledger)) return fail('ledger unavailable'); // fail closed
  let day = 0n, dayDest = 0n, hourCount = 0;
  for (const e of ctx.ledger) {
    if (e.at > ctx.now - DAY) { day += e.amount; if (e.to === p.to) dayDest += e.amount; }
    if (e.at > ctx.now - HOUR) hourCount++;
  }
  if (day + p.amount > policy.rolling24hLimitUsdc) return fail('rolling 24h budget');
  if (dayDest + p.amount > policy.perDestination24hLimitUsdc) return fail('per-destination 24h budget');
  if (hourCount >= policy.maxSendsPerHour) return fail('rate limit');
  return { ok: true };
}

/** Initial routing for a new proposal. */
export function route(p, policy = DEFAULT_POLICY) {
  return p.amount <= policy.instantMaxUsdc ? 'instant' : 'locked';
}

/** May both bot keys build and sign now? */
export function canRelease(item, checks, ctx, policy = DEFAULT_POLICY) {
  if (!checks.ok || ctx.breaker?.tripped) return false;
  if (item.state === 'cancelled' || item.state === 'held') return false;
  if (ctx.now - item.proposedAt < policy.minProposalAgeMs) return false;
  if (item.tier === 'locked' && ctx.now - item.proposedAt < policy.lockDelayMs) return false;
  return true;
}

/** Breaker: trips on volume spike or repeated/tamper failures; manual reset only. */
export function updateBreaker(breaker, ctx, lastCheck, policy = DEFAULT_POLICY) {
  if (breaker.tripped) return breaker;
  if (lastCheck && !lastCheck.ok && lastCheck.tamper) return { tripped: true, reason: lastCheck.reason };
  const failures = (ctx.failures || []).filter((t) => t > ctx.now - HOUR).length;
  if (failures >= policy.breaker.maxFailures1h) return { tripped: true, reason: 'repeated check failures' };
  let hourSum = 0n, hourCount = 0;
  for (const e of ctx.ledger || []) if (e.at > ctx.now - HOUR) { hourSum += e.amount; hourCount++; }
  const spikeAt = (policy.rolling24hLimitUsdc * BigInt(Math.round(policy.breaker.spikeFraction1h * 100))) / 100n;
  if (hourSum >= spikeAt || hourCount >= policy.maxSendsPerHour) return { tripped: true, reason: 'volume spike' };
  return breaker;
}

export function resetBreaker(byHuman) {
  if (byHuman !== true) throw new Error('Breaker reset is manual only');
  return { tripped: false };
}

/** Lifecycle. held/cancelled/stuck-send are never resent automatically. */
export function nextState(state, event) {
  const t = {
    proposed: { instant: 'releasing', lock: 'locked' },
    locked: { cancel: 'cancelled', 'check-failed': 'held', 'lock-ended-ok': 'releasing' },
    releasing: { published: 'sent', 'window-missed': 'releasing', unknown: 'stuck-send', 'check-failed': 'held' }
  };
  return (t[state] && t[state][event]) || state;
}
