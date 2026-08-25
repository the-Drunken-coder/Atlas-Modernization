import { Collapse } from "@blueprintjs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./controls.js";
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
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const text = useMemo(() => safeStringify(value), [value]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        setCopied(false);
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="json-drawer">
      <div className="json-drawer__summary">
        <Button
          type="button"
          variant="ghost"
          size="small"
          alignText="left"
          className="json-drawer__toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{open ? "▾" : "▸"}</span>
          <span>{title}</span>
        </Button>
        {open ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            className="json-drawer__copy"
            aria-label="Copy JSON"
            title="Copy JSON"
            onClick={() => void copy()}
          >
            <CopyIcon size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      <Collapse isOpen={open}>
        <div className="json-drawer__body">
          <pre className="json-drawer__pre">{text}</pre>
        </div>
      </Collapse>
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
