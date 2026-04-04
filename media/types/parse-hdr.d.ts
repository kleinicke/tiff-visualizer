declare module 'parse-hdr' {
    interface HdrResult {
        /** [width, height] */
        shape: [number, number];
        exposure: number;
        gamma: number;
        /** Interleaved RGBA float32 pixel data (alpha is always 1.0) */
        data: Float32Array;
    }

    function parseHdr(buffer: ArrayBuffer): HdrResult;

    export default parseHdr;
}
