# Place design system

The design of the Place app, written down from the live product.
Anything new (a page, a feature, a fix) follows this file, and if the design changes on purpose, this file changes in
the same commit. Paths in this file are relative to `frontend/`.

**One UI, two themes.** Every page is built once (`src/themes/place`, `src/components`) and both themes render the same
markup and layout. A theme only changes design tokens, type and motion.

**Contents:** [Rules](#1-rules) · [Themes](#2-themes) · [Colour](#3-colour) · [Typography](#4-typography) ·
[Spacing and layout](#5-spacing-and-layout) · [Surfaces](#6-surfaces) · [Components](#7-components) ·
[Patterns](#8-patterns) · [Motion](#9-motion) · [Icons and images](#10-icons-and-images) · [Copy](#11-copy) ·
[Files](#12-files) · [Checklist](#13-checklist)

---

## 1. Rules

1. **Never hard-code a colour.** Use the tokens in this file, and no others. A colour written as hex or rgba in a
   component breaks the other theme. Style with classes rather than inline colours and radii.
2. **One accent.** `--accent` is the only brand colour on a screen. The agent colour is used only for agent features
   (Agent Zone, Settings, Skill; hidden while `FEATURES.agents` is off). Grays and white space carry the rest.
3. **Same layout in every theme.** Never branch markup by theme. If a theme needs a different look for something, add a
   token or a scoped rule in `based.css` (`html[data-theme='based'] ...`).
4. **Reuse before you build.** Use the components in `src/themes/place/components/ui/index.jsx` and the existing classes.
   Don't write a new button, card or badge.
5. **Flat surfaces.** Depth comes from stepped surfaces and 1px borders, not shadows. Shadows are only for things that
   float above the page (menus and modals).
6. **Numbers in mono.** Amounts, balances, addresses and countdowns use the mono font with tabular figures.
7. **Mobile is a first-class layout.** Every screen works at 375 px, with no sideways scrolling and nothing hidden
   behind the top bar.
8. **Calm and factual.** Short left-aligned headers and plain text. No decorative gradients on cards, no emoji in the
   UI, no marketing shouting.

---

## 2. Themes

| Theme | Look | Tokens | Fonts |
|---|---|---|---|
| **Dark** (default) | Dark, flat surfaces, light-blue accent, teal for the agent | `src/themes/place/styles/tokens.css` | Inter, JetBrains Mono |
| **Based** | Light, Base brand (brand.base.org): white + Base gray ramp, Base Blue | `src/themes/place/styles/based.css` | Inter Tight, Roboto Mono, Doto |

- The theme is `<html data-theme="dark|based">`. `src/theme.js` picks it from `?theme=`, then the stored `place_theme`,
  and defaults to Dark. Users switch it in the header on desktop and in the More sheet on mobile.
- `tokens.css` defines every token, and `based.css` overrides them. A new token goes into **both** files, or it must
  work unchanged in both themes.
- The build scopes the theme folder's CSS to both themes (`THEME_IDS` in `vite.config.js`). Add new theme CSS to
  `src/themes/place/`, and it is scoped automatically.
- CSS loads in the order set by `src/themes/place/index.js`, with `based.css` last, so its overrides win.

---

## 3. Colour

### Surfaces, lines and text

| Token | Dark | Based | Use |
|---|---|---|---|
| `--bg` | `#090A0C` | `#FFFFFF` | Page |
| `--bg-bar` | `#0B0C0F` | `#FFFFFF` | Top bar and live trades strip |
| `--surface` | `#111317` | `#FFFFFF` | Cards, tiles, secondary buttons |
| `--surface-2` | `#16191E` | `#EEF0F3` | Anything inside a card, hover state |
| `--surface-3` | `#1D2128` | `#DEE1E7` | Progress track, scrollbar thumb |
| `--tile` | `#15181D` | `#FFFFFF` | Raised tiles |
| `--code-bg` | `#0D0F13` | `#EEF0F3` | Code blocks |
| `--on-image` | `#F5F7FA` | `#FFFFFF` | Text on artwork, always over a dark overlay |
| `--border` | white 7% | `#DEE1E7` | Default 1px line |
| `--border-strong` | white 12% | `#B1B7C3` | Hover, secondary buttons, menus |
| `--text` | `#F5F7FA` | `#0A0B0D` | Primary text |
| `--text-2` | `#A3A9B3` | `#5B616E` | Descriptions, inactive nav |
| `--text-3` | `#6C727D` | `#717886` | Labels, hints, captions |

### Brand and agent

| Token | Dark | Based | Use |
|---|---|---|---|
| `--accent` | `#66BEFF` | `#0000FF` | Primary action, active state, focus |
| `--accent-hover` | `#82CBFF` | `#3C8AFF` | Hover |
| `--accent-press` | `#4FADF2` | `#0033A0` | Pressed |
| `--on-accent` | `#06121F` | `#FFFFFF` | Text on the accent |
| `--accent-soft` | accent 14% | accent 7% | Active nav item, info alert |
| `--accent-border` | accent 30% | accent 28% | Border of soft accent elements |
| `--agent` | `#2EE6CF` | `#0000FF` | Agent features only |
| `--agent-hover` | `#5FF0DD` | `#3C8AFF` | Hover |
| `--on-agent` | `#04201C` | `#FFFFFF` | Text on the agent colour |
| `--base-blue` | `#0052FF` | `#0000FF` | Chain dot only |

### Status

Each status colour has a text colour, a background (`-bg`) and a border (`-bd`). Use all three together.

| Token | Dark | Based | Meaning |
|---|---|---|---|
| `--green` | `#2FD08A` | `#3D9A00` | Live, eligible, claimed, success; Buy and price up on the launchpad |
| `--amber` | `#F5B83D` | `#B07A00` | Warning, rules to know, streak flame |
| `--red` | `#FF5A5F` | `#E5341A` | Errors, ended, expired; Sell and price down on the launchpad |

### Overlays and tints

- Subtle overlay: `color-mix(in srgb, var(--tint-ink) N%, transparent)`. The ink is white in Dark and dark in Based.
- Tint of a token: `color-mix(in srgb, var(--accent) 14%, transparent)`.
- Shared wallet and agent pages read the tokens through aliases (`--pw-*`, `--agp-*`), so they follow the theme.

---

## 4. Typography

**Fonts:** `--font-sans` for all text and `--font-mono` for numbers (`.num` or `.mono`). In Based, `--font-display`
(Doto, bold, all caps) is for very short labels only, such as the Agent Zone badge. Weights in use: 400, 500, 600, 700.
Base size is 15 px.

| Role | Size | Weight | Colour | Notes |
|---|---|---|---|---|
| Page title (`.page-title`) | 36 px, 28 px on mobile | 700 | `--text` | Line height 1.15, spacing -0.02em (-0.03em in Based) |
| Page description (`.page-desc`) | 15 px | 400 | `--text-2` | Line height 1.5, max width 680 px |
| Section title (`.section-title`) | 18 px | 600 | `--text` | Count beside it: 14 px, 500, `--text-3` |
| Card title | 16 px (14 px in compact cards) | 700 (600) | `--text` | Spacing -0.01em |
| Body | 14–15 px | 400 | `--text` or `--text-2` | |
| Alert | 14 px | 400 | `--text` | Line height 1.45 |
| Secondary text, captions | 12–13 px | 400 | `--text-3` | |
| Tile label (`.tile-label`) | 13 px | 400 | `--text-3` | |
| Tile value (`.tile-value`) | 20 px mono | 700 | `--text` | Spacing -0.01em |
| Tile sub (`.tile-sub`) | 13 px mono | 400 | `--text-3` | |
| Large amount input | 24 px mono | 700 | `--text` | Swap |
| Button | 15 px; 16 px `lg`; 14 px `sm` | 600 | By variant | |
| Badge | 11 px; 12 px as a pill | 600 | By tone | Spacing 0.02em |
| Form label | 12 px | 600 | `--text-2` | |
| Form input | 14 px | 400 | `--text` | |
| Top bar section | 14 px | 500 | `--text-2`, active `--accent` | |
| Menu item | 14 px | 500 | `--text-2`, hover `--text` | |

Text is 11 px at the smallest. All caps is only for small group labels and Doto labels.

---

## 5. Spacing and layout

### Spacing

The base unit is 4 px: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 20 · `--s6` 24 · `--s8` 32 · `--s10` 40 ·
`--s12` 48 · `--s16` 64.

| Where | Value |
|---|---|
| Between page sections | 24 px |
| Page header to content | 32 px |
| Section title to content | 16 px |
| Card grid gap | 12 px (8–10 px on mobile) |
| Card padding | 20 px (18 px compact) |
| Inside a card, between blocks | 12–18 px |
| Tile padding | 14 px 16 px |
| Table row padding | 14 px 16 px (header 10 px 16 px) |
| Icon to text | 6–10 px |

### App shell

There is no sidebar and no bottom bar: everything hangs off one top bar, as on a trading terminal.

| Element | Desktop (1024 px and up) | Mobile (below 1024 px) |
|---|---|---|
| Top bar (`.pl-topnav`) | Sticky, 64 px, side padding 24 px: logo + product menu, sections, search, Launch NFT, Launch token, theme, wallet | Sticky, 60 px, side padding 12 px: logo, Launch token (icon), wallet, menu button |
| Live trades strip | Full width, 40 px, under the top bar on every app page | Same |
| Menu sheet | — | Slides in from the right, 320 px (max 88vw): search, sections, product menu, theme |
| Page section | Padding 24 px top, 60 px bottom | Same |
| Page gutter | 16 px | 16 px |
| Space under content | 40 px | 40 px |

### Page widths

| Width | Pages |
|---|---|
| 1536 px | Dashboard, Stocks, launch token page, Launch a token (form and preview), Launch NFT, Profile, every Rewards hub page, Projects, project and collection pages |
| 1040 px | Agent Zone, Skill, Admin |
| 760 px | Docs article (its own shell: top bar, menu, "On this page") |
| 640 px | Settings |
| 560 px | Wallet, Account |
| 480 px | Swap |

Use the widest width for dashboards, and a narrow column for one focused task. Pages are left-aligned inside a centred
container.

### Breakpoints

| Width | What changes |
|---|---|
| 1024 px | Full top bar. Below it: sections move into the menu sheet (use this one for the shell only) |
| 768 px | Main content breakpoint: 4 columns become 2, page title 28 px, `lg` buttons become full-width pills |
| 640 px | Stat and tile grids collapse to 1 column, table headers hide, action rows stack |
| 480 px, 380 px | Fine tuning on narrow phones |

### Grids

Grids use `repeat(N, minmax(0, 1fr))` so content can't push them wider than the page.

| Grid | Desktop | Mobile |
|---|---|---|
| Campaign cards (`.pl-campaign-grid`) | 4 columns, gap 12 px | 2 columns, gap 10 px |
| Tiles (`.pl-hub-tiles-3`) | 3 columns, gap 12 px | 1 column, gap 8 px |
| Claim stats (`.pl-claim-stats-grid`) | 3 columns, gap 12 px | 1 column, gap 8 px |
| Mint (`.pl-nft-mint-grid`) | `1fr 1.15fr`, gap 24 px | 1 column, gap 16 px |

---

## 6. Surfaces

| Token | Dark | Based | Use |
|---|---|---|---|
| `--r-sm` | 8 px | 6 px | Small controls, close buttons |
| `--r-md` | 12 px | 8 px | Buttons, tiles, alerts, campaign cards |
| `--r-lg` | 16 px | 12 px | Cards, large buttons |
| `--r-xl` | 20 px | 16 px | Hero blocks, celebration modals |
| `--r-full` | 999 px | 999 px | Pills, segmented controls, header buttons |

**Layering:** page (`--bg`) → card (`--surface`) → block inside a card (`--surface-2`). A `.tile` inside a `.card`
steps to `--surface-2` automatically. Every card needs a border of `1px solid var(--border)`.

**Shadows** are for floating elements only:
- Menus: `0 12px 32px rgba(0,0,0,.5)`
- Modals: `0 12px 40px rgba(0,0,0,.6)` to `0 24px 64px rgba(0,0,0,.6)`

**In Based, every card, panel and table needs its own background** (`var(--surface)`). The page has a texture that
would show through otherwise.

**Focus:** `outline: 2px solid var(--accent)` with a 2 px offset comes from the base styles. Never remove it.

---

## 7. Components

Import from `src/themes/place/components/ui/index.jsx`.

### Button

`<Button variant size fullWidth as>`. Use `as="a"` for links.

| Variant | Look | Use |
|---|---|---|
| `primary` | Accent fill, `--on-accent` text | The one main action in a view |
| `secondary` (default) | `--surface`, `--border-strong` border | Everything else |
| `ghost` | Transparent, `--text-2`, fills on hover | Low-priority actions |
| `warn` | Amber fill | Rare, for an action that needs attention |

| Size | Height | Padding | Radius |
|---|---|---|---|
| `sm` | 32 px | 0 12 px | 10 px |
| `md` (default) | 40 px | 0 16 px | `--r-md` |
| `lg` | 52 px | 0 24 px | `--r-lg`; full-width pill at 768 px and below |

Icon gap 8 px. Pressed: `scale(0.98)`. Disabled: opacity 0.45. While loading, show `Loader2` spinning and a short
label ("Claiming on Base...").

### Card

`<Card hover>`: `--surface`, 1 px border, `--r-lg`, padding 20 px. `hover` makes it step to `--surface-2` with
`--border-strong`. Use it for clickable cards only.

### Tile

`<Tile label value sub icon>` shows one metric, such as a balance or a pool. The value is mono. Add `tile-danger` for a
red value.

### Badge and StatusPill

`<Badge tone pill>`, with tones `neutral`, `accent`, `success`, `warn` and `danger`. Plain badges are 20 px high and
pills are 24 px. `<StatusPill status>` picks the tone from the text:

| Status | Tone |
|---|---|
| Live, active, unlocked, eligible | `success` |
| New, info, pre | `accent` |
| Warn | `warn` |
| Ended, not eligible | `danger` |
| Anything else (locked, upcoming) | `neutral` |

### PageHeader and SectionTitle

Every page starts with `<PageHeader title description badge action>`, left-aligned: one sentence of description, no
hero art. Sections inside a page use `<SectionTitle title count right>`.

### Alert

`<Alert tone icon action>`, with tones `info`, `warn`, `success` and `danger`. It takes the tone's `-bg` and `-bd`
colours, `--r-md` and padding 12 px 16 px. The text stays `--text`, so it remains readable.

### EmptyState and ProgressBar

- `<EmptyState icon title description action>`: centred, padding 48 px 24 px. Say what is missing and what happens
  next, never just "No data".
- `<ProgressBar value max>`: 4 px high, `--surface-3` track, accent fill.

### Segmented control

`.seg` with `<button aria-selected>` inside. A pill row: 32 px buttons, 14 px, selected in accent fill. Add `.soft` for
the quieter accent-soft version. Use it for switching a view or filter.

### Forms

Use `.pw-field`: label 12 px, 600, `--text-2`, gap 6 px. Inputs and selects are 44 px high, padding 0 12 px, 10 px
radius, on `--surface-2` with a `--border` border that turns `--accent` on focus. `.pw-amount` holds an amount with a
token select.

---

## 8. Patterns

### A new page

```jsx
<section style={{ padding: '24px 0 60px 0' }}>
  <div style={{ maxWidth: '1040px', margin: '0 auto', padding: '0 14px' }}>
    <PageHeader title="Page name" description="One factual sentence about what it does" />
    {/* sections 24px apart */}
  </div>
</section>
```

Then add the route in `src/themes/place/App.jsx`, the view in `BaseAppView.jsx`, and a link in `BaseAppTopNav.jsx`
(a section, or the product menu), and its section in `sectionOf` (`BaseAppView.jsx`). Give
the page a stylesheet `styles/<page>.css` with `pl-<page>-*` classes, and import it in `src/themes/place/index.js`
before `based.css`.

### Navigation

The shell is `src/themes/place/components/BaseAppTopNav.jsx`, styled in `components.css` (`.pl-topnav-*`).

- **Sections** (`NAV_SECTIONS`): Dashboard (`/`), Stocks (`/stocks`), Profile (`/profile`), Rewards (`/hub`),
  Projects (`/projects`). A section link is a 36 px pill, 14 px, 500, `--text-2`; active `--accent-soft` with
  `--accent`; hover `--surface-2`. Between 1024 and 1279 px the links drop their icons and the bar tightens its gaps.
  Pages without a section of their own light up the one they belong to (`sectionOf` in `BaseAppView.jsx`): the
  launch token page and the launch form belong to Dashboard; campaign, staking, Create vault / campaign and Launch NFT
  to Rewards; project pages (`/token/:address`) and Register token to Projects.
- **Product menu:** the chevron next to the logo opens the other pages (My rewards and My launches in the profile,
  Staking, Create vault / campaign, Launch NFT, Register token, Wallet, Swap, Docs; Skill with agents on; Admin for
  Place admins).
- **Search:** a 40 px pill, focused with `/` from anywhere. An address opens that token, any other text opens the
  Dashboard filtered by it (`/?q=`).
- **Right side:** Launch NFT (secondary pill with a sparkle, desktop only; in the product menu on mobile), Launch token
  (primary pill; an icon only on mobile), Agent Zone and the wallet toggle (agents only),
  the theme switcher (desktop), and the address pill (Base chain dot, short address, network name on desktop), which
  opens the wallet menu (Wallet, Account, Logout), or Connect wallet. Everything is a 36 px pill.
- **Rewards** is one list (All rewards) with no row of its own; creating starts from Create vault / campaign and Launch
  NFT in its head. Old links `/rewards` and `/my` redirect to `/profile/rewards` and `/profile/launches`.
- **Agent features** (Agent Zone, agent wallet, agent Settings, Skill) sit behind one flag, `FEATURES.agents` in
  `src/config/features.js`, and ship in the next upgrade. While it is off: `/agents`, `/settings` and `/skill`
  redirect home, the nav leaves them out, and Wallet, Swap and Account show the main wallet only (no Main / Agent
  toggle).
- Old links `/launch` and `/launch/profile/*` redirect to `/` and `/profile/*`.

### Campaign card

`.pl-campaign-card`: a 16:9 image with a dark gradient overlay, a badge top-left and a 13 px `--on-image` title
bottom-left. `--r-md`. Active: accent border and outline. Hover: the image scales to 1.02. In Based the badge sits on a
white plate so its colour stays readable over the art. Any text placed on artwork follows the same rules.

### Place campaign card

`.pl-place-card` in `.pl-place-grid` (3 columns, 2 at 768 px, 1 at 480 px): a `Card hover` link with the 16:9
campaign card on top (banner, status badge, title) and a body below it: the pool in mono, the asset, and the next
moment with a countdown. Status tones come from `STATUS_TONE` in `src/place/format.js` (Live green, Snapshotting
accent, Refundable amber, Ended red, the rest neutral).

### Place detail pages

A back link, then `.pl-place-head` (token icon, title, badges), `.pl-place-tiles` (3 tiles), and `.pl-place-cols`
(a main column and a side column with "Your reward", the timeline and contract details). Lists with actions use
`.pl-place-rows` / `.pl-place-row`; forms use `.pl-place-form` and `.pl-place-field`. Every on-chain action goes
through `usePlaceTx` and shows `TxButton` and `TxResult` (`pages/place/parts.jsx`). Without a wallet, pages offer
Connect wallet and an address field to check any wallet.

### Featured card

`.pl-hub-featured-card`: padding 20 px, gap 18 px. It has a head (40 px icon, 16 px name, 12 px sub, status badges on
the right), then a tile grid, then the action row aligned right. On mobile the action row stacks at full width.

### Tables and schedules

`.pl-schedule-card` wraps a `--r-md` block. The head is `--surface-2`, 12 px, 500, `--text-3`. Rows are padded 14 px
16 px with a `--border` divider and `--surface-2` on hover. At 640 px and below the head hides and rows reflow. Long
lists scroll inside the card (`.pl-schedule-scroll`).

### FAQ

`.pl-faq-card` with `.pl-faq-item` and `.pl-faq-trigger`: rows of 13 px, 600, padding 14 px 16 px, divided by
`--border`, with a chevron on the right.

### Launchpad pages

Place Launch lives under `/launch` and is built in `src/launch/ui` with `styles/launch.css` (`pl-launch-*`). It uses
the same components and tokens as the hub; only these pieces are its own:

- **Live ticker** (`.pl-launch-ticker`): a pill strip of the latest trades on top of the dashboard. It scrolls slowly,
  stops under the pointer, and is a plain scrollable row with reduced motion. Buy is `--green`, Sell is `--red`.
- **Category tabs** (`.pl-launch-tabs`): All / Crypto / Stocks as 20 px text tabs; sorting is a `.seg.soft`.
- **Token list**. A filter row: the Trending / Vol 24h / New / Liquidity `.seg.soft`, a Watchlist
  chip (`.pl-launch-watch-chip`, amber when on; stars are kept per browser by `useWatchlist` in `parts.jsx`), an "All
  assets" `FilterMenu` (the pair asset, `?asset=`), the Grid / Card / Table icon switch (`.pl-launch-views`, remembered
  per browser, key `place_launch_view`) and the search. Shared pieces in `parts.jsx`: `PairChip` (the pair logo and
  symbol, or "Base / PAIR" with the chain dot), `TaxBadge` (amber "Tax" for Economy tokens), `StarButton`,
  `CopyInline` (copy inside a clickable card), `McBar` (market cap on a $10K–$10M log scale). Cards and rows are
  `role="link"` blocks, so their inner buttons never open the page.
  - **Grid** (`.pl-launch-card` in `.pl-launch-grid`, 5/4/3/2 columns): square artwork with NEW / Tax badges, the
    name and $symbol with copy in `--on-image`; then market cap with "MC" and the scale bar, price and "Liq", Lifetime
    and Vol 24h, the pair chip and "23h ago".
  - **Cards** (`.pl-launch-rowcard` in `.pl-launch-rowcards`, 3/2/1 columns): "#01" in accent, "23H AGO" and the star
    on top; a 56 px logo with NEW / Tax, the $symbol at 20 px, the name with copy; Market cap at 24 px with "USD price /
    pair price"; on the right a vertical 10M–10K scale with an accent fill; Liquidity · Vol 24h / Lifetime (24 h in
    green) · Trades 24h; then "Base / PAIR", Tax or LP locked, and Trade (an accent pill, `.pl-launch-trade-btn`).
  - **Table** (`.pl-launch-list`): Token (logo, SYMBOL, name with copy; the pair and NEW / Tax under it), Market cap
    (with the bar), Created At, Liquidity, Volume 24h, Lifetime volume, Trades 24h, Price, then the star and Trade.
    Money cells show the pair amount under the USD value. A click on a header sorts (again reverses, a third time
    returns to the feed order). It scrolls sideways inside its card, the token column sticky on phones.
- **Tiny prices** keep their leading zeros counted: `$0.0₅3667` (`smallNumber` in `src/launch/format.js`).
- **Launch form** (`LaunchForm.jsx`, `EconomyFields.jsx`): three numbered steps (`.pl-launch-step`, a 30 px
  accent-soft number and a 22 px title): 01 Basics, 02 Economy, 03 Launch options. Options are cards with the switch
  on the left (`.pl-launch-option`). Economy: Standard or Economy cards; for Economy, buy and sell tax sliders (1–5%
  with a number box, `.pl-econ-range`, `.pl-econ-num`), then Tax allocation: a ring (`.pl-econ-ring`, 18 px arcs,
  the total and Reset in the middle) beside five bucket sliders whose track is hatched where other buckets hold the
  share, a "Fully allocated" badge, two cards splitting the buy and the sell tax in % of the trade, and the reward
  rules (minimum holding, minimum daily volume, reward token). The reward token is a pair-button that opens
  `RewardTokenPicker.jsx`, the pair picker's modal with Crypto / Stocks / Majors tabs, search and logos: the pair
  asset (default, no swap), "Your token" on top, and every token `launch/reward-tokens` lists a route to; an empty tab
  says a token appears once Place lists a route to it. Pickers render into `document.body` (a transformed page would
  carry a fixed overlay with it) with `.pw-theme` on the overlay and `.pw-card` on the modal. Bucket colours (`--c-*` on `.pl-econ` and the
  preview): creator `--accent`, holders `--green`, traders `--amber`, burn `--red`, community pool a mix of accent
  and green. On the right: a Live preview card (logo, name, TOKEN/PAIR, New, start price, launch cap, the allocation
  bar, badges) and a summary card with the launch button; both move under the form below 1180 px.
- **Token page** (`LaunchTokenPage.jsx`, little text): "All tokens", then the header: 56 px logo, the
  name (28 px), ticker, short address with copy; under it the pair chip with its logo, Tax (Economy tokens only), the
  standard (B20 or ERC20) and Immutable (green) or Editable; link pills on the right. The stat row (`.pl-launch-stats`,
  plain figures on the page, 7/4/2 columns): Market cap, Token price, Volume 24h, Pool liquidity (each with the pair
  amount under it), Total supply, Holders and, for Economy tokens only, Buy / sell tax. Then two columns: the chart,
  Info, the tabs card and Disclosures on the left; Swap on the right (under the chart below 1100 px).
  - **Chart** (`.pl-launch-chart-card`): toolbar (`.pl-launch-chart-toolbar`) with the interval select, USD / PAIR,
    MarketCap / Price (market cap = price × the supply the API counts) and fullscreen; under the chart the ranges
    3m / 1m / 5d / 1d (each picks the candle that fits) and a UTC clock. Drawn by our SVG `CandleChart` (no drawing
    tools, indicators or screenshots: those come with a licensed charting library).
  - **Info** (`.pl-launch-info`, plain): Creator (address, copy, link), Created (date and "(1d ago)") and, for tokens
    without economy, Trading fee; then Lifetime volume, Creator revenue and Protocol revenue with the pair amount.
  - **Tabs**: 22 px text titles (`.pl-launch-token-tabs`, the open one with a 2 px accent underline) in
    `.pl-launch-tabs-scroll`; `?tab=`. Economy token: Transactions · Holders · Economy · Burn · Holder rewards · Trader
    rewards (each only when its bucket is on) · Staking · NFT · Campaigns. Standard token: Transactions · Holders ·
    Economy · Staking · NFT · Campaigns (never Burn or rewards). Staking, NFT and Campaigns are always there and show an
    empty state when there is nothing ("No staking vaults yet", "No NFT collection yet", "No campaigns yet"). Transactions has an
    All / Buy / Sell filter beside its title and its columns: Time, Type, Price and Value (pair amount with "approx $"
    under it), Amount, Wallet.
  - **Swap** (`SwapPanel.jsx`): no tax text. The title with an (i) and, on the right, the gear with the current
    slippage; it opens **Trade settings** (`.pl-launch-swap-settings-panel`, a floating card over the swap): Max
    Slippage with Auto / Custom (`.seg`), 1% / 3% / 10% and a % box. Auto is 3% on the token pool, 5% through another
    pool; the value is what goes into minAmountOut. You pay / You receive boxes with the amount, its USD value, the
    asset chip and the balance; 20% / 50% / MAX on the pay side (MAX keeps a little ETH for gas); a flip button switches
    buy and sell. The pair-side chip is a button that opens **Select an asset** (`.pl-launch-swap-menu`): "Crypto and
    stablecoins" (ETH, USDC, another crypto pair) and "Paired stock" (logo, ticker, company). Another asset than the
    pair swaps in one multi-hop route through the pools the reward-token registry lists (`routeOf`); without one the
    menu marks it "No route" and the button says Route unavailable. Under the boxes: Max Slippage (Auto tag and %), then
    the folded Trade details (Minimum received, Trade fees, External pool fees, Network fees, Price impact, each with an
    (i)). Price impact is measured against a 1000× smaller trade on the same route: from -5% an amber alert, from -15%
    a red "Very high price impact (~X%). Try a smaller amount.", and from -50% the button is off. During the anti-snipe
    window an amber alert asks to wait a few seconds.
  - **InfoTip** (`InfoTip` in `components/ui`, `.info-tip` in `components.css`): a 13 px (i) after a label; on hover,
    focus or tap a 13 px bubble on `--surface` (max 280 px, rendered into `document.body`, kept inside the viewport)
    explains it in one or two sentences. Every stat (Market cap … Buy / sell tax), every Info figure and every swap row
    has one.
- **Token page tabs** (`TokenEconomy.jsx`, `TokenRewards.jsx`; body `.pl-launch-tab-body`): **Economy** (Economy
  token) — quiet figures (`.pl-launch-figures`): Buy tax and Sell tax with "Includes X% protocol",
  Anti-snipe window; "Split after protocol" with one sentence; the ring (`AllocationRing` with `center`: the tax after
  protocol, label "After protocol") beside a plain table (`.pl-launch-split-table`): Creator allocation, Holder
  rewards, Trader rewards, Burn allocation, Community Pool with Share, Buy tax and Sell tax. Nothing else.
  **Economy** (Standard token) — Trading fee and Anti-snipe window, then "Base fee split": Creator share and Platform
  share. 0.2.0 tokens use the Economy layout with their own buckets; 0.1.0 keeps its buyback list. **Burn** — Ready to
  burn, At the burn address, Burned with the button, Burn tokens and the list of burns. **Holder rewards / Trader
  rewards** — one status sentence (whether the wallet qualifies today, from
  `launch/rewards?token=` → `today`), a 2×2 plain grid (`.pl-launch-plain-grid`: Claimable rewards, Total earned,
  Minimum holding or Minimum daily volume, Rewards claimed), "Next payout in 07h 45m 03s at 00:00 UTC" and Claim
  rewards. **Staking**, **Campaigns** — hub cards (`HubCard`, 2/1 columns) with Create … and Open in Rewards hub.
  Campaigns are what goes beyond the token's own economy (`useTokenCampaigns`). **NFT** — a dashboard like the reward tabs:
  a compact head of the paired collection (44 px logo, name linking to `/collection/<addr>`, Minting / Official, Unique or
  Edition, Open collection; a `.seg.soft` picks between several, the official first), one sentence on NFT holder rewards,
  a 3-column plain grid (Rewards pool, Paid per day with per NFT, Accrued today, Your NFTs, You can claim), "Next epoch in
  … at 00:00 UTC", Claim rewards (`claim(ids)`) and Launch NFT. **Disclosures** (`.pl-launch-disclosures-block`, under the tabs, no card) — bold titles and short
  text as a two-column bulleted list, one column on phones. Creator announcements are not shown on the token page.
- **Bucket colours** outside the form: wrap in `.pl-econ-palette`. `AllocationBar` (`parts.jsx`) draws the shares as
  one bar with a legend (profile fee cards).
- **Profile** (`/profile/:section`, `CreatorConsole.jsx`): Launches, NFT launches, Fees, Rewards (the default) and
  Profile settings. Old sections redirect: `/profile/campaigns` → `/profile/launches`, `/profile/nfts` →
  `/profile/nft-launches` (`LEGACY_SECTIONS` in `src/launch/profileRewards.js`). **Launches**: token cards of the
  wallet's launches, then its one-off snapshot campaigns (`pages/place/MyCampaignsPage.jsx` with `embedded`: nothing
  while there are none). **NFT launches** (`ProfileNfts.jsx`): one `.pl-launch-reward-row` per collection it launched
  (logo, mint status, Unique / Edition, "Paired with TOKEN" linking to the token page, minted / supply and price), then
  NFTs you hold and the claim history. **Rewards** (`ProfileRewards.jsx`, logic in `src/launch/profileRewards.js`):
  Claim all in the head (one claimMany per rewards contract), the hub's type tabs (`.pl-rewards-types`: All · Staking ·
  Holders · Traders · NFT holders with counts; `?type=`), then groups of `.pl-launch-reward-row` rows: Staking (every
  vault the wallet is in, always, live first: pair logos, status and the end date in UTC, Earned and Staked in mono,
  Claim and Withdraw apart, "Unlocks …" while every lot is locked; on phones the two buttons share a full-width row),
  Holders, Traders and NFT holders (only what can be claimed now: distributor streams with Claim, and for NFT holders
  also the 30-day pools of collections, `claim(ids)`), then Campaign rewards (`pages/place/RewardsPage.jsx` with
  `only` and `quiet`: one-off payouts of snapshot campaigns, filtered by kind; hidden when there is nothing).
  Phones put the amounts on their own line. **Fees**: 0.3.0 tokens get `VaultPanelV3.jsx` — the allocation
  bar and three blocks: Creator revenue (Claim), Community Pool (Create campaign opens `.pl-launch-fund-form`: holder
  rewards, trader rewards or staking, amount, reward token, start, minimum, days, slippage, the quote and the ready
  transaction from `launch/fund-quote`; a 0.3.1 pool adds the NFT holders tab — collection select with the eligible
  official ones first and the rest disabled with the reason, share of the pool in % with 5/10/25% presets up to the
  25% cap, reward token, start, days, minimum NFTs, an amber alert during the 30-day cooldown — and Buyback & burn —
  share with 10/25/50/100% presets, slippage, tokens burned and burned so far; tabs show only when the pool supports
  them), Automatic campaign (date; Start it now when due), then the Pool log (`.pl-launch-pool-log`, last entries as
  `.pl-place-row` links to Basescan, amounts in mono). 0.2.0 tokens keep
  `VaultPanel.jsx` (your fees, burn with Run process(), community fund, raising shares); 0.1.0 the two-block card.
