#!/usr/bin/env bash
# Installs Clowdy on macOS from the latest GitHub release:
#
#   curl -fsSL https://<site>/install.sh | bash
#
# It downloads the signed app, checks its SHA-512 against the release's latest-mac.yml, and puts Clowdy.app in
# /Applications (~/Applications when that is not writable). It needs no sudo. The app updates itself from then on.
#
# Settings, all optional, as environment variables:
#   CLOWDY_VERSION      install this version (0.1.2) instead of the latest
#   CLOWDY_INSTALL_DIR  the folder to install into
#   CLOWDY_NO_OPEN      set to anything to not start Clowdy afterwards
#   CLOWDY_REPO         the GitHub repository whose releases hold the app, reforma-ai/clowdy unless set
#   CLOWDY_RELEASE_URL  the folder that holds latest-mac.yml and the zips, in place of the release (for tests)
#
# Everything is in functions that run on the last line: a download cut short never runs half of the script.

set -euo pipefail

TMP_DIR=""

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

main() {
    local repo="${CLOWDY_REPO:-reforma-ai/clowdy}"
    local arch=x64 base feed version entry zip expected actual app dir dest

    [ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, run install.ps1 in PowerShell."

    # A terminal that runs under Rosetta reports x86_64 on Apple silicon too.
    if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
        arch=arm64
    fi

    if [ -n "${CLOWDY_RELEASE_URL:-}" ]; then
        base="${CLOWDY_RELEASE_URL%/}"
    elif [ -n "${CLOWDY_VERSION:-}" ]; then
        base="https://github.com/$repo/releases/download/v${CLOWDY_VERSION#v}"
    else
        base="https://github.com/$repo/releases/latest/download"
    fi

    TMP_DIR="$(mktemp -d)"
    trap cleanup EXIT

    say "Looking for Clowdy for $arch"

    feed="$TMP_DIR/latest-mac.yml"
    curl -fsSL "$base/latest-mac.yml" -o "$feed" ||
        fail "Could not read $base/latest-mac.yml. Check the connection, and that the release exists and is public."

    version="$(awk '/^version:/ { print $2; exit }' "$feed")"

    # The files of the feed, each as `- url: <name>` and an indented `sha512: <base64>`; the one for this processor.
    entry="$(awk -v suffix="-$arch.zip" '
        /^ *- url:/ { url = $3; next }
        /^ +sha512:/ && url != "" && substr(url, length(url) - length(suffix) + 1) == suffix { print url " " $2; exit }
    ' "$feed")"

    [ -n "$entry" ] || fail "latest-mac.yml has no download for $arch."

    zip="${entry% *}"
    expected="${entry#* }"

    say "Downloading Clowdy ${version:-} ($zip)"
    curl -fL --progress-bar "$base/$zip" -o "$TMP_DIR/$zip" || fail "Could not download $base/$zip."

    actual="$(/usr/bin/openssl dgst -sha512 -binary "$TMP_DIR/$zip" | /usr/bin/base64 | tr -d '\n')"

    [ "$actual" = "$expected" ] || fail "$zip does not match the checksum in latest-mac.yml, so it was not installed."

    ditto -x -k "$TMP_DIR/$zip" "$TMP_DIR/unpacked" || fail "Could not unpack $zip."

    app="$TMP_DIR/unpacked/Clowdy.app"

    [ -d "$app" ] || fail "$zip holds no Clowdy.app."
    codesign --verify --deep --strict "$app" 2>/dev/null || fail "The signature of Clowdy.app does not verify."

    # Only a notarized build can update itself; any other asks for a download instead.
    if spctl --assess --type execute "$app" 2>/dev/null; then
        say "Signed and notarized by Apple"
    else
        say "Note: this build is not notarized, so it cannot update itself"
    fi

    dir="${CLOWDY_INSTALL_DIR:-}"

    if [ -z "$dir" ]; then
        if [ -w /Applications ]; then dir=/Applications; else dir="$HOME/Applications"; fi
    fi

    mkdir -p "$dir"
    dest="$dir/Clowdy.app"

    if [ -e "$dest" ] && pgrep -x Clowdy >/dev/null 2>&1; then
        fail "Clowdy is running. Quit it and run the installer again."
    fi

    # The new copy is complete before the old one goes.
    rm -rf "$dest.installing"
    ditto "$app" "$dest.installing"
    rm -rf "$dest"
    mv "$dest.installing" "$dest"

    say "Clowdy ${version:-} is installed in $dir"

    if [ -z "${CLOWDY_NO_OPEN:-}" ]; then open "$dest"; fi
}

main "$@"
