# Nidaamka Mawduucyada

Sida nidaamka afar mawduuc, light/dark variants u shaqeeyo, iyo sababta CSS custom properties loogu dhisay.

## Dhibaatada

Dugsiyadu waxay leeyihiin aqoonsiyo kala duwan. Hal mawduuc oo "buluug iyo caddaan" ah kuma shaqeeyo qof kasta. Nidaamku wuxuu u baahan yahay mawduucyo kala duwan oo la beddeli karo iyadoon wax laga beddelin koodhka component-ka.

## Habka

### Afar mawduuc, laba nooc

| Mawduuc | Midabka Koowaad | Midabka Xajka | Astaanta | Qaabka |
|---------|----------------|---------------|----------|--------|
| Acanthus | Cagaar qoto dheer (#0F4C3A) | Dahab (#C8A24A) | ❧ | Classical, dugsiyeed |
| Baroque | Casaan qoto dheer (#5B1F1F) | Dahab (#D4AF37) | ⚜ | Qurux badan, rasmi ah |
| Aurora | Purple (#7C3AED) | Cyan (#22D3EE) | ✧ | Casri, firfircoon |
| Light variants | Isku midab | La hagaajiyay | Isku | Daabacad-fiican |

Mawduuc kastaa wuxuu leeyahay dark mode (caadi) iyo light mode.

### CSS custom properties

Mawduuca oo dhan waxaa lagu qeexay CSS variables `:root`:

```css
:root {
  --bg: #0B0F14;
  --surface: #111827;
  --primary: #0F4C3A;
  --accent: #C8A24A;
  --text: #F5F5F4;
  --heading-font: "Cinzel", serif;
  --body-font: "Inter", sans-serif;
}
```

Component-yadu waxay tixraacaan variables-kaan, ma aha midabyo adag:

```css
h1 { color: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--border); }
```

### Beddelka mawduuca

Component-ka `ThemeSwitcher`:

1. Wuxuu akhriyaa mawduuca kaydsan `localStorage`
2. Wuxuu dejiyaa `data-theme` iyo `data-mode` attributes `<html>`-ka
3. CSS selectors waxay hawlgeliyaan variables-ka saxda ah:

```css
html[data-theme="acanthus"] { --primary: #0F4C3A; --accent: #C8A24A; }
html[data-theme="baroque"] { --primary: #5B1F1F; --accent: #D4AF37; }
html[data-theme="aurora"] { --primary: #7C3AED; --accent: #22D3EE; }

html[data-mode="light"] { --bg: #F7F1E3; --text: #17211C; }
```

## Sababta nidaamkan loo doortay

**CSS variables oo aan aheyn SASS/LESS:** Variables waa la beddeli karaa runtime-ka. SASS wuxuu u rogaa CSS taagan — mawduuc beddelasho la'aan reload la'aan.

**Data attributes oo aan aheyn classes:** `data-theme="acanthus"` waa ka fiican yahay `class="theme-acanthus"` kumana dhaco Tailwind-ka.

**Component-level theming:** Component kastaa wuxuu ka akhriyaa CSS variables. Waxba kuma jiraan theme context, prop drilling, ama HOC wrappers.

## Isbarbardhig

**Waxa la helay:**
- Beddelka mawduuca iyadoon wax laga beddelin components
- Light variants oo daabacad-fiican
- Aqoonsi gaar ah mawduuc kasta
- JavaScript theme logic oo ku jirin components

**Waxa la waayay:**
- Runtime theme customization (mawduucyada waxaa lagu qeexay CSS)
- Per-component theme overrides (mawduuc caalami ah oo keliya)
- Dynamic theme creation (mawduucyo cusub waxay u baahan yihiin CSS beddelaad)

## Hababka la tixgeliyay

**CSS-in-JS (styled-components, emotion):** Waxay u oggolaan lahayd runtime theming laakiin waxay ku dari lahayd cabirka bundle-ka iyo kakanaanta. CSS variables waa ka fudud yahay oo ka dhakhso badan yahay.

**Tailwind's dark mode:** Tailwind waxay leedahay `dark:` variants laakiin waxay taageertaa laba nooc oo keliya (light/dark). Nidaamka afar mawduuc wuxuu u baahan yahay tafaasiil dheeri ah.

**Theme provider context:** React context leh mawduuc qiimayaal ah waa shaqayn lahayd laakiin waxay ku dari lahayd re-renders marka mawduucu isbeddelo. CSS variables way isbeddelaan si degdeg ah React la'aan.
