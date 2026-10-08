/**
 * The statistics behind the promotion gate.
 *
 * Two proportions, small samples. At 30 conversations per arm and request rates
 * in single or low double digits, the normal approximation behind a z-test is not
 * trustworthy - the expected count in a cell is routinely below five - so the test
 * here is Fisher's exact, which is exact for any sample size and needs no
 * approximation to defend.
 *
 * Nothing here knows about playbooks. It is arithmetic, tested against values that
 * can be checked by hand.
 */

export function rate(successes: number, trials: number): number {
  return trials === 0 ? 0 : successes / trials;
}

const logFactorials: number[] = [0];

function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) {
    logFactorials.push((logFactorials[i - 1] as number) + Math.log(i));
  }
  return logFactorials[n] as number;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-sided Fisher exact test: the probability, if the two arms had the same true
 * rate, of seeing arm A do at least this much better than arm B.
 *
 * Conditions on the margins - A has `aTrials` conversations, the pair together
 * have `aSuccesses + bSuccesses` successes - and sums the hypergeometric
 * probability of A holding `aSuccesses` or more of them.
 */
export function fisherGreater(aSuccesses: number, aTrials: number, bSuccesses: number, bTrials: number): number {
  const total = aTrials + bTrials;
  const successes = aSuccesses + bSuccesses;
  if (aTrials === 0 || bTrials === 0 || successes === 0) return 1;

  const denominator = logChoose(total, aTrials);
  const top = Math.min(aTrials, successes);
  let p = 0;
  // Starting from the observed count, every larger x leaves B with fewer
  // successes than it already has, so each term is a valid table.
  for (let x = aSuccesses; x <= top; x++) {
    p += Math.exp(logChoose(successes, x) + logChoose(total - successes, aTrials - x) - denominator);
  }
  return Math.min(1, p);
}

export interface Interval {
  lower: number;
  upper: number;
}

/** Wilson score interval for one proportion. `z` 1.96 is a 95% interval. */
export function wilson(successes: number, trials: number, z = 1.96): Interval {
  if (trials === 0) return { lower: 0, upper: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * Newcombe's interval for the difference of two proportions (method 10), built
 * from the two Wilson intervals. It behaves at small counts where the textbook
 * Wald interval does not, and it is what the evaluation report quotes.
 */
export function newcombeDifference(
  aSuccesses: number,
  aTrials: number,
  bSuccesses: number,
  bTrials: number,
  z = 1.96
): Interval {
  const pa = rate(aSuccesses, aTrials);
  const pb = rate(bSuccesses, bTrials);
  const a = wilson(aSuccesses, aTrials, z);
  const b = wilson(bSuccesses, bTrials, z);
  return {
    lower: pa - pb - Math.sqrt((pa - a.lower) ** 2 + (b.upper - pb) ** 2),
    upper: pa - pb + Math.sqrt((a.upper - pa) ** 2 + (pb - b.lower) ** 2)
  };
}
