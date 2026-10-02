import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

/*
 * Building blocks of the Easy Migrate design, ported from the Stitch screens.
 * Styles live in app/styles/easy-migrate.css.
 */

export function Icon({
  name,
  size = 20,
  className,
  filled = false,
}: {
  name: string;
  size?: 16 | 18 | 20 | 24 | 32;
  className?: string;
  filled?: boolean;
}) {
  const classes = [
    "material-symbols-outlined",
    size === 24 ? "" : `em-icon-${size}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

// Pure CSS ring. An icon-font spinner shows its ligature name as text until
// the 1 MB Material Symbols font arrives, which is exactly when loaders show.
export function Spinner({ size = 20 }: { size?: 18 | 20 | 32 }) {
  return (
    <span
      className={`em-spinner em-spinner--${size}`}
      aria-hidden="true"
    />
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  size,
  type = "button",
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "critical";
  size?: "sm";
  type?: "button" | "submit";
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  fullWidth?: boolean;
}) {
  const classes = [
    "em-btn",
    `em-btn--${variant}`,
    size === "sm" ? "em-btn--sm" : "",
    fullWidth ? "em-btn--full" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? (
        <Spinner size={18} />
      ) : icon ? (
        <Icon name={icon} size={18} />
      ) : null}
      {children}
    </button>
  );
}

export function LinkButton({
  children,
  onClick,
  tone,
  disabled = false,
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "muted" | "critical";
  disabled?: boolean;
  icon?: string;
}) {
  return (
    <button
      type="button"
      className={["em-link-btn", tone ? `em-link-btn--${tone}` : ""]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {icon ? <Icon name={icon} size={16} /> : null}
    </button>
  );
}

export function StatGrid({
  columns = 4,
  gap,
  children,
}: {
  columns?: 3 | 4;
  gap?: "md";
  children: ReactNode;
}) {
  const classes = [
    "em-stat-grid",
    columns === 3 ? "em-stat-grid--three" : "",
    gap === "md" ? "em-stat-grid--md-gap" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes}>{children}</div>;
}

export function StatTile({
  label,
  value,
  tone,
  variant,
}: {
  label: string;
  value: number | string;
  tone?: "critical";
  variant?: "bordered" | "selected";
}) {
  const isCritical = tone === "critical" && Number(value) > 0;

  return (
    <div
      className={["em-stat", variant ? `em-stat--${variant}` : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="em-stat__label">{label}</span>
      <span
        className={
          isCritical ? "em-stat__value em-stat__value--critical" : "em-stat__value"
        }
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

export function Banner({
  tone,
  title,
  children,
  action,
  titleAction,
}: {
  tone: "critical" | "warning" | "success" | "info";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Small control shown right after the title, such as an info button. */
  titleAction?: ReactNode;
}) {
  const iconName =
    tone === "critical"
      ? "error"
      : tone === "warning"
        ? "warning"
        : tone === "success"
          ? "check_circle"
          : "info";

  return (
    <div className={`em-banner em-banner--${tone}`} role="status">
      <Icon name={iconName} className="em-icon-lead" filled />
      <div>
        {titleAction ? (
          <div className="em-banner__heading">
            <h4 className="em-banner__title">{title}</h4>
            {titleAction}
          </div>
        ) : (
          <h4 className="em-banner__title">{title}</h4>
        )}
        {children ? <p className="em-banner__body">{children}</p> : null}
        {action ? <div className="em-banner__action">{action}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
}: {
  icon: string;
  title: string;
  body?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "em-empty em-empty--compact" : "em-empty"}>
      <span className="em-empty__icon">
        <Icon name={icon} size={32} />
      </span>
      <h3 className="em-empty__title">{title}</h3>
      {body ? <p className="em-empty__body">{body}</p> : null}
      {action}
    </div>
  );
}

export function Pill({
  tone = "ready",
  children,
  dot,
  icon,
}: {
  tone?: "ready" | "neutral" | "running" | "failed" | "completed" | "outline";
  children: ReactNode;
  dot?: "warning" | "critical" | "success" | "primary";
  icon?: string;
}) {
  return (
    <span className={`em-pill em-pill--${tone}`}>
      {dot ? (
        <span
          className={`em-dot em-dot--${dot}${tone === "running" ? " em-dot--pulse" : ""}`}
        />
      ) : null}
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </span>
  );
}

export function StatusText({
  tone,
  children,
  dot = true,
}: {
  tone: "warning" | "critical" | "success" | "secondary";
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`em-status em-status--${tone}`}>
      {dot ? <span className={`em-dot em-dot--${tone}`} /> : null}
      {children}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="em-field">
      <label className="em-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="em-field__control">{children}</div>
      {error ? <p className="em-field__error">{error}</p> : null}
      {help && !error ? <p className="em-field__help">{help}</p> : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="em-modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="em-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="em-modal__header">
          <h3 className="em-section-heading">{title}</h3>
          <button
            type="button"
            className="em-icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="em-modal__body">{children}</div>
        {footer ? <div className="em-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * Scrolls to and briefly highlights list rows, e.g. the rows an
 * "Include them" button just ticked. Rows opt in with `data-flash-key`.
 */
export function useRowFlash<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);
  const [flashKeys, setFlashKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!flashKeys.length) {
      return;
    }

    const firstRow = [
      ...(containerRef.current?.querySelectorAll<HTMLElement>("[data-flash-key]") ??
        []),
    ].find((row) => flashKeys.includes(row.dataset.flashKey ?? ""));
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    firstRow?.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });

    const timer = window.setTimeout(() => setFlashKeys([]), 2000);
    return () => window.clearTimeout(timer);
  }, [flashKeys]);

  return { containerRef, flashKeys, flashRows: setFlashKeys };
}

/**
 * Lets a card grow into a centred dialog twice its size and shrink back. The
 * same DOM node moves, so everything inside it (ticks, search, scroll) carries
 * over. A view transition morphs between the two states where the browser
 * supports one; elsewhere, and with reduced motion, it switches instantly.
 *
 * The card needs the `em-expandable` class, `cardRef` and `cardStyle`, and a
 * placeholder of `placeholderHeight` so the page does not jump while it is out
 * of the flow.
 */
export function useExpandableCard() {
  const cardRef = useRef<HTMLDivElement>(null);
  const [collapsedSize, setCollapsedSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const expanded = collapsedSize !== null;

  const setExpanded = useCallback((next: boolean) => {
    const card = cardRef.current;
    if (!card) {
      return;
    }

    const apply = () =>
      flushSync(() =>
        setCollapsedSize(
          next ? { width: card.offsetWidth, height: card.offsetHeight } : null,
        ),
      );
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reduceMotion || typeof document.startViewTransition !== "function") {
      apply();
      return;
    }

    // Opening and closing swap the two layouts at different moments (see the
    // CSS), so tell the stylesheet which way this one goes.
    const root = document.documentElement;
    root.dataset.emExpand = next ? "open" : "close";
    document
      .startViewTransition(apply)
      .finished.finally(() => {
        delete root.dataset.emExpand;
      });
  }, []);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    }

    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      root.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, setExpanded]);

  const cardStyle = collapsedSize
    ? ({
        "--em-expand-width": `${String(collapsedSize.width * 2)}px`,
        "--em-expand-height": `${String(collapsedSize.height * 2)}px`,
      } as CSSProperties)
    : undefined;

  return {
    expanded,
    setExpanded,
    cardRef,
    cardStyle,
    placeholderHeight: collapsedSize?.height ?? 0,
  };
}

/** Formats a timestamp as "10 Aug 2026 at 4:32 PM". */
export function formatDateTime(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${day} at ${time}`;
}
