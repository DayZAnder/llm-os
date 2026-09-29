//! llmos-render — native renderer spike for LLM OS portable UI trees.
//!
//! Reads the JSON tree an app produces with `LLMOS.ui.snapshot()` (the same
//! tree the browser renders), lays it out with flexbox (taffy), rasterizes it
//! (tiny-skia + fontdue) and writes the frame to a PNG or a Linux framebuffer.
//! No browser, no X/Wayland: this is the path to a GUI on the 50 MB image.
//!
//! Usage:
//!   llmos-render <tree.json> [--png out.png] [--fb /dev/fb0] [--size 1920x1080]
//!                [--font path.ttf] [--title "Tasks"]

use fontdue::{Font, FontSettings};
use serde_json::Value;
use std::collections::HashMap;
use taffy::prelude::*;
use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

// ---------------------------------------------------------------- theme --

/// The default --llmos-* design tokens (must match src/shell/sandbox.js).
struct Theme {
    bg: Color,
    surface: Color,
    surface2: Color,
    fg: Color,
    muted: Color,
    accent: Color,
    accent_fg: Color,
    border: Color,
    danger: Color,
    success: Color,
    desktop: Color,
    radius: f32,
}

fn hex(s: &str) -> Color {
    let s = s.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0);
    Color::from_rgba8(p(0), p(2), p(4), 255)
}

impl Theme {
    fn default_theme() -> Self {
        Theme {
            bg: hex("#12121f"),
            surface: hex("#1a1a2e"),
            surface2: hex("#24243d"),
            fg: hex("#e0e0f0"),
            muted: hex("#8888a8"),
            accent: hex("#6c63ff"),
            accent_fg: hex("#ffffff"),
            border: hex("#2e2e4a"),
            danger: hex("#ff5c7a"),
            success: hex("#3ddc97"),
            desktop: hex("#0d0d1a"),
            radius: 8.0,
        }
    }
}

// ----------------------------------------------------------------- text --

struct Text {
    font: Font,
    bold: Option<Font>,
}

const LINE_HEIGHT: f32 = 1.45;

impl Text {
    fn face(&self, bold: bool) -> &Font {
        if bold { self.bold.as_ref().unwrap_or(&self.font) } else { &self.font }
    }

    fn width(&self, s: &str, size: f32) -> f32 {
        self.width_w(s, size, false)
    }

    fn width_w(&self, s: &str, size: f32, bold: bool) -> f32 {
        let f = self.face(bold);
        s.chars().map(|c| f.metrics(c, size).advance_width).sum()
    }

    /// Greedy word wrap. Returns the lines and the widest line's width.
    fn wrap(&self, s: &str, size: f32, max_width: Option<f32>, bold: bool) -> (Vec<String>, f32) {
        let mut lines = Vec::new();
        let mut widest: f32 = 0.0;
        for para in s.split('\n') {
            let mut line = String::new();
            for word in para.split(' ') {
                let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                match max_width {
                    Some(w) if !line.is_empty() && self.width_w(&candidate, size, bold) > w => {
                        widest = widest.max(self.width_w(&line, size, bold));
                        lines.push(std::mem::take(&mut line));
                        line = word.to_string();
                    }
                    _ => line = candidate,
                }
            }
            widest = widest.max(self.width_w(&line, size, bold));
            lines.push(line);
        }
        (lines, widest)
    }

