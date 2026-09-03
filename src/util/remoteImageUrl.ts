/**
 * Normalize image links copied out of another viewer's query string.
 *
 * A copied `url` value can look like `https%3A%2F%2F…tiff&zoom=12`: the
 * image URL is percent-encoded, while the source viewer's own state follows
 * it as ordinary query parameters. In that shape, literal query separators
 * cannot belong to the encoded image URL, so discard them before decoding.
 * Normal URLs are returned untouched, including their own query strings.
 */
export function normalizeRemoteImageUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	if (!/^https?%3a%2f%2f/i.test(trimmed)) {
		return trimmed;
	}

	// Some catalogue/share surfaces additionally Markdown-escape underscores.
	// A WHATWG URL treats those backslashes as path separators, so remove the
	// presentation escaping before parsing the actual URL.
	const encodedUrl = trimmed.split(/[?&#]/, 1)[0].replace(/\\_/g, '_');
	try {
		return decodeURIComponent(encodedUrl);
	} catch {
		// Let the caller's normal URL validation report malformed input.
		return trimmed;
	}
}
