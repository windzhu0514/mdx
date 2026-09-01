use crate::workspace::{disk_revision, DiskRevision};
use crate::{normalize_path, path_identity, validate_mdx_path};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub const EXTERNAL_FILES_CHANGED_EVENT: &str = "mora://external-files-changed";
pub const FILE_WATCH_STATUS_EVENT: &str = "mora://file-watch-status";
const DEBOUNCE_DELAY: Duration = Duration::from_millis(150);
const STABILITY_DELAY: Duration = Duration::from_millis(75);
const STABILITY_ATTEMPTS: usize = 4;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const ECHO_LIFETIME: Duration = Duration::from_secs(5);
const SUPERVISOR_ACK_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PENDING_NOTIFY_PATHS: usize = 256;

type EmitPaths = Arc<dyn Fn(Vec<String>) + Send + Sync>;
type EmitStatus = Arc<dyn Fn(FileWatchStatusPayload) + Send + Sync>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchStatusPayload {
    pub state: FileWatchState,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileWatchState {
    Active,
    Degraded,
    Disabled,
}

struct StatusReporter {
    emit: EmitStatus,
    last: Option<FileWatchStatusPayload>,
}

impl StatusReporter {
    fn new(emit: EmitStatus) -> Self {
        Self { emit, last: None }
    }

    fn report(&mut self, state: FileWatchState, message: Option<&str>) {
        let payload = FileWatchStatusPayload {
            state,
            message: message.map(str::to_string),
        };
        if self.last.as_ref() == Some(&payload) {
            return;
        }
        (self.emit)(payload.clone());
        self.last = Some(payload);
    }

    fn repeat(&self) {
        if let Some(payload) = self.last.clone() {
            (self.emit)(payload);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContentFingerprint([u8; 32]);

impl ContentFingerprint {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    fn from_path(path: &Path) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(Self(hasher.finalize().into()))
    }
}

#[derive(Clone)]
pub(crate) struct FileSnapshot {
    pub revision: DiskRevision,
    pub fingerprint: ContentFingerprint,
}

pub(crate) fn read_file_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let before = disk_revision(path);
    let revision = before.revision.ok_or_else(|| {
        before
            .error
            .unwrap_or_else(|| "文件暂时不可用。".to_string())
    })?;
    let fingerprint = ContentFingerprint::from_path(path)?;
    let after = disk_revision(path);
    if !after.available || after.revision.as_ref() != Some(&revision) {
        return Err("文件读取期间发生变化。".to_string());
    }
    Ok(FileSnapshot {
        revision,
        fingerprint,
    })
}

#[derive(Debug)]
enum EchoState {
    InFlight {
        expires_at: Instant,
    },
    Expected {
        revision: DiskRevision,
        fingerprint: ContentFingerprint,
        expires_at: Instant,
    },
}

#[derive(Debug, Default)]
pub struct EchoSuppressor {
    entries: HashMap<String, EchoState>,
}

impl EchoSuppressor {
    pub fn begin(&mut self, path: &Path) {
        self.prune();
        self.entries.insert(
            path_key(path),
            EchoState::InFlight {
                expires_at: Instant::now() + ECHO_LIFETIME,
            },
        );
    }

    pub fn finish(&mut self, path: &Path, revision: DiskRevision, fingerprint: ContentFingerprint) {
        self.prune();
        let key = path_key(path);
        if matches!(self.entries.get(&key), Some(EchoState::InFlight { .. })) {
            self.entries.insert(
                key,
                EchoState::Expected {
                    revision,
                    fingerprint,
                    expires_at: Instant::now() + ECHO_LIFETIME,
                },
            );
        }
    }

    pub fn cancel(&mut self, path: &Path) {
        self.entries.remove(&path_key(path));
    }

    pub fn should_suppress(
        &mut self,
        path: &Path,
        revision: &DiskRevision,
        fingerprint: &ContentFingerprint,
    ) -> bool {
        self.prune();
        let key = path_key(path);
        let suppress = matches!(
            self.entries.get(&key),
            Some(EchoState::Expected {
                revision: expected,
                fingerprint: expected_fingerprint,
                ..
            }) if expected == revision && expected_fingerprint == fingerprint
        );
        if matches!(self.entries.get(&key), Some(EchoState::Expected { .. })) {
            self.entries.remove(&key);
        }
        suppress
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, state| match state {
            EchoState::InFlight { expires_at } | EchoState::Expected { expires_at, .. } => {
                *expires_at > now
            }
        });
    }
}

#[derive(Clone)]
struct SupervisorMailbox {
    shared: Arc<MailboxShared>,
}

struct MailboxShared {
    state: Mutex<MailboxState>,
    overflow_rescan: AtomicBool,
    wake: SyncSender<()>,
}

struct MailboxState {
    controls: VecDeque<ControlMessage>,
    stable: VecDeque<StableMessage>,
    notify_paths: HashSet<PathBuf>,
    notify_rescan: bool,
    notify_error: Option<String>,
    max_notify_paths: usize,
}

struct MailboxReceiver {
    shared: Arc<MailboxShared>,
    wake: Receiver<()>,
}

struct NotifyBatch {
    paths: Vec<PathBuf>,
    rescan_all: bool,
    error: Option<String>,
}

enum SupervisorInput {
    Control(ControlMessage),
    Stable(StableMessage),
    Notify(NotifyBatch),
}

struct StableMessage {
    key: String,
    epoch: u64,
    generation: u64,
    outcome: StabilityOutcome,
}

enum ControlMessage {
    SetPaths {
        paths: Vec<String>,
        acknowledge: SyncSender<Result<(), String>>,
    },
    BeginInternalWrite {
        path: PathBuf,
        acknowledge: SyncSender<()>,
    },
    FinishInternalWrite {
        path: PathBuf,
        revision: DiskRevision,
        fingerprint: ContentFingerprint,
    },
    CancelInternalWrite {
        path: PathBuf,
    },
    Shutdown,
}

impl SupervisorMailbox {
    fn new(max_notify_paths: usize) -> (Self, MailboxReceiver) {
        let (wake, receiver) = mpsc::sync_channel(1);
        let shared = Arc::new(MailboxShared {
            state: Mutex::new(MailboxState {
                controls: VecDeque::new(),
                stable: VecDeque::new(),
                notify_paths: HashSet::new(),
                notify_rescan: false,
                notify_error: None,
                max_notify_paths,
            }),
            overflow_rescan: AtomicBool::new(false),
            wake,
        });
        (
            Self {
                shared: Arc::clone(&shared),
            },
            MailboxReceiver {
                shared,
                wake: receiver,
            },
        )
    }

    fn push_control(&self, message: ControlMessage) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.controls.push_back(message);
        }
        self.wake();
    }

    fn push_control_front(&self, message: ControlMessage) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.controls.push_front(message);
        }
        self.wake();
    }

    fn push_stable(&self, message: StableMessage) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.stable.push_back(message);
        }
        self.wake();
    }

    fn record_notify(&self, event: notify::Result<Event>) {
        if event
            .as_ref()
            .is_ok_and(|event| matches!(event.kind, EventKind::Access(_)))
        {
            return;
        }
        match self.shared.state.try_lock() {
            Ok(mut state) => match event {
                Ok(event) if !state.notify_rescan => {
                    for path in event.paths {
                        if state.notify_paths.len() >= state.max_notify_paths
                            && !state.notify_paths.contains(&path)
                        {
                            state.notify_paths.clear();
                            state.notify_rescan = true;
                            break;
                        }
                        state.notify_paths.insert(path);
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    state.notify_error = Some(error.to_string());
                    state.notify_paths.clear();
                    state.notify_rescan = true;
                }
            },
            Err(_) => {
                self.shared.overflow_rescan.store(true, Ordering::Release);
            }
        }
        self.wake();
    }

    fn wake(&self) {
        let _ = self.shared.wake.try_send(());
    }
}

