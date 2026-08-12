# Mora Window State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mora 在混合 DPI、多显示器环境中始终以完整可见的窗口启动，并记住关闭前的正常窗口位置和大小。

**Architecture:** 使用 Tauri 官方 `tauri-plugin-window-state` 只持久化位置，Mora 单独持久化 DPI 无关的逻辑客户区尺寸；应用显式恢复后，通过一个可独立测试的几何函数把窗口外框限制到最近显示器的工作区。Windows 使用 `GetMonitorInfoW` 排除任务栏，查询失败时回退到 Tauri 显示器完整范围。

**Tech Stack:** Rust、Tauri 2.11、tauri-plugin-window-state 2.4.1、windows 0.61.3、Cargo 单元测试。

## Global Constraints

- 插件只保存和恢复 `POSITION`；Mora 保存可见、未最小化、未最大化窗口的逻辑客户区尺寸，不保存全屏、装饰或可见性。
- 外框必须完整位于工作区内，任务栏和窗口边框必须计入。
- 保留位于负坐标副屏上的有效位置。
- 状态损坏、显示器移除或工作区查询失败不得阻止应用启动。
- 不修改编辑器布局、正文状态或 `.mdx` 文件格式。
- 主窗口恢复和工作区校正完成前保持隐藏，首次可见时即为最终外框。
- 保留工作树中已有的 `TODO.md`、`examples/` 和其他无关改动。

---

## File Map

- Create: `src-tauri/src/window_state.rs` — 矩形校正、Windows 工作区查询、状态恢复与窗口调整。
- Modify: `src-tauri/src/lib.rs` — 注册窗口状态插件并在应用启动时恢复、校正主窗口。
- Modify: `src-tauri/Cargo.toml` — 添加官方插件及 Windows API 依赖。
- Modify: `src-tauri/Cargo.lock` — Cargo 自动锁定依赖。
- Modify: `src-tauri/tauri.conf.json` — 主窗口初始隐藏，避免恢复阶段闪跳。

### Task 1: 可测试的工作区几何校正

**Files:**
- Create: `src-tauri/src/window_state.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: 物理像素窗口外框、客户区尺寸和显示器工作区。
- Produces: `fit_window_to_work_area(window: WindowGeometry, work_area: PhysicalRect) -> WindowAdjustment`。

- [ ] **Step 1: 先声明模块并写失败测试**

在 `src-tauri/src/lib.rs` 顶部添加：

```rust
mod window_state;
```

创建 `src-tauri/src/window_state.rs`，先只写测试所需类型和测试，暂不实现函数：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PhysicalRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowGeometry {
    x: i32,
    y: i32,
    outer_width: u32,
    outer_height: u32,
    inner_width: u32,
    inner_height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowAdjustment {
    x: i32,
    y: i32,
    inner_width: u32,
    inner_height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrinks_oversized_window_including_native_frame() {
        let adjustment = fit_window_to_work_area(
            WindowGeometry {
                x: -1685,
                y: 0,
                outer_width: 1568,
                outer_height: 1178,
                inner_width: 1560,
                inner_height: 1140,
            },
            PhysicalRect { x: -1920, y: 0, width: 1920, height: 1032 },
        );

        assert_eq!(adjustment.inner_width, 1560);
        assert_eq!(adjustment.inner_height, 994);
        assert_eq!(adjustment.x, -1685);
        assert_eq!(adjustment.y, 0);
    }

    #[test]
    fn moves_each_overflowing_edge_back_into_work_area() {
        let work = PhysicalRect { x: 100, y: 50, width: 1000, height: 700 };
        let left_top = fit_window_to_work_area(
            WindowGeometry { x: 0, y: 0, outer_width: 800, outer_height: 600, inner_width: 792, inner_height: 562 },
            work,
        );
        let right_bottom = fit_window_to_work_area(
            WindowGeometry { x: 500, y: 300, outer_width: 800, outer_height: 600, inner_width: 792, inner_height: 562 },
            work,
        );

        assert_eq!((left_top.x, left_top.y), (100, 50));
        assert_eq!((right_bottom.x, right_bottom.y), (300, 150));
    }

    #[test]
    fn preserves_valid_negative_monitor_bounds() {
        let geometry = WindowGeometry { x: -1700, y: 80, outer_width: 1000, outer_height: 700, inner_width: 992, inner_height: 662 };
        let adjustment = fit_window_to_work_area(
            geometry,
            PhysicalRect { x: -1920, y: 0, width: 1920, height: 1032 },
        );

        assert_eq!(adjustment, WindowAdjustment { x: -1700, y: 80, inner_width: 992, inner_height: 662 });
    }

    #[test]
    fn keeps_normal_window_unchanged() {
        let geometry = WindowGeometry { x: 200, y: 100, outer_width: 1048, outer_height: 798, inner_width: 1040, inner_height: 760 };
        let adjustment = fit_window_to_work_area(
            geometry,
            PhysicalRect { x: 0, y: 0, width: 1707, height: 1019 },
        );

        assert_eq!(adjustment, WindowAdjustment { x: 200, y: 100, inner_width: 1040, inner_height: 760 });
    }

    #[test]
    fn never_returns_zero_inner_size_for_tiny_work_area() {
        let adjustment = fit_window_to_work_area(
            WindowGeometry { x: 0, y: 0, outer_width: 100, outer_height: 100, inner_width: 60, inner_height: 50 },
            PhysicalRect { x: 0, y: 0, width: 20, height: 20 },
        );

        assert_eq!((adjustment.inner_width, adjustment.inner_height), (1, 1));
    }
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml window_state::tests --no-default-features
```

