// Office landing — gate staff (Umal, Maxamed, Abdurahman) land here after
// login and jump to the three read/lookup tools they're allowed to use.

import { ShieldCheck, Users, CreditCard } from 'lucide-react';

const TOOLS: { path: string; title: string; so: string; desc: string; icon: typeof ShieldCheck }[] = [
  {
    path: '/gate',
    title: 'Dismissal Gate',
    so: 'Iridda Dugsiga',
    desc: 'Look up families by typed ID or QR scan at pickup. Read-only.',
    icon: ShieldCheck,
  },
  {
    path: '/admin/family-ids',
    title: 'Family IDs',
    so: 'Aqoonsiga qoyska',
    desc: 'View families, transport, and print cards. Generate is admin-only.',
    icon: CreditCard,
  },
  {
    path: '/directory',
    title: 'Student Directory',
    so: 'Liiska ardayda',
    desc: 'Search students by name, grade, transport, or family ID. Read-only.',
    icon: Users,
  },
];

export function OfficeDashboard({ navigate }: { navigate: (path: string) => void }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Office Dashboard</h1>
        <p className="text-sm text-slate-500">Gate & dismissal tools — read/lookup only.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {TOOLS.map(tool => (
          <button
            key={tool.path}
            onClick={() => navigate(tool.path)}
            className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-600 hover:shadow-md"
          >
            <tool.icon className="mb-3 h-8 w-8 text-emerald-800" />
            <div className="text-base font-bold text-slate-900">{tool.title}</div>
            <div className="text-xs font-semibold text-emerald-700">{tool.so}</div>
            <p className="mt-2 text-sm text-slate-500">{tool.desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
