declare module 'tga-js' {
    interface TgaHeader {
        width: number;
        height: number;
        pixelDepth: number;
        isGreyColor: boolean;
    }

    class TgaLoader {
        header: TgaHeader;
        load(data: Uint8Array): void;
        getImageData(imageData: ImageData): void;
    }

    export default TgaLoader;
}
