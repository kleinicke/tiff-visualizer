declare module 'pako' {
    function inflate(data: Uint8Array | ArrayBuffer, options?: { to?: 'string' }): Uint8Array;
    function deflate(data: Uint8Array | ArrayBuffer, options?: unknown): Uint8Array;

    const pako: { inflate: typeof inflate; deflate: typeof deflate };
    export default pako;
    export { inflate, deflate };
}
