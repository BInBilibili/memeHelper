#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{LogicalSize, Manager, Size};

fn default_config() -> Value {
    json!({
        "theme": "system",
        "autoCopy": true,
        "templatesFile": "templates.json",
        "window": {
            "width": 1320,
            "height": 860,
            "minWidth": 1024,
            "minHeight": 680
        }
    })
}

fn app_directory() -> PathBuf {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    } else {
        env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn merge_object(base: &mut Value, saved: &Value) {
    let (Some(base_map), Some(saved_map)) = (base.as_object_mut(), saved.as_object()) else {
        return;
    };
    for (key, value) in saved_map {
        match (base_map.get_mut(key), value) {
            (Some(base_value @ Value::Object(_)), Value::Object(_)) => {
                merge_object(base_value, value)
            }
            _ => {
                base_map.insert(key.clone(), value.clone());
            }
        }
    }
}

fn read_config() -> Value {
    let mut config = default_config();
    let path = app_directory().join("config.json");
    if let Ok(contents) = fs::read_to_string(path) {
        if let Ok(saved) = serde_json::from_str::<Value>(&contents) {
            merge_object(&mut config, &saved);
        }
    }
    config
}

fn templates_path() -> PathBuf {
    if cfg!(debug_assertions) {
        return app_directory().join("src").join("bundled-templates.json");
    }
    let config = read_config();
    let configured = config
        .get("templatesFile")
        .and_then(Value::as_str)
        .unwrap_or("templates.json");
    let file_name = Path::new(configured)
        .file_name()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new("templates.json"));
    app_directory().join(file_name)
}

fn legacy_templates_path() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("meme-helper").join("templates.json"))
}

fn read_templates(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Vec<Value>>(&contents).ok())
        .unwrap_or_default()
}

fn template_matches(left: &Value, right: &Value) -> bool {
    let same_id = left.get("id").is_some() && left.get("id") == right.get("id");
    let same_shape = left.get("name") == right.get("name")
        && left.get("width") == right.get("width")
        && left.get("height") == right.get("height");
    same_id || same_shape
}

fn updated_at(value: &Value) -> i64 {
    value.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)
}

fn merge_templates(groups: impl IntoIterator<Item = Vec<Value>>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for template in groups.into_iter().flatten() {
        if let Some(index) = merged.iter().position(|item| template_matches(item, &template)) {
            if updated_at(&template) > updated_at(&merged[index]) {
                merged[index] = template;
            }
        } else {
            merged.push(template);
        }
    }
    merged
}

fn write_templates(path: &Path, templates: &[Value]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(templates).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn decode_png_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "只支持 PNG 图片数据".to_string())?;
    STANDARD.decode(encoded).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_config() -> Value {
    read_config()
}

#[tauri::command]
fn load_templates() -> Result<Vec<Value>, String> {
    let path = templates_path();
    let external = read_templates(&path);
    if cfg!(debug_assertions) {
        return Ok(external);
    }

    let legacy = legacy_templates_path()
        .as_deref()
        .map(read_templates)
        .unwrap_or_default();
    let merged = merge_templates([external.clone(), legacy]);
    if merged != external {
        write_templates(&path, &merged)?;
    }
    Ok(merged)
}

#[tauri::command]
fn save_templates(templates: Vec<Value>) -> Result<bool, String> {
    write_templates(&templates_path(), &templates)?;
    Ok(true)
}

#[tauri::command]
fn publish_templates(templates: Vec<Value>) -> Result<String, String> {
    let path = templates_path();
    write_templates(&path, &templates)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn copy_image(data_url: String) -> Result<bool, String> {
    let bytes = decode_png_data_url(&data_url)?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let (width, height) = image.dimensions();
    let clipboard_directory = env::temp_dir().join("MemeHelper");
    fs::create_dir_all(&clipboard_directory).map_err(|error| error.to_string())?;
    let clipboard_file = clipboard_directory.join("MemeHelper-copy.png");
    fs::write(&clipboard_file, &bytes).map_err(|error| error.to_string())?;

    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set()
        .image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(image.into_raw()),
        })
        .map_err(|error| error.to_string())?;
    clipboard
        .set()
        .file_list(&[&clipboard_file])
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn save_image(data_url: String, suggested_name: String) -> Result<Option<String>, String> {
    let bytes = decode_png_data_url(&data_url)?;
    let safe_name = Path::new(&suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("meme.png");
    let Some(path) = rfd::FileDialog::new()
        .set_file_name(safe_name)
        .add_filter("PNG 图片", &["png"])
        .save_file()
    else {
        return Ok(None);
    };
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn config_number(config: &Value, key: &str, fallback: f64, minimum: f64) -> f64 {
    config
        .get("window")
        .and_then(|window| window.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(fallback)
        .max(minimum)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let config = read_config();
                let min_width = config_number(&config, "minWidth", 1024.0, 800.0);
                let min_height = config_number(&config, "minHeight", 680.0, 600.0);
                let width = config_number(&config, "width", 1320.0, min_width);
                let height = config_number(&config, "height", 860.0, min_height);
                window.set_min_size(Some(Size::Logical(LogicalSize::new(min_width, min_height))))?;
                window.set_size(Size::Logical(LogicalSize::new(width, height)))?;
                window.center()?;
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            load_templates,
            save_templates,
            publish_templates,
            copy_image,
            save_image
        ])
        .run(tauri::generate_context!())
        .expect("MemeHelper failed to start");
}
