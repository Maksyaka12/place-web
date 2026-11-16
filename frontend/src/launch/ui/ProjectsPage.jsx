// Projects (/projects): verified projects of the Place hub. Tokens launched on Place become
// projects on their own, run by whoever launched them; external tokens join after creator verification (not
// built yet). Each row opens the token in the hub, with its official and community campaigns.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Rocket, Search, Flame, Users } from 'lucide-react';
import { Card, Badge, EmptyState, PageHeader, Button } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useLaunchTokens } from '../hooks.js';
import { TokenLogo, launchNewPath, launchTokenPath } from './parts.jsx';
import { money } from './TokenCard.jsx';
import { tokenShares } from '../economy.js';
import { compact } from '../format.js';

function ProjectRow({ t }) {
  const shares = tokenShares(t.economics);
  return (
    <div className="pl-projects-row">
      <Link to={`/token/${t.address}`} className="pl-projects-main">
        <TokenLogo token={t} size={40} />
        <span className="pl-projects-name">
          <span className="pl-launch-strong">{t.name}</span>
          <span className="pl-launch-muted pl-launch-small">
            ${t.symbol} · {t.quote.symbol} pair
          </span>
        </span>
      </Link>
      <span className="pl-projects-badges">
        <Badge tone="accent">
          <Rocket size={11} /> Launched on Place
        </Badge>
        {shares?.burn > 0 && (
          <Badge tone="success">
            <Flame size={11} /> {shares.burn}% burn
          </Badge>
        )}
        {shares?.fund > 0 && (
          <Badge tone="neutral">
            <Users size={11} /> {shares.fund}% fund
          </Badge>
        )}
        {t.legacy && <Badge tone="neutral">0.1.0</Badge>}
      </span>
      <span className="pl-projects-stat mono">{money(t.marketCapUsd, t.marketCap, t.quote.symbol)}</span>
      <span className="pl-projects-stat mono pl-launch-muted">{compact(t.holders)} holders</span>
      <Link to={launchTokenPath(t.address)} className="pl-place-link pl-launch-small">
        Trade
      </Link>
    </div>
  );
}

export default function ProjectsPage() {
  const [text, setText] = useState('');
  const q = useLaunchTokens({ sort: 'mcap', limit: 100, ...(text.trim() ? { q: text.trim() } : {}) });
  const tokens = q.data?.tokens || [];
  return (
    <div className="pl-place-stack">
      <PageHeader
        title="Projects"
        description="Verified projects in Place: every token launched on Place, run by its creator"
        action={
          <Button as={Link} to={launchNewPath()} variant="primary">
            <Rocket size={15} /> Launch token
          </Button>
        }
      />
      <label className="pl-launch-search">
        <Search size={15} />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name, ticker or address" aria-label="Search projects" />
      </label>
      {q.isLoading ? (
        <Skeleton height={240} />
      ) : q.error ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : tokens.length ? (
        <Card className="pl-projects-list">
          {tokens.map((t) => (
            <ProjectRow key={t.address} t={t} />
          ))}
        </Card>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState icon={<Boxes size={28} />} title="No projects found" description="Projects appear here when tokens launch on Place. Verification of external tokens comes later." />
        </Card>
      )}
      <p className="pl-launch-muted pl-launch-small">External tokens join after their creator proves ownership. That check is not open yet.</p>
    </div>
  );
}
