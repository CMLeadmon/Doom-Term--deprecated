import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cargoTargetDirectory, sidecarBinaryPath } from './sidecar-paths.mjs';

// Expectations are built with `path.join`, never written out with '/'.
//
// `sidecarBinaryPath` joins with the platform separator, so a literal
// '/w/target/release/srv' only ever matched on Unix — and this file is about
// the one path in the build that must be right on Windows, where the sidecar
// is named `doom-term-server-x86_64-pc-windows-msvc.exe` or the bundler fails
// with "file not found". A test that cannot run on the platform it is
// protecting is not protecting it.

test('a host build reads from <target-dir>/release', () => {
  assert.equal(
    sidecarBinaryPath({ targetDirectory: join('/w', 'target'), name: 'doom-term-server' }),
    join('/w', 'target', 'release', 'doom-term-server'),
  );
});

test('a cross build reads from <target-dir>/<triple>/release', () => {
  // The whole defect. `cargo build --target <triple>` writes here, and this
  // directory was in none of the searched candidates — so a correct
  // cross-compiled build failed with "none of the candidate binary paths exist".
  assert.equal(
    sidecarBinaryPath({
      targetDirectory: join('/w', 'target'),
      triple: 'aarch64-apple-darwin',
      name: 'doom-term-server',
    }),
    join('/w', 'target', 'aarch64-apple-darwin', 'release', 'doom-term-server'),
  );
});

test('windows keeps its extension on both paths', () => {
  // Was an `||` over both separators, which passed on either platform without
  // asserting which one was correct. Joining says exactly what is expected.
  assert.equal(
    sidecarBinaryPath({ targetDirectory: 'C:\\w\\target', name: 'srv', exe: '.exe' }),
    join('C:\\w\\target', 'release', 'srv.exe'),
  );
  assert.equal(
    sidecarBinaryPath({
      targetDirectory: 'C:\\w\\target',
      triple: 'x86_64-pc-windows-msvc',
      name: 'srv',
      exe: '.exe',
    }),
    join('C:\\w\\target', 'x86_64-pc-windows-msvc', 'release', 'srv.exe'),
  );
});

test('a cross build never resolves to the host output directory', () => {
  // The dangerous half: when a stale host binary sat in a searched directory,
  // the newest-file rule selected it and the caller copied it out under the
  // requested triple's name. A binary for the wrong architecture, labelled as
  // if it were for the right one, is not a failure the packager can see.
  const cross = sidecarBinaryPath({
    targetDirectory: join('/w', 'target'),
    triple: 'x86_64-pc-windows-msvc',
    name: 'srv',
  });
  const host = sidecarBinaryPath({ targetDirectory: join('/w', 'target'), name: 'srv' });
  assert.notEqual(cross, host);
  assert.equal(cross.includes('x86_64-pc-windows-msvc'), true);
});

test('it refuses to guess when cargo has not been asked', () => {
  assert.throws(() => sidecarBinaryPath({ name: 'srv' }), /target directory/);
  assert.throws(
    () => sidecarBinaryPath({ targetDirectory: join('/w', 'target') }),
    /binary name/,
  );
});

test('the target directory comes from cargo, not from a guess', () => {
  // It moves with CARGO_TARGET_DIR, with build.target-dir in a config.toml, and
  // with workspace membership — a crate inside a workspace builds into the
  // WORKSPACE's target directory, not its own.
  let asked = null;
  const dir = cargoTargetDirectory('/w/backend/Cargo.toml', (cmd, args) => {
    asked = { cmd, args };
    return JSON.stringify({ target_directory: '/elsewhere/target' });
  });
  assert.equal(dir, '/elsewhere/target');
  assert.equal(asked.cmd, 'cargo');
  assert.equal(asked.args.includes('metadata'), true);
  assert.equal(asked.args.includes('/w/backend/Cargo.toml'), true);
});

test('a metadata reply with no target directory is an error, not a default', () => {
  assert.throws(
    () => cargoTargetDirectory('/w/backend/Cargo.toml', () => JSON.stringify({})),
    /target_directory/,
  );
});
