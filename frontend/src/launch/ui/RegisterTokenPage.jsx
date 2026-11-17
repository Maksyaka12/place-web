// Register token (/projects/register): how a token launched elsewhere becomes a project on Place. Registration
// itself is not open yet, so the page explains the steps and points to what works today.
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, Rocket } from 'lucide-react';
import { Alert, Badge, Button, Card, PageHeader } from '../../themes/place/components/ui';
import { launchNewPath } from './parts.jsx';

const STEPS = [
  ['Prove the token is yours', 'Connect the wallet that owns or deployed the token. Place checks it onchain.'],
  ['Get a project page', 'The token gets its page in Projects, next to tokens launched on Place.'],
  ['Reward your community', 'Create official reward campaigns and NFT collections, marked as coming from the project.'],
];

export default function RegisterTokenPage() {
  return (
    <div className="pl-place-stack pl-projects-register">
      <Link to="/projects" className="pl-place-back">
        <ArrowLeft size={14} /> Projects
      </Link>
      <PageHeader title="Register token" description="Bring a token launched elsewhere to Place and run it as a project" badge={<Badge tone="neutral" pill>Soon</Badge>} />
      <Alert tone="info" icon={<BadgeCheck size={16} />}>
        Registration opens soon. Until then, anyone can already create reward campaigns and staking vaults for any token on Base.
      </Alert>
      <Card>
        <ol className="pl-projects-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="mono">{i + 1}</span>
              <span>
                <span className="pl-launch-strong">{title}</span>
                <br />
                <span className="pl-launch-muted">{text}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
      <div className="pl-projects-actions">
        <Button as={Link} to="/create">
          Create vault / campaign
        </Button>
        <Button as={Link} to={launchNewPath()} variant="primary">
          <Rocket size={15} /> Launch token
        </Button>
      </div>
    </div>
  );
}
