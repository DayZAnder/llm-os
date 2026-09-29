# llmos-render — native renderer spike

Draws LLM OS **portable UI** trees without a browser: flexbox layout
([taffy](https://github.com/DioxusLabs/taffy)), 2D rasterization
([tiny-skia](https://github.com/linebender/tiny-skia)) and glyph rendering
([fontdue](https://github.com/mooman219/fontdue)), written to a PNG or a Linux
framebuffer.

Portable apps (`"ui": "portable"` in the app manifest) describe their interface
with `LLMOS.ui.app` and components (`column`, `row`, `text`, `button`, …). The
browser renders that tree to DOM; `LLMOS.ui.snapshot()` returns the same tree
as JSON, which is what this renderer reads.

## Status: spike

| Works | Not yet |
| --- | --- |
| Layout of every portable component, themes' default tokens | Input (keyboard/mouse via evdev) |
| Text with word wrap, regular + bold faces | Text shaping (ligatures, complex scripts, bidi), emoji |
| PNG output (Windows/Linux), `/dev/fb0` output (Linux) | Running app logic (QuickJS/WASM host) |
| Full HD frame in ~2 ms (Windows) / ~9 ms (WSL) | DRM/KMS page flipping, damage tracking |
| Static Linux binary, ~1.4 MB | Tested on a real framebuffer boot |

The micro image kernel has no framebuffer drivers yet; see
`build/buildroot/configs/linux_micro_fb.config`.

## Build and run

```bash
cargo build --release
./target/release/llmos-render tree.json --png out.png --title "Tasks"

# Static binary for the LLM OS images (rust-lld, no C toolchain needed)
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
llmos-render tree.json --fb /dev/fb0
```

Options: `--size 1920x1080` (default), `--font path.ttf`, `--bold-font path.ttf`,
`--title "Window title"`. Without `--font` it looks for Segoe UI (Windows) or
DejaVu Sans (Linux).

Get a tree from any running portable app (browser console inside the app, or
through the shell): `JSON.stringify(LLMOS.ui.snapshot())`.
