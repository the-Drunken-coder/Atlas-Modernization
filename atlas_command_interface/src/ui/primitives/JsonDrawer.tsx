import { useMemo, useState } from "react";
import { CopyIcon } from "./icons.js";

type JsonDrawerProps = {
  value: unknown;
  title?: string;
  defaultOpen?: boolean;
};

/** Collapsible raw-JSON inspector. Collapsed by default; copy to clipboard. */
export function JsonDrawer({ value, title = "Raw JSON", defaultOpen = false }: JsonDrawerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => safeStringify(value), [value]);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="json-drawer">
      <div className="json-drawer__summary">
        <button type="button" className="json-drawer__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>{open ? "▾" : "▸"}</span>
          <span>{title}</span>
        </button>
        {open ? (
          <button type="button" className="json-drawer__copy" aria-label="Copy JSON" title="Copy JSON" onClick={() => void copy()}>
            <CopyIcon size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="json-drawer__body">
          <pre className="json-drawer__pre">{text}</pre>
        </div>
      ) : null}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
