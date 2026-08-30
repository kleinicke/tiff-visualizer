import fs from 'node:fs';
import path from 'node:path';

// Rebuilds the benchmark corpus: symlinks every listed source into one folder
// and writes manifest.json + README.md describing it.
//
// The corpus is symlinks rather than copies because it is 1.2GB and every file
// already exists elsewhere. That makes it fragile by design, which is exactly
// why the real path of each entry is recorded in the manifest: when a link
// breaks, the manifest says what it pointed at.
//
//   node scripts/benchmark-corpus.mjs [--root <dir>]
const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const DATA = process.env.TIFF_TEST_DATA || '/Users/florian/Projects/cursor/test_data';
const B = rootArg >= 0 ? args[rootArg + 1] : path.join(DATA, 'benchmark');

// Where each file actually lives. Checked in order; first hit wins.
const SEARCH = [
  DATA,
  path.join(DATA, 'depth_scene'),
  path.join(DATA, 'testfiles/scientific'),
  path.join(DATA, 'testfiles/layered'),
  path.join(DATA, 'images-advanced/avif'),
  path.join(DATA, 'images-advanced/jxl'),
  path.join(DATA, 'images-advanced/webp'),
  path.join(DATA, 'images-advanced/tga'),
  path.join(DATA, 'images-advanced/hdr'),
];
function findSource(name) {
  for (const dir of SEARCH) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) { return fs.realpathSync(candidate); }
  }
  return null;
}

// group -> [file, note]. The depth family is one 5120x5120 scene re-encoded, so
// those rows are directly comparable; the others are coverage, not comparison.
const GROUPS = {
  'depth-family': {
    description: 'One 5120x5120 depth scene re-encoded into every format that can hold it. Rows here ARE directly comparable: same pixels, same dimensions, only the container and sample type change.',
    files: {
      'nl_01_depth.tif': 'float32, uncompressed strips - the reference case',
      'nl_01_depth_x2.tif': 'float32 at 10240x10240 - 4x the pixels, for scaling behaviour',
      'nl_01_depth.exr': 'float32 mono, zip-compressed scanlines',
      'nl_01_depth.npy': 'float32, raw with a text header - the zero-copy fast path',
      'nl_01_depth.npz': 'the same npy inside a STORED (uncompressed) zip',
      'nl_01_depth.pfm': 'float32, native-endian - the other zero-copy fast path',
      'nl_01_depth.fits': 'float32 BIG-endian, bottom-up rows - forces a byte-swap pass',
      'nl_01_depth_norm.hdr': 'RGBE, RLE-compressed - the only format still on the CPU render path',
      'nl_01_depth_norm_q92.jpg': 'uint8 lossy - smallest file, dominated by fixed overhead',
      'nl_01_depth_norm_u16.png': 'uint16 mono, zlib + filters - serial inflate, no parallelism available',
      'nl_01_depth_norm_u16.pgm': 'uint16 mono binary - main-thread decode (cheaper than a worker hop)',
      'nl_01_depth_norm_rgb_u16.ppm': 'uint16 RGB binary - largest raw payload at 150MB',
      'nl_01_depth_norm.tga': 'uint8 BGR, bottom-up',
      'nl_01_depth_norm.bmp': 'uint8 BGR, bottom-up, row-padded',
    },
  },
  predictors: {
    description: 'Same 5120x5120 scene re-encoded across the TIFF predictor/sample-format matrix, to check that the strip-parallel decode path covers all of them and not just the predictor-3 float case it was first built for. Plus one real half-float file.',
    files: {
      'pred1_f32_none.tif': 'predictor 1 (none), float32, uncompressed - memory-bandwidth bound',
      'pred1_f32_deflate.tif': 'predictor 1, float32, Deflate',
      'pred1_u16_deflate.tif': 'predictor 1, uint16, Deflate',
      'pred2_u16_deflate.tif': 'predictor 2 (horizontal), uint16, Deflate',
      'pred2_rgb8_deflate.tif': 'predictor 2, 8-bit RGB - smallest strips, scales worst',
      'l_00_l_01_f300_w1600_h1600.tif': 'predictor 3 with FLOAT16 samples, 3600x3000 - the case the first implementation rejected',
    },
  },
  'utif-compatible': {
    description: 'Synthetic TIFFs used for head-to-head measurements against the Marketplace preview-tiff extension. Every file is decoded correctly by both implementations.',
    files: {
      'preview-tiff-extensive-bench/gray16-640-uncompressed.tiff': '640x480 uint16 grayscale, uncompressed',
      'preview-tiff-extensive-bench/gray8-2112-lzw.tif': '2112x2112 uint8 grayscale, LZW + predictor 2',
      'preview-tiff-extensive-bench/gray8-2112-packbits.tif': '2112x2112 uint8 grayscale, PackBits',
      'preview-tiff-extensive-bench/gray8-2112-uncompressed.tif': '2112x2112 uint8 grayscale, uncompressed',
      'preview-tiff-extensive-bench/rgb16-640-uncompressed.tiff': '640x480 uint16 RGB, uncompressed',
      'preview-tiff-extensive-bench/rgb8-2964-lzw.tif': '2964x2000 uint8 RGB, LZW + predictor 2',
      'preview-tiff-extensive-bench/rgb8-640-uncompressed.tiff': '640x480 uint8 RGB, uncompressed',
    },
  },
  containers: {
    description: 'Real-world scientific and layered documents. These are COVERAGE, not comparison - different scenes, sizes and channel layouts. Use them to catch regressions per decoder, not to rank formats.',
    files: {
      '0002.DCM': 'DICOM single frame',
      'channel.nc': 'classic NetCDF, multi-variable',
      '2-capzbHi1858_Homo_MF20_Phalloidin_72hpf_b.czi': 'Zeiss CZI, multi-scene microscopy',
      'EUVEngc4151imgx.fits': 'real telescope FITS (small, unlike the synthetic one above)',
      'eagle.ora': 'OpenRaster layer stack',
      'eagle_af_5k.psd': 'Photoshop, largest file in the corpus',
      'eagle.layers_2.xcf': 'GIMP XCF layer stack',
      '2026-06-22_Article-illustration-about-Wacom-and-other-brands-on-Linux.kra': 'Krita layer stack',
    },
  },
  codecs: {
    description: 'Small files exercising the browser-native and JXL codec paths. All are well under 1MB, so their totals are ~500ms of fixed webview overhead and the decode itself is close to invisible. Present for correctness coverage; do not read speed into them.',
    files: {
      'storage_bw_uint8.jxl': '', 'storage_rgb_uint8.jxl': '', 'storage_rgb_uint16.jxl': '', 'storage_rgb_float32.jxl': '',
      'storage_bw_uint8.webp': '', 'storage_rgb_uint8.webp': '',
      'storage_bw_uint8.avif': '', 'storage_rgb_uint8.avif': '', 'storage_rgb_uint16.avif': '',
      'storage_bw_uint8.tga': '', 'storage_rgb_uint8.tga': '',
      'storage_bw_float32.hdr': '', 'storage_rgb_float32.hdr': '', 'storage_rgb_uint16.hdr': '',
    },
  },
};

