# MBK International School — Dukumintasho

Nidaam buuxa oo maamulka dugsiyada lagu maamulo, oo lagu dhisay React, Vite, iyo Supabase. Wuxuu maamulaa ardayda, macallimiinta, waalidka, iyo kormeerayaasha 9 qaybood oo kala duwan.

## Bilow degdeg ah

| Door | Waxaad samayn karto |
|------|---------------------|
| Admin | Maamul isticmaalayaasha, fasallada, imtixaanada, taariikhda dugsiyada |
| Macallin | Gal natiijooyinka imtixaanada, qor xaadirinta, samee su'aalo |
| Waalid | Daawato warbixinnada carruurta, qaado su'aalaha, la soco horumarka |
| Kormeere | Dib u eeg qorshayaasha casharrada, xaqiiji imtixaanada, la soco macallimiinta |

## Dukumintasho

### Tababarro (halkan ka bilow)

- [Admin bilow](tutorials/admin-getting-started.md) — laga bilaabo galitaanka ilaa imtixaanka koowaad
- [Macallin bilow](tutorials/teacher-getting-started.md) — laga bilaabo galitaanka ilaa soo gelinta natiijooyinka
- [Waalid bilow](tutorials/parent-getting-started.md) — laga bilaabo galitaanka ilaa daawashada warbixinta ilmahaaga
- [Kormeere bilow](tutorials/supervisor-getting-started.md) — laga bilaabo galitaanka ilaa dib u eegista qorshayaasha casharrada

### Hagaha hawlgalka

- [Samee sannad dugsiyeed iyo xilli](how-tos/setup-academic-year.md)
- [Abuur fasallo-maadooyin](how-tos/create-class-subjects.md)
- [Geli oo xaqiiji natiijooyinka imtixaanka](how-tos/enter-exam-results.md)
- [Samee oo maamul su'aalaha](how-tos/manage-quizzes.md)
- [Qor xaadirinta ardayda](how-tos/record-attendance.md)
- [Soo saar warbixinnada ardayda](how-tos/generate-reports.md)
- [Isticmaal qorsheeye casharrada AI](how-tos/use-ai-lesson-planner.md)

### Sharaxaad

- [Qaabka dhismaha](explanations/architecture.md) — sababta React+Vite+Supabase, sida routing u shaqeeyo
- [Qaabka xogta](explanations/data-model.md) — sababta profiles→students→exams, RLS
- [Nidaamka mawduucyada](explanations/theming.md) — 4 mawduuc, light/dark, CSS variables
- [Dib u eegista qorshaha casharka AI](explanations/ai-lesson-review.md) — edge function, buundooyinka, shaqada kormeeraha

### Tixraac

Dukumintasho buuxda waxay ku taallaa `.kb/` — 170 fayl oo qeexaya schema, RLS, UI, iyo API. Ka bilow `.kb/index.md`.

## Qalabka

- **Frontend:** React 19, Vite 7, Tailwind CSS 4, React Router 7
- **Backend:** Supabase (PostgreSQL, Auth, RLS, Edge Functions)
- **Xaaladda:** TanStack React Query
- **Dhismaha:** Hal fayl oo HTML ah oo dhan
