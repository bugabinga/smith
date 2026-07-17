//! p27-per-frame-layout
//!
//! Proves or disproves docs/SPEC.md §8.7 / §8.5 / §8.6 / §13 claims:
//!
//! HYPOTHESIS: Lua builds the layout tree ONCE (on change) into an OWNED Rust
//! data structure; Rust resolves that tree to ratatui `Rect`s EVERY frame with
//! ZERO calls back into Lua.
//!
//! Model:
//!  (a) a Lua plugin builds a layout via §8.7 primitives, exposed as a
//!      `smith.tui.layout.*` table of Rust closures returning plain descriptor
//!      tables;
//!  (b) a ONE-TIME converter walks the returned Lua table into an owned Rust
//!      `LayoutTree` enum, after which the Lua `Value` is dropped;
//!  (c) a pure `resolve(tree, area) -> Vec<(SlotId, Rect)>` over owned data.
//!
//! A Lua-call counter (incremented by every `smith.tui.layout.*` closure, i.e.
//! every time the Lua VM executes a layout primitive) proves zero Lua activity
//! during the resolve loop: it freezes the instant conversion finishes.
//!
//! Scenarios (each exits 0 with PASS lines + numbers):
//!   build-once | resolve-frame | properties | invalidation | all
//!
//! Verify: `cargo run -- all`  (release recommended: `cargo run --release -- all`)

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mlua::{Error as LuaError, Lua, Result as LuaResult, Table, Value};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Terminal;

// ===========================================================================
// Owned, Send-able layout tree (NO captured Lua handle anywhere).
// ===========================================================================

/// Identifier of a widget slot: an owned `String`, never a Lua reference.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SlotId(String);

/// §8.7 `Size`: absolute cells or a percentage of the available axis.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Size {
    Abs(u16),
    Pct(u16),
}

/// §8.7 `BorderStyle`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum BorderStyle {
    None,
    Single,
    Double,
    Rounded,
    Thick,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ScrollDir {
    Vertical,
    Horizontal,
    Both,
}

/// §8.6 nine-anchor overlay model.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Anchor {
    Center,
    TopLeft,
    TopCenter,
    TopRight,
    RightCenter,
    BottomRight,
    BottomCenter,
    BottomLeft,
    LeftCenter,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Axis {
    Horizontal,
    Vertical,
}

/// A border-layout panel: `visible`, `size`, and its own nested layout (§8.7).
#[derive(Debug, Clone)]
struct Panel {
    visible: bool,
    size: Size,
    layout: Box<LayoutTree>,
}

/// The owned layout tree. Every field is owned data; the type is `Send +
/// 'static` by construction (asserted below), so a built tree survives the
/// death of the `Lua` state that produced it and can cross threads.
#[derive(Debug, Clone)]
enum LayoutTree {
    Column(Vec<LayoutTree>),
    Row(Vec<LayoutTree>),
    Box {
        width: Option<Size>,
        height: Option<Size>,
        border: BorderStyle,
        child: Box<LayoutTree>,
    },
    Expanded(Box<LayoutTree>),
    Scrollable {
        // Direction is faithful to §8.7 but transparent to rect resolution
        // (scrolling is a viewport concern, not a layout-partition concern).
        #[allow(dead_code)]
        dir: ScrollDir,
        child: Box<LayoutTree>,
    },
    Overlay {
        anchor: Anchor,
        width: Size,
        max_height: Size,
        offset_x: i16,
        offset_y: i16,
        child: Box<LayoutTree>,
    },
    Spacer(Option<Size>),
    Tabs {
        active: usize,
        children: Vec<LayoutTree>,
    },
    Split {
        axis: Axis,
        ratio: f32,
        a: Box<LayoutTree>,
        b: Box<LayoutTree>,
    },
    /// Predefined border layout: center + N/E/S/W panels.
    Border {
        center: Box<LayoutTree>,
        north: Option<Panel>,
        east: Option<Panel>,
        south: Option<Panel>,
        west: Option<Panel>,
    },
    WidgetSlot(SlotId),
}

/// Compile-time evidence that the owned tree captures no `!Send` Lua handle.
/// If any variant held an `mlua::Function`/`Table`/`Value`, this would fail to
/// compile (mlua without the `send` feature is `!Send`).
const fn _assert_send<T: Send + 'static>() {}
const _: () = _assert_send::<LayoutTree>();

fn is_overlay(t: &LayoutTree) -> bool {
    matches!(t, LayoutTree::Overlay { .. })
}

// ===========================================================================
// (a) Lua `smith.tui.layout.*` API + call counter.
// ===========================================================================