- **Rewards hub** (`/hub`, `HubPage.jsx`, shared pieces in `vaults.jsx`, styles in `styles/rewards.css` plus the
  `.pl-vaults-*` / `.pl-vault-*` / `.pl-filter-*` classes of `launch.css`): every reward on Place in the vault look. The
  head: the title with its description on one line, Launch NFT and Create vault / campaign (primary) on the right; four
  stat boxes (`.pl-rewards-stats`, 4/2 columns: Live now, Paid out per day, Tokens, You can claim with a link to
  Profile); type tabs (`.pl-rewards-types`, a `.seg.soft` in `.pl-launch-tabs-scroll`: All · Staking · Holders · Traders ·
  NFT holders, the number of live ones in a mono pill; `?type=`); a toolbar of filter pills (Reward currency, Token /
  Staking token / Collection, Phase, Source: Token economy · Creators and pools · Community · Tokens from other
  launchpads, Sort: Recommended, Most per day, Biggest pool, Highest APR, Newest, Ending soon) plus a Mine toggle, a
  search (ID, token or address) and a Cards / Table switch (remembered per browser); `?token=` starts filtered by a token.
  Cards (4/3/2/1 columns): target and reward logos overlapped, "Stake / Hold / Trade X · Earn Y" ("Hold X NFT" for
  collections), the ID with copy, status and an arrow, then a 2×2 grid of 11 px caps labels and 16 px mono values
  (staking: Live APR, TVL, Epochs, Early withdrawal; streams: Per day or Last day, Pool or Funded so far, Epochs N / M
  or N with "Every day, no end", Condition in 13 px; snapshot campaigns: Pool, Claimed, Snapshot, Claim until), then
  tags: the source (Token economy, Community Pool, Creator, Mint economy in accent; Community neutral), Launched on Place or Place
  collection, Snapshot, Not supported (amber), You can claim / You stake (green), You funded. The table
  (`.pl-rewards-row`, 7 columns, scrolls sideways inside its card) shows the same with the source under the name. A
  staking card opens `/staking?program=` (the vault page: stake form, position, claim, withdraw; `/staking` alone opens
  the Staking tab), a snapshot card its campaign page, a stream `/hub?stream=`.
