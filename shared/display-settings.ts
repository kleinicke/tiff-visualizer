/** Host-neutral, validated display edits. No DOM, Svelte, or IDE dependencies. */
export interface DisplaySettings {
  normalization: { min: number; max: number; autoNormalize: boolean; gammaMode: boolean };
  gamma: { in: number; out: number };
  brightness: { offset: number };
  normalizedFloatMode?: boolean;
}

export type DisplayEdit =
  | { kind: 'mode'; value: 'auto' | 'range' | 'gamma' }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'gamma'; input: number; output: number }
  | { kind: 'normalizedFloat'; value: boolean }
  | { kind: 'exposure'; value: number };

/** Return a new snapshot, or null for an invalid/untrusted message. */
export function applyDisplayEdit(current: DisplaySettings, edit: unknown): DisplaySettings | null {
  if (!edit || typeof edit !== 'object') return null;
  const e = edit as Record<string, unknown>;
  const next: DisplaySettings = {
    normalization: { ...current.normalization }, gamma: { ...current.gamma }, brightness: { ...current.brightness },
    normalizedFloatMode: current.normalizedFloatMode ?? false,
  };
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (e.kind === 'mode' && typeof e.value === 'string' && ['auto', 'range', 'gamma'].includes(e.value)) {
    next.normalization.autoNormalize = e.value === 'auto';
    next.normalization.gammaMode = e.value === 'gamma';
  } else if (e.kind === 'range' && finite(e.min) && finite(e.max) && e.min < e.max) {
    next.normalization = { min: e.min, max: e.max, autoNormalize: false, gammaMode: false };
  } else if (e.kind === 'gamma' && finite(e.input) && finite(e.output) && e.input > 0 && e.output > 0) {
    next.gamma = { in: e.input, out: e.output };
    next.normalization.autoNormalize = false;
    next.normalization.gammaMode = true;
  } else if (e.kind === 'normalizedFloat' && typeof e.value === 'boolean') {
    next.normalizedFloatMode = e.value;
  } else if (e.kind === 'exposure' && finite(e.value) && Math.abs(e.value) <= 16) {
    next.brightness.offset = e.value;
    next.normalization.autoNormalize = false;
    next.normalization.gammaMode = true;
  } else return null;
  return next;
}
