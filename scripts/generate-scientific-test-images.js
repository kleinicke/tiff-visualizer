#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'test-samples', 'scientific');
fs.mkdirSync(outputDir, { recursive: true });
const width = 32;
const height = 24;

function writeFits() {
	const card = (key, value) => `${key.padEnd(8)}= ${String(value).padStart(20)}`.padEnd(80);
	const cards = [
		card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'),
		card('NAXIS1', width), card('NAXIS2', height), card('BSCALE', '0.5'),
		card('BZERO', '-100'), card('OBJECT', "'Synthetic gradient'"),
		card('BUNIT', "'adu'"), 'END'.padEnd(80),
	];
	const header = Buffer.from(cards.join('').padEnd(2880, ' '), 'ascii');
	const dataBytes = width * height * 2;
	const data = Buffer.alloc(Math.ceil(dataBytes / 2880) * 2880);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.writeInt16BE(y * 100 + x, (y * width + x) * 2);
		}
	}
	fs.writeFileSync(path.join(outputDir, 'synthetic-gradient.fits'), Buffer.concat([header, data]));
}

function dicomElement(group, element, vr, value) {
	const longVr = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN']);
	const padded = value.length % 2 ? Buffer.concat([value, Buffer.from(vr === 'UI' ? [0] : [0x20])]) : value;
	const header = Buffer.alloc(longVr.has(vr) ? 12 : 8);
	header.writeUInt16LE(group, 0); header.writeUInt16LE(element, 2); header.write(vr, 4, 2, 'ascii');
	if (longVr.has(vr)) { header.writeUInt32LE(padded.length, 8); }
	else { header.writeUInt16LE(padded.length, 6); }
	return Buffer.concat([header, padded]);
}

function us(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function text(value) { return Buffer.from(value, 'ascii'); }

function writeDicom() {
	const metaBody = Buffer.concat([
		dicomElement(0x0002, 0x0001, 'OB', Buffer.from([0, 1])),
		dicomElement(0x0002, 0x0010, 'UI', text('1.2.840.10008.1.2.1')),
	]);
	const metaLength = Buffer.alloc(4); metaLength.writeUInt32LE(metaBody.length);
	const pixels = Buffer.alloc(width * height * 2);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) { pixels.writeUInt16LE(y * 32 + x, (y * width + x) * 2); }
	}
	const dataset = Buffer.concat([
		dicomElement(0x0008, 0x0060, 'CS', text('OT')),
		// Spacing tags, so the sample exercises spatial calibration. Anisotropic
		// on purpose: square pixels would hide a row/column mix-up.
		dicomElement(0x0018, 0x0050, 'DS', text('3.0')),
		dicomElement(0x0018, 0x0088, 'DS', text('2.5')),
		dicomElement(0x0028, 0x0002, 'US', us(1)),
		dicomElement(0x0028, 0x0004, 'CS', text('MONOCHROME2')),
		dicomElement(0x0028, 0x0010, 'US', us(height)),
		dicomElement(0x0028, 0x0011, 'US', us(width)),
		dicomElement(0x0028, 0x0030, 'DS', text('0.5\\0.75')),
		dicomElement(0x0028, 0x0100, 'US', us(16)),
		dicomElement(0x0028, 0x0101, 'US', us(12)),
		dicomElement(0x0028, 0x0102, 'US', us(11)),
		dicomElement(0x0028, 0x0103, 'US', us(0)),
		dicomElement(0x0028, 0x1050, 'DS', text('-640')),
		dicomElement(0x0028, 0x1051, 'DS', text('1500')),
		dicomElement(0x0028, 0x1052, 'DS', text('-1024')),
		dicomElement(0x0028, 0x1053, 'DS', text('1')),
		dicomElement(0x7fe0, 0x0010, 'OW', pixels),
	]);
	const preamble = Buffer.alloc(132); preamble.write('DICM', 128, 'ascii');
	fs.writeFileSync(path.join(outputDir, 'synthetic-ct.dcm'), Buffer.concat([
		preamble, dicomElement(0x0002, 0x0000, 'UL', metaLength), metaBody, dataset
	]));
}