- **Stream page** (`HubStreamDetail.jsx`): back link "All rewards", the vault head (40 px logos, 28 px title, ID, status,
  source and Place badges), an amber alert when Place does not build tables for the stream, 4 tiles (Per day, Pool,
  Shared so far, Next day closes in or Starts in; 15 px values on phones), the rule with "You can claim" and Claim beside
  a facts card (token, days in UTC, funded by, reward, contract); under Claim a live stream says "Rewards for today will
  be ready after 00:00 UTC" (`ReadyNote`). Then Unshared budget (Return to funder 30 days after the last day), the
  folded Advanced block with Close the day (Place closes days on its own) and the days table (`.pl-rewards-days-grid`:
  day, shared, wallets, table status with the IPFS link).
- **Create vault / campaign** (`/create`, `HubCreatePage.jsx`, logic in `src/launch/hubCreate.js`): one form for the
  four types, in the launch-form layout (numbered steps, a sticky right column, under the form below 1180 px). On top
  the type tabs (`.pl-rewards-types` as a radio group: Staking · Holders · Traders · NFT holders) and one sentence on
  the type. 01 Assets: the token or collection address, a block (`.pl-rewards-asset`) with the name, Token / NFT
  collection and Launched on Place / Place collection badges, Pay from (My wallet / Community Pool as a
  `.pl-rewards-choice`; the pool only for the token's creator, never for NFT rewards) and Reward currency: the
  pair-button that opens `RewardTokenPicker` (Crypto / Stocks / Majors; from a wallet: ETH, the launch pairs, the token
  itself and any ERC-20 pasted in the search, checked through `launch/hub/asset`; from the pool: `launch/reward-tokens`).
  02 Schedule: Start (00:00 UTC) and Number of days or epochs; staking adds Epoch duration (1d / 7d / 14d / 30d presets
  beside a days box), the reward as Pool or Per epoch, and Early withdrawal (Forbidden / With a penalty and its %); from
  the pool: Spend from the pool and Slippage. A `.pl-rewards-split` block shows per day (pool ÷ days) or per epoch.
  03 Criteria: minimum balance, minimum daily volume in the pair asset or minimum NFTs; staking says anyone can stake.
  Number boxes carry their unit (`.pl-launch-prefixed.suffix`). On the right: Preview (`.pl-rewards-preview`: pair
  logos, "Stake / Hold / Trade X · Earn Y", starts, ends, epochs, per day or epoch, condition, early withdrawal) and
  Funding summary (paid from, reward budget, Place fee on top with its %, Total, your balance, the button), an info
  alert on how it pays out and, for NFT rewards, an amber alert linking to Launch NFT. `?type=` and `?token=` fill the
  form; a created stream or vault opens right away.
- **Launch NFT** (`/launch/nft`, `LaunchNftPage.jsx`, logic in `src/launch/nft.js`, styles `styles/collections.css`,
  `.pl-collection-*`): the launch-form layout with four steps. 01 Basics: logo, name, symbol, description, Unique or Edition
  (kind cards), supply, max per wallet, then the files: Unique uploads one image per NFT (thumbnails numbered by file
  name, Upload to IPFS sends the images in folders of up to ~2.8 MB and every NFT's metadata JSON as one folder) or
  points to a metadata folder of its own; Edition takes one image or a link; mint opens / closes in UTC. 02 Pair token:
  `NftTokenPicker.jsx` (the pair picker's modal: Crypto / Stocks / Majors, search, Launched on Place badges; a pasted
  address is checked, and a token without a swap route gets the reason and Register token). 03 Mint: price in ETH and
  the "Also accept TOKEN" option with today's equivalent. 04 Economy: Place 20% fixed, the ring (`AllocationRing` with
  four arcs, Place in `--text-3` via `.platform`) beside three bucket sliders (Creator `--accent`, NFT holders
  `--green`, Buyback & burn `--red`), "Each mint at X ETH" in ETH and %, the holders' reward token (pair token by
  default, ETH or a routed token), royalty 0–10% and the 30-day pool in plain words. On the right: Live preview (first
  NFT image or logo, price, supply, reward token, royalty, allocation bar) and the summary with Launch collection. Before
  the NFT launchpad is deployed an info alert says it is coming and the button says when launching opens. After the
  launch the collection page opens.
