import { test as base, expect } from '@playwright/test';

const LOCAL_SCHEMES = ['data:', 'blob:', 'about:'];

function isLocalUrl(url: string, origin: string): boolean {
  if (LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export const test = base.extend<{ offOriginRequests: string[] }>({
  offOriginRequests: [
    async ({ page, baseURL }, use) => {
      if (baseURL === undefined) {
        throw new Error('the off-origin guard needs `use.baseURL` in playwright.config.ts');
      }
      const origin = new URL(baseURL).origin;
      const offOrigin: string[] = [];
      await page.route('**/*', async (route) => {
        const url = route.request().url();
        if (isLocalUrl(url, origin)) {
          await route.fallback();
          return;
        }
        offOrigin.push(url);
        await route.abort('blockedbyclient');
      });
      await use(offOrigin);
      expect(offOrigin, 'the dashboard must make no off-origin request').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
