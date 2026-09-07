import { expect, test } from '@playwright/test';

test('manifest and app icon are usable by Chromium', async ({ page }) => {
  await page.goto('/');
  const cdp = await page.context().newCDPSession(page);
  const result = await cdp.send('Page.getAppManifest');
  expect(result.errors).toEqual([]);
  expect(JSON.parse(result.data!).display).toBe('standalone');
  const installability = await cdp.send('Page.getInstallabilityErrors');
  expect(installability.installabilityErrors.filter(error => /manifest|icon/.test(error.errorId))).toEqual([]);
  const dimensions = await page.evaluate(async () => {
    const icon = new Image();
    icon.src = '/icon.png';
    await icon.decode();
    return [icon.naturalWidth, icon.naturalHeight];
  });
  expect(dimensions).toEqual([1024, 1024]);
});

test('install button uses browser prompt and hides after installation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => { document.body.dataset.promptShown = 'yes'; },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
  await page.locator('[data-web-action="more"]').click();
  await page.getByRole('button', { name: 'Install app…' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-prompt-shown', 'yes');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('[data-web-action="install"]')).toBeHidden();
});

test('OS file launch opens a local image through the existing viewer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'launchQueue', {
      value: {
        setConsumer(consumer: (launch: unknown) => void) {
          consumer({ files: [{ getFile: async () => new File(['P2\n2 2\n255\n0 64 128 255\n'], 'launched.pgm') }] });
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'launched.pgm', exact: true })).toBeVisible();
  await expect(page.locator('body > canvas:not(.measure-overlay)')).toBeVisible();
});
