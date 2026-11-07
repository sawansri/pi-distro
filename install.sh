#!/bin/sh
# Install pi-distro on Linux or macOS.
#
#   ./install.sh                                 # global: ~/.pi/agent (or $PI_CODING_AGENT_DIR)
#   ./install.sh --searxng http://localhost:8888 # use a local SearXNG for web search
#   ./install.sh --gufo http://127.0.0.1:8080/v1 --sessions 4
#   ./install.sh --dir ~/.pi/pi-distro-test      # self-contained dir, leaves your global setup alone
#   ./install.sh --dev                           # load extensions from this clone, for working on them
#
# Installs pi with its official installer when it is missing, then the pinned
# packages in config/packages.txt and this distro, then its configuration (see
# scripts/configure.mjs). The distro is copied into the agent directory, so this
# clone can be deleted afterwards. Safe to re-run.
set -eu

usage() {
  echo "Usage: $0 [--dir <path>] [--gufo <url>] [--searxng <url>] [--sessions <n>] [--dev]"
  echo "  --dir <path>      install into a self-contained pi agent directory instead of ~/.pi/agent"
  echo "  --gufo <url>      gufo's OpenAI-compatible URL (default http://127.0.0.1:8080/v1)"
  echo "  --searxng <url>   your SearXNG instance, tried first for web search"
  echo "  --sessions <n>    gufo's --sessions: how many subagents run at once (default 2)"
  echo "  --dev             load extensions from this clone instead of a copy"
}

own_dir=
dev=
configure_args=
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      mkdir -p "$2"
      PI_CODING_AGENT_DIR=$(cd "$2" && pwd)
      export PI_CODING_AGENT_DIR
      own_dir=1
      shift 2
      ;;
    --gufo | --searxng | --sessions)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      configure_args="$configure_args $1 $2"
      shift 2
      ;;
    --dev) dev=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}

say() { printf '\033[1m%s\033[0m\n' "$*"; }

if ! command -v pi >/dev/null 2>&1; then
  say "pi not found; running the official installer from https://pi.dev"
  curl -fsSL https://pi.dev/install.sh | sh | cat
fi
pi=$(command -v pi 2>/dev/null || true)
[ -n "$pi" ] || pi="$agent_dir/bin/pi"
if [ ! -x "$pi" ]; then
  echo "pi is still not available. Install it from https://pi.dev, open a new shell, and run this again." >&2
  exit 1
fi

version=$("$pi" --version 2>/dev/null </dev/null | head -n1)
case "$version" in
  0.* | 1.[0-4] | 1.[0-4].*)
    if [ -n "$own_dir" ]; then
      echo "pi $version is too old; pi-distro needs 1.5 or newer. Run \`pi update\`, then run this again." >&2
      exit 1
    fi
    say "Updating pi $version (pi-distro needs 1.5 or newer)"
    "$pi" update --self </dev/null
    ;;
esac

say "Installing packages into $agent_dir"
grep -v -e '^#' -e '^[[:space:]]*$' "$here/config/packages.txt" | while IFS= read -r package; do
  echo "  $package"
  "$pi" install "$package" </dev/null >/dev/null
done

# pi loads a local package in place, so it's copied into the agent directory
# first, unless --dev asks for the clone itself.
copy_dir="$agent_dir/pi-distro"
package_dir=$here
if [ -z "$dev" ]; then
  if [ "$here" != "$copy_dir" ]; then
    rm -rf "$copy_dir"
    mkdir -p "$copy_dir"
    for file in package.json extensions agents LICENSE README.md; do
      cp -R "$here/$file" "$copy_dir/"
    done
  fi
  package_dir=$copy_dir
else
  # configure.mjs drops the copy from pi's settings; the files go too.
  rm -rf "$copy_dir"
fi
echo "  $package_dir"
"$pi" install "$package_dir" </dev/null >/dev/null

node=$(command -v node 2>/dev/null || echo "${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node")
say "Configuring"
# shellcheck disable=SC2086 # configure_args holds flag/value pairs without spaces.
"$node" "$here/scripts/configure.mjs" --agent-dir "$agent_dir" --package-dir "$package_dir" $configure_args

if [ "$agent_dir" = "$HOME/.pi/agent" ]; then
  say "Done. Start pi with:  pi"
else
  say "Done. Start pi with:  PI_CODING_AGENT_DIR=$agent_dir pi"
fi
cat <<'EOF'

  shift+tab, /plan    plan mode: read-only until you approve the plan
  alt+t               thinking level (set it before you start; changing it
                      mid-session makes gufo reprocess the conversation)
  /research <topic>   deep research with sources
  /remember <note>    keep a note for future sessions (-g: every project)
  /handoff [focus]    continue in a fresh session from a summary
  /undo, /redo        revert or restore the last turn's file changes
EOF
