# M/M/1 Queue Simulator

Browser-based visualization of an M/M/1 queue: Poisson arrivals with rate `λ`, exponential service with rate `μ`, one server, first-come-first-served discipline, and an unbounded waiting room.

The project is designed as a teaching and exploration tool. It combines a discrete-event simulation engine with live visualizations, side-by-side theory comparisons, and a few interactive controls that make queueing behavior easy to inspect in real time.

## Purpose

This repository helps developers and readers:

- run and inspect an interactive M/M/1 simulation in the browser
- compare empirical behavior against closed-form steady-state theory
- explore transient behavior from an empty initial condition
- stress the queue manually with forced arrivals and departures
- understand how implementation choices map to queueing concepts

The app is especially useful when you want to explain:

- why `ρ = λ / μ` governs stability
- how queue length and waiting time grow as `ρ` approaches `1`
- how empirical occupancy converges toward steady-state probabilities
- how short-term manual shocks differ from changing the underlying model parameters

## Quick Start

This project is static HTML, CSS, and JavaScript. There is no build step.

### Requirements

- Node.js installed locally if you want to use the recommended local server

### Run locally

```bash
npx serve .
```

Then open:

```text
http://localhost:3000
```

You can also open `index.html` directly with `file://`, but using a local server is the preferred setup for normal development and review.

## Project Structure

| File | Responsibility |
|---|---|
| `index.html` | Application structure, controls, metrics table, canvas containers, and labels |
| `styles.css` | Layout, theming, control styling, charts/panel presentation, and responsive behavior |
| `app.js` | Simulation state, event processing, rendering, chart drawing, metrics computation, and UI wiring |

## What The Application Does

At runtime, the app maintains a simulation clock and schedules two event types:

- arrival
- departure

Inter-arrival and service times are sampled from exponential distributions using inverse-CDF sampling. The simulation advances in discrete events while the browser animation loop maps real time into simulated time according to the selected speed.

The app exposes both:

- theoretical values derived from the configured `λ` and `μ`
- empirical values measured from the simulated sample path

That combination lets a developer inspect where theory and observed behavior align, and where they diverge because of short runs, transient effects, or manual interventions.

## Setup And Development Notes

### No bundler or framework

This codebase intentionally stays simple:

- no package-managed frontend framework
- no transpilation
- no build output directory
- no client-side state library

That makes the repo easy to read, modify, and demo. Changes to `index.html`, `styles.css`, and `app.js` can be tested immediately by reloading the page.

### Recommended workflow

1. Start a local static server.
2. Open the app in a browser.
3. Make focused edits in one of the three source files.
4. Reload and verify the affected controls, metrics, or charts.

## UI Overview

### Top-level controls

The controls panel provides:

- **Arrival rate `λ`**: slider from `0.05` to `3.00` arrivals per simulated second
- **Service rate `μ`**: slider from `0.05` to `3.00` services per simulated second
- **Simulation speed**: logarithmic control from `0.1×` to `200×` real time
- **Theme toggle**: switch between dark and light presentation modes
- **Play / Pause**: start or pause continuous simulation
- **Step (1 event)**: process exactly one next event
- **Force arrivals**: inject a user-selected batch of customers at the current simulation time
- **Force departure**: complete the currently served customer immediately
- **Reset**: restore the simulation to its initial empty state

### Forced batch arrivals

The **Forced arrivals at once** input lets the user choose any positive integer batch size. Clicking **Force arrivals** inserts that many customers at the current simulation time.

This feature is intentionally a manual intervention tool, not a rewrite of the underlying arrival process. It changes the realized sample path and empirical metrics, but it does not change the model parameter `λ`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `s` | Step one event |
| `a` | Force arrivals using the current batch-size input |
| `d` | Force departure |
| `r` | Reset |

## Metrics And Visualizations

### Stability banner

Shows whether the configured queue is:

- comfortably stable
- in heavy traffic
- unstable

This is based on `ρ = λ / μ`.

### Queue visualization

Shows:

- the customer currently in service
- the waiting line
- the current state `X(t)` and waiting count

### Metrics table

The metrics panel compares empirical and theoretical values for:

- traffic intensity `ρ`
- realized arrival rate `λ̂`
- mean number in system `L`
- mean number in queue `L_q`
- mean sojourn time `W`
- mean wait `W_q`
- idle probability `π₀`

It also shows counters for:

- simulation time
- arrivals
- departures
- current number in system `X(t)`

#### Important distinction: theory vs realized behavior

The table intentionally distinguishes between:

