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
where the file provides them (for ImageJ stacks, the names are the slice
labels stored in the file's ImageJ metadata): the acquisition software knows which fluorophore
this is and we do not. Files without that metadata get a distinguishable
fallback palette, and RGB images get "Red", "Green", "Blue".

## Settings

Four VS Code settings make the panel start the way you usually set it up:

| Setting | Effect |
| --- | --- |
| `tiffVisualizer.channels.autoComposite` | Open images whose channels come from OME-TIFF or ImageJ metadata in composite mode. Ordinary RGB images are not affected |
| `tiffVisualizer.channels.colorsByName` | Tints by channel name, matched case-insensitively |
| `tiffVisualizer.channels.colorsByNumber` | Tints by channel number as the panel shows it, starting at 1 |
| `tiffVisualizer.channels.groups` | Named sets of channels that can be switched on or soloed together from the Groups section of the panel |

```json
"tiffVisualizer.channels.autoComposite": true,
"tiffVisualizer.channels.colorsByName": { "DAPI": "#3399ff", "GFP": "#00ff00" },
"tiffVisualizer.channels.colorsByNumber": { "1": "#00ff00" },
"tiffVisualizer.channels.groups": { "T Cells": ["CD3e", "CD8", "CD4"] }
```

A tint is chosen in this order: a colour you picked in the panel (kept while
you step through a series with the same channel count), then a name match,
then a number match, then the file's OME colour, then the fallback palette.
Names come first because they survive a change in channel order.

Switching composite on or off by hand wins over `autoComposite` for the rest
of that preview. A composite the setting switched on turns itself off again
for an image it does not apply to, such as an RGB photo later in the folder.
A changed `autoComposite` applies from the next image. Changed colours apply
to previews opened afterwards, because an open preview keeps the tints it is
already using.

Group members are channel names (exact, case-insensitive) or 1-based channel
numbers. A name that matches no channel is reported in the panel instead of
being guessed at, so `"CD3"` does not quietly match `"CD3e"`. Edits to `groups`
apply to open images without reopening them.

## The panel

One row per channel:

| Control | Effect |
| --- | --- |
| Checkbox | Include this channel in the composite |
| Colour swatch | Its tint |
| **Solo** | Show only this channel, switching it on if it was off. The others keep their settings and dim rather than disappearing. Pressing Solo again ends the solo and switches the channel back off if Solo was what turned it on |
| Black/white sliders | Display range, laid over that channel's own statistics |
| Opacity | Scales the channel's contribution |
| Tint / colormap | A flat tint is the microscopy convention; a colormap suits a single ratiometric channel. A colormap *replaces* the tint — its colour already encodes the value |
| **Auto** | Percentile range for this channel alone |

The actions that apply to every channel sit in a **Global** section at the top of
the panel, which stays in view while the list scrolls: **Select all**, **Deselect all**,
**Auto range all** and **Full range all**. Select all and Deselect all also clear
any Solo, so the result is what the button says.

### Groups

Groups defined in the `groups` setting appear in a foldable **Groups** section
above the channel list. Each row has:

| Control | Effect |
| --- | --- |
| Checkbox | Checked when every channel in the group is on, dashes when only some are. Clicking switches the whole group on (from unchecked or partly on), or off (from checked) |
| **Solo** | Show only the channels in this group, switching on any that were off. Pressing Solo again ends the solo and switches off the ones Solo had turned on |
| `2/3` | How many of the group's channels are on, out of those that matched. Listed members that matched nothing are named under the group |

A group Solo and a single-channel Solo (or the channel selector) replace each
other. Soloing a channel or group, or choosing a channel with the selector,
switches it on if it was off, until the solo is cleared. The selector keeps its position while a group is soloed, since a group is
several channels. Groups are available only while Composite is on, because they
describe a set of channels shown together.

### Why ranges are per channel

A bright nuclear stain and a dim reporter share no useful scale. Normalising
them together is exactly what makes the dim one invisible, so each channel
carries its own black and white point and its own statistics.

### Why "Auto" is a percentile, not min/max

One hot pixel sets the maximum, and the real signal then occupies the bottom few
percent of the range. Auto clips a thousandth at each end, which is what every
acquisition package does and why "auto" looks right there and wrong with a naive
implementation. **Full range all** gives you true min/max when you want it.

## The channel selector and the panel

Stacks where each channel is its own page (OME-TIFF, ImageJ) and TIFFs with
several bands also show a selector overlay (a slider, or a dropdown when the
channels have names). The two controls share one idea of the "current channel":

- **Composite off.** The selector decides which channel is shown. The panel
  highlights that channel, and its button reads **Show**: clicking it moves the
  selector to that channel. Moving the selector moves the highlight.
- **Composite on.** The image contains every channel, so the selector's channel
  control and **Solo** are the same thing. Moving the selector solos that channel
  in the composite, and soloing a channel in the panel moves the selector to it.
  Clearing Solo (click it again, or **Select all**) shows every channel again and
  leaves the selector where it was. Turning the composite off shows the channel
  the selector is on. Z and T keep working, and the composite is rebuilt for the
  new plane.

Images without a channel selector (for example multi-channel EXR or NumPy) have
nothing to link to, so there the panel works as described above.

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
