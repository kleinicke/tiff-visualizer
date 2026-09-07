package de.kleinicke.visualizer;

import com.intellij.ui.components.Magnificator;
import com.intellij.ui.components.ZoomableViewport;
import javax.swing.JPanel;
import java.awt.BorderLayout;
import java.awt.Point;
import java.util.function.BiConsumer;

/** Receives real Mac magnification gestures routed by the IDE's gesture manager. */
public final class ViewerGesturePanel extends JPanel implements ZoomableViewport {
    private BiConsumer<String, Double> receiver;
    private boolean magnifying;
    public ViewerGesturePanel() { super(new BorderLayout()); }
    void setGestureReceiver(BiConsumer<String, Double> receiver) { this.receiver = receiver; }
    @Override public Magnificator getMagnificator() {
        return receiver == null ? null : (scale, at) -> at;
    }
    @Override public void magnificationStarted(Point at) {
        if (receiver == null) return;
        magnifying = true;
        receiver.accept("gesturestart", 1.0);
    }
    @Override public void magnify(double magnification) {
        if (!magnifying || receiver == null || !Double.isFinite(magnification)) return;
        receiver.accept("gesturechange", Math.exp(Math.max(-8, Math.min(8, magnification))));
    }
    @Override public void magnificationFinished(double magnification) {
        if (!magnifying || receiver == null) return;
        magnify(magnification);
        receiver.accept("gestureend", 1.0);
        magnifying = false;
    }
}
