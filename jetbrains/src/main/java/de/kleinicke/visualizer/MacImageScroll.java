package de.kleinicke.visualizer;

import com.intellij.openapi.util.SystemInfoRt;
import com.intellij.ui.jcef.JBCefBrowser;
import java.awt.*;
import java.awt.event.*;
import java.util.ArrayList;
import java.util.List;

/** Avoid the OSR accumulator's half-second delay for small Mac wheel deltas. */
final class MacImageScroll implements AutoCloseable {
    private final List<Component> targets = new ArrayList<>();
    private final MouseWheelListener listener;
    MacImageScroll(JBCefBrowser browser, String url) {
        listener = event -> {
            if (event.isConsumed() || event.isAltDown() || event.isControlDown() || event.isMetaDown()
                    || event.getScrollType() != MouseWheelEvent.WHEEL_UNIT_SCROLL) return;
            Component source = event.getComponent();
            if (source.getWidth() <= 0 || source.getHeight() <= 0) return;
            double delta = event.getPreciseWheelRotation() * 40.0;
            if (!Double.isFinite(delta) || delta == 0) return;
            double x = (double) event.getX() / source.getWidth();
            double y = (double) event.getY() / source.getHeight();
            event.consume();
            browser.getCefBrowser().executeJavaScript("window.jetbrainsPan?.(" + x + "," + y + "," +
                (event.isShiftDown() ? delta : 0) + "," + (event.isShiftDown() ? 0 : delta) + ")", url, 0);
        };
        if (SystemInfoRt.isMac) install(browser.getComponent());
    }
    private void install(Component component) {
        // This implementation class is package-private; avoid linking against it.
        if (component.getClass().getName().equals("com.intellij.ui.jcef.JBCefOsrComponent")) {
            component.addMouseWheelListener(listener);
            targets.add(component);
        }
        if (component instanceof Container parent) for (Component child : parent.getComponents()) install(child);
    }
    @Override public void close() { for (Component component : targets) component.removeMouseWheelListener(listener); targets.clear(); }
}
