import { useEffect, useRef, useState } from "react";
import { BrandIcon } from "../../ui/primitives/icons.js";

type AccountMenuProps = {
  username: string;
  loggingOut: boolean;
  error?: string;
  onLogout: () => void;
};

export function AccountMenu({ username, loggingOut, error, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!loggingOut && !containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
    };
  }, [loggingOut, open]);

  return (
    <div
      className="account-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape" || loggingOut) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="bp6-button bp6-minimal rail__brand rail__brand-button"
        aria-label="Account"
        aria-expanded={open}
        aria-controls="account-menu-popover"
        title="Account"
        onClick={() => {
          if (!loggingOut) setOpen((current) => !current);
        }}
      >
        <BrandIcon size={22} />
      </button>
      {open ? (
        <div id="account-menu-popover" className="account-menu__popover" role="group" aria-label="Account menu">
          <div className="account-menu__identity">
            <span>Your account</span>
            <strong>{username}</strong>
          </div>
          <div className="account-menu__items">
            <button type="button" className="account-menu__item" disabled>
              <span>Settings</span>
              <small>Coming soon</small>
            </button>
            <button
              type="button"
              className="account-menu__item account-menu__item--danger"
              disabled={loggingOut}
              onClick={onLogout}
            >
              {loggingOut ? "Logging out..." : "Log out"}
            </button>
          </div>
          {error ? (
            <span className="account-menu__error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
