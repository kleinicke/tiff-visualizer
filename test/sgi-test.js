const assert = require('assert');
const fs = require('fs');

// Independent fixture writer: input is top-down, interleaved pixel values.
function fixture(bpc, channels, rle) {
    const width = 4, height = 2;
    const expected = Array.from({ length: width * height * channels }, (_, i) =>
        (Math.floor(i / channels) < 4 ? 13 + i : 75) * (bpc === 2 ? 257 : 1));
    const word = value => bpc === 1 ? Buffer.from([value]) : Buffer.from([value >> 8, value & 255]);
    const rows = [];
    for (let c = 0; c < channels; c++) {
        for (let y = height - 1; y >= 0; y--) {
            const values = Array.from({ length: width }, (_, x) => expected[(y * width + x) * channels + c]);
            // Exercise both literal packets and repeat packets, including 16-bit controls.
            rows.push(Buffer.concat((rle ? (y === 1 ? [4, values[0], 0] : [0x84, ...values, 0]) : values).map(word)));
        }
    }
    const header = Buffer.alloc(512);
    header.writeUInt16BE(474, 0); header[2] = Number(rle); header[3] = bpc;
    header.writeUInt16BE(channels === 1 ? 2 : 3, 4);
    header.writeUInt16BE(width, 6); header.writeUInt16BE(height, 8); header.writeUInt16BE(channels, 10);
    header.writeUInt32BE(bpc === 1 ? 255 : 65535, 16);
    if (!rle) return { bytes: Buffer.concat([header, ...rows]), expected };
    const tables = Buffer.alloc(rows.length * 8);
    let offset = 512 + tables.length;
    // Reverse physical scanline storage to prove offsets, rather than order, control decoding.
    for (let i = rows.length - 1; i >= 0; i--) {
        tables.writeUInt32BE(offset, i * 4);
        tables.writeUInt32BE(rows[i].length, (rows.length + i) * 4);
        offset += rows[i].length;
    }
    return { bytes: Buffer.concat([header, tables, ...rows.reverse()]), expected };
}

async function main() {
    const wasm = await import('../media/wasm/tiff-wasm.js');
    await wasm.default({ module_or_path: fs.readFileSync('media/wasm/tiff-wasm.wasm') });
    const { decodeSgiWithWasm } = await import('../out/media/modules/wasm-decoders.js');
    const { resolveFormat } = await import('../out/media/modules/format-registry.js');
    for (const extension of ['rgb', 'RGB', 'rgba', 'sgi', 'bw']) {
        assert.equal(resolveFormat(`image.${extension}`).kind, 'sgi');
    }
    for (const bpc of [1, 2]) for (const channels of [1, 2, 3, 4]) for (const rle of [false, true]) {
        const { bytes, expected } = fixture(bpc, channels, rle);
        for (const context of ['worker', 'main']) {
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
            const result = decodeSgiWithWasm(wasm.decode_sgi_fast, buffer, context);
            assert.deepStrictEqual(Array.from(result.data), expected);
            assert.equal(result.width, 4); assert.equal(result.height, 2); assert.equal(result.channels, channels);
            assert.equal(result.numericDomain.bitsPerSample, bpc * 8);
            assert.equal(result.numericDomain.typeMax, bpc === 1 ? 255 : 65535);
            assert.equal(result.numericDomain.sampleFormat, 1);
            assert.equal(result.stats.min, Math.min(...expected));
            assert.equal(result.stats.max, Math.max(...expected));
        }
        assert.throws(() => wasm.decode_sgi_fast(bytes.subarray(0, bytes.length - 1)), /SGI:/);
    }
    const valid = fixture(1, 3, true).bytes;
    for (const mutate of [
        b => b.writeUInt16BE(0, 0), b => { b[2] = 2; }, b => { b[3] = 4; },
        b => b.writeUInt16BE(0, 6), b => b.writeUInt16BE(0, 10),
        b => b.writeUInt32BE(1, 104), b => b.writeUInt32BE(12, 512),
        b => b.writeUInt32BE(0xffffffff, 512), b => b.writeUInt32BE(0xffffffff, 536),
        b => { b[b.readUInt32BE(512)] = 127; }, // row overrun
        b => { b[b.readUInt32BE(512)] = 0; }, // premature terminator
    ]) {
        const broken = Buffer.from(valid); mutate(broken);
        assert.throws(() => wasm.decode_sgi_fast(broken), /SGI:/);
    }
    // Identical rows can legally share one RLE payload.
    const shared = Buffer.from(valid);
    const start = shared.readUInt32BE(512), length = shared.readUInt32BE(536);
    for (let row = 0; row < 6; row++) {
        shared.writeUInt32BE(start, 512 + row * 4);
        shared.writeUInt32BE(length, 536 + row * 4);
    }
    assert.deepStrictEqual(Array.from(wasm.decode_sgi_fast(shared).take_data_as_f32()), Array(24).fill(75));
    console.log('SGI: 16 format variants, worker/main assembly, shared RLE rows, and malformed inputs passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
