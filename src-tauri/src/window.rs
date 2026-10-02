use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Emitter, Manager, WebviewWindowBuilder,
};

use crate::{
    error::{AppError, Result},
    resources,
};

const TRANSFER_LIMIT: usize = 256 * 1024 * 1024;
const TRANSFER_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct WindowState {
    pub next_window: Mutex<u64>,
    pub focused: Mutex<String>,
    pub pending: Mutex<HashMap<String, WindowInit>>,
    transfers: Mutex<TransferStore>,
    quit: Mutex<QuitVotes>,
}

impl WindowState {
    pub fn new(initial_files: Vec<String>) -> Self {
        Self {
            focused: Mutex::new("main".into()),
            pending: Mutex::new(HashMap::from([(
                "main".into(),
                WindowInit {
                    files: initial_files,
                    transfer_token: None,
                },
            )])),
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInit {
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpenOptions {
    pub files: Option<Vec<String>>,
    pub transfer_token: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

struct Transfer {
    source: String,
    target: Option<String>,
    body: Option<Vec<u8>>,
    accepted: bool,
    expires: Instant,
}

// 数据与字节计数在同一把锁内；take 释放内容，但保留接收凭据直到源确认或取消。
#[derive(Default)]
struct TransferStore {
    entries: HashMap<String, Transfer>,
    bytes: usize,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatus {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPlacement {
    index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    before_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferOffer {
    token: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    placement: Option<TransferPlacement>,
}

fn invalid_transfer() -> AppError {
    AppError::InvalidArgument(
        "transfer token is invalid, expired, or belongs to another window".into(),
    )
}

impl TransferStore {
    fn expire(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            if entry.expires <= now {
                self.bytes = self
                    .bytes
                    .saturating_sub(entry.body.as_ref().map_or(0, Vec::len));
                false
            } else {
                true
            }
        });
    }

    fn put(&mut self, source: &str, body: Vec<u8>, now: Instant) -> Result<String> {
        self.expire(now);
        if body.len().saturating_add(self.bytes) > TRANSFER_LIMIT {
            return Err(AppError::InvalidArgument(
                "tab transfer capacity exceeds 256 MiB".into(),
            ));
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.bytes += body.len();
        self.entries.insert(
            token.clone(),
            Transfer {
                source: source.to_owned(),
                target: None,
                body: Some(body),
                accepted: false,
                expires: now + TRANSFER_TTL,
            },
        );
        Ok(token)
    }

    fn bind(&mut self, token: &str, source: &str, target: &str, now: Instant) -> Result<()> {
        self.expire(now);
        let entry = self.entries.get_mut(token).ok_or_else(invalid_transfer)?;
        if entry.source != source || entry.target.is_some() || source == target {
            return Err(invalid_transfer());
        }
        entry.target = Some(target.to_owned());
        Ok(())
    }

    fn take(&mut self, token: &str, target: &str, now: Instant) -> Result<Vec<u8>> {
        self.expire(now);
        let entry = self.entries.get_mut(token).ok_or_else(invalid_transfer)?;
        if entry.target.as_deref() != Some(target) {
            return Err(invalid_transfer());
        }
        let body = entry.body.take().ok_or_else(invalid_transfer)?;
        self.bytes = self.bytes.saturating_sub(body.len());
        Ok(body)
    }

    fn accept(&mut self, token: &str, target: &str, now: Instant) -> Result<()> {
        self.expire(now);
        let entry = self.entries.get_mut(token).ok_or_else(invalid_transfer)?;
        if entry.target.as_deref() != Some(target) || entry.body.is_some() {
            return Err(invalid_transfer());
        }
        entry.accepted = true;
        Ok(())
    }

    fn status(&mut self, token: &str, source: &str, now: Instant) -> Result<TransferStatus> {
        self.expire(now);
        let Some(entry) = self.entries.get(token) else {
            return Ok(TransferStatus {
                state: "missing",
                target: None,
            });
        };
        if entry.source != source {
            return Err(invalid_transfer());
        }
        Ok(TransferStatus {
            state: if entry.accepted {
                "accepted"
            } else if entry.body.is_none() {
                "taken"
            } else {
                "pending"
            },
            target: entry.target.clone(),
        })
    }

    fn remove(&mut self, token: &str) {
        if let Some(entry) = self.entries.remove(token) {
            self.bytes = self
                .bytes
                .saturating_sub(entry.body.as_ref().map_or(0, Vec::len));
        }
    }

    fn cancel(&mut self, token: &str, source: &str) -> Result<()> {
        if self
            .entries
            .get(token)
            .is_some_and(|entry| entry.source != source)
        {
            return Err(invalid_transfer());
        }
        self.remove(token);
        Ok(())
    }

    fn reject(&mut self, token: &str, target: &str) -> Result<()> {
        if self
            .entries
            .get(token)
            .is_some_and(|entry| entry.target.as_deref() != Some(target))
        {
            return Err(invalid_transfer());
        }
        self.remove(token);
        Ok(())
    }

    fn close_window(&mut self, label: &str) {
        let tokens: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.source == label || entry.target.as_deref() == Some(label))
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            self.remove(&token);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitRequest {
    request_id: String,
}

struct QuitSession {
    request: QuitRequest,
    pending: HashSet<String>,
    participants: HashSet<String>,
}

#[derive(Default)]
struct QuitVotes {
    session: Option<QuitSession>,
    creating: HashSet<String>,
}

enum Vote {
    Pending,
    Approved(QuitRequest),
    Cancelled(QuitRequest),
}

impl QuitVotes {
    fn begin(&mut self, labels: impl IntoIterator<Item = String>) -> Option<QuitRequest> {
        if self.session.is_some() {
            return None;
        }
        let pending: HashSet<_> = labels
            .into_iter()
            .chain(self.creating.iter().cloned())
            .collect();
        if pending.is_empty() {
            return None;
        }
        let request = QuitRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
        };
        self.session = Some(QuitSession {
            request: request.clone(),
            participants: pending.clone(),
            pending,
        });
        Some(request)
    }

    fn init_window(&mut self, label: &str) -> Option<QuitRequest> {
        let session = self.session.as_mut()?;
        if session.participants.insert(label.to_owned()) {
            session.pending.insert(label.to_owned());
        }
        Some(session.request.clone())
    }

    fn reply(&mut self, id: &str, label: &str, allow: bool) -> Vote {
        let Some(session) = self.session.as_mut() else {
            return Vote::Pending;
        };
        if session.request.request_id != id || !session.pending.contains(label) {
            return Vote::Pending;
        }
        if !allow {
            return Vote::Cancelled(self.session.take().unwrap().request);
        }
        session.pending.remove(label);
        if session.pending.is_empty() {
            Vote::Approved(self.session.take().unwrap().request)
        } else {
            Vote::Pending
        }
    }
}

pub fn initial_files(args: &[String], cwd: &std::path::Path) -> Vec<String> {
    resources::open_files(args, cwd)
}

pub fn focused_label(focused: &str, labels: &[String]) -> Option<String> {
    if labels.iter().any(|label| label == focused) {
        return Some(focused.to_owned());
    }
    if labels.iter().any(|label| label == "main") {
        return Some("main".into());
    }
    labels.iter().min().cloned()
}

fn next_label(state: &WindowState) -> Result<String> {
    let mut next = state
        .next_window
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?;
    *next += 1;
    Ok(format!("win-{}", *next))
}

// 只能在 async command/独立线程中调用，Windows WebView2 在同步 UI 命令中建窗会死锁。
pub fn create_window(
    app: &tauri::AppHandle,
    opts: WindowOpenOptions,
    source: &str,
) -> Result<String> {
    let state = app.state::<WindowState>();
    let label = next_label(&state)?;
    let mut config =
        app.config().app.windows.first().cloned().ok_or_else(|| {
            AppError::InvalidArgument("main window configuration is missing".into())
        })?;
    config.label = label.clone();
    config.visible = false;
    config.maximized = false;
    crate::window_state::configure_new_window(app, &mut config, opts.x.zip(opts.y))?;
    let mut builder = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|err| AppError::InvalidArgument(err.to_string()))?;
    if let (Some(x), Some(y)) = (opts.x, opts.y) {
        if !x.is_finite() || !y.is_finite() {
            return Err(AppError::InvalidArgument("invalid window position".into()));
        }
        builder = builder.position(x, y);
    }
    {
        // quit.begin 在同一把锁下同时取已建窗口和 creating，不能漏掉 build 尚未完成的窗口。
        let mut votes = state
            .quit
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        if votes.session.is_some() {
            return Err(AppError::InvalidArgument(
                "application is waiting for quit confirmation".into(),
            ));
        }
        votes.creating.insert(label.clone());
    }
    let mut keep_failed_window = false;
    let result = (|| -> Result<()> {
        app.state::<crate::startup::StartupState>()
            .register(&label)?;
        if let Some(token) = opts.transfer_token.as_ref() {
            state
                .transfers
                .lock()
                .map_err(|err| AppError::Channel(err.to_string()))?
                .bind(token, source, &label, Instant::now())?;
        }
        state
            .pending
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?
            .insert(
                label.clone(),
                WindowInit {
                    files: opts.files.unwrap_or_default(),
                    transfer_token: opts.transfer_token,
                },
            );
        let window = builder
            .build()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        // Builder sizes already use the intended shadow insets, so no second set_size
        // is needed. Normalize the hidden client frame before its frontend lays out.
        crate::startup::watch(&window);
        if let Err(error) = crate::window_state::prepare_hidden_frame(&window) {
            if let Err(destroy_error) = window.destroy() {
                // Keep this window tracked until its visible error fallback is closed.
                // The existing watchdog remains installed if reporting itself fails.
                keep_failed_window = true;
                let message = format!(
                    "silk book could not prepare this window / 无法初始化此窗口\n{error}\n{destroy_error}"
                );
                let _ = app.run_on_main_thread(move || crate::startup::fail(&window, &message));
            }
            return Err(AppError::Channel(error.to_string()));
        }
        Ok(())
    })();
    let cancelled = state.quit.lock().ok().and_then(|mut votes| {
        votes.creating.remove(&label);
        if result.is_ok() {
            return None;
        }
        let id = votes
            .session
            .as_ref()
            .map(|session| session.request.request_id.clone());
        id.map(|id| votes.reply(&id, &label, false))
    });
    if let Some(Vote::Cancelled(request)) = cancelled {
        let _ = app.emit("quit-cancelled", request);
    }
    if let Err(err) = result {
        if !keep_failed_window {
            app.state::<crate::startup::StartupState>().closed(&label);
        }
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&label);
        }
        if let Ok(mut transfers) = state.transfers.lock() {
            transfers.close_window(&label);
        }
        return Err(err);
    }
    Ok(label)
}

#[tauri::command]
pub async fn window_open(
    opts: WindowOpenOptions,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String> {
    create_window(&app, opts, window.label())
}

#[cfg(any(windows, target_os = "macos", test))]
fn drop_label_for_root(
    root: usize,
    windows: impl IntoIterator<Item = (String, usize)>,
) -> Option<String> {
    if root == 0 {
        return None;
    }
    windows
        .into_iter()
        .find_map(|(label, handle)| (handle == root).then_some(label))
}

#[cfg(target_os = "macos")]
fn macos_drop_target(app: &tauri::AppHandle) -> Result<Option<String>> {
    use std::ffi::{c_char, c_void};

    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    type Object = *mut c_void;
    type Selector = *mut c_void;
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Selector;
        fn objc_msgSend();
    }

    // This function is dispatched to AppKit's main thread. Using its live cursor location
    // keeps Cocoa's screen coordinates intact on mixed-DPI displays and during mouse capture.
    // SAFETY: Classes/selectors are NUL-terminated static names. Each typed objc_msgSend
    // signature matches the corresponding AppKit method, on both 64-bit macOS architectures.
    unsafe {
        let event_class = objc_getClass(b"NSEvent\0".as_ptr().cast());
        let window_class = objc_getClass(b"NSWindow\0".as_ptr().cast());
        if event_class.is_null() || window_class.is_null() {
            return Err(AppError::Channel(
                "AppKit window classes unavailable".into(),
            ));
        }
        let mouse_location: unsafe extern "C" fn(Object, Selector) -> Point =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let hit_test: unsafe extern "C" fn(Object, Selector, Point, isize) -> isize =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let window_number: unsafe extern "C" fn(Object, Selector) -> isize =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let point = mouse_location(
            event_class,
            sel_registerName(b"mouseLocation\0".as_ptr().cast()),
        );
        let root = hit_test(
            window_class,
            sel_registerName(
                b"windowNumberAtPoint:belowWindowWithWindowNumber:\0"
                    .as_ptr()
                    .cast(),
            ),
            point,
            0,
        );
        if root <= 0 {
            return Ok(None);
        }
        let number_selector = sel_registerName(b"windowNumber\0".as_ptr().cast());
        let windows = app
            .webview_windows()
            .into_iter()
            .filter_map(|(label, window)| {
                // Tauri keeps each borrowed NSWindow alive while this window handle exists.
                let native = window.ns_window().ok()?;
                if native.is_null() {
                    return None;
                }
                let number = window_number(native, number_selector);
                (number > 0).then_some((label, number as usize))
            });
        Ok(drop_label_for_root(root as usize, windows))
    }
}

// WindowFromPoint 无视鼠标捕获，识别真正位于屏幕点上方的 HWND，防止拖进被遮挡的窗口。
#[tauri::command]
pub async fn window_drop_target(x: i32, y: i32, app: tauri::AppHandle) -> Result<Option<String>> {
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::POINT,
            UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT},
        };
        let root = unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) };
        let windows = app
            .webview_windows()
            .into_iter()
            .filter_map(|(label, window)| {
                window.hwnd().ok().map(|handle| (label, handle.0 as usize))
            });
        Ok(drop_label_for_root(root.0 as usize, windows))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (x, y);
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        let native_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = sent.send(macos_drop_target(&native_app));
        })
        .map_err(|error| AppError::Channel(error.to_string()))?;
        tauri::async_runtime::spawn_blocking(move || {
            received
                .recv()
                .map_err(|error| AppError::Channel(error.to_string()))?
        })
        .await
        .map_err(|error| AppError::Channel(error.to_string()))?
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (x, y, app);
        Ok(None)
    }
}

