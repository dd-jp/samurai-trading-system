import { isSaxoCfdAssetType } from './saxo-client.js';

describe('isSaxoCfdAssetType (#1916)', () => {
  it.each(['CfdOnStock', 'CfdOnIndex', 'CfdOnEtf'])('accepts %s', (assetType) => {
    expect(isSaxoCfdAssetType(assetType)).toBe(true);
  });

  it.each(['Etf', 'Etc', 'Etn', 'Stock', 'CfdOnFutures', '', 'cfdonstock'])(
    'refuses %j',
    (assetType) => {
      expect(isSaxoCfdAssetType(assetType)).toBe(false);
    },
  );
});
