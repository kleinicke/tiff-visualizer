import { writable } from 'svelte/store';
import type { DisplayEdit, DisplaySettings } from '../../shared/display-settings';

export interface ImageUiSnapshot {
  ready: boolean;
  name: string;
  size: string;
  pixel: string;
  format: string;
  bits: string;
  channels: string;
  normalizedFloatAvailable: boolean;
  zoom: string;
  settings: DisplaySettings;
}

export interface ImageUiBridge {
  state: ReturnType<typeof writable<ImageUiSnapshot>>;
  edit(edit: DisplayEdit): void;
  command(command: string): void;
  message(message: { type: string; [key: string]: unknown }): void;
}

export function createImageUiBridge(
  settings: DisplaySettings,
  send: (message: { type: string; [key: string]: unknown }) => void,
): ImageUiBridge {
  const state = writable<ImageUiSnapshot>({
    ready: false, name: 'Image', size: '—', pixel: '', format: '—', bits: '—', channels: '—', zoom: 'Fit',
    normalizedFloatAvailable: false, settings: structuredClone(settings),
  });
  return {
    state,
    edit: edit => send({ type: 'editDisplaySettings', edit }),
    command: command => send({ type: 'executeCommand', command: `tiffVisualizer.${command}` }),
    message(message) {
      if (message.type === 'clearImage') {
        state.update(s => ({ ...s, ready: false, name: 'Image', size: '—', pixel: '', format: '—', bits: '—', channels: '—', zoom: 'Fit', normalizedFloatAvailable: false }));
      } else if (message.type === 'updateSettings') {
        const next = message.settings as DisplaySettings & { resourceUri?: string };
        state.update(s => ({ ...s, settings: {
          normalization: { ...(next.normalization || s.settings.normalization) },
          gamma: { ...(next.gamma || s.settings.gamma) },
          brightness: { ...(next.brightness || s.settings.brightness) },
          normalizedFloatMode: next.normalizedFloatMode ?? s.settings.normalizedFloatMode,
        }, name: filename(next.resourceUri) || s.name }));
      } else if (message.type === 'size') state.update(s => ({ ...s, size: String(message.value || '—'), ready: !!message.value }));
      else if (message.type === 'pixelFocus') state.update(s => ({ ...s, pixel: String(message.value || '') }));
      else if (message.type === 'pixelBlur') state.update(s => ({ ...s, pixel: '' }));
      else if (message.type === 'zoom') state.update(s => ({ ...s, zoom: message.value === 'fit' ? 'Fit' : `${Math.round(Number(message.value) * 100)}%` }));
      else if (message.type === 'formatInfo') {
        const f = message.value as Record<string, unknown>;
        state.update(s => ({ ...s, format: String(f.formatType || 'Image'), bits: String(f.bitsPerSample || '—'), channels: String(f.samplesPerPixel || '—'), normalizedFloatAvailable: f.samplesPerPixel === 1 && f.sampleFormat !== 3 && !f.floatCarrier }));
      }
    },
  };
}

function filename(uri?: string): string {
  if (!uri) return '';
  try { return decodeURIComponent(uri.split('/').pop()?.split('?')[0] || ''); }
  catch { return uri.split('/').pop() || ''; }
}