- **Collection page** (`/collection/:address`, `CollectionPage.jsx`, pieces in `CollectionParts.jsx`): back to Projects,
  the head (logo, name, symbol, Official with a check, Unique / Edition, Paired with TOKEN), 3 tiles (Minted, Mint
  revenue, Burned), then the main column (gallery 4/3/2 columns of NFT images from their metadata or the edition image,
  Economy ring and table, Holders pool tiles: in the pool, every day and per NFT, accrued today, pays until; Holders;
  Mints; Economy log) and the side column (Mint card: status, progress, price in ETH and the pair token, quantity,
  ETH / TOKEN switch, Mint; Your NFTs with You can claim, Claim and "Rewards for today will be ready after 00:00
  UTC"; the folded "Advanced: keep it running" block (Share royalties after the sell-out, Burn waiting ETH, Pay out:
  the keeper runs them); Details). Rows that open Basescan use `.pl-collection-rows`. Before the deploy
  the page shows the "coming soon" empty state (`NftNotLive`).
- **Collection card** (`CollectionCard`): the dashboard card with the collection logo, status (Minting / Upcoming /
  Sold out / Ended) and Official badges, the mint price, a progress bar of minted / supply, holders and pool per day,
  SYMBOL / PAIR and Unique or Edition. Used in Projects (Collections), project pages, the profile and nowhere else.