    /// Draw one line with its top-left at (x, y).
    fn draw(&self, pix: &mut Pixmap, s: &str, x: f32, y: f32, size: f32, color: Color, clip: Option<Rect>) {
        self.draw_w(pix, s, x, y, size, color, clip, false)
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_w(&self, pix: &mut Pixmap, s: &str, x: f32, y: f32, size: f32, color: Color, clip: Option<Rect>, bold: bool) {
        let face = self.face(bold);
        let ascent = face
            .horizontal_line_metrics(size)
            .map(|m| m.ascent)
            .unwrap_or(size * 0.8);
        let baseline = y + (size * LINE_HEIGHT - size) / 2.0 + ascent;
        let mut pen = x;
        let (w, h) = (pix.width() as i32, pix.height() as i32);
        let c = color.to_color_u8();
        let data = pix.data_mut();
        for ch in s.chars() {
            let (m, bitmap) = face.rasterize(ch, size);
            let gx = (pen + m.xmin as f32).round() as i32;
            let gy = (baseline - m.height as f32 - m.ymin as f32).round() as i32;
            for row in 0..m.height as i32 {
                for col in 0..m.width as i32 {
                    let (px, py) = (gx + col, gy + row);
                    if px < 0 || py < 0 || px >= w || py >= h { continue; }
                    if let Some(r) = clip {
                        if (px as f32) < r.left() || (px as f32) >= r.right() || (py as f32) < r.top() || (py as f32) >= r.bottom() { continue; }
                    }
                    let a = bitmap[(row * m.width as i32 + col) as usize] as u32 * c.alpha() as u32 / 255;
                    if a == 0 { continue; }
                    let i = ((py * w + px) * 4) as usize;
                    // source-over onto an opaque premultiplied RGBA buffer
                    for (k, src) in [c.red(), c.green(), c.blue()].into_iter().enumerate() {
                        data[i + k] = ((src as u32 * a + data[i + k] as u32 * (255 - a)) / 255) as u8;
                    }
                    data[i + 3] = 255;
                }
            }
            pen += m.advance_width;
        }
    }
}

// --------------------------------------------------------------- layout --

fn text_size(props: &Value) -> f32 {
    if let Some(px) = props.get("size").and_then(Value::as_f64) {
        return (px as f32).clamp(1.0, 200.0);
    }
    match props.get("size").and_then(Value::as_str) {
        Some("sm") => 12.0,
        Some("lg") => 18.0,
        Some("xl") => 24.0,
        _ => 14.0,
    }
}

fn str_children(node: &Value) -> String {
    node.get("children")
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(""))
        .unwrap_or_default()
}

/// What a leaf needs measured.
enum Measure {
    Text { text: String, size: f32, bold: bool },
    Fixed(f32, f32),
}

fn dim(v: Option<&Value>) -> Dimension {
    match v {
        Some(Value::String(s)) if s == "fill" => Dimension::percent(1.0),
        Some(Value::Number(n)) => Dimension::length(n.as_f64().unwrap_or(0.0) as f32),
        _ => Dimension::auto(),
    }
}

fn num(props: &Value, key: &str) -> Option<f32> {
    props.get(key).and_then(Value::as_f64).map(|v| v as f32)
}

