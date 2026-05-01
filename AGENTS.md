# AGENTS.md

Purpose: guardrails for coding agents and humans working in `aur-ci`.

## CI architecture

- CI orchestrator: Buildkite
- Build logic: shell scripts (not giant inline YAML command blobs)
- Primary script: `./pkgbuild-update.sh`
- Build image: `ghcr.io/carteramesh/docker/aur-builder:latest`
- Buildkite pod template: `./buildkite-podtemplate.yaml`

## Buildkite docs reference (keep current)

- Start from the Buildkite docs table of contents: `https://buildkite.com/docs/llms.txt`
- Focus on **Pipelines** docs first, especially:
  - Pipelines overview/architecture/getting-started
  - Dynamic pipelines and Buildkite SDK
  - Best practices (pipeline design, caching, secrets, observability)
- For this repo's runtime model, also check:
  - Agent Stack for Kubernetes overview/installation
  - Controller configuration
  - Pod templates
  - Custom images
  - Kubernetes PodSpec / podSpecPatch

## Rules of engagement

1. Keep Buildkite YAML thin; put logic in scripts.
2. Scripts must run both locally and in CI.
3. Avoid mutating the checkout workspace unless required.
4. Use temporary workdirs (`$TMPDIR` or `/tmp`) for clone/build scratch data.
5. Use `set -euo pipefail` in shell scripts.
6. Prefer explicit logs and non-zero exits over silent failures.

## Local development

Run:

```bash
./pkgbuild-update.sh
```

Keep temp workspace for debugging:

```bash
KEEP_WORKDIR=1 ./pkgbuild-update.sh
```

## Buildkite notes

- Queue currently used by this repo pipeline: `default`
- Pipeline file: `.buildkite/pipeline.yml`
- Pod template manifest in repo: `buildkite-podtemplate.yaml`
- If switching queue names, update both controller tags and pipeline `agents.queue`.
- Current script behavior is controlled by env vars (for example `AUR_PUSH_CHANGES`, `KEEP_WORKDIR`).

## Secrets / credentials

- SSH keys should be file-mounted (Kubernetes Secret volume), not env vars.
- Do not print secrets or key material.
- Prefer scoped keys/tokens with minimal permissions.

## Debug checklist (Buildkite + k8s)

When a build fails, check these first:

1. Queue matching
   - Pipeline step `agents.queue` must match controller tags/queue.
   - Symptoms of mismatch: jobs stuck scheduled, controller logs show 0 jobs processed.

2. Secret namespace and mount path
   - Required secrets must exist in the `buildkite` namespace (not `arch` or other namespaces).
   - Verify `/home/aur_builder/.ssh/id_ed25519` exists and is a file, not a directory.

3. Runtime user and HOME
   - Confirm `id` output (expected non-root user for package builds).
   - If `HOME` is unexpected, set it explicitly in command/script before SSH operations.

4. Workspace permissions
   - Buildkite workspace may be root-owned; avoid writing there unless permissions are known.
   - Prefer temporary workdirs (`$TMPDIR` or `/tmp`) for clone/build scratch data.

5. Pod template actually applied
   - Ensure `.buildkite/pipeline.yml` includes kubernetes plugin with `podTemplate: aur-builder`.
   - Confirm `buildkite-podtemplate.yaml` is applied and current in cluster.

6. SSH connectivity sanity checks
   - `ssh -T aur@aur.archlinux.org` (or equivalent test in script/step)
   - Validate `known_hosts` and key permissions before clone/push.

## Repo hygiene

- Keep shell scripts small and composable.
- Add comments for non-obvious behavior only.
- Avoid adding heavyweight dependencies when shell + core tools are sufficient.
