#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::{Clipboard, Error as ClipboardError, ImageData};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageEncoder;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    env, fs,
    path::{Component, Path, PathBuf},
};
use tauri::{LogicalSize, Manager, Size};

fn default_config() -> Value {
    json!({
        "theme": "system",
        "autoCopy": true,
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

const TEMPLATE_FILE_NAME: &str = "template.json";
const MIGRATION_MARKER_NAME: &str = ".legacy-migrated";

fn templates_directory() -> PathBuf {
    app_directory().join("meme")
}

fn legacy_directory_templates_path() -> PathBuf {
    app_directory().join("templates.json")
}

fn legacy_templates_path() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("meme-helper").join("templates.json"))
}

fn read_template_array(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Vec<Value>>(&contents).ok())
        .unwrap_or_default()
}

fn image_type_from_mime(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some(("png", "image/png")),
        "image/jpeg" | "image/jpg" => Some(("jpg", "image/jpeg")),
        "image/webp" => Some(("webp", "image/webp")),
        "image/gif" => Some(("gif", "image/gif")),
        "image/bmp" | "image/x-ms-bmp" => Some(("bmp", "image/bmp")),
        "image/svg+xml" => Some(("svg", "image/svg+xml")),
        "image/avif" => Some(("avif", "image/avif")),
        "image/tiff" => Some(("tif", "image/tiff")),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some(("ico", "image/x-icon")),
        _ => None,
    }
}

fn image_mime_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "tif" | "tiff" => Some("image/tiff"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() {
        return None;
    }
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!safe.as_os_str().is_empty()).then_some(safe)
}

fn safe_name(value: &str, fallback: &str, limit: usize) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            if separator && !result.is_empty() {
                result.push('-');
            }
            result.push(character);
            separator = false;
        } else {
            separator = true;
        }
        if result.chars().count() >= limit {
            break;
        }
    }
    let result = result.trim_matches(['-', '_', '.']).to_string();
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

fn template_id(template: &Value) -> Option<&str> {
    template.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
}

fn replacement_template_id(directory: &Path, used_ids: &HashSet<String>) -> String {
    let folder = directory
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| safe_name(name, "copy", 48))
        .unwrap_or_else(|| "copy".to_string());
    let base = format!("folder-{folder}");
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used_ids.contains(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn repair_template_directory_ids(root: &Path) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
    };
    let mut directories: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    directories.sort();

    let mut used_ids = HashSet::new();
    for directory in directories {
        let path = directory.join(TEMPLATE_FILE_NAME);
        let Some(mut template) = read_template_file(&path, false) else {
            continue;
        };
        if template_id(&template).is_some_and(|id| used_ids.insert(id.to_string())) {
            continue;
        }

        let id = replacement_template_id(&directory, &used_ids);
        template["id"] = Value::String(id.clone());
        let json = serde_json::to_string_pretty(&template).map_err(|error| error.to_string())?;
        fs::write(path, json).map_err(|error| error.to_string())?;
        used_ids.insert(id);
    }
    Ok(())
}

fn layers_mut(template: &mut Value) -> Option<&mut Vec<Value>> {
    template.get_mut("layers")?.as_array_mut()
}

fn hydrate_template_assets(template: &mut Value, directory: &Path) {
    let Some(layers) = layers_mut(template) else {
        return;
    };
    for layer in layers {
        let Some(source) = layer.get("src").and_then(Value::as_str) else {
            continue;
        };
        let Some(relative) = safe_relative_path(source) else {
            continue;
        };
        let path = directory.join(relative);
        let Some(mime) = image_mime_from_path(&path) else {
            continue;
        };
        if let Ok(bytes) = fs::read(path) {
            layer["src"] = Value::String(format!(
                "data:{mime};base64,{}",
                STANDARD.encode(bytes)
            ));
        }
    }
}

fn read_template_file(path: &Path, hydrate: bool) -> Option<Value> {
    let mut template = fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .filter(Value::is_object)?;
    if hydrate {
        hydrate_template_assets(&mut template, path.parent()?);
    }
    Some(template)
}