#[tauri::command]
pub fn window_init(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowState>,
) -> Result<WindowInit> {
    let init = state
        .pending
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .remove(window.label())
        .unwrap_or_default();
    // 初始化前尚未订阅 quit-requested 的窗口在这里补收同一次请求。
    let request = state
        .quit
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .init_window(window.label());
    if let Some(request) = request {
        app.emit_to(
            tauri::EventTarget::webview_window(window.label()),
            "quit-requested",
            request,
        )
        .map_err(|err| AppError::Channel(err.to_string()))?;
    }
    Ok(init)
}

#[tauri::command]
pub fn tab_transfer_put(
    request: Request<'_>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowState>,
) -> Result<String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => {
            return Err(AppError::InvalidArgument(
                "tab_transfer_put requires a raw Uint8Array body".into(),
            ))
        }
    };
    state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .put(window.label(), body, Instant::now())
}

#[tauri::command]
pub fn tab_transfer_take(
    token: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowState>,
) -> Result<Response> {
    let body = state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .take(&token, window.label(), Instant::now())?;
    Ok(Response::new(body))
}

#[tauri::command]
pub fn tab_transfer_send(
    token: String,
    target: String,
    placement: Option<TransferPlacement>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowState>,
) -> Result<()> {
    if target == window.label() || app.get_webview_window(&target).is_none() {
        return Err(AppError::InvalidArgument(
            "destination window is unavailable".into(),
        ));
    }
    if !app
        .state::<crate::startup::StartupState>()
        .is_ready(&target)
    {
        return Err(AppError::InvalidArgument(
            "destination window is not visible and ready".into(),
        ));
    }
    {
        // 与退出状态同步；尚未订阅移入事件/未完成初始化的窗口不能接受迁移。
        let votes = state
            .quit
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        if votes.session.is_some()
            || state
                .pending
                .lock()
                .map_err(|err| AppError::Channel(err.to_string()))?
                .contains_key(&target)
        {
            return Err(AppError::InvalidArgument(
                "destination window is not ready to receive a tab".into(),
            ));
        }
        state
            .transfers
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?
            .bind(&token, window.label(), &target, Instant::now())?;
    }
    let offer = TransferOffer {
        token: token.clone(),
        source: window.label().to_owned(),
        placement,
    };
    if let Err(err) = app.emit_to(
        tauri::EventTarget::webview_window(&target),
        "tab-transfer-offered",
        offer,
    ) {
        if let Ok(mut transfers) = state.transfers.lock() {
            let _ = transfers.cancel(&token, window.label());
        }
        return Err(AppError::Channel(err.to_string()));
    }
    Ok(())
}

