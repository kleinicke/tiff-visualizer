declare module 'pako' {
    function inflate(data: Uint8Array | ArrayBuffer, options?: { to?: 'string' }): Uint8Array;
    function inflateRaw(data: Uint8Array | ArrayBuffer, options?: { to?: 'string' }): Uint8Array;
    function deflate(data: Uint8Array | ArrayBuffer, options?: unknown): Uint8Array;
    function deflateRaw(data: Uint8Array | ArrayBuffer, options?: unknown): Uint8Array;

    const pako: { inflate: typeof inflate; inflateRaw: typeof inflateRaw; deflate: typeof deflate; deflateRaw: typeof deflateRaw };
    export default pako;
    export { inflate, inflateRaw, deflate, deflateRaw };
}
