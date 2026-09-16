//! Environment passed across the desktop shell → host daemon boundary.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) fn sanitize(
    env: impl IntoIterator<Item = (OsString, OsString)>,
) -> HashMap<OsString, OsString> {
    let mut env: HashMap<OsString, OsString> = env.into_iter().collect();
    // Capture the mount root before removing the AppImage markers. Component
    // matching keeps similarly named host directories (e.g. bundle-tools).
    let appdir = env.get(&OsString::from("APPDIR")).map(PathBuf::from);
    if let Some(root) = appdir.filter(|p| p.is_absolute() && p.parent().is_some()) {
        for key in ["PATH", "XDG_DATA_DIRS"] {
            if let Some(value) = env.get_mut(&OsString::from(key)) {
                *value = std::env::join_paths(
                    std::env::split_paths(value).filter(|path| !path.starts_with(&root)),
                )
                .expect("split environment paths can be rejoined");
            }
        }
    }
    for key in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "APPDIR",
        "APPIMAGE",
        "PYTHONHOME",
        "PERLLIB",
        "GTK_PATH",
    ] {
        env.remove(&OsString::from(key));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(entries: &[(&str, &str)]) -> HashMap<OsString, OsString> {
        entries
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn removes_bundle_environment_and_preserves_host_settings() {
        let inherited = fixture(&[
            ("APPDIR", "/tmp/.mount_Doom123"),
            ("APPIMAGE", "/home/user/Doom.AppImage"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_Doom123/usr/lib"),
            ("LD_PRELOAD", "/tmp/.mount_Doom123/usr/lib/preload.so"),
            ("PYTHONHOME", "/tmp/.mount_Doom123/usr"),
            ("PERLLIB", "/tmp/.mount_Doom123/usr/lib/perl"),
            ("GTK_PATH", "/tmp/.mount_Doom123/usr/lib/gtk"),
            (
                "PATH",
                "/tmp/.mount_Doom123/usr/bin:/home/user/bin:/usr/bin:/tmp/.mount_Doom123/bin",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_Doom123/usr/share:/usr/local/share:/usr/share",
            ),
            ("HOME", "/home/user"),
            ("SSH_AUTH_SOCK", "/run/user/1000/keyring/ssh"),
            ("DOOM_TERM_PORT", "1421"),
        ]);
        assert_eq!(
            sanitize(inherited),
            fixture(&[
                ("PATH", "/home/user/bin:/usr/bin"),
                ("XDG_DATA_DIRS", "/usr/local/share:/usr/share"),
                ("HOME", "/home/user"),
                ("SSH_AUTH_SOCK", "/run/user/1000/keyring/ssh"),
                ("DOOM_TERM_PORT", "1421"),
            ])
        );
    }

    #[test]
    fn path_filter_uses_directory_boundaries_and_preserves_empty_entries() {
        assert_eq!(
            sanitize(fixture(&[
                ("APPDIR", "/tmp/bundle/"),
                (
                    "PATH",
                    "/tmp/bundle/bin::/tmp/bundle-other/bin:/usr/bin:/tmp/bundle"
                ),
                ("XDG_DATA_DIRS", "/tmp/bundle/share"),
            ])),
            fixture(&[
                ("PATH", ":/tmp/bundle-other/bin:/usr/bin"),
                ("XDG_DATA_DIRS", ""),
            ])
        );
    }

    #[test]
    fn absent_or_empty_appdir_does_not_remove_host_paths() {
        let host = fixture(&[("PATH", "/usr/local/bin:/usr/bin"), ("LANG", "en_US.UTF-8")]);
        assert_eq!(sanitize(host.clone()), host);
        let mut empty = host.clone();
        empty.insert("APPDIR".into(), "".into());
        assert_eq!(sanitize(empty), host);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_utf8_environment_values() {
        use std::os::unix::ffi::OsStringExt;
        let host_path = OsString::from_vec(b"/home/\xff/bin:/usr/bin".to_vec());
        let mut inherited = fixture(&[("APPDIR", "/tmp/bundle")]);
        inherited.insert(
            "PATH".into(),
            OsString::from_vec(b"/tmp/bundle/bin:/home/\xff/bin:/usr/bin".to_vec()),
        );
        inherited.insert("CUSTOM".into(), OsString::from_vec(vec![255]));
        let result = sanitize(inherited);
        assert_eq!(result.get(&OsString::from("PATH")), Some(&host_path));
        assert_eq!(
            result.get(&OsString::from("CUSTOM")),
            Some(&OsString::from_vec(vec![255]))
        );
    }
}
