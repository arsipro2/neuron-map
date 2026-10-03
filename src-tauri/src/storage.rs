use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
  collections::{HashMap, HashSet},
  fs,
  io::Write,
  path::PathBuf,
  sync::atomic::{AtomicU64, Ordering},
  time::{SystemTime, UNIX_EPOCH},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

#[derive(Clone)]
pub struct Database { pub data_dir: PathBuf, pub export_dir: PathBuf }

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRecord {
  pub id: String,
  pub title: String,
  #[serde(default)]
  pub summary: String,
  pub content: String,
  pub position: [f64; 3],
  #[serde(default)]
  pub attachments: Vec<AttachmentRecord>,
  #[serde(default)]
  pub tags: Vec<String>,
  #[serde(default, rename = "linkTargets")]
  pub link_targets: HashMap<String, String>,
}

const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_WORKSPACE_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WORKSPACE_FILE_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
  pub id: String,
  pub name: String,
  pub mime: String,
  pub size: u64,
  pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePayload { pub id: String, pub data: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRecord {
  pub id: String,
  pub source: String,
  pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraRecord {
  pub position: [f64; 3],
  pub quaternion: [f64; 4],
  pub orbit_target: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesRecord {
  #[serde(default)]
  pub link_navigation_enabled: bool,
  #[serde(default)]
  pub reduced_motion: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrashRecord {
  pub nodes: Vec<DeletedNodeRecord>,
  pub edges: Vec<EdgeRecord>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedNodeRecord { pub node: NodeRecord, pub deleted_at: i64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStateRecord {
  pub nodes: Vec<NodeRecord>,
  pub edges: Vec<EdgeRecord>,
  pub camera: Option<CameraRecord>,
  #[serde(default)]
  pub preferences: Option<PreferencesRecord>,
  #[serde(default)]
  pub trash: TrashRecord,
  #[serde(default)]
  pub revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
  pub id: String,
  pub name: String,
  pub created_at: i64,
  pub updated_at: i64,
  pub node_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
  pub workspaces: Vec<WorkspaceRecord>,
  pub last_workspace_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBackupRecord {
  pub id: i64,
  pub created_at: i64,
  pub node_count: usize,
  pub trash_count: usize,
  pub file_count: usize,
  pub titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceExportMeta {
  pub name: String,
  #[serde(default)]
  pub created_at: i64,
  #[serde(default)]
  pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceExportFile {
  pub format: String,
  pub version: u32,
  #[serde(default)]
  pub exported_at: i64,
  pub workspace: WorkspaceExportMeta,
  pub state: AppStateRecord,
  #[serde(default)]
  pub files: Vec<FilePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExportResult {
  pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportResult {
  pub workspace: WorkspaceRecord,
  pub file_name: String,
}

fn now_ms() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as i64)
    .unwrap_or(0)
}

fn new_workspace_id() -> String {
  let serial = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("ws-{}-{}", now_ms(), serial)
}

fn database_path(app: &Database) -> Result<PathBuf, String> {
  fs::create_dir_all(&app.data_dir).map_err(|e| format!("Cannot create app data directory: {e}"))?;
  Ok(app.data_dir.join("neuron-map.sqlite3"))
}

fn normalize_workspace_name(name: &str) -> String {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    "Untitled workspace".to_string()
  } else {
    trimmed.chars().take(80).collect()
  }
}

fn sanitize_filename(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|ch| if ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.') { ch } else { '_' })
    .collect();
  let trimmed = cleaned.trim().trim_matches('.');
  if trimmed.is_empty() { "workspace".to_string() } else { trimmed.chars().take(80).collect() }
}

fn unique_workspace_name(connection: &Connection, desired: &str) -> Result<String, String> {
  let base = normalize_workspace_name(desired);
  let mut statement = connection.prepare("SELECT name FROM workspaces").map_err(|e| e.to_string())?;
  let existing: HashSet<String> = statement
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|name| name.to_lowercase())
    .collect();
  if !existing.contains(&base.to_lowercase()) { return Ok(base); }
  for number in 2..10_000 {
    let suffix = format!(" ({number})");
    let keep = 80usize.saturating_sub(suffix.chars().count());
    let prefix: String = base.chars().take(keep).collect();
    let candidate = format!("{prefix}{suffix}");
    if !existing.contains(&candidate.to_lowercase()) { return Ok(candidate); }
  }
  Err("Could not choose a unique workspace name".to_string())
}

fn ensure_workspace_migration(connection: &mut Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_nodes (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS workspace_edges (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS workspace_settings (
        workspace_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_backups_workspace_time
        ON workspace_backups (workspace_id, created_at DESC);
      ",
    )
    .map_err(|e| format!("Cannot initialize workspace tables: {e}"))?;

  let has_attachments = {
    let mut statement = connection.prepare("PRAGMA table_info(workspace_nodes)").map_err(|e| e.to_string())?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    columns.iter().any(|name| name == "attachments")
  };
  if !has_attachments {
    connection.execute("ALTER TABLE workspace_nodes ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'", []).map_err(|e| e.to_string())?;
  }
  connection.execute_batch("CREATE TABLE IF NOT EXISTS workspace_files (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, added_at INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY (workspace_id, id)
  );").map_err(|e| e.to_string())?;

  for (table, column, declaration) in [
    ("workspaces", "revision", "INTEGER NOT NULL DEFAULT 0"),
    ("workspace_nodes", "tags", "TEXT NOT NULL DEFAULT '[]'"),
    ("workspace_nodes", "link_targets", "TEXT NOT NULL DEFAULT '{}'"),
  ] {
    let mut stmt = connection.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
    let columns = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if !columns.iter().any(|name| name == column) {
      connection.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {declaration}"), []).map_err(|e| e.to_string())?;
    }
  }
  let workspace_count: i64 = connection
    .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
    .map_err(|e| e.to_string())?;

  if workspace_count == 0 {
    // v0.16 and earlier stored one graph in the legacy nodes/edges/settings tables.
    // Keep those tables intact and copy their data into the first workspace.
    let workspace_id = "main".to_string();
    let timestamp = now_ms();
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
      .execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, 'Main', ?2, ?2)",
        params![workspace_id, timestamp],
      )
      .map_err(|e| e.to_string())?;

    let legacy_node_count: i64 = transaction
      .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
      .unwrap_or(0);

    if legacy_node_count > 0 {
      transaction
        .execute(
          "INSERT OR REPLACE INTO workspace_nodes (workspace_id, id, title, summary, content, x, y, z)
           SELECT ?1, id, title, summary, content, x, y, z FROM nodes",
          params![workspace_id],
        )
        .map_err(|e| e.to_string())?;
      transaction
        .execute(
          "INSERT OR REPLACE INTO workspace_edges (workspace_id, id, source, target)
           SELECT ?1, id, source, target FROM edges",
          params![workspace_id],
        )
        .map_err(|e| e.to_string())?;
      transaction
        .execute(
          "INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value)
           SELECT ?1, key, value FROM settings",
          params![workspace_id],
        )
        .map_err(|e| e.to_string())?;
    }

    transaction
      .execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_workspace_id', ?1)",
        params![workspace_id],
      )
      .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
  }

  Ok(())
}

fn open_database(app: &Database) -> Result<Connection, String> {
  let mut connection = Connection::open(database_path(app)?)
    .map_err(|e| format!("Cannot open SQLite database: {e}"))?;
  connection.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
  connection
    .execute_batch(
      "PRAGMA journal_mode = WAL;
       PRAGMA synchronous = FULL;
       PRAGMA foreign_keys = OFF;
       CREATE TABLE IF NOT EXISTS nodes (
         id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
         x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL
       );
       CREATE TABLE IF NOT EXISTS edges (
         id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS settings (
         key TEXT PRIMARY KEY, value TEXT NOT NULL
       );",
    )
    .map_err(|e| format!("Cannot initialize SQLite database: {e}"))?;
  let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
  if version < 22 {
    ensure_workspace_migration(&mut connection)?;
    connection.pragma_update(None, "user_version", 22).map_err(|e| e.to_string())?;
  } else if version > 22 { return Err("Database was created by a newer Neuron Map version".into()); }
  Ok(connection)
}

fn list_workspaces_internal(connection: &Connection) -> Result<Vec<WorkspaceRecord>, String> {
  let mut statement = connection
    .prepare(
      "SELECT w.id, w.name, w.created_at, w.updated_at, COUNT(n.id)
       FROM workspaces w
       LEFT JOIN workspace_nodes n ON n.workspace_id = w.id
       GROUP BY w.id, w.name, w.created_at, w.updated_at
       ORDER BY w.updated_at DESC, w.created_at DESC",
    )
    .map_err(|e| e.to_string())?;
  let rows = statement
    .query_map([], |row| {
      Ok(WorkspaceRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        node_count: row.get(4)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

fn read_last_workspace_id(connection: &Connection, workspaces: &[WorkspaceRecord]) -> Result<String, String> {
  let stored = connection
    .query_row(
      "SELECT value FROM app_settings WHERE key = 'last_workspace_id'",
      [],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?;

  if let Some(id) = stored {
    if workspaces.iter().any(|workspace| workspace.id == id) {
      return Ok(id);
    }
  }

  workspaces
    .first()
    .map(|workspace| workspace.id.clone())
    .ok_or_else(|| "No workspace exists".to_string())
}

pub fn bootstrap_workspaces(app: Database) -> Result<WorkspaceBootstrap, String> {
  let connection = open_database(&app)?;
  let workspaces = list_workspaces_internal(&connection)?;
  let last_workspace_id = read_last_workspace_id(&connection, &workspaces)?;
  Ok(WorkspaceBootstrap { workspaces, last_workspace_id })
}

fn read_state(connection: &Connection, workspace_id: &str) -> Result<AppStateRecord, String> {
  let exists: i64 = connection
    .query_row(
      "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
      params![workspace_id],
      |row| row.get(0),
    )
    .map_err(|e| e.to_string())?;
  if exists == 0 {
    return Err("Workspace does not exist".to_string());
  }

  let mut node_statement = connection
    .prepare(
      "SELECT id, title, summary, content, x, y, z, attachments, tags, link_targets
       FROM workspace_nodes WHERE workspace_id = ?1 ORDER BY rowid",
    )
    .map_err(|e| e.to_string())?;
  let nodes = node_statement
    .query_map(params![workspace_id], |row| {
      Ok(NodeRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        content: row.get(3)?,
        position: [row.get(4)?, row.get(5)?, row.get(6)?],
        attachments: serde_json::from_str(&row.get::<_, String>(7)?).map_err(|error|
          rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error)))?,
        tags: serde_json::from_str(&row.get::<_, String>(8)?).map_err(|error|
          rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error)))?,
        link_targets: serde_json::from_str(&row.get::<_, String>(9)?).map_err(|error|
          rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error)))?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

  let mut edge_statement = connection
    .prepare(
      "SELECT id, source, target FROM workspace_edges WHERE workspace_id = ?1 ORDER BY rowid",
    )
    .map_err(|e| e.to_string())?;
  let edges = edge_statement
    .query_map(params![workspace_id], |row| {
      Ok(EdgeRecord {
        id: row.get(0)?,
        source: row.get(1)?,
        target: row.get(2)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;

  let camera = connection
    .query_row(
      "SELECT value FROM workspace_settings WHERE workspace_id = ?1 AND key = 'camera'",
      params![workspace_id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|json| serde_json::from_str::<CameraRecord>(&json)).transpose().map_err(|e| format!("Cannot read saved camera: {e}"))?;

  let preferences = connection
    .query_row(
      "SELECT value FROM workspace_settings WHERE workspace_id = ?1 AND key = 'preferences'",
      params![workspace_id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|json| serde_json::from_str::<PreferencesRecord>(&json)).transpose().map_err(|e| format!("Cannot read saved preferences: {e}"))?;

  let trash = connection.query_row("SELECT value FROM workspace_settings WHERE workspace_id = ?1 AND key = 'trash'", params![workspace_id], |r| r.get::<_, String>(0))
    .optional().map_err(|e| e.to_string())?.map(|json| serde_json::from_str::<TrashRecord>(&json)).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
  let revision = Some(current_revision(connection, workspace_id)?);
  let mut state = AppStateRecord { nodes, edges, camera, preferences, trash, revision };
  normalize_camera(&mut state);
  validate_state(&state)?;
  Ok(state)
}

pub fn load_workspace(app: Database, workspace_id: String) -> Result<AppStateRecord, String> {
  let mut connection = open_database(&app)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
  let state = read_state(&transaction, &workspace_id)?;
  transaction.execute("INSERT INTO app_settings (key, value) VALUES ('last_workspace_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![workspace_id]).map_err(|e| e.to_string())?;
  transaction.commit().map_err(|e| e.to_string())?;
  Ok(state)
}

fn current_revision(connection: &Connection, workspace_id: &str) -> Result<u64, String> {
  connection.query_row("SELECT revision FROM workspaces WHERE id = ?1", params![workspace_id], |r| r.get(0))
    .optional().map_err(|e| e.to_string())?.ok_or_else(|| "Workspace does not exist".into())
}
fn check_revision(connection: &Connection, workspace_id: &str, expected: Option<u64>) -> Result<u64, String> {
  let current = current_revision(connection, workspace_id)?;
  if expected.is_some_and(|revision| revision != current) {
    return Err("SAVE_CONFLICT: Another window changed this workspace. Save a backup copy of your edits, then reload the workspace.".into());
  }
  Ok(current)
}
fn normalize_camera(state: &mut AppStateRecord) {
  if let Some(camera) = &mut state.camera {
    let norm = camera.quaternion.iter().map(|n| n * n).sum::<f64>().sqrt();
    if norm.is_finite() && norm >= 0.001 { for n in &mut camera.quaternion { *n /= norm; } }
  }
}
fn write_state(connection: &Connection, workspace_id: &str, state: &AppStateRecord) -> Result<(), String> {
  connection.execute("DELETE FROM workspace_nodes WHERE workspace_id = ?1", params![workspace_id]).map_err(|e| e.to_string())?;
  connection.execute("DELETE FROM workspace_edges WHERE workspace_id = ?1", params![workspace_id]).map_err(|e| e.to_string())?;
  {
    let mut statement = connection.prepare("INSERT INTO workspace_nodes (workspace_id, id, title, summary, content, x, y, z, attachments, tags, link_targets) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)").map_err(|e| e.to_string())?;
    for n in &state.nodes {
      statement.execute(params![workspace_id, n.id, n.title, n.summary, n.content, n.position[0], n.position[1], n.position[2],
        serde_json::to_string(&n.attachments).map_err(|e| e.to_string())?, serde_json::to_string(&n.tags).map_err(|e| e.to_string())?, serde_json::to_string(&n.link_targets).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    }
    let mut statement = connection.prepare("INSERT INTO workspace_edges (workspace_id, id, source, target) VALUES (?1, ?2, ?3, ?4)").map_err(|e| e.to_string())?;
    for e in &state.edges { statement.execute(params![workspace_id, e.id, e.source, e.target]).map_err(|e| e.to_string())?; }
  }
  connection.execute("DELETE FROM workspace_settings WHERE workspace_id = ?1 AND key IN ('camera', 'preferences', 'trash')", params![workspace_id]).map_err(|e| e.to_string())?;
  let mut settings = vec![("trash", serde_json::to_string(&state.trash).map_err(|e| e.to_string())?)];
  if let Some(camera) = &state.camera { settings.push(("camera", serde_json::to_string(camera).map_err(|e| e.to_string())?)); }
  if let Some(prefs) = &state.preferences { settings.push(("preferences", serde_json::to_string(prefs).map_err(|e| e.to_string())?)); }
  for (key, value) in settings {
    connection.execute("INSERT INTO workspace_settings (workspace_id, key, value) VALUES (?1, ?2, ?3)", params![workspace_id, key, value]).map_err(|e| e.to_string())?;
  }
  connection.execute("UPDATE workspaces SET updated_at = ?2, revision = ?3 WHERE id = ?1", params![workspace_id, now_ms(), state.revision.unwrap_or(0)]).map_err(|e| e.to_string())?;
  Ok(())
}
fn add_snapshot(connection: &Connection, workspace_id: &str, state: &AppStateRecord) -> Result<(), String> {
  let payload = serde_json::to_string(state).map_err(|e| e.to_string())?;
  connection.execute("INSERT INTO workspace_backups (workspace_id, created_at, payload) VALUES (?1, ?2, ?3)", params![workspace_id, now_ms(), payload]).map_err(|e| e.to_string())?;
  connection.execute("DELETE FROM workspace_backups WHERE workspace_id = ?1 AND id NOT IN (SELECT id FROM workspace_backups WHERE workspace_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20)", params![workspace_id]).map_err(|e| e.to_string())?;
  Ok(())
}
pub fn save_workspace(app: Database, workspace_id: String, mut state: AppStateRecord, create_backup: bool) -> Result<u64, String> {
  validate_state(&state)?;
  normalize_camera(&mut state);
  let mut connection = open_database(&app)?;
  let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
  let revision = check_revision(&transaction, &workspace_id, state.revision)? + 1;
  ensure_files_exist(&transaction, &workspace_id, &state)?;
  state.revision = Some(revision);
  write_state(&transaction, &workspace_id, &state)?;
  let last: Option<i64> = transaction.query_row("SELECT MAX(created_at) FROM workspace_backups WHERE workspace_id = ?1", params![workspace_id], |r| r.get(0)).map_err(|e| e.to_string())?;
  if create_backup || last.is_none_or(|time| now_ms() - time >= 5 * 60 * 1000) { add_snapshot(&transaction, &workspace_id, &state)?; }
  transaction.commit().map_err(|e| e.to_string())?;
  Ok(revision)
}

pub fn create_workspace(app: Database, name: String) -> Result<WorkspaceRecord, String> {
  let connection = open_database(&app)?;
  let id = new_workspace_id();
  let timestamp = now_ms();
  let normalized = normalize_workspace_name(&name);
  connection
    .execute(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
      params![id, normalized, timestamp],
    )
    .map_err(|e| e.to_string())?;
  connection
    .execute(
      "INSERT INTO app_settings (key, value) VALUES ('last_workspace_id', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![id],
    )
    .map_err(|e| e.to_string())?;
  Ok(WorkspaceRecord {
    id,
    name: normalized,
    created_at: timestamp,
    updated_at: timestamp,
    node_count: 0,
  })
}

pub fn rename_workspace(app: Database, workspace_id: String, name: String) -> Result<(), String> {
  let connection = open_database(&app)?;
  let normalized = normalize_workspace_name(&name);
  let changed = connection
    .execute(
      "UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
      params![workspace_id, normalized, now_ms()],
    )
    .map_err(|e| e.to_string())?;
  if changed == 0 {
    return Err("Workspace does not exist".to_string());
  }
  Ok(())
}

pub fn delete_workspace(app: Database, workspace_id: String) -> Result<WorkspaceBootstrap, String> {
  let mut connection = open_database(&app)?;
  let count: i64 = connection
    .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
    .map_err(|e| e.to_string())?;
  if count <= 1 {
    return Err("At least one workspace must remain".to_string());
  }

  let transaction = connection.transaction().map_err(|e| e.to_string())?;
  transaction
    .execute("DELETE FROM workspace_nodes WHERE workspace_id = ?1", params![workspace_id])
    .map_err(|e| e.to_string())?;
  transaction
    .execute("DELETE FROM workspace_edges WHERE workspace_id = ?1", params![workspace_id])
    .map_err(|e| e.to_string())?;
  transaction
    .execute("DELETE FROM workspace_settings WHERE workspace_id = ?1", params![workspace_id])
    .map_err(|e| e.to_string())?;
  transaction
    .execute("DELETE FROM workspace_backups WHERE workspace_id = ?1", params![workspace_id])
    .map_err(|e| e.to_string())?;
  transaction
    .execute("DELETE FROM workspaces WHERE id = ?1", params![workspace_id])
    .map_err(|e| e.to_string())?;
  transaction.execute("DELETE FROM workspace_files WHERE workspace_id = ?1", params![workspace_id]).map_err(|e| e.to_string())?;
  transaction.commit().map_err(|e| e.to_string())?;

  let workspaces = list_workspaces_internal(&connection)?;
  let current = read_last_workspace_id(&connection, &workspaces)?;
  connection
    .execute(
      "INSERT INTO app_settings (key, value) VALUES ('last_workspace_id', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![current],
    )
    .map_err(|e| e.to_string())?;

  Ok(WorkspaceBootstrap { workspaces, last_workspace_id: current })
}



pub fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
  let temporary = path.with_extension(format!("{}.part", new_workspace_id()));
  let result = (|| {
    let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() { fs::File::open(parent).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?; }
    Ok(())
  })();
  if result.is_err() { let _ = fs::remove_file(&temporary); }
  result
}
fn all_nodes(state: &AppStateRecord) -> impl Iterator<Item = &NodeRecord> {
  state.nodes.iter().chain(state.trash.nodes.iter().map(|entry| &entry.node))
}
pub fn export_workspace_file(app: Database, workspace_id: String) -> Result<WorkspaceExportResult, String> {
  let mut connection = open_database(&app)?;
  let transaction = connection.transaction().map_err(|e| e.to_string())?;
  let meta = transaction.query_row("SELECT name, created_at, updated_at FROM workspaces WHERE id = ?1", params![workspace_id],
    |r| Ok(WorkspaceExportMeta { name: r.get(0)?, created_at: r.get(1)?, updated_at: r.get(2)? })).map_err(|e| e.to_string())?;
  let state = read_state(&transaction, &workspace_id)?;
  ensure_files_exist(&transaction, &workspace_id, &state)?;
  let mut files = Vec::new();
  for file in all_nodes(&state).flat_map(|n| &n.attachments) {
    let bytes: Vec<u8> = transaction.query_row("SELECT data FROM workspace_files WHERE workspace_id = ?1 AND id = ?2", params![workspace_id, file.id], |r| r.get(0)).map_err(|e| e.to_string())?;
    files.push(FilePayload { id: file.id.clone(), data: BASE64.encode(bytes) });
  }
  transaction.commit().map_err(|e| e.to_string())?;
  let export = WorkspaceExportFile { format: "neuron-map-workspace".into(), version: 3, exported_at: now_ms(), workspace: meta, state, files };
  let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
  if json.len() > MAX_WORKSPACE_FILE_BYTES { return Err("Workspace export exceeds 100 MiB".into()); }
  fs::create_dir_all(&app.export_dir).map_err(|e| e.to_string())?;
  let path = app.export_dir.join(format!("{}-{}.neuron", sanitize_filename(&export.workspace.name), new_workspace_id()));
  atomic_write(&path, json.as_bytes())?;
  Ok(WorkspaceExportResult { path: path.to_string_lossy().into_owned() })
}

pub fn import_workspace_payload(app: Database, payload: String) -> Result<WorkspaceRecord, String> {
  if payload.len() > MAX_WORKSPACE_FILE_BYTES {
    return Err("Workspace file is larger than the 100 MB import limit".to_string());
  }
  let mut export: WorkspaceExportFile = serde_json::from_str(&payload)
    .map_err(|e| format!("This is not a valid Neuron Map workspace file: {e}"))?;
  if export.format != "neuron-map-workspace" {
    return Err("Unsupported workspace file format".to_string());
  }
  if !(1..=3).contains(&export.version) {
    return Err(format!("Workspace format version {} is not supported by this build", export.version));
  }

  if !valid_timestamp(export.exported_at) || !valid_timestamp(export.workspace.created_at) || !valid_timestamp(export.workspace.updated_at) { return Err("Invalid workspace timestamp".into()); }
  validate_state(&export.state)?;
  normalize_camera(&mut export.state);
  export.state.revision = Some(1);
  let metadata: std::collections::HashMap<&str, &AttachmentRecord> = all_nodes(&export.state)
    .flat_map(|node| &node.attachments).map(|file| (file.id.as_str(), file)).collect();
  let mut seen = HashSet::new();
  let mut decoded = Vec::new();
  for file in &export.files {
    let attachment = metadata.get(file.id.as_str()).ok_or("Unreferenced attachment data")?;
    if !seen.insert(file.id.as_str()) { return Err("Duplicate attachment data".to_string()); }
    decoded.push(((*attachment).clone(), decode_attachment(attachment, &file.data)?));
  }
  if seen.len() != metadata.len() { return Err("Workspace is missing attachment data".to_string()); }

  let mut connection = open_database(&app)?;
  let name = unique_workspace_name(&connection, &export.workspace.name)?;
  let id = new_workspace_id();
  let timestamp = now_ms();
  let transaction = connection.transaction().map_err(|e| e.to_string())?;
  transaction.execute(
    "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
    params![id, name, timestamp],
  ).map_err(|e| e.to_string())?;

  write_state(&transaction, &id, &export.state)?;
  for (attachment, bytes) in decoded {
    insert_file(&transaction, &id, &attachment, &bytes)?;
  }
  let snapshot = serde_json::to_string(&export.state).map_err(|e| e.to_string())?;
  transaction.execute(
    "INSERT INTO workspace_backups (workspace_id, created_at, payload) VALUES (?1, ?2, ?3)",
    params![id, timestamp, snapshot],
  ).map_err(|e| e.to_string())?;
  transaction.execute(
    "INSERT INTO app_settings (key, value) VALUES ('last_workspace_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    params![id],
  ).map_err(|e| e.to_string())?;
  transaction.commit().map_err(|e| e.to_string())?;

  Ok(WorkspaceRecord { id, name, created_at: timestamp, updated_at: timestamp, node_count: export.state.nodes.len() as i64 })
}

pub fn list_workspace_backups(app: Database, workspace_id: String) -> Result<Vec<WorkspaceBackupRecord>, String> {
  let connection = open_database(&app)?;
  let mut stmt = connection.prepare("SELECT id, created_at, payload FROM workspace_backups WHERE workspace_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 20").map_err(|e| e.to_string())?;
  let rows = stmt.query_map(params![workspace_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
  rows.into_iter().map(|(id, created_at, payload)| {
    let state: AppStateRecord = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    Ok(WorkspaceBackupRecord { id, created_at, node_count: state.nodes.len(), trash_count: state.trash.nodes.len(),
      file_count: all_nodes(&state).map(|n| n.attachments.len()).sum(), titles: state.nodes.iter().take(6).map(|n| n.title.clone()).collect() })
  }).collect()
}
#[cfg(test)]
pub fn restore_workspace_backup(app: Database, workspace_id: String, backup_id: i64) -> Result<(), String> {
  restore_workspace_backup_with_current(app, workspace_id, backup_id, None)
}
pub fn restore_workspace_backup_with_current(app: Database, workspace_id: String, backup_id: i64, current: Option<AppStateRecord>) -> Result<(), String> {
  let mut connection = open_database(&app)?;
  let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
  // Load the selected snapshot BEFORE adding/pruning the safety snapshot.
  let payload: String = tx.query_row("SELECT payload FROM workspace_backups WHERE workspace_id = ?1 AND id = ?2", params![workspace_id, backup_id], |r| r.get(0))
    .optional().map_err(|e| e.to_string())?.ok_or("Recovery snapshot does not exist")?;
  let mut target: AppStateRecord = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
  let current = match current { Some(state) => state, None => read_state(&tx, &workspace_id)? };
  let revision = check_revision(&tx, &workspace_id, current.revision)? + 1;
  validate_state(&current)?; validate_state(&target)?;
  ensure_files_exist(&tx, &workspace_id, &current)?; ensure_files_exist(&tx, &workspace_id, &target)?;
  add_snapshot(&tx, &workspace_id, &current)?;
  normalize_camera(&mut target); target.revision = Some(revision);
  write_state(&tx, &workspace_id, &target)?;
  tx.commit().map_err(|e| e.to_string())?;
  Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult { pub file_count: usize, pub bytes: u64 }
pub fn cleanup_attachments(app: Database, workspace_id: String, protected_ids: Vec<String>, dry_run: bool) -> Result<CleanupResult, String> {
  let mut connection = open_database(&app)?;
  let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
  let mut protected: HashSet<String> = protected_ids.into_iter().collect();
  for n in all_nodes(&read_state(&tx, &workspace_id)?) { protected.extend(n.attachments.iter().map(|f| f.id.clone())); }
  {
    let mut stmt = tx.prepare("SELECT payload FROM workspace_backups WHERE workspace_id = ?1").map_err(|e| e.to_string())?;
    let payloads = stmt.query_map(params![workspace_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    for payload in payloads {
      let state: AppStateRecord = serde_json::from_str(&payload).map_err(|e| format!("Cannot safely inspect snapshot: {e}"))?;
      for n in all_nodes(&state) { protected.extend(n.attachments.iter().map(|f| f.id.clone())); }
    }
  }
  let unused = {
    let mut stmt = tx.prepare("SELECT id, size FROM workspace_files WHERE workspace_id = ?1").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![workspace_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    rows.into_iter().filter(|(id, _)| !protected.contains(id)).collect::<Vec<_>>()
  };
  let result = CleanupResult { file_count: unused.len(), bytes: unused.iter().map(|(_, size)| size).sum() };
  if !dry_run { for (id, _) in unused { tx.execute("DELETE FROM workspace_files WHERE workspace_id = ?1 AND id = ?2", params![workspace_id, id]).map_err(|e| e.to_string())?; } }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(result)
}

fn valid_id(id: &str) -> bool { !id.is_empty() && id.encode_utf16().count() <= 256 && !id.chars().any(|c| (c as u32) < 32) }
fn valid_timestamp(time: i64) -> bool { (0..=9_007_199_254_740_991).contains(&time) }
fn coordinate(n: f64) -> bool { n.is_finite() && n.abs() <= 100000.0 }
fn validate_attachment(file: &AttachmentRecord) -> Result<(), String> {
  if !valid_id(&file.id) || file.name.trim().is_empty() || file.name == "." || file.name == ".."
    || file.name.contains(['/', '\\', '\0']) || file.size > MAX_ATTACHMENT_BYTES as u64 || !valid_timestamp(file.added_at) {
    return Err("Invalid attachment metadata or file exceeds 20 MiB".into());
  }
  Ok(())
}
fn validate_state(state: &AppStateRecord) -> Result<(), String> {
  if state.nodes.len() + state.trash.nodes.len() > 20000 || state.edges.len() + state.trash.edges.len() > 100000 { return Err("Graph exceeds supported size".into()); }
  if state.trash.nodes.iter().any(|n| !valid_timestamp(n.deleted_at)) { return Err("Invalid deletion date".into()); }
  let mut ids = HashSet::new(); let mut files = HashSet::new(); let mut total = 0u64;
  let live: HashSet<_> = state.nodes.iter().map(|n| n.id.as_str()).collect();
  for node in all_nodes(state) {
    if !valid_id(&node.id) || !ids.insert(node.id.as_str()) || node.position.iter().any(|n| !coordinate(*n)) { return Err("Invalid or duplicate note".into()); }
    if node.tags.len() > 20 || node.tags.iter().any(|t| t.trim().is_empty() || t.encode_utf16().count() > 40) { return Err("Invalid tags".into()); }
    if node.link_targets.iter().any(|(key, value)| key.encode_utf16().count() > 512 || !valid_id(value)) { return Err("Invalid note link targets".into()); }
    for file in &node.attachments {
      validate_attachment(file)?;
      if !files.insert(file.id.as_str()) { return Err("Duplicate attachment ID".into()); }
      total += file.size;
    }
  }
  if total > MAX_WORKSPACE_ATTACHMENT_BYTES { return Err("Workspace attachments exceed 64 MiB".into()); }
  let mut edges = HashSet::new(); let mut pairs = HashSet::new();
  for (edge, in_trash) in state.edges.iter().map(|e| (e, false)).chain(state.trash.edges.iter().map(|e| (e, true))) {
    let pair = if edge.source < edge.target { (&edge.source, &edge.target) } else { (&edge.target, &edge.source) };
    let both_live = live.contains(edge.source.as_str()) && live.contains(edge.target.as_str());
    if !valid_id(&edge.id) || !edges.insert(&edge.id) || !pairs.insert(pair) || edge.source == edge.target
      || !ids.contains(edge.source.as_str()) || !ids.contains(edge.target.as_str()) || (in_trash == both_live) { return Err("Invalid, duplicate or dangling link".into()); }
  }
  if let Some(camera) = &state.camera {
    if camera.position.iter().chain(camera.quaternion.iter()).chain(camera.orbit_target.iter()).any(|n| !coordinate(*n))
      || camera.quaternion.iter().map(|n| n * n).sum::<f64>() < 0.000001 { return Err("Invalid camera".into()); }
  }
  Ok(())
}

fn ensure_files_exist(connection: &Connection, workspace_id: &str, state: &AppStateRecord) -> Result<(), String> {
  let mut statement = connection.prepare("SELECT size, length(data) FROM workspace_files WHERE workspace_id = ?1 AND id = ?2").map_err(|e| e.to_string())?;
  for file in all_nodes(state).flat_map(|node| &node.attachments) {
    let size: Option<(u64, u64)> = statement.query_row(params![workspace_id, file.id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
    if size != Some((file.size, file.size)) { return Err(format!("Attachment is missing or damaged: {}", file.name)); }
  }
  Ok(())
}

fn decode_attachment(file: &AttachmentRecord, data: &str) -> Result<Vec<u8>, String> {
  validate_attachment(file)?;
  if data.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 { return Err("Attachment is too large".to_string()); }
  let bytes = BASE64.decode(data).map_err(|e| format!("Invalid attachment encoding: {e}"))?;
  if bytes.len() as u64 != file.size { return Err("Attachment size does not match its data".to_string()); }
  Ok(bytes)
}

fn insert_file(connection: &Connection, workspace_id: &str, file: &AttachmentRecord, bytes: &[u8]) -> Result<(), String> {
  connection.execute("INSERT INTO workspace_files (workspace_id, id, name, mime, size, added_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    params![workspace_id, file.id, file.name, file.mime, file.size, file.added_at, bytes]).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn store_attachment(app: Database, workspace_id: String, attachment: AttachmentRecord, data: String) -> Result<(), String> {
  let bytes = decode_attachment(&attachment, &data)?;
  let connection = open_database(&app)?;
  let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)", params![workspace_id], |row| row.get(0)).map_err(|e| e.to_string())?;
  if !exists { return Err("Workspace does not exist".to_string()); }
  insert_file(&connection, &workspace_id, &attachment, &bytes)
}

pub fn attachment_bytes(app: Database, workspace_id: String, attachment_id: String) -> Result<(String, Vec<u8>), String> {
  let connection = open_database(&app)?;
  connection.query_row("SELECT name, data FROM workspace_files WHERE workspace_id = ?1 AND id = ?2", params![workspace_id, attachment_id], |row| Ok((row.get(0)?, row.get(1)?)))
    .optional().map_err(|e| e.to_string())?.ok_or_else(|| "Attachment was not found".to_string())
}

pub fn read_attachment(app: Database, workspace_id: String, attachment_id: String) -> Result<String, String> {
  let (_, data) = attachment_bytes(app, workspace_id, attachment_id)?;
  Ok(BASE64.encode(data))
}

#[cfg(test)]
mod tests {
  use super::*;
  struct Fixture(Database);
  impl Fixture {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("neuron-map-test-{}-{}", std::process::id(), new_workspace_id()));
      let database = Database { data_dir: dir.clone(), export_dir: dir.join("exports") };
      bootstrap_workspaces(database.clone()).unwrap();
      Self(database)
    }
    fn db(&self) -> Database { self.0.clone() }
  }
  impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0.data_dir); } }
  fn note_state() -> AppStateRecord {
    AppStateRecord {
      nodes: vec![NodeRecord { id: "note".into(), title: "Заметка".into(), summary: "Описание".into(), content: "Содержимое".into(), position: [1.0, 2.0, 3.0], attachments: vec![], tags: vec![], link_targets: HashMap::new() }],
      edges: vec![], camera: None, preferences: None, trash: TrashRecord::default(), revision: None,
    }
  }
  fn file() -> AttachmentRecord { AttachmentRecord { id: "file-1".into(), name: "данные.bin".into(), mime: "application/octet-stream".into(), size: 5, added_at: 123 } }
  fn export_value(state: AppStateRecord) -> serde_json::Value {
    serde_json::json!({ "format": "neuron-map-workspace", "version": 1, "exported_at": 0,
      "workspace": { "name": "Old", "created_at": 0, "updated_at": 0 }, "state": state })
  }
  #[test]
  fn migrates_v020_nodes_without_data_loss() {
    let f = Fixture::new();
    let connection = open_database(&f.db()).unwrap();
    connection.execute("DROP TABLE workspace_nodes", []).unwrap();
    connection.pragma_update(None, "user_version", 0).unwrap();
    connection.execute_batch("CREATE TABLE workspace_nodes (workspace_id TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,content TEXT NOT NULL,x REAL NOT NULL,y REAL NOT NULL,z REAL NOT NULL,PRIMARY KEY(workspace_id,id));
      INSERT INTO workspace_nodes VALUES ('main','note','Title','Summary','Content',1,2,3);").unwrap();
    drop(connection);
    let loaded = load_workspace(f.db(), "main".into()).unwrap();
    assert_eq!(loaded.nodes[0].content, "Content");
    assert!(loaded.nodes[0].attachments.is_empty());
  }
  #[test]
  fn file_bytes_survive_save_load_export_import() {
    let f = Fixture::new();
    let bytes = vec![0, 255, 1, 128, 10];
    store_attachment(f.db(), "main".into(), file(), BASE64.encode(&bytes)).unwrap();
    let mut state = note_state(); state.nodes[0].attachments.push(file());
    save_workspace(f.db(), "main".into(), state, true).unwrap();
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].attachments[0].name, "данные.bin");
    let export = export_workspace_file(f.db(), "main".into()).unwrap();
    let payload = fs::read_to_string(export.path).unwrap();
    let imported = import_workspace_payload(f.db(), payload).unwrap();
    assert_ne!(imported.id, "main");
    assert_eq!(attachment_bytes(f.db(), imported.id.clone(), "file-1".into()).unwrap().1, bytes);
    assert_eq!(load_workspace(f.db(), imported.id).unwrap().nodes[0].content, "Содержимое");
  }
  #[test]
  fn restore_snapshot_recovers_removed_attachment() {
    let f = Fixture::new();
    store_attachment(f.db(), "main".into(), file(), BASE64.encode([1,2,3,4,5])).unwrap();
    let mut state = note_state(); state.nodes[0].attachments.push(file());
    save_workspace(f.db(), "main".into(), state, true).unwrap();
    let backup = list_workspace_backups(f.db(), "main".into()).unwrap()[0].id;
    save_workspace(f.db(), "main".into(), note_state(), true).unwrap();
    restore_workspace_backup(f.db(), "main".into(), backup).unwrap();
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].attachments.len(), 1);
    assert_eq!(attachment_bytes(f.db(), "main".into(), "file-1".into()).unwrap().1, vec![1,2,3,4,5]);
  }
  #[test]
  fn invalid_imports_are_atomic() {
    let f = Fixture::new();
    let mut state = note_state(); state.edges.push(EdgeRecord { id: "edge".into(), source: "note".into(), target: "missing".into() });
    assert!(import_workspace_payload(f.db(), export_value(state).to_string()).is_err());
    let mut state = note_state(); state.nodes[0].attachments.push(file());
    assert!(import_workspace_payload(f.db(), export_value(state).to_string()).is_err());
    assert_eq!(bootstrap_workspaces(f.db()).unwrap().workspaces.len(), 1);
  }
  #[test]
  fn failed_save_preserves_previous_notes() {
    let f = Fixture::new();
    save_workspace(f.db(), "main".into(), note_state(), true).unwrap();
    let mut state = note_state(); state.nodes[0].content = "do not save".into(); state.nodes[0].attachments.push(file());
    assert!(save_workspace(f.db(), "main".into(), state, true).is_err());
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].content, "Содержимое");
  }
  #[test]
  fn delete_workspace_removes_files_and_does_not_recreate_it() {
    let f = Fixture::new();
    let other = create_workspace(f.db(), "Other".into()).unwrap();
    store_attachment(f.db(), "main".into(), file(), BASE64.encode([1,2,3,4,5])).unwrap();
    let result = delete_workspace(f.db(), "main".into()).unwrap();
    assert_eq!(result.last_workspace_id, other.id);
    assert!(attachment_bytes(f.db(), "main".into(), "file-1".into()).is_err());
    assert!(save_workspace(f.db(), "main".into(), note_state(), true).is_err());
  }
  #[test]
  fn imports_format_one_without_attachment_fields() {
    let f = Fixture::new();
    let mut export = export_value(note_state());
    export["state"]["nodes"][0].as_object_mut().unwrap().remove("attachments");
    let imported = import_workspace_payload(f.db(), export.to_string()).unwrap();
    assert!(load_workspace(f.db(), imported.id).unwrap().nodes[0].attachments.is_empty());
  }
  #[test]
  fn retains_twenty_recent_snapshots() {
    let f = Fixture::new();
    for _ in 0..24 { save_workspace(f.db(), "main".into(), note_state(), true).unwrap(); }
    assert_eq!(list_workspace_backups(f.db(), "main".into()).unwrap().len(), 20);
  }
  #[test]
  fn rejects_invalid_attachment_bytes_and_paths() {
    let f = Fixture::new();
    assert!(store_attachment(f.db(), "main".into(), file(), "AA==".into()).is_err());
    let mut bad = file(); bad.name = "../outside".into();
    assert!(store_attachment(f.db(), "main".into(), bad, BASE64.encode([1,2,3,4,5])).is_err());
    assert!(read_attachment(f.db(), "main".into(), "file-1".into()).is_err());
  }
  #[test]
  fn restoring_snapshot_clears_newer_optional_settings() {
    let f = Fixture::new();
    save_workspace(f.db(), "main".into(), note_state(), true).unwrap();
    let backup = list_workspace_backups(f.db(), "main".into()).unwrap()[0].id;
    let mut state = note_state();
    state.camera = Some(CameraRecord { position: [4.0, 5.0, 6.0], quaternion: [0.0, 0.0, 0.0, 1.0], orbit_target: [0.0, 0.0, 0.0] });
    state.preferences = Some(PreferencesRecord { link_navigation_enabled: true, reduced_motion: false });
    save_workspace(f.db(), "main".into(), state, true).unwrap();
    restore_workspace_backup(f.db(), "main".into(), backup).unwrap();
    let loaded = load_workspace(f.db(), "main".into()).unwrap();
    assert!(loaded.camera.is_none()); assert!(loaded.preferences.is_none());
  }
  #[test]
  fn duplicate_links_are_rejected() {
    let mut state = note_state(); let mut second = state.nodes[0].clone(); second.id = "second".into(); state.nodes.push(second);
    state.edges = vec![EdgeRecord { id: "a".into(), source: "note".into(), target: "second".into() }, EdgeRecord { id: "b".into(), source: "second".into(), target: "note".into() }];
    assert!(validate_state(&state).is_err());
  }
  #[test]
  fn stale_writer_cannot_overwrite_newer_notes() {
    let f = Fixture::new();
    save_workspace(f.db(), "main".into(), note_state(), false).unwrap();
    let mut first = load_workspace(f.db(), "main".into()).unwrap();
    let mut second = first.clone(); first.nodes[0].content = "first edit".into(); second.nodes[0].title = "stale edit".into();
    save_workspace(f.db(), "main".into(), first, false).unwrap();
    assert!(save_workspace(f.db(), "main".into(), second, false).unwrap_err().starts_with("SAVE_CONFLICT"));
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].content, "first edit");
  }
  #[test]
  fn oldest_snapshot_restores_and_unsaved_edits_are_safeguarded() {
    let f = Fixture::new();
    for i in 0..20 { let mut state = note_state(); state.nodes[0].content = format!("version {i}"); save_workspace(f.db(), "main".into(), state, true).unwrap(); }
    let oldest = list_workspace_backups(f.db(), "main".into()).unwrap().last().unwrap().id;
    let mut current = load_workspace(f.db(), "main".into()).unwrap(); current.nodes[0].content = "unsaved current".into();
    restore_workspace_backup_with_current(f.db(), "main".into(), oldest, Some(current)).unwrap();
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].content, "version 0");
    let safety = list_workspace_backups(f.db(), "main".into()).unwrap()[0].id;
    restore_workspace_backup(f.db(), "main".into(), safety).unwrap();
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().nodes[0].content, "unsaved current");
  }
  #[test]
  fn cleanup_preserves_trash_snapshots_and_session_history() {
    let f = Fixture::new();
    for id in ["file-1", "undo-file", "unused"] { let mut attachment = file(); attachment.id = id.into(); store_attachment(f.db(), "main".into(), attachment, BASE64.encode([1,2,3,4,5])).unwrap(); }
    let mut state = note_state(); let mut node = state.nodes.remove(0); node.attachments.push(file());
    state.trash.nodes.push(DeletedNodeRecord { node, deleted_at: 1 });
    save_workspace(f.db(), "main".into(), state, true).unwrap();
    save_workspace(f.db(), "main".into(), note_state(), false).unwrap();
    let cleaned = cleanup_attachments(f.db(), "main".into(), vec!["undo-file".into()], false).unwrap();
    assert_eq!(cleaned.file_count, 1); assert_eq!(cleaned.bytes, 5);
    assert!(read_attachment(f.db(), "main".into(), "file-1".into()).is_ok());
    assert!(read_attachment(f.db(), "main".into(), "undo-file".into()).is_ok());
    let backup = list_workspace_backups(f.db(), "main".into()).unwrap()[0].id;
    restore_workspace_backup(f.db(), "main".into(), backup).unwrap();
    assert_eq!(load_workspace(f.db(), "main".into()).unwrap().trash.nodes[0].node.attachments.len(), 1);
  }
  #[test]
  fn shared_validation_fixtures_match_web_parser() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/workspace-validation.json")).unwrap();
    for fixture in fixtures.as_array().unwrap() {
      let f = Fixture::new();
      assert_eq!(import_workspace_payload(f.db(), fixture["workspace"].to_string()).is_ok(), fixture["valid"].as_bool().unwrap(), "{}", fixture["name"]);
    }
  }

}
