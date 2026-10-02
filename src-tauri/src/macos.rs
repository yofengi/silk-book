//! Route both the application menu and Cocoa/Dock termination through the safe quit protocol.

use std::{
    ffi::{c_char, c_void},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::OnceLock,
};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager,
};

use crate::error::{AppError, Result};

const QUIT_MENU_ID: &str = "app.quit";
const TERMINATE_CANCEL: usize = 0;
static QUIT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

type Object = *mut c_void;
type Selector = *mut c_void;
type ShouldTerminate = unsafe extern "C" fn(Object, Selector, Object) -> usize;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn object_getClass(object: Object) -> Object;
    fn sel_registerName(name: *const c_char) -> Selector;
    fn objc_msgSend();
    fn class_getInstanceMethod(class: Object, selector: Selector) -> *mut c_void;
    fn class_addMethod(
        class: Object,
        selector: Selector,
        implementation: unsafe extern "C" fn(),
        types: *const c_char,
    ) -> i8;
}

fn request_quit(app: &tauri::AppHandle) -> Result<()> {
    crate::window::app_request_quit(app.clone(), app.state())
}

unsafe extern "C" fn application_should_terminate(
    _delegate: Object,
    _selector: Selector,
    _application: Object,
) -> usize {
    // Cocoa must keep the event loop alive for the frontend's asynchronous dirty/flush votes.
    // Approved votes destroy all windows, after which Tauri exits through its normal loop path.
    let result = catch_unwind(AssertUnwindSafe(|| {
        let app = QUIT_APP
            .get()
            .ok_or_else(|| AppError::Channel("macOS quit handler is not initialized".into()))?;
        request_quit(app)
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Boshu native quit request failed: {error}"),
        Err(_) => eprintln!("Boshu native quit request panicked"),
    }
    TERMINATE_CANCEL
}

fn add_termination_method(class: Object, callback: ShouldTerminate) -> Result<()> {
    // SAFETY: The caller supplies a live Objective-C class. The callback matches
    // NSApplicationTerminateReply (NSUInteger) applicationShouldTerminate:(id).
    unsafe {
        let selector = sel_registerName(b"applicationShouldTerminate:\0".as_ptr().cast());
        if class.is_null() || selector.is_null() {
            return Err(AppError::Channel(
                "macOS quit delegate is unavailable".into(),
            ));
        }
        // Also check inherited methods: never replace another delegate's termination policy.
        if !class_getInstanceMethod(class, selector).is_null() {
            return Err(AppError::Channel(
                "macOS delegate already has a termination policy".into(),
            ));
        }
        let implementation =
            std::mem::transmute::<ShouldTerminate, unsafe extern "C" fn()>(callback);
        if class_addMethod(class, selector, implementation, b"Q@:@\0".as_ptr().cast()) == 0 {
            return Err(AppError::Channel(
                "macOS quit policy could not be installed".into(),
            ));
        }
    }
    Ok(())
}

fn install_termination_policy(app: &tauri::AppHandle) -> Result<()> {
    // setup runs on the main thread, after Tao has installed its NSApplication delegate.
    // SAFETY: These zero-argument selectors return Objective-C objects. Objects remain owned
    // by NSApplication/Tao; this code adds one missing method and does not replace the delegate.
    unsafe {
        let application_class = objc_getClass(b"NSApplication\0".as_ptr().cast());
        let shared_selector = sel_registerName(b"sharedApplication\0".as_ptr().cast());
        let delegate_selector = sel_registerName(b"delegate\0".as_ptr().cast());
        if application_class.is_null() || shared_selector.is_null() || delegate_selector.is_null() {
            return Err(AppError::Channel("NSApplication is unavailable".into()));
        }
        let send_object: unsafe extern "C" fn(Object, Selector) -> Object =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let application = send_object(application_class, shared_selector);
        if application.is_null() {
            return Err(AppError::Channel(
                "NSApplication instance is unavailable".into(),
            ));
        }
        let delegate = send_object(application, delegate_selector);
        if delegate.is_null() {
            return Err(AppError::Channel(
                "NSApplication delegate is unavailable".into(),
            ));
        }
        let class = object_getClass(delegate);
        QUIT_APP
            .set(app.clone())
            .map_err(|_| AppError::Channel("macOS quit policy was initialized twice".into()))?;
        add_termination_method(class, application_should_terminate)
    }
}

pub fn setup(app: &tauri::AppHandle) -> Result<()> {
    install_termination_policy(app)?;
    let menu = safe_menu(app).map_err(|error| AppError::Channel(error.to_string()))?;
    app.set_menu(menu)
        .map_err(|error| AppError::Channel(error.to_string()))?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == QUIT_MENU_ID {
            if let Err(error) = request_quit(app) {
                eprintln!("Boshu menu quit request failed: {error}");
            }
        }
    });
    Ok(())
}

