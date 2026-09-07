package de.kleinicke.visualizer;

import java.io.IOException;
import java.util.*;

/** Registry generated from both VS Code manifests, with explicit host limitations. */
public final class ViewerFormats {
    private static final Properties FORMATS = new Properties();
    static {
        try (var input = ViewerFormats.class.getResourceAsStream("/formats.properties")) {
            if (input == null) throw new IOException("Missing format registry");
            FORMATS.load(input);
        } catch (IOException error) { throw new ExceptionInInitializerError(error); }
    }
    public static String kind(String extension) {
        if (extension == null) return null;
        String suffix = extension.toLowerCase(Locale.ROOT);
        for (String kind : new String[]{"image", "ply"}) {
            if (Arrays.asList(FORMATS.getProperty(kind).split(",")).contains(suffix)) return kind;
        }
        return null;
    }
    private ViewerFormats() { }
}
