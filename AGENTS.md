# AGENTS.md

Purpose: guardrails for coding agents and humans working in `aur-ci`.

## CI architecture

- CI orchestrator: Buildkite
- Build logic: shell scripts (not giant inline YAML command blobs)
- Primary script: `./pkgbuild-update.sh`
- Build image: `ghcr.io/carteramesh/docker/aur-builder:latest`

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
- If switching queue names, update both controller tags and pipeline `agents.queue`.

## Secrets / credentials

- SSH keys should be file-mounted (Kubernetes Secret volume), not env vars.
- Do not print secrets or key material.
- Prefer scoped keys/tokens with minimal permissions.

## Repo hygiene

- Keep shell scripts small and composable.
- Add comments for non-obvious behavior only.
- Avoid adding heavyweight dependencies when shell + core tools are sufficient.