fn build(tree: &mut TaffyTree<Measure>, node: &Value, text: &Text, map: &mut HashMap<NodeId, Value>) -> NodeId {
    if let Some(s) = node.as_str() {
        // bare string child: a text run
        let id = tree
            .new_leaf_with_context(Style::default(), Measure::Text { text: s.to_string(), size: 14.0, bold: false })
            .unwrap();
        map.insert(id, serde_json::json!({ "t": "text", "props": {}, "children": [s] }));
        return id;
    }
    let t = node.get("t").and_then(Value::as_str).unwrap_or("text");
    let empty = serde_json::json!({});
    let props = node.get("props").unwrap_or(&empty);

    let mut style = Style {
        flex_grow: num(props, "grow").unwrap_or(0.0),
        flex_shrink: 1.0,
        min_size: Size { width: LengthPercentageAuto::length(0.0), height: LengthPercentageAuto::auto() },
        size: Size { width: dim(props.get("width")), height: dim(props.get("height")) },
        ..Default::default()
    };

    let id = match t {
        "column" | "row" | "scroll" => {
            style.display = Display::Flex;
            style.flex_direction = if t == "row" { FlexDirection::Row } else { FlexDirection::Column };
            if t == "row" && props.get("wrap").and_then(Value::as_bool).unwrap_or(false) {
                style.flex_wrap = FlexWrap::Wrap;
            }
            if t == "scroll" {
                style.overflow = taffy::Point { x: taffy::Overflow::Hidden, y: taffy::Overflow::Hidden };
                style.min_size.height = LengthPercentageAuto::length(0.0);
            }
            let g = num(props, "gap").unwrap_or(0.0);
            style.gap = Size { width: LengthPercentage::length(g), height: LengthPercentage::length(g) };
            let p = LengthPercentage::length(num(props, "padding").unwrap_or(0.0));
            style.padding = taffy::Rect { left: p, right: p, top: p, bottom: p };
            style.align_items = Some(match props.get("align").and_then(Value::as_str) {
                Some("start") => AlignItems::FLEX_START,
                Some("center") => AlignItems::CENTER,
                Some("end") => AlignItems::FLEX_END,
                _ => AlignItems::STRETCH,
            });
            style.justify_content = Some(match props.get("justify").and_then(Value::as_str) {
                Some("center") => JustifyContent::CENTER,
                Some("end") => JustifyContent::FLEX_END,
                Some("between") => JustifyContent::SPACE_BETWEEN,
                _ => JustifyContent::FLEX_START,
            });
            let kids: Vec<NodeId> = node
                .get("children")
                .and_then(Value::as_array)
                .map(|c| c.iter().map(|ch| build(tree, ch, text, map)).collect())
                .unwrap_or_default();
            tree.new_with_children(style, &kids).unwrap()
        }
        "text" => {
            let size = text_size(props);
            let bold = props.get("weight").and_then(Value::as_str) == Some("bold");
            tree.new_leaf_with_context(style, Measure::Text { text: str_children(node), size, bold }).unwrap()
        }
        "button" => {
            let label = str_children(node);
            let w = text.width(&label, 14.0) + 28.0 + 2.0;
            style.flex_shrink = 0.0;
            tree.new_leaf_with_context(style, Measure::Fixed(w, 14.0 * 1.2 + 14.0 + 2.0)).unwrap()
        }
        "input" => {
            if style.size.width == Dimension::auto() && style.flex_grow == 0.0 {
                style.size.width = Dimension::length(200.0);
            }
            tree.new_leaf_with_context(style, Measure::Fixed(0.0, 14.0 * 1.2 + 14.0 + 2.0)).unwrap()
        }
        "textarea" => {
            let h = num(props, "height").unwrap_or(120.0);
            tree.new_leaf_with_context(style, Measure::Fixed(0.0, h)).unwrap()
        }
        "checkbox" => {
            let label = props.get("label").and_then(Value::as_str).unwrap_or("");
            let w = 16.0 + if label.is_empty() { 0.0 } else { 8.0 + text.width(label, 14.0) };
            style.flex_shrink = 0.0;
            tree.new_leaf_with_context(style, Measure::Fixed(w, 16.0_f32.max(14.0 * LINE_HEIGHT))).unwrap()
        }
        "spacer" => {
            match num(props, "size") {
                Some(s) => { style.flex_basis = Dimension::length(s); style.flex_grow = 0.0; style.flex_shrink = 0.0; }
                None => { style.flex_grow = 1.0; }
            }
            tree.new_leaf(style).unwrap()
        }
        "logo" => {
            let px = num(props, "size").unwrap_or(24.0);
            style.flex_shrink = 0.0;
            tree.new_leaf_with_context(style, Measure::Fixed(px, px)).unwrap()
        }
        "divider" => {
            style.size.height = Dimension::length(1.0);
            style.flex_shrink = 0.0;
            tree.new_leaf(style).unwrap()
        }
        _ => tree.new_leaf(style).unwrap(),
    };
    map.insert(id, node.clone());
    id
}

// ---------------------------------------------------------------- paint --

fn rrect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}

