/**
 * Image sources the extension host pushes when the viewer switches to
 * another local file of a collection (src/imagePreview/source-push.ts). The
 * host offers one with `switchToImage`; the source is requested only when a
 * processor actually reads it, so an image the viewer serves from its own
 * cache costs no read. The page's first image travels the same way, through
 * the bootstrap script in the webview HTML.
 *
 * The host also offers the collection's next image (`prefetchSource`). Its
 * bytes are requested once the current image has loaded and kept until the
 * viewer switches: to that file, unchanged since (same size and mtime), the
 * switch reads nothing; anything else drops them.
 */

type HostChannel = { postMessage: (message: unknown) => unknown };
type Offer = { uri: string; token: string; size: number; mtime: number };

/** Chunks of a request that stop arriving are asked for again, from the first missing byte. */
const STALL_MS = 5000;
const MAX_RETRIES = 3;

let channel: HostChannel | null = null;
let offered: Offer | null = null;
let cancelActive: (() => void) | null = null;
type Prefetch = { offer: Offer; bytes: Promise<ArrayBuffer> | null; cancel: (() => void) | null };
/** The collection's next image. */
let prefetch: Prefetch | null = null;
/** A prefetch the current switch will read; the next prefetch offer must not drop it. */
let claimed: Prefetch | null = null;

export function setPushedSourceChannel(host: HostChannel): void {
	channel = host;
}

/** The host will push `uri` (`size` bytes, modified at `mtime`) on a request carrying `token`. */
export function offerPushedSource(uri: string, token: string, size: number, mtime = 0): void {
	cancelActive?.();
	claimed?.cancel?.();
	claimed = null;
	offered = null;
	if (prefetch && sameFile(prefetch.offer, uri, size, mtime)) {
		// The prefetch serves this switch.
		claimed = prefetch;
		prefetch = null;
		return;
	}
	dropPrefetch();
	offered = { uri, token, size, mtime };
}

/** The collection's next image, to request once the viewer is idle. */
export function offerPrefetch(uri: string, token: string, size: number, mtime: number): void {
	if (prefetch && sameFile(prefetch.offer, uri, size, mtime)) {
		// Keep the bytes; later requests use the host's newest token.
		prefetch.offer.token = token;
		return;
	}
	dropPrefetch();
	prefetch = { offer: { uri, token, size, mtime }, bytes: null, cancel: null };
}

/** Starts the offered prefetch; call when the current image has finished loading. */
export function startPrefetch(): void {
	// One request at a time: each replaces the host's previous push.
	if (!prefetch || prefetch.bytes || cancelActive || claimed?.cancel) { return; }
	const entry = prefetch;
	// Once settled there is nothing left to cancel.
	entry.bytes = receive(entry.offer, undefined, cancel => { entry.cancel = cancel; }, () => { entry.cancel = null; });
	// A failed prefetch is simply not there to use.
	entry.bytes.catch(() => {
		if (prefetch === entry) { prefetch = null; }
		if (claimed === entry) { claimed = null; }
	});
}

/**
 * The pushed source of `uri`: the prefetched bytes, or the offered source
 * requested now. Null when neither exists. Rejects when the host reports an
 * error, the chunks stall, a newer switch replaces this one, or `signal`
 * aborts; callers then fetch instead.
 */
export function takePushedSource(uri: string, signal?: AbortSignal): Promise<ArrayBuffer> | null {
	if (!channel) { return null; }
	if (claimed && claimed.offer.uri === uri) {
		const entry = claimed;
		claimed = null;
		if (!entry.bytes) { return receive(entry.offer, signal, cancel => { cancelActive = cancel; }); }
		// Still arriving: a newer switch must be able to stop it, or it would
		// stall, ask again and replace that switch's push.
		cancelActive = entry.cancel;
		return entry.bytes;
	}
	if (!offered || offered.uri !== uri) { return null; }
	const offer = offered;
	offered = null;
	cancelActive?.();
	return receive(offer, signal, cancel => { cancelActive = cancel; });
}

function sameFile(offer: Offer, uri: string, size: number, mtime: number): boolean {
	return offer.uri === uri && offer.size === size && offer.mtime === mtime;
}

function dropPrefetch(): void {
	prefetch?.cancel?.();
	prefetch = null;
}

function receive(
	offer: Offer,
	signal: AbortSignal | undefined,
	onCancel: (cancel: () => void) => void,
	onSettled?: () => void,
): Promise<ArrayBuffer> {
	const host = channel!;
	const { token, size } = offer;
	return new Promise<ArrayBuffer>((resolve, reject) => {
		const bytes = new Uint8Array(size);
		let received = 0;
		let retries = 0;
		let idle: ReturnType<typeof setTimeout> | undefined;
		const finish = (error: Error | null) => {
			clearTimeout(idle);
			window.removeEventListener('message', onChunk);
			signal?.removeEventListener('abort', onAbort);
			if (cancelActive === cancel) { cancelActive = null; }
			onSettled?.();
			if (error) { reject(error); } else { resolve(bytes.buffer); }
		};
		const cancel = () => finish(new DOMException('Pushed source replaced', 'AbortError'));
		const onAbort = () => finish(new DOMException('Load superseded', 'AbortError'));
		const request = () => {
			clearTimeout(idle);
			idle = setTimeout(() => {
				if (++retries > MAX_RETRIES) { finish(new Error('Pushed image source stalled')); } else { request(); }
			}, STALL_MS);
			host.postMessage({ type: 'sourceRequest', token, offset: received });
		};
		function onChunk(event: MessageEvent) {
			const chunk = event.data;
			if (chunk?.type !== 'sourceChunk' || chunk.token !== token) { return; }
			if (chunk.error) { finish(new Error(String(chunk.error))); return; }
			// A chunk of a push this request has since replaced.
			if (chunk.offset !== received) { return; }
			if (received + chunk.bytes.byteLength > size) { finish(new Error('Pushed image source is larger than announced')); return; }
			bytes.set(chunk.bytes, received);
			received += chunk.bytes.byteLength;
			if (received === size) { finish(null); return; }
			retries = 0;
			clearTimeout(idle);
			idle = setTimeout(request, STALL_MS);
		}
		if (signal?.aborted) { onAbort(); return; }
		onCancel(cancel);
		signal?.addEventListener('abort', onAbort);
		window.addEventListener('message', onChunk);
		request();
	});
}
