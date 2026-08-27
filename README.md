# native.build

Source of the [native.build](https://native.build) landing page — the home of **Alloy**, a Gradle
toolchain that fuses Java and C/C++ into a single reproducible build.

Static, dependency-free, served by GitHub Pages from the default branch.

```
index.html          the page
assets/style.css    palette and layout — amber (Java) + teal (native) → platinum (alloy)
assets/fluid.js     WebGL2 Navier–Stokes background; code panels act as obstacles
assets/site.js      syntax highlighting and scroll reveals
CNAME               native.build
```

The background is a real fluid solver: advection, vorticity confinement and a Jacobi pressure
projection, run at low resolution in fragment shaders. Two dyes are injected from opposite edges
and advected into one another; where they mix, the additive blend goes pale — the alloy. Scrolling
agitates the field, and every element marked `data-obstacle` is rasterised into an obstacle mask
each frame, so the flow parts around the code panels and slips through the gap between the two
halves. Browsers without WebGL2 or float render targets simply get the static background.
