# Editorial audit

Public text was reviewed across the README, documentation, CLI messages, report templates, GitHub Check/comment text, issue and pull-request templates, release notes, package metadata, worker messages, and the proposed repository metadata. The current gate scans 113 public files.

The review removed em and en dashes, inflated product claims, generic marketing adjectives, canned comparisons, fake quotations, and repeated summaries. Descriptions now state the observable behavior and its limits. The automated guard currently scans 113 public files:

```text
pnpm editorial:check
```

It scans public Markdown, text examples, YAML, and source strings and fails on U+2014 or U+2013. It does not replace human review of tone or technical accuracy.
