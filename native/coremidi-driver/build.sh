#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
#
# Build VRMC.plugin, a CoreMIDI driver, and sign it ad-hoc.
#
# Plain clang++ rather than Xcode: the whole thing is one translation unit and
# two frameworks, and a project file would be more machinery than the code it
# builds. The output layout is what CFBundle expects of a loadable bundle —
# WRAPPER_EXTENSION=plugin in Xcode's terms.
#
# The ad-hoc signature is the point of the exercise, not a shortcut. See the
# README: whether MIDIServer loads this is the question the spike exists to
# answer, and signing it any other way would answer a different one.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/build}"
bundle="$out/VRMC.plugin"

rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS"
cp "$here/Info.plist" "$bundle/Contents/Info.plist"

# Universal, because a Mac running this may be either architecture and a driver
# that does not match MIDIServer's architecture is simply not loaded — with no
# error anywhere the user will see.
clang++ -std=c++17 -bundle -O2 \
  -pthread \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -fvisibility=hidden \
  -Wall -Wextra -Werror \
  -framework CoreMIDI -framework CoreFoundation \
  -o "$bundle/Contents/MacOS/VRMC" \
  "$here/src/VrmcDriver.cpp"

codesign --force --sign - --timestamp=none "$bundle"
codesign --verify --strict --verbose=2 "$bundle"

echo
echo "built $bundle"
echo
codesign --display --verbose=2 "$bundle" 2>&1 | sed 's/^/  /'