- **theory**, computed from the configured M/M/1 parameters
- **empirical values**, computed from the actual simulated history

This matters because manual interventions can move the empirical path away from nominal theory.

Example:

- if the user forces `20` arrivals at once, the queue can spike sharply
- the theoretical `λ` and `ρ` still reflect the slider settings
- the realized arrival rate `λ̂` and other empirical metrics reflect what actually happened in the run

### Queue length chart

The rolling `X(t)` chart plots queue length over simulated time and overlays the theoretical steady-state mean `L = ρ / (1 - ρ)` when `ρ < 1`.

### State distribution chart

The `π_k` panel compares:

- empirical occupancy frequencies accumulated from the run
- theoretical steady-state probabilities `(1 - ρ)ρ^k`

### Transient distribution chart

The `P_k(t)` panel shows the time-`t` distribution starting from an empty queue. This is distinct from long-run occupancy:

- `P_k(t)` describes the process at one specific time
- `π_k` describes steady-state occupancy over long-run time averages

### Burke panel

The departure inter-arrival chart compares the observed departure-gap histogram against the predicted `Exp(λ)` density. It serves as a visual check of Burke’s theorem in the stable regime.

### Event log

Shows the most recent arrival and departure activity, including manual burst injections.

## Simulation Model

### Core state

The simulator tracks:

- current simulation time
- current system size `N`
- scheduled next arrival time
- scheduled next departure time
- queue contents
- customer in service
- aggregate counters and statistics

### Event processing

The simulation advances through two handlers:

- arrival processing
- departure processing

Each event:

- advances the simulation clock
- updates occupancy and customer state
- updates cumulative statistics
- records chart/history data

### Empirical statistics

Empirical occupancy statistics are time-averaged, not event-averaged. The code accumulates total simulated time spent in each state `k`, then derives:

- empirical `π_k`
- empirical `L`
- empirical `L_q`
- empirical busy fraction / idle fraction

Customer-level timing aggregates are used for:

- empirical `W`
- empirical `W_q`

### Realized arrival rate

The empirical `λ̂` metric is computed as:

```text
total arrivals / elapsed simulated time
```

This is included specifically so manual forced-arrival bursts are visible in the dashboard, even though the theoretical `λ` slider value remains unchanged.

## Modeling Choices And Assumptions

### Memoryless parameter updates

When `λ` changes, the next scheduled arrival is re-sampled from the current simulation time. When `μ` changes while a customer is in service, the remaining service completion is also re-sampled from the current simulation time.

This is a deliberate use of the memoryless property of the exponential distribution.

### Manual bursts are not parameter changes

Forced arrivals and forced departures are user interventions layered on top of the M/M/1 simulator. They are useful for demonstrations, but they mean the observed path is not always a pure untouched sample from the configured stationary model.

That is expected behavior.

### Stability interpretation

The theoretical formulas shown in the UI assume:

- an M/M/1 queue
- stationary conditions when `ρ < 1`
- no reinterpretation of manual bursts as a change in `λ`

If you want scheduled bulk arrivals to be part of the model itself, that would require a different queueing model and different formulas.

## Rendering And Performance Notes

- The app uses canvas-based rendering for the queue and charts.
- Canvas dimensions are scaled by `devicePixelRatio` for sharper rendering on high-DPI displays.
- The simulation loop includes a per-frame safety cap to avoid lock-ups at very high speeds or rates.
- Theme preference is stored locally so the selected light/dark mode persists across reloads.

## How To Extend The Project

Common extension points for new developers:

- add new derived metrics in `renderStats()`
- add new manual controls in `index.html` and wire them in `app.js`
- refine layout and responsive behavior in `styles.css`
- add new charts by following the existing canvas rendering pattern
- evolve the simulation toward another queueing model if you need different theoretical assumptions

If you change the mathematical model, update both:

- the simulation event logic
- the theory/tooltip/documentation text

That keeps the UI honest about what is being simulated versus what is merely being visualized.

## Suggested Exploration Scenarios

- Set `ρ` close to `1` and watch congestion build slowly but persistently.
- Set `λ > μ` and observe the unstable regime where no steady-state distribution exists.
- Force a burst of `4`, `10`, or `25` arrivals and compare `λ̂`, `L`, and `L_q` against the theoretical column.
- Let a stable configuration run for a long time and compare empirical `π_k` against the geometric steady-state distribution.
- Watch the Burke panel converge as more departures are observed.

## Related Material

This simulator was built as a companion to the paper `../paper.pdf`, *From Poisson Arrivals to Kendall Models*.
