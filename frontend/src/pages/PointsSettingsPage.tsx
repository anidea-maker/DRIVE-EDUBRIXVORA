import { useEffect, useMemo, useState } from 'react'
import { Coins, Loader2, Save, RotateCcw, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The HXP rule editor.
 *
 * Every number here is data, not code: a super admin changes what reading, notes,
 * a test or a video is worth, and the next award uses the new value. Past awards
 * are never rewritten - each ledger row carries the value it was paid under - so
 * the panel says so instead of leaving an administrator to guess.
 *
 * Rendered only for a super admin, but the gate is a *convenience*: the route is
 * protected by `requireRole('manage_administrators')`, so a non-admin who forces
 * this to render gets a 403 on save rather than an editing session.
 */

type Rule = {
  id: string
  activity: string
  label: string
  description: string | null
  points: number
  bonusPoints: number
  bonusThreshold: number
  dailyCap: number
  enabled: boolean
  updatedAt: string
}

/** The editable shape, kept as strings so a half-typed number is not lost. */
type Draft = {
  points: string
  bonusPoints: string
  bonusThreshold: string
  dailyCap: string
  enabled: boolean
}

function toDraft(rule: Rule): Draft {
  return {
    points: String(rule.points),
    bonusPoints: String(rule.bonusPoints),
    bonusThreshold: String(rule.bonusThreshold),
    dailyCap: String(rule.dailyCap),
    enabled: rule.enabled,
  }
}

function sameDraft(a: Draft, b: Draft) {
  return (
    a.points === b.points &&
    a.bonusPoints === b.bonusPoints &&
    a.bonusThreshold === b.bonusThreshold &&
    a.dailyCap === b.dailyCap &&
    a.enabled === b.enabled
  )
}

/** A whole number in range, or `null` when the field is not a usable number. */
function parseNumber(value: string, max: number) {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return parsed <= max ? parsed : null
}

function NumberField({
  label,
  hint,
  value,
  max,
  onChange,
}: {
  label: string
  hint: string
  value: string
  max: number
  onChange: (next: string) => void
}) {
  const invalid = parseNumber(value, max) === null
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <Input
        value={value}
        inputMode="numeric"
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        className={cn('mt-1 tabular', invalid && 'border-red-400')}
      />
      <span className={cn('mt-1 block text-[11px]', invalid ? 'font-semibold text-red-600' : 'text-slate-400')}>
        {invalid ? 'Enter a whole number within range.' : hint}
      </span>
    </label>
  )
}

