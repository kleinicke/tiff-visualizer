[← Documentation index](./index.md)

# Collections and comparison

Three different ways to look at more than one image, for three different
questions.

| You want to | Use |
| --- | --- |
| Flip through many related files in one tab | **Collection** |
| Put two images next to each other and scroll both | **Side-by-side compare** |
| Compute the difference, or mask one with another | [**Layers view**](./layers.md) |

## Collections

A collection is an ordered list of images sharing one editor tab. Instead of
twenty tabs for twenty frames, you get one tab and the arrow keys.

**Adding images** — run **Add Images to Collection** from the Command Palette
and give a path or a glob, or right-click in the Explorer:

- On a file → **Add Image to Visualizer Collection**
- On a folder → **Add Folder Images to Visualizer Collection**

**Navigating** — `←` and `→`. An overlay shows your position (`2 / 5`) whenever
the collection holds more than one image, and lets you jump directly or remove
entries.

Images are preloaded so switching is immediate rather than a fresh decode each
time.

**Why this beats tabs:** display settings are session-wide, so with a fixed
manual [normalization range](./rendering.md) every frame in the collection is
mapped identically. Flipping between them with the arrow keys makes real
differences pop out, because nothing else about the rendering is changing.

Collection state survives switching to another tab and back, and is restored if
the webview reloads.

## Side-by-side comparison

For a genuine two-panel comparison:

1. Open the first image and run **Select Image for Side-by-Side Compare**
2. Open the second image
3. Run **Compare Side by Side with Selected**

Both commands are in the right-click menu inside the viewer.

This uses VS Code's native editor-group layout with a complete Scientific Image
Visualizer on each side — full HDR and scientific decoding, GPU acceleration,
histogram and pixel inspection in both panes. It is not a screenshot diff.

VS Code's built-in image diff remains available for browser-native formats, but
its internal image renderer cannot be replaced with a TIFF/HDR-capable one,
which is why this exists as a separate command.

**Open Comparison Gallery (Legacy Renderer)** opens the older single-panel
gallery. It is kept for workflows that depend on it; new work should use the
side-by-side commands.

## Choosing between them

The honest decision rule:

- **Comparing appearance** — collection, with a fixed manual range. Flipping in
  place beats side-by-side for spotting change, because your eye compares
  against memory of the same screen position.
- **Comparing detail in context** — side-by-side, when you need to point at two
  things at once.
- **Comparing values** — layers view with difference blending. Your eye is bad
  at judging whether two greys differ by 2%; a difference image is not.
