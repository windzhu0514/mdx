use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};
use tauri_plugin_window_state::{StateFlags, WindowExt};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MinimumClientSize {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
struct PersistedLogicalSize {
    width: f64,
    height: f64,
}

const MAIN_WINDOW_MIN_INNER_WIDTH: u32 = 760;
const MAIN_WINDOW_MIN_INNER_HEIGHT: u32 = 520;
const MAIN_WINDOW_DEFAULT_LOGICAL_WIDTH: f64 = 1040.0;
const MAIN_WINDOW_DEFAULT_LOGICAL_HEIGHT: f64 = 760.0;
const MAIN_WINDOW_SIZE_FILENAME: &str = ".mora-window-size.json";

fn fit_window_to_work_area(window: WindowGeometry, work_area: PhysicalRect) -> WindowAdjustment {
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

fn relaxed_minimum_for_fit(
    window: WindowGeometry,
    work_area: PhysicalRect,
    adjustment: WindowAdjustment,
) -> Option<MinimumClientSize> {
    let frame_width = window.outer_width.saturating_sub(window.inner_width);
    let frame_height = window.outer_height.saturating_sub(window.inner_height);
    let width_fits = work_area.width >= MAIN_WINDOW_MIN_INNER_WIDTH.saturating_add(frame_width);
    let height_fits = work_area.height >= MAIN_WINDOW_MIN_INNER_HEIGHT.saturating_add(frame_height);

    (!width_fits || !height_fits).then_some(MinimumClientSize {
        width: if width_fits {
            MAIN_WINDOW_MIN_INNER_WIDTH
        } else {
            adjustment.inner_width
        },
        height: if height_fits {
            MAIN_WINDOW_MIN_INNER_HEIGHT
        } else {
            adjustment.inner_height
        },
    })
}

pub fn tracked_state_flags() -> StateFlags {
    StateFlags::POSITION
}

pub fn restore_main_window_state(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if let Err(error) = window.restore_state(tracked_state_flags()) {
        eprintln!("无法恢复主窗口状态：{error}");
    }

    let size_path = match app.path().app_config_dir() {
        Ok(path) => path.join(MAIN_WINDOW_SIZE_FILENAME),
        Err(error) => {
            eprintln!("无法定位窗口尺寸状态目录：{error}");
            return Ok(());
        }
    };
    let initial_size = load_logical_size(&size_path).unwrap_or(PersistedLogicalSize {
        width: MAIN_WINDOW_DEFAULT_LOGICAL_WIDTH,
        height: MAIN_WINDOW_DEFAULT_LOGICAL_HEIGHT,
    });
    if let Err(error) = window.set_size(LogicalSize::new(initial_size.width, initial_size.height)) {
        eprintln!("无法恢复主窗口尺寸：{error}");
    }

    let cached_size = Arc::new(Mutex::new(initial_size));
    let window_for_event = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(size)
            if window_for_event.is_visible().unwrap_or(false)
                && !window_for_event.is_maximized().unwrap_or(false)
                && !window_for_event.is_minimized().unwrap_or(false) =>
        {
            if let Ok(scale_factor) = window_for_event.scale_factor() {
                if let Some(logical_size) = logical_size_from_physical(*size, scale_factor) {
                    if let Ok(mut cached_size) = cached_size.lock() {
                        *cached_size = logical_size;
                    }
                }
            }
        }
        WindowEvent::CloseRequested { .. } => {
            if let Ok(cached_size) = cached_size.lock() {
                if let Err(error) = save_logical_size(&size_path, *cached_size) {
                    eprintln!("无法保存主窗口尺寸：{error}");
                }
            }
        }
        _ => {}
    });
    Ok(())
}

fn logical_size_from_physical(
    size: PhysicalSize<u32>,
    scale_factor: f64,
) -> Option<PersistedLogicalSize> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 || size.width == 0 || size.height == 0 {
        return None;
    }
    Some(PersistedLogicalSize {
        width: f64::from(size.width) / scale_factor,
        height: f64::from(size.height) / scale_factor,
    })
}

fn load_logical_size(path: &Path) -> Option<PersistedLogicalSize> {
    let state: PersistedLogicalSize = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (state.width.is_finite()
        && state.height.is_finite()
        && state.width >= 1.0
        && state.height >= 1.0)
        .then_some(state)
}

