import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const sveltePlugin = require(path.join(root, 'scripts/svelte-plugin.cjs'));
let script = '';

test.beforeAll(async () => {
  // The production components, compiled the way the viewer bundles compile them.
  const result = await build({
    stdin: {
      contents: `import { flushSync, mount } from 'svelte'; import CellsSection from './ui/components/cells/CellsSection.svelte';
        (window as any).mountCells = (target: HTMLElement, cells: unknown) => flushSync(() => mount(CellsSection, { target, props: { cells } }));`,
      resolveDir: root, loader: 'ts',
    },
    bundle: true, format: 'iife', write: false, outdir: path.join(root, 'out/test-cells-fold'), plugins: [sveltePlugin()],
  });
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});

async function open(page: Page) {
  await page.setContent('<!doctype html><body><div id="root"></div></body>');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const none = () => undefined;
    const view = { count: 10, hasNuclei: false, show: 'cells', metric: null, metrics: [], opacity: 0.5, discrete: null, continuous: null, selection: null,
      setShow: none, setMetric: none, setOpacity: none, setCategory: none, setAllCategories: none, setRange: none, setColormap: none, clearSelection: none };
    const set = (name: string, origin: string) => ({ id: name, name, path: name, origin, color: '#ff0000', visible: true, count: 10, tables: [], tableMessage: null, view,
      setVisible: none, setColor: none, remove: none, addTable: none, browseTable: none, loadTable: none, removeTable: none });
    (window as any).mountCells(document.getElementById('root'), { status: null, sets: [set('Xenium cells', 'native'), set('Mask', 'added')], pending: [], sourceMessage: null,
      addSource: none, browseSource: none, loadSource: none, removeSource: none });
  });
}

const setBody = (page: Page, name: string) => page.locator('.cell-set', { has: page.locator('.channel-name', { hasText: name }) }).locator('.cell-set-body');
const setFold = (page: Page, name: string) => page.locator('.cell-set', { has: page.locator('.channel-name', { hasText: name }) }).locator('.cell-set-top .channel-fold');
const sectionFold = (page: Page) => page.locator('.cells-header .channel-fold');

test('the Xenium cells open folded and a set the user added opens unfolded', async ({ page }) => {
  await open(page);
  await expect(setBody(page, 'Xenium cells')).toHaveCount(0);
  await expect(setBody(page, 'Mask')).toHaveCount(1);
});

test('folding and unfolding the Cells section keeps each cell set as it was', async ({ page }) => {
  await open(page);
  await setFold(page, 'Xenium cells').click();
  await expect(setBody(page, 'Xenium cells')).toHaveCount(1);
  await sectionFold(page).click();
  await expect(page.locator('.cell-sets')).toHaveCount(0);
  await sectionFold(page).click();
  await expect(setBody(page, 'Xenium cells')).toHaveCount(1);
  await expect(setBody(page, 'Mask')).toHaveCount(1);

  await setFold(page, 'Xenium cells').click();
  await setFold(page, 'Mask').click();
  await sectionFold(page).click();
  await sectionFold(page).click();
  await expect(setBody(page, 'Xenium cells')).toHaveCount(0);
  await expect(setBody(page, 'Mask')).toHaveCount(0);
});
