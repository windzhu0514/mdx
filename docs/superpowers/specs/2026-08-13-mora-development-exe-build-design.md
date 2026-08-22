# Mora 开发阶段 EXE 构建设计

## 目标

日常开发验证只生成 `src-tauri/target/release/mora.exe`，不生成 MSI 和 NSIS，缩短每次改动后的等待时间；正式发布能力保持不变。

## 方案

- 新增 `npm run build:exe`，执行 Tauri 官方命令 `tauri build --no-bundle`。
- 每次代码修改后的固定验证为 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml` 和 `npm run build:exe`。
- `npm run tauri -- build` 仅用于正式发布，继续生成 `mora.exe`、MSI 和 NSIS。
- README 同时说明两种命令，避免开发构建与发布打包混用。

## 边界

- 不修改 `tauri.conf.json` 的正式打包配置。
- 不删除 MSI 或 NSIS 能力。
- 不改写历史设计与实施计划中的验收记录。
- 不增加依赖、构建适配层或额外配置文件。

## 验收

- `npm run build:exe -- --help` 能将参数传给 Tauri，且 `build:exe` 明确包含 `--no-bundle`。
- `npm run build` 成功。
- `cargo check --manifest-path src-tauri/Cargo.toml` 成功。
- `npm run build:exe` 成功并生成 `src-tauri/target/release/mora.exe`。
- `git diff --check` 成功。

## 删减检查

唯一新增入口是 `build:exe`：它直接满足“开发阶段只生成 mora.exe”的验收项。删除后只能继续调用完整安装包构建。其余变更仅更新规则和使用说明，没有新增模块、接口或依赖。
