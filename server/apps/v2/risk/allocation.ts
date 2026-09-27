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

export function assertCapitalShares(sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[]): void {
  assertCapitalShareRanges(sleeves);
  const total = sleeves.reduce((sum, { spec }) => sum + spec.capitalShare, 0);
  if (total > 1 + SHARE_TOLERANCE) {
    throw new Error(`capital share: sleeves declare ${total} of the account, more than 1`);
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
