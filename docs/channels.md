[← Documentation index](./index.md)

# Channels and compositing

Open with **Channels** from the right-click menu or the command palette. The
entry only appears for images that actually have more than one channel, and
compositing stays off until you switch it on — a single-channel image behaves
exactly as before.

## What this is

Several channels shown at once, each with its own tint, display range and
opacity, added together. This is the "Composite" mode of Fiji and the "Display
Adjustment" panel of Imaris and arivis: DAPI in blue, GFP in green, RFP in red,
in one picture instead of one channel at a time.

## What this is not

It is **not** the [Layers view](./layers.md). That implements authoring
semantics — Photoshop and GIMP blend modes, clipping, groups, alpha over — and
is for composing pictures.

What happens here is raw arithmetic over scientific channels: each channel is
scaled by its own range, multiplied by its tint, and summed. Emission from
separate fluorophores physically adds at the detector, so addition is the
operation that corresponds to the data. Alpha-over would put one channel *in
front of* another, which no microscope does.

## Where channels come from

Two storage layouts, handled the same way:

- **Interleaved** — an RGB or multi-sample TIFF, EXR, or NumPy array, where the
  channels sit within one page.
- **OME-TIFF with a C axis** — each channel is its own IFD. The sibling planes
  at the current Z and T are decoded in the background, so the first channel
  appears immediately and the composite fills in.

Channel names and tints come from OME `Channel/@Name` and `Channel/@Color`
where the file provides them: the acquisition software knows which fluorophore
this is and we do not. Files without that metadata get a distinguishable
fallback palette, and RGB images get "Red", "Green", "Blue".

## The panel

One row per channel:

| Control | Effect |
| --- | --- |
| Checkbox | Include this channel in the composite |
| Colour swatch | Its tint |
| **Solo** | Show only this channel. A view, not a change to the settings — the others stay configured and dim rather than disappearing |
| Black/white sliders | Display range, laid over that channel's own statistics |
| Opacity | Scales the channel's contribution |
| Tint / colormap | A flat tint is the microscopy convention; a colormap suits a single ratiometric channel. A colormap *replaces* the tint — its colour already encodes the value |
| **Auto** | Percentile range for this channel alone |

Plus **Auto range all**, **Full range all** and **Show all**.

### Why ranges are per channel

A bright nuclear stain and a dim reporter share no useful scale. Normalising
them together is exactly what makes the dim one invisible, so each channel
carries its own black and white point and its own statistics.

### Why "Auto" is a percentile, not min/max

One hot pixel sets the maximum, and the real signal then occupies the bottom few
percent of the range. Auto clips a thousandth at each end, which is what every
acquisition package does and why "auto" looks right there and wrong with a naive
implementation. **Full range all** gives you true min/max when you want it.

## Non-finite samples

A channel that is `NaN` or `±Inf` at a pixel contributes nothing there — it is
not clamped to the bottom of its range. Other channels still show through. Only
when *every* visible channel is non-finite at a pixel is the NaN colour used.
This is the same rule the [measurement](./measure.md) subsystem applies, so what
you see and what you measure agree.

## Compositing and measurement

The composite is a view; measurements always read the raw data. Switching
**Measure every channel** on in the Results tab gives one row per ROI per
channel, which is the other half of the standard workflow: count nuclei in one
channel, read intensity in each of the others for the same regions.

## Histogram

With compositing on, the histogram overlay shows **one curve per visible
channel**, each over that channel's own display range and drawn in its own
tint. Solo applies there too.

This is a different question from the ordinary histogram, which describes the
rendered image on one axis. Here every channel has its own black and white
point — that is the whole premise of compositing — so a shared axis would
squeeze a dim channel into the leftmost few pixels and say nothing useful about
it. Samples outside a channel's range land in the end bins rather than being
dropped, so clipping shows up as a spike instead of vanishing.

## Rendering backend

Compositing runs on **WebGPU** where the platform provides it, and on the CPU
otherwise. The panel says which is in use.

The arithmetic is not duplicated between them. Both call the same function to
build each channel's colour lookup table, and the shader does only what the CPU
loop also does: normalise a sample into the channel's range and add the entry it
lands on. A shader that re-derived tint, opacity, gamma and colormap would drift
from the CPU path silently, and a composite that disagrees with the
[measurement](./measure.md) subsystem about what a pixel contains is worse than
a slow one.

There is deliberately no WebGL2 variant. A second GPU path would double the
surface for a backend on its way out, and the CPU fallback already covers
everything it would have. More than eight visible channels fall back to the CPU
rather than being truncated.

The first composite after opening the panel is drawn on the CPU while the GPU
device is being created in the background; subsequent ones use the GPU.
