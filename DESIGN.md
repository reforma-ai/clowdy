---
name: Clowdy
description: Warm workshop chrome for the Clowdy app — terracotta, paper, squircles, dense type. Inherited from Reforma's design system.
colors:
  primary: "#d97348"
  primary-light: "#ed8c6a"
  primary-muted-light: "rgba(217, 115, 72, 0.08)"
  secondary-muted-light: "rgba(98, 64, 29, 0.05)"
  interactive: "#4f83f3"
  accent: "#6d6af8"
  success: "#5c9b6c"
  warning: "#d9a441"
  danger: "#d96c5f"
  surface: "#f8f7f5"
  background: "#f0ece8"
  secondary: "#e9e7df"
  secondary-content: "#242526"
  text: "#1b1c1d"
  contrast: "#1b1c1d"
  contrast-content: "#f8f7f5"
  surface-float: "#ffffff"
  white: "#ffffff"
  black: "#000000"
typography:
  display:
    fontFamily: "Onest, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 500
    lineHeight: "2.5rem"
    letterSpacing: "0"
  headline:
    fontFamily: "Onest, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: "1.75rem"
    letterSpacing: "0"
  title:
    fontFamily: "Onest, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: "1.25rem"
    letterSpacing: "0"
  body:
    fontFamily: "Onest, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
    letterSpacing: "0"
  label:
    fontFamily: "Onest, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
    letterSpacing: "0"
  button:
    fontFamily: "Onest, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
    letterSpacing: "0"
  code:
    fontFamily: "Menlo, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
    letterSpacing: "0"
rounded:
  xs: "0.25rem"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.75rem"
  xxl: "1.5rem"
  2xl: "2.5rem"
  full: "624.9375rem"
spacing:
  xxs: "0.125rem"
  xs: "0.25rem"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  xxl: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.875rem"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-light}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.875rem"
    height: "2.25rem"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-content}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.875rem"
    height: "2.25rem"
  button-contrast:
    backgroundColor: "{colors.contrast}"
    textColor: "{colors.contrast-content}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.875rem"
    height: "2.25rem"
  button-ghost:
    backgroundColor: "{colors.primary-muted-light}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.875rem"
    height: "2.25rem"
  input:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-content}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0.375rem 0.625rem"
    height: "2.25rem"
  card-filled:
    backgroundColor: "{colors.secondary-muted-light}"
    rounded: "{rounded.lg}"
  card-bordered:
    backgroundColor: "transparent"
    rounded: "{rounded.lg}"
---

# Design System: Clowdy

> Inherited from Reforma's design system. The tokens, type, shape, and component rules below are Clowdy's starting point; sections about Reforma's own product (variable galleries, published sites) describe the source product and will be rewritten as Clowdy's screens appear.

## Overview

**Creative North Star: "The Warm Workshop"**

This file is the Clowdy product chrome (`apps/desktop`, `@clowdy/components`, `@clowdy/styles`). Projects people open in Clowdy bring their own tokens: do not pour terracotta and Onest into them.

The chrome is a quiet tool. Dense, warm, no decoration. Brand lives in Terracotta and squircles, not in illustration, atmosphere, or marketing layout. You are drawing a workbench: paper surfaces, clay for the one voice, faint lift only when something actually floats.

Consume the `@clowdy/styles` CSS variables. Do not invent a parallel palette, type scale, or radius. Tokens live in `packages/styles/src/tokens/` and are edited there by hand (there is no Figma sync).

**Key Characteristics:**

- Warm paper plates, Terracotta as the single voice, Tool Blue and Workshop Violet as supporting semantics
- Onest for all UI type; Menlo only for code
- Compact: default body is 13px (`--text-md`)
- Squircles (`superellipse(1.75)`) on controls, cards, inputs, modals — pills opt out
- Tonal stacking; shadows only on floats
- Light and dark via `.dark` remaps of the same semantic tokens

Confirmed rejections: generic AI-saas (purple gradients, Inter, glassmorphism); Figma/Linear chrome clones; playful or illustration-led product UI.

## Colors

Warm paper and clay. Accents are semantic, not a rainbow.

### Primary

- **Terracotta** (`{colors.primary}`, `--color-primary`): the one voice. Filled primary buttons, input focus border, active card stroke, focus rings (`--color-primary-muted-border`). Hover fill steps to `{colors.primary-light}`.

### Secondary

- **Tool Blue** (`{colors.interactive}`, `--color-interactive`): links, selection, and interactive semantics — not the brand fill.
- **Workshop Violet** (`{colors.accent}`, `--color-accent`): a real token. Use it as a semantic color, never as a gradient wash.

### Tertiary

- **Success / Warning / Danger** (`{colors.success}` / `{colors.warning}` / `{colors.danger}`): status only. Danger fill for destructive confirms. Do not restyle the whole chrome in these.

### Neutral

