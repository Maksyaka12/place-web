// The live strip of the latest trades across the launchpad, above the dashboard (and on the token page).
// It scrolls slowly and stops under the pointer; with reduced motion it is a plain scrollable row.
import { Link } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { useLaunchTrades } from '../hooks.js';
import { TokenLogo, launchTokenPath } from './parts.jsx';
import { usd, amount } from '../format.js';
import { useLiveTrades } from '../live.js';

function Item({ t }) {
  const value = t.valueUsd != null ? usd(t.valueUsd) : amount(t.quote, t.quoteSymbol);
  return (
    <Link to={launchTokenPath(t.token)} className={`pl-launch-ticker-item ${t.live ? `pl-launch-flash ${t.side}` : ''}`.trim()} tabIndex={-1}>
      <TokenLogo token={t} size={20} shape="round" />
      <span className="pl-launch-ticker-symbol">{t.symbol}</span>
      <span className={t.side === 'buy' ? 'pl-launch-buy' : 'pl-launch-sell'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
      <span className="mono">{value}</span>
    </Link>
  );
}

export function LiveTicker() {
  const { data } = useLaunchTrades({ limit: 30 });
  const trades = useLiveTrades(data?.trades || [], data?.indexedBlock, null, 30);
  return (
    <div className="pl-launch-ticker" aria-label="Latest trades">
      <span className="pl-launch-ticker-live">
        <Radio size={14} />
        Live
      </span>
      <div className="pl-launch-ticker-viewport">
        {trades.length ? (
          <div className={`pl-launch-ticker-track ${trades.length > 4 ? 'moving' : ''}`.trim()}>
            {trades.map((t) => (
              <Item key={t.cursor} t={t} />
            ))}
            {/* The copy makes the loop seamless; screen readers skip it. */}
            {trades.length > 4 && (
              <span className="pl-launch-ticker-copy" aria-hidden="true">
                {trades.map((t) => (
                  <Item key={`copy-${t.cursor}`} t={t} />
                ))}
              </span>
            )}
          </div>
        ) : (
          <span className="pl-launch-muted pl-launch-ticker-empty">Trades show up here seconds after they land on Base</span>
        )}
      </div>
    </div>
  );
}
