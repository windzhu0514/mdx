# Mora Agent 实时读写与 MCP 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Mora 增加默认关闭的本机 Agent 实时读写能力，并通过同一个 `mora-agent` 二进制提供 CLI 与 MCP stdio，同时可靠感知其他程序对已打开 `.mdx` 的修改。

**Architecture:** Vue 的 `useDocumentSession` 继续持有唯一权威正文，并增加不透明的 `liveRevision`；GUI Rust 进程通过当前用户专属的 Named Pipe/Unix Socket 将外部请求转成 Tauri 事件，再由前端会话执行读取、替换和保存。`mora-agent` 只包含共享协议、IPC 客户端、CLI 与 MCP 适配，文件监视器独立处理绕过 IPC 的磁盘修改。

**Tech Stack:** Tauri 2、Vue 3、TypeScript、Vitest、Rust 2021、Tokio 1.53、notify 8.2、clap 4.5、官方 rmcp 3.1.4、Windows Named Pipe、Unix Domain Socket

**Spec:** `docs/superpowers/specs/2026-08-28-mora-agent-integration-design.md`

## Global Constraints

- `useDocumentSession` 中的规范 Markdown 是唯一权威正文；不得增加 Agent 专用正文副本。
- Agent 写入只修改内存并标记脏状态；只有 `save` 命令或 `mora_save_document` 工具显式保存磁盘。
- Agent 接入设置键固定为 `agentAccessEnabled`，默认值固定为 `false`。
- 正常传输固定为 Windows Named Pipe 与 macOS/Linux Unix Domain Socket；不得增加 HTTP、TCP 或局域网监听。
- Windows Pipe ACL 仅授予当前用户和 SYSTEM；Unix socket 与发现文件权限固定为 `0600`，父目录固定为 `0700`。
- 日志、错误和状态事件不得包含正文、API 密钥或未经需要的完整文档路径。
- IPC 协议版本固定为 `1`，最大帧固定为 `16 MiB`，请求超时固定为 `10 s`，最大并发连接固定为 `8`。
- 写请求必须携带完全匹配的 `baseLiveRevision`；旧版本必须返回 `REVISION_CONFLICT`，不得自动覆盖或静默合并。
- CLI/MCP 首版只操作 Mora 当前打开文档，不增加离线 `.mdx` 编辑器。
- 新增的唯一控制台二进制固定命名为 Windows 的 `mora-agent.exe`、macOS/Linux 的 `mora-agent`；MCP 入口固定为 `mora-agent mcp`。
- MCP 仅使用 stdio；首版工具固定为 `mora_list_documents`、`mora_read_document`、`mora_replace_document`、`mora_save_document`。
- 直接磁盘变更：干净文档自动重载，脏文档只标记冲突；Mora 自身安全保存产生的事件必须抑制回声。
- `.mdx` 的 ZIP 格式、资源相对路径和 `.tmp` + `.bak` 安全保存流程保持不变。
- 保留工作区中用户已有的未提交修改；每次提交只暂存任务列出的文件。
- 实现使用当前依赖的官方公开 API：Tokio `ServerOptions::create_with_security_attributes_raw`、Tokio `UnixListener`、notify `recommended_watcher`/`PollWatcher`、rmcp `tool_router`/`transport::stdio`、Tauri 事件与 command。

---

## File Map

### Shared Rust core

- Create `src-tauri/src/agent_protocol.rs`: wire types, stable errors, frame codec and protocol limits.
- Create `src-tauri/src/agent_ipc/mod.rs`: endpoint discovery, server accept loop and connection limit.
- Create `src-tauri/src/agent_ipc/windows.rs`: owner-only Named Pipe creation and client connection.
- Create `src-tauri/src/agent_ipc/unix.rs`: owner-only Unix socket creation, stale cleanup and client connection.
- Create `src-tauri/src/agent_client.rs`: typed request client shared by CLI and MCP.
- Create `src-tauri/src/agent_bridge.rs`: Tauri bridge lifecycle, pending frontend requests and watch broadcasts.
- Create `src-tauri/src/agent_cli.rs`: clap command model, JSON/JSONL output and exit-code mapping.
- Create `src-tauri/src/agent_mcp.rs`: four rmcp tools backed by `AgentClient`.
- Create `src-tauri/src/file_watch.rs`: parent-directory watcher, stability retry, polling fallback and internal-write echo suppression.
- Create `src-tauri/src/bin/mora-agent.rs`: console entry point only.
- Modify `src-tauri/src/lib.rs`: register modules, managed states and Tauri commands; wrap existing save commands with echo suppression.
- Modify `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: binary target and exact dependencies/features.

### Frontend

- Create `src/types/agent.ts`: TypeScript mirror of frontend request/result/status/event contracts.
- Modify `src/composables/useDocumentSession.ts`: `liveRevision`, guarded replacement and path-filtered disk refresh.
- Create `src/composables/useAgentBridge.ts`: Tauri request handler, access lifecycle and coalesced version publication.
- Create `src/composables/useExternalFileSync.ts`: watched-path registration and external-change handling.
- Modify `src/composables/usePreferences.ts`: persisted default-off setting.
- Modify `src/components/SettingsPanel.vue`: dedicated “Agent” category, warning, status and MCP config copy action.
- Modify `src/App.vue`: compose the bridge, settings, save guard and external file sync.
- Modify `src/experience.css`: settings status and warning styles using existing theme variables.

### Tests, packaging and docs

- Create `src-tauri/tests/agent_protocol.rs`, `agent_ipc.rs`, `agent_cli.rs`, `agent_mcp.rs`, `file_watch.rs`.
- Create `src/composables/useAgentBridge.test.ts` and `useExternalFileSync.test.ts`.
- Modify `src/composables/useDocumentSession.test.ts`, `usePreferences.test.ts`, `src/components/SettingsPanel.test.ts`, `src/releaseWorkflow.test.ts`.
- Create `scripts/prepare-agent-sidecar.mjs` and `scripts/prepare-agent-sidecar.test.mjs`.
- Modify `package.json`, `.gitignore`, `src-tauri/tauri.conf.json`, `.github/workflows/publish.yml`, `README.md` and `docs/RELEASE.md`.

---

### Task 1: Shared protocol and live document revision

**Files:**

- Create: `src-tauri/src/agent_protocol.rs`
- Create: `src-tauri/tests/agent_protocol.rs`
- Create: `src/types/agent.ts`
- Modify: `src-tauri/src/lib.rs:1-16`
- Modify: `src/composables/useDocumentSession.ts:29-47,164-239,452-468,876-958,1061-1091`
- Modify: `src/composables/useDocumentSession.test.ts`

**Interfaces:**

- Produces Rust constants `PROTOCOL_VERSION`, `MAX_FRAME_BYTES`, `REQUEST_TIMEOUT`, `MAX_CONNECTIONS`.
- Produces `AgentRequest`, `AgentRequestKind`, `AgentResponse`, `AgentResult`, `AgentServerMessage`, `AgentError`, `AgentDocumentSummary`, `AgentDocumentSnapshot`, `AgentMutationResult`, `AgentDocumentEvent`.
- Produces TypeScript mirrors `AgentFrontendRequest`, `AgentFrontendResponse`, `AgentBridgeStatus`, `AgentDocumentSummary`, `AgentDocumentSnapshot`, `AgentMutationResult`, `AgentDocumentEvent`.
- Extends `OpenDocument` with `liveRevision: string` and `changeSource: "editor" | "agent" | "disk"`.
- Produces session methods `replaceContent(id, markdown, baseLiveRevision)` and `assertLiveRevision(id, baseLiveRevision)`.

- [ ] **Step 1: Write failing Rust serialization and frame tests**

Create tests that lock the field casing, method tags, frame limit and error shape:

```rust
use mdxnote_lib::agent_protocol::{
    decode_frame, encode_frame, AgentError, AgentRequest, AgentRequestKind,
    MAX_FRAME_BYTES, PROTOCOL_VERSION,
};

