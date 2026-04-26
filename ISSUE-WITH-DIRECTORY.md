# `withDirectory` changes ownership of `/home/<user>` and breaks non-root workflows

## Summary
Using `Container.withDirectory()` to mount a source directory under a non-root user's home (for example `/home/aur_builder/repo-src`) can unexpectedly make parent paths (`/home`, `/home/aur_builder`) owned by `root:root` in the resulting snapshot. This causes permission failures for subsequent non-root `withExec` steps.

Workaround: explicitly set `owner` in `withDirectory(..., { owner: "<uid>:<gid>" })`.

---

## Environment
- Dagger CLI/Engine: `v0.20.6`
- Base image: `ghcr.io/carteramesh/docker/aur-builder:latest`
- Container default user: `aur_builder` (`uid=1001`, `gid=1001`)

Image Dockerfile excerpt:

```dockerfile
RUN groupadd --gid 1001 aur_builder && useradd --uid 1001 --gid 1001 --no-user-group --create-home --shell /bin/bash aur_builder
USER aur_builder
WORKDIR /home/aur_builder
```

---

## Expected behavior
`withDirectory("/home/aur_builder/repo-src", sourceDir)` should not make `/home/aur_builder` unwritable for the image's configured non-root user.

At minimum, parent directory ownership/mode should remain compatible with subsequent non-root operations.

---

## Actual behavior
After `withDirectory(...)` (without `owner`), subsequent `withExec` running as uid 1001 fails:

```text
mkdir: cannot create directory '/home/aur_builder/repo': Permission denied
```

Inspection from inside the same container chain shows:

```text
drwxr-xr-x 1 root root 3 ... /home
drwxr-xr-x 1 root root 3 ... /home/aur_builder
drwxr-xr-x 5 root root ... /home/aur_builder/repo-src
```

So `/home/aur_builder` is no longer owned/writable by `aur_builder`.

---

## Minimal repro (CLI)

### 1) Baseline (works)

```bash
dagger core container \
  from --address=ghcr.io/carteramesh/docker/aur-builder:latest \
  with-exec --args=bash,-lc,'id; ls -ld /home /home/aur_builder; mkdir -p /home/aur_builder/repo && echo OK' \
  stdout
```

Observed:
- user is `uid=1001(aur_builder)`
- `/home/aur_builder` owned by `aur_builder`
- mkdir succeeds

### 2) Add `withDirectory` under `/home/aur_builder` (fails)

```bash
dagger core container \
  from --address=ghcr.io/carteramesh/docker/aur-builder:latest \
  with-directory --path=/home/aur_builder/repo-src --source=. \
  with-exec --args=bash,-lc,'id; ls -ld /home /home/aur_builder /home/aur_builder/repo-src; mkdir -p /home/aur_builder/repo && echo OK' \
  stdout
```

Observed:
- `/home` and `/home/aur_builder` become `root:root`
- mkdir fails with permission denied

### 3) Same operation but explicit owner (works)

```bash
dagger core container \
  from --address=ghcr.io/carteramesh/docker/aur-builder:latest \
  with-directory --path=/home/aur_builder/repo-src --source=. --owner=1001:1001 \
  with-exec --args=bash,-lc,'id; ls -ld /home /home/aur_builder /home/aur_builder/repo-src; mkdir -p /home/aur_builder/repo && echo OK' \
  stdout
```

Observed:
- ownership is `aur_builder:aur_builder`
- mkdir succeeds

---

## Repro in TypeScript SDK

### Failing shape

```ts
const c = dag
  .container()
  .from("ghcr.io/carteramesh/docker/aur-builder:latest")
  .withDirectory("/home/aur_builder/repo-src", sourceDir)
  .withExec([
    "bash",
    "-lc",
    "id; ls -ld /home /home/aur_builder /home/aur_builder/repo-src; mkdir -p /home/aur_builder/repo",
  ])
```

### Working shape

```ts
const c = dag
  .container()
  .from("ghcr.io/carteramesh/docker/aur-builder:latest")
  .withDirectory("/home/aur_builder/repo-src", sourceDir, { owner: "1001:1001" })
  .withExec([
    "bash",
    "-lc",
    "id; ls -ld /home /home/aur_builder /home/aur_builder/repo-src; mkdir -p /home/aur_builder/repo",
  ])
```

---

## Why this matters
- Non-root images are standard hardening practice in CI.
- Workflows that rely on writable `$HOME` break unless callers remember to always set `owner` for `withDirectory` under home paths.
- This behavior is surprising compared to typical container/Docker expectations where adding files to a subpath should not silently make the parent unwritable to the configured runtime user.

---

## Possible issue area
Likely related to `withDirectory` snapshot/merge behavior when owner is unset and destination parent metadata is merged from scratch layer defaults.

(Observed while inspecting `core/container.go` -> `Container.WithDirectory` and `core/directory.go` -> `Directory.WithDirectory` copy/merge path.)

---

## Requested clarification/fix
1. Clarify intended ownership semantics of `withDirectory` when `owner` is omitted.
2. Ensure destination parent path ownership/mode does not regress for existing non-root user workflows.
3. If current behavior is intentional, document this explicitly with guidance for non-root images.