fn fill(pix: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, r: f32, color: Color) {
    if let Some(path) = rrect(x, y, w, h, r) {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        pix.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

fn stroke(pix: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, r: f32, color: Color) {
    if let Some(path) = rrect(x + 0.5, y + 0.5, w - 1.0, h - 1.0, r) {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        pix.stroke_path(&path, &paint, &Stroke { width: 1.0, ..Default::default() }, Transform::identity(), None);
    }
}

fn tone(props: &Value, th: &Theme) -> Color {
    match props.get("tone").and_then(Value::as_str) {
        Some("muted") => th.muted,
        Some("accent") => th.accent,
        Some("danger") => th.danger,
        Some("success") => th.success,
        _ => th.fg,
    }
}

struct Painter<'a> {
    tree: &'a TaffyTree<Measure>,
    nodes: &'a HashMap<NodeId, Value>,
    text: &'a Text,
    th: &'a Theme,
}

impl Painter<'_> {
    fn paint(&self, pix: &mut Pixmap, id: NodeId, ox: f32, oy: f32, clip: Option<Rect>) {
        let l = self.tree.layout(id).unwrap();
        let (x, y, w, h) = (ox + l.location.x, oy + l.location.y, l.size.width, l.size.height);
        let empty = serde_json::json!({});
        let node = &self.nodes[&id];
        let props = node.get("props").unwrap_or(&empty);
        let t = node.get("t").and_then(Value::as_str).unwrap_or("text");
        let th = self.th;
        let mut child_clip = clip;

        match t {
            "column" | "row" | "scroll" => {
                match props.get("surface").and_then(Value::as_str) {
                    Some("panel") => { fill(pix, x, y, w, h, th.radius, th.surface); stroke(pix, x, y, w, h, th.radius, th.border); }
                    Some("card") => fill(pix, x, y, w, h, th.radius, th.surface2),
                    _ => {}
                }
                if t == "scroll" {
                    child_clip = Rect::from_xywh(x, y, w, h);
                    // anchor: "end" — show the bottom of overflowing content (logs, terminals)
                    if props.get("anchor").and_then(Value::as_str) == Some("end") {
                        let bottom = self.tree.children(id).unwrap_or_default().iter()
                            .map(|c| { let l = self.tree.layout(*c).unwrap(); l.location.y + l.size.height })
                            .fold(0.0f32, f32::max);
                        let pad = num(props, "padding").unwrap_or(0.0);
                        let shift = (bottom + pad - h).max(0.0);
                        for child in self.tree.children(id).unwrap_or_default() {
                            self.paint(pix, child, x, y - shift, child_clip);
                        }
                        return;
                    }
                }
            }
            "text" => {
                let size = text_size(props);
                let bold = props.get("weight").and_then(Value::as_str) == Some("bold");
                let (lines, _) = self.text.wrap(&str_children(node), size, Some(w.max(1.0)), bold);
                for (i, line) in lines.iter().enumerate() {
                    self.text.draw_w(pix, line, x, y + i as f32 * size * LINE_HEIGHT, size, tone(props, th), clip, bold);
                }
            }
            "button" => {
                let disabled = props.get("disabled").and_then(Value::as_bool).unwrap_or(false);
                let variant = props.get("variant").and_then(Value::as_str).unwrap_or("secondary");
                let (bg, fg, border) = match variant {
                    "primary" => (Some(th.accent), th.accent_fg, Some(th.accent)),
                    "danger" => (Some(th.surface2), th.danger, Some(th.border)),
                    "ghost" => (None, th.fg, None),
                    _ => (Some(th.surface2), th.fg, Some(th.border)),
                };
                let fade = |mut c: Color| { if disabled { c.set_alpha(0.45); } c };
                if let Some(bg) = bg { fill(pix, x, y, w, h, th.radius, fade(bg)); }
                if let Some(b) = border { stroke(pix, x, y, w, h, th.radius, fade(b)); }
                let label = str_children(node);
                let tw = self.text.width(&label, 14.0);
                self.text.draw(pix, &label, x + (w - tw) / 2.0, y + (h - 14.0 * LINE_HEIGHT) / 2.0, 14.0, fade(fg), clip);
            }
            "input" | "textarea" => {
                fill(pix, x, y, w, h, th.radius, th.bg);
                stroke(pix, x, y, w, h, th.radius, th.border);
                let value = props.get("value").and_then(Value::as_str).unwrap_or("");
                let (s, c) = if value.is_empty() {
                    (props.get("placeholder").and_then(Value::as_str).unwrap_or(""), th.muted)
                } else { (value, th.fg) };
                let inner = Rect::from_xywh(x + 1.0, y + 1.0, (w - 2.0).max(1.0), (h - 2.0).max(1.0));
                let ty = if t == "input" { y + (h - 14.0 * LINE_HEIGHT) / 2.0 } else { y + 7.0 };
                self.text.draw(pix, s, x + 10.0, ty, 14.0, c, inner);
            }
            "checkbox" => {
                let checked = props.get("checked").and_then(Value::as_bool).unwrap_or(false);
                let by = y + (h - 16.0) / 2.0;
                if checked {
                    fill(pix, x, by, 16.0, 16.0, 3.0, th.accent);
                    let mut pb = PathBuilder::new();
                    pb.move_to(x + 4.0, by + 8.5);
                    pb.line_to(x + 7.0, by + 11.5);
                    pb.line_to(x + 12.5, by + 5.0);
                    if let Some(path) = pb.finish() {
                        let mut paint = Paint::default();
                        paint.set_color(th.accent_fg);
                        paint.anti_alias = true;
                        pix.stroke_path(&path, &paint, &Stroke { width: 2.0, ..Default::default() }, Transform::identity(), None);
                    }
                } else {
                    fill(pix, x, by, 16.0, 16.0, 3.0, th.bg);
                    stroke(pix, x, by, 16.0, 16.0, 3.0, th.muted);
                }
                if let Some(label) = props.get("label").and_then(Value::as_str) {
                    self.text.draw(pix, label, x + 24.0, y + (h - 14.0 * LINE_HEIGHT) / 2.0, 14.0, th.fg, clip);
                }
            }
            "divider" => fill(pix, x, y, w, 1.0, 0.0, th.border),
            "logo" => draw_logo(pix, x, y, w.min(h), th),
            _ => {}
        }

        for child in self.tree.children(id).unwrap_or_default() {
            self.paint(pix, child, x, y, child_clip);
        }
    }
}

