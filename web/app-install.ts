interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface FileLaunchQueue {
  setConsumer(consumer: (launch: { files: Array<{ getFile(): Promise<File> }> }) => void): void;
}

// Register early: the browser may offer installation before DOMContentLoaded.
let installPrompt: InstallPrompt | undefined;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
});

export function setupAppInstall(openFiles: (files: File[]) => Promise<void>, report: (message: string) => void): void {
  const button = document.querySelector<HTMLButtonElement>('[data-web-action="install"]');
  const standalone = window.matchMedia('(display-mode: standalone)');
  const updateButton = (): void => {
    if (button) button.hidden = standalone.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  };
  updateButton();
  standalone.addEventListener('change', updateButton);
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    if (button) button.hidden = true;
  });
  button?.addEventListener('click', async () => {
    const prompt = installPrompt;
    if (!prompt) {
      report('Use your browser’s Install app or Add to Dock menu. On iPhone/iPad, use Share → Add to Home Screen. Internet is still needed to load the viewer.');
      return;
    }
    installPrompt = undefined;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      report('Installation is unavailable right now. Try your browser’s Install app menu.');
    }
  });

  // Installed-app file launches reuse the normal local-file path, including
  // content sniffing and collections. Serialize launches to preserve ordering.
  const queue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
  let pending = Promise.resolve();
  queue?.setConsumer(launch => {
    if (!launch.files.length) return;
    pending = pending.then(async () => {
      const files = await Promise.all(launch.files.map(handle => handle.getFile()));
      await openFiles(files);
    }).catch(() => report('Could not open the files supplied by the system. Use Open files to select them again.'));
  });
}
