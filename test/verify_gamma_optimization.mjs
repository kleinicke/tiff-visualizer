import assert from 'assert';

console.log('🧪 Verifying Gamma Optimization Logic...\n');

// Mock Browser Environment
global.window = {
    GeoTIFF: {}
};
global.UPNG = {};

// Mock Settings Manager
class MockSettingsManager {
    constructor() {
        this.settings = {
            gamma: { in: 1.0, out: 1.0 },
            brightness: { offset: 0 },
            normalization: { gammaMode: true, autoNormalize: false }
        };
    }
}

// Mock VS Code
const mockVscode = {
    postMessage: () => { }
};

async function runTests() {
    try {
        // Dynamic imports to ensure globals are set first
        const { TiffProcessor } = await import('../out/media/modules/tiff-processor.js');
        const { ExrProcessor } = await import('../out/media/modules/exr-processor.js');
        const { PngProcessor } = await import('../out/media/modules/png-processor.js');

        console.log('📋 Testing TiffProcessor...');
        const tiffSettingsManager = new MockSettingsManager();
        const tiffProcessor = new TiffProcessor(tiffSettingsManager, mockVscode);

        // Test 1: Optimization (Identity)
        tiffSettingsManager.settings.gamma.in = 1.0;
        tiffSettingsManager.settings.gamma.out = 1.0;
        tiffSettingsManager.settings.brightness.offset = 0;

        let input = 0.5;
        let output = tiffProcessor._applyGammaAndBrightness(input, tiffSettingsManager.settings);
        assert.strictEqual(output, input, 'Should return input value when gamma is identity and brightness is 0');
        console.log('    ✅ Optimization works (Identity)');

        // Test 2: Computation (Gamma Change)
        tiffSettingsManager.settings.gamma.in = 2.2;
        tiffSettingsManager.settings.gamma.out = 1.0;

        output = tiffProcessor._applyGammaAndBrightness(input, tiffSettingsManager.settings);
        let expected = Math.pow(input, 2.2);
        assert(Math.abs(output - expected) < 0.0001, `Expected ${expected}, got ${output}`);
        console.log('    ✅ Computation works (Gamma Change)');


        console.log('\n📋 Testing ExrProcessor...');
        const exrSettingsManager = new MockSettingsManager();
        const exrProcessor = new ExrProcessor(exrSettingsManager, mockVscode);

        // Test 1: Optimization
        const gamma = { in: 1.0, out: 1.0 };
        const brightness = { offset: 0 };

        input = 0.5;
        output = exrProcessor._applyGammaAndBrightness(input, gamma, brightness);
        assert.strictEqual(output, input, 'Should return input value when gamma is identity and brightness is 0');
        console.log('    ✅ Optimization works (Identity)');

        // Test 2: Computation
        gamma.in = 2.2;
        output = exrProcessor._applyGammaAndBrightness(input, gamma, brightness);
        expected = Math.pow(input, 2.2);
        assert(Math.abs(output - expected) < 0.0001, `Expected ${expected}, got ${output}`);
        console.log('    ✅ Computation works (Gamma Change)');


        console.log('\n📋 Testing PngProcessor...');
        const pngSettingsManager = new MockSettingsManager();
        const pngProcessor = new PngProcessor(pngSettingsManager, mockVscode);

        // Test 1: Optimization
        pngSettingsManager.settings.gamma.in = 1.0;
        pngSettingsManager.settings.gamma.out = 1.0;
        pngSettingsManager.settings.brightness.offset = 0;

        input = 0.5;
        output = pngProcessor._applyGammaAndBrightness(input, pngSettingsManager.settings);
        assert.strictEqual(output, input, 'Should return input value when gamma is identity and brightness is 0');
        console.log('    ✅ Optimization works (Identity)');

        // Test 2: Computation
        pngSettingsManager.settings.gamma.in = 2.2;
        output = pngProcessor._applyGammaAndBrightness(input, pngSettingsManager.settings);
        expected = Math.pow(input, 2.2);
        assert(Math.abs(output - expected) < 0.0001, `Expected ${expected}, got ${output}`);
        console.log('    ✅ Computation works (Gamma Change)');

        console.log('\n🎉 All gamma optimization tests passed!');
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    }
}

runTests();
