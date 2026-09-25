import type { Sleeve, SleeveSource, SleeveSpec } from '../../../../contracts/index.js';

export class SleeveRegistry implements SleeveSource {
  readonly #sleeves = new Map<string, Sleeve>();

  register(sleeve: Sleeve): void {
    if (this.#sleeves.has(sleeve.id)) {
      throw new Error(`SleeveRegistry: sleeve '${sleeve.id}' is already registered`);
    }
    this.#sleeves.set(sleeve.id, sleeve);
  }

  list(): readonly Sleeve[] {
    return [...this.#sleeves.values()];
  }

  ids(): readonly string[] {
    return [...this.#sleeves.keys()];
  }

  spec(id: string): SleeveSpec {
    const sleeve = this.#sleeves.get(id);
    if (sleeve === undefined) throw new Error(`SleeveRegistry: no sleeve '${id}'`);
    return sleeve.spec;
  }
}
