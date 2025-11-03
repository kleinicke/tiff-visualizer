# Image Tab Caching System

## Overview

The TIFF Visualizer now includes an intelligent caching system that keeps up to 5 images loaded per view column, eliminating the need to reload images from disk when switching between tabs. This dramatically improves the user experience when working with multiple images.

## How It Works

### 1. Cache Architecture

**Extension Side** (`src/imagePreview/viewCache.ts`):
- Each `ImagePreview` instance maintains a `ViewCache` that stores up to 5 most recently viewed images
- The cache stores:
  - Image resource URI
  - Image format type (TIFF-float, PNG, EXR, etc.)
  - Snapshot of settings used to render the image (normalization, gamma, brightness, etc.)
  - Mask filter settings for that specific image
  - Last zoom/pan position
  - Last comparison state (peer images)
  - Timestamp for LRU eviction

**Webview Side** (`media/imagePreview.js`):
- Raw image data (TypedArrays) stays in memory during the webview lifetime
- Canvas rendering is cached implicitly in the image data
- Can be re-rendered with different settings without reloading from disk

### 2. Cache Lifecycle

#### Saving to Cache
When you switch images using arrow keys or the "Toggle Image" command:
1. `toggleToNextImage()` / `toggleToPreviousImage()` is called
2. These methods request the current zoom and comparison state via messages
3. `ZoomStateResponseMessageHandler` receives the zoom state
4. Handler calls `saveCurrentViewToCache()` which stores the view with all state
5. Then the image switch happens

#### Cache Validation
When switching to an image:
1. Check if a cached view exists for that image
2. Compare the cached settings snapshot with current format's global settings
3. If settings match → **reuse cached image** (no re-render needed)
4. If settings differ → **re-render with new settings** (use cached raw data, not disk I/O)
5. If not cached → **full reload from disk**

#### Cache Invalidation
When you change per-format settings (gamma, normalization, brightness):
1. `AppStateManager` emits settings change event
2. `ImagePreview` receives event and calls `_viewCache.invalidateFormat(format)`
3. All cached views of that format are deleted
4. Next switch to an image of that format will trigger re-render or reload

### 3. Message Flow

**Switching to Next Image:**
```
User presses arrow key
    ↓
toggleToNextImage()
    ↓
saveCurrentZoomState()
    ↓ (asynchronous)
Webview sends: zoomStateResponse, comparisonStateResponse
    ↓
Handler saves to cache via saveCurrentViewToCache()
    ↓
switchToImageAtIndex(newIndex)
    ↓
Check cache validity
    ↓
Send 'reuseCachedImage' or 'switchToImage' message
    ↓
Webview updates display
```

**Reusing Cached Image:**
```
Extension: 'reuseCachedImage' message (no disk I/O)
    ↓
Webview: reuseCachedImage() function
    ↓
Check: Cache valid? (loaded, has data)
    ↓
If needsRerender:
  Update settings and trigger re-render
Else:
  Just update UI (zoom, masks)
    ↓
updateImageCollectionOverlay()
    ↓
Display complete (instant, no loading)
```

## Configuration

**Cache Size Limit:** 5 images per view column
- Set in `src/imagePreview/viewCache.ts` as `MAX_CACHED_IMAGES = 5`
- When a 6th image is added, the least recently used (oldest timestamp) is evicted

## When Cache Is Used vs Not Used

### Cache IS Used (Fast Switching):
- ✅ Switching between images with arrow keys (same tab, same format)
- ✅ Format settings unchanged since image was cached
- ✅ Image already viewed within this session

### Cache NOT Used (Disk I/O):
- ❌ Image not yet viewed in this session (first open from disk)
- ❌ Image is the 6th+ image (beyond 5-image limit, evicted)
- ❌ Format settings changed (e.g., adjusted gamma globally)
- ❌ File was modified on disk (auto-reload triggered)

## Performance Impact

### Before Caching:
- Switching images: **Full disk I/O + decode + render** (~1-2 seconds per image)
- Changing format settings: **Re-render current image** (~100-500ms)
- Memory: Minimal (one image in memory at a time)

### After Caching:
- Switching images (cached): **Instant** (~50-100ms, no disk I/O)
- Switching images (not cached): **Full reload** (same as before)
- Changing format settings: **Re-render all formats** (instant, using cached data)
- Memory: ~5-10MB per 5-image cache (typical TIFF files)

## Settings and Caching

### Per-Format Settings (Global):
These settings apply to ALL images of a format:
- Normalization (min/max, auto-normalize mode)
- Gamma (in/out values)
- Brightness offset
- RGB as 24-bit grayscale mode
- Normalized float mode

When changed: **All cached images of that format are invalidated**

### Per-Image Settings (Local):
These settings apply to specific images only:
- Mask filters

When changed: **Cache remains valid, just re-apply masks on next view**

## Technical Details

### Cache Key
- Resource URI (unique identifier for each image file)
- Format type (ensures type-specific defaults are applied)

### Timestamp Management
- Updated every time a cached view is accessed
- Used for LRU eviction (least recently used is removed when cache is full)
- Resolution: milliseconds (Date.now())

### Settings Comparison
Deep equality check comparing:
- All normalization properties
- Gamma in/out values
- Brightness offset
- Boolean flags (rgbAs24BitGrayscale, normalizedFloatMode, etc.)
- Scale24BitFactor

### Thread Safety
- No async issues: All cache operations happen on main thread
- Message passing ensures proper ordering
- Zoom/comparison state captured before switching

## Testing

Run the cache logic tests:
```bash
node test/view-cache-test.js
```

Run behavioral tests:
```bash
npm run test:behavior
```

## Future Enhancements

Possible improvements for future versions:
1. **Persistent cache across sessions**: Store last 5 images in workspace state
2. **Cache size setting**: User-configurable cache limit (currently hardcoded to 5)
3. **Memory pressure handling**: Auto-clear old cache if memory is low
4. **Cache statistics**: Log cache hits/misses for performance analysis
5. **Multi-view column support**: Per-column cache (already designed for this)

## Debugging

Enable console logging in `imagePreview.ts` and `media/imagePreview.js` to see cache operations:

```typescript
// In switchToImageAtIndex:
console.log(`Cache valid: ${isCacheValid}, Needs rerender: ${needsRerender}`);
console.log(`Message type: ${messageType}`);

// In reuseCachedImage (webview):
console.log('Reusing cached image:', resourceUri);
console.log('Needs re-render:', needsRerender);
```

## Related Files

- `src/imagePreview/viewCache.ts` - Cache implementation
- `src/imagePreview/imagePreview.ts` - Cache integration with preview
- `src/imagePreview/messageHandlers.ts` - Message handlers for cache state capture
- `media/imagePreview.js` - Webview-side cache handling
