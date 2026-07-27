import { Plus } from 'lucide-react';

interface EmptyActivityRowProps {
  onAdd: () => void;
}

export function EmptyActivityRow({ onAdd }: EmptyActivityRowProps) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 transition-colors w-full rounded-md border border-dashed border-slate-200 px-2 py-1.5 hover:border-indigo-300 hover:bg-indigo-50/30"
        >
          <Plus className="w-3 h-3" /> Add activity
        </button>
      </div>
      <div className="flex items-center gap-1 opacity-0 pointer-events-none">
        <input className="flex-1 rounded-md border px-1.5 py-1 text-xs" placeholder="Resource" disabled />
        <input className="flex-1 rounded-md border px-1.5 py-1 text-xs" placeholder="Place/URL" disabled />
      </div>
    </div>
  );
}