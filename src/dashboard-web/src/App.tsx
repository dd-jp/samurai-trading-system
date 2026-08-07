import './App.css';

/**
 * Room numbers/names from dashboard-spec.md, "Pipeline theater": seven
 * pipeline stages plus the Lobby (idle lanes), laid out as a 4x2 grid.
 * Room 04 (`invalidation`) is drawn lights-off because the stage is specced
 * and not built yet (spec: "Layout", "Rooms hero").
 */
const ROOMS = [
  { id: 'lobby', number: null, name: 'Lobby', lightsOff: false },
  { id: 'analysts', number: '01', name: 'Analysts', lightsOff: false },
  { id: 'debate', number: '02', name: 'Debate', lightsOff: false },
  { id: 'trader', number: '03', name: 'Trader', lightsOff: false },
  { id: 'invalidation', number: '04', name: 'Invalidation', lightsOff: true },
  { id: 'risk', number: '05', name: 'Risk', lightsOff: false },
  { id: 'verdict', number: '06', name: 'Verdict', lightsOff: false },
  { id: 'execution', number: '07', name: 'Execution', lightsOff: false },
] as const;

/**
 * Bento panel placeholders — dashboard-spec.md, "Layout", section 4. Every
 * datum in this list has a home in the Information Inventory table; none of
 * these render real data yet (that's later tickets under wayfinder map
 * #533). This is the WorldMonitor deferred-shell contract applied to the
 * bottom-of-screen grid: the panel slots exist from first paint so a poll
 * never changes the page's geometry.
 */
const BENTO_PANELS = [
  { id: 'positions', title: 'Positions' },
  { id: 'metrics', title: 'Metrics suite' },
  { id: 'analysts', title: 'Analysts' },
  { id: 'llm-spend', title: 'LLM spend' },
  { id: 'recent-debates', title: 'Recent debates' },
] as const;

/**
 * Static shell for the v2 mission-control screen (dashboard-spec.md,
 * "Layout"). This ticket (#536) scaffolds structure and tokens only — no
 * data fetching, no `/api/snapshot` polling, no motion. Those land in
 * later tickets under wayfinder map #533; this component's job is proving
 * the Vite+React build and test wiring, and giving every later panel a
 * reserved place to render into.
 */
export function App() {
  return (
    <div className="app">
      {/*
        `<section aria-label>`, matching the other three top-level regions
        below, rather than `<header>`: Biome's static a11y check assigns
        `<header>` here a conservative implicit `generic` role (it cannot
        prove this isn't nested inside sectioning content) and then rejects
        `aria-label` as unsupported by that role. A labelled `<section>`
        gets an unambiguous `region` role, which does support `aria-label`.
      */}
      <section className="telemetry-strip" aria-label="Telemetry">
        <div className="telemetry-cell" data-field="mode">
          <span className="telemetry-label">Mode</span>
          <span className="telemetry-value">—</span>
        </div>
        <div className="telemetry-cell" data-field="live-tick">
          <span className="telemetry-label">Live tick</span>
          <span className="telemetry-value">idle</span>
        </div>
        <div className="telemetry-cell" data-field="burn-meter">
          <span className="telemetry-label">LLM burn</span>
          <span className="telemetry-value">—</span>
        </div>
        <div className="telemetry-cell" data-field="alpaca-balance">
          <span className="telemetry-label">Alpaca</span>
          <span className="telemetry-value">—</span>
        </div>
        <div className="telemetry-cell" data-field="polygon">
          <span className="telemetry-label">Polygon</span>
          <span className="telemetry-value">—</span>
        </div>
        <div className="telemetry-cell" data-field="snapshot-clock">
          <span className="telemetry-label">Snapshot</span>
          <span className="telemetry-value">—</span>
        </div>
      </section>

      <main>
        <section className="rooms-hero" aria-label="Pipeline rooms">
          {ROOMS.map((room) => (
            <div
              key={room.id}
              className={room.lightsOff ? 'room room-lights-off' : 'room'}
              data-room={room.id}
            >
              <div className="room-heading">
                {room.number !== null && <span className="room-number">{room.number}</span>}
                <h2 className="room-name">{room.name}</h2>
              </div>
              {room.lightsOff && (
                <p className="room-note">Specced and not built — devils-advocate-spec.md</p>
              )}
              <div className="room-occupants" />
            </div>
          ))}
        </section>

        <section className="verdict-ledger" aria-label="Verdict ledger">
          <h2>Verdict ledger</h2>
          <div className="ledger-body" />
        </section>

        <section className="bento" aria-label="Panels">
          {BENTO_PANELS.map((panel) => (
            <div key={panel.id} className="bento-panel" data-panel={panel.id}>
              <h2>{panel.title}</h2>
              <div className="bento-body" />
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