Expected: 编译失败，错误明确指出 `fit_window_to_work_area` 不存在。

- [ ] **Step 3: 实现最小几何函数**

在测试上方添加：

```rust
fn fit_window_to_work_area(
    window: WindowGeometry,
    work_area: PhysicalRect,
) -> WindowAdjustment {
    let frame_width = window.outer_width.saturating_sub(window.inner_width);
    let frame_height = window.outer_height.saturating_sub(window.inner_height);
    let outer_width = window.outer_width.min(work_area.width).max(1);
    let outer_height = window.outer_height.min(work_area.height).max(1);
    let inner_width = outer_width.saturating_sub(frame_width).max(1);
    let inner_height = outer_height.saturating_sub(frame_height).max(1);

    WindowAdjustment {
        x: clamp_axis(window.x, outer_width, work_area.x, work_area.width),
        y: clamp_axis(window.y, outer_height, work_area.y, work_area.height),
        inner_width,
        inner_height,
    }
}

fn clamp_axis(position: i32, size: u32, origin: i32, available: u32) -> i32 {
    let origin = i64::from(origin);
    let maximum = origin + i64::from(available) - i64::from(size);
    i64::from(position).clamp(origin, maximum.max(origin)) as i32
}
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml window_state::tests --no-default-features
```

Expected: 5 tests passed，0 failed。

### Task 2: 持久化状态并在启动时恢复、校正

**Files:**
- Modify: `src-tauri/src/window_state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Tauri 主窗口 `main`、官方插件缓存、Windows HWND。
- Produces: `tracked_state_flags() -> StateFlags` 和 `restore_and_fit_main_window(app: &tauri::App) -> tauri::Result<()>`。

- [ ] **Step 1: 添加状态范围失败测试**

在 `window_state.rs` 测试模块中添加：

```rust
#[test]
fn plugin_tracks_only_position_to_avoid_cross_dpi_size_restore() {
    let flags = tracked_state_flags();
    assert!(flags.contains(StateFlags::POSITION));
    assert!(!flags.intersects(
        StateFlags::SIZE
            | StateFlags::MAXIMIZED
            | StateFlags::VISIBLE
            | StateFlags::DECORATIONS
            | StateFlags::FULLSCREEN
    ));
}
```

- [ ] **Step 2: 运行并确认 RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml plugin_tracks_only_position_to_avoid_cross_dpi_size_restore
```

Expected: 编译失败，错误指出 `StateFlags` 或 `tracked_state_flags` 不存在。

- [ ] **Step 3: 添加锁定依赖**

在 `src-tauri/Cargo.toml` 添加：

```toml
tauri-plugin-window-state = "2.4.1"

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61.3", features = [
    "Win32_Foundation",
    "Win32_Graphics_Gdi",
] }
```

执行：

```powershell
cargo update --manifest-path src-tauri/Cargo.toml -p tauri-plugin-window-state --precise 2.4.1
```

- [ ] **Step 4: 实现状态范围、工作区读取与窗口应用**

在 `window_state.rs` 中添加以下生产逻辑；Windows 查询返回 `None` 时使用 `current_monitor()`：