#[tauri::command]
pub fn tab_transfer_accept(
    token: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowState>,
) -> Result<()> {
    if !window
        .app_handle()
        .state::<crate::startup::StartupState>()
        .is_ready(window.label())
        || !window
            .is_visible()
            .map_err(|err| AppError::Channel(err.to_string()))?
    {
        return Err(AppError::InvalidArgument(
            "destination window is not visible and ready".into(),
        ));
    }
    state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .accept(&token, window.label(), Instant::now())
}

#[tauri::command]
pub fn tab_transfer_status(
    token: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowState>,
) -> Result<TransferStatus> {
    let mut transfers = state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?;
    let status = transfers.status(&token, window.label(), Instant::now())?;
    if status
        .target
        .as_ref()
        .is_some_and(|target| app.get_webview_window(target).is_none())
    {
        transfers.remove(&token);
        return Ok(TransferStatus {
            state: "missing",
            target: None,
        });
    }
    Ok(status)
}

#[tauri::command]
pub fn tab_transfer_cancel(
    token: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowState>,
) -> Result<()> {
    state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .cancel(&token, window.label())
}

#[tauri::command]
pub fn tab_transfer_reject(
    token: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, WindowState>,
) -> Result<()> {
    state
        .transfers
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .reject(&token, window.label())
}

