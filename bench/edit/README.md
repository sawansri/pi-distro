# Edit benchmark

Six small editing tasks on two Python files (`fixture/`), each checked by `check.py`: an off-by-one fix, adding a parameter, changing one of several near-identical lines, adding an `elif`, a rename, and a two-function change. `run.sh` runs each task in two pi agent directories, A and B, so an edit tool can be compared with pi's own.

Results on 2026-11-07, Qwen 3.8 27B (Q4_K_XL) on gufo, thinking off, 3 rounds:

| | Pass | Tool errors | Time | Input tokens | Output tokens |
|---|---|---|---|---|---|
| A: pi's `edit` | 18/18 | 0 | 629 s | 240k | 5.5k |
| B: pi-hashline-edit-pro 7.1.1 (read, replace, insert) | 18/18 | 1 | 664 s | 324k | 5.6k |

The 27B made no edit errors with pi's `edit`, and hashline's anchors on every read line cost 35% more input, so the distro keeps pi's `edit`. Worth re-running with Qwen 3.8 Flash Next.
