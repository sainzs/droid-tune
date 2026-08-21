# droid-tune project site

Single-page landing page for droid-tune. Static, dependency-free, no build
step, no external requests — every asset is relative, so it renders offline.

## Preview

Open `site/index.html` directly in a browser (`file://` works), or serve the
directory so the relative assets resolve:

```sh
cd site && python3 -m http.server 8000
# then open http://localhost:8000/
```

Files: `index.html`, `styles.css`, `hero.gif`. No JavaScript is used.
