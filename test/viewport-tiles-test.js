/**
 * Tests for the viewport-region policy (media/modules/viewport-tiles.ts).
 *
 * The decoder can read a rectangle; this decides WHICH one, and the decisions
 * are the kind that look obvious and are easy to get subtly wrong — a snap that
 * rounds the wrong way decodes a block too few and shows a seam, a margin that
 * grows around the wrong point decodes ahead of where the reader is going, and
 * a "worth it?" test applied to the padded rectangle rather than the visible
 * one falls back to the whole page exactly when the region would have helped.
 *
 * Run with: node test/viewport-tiles-test.js
 */

const assert = require('assert');
const path = require('path');

/** A Sentinel-2 band: 10980 square, 1024-pixel tiles. */
const S2 = { imageWidth: 10980, imageHeight: 10980, blockWidth: 1024, blockHeight: 1024 };
/** A stripped file: blocks are full-width bands. */
const STRIPPED = { imageWidth: 4000, imageHeight: 3000, blockWidth: 4000, blockHeight: 16 };

async function main() {
	console.log('🧪 Running viewport-region policy tests...\n');

	const {
		visibleImageRect, withMargin, snapToBlocks, rectContains, rectsEqual,
		planRegionForView, WHOLE_PAGE_FRACTION,
	} = await import(
		path.join('..', 'out', 'media', 'modules', 'viewport-tiles.js').replace(/\\/g, '/')
	);

	// 1. Screen to image coordinates.
	{
		// 1:1, scrolled to (2000, 1000), a 1600x1000 window.
		assert.deepStrictEqual(visibleImageRect(S2, 1600, 1000, 1, 2000, 1000),
			{ x: 2000, y: 1000, width: 1600, height: 1000 });
		// Zoomed to 4x, the same window covers a quarter as many image pixels.
		assert.deepStrictEqual(visibleImageRect(S2, 1600, 1000, 4, 8000, 4000),
			{ x: 2000, y: 1000, width: 400, height: 250 });
		// Zoomed out, the rectangle is clamped to the image rather than
		// running off it.
		const zoomedOut = visibleImageRect(S2, 1600, 1000, 0.05, 0, 0);
		assert.strictEqual(zoomedOut.x, 0);
		assert.strictEqual(zoomedOut.width, 10980);
		// A nonsense scale asks for everything rather than dividing by zero.
		assert.deepStrictEqual(visibleImageRect(S2, 1600, 1000, 0, 0, 0),
			{ x: 0, y: 0, width: 10980, height: 10980 });
		console.log('✅ The visible rectangle follows zoom and scroll, and stays inside the image');
	}

	// 2. Snapping expands to whole blocks, never contracts.
	{
		const snapped = snapToBlocks({ x: 1030, y: 5, width: 100, height: 100 }, S2);
		assert.deepStrictEqual(snapped, { x: 1024, y: 0, width: 1024, height: 1024 },
			'a rectangle inside one tile becomes that tile');
		const across = snapToBlocks({ x: 1000, y: 1000, width: 100, height: 100 }, S2);
		assert.deepStrictEqual(across, { x: 0, y: 0, width: 2048, height: 2048 },
			'a rectangle straddling a boundary takes both tiles');
		// The last block is short, and snapping must not run past the image.
		const edge = snapToBlocks({ x: 10900, y: 10900, width: 80, height: 80 }, S2);
		assert.strictEqual(edge.x + edge.width, 10980);
		assert.strictEqual(edge.y + edge.height, 10980);
		// Strips: full width, a few rows tall.
		assert.deepStrictEqual(snapToBlocks({ x: 100, y: 100, width: 200, height: 20 }, STRIPPED),
			{ x: 0, y: 96, width: 4000, height: 32 });
		console.log('✅ Snapping grows to whole blocks and stops at the image edge');
	}

	// 3. The margin grows around the CENTRE, so panning either way is covered.
	{
		const grown = withMargin({ x: 4000, y: 4000, width: 1000, height: 1000 }, S2, 0.5);
		assert.strictEqual(grown.width, 1500);
		assert.strictEqual(grown.height, 1500);
		assert.strictEqual(grown.x, 3750, 'grows equally on both sides');
		// At the edge it cannot grow outward, and must not produce a negative
		// origin or a rectangle outside the image.
		const atEdge = withMargin({ x: 0, y: 0, width: 1000, height: 1000 }, S2, 0.5);
		assert.strictEqual(atEdge.x, 0);
		assert.ok(atEdge.x + atEdge.width <= S2.imageWidth);
		console.log('✅ The decoded margin grows around the view and clamps at the edges');
	}

	// 4. The plan: keep, read, or give up on regions.
	{
		const visible = { x: 4000, y: 4000, width: 1600, height: 1000 };
		const first = planRegionForView(S2, visible, null);
		assert.strictEqual(first.kind, 'region');
		assert.ok(rectContains(first.rect, visible), 'the decoded rectangle covers the view');
		assert.strictEqual(first.rect.x % S2.blockWidth, 0, 'and is block-aligned');

		// A small pan inside the margin needs no decode: this is what the
		// margin is for, and without it every drag would stall.
		const panned = { x: 4100, y: 4050, width: 1600, height: 1000 };
		assert.strictEqual(planRegionForView(S2, panned, first.rect).kind, 'keep');

		// A large pan does need one, and produces a different rectangle.
		const far = { x: 9000, y: 9000, width: 1600, height: 1000 };
		const second = planRegionForView(S2, far, first.rect);
		assert.strictEqual(second.kind, 'region');
		assert.ok(!rectsEqual(second.rect, first.rect));

		// Asking twice for the same view does not decode twice.
		assert.strictEqual(planRegionForView(S2, far, second.rect).kind, 'keep');
		console.log('✅ Plans keep what is decoded, and read again only when the view leaves it');
	}

	// 5. Zoomed far enough out, a region is not worth having: it would cover
	//    nearly the whole page while giving up the whole-page result.
	{
		const most = { x: 0, y: 0, width: 10980, height: 10980 };
		assert.strictEqual(planRegionForView(S2, most, null).kind, 'whole-page');
		const smallEnough = {
			x: 0, y: 0,
			width: Math.floor(10980 * 0.5), height: Math.floor(10980 * 0.5),
		};
		// A quarter of the pixels is well under the threshold.
		assert.strictEqual(planRegionForView(S2, smallEnough, null).kind, 'region');
		assert.ok(WHOLE_PAGE_FRACTION > 0 && WHOLE_PAGE_FRACTION < 1);
		console.log('✅ A view covering most of the page falls back to decoding the page');
	}

	// 6. The judgement uses the VISIBLE rectangle, not the padded one — else a
	//    view that a region would serve well is refused because its margin
	//    pushes it over the threshold.
	{
		const geometry = { imageWidth: 1000, imageHeight: 1000, blockWidth: 100, blockHeight: 100 };
		// 40% of the pixels visible: under the threshold, so a region — even
		// though the margin and snapping grow it past 60%.
		const visible = { x: 300, y: 300, width: 632, height: 632 };
		assert.ok((visible.width * visible.height) / 1e6 < WHOLE_PAGE_FRACTION);
		assert.strictEqual(planRegionForView(geometry, visible, null).kind, 'region');
		console.log('✅ The whole-page threshold judges the view, not the padding around it');
	}

	// 7. A degenerate page is answered, not divided by.
	{
		assert.strictEqual(
			planRegionForView({ imageWidth: 0, imageHeight: 0, blockWidth: 1, blockHeight: 1 },
				{ x: 0, y: 0, width: 1, height: 1 }, null).kind,
			'whole-page');
		console.log('✅ A degenerate page falls back rather than dividing by zero');
	}

	console.log('\n🎉 All viewport-region policy tests passed.\n');
}

main().catch(error => {
	console.error('❌ Viewport-region policy test failed:');
	console.error(error);
	process.exit(1);
});