/// Install `smith.tui.layout.*` builders. Every builder increments `counter`
/// when the Lua VM invokes it — so the counter is a faithful "Lua executed a
/// layout primitive" tally. The builders return plain descriptor tables
/// (`{ kind = ..., ... }`); no Rust layout type is exposed to Lua.
fn install_layout_api(lua: &Lua, counter: Arc<AtomicU64>) -> LuaResult<()> {
    let smith = lua.create_table()?;
    let tui = lua.create_table()?;
    let layout = lua.create_table()?;

    // Container/leaf builders that just tag the passed table with a `kind`.
    for kind in ["column", "row", "box", "expanded", "scrollable", "overlay", "tabs", "split", "border"] {
        let c = counter.clone();
        let f = lua.create_function(move |_, t: Table| {
            c.fetch_add(1, Ordering::Relaxed);
            t.set("kind", kind)?;
            Ok(t)
        })?;
        layout.set(kind, f)?;
    }

    // `slot(id)` -> { kind = "slot", id = id }
    {
        let c = counter.clone();
        let f = lua.create_function(move |lua, id: String| {
            c.fetch_add(1, Ordering::Relaxed);
            let t = lua.create_table()?;
            t.set("kind", "slot")?;
            t.set("id", id)?;
            Ok(t)
        })?;
        layout.set("slot", f)?;
    }

    // `spacer(size?)` -> { kind = "spacer", size = size? }
    {
        let c = counter.clone();
        let f = lua.create_function(move |lua, size: Value| {
            c.fetch_add(1, Ordering::Relaxed);
            let t = lua.create_table()?;
            t.set("kind", "spacer")?;
            if !matches!(size, Value::Nil) {
                t.set("size", size)?;
            }
            Ok(t)
        })?;
        layout.set("spacer", f)?;
    }

    tui.set("layout", layout)?;
    smith.set("tui", tui)?;
    lua.globals().set("smith", smith)?;
    Ok(())
}

/// Build a `LayoutTree` from a Lua script that returns a layout descriptor.
/// This is the ONE-TIME cost: the script runs, its primitives fire, we convert
/// the returned table into owned data, and the Lua `Value` is dropped here.
fn build_tree(lua: &Lua, script: &str) -> LuaResult<LayoutTree> {
    let root: Value = lua.load(script).set_name("layout").eval()?;
    let tree = convert(root)?;
    // `root` was moved into `convert`; nothing Lua-borrowed escapes.
    Ok(tree)
}

// ===========================================================================
// (b) One-time converter: Lua descriptor table -> owned LayoutTree.
// ===========================================================================

fn rt(msg: impl Into<String>) -> LuaError {
    LuaError::runtime(msg.into())
}

fn convert(v: Value) -> LuaResult<LayoutTree> {
    let t = match v {
        Value::Table(t) => t,
        other => return Err(rt(format!("layout node must be a table, got {}", other.type_name()))),
    };
    let kind: String = t
        .get::<Option<String>>("kind")?
        .ok_or_else(|| rt("layout node missing 'kind'"))?;

    match kind.as_str() {
        "column" => Ok(LayoutTree::Column(convert_children(&t)?)),
        "row" => Ok(LayoutTree::Row(convert_children(&t)?)),
        "box" => Ok(LayoutTree::Box {
            width: opt_size(&t, "width")?,
            height: opt_size(&t, "height")?,
            border: parse_border(t.get::<Option<String>>("border")?.as_deref())?,
            child: Box::new(convert(t.get::<Value>(1)?)?),
        }),
        "expanded" => Ok(LayoutTree::Expanded(Box::new(convert(t.get::<Value>(1)?)?))),
        "scrollable" => Ok(LayoutTree::Scrollable {
            dir: parse_scroll(t.get::<Option<String>>("dir")?.as_deref())?,
            child: Box::new(convert(t.get::<Value>(1)?)?),
        }),
        "overlay" => Ok(LayoutTree::Overlay {
            anchor: parse_anchor(t.get::<Option<String>>("anchor")?.as_deref())?,
            width: req_size(&t, "width")?,
            max_height: req_size(&t, "max_height")?,
            offset_x: t.get::<Option<i64>>("offset_x")?.unwrap_or(0) as i16,
            offset_y: t.get::<Option<i64>>("offset_y")?.unwrap_or(0) as i16,
            child: Box::new(convert(t.get::<Value>(1)?)?),
        }),
        "spacer" => Ok(LayoutTree::Spacer(opt_size(&t, "size")?)),
        "tabs" => {
            let active = t.get::<Option<i64>>("active")?.unwrap_or(0).max(0) as usize;
            Ok(LayoutTree::Tabs {
                active,
                children: convert_children(&t)?,
            })
        }
        "split" => Ok(LayoutTree::Split {
            axis: parse_axis(t.get::<Option<String>>("dir")?.as_deref())?,
            ratio: t.get::<Option<f64>>("ratio")?.unwrap_or(0.5) as f32,
            a: Box::new(convert(t.get::<Value>(1)?)?),
            b: Box::new(convert(t.get::<Value>(2)?)?),
        }),
        "border" => Ok(LayoutTree::Border {
            center: Box::new(convert(t.get::<Value>("center")?)?),
            north: opt_panel(&t, "north")?,
            east: opt_panel(&t, "east")?,
            south: opt_panel(&t, "south")?,
            west: opt_panel(&t, "west")?,
        }),
        "slot" => Ok(LayoutTree::WidgetSlot(SlotId(
            t.get::<Option<String>>("id")?
                .ok_or_else(|| rt("slot missing 'id'"))?,
        ))),
        other => Err(rt(format!("unknown layout kind: {other}"))),
    }
}

