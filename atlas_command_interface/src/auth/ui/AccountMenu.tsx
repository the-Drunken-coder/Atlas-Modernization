import { Button, Menu, MenuItem, PopoverNext } from "@blueprintjs/core";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const logoutItemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  return (
    <div className="account-menu">
      <PopoverNext
        isOpen={open}
        placement="right-start"
        popoverClassName="account-menu-popover"
        autoFocus={false}
        canEscapeKeyClose={!loggingOut}
        shouldReturnFocusOnClose
        onInteraction={(nextOpen) => {
          if (!loggingOut) setOpen(nextOpen);
        }}
        onOpening={() => logoutItemRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus()}
        content={
          <div
            role="group"
            aria-label="Account menu"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !loggingOut) {
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            <div className="account-menu__identity">
              <span>Your account</span>
              <strong>{username}</strong>
            </div>
            <Menu size="small">
              <MenuItem disabled text="Settings" label="Coming soon" />
              <MenuItem
                ref={logoutItemRef}
                intent="danger"
                disabled={loggingOut}
                shouldDismissPopover={false}
                text={loggingOut ? "Logging out..." : "Log out"}
                onClick={onLogout}
              />
            </Menu>
            {error ? (
              <span className="account-menu__error" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        }
      >
        <Button
          ref={triggerRef}
          type="button"
          variant="minimal"
          className="rail__brand rail__brand-button"
          aria-label="Account"
          title="Account"
        >
          <BrandIcon size={22} />
        </Button>
      </PopoverNext>
    </div>
  );
}