impl MailboxReceiver {
    fn take_pending(&mut self) -> Option<SupervisorInput> {
        let mut state = self.shared.state.lock().ok()?;
        if let Some(message) = state.controls.pop_front() {
            return Some(SupervisorInput::Control(message));
        }
        if let Some(message) = state.stable.pop_front() {
            return Some(SupervisorInput::Stable(message));
        }
        if self.shared.overflow_rescan.swap(false, Ordering::AcqRel) {
            state.notify_paths.clear();
            state.notify_rescan = true;
        }
        if state.notify_paths.is_empty() && !state.notify_rescan && state.notify_error.is_none() {
            return None;
        }
        Some(SupervisorInput::Notify(NotifyBatch {
            paths: state.notify_paths.drain().collect(),
            rescan_all: std::mem::take(&mut state.notify_rescan),
            error: state.notify_error.take(),
        }))
    }

    fn next(&mut self, timeout: Option<Duration>) -> Option<SupervisorInput> {
        loop {
            if let Some(message) = self.take_pending() {
                return Some(message);
            }
            let wake = match timeout {
                Some(timeout) => self.wake.recv_timeout(timeout),
                None => self.wake.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match wake {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return None,
            }
        }
    }
}

pub struct DocumentWatchState {
    mailbox: SupervisorMailbox,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl DocumentWatchState {
    pub fn new(app: AppHandle) -> Self {
        let status_app = app.clone();
        Self::with_runtime(
            move |paths| {
                let _ = app.emit(
                    EXTERNAL_FILES_CHANGED_EVENT,
                    ExternalFilesChangedPayload { paths },
                );
            },
            move |status| {
                let _ = status_app.emit(FILE_WATCH_STATUS_EVENT, status);
            },
            Arc::new(NotifyWatcherFactory),
        )
    }

    #[doc(hidden)]
    pub fn with_emitter<F>(emit: F) -> Self
    where
        F: Fn(Vec<String>) + Send + Sync + 'static,
    {
        Self::with_runtime(emit, |_| {}, Arc::new(NotifyWatcherFactory))
    }

    fn with_runtime<F, S>(emit: F, emit_status: S, factory: Arc<dyn WatcherFactory>) -> Self
    where
        F: Fn(Vec<String>) + Send + Sync + 'static,
        S: Fn(FileWatchStatusPayload) + Send + Sync + 'static,
    {
        let (mailbox, receiver) = SupervisorMailbox::new(MAX_PENDING_NOTIFY_PATHS);
        let supervisor_mailbox = mailbox.clone();
        let emit: EmitPaths = Arc::new(emit);
        let emit_status: EmitStatus = Arc::new(emit_status);
        let join = thread::Builder::new()
            .name("mora-file-watch".to_string())
            .spawn(move || run_supervisor(receiver, supervisor_mailbox, emit, emit_status, factory))
            .expect("failed to start Mora file watcher");
        Self {
            mailbox,
            join: Mutex::new(Some(join)),
        }
    }

    pub fn set_paths(&self, paths: Vec<String>) -> Result<(), String> {
        let (acknowledge, result) = mpsc::sync_channel(0);
        self.mailbox
            .push_control(ControlMessage::SetPaths { paths, acknowledge });
        result
            .recv_timeout(SUPERVISOR_ACK_TIMEOUT)
            .map_err(|_| "文件监视任务已停止。".to_string())?
    }

    pub fn begin_internal_write(&self, path: &Path) -> InternalWriteGuard<'_> {
        let path = path.to_path_buf();
        let (acknowledge, acknowledged) = mpsc::sync_channel(0);
        self.mailbox
            .push_control(ControlMessage::BeginInternalWrite {
                path: path.clone(),
                acknowledge,
            });
        let _ = acknowledged.recv_timeout(SUPERVISOR_ACK_TIMEOUT);
        InternalWriteGuard {
            state: self,
            path,
            finished: false,
        }
    }

