/**
 * Tests for the pyramid-level policy (media/modules/tiff-pages.ts).
 *
 * The classification itself is Rust's job and is tested there; what lives here
 * is the DISPLAY policy built on top of it, which is where the judgement calls
 * are:
 *
 *   - a pyramid's extra IFDs are levels of one image, not pages;
 *   - full resolution is the default whenever it can be shown, because a
 *     silently downsampled image is a worse failure than a slow one;
 *   - a level is never chosen below the size it will be displayed at, since
 *     that would show interpolated pixels the file does not contain.
 *
 * Run with: node test/tiff-pages-test.js
 */

const assert = require('assert');
const path = require('path');

/** The directory JSON a 4-level COG produces, as the decoder emits it. */
function cogDirectory() {
	return JSON.stringify([
		{ index: 0, width: 8000, height: 8000, samplesPerPixel: 1, subfileType: 0, kind: 'image', parent: null, reduction: 1, subIfdCount: 0 },
		{ index: 1, width: 4000, height: 4000, samplesPerPixel: 1, subfileType: 1, kind: 'overview', parent: 0, reduction: 2, subIfdCount: 0 },
		{ index: 2, width: 2000, height: 2000, samplesPerPixel: 1, subfileType: 1, kind: 'overview', parent: 0, reduction: 4, subIfdCount: 0 },
		{ index: 3, width: 1000, height: 1000, samplesPerPixel: 1, subfileType: 1, kind: 'overview', parent: 0, reduction: 8, subIfdCount: 0 },
	]);
}

async function main() {
	console.log('🧪 Running TIFF pyramid-level policy tests...\n');

	const pages = await import(
		path.join('..', 'out', 'media', 'modules', 'tiff-pages.js').replace(/\\/g, '/')
	);
	const {
		parsePageDirectory, imagePages, levelsForPage, pageOwningIfd,
		isPyramidal, levelForDisplayWidth, chooseOpenLevel, levelLabel,
	} = pages;

	// 1. Parsing tolerates absence and rubbish rather than throwing into a load.
	{
		assert.deepStrictEqual(parsePageDirectory(''), []);
		assert.deepStrictEqual(parsePageDirectory(undefined), []);
		assert.deepStrictEqual(parsePageDirectory('not json'), []);
		assert.deepStrictEqual(parsePageDirectory('{"not":"an array"}'), []);
		console.log('✅ A missing or malformed directory yields no levels, not an error');
	}

	// 2. A pyramid is one page with levels, not four pages.
	{
		const directory = parsePageDirectory(cogDirectory());
		assert.strictEqual(directory.length, 4);
		assert.ok(isPyramidal(directory));
		assert.strictEqual(imagePages(directory).length, 1, 'a COG holds ONE image');
		assert.strictEqual(levelsForPage(directory, 0).length, 4);
		assert.strictEqual(pageOwningIfd(directory, 3), 0, 'an overview belongs to its page');
		console.log('✅ A 4-IFD COG reads as one page with four levels');
	}

	// 3. Levels come back full-resolution first, so index 0 is always the truth.
	{
		const levels = levelsForPage(parsePageDirectory(cogDirectory()), 0);
		assert.deepStrictEqual(levels.map(level => level.width), [8000, 4000, 2000, 1000]);
		assert.strictEqual(levelLabel(levels[0]), 'Full · 8000x8000');
		assert.strictEqual(levelLabel(levels[2]), '1/4 · 2000x2000');
		console.log('✅ Levels are ordered largest-first and labelled by their reduction');
	}

	// 4. Never choose a level below the display size: that would invent detail.
	{
		const directory = parsePageDirectory(cogDirectory());
		assert.strictEqual(levelForDisplayWidth(directory, 0, 900).width, 1000,
			'a 900px display uses the 1000px level, not the 2000px one');
		assert.strictEqual(levelForDisplayWidth(directory, 0, 1001).width, 2000,
			'one pixel over a level forces the next one up');
		assert.strictEqual(levelForDisplayWidth(directory, 0, 100000).width, 8000,
			'beyond full resolution there is nothing finer to ask for');
		console.log('✅ Level choice never goes below the displayed size');
	}

	// 5. A file with no overviews is the one-level case, not a special case.
	{
		const flat = parsePageDirectory(JSON.stringify([
			{ index: 0, width: 512, height: 512, samplesPerPixel: 1, subfileType: 0, kind: 'image', parent: null, reduction: 1, subIfdCount: 0 },
		]));
		assert.ok(!isPyramidal(flat));
		assert.strictEqual(levelsForPage(flat, 0).length, 1);
		assert.strictEqual(levelForDisplayWidth(flat, 0, 4000).width, 512);
		console.log('✅ A file without overviews behaves as a single level');
	}

	// 6. Opening policy: full resolution whenever it can be shown at all.
	{
		const directory = parsePageDirectory(cogDirectory());
		const always = () => true;
		assert.strictEqual(chooseOpenLevel(directory, 0, 800, always).index, 0,
			'a displayable full resolution is always preferred over a faster level');
		console.log('✅ Opening prefers full resolution when it can be displayed');
	}

	// 7. …and falls back to a screen-sized level when it cannot.
	//    This is the 40000x40000 case: 1.6 gigapixels can never reach a canvas,
	//    and before this the file simply failed to open.
	{
		const huge = parsePageDirectory(JSON.stringify([
			{ index: 0, width: 40000, height: 40000, kind: 'image', parent: null, reduction: 1, samplesPerPixel: 1, subfileType: 0, subIfdCount: 0 },
			{ index: 1, width: 20000, height: 20000, kind: 'overview', parent: 0, reduction: 2, samplesPerPixel: 1, subfileType: 1, subIfdCount: 0 },
			{ index: 2, width: 10000, height: 10000, kind: 'overview', parent: 0, reduction: 4, samplesPerPixel: 1, subfileType: 1, subIfdCount: 0 },
			{ index: 3, width: 2500, height: 2500, kind: 'overview', parent: 0, reduction: 16, samplesPerPixel: 1, subfileType: 1, subIfdCount: 0 },
		]));
		// A canvas ceiling like Chromium's: bounded by total pixels.
		const canDisplay = (width, height) => width * height <= 268435456;
		const chosen = chooseOpenLevel(huge, 0, 1280, canDisplay);
		assert.strictEqual(chosen.width, 2500,
			'an undisplayable image opens at a level sized for the window');

		// Nothing displayable at all is reported, not guessed at.
		assert.strictEqual(chooseOpenLevel(huge, 0, 1280, () => false), null);
		console.log('✅ An image too large to display opens at its largest usable level');
	}

	// 8. A level that is displayable but smaller than the window still wins
	//    over an undisplayable full resolution — the walk starts at the
	//    window-sized level and descends only as far as it must.
	{
		const directory = parsePageDirectory(cogDirectory());
		const canDisplay = width => width <= 2000;
		assert.strictEqual(chooseOpenLevel(directory, 0, 3000, canDisplay).width, 2000);
		console.log('✅ The fallback walk stops at the largest displayable level');
	}

	console.log('\n🎉 All TIFF pyramid-level policy tests passed.\n');
}

main().catch(error => {
	console.error('❌ TIFF pyramid-level policy test failed:');
	console.error(error);
	process.exit(1);
});