fn convert_children(t: &Table) -> LuaResult<Vec<LayoutTree>> {
    let n = t.raw_len();
    let mut out = Vec::with_capacity(n as usize);
    for i in 1..=n {
        out.push(convert(t.get::<Value>(i)?)?);
    }
    Ok(out)
}

fn parse_size_value(v: Value) -> LuaResult<Size> {
    match v {
        Value::Integer(n) => Ok(Size::Abs(n.max(0) as u16)),
        Value::Number(n) => Ok(Size::Abs(n.max(0.0) as u16)),
        Value::Table(t) => {
            if let Some(p) = t.get::<Option<i64>>("pct")? {
                Ok(Size::Pct(p.clamp(0, 100) as u16))
            } else if let Some(a) = t.get::<Option<i64>>("abs")? {
                Ok(Size::Abs(a.max(0) as u16))
            } else {
                Err(rt("size table needs `pct` or `abs`"))
            }
        }
        other => Err(rt(format!("bad size value: {}", other.type_name()))),
    }
}

fn opt_size(t: &Table, key: &str) -> LuaResult<Option<Size>> {
    match t.get::<Value>(key)? {
        Value::Nil => Ok(None),
        v => Ok(Some(parse_size_value(v)?)),
    }
}

fn req_size(t: &Table, key: &str) -> LuaResult<Size> {
    opt_size(t, key)?.ok_or_else(|| rt(format!("missing required size `{key}`")))
}

fn opt_panel(t: &Table, key: &str) -> LuaResult<Option<Panel>> {
    match t.get::<Value>(key)? {
        Value::Nil => Ok(None),
        Value::Table(p) => Ok(Some(Panel {
            visible: p.get::<Option<bool>>("visible")?.unwrap_or(true),
            size: req_size(&p, "size")?,
            layout: Box::new(convert(p.get::<Value>("layout")?)?),
        })),
        other => Err(rt(format!("panel `{key}` must be a table, got {}", other.type_name()))),
    }
}

fn parse_border(s: Option<&str>) -> LuaResult<BorderStyle> {
    Ok(match s {
        None | Some("none") => BorderStyle::None,
        Some("single") => BorderStyle::Single,
        Some("double") => BorderStyle::Double,
        Some("rounded") => BorderStyle::Rounded,
        Some("thick") => BorderStyle::Thick,
        Some(other) => return Err(rt(format!("unknown border style: {other}"))),
    })
}

fn parse_scroll(s: Option<&str>) -> LuaResult<ScrollDir> {
    Ok(match s {
        None | Some("vertical") => ScrollDir::Vertical,
        Some("horizontal") => ScrollDir::Horizontal,
        Some("both") => ScrollDir::Both,
        Some(other) => return Err(rt(format!("unknown scroll dir: {other}"))),
    })
}

fn parse_axis(s: Option<&str>) -> LuaResult<Axis> {
    Ok(match s {
        None | Some("horizontal") => Axis::Horizontal,
        Some("vertical") => Axis::Vertical,
        Some(other) => return Err(rt(format!("unknown split dir: {other}"))),
    })
}

fn parse_anchor(s: Option<&str>) -> LuaResult<Anchor> {
    let norm = s.unwrap_or("center").replace('_', "-");
    Ok(match norm.as_str() {
        "center" => Anchor::Center,
        "top-left" => Anchor::TopLeft,
        "top-center" | "top" => Anchor::TopCenter,
        "top-right" => Anchor::TopRight,
        "right-center" | "right" => Anchor::RightCenter,
        "bottom-right" => Anchor::BottomRight,
        "bottom-center" | "bottom" => Anchor::BottomCenter,
        "bottom-left" => Anchor::BottomLeft,
        "left-center" | "left" => Anchor::LeftCenter,
        other => return Err(rt(format!("unknown anchor: {other}"))),
    })
}

// ===========================================================================
// (c) Pure resolver: (owned tree, area) -> Rect per slot. ZERO Lua.
// ===========================================================================
//
// Column/Row/Split use ratatui `Layout`/`Constraint` (documented choice) so
// tiling and remainder distribution match production widget code. The border
// layout and overlay placement are hand-rolled (ratatui has no primitive for
// them). Overlays float over their container's area and do NOT consume flow
// space — see the spec note in the result block.

fn resolve(tree: &LayoutTree, area: Rect) -> Vec<(SlotId, Rect)> {
    let mut out = Vec::new();
    resolve_node(tree, area, &mut out);
    out
}

