/**
 * The usage endpoint's answer, in its own shape with made-up figures: every field it carries, and the
 * two quirks the parser depends on, microsecond ISO times with an offset, and a model's own weekly
 * limit in `limits[]` (`weekly_scoped`, named by `scope.model.display_name`).
 *
 * A real answer, to check the parser against, goes in `.secrets/usage-capture.json` at the repo's root
 * (`.gitignore` keeps that folder out of the repo). The test kit reads no file beyond the tests'
 * imports, so no test loads it: compare it by hand when the endpoint's shape changes.
 */
export const USAGE_BODY = {
  five_hour: { utilization: 40.0, resets_at: '2026-10-28T15:00:00.250117+00:00', limit_dollars: null, locked_reason: null },
  seven_day: { utilization: 70.0, resets_at: '2026-11-01T09:00:00.250126+00:00', limit_dollars: null, locked_reason: null },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 40, severity: 'normal', resets_at: '2026-10-28T15:00:00.250117+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 70, severity: 'warning', resets_at: '2026-11-01T09:00:00.250126+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 95,
      severity: 'critical',
      resets_at: '2026-11-01T08:59:59.512301+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
}
