# Android adaptive icons

Канва **108×108 dp**. Контент лежит в центральной безопасной зоне 66 dp — дерево занимает **62 dp**, поэтому переживает любую маску OEM (круг, squircle, скруглённый квадрат, teardrop) без обрезки.

## Файлы на каждый сервис

| Файл | Слой | Куда |
| --- | --- | --- |
| `<сервис>-bg.svg` | background | `ic_launcher_background` — сплошная плашка цвета сервиса |
| `<сервис>-fg.svg` | foreground | `ic_launcher_foreground` — дерево в цвете сервиса, прозрачный фон |
| `<сервис>-mono.svg` | monochrome | `ic_launcher_monochrome` — дерево чёрным для themed icons (Android 13+); система сама перекрасит под обои |
| `<сервис>-preview.svg` | — | только для показа: как выглядит под squircle-маской. В сборку не кладётся |

## Сборка

```xml
<!-- res/mipmap-anydpi-v26/ic_launcher.xml -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
```

SVG конвертируются в vector drawable через Android Studio (Asset Studio → Vector Asset) или `svg2vectordrawable`. Legacy-растр для API < 26 генерируется из `assets/services/<сервис>.svg`.

## Правила

- **Фон — только плашка.** Ни градиентов, ни теней, ни бликов: система накладывает собственные эффекты параллакса и тени при движении.
- **Дерево не выносить за 62 dp.** Слои сдвигаются относительно друг друга при параллаксе, и всё, что ближе к краю, срежется.
- **Контур дерева не менять.** Ни для одного сервиса, ни ради «оптической компенсации».
- **Monochrome — сплошной чёрный.** Никаких полутонов и прозрачности внутри силуэта: система работает с ним как с маской.
- **Надписей внутри иконки нет.** Имя сервиса рисует лаунчер.