fn resolve_node(t: &LayoutTree, area: Rect, out: &mut Vec<(SlotId, Rect)>) {
    match t {
        LayoutTree::WidgetSlot(id) => out.push((id.clone(), area)),
        LayoutTree::Spacer(_) => {} // occupies space via parent constraint; no slot
        LayoutTree::Column(children) => resolve_flow(children, area, Direction::Vertical, out),
        LayoutTree::Row(children) => resolve_flow(children, area, Direction::Horizontal, out),
        LayoutTree::Expanded(child) => resolve_node(child, area, out),
        LayoutTree::Scrollable { child, .. } => resolve_node(child, area, out),
        LayoutTree::Box {
            width,
            height,
            border,
            child,
        } => {
            let w = width.map_or(area.width, |s| size_cells(s, area.width)).min(area.width);
            let h = height.map_or(area.height, |s| size_cells(s, area.height)).min(area.height);
            let box_rect = Rect { x: area.x, y: area.y, width: w, height: h };
            let inner = if *border == BorderStyle::None {
                box_rect
            } else {
                Rect {
                    x: box_rect.x.saturating_add(1),
                    y: box_rect.y.saturating_add(1),
                    width: box_rect.width.saturating_sub(2),
                    height: box_rect.height.saturating_sub(2),
                }
            };
            resolve_node(child, inner, out);
        }
        LayoutTree::Overlay {
            anchor,
            width,
            max_height,
            offset_x,
            offset_y,
            child,
        } => {
            let rect = overlay_rect(area, *anchor, *width, *max_height, *offset_x, *offset_y);
            resolve_node(child, rect, out);
        }
        LayoutTree::Tabs { active, children } => {
            // Reserve the top row for the tab bar; render the active child below.
            let content = Rect {
                x: area.x,
                y: area.y.saturating_add(1),
                width: area.width,
                height: area.height.saturating_sub(1),
            };
            if let Some(child) = children.get(*active) {
                resolve_node(child, content, out);
            }
        }
        LayoutTree::Split { axis, ratio, a, b } => {
            let (ra, rb) = split_rect(area, *axis, *ratio);
            resolve_node(a, ra, out);
            resolve_node(b, rb, out);
        }
        LayoutTree::Border {
            center,
            north,
            east,
            south,
            west,
        } => resolve_border(center, north, east, south, west, area, out),
    }
}

/// Column/Row via ratatui `Layout`. Flow children tile the axis; overlay
/// children float over the whole container area without consuming space.
fn resolve_flow(children: &[LayoutTree], area: Rect, dir: Direction, out: &mut Vec<(SlotId, Rect)>) {
    let vertical = matches!(dir, Direction::Vertical);
    let total = if vertical { area.height } else { area.width };

    let flow: Vec<&LayoutTree> = children.iter().filter(|c| !is_overlay(c)).collect();
    let floats: Vec<&LayoutTree> = children.iter().filter(|c| is_overlay(c)).collect();

    if !flow.is_empty() {
        let constraints: Vec<Constraint> = flow.iter().map(|c| axis_constraint(c, total, vertical)).collect();
        let rects = Layout::default().direction(dir).constraints(constraints).split(area);
        for (c, r) in flow.iter().zip(rects.iter()) {
            resolve_node(c, *r, out);
        }
    }
    for f in floats {
        resolve_node(f, area, out);
    }
}

/// Along-axis constraint for a flow child. Fixed for a box/spacer that names
/// its along-axis size; `Fill(1)` (flex) for `expanded`, unsized spacers, and
/// anything without an intrinsic along-axis size.
fn axis_constraint(child: &LayoutTree, total: u16, vertical: bool) -> Constraint {
    match child {
        LayoutTree::Box { width, height, .. } => {
            let s = if vertical { *height } else { *width };
            match s {
                Some(sz) => Constraint::Length(size_cells(sz, total)),
                None => Constraint::Fill(1),
            }
        }
        LayoutTree::Spacer(Some(sz)) => Constraint::Length(size_cells(*sz, total)),
        LayoutTree::Spacer(None) => Constraint::Fill(1),
        LayoutTree::Expanded(_) => Constraint::Fill(1),
        _ => Constraint::Fill(1),
    }
}

fn resolve_border(
    center: &LayoutTree,
    north: &Option<Panel>,
    east: &Option<Panel>,
    south: &Option<Panel>,
    west: &Option<Panel>,
    area: Rect,
    out: &mut Vec<(SlotId, Rect)>,
) {
    let mut mid = area;

    if let Some(p) = north.as_ref().filter(|p| p.visible) {
        let h = size_cells(p.size, area.height).min(mid.height);
        let r = Rect { x: mid.x, y: mid.y, width: mid.width, height: h };
        resolve_node(&p.layout, r, out);
        mid.y += h;
        mid.height -= h;
    }
    if let Some(p) = south.as_ref().filter(|p| p.visible) {
        let h = size_cells(p.size, area.height).min(mid.height);
        let r = Rect { x: mid.x, y: mid.y + (mid.height - h), width: mid.width, height: h };
        resolve_node(&p.layout, r, out);
        mid.height -= h;
    }
    if let Some(p) = west.as_ref().filter(|p| p.visible) {
        let w = size_cells(p.size, area.width).min(mid.width);
        let r = Rect { x: mid.x, y: mid.y, width: w, height: mid.height };
        resolve_node(&p.layout, r, out);
        mid.x += w;
        mid.width -= w;
    }
    if let Some(p) = east.as_ref().filter(|p| p.visible) {
        let w = size_cells(p.size, area.width).min(mid.width);
        let r = Rect { x: mid.x + (mid.width - w), y: mid.y, width: w, height: mid.height };
        resolve_node(&p.layout, r, out);
        mid.width -= w;
    }
    resolve_node(center, mid, out);
}

