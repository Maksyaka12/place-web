import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Copy, Info, TriangleAlert, Lightbulb, ShieldAlert } from 'lucide-react';
import { Alert } from '../../components/ui';

// Building blocks of the /docs pages. Styles: styles/docs.css.

/** A number, amount, address or date inside a sentence (docs/DESIGN.md: numbers are mono). */
export const N = ({ children }) => <span className="mono pl-docs-n">{children}</span>;

/** A name of a control or a page as it reads in the app. */
export const Ui = ({ children }) => <span className="pl-docs-ui">{children}</span>;

export const C = ({ children }) => <code className="pl-docs-inline-code">{children}</code>;

export const Ext = ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

export const To = ({ page, hash, children }) => <Link to={`/docs${page ? `/${page}` : ''}${hash ? `#${hash}` : ''}`}>{children}</Link>;

export const H3 = ({ id, children }) => <h3 id={id} className="pl-docs-h3">{children}</h3>;

const CALLOUT = {
  note: { tone: 'info', Icon: Info },
  tip: { tone: 'success', Icon: Lightbulb },
  warn: { tone: 'warn', Icon: TriangleAlert },
  danger: { tone: 'danger', Icon: ShieldAlert },
};

export function Callout({ type = 'note', children }) {
  const { tone, Icon } = CALLOUT[type];
  return <Alert tone={tone} icon={<Icon size={16} />} className="pl-docs-callout">{children}</Alert>;
}

/** Numbered how-to steps. */
export function Steps({ children }) {
  return <ol className="pl-docs-steps">{children}</ol>;
}

/** columns: header strings; `mono`: indexes of the columns that hold numbers, dates or addresses; `nowrap`: columns kept on one line. */
export function Table({ columns, rows, mono = [], nowrap = [] }) {
  return (
    <div className="pl-docs-table-wrap">
      <table className="pl-docs-table">
        <thead>
          <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => <td key={j} className={[mono.includes(j) && 'mono', nowrap.includes(j) && 'nowrap'].filter(Boolean).join(' ') || undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Code({ title, children }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {}
  };
  return (
    <div className="pl-docs-code">
      <div className="pl-docs-code-head">
        <span>{title}</span>
        <button type="button" onClick={copy} aria-label="Copy code" title="Copy">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="mono"><code>{children}</code></pre>
    </div>
  );
}

/** The life of a reward round, drawn from the same three moments the contracts enforce. */
export function RoundTimeline() {
  const stages = [
    { at: '00:00 UTC, round day', title: 'Snapshot', text: 'Balances and NFT holders are recorded. What you hold after this moment no longer counts for this round.' },
    { at: '14:00 UTC, same day', title: 'Claim opens', text: 'The allocations are published. Eligible wallets can claim from the Claim Portal.', live: true },
    { at: '00:00 UTC, next snapshot day', title: 'Claim closes', text: 'The round expires. Nobody can claim it any more, not even by calling the contract directly.', end: true },
  ];
  return (
    <ol className="pl-docs-timeline">
      {stages.map((s) => (
        <li key={s.title} className={`${s.live ? 'live' : ''} ${s.end ? 'end' : ''}`.trim() || undefined}>
          <span className="pl-docs-timeline-dot" aria-hidden="true" />
          <span className="mono pl-docs-timeline-at">{s.at}</span>
          <span className="pl-docs-timeline-title">{s.title}</span>
          <span className="pl-docs-timeline-text">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** A 100% bar of shares. parts: [{ label, value, strong }] */
export function ShareBar({ parts }) {
  return (
    <div className="pl-docs-share">
      <div className="pl-docs-share-bar" aria-hidden="true">
        {parts.map((p) => <span key={p.label} className={p.strong ? 'strong' : undefined} style={{ flexGrow: p.value }} />)}
      </div>
      <ul>
        {parts.map((p) => (
          <li key={p.label}>
            <i className={p.strong ? 'strong' : undefined} aria-hidden="true" />
            <span>{p.label}</span>
            <span className="mono">{p.value}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Faq({ items }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="pl-faq-card pl-docs-faq">
      {items.map(({ q, a }) => {
        const isOpen = open === q;
        return (
          <div key={q} className="pl-faq-item">
            <button type="button" className="pl-faq-trigger" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : q)}>
              <span>{q}</span>
              <ChevronDown size={15} className={isOpen ? 'pl-docs-chevron open' : 'pl-docs-chevron'} />
            </button>
            {isOpen && <div className="pl-faq-content">{a}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Link cards. items: [{ page, title, text, icon }] */
export function CardGrid({ items }) {
  return (
    <div className="pl-docs-cards">
      {items.map(({ page, title, text, icon: Icon }) => (
        <Link key={page} to={`/docs/${page}`} className="pl-docs-card">
          {Icon && <span className="pl-docs-card-icon"><Icon size={18} strokeWidth={1.75} /></span>}
          <b>{title}</b>
          <span>{text}</span>
        </Link>
      ))}
    </div>
  );
}
