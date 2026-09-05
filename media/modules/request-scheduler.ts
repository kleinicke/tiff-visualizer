/** Work-conserving queue: an idle slot always takes the next useful request. */
export class RequestScheduler {
	private active = 0;
	private queue: { run: () => void; cancel: () => void; priority: number }[] = [];
	constructor(private readonly limit: number) {}
	run<T>(work: () => Promise<T>, signal?: AbortSignal, priority = 0): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const cancel = () => {
				const index = this.queue.indexOf(job);
				if (index >= 0) { this.queue.splice(index, 1); }
				signal?.removeEventListener('abort', cancel);
				reject(new DOMException('Request cancelled', 'AbortError'));
			};
			const job = { priority, cancel, run: () => {
				signal?.removeEventListener('abort', cancel);
				this.active++;
				Promise.resolve().then(work).then(resolve, reject).finally(() => {
					this.active--; this.drain();
				});
			} };
			if (signal?.aborted) { cancel(); return; }
			signal?.addEventListener('abort', cancel, { once: true });
			this.queue.push(job);
			this.queue.sort((a, b) => b.priority - a.priority);
			this.drain();
		});
	}
	private drain(): void {
		while (this.active < this.limit && this.queue.length) { this.queue.shift()!.run(); }
	}
}