    pub fn shutdown_now(&self) {
        let join = self.join.lock().ok().and_then(|mut join| join.take());
        if let Some(join) = join {
            self.mailbox.push_control_front(ControlMessage::Shutdown);
            let _ = join.join();
        }
    }
}

impl Drop for DocumentWatchState {
    fn drop(&mut self) {
        let join = self.join.get_mut().ok().and_then(Option::take);
        if let Some(join) = join {
            self.mailbox.push_control_front(ControlMessage::Shutdown);
            let _ = join.join();
        }
    }
}

pub struct InternalWriteGuard<'a> {
    state: &'a DocumentWatchState,
    path: PathBuf,
    finished: bool,
}

impl InternalWriteGuard<'_> {
    pub fn finish(mut self, revision: DiskRevision, fingerprint: ContentFingerprint) {
        self.state
            .mailbox
            .push_control(ControlMessage::FinishInternalWrite {
                path: self.path.clone(),
                revision,
                fingerprint,
            });
        self.finished = true;
    }
}

impl Drop for InternalWriteGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.state
                .mailbox
                .push_control(ControlMessage::CancelInternalWrite {
                    path: self.path.clone(),
                });
        }
    }
}

#[derive(Clone, Serialize)]
struct ExternalFilesChangedPayload {
    paths: Vec<String>,
}

struct WatchedTarget {
    path: PathBuf,
    normalized: String,
    parent_key: String,
    epoch: u64,
}

struct ParentWatch {
    path: PathBuf,
    references: usize,
}

struct StabilityTask {
    epoch: u64,
    generation: u64,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct WatchedDocuments {
    targets: HashMap<String, WatchedTarget>,
    deadlines: HashMap<String, (Instant, u64, u64)>,
    generations: HashMap<String, u64>,
    tasks: HashMap<String, StabilityTask>,
    suppressor: EchoSuppressor,
    next_epoch: u64,
}

impl WatchedDocuments {
    fn replace_targets(&mut self, mut next: HashMap<String, WatchedTarget>) {
        for (key, target) in &mut next {
            if let Some(current) = self.targets.get(key) {
                target.epoch = current.epoch;
            } else {
                self.next_epoch = self
                    .next_epoch
                    .checked_add(1)
                    .expect("watch membership epoch exhausted");
                target.epoch = self.next_epoch;
            }
        }
        let removed = self
            .targets
            .keys()
            .filter(|key| !next.contains_key(*key))
            .cloned()
            .collect::<Vec<_>>();
        for key in removed {
            self.deadlines.remove(&key);
            self.generations.remove(&key);
            if let Some(task) = self.tasks.remove(&key) {
                let _ = task.cancel.send(true);
            }
            if let Some(target) = self.targets.get(&key) {
                self.suppressor.cancel(&target.path);
            }
        }
        self.targets = next;
    }

    fn schedule(&mut self, key: &str) {
        let Some(target) = self.targets.get(key) else {
            return;
        };
        if let Some(task) = self.tasks.remove(key) {
            let _ = task.cancel.send(true);
        }
        let generation = self.generations.entry(key.to_string()).or_default();
        *generation += 1;
        self.deadlines.insert(
            key.to_string(),
            (Instant::now() + DEBOUNCE_DELAY, target.epoch, *generation),
        );
    }

    fn accepts_stable(&self, key: &str, epoch: u64, generation: u64) -> bool {
        self.targets.get(key).map(|target| target.epoch) == Some(epoch)
            && self
                .tasks
                .get(key)
                .map(|task| (task.epoch, task.generation))
                == Some((epoch, generation))
    }

    fn cancel_all(self) {
        for (_, task) in self.tasks {
            let _ = task.cancel.send(true);
        }
    }
}

struct StabilityOutcome {
    revision: Option<DiskRevision>,
    fingerprint: Option<ContentFingerprint>,
    valid: bool,
}

enum ActiveWatcher {
    Native(RecommendedWatcher),
    Poll(PollWatcher),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WatcherMode {
    Native,
    Poll,
}

#[cfg(test)]
impl WatcherMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Poll => "poll",
        }
    }
}

trait WatchBackend: Send {
    fn mode(&self) -> WatcherMode;
    fn watch(&mut self, path: &Path) -> Result<(), String>;
    fn unwatch(&mut self, path: &Path) -> Result<(), String>;
}

