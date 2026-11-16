import { useEffect, useState } from 'react';
import { ExternalLink, Eye, X } from 'lucide-react';
import { basescanAddress, subscribeDemoPreview } from '../../config/demo';
import { PLACE_CHAIN } from '../../place/chain';
import './demo.css';

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/** The dialog a demo visitor sees instead of a wallet prompt. */
export default function DemoTxPreview() {
  const [preview, setPreview] = useState(null);

  useEffect(() => subscribeDemoPreview(setPreview), []);

  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (e) => e.key === 'Escape' && setPreview(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  if (!preview) return null;
  const { action, amount, contract, contractLabel, method, note, from } = preview;

  return (
    <div className="pl-demo-modal-backdrop" onClick={() => setPreview(null)}>
      <div
        className="pl-demo-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pl-demo-modal-title"
        data-testid="demo-tx-preview"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pl-demo-modal-head">
          <span className="pl-demo-modal-icon"><Eye size={16} /></span>
          <div>
            <div id="pl-demo-modal-title" className="pl-demo-modal-title">Transaction preview</div>
            <div className="pl-demo-modal-sub">Read-only demo: nothing was signed or sent.</div>
          </div>
          <button className="pl-demo-modal-close" onClick={() => setPreview(null)} aria-label="Close preview"><X size={16} /></button>
        </div>

        <dl className="pl-demo-rows">
          <div><dt>Action</dt><dd>{action}</dd></div>
          {amount ? <div><dt>Amount</dt><dd>{amount}</dd></div> : null}
          {contract ? (
            <div>
              <dt>Contract</dt>
              <dd>
                <a href={basescanAddress(contract)} target="_blank" rel="noopener noreferrer" className="pl-demo-link">
                  {contractLabel ? `${contractLabel} · ` : ''}{short(contract)} <ExternalLink size={12} />
                </a>
              </dd>
            </div>
          ) : null}
          {method ? <div><dt>Call</dt><dd className="pl-demo-mono">{method}</dd></div> : null}
          {from ? (
            <div>
              <dt>From</dt>
              <dd>
                <a href={basescanAddress(from)} target="_blank" rel="noopener noreferrer" className="pl-demo-link">
                  {short(from)} <ExternalLink size={12} />
                </a>
              </dd>
            </div>
          ) : null}
          <div><dt>Network</dt><dd>{PLACE_CHAIN.name} ({PLACE_CHAIN.id})</dd></div>
        </dl>

        {note ? <p className="pl-demo-note">{note}</p> : null}
        <p className="pl-demo-note">To do this for real, exit the demo and use your own wallet.</p>

        <div className="pl-demo-modal-actions">
          {contract ? (
            <a className="btn btn-secondary btn-sm" href={basescanAddress(contract)} target="_blank" rel="noopener noreferrer">
              View on Basescan <ExternalLink size={12} />
            </a>
          ) : null}
          <button className="btn btn-primary btn-sm" onClick={() => setPreview(null)}>Got it</button>
        </div>
      </div>
    </div>
  );
}
