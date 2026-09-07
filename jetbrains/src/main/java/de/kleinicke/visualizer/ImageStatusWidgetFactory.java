package de.kleinicke.visualizer;

import com.intellij.openapi.fileEditor.*;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.*;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.ui.components.JBLabel;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import javax.swing.*;
import java.awt.*;
import java.awt.datatransfer.StringSelection;
import java.awt.event.*;
import java.util.Locale;

/** One registered IDE widget per control, matching the VS Code status areas. */
public abstract class ImageStatusWidgetFactory implements StatusBarWidgetFactory {
    private final String item;
    private final String title;
    protected ImageStatusWidgetFactory(String item, String title) { this.item = item; this.title = title; }
    public static final class Zoom extends ImageStatusWidgetFactory { public Zoom() { super("zoom", "Image zoom"); } }
    public static final class Size extends ImageStatusWidgetFactory { public Size() { super("size", "Image size and pixel values"); } }
    public static final class Normalization extends ImageStatusWidgetFactory { public Normalization() { super("normalization", "Image normalization"); } }
    public static final class Gamma extends ImageStatusWidgetFactory { public Gamma() { super("gamma", "Image gamma"); } }
    public static final class Exposure extends ImageStatusWidgetFactory { public Exposure() { super("exposure", "Image exposure"); } }
    public static final class Bytes extends ImageStatusWidgetFactory { public Bytes() { super("bytes", "Image file size"); } }
    @Override public @NotNull String getId() { return "ScientificImage." + item; }
    @Override public @NotNull String getDisplayName() { return title; }
    @Override public @NotNull StatusBarWidget createWidget(@NotNull Project project) { return new Widget(project, item, title); }
    @Override public void disposeWidget(@NotNull StatusBarWidget widget) { Disposer.dispose(widget); }

    private static final class Widget implements CustomStatusBarWidget {
        private final Project project;
        private final String item;
        private final JBLabel label = new JBLabel();
        private final Runnable refresh = this::render;
        private ImageStatusBridge bridge;
        private boolean disposed;
        Widget(Project project, String item, String title) {
            this.project = project;
            this.item = item;
            label.setName("scientific-status-" + item);
            label.setToolTipText(title);
            label.setBorder(JBUI.Borders.empty(0, 3));
            label.setVisible(false);
            if (!item.equals("bytes")) {
                label.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                label.addMouseListener(new MouseAdapter() {
                    @Override public void mouseClicked(MouseEvent event) {
                        if (SwingUtilities.isLeftMouseButton(event) && bridge != null) click();
                    }
                });
            }
        }
        @Override public @NotNull String ID() { return "ScientificImage." + item; }
        @Override public @NotNull JComponent getComponent() { return label; }
        @Override public void install(@NotNull StatusBar bar) {
            project.getMessageBus().connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
                @Override public void selectionChanged(@NotNull FileEditorManagerEvent event) { select(); }
                @Override public void fileClosed(@NotNull FileEditorManager manager, @NotNull com.intellij.openapi.vfs.VirtualFile file) { select(); }
            });
            select();
        }
        private void select() {
            if (disposed || project.isDisposed()) return;
            FileEditor editor = FileEditorManager.getInstance(project).getSelectedEditor();
            ImageStatusBridge next = editor instanceof VisualizerEditor image ? image.imageStatus() : null;
            if (next != bridge) {
                if (bridge != null) { bridge.removeListener(refresh); bridge.setNativeActive(this, false); }
                bridge = next;
                if (bridge != null) bridge.addListener(refresh);
            }
            render();
        }
        private void render() {
            if (disposed) return;
            boolean ready = bridge != null && bridge.state().ready() && bridge.state().normalization() != null;
            if (bridge != null) bridge.setNativeActive(this, ready);
            if (!ready) { label.setVisible(false); return; }
            var state = bridge.state();
            boolean visible = !item.equals("gamma") && !item.equals("exposure") || state.normalization().gammaMode();
            label.setVisible(visible);
            String text = switch (item) {
                case "size" -> state.pixel() == null || state.pixel().isEmpty() ? state.size() : state.pixel();
                case "zoom" -> "fit".equals(state.zoom()) ? "Whole Image" : Math.round(Double.parseDouble(state.zoom()) * 100) + "%";
                case "gamma" -> String.format(Locale.ROOT, "γ: %.1f→%.1f", state.gamma().in(), state.gamma().out());
                case "exposure" -> String.format(Locale.ROOT, "Exposure: %+.1f EV", state.exposure());
                case "normalization" -> state.normalization().autoNormalize()
                    ? (state.stats() == null ? "Auto-Norm" : range("Auto-Norm", state.stats().min(), state.stats().max()))
                    : state.normalization().gammaMode() ? "Gamma-Norm" : range("Norm", state.normalization().min(), state.normalization().max());
                case "bytes" -> bytes(state.fileSize());
                default -> "";
            };
            if (!java.util.Objects.equals(label.getText(), text)) label.setText(text);

        }
        private static String range(String mode, double min, double max) { return String.format(Locale.ROOT, "%s: [%.2f, %.2f]", mode, min, max); }
        private static String bytes(Long size) {
            if (size == null) return "Remote";
            if (size < 1024) return size + " B";
            if (size < 1024 * 1024) return String.format(Locale.ROOT, "%.1f KB", size / 1024.0);
            return String.format(Locale.ROOT, "%.2f MB", size / (1024.0 * 1024));
        }
        private void click() {
            ImageStatusBridge selected = bridge;
            JPopupMenu menu = new JPopupMenu();
            switch (item) {
                case "size" -> add(menu, "Copy image / pixel readout", () -> CopyPasteManager.getInstance().setContents(new StringSelection(label.getText())));
                case "zoom" -> {
                    for (double scale : new double[]{10, 5, 2, 1, 0.5, 0.2}) add(menu, Math.round(scale * 100) + "%", () -> selected.adjust("zoom", scale));
                    add(menu, "Whole Image", () -> selected.command("fit"));
                }
                case "normalization", "gamma", "exposure" -> { selected.action(item); return; }
                default -> { return; }
            }
            menu.show(label, 0, -menu.getPreferredSize().height);
        }
        private static void add(JPopupMenu menu, String text, Runnable action) {
            JMenuItem entry = new JMenuItem(text);
            entry.addActionListener(event -> action.run());
            menu.add(entry);
        }
        @Override public void dispose() {
            disposed = true;
            if (bridge != null) { bridge.removeListener(refresh); bridge.setNativeActive(this, false); bridge = null; }
        }
    }
}
