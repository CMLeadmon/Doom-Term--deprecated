/**
 * Tell a machine that cannot build the desktop shell apart from a shell that
 * does not build.
 *
 * `src-tauri` is a workspace member but not a DEFAULT member, so the generic
 * `cargo check` and `cargo test` in the verification command never touched it:
 * the unified gate reported success while the crate users actually run had not
 * been looked at. It is excluded for a reason — it needs system development
 * packages (glib, gtk, dbus-1, webkit2gtk) that a headless checkout lacks — so
 * asking for it explicitly means these two outcomes have to be separated.
 *
 * Getting this wrong in the permissive direction is the exact failure being
 * fixed, so the markers are specific: a bare "pkg-config" also appears in
 * ordinary progress lines like `Compiling pkg-config v0.3.34`.
 */
const ENVIRONMENT_MARKERS = [
  // Linux: pkg-config cannot find a system development package.
  'was not found in the pkg-config search path',
  'could not find system library',
  'required by crate',
  'pkg-config exited with status code',
  'No package',
  // Windows: nothing here says "pkg-config", so a missing toolchain read as a
  // hard FAIL — the exact permissive-direction error this file exists to
  // prevent, just pointed the other way. A runner without the MSVC build tools
  // or the WebView2 SDK is a blocked environment, not a broken crate.
  'failed to find tool',
  'linker `link.exe` not found',
  'Microsoft Visual Studio',
  'MSVC build tools',
  'WebView2',
];

/**
 * @returns {{ kind: 'pass' } | { kind: 'blocked', reason?: string } | { kind: 'fail' }}
 */
export function classifyCargoFailure(status, output) {
  if (status === 0) return { kind: 'pass' };

  const lines = String(output ?? '').split('\n').map((line) => line.trim());
  const blocked = lines.some((line) =>
    ENVIRONMENT_MARKERS.some((marker) => line.includes(marker)));
  if (!blocked) return { kind: 'fail' };

  // Prefer the line that names the missing library over the one that merely
  // reports a non-zero exit.
  const reason =
    lines.find((line) => line.includes('The system library')) ??
    lines.find((line) => line.includes('was not found in the pkg-config search path')) ??
    lines.find((line) => line.includes('failed to find tool')) ??
    lines.find((line) => line.includes('linker `link.exe` not found')) ??
    lines.find((line) => ENVIRONMENT_MARKERS.some((marker) => line.includes(marker)));

  return { kind: 'blocked', reason };
}
