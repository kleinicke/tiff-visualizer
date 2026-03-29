import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/playwright',
  // Only run extension-core tests in CI — they are standalone (no VS Code server needed).
  // The other spec files require a running VS Code Web server and are run manually.
  testMatch: 'extension-core.spec.ts',
  reporter: 'list',
  use: {
    // No baseURL needed — extension-core tests are filesystem-only
  },
  // No browser projects needed: extension-core tests don't use the page fixture
  projects: [
    {
      name: 'core',
    },
  ],
});