fs.mkdirSync(B, { recursive: true });
// Drop stale links first so a removed entry does not linger in the corpus.
function dropSymlinks(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) { fs.unlinkSync(full); }
    else if (stat.isDirectory()) { dropSymlinks(full); }
  }
}
dropSymlinks(B);
for (const spec of Object.values(GROUPS)) {
  for (const name of Object.keys(spec.files)) {
    const source = findSource(name);
    if (source) {
      const destination = path.join(B, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination);
    }
  }
}

function listCorpusEntries(dir, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!relative && (name.startsWith('.') || name.endsWith('.json') || name.endsWith('.md'))) { continue; }
    const full = path.join(dir, name);
    const nested = relative ? path.join(relative, name) : name;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) { entries.push(...listCorpusEntries(full, nested)); }
    else { entries.push(nested); }
  }
  return entries;
}
const present = new Set(listCorpusEntries(B));
const manifest = { generated: new Date().toISOString().slice(0, 10), root: B, groups: {} };
let missing = [], unlisted = new Set(present);

for (const [group, spec] of Object.entries(GROUPS)) {
  const entries = [];
  for (const [name, note] of Object.entries(spec.files)) {
    unlisted.delete(name);
    const link = path.join(B, name);
    if (!fs.existsSync(link)) { missing.push(`${group}/${name}`); continue; }
    const real = fs.realpathSync(link);
    entries.push({ name, bytes: fs.statSync(real).size, source: real, note });
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  manifest.groups[group] = {
    description: spec.description,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    files: entries,
  };
}
if (missing.length) console.warn('MISSING (listed but not present):', missing.join(', '));
if (unlisted.size) console.warn('UNLISTED (present but not in manifest):', [...unlisted].join(', '));

fs.writeFileSync(path.join(B, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const mb = b => (b / 1048576).toFixed(1);
let md = `# Benchmark corpus\n\nGenerated ${manifest.generated}. Entries are **symlinks**, not copies — moving or renaming a\nsource file breaks the corpus, which is why every real path is recorded in\n\`manifest.json\`. Regenerate with \`scripts/benchmark-corpus.mjs\`.\n\nRun one group at a time. Absolute timings are only comparable **within** a single\nrun: a run over all ${present.size} files (${mb([...present].reduce((n, f) => n + fs.statSync(fs.realpathSync(path.join(B, f))).size, 0))} MB) shows noticeably inflated totals\nversus a smaller run, because of memory pressure.\n`;
for (const [group, g] of Object.entries(manifest.groups)) {
  md += `\n## ${group} — ${g.files.length} files, ${mb(g.totalBytes)} MB\n\n${g.description}\n\n| file | MB | notes |\n| --- | ---: | --- |\n`;
  for (const f of g.files) md += `| \`${f.name}\` | ${mb(f.bytes)} | ${f.note} |\n`;
}
fs.writeFileSync(path.join(B, 'README.md'), md);
console.log(`manifest.json + README.md written: ${Object.values(manifest.groups).reduce((n, g) => n + g.files.length, 0)} files, ${mb(Object.values(manifest.groups).reduce((n, g) => n + g.totalBytes, 0))} MB`);
