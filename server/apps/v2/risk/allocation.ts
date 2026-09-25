import type { BookSpec, CapitalYear, Sleeve, SleeveSpec } from '../../../../contracts/index.js';

export function sleeveAllocationGbp(spec: SleeveSpec, capital: CapitalYear): number {
  if (capital.startCapitalGbp < spec.minimumCapitalGbp) return 0;
  return Math.min(capital.startCapitalGbp, spec.capacityGbp);
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
