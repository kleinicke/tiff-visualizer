import { EditorView, VSBrowser } from 'vscode-extension-tester';
import { By } from 'selenium-webdriver';
import * as fs from 'fs';
import * as path from 'path';

const benchDir = process.env.NATIVE_VISIBILITY_BENCH_DIR;
const iterations = Math.max(2, Number(process.env.NATIVE_VISIBILITY_ITER || 4));
const variant = process.env.NATIVE_VISIBILITY_VARIANT;

async function waitForVisibleImage(title: string, started: number): Promise<number> {
	await new EditorView().openEditor(title);
	const driver = VSBrowser.instance.driver;
	await driver.switchTo().defaultContent();
	const frame = await driver.wait(async () => {
		const editor = await driver.findElement(By.css('.editor-group-container.active .editor-instance'));
		const area = await editor.getRect();
		const frames = await driver.findElements(By.css('iframe'));
		let best: { frame: typeof frames[number], overlap: number } | undefined;
		for (const candidate of frames) {
			try {
				const rect = await candidate.getRect();
				const overlap = Math.max(0, Math.min(area.x + area.width, rect.x + rect.width) - Math.max(area.x, rect.x))
					* Math.max(0, Math.min(area.y + area.height, rect.y + rect.height) - Math.max(area.y, rect.y));
				if (!best || overlap > best.overlap) { best = { frame: candidate, overlap }; }
			} catch { /* frame replaced while loading */ }
		}
		return best && best.overlap > 0 ? best.frame : false;
	}, 10000);
	await driver.switchTo().frame(frame);
	const innerFrame = await driver.wait(async () => {
		const frames = await driver.findElements(By.css('iframe'));
		for (const candidate of frames) {
			try {
				if (await candidate.isDisplayed()) { return candidate; }
			} catch { /* inner frame replaced while loading */ }
		}
		return false;
	}, 10000);
	await driver.switchTo().frame(innerFrame);
	try {
		await driver.wait(async () => {
			const images = await driver.findElements(By.css('img, canvas'));
			for (const image of images) {
				const ready = await driver.executeScript<boolean>(
					`const i=arguments[0],r=i.getBoundingClientRect(),s=getComputedStyle(i);` +
					`const loaded=i.tagName==='IMG'?(i.complete&&i.naturalWidth>0):(i.width>0&&i.height>0);` +
					`return loaded&&r.width*r.height>10000&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;`,
					image,
				);
				if (ready) { return true; }
			}
			return false;
		}, 30000, 'image did not become visible', 2);
		// One compositor opportunity after the DOM-visible state, matching the
		// extension's own `visible` metric as closely as an external driver can.
		await driver.executeAsyncScript(`requestAnimationFrame(()=>requestAnimationFrame(arguments[0]));`);
		return performance.now() - started;
	} finally {
		await driver.switchTo().defaultContent();
	}
}

(benchDir && (variant === 'native' || variant === 'extension') ? describe : describe.skip)('Native-format visibility benchmark', () => {
	it(`measures ${variant} open-to-visible time`, async function () {
		this.timeout(10 * 60 * 1000);
		const editorView = new EditorView();
		const formats = ['png', 'jpg', 'bmp', 'ico', 'webp', 'avif'];
		const results: Record<string, number[]> = {};

		for (const ext of formats) {
			const source = path.join(benchDir!, `sample.${ext}`);
			if (!fs.existsSync(source)) { throw new Error(`Missing benchmark image: ${source}`); }
			results[ext] = [];
			for (let iteration = 0; iteration < iterations; iteration++) {
				const fresh = path.join(benchDir!, `${ext}-${variant}-${iteration}.${ext}`);
				fs.copyFileSync(source, fresh);
				const started = performance.now();
				await VSBrowser.instance.openResources(fresh);
				results[ext].push(await waitForVisibleImage(path.basename(fresh), started));
				await editorView.closeAllEditors();
			}
		}

		const resultFile = process.env.NATIVE_VISIBILITY_RESULT;
		if (resultFile) { fs.writeFileSync(resultFile, JSON.stringify({ variant, iterations, results }, null, 2)); }
		console.log(`NATIVE_VISIBILITY_RESULT ${JSON.stringify({ variant, results })}`);
	});
});
