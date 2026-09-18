import { useEffect, type ReactNode } from "react";

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
        <Icon name="progress_activity" size={18} className="em-spin" />
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
}: {
  tone: "critical" | "warning" | "success" | "info";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
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
        <h4 className="em-banner__title">{title}</h4>
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
