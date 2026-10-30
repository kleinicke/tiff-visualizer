const fs = require('fs');

/**
 * hyparquet 1.31 reads one byte past the end of a page when the last
 * bit-packed group of a dictionary index column is padded (the padding values
 * are discarded anyway), which throws on Xenium's cells.parquet. Stop the
 * group once the output is full.
 */
const SEARCH = 'while (count) {';
const REPLACE = 'while (count && seen < output.length) {';

function patchHyparquetEncoding() {
  return {
    name: 'patch-hyparquet-encoding',
    setup(build) {
      build.onLoad({ filter: /hyparquet[\\/]src[\\/]encoding\.js$/ }, async args => {
        const source = await fs.promises.readFile(args.path, 'utf8');
        if (!source.includes(SEARCH)) {
          throw new Error('hyparquet encoding.js changed; revisit esbuild-hyparquet-patch.js');
        }
        return { contents: source.replace(SEARCH, REPLACE), loader: 'js' };
      });
    },
  };
}

module.exports = { patchHyparquetEncoding };
