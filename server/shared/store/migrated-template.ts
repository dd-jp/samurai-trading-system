import { inMemoryCopyOf, openSharedStore, type StoreHandle } from './open-shared-store.js';

let template: StoreHandle | undefined;

// Test support: one migrated store per test file. Callers only serialise or copy the template,
// never write to it, so no state leaks from one test into the next
export function migratedTemplate(): StoreHandle {
  template ??= openSharedStore(':memory:');
  return template;
}

export function migratedMemoryStore(): StoreHandle {
  return inMemoryCopyOf(migratedTemplate());
}