/// Hand-rolled split: honors `ratio` (± one cell of rounding) and tiles the
/// axis exactly (no gap, no overlap).
fn split_rect(area: Rect, axis: Axis, ratio: f32) -> (Rect, Rect) {
    let r = ratio.clamp(0.0, 1.0);
    match axis {
        Axis::Horizontal => {
            let wa = ((area.width as f32) * r).round().clamp(0.0, area.width as f32) as u16;
            let a = Rect { x: area.x, y: area.y, width: wa, height: area.height };
            let b = Rect { x: area.x + wa, y: area.y, width: area.width - wa, height: area.height };
            (a, b)
        }
        Axis::Vertical => {
            let ha = ((area.height as f32) * r).round().clamp(0.0, area.height as f32) as u16;
            let a = Rect { x: area.x, y: area.y, width: area.width, height: ha };
            let b = Rect { x: area.x, y: area.y + ha, width: area.width, height: area.height - ha };
            (a, b)
        }
    }
}

fn overlay_rect(area: Rect, anchor: Anchor, width: Size, max_height: Size, ox: i16, oy: i16) -> Rect {
    let w = size_cells(width, area.width).min(area.width);
    let h = size_cells(max_height, area.height).min(area.height);
    let (bx, by) = match anchor {
        Anchor::Center => (mid(area.width, w), mid(area.height, h)),
        Anchor::TopLeft => (0, 0),
        Anchor::TopCenter => (mid(area.width, w), 0),
        Anchor::TopRight => (area.width - w, 0),
        Anchor::RightCenter => (area.width - w, mid(area.height, h)),
        Anchor::BottomRight => (area.width - w, area.height - h),
        Anchor::BottomCenter => (mid(area.width, w), area.height - h),
        Anchor::BottomLeft => (0, area.height - h),
        Anchor::LeftCenter => (0, mid(area.height, h)),
    };
    // Apply offset, then clamp so the overlay stays fully inside `area`.
    let max_x = area.width.saturating_sub(w);
    let max_y = area.height.saturating_sub(h);
    let x = clamp_off(bx, ox, max_x);
    let y = clamp_off(by, oy, max_y);
    Rect { x: area.x + x, y: area.y + y, width: w, height: h }
}

fn mid(total: u16, part: u16) -> u16 {
    total.saturating_sub(part) / 2
}

fn clamp_off(base: u16, off: i16, max: u16) -> u16 {
    let v = base as i32 + off as i32;
    v.clamp(0, max as i32) as u16
}

fn size_cells(size: Size, total: u16) -> u16 {
    match size {
        Size::Abs(n) => n.min(total),
        Size::Pct(p) => ((total as u32 * p as u32) / 100) as u16,
    }
}

// ===========================================================================
// Realistic default layout script (§8.7 border layout).
// ===========================================================================

/// Root = a column whose sole flow child is an expanded border layout (fills
/// the screen), plus one floating command-palette overlay centered over the
/// whole terminal. The border's center is the status / messages / input / hint
/// stack; the west panel is a scrollable file tree.
const DEFAULT_LAYOUT: &str = r#"
local L = smith.tui.layout

local center = L.column{
  L.box{ L.slot("status-bar"), height = 1 },
  L.expanded{ L.slot("message-list") },
  L.box{ L.slot("input"), height = 3, border = "rounded" },
  L.box{ L.slot("hint-bar"), height = 1 },
}

local base = L.border{
  center = center,
  west = {
    visible = true,
    size = 24,
    layout = L.scrollable{ L.slot("file-tree"), dir = "vertical" },
  },
}

return L.column{
  L.expanded{ base },
  L.overlay{
    L.box{ L.slot("command-palette"), border = "double" },
    anchor = "center",
    width = { pct = 60 },
    max_height = { pct = 50 },
  },
}
"#;

/// A mutation: swap the center layout to a two-tab arrangement and hide the
/// west panel. Used by the invalidation scenario as `set_center_layout`.
const MUTATED_LAYOUT: &str = r#"
local L = smith.tui.layout
return L.border{
  center = L.column{
    L.box{ L.slot("status-bar"), height = 1 },
    L.split{
      L.expanded{ L.slot("message-list") },
      L.scrollable{ L.slot("detail-pane") },
      dir = "horizontal",
      ratio = 0.7,
    },
    L.box{ L.slot("input"), height = 3 },
  },
}
"#;

// ===========================================================================
// Scenario helpers.
// ===========================================================================

fn check(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        println!("PASS: {msg}");
        Ok(())
    } else {
        Err(format!("FAIL: {msg}"))
    }
}

fn us(d: Duration) -> f64 {
    d.as_secs_f64() * 1_000_000.0
}

fn build_mode() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

fn contains(parent: Rect, child: Rect) -> bool {
    child.width == 0
        || child.height == 0
        || (child.x >= parent.x
            && child.y >= parent.y
            && child.x + child.width <= parent.x + parent.width
            && child.y + child.height <= parent.y + parent.height)
}

