# Marketplace submission draft

Name: Scientific Image Visualizer

Version: 0.4.4

Permanent plugin ID: `imagevisualizer`

License: MIT

Source and issue tracker: https://github.com/kleinicke/tiff-visualizer

## Description

The description lives in [DESCRIPTION.md](DESCRIPTION.md). The build renders it
into plugin.xml, and each upload replaces the Marketplace page with it. Do not
edit it on the Marketplace website: if the site asks, do not choose "Always use
the description from the plugin page", or uploads will stop updating it.

## Release notes

First standalone image-only JetBrains package, independent of the 3D Visualizer.
Supports PyCharm 2024.3 and later without an artificial upper version ceiling.
Includes native status controls, local image decoding and corrected PNG export
for GPU-rendered images.

## Upload preparation

Complete the remaining gates in RELEASE.md before submitting the signed ZIP.
Use META-INF/pluginIcon.svg from src/main/resources for the product icon.
Create screenshots showing an image editor with native pixel/status controls and
an image with its histogram or measurement panel. Current build/release-evidence
captures demonstrate functionality but are not polished Marketplace screenshots.
The first publication is a manual submission; no upload has been performed.
