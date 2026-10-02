package de.kleinicke.visualizer;

import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.util.UserDataHolderBase;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;
import javax.swing.*;
import java.awt.BorderLayout;
import java.beans.PropertyChangeListener;
import java.nio.file.Path;

public final class VisualizerEditor extends UserDataHolderBase implements FileEditor {
    private final VirtualFile file;
    private final ViewerGesturePanel panel = new ViewerGesturePanel();
    private JBCefBrowser browser;
    private ViewerServer server;
    private MacImageScroll macScroll;
    private ImageStatusBridge imageStatus;
    private boolean disposed;
    public VisualizerEditor(VirtualFile file) {
        this.file = file;
        if (!JBCefApp.isSupported()) {
            panel.add(new JLabel("This viewer requires the JetBrains Runtime with JCEF."));
            return;
        }
        try {
            String kind = ViewerFormats.kind(file.getExtension());
            server = new ViewerServer(Path.of(file.getPath()), kind);
            // Set before browser creation: changing the live OSR cap did not update
            // animation cadence in the tested runtime (30 fps versus 60 fps).
            browser = new com.intellij.ui.jcef.JBCefBrowserBuilder().setWindowlessFramerate(60).build();
            browser.getJBCefClient().getCefClient().addDownloadHandler(new org.cef.handler.CefDownloadHandlerAdapter() {
                @Override public boolean onBeforeDownload(org.cef.browser.CefBrowser cef,
                        org.cef.callback.CefDownloadItem item, String suggestedName,
                        org.cef.callback.CefBeforeDownloadCallback callback) {
                    // JCEF's native Save dialog owns the destination and overwrite confirmation.
                    callback.Continue(suggestedName, true);
                    return true;
                }
            });
            if (kind.equals("image")) {
                imageStatus = new ImageStatusBridge(browser, server.url());
                macScroll = new MacImageScroll(browser, server.url());
                panel.setGestureReceiver((type, scale) -> {
                    if (disposed || browser == null) return;
                    browser.getCefBrowser().executeJavaScript(
                        "window.jetbrainsGesture?.('" + type + "'," + scale + ")", server.url(), 0);
                });
            }
            browser.loadURL(server.url());
            panel.add(browser.getComponent(), BorderLayout.CENTER);
        } catch (Exception exception) {
            if (imageStatus != null) imageStatus.close();
            if (macScroll != null) macScroll.close();
            if (browser != null) browser.dispose();
            if (server != null) server.close();
            browser = null;
            panel.add(new JLabel("Could not start the viewer: " + exception.getMessage()));
        }
    }
    @Override public @NotNull JComponent getComponent() { return panel; }
    ImageStatusBridge imageStatus() { return imageStatus; }
    @Override public JComponent getPreferredFocusedComponent() { return browser == null ? panel : browser.getComponent(); }
    @Override public @NotNull String getName() { return "Scientific Image Visualizer"; }
    @Override public void setState(@NotNull FileEditorState state) { }
    @Override public boolean isModified() { return false; }
    @Override public boolean isValid() { return !disposed && file.isValid(); }
    @Override public VirtualFile getFile() { return file; }
    @Override public void addPropertyChangeListener(@NotNull PropertyChangeListener listener) { }
    @Override public void removePropertyChangeListener(@NotNull PropertyChangeListener listener) { }
    @Override public void dispose() {
        disposed = true;
        panel.setGestureReceiver(null);
        if (imageStatus != null) imageStatus.close();
        if (macScroll != null) macScroll.close();
        if (browser != null) browser.dispose();
        if (server != null) server.close();
    }
}
