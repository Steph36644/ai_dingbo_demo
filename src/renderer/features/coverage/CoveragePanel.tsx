import type { FrameworkLoadResult } from "@shared/contracts/framework";
import type { CoverageItem } from "@shared/contracts/issue";
import { COVERAGE_DISTINCTION, coverageEmptyKind, coverageEmptyMessage } from "@shared/issues/coverageCopy";
import { formatClock } from "../monitor/format";

export function CoveragePanel({ items, framework }: { items: CoverageItem[]; framework: FrameworkLoadResult | null }) {
  const mustSayCount = framework?.ok ? framework.document.must_say.length : 0;
  const empty = coverageEmptyKind({
    frameworkReady: framework ? framework.ok : null,
    mustSayCount,
    itemCount: items.length,
  });
  const covered = items.filter((item) => item.covered).length;
  return (
    <section className="coverage" aria-label="本场累计必讲">
      <header className="panel-head">
        <h2>本场累计</h2>
        <strong>
          {covered}/{items.length || mustSayCount}
        </strong>
      </header>
      <p className="analysis-meta">{COVERAGE_DISTINCTION}</p>
      {empty ? <p className="empty-dark">{coverageEmptyMessage(empty)}</p> : null}
      <ul className="coverage-list">
        {items.map((item) => (
          <li key={item.frameworkItemId} className={item.covered ? "done" : "todo"}>
            <input type="checkbox" checked={item.covered} readOnly disabled aria-label={item.covered ? `${item.text}，本场已讲` : `${item.text}，本场未讲`} />
            <div>
              <strong>{item.text}</strong>
              <small>
                {item.covered
                  ? `本场已讲${item.firstCoveredAtMs != null ? ` · ${formatClock(item.firstCoveredAtMs)}` : ""} · ${item.matchedSegmentIds.length} 段`
                  : "本场未讲"}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
