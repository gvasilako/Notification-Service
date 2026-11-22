import { useEffect, useState } from "react";

// Just enough routing for two pages, on top of the History API. nginx serves
// index.html for unknown paths, so deep links like /orders/abc work on reload.

export function navigate(to) {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange); // back/forward and navigate()
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function Link({ to, children, ...props }) {
  const onClick = (e) => {
    // Let the browser handle ctrl/cmd/shift-click (new tab or window).
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} {...props}>
      {children}
    </a>
  );
}
