"use strict";

import { levelsForPage, type TiffPageEntry } from '../tiff-pages.js';

/**
 * Geometry of a pyramid viewed through a pan/zoom camera.
 *
 * Pure arithmetic, like `viewport-tiles.ts`: which resolution level suits a
 * zoom, which fixed tiles of that level cover the window, and how the camera
 * moves. Keeping it free of the DOM and the decoder means the decisions that
 * decide whether the picture is sharp or wasteful can be tested exactly.
 *
 * Coordinates: "scene" pixels are the pixels of the FULL resolution image
 * (level 0). A level with `reduction` r is r times smaller; its pixel (x, y)
 * covers scene pixels [x*r, (x+1)*r).
 */

export interface SceneLevel {
	/** What the decoder takes to read this level. */
	index: number;
	width: number;
	height: number;
	/** Linear downsample against level 0 (1, 2, 4, ...). */
	reduction: number;
	blockWidth: number;
	blockHeight: number;
}

export interface Camera {
	/** Screen pixels per scene pixel. */
	scale: number;
	/** Screen position of scene pixel (0, 0). */
	x: number;
	y: number;
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface TileAddress { level: number; column: number; row: number }

/** Levels of page 0 of a classified TIFF directory, finest first. */
export function sceneLevels(directory: TiffPageEntry[]): SceneLevel[] {
	return levelsForPage(directory, 0).map(entry => ({
		index: entry.index,
		width: entry.width,
		height: entry.height,
		reduction: Math.max(1, entry.reduction),
		blockWidth: entry.blockWidth,
		blockHeight: entry.blockHeight,
	}));
}

/**
 * The level to draw at this zoom: the coarsest whose pixels are no larger than
 * a screen pixel, so nothing is ever shown blurrier than the file allows and
 * nothing finer than the screen can show is decoded.
 */
export function chooseLevel(levels: readonly SceneLevel[], scale: number): number {
	let chosen = 0;
	for (let index = 0; index < levels.length; index++) {
		if (levels[index].reduction * scale <= 1.0001) { chosen = index; }
	}
	return chosen;
}

/**
 * The overview used as the always-present base layer: the finest level that
 * still fits in `maxPixels`, or the coarsest one when none does.
 */
export function chooseOverview(levels: readonly SceneLevel[], maxPixels: number): number {
	for (let index = 0; index < levels.length; index++) {
		if (levels[index].width * levels[index].height <= maxPixels) { return index; }
	}
	return Math.max(0, levels.length - 1);
}

/** The part of the scene the window shows, in scene pixels, clamped to the image. */
export function visibleSceneRect(camera: Camera, viewWidth: number, viewHeight: number, sceneWidth: number, sceneHeight: number): Rect {
	const left = Math.max(0, -camera.x / camera.scale);
	const top = Math.max(0, -camera.y / camera.scale);
	const right = Math.min(sceneWidth, (viewWidth - camera.x) / camera.scale);
	const bottom = Math.min(sceneHeight, (viewHeight - camera.y) / camera.scale);
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Edge length of the square tiles used for `level`: its block size, capped. */
export function tileSizeFor(level: SceneLevel, cap = 1024): number {
	return Math.max(64, Math.min(cap, Math.max(level.blockWidth, level.blockHeight)));
}

/** The rectangle of `address` in the level's own pixels, clipped to the level. */
export function tileRect(level: SceneLevel, address: TileAddress, tileSize: number): Rect {
	const x = address.column * tileSize;
	const y = address.row * tileSize;
	return { x, y, width: Math.max(0, Math.min(tileSize, level.width - x)), height: Math.max(0, Math.min(tileSize, level.height - y)) };
}

export interface SceneSize { width: number; height: number }

/**
 * Where a tile lands in the scene.
 *
 * Levels are `ceil(size / reduction)` pixels, so a level pixel is not exactly
 * `reduction` scene pixels at the far edge; mapping by the ratio of the two
 * sizes keeps every level lined up with level 0 to the last pixel.
 */
export function tileSceneRect(level: SceneLevel, address: TileAddress, tileSize: number, scene: SceneSize): Rect {
	const rect = tileRect(level, address, tileSize);
	const fx = scene.width / level.width;
	const fy = scene.height / level.height;
	return { x: rect.x * fx, y: rect.y * fy, width: rect.width * fx, height: rect.height * fy };
}

/** The tiles of `level` that cover `visible` (scene pixels), nearest the centre first. */
export function visibleTiles(level: SceneLevel, levelIndex: number, tileSize: number, visible: Rect, scene: SceneSize): TileAddress[] {
	if (visible.width <= 0 || visible.height <= 0) { return []; }
	const columns = Math.ceil(level.width / tileSize);
	const rows = Math.ceil(level.height / tileSize);
	const fx = level.width / scene.width;
	const fy = level.height / scene.height;
	const firstColumn = (value: number) => Math.floor(value * fx / tileSize);
	const lastColumn = (value: number) => Math.ceil(value * fx / tileSize) - 1;
	const firstRow = (value: number) => Math.floor(value * fy / tileSize);
	const lastRow = (value: number) => Math.ceil(value * fy / tileSize) - 1;
	const column0 = Math.max(0, firstColumn(visible.x));
	const row0 = Math.max(0, firstRow(visible.y));
	const column1 = Math.min(columns - 1, lastColumn(visible.x + visible.width));
	const row1 = Math.min(rows - 1, lastRow(visible.y + visible.height));
	const centreColumn = (visible.x + visible.width / 2) * fx / tileSize - 0.5;
	const centreRow = (visible.y + visible.height / 2) * fy / tileSize - 0.5;
	const tiles: TileAddress[] = [];
	for (let row = row0; row <= row1; row++) {
		for (let column = column0; column <= column1; column++) { tiles.push({ level: levelIndex, column, row }); }
	}
	return tiles.sort((a, b) =>
		Math.hypot(a.column - centreColumn, a.row - centreRow) - Math.hypot(b.column - centreColumn, b.row - centreRow));
}

export function tileKey(address: TileAddress): string {
	return `${address.level}:${address.column}:${address.row}`;
}

/** Scale at which the whole scene fits the window, with a margin. */
export function fitScale(viewWidth: number, viewHeight: number, sceneWidth: number, sceneHeight: number, margin = 0.96): number {
	if (!(viewWidth > 0 && viewHeight > 0 && sceneWidth > 0 && sceneHeight > 0)) { return 1; }
	return Math.min(viewWidth / sceneWidth, viewHeight / sceneHeight) * margin;
}

/** A camera that centres the whole scene. */
export function fitCamera(viewWidth: number, viewHeight: number, sceneWidth: number, sceneHeight: number): Camera {
	const scale = fitScale(viewWidth, viewHeight, sceneWidth, sceneHeight);
	return { scale, x: (viewWidth - sceneWidth * scale) / 2, y: (viewHeight - sceneHeight * scale) / 2 };
}

/** Zoom by `factor` keeping the scene point under `anchor` (screen pixels) fixed. */
export function zoomAt(camera: Camera, factor: number, anchorX: number, anchorY: number, minScale: number, maxScale: number): Camera {
	const scale = Math.min(maxScale, Math.max(minScale, camera.scale * factor));
	const ratio = scale / camera.scale;
	return { scale, x: anchorX - (anchorX - camera.x) * ratio, y: anchorY - (anchorY - camera.y) * ratio };
}

/** Screen position -> scene pixel. */
export function screenToScene(camera: Camera, screenX: number, screenY: number): { x: number; y: number } {
	return { x: (screenX - camera.x) / camera.scale, y: (screenY - camera.y) / camera.scale };
}

/**
 * Keep the scene from being dragged out of sight: some of it must stay inside
 * the window. Loose on purpose; people pan past the edge to look at it.
 */
export function clampCamera(camera: Camera, viewWidth: number, viewHeight: number, sceneWidth: number, sceneHeight: number, keep = 64): Camera {
	const width = sceneWidth * camera.scale;
	const height = sceneHeight * camera.scale;
	const clamp = (value: number, size: number, view: number) => Math.min(view - Math.min(keep, size), Math.max(Math.min(keep, size) - size, value));
	return { scale: camera.scale, x: clamp(camera.x, width, viewWidth), y: clamp(camera.y, height, viewHeight) };
}