- **Projects** (`/projects`, `ProjectsPage.jsx`, `.pl-projects-*`): the head with Register token and Launch token
  (primary); a toolbar with the search and three `.seg.soft` filters (All / Economy / Standard, All / Crypto / Stocks,
  Market cap / Newest / Most campaigns); then token cards in `.pl-launch-grid` (the dashboard card: artwork with an
  Economy or Standard badge and the release for tokens older than 0.3.0, market cap, live and upcoming campaigns
  (streams, staking, snapshot campaigns) and holders, Tax X% / Y% and Rewards tags, TOKEN / PAIR). A card opens the
  project page (`/token/:address`, `pages/place/TokenPage.jsx`): back to Projects, head and tiles, Rewards and
  staking (hub cards for this token, Open in Rewards), Campaigns, Who created them and Collections (collection cards of
  this pair token, the official one first, Launch NFT on the right). A Tokens / Collections `.seg.soft` above the toolbar
  switches Projects to collection cards (`?view=collections`: search, All / Official / Paying holders, Newest / Most
  minted / Biggest pool). Verified registered tokens join the token cards with a Registered badge and their liquidity.
  **Register token** (`/projects/register`, `RegisterTokenPage.jsx`, `?token=`): the three steps, the token address,
  then checks with a green / amber / red icon (`.pl-projects-check`: owner() or admin() and this wallet, liquidity
  against $10K), the registration status (Verified project, In review, Not accepted), Sign and register (a signed
  message, no transaction) and an info alert on what stays with Place (swap routes, the onchain Official badge).
