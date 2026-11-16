import { Compass, Eye, LogOut } from 'lucide-react';
import { DEMO_ADDRESS, basescanAddress, exitDemo } from '../../config/demo';
import { useDemoMode } from '../../hooks/useDemoMode';
import { startTour } from './tourState';
import './demo.css';

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Shown on every page while the read-only demo is on. */
export default function DemoBanner() {
  const { demo } = useDemoMode();
  if (!demo) return null;
  return (
    <div className="pl-demo-banner" role="status" data-testid="demo-banner">
      <Eye size={14} className="pl-demo-banner-icon" />
      <span className="pl-demo-banner-text">
        Viewing as{' '}
        <a href={basescanAddress(DEMO_ADDRESS)} target="_blank" rel="noopener noreferrer" className="pl-demo-banner-addr" title={DEMO_ADDRESS}>
          {short(DEMO_ADDRESS)}
        </a>
        {' '}— read-only<span className="pl-demo-banner-long"> demo</span>
      </span>
      <button className="pl-demo-banner-tour" onClick={startTour} data-testid="demo-tour-open">
        <Compass size={13} /> Tour
      </button>
      <button className="pl-demo-banner-exit" onClick={exitDemo}>
        <LogOut size={13} /> Exit demo
      </button>
    </div>
  );
}
