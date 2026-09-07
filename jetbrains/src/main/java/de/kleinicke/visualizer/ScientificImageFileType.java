package de.kleinicke.visualizer;

import com.intellij.icons.AllIcons;
import com.intellij.openapi.fileTypes.FileType;
import org.jetbrains.annotations.NotNull;
import javax.swing.Icon;

public final class ScientificImageFileType implements FileType {
    public static final ScientificImageFileType INSTANCE = new ScientificImageFileType();
    private ScientificImageFileType() { }
    @Override public @NotNull String getName() { return "Scientific Image"; }
    @Override public @NotNull String getDescription() { return "Scientific image or layered document"; }
    @Override public @NotNull String getDefaultExtension() { return "exr"; }
    @Override public Icon getIcon() { return AllIcons.FileTypes.Image; }
    @Override public boolean isBinary() { return true; }
}
