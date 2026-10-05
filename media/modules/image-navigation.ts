import type { DecodedSnapshot } from './active-image';

export interface CachedImage<Metadata> {
  cacheKey: string;
  label: string;
  snapshot: DecodedSnapshot;
  formatInfo: Metadata | null;
}

export interface NavigationHost {
  cancelWorkers(): void;
  setSignal(signal: AbortSignal): void;
  resetFile(): void;
}

/** Owns load identity, cancellation and the previous-file cache. UI stays in the host. */
export class ImageNavigation<Metadata> {
  private currentGeneration = 0;
  get generation(): number { return this.currentGeneration; }
  private state: 'loading' | 'ready' | 'failed' = 'loading';
  private waiters = new Set<(ready: boolean) => void>();
  private controller = new AbortController();
  private previous: CachedImage<Metadata> | null = null;
  private candidate: CachedImage<Metadata> | null = null;
  constructor(private host: NavigationHost) {}
  get signal(): AbortSignal { return this.controller.signal; }

  private settle(state: 'loading' | 'ready' | 'failed'): void {
    this.state = state;
    for (const resolve of this.waiters) resolve(state === 'ready');
    this.waiters.clear();
  }
  markReady(generation: number): void {
    if (generation === this.generation) this.settle('ready');
  }
  markFailed(generation: number): void {
    if (generation === this.generation) this.settle('failed');
  }
  waitUntilReady(generation: number): Promise<boolean> {
    if (generation !== this.generation) return Promise.resolve(false);
    if (this.state !== 'loading') return Promise.resolve(this.state === 'ready');
    return new Promise(resolve => this.waiters.add(resolve));
  }

  private begin(cancelWorkers: boolean): number {
    this.settle('loading');
    this.currentGeneration++;
    this.controller.abort();
    if (cancelWorkers) this.host.cancelWorkers();
    this.controller = new AbortController();
    this.host.setSignal(this.signal);
    return this.generation;
  }

  openFile(outgoing: CachedImage<Metadata> | null): number {
    this.candidate = this.previous;
    this.previous = outgoing;
    const generation = this.begin(true);
    this.host.resetFile();
    return generation;
  }

  /** Keep worker source caches and renderers while scrubbing the same dataset. */
  changePlane(): number { this.candidate = null; return this.begin(false); }
  changeLevel(): number { this.candidate = null; return this.begin(true); }
  restore(key: string): CachedImage<Metadata> | null {
    const cached = this.candidate;
    if (!cached || cached.cacheKey !== key) return null;
    cached.snapshot.restore();
    this.candidate = null;
    return cached;
  }
  clear(): void {
    this.settle('failed');
    this.currentGeneration++;
    this.controller.abort();
    this.host.cancelWorkers();
    this.previous = this.candidate = null;
  }
}