fn save_logical_size(path: &Path, state: PersistedLogicalSize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

pub fn fit_and_show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    if let Err(error) = fit_webview_window(&window) {
        eprintln!("无法校正主窗口位置和大小：{error}");
    }
    if let Err(error) = window.show() {
        eprintln!("无法显示主窗口：{error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("无法聚焦主窗口：{error}");
    }
    Ok(())
}

fn fit_webview_window(window: &WebviewWindow) -> tauri::Result<()> {
    let outer_position = window.outer_position()?;
    let outer_size = window.outer_size()?;
    let inner_size = window.inner_size()?;
    let work_area = platform_work_area(window).or_else(|| {
        window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| PhysicalRect {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            })
    });
    let Some(work_area) = work_area else {
        return Ok(());
    };

    let geometry = WindowGeometry {
        x: outer_position.x,
        y: outer_position.y,
        outer_width: outer_size.width,
        outer_height: outer_size.height,
        inner_width: inner_size.width,
        inner_height: inner_size.height,
    };
    let adjustment = fit_window_to_work_area(geometry, work_area);

    if let Some(minimum_size) = relaxed_minimum_for_fit(geometry, work_area, adjustment) {
        window.set_min_size(Some(PhysicalSize::new(
            minimum_size.width,
            minimum_size.height,
        )))?;
    }
    if (adjustment.inner_width, adjustment.inner_height) != (inner_size.width, inner_size.height) {
        window.set_size(PhysicalSize::new(
            adjustment.inner_width,
            adjustment.inner_height,
        ))?;
    }
    let actual_outer_position = window.outer_position()?;
    let actual_outer_size = window.outer_size()?;
    let adjusted_position = (
        clamp_axis(
            actual_outer_position.x,
            actual_outer_size.width,
            work_area.x,
            work_area.width,
        ),
        clamp_axis(
            actual_outer_position.y,
            actual_outer_size.height,
            work_area.y,
            work_area.height,
        ),
    );
    if adjusted_position != (actual_outer_position.x, actual_outer_position.y) {
        window.set_position(PhysicalPosition::new(
            adjusted_position.0,
            adjusted_position.1,
        ))?;
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
            PhysicalRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1032,
            },
        );

        assert_eq!(adjustment.inner_width, 1560);
        assert_eq!(adjustment.inner_height, 994);
        assert_eq!(adjustment.x, -1685);
        assert_eq!(adjustment.y, 0);
    }

    #[test]
    fn moves_each_overflowing_edge_back_into_work_area() {
        let work = PhysicalRect {
            x: 100,
            y: 50,
            width: 1000,
            height: 700,
        };
        let left_top = fit_window_to_work_area(
            WindowGeometry {
                x: 0,
                y: 0,
                outer_width: 800,
                outer_height: 600,
                inner_width: 792,
                inner_height: 562,
            },
            work,
        );
        let right_bottom = fit_window_to_work_area(
            WindowGeometry {
                x: 500,
                y: 300,
                outer_width: 800,
                outer_height: 600,
                inner_width: 792,
                inner_height: 562,
            },
            work,
        );

        assert_eq!((left_top.x, left_top.y), (100, 50));
        assert_eq!((right_bottom.x, right_bottom.y), (300, 150));
    }

    #[test]
    fn preserves_valid_negative_monitor_bounds() {
        let geometry = WindowGeometry {
            x: -1700,
            y: 80,
            outer_width: 1000,
            outer_height: 700,
            inner_width: 992,
            inner_height: 662,
        };
        let adjustment = fit_window_to_work_area(
            geometry,
            PhysicalRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1032,
            },
        );

        assert_eq!(
            adjustment,
            WindowAdjustment {
                x: -1700,
                y: 80,
                inner_width: 992,
                inner_height: 662
            }
        );
    }

    #[test]
    fn keeps_normal_window_unchanged() {
        let geometry = WindowGeometry {
            x: 200,
            y: 100,
            outer_width: 1048,
            outer_height: 798,
            inner_width: 1040,
            inner_height: 760,
        };
        let adjustment = fit_window_to_work_area(
            geometry,
            PhysicalRect {
                x: 0,
                y: 0,
                width: 1707,
                height: 1019,
            },
        );

        assert_eq!(
            adjustment,
            WindowAdjustment {
                x: 200,
                y: 100,
                inner_width: 1040,
                inner_height: 760
            }
        );
    }

    #[test]
    fn never_returns_zero_inner_size_for_tiny_work_area() {
        let adjustment = fit_window_to_work_area(
            WindowGeometry {
                x: 0,
                y: 0,
                outer_width: 100,
                outer_height: 100,
                inner_width: 60,
                inner_height: 50,
            },
            PhysicalRect {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
        );

        assert_eq!((adjustment.inner_width, adjustment.inner_height), (1, 1));
    }

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

    #[test]
    fn converts_physical_size_to_dpi_independent_logical_size() {
        assert_eq!(
            logical_size_from_physical(PhysicalSize::new(1560, 1140), 1.5),
            Some(PersistedLogicalSize {
                width: 1040.0,
                height: 760.0,
            })
        );
        assert_eq!(
            logical_size_from_physical(PhysicalSize::new(1560, 1140), 0.0),
            None
        );
    }

    #[test]
    fn main_window_starts_hidden_until_state_is_restored() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main_window = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();

        assert_eq!(main_window["visible"], false);
    }

    #[test]
    fn relaxes_only_the_minimum_dimension_that_cannot_fit() {
        let window = WindowGeometry {
            x: 0,
            y: 0,
            outer_width: 768,
            outer_height: 558,
            inner_width: 760,
            inner_height: 520,
        };
        let work_area = PhysicalRect {
            x: 0,
            y: 0,
            width: 700,
            height: 558,
        };
        let adjustment = fit_window_to_work_area(window, work_area);

        assert_eq!(
            relaxed_minimum_for_fit(window, work_area, adjustment),
            Some(MinimumClientSize {
                width: 692,
                height: 520,
            })
        );
    }

    #[test]
    fn retains_configured_minimum_when_work_area_fits_the_frame() {
        let window = WindowGeometry {
            x: 0,
            y: 0,
            outer_width: 900,
            outer_height: 700,
            inner_width: 892,
            inner_height: 662,
        };
        let work_area = PhysicalRect {
            x: 0,
            y: 0,
            width: 768,
            height: 558,
        };
        let adjustment = fit_window_to_work_area(window, work_area);

        assert_eq!(relaxed_minimum_for_fit(window, work_area, adjustment), None);
    }
}
