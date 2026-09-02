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
const FIELD_VALUE_H = 'h-6';      // one line of field value text
const STATUS_LINE_H = 'h-4';      // reserved single-line status/meta slot
const ACTION_ROW_H = 'min-h-[44px]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
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
  header,
  transport,
  driver,
  status,
  actions,
  stagger,
}: {
  tone: 'neutral' | 'ready' | 'excluded' | 'done';
  header: React.ReactNode;
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
      <div className="flex min-h-[40px] items-start justify-between gap-3">{header}</div>
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
      header={
        <div className="w-full space-y-1.5 pt-0.5">
          <Bar className="h-4 w-40" />
          <Bar className="h-3 w-20" />
        </div>
      }
      transport={
        <div className="min-w-0 flex-1 space-y-1.5">
          <Bar className="h-2.5 w-16" />
          <Bar className="h-3.5 w-24" />
        </div>
      }
      driver={
        <div className="min-w-0 flex-1 space-y-1.5">
          <Bar className="h-2.5 w-12" />
          <Bar className="h-3.5 w-28" />
        </div>
      }
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

  const header = (
    <>
      <div className="min-w-0">
        <div className="truncate text-base font-bold leading-tight text-slate-900">{student.name}</div>
        <div className="mt-0.5 text-xs font-medium text-slate-500">{student.className}</div>
      </div>
      {releasedAt ? (
        <span className="gate-fade shrink-0 rounded-full bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white">
          ✓ {t.released}
        </span>
      ) : isExcluded ? (
        <span className="shrink-0 rounded-full bg-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">
          {isBus ? '🚌' : '—'} {transportLabel}
        </span>
      ) : (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
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
    <p className="text-xs font-medium text-slate-500">{t.notEligible}</p>
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
      <button
        type="button"
        onClick={onAssign}
        className="gate-press min-h-[44px] shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition duration-150 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.985]"
      >
        {driver ? t.changeDriver : `+ ${t.addDriver}`}
      </button>
      {driver && (
        <button
          type="button"
          onClick={onRemoveDriver}
          aria-label={`${t.removeDriver}: ${student.name}`}
          className="gate-press min-h-[44px] w-11 shrink-0 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-rose-700 transition duration-150 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 active:scale-[0.985]"
        >
          ✕
        </button>
      )}
    </>
  );

  return (
    <GateCardShell
      tone={releasedAt ? 'done' : isExcluded ? 'excluded' : 'ready'}
      stagger={stagger}
      header={header}
      transport={transportField}
      driver={driverField}
      status={status}
      actions={actions}
    />
  );
}
