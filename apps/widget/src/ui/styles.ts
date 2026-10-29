// The styles of the widget, as a constructable stylesheet: a <style> tag or a style attribute would be
// refused by a strict `style-src` of the site, and this is not (it is not markup the page parsed).
// The shadow root keeps the rules of the site out of the widget and the widget out of the site.
const CSS = `
:host {
  all: initial;
  --accent: #1d4ed8;
  --on-accent: #ffffff;
  --surface: #ffffff;
  --text: #111827;
  --muted: #6b7280;
  --line: #e5e7eb;
  --bubble-team: #f3f4f6;
  --warn-bg: #fef3c7;
  --warn-text: #78350f;
  --error: #b91c1c;
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.4;
  color: var(--text);
}
@media (prefers-color-scheme: dark) {
  :host {
    --accent: #3b82f6;
    --surface: #1f2937;
    --text: #f9fafb;
    --muted: #9ca3af;
    --line: #374151;
    --bubble-team: #374151;
    --warn-bg: #451a03;
    --warn-text: #fde68a;
    --error: #fca5a5;
  }
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
svg { width: 20px; height: 20px; display: block; }
.sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
.launcher {
  position: relative; width: 56px; height: 56px; border: 0; border-radius: 50%;
  background: var(--accent); color: var(--on-accent);
  display: grid; place-items: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}
.launcher svg { width: 26px; height: 26px; }
.launcher--unread::after {
  content: ''; position: absolute; top: 2px; right: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: #dc2626; border: 2px solid var(--surface);
}
.launcher:focus-visible, .icon-button:focus-visible, .send:focus-visible, .retry:focus-visible,
.field:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel {
  position: absolute; right: 0; bottom: 70px; width: 360px; height: 520px;
  max-width: calc(100vw - 40px); max-height: calc(100vh - 110px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}
.panel[hidden] { display: none; }
.header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; background: var(--accent); color: var(--on-accent);
}
.title { font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-button {
  border: 0; background: transparent; color: inherit; padding: 4px; border-radius: 6px;
  display: grid; place-items: center;
}
.away { margin: 0; padding: 10px 14px; background: var(--warn-bg); color: var(--warn-text); font-size: 13px; }
.away[hidden] { display: none; }
.messages {
  flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px;
}
.empty { margin: auto; text-align: center; color: var(--muted); }
.msg { max-width: 80%; display: flex; flex-direction: column; gap: 2px; }
.msg--visitor { align-self: flex-end; align-items: flex-end; }
.msg--team { align-self: flex-start; }
.bubble {
  margin: 0; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere;
}
.msg--visitor .bubble { background: var(--accent); color: var(--on-accent); border-bottom-right-radius: 4px; }
.msg--team .bubble { background: var(--bubble-team); border-bottom-left-radius: 4px; }
.msg--sending .bubble { opacity: 0.6; }
.failure { font-size: 12px; color: var(--error); }
.retry { border: 0; background: transparent; color: var(--error); text-decoration: underline; padding: 0 0 0 4px; font-size: 12px; }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
.field {
  flex: 1; resize: none; max-height: 120px; min-height: 36px; padding: 8px 10px; font: inherit;
  color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 10px;
  field-sizing: content;
}
.send {
  border: 0; border-radius: 10px; width: 38px; height: 38px; display: grid; place-items: center;
  background: var(--accent); color: var(--on-accent);
}
.send:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 480px) {
  :host { right: 12px; bottom: 12px; }
  .panel { position: fixed; inset: 0; width: auto; height: auto; max-width: none; max-height: none; border-radius: 0; }
}
`

// False in a browser that cannot hold a stylesheet without markup: the widget then stays out of the
// page, because the other way to style it is the very thing a strict policy forbids
export function applyStyles(root: ShadowRoot): boolean {
  if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in root)) return false
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(CSS)
    root.adoptedStyleSheets = [sheet]
    return true
  } catch {
    return false
  }
}
