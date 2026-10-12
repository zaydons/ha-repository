// @ts-check
// WS0 placeholder UI: proves vendor modules, relative URLs and the stub API
// work under the ingress prefix. WS5 replaces this file.
import { h, render } from "../vendor/preact.mjs";
import { useEffect, useState } from "../vendor/hooks.mjs";
import htm from "../vendor/htm.mjs";

const html = htm.bind(h);

function App() {
  const [config, setConfig] = useState(/** @type {any} */ (null));
  const [state, setState] = useState(/** @type {any} */ (null));
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("api/config").then((r) => r.json()).then(setConfig, (e) => setError(String(e)));
    const poll = () => fetch("api/state").then((r) => r.json()).then(setState, (e) => setError(String(e)));
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  if (error) return html`<p>Error: ${error}</p>`;
  if (!config) return html`<p>Loading…</p>`;
  return html`
    <h1>${config.title}</h1>
    <p>Stub UI (rev ${config.rev}, ${config.groups.length} groups, config folder ${config.configPath})</p>
    <pre>${JSON.stringify(state, null, 2)}</pre>`;
}

const root = document.getElementById("app");
if (root) render(html`<${App} />`, root);