fn intersects(a: Rect, b: Rect) -> bool {
    if a.width == 0 || a.height == 0 || b.width == 0 || b.height == 0 {
        return false;
    }
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// Render one resolved frame into a `TestBackend` to prove the Rects are usable
/// widget targets. Returns the filled buffer.
fn render_to_testbackend(slots: &[(SlotId, Rect)], w: u16, h: u16) -> Buffer {
    let backend = TestBackend::new(w, h);
    let mut term = Terminal::new(backend).expect("test backend");
    term.draw(|f| {
        for (slot, rect) in slots {
            if rect.width == 0 || rect.height == 0 {
                continue;
            }
            let block = Block::bordered().title(slot.0.clone());
            f.render_widget(Paragraph::new(slot.0.clone()).block(block), *rect);
        }
    })
    .expect("draw");
    term.backend().buffer().clone()
}

fn nonblank_cells(buf: &Buffer, w: u16, h: u16) -> usize {
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            if buf[(x, y)].symbol() != " " {
                n += 1;
            }
        }
    }
    n
}

// ===========================================================================
// Scenario: build-once
// ===========================================================================

fn build_once() -> Result<(), String> {
    let counter = Arc::new(AtomicU64::new(0));
    let lua = Lua::new();
    install_layout_api(&lua, counter.clone()).map_err(|e| e.to_string())?;

    check(counter.load(Ordering::Relaxed) == 0, "Lua-call counter starts at 0")?;

    let tree = build_tree(&lua, DEFAULT_LAYOUT).map_err(|e| e.to_string())?;
    let after_build = counter.load(Ordering::Relaxed);
    check(after_build > 0, &format!("building the tree fired {after_build} Lua primitive calls"))?;

    let area = Rect::new(0, 0, 120, 40);
    let slots = resolve(&tree, area);
    let ids: Vec<&str> = slots.iter().map(|(s, _)| s.0.as_str()).collect();
    check(
        ids.contains(&"status-bar")
            && ids.contains(&"message-list")
            && ids.contains(&"input")
            && ids.contains(&"hint-bar")
            && ids.contains(&"file-tree")
            && ids.contains(&"command-palette"),
        &format!("realistic tree resolves all six slots: {ids:?}"),
    )?;

    // Resolve many times; counter must not advance (zero Lua in the loop).
    let frozen = counter.load(Ordering::Relaxed);
    for _ in 0..5000 {
        let _ = resolve(&tree, area);
    }
    check(
        counter.load(Ordering::Relaxed) == frozen,
        &format!("counter frozen at {frozen} across 5000 resolves (zero Lua calls)"),
    )?;

    // Independence: drop the entire Lua state, MOVE the tree to another thread,
    // and resolve there. Compiles only because LayoutTree is Send + 'static;
    // proves the tree owns no Lua handle.
    drop(lua);
    let expected = slots.clone();
    let moved = tree; // move, no clone: the tree is fully owned
    let handle = std::thread::spawn(move || resolve(&moved, Rect::new(0, 0, 120, 40)));
    let after_drop = handle.join().map_err(|_| "resolve thread panicked".to_string())?;
    check(
        after_drop == expected,
        "identical Rects after dropping Lua and resolving on another thread (Send, no Lua handle)",
    )?;
    check(
        counter.load(Ordering::Relaxed) == frozen,
        "counter still frozen after Lua state dropped",
    )?;

    println!("build-once: {} slots, {after_build} build-time Lua calls, 0 resolve-time Lua calls", slots.len());
    Ok(())
}

// ===========================================================================
// Scenario: resolve-frame
// ===========================================================================

fn resolve_frame() -> Result<(), String> {
    let counter = Arc::new(AtomicU64::new(0));
    let lua = Lua::new();
    install_layout_api(&lua, counter.clone()).map_err(|e| e.to_string())?;
    let tree = build_tree(&lua, DEFAULT_LAYOUT).map_err(|e| e.to_string())?;

    const N: usize = 10_000;
    const CEIL_US: f64 = 2000.0; // 2ms frame budget (§13), asserted even in debug

    for &(w, h) in &[(80u16, 24u16), (200, 50), (400, 100)] {
        let area = Rect::new(0, 0, w, h);
        let before = counter.load(Ordering::Relaxed);

        // Warmup.
        for _ in 0..200 {
            let _ = resolve(&tree, area);
        }

        let mut times = Vec::with_capacity(N);
        for _ in 0..N {
            let t0 = Instant::now();
            let slots = resolve(&tree, area);
            times.push(t0.elapsed());
            std::hint::black_box(&slots);
        }
        times.sort();
        let median = us(times[N / 2]);
        let p99 = us(times[(N * 99) / 100]);
        let delta = counter.load(Ordering::Relaxed) - before;

        check(delta == 0, &format!("{w}x{h}: Lua-call delta over {N} resolves == 0"))?;
        check(
            p99 < CEIL_US,
            &format!(
                "{w}x{h}: median {median:.3}us / p99 {p99:.3}us per resolve (<< 2000us budget, {} build)",
                build_mode()
            ),
        )?;

        // Prove the Rects are usable: render one frame into a TestBackend.
        let slots = resolve(&tree, area);
        let buf = render_to_testbackend(&slots, w, h);
        let painted = nonblank_cells(&buf, w, h);
        check(
            painted > 0,
            &format!("{w}x{h}: rendered {} slots into TestBackend, {painted} non-blank cells", slots.len()),
        )?;
    }

    Ok(())
}

