#!/bin/sh
# Run pi inside nono, so the agent's shell commands are confined by the kernel.
#
# Why this exists: pi asks no approval before running a tool, and the reported
# coding-agent incidents are all shell commands — deleted home directories,
# force-pushed remotes, keys read out and later committed. nono applies Landlock
# (Linux) or Seatbelt (macOS) to the whole pi process, so a command that escapes
# the workspace or reaches a credential file fails at the syscall.
#
# It is not a substitute for the distro's guard (`extensions/guard.ts`), which
# reads intent: nono let a `git push --force` through in testing, because a
# force-push is a local git operation plus an allowed domain, and nothing a
# filesystem sandbox can object to. The guard blocks that; nono blocks the
# things the guard cannot see into, like a build script that reads ~/.ssh.
#
#   ./sandbox.sh                    # pi, sandboxed, with this directory writable
#   ./sandbox.sh --allow-domain github.com   # plus one host the agent may reach
#   ./sandbox.sh -p "fix the tests"          # any pi argument passes through
#
# Anything this script does not recognise as its own flag is handed to pi.

set -eu

usage() {
  cat <<'EOF'
Usage: sandbox.sh [sandbox options] [-- pi arguments]

Sandbox options (everything else goes to pi):
  --allow-domain <host>   let the sandbox reach one host (repeatable)
  --allow <dir>           give read+write access to another directory (repeatable)
  --read <dir>            give read access to another directory (repeatable)
  --block-net             deny all network access
  --profile <name>        nono profile (default: node-dev)
  --dry-run               print the command instead of running it
  --print-alias           print a shell alias that makes bare `pi` use this
  -h, --help              this text
EOF
}

profile=node-dev
dry_run=
block_net=
# One string per grant, so repeated flags keep their own quoting.
allows=
reads=
domains=
# Arguments for pi, kept apart from the flags below so neither can consume the
# other. Only the ones after `--` are pi's; bare words are treated as pi's too.
pi_args=
saw_ddash=

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-domain)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      domains="$domains --allow-domain $2"
      shift 2
      ;;
    --allow)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      allows="$allows --allow $2"
      shift 2
      ;;
    --read)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      reads="$reads --read $2"
      shift 2
      ;;
    --block-net) block_net=1; shift ;;
    --profile)
      [ $# -ge 2 ] || { usage >&2; exit 1; }
      profile=$2
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    --print-alias)
      # An alias, not a wrapper on PATH: pi's updater rewrites its own launcher
      # (~/.pi/agent/bin/pi), so anything installed there is silently replaced.
      printf "alias pi='%s'\n" "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
      exit 0
      ;;
    -h | --help) usage; exit 0 ;;
    --) shift; saw_ddash=1; break ;;
    # Anything else is pi's, together with everything after it.
    *) break ;;
  esac
done
pi_args=$*
[ -n "$saw_ddash" ] || true

if ! command -v nono >/dev/null 2>&1; then
  echo "nono is not installed. Install it from https://nono.sh, or run pi directly." >&2
  exit 1
fi

# The real pi binary. `command -v pi` here is deliberately resolved before any
# sandboxing, and it must not be this script.
pi_bin=$(command -v pi 2>/dev/null || true)
if [ -z "$pi_bin" ]; then
  echo "pi is not on PATH." >&2
  exit 1
fi
if [ "$(cd "$(dirname "$pi_bin")" && pwd)/$(basename "$pi_bin")" = "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" ]; then
  # Guard against this script shadowing pi on PATH, which would recurse forever.
  echo "sandbox.sh is shadowing pi on PATH; install it under another name." >&2
  exit 1
fi

agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
node_bin=${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin

set -- \
  run \
  --profile "$profile" \
  --allow-cwd

# Writable scratch: the TypeScript loader (jiti) compiles extensions into /tmp,
# and without it every extension fails to load with EACCES.
set -- "$@" --allow /tmp

# pi's own agent directory: it reads models.json and settings, and writes
# sessions, trust decisions and the search-capability cache.
set -- "$@" --allow "$agent_dir"

# Node installed by pi's installer, if that is the interpreter in use.
[ -d "$node_bin" ] && set -- "$@" --read "$node_bin"

# Git reads these before any command, and refuses to run without them.
[ -f "$HOME/.gitconfig" ] && set -- "$@" --read-file "$HOME/.gitconfig"
[ -d "$HOME/.config/git" ] && set -- "$@" --read "$HOME/.config/git"
# ~/.ssh is deliberately NOT granted. It was, briefly, so that `git push` over
# SSH would work — but a read grant covers private keys, which re-opens exactly
# the hole this sandbox exists to close. Pushing is the human's step: run
# `git push` in the host shell, where you can see it.

# An extension installed as a symlink (a package kept in another repo, which is
# how this distro is developed) resolves outside the agent dir. pi refuses to
# start when one of those is unreadable, so grant the real path of each.
for entry in "$agent_dir"/extensions/*; do
  [ -e "$entry" ] || continue
  if [ -L "$entry" ]; then
    real=$(readlink -f "$entry" 2>/dev/null || true)
    [ -n "$real" ] && [ -d "$real" ] && set -- "$@" --read "$real"
  fi
done

# shellcheck disable=SC2086 # each grant is a flag and a path, with no spaces.
[ -n "$reads" ] && set -- "$@" $reads
# shellcheck disable=SC2086
[ -n "$allows" ] && set -- "$@" $allows
# shellcheck disable=SC2086
[ -n "$domains" ] && set -- "$@" $domains

# The model gateway is the one host pi cannot work without, so it is allowed by
# naming it rather than by turning the network off. Quoted, so a domain with a
# slash in it cannot become a flag.
# shellcheck disable=SC2086
[ -n "$domains" ] || set -- "$@" --allow-domain llm-api.amd.com

[ -n "$block_net" ] && set -- "$@" --block-net

# shellcheck disable=SC2086 # pi_args is a word list, re-split deliberately.
set -- "$@" -- "$pi_bin" $pi_args

if [ -n "$dry_run" ]; then
  printf '%s\n' "nono $*"
  exit 0
fi

exec nono "$@"
