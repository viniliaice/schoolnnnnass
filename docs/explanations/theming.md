# The Theming System

How the four-theme, light/dark variant system works, and why it's built on CSS custom properties.

## The problem

Schools have different brand identities. A single "blue and white" theme doesn't work for everyone. The system needs multiple themes that can be switched without changing any component code.

## The approach

### Four themes, two variants each

| Theme | Primary | Accent | Ornament | Style |
|-------|---------|--------|----------|-------|
| Acanthus | Deep green (#0F4C3A) | Gold (#C8A24A) | ❧ | Classical, academic |
| Baroque | Deep red (#5B1F1F) | Gold (#D4AF37) | ⚜ | Ornate, formal |
| Aurora | Purple (#7C3AED) | Cyan (#22D3EE) | ✧ | Modern, vibrant |
| Light variants | Same palette | Adjusted contrast | Same | Print-friendly |

Each theme has a dark mode (default) and a light mode.

### CSS custom properties

The entire theme is defined as CSS variables on `:root`:

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

Components reference these variables, not hardcoded colors:

```css
h1 { color: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--border); }
```

### Theme switching

The `ThemeSwitcher` component:

1. Reads the stored theme from `localStorage`
2. Sets `data-theme` and `data-mode` attributes on `<html>`
3. CSS selectors activate the right variable set:

```css
html[data-theme="acanthus"] { --primary: #0F4C3A; --accent: #C8A24A; }
html[data-theme="baroque"] { --primary: #5B1F1F; --accent: #D4AF37; }
html[data-theme="aurora"] { --primary: #7C3AED; --accent: #22D3EE; }

html[data-mode="light"] { --bg: #F7F1E3; --text: #17211C; }
```

### Page gradient

Each theme has a subtle radial gradient background:

```css
--page-gradient: radial-gradient(
  circle at 18% 0%, 
  rgba(200, 162, 74, 0.11), 
  transparent 32rem
), radial-gradient(
  circle at 85% 14%, 
  rgba(15, 76, 58, 0.28), 
  transparent 28rem
), linear-gradient(135deg, #080b10, #0B0F14, #111827);
```

This creates a unique ambient glow per theme without images.

### SVG body pattern

A decorative SVG pattern is overlaid on the body:

```css
body::before {
  background-color: var(--accent);
  -webkit-mask-image: url("data:image/svg+xml,...");
  mix-blend-mode: overlay;
  opacity: var(--pattern-opacity);
}
```

The pattern is a stylized leaf/fleur motif that's themed via `--accent` color and `--pattern-opacity`.

### Ornament watermark

Each theme has a signature character displayed as a subtle watermark:

```css
#root::before {
  content: var(--ornament); /* ❧, ⚜, or ✧ */
  color: var(--accent);
  opacity: 0.07;
}
```

## Why this design

**CSS variables over SASS/LESS:** Variables are runtime-switchable. SASS compiles to static CSS — no theme switching without reloading.

**Data attributes over classes:** `data-theme="acanthus"` is more semantic than `class="theme-acanthus"` and avoids conflicts with Tailwind's class system.

**Component-level theming:** Each component reads from CSS variables. No theme context, no prop drilling, no HOC wrappers. The theme "just works" because the CSS cascade handles it.

## Trade-offs

**What was gained:**
- Theme switching without component changes
- Print-friendly light variants
- Unique visual identity per theme
- No JavaScript theme logic in components

**What was given up:**
- Runtime theme customization (themes are defined in CSS, not configurable by users)
- Per-component theme overrides (global theme only)
- Dynamic theme creation (new themes require CSS changes)

## Alternatives considered

**CSS-in-JS (styled-components, emotion):** Would allow runtime theming but adds bundle size and complexity. The CSS variable approach is simpler and faster.

**Tailwind's dark mode:** Tailwind has `dark:` variants but they only support two modes (light/dark). The four-theme system needs more granularity.

**Theme provider context:** A React context with theme values would work but adds re-renders on theme change. CSS variables change instantly without React involvement.
