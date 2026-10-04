use std::{fs, io::{self, Write}, path::{Path, PathBuf}, time::{Duration, SystemTime}};

const COPY_PREFIX: &str = "open-";
const COPY_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);

// Preserve extensions for the OS file association, including files imported from
// another platform. Neither a stored filename nor an attachment ID becomes a path.
fn safe_filename(name: &str) -> String {
    let replaced: String = name.chars().map(|c| {
        if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }
    }).collect();
    let mut name = replaced.trim().trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() { name = "attachment".into(); }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix)
            .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")));
    if reserved { name.insert(0, '_'); }
    if name.len() > 180 {
        let extension = name.rsplit_once('.').filter(|(_, ext)| !ext.is_empty() && ext.len() <= 32)
            .map(|(_, ext)| format!(".{ext}")).unwrap_or_default();
        let mut end = 180 - extension.len();
        while !name.is_char_boundary(end) { end -= 1; }
        name.truncate(end);
        name.push_str(&extension);
    }
    name
}

pub fn prepare_copy(cache: &Path, name: &str, data: &[u8]) -> io::Result<PathBuf> {
    fs::create_dir_all(cache)?;
    cleanup_old_copies(cache, SystemTime::now());
    // Each request gets an independent directory, so another open cannot replace
    // a file still in use by an editor, even across workspaces with identical names.
    let directory = tempfile::Builder::new().prefix(COPY_PREFIX).tempdir_in(cache)?;
    let path = directory.path().join(safe_filename(name));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(data)?;
    drop(file);
    // The external application may read the file after this command returns or
    // after Neuron Map exits. Retain it; later opens clean up inactive old copies.
    let _ = directory.keep();
    Ok(path)
}

fn cleanup_old_copies(cache: &Path, now: SystemTime) {
    let Some(cutoff) = now.checked_sub(COPY_LIFETIME) else { return };
    let Ok(entries) = fs::read_dir(cache) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(COPY_PREFIX) { continue; }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
        if !metadata.is_dir() || !metadata.modified().is_ok_and(|time| time < cutoff) { continue; }
        let Ok(files) = fs::read_dir(entry.path()) else { continue };
        // Be conservative around edits, unknown contents, symlinks and I/O errors.
        let inactive = files.into_iter().all(|file| file.ok()
            .and_then(|file| fs::symlink_metadata(file.path()).ok())
            .is_some_and(|meta| meta.is_file() && meta.modified().is_ok_and(|time| time < cutoff)));
        if inactive { let _ = fs::remove_dir_all(entry.path()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_preserve_bytes_and_names_without_overwriting_external_edits() {
        let cache = tempfile::tempdir().unwrap();
        let bytes = [0, 255, 128, 13, 10];
        let first = prepare_copy(cache.path(), "файл.bin", &bytes).unwrap();
        assert_eq!(first.file_name().unwrap(), "файл.bin");
        assert_eq!(fs::read(&first).unwrap(), bytes);
        fs::write(&first, b"external edits").unwrap();
        let second = prepare_copy(cache.path(), "файл.bin", &bytes).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), b"external edits");
        assert_eq!(fs::read(second).unwrap(), bytes);
        let empty = prepare_copy(cache.path(), "empty.txt", &[]).unwrap();
        assert!(fs::read(empty).unwrap().is_empty());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn filenames_cannot_escape_the_cache_and_are_portable() {
        let cache = tempfile::tempdir().unwrap();
        for name in ["../../escape.txt", "C:\\bad\\a.txt", "..", "CON.txt", "LPT1.pdf", "AUX", "COM¹.txt", "a\0b?.txt", "trailing. "] {
            let path = prepare_copy(cache.path(), name, b"test").unwrap();
            assert_eq!(path.parent().unwrap().parent().unwrap(), cache.path());
            assert!(!path.file_name().unwrap().to_str().unwrap().contains(['/', '\\', ':', '?', '\0']));
        }
        assert_eq!(safe_filename("CON.txt"), "_CON.txt");
        assert_eq!(safe_filename(".."), "attachment");
        assert_eq!(safe_filename("report.pdf"), "report.pdf");
        let long = safe_filename(&format!("{}.pdf", "документ".repeat(100)));
        assert!(long.len() <= 180 && long.ends_with(".pdf"));
    }

    fn set_modified(path: &Path, time: SystemTime) {
        fs::OpenOptions::new().write(true).open(path).unwrap()
            .set_times(fs::FileTimes::new().set_modified(time)).unwrap();
    }

    #[test]
    fn cleanup_removes_only_inactive_owned_copies() {
        let cache = tempfile::tempdir().unwrap();
        let stale = prepare_copy(cache.path(), "stale.txt", b"stale").unwrap();
        let edited = prepare_copy(cache.path(), "edited.txt", b"edited").unwrap();
        let fresh = prepare_copy(cache.path(), "fresh.txt", b"fresh").unwrap();
        // Advance the cleanup clock rather than opening directory handles, which
        // need special permissions on Windows. Simulate an edit in the future.
        let now = SystemTime::now() + COPY_LIFETIME + Duration::from_secs(60);
        set_modified(&edited, now);
        set_modified(&fresh, now);
        let unrelated = cache.path().join("user-files");
        fs::create_dir(&unrelated).unwrap();
        cleanup_old_copies(cache.path(), now);
        assert!(!stale.exists());
        assert!(edited.exists() && fresh.exists() && unrelated.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_symlinks() {
        let cache = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("keep.txt");
        fs::write(&file, b"keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), cache.path().join("open-link")).unwrap();
        cleanup_old_copies(cache.path(), SystemTime::now() + COPY_LIFETIME + Duration::from_secs(60));
        assert_eq!(fs::read(file).unwrap(), b"keep");
    }
}
