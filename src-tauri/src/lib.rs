mod storage;
mod attachment_open;
use storage::*;
use tauri::{AppHandle, Manager};

fn database(app: &AppHandle) -> Result<Database, String> {
  let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let export_dir = app.path().download_dir().unwrap_or_else(|_| data_dir.clone());
  Ok(Database { data_dir, export_dir })
}

#[tauri::command]
async fn bootstrap_workspaces(app: AppHandle) -> Result<WorkspaceBootstrap, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::bootstrap_workspaces(db)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn load_workspace(app: AppHandle, workspace_id: String) -> Result<AppStateRecord, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::load_workspace(db, workspace_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_workspace(app: AppHandle, workspace_id: String, state: AppStateRecord, create_backup: bool) -> Result<u64, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::save_workspace(db, workspace_id, state, create_backup)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_workspace(app: AppHandle, name: String) -> Result<WorkspaceRecord, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::create_workspace(db, name)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rename_workspace(app: AppHandle, workspace_id: String, name: String) -> Result<(), String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::rename_workspace(db, workspace_id, name)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn delete_workspace(app: AppHandle, workspace_id: String) -> Result<WorkspaceBootstrap, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::delete_workspace(db, workspace_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_workspace_file(app: AppHandle, workspace_id: String) -> Result<WorkspaceExportResult, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::export_workspace_file(db, workspace_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn import_workspace_payload(app: AppHandle, payload: String) -> Result<WorkspaceRecord, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::import_workspace_payload(db, payload)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn pick_and_import_workspace_file(app: AppHandle) -> Result<Option<WorkspaceImportResult>, String> {
  let picked = rfd::AsyncFileDialog::new().set_title("Import Neuron Map workspace")
    .add_filter("Neuron workspace", &["neuron"]).add_filter("JSON workspace", &["json"]).add_filter("All files", &["*"]).pick_file().await;
  let Some(file) = picked else { return Ok(None) };
  let path = file.path().to_path_buf();
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 100 * 1024 * 1024 { return Err("Workspace exceeds 100 MiB".to_string()); }
    let payload = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let workspace = storage::import_workspace_payload(db, payload)?;
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("workspace.neuron").to_string();
    Ok(Some(WorkspaceImportResult { workspace, file_name }))
  }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_workspace_backups(app: AppHandle, workspace_id: String) -> Result<Vec<WorkspaceBackupRecord>, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::list_workspace_backups(db, workspace_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn restore_workspace_backup(app: AppHandle, workspace_id: String, backup_id: i64, current: Option<AppStateRecord>) -> Result<(), String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::restore_workspace_backup_with_current(db, workspace_id, backup_id, current)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn store_attachment(app: AppHandle, workspace_id: String, attachment: AttachmentRecord, data: String) -> Result<(), String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::store_attachment(db, workspace_id, attachment, data)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_attachment(app: AppHandle, workspace_id: String, attachment_id: String) -> Result<String, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::read_attachment(db, workspace_id, attachment_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn open_attachment(app: AppHandle, workspace_id: String, attachment_id: String) -> Result<(), String> {
  let db = database(&app)?;
  let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("opened-attachments");
  tauri::async_runtime::spawn_blocking(move || {
    let (name, data) = storage::attachment_bytes(db, workspace_id, attachment_id)?;
    let copy = attachment_open::prepare_copy(&cache, &name, &data).map_err(|e| format!("Could not prepare attachment: {e}"))?;
    tauri_plugin_opener::open_path(&copy, None::<&str>).map_err(|e| format!("Could not open attachment. Check that a default application is installed for this file type. {e}"))
  }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_attachment_as(app: AppHandle, workspace_id: String, attachment_id: String) -> Result<Option<String>, String> {
  let db = database(&app)?;
  let (name, data) = tauri::async_runtime::spawn_blocking(move || storage::attachment_bytes(db, workspace_id, attachment_id)).await.map_err(|e| e.to_string())??;
  let chosen = rfd::AsyncFileDialog::new().set_title("Save attachment").set_file_name(name).save_file().await;
  let Some(file) = chosen else { return Ok(None) };
  file.write(&data).await.map_err(|e| e.to_string())?;
  Ok(Some(file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn cleanup_attachments(app: AppHandle, workspace_id: String, protected_ids: Vec<String>, dry_run: bool) -> Result<CleanupResult, String> {
  let db = database(&app)?;
  tauri::async_runtime::spawn_blocking(move || storage::cleanup_attachments(db, workspace_id, protected_ids, dry_run)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn save_workspace_copy(payload: String, suggested_name: String) -> Result<Option<WorkspaceExportResult>, String> {
  if payload.len() > 100 * 1024 * 1024 { return Err("Workspace exceeds 100 MiB".into()); }
  let chosen = rfd::AsyncFileDialog::new().set_title("Save independent backup copy")
    .set_file_name(suggested_name).add_filter("Neuron workspace", &["neuron"]).save_file().await;
  let Some(file) = chosen else { return Ok(None) };
  let path = file.path().to_path_buf();
  tauri::async_runtime::spawn_blocking(move || {
    storage::atomic_write(&path, payload.as_bytes())?;
    Ok(Some(WorkspaceExportResult { path: path.to_string_lossy().into_owned() }))
  }).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
    }
  }));
  builder.invoke_handler(tauri::generate_handler![bootstrap_workspaces, load_workspace, save_workspace,
      create_workspace, rename_workspace, delete_workspace, export_workspace_file, import_workspace_payload,
      pick_and_import_workspace_file, list_workspace_backups, restore_workspace_backup,
      store_attachment, read_attachment, open_attachment, save_attachment_as, cleanup_attachments, save_workspace_copy])
    .run(tauri::generate_context!())
    .expect("error while running Neuron Map");
}
