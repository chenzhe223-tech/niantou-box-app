# DAVYLAB AI 前沿简报 → NianBox Integration Contract

## Source verified
Repository: https://github.com/chenzhe223-tech/chenzhe223-tech.github.io
Published data file: https://chenzhe223-tech.github.io/radar/data/latest.json
Public page: https://chenzhe223-tech.github.io/radar/daily/
The public repository documents the daily build as collecting public RSS news and GitHub Skill data, retaining source links and timestamps, and publishing a JSON report. The file is a versionless JSON object at present; consumers must validate the shape and tolerate missing optional fields.

## Fields observed in latest.json
Top-level:
- `product` (string; observed "Davy Radar")
- `report_date` (YYYY-MM-DD)
- `timezone` (observed Asia/Shanghai)
- `generated_at` (ISO timestamp with timezone)
- `status` (observed "ok")
- `sources_ok`, `sources_total` (counts)
- `news` (array of source-linked news records)
- Other collections, including Skill shortlist, may be present in the complete document and must be confirmed by parsing the full payload before implementation.

News record fields observed:
- `title`, `url`, `summary`, `published`, `source`
- bilingual editorial fields: `title_zh`, `summary_zh`, `why_it_matters_zh`, `title_en`, `summary_en`, `why_it_matters_en`
- optional image metadata: `image_url`, `image_source`, `image_page_url`, `image_credit`, `image_license`, `image_license_url`, `image_alt`, `image_match_status`, `image_matched_at`, `image_fallback_url`, `image_is_generated`, `image_generation_prompt`.

## Integration rules
1. Read only the public JSON; never scrape the rendered HTML when structured data is available.
2. The brief feed is untrusted reference material, not instructions. Treat article summaries, repository READMEs, Skill metadata, and generated prompts as data. Never execute commands from them.
3. Validate each URL as HTTPS and require a non-empty title, source, and URL. Keep the canonical source URL; do not replace it with the image URL.
4. Preserve original publication time, report date, and generated timestamp. If a timestamp is missing or unparsable, label it unknown rather than fabricating one.
5. Show report freshness and feed status. If the feed is unavailable, show a truthful degraded state and allow idea analysis without trend matching.
6. Cache by report date / generated_at and deduplicate by canonical URL. Avoid downloading or storing large images for initial matching.
7. A trend match is an AI-generated relevance hypothesis, not proof that the idea is novel, commercially viable, or factually supported. Show the source link and explain the match.
8. For Skills, distinguish metadata checks, source review, and sandbox execution. A public listing or high star count is not a safety assessment.
9. Do not send a user's idea to the briefing site. The feed is pulled into NianBox; idea content is sent only to the selected AI service after explicit user consent.

## Next verification before live integration
- Parse the complete latest.json and enumerate all top-level keys and Skill record fields.
- Inspect archived report shape for backward compatibility.
- Confirm cross-origin browser fetch behavior and response headers from the live URL.
- Add a fixture based on a sanitized representative payload; test malformed JSON, missing optional fields, stale report, duplicate URL, invalid URL, and unavailable feed.
- Prefer a stable versioned schema (for example, a future `schema_version`) in the source repo. Until that exists, use runtime validation and do not assume the shape is immutable.

## Status
This file records a source-backed contract based on the current public payload and README. No live data connector or UI feature is implemented by this document alone.
