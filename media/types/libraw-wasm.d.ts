declare module 'libraw-wasm' {
    interface RawMetadata {
        width: number;
        height: number;
        make?: string;
        model?: string;
        colors?: number;
        samplesPerPixel?: number;
        raw_colors?: number;
        [key: string]: any;
    }

    class LibRaw {
        open(data: Uint8Array, settings?: object): Promise<void>;
        metadata(): Promise<RawMetadata>;
        imageData(): Promise<any>;
        close(): void;
    }

    export default LibRaw;
}
