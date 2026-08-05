[← Documentation index](./index.md)

# Measurement and quantitative analysis

Open with `Ctrl`/`Cmd` + `Shift` + `M`, or **Measure** from the right-click menu.
Everything lives in that one panel, and nothing about it is visible until you
open it.

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
| **ROIs** | The list of regions you have drawn — rename, reorder, delete |
| **Results** | The measurement table, derived columns, export |
| **Segment** | Thresholding and particle analysis |
| **Scale** | Physical units — pixel size, unit name, origin |

## Tools

| Tool | Key | Notes |
| --- | :---: | --- |
| Select | `V` | Move and reshape existing ROIs |
| Rect | `R` | |
| Ellipse | `E` | |
| Polygon | `P` | Click vertices, close to finish |
| Freehand | `F` | Drag an outline |
| Line | `L` | Length, angle, and an intensity profile |
| Polyline | | Multi-segment path |
| Points | `N` | Individual sample points |
| Wand | `W` | Magic wand — see below |
| Brush | `B` | Paint a mask region |
| Trace edge | | Livewire — follows image edges between clicks |

Clicking a row in the Results table highlights its ROI on the image, and
selecting an ROI highlights its row. That two-way link is how you find the
outlier in a table of two hundred objects.

### The magic wand

Hover before you click: the wand **previews the region it would select** as you
move, and picks its own tolerance from the local image statistics. Most wand
implementations make you guess a tolerance, click, undo, and guess again. This
one shows you the answer first.

### Line profiles

A line ROI produces an intensity profile along its length, plotted in the panel
and exportable on its own with **Export profile as CSV**. This is the standard
way to check an edge response, a gradient, or the flatness of a background.

## Measurements

Available columns:

| Column | Meaning |
| --- | --- |
| Area | In calibrated square units |
| Perimeter | Outline length |
| Length | For line and polyline ROIs |
| Mean, StdDev, Min, Max | Intensity statistics over the ROI |
| Median, Mode | Robust centre estimates |
| Skewness, Kurtosis | Distribution shape |
| Integrated density | Mean × area |
| Centroid | Geometric centre |
| Fitted ellipse | Major/minor axis, angle |
| Feret diameter | Maximum caliper width, with angle and endpoints |
| Circularity | 4π·area / perimeter² — 1.0 is a perfect circle |

Multi-channel images produce one row per channel per ROI, marked in the **Ch**
column.

### Derived columns

The Results tab accepts expressions that compute new columns from existing ones
— ratios, normalised intensities, corrections. Identifiers that do not resolve
for a given row evaluate to `NaN` rather than throwing, so a column that only
applies to area ROIs will not break the rows for your line ROIs.

## Scale and physical units

The **Scale** tab sets pixel size and unit. It is pre-filled automatically from
the file where the file says something:

- **OME-TIFF** physical pixel sizes
- **TIFF resolution tags** (`XResolution`, `YResolution`, `ResolutionUnit`)

Two deliberate refusals in that code, both worth knowing:

- A `ResolutionUnit` of "no absolute unit" is treated as *no calibration*, not
  as a silent default. It genuinely carries no physical meaning.
- A 1×1 resolution is ignored — that is what a writer emits when it has nothing
  to say, and treating it as "one pixel per inch" would be fiction.
- No unit conversion happens between different source spellings. Source metadata
  disagrees about `um` / `µm` / `micron` / `MICROMETER` often enough that
  guessing is a bad idea; the unit string you were given is the unit string you
  get.

If no calibration is found, measurements come out in pixels and say so.

## Thresholding

The **Segment** tab shows **all thirteen auto-threshold methods side by side**,
each with the threshold it chose:

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

Showing them together turns method choice into an observation instead of a
tradition. If eight methods agree within a few grey levels, the threshold is
real. If they scatter across the range, your segmentation problem is not going
to be solved by picking one.

### The stability curve

Below the methods, a curve sweeps the threshold across its range and plots how
much the result changes. A **plateau** means a range of thresholds that all give
essentially the same segmentation — that is a robust threshold, and the panel
reports the widest plateau and its centre. A steep slope everywhere means the
answer depends on a number you are guessing.

This is the single most useful thing in the tab. A threshold sitting on a
plateau is defensible in review; one sitting on a slope is not.

### Local adaptive thresholding

For uneven illumination, where no single global value works:

| Method | Notes |
| --- | --- |
| **Global** | One threshold for the whole image |
| **Sauvola** | Local mean and standard deviation. The usual first choice. |
| **Niblack** | Local mean minus k·σ. Sensitive in flat background regions. |
| **Phansalkar** | Sauvola variant tuned for low-contrast stained images. |
| **Local mean** | Local mean minus a constant offset. |
| **Local median** | Local median minus a constant offset. Robust to speckle. |

## Particle analysis

Once you have a mask, the Particles section turns it into one ROI per object:

- **Split touching objects (watershed)** — distance-transform watershed, for
  objects that merged during thresholding
- **Fill holes** — close interior gaps
- **Exclude objects touching the edge** — objects clipped by the frame have
  meaningless area and shape, so this is usually the correct choice
- **Min area (px)** and **Min circularity** — drop noise and debris

The panel shows the surviving count as you adjust the filters. **Add objects as
ROIs** commits them to the ROI list, after which they measure like anything else.

## Saving and sharing ROIs

ROIs are stored in a readable JSON sidecar next to the image
(`image.tif.rois.json`), not in an opaque binary. Consequences:

- ROI changes **diff in code review** like any other file
- You can edit or generate them from a script
- They travel with the image in version control

For exchange with ImageJ/Fiji, both directions of ImageJ's `.roi` and
`RoiSet.zip` formats are supported.

## Exporting results

Four buttons in the Results tab:

| Export | Format |
| --- | --- |
| **CSV** | Long/tidy CSV with full provenance |
| **CSV (de)** | Semicolon separator, comma decimal mark — for German-locale Excel |
| **Excel .xlsx** | Real xlsx, no CSV-import dance |
| **pandas script** | A Python starter script |

The tidy/long shape is chosen so the file goes straight into pandas, R or a
plotting library without reshaping. Provenance — the scale in force, the
threshold used, the ROI count — travels in the file, so a results CSV found six
months later still says how it was produced.

The **pandas script** is generated from your actual session: the columns that
exist, the scale in force, the threshold used, and your derived columns written
out as real expressions. It is a starting point that already matches your data,
rather than a generic template.