```rust
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub fn tracked_state_flags() -> StateFlags {
    StateFlags::POSITION
}

pub fn restore_and_fit_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.restore_state(tracked_state_flags())?;
    fit_webview_window(&window)
}

fn fit_webview_window(window: &WebviewWindow) -> tauri::Result<()> {
    let outer_position = window.outer_position()?;
    let outer_size = window.outer_size()?;
    let inner_size = window.inner_size()?;
    let work_area = platform_work_area(window).or_else(|| {
        window.current_monitor().ok().flatten().map(|monitor| PhysicalRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
    });
    let Some(work_area) = work_area else {
        return Ok(());
    };

    let adjustment = fit_window_to_work_area(
        WindowGeometry {
            x: outer_position.x,
            y: outer_position.y,
            outer_width: outer_size.width,
            outer_height: outer_size.height,
            inner_width: inner_size.width,
            inner_height: inner_size.height,
        },
        work_area,
    );

    if (adjustment.inner_width, adjustment.inner_height)
        != (inner_size.width, inner_size.height)
    {
        window.set_size(PhysicalSize::new(
            adjustment.inner_width,
            adjustment.inner_height,
        ))?;
    }
    if (adjustment.x, adjustment.y) != (outer_position.x, outer_position.y) {
        window.set_position(PhysicalPosition::new(adjustment.x, adjustment.y))?;
    }
    Ok(())
}

#[cfg(windows)]
fn platform_work_area(window: &WebviewWindow) -> Option<PhysicalRect> {
    use std::mem::size_of;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let hwnd = window.hwnd().ok()?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_invalid() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }
    Some(PhysicalRect {
        x: info.rcWork.left,
        y: info.rcWork.top,
        width: info.rcWork.right.saturating_sub(info.rcWork.left) as u32,
        height: info.rcWork.bottom.saturating_sub(info.rcWork.top) as u32,
    })
}

#[cfg(not(windows))]
fn platform_work_area(_window: &WebviewWindow) -> Option<PhysicalRect> {
    None
}
```

- [ ] **Step 5: 注册插件并控制恢复顺序**

在 `src-tauri/src/lib.rs` 的 `run()` 中，创建一次 flags 并注册插件。主窗口必须 `skip_initial_state("main")`，随后在 `.setup(...)` 中显式恢复并校正：

```rust
pub fn run() {
    let window_state_flags = window_state::tracked_state_flags();
    tauri::Builder::default()
        .manage(AiRequestState::default())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            window_state::restore_and_fit_main_window(app)?;
            Ok(())
        })
        // 保留现有 invoke_handler 和 run 调用
```

- [ ] **Step 6: 运行定向测试并确认 GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml window_state::tests
```

Expected: 6 tests passed，0 failed。

### Task 3: 回归、格式与打包验证

**Files:**
- Verify only: `src-tauri/src/window_state.rs`
- Verify only: `src-tauri/src/lib.rs`
- Verify only: `src-tauri/Cargo.toml`
- Verify only: `src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Task 1–2 的完整实现。
- Produces: 可发布的 Mora Windows 构建及验证证据。

- [ ] **Step 1: 格式检查**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

Expected: 两条命令退出码均为 0。

- [ ] **Step 2: Rust 完整回归**

Run:

```powershell
$env:CARGO_INCREMENTAL='0'
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 所有测试通过，`cargo check` 退出码为 0。

- [ ] **Step 3: 前端构建**

Run:

```powershell
npm run build
```

Expected: Vue TypeScript 检查和 Vite 构建退出码为 0；允许报告既有 chunk-size 提示，但不得忽略错误。

- [ ] **Step 4: Tauri 打包**

关闭正在运行的 Mora 后执行一次：

```powershell
npm run tauri -- build
```

Expected: 退出码为 0，并生成或更新时间一致的：

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/bundle/msi/Mora_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Mora_0.1.0_x64-setup.exe
```

- [ ] **Step 5: 真实窗口验收**

启动新构建并验证：

1. 首次启动窗口完整位于当前屏工作区内，不遮挡任务栏。
2. 移动到副屏、调整大小、关闭后重新打开，恢复到该副屏相同正常位置和大小。
3. 在最大化状态关闭后重新打开，恢复最后一次正常窗口边界而不是超大窗口。
4. 临时移除保存位置所在显示器后启动，窗口回到有效屏幕且完整可见。

- [ ] **Step 6: 提交边界**

不自动提交。仅在用户明确要求提交时，暂存以下文件，不包含现有 `TODO.md`、`examples/` 或其他无关改动：

```text
docs/superpowers/specs/2026-08-11-mora-window-state-design.md
docs/superpowers/plans/2026-08-11-mora-window-state.md
src-tauri/src/window_state.rs
src-tauri/src/lib.rs
src-tauri/Cargo.toml
src-tauri/Cargo.lock
```
