Distribution and growth strategy — Scientific Image Visualizer and 3D Visualizer

Research date: 5 September 2026. Based on both local repositories, public registry metadata, live website HTML, and the platform documentation linked below. Effort ranges are planning estimates for one developer familiar with these projects; they exclude review queues and are not implementation commitments. Platform availability is not a claim that either extension has been tested in that platform.

**Recommendation**

Build recognition around two related tools for inspecting scientific files locally, with consistent branding and shared distribution infrastructure. Retain the existing extension IDs and websites. Keep the image and 3D engines separately loadable and maintain thin integrations around them.

The strongest expansion sequence is: improve conversion on existing channels; offer installable web apps and targeted demos; add Python/notebook access; validate a desktop release; then add JetBrains or specialist integrations in response to repeated demand. Broader format support alone will not make people discover the tools. Every supported application area needs a credible example, a searchable explanation, and a convenient entry point.

**Verified baseline**

| Product | VS Marketplace installations | Open VSX downloads | Open VSX version | GitHub stars |
| --- | ---: | ---: | --- | ---: |
| Scientific Image Visualizer | 2,873 | 18,568 | 1.10.1 | 7 |
| 3D Point Cloud and Mesh Visualizer | 12,948 | 12,123 | 1.8.0 | 15 |

Read from the public [image Marketplace listing](https://marketplace.visualstudio.com/items?itemName=kleinicke.tiff-visualizer), [3D Marketplace listing](https://marketplace.visualstudio.com/items?itemName=kleinicke.ply-visualizer), [image Open VSX API](https://open-vsx.org/api/kleinicke/tiff-visualizer/latest), [3D Open VSX API](https://open-vsx.org/api/kleinicke/ply-visualizer/latest), and the two GitHub repository APIs. The Marketplace describes its displayed metric as unique installations excluding updates; Open VSX reports downloads. Do not add these together or treat either as active users. Both Open VSX versions match the inspected local manifests.

Both browser websites returned HTTP 200. This check verified public availability and HTML metadata, not interactive correctness. Existing public listings also describe the browser editions.

Local findings:

- The image extension has both Node and browser entry points. Its standalone host is `web/browser-host.ts`; decoding is already in the plain Rust `scientific-image-decoders` crate with WASM adapters.
- The 3D project already separates its shared engine in `engine/` from the VS Code host. Its manifest has no browser entry point, and its provider imports Node `fs` and `path`. A standalone browser engine does not automatically make the extension a VS Code web extension.
- Both root package manifests lack a homepage field; both public GitHub repository homepage fields are empty.
- The image website has description, canonical and social metadata, but no linked app manifest. The 3D website has an app manifest, but its inspected HTML lacks a search description and social preview metadata.
- The 3D app manifest does not register file handlers. No service-worker registration was found in the inspected host sources. Verify offline behavior before advertising either edition as offline-capable.
- Both websites initialize Plausible. The inspected host sources did not reveal a custom successful-open funnel. Access to the analytics dashboard was not part of this research.
- The image-to-3D browser handoff and 3D guided examples already exist. Promote and improve those existing paths.
- The manifests contain 56 image keywords and 41 3D keywords. VS Code currently documents a 30-keyword maximum; curate these before the next release. This is a metadata mismatch, not evidence that the existing publications failed. The 3D repository has an MIT license file but no root manifest license field. [Extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest).

**Where to distribute, ordered by expected value relative to effort**

| Destination | Adaptation and practical route | Estimated effort | Priority |
| --- | --- | --- | --- |
| Cursor, Windsurf, Positron, VSCodium | Existing Open VSX releases are the distribution foundation. Test file opening, commands, export, workers and large-file behavior in each; add specific install instructions. | 2–5 days for an initial compatibility campaign | Immediate |
| Theia, code-server and institutional remote workspaces | Use existing VSIX/Open VSX distribution. Test remote URIs, file reads and saves, companion files and host-version compatibility. Offer reproducible workspace setup examples. | 2–5 days initially; fixes vary | High |
| vscode.dev, github.dev, GitLab Web IDE | Validate the image web extension. Add a browser host to the 3D extension, replace Node-only filesystem assumptions and bundle browser dependencies. Test virtual workspaces and binary-file limits. | Image 1–3 days; 3D 1–3 weeks | High |
| Installable web apps | Add/complete manifests, icons, offline asset caching, update behavior and supported file handlers; retain ordinary file picking everywhere. Cache lazy WASM modules deliberately. | 3–7 days for both, plus device QA | High |
| Hugging Face Spaces | Publish purpose-built static demos of depth inspection and Gaussian-splat/point-cloud inspection using the existing builds. Link back to canonical product pages. | 1–3 days | High experiment |
| Python and notebook outputs | Package a small Python API and an anywidget-based view with bundled JS/WASM. Start with NumPy images and XYZ/RGB arrays. Distribute on PyPI; consider conda-forge once stable. | 1–3 weeks for a focused beta | Highest-value new integration hypothesis |
| JupyterLab file browser | Add an actual document viewer, including authenticated file retrieval and companion-file resolution. Distribute a prebuilt Python package. This is distinct from showing an array in a notebook cell. | 1–3 additional weeks | High after notebook validation |
| Windows, macOS, Linux desktop | Wrap the browser engines with native open/save, file associations, recent files, folder access, CLI launch and updates. Release downloadable builds, then package-manager/store editions. | 3–6 weeks for a credible three-OS beta | High if offline/double-click demand is repeated |
| PyCharm, IntelliJ, CLion and related JetBrains IDEs | New Kotlin/Java host, custom file editor and JCEF browser embedding; reuse JS/WASM engines. Publish through JetBrains Marketplace after host/GPU tests. | 3–6 weeks for both in one shared host | Second wave |
| npm and crates.io | Publish a stable embedding API or decoder API with examples. Confirm existing package availability and naming first. Native/Python use of the decoder is possible without embedding the full viewer. | 1–3 weeks for a deliberately small API | Strategic, after an adopter appears |
| napari, QGIS, Blender, Fiji/ImageJ | Prefer useful readers/exporters or an external-viewer handoff. Full native viewport integration is a separate project. | Handoff: days; native integration: weeks or longer | Demand-led |

Cursor documents Open VSX behind its own marketplace proxy, so registry publication does not guarantee immediate in-app visibility. It also documents a publisher verification process using reciprocal links on your own website. Windsurf uses Open VSX, while Positron's current default is Posit's mirror of the Open VSX catalog. Prioritize Positron because its data-science audience fits the image viewer particularly well. [Cursor extensions](https://prod.cursor.com/help/customization/extensions), [Windsurf registry](https://marketplace.windsurf.com/), [Positron extensions](https://positron.posit.co/extensions.html).

Theia and code-server document Open VSX integration; GitLab's Web IDE defaults to Open VSX. Each has a different host/runtime boundary. In particular, a browser UI backed by a remote Node extension host can run extensions that a browser-only host cannot. Codespaces belongs in the remote-workspace test matrix, rather than being treated as identical to github.dev. [Theia](https://theia-ide.org/docs/user_install_vscode_extensions/), [code-server](https://coder.com/docs/code-server/FAQ), [GitLab](https://docs.gitlab.com/user/project/web_ide/), [VS Code web extensions](https://code.visualstudio.com/api/extension-guides/web-extensions).

**The most promising new integration: Python**

The user should be able to inspect a computed array without writing a temporary file, choosing a plotting backend, or exporting an 8-bit approximation. Design an API along the lines of `show_image(array)` and `show_points(xyz, colors=rgb)`; these are proposed names, not existing APIs. Start with view, inspect, normalize, and compare. Return selected measurements or camera state later, once needed.

anywidget provides a route into JupyterLab, Jupyter, VS Code notebooks, Colab and marimo, but every host still needs testing. Use binary buffers for arrays; avoid base64/JSON serialization for large datasets. Decide explicitly how embedded WASM, worker URLs, widget cleanup and versioning work. A hosted kernel's arrays must travel to the user's browser: promise that you do not send them to your own service, rather than claiming they never leave the kernel machine. [anywidget](https://docs.anywidget.dev/en/getting-started/).

JupyterLab's file-browser viewer is a second entry point and needs its own document registration. Jupyter recommends prebuilt extensions distributed in Python packages; its current extension manager discovers suitably classified packages on PyPI. [Development guide](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html), [extension manager](https://jupyterlab.readthedocs.io/en/stable/user/extensions.html).

**Standalone programs and stores**

Start with PWAs as the cheapest way to test demand for an installed application. Browser file associations have limited availability, so advertise the exact browser/OS combinations tested. A manifest alone does not prove offline decoding works. [PWA file handling](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Associate_files_with_your_PWA).

For native desktop packaging, I would prototype Electron first because it bundles Chromium and is closer to the existing VS Code rendering environment. Tauri is worth a parallel technical comparison within that prototype if package size matters, but uses different system webviews across operating systems. Existing Rust code does not eliminate the need to test WebGPU/WebGL, WASM workers, exports and splat rendering in those webviews. Neither wrapper alone removes canvas or memory limits. [Electron](https://www.electronjs.org/docs/latest/), [Tauri webviews](https://v2.tauri.app/reference/webview-versions/).

Ship direct Windows/macOS/Linux releases with signing/notarization where applicable, then:

- Windows: WinGet and Microsoft Store. A PWA Store package is also possible before a full native wrapper.
- macOS: direct notarized download and a Homebrew tap; seek the main cask repository once eligible. Consider the Mac App Store after file/folder workflows are proven.
- Linux: direct package/AppImage initially, then Flatpak/Flathub. Add further formats only when users request them.

Store inclusion involves submission and review, not just compilation. [WinGet](https://learn.microsoft.com/en-us/windows/package-manager/package/repository), [Microsoft Store PWA route](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store), [Homebrew casks](https://docs.brew.sh/Acceptable-Casks), [Flathub](https://docs.flathub.org/docs/for-app-authors/submission).

**Serve each supported field with a specific workflow**

These are proposed acquisition campaigns, not claims that every listed community will accept promotional posts or that search demand has been measured.

| Audience | First useful demonstration | Discovery and adoption route |
| --- | --- | --- |
| Computer vision / ML | Inspect float depth and NaNs, then open the same data as a calibrated point cloud | Python examples, dataset READMEs, Hugging Face demo, course notebooks |
| Microscopy / bioimaging | Open OME-TIFF or CZI, composite channels, measure an ROI and export a table | Image.sc, microscopy facilities, workshop material; preserve ImageJ ROI exchange |
| Robotics / SLAM | Inspect a PCD/KITTI cloud alongside a depth map and calibration | Robotics tutorials, research code examples, lab workspace templates |
| Gaussian splatting / reconstruction | Open a 3DGS export, switch between splats and centers, inspect opacity | Reconstruction project docs and community demos; emphasize exported artifacts |
| LiDAR / surveying | Open LAS/LAZ or a multi-scan E57 and inspect classification/intensity | Surveying and photogrammetry tutorials, field-to-office handoff examples |
| VFX / rendering | Inspect EXR values, tune exposure and compare renders | Rendering guides and developer communities; describe supported EXR variants accurately |
| Astronomy | Open a FITS HDU and inspect its range and pixel data | Astronomy notebook examples and research-group documentation |
| Earth science / GIS | Inspect GeoTIFF coordinates or a classic NetCDF variable | Geospatial tutorials and dataset links; make NetCDF-4/HDF5 and large-raster limitations visible |
| Medical-imaging research | Navigate a supported DICOM study without uploading it to a viewer service | Research/teaching demonstrations; retain the existing research-use scope |
| Creative-document exchange | Preview PSD/KRA/XCF and see which operations are approximated | Format-specific guides aimed at recipients of those files |
| Meshes / fabrication | Inspect an exported STL/OBJ/GLB | Export-validation tutorials; avoid implying CAD or slicer functionality |

Start actively with computer vision plus microscopy. They use existing strengths, and computer vision connects both products. Give the other fields accurate evergreen pages first; expand active outreach where usage appears.

Fiji, CloudCompare and Nerfstudio already serve substantial analysis, point-cloud processing and training-viewer workflows. Position these products around quick inspection, local processing, convenient installation and exchange with those workflows. Broad replacement claims would create expectations beyond current scope. ImageJ explicitly directs its community toward Image.sc. [Fiji](https://imagej.net/learn/), [Image.sc community route](https://imagej.net/discuss/chat), [CloudCompare](https://cloudcompare.org/doc/wiki/index.php/Introduction), [Nerfstudio viewer](https://docs.nerf.studio/quickstart/viewer_quickstart.html).

**A repeatable growth system**

1. Publish a small set of useful, indexable pages: float TIFF, EXR, OME-TIFF/CZI, FITS, NPY depth, LAS/LAZ, E57 and Gaussian splats. Each gets an actual supported sample, a short demonstration, limitations, and clear browser/install buttons. These are keyword hypotheses; validate impressions before creating dozens of pages.
2. Improve the first minute. Add image samples, promote the existing 3D guided example, explain one useful interaction, and show contextual help for failed opens. Lead public copy with the task accomplished; put Rust/WASM implementation details lower down.
3. Make outputs and tutorials carry adoption. Provide screenshots, reproducible view settings, a citation file, and copyable dataset-viewer links for public samples. A local file cannot become a shareable public URL without an explicit data-sharing mechanism.
4. Seek maintainer-approved examples in complementary projects and course material. A useful tutorial or workspace recommendation can bring repeated qualified users. Start with ten carefully chosen projects/labs; prepare an actual example for each relevant workflow.
5. Cross-promote at the moment of need: depth inspection to the existing 3D handoff, and image/3D companion links on both install pages. Offer an optional extension pack once setup is consistent; preserve users' choice of default editor for overlapping formats.
6. Use one substantive launch on Show HN or a suitable developer community after onboarding works. Follow with workflow-specific videos and updates. Product Hunt and software directories can be secondary experiments; measure their contribution instead of assuming traffic will retain.

For Hugging Face, publish an actual static build or dedicated demo. The image site's current `frame-ancestors 'none'` blocks embedding it as an iframe elsewhere. Build a separate embedding surface with intentional origin and asset policies; keep the regular viewer's policy intact. Remote dataset links also need CORS, companion-file resolution and an explicit private-data story. [Static Spaces](https://huggingface.co/docs/hub/en/spaces-sdks-static).

**90-day execution plan**

| Period | Deliverables | Decision evidence |
| --- | --- | --- |
| Days 1–14 | Homepage/license/keyword cleanup; updated install pages and screenshots; initial editor matrix; sample onboarding; release synchronization; baseline measurements | Successful-open rate by entry page and format family; registry install/download trends kept separate |
| Days 15–30 | Six to eight useful format/workflow pages; complete PWA beta; two focused public demos; prepare ten targeted integration/tutorial proposals | Which workflows bring successful real-file opens, repeat sessions and support requests |
| Days 31–60 | Focused Python/anywidget beta; document viewer only if file-browser demand is strong; fix top failure modes; pursue selected tutorial partnerships | At least five external people use their own data repeatedly, and at least two teams/course owners reuse an example |
| Days 61–90 | Choose one major expansion: desktop beta or JetBrains beta, based on user evidence; launch the strongest proven workflow | New channel delivers repeat use at a maintenance cost you can sustain |

This is a prioritized sequence, not a requirement to finish all optional integrations in 90 days. If working part-time, extend the calendar while keeping the ordering. Reserve time for existing users and compatibility fixes. A useful initial allocation is 40% onboarding/discovery, 40% integration work, 20% reliability/support, then adjust using results.

Measure successful user-file opens, failure rate, time to first useful interaction and repeat use where measurable with consent. Separate demo opens from real-file opens. Plausible page views alone cannot establish retained users; anonymous aggregate usage also cannot reliably deduplicate a person across editors/devices. Use voluntary beta follow-ups or opt-in cohort measurement for retention. Avoid sending filenames, paths, image contents, DICOM metadata or dataset URLs in analytics.

Suggested experiment gates, not forecasts: improve weekly successful web sessions to 3× the first two-week baseline; attain repeated use by five independent beta users; obtain two externally maintained tutorials/integrations. A 10× longer-term adoption ambition is reasonable to test, but current public counters do not support a growth prediction.

**What to defer**

JetBrains is feasible, but JCEF availability, browser lifecycle, large-file transfer and remote IDE behavior require a new host and testing. [JCEF documentation](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html).

For napari, a decoder-backed reader can return arrays and metadata to its native layers. For QGIS or Blender, a focused import/export or external-viewer handoff is easier than replacing their viewport. Establish a real unmet need first; these ecosystems already have viewers and importers. [napari contributions](https://napari.org/stable/plugins/building_a_plugin/guides.html), [QGIS publishing](https://plugins.qgis.org/docs/publish), [Blender Extensions](https://extensions.blender.org/about/).

Do not budget a minor Zed port: its documented extension categories do not establish a general custom webview editor API suitable for these engines. Use a future desktop/CLI handoff unless a suitable API is confirmed. Classic Eclipse and Visual Studio also require separate plugin models; Theia and VS Code distribution do not cover them. [Zed extensions](https://zed.dev/docs/extensions), [Theia versus Eclipse](https://theia-ide.org/docs/faq/).

Mobile app stores, browser extensions, full CAD/GIS/clinical workflows and an AI/MCP integration should wait for a concrete user need. Browser and desktop file-opening already address much of the access problem. An AI integration would need useful structured inspection/export operations and would not itself make the visual UI available inside every agent environment.
