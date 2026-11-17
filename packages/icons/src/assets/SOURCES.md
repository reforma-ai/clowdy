# Browser and operating system icons

These local SVGs identify browsers and operating systems in analytics. They build through the existing `@clowdy/icons/assets` pack, which preserves colors. No runtime downloads are required. Files are maintained locally and are not managed by the Figma sync manifest.

## Browser Logos

Source: [alrra/browser-logos](https://github.com/alrra/browser-logos/tree/58881b84c4d73adc03c06fa2c275a7abee02d935), pinned to `58881b84c4d73adc03c06fa2c275a7abee02d935`.

| Local file | Upstream file |
| --- | --- |
| `browser-chrome.svg` | `src/chrome/chrome.svg` |
| `browser-edge.svg` | `src/edge/edge.svg` |
| `browser-firefox.svg` | `src/firefox/firefox.svg` |
| `browser-opera.svg` | `src/opera/opera.svg` |
| `browser-safari.svg` | `src/safari/safari.svg` |
| `browser-samsung-internet.svg` | `src/samsung-internet/samsung-internet.svg` |

Logos and trademarks belong to their respective owners. The collection's remaining material is MIT-licensed; see [LICENSE-browser-logos.txt](LICENSE-browser-logos.txt).

## SuperTinyIcons

Source: [edent/SuperTinyIcons](https://github.com/edent/SuperTinyIcons/tree/d532b8a9e8a96ed5462f3813106f0b1e230249dc), pinned to `d532b8a9e8a96ed5462f3813106f0b1e230249dc`.

| Local file | Upstream file | Cropped viewBox |
| --- | --- | --- |
| `os-android.svg` | `images/svg/android.svg` | `74 116 360 212` |
| `os-linux.svg` | `images/svg/linux.svg` | `80 32 352 416` |
| `os-windows.svg` | `images/svg/windows.svg` | `96 96 320 320` |

MIT license: [LICENSE-supertinyicons.txt](LICENSE-supertinyicons.txt). The white canvas path and upstream accessibility labels were removed; the viewBox was cropped to the artwork so icons remain legible at 14 px on either theme. The shared icon wrapper owns accessibility.

## Import normalization

The Edge and Firefox sources use `x` as an alias for the XLink namespace; it was renamed to the standard `xlink` alias before normalization so SVG reference rewriting and React both recognize it.

All nine SVGs passed through the installed SVGO `prefixIds` plugin only, using `clowdy-<local filename without .svg>` as the prefix. This namespaces gradient, filter, clip, and class references when different logos appear together. Geometry and colors are preserved. Do not run the ordinary monochrome icon optimization on these assets.

macOS and iOS reuse `Apple` from `@clowdy/icons/logo`. Chrome OS reuses the Chrome logo. Device icons reuse the existing `Desktop`, `Mobile`, and `Tablet` components.
