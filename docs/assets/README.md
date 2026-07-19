# docs/assets

Repository imagery. Currently: the GitHub **social preview** card.

## social-preview.png

The image GitHub shows when the repo is shared on social platforms (the Open
Graph card). Sized to GitHub's recommended **1280×640** with every meaningful
element kept inside the 40px safe border so previews are never cropped.

GitHub exposes no API for this — apply it by hand:
**Settings → General → Social preview → Edit → Upload an image.**

### Regenerating

`social-preview.png` is rendered from `social-preview.html` (Catppuccin Mocha,
the spec's default theme example) with headless Chromium. The window renders
short when the page body equals the viewport, so render on a taller canvas and
crop the top 1280×640:

```sh
chromium --headless=new --force-device-scale-factor=1 \
  --window-size=1280,760 --default-background-color=00000000 \
  --screenshot=full.png docs/assets/social-preview.html
# then crop full.png to (0,0,1280,640) -> social-preview.png
```

Edit the HTML, re-render, and commit both files together.
