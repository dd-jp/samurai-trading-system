
export function orderHeldFirst<T extends { readonly asset: string }>(
  instruments: readonly T[],
  heldAssets: ReadonlySet<string>,
): T[] {
  const held: T[] = [];
  const flat: T[] = [];
  for (const instrument of instruments) {
    (heldAssets.has(instrument.asset) ? held : flat).push(instrument);
  }
  return [...held, ...flat];
}
