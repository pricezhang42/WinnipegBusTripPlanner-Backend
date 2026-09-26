# Expanded post-overhaul history

The current build combines all 13 `data/on_time_performance_YYYY_MM.zip` archives (July 2025 through July 2026) and `Recent_Transit_On-Time_Performance_Data_20260925.csv`. The cutoff is June 29, 2025; the provided files begin in July, so June 29–30 are not reconstructed. Older pass-up reports are only used on dates with retained departure observations.

## Reproduce

Use Python 3.9+ and the separate history dependency list:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-history.txt
.venv/bin/python src/build_history.py \
  --departures data/on_time_performance_*.zip Recent_Transit_On-Time_Performance_Data_20260925.csv \
  --passups Transit_Pass-ups_20260925.csv \
  --work data/history-work \
  --output reports/history-expanded
.venv/bin/python -m unittest discover -s src -p 'test_build_history.py'
```

Keep the working database outside version control; it occupies several GB. ZIPs are streamed through one temporary extracted CSV at a time. DuckDB has a 1 GB memory budget and two worker threads. `--skip-import` can repeat export after a completed import; it uses the existing database and `source-report.json`, so do not use it for new or changed departure inputs. Rebuild normally when sources change. Raw files are never edited.

Copy the following output set together into the backend's `data/` directory and restart the backend:

- `reliability.json`, `reliability.report.json`, and the complete `reliability-routes/` directory
- `passup-risk.json`, `passup-risk.report.json`, and the complete `passup-risk-routes/` directory

Schema 2 manifests reference per-route files. The backend supports the old schema as well, lazily reads only the routes needed by a request, and bounds its file cache to four entries / 12 MB of serialized data. Missing files fail open to unavailable timing or Unknown risk. Docker includes the full `data/` tree. The two manifests must have the same departure-source bundle fingerprint and coverage cutoff.

## Cleaning and comparability

- Parse both ISO archive timestamps and the recent CSV's month-name timestamps. Ignore all pre-overhaul observations.
- Remove exact duplicate source records across files; exclude source IDs with conflicting timing/identity information. Collapse natural visit identities (route, stop, destination, scheduled time); exclude conflicting deviations for the same identity. Natural identities remain proxies for trips because vehicle/trip IDs are absent.
- Exclude invalid rows, deviations over seven days, and rows whose reported service day disagrees with the calendar. Records marked Holiday are excluded; this does not claim to recognize every possible special-service date. Source rows outside the ordinary calendar comparison are counted in the audit.
- Departure timing uses observations within one hour of schedule; pass-up denominators retain larger deviations up to the structural validity bound. Do not remove very late visits from the denominator merely for being late.
- Group by exact route, stop, normalized destination, weekday/weekend, season and hour. Winter, summer and transition history remain separate. Old destination labels are not fuzzily merged into current destinations. No historical timetable is inferred from the current GTFS feed.
- Use stop coordinates and route/destination membership observed on each report's date. Stops with unstable coordinates within that date are excluded. This avoids using one latest stop location across a year of history. Matching still lacks shared trip identifiers and manual ground truth; local timestamps at the repeated daylight-saving hour remain an ambiguity.
- Keep the approved `reported-pattern-v1` Low/Medium/High policy and all three matching-sensitivity checks unchanged. No rebalance was applied. Zero-report groups still require adequate history and uncertain matches remain Unknown.

The departure artifact retains exact observed median and p10/p90 offsets. Stored share intervals now use a daily-cluster variance calculation with a normal 95% approximation rather than 100 bootstrap repetitions, allowing aggregation of the longer history. They are descriptive uncertainty estimates, not calibrated future-arrival intervals, and are not shown in the two-line UI. No new predictive holdout claim is made; earlier pilot evaluation numbers do not evaluate this expanded release.

## Coverage and operational limits

`reliability.report.json` records all input filenames and SHA-256 hashes, cleaning counts and every retained date's visit count. `passup-risk.report.json` records the new category distribution. The import does not fill missing days or infer zero pass-ups on uncovered days. Pass-up records outside observed departure dates are excluded from the denominator-based comparison.

The backend's 30-day data freshness and trip-horizon rules still apply. Having winter history does not turn a months-ahead itinerary into a supported live estimate: refresh recent data as the season progresses. Source coverage extends through September 24, 2026; keep the backend's calendar rules updated for future years. The app's existing two summary lines and outside-time calculation are unchanged.

## Verified current result

- 48,307,022 source departure rows; 46,948,677 retained recorded visits.
- Usable coverage: July 1, 2025–September 24, 2026, across 72 route identifiers.
- 341,722 supported departure groups, including 124,265 winter groups.
- 16,049 full-bus reports on covered dates; one has invalid coordinates, leaving 16,048 spatial candidates. The three profiles match 4,411 / 5,763 / 6,910 distinct candidate visits respectively. Reports remain approximate matches, not ground truth.
- 150,266 Low groups, 30 Medium, zero High; 323,309 comparison groups remain Unknown. Categories refer to stop/direction/hour/season combinations, not numbers of routes. Thresholds were not changed to rebalance labels.
- Dates within the coverage range with no retained observations: August 4, 2025; February 16, May 18, July 1, August 1–7, and September 6–8, 2026. These gaps can result from absent inputs or the cleaning/service-day filters; the report does not claim they are all missing downloads. There is no June 2025 archive in the supplied folder.

Validation: ZIP/CSV timestamp parsing, overlap removal, conflicting source/visit identities, cutoff filtering and winter/summer separation tested with fixtures. Backend loader tests pass for both artifact schemas, missing files and path containment. All 341,722 timing groups and all 150,296 supported labels passed export/lookup checks. Example integrated lookup: route 662, stop 60188, University of Manitoba, September weekday 16:00–16:59 returns Medium. No emulator test or production deployment was performed for this data refresh.