- **Warm Paper** (`{colors.surface}`, `--color-surface`): default plate. Light-50 clay-tinted off-white.
- **Warm Stone** (`{colors.background}` page, `{colors.secondary}` control fill, `{colors.secondary-content}` on those fills): the stacked workshop sheets.
- **Ink** (`{colors.text}`): default copy. **Contrast** (`{colors.contrast}`) is the loud neutral fill (near-black in light); content on it is `{colors.contrast-content}`.
- **Float** (`{colors.surface-float}`): modal/popover sheets. Overlay is `--color-black-a60`.

Dark mode (`.dark`) remaps the same names: surface goes to `--color-secondary-900` (floats to `--color-secondary-950`), text to Warm Paper, contrast to a light stone fill. Do not author a second palette.

The composer uses `--color-chat-composer`, an alias of `--color-surface-float` in both themes. The user bubble uses `--color-chat-message` (Terracotta at low alpha in light).

**The Terracotta Rule.** Terracotta is the voice, not the wallpaper. One filled primary (or one focus ring) per region. If a screen is orange, you used it as paint.

**The Token File Rule.** New chrome color is a semantic (`--color-primary`, `--color-secondary-muted-light`, …) or a local alias to one. Raw hex in a feature CSS module is a bug unless it is a one-off overlay you cannot name.

## Typography

**Display Font:** Onest (sans-serif fallback)
**Body Font:** Onest (sans-serif fallback)
**Label/Mono Font:** Onest for labels; Menlo for code (`--typography-text-code-sm` / `code-xs`)

**Character:** One family, tight and even. No display serif, no Inter, no letter-spacing theater. Size does the hierarchy; weight only parts headings (500) from body (400). Buttons are 400 up to `md` and 500 at `lg`.

### Hierarchy

- **Display** (`heading-1`, `{typography.display}`): rare chrome titles. 36px / 40px, medium.
- **Headline** (`heading-2`, `{typography.headline}`): 24px / 28px, medium. Page-level in settings/empty states.
- **Title** (`heading-3`–`heading-6`, `{typography.title}` at lg): 18px down to 12px, medium. Section labels in panels.
- **Body** (`text-md`, `{typography.body}`): default UI copy. 13px / 18px. `text-sm` (12px) and `text-xs` (11px) are the two steps down; `text-lg` (16px) and `text-xl` (18px) are the two steps up — not a second body.
- **Label** (`label-sm`, `{typography.label}`): 12px / 16px. Field labels, helper text.
- **Button** (`{typography.button}`): 13px regular on `md`. Size `sm`/`xs` drop to 12px; `lg` is 16px medium.
- **Code** (`{typography.code}`): Menlo, 11px default.

Use `<Text variant="…">` from `@clowdy/components`. Do not invent a type ramp in a feature file.

**The Density Rule.** Chrome body is 13px. Do not “fix” it to 16px for readability. This is an editor, not a marketing page.

## Layout

Mobile-first custom media in `@clowdy/styles`: `--tablet` 640px, `--desktop-sm` 1024px, `--desktop` 1280px, `--desktop-md` 1440px, then `--fhd` / `--qhd` / `--uhd`. Named max counterparts exist (`--tablet-max`, …).

Spacing is a 2px-based rem scale. Prefer the named steps `{spacing.xxs}`–`{spacing.xxl}` (`--spacing-xxs` … `--spacing-xxl`) and Box `gap` / `padding` (`xxs` | `xs` | `sm` | `md` | `lg` | `xl`). Numeric `--spacing-2` … `--spacing-288` exist; do not skip the named steps for ordinary chrome.

Density is compact: `md` controls are 36px tall (`--spacing-36`); `sm` 30px; `xs` 24px; `lg` 56px. Panel and chat UI live at `sm`/`md`. Do not stretch editor chrome to marketing padding.

No page max-width or marketing grid in the product shell. Workspace and editor are full-viewport tools. Settings live in a modal chrome (`SettingsLayout`), not a marketing column.

## Elevation & Depth

Tonal first. Surfaces stack by color (paper → stone fill → muted → float). Shadows exist as tokens and are for things that leave the plane.

Buttons, cards, inputs, and rails are flat at rest. Depth is a darker or lighter plate, a 1px muted border, or a press scale — not a drop shadow.

### Shadow Vocabulary

- **xs–xl** (`--shadow-xs` … `--shadow-xl`): increasing offset and blur, all `black-a5` except xl at `black-a8`. **xl** is the modal lift (`--modal-box-shadow: var(--shadow-xl)`).
- **Float** (`--shadow-float`, remapped in dark): the lift of a small float — popovers, menus, a button over a selection — with a 1px `--color-surface-border`.
- **AI glow** (`--effect-ai`): 20px Terracotta-alpha bloom. For AI-authored moments, not for every button.
- Dark modal: a 1px light hairline (white at 12%) plus a `0 16px 40px` `black-a50` shadow — not the light-mode xl recipe.

