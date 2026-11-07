#!/bin/sh
# Edit benchmark: runs each task in tasks.tsv in two pi agent directories and
# checks the result with check.py. Compare pi's edit tool with an alternative
# such as pi-hashline-edit-pro installed in a copy of your agent directory.
#
#   AGENT_A=~/.pi/agent AGENT_B=~/.pi/agent-hashline MODEL=gufo/qwen3.8-flash-next:off sh run.sh 3
#
# Results go to results.tsv in the current directory; work copies to ./work.
set -u
here=$(cd "$(dirname "$0")" && pwd)
rounds=${1:-1}
model=${MODEL:-gufo/qwen3.8-flash-next:off}
out=$PWD/results.tsv
mkdir -p "$PWD/work"
: > "$out"
for round in $(seq 1 "$rounds"); do
  while IFS='	' read -r task prompt; do
    for variant in A B; do
      case $variant in A) agent=$AGENT_A ;; B) agent=$AGENT_B ;; esac
      work=$PWD/work/$variant-$task-$round
      rm -rf "$work" && cp -r "$here/fixture" "$work"
      events=$work.jsonl
      start=$(date +%s)
      ( cd "$work" && PI_CODING_AGENT_DIR=$agent timeout 600 \
          pi --no-session --model "$model" --mode json -p "$prompt" </dev/null > "$events" 2>&1 )
      seconds=$(( $(date +%s) - start ))
      result=$(python3 -I "$here/check.py" "$task" "$work" | tail -1)
      calls=$(grep -c '"type":"tool_execution_end"' "$events")
      errors=$(grep '"type":"tool_execution_end"' "$events" | grep -c '"isError":true')
      tokens=$(python3 -I "$here/tokens.py" "$events")
      printf '%s\t%s\t%s\t%s\t%ss\tcalls=%s\terrors=%s\t%s\n' "$round" "$task" "$variant" "$result" "$seconds" "$calls" "$errors" "$tokens" | tee -a "$out"
    done
  done < "$here/tasks.tsv"
done
