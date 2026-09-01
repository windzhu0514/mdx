use crate::workspace::{disk_revision, DiskRevision};
use crate::{normalize_path, path_identity, validate_mdx_path};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

pub const EXTERNAL_FILES_CHANGED_EVENT: &str = "mora://external-files-changed";
const DEBOUNCE_DELAY: Duration = Duration::from_millis(150);
const STABILITY_DELAY: Duration = Duration::from_millis(75);
const STABILITY_ATTEMPTS: usize = 4;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const ECHO_LIFETIME: Duration = Duration::from_secs(5);
const SUPERVISOR_ACK_TIMEOUT: Duration = Duration::from_secs(2);

type EmitPaths = Arc<dyn Fn(Vec<String>) + Send + Sync>;

#[derive(Debug)]
enum EchoState {
    InFlight {
        expires_at: Instant,
    },
    Expected {
        revision: DiskRevision,
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

    pub fn finish(&mut self, path: &Path, revision: DiskRevision) {
        self.prune();
        let key = path_key(path);
        if matches!(self.entries.get(&key), Some(EchoState::InFlight { .. })) {
            self.entries.insert(
                key,
                EchoState::Expected {
                    revision,
                    expires_at: Instant::now() + ECHO_LIFETIME,
                },
            );
        }
    }

    pub fn cancel(&mut self, path: &Path) {
        self.entries.remove(&path_key(path));
    }

    pub fn should_suppress(&mut self, path: &Path, revision: &DiskRevision) -> bool {
        self.prune();
        let key = path_key(path);
        let suppress = matches!(
            self.entries.get(&key),
            Some(EchoState::Expected {
                revision: expected,
                ..
            }) if expected == revision
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

pub struct DocumentWatchState {
    sender: Sender<SupervisorMessage>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl DocumentWatchState {
    pub fn new(app: AppHandle) -> Self {
        Self::with_emitter(move |paths| {
            let _ = app.emit(
                EXTERNAL_FILES_CHANGED_EVENT,
                ExternalFilesChangedPayload { paths },
            );
        })
    }

    #[doc(hidden)]
    pub fn with_emitter<F>(emit: F) -> Self
    where
        F: Fn(Vec<String>) + Send + Sync + 'static,
    {
        let (sender, receiver) = mpsc::channel();
        let supervisor_sender = sender.clone();
        let emit: EmitPaths = Arc::new(emit);
        let join = thread::Builder::new()
            .name("mora-file-watch".to_string())
            .spawn(move || run_supervisor(receiver, supervisor_sender, emit))
            .expect("failed to start Mora file watcher");
        Self {
            sender,
            join: Mutex::new(Some(join)),
        }
    }

    pub fn set_paths(&self, paths: Vec<String>) -> Result<(), String> {
        let (acknowledge, result) = mpsc::sync_channel(0);
        self.sender
            .send(SupervisorMessage::SetPaths { paths, acknowledge })
            .map_err(|_| "文件监视任务已停止。".to_string())?;
        result
            .recv_timeout(SUPERVISOR_ACK_TIMEOUT)
            .map_err(|_| "文件监视任务已停止。".to_string())?
    }

    pub fn begin_internal_write(&self, path: &Path) -> InternalWriteGuard<'_> {
        let path = path.to_path_buf();
        let (acknowledge, acknowledged) = mpsc::sync_channel(0);
        if self
            .sender
            .send(SupervisorMessage::BeginInternalWrite {
                path: path.clone(),
                acknowledge,
            })
            .is_ok()
        {
            let _ = acknowledged.recv_timeout(SUPERVISOR_ACK_TIMEOUT);
        }
        InternalWriteGuard {
            state: self,
            path,
            finished: false,
        }
    }

    pub fn shutdown_now(&self) {
        let join = self.join.lock().ok().and_then(|mut join| join.take());
        if let Some(join) = join {
            let _ = self.sender.send(SupervisorMessage::Shutdown);
            let _ = join.join();
        }
    }
}

impl Drop for DocumentWatchState {
    fn drop(&mut self) {
        let join = self.join.get_mut().ok().and_then(Option::take);
        if let Some(join) = join {
            let _ = self.sender.send(SupervisorMessage::Shutdown);
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
    pub fn finish(mut self, revision: DiskRevision) {
        let _ = self.sender().send(SupervisorMessage::FinishInternalWrite {
            path: self.path.clone(),
            revision,
        });
        self.finished = true;
    }

    fn sender(&self) -> &Sender<SupervisorMessage> {
        &self.state.sender
    }
}

impl Drop for InternalWriteGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self
                .state
                .sender
                .send(SupervisorMessage::CancelInternalWrite {
                    path: self.path.clone(),
                });
        }
    }
}

#[derive(Clone, Serialize)]
struct ExternalFilesChangedPayload {
    paths: Vec<String>,
}

enum SupervisorMessage {
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
    },
    CancelInternalWrite {
        path: PathBuf,
    },
    Notify(notify::Result<Event>),
    Stable {
        key: String,
        generation: u64,
        outcome: StabilityOutcome,
    },
    Shutdown,
}

struct WatchedTarget {
    path: PathBuf,
    normalized: String,
    parent_key: String,
}

struct ParentWatch {
    path: PathBuf,
    references: usize,
}

struct StabilityTask {
    generation: u64,
    cancel: watch::Sender<bool>,
}

struct StabilityOutcome {
    revision: Option<DiskRevision>,
    valid: bool,
}

enum ActiveWatcher {
    Native(RecommendedWatcher),
    Poll(PollWatcher),
}

impl ActiveWatcher {
    fn is_native(&self) -> bool {
        matches!(self, Self::Native(_))
    }

    fn watch(&mut self, path: &Path) -> notify::Result<()> {
        match self {
            Self::Native(watcher) => watcher.watch(path, RecursiveMode::NonRecursive),
            Self::Poll(watcher) => watcher.watch(path, RecursiveMode::NonRecursive),
        }
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        match self {
            Self::Native(watcher) => watcher.unwatch(path),
            Self::Poll(watcher) => watcher.unwatch(path),
        }
    }
}

fn run_supervisor(
    receiver: Receiver<SupervisorMessage>,
    sender: Sender<SupervisorMessage>,
    emit: EmitPaths,
) {
    let mut watcher = create_initial_watcher(&sender).ok();
    let mut targets = HashMap::<String, WatchedTarget>::new();
    let mut parents = HashMap::<String, ParentWatch>::new();
    let mut deadlines = HashMap::<String, (Instant, u64)>::new();
    let mut generations = HashMap::<String, u64>::new();
    let mut tasks = HashMap::<String, StabilityTask>::new();
    let mut suppressor = EchoSuppressor::default();

    loop {
        let message = match next_timeout(&deadlines) {
            Some(timeout) => match receiver.recv_timeout(timeout) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match receiver.recv() {
                Ok(message) => Some(message),
                Err(_) => break,
            },
        };

        if let Some(message) = message {
            match message {
                SupervisorMessage::SetPaths { paths, acknowledge } => {
                    let result = normalized_targets(paths).and_then(|next_targets| {
                        let next_parents = parent_watches(&next_targets);
                        sync_watches(&mut watcher, &parents, &next_parents, &sender)?;
                        for (key, task) in
                            tasks.extract_if(|key, _| !next_targets.contains_key(key))
                        {
                            let _ = task.cancel.send(true);
                            deadlines.remove(&key);
                            generations.remove(&key);
                        }
                        targets = next_targets;
                        parents = next_parents;
                        Ok(())
                    });
                    let _ = acknowledge.send(result);
                }
                SupervisorMessage::BeginInternalWrite { path, acknowledge } => {
                    suppressor.begin(&path);
                    let _ = acknowledge.send(());
                }
                SupervisorMessage::FinishInternalWrite { path, revision } => {
                    suppressor.finish(&path, revision);
                }
                SupervisorMessage::CancelInternalWrite { path } => suppressor.cancel(&path),
                SupervisorMessage::Notify(Ok(event)) => {
                    if !matches!(event.kind, EventKind::Access(_)) {
                        for key in matching_targets(&event, &targets) {
                            schedule_target(&key, &mut deadlines, &mut generations, &mut tasks);
                        }
                    }
                }
                SupervisorMessage::Notify(Err(_)) => {
                    if watcher.as_ref().is_some_and(ActiveWatcher::is_native) {
                        watcher = switch_to_poll(&parents, &sender).ok();
                    }
                }
                SupervisorMessage::Stable {
                    key,
                    generation,
                    outcome,
                } => {
                    if tasks.get(&key).map(|task| task.generation) != Some(generation) {
                        continue;
                    }
                    tasks.remove(&key);
                    let Some(target) = targets.get(&key) else {
                        continue;
                    };
                    if outcome.valid
                        && outcome.revision.as_ref().is_some_and(|revision| {
                            suppressor.should_suppress(&target.path, revision)
                        })
                    {
                        continue;
                    }
                    emit(vec![target.normalized.clone()]);
                }
                SupervisorMessage::Shutdown => break,
            }
        }

        start_due_tasks(&mut deadlines, &targets, &mut tasks, &sender);
    }

    for (_, task) in tasks {
        let _ = task.cancel.send(true);
    }
    drop(watcher);
}

fn create_initial_watcher(sender: &Sender<SupervisorMessage>) -> notify::Result<ActiveWatcher> {
    match notify::recommended_watcher(notify_handler(sender.clone())) {
        Ok(watcher) => Ok(ActiveWatcher::Native(watcher)),
        Err(_) => create_poll_watcher(sender),
    }
}

fn create_poll_watcher(sender: &Sender<SupervisorMessage>) -> notify::Result<ActiveWatcher> {
    PollWatcher::new(
        notify_handler(sender.clone()),
        Config::default().with_poll_interval(POLL_INTERVAL),
    )
    .map(ActiveWatcher::Poll)
}

fn notify_handler(
    sender: Sender<SupervisorMessage>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |event| {
        let _ = sender.send(SupervisorMessage::Notify(event));
    }
}

fn sync_watches(
    watcher: &mut Option<ActiveWatcher>,
    current: &HashMap<String, ParentWatch>,
    next: &HashMap<String, ParentWatch>,
    sender: &Sender<SupervisorMessage>,
) -> Result<(), String> {
    if watcher.is_none() {
        *watcher = Some(create_initial_watcher(sender).map_err(|error| error.to_string())?);
    }
    let operation = (|| -> notify::Result<()> {
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
        return Ok(());
    }

    *watcher = None;
    *watcher = Some(switch_to_poll(next, sender)?);
    Ok(())
}

fn switch_to_poll(
    parents: &HashMap<String, ParentWatch>,
    sender: &Sender<SupervisorMessage>,
) -> Result<ActiveWatcher, String> {
    let mut watcher = create_poll_watcher(sender).map_err(|error| error.to_string())?;
    for parent in parents.values() {
        watcher
            .watch(&parent.path)
            .map_err(|error| error.to_string())?;
    }
    Ok(watcher)
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

fn matching_targets(event: &Event, targets: &HashMap<String, WatchedTarget>) -> Vec<String> {
    let mut matches = Vec::new();
    for event_path in &event.paths {
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

fn schedule_target(
    key: &str,
    deadlines: &mut HashMap<String, (Instant, u64)>,
    generations: &mut HashMap<String, u64>,
    tasks: &mut HashMap<String, StabilityTask>,
) {
    if let Some(task) = tasks.remove(key) {
        let _ = task.cancel.send(true);
    }
    let generation = generations.entry(key.to_string()).or_default();
    *generation += 1;
    deadlines.insert(
        key.to_string(),
        (Instant::now() + DEBOUNCE_DELAY, *generation),
    );
}

fn next_timeout(deadlines: &HashMap<String, (Instant, u64)>) -> Option<Duration> {
    let next = deadlines.values().map(|(deadline, _)| *deadline).min()?;
    Some(next.saturating_duration_since(Instant::now()))
}

fn start_due_tasks(
    deadlines: &mut HashMap<String, (Instant, u64)>,
    targets: &HashMap<String, WatchedTarget>,
    tasks: &mut HashMap<String, StabilityTask>,
    sender: &Sender<SupervisorMessage>,
) {
    let now = Instant::now();
    let due = deadlines
        .extract_if(|_, (deadline, _)| *deadline <= now)
        .collect::<Vec<_>>();
    for (key, (_, generation)) in due {
        let Some(target) = targets.get(&key) else {
            continue;
        };
        let path = target.path.clone();
        let (cancel, cancel_receiver) = watch::channel(false);
        tasks.insert(key.clone(), StabilityTask { generation, cancel });
        let sender = sender.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(outcome) = stabilize_path(&path, cancel_receiver).await {
                let _ = sender.send(SupervisorMessage::Stable {
                    key,
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
    let mut last_revision = None;
    for attempt in 0..STABILITY_ATTEMPTS {
        if *cancel.borrow() {
            return None;
        }
        let first = disk_revision(path);
        if cancelled_sleep(STABILITY_DELAY, &mut cancel).await {
            return None;
        }
        let second = disk_revision(path);
        last_revision = second.revision.clone();
        if first.available
            && second.available
            && first.revision.is_some()
            && first.revision == second.revision
            && validate_mdx_path(path).is_ok()
        {
            return Some(StabilityOutcome {
                revision: second.revision,
                valid: true,
            });
        }
        if attempt + 1 < STABILITY_ATTEMPTS && cancelled_sleep(STABILITY_DELAY, &mut cancel).await {
            return None;
        }
    }
    Some(StabilityOutcome {
        revision: last_revision,
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
