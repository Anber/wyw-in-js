---
'@wyw-in-js/transform': patch
---

Add optional JSONL debug output for evaluator payloads and transform perf spans.

`eval-files.jsonl` records shipped evaluator code and serialized or stringified value details. `perf-spans.jsonl` records transform perf spans so evaluator and transform costs can be analyzed alongside action, dependency, and entrypoint logs.
