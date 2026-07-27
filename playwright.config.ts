import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/playwright',
  // Standalone filesystem/browser-worker checks that need no VS Code server.
  // The other spec files require a running VS Code Web server and are manual.
  testMatch: ['extension-core.spec.ts', 'layer-compositor-worker.spec.ts', 'gpu-layer-compositor.spec.ts', 'webgpu-layer-compositor.spec.ts'],
  reporter: 'list',
  use: {
    // No baseURL needed — extension-core tests are filesystem-only
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
    },
  },
  projects: [
    {
      name: 'core',
    },
  ],
});