#[test]
fn replace_request_uses_versioned_camel_case_wire_shape() {
    let request = AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: "req-1".into(),
        request: AgentRequestKind::ReplaceDocument {
            document_id: "doc-1".into(),
            base_live_revision: "session:4".into(),
            content: "# changed\n".into(),
        },
    };
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["requestId"], "req-1");
    assert_eq!(value["method"], "replaceDocument");
    assert_eq!(value["params"]["baseLiveRevision"], "session:4");
}

#[test]
fn frame_codec_round_trips_and_rejects_oversized_payloads() {
    let bytes = encode_frame(br#"{"ok":true}"#).unwrap();
    assert_eq!(decode_frame(&bytes).unwrap(), br#"{"ok":true}"#);
    assert_eq!(
        encode_frame(&vec![0; MAX_FRAME_BYTES + 1]).unwrap_err().code,
        "REQUEST_TOO_LARGE"
    );
}

#[test]
fn stable_error_never_serializes_document_content() {
    let error = AgentError::new("REVISION_CONFLICT", "文档已变化")
        .with_detail(serde_json::json!({ "currentLiveRevision": "session:5" }));
    let text = serde_json::to_string(&error).unwrap();
    assert!(text.contains("REVISION_CONFLICT"));
    assert!(!text.contains("content"));
}
```

- [ ] **Step 2: Run Rust tests to verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test agent_protocol`

Expected: FAIL because `agent_protocol` and its public types do not exist.

- [ ] **Step 3: Define exact protocol types and frame codec**

Implement the following public surface, using `#[serde(rename_all = "camelCase")]` and `#[serde(tag = "method", content = "params", rename_all = "camelCase")]`:

```rust
pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_CONNECTIONS: usize = 8;

pub struct AgentRequest {
    pub protocol_version: u16,
    pub request_id: String,
    #[serde(flatten)]
    pub request: AgentRequestKind,
}

pub enum AgentRequestKind {
    Status,
    ListDocuments,
    ReadDocument { document_id: String },
    ReplaceDocument {
        document_id: String,
        base_live_revision: String,
        content: String,
    },
    SaveDocument {
        document_id: String,
        base_live_revision: String,
    },
    Watch { document_id: Option<String> },
}

pub struct AgentError {
    pub code: String,
    pub message: String,
    pub detail: Option<serde_json::Value>,
}

pub struct AgentBridgeStatus {
    pub enabled: bool,
    pub listening: bool,
    pub connected_clients: usize,
    pub watcher_clients: usize,
    pub cli_path: Option<String>,
    pub protocol_version: u16,
    pub last_error: Option<String>,
}

pub struct AgentDocumentEvent {
    pub document_id: String,
    pub live_revision: String,
    pub dirty: bool,
    pub source: AgentChangeSource,
}
```

Expose stable code constants for exactly this first-version set so Rust, CLI and frontend mapping do not duplicate string literals:

```text
AGENT_ACCESS_DISABLED
MORA_NOT_RUNNING
BRIDGE_UNAVAILABLE
BRIDGE_ALREADY_RUNNING
DOCUMENT_NOT_FOUND
DOCUMENT_NOT_OPEN
DOCUMENT_BUSY
SAVE_AS_REQUIRED
REVISION_CONFLICT
DISK_CONFLICT
INVALID_MDX
REQUEST_TOO_LARGE
PERMISSION_DENIED
TIMEOUT
PROTOCOL_MISMATCH
```

Encode frames as a four-byte big-endian payload length followed by UTF-8 JSON. Reject a declared or actual body larger than `MAX_FRAME_BYTES` before allocation. `AgentServerMessage` must be an internally tagged enum with `type: "response" | "event"`.

- [ ] **Step 4: Write failing frontend revision tests**

Add tests proving revisions are opaque, change on real edits/reloads, remain stable for no-op edits and reject stale writes:

```ts
it("guards agent replacement with the current live revision", () => {
    const session = useDocumentSession(false);
    const runtime = session.newDocument();
    const base = runtime.liveRevision;

    session.replaceContent(runtime.id, "agent text", base);

    expect(runtime.content).toBe("agent text");
    expect(runtime.dirty).toBe(true);
    expect(runtime.liveRevision).not.toBe(base);
    expect(() => session.replaceContent(runtime.id, "stale", base)).toThrowError(
        expect.objectContaining({ code: "REVISION_CONFLICT" }),
    );
});

it("does not advance the revision for a canonical no-op", () => {
    const session = useDocumentSession(false);
    const runtime = session.newDocument();
    const base = runtime.liveRevision;
    session.updateContent(runtime.id, runtime.content);
    expect(runtime.liveRevision).toBe(base);
});
```

- [ ] **Step 5: Run frontend tests to verify RED**

Run: `npx vitest run src/composables/useDocumentSession.test.ts`

Expected: FAIL because `liveRevision` and `replaceContent` do not exist.

- [ ] **Step 6: Add the session revision clock and guarded replacement**

Inside `useDocumentSession`, create one session UUID and one monotonic counter:

```ts
const liveSessionId = globalThis.crypto.randomUUID();
let nextLiveRevision = 0;

function issueLiveRevision() {
    nextLiveRevision += 1;
    return `${liveSessionId}:${nextLiveRevision}`;
}

function touchLiveRevision(runtime: SessionDocument) {
    runtime.liveRevision = issueLiveRevision();
}
```

Assign an initial revision in `sessionDocument`, default `updateContent` to source `"editor"`, call `touchLiveRevision` after actual canonical content changes and successful disk reloads, and implement:

```ts
function assertLiveRevision(id: string, baseLiveRevision: string) {
    const runtime = document(id);
    if (runtime.liveRevision !== baseLiveRevision) {
        throw {
            code: "REVISION_CONFLICT",
            documentId: id,
            currentLiveRevision: runtime.liveRevision,
        };
    }
    return runtime;
}

function replaceContent(id: string, markdown: string, baseLiveRevision: string) {
    const runtime = assertLiveRevision(id, baseLiveRevision);
    updateContent(id, markdown, "agent");
    return runtime;
}
```

Set `changeSource = "disk"` on successful reload. Extend `refreshDiskState(paths?: readonly string[])` so an omitted argument keeps the existing full refresh while a supplied list compares normalized path keys and checks only matching open documents.

- [ ] **Step 7: Add TypeScript protocol mirrors**

Create `src/types/agent.ts` with exact method unions and results. The core document shapes must be:

```ts
export type AgentDocumentSummary = {
    id: string;
    path: string | null;
    title: string;
    dirty: boolean;
    conflict: boolean;
    unavailable: boolean;
    liveRevision: string;
    diskRevision: DiskRevision | null;
};

export type AgentDocumentSnapshot = AgentDocumentSummary & {
    content: string;
    meta: MdxMetadata | null;
};

export type AgentMutationResult = AgentDocumentSummary;

export type AgentBridgeStatus = {
    enabled: boolean;
    listening: boolean;
    connectedClients: number;
    watcherClients: number;
    cliPath: string | null;
    protocolVersion: 1;
    lastError: string | null;
};
```

Use only the four frontend methods `listDocuments`, `readDocument`, `replaceDocument`, `saveDocument`; Rust handles `status` and `watch` without forwarding them to Vue.

- [ ] **Step 8: Run Task 1 tests GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test agent_protocol
npx vitest run src/composables/useDocumentSession.test.ts
```

Expected: PASS; existing save-race and disk-conflict tests remain green.

- [ ] **Step 9: Commit Task 1**

```powershell
git add src-tauri/src/agent_protocol.rs src-tauri/tests/agent_protocol.rs src-tauri/src/lib.rs src/types/agent.ts src/composables/useDocumentSession.ts src/composables/useDocumentSession.test.ts
git commit -m "feat(agent): 增加实时会话版本协议"
```

---

### Task 2: Secure cross-platform IPC and shared client

**Files:**

- Create: `src-tauri/src/agent_ipc/mod.rs`
- Create: `src-tauri/src/agent_ipc/windows.rs`
- Create: `src-tauri/src/agent_ipc/unix.rs`
- Create: `src-tauri/src/agent_client.rs`
- Create: `src-tauri/tests/agent_ipc.rs`
- Modify: `src-tauri/src/lib.rs:1-20`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**

- Consumes: Task 1 `AgentRequest`, `AgentServerMessage`, frame codec and limits.
- Produces `AgentEndpointDescriptor`, `EndpointRegistry`, `AgentServer`, `AgentClient`.
- Produces `AgentClient::request(AgentRequestKind) -> Result<AgentResult, AgentError>` and `AgentClient::watch(Option<String>) -> Result<AgentEventStream, AgentError>`.

- [ ] **Step 1: Add exact dependencies and Tokio features**

Change dependency declarations to include:

```toml
tokio = { version = "1.53.1", features = ["macros", "sync", "rt-multi-thread", "net", "io-util", "io-std", "time"] }
thiserror = "2"
```

Extend Windows features with:

```toml
"Win32_Security",
"Win32_Security_Authorization",
"Win32_System_Memory",
"Win32_System_Pipes",
"Win32_System_Threading",
```

Run the focused Cargo test/check commands below to converge `Cargo.lock`; do not run a broad `cargo update`.

- [ ] **Step 2: Write failing endpoint, permission and round-trip tests**

The integration test must define a local `IpcFixture` backed by `tempfile::TempDir`, construct `EndpointRegistry::at(temp.path().join("agent-endpoint-v1.json"))`, and use the real platform transport:

```rust
#[tokio::test]
async fn client_round_trips_over_current_platform_transport() {
    let fixture = IpcFixture::new().await;
    let server = fixture.start(|request| async move {
        assert_eq!(request.protocol_version, PROTOCOL_VERSION);
        AgentResult::Status(AgentBridgeStatus::listening_for_test())
    }).await;
    let client = AgentClient::connect_to(server.descriptor()).await.unwrap();
    let result = client.request(AgentRequestKind::Status).await.unwrap();
    assert!(matches!(result, AgentResult::Status(_)));
}

#[cfg(unix)]
#[tokio::test]
async fn unix_endpoint_and_registry_are_owner_only() {
    let fixture = IpcFixture::new().await;
    let server = fixture.start(ok_handler()).await;
    assert_eq!(mode(server.descriptor().registry_path()), 0o600);
    assert_eq!(mode(server.descriptor().socket_path()), 0o600);
}
```

Add Windows unit coverage for the generated SDDL string and an integration assertion that a Named Pipe descriptor uses `\\.\pipe\mora-agent-<session-id>`.

Add an ignored `five_mib_round_trip_profile` test that requires a release build, performs one warm-up plus 20 sequential 5 MiB request/response round trips, and prints sorted sample durations plus `p95_ms`; it records performance without creating a flaky CI assertion.

- [ ] **Step 3: Run IPC tests to verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test agent_ipc`

Expected: FAIL because endpoint registry, server and client do not exist.

- [ ] **Step 4: Implement endpoint discovery and cleanup**

Use this descriptor surface:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEndpointDescriptor {
    pub protocol_version: u16,
    pub session_id: String,
    pub pid: u32,
    pub transport: AgentTransport,
    pub address: String,
}

pub enum AgentTransport {
    NamedPipe,
    UnixSocket,
}
```

`EndpointRegistry::publish` must write a sibling temporary file, apply owner-only permissions, atomically rename it to `agent-endpoint-v1.json`, and remove it only if its `sessionId` still matches the stopping server. A live existing PID/endpoint must return `BRIDGE_ALREADY_RUNNING`; a stale registry/socket must be removed before binding.

- [ ] **Step 5: Implement owner-only platform transports**

Windows implementation requirements:

```rust
pub fn owner_only_pipe_security() -> Result<OwnedSecurityAttributes, AgentError>;
pub async fn bind(descriptor: &AgentEndpointDescriptor) -> Result<PlatformListener, AgentError>;
pub async fn connect(descriptor: &AgentEndpointDescriptor) -> Result<PlatformStream, AgentError>;
```

Resolve the current process token SID, build protected SDDL with `format!("D:P(A;;GA;;;SY)(A;;GA;;;{})", current_sid)`, convert it with `ConvertStringSecurityDescriptorToSecurityDescriptorW`, retain the descriptor with RAII, set `reject_remote_clients(true)`, and call Tokio `ServerOptions::create_with_security_attributes_raw`.

Unix implementation requirements:

```rust
pub async fn bind(descriptor: &AgentEndpointDescriptor) -> Result<UnixListener, AgentError>;
pub async fn connect(descriptor: &AgentEndpointDescriptor) -> Result<UnixStream, AgentError>;
```

Create the parent directory as `0700`, bind with `UnixListener::bind`, then set the socket to `0600`. Never follow a pre-existing symlink when removing a stale endpoint.

- [ ] **Step 6: Implement bounded server and typed client**

`AgentServer` must acquire a Tokio semaphore permit before accepting a connection, use the Task 1 frame codec, reject protocol versions other than `1`, apply `tokio::time::timeout(REQUEST_TIMEOUT, read_request(&mut stream))`, and never log request bodies.

`AgentClient::connect()` reads the registry and maps missing/stale discovery to `MORA_NOT_RUNNING`; `request` creates a UUID request ID and requires the response ID to match. `watch` sends one watch request, consumes the acknowledgement, and then exposes only `AgentServerMessage::Event` values.

- [ ] **Step 7: Run Task 2 tests GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test agent_protocol
cargo test --manifest-path src-tauri/Cargo.toml --test agent_ipc
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS on the current OS; platform-specific modules compile only under their matching `cfg`.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/agent_ipc src-tauri/src/agent_client.rs src-tauri/tests/agent_ipc.rs
git commit -m "feat(agent): 增加安全本地 IPC"
```

---

### Task 3: Tauri bridge, default-off preference and settings UX

**Files:**

- Create: `src-tauri/src/agent_bridge.rs`
- Create: `src/composables/useAgentBridge.ts`
- Create: `src/composables/useAgentBridge.test.ts`
- Modify: `src-tauri/src/lib.rs:1108-1172`
- Modify: `src/composables/usePreferences.ts:257-343,372-419`
- Modify: `src/composables/usePreferences.test.ts`
- Modify: `src/components/SettingsPanel.vue:20-112,139-410`
- Modify: `src/components/SettingsPanel.test.ts`
- Modify: `src/App.vue:1-55,96-220,1017-1103,1621-1644,2883-2893`
- Modify: `src/experience.css`

**Interfaces:**

- Consumes: Task 1 session revision methods and Task 2 `AgentServer`.
- Produces Tauri commands `set_agent_access_enabled`, `get_agent_bridge_status`, `complete_agent_request`, `publish_agent_document_events`.
- Produces `useAgentBridge(options)` with `status`, `dispose()` and automatic enable/disable watching.
- Extends settings props with `agentStatus: AgentBridgeStatus` and emits `copy-agent-config`.

- [ ] **Step 1: Write failing preference and settings tests**

Add assertions for default-off persistence and a fourth category:

```ts
expect(DEFAULT_PREFERENCES.agentAccessEnabled).toBe(false);
expect(normalizePreferences({ agentAccessEnabled: "yes" }).agentAccessEnabled).toBe(false);
expect(normalizePreferences({ agentAccessEnabled: true }).agentAccessEnabled).toBe(true);
```

In `SettingsPanel.test.ts`, pass a disabled `AgentBridgeStatus`, click “Agent”, and assert:

```ts
expect(navLabels).toEqual(["外观", "编辑器", "AI", "Agent"]);
expect(host.textContent).toContain("默认关闭");
expect(host.textContent).toContain("未保存内容");

const toggle = host.querySelector<HTMLInputElement>('[aria-label="本地 Agent 接入"]')!;
toggle.checked = true;
toggle.dispatchEvent(new Event("change", { bubbles: true }));
expect(update).toHaveBeenCalledWith({ agentAccessEnabled: true });
```

- [ ] **Step 2: Write failing bridge adapter tests**

Mock `@tauri-apps/api/event` and `invoke`, capture the `mora://agent-request` listener, then prove live reads, guarded replaces, saves and disable cleanup:

```ts
await requestListener({
    payload: {
        requestId: "req-1",
        method: "readDocument",
        params: { documentId: runtime.id },
    },
});
expect(invoke).toHaveBeenCalledWith(
    "complete_agent_request",
    expect.objectContaining({
        response: expect.objectContaining({
            requestId: "req-1",
            result: expect.objectContaining({ content: "unsaved" }),
        }),
    }),
);
```

Also assert `replaceDocument` returns `REVISION_CONFLICT` for a stale revision and `saveDocument` maps `EXTERNAL_CONFLICT` to `DISK_CONFLICT` without opening the UI conflict dialog.

- [ ] **Step 3: Run frontend tests to verify RED**

Run:

```powershell
npx vitest run src/composables/usePreferences.test.ts src/components/SettingsPanel.test.ts src/composables/useAgentBridge.test.ts
```

Expected: FAIL because the setting, category and bridge composable do not exist.

- [ ] **Step 4: Implement the Rust bridge state**

Use a cloneable managed state with one runtime and pending response map:

```rust
#[derive(Clone)]
pub struct AgentBridgeState {
    inner: Arc<AgentBridgeInner>,
}

struct AgentBridgeInner {
    runtime: Mutex<Option<BridgeRuntime>>,
    pending: Mutex<HashMap<String, oneshot::Sender<AgentFrontendResponse>>>,
    write_gate: tokio::sync::Mutex<()>,
    events: broadcast::Sender<AgentDocumentEvent>,
    status: RwLock<AgentBridgeStatus>,
}
```

`AgentBridgeState::start(app)` publishes the endpoint only after the listener is bound. `stop()` cancels the listener, fails every pending request with `AGENT_ACCESS_DISABLED`, removes only its own registry/socket and disconnects clients. `dispatch_frontend` emits `mora://agent-request`, waits at most 10 seconds, and removes the pending sender on every exit path.

`BridgeRuntime::drop` must synchronously cancel accept tasks and remove only its matching discovery record, so abnormal renderer teardown or normal application exit does not leave a usable endpoint. Resolve `cliPath` by checking the installed current-executable sibling first, then the Tauri resource directory, and include it only when the exact `mora-agent` file exists.

Handle `status` directly from `status`; handle `watch` by subscribing the connection to `events`; forward only list/read/replace/save to Vue. Hold `write_gate` across each forwarded replace/save request, while list/read remain concurrent. Add a bridge unit test issuing two replaces with the same base revision and assert exactly one succeeds. Emit `mora://agent-status` whenever enabled/listening/client counts change.

Register managed state and commands in `run()`:

```rust
.manage(agent_bridge::AgentBridgeState::default())
.invoke_handler(tauri::generate_handler![
    agent_bridge::set_agent_access_enabled,
    agent_bridge::get_agent_bridge_status,
    agent_bridge::complete_agent_request,
    agent_bridge::publish_agent_document_events,
])
```

Merge these names into the existing handler list rather than creating a second Tauri builder.

- [ ] **Step 5: Implement frontend request handling**

`useAgentBridge` must accept:

```ts
type AgentBridgeOptions = {
    desktop: boolean;
    enabled: Readonly<Ref<boolean>>;
    session: ReturnType<typeof useDocumentSession>;
    saveDocument(id: string, baseLiveRevision: string): Promise<OpenDocument>;
    onMutation(documentId: string): void;
};
```

Build snapshots only from `session.document(id)`. `replaceDocument` calls `session.replaceContent` and then `onMutation`; App uses it to show the short status “Agent 已修改文档”. `saveDocument` first calls `session.assertLiveRevision`, then the supplied save callback. Convert errors to the stable code list and never include document content in an error.

Watch the list of `{ id, liveRevision, dirty }` values and coalesce `publish_agent_document_events` calls to at most once per 100 ms. Reads and writes themselves remain immediate. On `dispose`, clear the timer, unregister both Tauri listeners and call `set_agent_access_enabled(false)` only when this composable had started the bridge.

- [ ] **Step 6: Implement the non-interactive Agent save path in App**

Add a save callback that shares `savingDocumentIds` but never opens Save As or conflict dialogs:

```ts
async function saveDocumentForAgent(id: string, baseLiveRevision: string) {
    const runtime = session.assertLiveRevision(id, baseLiveRevision);
    if (!runtime.path || runtime.sourceKind !== "mdx") {
        throw { code: "SAVE_AS_REQUIRED", documentId: id };
    }
    if (savingDocumentIds.has(id)) {
        throw { code: "DOCUMENT_BUSY", documentId: id };
    }
    savingDocumentIds.add(id);
    try {
        return await session.save(id);
    } finally {
        savingDocumentIds.delete(id);
    }
}
```

Instantiate `useAgentBridge` after preferences/session creation, and dispose it before `session.dispose()`.

- [ ] **Step 7: Add the persisted setting and Agent category**

Add `agentAccessEnabled: boolean` to `EditorPreferences`, default it to `false`, and normalize with an exact boolean check. The Agent settings view must include:

- One checkbox labeled “本地 Agent 接入”.
- A visible warning that same-user programs can read and modify open documents, including unsaved content.
- Status text for disabled, listening, connection count and last error.
- The resolved CLI path when available.
- A “复制 MCP 配置” button enabled only when `cliPath` is present.

Build the copied JSON from the resolved path with:

```ts
JSON.stringify(
    {
        mcpServers: {
            mora: { command: agentStatus.cliPath, args: ["mcp"] },
        },
    },
    null,
    2,
);
```

Use `navigator.clipboard.writeText` in App and report success/failure through the existing status/error message areas. Style only with existing semantic CSS variables.

- [ ] **Step 8: Run Task 3 tests GREEN**

Run:

```powershell
npx vitest run src/composables/usePreferences.test.ts src/components/SettingsPanel.test.ts src/composables/useAgentBridge.test.ts src/composables/useDocumentSession.test.ts
cargo test --manifest-path src-tauri/Cargo.toml agent_bridge
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS; default startup publishes no IPC listener or registry.

- [ ] **Step 9: Commit Task 3**

```powershell
git add src-tauri/src/agent_bridge.rs src-tauri/src/lib.rs src/types/agent.ts src/composables/useAgentBridge.ts src/composables/useAgentBridge.test.ts src/composables/usePreferences.ts src/composables/usePreferences.test.ts src/components/SettingsPanel.vue src/components/SettingsPanel.test.ts src/App.vue src/experience.css
git commit -m "feat(agent): 接入默认关闭的实时桥接"
```

---

### Task 4: `mora-agent` CLI and watch stream

**Files:**

- Create: `src-tauri/src/agent_cli.rs`
- Create: `src-tauri/src/bin/mora-agent.rs`
- Create: `src-tauri/tests/agent_cli.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs:1-20`

**Interfaces:**

- Consumes: `AgentClient::request`, `AgentClient::watch` and protocol result/error types.
- Produces clap `Cli`, `Command`, `run_cli`, stable JSON/JSONL records and process exit codes.
- Produces Cargo binary target `mora-agent`.

- [ ] **Step 1: Add CLI dependency and binary target**

Add:

```toml
clap = { version = "4.5", features = ["derive"] }

[[bin]]
name = "mora-agent"
path = "src/bin/mora-agent.rs"
```

The binary must remain a console subsystem on Windows; do not copy the GUI crate attribute `windows_subsystem = "windows"`.

- [ ] **Step 2: Write failing parser, output and exit-code tests**

Test exact command parsing and that replace reads content from a file or `-` stdin rather than command-line text:

```rust
#[test]
fn parses_replace_without_accepting_inline_content() {
    let cli = Cli::try_parse_from([
        "mora-agent", "replace", "doc-1",
        "--base-revision", "session:2",
        "--content-file", "-", "--json",
    ]).unwrap();
    assert!(matches!(cli.command, Command::Replace { .. }));
}

#[test]
fn maps_stable_errors_to_stable_exit_codes() {
    assert_eq!(exit_code("MORA_NOT_RUNNING"), 2);
    assert_eq!(exit_code("AGENT_ACCESS_DISABLED"), 3);
    assert_eq!(exit_code("REVISION_CONFLICT"), 4);
    assert_eq!(exit_code("DISK_CONFLICT"), 5);
    assert_eq!(exit_code("PERMISSION_DENIED"), 6);
}
```

Use a real temporary IPC server to assert `list --json` writes only one JSON object to stdout and `watch --jsonl` writes one compact JSON event per line. Capture stderr separately and assert it never contains fixture content.

- [ ] **Step 3: Run CLI tests to verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test agent_cli`

Expected: FAIL because CLI types and binary do not exist.

- [ ] **Step 4: Implement exact CLI surface**

Define these subcommands and flags:

```rust
pub enum Command {
    Status { json: bool },
    List { json: bool },
    Read { document_id: String, json: bool },
    Replace {
        document_id: String,
        base_revision: String,
        content_file: PathBuf,
        json: bool,
    },
    Save {
        document_id: String,
        base_revision: String,
        json: bool,
    },
    Watch { document_id: Option<String>, jsonl: bool },
    Mcp,
}
```

For `--content-file -`, read UTF-8 from stdin; reject invalid UTF-8 and files over `MAX_FRAME_BYTES` before connecting. Machine-readable success and error records go to stdout only when `--json`/`--jsonl` is active; diagnostics always go to stderr. `watch` prints the acknowledgement only in human mode, then flushes every event line immediately.

- [ ] **Step 5: Implement the console entry point**

`src/bin/mora-agent.rs` must contain only runtime setup and dispatch:

```rust
#[tokio::main]
async fn main() {
    let code = mdxnote_lib::agent_cli::main_entry(std::env::args_os()).await;
    std::process::exit(code);
}
```

The `Mcp` branch calls Task 5 `run_mcp()`; until Task 5 lands, return a stable `UNSUPPORTED_COMMAND` error from that branch so Task 4 remains independently testable.

- [ ] **Step 6: Run Task 4 tests GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test agent_cli
cargo run --manifest-path src-tauri/Cargo.toml --bin mora-agent -- --help
```

Expected: tests PASS; help lists `status`, `list`, `read`, `replace`, `save`, `watch`, `mcp`; because Mora is not guaranteed running, do not treat a status exit code of 2 as a build failure.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/agent_cli.rs src-tauri/src/bin/mora-agent.rs src-tauri/tests/agent_cli.rs
git commit -m "feat(agent): 提供实时读写 CLI"
```

---

### Task 5: MCP stdio tools in the same binary

**Files:**

- Create: `src-tauri/src/agent_mcp.rs`
- Create: `src-tauri/tests/agent_mcp.rs`
- Modify: `src-tauri/src/agent_cli.rs`
- Modify: `src-tauri/src/lib.rs:1-20`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**

- Consumes: the same `AgentClient` methods used by CLI.
- Produces `MoraMcpServer` and `run_mcp() -> Result<(), AgentError>`.
- Replaces Task 4 temporary `UNSUPPORTED_COMMAND` branch with the MCP server.

- [ ] **Step 1: Add the official MCP SDK with only stdio server features**

Add the current verified dependency:

```toml
rmcp = { version = "3.1.4", default-features = false, features = ["server", "macros", "schemars", "transport-io"] }
```

Do not enable client, HTTP, OAuth or streamable HTTP features.

- [ ] **Step 2: Write failing tool discovery and invocation tests**

Launch the built `mora-agent mcp` against a temporary Agent IPC server and speak MCP over piped stdio. Assert initialize succeeds, `tools/list` returns exactly four names, and tool calls use the same wire requests as CLI:

```rust
assert_eq!(
    listed_tool_names,
    [
        "mora_list_documents",
        "mora_read_document",
        "mora_replace_document",
        "mora_save_document",
    ]
);
assert_eq!(captured_replace.base_live_revision, "session:7");
assert_eq!(captured_replace.content, "# from mcp\n");
```

Send a fixture `REVISION_CONFLICT` from IPC and assert the MCP tool result is marked as an error and its text JSON contains `code` plus `currentLiveRevision`, but no document content.

- [ ] **Step 3: Run MCP tests to verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test agent_mcp`

Expected: FAIL because `agent_mcp` and a functioning `mcp` branch do not exist.

- [ ] **Step 4: Implement typed MCP arguments and tools**

Use rmcp macros and JSON Schema derives:

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadDocumentArgs {
    pub document_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReplaceDocumentArgs {
    pub document_id: String,
    pub base_live_revision: String,
    pub content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveDocumentArgs {
    pub document_id: String,
    pub base_live_revision: String,
}
```

`MoraMcpServer` holds only `AgentClient`. Annotate the implementation with `#[tool_router(server_handler)]`; every tool serializes its successful `AgentResult` as compact JSON text. Invalid MCP arguments return `ErrorData::invalid_params`; Mora operational failures return an MCP tool error result containing the stable `AgentError` JSON.

- [ ] **Step 5: Run the stdio service**

Use the official stdio transport:

```rust
pub async fn run_mcp() -> Result<(), AgentError> {
    let client = AgentClient::connect().await?;
    let service = MoraMcpServer::new(client)
        .serve(rmcp::transport::stdio())
        .await
        .map_err(AgentError::from_mcp)?;
    service.waiting().await.map_err(AgentError::from_mcp)?;
    Ok(())
}
```

Ensure all diagnostic output stays on stderr because stdout belongs exclusively to MCP JSON-RPC.

- [ ] **Step 6: Run Task 5 tests GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test agent_mcp
cargo test --manifest-path src-tauri/Cargo.toml --test agent_cli
cargo check --manifest-path src-tauri/Cargo.toml --bin mora-agent
```

Expected: PASS; `mora-agent mcp` exits with a nonzero stable error when Mora is not running and never prints diagnostics to stdout.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/agent_cli.rs src-tauri/src/agent_mcp.rs src-tauri/tests/agent_mcp.rs
git commit -m "feat(agent): 在 CLI 中提供 MCP stdio"
```

---

### Task 6: Event-driven external file synchronization

**Files:**

- Create: `src-tauri/src/file_watch.rs`
- Create: `src-tauri/tests/file_watch.rs`
- Create: `src/composables/useExternalFileSync.ts`
- Create: `src/composables/useExternalFileSync.test.ts`
- Modify: `src-tauri/src/lib.rs:15-16,263-267,309-317,342-399,401-428,1108-1172`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src/App.vue:1017-1103`

**Interfaces:**

- Produces managed `DocumentWatchState` and Tauri command `set_watched_document_paths(paths)`.
- Emits `mora://external-files-changed` with `{ paths: string[] }`.
- Produces `InternalWriteGuard`, `begin_internal_write(path)` and `finish(revision)`.
- Produces `useExternalFileSync({ desktop, session, onReloaded, onActiveConflict })`.

- [ ] **Step 1: Add the exact watcher dependency**

Add:

```toml
notify = "8.2.0"
```

Do not add a second debounce crate; the supervisor owns one deadline map keyed by normalized target path.

- [ ] **Step 2: Write failing watcher and echo-suppression tests**

Cover parent-directory atomic rename, incomplete ZIP retry, dirty conflict behavior at the frontend seam, and own-save suppression:

```rust
#[test]
fn expected_internal_revision_is_suppressed_once() {
    let mut suppressor = EchoSuppressor::default();
    suppressor.begin(Path::new("note.mdx"));
    suppressor.finish(Path::new("note.mdx"), revision(42, 900));
    assert!(suppressor.should_suppress(Path::new("note.mdx"), &revision(42, 900)));
    assert!(!suppressor.should_suppress(Path::new("note.mdx"), &revision(43, 901)));
}
```

Frontend test:

```ts
await externalChangeListener({ payload: { paths: [clean.path!, dirty.path!] } });
expect(session.document(clean.id).content).toBe("disk changed");
expect(session.document(dirty.id).content).toBe("local dirty");
expect(session.document(dirty.id).conflict).toBe(true);
expect(onReloaded).toHaveBeenCalledWith([clean.id]);
```

- [ ] **Step 3: Run watcher tests to verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test file_watch
npx vitest run src/composables/useExternalFileSync.test.ts
```

Expected: FAIL because the watcher state and composable do not exist.

- [ ] **Step 4: Implement watcher supervision and fallback**

The watcher thread owns `notify::RecommendedWatcher`, the watched document set, parent-directory reference counts, debounce deadlines and echo suppressor. Watch parents with `RecursiveMode::NonRecursive` so atomic replacement of the target inode is observed.

For a matching event:

1. Set or extend that path's deadline to 150 ms.
2. After the deadline, read two `DiskRevision` values 75 ms apart.
3. Continue only when both revisions match.
4. Validate the archive through a `pub(crate) fn validate_mdx_path(&Path)` extracted from the existing read path.
5. Retry the stability/validation sequence at most four times.
6. Suppress a matching expected internal revision; otherwise emit the path once.

If `recommended_watcher` creation or `watch()` fails, replace it with `notify::PollWatcher` configured to one second. A later backend error must send a supervisor message that performs the same switch; do not run native watch and polling simultaneously.

- [ ] **Step 5: Wrap the existing safe save with echo state**

Add `State<DocumentWatchState>` to `save_mdx` and `save_mdx_as`. Before `save_to_path`, create an `InternalWriteGuard` for the final `.mdx` path. On success, read `workspace::disk_revision` and call `guard.finish(revision)`; on error, `Drop` clears the in-flight marker. Do not alter `safe_write_file` or the archive-building order.

- [ ] **Step 6: Implement frontend watched-path synchronization**

`useExternalFileSync` watches the sorted unique non-null `document.path` list and invokes `set_watched_document_paths`. On `mora://external-files-changed`, call `session.refreshDiskState(payload.paths)`, pass reloaded IDs to `onReloaded`, then call `onActiveConflict` only when the active document is conflicted.

Keep the existing focus handler as a final fallback. Its full `session.refreshDiskState()` call remains unchanged.

- [ ] **Step 7: Run Task 6 tests GREEN**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test file_watch
npx vitest run src/composables/useExternalFileSync.test.ts src/composables/useDocumentSession.test.ts
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS; an internal save does not create a false conflict, an external clean replacement reloads, and a dirty replacement preserves local content.

- [ ] **Step 8: Commit Task 6**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/file_watch.rs src-tauri/tests/file_watch.rs src/composables/useExternalFileSync.ts src/composables/useExternalFileSync.test.ts src/App.vue
git commit -m "feat(agent): 实时感知外部文件修改"
```

---

### Task 7: Build and bundle `mora-agent` on every target

**Files:**

- Create: `scripts/prepare-agent-sidecar.mjs`
- Create: `scripts/prepare-agent-sidecar.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `src-tauri/tauri.conf.json:7-13,29-56`
- Modify: `src/releaseWorkflow.test.ts`
- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: Cargo binary `mora-agent` from Task 4/5.
- Produces Tauri external binary `binaries/mora-agent-$TAURI_ENV_TARGET_TRIPLE[.exe]`.
- Preserves `npm run build:exe` as the routine command while making it build both `mora` and `mora-agent`.

- [ ] **Step 1: Write failing sidecar preparation tests**

Test pure helpers without compiling Rust:

```js
assert.equal(sidecarFileName("x86_64-pc-windows-msvc"), "mora-agent-x86_64-pc-windows-msvc.exe");
assert.equal(sidecarFileName("aarch64-apple-darwin"), "mora-agent-aarch64-apple-darwin");
assert.deepEqual(cargoBuildArgs("x86_64-unknown-linux-gnu", false), [
    "build", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "mora-agent",
    "--release", "--target", "x86_64-unknown-linux-gnu",
]);
```

Extend `releaseWorkflow.test.ts` to require `externalBin: ["binaries/mora-agent"]`, the prepare script in `beforeBuildCommand`, and the cross-platform command `node scripts/prepare-agent-sidecar.mjs --check --target ${{ matrix.target }}` after every release build.

- [ ] **Step 2: Run packaging contract tests to verify RED**

Run:

```powershell
node --test scripts/prepare-agent-sidecar.test.mjs
npx vitest run src/releaseWorkflow.test.ts
```

Expected: FAIL because the script and external binary configuration do not exist.

- [ ] **Step 3: Implement target-aware sidecar preparation**

The script must:

1. Read `TAURI_ENV_TARGET_TRIPLE`; if absent, call `rustc --print host-tuple`.
2. Read `TAURI_ENV_DEBUG === "true"` to choose debug; otherwise use release.
3. Invoke Cargo with explicit `--bin mora-agent --target <triple>` and `--release` when required.
4. Copy the resulting executable to `src-tauri/binaries/mora-agent-<triple>[.exe]`.
5. On a native target, also copy it to `src-tauri/target/<profile>/mora-agent[.exe]` so the documented development output is directly callable beside `mora`.
6. Fail with a nonzero exit code if the source binary or copied artifact is missing.
7. In `--check --target <triple>` mode, perform no build or copy; verify the compiled target binary and Tauri sidecar copy both exist.

Export the filename/argument helpers and execute `main()` only when the module is run directly so Node tests remain side-effect free.

- [ ] **Step 4: Wire Tauri build and bundling**

Add:

```json
"prepare:agent": "node scripts/prepare-agent-sidecar.mjs"
```

Set `beforeBuildCommand` to `npm run build && npm run prepare:agent`, and add:

```json
"externalBin": ["binaries/mora-agent"]
```

Ignore only generated `src-tauri/binaries/mora-agent-*`; do not ignore arbitrary files under `src-tauri/binaries`.

- [ ] **Step 5: Update release workflow artifact checks**

After `tauri-action`, run `node scripts/prepare-agent-sidecar.mjs --check --target ${{ matrix.target }}`. Keep release matrix serialization, updater signing, bundles and Draft behavior unchanged.

- [ ] **Step 6: Run Task 7 tests and development build GREEN**

Run:

```powershell
node --test scripts/prepare-agent-sidecar.test.mjs
npx vitest run src/releaseWorkflow.test.ts
npm run build:exe
```

Expected: PASS; on Windows both files exist:

```text
src-tauri/target/release/mora.exe
src-tauri/target/release/mora-agent.exe
```

If `mora.exe` is locked by a running Mora instance, set a task-specific `CARGO_TARGET_DIR` for verification and report the standard artifact as not overwritten; do not terminate the user's application.

- [ ] **Step 7: Commit Task 7**

```powershell
git add scripts/prepare-agent-sidecar.mjs scripts/prepare-agent-sidecar.test.mjs package.json .gitignore src-tauri/tauri.conf.json src/releaseWorkflow.test.ts .github/workflows/publish.yml
git commit -m "build(agent): 打包 mora-agent 辅助程序"
```

---

### Task 8: User documentation and complete acceptance

**Files:**

- Modify: `README.md`
- Modify: `docs/RELEASE.md`
- Verify: all files changed by Tasks 1-7

**Interfaces:**

- Produces user-facing enablement, CLI, MCP, security and conflict documentation.
- Produces fresh test/build evidence for both binaries and all integration seams.

- [ ] **Step 1: Document the exact user workflow**

Add a concise README section covering:

```text
设置 → Agent → 开启“本地 Agent 接入”
mora-agent status --json
mora-agent list --json
mora-agent read <document-id> --json
mora-agent replace <document-id> --base-revision <revision> --content-file - --json
mora-agent save <document-id> --base-revision <revision> --json
mora-agent mcp
```

State explicitly that the feature is default-off, same-user local only, reads unsaved content, replacement does not auto-save, stale writes are rejected, and MCP uses stdio with no HTTP port.

- [ ] **Step 2: Document packaging and release checks**

Update `docs/RELEASE.md` so development verification checks both executable names and every installer is expected to contain `mora-agent`. Keep the existing Windows/macOS/Linux package matrix and release authorization boundaries unchanged.

- [ ] **Step 3: Run focused frontend suite**

Run:

```powershell
npx vitest run src/composables/useDocumentSession.test.ts src/composables/usePreferences.test.ts src/composables/useAgentBridge.test.ts src/composables/useExternalFileSync.test.ts src/components/SettingsPanel.test.ts src/releaseWorkflow.test.ts
```

Expected: PASS with revision, default-off, bridge, watcher, settings and packaging contracts.

- [ ] **Step 4: Run complete Rust suite**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS including `agent_protocol`, `agent_ipc`, `agent_cli`, `agent_mcp` and `file_watch` integration tests.

- [ ] **Step 5: Run repository-wide quality gates**

Run:

```powershell
npm test
npm run lint
npm run format:check
npm run build
npm run build:exe
```

Expected: PASS. Confirm the frontend build, `mora.exe` and `mora-agent.exe`/`mora-agent` exist at the documented development paths.

- [ ] **Step 6: Perform local IPC acceptance without exposing document data**

Using a disposable `.mdx` fixture and a development Mora instance:

1. Confirm the default setting produces no registry/listener.
2. Enable Agent access and run `mora-agent status --json`.
3. Edit without saving; verify `read` returns the new in-memory text.
4. Replace with the current revision; verify the editor changes immediately and remains dirty.
5. Retry with the old revision; verify exit code 4 and unchanged content.
6. Save with the new revision; reopen the fixture and validate its archive/resources.
7. Start `watch --jsonl`, type once, and confirm a revision-only event arrives.
8. Disable Agent access; verify the watcher disconnects and later requests fail.
9. Modify the fixture externally once while clean and once while dirty; verify reload then conflict behavior.

Do not use a personal note, and do not include fixture content in logs or the final report.

- [ ] **Step 7: Run the explicit performance trigger probe**

Run:

```powershell
cargo test --release --manifest-path src-tauri/Cargo.toml --test agent_ipc five_mib_round_trip_profile -- --ignored --nocapture
```

Expected: a debug build fails immediately with an instruction to use `cargo test --release`. The release test prints 20 measured samples and `p95_ms`. If release-mode P95 exceeds 100 ms on the local machine, stop and report the measured trigger; do not add patch/CRDT logic outside a revised design.

- [ ] **Step 8: Audit scope and whitespace**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; the pre-existing unrelated user modification remains unstaged and unchanged.

- [ ] **Step 9: Commit Task 8**

```powershell
git add README.md docs/RELEASE.md
git commit -m "docs(agent): 补充 CLI 与 MCP 使用说明"
```

Do not tag, push, publish a release or start GitHub Actions without a new explicit user request.

---

## Spec Coverage Review

| Spec requirement | Implemented by |
| --- | --- |
| Unsaved in-memory read/write and immediate editor update | Tasks 1, 3 |
| Opaque live revision and serialized writes | Tasks 1, 3 |
| Explicit safe save and disk conflict | Tasks 3, 6 |
| Default-off setting and visible connection state | Task 3 |
| Owner-only Named Pipe/Unix socket, no network port | Task 2 |
| One `mora-agent` binary | Tasks 4, 7 |
| CLI JSON/JSONL and watch | Task 4 |
| Four MCP stdio tools with shared client | Task 5 |
| External event watch, stability validation, polling fallback | Task 6 |
| Internal save echo suppression | Task 6 |
| Cross-platform packaging and exact binary names | Task 7 |
| Security, failure and full acceptance coverage | Tasks 2-8 |

No task introduces HTTP, CRDT/OT, an offline editor, a second document store, resource mutation tools, a daemon, automatic `PATH` changes or automatic third-party MCP configuration.
