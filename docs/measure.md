[← Documentation index](./index.md)

# Measurement and quantitative analysis

Open with `Ctrl`/`Cmd` + `Shift` + `M`, **Measure** from the right-click menu, or
**TIFF Visualizer: Measure** from the command palette. Everything lives in that
one panel, and nothing about it is visible until you open it.

## The guarantee that matters

**Statistics always run on the raw sample values, never on the displayed image.**
Change the normalization range, the gamma, the brightness or the colormap and
your measurements do not move. Non-finite samples (`NaN`, `±Inf`) are excluded
from statistics and the exclusion is reported — they are never quietly counted
as zero.

This is the difference between a measurement and a screenshot with numbers on
it.

## Panel layout

Five tabs:

| Tab | Purpose |
| --- | --- |
| **Tools** | Pick a drawing tool, set its options |
| **ROIs** | The list of regions you have drawn — rename, delete, save, exchange |
| **Results** | The measurement table, derived columns, grouping, export |
| **Segment** | Thresholding and particle analysis |
| **Scale** | Physical units — pixel size, unit name, origin |

Two chips in the panel header control what is drawn on the image:

| Chip | Key | Effect |
| --- | :---: | --- |
| **Mask** | `M` | The threshold overlay (Segment tab) |
| **ROIs** | `O` | The ROI outlines. Hiding them deletes nothing |
| — | hold `H` | Hide everything measurement-related while held |

They sit in the header rather than in a tab because comparing an overlay against
the image underneath is a glance, not a setting. Hold `H` when you want to see
what is actually under your segmentation; the `ROIs` chip is what you want when
you have two hundred objects on screen and want to try a different threshold
without the clutter.

## Tools

| Tool | Key | Notes |
| --- | :---: | --- |
| Select | `V` | Move and reshape existing ROIs |
| Rect | `R` | |
| Ellipse | `E` | |
| Polygon | `P` | Click vertices; double-click or `Enter` closes, `Esc` cancels |
| Freehand | `F` | Drag an outline |
| Line | `L` | Length, angle, and an intensity profile |
| Polyline | | Multi-segment path |
| Points | `N` | Counter markers. `Alt`-click removes the nearest |
| Wand | `W` | Magic wand — see below |
| Brush | `B` | Paint into the selected object. `Alt`-drag erases, scroll resizes |
| Trace edge | | Livewire — snaps to the strongest edge between clicks |

`Ctrl`/`Cmd` + `Z` undoes, with `Shift` to redo — a full history, not one level.
`Delete` removes the selection. `Esc` cancels an in-progress shape, or returns
to the Select tool.

Only the object you point at or have selected is named. Hovering anywhere on the
image highlights the object under the cursor, exactly as hovering a row in the
Results table does — so an object can be identified without clicking it.
**Show all ROI names** in the Tools tab opts into labelling everything.

Highlighting keeps each ROI's own colour in every state, because the colour is
what identifies it; emphasis comes from a white halo and a heavier line instead.

The image and the Results table stay in step in both directions:

- Clicking a row highlights its ROI and scrolls the image to it. The table
  itself does not move — you keep your place in the list.
- Clicking an object on the image selects its row and scrolls the table to it.
- Hovering either one highlights the other, without changing the selection.

That two-way link is how you find the outlier in a table of two hundred
objects — and it is precisely what a spreadsheet copy destroys permanently.

### The magic wand

Hover before you click: the wand **previews the region it would select** as you
move, and picks its own tolerance from the local image statistics. Scroll to
widen or tighten it live; `Shift`-click merges the new region into the selected
object instead of creating another one.

Most wand implementations make you guess a tolerance, click, undo, and guess
again. This one shows you the answer first.

### Line profiles

A line ROI produces an intensity profile along its length, plotted in the panel
and exportable on its own with **Export profile as CSV**. Raising **Line width**
averages a perpendicular band, which suppresses noise without blurring the
image. This is the standard way to check an edge response, a gradient, or the
flatness of a background.

## Measurements

The table in the Results tab shows the columns you look at while working:

ROI, channel, area, perimeter, length, mean, StdDev, min, max, circularity,
Feret.

**Exports contain considerably more.** Every populated column travels into the
CSV/xlsx:

| Group | Columns |
| --- | --- |
| Identity | File name, page, ROI id/name/kind, group, channel |
| Size | Pixel count, area, perimeter, length |
| Bounding box | BX, BY, width, height |
| Fitted ellipse | Major, minor, angle |
| Feret | Feret, min Feret, Feret angle, Feret X/Y |
| Shape | Circularity, aspect ratio, roundness, solidity |
| Position | Centroid X/Y, centre of mass X/Y |
| Intensity | Mean, StdDev, min, max, median, mode, skewness, kurtosis |
| Density | Integrated density (mean × area), raw integrated density (sum) |
| Quality | Count of non-finite samples excluded |

Geometry is calibrated; intensities are not, because a pixel value in µm-space
is still a pixel value. There is no column chooser yet — the visible set is
fixed and exports include everything present.

Multi-channel images produce one row per channel per ROI, marked in the **Ch**
column, once **Measure every channel** is switched on.

There is no "Redirect to" setting, because there is nothing to redirect:
measurements always read the original raw image. Segmenting on a processed copy
and measuring on the original is the default rather than a step you can forget.

### Derived columns

The Results tab accepts expressions that compute new columns from existing ones
— ratios, normalised intensities, corrections. Column names are used bare, e.g.
`rawIntegratedDensity / area`. Available: `+ - * / % ^`, parentheses, `pi`, `e`,
and `abs sqrt log log10 log2 exp min max pow round floor ceil sin cos tan atan2
sign`.

Identifiers that do not resolve for a given row evaluate to `NaN` rather than
throwing, so a column that only applies to area ROIs will not break the rows for
your line ROIs. Expressions are stored with the ROIs and travel into exports —
including the generated pandas script, where `^` is rewritten to `**` because
pandas reads `^` as bitwise XOR.

### Summary

With more than one row measured, the Results tab shows a **Summary** table: n,
mean, SD, SEM, min and max for every measured column. This is ImageJ's
"Summarize", and usually it is the actual deliverable — the per-object table is
the evidence, but the sentence that ends up in a methods section is "465 cells,
mean area 212 µm² ± 8".

### Grouping

**Filename pattern** in the Results tab captures grouping columns from the file
name: `{condition}_{replicate}_{index}.tif` turns the first two into real
columns. This is exactly the join people otherwise perform by hand in a
spreadsheet. When a pattern matches, the panel also shows a per-group summary
(n, mean, SEM) for reading — the exported file stays the raw long table, because
aggregating on export throws away the rows a reviewer needs to check the
aggregate.

## Scale and physical units

The **Scale** tab sets pixel size and unit. It is pre-filled automatically from
the file where the file says something:

- **OME-TIFF** physical pixel sizes (preferred — the acquisition software wrote
  them deliberately)
- **TIFF resolution tags** (`XResolution`, `YResolution`, `ResolutionUnit`)

Three deliberate refusals in that code, all worth knowing:

- A `ResolutionUnit` of "no absolute unit" is treated as *no calibration*, not
  as a silent default. It genuinely carries no physical meaning.
- A 1×1 resolution is ignored — that is what a writer emits when it has nothing
  to say, and treating it as "one pixel per inch" would be fiction.
- No unit conversion happens between different source spellings. Source metadata
  disagrees about `um` / `µm` / `micron` / `MICROMETER` often enough that
  guessing is a bad idea; the unit string you were given is the unit string you
  get.

If no calibration is found, measurements come out in pixels and say so.

### Setting the scale by hand

When the file carries nothing, use **Draw calibration line**: drag along a
feature whose real length you know — a scale bar, a calibration grid — then type
that length and its unit and press **Apply**. Pixels are assumed square for this
path, since one line cannot separate the two axes; enter anisotropic sizes
directly in the fields above instead.

A calibration you set by hand is never overwritten by a later automatic one.

## Thresholding

The **Segment** tab, top to bottom.

### 1. The histogram

The tab leads with the image histogram and a shaded band. **Drag either edge of
the band** to set the threshold range; the mask on the image follows
continuously. This is the everyday control — it answers "where in the
distribution am I cutting?", which is a different question from the one the
stability curve below answers.

### 2. Objects brighter or darker