function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function ncName(value) {
	const raw = Buffer.from(value, 'ascii');
	return Buffer.concat([u32(raw.length), raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
}
function ncAttribute(name, type, values) {
	let raw;
	if (type === 2) { raw = Buffer.from(values, 'ascii'); }
	else { raw = Buffer.alloc(values.length * 4); values.forEach((v, i) => raw.writeFloatBE(v, i * 4)); }
	return Buffer.concat([ncName(name), u32(type), u32(type === 2 ? raw.length : values.length), raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
}

function writeNetCdf() {
	const dimensions = Buffer.concat([
		u32(10), u32(2), ncName('latitude'), u32(height), ncName('longitude'), u32(width)
	]);
	const attributes = [
		ncAttribute('units', 2, 'K'),
		ncAttribute('long_name', 2, 'synthetic surface temperature'),
		ncAttribute('_FillValue', 5, [-9999]),
	];
	const variablePrefix = Buffer.concat([
		u32(11), u32(1), ncName('temperature'), u32(2), u32(0), u32(1),
		u32(12), u32(attributes.length), ...attributes,
		u32(5), u32(width * height * 4),
	]);
	const headerWithoutBegin = Buffer.concat([
		Buffer.from([0x43, 0x44, 0x46, 0x01]), u32(0), dimensions, u32(0), u32(0), variablePrefix
	]);
	const dataOffset = headerWithoutBegin.length + 4;
	const data = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) { data.writeFloatBE(273.15 + y * 0.5 + x * 0.1, (y * width + x) * 4); }
	}
	fs.writeFileSync(path.join(outputDir, 'synthetic-temperature.nc'), Buffer.concat([headerWithoutBegin, u32(dataOffset), data]));
}


/**
 * Synthetic CZI: a 2x1 mosaic (so tile blitting is covered) across Z=0..2 and
 * C=0..1, Gray8, uncompressed. Segments are laid out exactly as ZISRAW requires:
 * a 512-byte file header, then subblocks, then the subblock directory.
 */
function writeCzi() {
	const tileWidth = 16;
	const tileHeight = height;
	const tilesX = 2;
	const sizeZ = 3;
	const sizeC = 2;
	const segment = (id, data, allocated = data.length) => {
		const header = Buffer.alloc(32);
		header.write(id, 0, 'ascii');
		header.writeBigInt64LE(BigInt(allocated), 16);
		header.writeBigInt64LE(BigInt(data.length), 24);
		return Buffer.concat([header, data, Buffer.alloc(allocated - data.length)]);
	};
	// DirectoryEntryDV: 32 fixed bytes + 20 bytes per dimension entry.
	const directoryEntry = (filePosition, dims) => {
		const entry = Buffer.alloc(32 + dims.length * 20);
		entry.write('DV', 0, 'ascii');
		entry.writeInt32LE(0, 2);                    // PixelType Gray8
		entry.writeBigInt64LE(BigInt(filePosition), 6);
		entry.writeInt32LE(0, 14);                   // FilePart
		entry.writeInt32LE(0, 18);                   // Compression: uncompressed
		entry.writeInt32LE(dims.length, 28);
		dims.forEach(([name, start, size], index) => {
			const at = 32 + index * 20;
			entry.write(name, at, 'ascii');
			entry.writeInt32LE(start, at + 4);
			entry.writeInt32LE(size, at + 8);
			entry.writeFloatLE(0, at + 12);
			entry.writeInt32LE(size, at + 16);       // StoredSize == Size: full resolution
		});
		return entry;
	};

	const xml = Buffer.from(`<ImageDocument><Metadata><Information><Image>`
		+ `<SizeX>${tileWidth * tilesX}</SizeX><SizeY>${tileHeight}</SizeY>`
		+ `<SizeZ>${sizeZ}</SizeZ><SizeC>${sizeC}</SizeC><PixelType>Gray8</PixelType>`
		+ `<Dimensions><Channels>`
		+ `<Channel Id="C0"><DyeName>DAPI</DyeName></Channel>`
		+ `<Channel Id="C1"><DyeName>GFP</DyeName></Channel>`
		+ `</Channels></Dimensions></Image></Information>`
		+ `<Scaling><Items><Distance Id="X"><Value>1e-007</Value></Distance></Items></Scaling>`
		+ `<ScalingX>1e-007</ScalingX><ScalingY>1e-007</ScalingY><ScalingZ>5e-007</ScalingZ>`
		+ `</Metadata></ImageDocument>`, 'utf8');
	const metadataSegment = segment('ZISRAWMETADATA', Buffer.concat([
		(() => { const fixed = Buffer.alloc(256); fixed.writeInt32LE(xml.length, 0); return fixed; })(),
		xml,
	]));

	const headerSize = 32 + 512;
	const subBlocks = [];
	const entries = [];
	let position = headerSize + metadataSegment.length;
	for (let z = 0; z < sizeZ; z++) {
		for (let c = 0; c < sizeC; c++) {
			for (let tile = 0; tile < tilesX; tile++) {
				const dims = [
					['X', tile * tileWidth, tileWidth], ['Y', 0, tileHeight],
					['Z', z, 1], ['C', c, 1], ['M', tile, 1],
				];
				const pixels = Buffer.alloc(tileWidth * tileHeight);
				for (let y = 0; y < tileHeight; y++) {
					for (let x = 0; x < tileWidth; x++) {
						// Encodes tile, z and c so tests can verify plane selection and placement.
						pixels[y * tileWidth + x] = (tile * 16 + x + z * 40 + c * 100) & 0xff;
					}
				}
				const inline = directoryEntry(position, dims);
				const fixed = Buffer.alloc(Math.max(256, 16 + inline.length));
				fixed.writeInt32LE(0, 0);                        // MetadataSize
				fixed.writeInt32LE(0, 4);                        // AttachmentSize
				fixed.writeBigInt64LE(BigInt(pixels.length), 8); // DataSize
				inline.copy(fixed, 16);
				const block = segment('ZISRAWSUBBLOCK', Buffer.concat([fixed, pixels]));
				subBlocks.push(block);
				entries.push(directoryEntry(position, dims));
				position += block.length;
			}
		}
	}

	const directoryPosition = position;
	const directoryData = Buffer.concat([
		(() => { const fixed = Buffer.alloc(128); fixed.writeInt32LE(entries.length, 0); return fixed; })(),
		...entries,
	]);
	const directorySegment = segment('ZISRAWDIRECTORY', directoryData);

	const fileHeader = Buffer.alloc(512);
	fileHeader.writeInt32LE(1, 0x00);   // Major
	fileHeader.writeInt32LE(0, 0x04);   // Minor
	fileHeader.writeInt32LE(0, 0x30);   // FilePart
	fileHeader.writeBigInt64LE(BigInt(directoryPosition), 0x34);
	fileHeader.writeBigInt64LE(BigInt(headerSize), 0x3c);  // MetadataPosition
	fileHeader.writeInt32LE(0, 0x44);   // UpdatePending
	fileHeader.writeBigInt64LE(0n, 0x48);

	fs.writeFileSync(path.join(outputDir, 'synthetic-stack.czi'), Buffer.concat([
		segment('ZISRAWFILE', fileHeader), metadataSegment, ...subBlocks, directorySegment,
	]));
}

writeFits();
writeDicom();
writeNetCdf();
writeCzi();
console.log(`Generated FITS, DICOM, NetCDF, and CZI samples in ${outputDir}`);
