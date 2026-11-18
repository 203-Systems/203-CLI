#!/bin/sh
# Installs this checkout of 203-CLI as the 203-community Agent Skill and the 203c command, the same layout the
# community's installer makes (curl -fsSL https://cardenza.203.io/community/skill/install.sh | sh):
#   ${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/203-community   SKILL.md, LICENSE, scripts/, reference/, products/
#   ${COMMUNITY_BIN_DIR:-$HOME/.local/bin}/203c                  a two-line script running scripts/203c.mjs
# Run it from anywhere: sh path/to/203-CLI/install.sh. No sudo, no network.
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
BIN="${COMMUNITY_BIN_DIR:-$HOME/.local/bin}"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

fail() { echo "203-CLI: $*" >&2; exit 1; }
[ -f "$SRC/SKILL.md" ] && [ -f "$SRC/scripts/203c.mjs" ] || fail "run this script from a 203-CLI checkout"
[ -n "$DEST" ] && [ "$DEST" != "/" ] || fail "no place to install (set CLAUDE_SKILLS_DIR)"

mkdir -p "$DEST"
rm -rf "$DEST/.203-community.new"
mkdir "$DEST/.203-community.new"
for item in SKILL.md LICENSE scripts reference products; do cp -R "$SRC/$item" "$DEST/.203-community.new/"; done
rm -rf "$DEST/203-community"
mv "$DEST/.203-community.new" "$DEST/203-community"
chmod +x "$DEST/203-community/scripts/203c.mjs" 2>/dev/null || true
echo "Installed the 203-community skill in $DEST/203-community (from $SRC)"

if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 18 ] || echo "Note: 203c needs Node 18 or newer (found $(node --version))." >&2
else
  echo "Note: 203c needs Node 18 or newer (https://nodejs.org)." >&2
fi
if mkdir -p "$BIN" 2>/dev/null && [ -w "$BIN" ]; then
  printf '#!/bin/sh\nexec node "%s/203-community/scripts/203c.mjs" "$@"\n' "$DEST" > "$BIN/203c"
  chmod +x "$BIN/203c"
  echo "Installed the command $BIN/203c"
  case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: $BIN is not on your PATH; add it, or run node \"$DEST/203-community/scripts/203c.mjs\"" >&2 ;; esac
  echo "Try: 203c doctor"
else
  echo "Try: node \"$DEST/203-community/scripts/203c.mjs\" doctor"
fi