#[tauri::command]
pub fn app_request_quit(app: tauri::AppHandle, state: tauri::State<'_, WindowState>) -> Result<()> {
    // Failed startup windows have no editable/accepted documents or usable frontend voter.
    // Closing their error view here keeps a later native Quit from waiting forever for JS.
    let startup = app.state::<crate::startup::StartupState>();
    let windows = app.webview_windows();
    for (label, window) in windows {
        if startup.is_failed(&label) {
            window
                .destroy()
                .map_err(|error| AppError::Channel(error.to_string()))?;
        }
    }
    let request = {
        let mut votes = state
            .quit
            .lock()
            .map_err(|err| AppError::Channel(err.to_string()))?;
        // Snapshot completed windows under the same lock as `creating`: a builder cannot
        // disappear from creating between this live snapshot and begin's participants.
        let labels = app
            .webview_windows()
            .into_keys()
            .filter(|label| !startup.is_failed(label));
        votes.begin(labels)
    };
    if let Some(request) = request {
        app.emit("quit-requested", request)
            .map_err(|err| AppError::Channel(err.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn app_quit_reply(
    request_id: String,
    allow: bool,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, WindowState>,
) -> Result<()> {
    let vote = state
        .quit
        .lock()
        .map_err(|err| AppError::Channel(err.to_string()))?
        .reply(&request_id, window.label(), allow);
    match vote {
        Vote::Pending => Ok(()),
        Vote::Approved(request) => app
            .emit("quit-approved", request)
            .map_err(|err| AppError::Channel(err.to_string())),
        Vote::Cancelled(request) => app
            .emit("quit-cancelled", request)
            .map_err(|err| AppError::Channel(err.to_string())),
    }
}

pub fn closed(app: &tauri::AppHandle, label: &str) {
    app.state::<crate::startup::StartupState>().closed(label);
    let state = app.state::<WindowState>();
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(label);
    }
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.close_window(label);
    }
    let labels: Vec<_> = app
        .webview_windows()
        .into_keys()
        .filter(|existing| existing != label)
        .collect();
    if let Ok(mut focused) = state.focused.lock() {
        if *focused == label {
            *focused = focused_label("", &labels).unwrap_or_default();
        }
    }
    let vote = state.quit.lock().ok().and_then(|mut votes| {
        let id = votes
            .session
            .as_ref()
            .map(|session| session.request.request_id.clone());
        id.map(|id| votes.reply(&id, label, false))
    });
    if let Some(Vote::Cancelled(request)) = vote {
        let _ = app.emit("quit-cancelled", request);
    }
}

pub fn cancel_failed_startup(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<WindowState>();
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.close_window(label);
    };
    // A missing JS module cannot replay or reject its pending vote. Unfreeze healthy
    // windows as soon as the visible failure fallback replaces this pending participant.
    let cancelled = state.quit.lock().ok().and_then(|mut votes| {
        let id = votes
            .session
            .as_ref()
            .map(|session| session.request.request_id.clone());
        id.map(|id| votes.reply(&id, label, false))
    });
    if let Some(Vote::Cancelled(request)) = cancelled {
        let _ = app.emit("quit-cancelled", request);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_is_not_accepted_until_receiver_finishes_and_only_bound_window_can_take() {
        let now = Instant::now();
        let mut store = TransferStore::default();
        let token = store.put("main", b"unsaved draft".to_vec(), now).unwrap();
        store.bind(&token, "main", "win-1", now).unwrap();
        assert!(store.take(&token, "win-2", now).is_err());
        assert!(store.accept(&token, "win-1", now).is_err());
        assert_eq!(store.status(&token, "main", now).unwrap().state, "pending");
        assert_eq!(store.take(&token, "win-1", now).unwrap(), b"unsaved draft");
        assert_eq!(store.bytes, 0);
        assert!(store.take(&token, "win-1", now).is_err());
        assert!(store.accept(&token, "win-2", now).is_err());
        assert_eq!(store.status(&token, "main", now).unwrap().state, "taken");
        store.accept(&token, "win-1", now).unwrap();
        assert_eq!(store.status(&token, "main", now).unwrap().state, "accepted");
        assert!(store.status(&token, "win-2", now).is_err());
    }

    #[test]
    fn closed_target_or_timeout_revokes_receipt_and_source_retains_ownership() {
        let now = Instant::now();
        let mut store = TransferStore::default();
        let token = store.put("main", vec![1, 2, 3], now).unwrap();
        store.bind(&token, "main", "win-1", now).unwrap();
        store.take(&token, "win-1", now).unwrap();
        store.accept(&token, "win-1", now).unwrap();
        store.close_window("win-1");
        assert_eq!(store.status(&token, "main", now).unwrap().state, "missing");
        let token = store.put("main", vec![1, 2, 3], now).unwrap();
        assert!(store.cancel(&token, "win-2").is_err());
        assert_eq!(
            store
                .status(&token, "main", now + TRANSFER_TTL)
                .unwrap()
                .state,
            "missing"
        );
        assert_eq!(store.bytes, 0);
    }

    #[test]
    fn failed_transfer_cleans_capacity_and_cannot_be_bound_twice() {
        let now = Instant::now();
        let mut store = TransferStore::default();
        let token = store.put("main", vec![0; 10], now).unwrap();
        assert!(store.bind(&token, "win-2", "win-1", now).is_err());
        store.bind(&token, "main", "win-1", now).unwrap();
        assert!(store.bind(&token, "main", "win-2", now).is_err());
        store.close_window("win-1");
        assert_eq!(store.bytes, 0);
        store.bytes = TRANSFER_LIMIT;
        assert!(store.put("main", vec![1], now).is_err());
    }

    #[test]
    fn only_bound_recipient_can_reject_existing_window_offer_and_capacity_is_released() {
        let now = Instant::now();
        let mut store = TransferStore::default();
        let token = store.put("main", b"dirty text".to_vec(), now).unwrap();
        assert!(store.bind(&token, "main", "main", now).is_err());
        assert!(store.reject(&token, "win-1").is_err());
        store.bind(&token, "main", "win-1", now).unwrap();
        assert!(store.reject(&token, "main").is_err());
        assert!(store.reject(&token, "win-2").is_err());
        assert_eq!(store.status(&token, "main", now).unwrap().state, "pending");
        store.reject(&token, "win-1").unwrap();
        assert_eq!(store.bytes, 0);
        assert_eq!(store.status(&token, "main", now).unwrap().state, "missing");
        assert!(store.take(&token, "win-1", now).is_err());
        assert!(store.accept(&token, "win-1", now).is_err());
        store.reject(&token, "win-1").unwrap();
    }

    #[test]
    fn drop_uses_actual_top_level_handle_and_never_a_window_below_another_app() {
        let windows = [
            ("main".into(), 10),
            ("win-1".into(), 20),
            ("win-2".into(), 30),
        ];
        assert_eq!(
            drop_label_for_root(20, windows.clone()),
            Some("win-1".into())
        );
        assert_eq!(drop_label_for_root(0, windows.clone()), None);
        assert_eq!(drop_label_for_root(999, windows), None);
    }

    #[test]
    fn quit_waits_for_every_window_and_any_cancel_aborts() {
        let mut votes = QuitVotes::default();
        let request = votes.begin(["main".into(), "win-1".into()]).unwrap();
        assert!(votes.begin(["main".into()]).is_none());
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        assert!(matches!(votes.reply("stale", "win-1", true), Vote::Pending));
        assert!(matches!(
            votes.reply(&request.request_id, "win-1", false),
            Vote::Cancelled(_)
        ));
        assert!(votes.session.is_none());
        let request = votes.begin(["main".into(), "win-1".into()]).unwrap();
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        assert!(matches!(
            votes.reply(&request.request_id, "win-1", true),
            Vote::Approved(_)
        ));
    }

    #[test]
    fn file_open_routing_survives_main_window_closing() {
        assert_eq!(
            focused_label("main", &["win-1".into()]),
            Some("win-1".into())
        );
        assert_eq!(
            focused_label("win-2", &["main".into(), "win-2".into()]),
            Some("win-2".into())
        );
        assert_eq!(focused_label("missing", &[]), None);
        let state = WindowState::new(vec!["C:\\draft.txt".into()]);
        assert_eq!(
            state.pending.lock().unwrap().remove("main").unwrap().files,
            ["C:\\draft.txt"]
        );
        assert!(state.pending.lock().unwrap().remove("main").is_none());
    }

    #[test]
    fn quit_includes_window_still_being_built_and_waits_for_its_vote() {
        let mut votes = QuitVotes::default();
        votes.creating.insert("win-1".into());
        let request = votes.begin(["main".into()]).unwrap();
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        votes.creating.remove("win-1");
        votes.init_window("win-1");
        assert!(matches!(
            votes.reply(&request.request_id, "win-1", false),
            Vote::Cancelled(_)
        ));
        let request = votes.begin(["main".into()]).unwrap();
        votes.init_window("late-window");
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        assert!(matches!(
            votes.reply(&request.request_id, "late-window", true),
            Vote::Approved(_)
        ));
    }

    #[test]
    fn quit_before_frontend_initialization_is_replayed_without_reviving_completed_votes() {
        let mut votes = QuitVotes::default();
        let request = votes.begin(["main".into(), "win-1".into()]).unwrap();
        assert_eq!(
            votes.init_window("main").unwrap().request_id,
            request.request_id
        );
        assert!(matches!(
            votes.reply(&request.request_id, "main", true),
            Vote::Pending
        ));
        // A repeated window_init can replay the event, but cannot require a second vote.
        assert_eq!(
            votes.init_window("main").unwrap().request_id,
            request.request_id
        );
        assert_eq!(
            votes.init_window("win-1").unwrap().request_id,
            request.request_id
        );
        assert!(matches!(
            votes.reply(&request.request_id, "win-1", true),
            Vote::Approved(_)
        ));
        assert!(votes.init_window("main").is_none());
        assert!(votes.session.is_none());
    }
}
