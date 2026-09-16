import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCargoFailure } from './tauri-check-result.mjs';

const MISSING_DBUS = `
   Compiling pkg-config v0.3.34
error: failed to run custom build command for \`libdbus-sys v0.2.7\`
  pkg-config exited with status code 1
  pkg-config output:
    Package dbus-1 was not found in the pkg-config search path.
  The system library \`dbus-1\` required by crate \`libdbus-sys\` was not found.
`;

const REAL_COMPILE_ERROR = `
   Compiling pkg-config v0.3.34
   Compiling doom-term v0.1.0
error[E0308]: mismatched types
 --> src-tauri/src/commands.rs:12:5
  |
12|     "not a u32"
  |     ^^^^^^^^^^^ expected \`u32\`, found \`&str\`
error: could not compile \`doom-term\` due to 1 previous error
`;

test('a successful check is a pass', () => {
  assert.deepEqual(classifyCargoFailure(0, ''), { kind: 'pass' });
});

test('missing system libraries are an environment block, not a failure', () => {
  const verdict = classifyCargoFailure(101, MISSING_DBUS);
  assert.equal(verdict.kind, 'blocked');
  assert.match(verdict.reason, /dbus-1/);
  assert.match(verdict.reason, /The system library/);
});

test('the reported reason names the library, not the progress line', () => {
  // `Compiling pkg-config v0.3.34` contains the string "pkg-config" and is the
  // FIRST line that would match a loose marker. Quoting it tells the reader
  // nothing about what is actually missing.
  const verdict = classifyCargoFailure(101, MISSING_DBUS);
  assert.equal(verdict.reason.includes('Compiling'), false);
});

test('a genuine compile error fails the gate', () => {
  // The direction that matters. Calling this a blocked environment would put
  // the verification command straight back to reporting success for a desktop
  // shell that does not build — the finding this whole check exists to fix.
  assert.deepEqual(classifyCargoFailure(101, REAL_COMPILE_ERROR), { kind: 'fail' });
});

test('an empty failure with no explanation fails rather than excusing itself', () => {
  assert.deepEqual(classifyCargoFailure(1, ''), { kind: 'fail' });
  assert.deepEqual(classifyCargoFailure(1, undefined), { kind: 'fail' });
});

test('a Windows runner without the MSVC toolchain is blocked, not broken', () => {
  // Before this, nothing in the marker list said anything a Windows failure
  // says, so a missing build tool was reported as "the crate does not
  // compile" — conflating an environment with a defect, which is the one
  // thing this classifier exists to keep apart.
  const result = classifyCargoFailure(
    101,
    'error occurred in cc-rs: failed to find tool "lib.exe": No such file or directory'
  );
  assert.equal(result.kind, 'blocked');
  assert.match(result.reason, /failed to find tool/);
});

test('a missing MSVC linker is blocked, not broken', () => {
  const result = classifyCargoFailure(101, 'error: linker `link.exe` not found');
  assert.equal(result.kind, 'blocked');
});

test('a real Windows compile error is still a failure', () => {
  // The permissive direction remains the dangerous one: a genuine error on
  // Windows must not be excused just because the platform is Windows.
  const result = classifyCargoFailure(101, 'error[E0425]: cannot find value `nope` in this scope');
  assert.equal(result.kind, 'fail');
});
