# Releasing Doom Term

Releases are tag-driven. Pushing a `v*` tag builds every platform and attaches
the bundles to a GitHub release; `workflow_dispatch` builds the same matrix
without publishing, which is the only way to learn whether a platform still
builds before a tag makes that question public.

## Cutting a release

**1. Make sure `main` is green.** `.github/workflows/ci.yml` runs on every push
and pull request across Linux and Windows, plus a format and lint job. The tag
must point at a commit that has passed it.

**2. Bump the version in all five places, together.**

```
package.json
src-tauri/tauri.conf.json
crates/doom-term-pty/Cargo.toml
backend/Cargo.toml
src-tauri/Cargo.toml
```

Then `cargo check` so `Cargo.lock` picks the new versions up, and commit the
lock with them.

**3. Write the changelog entry.** [`CHANGELOG.md`](../CHANGELOG.md) follows
Keep a Changelog. The release workflow reads the section for the tag being
built and uses it as the release notes, so an empty or missing section ships an
empty release. Include a **Known limitations** section — what the build cannot
do is part of what you are publishing.

**4. Smoke-test the matrix without publishing.**

```bash
gh workflow run release.yml --ref main
```

This builds all four targets and uploads the bundles as workflow artifacts
without creating a release. Do this before every tag. It has already caught a
silently empty artifact path and a runner class GitHub had quietly stopped
providing.

**5. Tag and push.**

```bash
git tag -a v0.2.0 -m "Doom Term v0.2.0"
git push origin v0.2.0
```

**6. Verify what actually shipped.**

```bash
gh release view v0.2.0
gh attestation verify --owner CMLeadmon <downloaded-asset>
```

Check the asset list against the matrix: Linux gives AppImage, deb and rpm;
macOS gives a dmg and an `.app.tar.gz` per architecture; Windows gives an MSI
and an NSIS `-setup.exe`. A missing platform means a job failed — the workflow
no longer tolerates that silently, but look rather than assume.

## Pre-release or not

`prerelease: true` is currently unconditional. Keep it that way while any row
in the README's platform table reads 🚧 rather than ✅ — that mark means
*implemented but not confirmed on hardware*, and a full release should not
carry unconfirmed capability claims.

## Verifying a release

Every release carries a `SHA256SUMS` file and a [build provenance
attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds),
signed through Sigstore. Users can check both:

```bash
# Contents match what was published
sha256sum --check --ignore-missing SHA256SUMS

# And it was built by this repository's workflow, not merely uploaded to it
gh attestation verify --owner CMLeadmon Doom.Term_0.2.0_x64-setup.exe
```

The attestation is the stronger of the two: a checksum file proves an asset has
not changed since it was listed, while provenance ties the binary to the
workflow run and commit that produced it.

## Code signing

Doom Term's Windows installers are **not signed**, so SmartScreen shows a
"Windows protected your PC" prompt on first run; **More info → Run anyway**
proceeds. macOS builds are not notarized.

This is stated plainly rather than worked around. Signing is being pursued
through the [SignPath Foundation](https://signpath.io/solutions/open-source-community),
which provides free certificates to open-source projects — the publisher name
shown would be theirs rather than the project's. Until then, checksums and
provenance are what a careful user can actually check, and both are stronger
evidence than an unverified signature would be.

Do not sign with a self-generated certificate. It does not clear SmartScreen
and implies a trust chain that does not exist.

## What the workflow does not do

- **No updater.** `includeUpdaterJson: false`, and no updater plugin is
  configured. Updating means downloading a new build.
- **No Actions are pinned to commit SHAs.** They float on major tags, with
  Dependabot watching them. Pinning is worth doing and is tracked separately;
  it is not a silent omission.
- **`npm run agent:verify` is not re-run per target.** It needs tmux 3.7,
  bubblewrap and Linux-only HUD reference images, and CI already runs it on
  every push to `main`. Each release job runs a typecheck and a compile check
  for its own target instead — re-running the full gate on four runners would
  only give an environment difference the power to fail a release.
