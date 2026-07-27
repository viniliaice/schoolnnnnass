# Qaabka Xogta

Sababta database-ka loo qaabeeyay sidaan, iyo sida qaybuhu isugu xirmaan.

## Dhibaatada

Nidaamka maamulka dugsiyada wuxuu u baahan yahay inuu raad raaco:
- Isticmaalayaasha (admin, macallin, waalid, kormeere)
- Ardayda iyo diiwaangelinta fasalka
- Natiijooyinka imtixaanka (maado, bil, nooc)
- Taariikhda dugsiyada (sannado, xilliyo, bilo)
- Qoondaynta (macallin bariyo fasalka-maadada)
- Warbixinnada (xogta imtixaanka oo la isu geeyay)

Dhibaatadu waxay tahay: qaybahan waxay leeyihiin xiriir adag, habka helitaankuna wuu kala duwan yahay door kasta.

## Habka

### Xiriirka qaybaha muhiimka ah

```
profiles (isticmaalayaasha)
  ├── students (hal profile → arday badan via parentId)
  ├── exams (hal macallin → imtixaan badan via teacherId)
  ├── class_subjects (hal macallin → qoondayn badan)
  └── auth_id → auth.users (Supabase auth)

students
  ├── exams (hal arday → imtixaan badan)
  ├── attendance (hal arday → diiwaan badan)
  └── parentId → profiles (xiriirka waalidka)

class_subjects
  ├── className + subjectId → subjects
  └── teacherId → profiles
```

### Sababta profiles loo isticmaalay, ee ma aha users

Table-ka `profiles` wuxuu kaydiyaa xogta isticmaalaha heerka barnaamijka. `auth.users` wuxuu maamulaa authentication-ka. Waxay isugu xirmaan `auth_id`:

```
auth.users (Supabase)     profiles (Application)
├── id (UUID)             ├── id (TEXT)
├── email                 ├── auth_id → auth.users.id
└── password_hash         ├── name
                          ├── role
                          ├── assignedClasses
                          └── assignedSubjects
```

Kala saaridaani waxay ka dhigan tahay:
- Auth waxaa maamula Supabase (badqab, la dayactiro)
- Xogta barnaamijku waa gacanteeda (qaab dabacsan)
- `auth_id` wuxuu u oggolaanayaa soo celinta session-ka

### Sababta imtixaannadu yihiin xarunta

Table-ka imtixaanku wuxuu isku xiraa wax walba:

```
exam
├── studentId → students
├── teacherId → profiles
├── subject (text, denormalized)
├── examType (CA, Homework, Classwork, Quiz, Midterm, Final)
├── month (text)
├── status (pending → approved/rejected)
└── termId → terms (optional)
```

`status` wuxuu abuuraa hawl: macallimiintu geliyaan → kormeerayaashu ansixiyaan → waalidku arkaan. Laba tallaabo oo kala ah ayaa hubiya tayada xogta.

### Sababta class_subjects u jirto

Macallimiintu ma bariyaan "Mathematics" oo keliya — waxay bariyaan "Mathematics fasalka Grade 5-A". Table-ka `class_subjects` wuxuu qabtaa tan:

```
class_subjects
├── className: "Grade 5-A"
├── subjectId → subjects
└── teacherId → profiles
```

Tani waxay u oggolaanaysaa:
- Macallimiintu waxay arkaan fasalladooda oo keliya
- Kormeerayaashu waxay la socon karaan iskudhafyada fasalka-maadada
- Warbixinnadu waxay isu geeyaan fasalka-maadada

### RLS policies

Row-Level Security waxay hubisaa in door kastaa arko waxa uu arki karo oo keliya:

```
Macallin: WHERE teacherId = auth.uid()
  → wuxuu arki karaa imtixaannadiisa oo keliya

Waalid: WHERE parentId = auth.uid()
  → wuxuu arki karaa imtixaannada carruurtiisa oo keliya

Arday: WHERE studentId = auth.uid()
  → wuxuu arki karaa imtixaannadiisa oo keliya
```

Kormeerayaashu RLS ma qabso — waxay u baahan yihiin inay arkaan xogta oo dhan xaqiijinta.

## Isbarbardhig

**Subject-ka denormalized:** Table-ka `exams` wuxuu kaydiyaa `subject` qoraal ahaan, ma aha foreign key. Tani waxay nuqul ka dhigtaa xogta laakiin waxay fududaysaa queries.

**TEXT IDs:** App-ku wuxuu isticmaalaa TEXT astaamaha koowaad (nanoid). UUIDs waa heer caadi ah laakiin TEXT waa ka fudud yahay.

**Xiriirka xilligu waa ikhtiyaar:** Imtixaannadu way jiri karaan la'aanteed `termId`. Tani waxay siisaa dabacsanaan laakiin waxay ka dhigan tahay in warbixinnadu ay maamulaan imtixaannada aan xiriirka lahayn.

## Hababka la tixgeliyay

**Subject-normalized (Iska caadiyey):** Isticmaalka `subjectId` oo foreign key ah imtixaannada wuxuu ka hortagi lahaa qaladaad laakiin wuxuu ku dari lahaa JOIN su'aal kasta oo imtixaan ah. Habka denormalized ayaa loo doortay fududaynta queries.

**Exam_types table gaar ah:** Table gooni ah ama enum wuxuu noqon lahaa mid normalized badan laakiin noocyadu waa go'an yihiin oo yar yihiin — enum ku filan ayaa ku filan.

**Soft deletes:** Ku darista `deletedAt` timestamp wuxuu u oggolaan lahaa soo celinta laakiin wuxuu ku dari lahaa kakanaanta. Habka hadda wuxuu isticmaalaa hard deletes leh CASCADE.