// ===========================================================================
// Scenario: properties
// ===========================================================================

fn properties() -> Result<(), String> {
    // ---- Fixed tree: tiling / non-overlap / expanded remainder ----
    let counter = Arc::new(AtomicU64::new(0));
    let lua = Lua::new();
    install_layout_api(&lua, counter.clone()).map_err(|e| e.to_string())?;
    let tree = build_tree(&lua, DEFAULT_LAYOUT).map_err(|e| e.to_string())?;

    let area = Rect::new(0, 0, 80, 24);
    let slots = resolve(&tree, area);
    let find = |id: &str| slots.iter().find(|(s, _)| s.0 == id).map(|(_, r)| *r).unwrap();

    let status = find("status-bar");
    let msgs = find("message-list");
    let input = find("input"); // inner rect of a rounded box (height 3 -> inner 1)
    let hint = find("hint-bar");
    let tree_rect = find("file-tree");

    // West panel is 24 wide; center starts at x=24.
    check(tree_rect.x == 0 && tree_rect.width == 24, "west file-tree panel is 24 cells wide at x=0")?;
    check(status.x == 24, "center column starts right of the 24-wide west panel")?;

    // Center column stacks status(1) / expanded(msgs) / input-box(3) / hint(1),
    // covering the full 24-row height with no overlap.
    check(status.y == 0 && status.height == 1, "status bar: y=0 h=1")?;
    check(hint.y == 23 && hint.height == 1, "hint bar pinned to last row (y=23 h=1)")?;
    // message-list gets exactly the remainder: 24 - 1(status) - 3(input box) - 1(hint) = 19.
    check(
        msgs.height == 24 - 1 - 3 - 1,
        &format!("expanded message-list takes exact remainder: {} == 19", msgs.height),
    )?;
    check(msgs.y == status.y + status.height, "message-list sits directly below status bar")?;
    // input is the INNER rect of the rounded box on the row band [20,23): inner y=21 h=1.
    check(input.y == 21 && input.height == 1, "input inner rect inside rounded box (y=21 h=1)")?;
    check(!intersects(status, msgs) && !intersects(msgs, hint), "center flow siblings do not overlap")?;

    // ---- Fixed tree: split honors ratio ----
    let split_tree = LayoutTree::Split {
        axis: Axis::Horizontal,
        ratio: 0.3,
        a: Box::new(LayoutTree::WidgetSlot(SlotId("a".into()))),
        b: Box::new(LayoutTree::WidgetSlot(SlotId("b".into()))),
    };
    let sa = Rect::new(0, 0, 100, 10);
    let sr = resolve(&split_tree, sa);
    let ra = sr.iter().find(|(s, _)| s.0 == "a").unwrap().1;
    let rb = sr.iter().find(|(s, _)| s.0 == "b").unwrap().1;
    check(ra.width == 30, &format!("split ratio 0.3 of 100 -> left width {} == 30", ra.width))?;
    check(ra.width + rb.width == 100 && rb.x == 30, "split tiles the axis exactly, no gap/overlap")?;

    // ---- LCG-seeded random trees: containment, non-overlap, determinism ----
    let sizes = [(80u16, 24u16), (137, 41), (200, 50)];
    let mut checked = 0usize;
    for seed in 0..64u64 {
        let mut rng = Lcg(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1));
        let mut next_id = 0u32;
        let rtree = gen_tree(&mut rng, 4, &mut next_id);
        for &(w, h) in &sizes {
            let area = Rect::new(0, 0, w, h);
            let r1 = resolve(&rtree, area);
            let r2 = resolve(&rtree, area);
            if r1 != r2 {
                return Err(format!("FAIL: non-deterministic resolve for seed {seed} at {w}x{h}"));
            }
            for (_, rect) in &r1 {
                if !contains(area, *rect) {
                    return Err(format!("FAIL: slot escapes root bounds (seed {seed}, {w}x{h}): {rect:?}"));
                }
            }
            // No overlays are generated, so all leaf slots must be pairwise disjoint.
            for i in 0..r1.len() {
                for j in (i + 1)..r1.len() {
                    if intersects(r1[i].1, r1[j].1) {
                        return Err(format!(
                            "FAIL: overlapping slots (seed {seed}, {w}x{h}): {:?} vs {:?}",
                            r1[i], r1[j]
                        ));
                    }
                }
            }
            checked += 1;
        }
    }
    check(
        checked == 64 * sizes.len(),
        &format!("{checked} (tree,size) pairs: children within parent, siblings disjoint, resolve deterministic"),
    )?;

    println!("properties: §17 property-test target = {{within-parent, siblings-tile-no-overlap, expanded=remainder, split-ratio±rounding, deterministic}}");
    Ok(())
}

/// Tiny LCG for reproducible random trees (no external rand dep).
struct Lcg(u64);
impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        ((self.next_u64() >> 33) as usize) % n
    }
}

