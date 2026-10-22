import { useEffect, useState, type ReactNode } from "react";
import { readDockCollapsed, writeDockCollapsed, type Workspace } from "./workspace";

type DockProps = {
  id: string;
  title: string;
  workspace: Workspace;
  children: ReactNode;
  actions?: ReactNode;
  /** 中栏主监视器不折叠。 */
  collapsible?: boolean;
  className?: string;
};

export function Dock({ id, title, workspace, children, actions, collapsible = true, className }: DockProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const storage = typeof window === "undefined" ? null : window.localStorage;
    setCollapsed(readDockCollapsed(storage, workspace, id));
  }, [workspace, id]);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    writeDockCollapsed(typeof window === "undefined" ? null : window.localStorage, workspace, id, next);
  }

  const classes = ["dock", className, collapsed ? "collapsed" : ""].filter(Boolean).join(" ");

  if (collapsed) {
    return (
      <section className={classes} aria-label={title}>
        <button type="button" className="dock-expand" title={`展开${title}`} onClick={toggle}>
          <span className="chevron chevron-right" aria-hidden="true" />
          <span className="dock-rail-label">{title}</span>
        </button>
      </section>
    );
  }

  return (
    <section className={classes} aria-label={title}>
      <header className="dock-head">
        <h2>
          {collapsible ? (
            <button
              type="button"
              className="dock-toggle"
              title={`折叠${title}`}
              aria-expanded="true"
              onClick={toggle}
            >
              <span className="chevron" aria-hidden="true" />
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        <div className="dock-head-actions">{actions}</div>
      </header>
      <div className="dock-body">{children}</div>
    </section>
  );
}
