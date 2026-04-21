# M/M/1 Queue Simulator

Interactive, browser-based visualization of the M/M/1 queue — Poisson arrivals (rate λ), exponential service (rate μ), single server, FCFS, infinite buffer. Built as a companion to the paper *From Poisson Arrivals to Kendall Models* (`../paper.pdf`).

## Run it

No build step — any static server works.

```bash
npx serve .
# then open http://localhost:3000
```

Or just open `index.html` directly in a browser (`file://`).

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup and panel layout |
| `styles.css` | All styling (design tokens, panels, canvas sizing, responsive grid) |
| `app.js` | Discrete-event simulation engine, rendering, and UI wiring |

## What it does

A discrete-event simulator with two event types (arrival, departure) scheduled via inverse-CDF exponential sampling (`-ln(U)/rate`). Real time advances the sim clock by `speed × realDt`; events are processed in chronological order.

### Controls

- **λ** (arrival rate) and **μ** (service rate) — sliders, `0.05`–`3.00` per sim-second
- **Speed** — logarithmic, `0.1×`–`200×` real-time
- **Play / Pause**, **Step** (one event), **Force arrival**, **Force departure**, **Reset**

### Live panels

- **Stability banner** — green / amber / red depending on ρ (`<0.85` / `<1` / `≥1`)
- **Queue visualization** — live server (busy = blue with customer id, idle = gray) and waiting-line
- **Metrics table** — empirical (time-averaged) vs closed-form theory for ρ, L, L_q, W, W_q, π₀
- **Queue length X(t)** — rolling-window step plot with theoretical L = ρ/(1−ρ) reference line
- **State distribution π_k** — empirical bars vs theoretical (1−ρ)ρᵏ markers
- **Burke's theorem panel** — histogram of observed inter-departure times overlaid with the predicted Exp(λ) pdf
- **Event log** — last 100 arrivals/departures

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `s` | Step one event |
| `a` | Force arrival |
| `d` | Force departure |
| `r` | Reset |

## Implementation notes

- **Memoryless updates:** changing λ or μ mid-run re-samples the next event from the current moment. Equivalent by the lack-of-memory property of the exponential distribution; no state corruption.
- **Time-averaged statistics:** `timeInState[k]` accumulates sojourn time in state `k`; empirical π_k = `timeInState[k] / Σ timeInState`.
- **Per-frame safety cap:** `advanceTo` breaks out after 10,000 events per frame to prevent lock-up at very high rates/speeds.
- **Canvas DPR-aware:** `fitCanvas` scales by `devicePixelRatio` for crisp rendering on hi-DPI displays.

## Things to try

- Set ρ ≈ 0.95 — watch the queue grow violently and empirical L approach the theoretical line slowly.
- Set λ > μ — stability banner turns red, queue diverges linearly.
- Leave it running at high speed for a minute — the Burke histogram converges tightly onto the Exp(λ) curve, confirming that the departure process is Poisson(λ).
- Compare empirical π_k to theoretical (1−ρ)ρᵏ at different ρ — the geometric decay is visibly steeper at low ρ.
