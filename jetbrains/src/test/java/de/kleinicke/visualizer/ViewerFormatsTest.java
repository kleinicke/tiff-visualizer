package de.kleinicke.visualizer;
import org.junit.Test;
import static org.junit.Assert.*;
public class ViewerFormatsTest {
    @Test public void routesImagesWithoutClaimingGeometryOrGenericBinary() {
        for (String suffix : new String[]{"tiff", "DCM", "EXR", "npz", "psd", "jpg"}) assertEquals("image", ViewerFormats.kind(suffix));
        for (String suffix : new String[]{"PLY", "obj", "las", "glb", "sog", "nrrd"}) assertNull(ViewerFormats.kind(suffix));
        for (String suffix : new String[]{"bin", "nhdr", "json", "java", ""}) assertNull(ViewerFormats.kind(suffix));
        assertNull(ViewerFormats.kind(null));
    }
}
