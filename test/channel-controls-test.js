const assert = require('assert');
const fs = require('fs');
const ts = require('typescript');
const vm = require('vm');

// Exercise the production functions without booting the entire webview.
function extract(file, names) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found = {};
    function visit(node) {
        if (node.name && names.includes(node.name.getText(source))) found[node.name.getText(source)] = node.getText(source);
        ts.forEachChild(node, visit);
    }
    visit(source);
    return names.map(name => { assert.ok(found[name], name); return found[name]; }).join('\n');
}
function run(code, context) {
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
}

async function main() {
    const nav = {
        currentLoadFormat: 'PNG/JPEG', tiffProcessor: {}, datasetManifest: null,
        controlsFromSelectors: (_namespace, selectors) => selectors, bandDescription: () => null,
        hideNavOverlay: () => {}, renderNavOverlay: () => { throw new Error('Non-TIFF must not populate TIFF overlay'); },
    };
    run(extract('media/imagePreview.ts', ['tiffBandControls', 'updateTiffPageOverlay']), nav);
    for (const format of ['PNG/JPEG', 'EXR', 'NPY', 'Web Image', 'DICOM']) {
        nav.currentLoadFormat = format;
        for (const count of [undefined, 0, 4]) {
            nav.tiffProcessor = { selectableBandCount: count };
            assert.equal(nav.tiffBandControls().length, 0, `${format} with dormant or retained TIFF state`);
            nav.updateTiffPageOverlay();
        }
    }
    nav.currentLoadFormat = 'TIFF';
    for (const count of [undefined, NaN, 0, 1]) {
        nav.tiffProcessor = { selectableBandCount: count };
        assert.equal(nav.tiffBandControls().length, 0);
    }
    nav.tiffProcessor = { selectableBandCount: 4, displayBand: 0 };
    assert.equal(nav.tiffBandControls().length, 2, 'multiband TIFF retains view and band choices');
    nav.tiffProcessor.displayRgbBands = [0, 1, 2];
    assert.equal(nav.tiffBandControls().length, 4, 'multiband RGB retains three band mappings');

    let pixels;
    const png = {
        bootstrapImageFor: () => null,
        Image: class {
            naturalWidth = 2; naturalHeight = 1; listeners = {};
            addEventListener(name, fn) { this.listeners[name] = fn; }
            set src(_value) { queueMicrotask(this.listeners.load); }
        },
        document: { createElement: () => ({ classList: { add() {} }, getContext: () => ({
            drawImage() {}, getImageData: () => ({ data: pixels }),
        }) }) },
        queueMicrotask,
    };
    run('class Reader {\n' + extract('media/modules/png-processor.ts', ['_processWithNativeAPI', 'getColorAtPixel']) + '\n}\nglobalThis.Reader = Reader;', png);
    for (const [sourceChannels, values, expected] of [
        [1, [32, 32, 32, 255, 64, 64, 64, 255], '64'],
        [2, [32, 32, 32, 255, 64, 64, 64, 128], '64 α:0.50'],
        [1, [32, 32, 32, 255, 64, 64, 64, 0], '64 α:0.00'],
        [3, [32, 32, 32, 255, 10, 20, 30, 255], '010 020 030'],
    ]) {
        pixels = Uint8ClampedArray.from(values);
        const reader = new png.Reader();
        reader.settingsManager = { settings: {} };
        reader._postFormatInfo = () => {};
        await reader._processWithNativeAPI('image.png', undefined, sourceChannels);
        assert.equal(reader.getColorAtPixel(1, 0, 2, 1), expected);
        assert.equal(reader._lastRaw.channels, 4, 'canvas storage stride stays RGBA');
        if (sourceChannels === 1 && values[7] === 255) {
            reader.settingsManager.settings.normalizedFloatMode = true;
            assert.equal(reader.getColorAtPixel(1, 0, 2, 1), (64 / 255).toPrecision(4));
        }
    }
    console.log('Channel controls and native PNG grayscale/RGB readouts passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
