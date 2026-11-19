import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Button component
 * variant: 'primary' | 'secondary' | 'ghost'
 * size: 'sm' | 'md' | 'lg'
 */
export function Button({
  as: Component = 'button',
  children,
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className = '',
  disabled = false,
  ...props
}) {
  const sizeCls = size === 'lg' ? 'btn-lg' : size === 'sm' ? 'btn-sm' : '';
  const varCls = `btn-${variant}`;
  const fullCls = fullWidth ? 'btn-full' : '';
  return (
    <Component
      className={`btn ${varCls} ${sizeCls} ${fullCls} ${className}`.trim()}
      disabled={Component === 'button' ? disabled : undefined}
      aria-disabled={disabled}
      {...props}
    >
      {children}
    </Component>
  );
}

/**
 * Card container
 */
export function Card({ children, hover = false, className = '', style, ...props }) {
  return (
    <div
      className={`card ${hover ? 'card-hover' : ''} ${className}`.trim()}
      style={style}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * KPI / Metric Tile
 */
export function Tile({
  label,
  value,
  sub,
  icon,
  className = '',
  style,
  children,
  ...props
}) {
  const renderIcon = () => {
    if (!icon) return null;
    if (React.isValidElement(icon)) return icon;
    if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && (icon.$$typeof || icon.render))) {
      const IconComp = icon;
      return <IconComp size={14} />;
    }
    return icon;
  };

  return (
    <div className={`tile ${className}`.trim()} style={style} {...props}>
      {label && (
        <div className="tile-label">
          <span>{label}</span>
          {renderIcon()}
        </div>
      )}
      {value !== undefined && <div className="tile-value">{value}</div>}
      {sub && <div className="tile-sub">{sub}</div>}
      {children}
    </div>
  );
}

/**
 * Badge & Status Pill
 * tone: 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
 * pill: boolean
 */
export function Badge({
  children,
  tone = 'neutral',
  pill = false,
  className = '',
  style,
  ...props
}) {
  const toneCls = `badge-${tone}`;
  const pillCls = pill ? 'badge-pill' : '';
  return (
    <span
      className={`badge ${toneCls} ${pillCls} ${className}`.trim()}
      style={style}
      {...props}
    >
      {children}
    </span>
  );
}

// status picks the tone; the text is children, then label, then status itself.
export function StatusPill({ status, tone, label, children, ...props }) {
  // auto-derive tone from status if not provided
  let derivedTone = tone;
  if (!derivedTone && status) {
    const s = String(status).toLowerCase();
    if (s.includes('live') || s.includes('unlocked') || s.includes('active') || s.includes('eligible')) derivedTone = 'success';
    else if (s.includes('pre') || s.includes('info') || s.includes('new')) derivedTone = 'accent';
    else if (s.includes('warn') || s.includes('tax')) derivedTone = 'warn';
    else if (s.includes('forbid') || s.includes('danger') || s.includes('not eligible') || s.includes('ended')) derivedTone = 'danger';
    else derivedTone = 'neutral';
  }
  return (
    <Badge pill tone={derivedTone || 'neutral'} {...props}>
      {children || label || status}
    </Badge>
  );
}

/**
 * PageHeader
 * Left-aligned, factual, calm.
 */
export function PageHeader({ title, description, badge, action, className = '', style }) {
  return (
    <header className={`page-header ${className}`.trim()} style={style}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">{title}</h1>
          {description && <p className="page-desc">{description}</p>}
        </div>
        {(badge || action) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {badge}
            {action}
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * SectionTitle: a section heading with an optional count and a right-hand slot
 */
export function SectionTitle({ title, count, right, className = '', style }) {
  return (
    <div className={`section-title ${className}`.trim()} style={style}>
      <div className="section-title-left">
        <span>{title}</span>
        {count !== undefined && <span className="section-count">({count})</span>}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}

/**
 * Alert banner
 * tone: 'info' | 'warn' | 'success' | 'danger'
 */
export function Alert({ children, tone = 'warn', icon, action, className = '', style }) {
  return (
    <div className={`alert alert-${tone} ${className}`.trim()} style={style}>
      {icon && <div style={{ flexShrink: 0, marginTop: '1px' }}>{icon}</div>}
      <div style={{ flex: 1 }}>{children}</div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

/**
 * Progress Bar
 */
export function ProgressBar({ value = 0, max = 100, className = '', style }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`progress-bar-track ${className}`.trim()} style={style}>
      <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * EmptyState
 */
export function EmptyState({ icon, title, description, action, className = '', style }) {
  return (
    <div className={`empty-state ${className}`.trim()} style={style}>
      {icon}
      {title && <div className="empty-state-title">{title}</div>}
      {description && <div className="empty-state-desc">{description}</div>}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}

/**
 * InfoTip: a small ⓘ that shows a short explanation on hover, focus or tap. The bubble renders into
 * document.body with a fixed position kept inside the viewport, so a scrolling or clipped card never cuts it.
 */
export function InfoTip({ text, label = 'More info', size = 13, className = '' }) {
  const btn = React.useRef(null);
  const tip = React.useRef(null);
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  React.useLayoutEffect(() => {
    if (!open || !btn.current || !tip.current) return;
    const b = btn.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(8, b.left + b.width / 2 - t.width / 2), vw - t.width - 8);
    const below = b.bottom + 8;
    const top = below + t.height > vh - 8 ? Math.max(8, b.top - t.height - 8) : below;
    setPos({ left, top });
  }, [open, text]);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && btn.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [open]);
  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setPos(null);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`info-tip ${className}`.trim()}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
      {open &&
        createPortal(
          <span ref={tip} id={id} role="tooltip" className="info-tip-bubble" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
            {text}
          </span>,
          document.body
        )}
    </>
  );
}
