// One token in the launchpad feed: artwork with name and ticker, then market cap, price, liquidity and volume.
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import { TokenArt, NewBadge, Change, Stat, launchTokenPath } from './parts.jsx';
import { usd, price as priceText, amount, age } from '../format.js';

/** A USD value when the pair has a USD price, else the amount in the pair asset. */
export const money = (valueUsd, value, symbol) => (valueUsd != null ? usd(valueUsd) : amount(value, symbol));

export function TokenCard({ t, now }) {
  const q = t.quote?.symbol || '';
  return (
    <Link to={launchTokenPath(t.address)} className={`card card-hover pl-launch-card ${t.liveTick ? 'live' : ''}`.trim()} data-testid="launch-card">
      <div className="pl-launch-art">
        <TokenArt token={t} />
        <div className="pl-launch-art-overlay" />
        <div className="pl-launch-art-badges">
          <NewBadge createdAt={t.createdAt} now={now} />
          <Badge tone="neutral">{t.kind === 'b20' ? 'B20' : 'ERC-20'}</Badge>
        </div>
        <div className="pl-launch-art-title">
          <span className="pl-launch-art-name">{t.name}</span>
          <span className="pl-launch-art-symbol">${t.symbol}</span>
        </div>
      </div>
      <div className="pl-launch-card-body">
        <div className="pl-launch-card-mc">
          <span key={t.liveTick?.cursor} className={`pl-launch-card-mc-value mono ${t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : ''}`.trim()}>
            {money(t.marketCapUsd, t.marketCap, q)}
          </span>
          <span className="pl-launch-card-mc-label">MC</span>
          <Change value={t.change24h} className="pl-launch-card-change" />
        </div>
        <div className="pl-launch-card-line">
          <span className="mono">{t.priceUsd != null ? usd(t.priceUsd) : priceText(t.price, q)}</span>
          <span className="pl-launch-muted">
            Liq <span className="mono pl-launch-strong">{money(t.liquidity?.valueUsd, t.liquidity?.value, q)}</span>
          </span>
        </div>
        <div className="pl-launch-card-stats">
          <Stat label="Lifetime" value={money(t.volumeAllUsd, t.volumeAll, q)} />
          <Stat label="Vol 24h" value={money(t.volume24hUsd, t.volume24h, q)} className="right" />
        </div>
        <div className="pl-launch-card-foot">
          <span className="pl-launch-pair">{q || 'Pair'}</span>
          <span className="pl-launch-muted pl-launch-age">
            <Clock size={12} />
            {age(t.createdAt, now)}
          </span>
        </div>
      </div>
    </Link>
  );
}