**Objects are brighter than the background** flips the polarity of everything in
the tab. If your threshold appears to select exactly the wrong thing, this is
the first switch to check.

The local methods further down are published for document binarization, where
the foreground is *darker*; the polarity is normalised internally so each one
behaves as published in both directions.

### 3. Preprocessing

Gaussian blur and rolling-ball background subtraction, applied to **a copy used
only for thresholding**. The displayed image is never modified and your
measurements still read the raw values.

Background subtraction is the standard answer to uneven illumination — the usual
reason a global threshold seems to have no right value. Set **Background
radius** somewhat larger than your objects; `0` disables it.

### 4. The method gallery

All thirteen global auto-threshold methods and five local adaptive ones, side by
side, each with the value or parameters it would use:

| Method | When it helps |
| --- | --- |
| **Otsu** | Maximises between-class variance. The safe default for bimodal data. |
| **IsoData** | Iterative midpoint between class means. ImageJ's "Default". |
| **Li** | Minimum cross-entropy. Good when the object is a small fraction of the frame. |
| **Triangle** | Geometric; strong when one peak dominates and objects are faint. |
| **Yen** | Maximum correlation criterion. Tends to keep more of the object. |
| **Huang** | Fuzzy-set measure. Tolerant of a broad background peak. |
| **MaxEntropy** | Kapur-Sahoo-Wong entropy split. Favours faint structure. |
| **Mean** | The image mean. Crude, but a useful sanity reference. |
| **Moments** | Preserves the first three histogram moments. |
| **Percentile** | Assumes a fixed 50% foreground fraction. |
| **Shanbhag** | Information-measure variant of MaxEntropy. |
| **Minimum** | Valley between two peaks after smoothing. Needs a truly bimodal histogram. |
| **Intermodes** | Midpoint between two peaks after smoothing. |
| **Sauvola (local)** | Local mean and standard deviation. The usual first choice for uneven illumination. |
| **Niblack (local)** | Local mean minus k·σ. Sensitive in flat background regions. |
| **Phansalkar (local)** | Sauvola variant tuned for low-contrast stained images. |
| **Local mean** | Local mean minus a constant offset. |
| **Local median** | Local median minus a constant offset. Robust to speckle. |

**Hover any entry to see it on the image**; click to keep it. All of these are
one choice — only ever one is applied. Selecting any of them reveals a
**Neighbourhood** section with the window radius, plus a **Sensitivity (k)** for
the Sauvola family.

### Any method, per window

**Apply the chosen method per window** runs whichever of the thirteen
statistical methods you picked on the histogram of a local neighbourhood instead
of the whole image — ImageJ's "Auto Local Threshold". Use it when the criterion
is right but the illumination is not even: patchy lighting where an object in
one corner is darker than the background in another, which no single global cut
can handle.

Two things worth knowing about this mode:

- A window containing nothing but background still *has* a histogram, and every
  method above will happily split it. A minimum-contrast guard suppresses that,
  so flat regions stay empty. Real edges in the background — the boundary
  between two differently lit areas — are genuine structure and will still be
  picked up.
- A smooth *gradient* defeats the contrast guard, because every window across it
  contains a real range of values. Use Sauvola for that case, or subtract the
  background first; both are designed for it.

The range handles on the histogram are greyed out while any adaptive method is
active, because it computes its own threshold per pixel and the range is not in
use. Dragging a handle takes manual control back and switches the adaptive
method off.

Showing them together turns method choice into an observation instead of a
tradition. If eight methods agree within a few grey levels, the threshold is
real. If they scatter across the range, your segmentation problem is not going
to be solved by picking one.

### 5. Is the threshold robust?

Press **Compute** and the panel sweeps the threshold across its whole range,
plotting how many objects each value produces (line) and how much of the image
is selected (fill).

A **plateau** is a stretch of thresholds that all give essentially the same
answer — that is a robust threshold, and the panel reports the widest one and
its centre. A steep slope everywhere means the answer depends on a number you
are guessing, and the image probably wants local adaptive thresholding instead.

Click or drag across the plot to adopt a value directly, or press **Use the most
stable threshold**.

A threshold sitting on a plateau is defensible in review; one sitting on a slope
is not. Nothing else in the tab tells you which of the two you have.