fn safe_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // A regular menu item emits a MenuEvent. Predefined Quit calls Cocoa terminate: directly.
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit silk book", true, Some("Cmd+Q"))?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "silk book",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::CString,
        sync::atomic::{AtomicUsize, Ordering},
    };

    extern "C" {
        fn objc_allocateClassPair(
            superclass: Object,
            name: *const c_char,
            extra_bytes: usize,
        ) -> Object;
        fn objc_registerClassPair(class: Object);
    }
    static REQUESTS: AtomicUsize = AtomicUsize::new(0);
    unsafe extern "C" fn request_and_cancel(_: Object, _: Selector, _: Object) -> usize {
        REQUESTS.fetch_add(1, Ordering::SeqCst);
        TERMINATE_CANCEL
    }
    unsafe extern "C" fn marker(_: Object, _: Selector) -> usize {
        7
    }

    #[test]
    fn cocoa_termination_method_cancels_and_keeps_other_delegate_methods() {
        // Exercise the actual Objective-C runtime/ABI without requiring a desktop event loop.
        unsafe {
            let name = CString::new(format!("BoshuQuitPolicyTest{}", std::process::id())).unwrap();
            let class = objc_allocateClassPair(
                objc_getClass(b"NSObject\0".as_ptr().cast()),
                name.as_ptr(),
                0,
            );
            assert!(!class.is_null());
            objc_registerClassPair(class);
            let marker_selector = sel_registerName(b"boshuTestMarker\0".as_ptr().cast());
            assert_ne!(
                class_addMethod(
                    class,
                    marker_selector,
                    std::mem::transmute::<
                        unsafe extern "C" fn(Object, Selector) -> usize,
                        unsafe extern "C" fn(),
                    >(marker),
                    b"Q@:\0".as_ptr().cast()
                ),
                0
            );
            add_termination_method(class, request_and_cancel).unwrap();
            assert!(add_termination_method(class, request_and_cancel).is_err());

            let send_object: unsafe extern "C" fn(Object, Selector) -> Object =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let allocated = send_object(class, sel_registerName(b"alloc\0".as_ptr().cast()));
            let object = send_object(allocated, sel_registerName(b"init\0".as_ptr().cast()));
            assert!(!object.is_null());
            let send_termination: ShouldTerminate =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            assert_eq!(
                send_termination(
                    object,
                    sel_registerName(b"applicationShouldTerminate:\0".as_ptr().cast()),
                    std::ptr::null_mut()
                ),
                TERMINATE_CANCEL
            );
            assert_eq!(REQUESTS.load(Ordering::SeqCst), 1);
            let send_number: unsafe extern "C" fn(Object, Selector) -> usize =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            assert_eq!(send_number(object, marker_selector), 7);
            let send_release: unsafe extern "C" fn(Object, Selector) =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            send_release(object, sel_registerName(b"release\0".as_ptr().cast()));

            let child_name =
                CString::new(format!("BoshuQuitPolicyChildTest{}", std::process::id())).unwrap();
            let child = objc_allocateClassPair(class, child_name.as_ptr(), 0);
            assert!(!child.is_null());
            objc_registerClassPair(child);
            assert!(add_termination_method(child, request_and_cancel).is_err());
        }
    }
}
