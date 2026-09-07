package de.kleinicke.visualizer;

import org.junit.Test;
import java.awt.Point;
import java.util.ArrayList;
import static org.junit.Assert.*;

public class ViewerGesturePanelTest {
    @Test public void forwardsNativeGesturePhasesAndClearsOnDispose() {
        var panel = new ViewerGesturePanel();
        assertNull(panel.getMagnificator());
        var phases = new ArrayList<String>();
        var scales = new ArrayList<Double>();
        panel.setGestureReceiver((phase, scale) -> { phases.add(phase); scales.add(scale); });
        assertNotNull(panel.getMagnificator());
        panel.magnify(0.2);
        assertTrue(phases.isEmpty());
        panel.magnificationStarted(new Point(100, 100));
        panel.magnify(Math.log(2));
        panel.magnificationFinished(Math.log(2));
        assertEquals(java.util.List.of("gesturestart", "gesturechange", "gesturechange", "gestureend"), phases);
        assertEquals(2.0, scales.get(1), 1e-10);
        panel.setGestureReceiver(null);
        panel.magnificationStarted(new Point());
        assertEquals(4, phases.size());
    }
}
