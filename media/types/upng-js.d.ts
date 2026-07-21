declare module 'upng-js' {
	interface DecodedPng {
		width: number;
		height: number;
		depth: number;
		ctype: number;
		data: ArrayBuffer;
		frames: unknown[];
	}

	const UPNG: {
		decode(buffer: ArrayBuffer): DecodedPng;
		toRGBA8(image: DecodedPng): ArrayBuffer[];
		encode(buffers: ArrayBuffer[], width: number, height: number, colorCount?: number): ArrayBuffer;
	};
	export default UPNG;
}
