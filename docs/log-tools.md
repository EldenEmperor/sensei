# Log tools

Sensei's edge over a general coding agent: a tool family that lets the model analyze
huge log files **without reading them into context**. You normally don't call these
yourself — you ask questions and sensei picks the tools — but knowing what exists helps
you ask better.

## The workflow sensei follows

1. **`log_stats`** first, always — one streamed pass over the file: total lines, level
   counts, time range, error-frequency-over-time buckets, and the most common error
   *templates* (messages with variable parts collapsed). Costs a few hundred tokens for
   a 200k-line file.
2. **Hypotheses, then drilling** — `log_slice` pulls exact regions (head/tail, line
   range, or a time window like `02:46:30`–`02:47:30`); `grep` finds patterns.
3. **Evidence** — answers cite `path:line` for every claim.

The guiding heuristic baked into the system prompt: hunt the *first* anomaly in time,
not the loudest one — cascades after a crash are symptoms.

## The tools

| Tool | What it does |
|---|---|
| `log_stats` | one-pass profile: levels, time range, error frequency over time, top error templates |
| `log_slice` | head/tail/line-range/time-range of a huge file, streamed, never loaded whole |
| `log_timeline` | merge 2+ logs into one timestamp-ordered view, each line tagged `[source.log]` |
| `log_trace` | follow a request/correlation id across multiple logs, in order |
| `log_baseline` | `save` a known-good profile, later `diff` a run against it: NEW error templates, count spikes |
| `log_search` | *semantic* search over a log's error templates (local Ollama embeddings; `--local` only) |
| `log_investigate` | deep structural analysis of ANY unknown format (below) |

## `log_investigate` and format maps

For a log sensei can't read out of the box — JSON lines, logfmt, CSV/TSV, Apache/W3C
access logs, epoch timestamps, exotic level vocabularies (`SEVERE`, `CRIT`, …),
multi-line stack blocks — `log_investigate` maps the structure: format family, every
timestamp style with coverage, level vocabulary, field types and cardinality, rare and
unique events.

The resulting **format map is cached** in `~/.sensei/formats/` and transparently
consumed by the other log tools: after one investigate, `log_stats` and `log_slice` can
read epoch timestamps, JSON timestamp fields, and extended level vocabularies in that
file. One pass, permanent benefit.

Shortcuts:

- `/investigate [path]` in the TUI (defaults to the newest `.log` in the directory)
- `sensei --investigate <path>` headlessly

## Baselines in practice

```
# while things are healthy:
"save a baseline of app.log as good-run"

# after a bad deploy:
"diff app.log against the good-run baseline"
→ NEW error templates (e.g. Kafka broker unreachable ×3) and COUNT SPIKES (Payment failed 10 → 50)
```

Baselines persist under `~/.sensei/`, so they survive across sessions.
