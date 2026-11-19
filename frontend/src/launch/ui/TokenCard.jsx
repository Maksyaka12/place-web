// One token in the launchpad feed: the Grid card (artwork with NEW / Tax badges, name and $symbol
// with copy, market cap with its scale bar, price and liquidity, lifetime and 24 h volume, the pair chip and the age)
// and the Cards view card (rank, age and star on top, logo and $symbol, market cap on a 10K-10M scale, liquidity,
// volume, trades, "Base / PAIR" and Trade).
import { useNavigate } from 'react-router-dom';
import { Clock, Zap } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import { TokenArt, TokenLogo, NewBadge, TaxBadge, PairChip, StarButton, CopyInline, McBar, mcScale, agoText, isEconomy, launchTokenPath } from './parts.jsx';
import { usd, price as priceText, amount, compact } from '../format.js';

/** A USD value when the pair has a USD price, else the amount in the pair asset. */
export const money = (valueUsd, value, symbol) => (valueUsd != null ? usd(valueUsd) : amount(value, symbol));

/** A whole card that opens the token page (inner buttons stop the click). */
function useOpen(t) {
  const navigate = useNavigate();
  const to = launchTokenPath(t.address);
  return {
    role: 'link',
    tabIndex: 0,
    'aria-label': `${t.name} (${t.symbol})`,
    onClick: () => navigate(to),
    onKeyDown: (e) => e.key === 'Enter' && navigate(to),
  };
}

export function TokenCard({ t, now }) {
  const q = t.quote?.symbol || '';
  const open = useOpen(t);
  return (
    <div className={`card card-hover pl-launch-card ${t.liveTick ? 'live' : ''}`.trim()} data-testid="launch-card" {...open}>
      <div className="pl-launch-art">
        <TokenArt token={t} />
        <div className="pl-launch-art-overlay" />
        <div className="pl-launch-art-badges">
          <NewBadge createdAt={t.createdAt} now={now} />
          <TaxBadge token={t} />
        </div>
        <div className="pl-launch-art-title">
          <span className="pl-launch-art-name">{t.name}</span>
          <span className="pl-launch-art-symbol">
            ${t.symbol}
            <CopyInline value={t.address} />
          </span>
        </div>
      </div>
      <div className="pl-launch-card-body">
        <div className="pl-launch-card-mc">
          <span key={t.liveTick?.cursor} className={`pl-launch-card-mc-value mono ${t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : ''}`.trim()}>
            {money(t.marketCapUsd, t.marketCap, q)}
          </span>
          <span className="pl-launch-card-mc-label">MC</span>
          <McBar usdValue={t.marketCapUsd} />
        </div>
        <div className="pl-launch-card-line">
          <span className="mono pl-launch-muted">{t.priceUsd != null ? usd(t.priceUsd) : priceText(t.price, q)}</span>
          <span className="pl-launch-muted">
            Liq <span className="mono">{money(t.liquidity?.valueUsd, t.liquidity?.value, q)}</span>
          </span>
        </div>
        <div className="pl-launch-card-stats">
          <div className="pl-launch-stat">
            <span className="pl-launch-stat-label">Lifetime</span>
            <span className="pl-launch-stat-value mono">{money(t.volumeAllUsd, t.volumeAll, q)}</span>
          </div>
          <div className="pl-launch-stat right">
            <span className="pl-launch-stat-label">Vol 24h</span>
            <span className="pl-launch-stat-value mono">{money(t.volume24hUsd, t.volume24h, q)}</span>
          </div>
        </div>
        <div className="pl-launch-card-foot">
          <PairChip quote={t.quote} />
          <span className="pl-launch-muted pl-launch-small">{agoText(t.createdAt, now)}</span>
        </div>
      </div>
    </div>
  );
}

const SCALE = ['10M', '5M', '1M', '100K', '10K'];

/** The Cards view: rank, age and star; logo and $symbol; market cap with its vertical scale; the numbers; Trade. */
export function TokenRowCard({ t, now, rank, watch }) {
  const q = t.quote?.symbol || '';
  const open = useOpen(t);
  const level = mcScale(t.marketCapUsd);
  return (
    <div className={`card card-hover pl-launch-rowcard ${t.liveTick ? 'live' : ''}`.trim()} data-testid="launch-card" {...open}>
      <div className="pl-launch-rowcard-top">
        <span className="pl-launch-rowcard-rank mono">#{String(rank).padStart(2, '0')}</span>
        <span className="pl-launch-rowcard-age">
          <Clock size={12} />
          {agoText(t.createdAt, now)}
        </span>
        <StarButton address={t.address} watch={watch} />
      </div>
      <div className="pl-launch-rowcard-main">
        <div className="pl-launch-rowcard-left">
          <div className="pl-launch-rowcard-head">
            <TokenLogo token={t} size={56} />
            <span className="pl-launch-rowcard-name">
              <span className="pl-launch-inline pl-launch-rowcard-badges">
                <NewBadge createdAt={t.createdAt} now={now} />
                <TaxBadge token={t} />
              </span>
              <span className="pl-launch-rowcard-symbol">${t.symbol}</span>
              <span className="pl-launch-muted pl-launch-small pl-launch-rowcard-sub">
                <span className="pl-launch-ellipsis">{t.name}</span>
                <CopyInline value={t.address} />
              </span>
            </span>
          </div>
          <span className="pl-launch-stat-label">Market cap</span>
          <span key={t.liveTick?.cursor} className={`pl-launch-rowcard-mc mono ${t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : ''}`.trim()}>
            {money(t.marketCapUsd, t.marketCap, q)}
          </span>
          <span className="pl-launch-muted pl-launch-small mono">
            {t.priceUsd != null ? usd(t.priceUsd) : '—'} / {priceText(t.price, q)}
          </span>
        </div>
        {level != null && (
          <div className="pl-launch-rowcard-scale" aria-hidden="true">
            <span className="pl-launch-rowcard-scale-labels mono">
              {SCALE.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </span>
            <span className="pl-launch-rowcard-scale-bar">
              <span style={{ height: `${Math.max(4, level * 100)}%` }} />
            </span>
          </div>
        )}
      </div>
      <div className="pl-launch-rowcard-stats">
        <div className="pl-launch-stat">
          <span className="pl-launch-stat-label">Liquidity</span>
          <span className="pl-launch-stat-value mono">{money(t.liquidity?.valueUsd, t.liquidity?.value, q)}</span>
        </div>
        <div className="pl-launch-stat">
          <span className="pl-launch-stat-label">Vol 24h / Lifetime</span>
          <span className="pl-launch-stat-value mono">
            <span className="pl-launch-buy">{money(t.volume24hUsd, t.volume24h, q)}</span> / {money(t.volumeAllUsd, t.volumeAll, q)}
          </span>
        </div>
        <div className="pl-launch-stat">
          <span className="pl-launch-stat-label">Trades 24h</span>
          <span className="pl-launch-stat-value mono">{compact(t.trades24h ?? 0)}</span>
        </div>
      </div>
      <div className="pl-launch-rowcard-foot">
        <PairChip quote={t.quote} chain />
        {isEconomy(t) ? <Badge tone="warn">Tax</Badge> : <Badge tone="success">LP locked</Badge>}
        <span className="pl-launch-trade-btn">
          <Zap size={13} />
          Trade
        </span>
      </div>
    </div>
  );
}