// ---------------------------------------------------------------- logo --

// Same shapes as LOGO_SPARK / LOGO_SPARK_SMALL in src/sdk/ui.js (viewBox 32x32)
const LOGO_SPARK: &str = "M14 5C14.9 11.6 17.4 14.1 24 15 17.4 15.9 14.9 18.4 14 25 13.1 18.4 10.6 15.9 4 15 10.6 14.1 13.1 11.6 14 5Z";
const LOGO_SPARK_SMALL: &str = "M23.5 18.5C23.9 21 24.8 21.9 27.5 22.5 24.8 23.1 23.9 24 23.5 26.5 23.1 24 22.2 23.1 19.5 22.5 22.2 21.9 23.1 21 23.5 18.5Z";

/// Minimal SVG path reader: absolute M, L, C (with repeated coordinate groups) and Z.
fn svg_path(d: &str, ox: f32, oy: f32, scale: f32) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    let mut nums: Vec<f32> = Vec::new();
    let mut cmd = ' ';
    let flush = |cmd: char, nums: &mut Vec<f32>, pb: &mut PathBuilder| {
        let p = |i: usize, v: &[f32]| (ox + v[i] * scale, oy + v[i + 1] * scale);
        match cmd {
            'M' => { for (k, c) in nums.chunks(2).enumerate() { if c.len() == 2 { let (x, y) = p(0, c); if k == 0 { pb.move_to(x, y) } else { pb.line_to(x, y) } } } }
            'L' => { for c in nums.chunks(2) { if c.len() == 2 { let (x, y) = p(0, c); pb.line_to(x, y); } } }
            'C' => { for c in nums.chunks(6) { if c.len() == 6 { let (a, b) = p(0, c); let (e, f) = p(2, c); let (g, h) = p(4, c); pb.cubic_to(a, b, e, f, g, h); } } }
            _ => {}
        }
        nums.clear();
    };
    let mut token = String::new();
    for ch in d.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphabetic() || ch == ' ' || ch == ',' || (ch == '-' && !token.is_empty()) {
            if !token.is_empty() { nums.push(token.parse().unwrap_or(0.0)); token.clear(); }
            if ch == '-' { token.push(ch); continue; }
            if ch.is_ascii_alphabetic() {
                flush(cmd, &mut nums, &mut pb);
                if ch == 'Z' || ch == 'z' { pb.close(); cmd = ' '; } else { cmd = ch; }
            }
        } else {
            token.push(ch);
        }
    }
    flush(cmd, &mut nums, &mut pb);
    pb.finish()
}

