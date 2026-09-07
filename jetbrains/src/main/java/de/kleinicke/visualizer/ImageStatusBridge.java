package de.kleinicke.visualizer;

import com.google.gson.Gson;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefJSQuery;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import javax.swing.SwingUtilities;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/** Per-editor status channel; never moves image pixels across the native bridge. */
final class ImageStatusBridge implements AutoCloseable {
    record Item(String id, String text, boolean visible, String tooltip) { }
    record Normalization(double min, double max, boolean autoNormalize, boolean gammaMode) { }
    record Gamma(double in, double out) { }
    record Stats(double min, double max) { }
    record State(boolean ready, boolean modifiedPicker, List<Item> statusItems, String size, String pixel,
                 String zoom, Long fileSize, Normalization normalization, Gamma gamma, double exposure, Stats stats) { }
    private static final Gson JSON = new Gson();
    private final JBCefBrowser browser;
    private final String url;
    private final JBCefJSQuery query;
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final AtomicBoolean updateQueued = new AtomicBoolean();
    private volatile State state = new State(false, false, List.of(), "", "", "fit", null, null, null, 0, null);
    private volatile boolean closed;
    private volatile boolean nativeActive;
    private final java.util.Set<Object> nativeOwners = new java.util.HashSet<>();
    private final CefLoadHandlerAdapter loadHandler = new CefLoadHandlerAdapter() {
        @Override public void onLoadEnd(CefBrowser cef, CefFrame frame, int status) {
            if (closed || !frame.isMain() || !url.equals(frame.getURL())) return;
            execute("window.jetbrainsConnectStatus?.(json => {" + query.inject("json") + "});");
            applyNativeVisibility();
        }
    };
    ImageStatusBridge(JBCefBrowser browser, String url) {
        this.browser = browser;
        this.url = url;
        query = JBCefJSQuery.create((com.intellij.ui.jcef.JBCefBrowserBase) browser);
        query.addHandler(json -> {
            if (closed || json.length() > 65536) return null;
            try {
                State next = JSON.fromJson(json, State.class);
                if (next == null || next.statusItems() == null) return null;
                state = next;
                if (updateQueued.compareAndSet(false, true)) SwingUtilities.invokeLater(() -> {
                    updateQueued.set(false);
                    if (!closed) listeners.forEach(Runnable::run);
                });
            } catch (RuntimeException ignored) { /* Ignore malformed status messages. */ }
            return null;
        });
        browser.getJBCefClient().addLoadHandler(loadHandler, browser.getCefBrowser());
    }
    State state() { return state; }
    void addListener(Runnable listener) { listeners.add(listener); }
    void removeListener(Runnable listener) { listeners.remove(listener); }
    void setNativeActive(Object owner, boolean enabled) {
        if (enabled) nativeOwners.add(owner); else nativeOwners.remove(owner);
        boolean active = !nativeOwners.isEmpty();
        if (nativeActive == active) return;
        nativeActive = active;
        applyNativeVisibility();
    }
    private void applyNativeVisibility() {
        execute("document.documentElement.classList.toggle('jetbrains-native-status'," + nativeActive + ");");
    }
    void action(String id) {
        browser.getComponent().requestFocusInWindow();
        execute("window.scientificImageHost?.statusAction(" + JSON.toJson(id) + ");");
    }
    void adjust(String name, double... values) {
        execute("window.scientificImageHost?.adjust(" + JSON.toJson(name) + "," + JSON.toJson(values) + ");");
    }
    void command(String name) {
        execute("window.scientificImageHost?.command(" + JSON.toJson(name) + ");");
    }
    private void execute(String script) {
        if (!closed) browser.getCefBrowser().executeJavaScript(script, url, 0);
    }
    @Override public void close() {
        if (closed) return;
        execute("window.jetbrainsDisconnectStatus?.();");
        closed = true;
        listeners.clear();
        browser.getJBCefClient().removeLoadHandler(loadHandler, browser.getCefBrowser());
        query.dispose();
    }
}
