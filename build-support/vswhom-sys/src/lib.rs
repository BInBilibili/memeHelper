use libc::{c_int, wchar_t};
use std::ptr::null_mut;

#[repr(C)]
pub struct Find_Result {
    pub windows_sdk_version: c_int,
    pub windows_sdk_root: *mut wchar_t,
    pub windows_sdk_um_library_path: *mut wchar_t,
    pub windows_sdk_ucrt_library_path: *mut wchar_t,
    pub vs_exe_path: *mut wchar_t,
    pub vs_library_path: *mut wchar_t,
}

pub unsafe fn vswhom_find_visual_studio_and_windows_sdk() -> Find_Result {
    Find_Result {
        windows_sdk_version: 0,
        windows_sdk_root: null_mut(),
        windows_sdk_um_library_path: null_mut(),
        windows_sdk_ucrt_library_path: null_mut(),
        vs_exe_path: null_mut(),
        vs_library_path: null_mut(),
    }
}

pub unsafe fn vswhom_free_resources(_result: *mut Find_Result) {}
