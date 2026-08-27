import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandIcon } from "../../ui/primitives/icons.js";

type AccountMenuProps = {
  username: string;
  loggingOut: boolean;
  error?: string;
  onLogout: () => void;
};

type PopoverPosition = { left: number; top: number };

const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

export function AccountMenu({ username, loggingOut, error, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const logoutRef = useRef<HTMLButtonElement>(null);
  const focusedOpenMenuRef = useRef(false);

  const updatePosition = useCallback(() => {
    const triggerBounds = triggerRef.current?.getBoundingClientRect();
    const popoverBounds = popoverRef.current?.getBoundingClientRect();
    if (!triggerBounds || !popoverBounds) return;

    setPosition({
      left: Math.max(
        VIEWPORT_PADDING,
        Math.min(triggerBounds.right + POPOVER_GAP, window.innerWidth - popoverBounds.width - VIEWPORT_PADDING)
      ),
      top: Math.max(
        VIEWPORT_PADDING,
        Math.min(triggerBounds.top, window.innerHeight - popoverBounds.height - VIEWPORT_PADDING)
      )
    });
  }, []);

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  useEffect(() => {
    if (!open) {
      focusedOpenMenuRef.current = false;
      return;
    }
    if (!position || loggingOut || focusedOpenMenuRef.current) return;

    logoutRef.current?.focus();
    focusedOpenMenuRef.current = true;
  }, [loggingOut, open, position]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!loggingOut && !containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
        setPosition(undefined);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
    };
  }, [loggingOut, open]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [error, loggingOut, open, updatePosition]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(undefined);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div
      className="account-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape" || loggingOut) return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
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
          if (loggingOut) return;
          if (open) close(true);
          else setOpen(true);
        }}
      >
        <BrandIcon size={22} />
      </button>
      {open
        ? createPortal(
            <div
              id="account-menu-popover"
              ref={popoverRef}
              className="account-menu__popover"
              role="group"
              aria-label="Account menu"
              style={position ?? { visibility: "hidden" }}
            >
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
                  ref={logoutRef}
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
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
