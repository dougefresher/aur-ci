#!/usr/bin/env bash
set -euo pipefail

PUSH_CHANGES="${AUR_PUSH_CHANGES:-0}"

PACKAGES=(
  pi-ext-powerline-footer
  pi-ext-subagents
  pi-ext-awsdocs
  pi-ext-cursor-rules
  pi-ext-boomerang
  pi-ext-intercom
)
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/aur-ci.XXXXXX")"
if [[ "${KEEP_WORKDIR:-0}" != "1" ]]; then
  trap 'rm -rf "$WORKDIR"' EXIT
else
  echo "KEEP_WORKDIR=1, preserving workspace: $WORKDIR"
fi

mkdir -p "$WORKDIR/repos"
cd "$WORKDIR/repos"
for pkg in "${PACKAGES[@]}"; do
  git clone "ssh://aur@aur.archlinux.org/${pkg}.git"
  (
    cd $pkg
    source PKGBUILD
    current_pkgver="$pkgver"
    # Query upstream using structured logs
    nvlog="$(mktemp)"
    trap 'rm -f "$nvlog"' EXIT
    nvchecker -c .nvchecker.toml --logger=json >"$nvlog"

    latest_pkgver="$(jq -r --arg p "$pkgname" 'select((.event == "updated" or .event == "up-to-date") and .name == $p) | .version' "$nvlog" | tail -n1)"

    if [[ -z "$latest_pkgver" || "$latest_pkgver" == "null" ]]; then
      echo "nvchecker returned no version for $pkgname" >&2
      exit 1
    fi

    if [[ "$latest_pkgver" == "$current_pkgver" ]]; then
      echo "$pkgname is up to date ($current_pkgver)"
      exit 0
    fi

    echo "Updating $pkgname: $current_pkgver -> $latest_pkgver"

    tmp="$(mktemp)"
    awk -v v="$latest_pkgver" '
  /^pkgver=/ { print "pkgver=" v; next }
  /^pkgrel=/ { print "pkgrel=1"; next }
  { print }
' PKGBUILD >"$tmp"
    mv "$tmp" PKGBUILD

    updpkgsums
    makepkg --printsrcinfo >.SRCINFO
    # CI currently does metadata/lint updates only; full builds are deferred.
    # Avoid `makepkg -s --nobuild` here because it can trigger interactive sudo.
    namcap PKGBUILD
    nvtake -c .nvchecker.toml "$pkgname"

    if [[ "$PUSH_CHANGES" == "1" || "$PUSH_CHANGES" == "true" || "$PUSH_CHANGES" == "yes" ]]; then
      if git diff --quiet -- PKGBUILD .SRCINFO; then
        echo "No commit needed for $pkgname"
      else
        git add PKGBUILD .SRCINFO oldver.json
        git commit -m "automated update: ${current_pkgver} -> ${latest_pkgver}"
        git push origin HEAD
      fi
    else
      echo "AUR_PUSH_CHANGES not enabled; skipping commit/push for $pkgname"
    fi
  )
done
