plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.7.2"
}
group = "de.kleinicke"
version = "0.2.5"
repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}
dependencies {
    intellijPlatform { pycharmCommunity("2024.3.5") }
    testImplementation("junit:junit:4.13.2")
}
java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        name = "Scientific Image and 3D Visualizers"
        ideaVersion { sinceBuild = "243" }
    }
}
tasks.runIde {
    systemProperty("ide.browser.jcef.debug.port", "9223")
    val fixtures = providers.gradleProperty("viewerTestProject")
        .orElse(file("../../test_data/testfiles").absolutePath)
    args(fixtures.get())
}
val prepareViewers by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine("node", "scripts/prepare-viewers.mjs")
}
tasks.processResources {
    dependsOn(prepareViewers)
    from(layout.buildDirectory.dir("viewer-resources"))
}

val checkFormats by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine("node", "scripts/register-formats.mjs", "--check")
}
tasks.compileJava { dependsOn(checkFormats) }