trait WatcherFactory: Send + Sync {
    fn create(
        &self,
        mode: WatcherMode,
        mailbox: SupervisorMailbox,
    ) -> Result<Box<dyn WatchBackend>, String>;
}

struct NotifyWatcherFactory;

impl WatcherFactory for NotifyWatcherFactory {
    fn create(
        &self,
        mode: WatcherMode,
        mailbox: SupervisorMailbox,
    ) -> Result<Box<dyn WatchBackend>, String> {
        let watcher = match mode {
            WatcherMode::Native => ActiveWatcher::Native(
                notify::recommended_watcher(notify_handler(mailbox))
                    .map_err(|error| error.to_string())?,
            ),
            WatcherMode::Poll => ActiveWatcher::Poll(
                PollWatcher::new(
                    notify_handler(mailbox),
                    Config::default()
                        .with_poll_interval(POLL_INTERVAL)
                        .with_compare_contents(true),
                )
                .map_err(|error| error.to_string())?,
            ),
        };
        Ok(Box::new(watcher))
    }
}

impl WatchBackend for ActiveWatcher {
    fn mode(&self) -> WatcherMode {
        match self {
            Self::Native(_) => WatcherMode::Native,
            Self::Poll(_) => WatcherMode::Poll,
        }
    }

    fn watch(&mut self, path: &Path) -> Result<(), String> {
        match self {
            Self::Native(watcher) => watcher.watch(path, RecursiveMode::NonRecursive),
            Self::Poll(watcher) => watcher.watch(path, RecursiveMode::NonRecursive),
        }
        .map_err(|error| error.to_string())
    }

    fn unwatch(&mut self, path: &Path) -> Result<(), String> {
        match self {
            Self::Native(watcher) => watcher.unwatch(path),
            Self::Poll(watcher) => watcher.unwatch(path),
        }
        .map_err(|error| error.to_string())
    }
}

fn run_supervisor(
    mut receiver: MailboxReceiver,
    mailbox: SupervisorMailbox,
    emit: EmitPaths,
    emit_status: EmitStatus,
    factory: Arc<dyn WatcherFactory>,
) {
    let mut reporter = StatusReporter::new(emit_status);
    let mut watcher = create_preferred_watcher(&factory, &mailbox, &mut reporter);
    let mut parents = HashMap::<String, ParentWatch>::new();
    let mut watched = WatchedDocuments::default();

    loop {
        if let Some(message) = receiver.next(next_timeout(&watched.deadlines)) {
            match message {
                SupervisorInput::Control(ControlMessage::SetPaths { paths, acknowledge }) => {
                    let result = normalized_targets(paths).and_then(|next_targets| {
                        let next_parents = parent_watches(&next_targets);
                        sync_watches(
                            &mut watcher,
                            &parents,
                            &next_parents,
                            &mailbox,
                            &factory,
                            &mut reporter,
                        )?;
                        watched.replace_targets(next_targets);
                        parents = next_parents;
                        Ok(())
                    });
                    reporter.repeat();
                    let _ = acknowledge.send(result);
                }
                SupervisorInput::Control(ControlMessage::BeginInternalWrite {
                    path,
                    acknowledge,
                }) => {
                    watched.suppressor.begin(&path);
                    let _ = acknowledge.send(());
                }
                SupervisorInput::Control(ControlMessage::FinishInternalWrite {
                    path,
                    revision,
                    fingerprint,
                }) => {
                    watched.suppressor.finish(&path, revision, fingerprint);
                }
                SupervisorInput::Control(ControlMessage::CancelInternalWrite { path }) => {
                    watched.suppressor.cancel(&path)
                }
                SupervisorInput::Notify(batch) => {
                    if batch.error.is_some() {
                        let previous_mode = watcher.as_ref().map(|watcher| watcher.mode());
                        drop(watcher.take());
                        watcher = match previous_mode {
                            Some(WatcherMode::Native) => {
                                create_poll_for_parents(&parents, &factory, &mailbox, &mut reporter)
                            }
                            Some(WatcherMode::Poll) | None => {
                                reporter.report(
                                    FileWatchState::Disabled,
                                    Some("文件监视已停止；切换或重新打开文档可重试。"),
                                );
                                None
                            }
                        };
                    }
                    let keys = if batch.rescan_all {
                        watched.targets.keys().cloned().collect()
                    } else {
                        matching_target_paths(&batch.paths, &watched.targets)
                    };
                    for key in keys {
                        watched.schedule(&key);
                    }
                }
                SupervisorInput::Stable(StableMessage {
                    key,
                    epoch,
                    generation,
                    outcome,
                }) => {
                    if !watched.accepts_stable(&key, epoch, generation) {
                        continue;
                    }
                    watched.tasks.remove(&key);
                    let Some(target) = watched.targets.get(&key) else {
                        continue;
                    };
                    let target_path = target.path.clone();
                    let normalized = target.normalized.clone();
                    if outcome.valid
                        && outcome
                            .revision
                            .as_ref()
                            .zip(outcome.fingerprint.as_ref())
                            .is_some_and(|(revision, fingerprint)| {
                                watched.suppressor.should_suppress(
                                    &target_path,
                                    revision,
                                    fingerprint,
                                )
                            })
                    {
                        continue;
                    }
                    emit(vec![normalized]);
                }
                SupervisorInput::Control(ControlMessage::Shutdown) => break,
            }
        }

        start_due_tasks(&mut watched, &mailbox);
    }

    watched.cancel_all();
    drop(watcher);
}