/// Generate a partitioning tree (no overlays) so all leaf slots stay disjoint.
fn gen_tree(rng: &mut Lcg, depth: u32, next_id: &mut u32) -> LayoutTree {
    if depth == 0 || rng.below(3) == 0 {
        let id = *next_id;
        *next_id += 1;
        return LayoutTree::WidgetSlot(SlotId(format!("s{id}")));
    }
    match rng.below(5) {
        0 => {
            let k = 2 + rng.below(3);
            let children = (0..k)
                .map(|_| {
                    // Mix fixed boxes and expanded children.
                    if rng.below(2) == 0 {
                        LayoutTree::Box {
                            width: None,
                            height: Some(Size::Abs(1 + rng.below(4) as u16)),
                            border: BorderStyle::None,
                            child: Box::new(gen_tree(rng, depth - 1, next_id)),
                        }
                    } else {
                        LayoutTree::Expanded(Box::new(gen_tree(rng, depth - 1, next_id)))
                    }
                })
                .collect();
            LayoutTree::Column(children)
        }
        1 => {
            let k = 2 + rng.below(3);
            let children = (0..k).map(|_| LayoutTree::Expanded(Box::new(gen_tree(rng, depth - 1, next_id)))).collect();
            LayoutTree::Row(children)
        }
        2 => LayoutTree::Split {
            axis: if rng.below(2) == 0 { Axis::Horizontal } else { Axis::Vertical },
            ratio: (1 + rng.below(9)) as f32 / 10.0,
            a: Box::new(gen_tree(rng, depth - 1, next_id)),
            b: Box::new(gen_tree(rng, depth - 1, next_id)),
        },
        3 => LayoutTree::Box {
            width: None,
            height: None,
            border: if rng.below(2) == 0 { BorderStyle::Single } else { BorderStyle::None },
            child: Box::new(gen_tree(rng, depth - 1, next_id)),
        },
        _ => LayoutTree::Scrollable {
            dir: ScrollDir::Vertical,
            child: Box::new(gen_tree(rng, depth - 1, next_id)),
        },
    }
}

// ===========================================================================
// Scenario: invalidation
// ===========================================================================

fn invalidation() -> Result<(), String> {
    let counter = Arc::new(AtomicU64::new(0));
    let lua = Lua::new();
    install_layout_api(&lua, counter.clone()).map_err(|e| e.to_string())?;

    // Build A.
    let tree_a = build_tree(&lua, DEFAULT_LAYOUT).map_err(|e| e.to_string())?;
    let after_a = counter.load(Ordering::Relaxed);
    check(after_a > 0, &format!("build A fired {after_a} Lua calls"))?;

    let area = Rect::new(0, 0, 100, 30);
    let slots_a = resolve(&tree_a, area);

    // Many resolves against A: no Lua re-entry.
    for _ in 0..3000 {
        let _ = resolve(&tree_a, area);
    }
    check(
        counter.load(Ordering::Relaxed) == after_a,
        &format!("counter frozen at {after_a} across 3000 resolves of tree A"),
    )?;

    // Explicit mutation: set_center_layout -> a NEW build fires Lua again.
    let tree_b = build_tree(&lua, MUTATED_LAYOUT).map_err(|e| e.to_string())?;
    let after_b = counter.load(Ordering::Relaxed);
    check(after_b > after_a, &format!("mutation (set_center_layout) rebuilds: {after_a} -> {after_b} Lua calls"))?;

    let slots_b = resolve(&tree_b, area);
    let ids_a: Vec<&str> = slots_a.iter().map(|(s, _)| s.0.as_str()).collect();
    let ids_b: Vec<&str> = slots_b.iter().map(|(s, _)| s.0.as_str()).collect();
    check(
        ids_b.contains(&"detail-pane") && !ids_a.contains(&"detail-pane"),
        "new tree exposes the mutated slot set (detail-pane appears only after mutation)",
    )?;

    // Resolves of B: still zero Lua re-entry.
    for _ in 0..3000 {
        let _ = resolve(&tree_b, area);
    }
    check(
        counter.load(Ordering::Relaxed) == after_b,
        &format!("counter frozen at {after_b} across 3000 resolves of tree B"),
    )?;

    println!("invalidation: tree rebuilds ONLY on explicit mutation; between mutations 0 Lua calls per frame");
    Ok(())
}

// ===========================================================================
// main
// ===========================================================================

fn run(scenario: &str) -> Result<(), String> {
    match scenario {
        "build-once" => build_once(),
        "resolve-frame" => resolve_frame(),
        "properties" => properties(),
        "invalidation" => invalidation(),
        "all" => {
            println!("== build-once ==");
            build_once()?;
            println!("== resolve-frame ==");
            resolve_frame()?;
            println!("== properties ==");
            properties()?;
            println!("== invalidation ==");
            invalidation()?;
            Ok(())
        }
        other => Err(format!(
            "unknown scenario '{other}'; use build-once|resolve-frame|properties|invalidation|all"
        )),
    }
}

fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match run(&scenario) {
        Ok(()) => println!("PASS: p27 scenario '{scenario}' complete ({} build)", build_mode()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
