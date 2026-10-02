# Scientific Image Visualizer for JetBrains

Standalone image plugin, version 0.4.4, ID `imagevisualizer`.
Builds solely from this repository. The independent 3D plugin lives in
`ply-visualizer/jetbrains`; neither plugin requires the other at build time.

## Build and try

Requires JDK 21, Node 24, root npm dependencies (`npm ci`) and the existing
WASM artifacts used by the website build.

```sh
cd jetbrains
./gradlew test buildPlugin
./gradlew verifyPlugin
./gradlew runIde
```

Install `build/distributions/scientific-image-visualizer-jetbrains-0.4.4.zip`
using Settings → Plugins → gear → Install Plugin from Disk, then restart.
Remove the old `Scientific Image and 3D Visualizers` prototype first: its old ID
means it is not replaced automatically. The standalone 3D Visualizer can remain installed.

The development IDE opens `../../test_data`; override with
`-PviewerTestProject=/absolute/path`. JCEF debugging uses port 9223 in `runIde` only.

## Scope and validation

Image associations are generated from this repository's VS Code manifest:
`node scripts/register-formats.mjs --check`. Common built-in image types retain
their IDE identity and alternative editor. Geometry formats are not registered.
All viewer assets are bundled locally, including workers and WASM.
Native image status widgets, macOS pan/pinch adapters and the image engine are retained.

Compatibility starts at build 243 with no artificial upper build limit.
Plugin Verifier passes PyCharm 2024.3.5 and 2026.2.3; future IDE API changes
can still require updates. JCEF is required. Editor state is not restored on reopen.
Format registration does not establish full variant support in this host.

After a Gradle build, run the Java-host browser smoke check:

```sh
node scripts/smoke-viewers.mjs /absolute/path/sample.tif
```

This exercises image loading, status updates, gamma/range changes and the pan
bridge. It does not replace a clean IDE install or physical trackpad checks.
See [release checklist](RELEASE.md) for the remaining publication gates and
[prototype history](PROTOTYPE-HISTORY.md) for earlier development results.

## Marketplace description

[DESCRIPTION.md](DESCRIPTION.md) is the Marketplace page and the IDE plugin
description. The build writes it into `plugin.xml`, and each upload replaces the
Marketplace text with it. Update it whenever a user-visible feature, format or
limitation changes in this host; its header says which section to use. Release
notes stay in `<change-notes>` in `plugin.xml`.

## Release signing

Use the signing environment variables listed in RELEASE.md, or pass
`-PsigningDirectory=/absolute/private/directory` containing `chain.crt` and
`private.pem` to `signPlugin verifyPluginSignature`. Keep private keys outside
source control. Dependency notices are collected automatically from the local
npm and Cargo dependency installations during packaging.

Verify an installed IDE without downloading another SDK with
`./gradlew verifyPlugin -PverificationIde=/Applications/PyCharm.app`.

Local builds and tests use the installed `/Applications/PyCharm.app` (override with
`-PlocalIde=/path/to/IDE`). Verification defaults to that same current IDE; older
IDE versions are no longer downloaded or tested. The declared minimum compatibility
version is unchanged; historical verification does not validate future changes.