fn create_preferred_watcher(
    factory: &Arc<dyn WatcherFactory>,
    mailbox: &SupervisorMailbox,
    reporter: &mut StatusReporter,
) -> Option<Box<dyn WatchBackend>> {
    match factory.create(WatcherMode::Native, mailbox.clone()) {
        Ok(watcher) => {
            reporter.report(FileWatchState::Active, None);
            Some(watcher)
        }
        Err(_) => match factory.create(WatcherMode::Poll, mailbox.clone()) {
            Ok(watcher) => {
                reporter.report(
                    FileWatchState::Degraded,
                    Some("原生文件监视不可用，已切换到兼容监视模式。"),
                );
                Some(watcher)
            }
            Err(_) => {
                reporter.report(
                    FileWatchState::Disabled,
                    Some("文件监视不可用；切换或重新打开文档可重试。"),
                );
                None
            }
        },
    }
}

fn create_poll_for_parents(
    parents: &HashMap<String, ParentWatch>,
    factory: &Arc<dyn WatcherFactory>,
    mailbox: &SupervisorMailbox,
    reporter: &mut StatusReporter,
) -> Option<Box<dyn WatchBackend>> {
    let mut watcher = match factory.create(WatcherMode::Poll, mailbox.clone()) {
        Ok(watcher) => watcher,
        Err(_) => {
            reporter.report(
                FileWatchState::Disabled,
                Some("文件监视不可用；切换或重新打开文档可重试。"),
            );
            return None;
        }
    };
    if parents
        .values()
        .any(|parent| watcher.watch(&parent.path).is_err())
    {
        drop(watcher);
        reporter.report(
            FileWatchState::Disabled,
            Some("文件监视无权访问当前目录；切换或重新打开文档可重试。"),
        );
        return None;
    }
    reporter.report(
        FileWatchState::Degraded,
        Some("原生文件监视不可用，已切换到兼容监视模式。"),
    );
    Some(watcher)
}

fn notify_handler(
    mailbox: SupervisorMailbox,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |event| {
        mailbox.record_notify(event);
    }
}

fn sync_watches(
    watcher: &mut Option<Box<dyn WatchBackend>>,
    current: &HashMap<String, ParentWatch>,
    next: &HashMap<String, ParentWatch>,
    mailbox: &SupervisorMailbox,
    factory: &Arc<dyn WatcherFactory>,
    reporter: &mut StatusReporter,
) -> Result<(), String> {
    if watcher.is_none() {
        *watcher = create_preferred_watcher(factory, mailbox, reporter);
        if watcher.is_none() {
            return Err("文件监视不可用；切换或重新打开文档可重试。".to_string());
        }
    }
    let operation = (|| -> Result<(), String> {
        let active = watcher.as_mut().expect("watcher was initialized");
        for parent in current.values() {
            if !next.contains_key(&path_key(&parent.path)) {
                active.unwatch(&parent.path)?;
            }
        }
        for (key, parent) in next {
            if !current.contains_key(key) {
                active.watch(&parent.path)?;
            }
        }
        Ok(())
    })();
    if operation.is_ok() {
        match watcher.as_ref().map(|watcher| watcher.mode()) {
            Some(WatcherMode::Native) => reporter.report(FileWatchState::Active, None),
            Some(WatcherMode::Poll) => {
                reporter.report(FileWatchState::Degraded, Some("正在使用兼容文件监视模式。"))
            }
            None => {}
        }
        return Ok(());
    }

    let previous_mode = watcher.as_ref().map(|watcher| watcher.mode());
    drop(watcher.take());
    if previous_mode == Some(WatcherMode::Poll) {
        reporter.report(
            FileWatchState::Disabled,
            Some("兼容文件监视无权访问当前目录；切换或重新打开文档可重试。"),
        );
        return Err("文件监视无权访问当前目录。".to_string());
    }
    *watcher = create_poll_for_parents(next, factory, mailbox, reporter);
    watcher
        .as_ref()
        .map(|_| ())
        .ok_or_else(|| "文件监视无权访问当前目录。".to_string())
}

fn normalized_targets(paths: Vec<String>) -> Result<HashMap<String, WatchedTarget>, String> {
    let mut targets = HashMap::new();
    for path in paths {
        let normalized = normalize_path(Path::new(&path))?;
        let target = PathBuf::from(&normalized);
        let key = path_identity(&target)?;
        let parent = target
            .parent()
            .ok_or_else(|| "文件没有可监视的父目录。".to_string())?;
        let parent_key = path_identity(parent)?;
        targets.insert(
            key,
            WatchedTarget {
                path: target,
                normalized,
                parent_key,
                epoch: 0,
            },
        );
    }
    Ok(targets)
}

fn parent_watches(targets: &HashMap<String, WatchedTarget>) -> HashMap<String, ParentWatch> {
    let mut parents = HashMap::<String, ParentWatch>::new();
    for target in targets.values() {
        let parent = target
            .path
            .parent()
            .expect("normalized target has a parent");
        parents
            .entry(target.parent_key.clone())
            .and_modify(|watch| watch.references += 1)
            .or_insert_with(|| ParentWatch {
                path: parent.to_path_buf(),
                references: 1,
            });
    }
    parents
}