/// The launcher mark: a solid accent tile with a spark.
fn draw_logo(pix: &mut Pixmap, x: f32, y: f32, size: f32, th: &Theme) {
    let s = size / 32.0;
    fill(pix, x, y, size, size, 8.0 * s, th.accent);
    let mut paint = Paint::default();
    paint.anti_alias = true;
    paint.set_color(th.accent_fg);
    if let Some(path) = svg_path(LOGO_SPARK, x, y, s) {
        pix.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
    let mut small = th.accent_fg;
    small.set_alpha(0.85);
    paint.set_color(small);
    if let Some(path) = svg_path(LOGO_SPARK_SMALL, x, y, s) {
        pix.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

// ---------------------------------------------------------------- output --

#[cfg(target_os = "linux")]
fn write_fb(pix: &Pixmap, dev: &str) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let name = std::path::Path::new(dev).file_name().unwrap().to_string_lossy().to_string();
    let read = |f: &str| std::fs::read_to_string(format!("/sys/class/graphics/{name}/{f}")).unwrap_or_default();
    let bpp: usize = read("bits_per_pixel").trim().parse().unwrap_or(32);
    let stride: usize = read("stride").trim().parse().unwrap_or(pix.width() as usize * bpp / 8);
    let vs = read("virtual_size");
    let mut it = vs.trim().split(',').map(|v| v.parse::<usize>().unwrap_or(0));
    let (fw, fh) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    if bpp != 32 { return Err(std::io::Error::other(format!("unsupported framebuffer depth: {bpp} bpp"))); }
    let mut fb = std::fs::OpenOptions::new().write(true).open(dev)?;
    let (w, h) = ((pix.width() as usize).min(fw), (pix.height() as usize).min(fh));
    let src = pix.data();
    let mut row = vec![0u8; w * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * pix.width() as usize + x) * 4;
            // RGBA (opaque) -> BGRX, the common fbdev layout
            row[x * 4] = src[i + 2];
            row[x * 4 + 1] = src[i + 1];
            row[x * 4 + 2] = src[i];
            row[x * 4 + 3] = 255;
        }
        fb.seek(SeekFrom::Start((y * stride) as u64))?;
        fb.write_all(&row)?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn write_fb(_: &Pixmap, _: &str) -> std::io::Result<()> {
    Err(std::io::Error::other("framebuffer output is only available on Linux"))
}

fn default_font() -> Option<String> {
    [
        "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/llmos/sans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ]
    .iter()
    .find(|p| std::path::Path::new(p).exists())
    .map(|p| p.to_string())
}

fn default_bold_font() -> Option<String> {
    [
        "C:/Windows/Fonts/segoeuisb.ttf",
        "C:/Windows/Fonts/segoeuib.ttf",
        "/usr/share/fonts/llmos/sans-bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    .iter()
    .find(|p| std::path::Path::new(p).exists())
    .map(|p| p.to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let Some(input) = args.get(1).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: llmos-render <tree.json> [--png out.png] [--fb /dev/fb0] [--size 1920x1080] [--font f.ttf] [--title T]");
        std::process::exit(2);
    };
    let (sw, sh) = flag("--size")
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap_or(1920), b.parse().unwrap_or(1080))))
        .unwrap_or((1920u32, 1080u32));
    let title = flag("--title").unwrap_or_else(|| "App".into());

    let font_path = flag("--font").or_else(default_font).expect("no font found; pass --font path.ttf");
    let font = Font::from_bytes(std::fs::read(&font_path).expect("read font"), FontSettings::default()).expect("parse font");
    let bold = flag("--bold-font").or_else(default_bold_font).and_then(|p| std::fs::read(p).ok()).and_then(|b| Font::from_bytes(b, FontSettings::default()).ok());
    let text = Text { font, bold };
    let th = Theme::default_theme();

    let tree_json: Value = serde_json::from_str(&std::fs::read_to_string(input).expect("read tree")).expect("parse tree");

    let started = std::time::Instant::now();

    // Build the layout tree for the app content
    let mut tree: TaffyTree<Measure> = TaffyTree::new();
    let mut nodes = HashMap::new();
    let root = build(&mut tree, &tree_json, &text, &mut nodes);

    // Window geometry matching the browser shell screenshot
    let (wx, wy, ww, wh, tb) = (40.0f32, 66.0f32, 720.0f32, 560.0f32, 30.0f32);
    let content = Size { width: AvailableSpace::Definite(ww - 2.0), height: AvailableSpace::Definite(wh - tb - 1.0) };
    tree.set_style(root, Style {
        size: Size { width: Dimension::length(ww - 2.0), height: Dimension::length(wh - tb - 1.0) },
        ..tree.style(root).unwrap().clone()
    }).unwrap();
    tree.compute_layout_with_measure(root, content, |inputs, _id, ctx, style| {
        taffy::compute_leaf_layout(inputs, style, |_, _| 0.0, |known, available| match ctx.as_deref() {
            Some(Measure::Text { text: s, size, bold }) => {
                let max = known.width.or(match available.width {
                    AvailableSpace::Definite(w) => Some(w),
                    _ => None,
                });
                let (lines, widest) = text.wrap(s, *size, max, *bold);
                Size { width: known.width.unwrap_or(widest.ceil()), height: lines.len() as f32 * size * LINE_HEIGHT }
            }
            Some(Measure::Fixed(w, h)) => Size { width: known.width.unwrap_or(*w), height: known.height.unwrap_or(*h) },
            None => Size::ZERO,
        })
    }).unwrap();

    // Paint: desktop, top bar, window chrome, app
    let mut pix = Pixmap::new(sw, sh).expect("pixmap");
    pix.fill(th.desktop);
    fill(&mut pix, 0.0, 0.0, sw as f32, 36.0, 0.0, hex("#141428"));
    fill(&mut pix, 0.0, 36.0, sw as f32, 1.0, 0.0, th.border);
    text.draw(&mut pix, "LLM OS", 16.0, 9.0, 13.0, th.accent, None);
    text.draw(&mut pix, "native renderer · no browser", 90.0, 9.0, 13.0, th.muted, None);

    fill(&mut pix, wx, wy, ww, wh, 8.0, th.bg);
    fill(&mut pix, wx, wy, ww, tb, 8.0, hex("#1e1e3a"));
    fill(&mut pix, wx, wy + tb - 1.0, ww, 1.0, 0.0, th.border);
    stroke(&mut pix, wx, wy, ww, wh, 8.0, th.accent);
    text.draw(&mut pix, &title, wx + 14.0, wy + 7.0, 12.0, th.fg, None);

    let painter = Painter { tree: &tree, nodes: &nodes, text: &text, th: &th };
    painter.paint(&mut pix, root, wx + 1.0, wy + tb, Rect::from_xywh(wx, wy + tb, ww, wh - tb));

    let elapsed = started.elapsed();
    eprintln!("layout+paint {}x{} in {:.1} ms ({} nodes)", sw, sh, elapsed.as_secs_f64() * 1000.0, nodes.len());

    if let Some(out) = flag("--png") {
        pix.save_png(&out).expect("write png");
        eprintln!("wrote {out}");
    }
    if let Some(dev) = flag("--fb") {
        match write_fb(&pix, &dev) {
            Ok(()) => eprintln!("wrote {dev}"),
            Err(e) => { eprintln!("framebuffer: {e}"); std::process::exit(1); }
        }
    }
}