export function PointsSettingsPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string>('')
  const [unaffected, setUnaffected] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<{ rules: Rule[] }>('/admin/points/rules')
      .then((data) => {
        if (cancelled) return
        setRules(data.rules)
        setDrafts(Object.fromEntries(data.rules.map((rule) => [rule.activity, toDraft(rule)])))
      })
      .catch((problem) => {
        if (cancelled) return
        // The server is the authority on who may see this page. A 403 from the
        // endpoint is a real answer, so show the explanation rather than an error.
        const message = problem instanceof Error ? problem.message : ''
        if (/403|permission|not allowed/i.test(message)) setDenied(true)
        else setError(message || 'Could not load the points rules.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dirtyCount = useMemo(
    () => rules.filter((rule) => drafts[rule.activity] && !sameDraft(drafts[rule.activity], toDraft(rule))).length,
    [rules, drafts],
  )

  function patchDraft(activity: string, patch: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [activity]: { ...current[activity], ...patch } }))
    setSaved('')
  }

  async function save(rule: Rule) {
    const draft = drafts[rule.activity]
    const points = parseNumber(draft.points, 10_000)
    const bonusPoints = parseNumber(draft.bonusPoints, 10_000)
    const bonusThreshold = parseNumber(draft.bonusThreshold, 100)
    const dailyCap = parseNumber(draft.dailyCap, 1_000_000)
    if (points === null || bonusPoints === null || bonusThreshold === null || dailyCap === null) {
      setError('One of the values is not a whole number in the allowed range. Fix it before saving.')
      return
    }
    /*
     * The API refuses a bonus that can never pay (server error
     * HXP_BONUS_NEEDS_THRESHOLD). Catching it here turns a rejected save into an
     * explanation next to the field the administrator is looking at.
     */
    if (bonusPoints > 0 && bonusThreshold === 0) {
      setError(`"${rule.label}" pays a bonus, so set the percentage it is paid at (1-100) - or set the bonus to 0.`)
      return
    }

    setSaving(rule.activity)
    setError('')
    try {
      const result = await apiFetch<{ rule: Rule; pastAwardsUnaffected: number }>(
        `/admin/points/rules/${rule.activity}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ points, bonusPoints, bonusThreshold, dailyCap, enabled: draft.enabled }),
        },
      )
      setRules((current) => current.map((entry) => (entry.activity === rule.activity ? result.rule : entry)))
      // Re-seed the draft from the server's answer, not from what was typed: the
      // API clamps and normalises, and a stale draft would immediately look wrong.
      setDrafts((current) => ({ ...current, [rule.activity]: toDraft(result.rule) }))
      setSaved(rule.activity)
      setUnaffected(result.pastAwardsUnaffected)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save that rule.')
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-[13px] font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading points rules...
      </div>
    )
  }

  if (denied) {
    return (
      <>
        <PageHeader title="HXP settings" description="What each activity is worth." />
        <Card className="mt-5 p-5">
          <p className="text-[13px] font-semibold text-slate-700">
            These values can only be changed by a super admin.
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">
            One administrator setting one activity to an extreme value would distort every account's total, so the
            rule table is deliberately narrower than the rest of the admin surface. Ask a super admin to make the
            change.
          </p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="HXP settings"
        description="What reading, notes, a test and a video are worth. Changes apply to the next award; nothing already earned changes."
        actions={
          <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-1.5 text-[12px] font-semibold text-slate-600">
            <Coins className="h-3.5 w-3.5 text-amber-500" />
            {dirtyCount > 0 ? `${dirtyCount} unsaved` : 'All saved'}
          </div>
        }
      />

      <Card className="mt-5 flex items-start gap-3 p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <p className="text-[12.5px] leading-relaxed text-slate-600">
          <span className="font-bold text-slate-700">Points</span> are paid every time an activity is completed.{' '}
          <span className="font-bold text-slate-700">Bonus</span> is paid once on top, when a test score or watch
          percentage reaches the threshold.{' '}
          <span className="font-bold text-slate-700">Daily cap</span> is the most an account can earn from that activity
          in a UTC day - set it to <span className="font-bold">0</span> for no limit.
        </p>
      </Card>

      {error ? (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] font-semibold text-red-700">{error}</p>
      ) : null}
      {saved && unaffected !== null ? (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[13px] font-semibold text-emerald-700">
          Saved. {unaffected === 0 ? 'No awards have used this rule yet.' : `${unaffected} past award${unaffected === 1 ? '' : 's'} unchanged.`}
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {rules.map((rule) => {
          const draft = drafts[rule.activity] ?? toDraft(rule)
          const dirty = !sameDraft(draft, toDraft(rule))
          return (
            <Card key={rule.activity} className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-extrabold leading-snug">{rule.label}</h2>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">{rule.description}</p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] font-bold text-slate-600">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => patchDraft(rule.activity, { enabled: event.target.checked })}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {draft.enabled ? 'On' : 'Off'}
                </label>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <NumberField
                  label="Points"
                  hint="Paid per completion."
                  value={draft.points}
                  max={10_000}
                  onChange={(next) => patchDraft(rule.activity, { points: next })}
                />
                <NumberField
                  label="Daily cap"
                  hint="0 means no limit."
                  value={draft.dailyCap}
                  max={1_000_000}
                  onChange={(next) => patchDraft(rule.activity, { dailyCap: next })}
                />
                <NumberField
                  label="Bonus"
                  hint="Paid once, at the threshold."
                  value={draft.bonusPoints}
                  max={10_000}
                  onChange={(next) => patchDraft(rule.activity, { bonusPoints: next })}
                />
                <NumberField
                  label="Bonus at"
                  hint={rule.activity === 'test' ? 'Test score %.' : rule.activity === 'video' ? 'Watch %.' : 'Threshold %.'}
                  value={draft.bonusThreshold}
                  max={100}
                  onChange={(next) => patchDraft(rule.activity, { bonusThreshold: next })}
                />
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!dirty || saving === rule.activity}
                  onClick={() => patchDraft(rule.activity, toDraft(rule))}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset
                </Button>
                <Button type="button" size="sm" disabled={!dirty || saving === rule.activity} onClick={() => save(rule)}>
                  {saving === rule.activity ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </>
  )
}
