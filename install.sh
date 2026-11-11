#!/bin/sh
# Install pi-distro on Linux or macOS.
#
#   ./install.sh                                 # global: ~/.pi/agent (or $PI_CODING_AGENT_DIR)
#   ./install.sh --dev                           # load extensions from this clone, for working on them
#   ./install.sh --gateway https://gw.example.com/Unified/v1 --concurrency 6
#   ./install.sh --dir ~/.pi/pi-distro-gateway   # self-contained dir, leaves your global setup alone
#
# Web search and /research go through the gateway's own search tool, using the
# same key as the chat models: export LLM_GATEWAY_KEY before starting pi, or
# name another variable in models.json.
#
# Installs pi with its official installer when it is missing, then the pinned
# packages in config/packages.txt and this distro, then its configuration (see
# scripts/configure.mjs). The distro is copied into the agent directory, so this
# clone can be deleted afterwards. Safe to re-run.
set -eu

usage() {
  echo "Usage: $0 [--dir <path>] [--gateway <url>] [--anthropic <url>] [--concurrency <n>] [--dev]"
  echo "  --dir <path>       install into a self-contained pi agent directory instead of ~/.pi/agent"
  echo "  --gateway <url>    the gateway's OpenAI-compatible (Responses) URL, \`.../v1\`"
  echo "  --anthropic <url>  the gateway's Anthropic-compatible URL for the same service"
  echo "  --concurrency <n>   how many subagent tasks run at once (default 4)"
  echo "  --dev              load extensions from this clone instead of a copy"
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
    --gateway | --anthropic | --concurrency | --sessions)
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
elif [ "$here" != "$copy_dir" ]; then
  # configure.mjs drops the copy from pi's settings; the files go too.
  rm -rf "$copy_dir"
fi
echo "  $package_dir"
"$pi" install "$package_dir" </dev/null >/dev/null

node=$(command -v node 2>/dev/null || echo "${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node")
say "Configuring"
# shellcheck disable=SC2086 # configure_args holds flag/value pairs without spaces.
"$node" "$here/scripts/configure.mjs" --agent-dir "$agent_dir" --package-dir "$package_dir" $configure_args

if [ -z "${LLM_GATEWAY_KEY:-}" ]; then
  echo "  Note: export LLM_GATEWAY_KEY before starting pi; models.json reads it." >&2
fi

if [ "$agent_dir" = "$HOME/.pi/agent" ]; then
  say "Done. Start pi with:  pi"
else
  say "Done. Start pi with:  PI_CODING_AGENT_DIR=$agent_dir pi"
fi
cat <<'EOF'

  shift+tab, /plan    plan mode: read-only until you approve the plan
  alt+t               thinking level
  /research <topic>   deep research, searching through the gateway
  /remember <note>    keep a note for future sessions (-g: every project)
  /handoff [focus]    continue in a fresh session from a summary
  /undo, /redo        revert or restore the last turn's file changes
EOF