fn template_directories(root: &Path, hydrate: bool) -> Vec<(String, PathBuf, Value)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    directories.sort();
    directories
        .into_iter()
        .filter_map(|directory| {
            let template = read_template_file(&directory.join(TEMPLATE_FILE_NAME), hydrate)?;
            let id = template_id(&template)?.to_string();
            Some((id, directory, template))
        })
        .collect()
}

fn read_template_directories(root: &Path) -> Vec<Value> {
    template_directories(root, true)
        .into_iter()
        .map(|(_, _, template)| template)
        .collect()
}

fn decode_template_asset(source: &str) -> Result<Option<(&'static str, Vec<u8>)>, String> {
    let Some((header, encoded)) = source.split_once(',') else {
        return Ok(None);
    };
    let Some(metadata) = header.strip_prefix("data:") else {
        return Ok(None);
    };
    let mut parts = metadata.split(';');
    let Some(mime) = parts.next() else {
        return Ok(None);
    };
    if !parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return Ok(None);
    }
    let Some((extension, _)) = image_type_from_mime(mime) else {
        return Ok(None);
    };
    let bytes = STANDARD.decode(encoded).map_err(|error| error.to_string())?;
    Ok(Some((extension, bytes)))
}

fn referenced_assets(template: &Value) -> HashSet<PathBuf> {
    template
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| layer.get("src").and_then(Value::as_str))
        .filter_map(safe_relative_path)
        .collect()
}

