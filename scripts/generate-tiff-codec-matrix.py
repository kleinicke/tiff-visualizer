#!/usr/bin/env python3
"""Generate a broad, reproducible TIFF codec/tag corpus from two real images.

Uses tifffile/imagecodecs for the core matrix, then libtiff, ImageMagick, and
FFmpeg for independently encoded and less-common TIFF organizations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from PIL import Image


DEFAULT_DEPTH = Path('/Users/florian/Projects/cursor/test_data/benchmark/nl_01_depth.tif')
DEFAULT_PHOTO = Path('/Users/florian/Projects/cursor/test_data/images/IMG_0272.jpeg')
DEFAULT_OUTPUT = Path('/Users/florian/Projects/cursor/test_data/tiff-codec-tag-matrix')


def cli() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--depth', type=Path, default=DEFAULT_DEPTH)
    parser.add_argument('--photo', type=Path, default=DEFAULT_PHOTO)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


class Matrix:
    def __init__(self, output: Path) -> None:
        self.output = output
        self.records: list[dict[str, Any]] = []
        self.failures: list[dict[str, str]] = []

    def _record_failure(self, name: str, encoder: str, error: BaseException | str) -> None:
        message = str(error).strip()
        self.failures.append({'name': name, 'encoder': encoder, 'error': message[-2000:]})
        print(f'  SKIP {name}: {message.splitlines()[-1]}')

    def write(self, name: str, data: np.ndarray, *, encoder: str = 'tifffile', **kwargs: Any) -> Path | None:
        path = self.output / name
        try:
            tifffile.imwrite(path, data, **kwargs)
            self.records.append({'name': name, 'encoder': encoder})
            print(f'  wrote {name}')
            return path
        except Exception as error:
            path.unlink(missing_ok=True)
            self._record_failure(name, encoder, error)
            return None

    def command(self, name: str, encoder: str, command: list[str]) -> Path | None:
        path = self.output / name
        try:
            subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if not path.exists() or path.stat().st_size == 0:
                raise RuntimeError('encoder produced no output')
            self.records.append({'name': name, 'encoder': encoder})
            print(f'  wrote {name}')
            return path
        except Exception as error:
            path.unlink(missing_ok=True)
            if isinstance(error, subprocess.CalledProcessError):
                error = error.stderr or error.stdout or error
            self._record_failure(name, encoder, error)
            return None


def orientation_tag(value: int) -> list[tuple[int, str, int, int, bool]]:
    return [(274, 'H', 1, value, False)]


def orientation_storage(data: np.ndarray, value: int) -> np.ndarray:
    """Store the inverse transform so an Orientation-aware viewer shows `data`."""
    transforms = {
        1: lambda a: a,
        2: np.fliplr,
        3: lambda a: np.rot90(a, 2),
        4: np.flipud,
        5: lambda a: np.swapaxes(a, 0, 1),
        6: lambda a: np.rot90(a, 1),
        7: lambda a: np.flipud(np.fliplr(np.swapaxes(a, 0, 1))),
        8: lambda a: np.rot90(a, -1),
    }
    return np.ascontiguousarray(transforms[value](data))


def geotiff_tags() -> list[tuple[int, str, int, Any, bool]]:
    return [
        (33550, 'd', 3, (0.25, 0.25, 0.0), False),
        (33922, 'd', 6, (0.0, 0.0, 0.0, 500000.0, 5400000.0, 0.0), False),
        (34735, 'H', 16, (1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32632), False),
        (34737, 's', 8, 'WGS 84|', False),
    ]


def generate_tifffile(matrix: Matrix, depth: np.ndarray, rgb: np.ndarray) -> None:
    print('tifffile/imagecodecs variants')
    depth_common = dict(photometric='minisblack', metadata=None)
    matrix.write('depth_f32_none_one_strip.tif', depth, rowsperstrip=depth.shape[0], **depth_common)
    matrix.write('depth_f32_none_rows16.tif', depth, rowsperstrip=16, **depth_common)
    matrix.write('depth_f32_deflate_pred1_rows64.tif', depth, compression='deflate', predictor=1, rowsperstrip=64, **depth_common)
    matrix.write('depth_f32_deflate_pred3_rows12.tif', depth, compression='deflate', predictor=3, rowsperstrip=12, **depth_common)
    matrix.write('depth_f32_deflate_pred3_tile256.tif', depth, compression='deflate', predictor=3, tile=(256, 256), **depth_common)
    matrix.write('depth_f32_lzw_pred1_rows64.tif', depth, compression='lzw', predictor=1, rowsperstrip=64, **depth_common)
    matrix.write('depth_f32_lzw_pred3_rows16.tif', depth, compression='lzw', predictor=3, rowsperstrip=16, **depth_common)
    matrix.write('depth_f32_lzw_pred3_tile256.tif', depth, compression='lzw', predictor=3, tile=(256, 256), **depth_common)
    matrix.write('depth_f32_packbits_rows32.tif', depth, compression='packbits', rowsperstrip=32, **depth_common)
    matrix.write('depth_f32_zstd_pred1_rows64.tif', depth, compression='zstd', predictor=1, compressionargs={'level': 7}, rowsperstrip=64, **depth_common)
    matrix.write('depth_f32_zstd_pred3_tile256.tif', depth, compression='zstd', predictor=3, compressionargs={'level': 7}, tile=(256, 256), **depth_common)
    matrix.write('depth_f32_lzma_pred3_rows32.tif', depth, compression='lzma', predictor=3, compressionargs={'level': 6}, rowsperstrip=32, **depth_common)
    matrix.write('depth_f32_deflate_pred3_big_endian.tif', depth, compression='deflate', predictor=3, byteorder='>', rowsperstrip=32, **depth_common)
    matrix.write('depth_f32_deflate_pred3_bigtiff.tif', depth, compression='deflate', predictor=3, bigtiff=True, rowsperstrip=32, **depth_common)
    matrix.write('depth_f32_orientation_bottomright.tif', orientation_storage(depth, 3), compression='deflate', predictor=3, rowsperstrip=32, extratags=orientation_tag(3), **depth_common)
    matrix.write('depth_f32_orientation_righttop.tif', orientation_storage(depth, 6), compression='deflate', predictor=3, rowsperstrip=32, extratags=orientation_tag(6), **depth_common)
    matrix.write('depth_f32_geotiff_tags.tif', depth, compression='deflate', predictor=3, rowsperstrip=32, extratags=geotiff_tags(), **depth_common)
    matrix.write('depth_f16_deflate_pred3.tif', depth.astype(np.float16), compression='deflate', predictor=3, rowsperstrip=32, **depth_common)
    finite = np.nan_to_num(depth, nan=0.0, posinf=0.0, neginf=0.0)
    lo, hi = np.percentile(finite, (0.1, 99.9))
    normalized = np.clip((finite - lo) / max(float(hi - lo), 1e-12), 0, 1)
    matrix.write('depth_u16_deflate_pred2.tif', np.round(normalized * 65535).astype(np.uint16), compression='deflate', predictor=2, rowsperstrip=32, **depth_common)
    matrix.write('depth_i16_deflate_pred2.tif', np.round((normalized - 0.5) * 65534).astype(np.int16), compression='deflate', predictor=2, rowsperstrip=32, **depth_common)
    matrix.write('depth_f64_zstd_pred3.tif', depth.astype(np.float64), compression='zstd', predictor=3, compressionargs={'level': 5}, rowsperstrip=16, **depth_common)
    matrix.write('depth_ome_f32_deflate.tif', depth, compression='deflate', predictor=3, ome=True, metadata={'axes': 'YX'})
    matrix.write('depth_multipage_f32_deflate.tif', np.stack((depth, np.flipud(depth))), compression='deflate', predictor=3, metadata={'axes': 'QYX'})

    rgb_common = dict(photometric='rgb', metadata=None)
    matrix.write('photo_rgb8_none_one_strip.tif', rgb, rowsperstrip=rgb.shape[0], **rgb_common)
    matrix.write('photo_rgb8_none_rows16.tif', rgb, rowsperstrip=16, **rgb_common)
    matrix.write('photo_rgb8_none_tile256.tif', rgb, tile=(256, 256), **rgb_common)
    matrix.write('photo_rgb8_deflate_pred1_rows64.tif', rgb, compression='deflate', predictor=1, rowsperstrip=64, **rgb_common)
    matrix.write('photo_rgb8_deflate_pred2_rows32.tif', rgb, compression='deflate', predictor=2, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_deflate_pred2_tile128.tif', rgb, compression='deflate', predictor=2, tile=(128, 128), **rgb_common)
    matrix.write('photo_rgb8_lzw_pred1_rows64.tif', rgb, compression='lzw', predictor=1, rowsperstrip=64, **rgb_common)
    matrix.write('photo_rgb8_lzw_pred2_rows32.tif', rgb, compression='lzw', predictor=2, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_lzw_pred2_tile256.tif', rgb, compression='lzw', predictor=2, tile=(256, 256), **rgb_common)
    matrix.write('photo_rgb8_packbits_rows32.tif', rgb, compression='packbits', rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_packbits_tile256.tif', rgb, compression='packbits', tile=(256, 256), **rgb_common)
    matrix.write('photo_rgb8_zstd_pred2_rows32.tif', rgb, compression='zstd', predictor=2, compressionargs={'level': 7}, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_lzma_pred2_rows32.tif', rgb, compression='lzma', predictor=2, compressionargs={'level': 6}, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_deflate_pred2_big_endian.tif', rgb, compression='deflate', predictor=2, byteorder='>', rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_lzw_pred2_bigtiff.tif', rgb, compression='lzw', predictor=2, bigtiff=True, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb8_planar_separate_deflate.tif', np.moveaxis(rgb, -1, 0), compression='deflate', predictor=2, planarconfig='separate', photometric='rgb', metadata=None)
    matrix.write('photo_rgb8_orientation_topleft.tif', rgb, compression='deflate', predictor=2, extratags=orientation_tag(1), **rgb_common)
    matrix.write('photo_rgb8_orientation_topright.tif', orientation_storage(rgb, 2), compression='deflate', predictor=2, extratags=orientation_tag(2), **rgb_common)
    matrix.write('photo_rgb8_orientation_leftbottom.tif', orientation_storage(rgb, 8), compression='deflate', predictor=2, extratags=orientation_tag(8), **rgb_common)
    rgba = np.concatenate((rgb, np.full((*rgb.shape[:2], 1), 160, dtype=np.uint8)), axis=2)
    matrix.write('photo_rgba8_unassociated_alpha.tif', rgba, compression='deflate', predictor=2, photometric='rgb', extrasamples='unassalpha', metadata=None)
    matrix.write('photo_rgba8_associated_alpha.tif', rgba, compression='lzw', predictor=2, photometric='rgb', extrasamples='assocalpha', metadata=None)
    gray = np.round(rgb @ np.array([0.2126, 0.7152, 0.0722])).astype(np.uint8)
    matrix.write('photo_gray8_minisblack_lzw.tif', gray, compression='lzw', predictor=2, photometric='minisblack', metadata=None)
    matrix.write('photo_gray8_miniswhite_packbits.tif', 255 - gray, compression='packbits', photometric='miniswhite', metadata=None)
    palette_image = np.asarray(Image.fromarray(rgb).quantize(colors=256), dtype=np.uint8)
    palette = np.asarray(Image.fromarray(rgb).quantize(colors=256).getpalette(), dtype=np.uint8).reshape(-1, 3)[:256]
    colormap = np.zeros((3, 256), dtype=np.uint16)
    colormap[:, :len(palette)] = (palette.T.astype(np.uint16) * 257)
    matrix.write('photo_palette8_lzw.tif', palette_image, compression='lzw', photometric='palette', colormap=colormap, metadata=None)
    matrix.write('photo_rgb16_deflate_pred2.tif', rgb.astype(np.uint16) * 257, compression='deflate', predictor=2, rowsperstrip=32, **rgb_common)
    matrix.write('photo_rgb_f32_zstd_pred3.tif', rgb.astype(np.float32) / 255.0, compression='zstd', predictor=3, rowsperstrip=32, **rgb_common)
    matrix.write('photo_ome_rgb8_deflate.tif', rgb, compression='deflate', predictor=2, ome=True, metadata={'axes': 'YXS'})

    pyramid = matrix.output / 'photo_rgb8_pyramid_subifds.tif'
    try:
        resampling = getattr(Image, 'Resampling', Image).LANCZOS
        half = np.asarray(Image.fromarray(rgb).resize((rgb.shape[1] // 2, rgb.shape[0] // 2), resampling))
        quarter = np.asarray(Image.fromarray(rgb).resize((rgb.shape[1] // 4, rgb.shape[0] // 4), resampling))
        with tifffile.TiffWriter(pyramid) as writer:
            writer.write(rgb, photometric='rgb', compression='deflate', predictor=2, tile=(256, 256), subifds=2, metadata=None)
            writer.write(half, photometric='rgb', compression='deflate', predictor=2, tile=(256, 256), subfiletype=1, metadata=None)
            writer.write(quarter, photometric='rgb', compression='deflate', predictor=2, tile=(256, 256), subfiletype=1, metadata=None)
        matrix.records.append({'name': pyramid.name, 'encoder': 'tifffile'})
        print(f'  wrote {pyramid.name}')
    except Exception as error:
        pyramid.unlink(missing_ok=True)
        matrix._record_failure(pyramid.name, 'tifffile', error)


def generate_external(matrix: Matrix, photo_source: Path) -> None:
    print('libtiff/ImageMagick/FFmpeg variants')
    base = matrix.output / 'photo_rgb8_none_rows16.tif'
    tiffcp = shutil.which('tiffcp')
    if tiffcp and base.exists():
        variants = {
            'photo_libtiff_jpeg_ycbcr_q85.tif': ['-c', 'jpeg:85'],
            'photo_libtiff_jpeg_rgb_q85.tif': ['-c', 'jpeg:r:85'],
            'photo_libtiff_zstd_pred2_tile256.tif': ['-t', '-w', '256', '-l', '256', '-c', 'zstd:2:p9'],
            'photo_libtiff_lzma_pred2_rows32.tif': ['-s', '-r', '32', '-c', 'lzma:2:p8'],
            'photo_libtiff_planar_separate_lzw.tif': ['-p', 'separate', '-c', 'lzw:2'],
            'photo_libtiff_fillorder_lsb_packbits.tif': ['-f', 'lsb2msb', '-c', 'packbits'],
            'photo_libtiff_big_endian_deflate.tif': ['-B', '-c', 'zip:2:p9'],
            'photo_libtiff_bigtiff_lzw.tif': ['-8', '-c', 'lzw:2'],
        }
        for name, options in variants.items():
            matrix.command(name, 'libtiff 4.7.1', [tiffcp, *options, str(base), str(matrix.output / name)])

    magick = shutil.which('magick')
    if magick:
        commands = {
            'photo_imagemagick_cmyk_zip.tif': ['-colorspace', 'CMYK', '-compress', 'Zip'],
            'photo_imagemagick_palette_lzw.tif': ['-colors', '256', '-type', 'Palette', '-compress', 'LZW'],
            'photo_imagemagick_bilevel_group4.tif': ['-colorspace', 'Gray', '-threshold', '50%', '-type', 'Bilevel', '-compress', 'Group4'],
            'photo_imagemagick_gray_lzma.tif': ['-colorspace', 'Gray', '-compress', 'LZMA'],
            'photo_imagemagick_rgba_zstd.tif': ['-alpha', 'set', '-channel', 'A', '-evaluate', 'set', '70%', '+channel', '-compress', 'Zstd'],
            'photo_imagemagick_ptif_pyramid.tif': ['-define', 'ptif:pyramid=true', '-compress', 'Zip'],
        }
        for name, options in commands.items():
            output = matrix.output / name
            matrix.command(name, 'ImageMagick/libtiff', [magick, str(photo_source), *options, str(output)])

    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg:
        for codec in ('raw', 'packbits', 'lzw', 'deflate'):
            name = f'photo_ffmpeg_{codec}_rgb24.tif'
            matrix.command(name, 'FFmpeg TIFF', [
                ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(photo_source),
                '-frames:v', '1', '-pix_fmt', 'rgb24', '-c:v', 'tiff', '-compression_algo', codec,
                str(matrix.output / name),
            ])


def tag_value(page: tifffile.TiffPage, name: str, default: Any = None) -> Any:
    tag = page.tags.get(name)
    value = tag.value if tag else default
    if hasattr(value, 'name'):
        return value.name
    if isinstance(value, tuple):
        return [getattr(item, 'name', item) for item in value]
    return value


def build_manifest(matrix: Matrix, depth_source: Path, photo_source: Path) -> None:
    successful: list[dict[str, Any]] = []
    for record in matrix.records:
        path = matrix.output / record['name']
        try:
            with tifffile.TiffFile(path) as tif:
                page = tif.pages[0]
                info = {
                    **record,
                    'bytes': path.stat().st_size,
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    'byteOrder': tif.byteorder,
                    'bigtiff': tif.is_bigtiff,
                    'pages': len(tif.pages),
                    'shape': list(page.shape),
                    'dtype': str(page.dtype),
                    'compression': tag_value(page, 'Compression'),
                    'predictor': tag_value(page, 'Predictor', 1),
                    'photometric': tag_value(page, 'PhotometricInterpretation'),
                    'planarConfiguration': tag_value(page, 'PlanarConfiguration', 1),
                    'orientation': tag_value(page, 'Orientation', 1),
                    'tiled': page.is_tiled,
                    'tile': [tag_value(page, 'TileWidth'), tag_value(page, 'TileLength')] if page.is_tiled else None,
                    'rowsPerStrip': tag_value(page, 'RowsPerStrip'),
                    'samplesPerPixel': tag_value(page, 'SamplesPerPixel', 1),
                    'bitsPerSample': tag_value(page, 'BitsPerSample'),
                    'sampleFormat': tag_value(page, 'SampleFormat', 1),
                    'extraSamples': tag_value(page, 'ExtraSamples', []),
                    'subifds': len(page.pages) if page.pages is not None else 0,
                }
            successful.append(info)
        except Exception as error:
            matrix._record_failure(record['name'], record['encoder'] + ' manifest inspection', error)

    manifest = {
        'generated': datetime.now(timezone.utc).isoformat(),
        'sources': {'depth': str(depth_source.resolve()), 'photo': str(photo_source.resolve())},
        'tools': {
            'tifffile': tifffile.__version__,
            'tiffcp': shutil.which('tiffcp'),
            'magick': shutil.which('magick'),
            'ffmpeg': shutil.which('ffmpeg'),
        },
        'fileCount': len(successful),
        'totalBytes': sum(item['bytes'] for item in successful),
        'files': successful,
        'failedVariants': matrix.failures,
    }
    (matrix.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    readme = [
        '# TIFF codec and tag matrix', '',
        f'Generated from `{depth_source}` and `{photo_source}`.', '',
        f'{len(successful)} valid TIFF files, {manifest["totalBytes"] / 1048576:.1f} MiB total.', '',
        'Regenerate from `tiff-visualizer` with:', '',
        '```bash',
        'uv run --with tifffile --with imagecodecs --with pillow python scripts/generate-tiff-codec-matrix.py',
        '```', '',
        'See `manifest.json` for exact encoder, dimensions, dtype, compression, predictor,',
        'photometric interpretation, organization, byte order, and SHA-256 metadata.', '',
    ]
    if matrix.failures:
        readme += [f'{len(matrix.failures)} requested encoder combinations were unavailable and are recorded under `failedVariants`.', '']
    (matrix.output / 'README.md').write_text('\n'.join(readme))


def main() -> None:
    args = cli()
    args.output.mkdir(parents=True, exist_ok=True)
    depth = tifffile.imread(args.depth)
    rgb = np.asarray(Image.open(args.photo).convert('RGB'))
    print(f'depth {depth.shape} {depth.dtype}; photo {rgb.shape} {rgb.dtype}')
    matrix = Matrix(args.output)
    generate_tifffile(matrix, depth, rgb)
    generate_external(matrix, args.photo)
    build_manifest(matrix, args.depth, args.photo)
    print(f'Generated {len(matrix.records)} TIFFs in {args.output}')
    if matrix.failures:
        print(f'{len(matrix.failures)} variants failed; see manifest.json')


if __name__ == '__main__':
    main()
