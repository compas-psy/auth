// Клиент первичного токен-API СИМПАС.
//
// ЧИСТЫЙ Kotlin/JVM, БЕЗ зависимостей от Android. Это осознанно:
//   * библиотека проверяется обычными тестами на JVM, а не эмулятором,
//     и потому проверяется вообще — Android-тесты в нашем прогоне не
//     запускаются;
//   * приложению она подключается как есть: OkHttp у ПРАКТИКИ уже стоит.
//
// Хранение токенов сюда НЕ входит намеренно: на Android их место в
// EncryptedSharedPreferences поверх Keystore, а библиотека, знающая
// про хранилище, неизбежно навязала бы своё.
plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

kotlin { jvmToolchain(21) }
tasks.test { useJUnitPlatform() }
