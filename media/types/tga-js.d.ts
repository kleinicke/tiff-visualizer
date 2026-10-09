declare module 'tga-js' {
    interface TgaHeader {
        width: number;
        height: number;
        pixelDepth: number;
        isGreyColor: boolean;
        hasColorMap: boolean;
        /** Bits 4-5: the pixel origin (0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right). */
        flags: number;
    }

    class TgaLoader {
        header: TgaHeader;
        /** Pixels after `load`, RLE expanded (palette indices for colour-mapped images). */
        imageData: Uint8Array;
        load(data: Uint8Array): void;
        getImageData(imageData: ImageData): void;
    }

    export default TgaLoader;
}
