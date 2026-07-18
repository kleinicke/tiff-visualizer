interface ImageInfo {
    webviewUri: string;
    filename: string;
    uri: string;
}

(function() {
    'use strict';

    const vscode = (globalThis as any).acquireVsCodeApi() as { postMessage(msg: unknown): void };

    function createImageItem(imageInfo: ImageInfo): HTMLElement {
        const item = document.createElement('div');
        item.className = 'image-item';

        item.innerHTML = `
            <img class="image-preview" src="${imageInfo.webviewUri}" alt="${imageInfo.filename}" loading="lazy">
            <div class="image-info">
                <div class="image-filename" title="${imageInfo.filename}">${imageInfo.filename}</div>
                <div class="image-actions">
                    <button class="action-button" data-action="open" data-uri="${imageInfo.uri}">Open</button>
                    <button class="action-button secondary" data-action="remove" data-uri="${imageInfo.uri}">Remove</button>
                </div>
            </div>
        `;

        // Add click handler for image preview
        const imageElement = item.querySelector('.image-preview');
        if (!imageElement) return item;
        imageElement.addEventListener('click', () => {
            vscode.postMessage({
                type: 'openImageInMainEditor',
                uri: imageInfo.uri
            });
        });

        // Add click handlers for buttons
        const buttons = item.querySelectorAll('.action-button');
        buttons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const action = (button as HTMLElement).dataset.action;
                const uri = (button as HTMLElement).dataset.uri;

                if (action === 'open') {
                    vscode.postMessage({
                        type: 'openImageInMainEditor',
                        uri: uri
                    });
                } else if (action === 'remove') {
                    vscode.postMessage({
                        type: 'removeImage',
                        uri: uri
                    });
                }
            });
        });

        return item;
    }

    function updateImageGrid(): void {
        const grid = document.getElementById('image-grid');
        if (!grid) return;

        // Clear existing content
        grid.innerHTML = '';

        const imageData = (window as any).imageData as ImageInfo[];
        if (!imageData || imageData.length === 0) {
            grid.innerHTML = '<div class="empty-state">No images to compare. Use "Select for Compare" from the context menu in an image editor.</div>';
            return;
        }

        // Add image items
        imageData.forEach(imageInfo => {
            const item = createImageItem(imageInfo);
            grid.appendChild(item);
        });
    }

    // Initialize when DOM is loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateImageGrid);
    } else {
        updateImageGrid();
    }

    // Handle keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Close the panel (let VS Code handle this)
            vscode.postMessage({
                type: 'closePanel'
            });
        }
    });

})();