fn matching_target_paths(
    event_paths: &[PathBuf],
    targets: &HashMap<String, WatchedTarget>,
) -> Vec<String> {
    let mut matches = Vec::new();
    for event_path in event_paths {
        let event_key = path_key(event_path);
        if targets.contains_key(&event_key) {
            if !matches.contains(&event_key) {
                matches.push(event_key);
            }
            continue;
        }
        for (target_key, target) in targets {
            if target.parent_key == event_key && !matches.contains(target_key) {
                matches.push(target_key.clone());
            }
        }
    }
    matches
}

fn next_timeout(deadlines: &HashMap<String, (Instant, u64, u64)>) -> Option<Duration> {
    let next = deadlines.values().map(|(deadline, _, _)| *deadline).min()?;
    Some(next.saturating_duration_since(Instant::now()))
}

fn start_due_tasks(watched: &mut WatchedDocuments, mailbox: &SupervisorMailbox) {
    let now = Instant::now();
    let due = watched
        .deadlines
        .extract_if(|_, (deadline, _, _)| *deadline <= now)
        .collect::<Vec<_>>();
    for (key, (_, epoch, generation)) in due {
        let Some(target) = watched.targets.get(&key) else {
            continue;
        };
        if target.epoch != epoch {
            continue;
        }
        let path = target.path.clone();
        let (cancel, cancel_receiver) = watch::channel(false);
        watched.tasks.insert(
            key.clone(),
            StabilityTask {
                epoch,
                generation,
                cancel,
            },
        );
        let mailbox = mailbox.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(outcome) = stabilize_path(&path, cancel_receiver).await {
                mailbox.push_stable(StableMessage {
                    key,
                    epoch,
                    generation,
                    outcome,
                });
            }
        });
    }
}

async fn stabilize_path(
    path: &Path,
    mut cancel: watch::Receiver<bool>,
) -> Option<StabilityOutcome> {
    let mut last_snapshot = None;
    for attempt in 0..STABILITY_ATTEMPTS {
        if *cancel.borrow() {
            return None;
        }
        let first = read_file_snapshot(path).ok();
        if cancelled_sleep(STABILITY_DELAY, &mut cancel).await {
            return None;
        }
        let second = read_file_snapshot(path).ok();
        last_snapshot = second.clone();
        if first
            .as_ref()
            .zip(second.as_ref())
            .is_some_and(|(first, second)| {
                first.revision == second.revision && first.fingerprint == second.fingerprint
            })
            && validate_mdx_path(path).is_ok()
        {
            let snapshot = second.expect("stable snapshot was present");
            return Some(StabilityOutcome {
                revision: Some(snapshot.revision),
                fingerprint: Some(snapshot.fingerprint),
                valid: true,
            });
        }
        if attempt + 1 < STABILITY_ATTEMPTS && cancelled_sleep(STABILITY_DELAY, &mut cancel).await {
            return None;
        }
    }
    Some(StabilityOutcome {
        revision: last_snapshot
            .as_ref()
            .map(|snapshot| snapshot.revision.clone()),
        fingerprint: last_snapshot.map(|snapshot| snapshot.fingerprint),
        valid: false,
    })
}

async fn cancelled_sleep(duration: Duration, cancel: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        result = cancel.changed() => result.is_err() || *cancel.borrow(),
    }
}

