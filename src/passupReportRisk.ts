import type { ReportEvidence } from './passupReports.js';

/** Approved report-count policy; this ratio is not a boarding probability. */
export const REPORT_POLICY = {
  version: 'report-scheduled-visit-ratio-v1',
  profile: '150m',
  minimumDepartures: 60,
  minimumDepartureDates: 10,
  zeroReportMinimumDepartures: 120,
  mediumRatio: 0.01,
  highRatio: 0.025,
  mediumReportDates: 2,
  highReportDates: 3,
} as const;

export type ReportRisk = {
  level: 'low' | 'medium' | 'high' | 'unknown';
  basis: string;
  policyVersion: string;
};
type Counts = Pick<ReportEvidence, 'reportCount' | 'reportDates' | 'recordedDepartures' | 'departureDates'>;

export function unknownReportRisk(reason: string): ReportRisk {
  return { level: 'unknown', basis: reason, policyVersion: REPORT_POLICY.version };
}

/** Evidence is validated by the report reader before classification. */
export function reportRisk(evidence: Counts): ReportRisk {
  const { reportCount, reportDates, recordedDepartures, departureDates } = evidence;
  if (recordedDepartures < REPORT_POLICY.minimumDepartures || departureDates < REPORT_POLICY.minimumDepartureDates) {
    return unknownReportRisk('insufficient_reference_history');
  }
  if (reportCount > recordedDepartures) return unknownReportRisk('reports_exceed_recorded_visits');
  if (reportCount === 0 && recordedDepartures < REPORT_POLICY.zeroReportMinimumDepartures) {
    return unknownReportRisk('insufficient_zero_report_history');
  }

  const ratio = reportCount / recordedDepartures;
  let level: ReportRisk['level'] = 'low';
  if (ratio >= REPORT_POLICY.highRatio) {
    if (reportDates < REPORT_POLICY.highReportDates) return unknownReportRisk('insufficient_reporting_dates');
    level = 'high';
  } else if (ratio >= REPORT_POLICY.mediumRatio) {
    if (reportDates < REPORT_POLICY.mediumReportDates) return unknownReportRisk('insufficient_reporting_dates');
    level = 'medium';
  }
  return { level, basis: 'report_to_recorded_visit_ratio', policyVersion: REPORT_POLICY.version };
}
