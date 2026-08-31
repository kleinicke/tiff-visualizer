"use strict";

export type TiffSampleView = Uint8Array | Uint16Array | Float32Array;

/**
 * Put one decoded source-row range into its final TIFF-orientation layout.
 *
 * Orientations 1-4 remain a row band. Transposing orientations 5-8 become a
 * column band laid out as `source width` rows by `range rows` columns, which
 * lets the orchestrator assemble it with one TypedArray#set per output row.
 * No worker ever needs the complete raster.
 */
export function orientTiffRange<T extends TiffSampleView>(
	source: T,
	width: number,
	height: number,
	channels: number,
	firstRow: number,
	orientation: number,
): { samples: T, transposed: boolean, destinationStart: number, bandWidth: number } {
	if (orientation === 1) {
		return { samples: source, transposed: false, destinationStart: firstRow, bandWidth: width };
	}
	const rows = source.length / (width * channels);
	const transposed = orientation >= 5 && orientation <= 8;
	const destinationStart = transposed
		? (orientation === 6 || orientation === 7 ? height - firstRow - rows : firstRow)
		: (orientation === 3 || orientation === 4 ? height - firstRow - rows : firstRow);
	const output = new (source.constructor as any)(source.length) as T;
	for (let localY = 0; localY < rows; localY++) {
		const sourceY = firstRow + localY;
		for (let sourceX = 0; sourceX < width; sourceX++) {
			let destinationX: number;
			let destinationY: number;
			switch (orientation) {
				case 2: destinationX = width - 1 - sourceX; destinationY = sourceY; break;
				case 3: destinationX = width - 1 - sourceX; destinationY = height - 1 - sourceY; break;
				case 4: destinationX = sourceX; destinationY = height - 1 - sourceY; break;
				case 5: destinationX = sourceY; destinationY = sourceX; break;
				case 6: destinationX = height - 1 - sourceY; destinationY = sourceX; break;
				case 7: destinationX = height - 1 - sourceY; destinationY = width - 1 - sourceX; break;
				case 8: destinationX = sourceY; destinationY = width - 1 - sourceX; break;
				default: destinationX = sourceX; destinationY = sourceY;
			}
			const localDestinationX = transposed ? destinationX - destinationStart : destinationX;
			const localDestinationY = transposed ? destinationY : destinationY - destinationStart;
			const from = (localY * width + sourceX) * channels;
			const to = transposed
				? (localDestinationY * rows + localDestinationX) * channels
				: (localDestinationY * width + localDestinationX) * channels;
			for (let channel = 0; channel < channels; channel++) {
				output[to + channel] = source[from + channel];
			}
		}
	}
	return { samples: output, transposed, destinationStart, bandWidth: transposed ? rows : width };
}