fn path_key(path: &Path) -> String {
    path_identity(path).unwrap_or_else(|_| {
        normalize_path(path).unwrap_or_else(|_| path.to_string_lossy().to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tempfile::tempdir;

    #[derive(Clone, Default)]
    struct FakeWatcherFactory {
        events: Arc<Mutex<Vec<String>>>,
        fail_native_create: Arc<AtomicBool>,
        fail_poll_create: Arc<AtomicBool>,
        fail_native_watch: Arc<AtomicBool>,
        fail_poll_watch: Arc<AtomicBool>,
    }

    struct FakeWatcher {
        mode: WatcherMode,
        events: Arc<Mutex<Vec<String>>>,
        fail_watch: Arc<AtomicBool>,
    }

    impl Drop for FakeWatcher {
        fn drop(&mut self) {
            self.events
                .lock()
                .unwrap()
                .push(format!("drop-{}", self.mode.as_str()));
        }
    }

    impl WatchBackend for FakeWatcher {
        fn mode(&self) -> WatcherMode {
            self.mode
        }

        fn watch(&mut self, _path: &Path) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("watch-{}", self.mode.as_str()));
            if self.fail_watch.load(Ordering::Acquire) {
                Err("permission denied".to_string())
            } else {
                Ok(())
            }
        }

        fn unwatch(&mut self, _path: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    impl WatcherFactory for FakeWatcherFactory {
        fn create(
            &self,
            mode: WatcherMode,
            _mailbox: SupervisorMailbox,
        ) -> Result<Box<dyn WatchBackend>, String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("create-{}", mode.as_str()));
            let fail_create = match mode {
                WatcherMode::Native => &self.fail_native_create,
                WatcherMode::Poll => &self.fail_poll_create,
            };
            if fail_create.load(Ordering::Acquire) {
                return Err("create failed".to_string());
            }
            let fail_watch = match mode {
                WatcherMode::Native => Arc::clone(&self.fail_native_watch),
                WatcherMode::Poll => Arc::clone(&self.fail_poll_watch),
            };
            Ok(Box::new(FakeWatcher {
                mode,
                events: Arc::clone(&self.events),
                fail_watch,
            }))
        }
    }

    fn state_receiver(
        factory: FakeWatcherFactory,
    ) -> (DocumentWatchState, mpsc::Receiver<FileWatchStatusPayload>) {
        let (sender, receiver) = mpsc::channel();
        let state = DocumentWatchState::with_runtime(
            |_| {},
            move |status| {
                sender.send(status).unwrap();
            },
            Arc::new(factory),
        );
        (state, receiver)
    }

    fn receive_status(
        receiver: &mpsc::Receiver<FileWatchStatusPayload>,
        expected: FileWatchState,
    ) -> FileWatchStatusPayload {
        loop {
            let status = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
            if status.state == expected {
                return status;
            }
        }
    }

    fn notify_event(path: impl Into<PathBuf>) -> notify::Result<Event> {
        Ok(Event::new(EventKind::Any).add_path(path.into()))
    }

    #[test]
    fn notification_burst_uses_one_bounded_wake_and_overflow_requests_a_rescan() {
        let (mailbox, mut receiver) = SupervisorMailbox::new(2);
        for index in 0..1_000 {
            mailbox.record_notify(notify_event(format!("note-{index}.mdx")));
        }

        let SupervisorInput::Notify(batch) = receiver.take_pending().unwrap() else {
            panic!("expected a merged notify batch");
        };
        assert!(batch.rescan_all);
        assert!(batch.paths.is_empty());
        assert!(receiver.take_pending().is_none());
    }

    #[test]
    fn poll_watcher_reports_same_size_same_mtime_content_changes() {
        let root = tempdir().unwrap();
        let path = root.path().join("poll-content.mdx");
        std::fs::write(&path, b"saved-A").unwrap();
        let original_modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let (mailbox, mut receiver) = SupervisorMailbox::new(4);
        let factory = NotifyWatcherFactory;
        let mut watcher = factory.create(WatcherMode::Poll, mailbox).unwrap();
        watcher.watch(root.path()).unwrap();
        thread::sleep(POLL_INTERVAL + Duration::from_millis(250));
        while receiver.next(Some(Duration::from_millis(10))).is_some() {}

        std::fs::write(&path, b"externB").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();

        let changed = loop {
            let Some(input) = receiver.next(Some(Duration::from_secs(3))) else {
                panic!("poll watcher did not report the content-only change");
            };
            if let SupervisorInput::Notify(batch) = input {
                break batch;
            }
        };
        assert!(changed.rescan_all || changed.paths.iter().any(|item| item == &path));
    }

    #[test]
    fn control_messages_are_taken_before_a_pending_notification_burst() {
        let (mailbox, mut receiver) = SupervisorMailbox::new(2);
        mailbox.record_notify(notify_event("note.mdx"));
        mailbox.push_control(ControlMessage::Shutdown);

        assert!(matches!(
            receiver.take_pending(),
            Some(SupervisorInput::Control(ControlMessage::Shutdown))
        ));
        assert!(matches!(
            receiver.take_pending(),
            Some(SupervisorInput::Notify(_))
        ));
    }

    #[test]
    fn shutdown_is_not_queued_behind_sustained_notify_backlog() {
        let (mailbox, mut receiver) = SupervisorMailbox::new(4);
        for _ in 0..10_000 {
            mailbox.record_notify(notify_event("note.mdx"));
        }
        mailbox.push_control_front(ControlMessage::Shutdown);

        assert!(matches!(
            receiver.take_pending(),
            Some(SupervisorInput::Control(ControlMessage::Shutdown))
        ));
    }

    #[test]
    fn removing_a_path_clears_a_deadline_before_it_becomes_a_task() {
        let root = tempdir().unwrap();
        let path = root.path().join("deadline.mdx");
        let key = path_key(&path);
        let mut watched = WatchedDocuments::default();
        watched.replace_targets(normalized_targets(vec![path.to_string_lossy().into()]).unwrap());
        watched.schedule(&key);
        assert!(watched.deadlines.contains_key(&key));

        watched.replace_targets(HashMap::new());

        assert!(!watched.deadlines.contains_key(&key));
        assert!(!watched.tasks.contains_key(&key));
    }

    #[test]
    fn rapid_close_and_reopen_rejects_an_old_stable_result_without_removing_the_new_task() {
        let root = tempdir().unwrap();
        let path = root.path().join("aba.mdx");
        let key = path_key(&path);
        let mut watched = WatchedDocuments::default();
        watched.replace_targets(normalized_targets(vec![path.to_string_lossy().into()]).unwrap());
        let old_epoch = watched.targets[&key].epoch;
        watched.replace_targets(HashMap::new());
        watched.replace_targets(normalized_targets(vec![path.to_string_lossy().into()]).unwrap());
        let new_epoch = watched.targets[&key].epoch;
        let (cancel, _) = watch::channel(false);
        watched.tasks.insert(
            key.clone(),
            StabilityTask {
                epoch: new_epoch,
                generation: 1,
                cancel,
            },
        );

        assert!(new_epoch > old_epoch);
        assert!(!watched.accepts_stable(&key, old_epoch, 1));
        assert_eq!(watched.tasks[&key].epoch, new_epoch);
    }

    #[test]
    fn workspace_switch_clears_removed_tasks_deadlines_and_echoes() {
        let root = tempdir().unwrap();
        let old_path = root.path().join("old.mdx");
        let next_path = root.path().join("next.mdx");
        let old_key = path_key(&old_path);
        let mut watched = WatchedDocuments::default();
        watched
            .replace_targets(normalized_targets(vec![old_path.to_string_lossy().into()]).unwrap());
        watched.schedule(&old_key);
        watched.suppressor.begin(&old_path);
        watched.suppressor.finish(
            &old_path,
            DiskRevision {
                path: old_key.clone(),
                modified_at_ms: 42,
                size: 7,
            },
            ContentFingerprint::from_bytes(b"old"),
        );

        watched
            .replace_targets(normalized_targets(vec![next_path.to_string_lossy().into()]).unwrap());

        assert!(!watched.targets.contains_key(&old_key));
        assert!(!watched.deadlines.contains_key(&old_key));
        assert!(!watched.tasks.contains_key(&old_key));
        assert!(!watched.suppressor.should_suppress(
            &old_path,
            &DiskRevision {
                path: old_key,
                modified_at_ms: 42,
                size: 7,
            },
            &ContentFingerprint::from_bytes(b"old"),
        ));
    }

    #[test]
    fn dropping_an_unfinished_internal_write_guard_enqueues_cancellation() {
        let (mailbox, mut receiver) = SupervisorMailbox::new(4);
        let state = DocumentWatchState {
            mailbox,
            join: Mutex::new(None),
        };
        let path = PathBuf::from("failed-save.mdx");

        drop(InternalWriteGuard {
            state: &state,
            path: path.clone(),
            finished: false,
        });

        assert!(matches!(
            receiver.take_pending(),
            Some(SupervisorInput::Control(
                ControlMessage::CancelInternalWrite { path: cancelled }
            )) if cancelled == path
        ));
    }

    #[test]
    fn cancelled_write_does_not_accept_a_late_finish_as_an_expected_echo() {
        let path = Path::new("failed-save.mdx");
        let revision = DiskRevision {
            path: "failed-save.mdx".to_string(),
            modified_at_ms: 42,
            size: 7,
        };
        let fingerprint = ContentFingerprint::from_bytes(b"failed save");
        let mut suppressor = EchoSuppressor::default();
        suppressor.begin(path);
        suppressor.cancel(path);
        suppressor.finish(path, revision.clone(), fingerprint.clone());

        assert!(!suppressor.should_suppress(path, &revision, &fingerprint));
    }

    #[test]
    fn native_create_failure_reports_degraded_after_poll_fallback() {
        let factory = FakeWatcherFactory::default();
        factory.fail_native_create.store(true, Ordering::Release);
        let events = Arc::clone(&factory.events);
        let (watch, statuses) = state_receiver(factory);

        let status = receive_status(&statuses, FileWatchState::Degraded);

        assert!(status.message.is_some());
        assert_eq!(
            *events.lock().unwrap(),
            ["create-native".to_string(), "create-poll".to_string()]
        );
        watch.shutdown_now();
    }

    #[test]
    fn permission_watch_failure_drops_native_before_creating_poll() {
        let root = tempdir().unwrap();
        let path = root.path().join("permission.mdx");
        let factory = FakeWatcherFactory::default();
        factory.fail_native_watch.store(true, Ordering::Release);
        let events = Arc::clone(&factory.events);
        let (watch, statuses) = state_receiver(factory);

        watch
            .set_paths(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        receive_status(&statuses, FileWatchState::Degraded);

        let events = events.lock().unwrap();
        let dropped = events
            .iter()
            .position(|event| event == "drop-native")
            .unwrap();
        let poll_created = events
            .iter()
            .position(|event| event == "create-poll")
            .unwrap();
        assert!(dropped < poll_created);
        drop(events);
        watch.shutdown_now();
    }

    #[test]
    fn runtime_error_switches_to_poll_and_emits_degraded_status() {
        let root = tempdir().unwrap();
        let path = root.path().join("runtime.mdx");
        let factory = FakeWatcherFactory::default();
        let events = Arc::clone(&factory.events);
        let (watch, statuses) = state_receiver(factory);
        watch
            .set_paths(vec![path.to_string_lossy().into_owned()])
            .unwrap();

        watch
            .mailbox
            .record_notify(Err(notify::Error::generic("runtime failure")));
        receive_status(&statuses, FileWatchState::Degraded);

        let events = events.lock().unwrap();
        let dropped = events
            .iter()
            .position(|event| event == "drop-native")
            .unwrap();
        let poll_created = events
            .iter()
            .position(|event| event == "create-poll")
            .unwrap();
        assert!(dropped < poll_created);
        drop(events);
        watch.shutdown_now();
    }

    #[test]
    fn failed_native_and_poll_creation_reports_disabled_and_later_set_paths_recovers() {
        let root = tempdir().unwrap();
        let path = root.path().join("recover.mdx");
        let factory = FakeWatcherFactory::default();
        factory.fail_native_create.store(true, Ordering::Release);
        factory.fail_poll_create.store(true, Ordering::Release);
        let (watch, statuses) = state_receiver(factory.clone());
        receive_status(&statuses, FileWatchState::Disabled);

        factory.fail_native_create.store(false, Ordering::Release);
        factory.fail_poll_create.store(false, Ordering::Release);
        watch
            .set_paths(vec![path.to_string_lossy().into_owned()])
            .unwrap();

        receive_status(&statuses, FileWatchState::Active);
        watch.shutdown_now();
    }
}
