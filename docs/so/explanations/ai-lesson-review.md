# Dib u Eegista Qorshaha Casharka AI

Sida nidaamka dib u eegista qorshaha casharka AI u shaqeeyo, laga bilaabo gudbinta ilaa buundoyinka.

## Dhibaatada

Kormeerayaashu ma eegi karaan qorshe kasta oo cashar ah si faahfaahsan. Macallimiintu waxay soo gudbiyaan qorshayaal usbuuc kasta, dib u eegista gacantu waa waqti-qaali. Nidaamku wuxuu u baahan yahay jawaab celin tayo leh oo toos ah oo isku mid ah.

## Habka

### Dhismaha

```
Macallinku wuxuu soo gudbiyaa qorshe
  → Client-ku wuxuu u diraa period-ka + unit_context (haddii ay jirto) edge function-ka
  → Edge function-ku wuxuu u yeeraa LLM (GPT-4 ama la mid ah)
  → LLM wuxuu helaa macnaha cutubka (name + objectives)
  → LLM wuxuu soo celiyaa structured JSON buundooyin ah
  → Edge function-ku wuxuu ku kaydiyaa table-ka ai_reviews
  → Kormeeruhu wuxuu arkaa buundooyinka AI + macnaha cutubka + wuxuu ku darayaa dib u eegistiisa
```

### Edge function-ka

Wuxuu ku yaallaa `supabase/functions/review-lesson-plan/`. Edge function-ku:

1. Wuxuu helaa periods-ka qorshaha oo JSON ah
2. Wuxuu dhisaa prompt nidaamsan oo leh shuruudaha buundada
3. Wuxuu u yeeraa LLM API-ga
4. Wuxuu baaraa jawaabta JSON-ka ee qaabeysan
5. Wuxuu ku kaydiyaa dib u eegista database-ka

### Qaybaha buundada

AI-ga wuxuu qiimeeyaa 10 qaybood, mid kastaa 0-100:

| Qaybta | Miisaan | Waxay qiyaastaa |
|--------|---------|-----------------|
| Learning Objectives | Sarreeya | Ujeedooyin gaar ah, la qiyaasi karo? |
| Lesson Structure | Sarreeya | Qulqulka casharku ma wanaagsan yahay? |
| Student Engagement | Dhexe | Fursadaha barashada firfircoon? |
| Teaching Strategies | Dhexe | Kala duwanaanshaha hababka? |
| Differentiation | Dhexe | La qabsiga ardayda kala duwan? |
| Assessment Methods | Sarreeya | Sida barashada loo hubiyo? |
| Curriculum Alignment | Sarreeya | Ma ku habboon yahay heerarka? AI-ga wuxuu isticmaalaa ujeedooyinka cutubka si uu u hubiyo |
| Classroom Management | Hoose | Anshaxa iyo maamulka wakhtiga? |
| Resources Materials | Hoose | Agabku ma habboon yahay oo ma heli karaa? |
| Overall Quality | Sarreeya | Qiimeynta guud ee qorshaha |

### Qaabka prompt-ka

Prompt-ka nidaamsan wuxuu weydiisaa LLM-ka:

1. Akhri mawduuca, ujeeddada, iyo hawlo kasta oo xilli ah
2. Haddii unit_context la helo, akhri magaca cutubka iyo ujeedooyinkiisa
3. Isbarbardhig qorshaha casharka usbuuca ujeedooyinka cutubka — ma taageerayaan midba midka kale?
4. Buundo qayb kasta 0-100 (Curriculum Alignment wuxuu tixgelinayaa ujeedooyinka cutubka)
5. Sharax buundo kasta
6. Liiso xoogga iyo meelaha loo baahan yahay hagaajin
7. Qor soo koobid guud
8. Ku talo heerka (approve/revise/reject)

### Qaabka jawaabta

LLM wuxuu soo celiyaa JSON qaabeysan:

```json
{
  "category_scores": {
    "learning_objectives": { "score": 85, "explanation": "..." },
    "lesson_structure": { "score": 78, "explanation": "..." }
  },
  "total_score": 79,
  "percentage": 79,
  "performance_level": "good",
  "strengths": ["Ujeedooyin cad", "Hawlo kala duwan"],
  "improvements": [
    { "area": "Assessment", "why": "...", "recommendation": "..." }
  ]
}
```

### Heerarka

| Boqolleyda | Heer | Ficil |
|-----------|------|-------|
| 90-100 | Aad u fiican | Ansixi |
| 80-89 | Wanaagsan | Ansixi faallo yar |
| 70-79 | Fican | Ansixi ama dib u eeg |
| 60-69 | U Baahan Hagaajin | Dib u eeg |
| 0-59 | U Baahan Dib u Qorid | Diid |

### Hawsha kormeeraha

1. Dib u eegista AI waxay si toos ah u kaydantaa gudbinta
2. Kormeeruhu wuxuu furaa qorshaha oo wuxuu arkaa buundooyinka AI iyo macnaha cutubka
3. Wuxuu akhriyaa soo koobista AI
4. Wuxuu ku darayaa faalladiisa
5. Wuxuu ansixinayaa ama codsanayaa dib u hagaajin

AI-ga ma beddelayo kormeeraha — wuxuu bixiyaa jawaab celin joogto ah oo qaabeysan oo dedejisa dib u eegista.

## Sababta nidaamkan loo doortay

**Edge function oo aan aheyn client-side:** Furaha LLM API-ga wuxuu ku sii jiraa server-ka. Edge function-ku wuxuu maamulaa retries, timeouts, iyo qaabaynta qaladaadka.

**Structured JSON oo aan aheyn qoraal xor ah:** Wax soo saar qaabeysan wuxuu u oggolaanayaa:
- Buundo joogto ah qorshayaasha dhexdooda
- Raad raaca isbeddellada wakhti ka dib
- Isbarbardhigga macallimiinta
- Talooyin heer toos ah

**10 qaybood oo aan aheyn hal buundo:** Jawaab celin tafaasiil leh waxay ka caawisaa macallimiinta inay hagaajiyaan meelo gaar ah. Hal "79/100" kuma sheego waxa la hagaajiyo.

## Isbarbardhig

**Waxa la helay:**
- Jawaab celin joogto ah, toos ah
- Hawl dib u eegis oo la ballaarin karo
- Raad raaca hagaajinta xog-ku-saleysan
- Badbaadin waqtiga kormeeraha

**Waxa la waayay:**
- Kharashka LLM ee dib u eegista (caadi ahaan $0.01-0.05)
- Ku tiirsanaanta API-ga dibadda
- U nuglaanshaha buundo eexan karta
- Dib u eegista waaqiciga ah (10-30 ilbiriqsi)

## Hababka la tixgeliyay

**Rule-based scoring:** Waa bilaash oo degdeg ah laakiin aad u adag. Qorshayaasha casharku waa hal abuur — sharciyadu ma qaban karaan tayada.

**Peer review:** Macallimiintu dib isu eegaan. Wanaagsan dhaqanka laakiin ma ballaarin karo oo waxay soo bandhigaysaa dhaqanka bulshada.

**Kormeere-keliya dib u eegis:** Waxa jira waqti ahaan. Laakin ma ballaarin karo — kormeerayaashu waxay noqdaan cidhiidhi.
