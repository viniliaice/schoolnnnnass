# Qaabka Dhismaha

Sababta nidaamka loo dhisay sidaan, iyo sida qaybuhu isugu xirmaan.

## Dhibaatada

Dugsiyadu waxay u baahan yihiin nidaam dhammaystiran oo maamula ardayda, macallimiinta, imtixaannada, iyo warbixinnada. Xalalka jira ayaa aad u adag (enterprise SaaS) ama aad u fudud (spreadsheets). Dugsiyada MBK International waxay u baahan yihiin nidaam dhexdhexaad ah: web app u shaqeeya hawsha dugsiyeed oo dhan isagoo fudud oo ay isticmaali karaan shaqaalaha aan farsamada aheyn.

## Habka

### Frontend: React + Vite + Tailwind

**Sababta React:** Component-based UI waxay ku habboon tahay qaabka dashboard-ka — door kastaa wuxuu leeyahay aragtiyo kala duwan, laakiin waxay wadaagaan qaybo UI oo caadi ah (tables, forms, modals). Qaabka React-ka ee ka kooban yahay ayaa tan ka dhigaya mid dabiici ah.

**Sababta Vite:** Server-ka horumarineed ee degdega ah, hal fayl oo HTML ah oo la soo saaro. Hal fayl oo HTML ah ayaa laga dhigi karaa meel kasta — xitaa server faylal ah.

**Sababta Tailwind CSS:** Utility-first CSS waxay baabi'isaa baahida nidaam qaabayn gaar ah. Mawduucyada (Acanthus, Baroque, Aurora) waxay isticmaalaan CSS custom properties.

### Backend: Supabase

**Sababta Supabase:** Waxay siisaa PostgreSQL, authentication, row-level security, iyo edge functions hal meel. Dugsiyada:

- **PostgreSQL:** Qaabka xogta relational wuxuu ku habboon yahay students → exams → reports
- **Auth:** Email/password login leh maamulka session-ka
- **RLS:** Macallimiintu waxay arkaan fasalladooda oo keliya, waalidku carruurtooda oo keliya
- **Edge Functions:** Dib u eegista qorshaha casharka AI waxay ku shaqeysaa edge function

### Routing-ka client-side

App-ku wuxuu isticmaalaa `switch` fudud oo ku saabsan `currentPath` gudaha `App.tsx`. Door kastaa wuxuu leeyahay routes u gaar ah. Tani waa ula kac — app-ku waa ku yar yahay router-ka buuxa.

### Maamulka xaaladda (state)

**Sababta React Query:** Xaaladda server-ka (imtixaannada, ardayda, warbixinnada) waa la kaydiyaa (cache) oo dib baa loo soo cusboonaysiiyaa. Xaaladda maxalliga ah (UI toggles, form inputs) waxay ku sii jirtaa component state.

## Go'aamada qaabaynta

### Helitaanka door-ku-saleysan (role-based)

Door kastaa wuxuu leeyahay bogag u gaar ah. Component-ka `AppContent` wuxuu hubiyaa `session.role` oo soo saaraa routes-ka saxda ah.

### Imtixaannada tahay xarunta

Wax walba waxay ku wareegaan imtixaannada:

```
Ardayda → Qaadaan Imtixaanno → Maaddiiba → Bishii → Fasalka
Macallimiintu → Geliyaan Imtixaanno → Fasalladooda
Kormeerayaashu → Xaqiijiyaan Imtixaanno → Kahor waalidka
Waalidku → Daawatadaan Imtixaanno → Warbixinnada
```

### Fayl keliya oo la taageero

Pluginka `vite-plugin-singlefile` wuxuu JavaScript, CSS, iyo assets oo dhan ku daraa hal fayl oo HTML ah.

## Isbarbardhig

**Waxa la helay:**
- Taageero fudud (hal fayl HTML)
- Horumarineed degdeg ah (Vite HMR)
- Badqabka TypeScript
- Nabadgelyo (Supabase RLS)

**Waxa la waayay:**
- Server-side rendering (SEO looguma baahna app-ka dugsiyada)
- Qaybinta koodhka
- Routing-ka URL-ku-saleysan
- Offline-first

## Hababka la tixgeliyay

**Next.js:** Waxay ku dari lahayd SSR iyo routing, laakiin hal fayl oo HTML ah wuxuu khilaafayaa qaabka Next.js.

**Firebase:** Waxay la mid tahay Supabase laakiin SQL ahaan kuma habboona.

**Custom backend:** Xakame dheeri ah laakiin dayactir dheeri ah. Supabase waxay maamushaa auth, database, iyo edge functions.
