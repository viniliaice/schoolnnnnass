// Public, unauthenticated privacy-policy page — the page behind
// /privacy-policy (see App.tsx, which renders it before the sign-in gate).
//
// The content comes from src/legal/privacyPolicy.ts, the same source the
// standalone HTML build uses, so the two can never drift apart. The layout is
// deliberately the same public look as LoginPage (light gradient, white card,
// indigo links) so a signed-out visitor sees one consistent website.
//
// Keep this page free of app-only chrome: no sidebar, no session data, nothing
// that needs an account.

import type { ReactNode } from 'react';
import logo from '../../../assets/logo.png';
import {
  PRIVACY_POLICY_LAST_UPDATED,
  PRIVACY_POLICY_PATH,
  PRIVACY_POLICY_SECTIONS,
  PRIVACY_POLICY_TITLE,
  SITE_URL,
  parseInline,
  type PolicyBlock,
} from '../../legal/privacyPolicy';

const linkClass = 'font-medium text-indigo-600 underline underline-offset-2 transition-colors hover:text-indigo-700';

/** Renders the shared inline markup (**bold**, [label](href)) as React nodes. */
function inline(text: string): ReactNode[] {
  return parseInline(text).map((part, index) => {
    if (part.kind === 'strong') return <strong key={index}>{part.value}</strong>;
    if (part.kind === 'link') {
      return (
        <a key={index} href={part.href} className={linkClass}>
          {part.value}
        </a>
      );
    }
    return part.value;
  });
}

function Block({ block }: { block: PolicyBlock }) {
  switch (block.kind) {
    case 'h3':
      return <h3 className="mt-6 text-base font-bold text-slate-900">{block.text}</h3>;
    case 'p':
      return <p className="mt-3 text-base leading-7 text-slate-700">{inline(block.text)}</p>;
    case 'ul':
      return (
        <ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-7 text-slate-700">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>
      );
    case 'note':
      return (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-slate-700">
          {inline(block.text)}
        </div>
      );
    case 'dl':
      return (
        <dl className="mt-4 space-y-3">
          {block.items.map((item, index) => (
            <div key={index}>
              <dt className="text-sm font-bold text-slate-900">{item.term}</dt>
              <dd className="mt-1 text-base leading-7 text-slate-700">{inline(item.text)}</dd>
            </div>
          ))}
        </dl>
      );
  }
}

export function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-linear-to-br from-indigo-50 via-white to-teal-50 px-4 py-8">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-center gap-4">
          <img src={logo} alt="MBK International School" className="h-14 w-14 object-contain" />
          <div>
            <p className="text-lg font-bold text-slate-900" style={{ fontFamily: "'Cinzel', Georgia, serif" }}>
              MBK International School
            </p>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">MBK Parent Portal</p>
          </div>
        </header>

        <main className="theme-ornamented mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-10">
          <h1 className="text-3xl font-bold text-slate-900">{PRIVACY_POLICY_TITLE}</h1>
          <p className="mt-3 text-sm text-slate-600">
            <strong>Last updated:</strong> {PRIVACY_POLICY_LAST_UPDATED}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            <strong>Applies to:</strong> the MBK Parent Portal mobile application and the MBK International School
            Parent Portal website.
          </p>
          <p className="mt-4 text-base leading-7 text-slate-700">
            This policy describes what information the MBK Parent Portal handles, why it is handled, who processes it,
            and the choices available to parents, guardians and pupils' families. It is written to match how the portal
            actually works.
          </p>

          <nav
            aria-labelledby="privacy-contents-heading"
            className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <h2
              id="privacy-contents-heading"
              className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500"
            >
              Contents
            </h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600 sm:columns-2 sm:gap-6">
              {PRIVACY_POLICY_SECTIONS.map(section => (
                <li key={section.id} className="break-inside-avoid">
                  <a href={`#${section.id}`} className={linkClass}>
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {PRIVACY_POLICY_SECTIONS.map((section, index) => (
            <section key={section.id}>
              <h2
                id={section.id}
                className="mt-10 border-t border-slate-200 pt-6 text-xl font-bold text-slate-900 first:border-t-0 first:pt-0"
              >
                {index + 1}. {section.title}
              </h2>
              {section.blocks.map((block, blockIndex) => (
                <Block key={blockIndex} block={block} />
              ))}
            </section>
          ))}
        </main>

        <footer className="mt-6 space-y-2 text-center">
          <p className="text-xs text-slate-500">
            <a href="/" className={linkClass}>
              MBK Parent Portal
            </a>
            {' · '}
            <a href={PRIVACY_POLICY_PATH} className={linkClass}>
              Privacy Policy
            </a>
            {' · '}
            <a href={SITE_URL} className={linkClass}>
              schoolnnnnass.vercel.app
            </a>
          </p>
          <p className="text-xs text-slate-500" style={{ fontFamily: "'Dancing Script', cursive", fontSize: '1rem' }}>
            MBK International School · Made by <span className="font-bold text-indigo-500">Eng. Akso</span>
          </p>
        </footer>
      </div>
    </div>
  );
}
