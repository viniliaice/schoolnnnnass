// One student row in the gate result — and the skeleton that reserves its
// exact geometry.
//
// ZERO-LAYOUT-SHIFT CONTRACT
// -------------------------
// `GateCardShell` is the single source of truth for a card's structure:
//   header row (name + grade)  →  Transport field  →  Driver field  →  action row
// Both the skeleton and the real card render through it, with the SAME row
// count, the same fixed row heights, and the same padding. A skeleton is
// therefore pixel-identical in height to the card that replaces it, and the
// driver slot never "grows" when a driver name arrives — the slot is always
// there, it just changes its contents.
//
// Nothing inside the card is conditionally mounted in a way that changes the
// card's height: the action row is always one 44px-tall band, the driver field
// is always one line, and the status line is a reserved single line.

import type { GateLang, GateStrings } from '../../../lib/i18n/gateStrings';
import { gateTransportLabel } from '../../../lib/i18n/gateStrings';
import { gateEligibility } from '../../../lib/gate/gate-utils';
import type { GateLookupRow } from '../../../lib/db/gate';
import type { FamilyPickup } from '../../../lib/db/authorizedPickups';

/** Fixed row heights — the whole no-shift guarantee rests on these. */
const NAME_H = 'h-5';             // student name line
const GRADE_H = 'h-4';            // grade line
const FIELD_LABEL_H = 'h-4';      // the uppercase field label
const FIELD_VALUE_H = 'h-6';      // one line of field value text
const STATUS_LINE_H = 'h-4';      // reserved single-line status/meta slot
const ACTION_ROW_H = 'min-h-[44px]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={`${FIELD_LABEL_H} text-[11px] font-semibold uppercase leading-4 tracking-wider text-slate-400`}>{label}</div>
      <div className={`${FIELD_VALUE_H} flex items-center truncate text-sm font-semibold text-slate-700`}>
        {children}
      </div>
    </div>
  );
}

function Bar({ className = '' }: { className?: string }) {
  return <div className={`gate-skeleton rounded bg-slate-200/80 ${className}`} />;
}

/**
 * The structural shell. Skeleton and real card MUST both go through this so
 * their heights can never diverge.
 */
function GateCardShell({
  tone,
  name,
  grade,
  badge,
  transport,
  driver,
  status,
  actions,
  stagger,
}: {
  tone: 'neutral' | 'ready' | 'excluded' | 'done';
  name: React.ReactNode;
  grade: React.ReactNode;
  badge: React.ReactNode;
  transport: React.ReactNode;
  driver: React.ReactNode;
  status: React.ReactNode;
  actions: React.ReactNode;
  stagger?: number;
}) {
  const toneClass =
    tone === 'ready' ? 'border-emerald-200 bg-white'
      : tone === 'done' ? 'border-emerald-300 bg-emerald-50/70'
        : tone === 'excluded' ? 'border-slate-200 bg-slate-50'
          : 'border-slate-200 bg-white';

  return (
    <li
      className={`gate-enter rounded-xl border ${toneClass} p-3.5 transition-colors duration-200`}
      style={stagger ? ({ ['--gate-stagger' as string]: `${stagger}ms` }) : undefined}
    >
      {/* Fixed name/grade line heights live HERE, not in the callers, so the
          skeleton and the real card cannot drift apart (browser QA measured a
          4px height / 2px position delta when each built its own header). */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`${NAME_H} flex items-center truncate text-base font-bold leading-5 text-slate-900`}>{name}</div>
          <div className={`${GRADE_H} mt-0.5 flex items-center truncate text-xs font-medium leading-4 text-slate-500`}>{grade}</div>
        </div>
        {/* Fixed-width badge slot: 'Ready to release' → '✓ Released' are
            different widths, and a content-sized badge re-flowed the name and
            grade columns beside it on release (browser QA: dw 34.9px). */}
        <div className="flex h-9 w-[8.5rem] shrink-0 items-start justify-end">{badge}</div>
      </div>
      <div className="mt-2.5 flex items-start gap-4">
        {transport}
        {driver}
      </div>
      <div className={`${STATUS_LINE_H} mt-1.5 flex items-center text-xs font-semibold`}>{status}</div>
      <div className={`${ACTION_ROW_H} mt-2.5 flex items-center gap-2`}>{actions}</div>
    </li>
  );
}

/** Skeleton with the SAME shell → identical height to the loaded card. */
export function StudentCardSkeleton({ stagger }: { stagger?: number }) {
  return (
    <GateCardShell
      tone="neutral"
      stagger={stagger}
      name={<Bar className="h-4 w-40" />}
      grade={<Bar className="h-3 w-20" />}
      badge={<Bar className="h-6 w-24 rounded-full" />}
      // Reuse the REAL Field component with bars as its value. Hand-rolled
      // skeleton markup previously came out ~10px shorter per field, which the
      // browser QA caught as a 10.5px card growth on load.
      transport={<Field label=""><Bar className="h-3.5 w-24" /></Field>}
      driver={<Field label=""><Bar className="h-3.5 w-28" /></Field>}
      status={<Bar className="h-2.5 w-24" />}
      actions={<Bar className="h-[44px] w-full" />}
    />
  );
}