### Reading the overlay

While the Segment tab is doing anything, the result is painted over the image:

- **Red** — selected by the threshold
- **Green** — survives the particle filters below and would be added as an ROI

Red-without-green is "thresholded, then filtered out", which is otherwise
invisible and the usual reason an object count surprises you. Toggle the whole
thing with the **Mask** chip or `M`, and hold `H` to check it against the raw
image.

## Particle analysis

Once you have a mask, the Particles section turns it into one ROI per object:

**Split touching** decides how objects that thresholding merged are separated:

| Mode | Use when |
| --- | --- |
| **Do not split** | Objects are already separate |
| **By shape (watershed)** | Round objects overlap, so their outline pinches between them |
| **By intensity maxima** | Objects touch *without* the outline pinching — nuclei packed edge to edge, where a shape watershed finds one blob |

Intensity maxima is ImageJ's **Find Maxima** with output *Segmented Particles*.
**Prominence** is how far a peak must rise above the saddle joining it to a
brighter one before it counts as its own object — note that this is not the
peak's absolute height, which is the usual source of confusion. The panel
reports how many centres the current value accepts, so you turn the number until
the count matches what you can see.

In ImageJ this workflow needs two images and an `AND` in the Image Calculator:
one from Find Maxima, one from the threshold. Here the threshold mask is simply
the region the maxima are found in, so the combination is implicit and there is
nothing to keep in sync.

The remaining filters:

- **Fill holes** — close interior gaps
- **Exclude objects touching the edge** — objects clipped by the frame have
  meaningless area and shape, so this is usually the correct choice
- **Min area (px)** / **Max area (px)** — drop debris below and merged clumps
  above. `0` for the maximum means no upper limit
- **Min circularity** — drop elongated artefacts

Every filter repaints immediately, so you see *which* objects a filter removes
rather than only a smaller number. The count line also breaks down the
rejections by reason.

The tab ends with the step it exists for: a highlighted **Add N objects as
ROIs** button that names the count. Pressing it commits them to the ROI list,
after which they measure like anything else, the Results table fills in, and the
filled preview switches off so their outlines stay readable. If the count is
zero the button says so and points at whichever filter removed everything.

## Saving and sharing ROIs

ROIs are stored in a readable JSON sidecar next to the image
(`image.tif.rois.json`), not in an opaque binary. Consequences:

- ROI changes **diff in code review** like any other file
- You can edit or generate them from a script
- They travel with the image in version control

They are also kept in the editor's own state, so moving the tab, splitting the
editor, or an extension host restart does not discard work you have not saved
yet.

For exchange with ImageJ/Fiji, both directions of ImageJ's `.roi` and
`RoiSet.zip` formats are supported. Segmented (mask) ROIs export as their traced
outline, which loses interior holes; everything else round-trips exactly.

## Exporting results

Four buttons in the Results tab:

| Export | Format |
| --- | --- |
| **CSV** | Long/tidy CSV with full provenance |
| **CSV (de)** | Semicolon separator, comma decimal mark — for German-locale Excel |
| **Excel .xlsx** | Real xlsx, no CSV-import dance |
| **pandas script** | A Python starter script |

Exports open in a side editor without taking focus, so the image and your
measurement session stay as they were.

The tidy/long shape is chosen so the file goes straight into pandas, R or a
plotting library without reshaping. Provenance — the scale in force, the
threshold used and its value, any preprocessing, the ROI count — is repeated on
every row, so several exports concatenate without bookkeeping and a results CSV
found six months later still says how it was produced.

The **pandas script** is generated from your actual session: the columns that
exist, the scale in force, the threshold used, the channel handling your image
needs, and your derived columns written out as real expressions. It is a
starting point that already matches your data, rather than a generic template.

## Not yet available

Worth knowing before you plan a workflow around this:

- No column chooser — the visible table is a fixed set, exports include all
  populated columns. ImageJ's "Set Measurements" has no equivalent; everything
  is always measured
- One image per export; there is no folder-wide results table yet
- The ROI sidecar is written and read on request, not loaded automatically when
  an image opens
- No rotated rectangle/ellipse handles
- No machine-learning segmentation — that is deliberately out of scope