- **Stocks** (`/stocks`, `StocksPage.jsx`, `.pl-stocks-*`): every Coinbase tokenized stock on Base, from
  `GET launch/stocks`. A hero card (`--r-xl`): 56 px title, one sentence, a stat block (Paired tokens and Onchain
  liquidity large; Listed stocks, Launch ready, Liquidity ≥ $10K small) and a cloud of stock logos on the right
  (hidden below 1024 px). Then Categories (7/5/3/2 columns, three overlapped logos, name, count; a click filters the
  list) and All stocks: filter pills with counts, sort (Liquidity, Price, A–Z), search, cards or a list. A stock card:
  logo, ticker and company, rank by liquidity, price (24 px mono) and shares, liquidity, a 4 px accent bar on a log
  scale, the number of Place tokens paired with it and "Launch with TICKER" (primary when the stock is a launch pair
  on this network, otherwise disabled). Categories are set by ticker in `src/launch/stockCategories.js`.
- Don't use `<section>` inside a page: an old global rule gives it 100 px padding. Use a `div`.
- **Profile menu**: a side menu (`.pl-launch-console-nav`, a pill row below 1100 px) with Launches, NFT launches, Fees,
  Rewards and Profile settings. Saving the profile signs a message (no transaction).
- **Advanced** (`Advanced` in `src/launch/ui/parts.jsx`, `.pl-launch-advanced`): a folded `<details>` card for manual
  fallbacks of what Place runs on its own (Close the day, Keep it running). The summary is 13 px, 600, `--text-2`
  with a settings icon and a chevron; the body opens with one sentence saying it happens automatically. The main
  state instead is `ReadyNote` (`.pl-launch-ready-note`: a clock in `--accent` and "Rewards for today will be ready
  after 00:00 UTC").

### Modals

| Type | Classes | Width | Enter animation |
|---|---|---|---|
| Form or confirmation | `.pw-modal-overlay`, `.pw-modal` | 440 px | `pw-pop`, 0.18 s |
| Share after a claim | `.pl-share-modal-overlay`, `.pl-share-modal-card` | 440 px | None |
| Celebration after a mint | `.pl-nft-modal-overlay`, `.pl-nft-modal-content` | 400 px | `pl-mint-card-in`, 0.32 s |

The overlay is fixed, centres its card, has 16–20 px padding and a dark blurred backdrop. The close button sits
top-right, 28 px. A modal must scroll on small screens.

### Transaction states

Each on-chain action goes through: idle → waiting for the wallet → pending (spinner on the button) → success (a Basescan
link) or error (a short message in plain words). Rejecting in the wallet is not an error, so return to idle quietly. The exception is the Claim Portal: the wallet doesn't
always tell a rejection from a failure, so its claim buttons show "Claim was cancelled or failed" for both.

### Connect wallet

Pages stay readable when logged out. Show "Connect wallet to verify", "Not connected" or "Log in to see your wallet" in
place of personal data, and keep the public numbers visible.

---

## 9. Motion

| What | Duration | Easing |
|---|---|---|
| Hover and colour changes | 0.15 s | `ease` |
| Button press | 0.05 s | `ease` |
| Menu sheet entrance | 0.18 s | `cubic-bezier(0.16, 1, 0.3, 1)` |
| Progress fill | 0.3 s | `ease` |
| Modal entrance | 0.18–0.32 s | `cubic-bezier(0.16, 1, 0.3, 1)` |

**In general:** UI feedback takes 120–240 ms. Animate `transform`, `opacity` and colours only. No motion blur, no 3D, no
bounce. Decorative loops belong only to the Agent Zone hero.

**`prefers-reduced-motion` is always respected.** The base styles cut transitions and animations to almost nothing,
and Based turns its own animations off.

**Based only**, all using `--ease` (`cubic-bezier(0.4, 0, 0.2, 1)`):
- Pages slide up 10 px in 240 ms (`based-slide-in`).
- Page titles reveal with a Base Blue square wipe in 560 ms (`based-reveal`, `based-wipe`).
- The background texture drifts slowly over 48 s (`based-drift`).

---

## 10. Icons and images

**Icons:** [lucide-react](https://lucide.dev) only, with `strokeWidth={1.75}` in navigation.

| Where | Size |
|---|---|
| Inline in a tile, badge or small button | 12–14 px |
| Buttons and rows | 15–16 px |
| Top bar sections, menus | 16 px; 18 px in the menu sheet |
| Mobile menu button | 20 px |

Icons take a colour from their text or a token.

**Images** live in `public/`.

| Asset | Path | Shape |
|---|---|---|
| Logo | `/logo.svg` in the UI, `/logo.png` (512) for wallets and links | A ring with a dot in `--accent` on `--bg-bar`; drawn by `scripts/makeLogo.mjs` |
| Site icons | `/favicon.ico`, `/icon-192.png`, `/apple-touch-icon.png` | Made from the logo by the same script |
| Link preview card | `/placeholders/og.png` (placeholder) | 1200×630, Dark look |
| Campaign banners | the `image` in the campaign metadata (IPFS), else `/placeholders/banner.png` | 16:9, `object-fit: cover` |
| Partner logos | `/brands/*` | Square |

Images that sit on a colour need their own rounded frame. A white logo that needs ink on a light tile gets a scoped
filter in `based.css`.

**Based background:** fine vertical gray lines and dot-matrix clusters in the free space of the page, fixed to the
viewport, on `.base-app-shell`. It is weaker on mobile. The docs go without it, because their long text sits right on the page. Don't add other page backgrounds.

**Glows** are Dark only. Based stays flat, and `based.css` removes them.

---

## 11. Copy

- **Language:** English, in sentence case ("Claim Portal" and "Agent Zone" are names and keep their capitals).
- **Tokens:** the symbol after the amount, as the token names itself: `10,000,000 USDC`. Numbers use commas. Compact
  forms are fine in tight spots: `31.50M`.
- **ETH:** as `0.005 ETH`, gas as `~0.0001 ETH`.
- **Dates:** `25 Oct, 00:00 UTC`. Always show UTC for rounds, snapshots and claim windows.
- **Countdowns:** `19d 01h 04m 01s`, in mono.
- **Addresses:** in full where people copy them, and short as `0x9E92...b886` elsewhere.
- **Name:** Place. Slogan: "All in one place". The domain is not chosen yet, so copy does not name one.
- **Page descriptions:** one factual sentence with no full stop: "Personal reward allocations, active claims, and
  distribution history".
- **Buttons:** verb first: "Go to Claim Portal", "View rules", "Connect wallet".
- **Names to keep:** Place, Dashboard, Stocks, Profile, Rewards, Projects, Campaigns, My rewards, My launches, Create, Claim all,
  Agent Zone, Launchpad, Launch token, Register token, Launched on Place.

---

## 12. Files

| File | What it holds |
|---|---|
| `src/theme.js` | Theme list, fonts, how the theme is chosen |
| `src/themes/place/styles/tokens.css` | All tokens (Dark values), base type, focus, scrollbars |
| `src/themes/place/styles/based.css` | Based tokens, texture and motion |
| `src/themes/place/styles/components.css` | Buttons, cards, tiles, badges, segmented control, header, alerts, empty state |
| `src/themes/place/components/ui/index.jsx` | The React components for the above |
| `src/themes/place/styles/place.css` | Place pages and shell pieces (`pl-place-*`) |
| `src/themes/place/styles/launch.css` | Place Launch pages (`pl-launch-*`), vault cards and filter pills (`pl-vault-*`, `pl-filter-*`) |
| `src/themes/place/styles/rewards.css` | Rewards hub, Create vault / campaign (`pl-rewards-*`) |
| `src/themes/place/styles/collections.css` | Launch NFT, collection page and cards, Place's share colour (`pl-collection-*`, `.platform`) |
| `src/launch/ui/` | The Place Launch pages: dashboard, launch form, token page, creator console, the Rewards hub (`HubPage`, `HubStreamDetail`, `HubCreatePage`, `vaults.jsx`) and Launch NFT |
| `src/themes/place/styles/{hub,claim,swap,docs}.css` | Shared card and table patterns, Swap, Docs |
| `src/themes/place/pages/place/` | The Place pages |
| `src/themes/place/pages/docs/` | Docs at `/docs`: shell (`DocsPage.jsx`), blocks (`kit.jsx`), content by menu group (`pages/`, a coming-soon page for now) |
| `src/themes/place/components/BaseApp{View,TopNav}.jsx` | App shell: pages, top bar, sections |
| `src/components/wallet/WalletPages.css` | Wallet, Account, Settings, forms, modals (`pw-*`) |
| `src/components/agent/AgentsPage.css`, `SkillPage.css` | Agent Zone and Skill (`agp-*`, `skp-*`) |

**New CSS goes** into the stylesheet of its page, or `components.css` if it is reused. Don't add to
`BaseAppTheme.css` or `src/themes/place/index.css`: they hold older layers.

---

## 13. Checklist

Before shipping a UI change, check that:

- [ ] It looks right in both themes: `?theme=dark` and `?theme=based`.
- [ ] It works at desktop width and at 375 px, with no sideways scrolling.
- [ ] Nothing is hidden behind the top bar or the menu sheet.
- [ ] There are no hard-coded colours, and only tokens from this file.
- [ ] It reuses existing components.
- [ ] Hover, focus, disabled, loading, empty and error states exist.
- [ ] It works logged out as well as logged in.
- [ ] Numbers are mono, dates are in UTC, and the copy follows section 11.
- [ ] This file is updated if the design changed on purpose.
