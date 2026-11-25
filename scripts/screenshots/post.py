"""post.py <raw.png> <out.png> <reference.png>: give the flat browser capture the window shape of the
upstream screenshot.

The reference (docs/images/claudemom.png, unchanged from upstream) is an RGBA image whose corners are
transparent. macOS window corners are not circular arcs, so instead of drawing a rounded rectangle the
alpha of each reference corner (64 device px) is copied onto the capture.
"""
import sys

from PIL import Image, ImageChops, ImageOps

CORNER_DEVICE_PX = 64

raw, out, reference = sys.argv[1:4]
image = Image.open(raw).convert("RGBA")
ref = Image.open(reference).convert("RGBA")
n = CORNER_DEVICE_PX
w, h = ref.size

boxes = {
    "tl": (0, 0, n, n),
    "tr": (w - n, 0, w, n),
    "bl": (0, h - n, n, h),
    "br": (w - n, h - n, w, h),
}
corners = {name: ref.crop(box).getchannel("A") for name, box in boxes.items()}
top_left = corners["tl"]
seam_min = min(
    top_left.crop((n - 1, 0, n, n)).getextrema()[0],
    top_left.crop((0, n - 1, n, n)).getextrema()[0],
)
if seam_min != 255:
    raise SystemExit("reference corner is not fully opaque at the seam; raise CORNER_DEVICE_PX")

alpha = Image.new("L", image.size, 255)
width, height = image.size
alpha.paste(corners["tl"], (0, 0))
alpha.paste(corners["tr"], (width - n, 0))
alpha.paste(corners["bl"], (0, height - n))
alpha.paste(corners["br"], (width - n, height - n))
image.putalpha(alpha)
image.save(out, format="PNG", optimize=True)
