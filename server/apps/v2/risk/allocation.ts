import type { BookSpec, CapitalYear, Sleeve, SleeveSpec } from '../../../../contracts/index.js';

const SHARE_TOLERANCE = 1e-9;

// Doc 66 2026-09-27: the loss cap and daily cap split by the same share as capital, so the
// sleeves' caps together never exceed the account's. Derived per call so a mid-year tighten reaches every book.
export function sleeveCapitalYear(spec: SleeveSpec, capital: CapitalYear): CapitalYear {
  return {
    ...capital,
    startCapitalGbp: capital.startCapitalGbp * spec.capitalShare,
    lossCapGbp: capital.lossCapGbp * spec.capitalShare,
  };
}

export function sleeveAllocationGbp(spec: SleeveSpec, capital: CapitalYear): number {
  const { startCapitalGbp } = sleeveCapitalYear(spec, capital);
  if (startCapitalGbp < spec.minimumCapitalGbp) return 0;
  return Math.min(startCapitalGbp, spec.capacityGbp);
}

export function assertCapitalShareRanges(sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[]): void {
  for (const { id, spec } of sleeves) {
    if (!(spec.capitalShare > 0 && spec.capitalShare <= 1)) {
      throw new Error(
        `capital share: sleeve '${id}' declares ${spec.capitalShare}, outside (0, 1]`,
      );
    }
  }
}

// A sleeve with no 'primary' book can never hold a real fill (`V2OrderExecutor.simulates()`
// routes every non-primary book, and every venue, to a simulated broker) — its capital
// share is notional, seeding a comparably-sized shadow book (Q14), never drawing on the
// real account. Doc 66, 2026-09-28 addition (#1773): the ceiling below sums only sleeves
// that can, so a shadow-only arm cannot crowd out a real one's share of the account
function capableOfRealFills(spec: SleeveSpec): boolean {
  return spec.books.some((book) => book.variant === 'primary');
}

export function assertCapitalShares(sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[]): void {
  assertCapitalShareRanges(sleeves);
  const total = sleeves
    .filter(({ spec }) => capableOfRealFills(spec))
    .reduce((sum, { spec }) => sum + spec.capitalShare, 0);
  if (total > 1 + SHARE_TOLERANCE) {
    throw new Error(`capital share: sleeves declare ${total} of the account, more than 1`);
  }
}

export function assertArm2RunsBesideDebate(
  sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[],
  debateSleeveId: string,
  arm2SleeveId: string,
): void {
  const ids = new Set(sleeves.map((sleeve) => sleeve.id));
  if (ids.has(debateSleeveId) !== ids.has(arm2SleeveId)) {
    throw new Error(
      `v2 root refuses '${debateSleeveId}' without '${arm2SleeveId}' beside it: no debate-sleeve paper trade until arm 2 runs beside it (#1773)`,
    );
  }
}

export function bookSpecsFor(sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[]): BookSpec[] {
  return sleeves.flatMap((sleeve) =>
    sleeve.spec.books.map((book) => ({
      id: `${sleeve.id}/${book.variant}`,
      sleeve: sleeve.id,
      variant: book.variant,
      instantiated: book.instantiated,
    })),
  );
}