fn write_template_directory(directory: &Path, template: &Value) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let old_template = read_template_file(&directory.join(TEMPLATE_FILE_NAME), false);
    let old_assets = old_template.as_ref().map(referenced_assets).unwrap_or_default();
    let mut stored = template.clone();
    let Some(layers) = layers_mut(&mut stored) else {
        return Err("模板图层数据格式无效".to_string());
    };
    let mut current_assets = HashSet::new();
    for (index, layer) in layers.iter_mut().enumerate() {
        let Some(source) = layer.get("src").and_then(Value::as_str) else {
            continue;
        };
        if let Some((extension, bytes)) = decode_template_asset(source)? {
            let layer_id = layer
                .get("id")
                .and_then(Value::as_str)
                .map(|id| safe_name(id, "image", 64))
                .unwrap_or_else(|| format!("image-{}", index + 1));
            let file_name = format!("layer-{layer_id}.{extension}");
            fs::write(directory.join(&file_name), bytes).map_err(|error| error.to_string())?;
            layer["src"] = Value::String(file_name.clone());
            current_assets.insert(PathBuf::from(file_name));
        } else if let Some(relative) = safe_relative_path(source) {
            current_assets.insert(relative);
        }
    }
    let json = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    fs::write(directory.join(TEMPLATE_FILE_NAME), json).map_err(|error| error.to_string())?;
    for stale in old_assets.difference(&current_assets) {
        let path = directory.join(stale);
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn new_template_directory(root: &Path, template: &Value, used: &HashSet<PathBuf>) -> PathBuf {
    let name = template
        .get("name")
        .and_then(Value::as_str)
        .map(|name| safe_name(name, "template", 36))
        .unwrap_or_else(|| "template".to_string());
    let id = template_id(template)
        .map(|id| safe_name(id, "id", 12))
        .unwrap_or_else(|| "id".to_string());
    let mut candidate = root.join(format!("template-{name}-{id}"));
    let mut suffix = 2;
    while candidate.exists() || used.contains(&candidate) {
        candidate = root.join(format!("template-{name}-{id}-{suffix}"));
        suffix += 1;
    }
    candidate
}

fn write_template_directories(root: &Path, templates: &[Value]) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let existing = template_directories(root, false);
    let existing_by_id: HashMap<String, PathBuf> = existing
        .iter()
        .map(|(id, directory, _)| (id.clone(), directory.clone()))
        .collect();
    let target_ids: HashSet<String> = templates
        .iter()
        .filter_map(template_id)
        .map(str::to_string)
        .collect();
    if target_ids.len() != templates.len() {
        return Err("模板 ID 缺失或重复".to_string());
    }
    let mut used_directories = HashSet::new();
    for template in templates {
        let id = template_id(template).expect("template IDs were validated");
        let directory = existing_by_id
            .get(id)
            .cloned()
            .unwrap_or_else(|| new_template_directory(root, template, &used_directories));
        write_template_directory(&directory, template)?;
        used_directories.insert(directory);
    }
    for (id, directory, _) in existing {
        if !target_ids.contains(&id) && directory.starts_with(root) {
            fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn template_matches(left: &Value, right: &Value) -> bool {
    left.get("id").is_some() && left.get("id") == right.get("id")
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

fn editor_drafts_path() -> PathBuf {
    app_directory().join("autosave.json")
}

fn use_sessions_path() -> PathBuf {
    app_directory().join("use-sessions.json")
}

fn decode_image_data_url(data_url: &str) -> Result<(&str, Vec<u8>), String> {
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "图片数据格式无效".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| matches!(*value, "image/png" | "image/jpeg" | "image/webp"))
        .ok_or_else(|| "只支持 PNG、JPEG 或 WebP 图片数据".to_string())?;
    let bytes = STANDARD.decode(encoded).map_err(|error| error.to_string())?;
    Ok((mime, bytes))
}

#[tauri::command]
fn load_config() -> Value {
    read_config()
}

fn load_templates_from(root: &Path, legacy_paths: &[PathBuf]) -> Result<Vec<Value>, String> {
    repair_template_directory_ids(root)?;
    let marker = root.join(MIGRATION_MARKER_NAME);
    if !marker.exists() {
        let directory_templates = read_template_directories(&root);
        let mut groups = vec![directory_templates];
        groups.extend(legacy_paths.iter().map(|path| read_template_array(path)));
        let merged = merge_templates(groups);
        write_template_directories(root, &merged)?;
        fs::write(&marker, b"1").map_err(|error| error.to_string())?;
    }
    Ok(read_template_directories(root))
}

#[tauri::command]
fn load_templates() -> Result<Vec<Value>, String> {
    let mut legacy_paths = vec![legacy_directory_templates_path()];
    if let Some(path) = legacy_templates_path() {
        legacy_paths.push(path);
    }
    load_templates_from(&templates_directory(), &legacy_paths)
}

#[tauri::command]
fn save_templates(templates: Vec<Value>) -> Result<bool, String> {
    write_template_directories(&templates_directory(), &templates)?;
    Ok(true)
}

#[tauri::command]
fn load_editor_drafts() -> Value {
    fs::read_to_string(editor_drafts_path())
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn save_editor_drafts(drafts: Value) -> Result<bool, String> {
    if !drafts.is_object() {
        return Err("自动保存数据格式无效".to_string());
    }
    let json = serde_json::to_string_pretty(&drafts).map_err(|error| error.to_string())?;
    fs::write(editor_drafts_path(), json).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn load_use_sessions() -> Value {
    fs::read_to_string(use_sessions_path())
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn save_use_sessions(sessions: Value) -> Result<bool, String> {
    if !sessions.is_object() {
        return Err("使用模板缓存数据格式无效".to_string());
    }
    let json = serde_json::to_string_pretty(&sessions).map_err(|error| error.to_string())?;
    fs::write(use_sessions_path(), json).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn copy_image(data_url: String, clipboard_data_url: Option<String>) -> Result<bool, String> {
    let (mime, bytes) = decode_image_data_url(&data_url)?;
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/png" => "png",
        _ => return Err("仅支持 PNG、JPEG 和 WebP 图片".to_string()),
    };
    let clipboard_source = clipboard_data_url.as_deref().unwrap_or(&data_url);
    let (clipboard_mime, clipboard_bytes) = decode_image_data_url(clipboard_source)?;
    if clipboard_mime != "image/png" {
        return Err("剪贴板预览必须为 PNG 格式".to_string());
    }
    let image = image::load_from_memory_with_format(&clipboard_bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let (width, height) = image.dimensions();
    let clipboard_directory = env::temp_dir().join("MemeHelper");
    fs::create_dir_all(&clipboard_directory).map_err(|error| error.to_string())?;
    let clipboard_file = clipboard_directory.join(format!("MemeHelper-copy.{extension}"));
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
fn read_clipboard_image() -> Result<Option<String>, String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    let clipboard_image = match clipboard.get_image() {
        Ok(image) => image,
        Err(ClipboardError::ContentNotAvailable) => {
            let files = match clipboard.get().file_list() {
                Ok(files) => files,
                Err(ClipboardError::ContentNotAvailable) => return Ok(None),
                Err(error) => return Err(error.to_string()),
            };
            let Some((path, mime)) = files.iter().find_map(|path| {
                let extension = path.extension()?.to_str()?.to_ascii_lowercase();
                let mime = match extension.as_str() {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "webp" => "image/webp",
                    _ => return None,
                };
                Some((path, mime))
            }) else {
                return Ok(None);
            };
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            return Ok(Some(format!(
                "data:{mime};base64,{}",
                STANDARD.encode(bytes)
            )));
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            clipboard_image.bytes.as_ref(),
            clipboard_image.width as u32,
            clipboard_image.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png)
    )))
}

#[tauri::command]
fn save_image(data_url: String, suggested_name: String) -> Result<Option<String>, String> {
    let (mime, bytes) = decode_image_data_url(&data_url)?;
    let (label, extensions, fallback) = match mime {
        "image/jpeg" => ("JPEG 图片", &["jpg", "jpeg"][..], "meme.jpg"),
        "image/webp" => ("WebP 图片", &["webp"][..], "meme.webp"),
        _ => ("PNG 图片", &["png"][..], "meme.png"),
    };
    let safe_name = Path::new(&suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    let Some(path) = rfd::FileDialog::new()
        .set_file_name(safe_name)
        .add_filter(label, extensions)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after Unix epoch")
            .as_nanos();
        env::temp_dir().join(format!(
            "meme-helper-storage-test-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn template(id: &str, name: &str, source: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "width": 100,
            "height": 100,
            "createdAt": 1,
            "updatedAt": 1,
            "layers": [{
                "id": format!("layer-{id}"),
                "name": "image",
                "type": "static",
                "src": source,
                "x": 0,
                "y": 0,
                "width": 100,
                "height": 100,
                "rotation": 0,
                "visible": true,
                "fit": "fill"
            }]
        })
    }

    #[test]
    fn writes_images_as_relative_assets_and_hydrates_them() {
        let root = test_directory("assets");
        let bytes = b"original-jpeg-bytes";
        let source = format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes));
        let value = template("one", "First", &source);

        write_template_directories(&root, &[value]).expect("template must be written");
        let directories = template_directories(&root, false);
        assert_eq!(directories.len(), 1);
        let stored = &directories[0].2;
        let stored_source = stored["layers"][0]["src"]
            .as_str()
            .expect("stored source must be a string");
        assert!(stored_source.ends_with(".jpg"));
        assert_eq!(
            fs::read(directories[0].1.join(stored_source)).expect("asset must be readable"),
            bytes
        );

        let hydrated = read_template_directories(&root);
        assert_eq!(hydrated[0]["layers"][0]["src"], source);
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn removes_deleted_templates_and_stale_assets() {
        let root = test_directory("cleanup");
        let png = format!("data:image/png;base64,{}", STANDARD.encode(b"png"));
        let first = template("one", "First", &png);
        let second = template("two", "Second", &png);
        write_template_directories(&root, &[first.clone(), second])
            .expect("templates must be written");

        let first_directory = template_directories(&root, false)
            .into_iter()
            .find(|(id, _, _)| id == "one")
            .expect("first template must exist")
            .1;
        let old_asset = referenced_assets(
            &read_template_file(&first_directory.join(TEMPLATE_FILE_NAME), false)
                .expect("stored template must be readable"),
        )
        .into_iter()
        .next()
        .expect("stored template must reference an asset");

        let without_image = template("one", "First", "");
        write_template_directories(&root, &[without_image])
            .expect("updated template must be written");
        assert!(!first_directory.join(old_asset).exists());
        assert_eq!(template_directories(&root, false).len(), 1);
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn does_not_hydrate_paths_outside_the_template_directory() {
        let root = test_directory("traversal");
        let directory = root.join("template");
        fs::create_dir_all(&directory).expect("template directory must be created");
        let value = template("one", "First", "../outside.png");
        fs::write(
            directory.join(TEMPLATE_FILE_NAME),
            serde_json::to_string(&value).expect("template must serialize"),
        )
        .expect("template must be written");
        fs::write(root.join("outside.png"), b"outside").expect("outside file must be written");

        let loaded = read_template_directories(&root);
        assert_eq!(loaded[0]["layers"][0]["src"], "../outside.png");
        fs::remove_dir_all(root).expect("test directory must be removable");
    }

    #[test]
    fn repository_templates_reference_readable_assets() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("manifest directory must have a parent")
            .join("meme");
        let templates = read_template_directories(&root);
        assert_eq!(templates.len(), 2);
        for template in templates {
            let static_source = template["layers"]
                .as_array()
                .expect("template layers must be an array")
                .iter()
                .find(|layer| layer["type"] == "static")
                .and_then(|layer| layer["src"].as_str())
                .expect("template must have a static image source");
            assert!(static_source.starts_with("data:image/svg+xml;base64,"));
        }
    }

    #[test]
    fn migrates_legacy_templates_only_once() {
        let directory = test_directory("migration");
        let root = directory.join("meme");
        let legacy = directory.join("templates.json");
        let source = format!("data:image/png;base64,{}", STANDARD.encode(b"png"));
        let first = template("one", "First", &source);
        fs::create_dir_all(&directory).expect("test directory must be created");
        fs::write(
            &legacy,
            serde_json::to_string(&vec![first]).expect("legacy templates must serialize"),
        )
        .expect("legacy templates must be written");

        let migrated = load_templates_from(&root, std::slice::from_ref(&legacy))
            .expect("legacy templates must migrate");
        assert_eq!(migrated.len(), 1);
        assert!(root.join(MIGRATION_MARKER_NAME).is_file());

        let second = template("two", "Second", &source);
        fs::write(
            &legacy,
            serde_json::to_string(&vec![second]).expect("legacy templates must serialize"),
        )
        .expect("legacy templates must be replaced");
        let loaded = load_templates_from(&root, std::slice::from_ref(&legacy))
            .expect("directory templates must load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["id"], "one");
        fs::remove_dir_all(directory).expect("test directory must be removable");
    }

    #[test]
    fn repairs_duplicate_ids_when_a_template_folder_is_copied() {
        let directory = test_directory("copied-folder");
        let root = directory.join("meme");
        let first_directory = root.join("first");
        let copied_directory = root.join("first-copy");
        let source = format!("data:image/png;base64,{}", STANDARD.encode(b"png"));
        let value = template("same-id", "Same template", &source);
        write_template_directory(&first_directory, &value).expect("first template must be written");
        fs::create_dir_all(&copied_directory).expect("copy directory must be created");
        fs::copy(
            first_directory.join(TEMPLATE_FILE_NAME),
            copied_directory.join(TEMPLATE_FILE_NAME),
        )
        .expect("template JSON must be copied");
        fs::write(root.join(MIGRATION_MARKER_NAME), b"1").expect("marker must be written");

        let loaded = load_templates_from(&root, &[]).expect("copied templates must load");
        assert_eq!(loaded.len(), 2);
        let ids: HashSet<&str> = loaded.iter().filter_map(template_id).collect();
        assert_eq!(ids.len(), 2);
        let copied = read_template_file(&copied_directory.join(TEMPLATE_FILE_NAME), false)
            .expect("copied template must remain readable");
        assert_ne!(template_id(&copied), Some("same-id"));
        fs::remove_dir_all(directory).expect("test directory must be removable");
    }
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
            load_editor_drafts,
            save_editor_drafts,
            load_use_sessions,
            save_use_sessions,
            copy_image,
            read_clipboard_image,
            save_image
        ])
        .run(tauri::generate_context!())
        .expect("MemeHelper failed to start");
}