**The Float-Only Shadow Rule.** If it does not overlay the page (modal, popover, tooltip, menu), it does not get a shadow. No ambient card shadows. No glass.

## Shapes

Squircles are the default control silhouette. `--radius-lg` (10px) on `md` buttons, inputs, and cards; `--radius-xl` (12px) on modals. Always multiply radius by `--squircle-radius-factor` and set `corner-shape: superellipse(var(--squircle-value))`. The factor lives on `:root` (1, or 1.573 where superellipse is supported) — do not wrap call sites in `@supports`.

Pills (`rounded` on Button, `--radius-full`) force `corner-shape: round`. Do not squircle a pill.

Borders are 1px. Default inputs have a transparent border that becomes Terracotta on focus and muted stone on hover. Cards: filled (no stroke), bordered (muted stroke), or transparent.

**The Squircle Rule.** New controls inherit the squircle. Do not switch a one-off to `border-radius: 8px` “to match iOS” or to sharp rects “to look more editor.” Pills and true circles are the only opt-out.

## Components

Primitives live in `@clowdy/components`. Variant APIs are data attributes, not new CSS files.

### Buttons

Refined and restrained. Fill is the one action; ghost and filling do the rest.

- **Shape:** squircle; radius tracks size (`sm` 8px, `md` 10px, `lg` 12px). Icon-only buttons scale to `0.92` while pressed; text buttons do not scale. 150ms ease-out. Focus: 4px Terracotta-muted ring, no offset (`@ruleset focus-ring`, `--color-focus-ring`), the one ring of the app.
- **Primary filled:** Terracotta plate, white label. Hover: `{colors.primary-light}`.
- **Secondary filled (default):** Warm Stone plate. Default when `color` is omitted (except `inline` / `transparent`, which inherit).
- **Contrast filled:** Ink plate, paper label. Used for the commit button and other prominent neutral actions.
- **Ghost:** muted tint of the color, no border. Quiet paired actions.
- **Filling:** transparent until hover paints a muted plate.
- **Bordered / transparent / inline:** stroke, fade, or in-copy link. Inline has no padding and inherits type.
- **Disabled:** `--opacity-disabled` (0.4). Pending: in-button spinner, label hidden.

### Chips

Chat chips: 20px tall, `sm` squircle, muted stone fill, 11px type (`text-xs`); a status pill is the same chip fully round. Interactive hover darkens the plate. Focus uses the same Terracotta-muted ring as buttons. Build them with `Chip` from `@clowdy/components/Chip`, which holds the one tone map.

### Cards / Containers

- **Corner Style:** squircle, `md`/`lg`/`xl` by size
- **Background:** filled = `--color-secondary-muted-light` (or the color’s muted-light); bordered = transparent; transparent = no plate until hover
- **Shadow Strategy:** none. Press on hoverable cards: `translate 0 2px` + `scale(0.98)`
- **Border:** 1px; active/selected uses Terracotta
- **Internal Padding:** caller-owned (Box), not baked into Card

### Inputs / Fields

- **Style:** filled Warm Stone, squircle, 36px at `md`, body type. Prefix/suffix sit inside the plate.
- **Focus:** 1px Terracotta border (`:focus-within`). No extra glow.
- **Hover:** muted stone border, not a fill change.
- **Error:** danger border; focus becomes `--color-danger`.
- **Disabled:** 0.4 opacity. Bordered and transparent variants exist; default is filled.

### Navigation

Workspace and editor chrome are toolbars and rails, not a marketing nav. Items are Buttons (`filling` / `transparent` / `icon`) and Text. Active is tonal or Terracotta text, not a pill nav copied from Linear. Settings use `SettingsLayout`: sidebar list, title, panes inside modal chrome.

### Modal (signature)

Float plate: `{colors.surface-float}`, 1px muted border, `--shadow-xl`, `--radius-xl` squircle. Overlay `--color-modal-overlay`. Title row 40px. This is the only place large radius + shadow stack by default.

## Do's and Don'ts

### Do:

- **Do** consume `@clowdy/styles` and `@clowdy/components`. Map local CSS variables to those tokens.
- **Do** keep Terracotta rare: one filled primary or one focus per region.
- **Do** set squircles on new controls (`corner-shape` + `--squircle-radius-factor`).
- **Do** use Onest at `--text-md` (13px) for chrome body; Menlo only for code.
- **Do** stack plates tonally (paper / stone / muted / float) before reaching for a shadow.

### Don't:

- **Don't** pour this system into the projects people open in Clowdy.
- **Don't** use Inter, purple gradients, or glassmorphism.
- **Don't** clone Figma or Linear chrome.
- **Don't** illustrate the product shell or make it playful.
- **Don't** put drop shadows on cards, buttons, or rails.
- **Don't** invent a 16px body “for a11y” in the editor chrome.
