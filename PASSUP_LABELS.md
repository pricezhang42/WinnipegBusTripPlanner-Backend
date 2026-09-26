> Current expanded data build: see [HISTORICAL_DATA.md](HISTORICAL_DATA.md). It supersedes the initial snapshot counts and flat-file build instructions below; the category thresholds are unchanged.

# Historical pass-up categories, version 1

The app displays one of Low, Medium, High or Unknown beside each ride. These are relative historical **reported** pass-up patterns, not measured boarding-failure probabilities. Low does not guarantee boarding. Operator under-reporting, incomplete departure telemetry and approximate stop/trip matching remain limitations. No precise percentage is exposed.

## Rebuild

Run the extended audit against the same departure CSV used for the timing artifact:

```sh
python3 src/audit_passups.py --departures Recent_Transit_On-Time_Performance_Data_20260925.csv --passups Transit_Pass-ups_20260925.csv --output reports/passup-labels-20260925
python3 -m unittest discover -s src -p 'test_passup_policy.py'
python3 -m unittest discover -s src -p 'test_audit_passups.py'
```

Copy `passup-risk.json` and `passup-risk.report.json` into the backend's `data/` directory, alongside `reliability.json`. Restart the backend. Docker already includes `data/`. `PASSUP_RISK_DATA_PATH` can override the risk artifact location. The backend requires the cutoff and departure-source SHA-256 to match the timing artifact. The existing trip-date, freshness, season, direction and sample checks still apply. Missing or incompatible risk data gives Unknown without removing departure timing.

## Evidence and policy

Use exact route, stop, destination, scheduled hour, weekday/weekend and season. Do not borrow evidence from another direction, stop, hour or season. Count distinct matched visits, not button presses; exclude duplicate/conflicting departure identities as in the audit. The denominator is recorded visits, not a claim of complete actual service coverage.

Evaluate three matching profiles independently, deduplicating report matches per visited bus-stop record:

| Profile | Maximum distance | Maximum time difference |
|---|---:|---:|
| Strict | 60 m | 120 seconds |
| Intermediate | 100 m | 180 seconds |
| Broad | 150 m | 300 seconds |

Every profile requires at least 30 m spatial separation from the next candidate and 60 seconds temporal separation from the next candidate. Stops with unstable coordinates are excluded. If a nearby report cannot be assigned under even the broad profile, mark the nearest candidate groups within 150 m Unknown for the report hour and adjacent hours. This is a conservative uncertainty flag, not an inference that an event occurred at those stops.

Minimum evidence: 60 recorded visits across 10 distinct dates. For zero-report groups, require at least 120 visits across 10 dates before allowing Low; zero reports alone is insufficient.

Internal score = distinct matched reported visits / (recorded visits + 50). The extra 50 is an explicit small-sample penalty, not extra observed visits or a calibrated probability model. Fixed network-wide boundaries:

- Low: score below 0.010, subject to sample and uncertainty gates.
- Medium: score at least 0.010 but below 0.025, with matched reports on at least 2 distinct dates.
- High: score at least 0.025, with matched reports on at least 3 distinct dates.
- Unknown: insufficient sample/persistence, unresolved nearby reports, unstable stop coordinates, or disagreement between matching profiles.

A high score with insufficient persistence becomes Unknown, not Low. The score/category must agree across all three profiles. Thresholds are provisional engineering choices, frozen as `reported-pattern-v1`. They were informed by the initial audit's 174 positive groups with at least 60 visits and 10 dates: median penalized score 0.008, 75th percentile 0.0117, 90th percentile 0.0224. They are not claimed to be calibrated or independently validated. Do not retune them automatically on each refresh or separately by route. Future changes require a version update, evidence review and corresponding backend validation tests.

## Outputs and UI

`passup-risk.json` contains supported group labels and their evidence. Omitted groups mean Unknown, never Low. `passup-risk.report.json` records label/exclusion counts, source hashes and policy. The original audit outputs remain available; their experimental percentages remain unpublished. The backend validates the label against all exported profile counts before serving it.

The ride UI stays at two summaries:

> Typical departure: 2 min late
> Historical pass-up risk: Medium

No raw counts, score or percentage is displayed. Older backends and malformed labels fall back to Unknown. Arrival timing is not inferred from departure history.

The earlier audit's recommendation to retain Unknown everywhere is superseded by the user's approval to publish these **descriptive categories**. The unanswered City questions still matter for future probability estimates and validation; no message has been sent to Transit.

## Initial all-route build

For the August 8–September 24, 2026 source snapshot: 1,538 groups qualify as Low, 7 as Medium, none as High, and 275,087 remain Unknown. These are route/stop/destination/day-type/season/hour groups, not numbers of routes or passengers. All 1,545 labeled groups are also present in the departure-timing artifact. Many groups have only a few visits; the gates intentionally do not assign them a category. High remains implemented and tested; thresholds were not relaxed to force a High example into this release.

Example available for a September weekday: BLUE, stop 10639, toward University of Manitoba, 16:00–16:59: Medium. This is a reproducible artifact lookup, not a claim of live crowding.
