// Explore (home): every campaign on Place, live and upcoming first.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Radio, CalendarClock, History, Info } from 'lucide-react';
import { PageHeader, SectionTitle, EmptyState, Alert, Button } from '../../components/ui';
import { useCampaigns } from '../../../../place/hooks';
import { isTestnet, PLACE_CHAIN } from '../../../../place/chain';
import { CampaignCard, QueryError, Skeleton } from './parts';

const KINDS = [
  { id: '', label: 'All' },
  { id: 'token-holders', label: 'Tokens' },
  { id: 'nft-holders', label: 'NFT' },
];

function CampaignSection({ title, status, kind, icon, empty, limit = 24 }) {
  const q = useCampaigns({ status, kind: kind || undefined, limit });
  const list = q.data?.campaigns || [];
  return (
    <section className="pl-place-section">
      <SectionTitle title={title} count={q.data ? list.length : undefined} />
      {q.isLoading ? (
        <div className="pl-place-grid">
          <Skeleton count={3} height={220} />
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : list.length ? (
        <div className="pl-place-grid">
          {list.map((c) => (
            <CampaignCard key={`${c.hub}:${c.id}`} c={c} />
          ))}
        </div>
      ) : (
        <div className="card pl-place-empty-card">
          <EmptyState icon={icon} title={empty.title} description={empty.text} action={empty.action} />
        </div>
      )}
    </section>
  );
}

export default function ExplorePage() {
  const [kind, setKind] = useState('');
  const create = (
    <Button as={Link} to="/create" variant="primary">
      Create a campaign
    </Button>
  );
  return (
    <div className="pl-place-explore">
      <PageHeader
        title="All in one place"
        description="Live and upcoming reward campaigns for holders of any token or NFT collection on Base"
        action={create}
      />

      {isTestnet && (
        <Alert tone="info" icon={<Info size={16} />} className="pl-place-section">
          Place runs on {PLACE_CHAIN.name} for now: campaigns and rewards use test tokens with no value.
        </Alert>
      )}

      <div className="seg pl-place-filters" role="tablist" aria-label="Asset type">
        {KINDS.map((k) => (
          <button key={k.id || 'all'} type="button" role="tab" aria-selected={kind === k.id} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>

      <CampaignSection
        title="Live now"
        status="live"
        kind={kind}
        icon={<Radio size={28} />}
        empty={{ title: 'No live campaigns', text: 'Claims open here as soon as a snapshot is published' }}
      />
      <CampaignSection
        title="Upcoming"
        status="upcoming"
        kind={kind}
        icon={<CalendarClock size={28} />}
        empty={{ title: 'Nothing scheduled', text: 'Campaigns waiting for their snapshot show up here', action: create }}
      />
      <CampaignSection
        title="Ended"
        status="ended"
        kind={kind}
        limit={8}
        icon={<History size={28} />}
        empty={{ title: 'No ended campaigns yet', text: 'Finished, cancelled and refunded campaigns stay listed here' }}
      />
    </div>
  );
}