export interface StudentCardProps {
  student: GateLookupRow;
  driver: FamilyPickup | undefined;
  releasedAt: string | undefined;
  releasing: boolean;
  failed: boolean;
  lang: GateLang;
  t: GateStrings;
  stagger?: number;
  onRelease: () => void;
  onAssign: () => void;
  onRemoveDriver: () => void;
}

export function StudentCard({
  student, driver, releasedAt, releasing, failed, lang, t, stagger,
  onRelease, onAssign, onRemoveDriver,
}: StudentCardProps) {
  const eligibility = gateEligibility(student.transport);
  const isExcluded = eligibility === 'excluded';
  const isWalking = eligibility === 'walking';
  const isBus = /^\d+$/.test((student.transport ?? '').trim());
  const transportLabel = gateTransportLabel(lang, student.transport);
  const canRelease = !isExcluded && (isWalking || Boolean(driver));

  const badge = (
    <>
      {releasedAt ? (
        <span className="gate-fade max-w-full truncate rounded-full bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white">
          ✓ {t.released}
        </span>
      ) : isExcluded ? (
        <span className="max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700 ring-1 ring-slate-300">
          {isBus ? '🚌' : '—'} {transportLabel}
        </span>
      ) : (
        <span className="max-w-full truncate rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
          {t.eligible}
        </span>
      )}
    </>
  );

  const transportField = (
    <Field label={t.transport}>
      <span className="truncate">
        {isBus ? '🚌 ' : isExcluded ? '' : driver ? '🚗 ' : isWalking ? '🚶 ' : '🚗 '}
        {driver && isWalking ? t.driverPickup : transportLabel}
      </span>
    </Field>
  );

  // The driver slot ALWAYS exists (even for bus students, where it reads '—'),
  // so switching a walking student from "not assigned" to a named driver is a
  // pure text swap inside a fixed-height line, not a resize.
  const driverField = (
    <Field label={t.driver}>
      {isExcluded ? (
        <span className="text-slate-400">—</span>
      ) : driver ? (
        <span className="gate-fade truncate text-slate-800">
          {driver.name} <span className="font-mono text-slate-500">· {driver.phoneNumber}</span>
        </span>
      ) : (
        <span className="truncate font-medium text-slate-400">{t.driverNotAssigned}</span>
      )}
    </Field>
  );

  const status = failed ? (
    <span role="alert" className="text-rose-600">{t.releaseFailed}</span>
  ) : releasedAt ? (
    <span className="text-emerald-700">{t.releasedAt} {new Date(releasedAt).toLocaleTimeString()}</span>
  ) : isExcluded ? (
    <span className="text-amber-700">{t.notEligible}</span>
  ) : (
    <span aria-hidden className="text-transparent">·</span>
  );

  // The action band is always rendered at a constant height. For a bus student
  // it holds an explanatory line rather than buttons — same height, no jump.
  const actions = releasedAt ? (
    <p className="text-xs font-medium text-slate-500">{student.name} · {driver ? driver.name : t.noDriver}</p>
  ) : isExcluded ? (
    // The status line above already carries 'Not eligible' — repeating it here
    // (browser QA screenshot) was duplicated text. Keep the band reserved only.
    <span aria-hidden />
  ) : (
    <>
      <button
        type="button"
        onClick={onRelease}
        disabled={releasing || !canRelease}
        aria-busy={releasing}
        className="gate-press min-h-[44px] flex-1 rounded-lg bg-emerald-800 px-4 text-sm font-bold text-white transition duration-150 hover:bg-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {releasing ? t.releasing : `✓ ${t.release}`}
      </button>
      {/* Fixed width: 'Assign driver' and 'Change driver' are different lengths,
          so a content-sized button would resize — and shrink the flex-1 Release
          button beside it — the moment a driver is assigned. */}
      <button
        type="button"
        onClick={onAssign}
        className="gate-press min-h-[44px] w-[9.5rem] shrink-0 rounded-lg border border-slate-300 bg-white px-2 text-sm font-semibold text-slate-700 transition duration-150 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.985]"
      >
        {driver ? t.changeDriver : `+ ${t.addDriver}`}
      </button>
      {/* The remove slot is ALWAYS occupied; without a driver it is an inert
          placeholder, so assigning one cannot re-flow the action band. */}
      {driver ? (
        <button
          type="button"
          onClick={onRemoveDriver}
          aria-label={`${t.removeDriver}: ${student.name}`}
          className="gate-press min-h-[44px] w-11 shrink-0 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-rose-700 transition duration-150 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 active:scale-[0.985]"
        >
          ✕
        </button>
      ) : (
        <span aria-hidden className="min-h-[44px] w-11 shrink-0" />
      )}
    </>
  );

  return (
    <GateCardShell
      tone={releasedAt ? 'done' : isExcluded ? 'excluded' : 'ready'}
      stagger={stagger}
      name={student.name}
      grade={student.className}
      badge={badge}
      transport={transportField}
      driver={driverField}
      status={status}
      actions={actions}
    />
  );
}
